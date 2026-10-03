import { createHash } from 'node:crypto';
import { PlannerPolicy } from './planner.js';
import { JevPolicy } from './jev.js';
import { RandomPolicy } from './survival.js';
import { projectState } from './state.js';

export const EXPERIMENT_OPTIONS = Object.freeze({ depth: 20, width: 24, intervalMs: 100, route: false });
export const EXPERIMENT_ENEMIES = Object.freeze({ CHASER: 5, DASHER: 5, SHOOTER: 5, LASER: 5, MINE: 5, JAMMER: 5 });

export function experimentPolicy(engine, method, { selectionSeed, apiKey, maxCalls, model,
  mock = false, signal, budgetPerAction } = {}) {
  const planner = new PlannerPolicy({ ...engine, ...EXPERIMENT_OPTIONS, signal });
  if (method === 'random') return new RandomPolicy({ planner, selectionSeed, budgetPerAction });
  return new JevPolicy({ planner, comparison: true, selectionSeed, budgetPerAction,
    apiKey: mock ? 'mock' : apiKey, maxCalls, model,
    // 機能検証だけの模擬API。ランダム／実Jevの性能評価には混ぜない。
    ...(mock ? { fetchImpl: async (_, options) => {
      const body = JSON.parse(options.body);
      return { ok: true, json: async () => ({ answers: { move: {
        type: 'choice', choice: Object.keys(body.questions.move.criteria).at(-1) } } }) };
    } } : {}) });
}

export function snapshotOf(sim, challenge) {
  return JSON.parse(JSON.stringify(projectState(sim.state, sim.cfg, challenge)));
}

export async function simulatorTrial(engine, challenge, policy, onDecision = () => {}) {
  const sim = engine.originalCreateSim(challenge, engine.createConfig());
  const start = performance.now();
  let next = 0, decisions = 0, deciding = false;
  try {
    while (sim.state.status !== 'cleared' && sim.state.status !== 'failed') {
      if (sim.state.status === 'playing' && !sim.isMoving() && sim.state.elapsedMs + 1e-7 >= next) {
        const state = snapshotOf(sim, challenge);
        deciding = true;
        const decision = await policy.decide(state);
        deciding = false;
        decisions++;
        await onDecision({ ...decision, elapsedMs: state.elapsedMs,
          stateHash: createHash('sha256').update(JSON.stringify(state)).digest('hex') });
        if (decision.action !== 'wait') sim.input(decision.action);
        next = sim.state.elapsedMs + EXPERIMENT_OPTIONS.intervalMs;
      }
      sim.step(); sim.drainEvents();
    }
    return { status: sim.state.status, survivedMs: sim.state.deathAtMs ?? Math.min(sim.state.elapsedMs, sim.state.durationMs),
      elapsedMs: sim.state.elapsedMs, livesLeft: sim.state.lives, damageTaken: sim.state.damageTaken,
      challenge, decisions, simulatorElapsedMs: performance.now() - start, realElapsedMs: null };
  } catch (error) {
    return { status: 'aborted', abortReason: error.code ?? (error.name === 'AbortError' ? 'CANCELLED' : 'SIMULATOR_ERROR'),
      survivedMs: null, partialSurvivedMs: sim.state.deathAtMs ?? sim.state.elapsedMs,
      elapsedMs: sim.state.elapsedMs, challenge, decisions,
      simulatorElapsedMs: performance.now() - start, realElapsedMs: null,
      failedDecision: deciding ? policy.lastDecision : undefined };
  }
}

export function quantile(values, probability) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const offset = (sorted.length - 1) * probability, low = Math.floor(offset);
  return sorted[low] + (sorted[Math.ceil(offset)] - sorted[low]) * (offset - low);
}

export function distribution(values) {
  return { n: values.length, total: values.reduce((sum, value) => sum + value, 0),
    mean: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null,
    median: quantile(values, 0.5), p10: quantile(values, 0.1), p95: quantile(values, 0.95) };
}

export function finishTrial(summary, samples, policy) {
  const failures = summary.failedDecision ? [summary.failedDecision] : [];
  const attempted = [...samples, ...failures];
  const buckets = { zero: 0, one: 0, multiple: 0 };
  for (const d of attempted) {
    if (!Number.isInteger(d.candidateCount)) continue;
    buckets[d.candidateCount === 0 ? 'zero' : d.candidateCount === 1 ? 'one' : 'multiple']++;
  }
  const api = attempted.filter(d => d.apiAttempted).map(d => d.apiMs);
  return { ...summary, failedDecision: undefined,
    calls: policy.calls ?? 0, inputTokens: policy.inputTokens ?? 0,
    apiMs: distribution(api), predictionMs: distribution(attempted.map(d => d.predictionMs).filter(Number.isFinite)),
    candidateCounts: buckets,
    realToGameRatio: summary.realElapsedMs != null && summary.elapsedMs > 0
      ? summary.realElapsedMs / summary.elapsedMs : null };
}
