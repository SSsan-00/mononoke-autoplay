import test from 'node:test';
import assert from 'node:assert/strict';
import { PlannerPolicy } from '../src/planner.js';
import { RandomPolicy, SelectionRandom } from '../src/survival.js';
import { JevPolicy } from '../src/jev.js';
import { finishTrial, simulatorTrial, experimentPolicy } from '../src/experiment.js';
import { loadPredictionEngine } from '../src/engine.js';

function search(diesAt = Infinity, clearsAt = Infinity, budget) {
  const root = { state: { w: 3, h: 3, player: { x: 1, y: 1 }, elapsedMs: 0, lives: 1, damageTaken: 0 } };
  const planner = new PlannerPolicy({ createSim: () => {}, depth: 20, width: 24 });
  planner.advanceCandidate = (sim, action) => {
    const elapsedMs = sim.state.elapsedMs + 100;
    const first = sim.first ?? action;
    return { first, state: { ...sim.state, elapsedMs,
      status: elapsedMs >= diesAt ? 'failed' : elapsedMs >= clearsAt ? 'cleared' : 'playing',
      ...(elapsedMs >= diesAt ? { deathAtMs: elapsedMs } : {}) } };
  };
  planner.scoreCandidate = (_, __, ___, exposure) => ({ cost: exposure, exposure });
  return planner.findSurvivalCandidates(root, root.state, budget);
}

test('生存候補は20手到達か途中クリアだけ。初手ごとの同予算と死亡除外', () => {
  const complete = search();
  assert.deepEqual(complete.candidates.map(d => d.action), ['up', 'down', 'left', 'right', 'wait']);
  assert.ok(complete.candidates.every(d => d.reachedDepth === 20 && d.reason === 'horizon'));
  assert.equal(new Set(complete.outcomes.map(d => d.evaluatedBranches)).size, 1);
  assert.equal(search(1000).candidates.length, 0);
  assert.deepEqual(search(1000).fallbackActions, ['up', 'down', 'left', 'right', 'wait']);
  assert.ok(search(Infinity, 300).candidates.every(d => d.reachedDepth === 3 && d.reason === 'cleared'));
  const partial = search(Infinity, Infinity, 2);
  assert.equal(partial.candidates.length, 0);
  assert.ok(partial.outcomes.every(d => d.reason === 'budget' && d.evaluatedBranches === 2));
  assert.deepEqual(search(), complete, '同じ状態と履歴では候補が完全一致');
});

function fakePlanner(actions, fallbackActions = ['wait']) {
  return { intervalMs: 100, mirror: {}, committed: [], synchronize() {},
    findSurvivalCandidates: () => ({ candidates: actions.map(action => ({ action, cost: action === 'wait' ? 900 : 0 })),
      fallbackActions, outcomes: [], searchedDepth: 20, evaluatedBranches: 10 }),
    recordAction(_, action) { this.committed.push(action); } };
}
const state = { w: 3, h: 3, player: { x: 1, y: 1 } };

test('均等ランダムの再現性・独立性と候補0/1件の共通処理', async () => {
  const a = new SelectionRandom(123), b = new SelectionRandom(123), counts = [0, 0, 0];
  for (let i = 0; i < 30000; i++) { const x = a.choose([0, 1, 2]); assert.equal(x, b.choose([0, 1, 2])); counts[x]++; }
  assert.ok(counts.every(n => Math.abs(n - 10000) < 400));
  for (const actions of [[], ['left']]) {
    const random = new RandomPolicy({ planner: fakePlanner(actions, ['left', 'wait']), selectionSeed: 17 });
    const jev = new JevPolicy({ planner: fakePlanner(actions, ['left', 'wait']), comparison: true,
      apiKey: 'mock', selectionSeed: 17, fetchImpl: () => assert.fail('API不要') });
    assert.equal((await random.decide(state)).action, (await jev.decide(state)).action);
    assert.equal(random.random.draws, 0, 'fallbackは通常の選択乱数を消費しない');
  }
});

test('比較Jevは共通候補を追加除外せず渡し、異常を通信時間・使用量付きで記録', async () => {
  const planner = fakePlanner(['left', 'wait']);
  const jev = new JevPolicy({ planner, comparison: true, apiKey: 'mock', fetchImpl: async (_, req) => {
    assert.deepEqual(Object.keys(JSON.parse(req.body).questions.move.criteria), ['left', 'wait']);
    return { ok: true, json: async () => ({ answers: { move: { type: 'choice', choice: 'up' } }, usage: { input_tokens: 32 } }) };
  } });
  await assert.rejects(jev.decide(state), { code: 'INVALID_CHOICE' });
  assert.deepEqual(planner.committed, []);
  const result = finishTrial({ status: 'aborted', failedDecision: jev.lastDecision }, [], jev);
  assert.equal(result.inputTokens, 32);
  assert.equal(result.calls, 1);
  assert.equal(result.apiMs.n, 1);
  assert.equal(result.candidateCounts.multiple, 1);
  for (const [fetchImpl, code] of [
    [async () => ({ ok: false, status: 503 }), 'HTTP_503'],
    [async () => { throw new DOMException('timeout', 'TimeoutError'); }, 'API_TIMEOUT'],
  ]) {
    const policy = new JevPolicy({ planner: fakePlanner(['left', 'wait']), comparison: true, apiKey: 'mock', fetchImpl });
    await assert.rejects(policy.decide(state), { code });
    assert.equal(policy.lastDecision.apiAttempted, true);
    assert.ok(policy.lastDecision.apiMs >= 0);
  }
});

test('原本上でも候補生成・選択を再現し、ゲームRNGと同期を保つ',
  { skip: !process.env.MONONOKE_ENGINE_DIR, timeout: 120000 }, async () => {
    const engine = await loadPredictionEngine();
    const dense = { field: 'S', time: 30, lives: 1, seed: 101,
      enemies: { CHASER: 5, DASHER: 5, SHOOTER: 5, LASER: 5, MINE: 5, JAMMER: 5 } };
    const original = engine.originalCreateSim(dense, engine.createConfig());
    const { snapshotOf } = await import('../src/experiment.js');
    const snapshot = snapshotOf(original, dense), before = JSON.stringify(original.state);
    const random = await experimentPolicy(engine, 'random', { selectionSeed: 41 }).decide(snapshot);
    const jev = await experimentPolicy(engine, 'jev', { selectionSeed: 41, mock: true }).decide(snapshot);
    assert.deepEqual(random.candidates, jev.candidates, '実際の20手候補も同じ状態・履歴で一致');
    assert.equal(JSON.stringify(original.state), before, '探索と選択は原本の乱数を消費しない');
    const challenge = { field: 'S', time: 0.6, lives: 1, seed: 101, enemies: { CHASER: 1 } };
    const run = async () => {
      const logs = [];
      const result = await simulatorTrial(engine, challenge,
        experimentPolicy(engine, 'random', { selectionSeed: 41 }), d => logs.push([d.action, d.stateHash, d.eligibleActions]));
      return { result, logs };
    };
    const a = await run(), b = await run();
    assert.equal(a.result.status, 'cleared');
    assert.deepEqual(a.logs, b.logs);
    const broken = experimentPolicy(engine, 'random', { selectionSeed: 41 });
    const synchronize = broken.planner.synchronize.bind(broken.planner);
    broken.planner.synchronize = s => { s.player.x++; synchronize(s); };
    assert.equal((await simulatorTrial(engine, challenge, broken)).status, 'aborted');
  });
