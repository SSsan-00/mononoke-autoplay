// 保存済みのJev判断を再生し、候補の評価値が変わらないことを確認します。有料APIは呼びません。
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadPredictionEngine } from '../src/engine.js';
import { PlannerPolicy } from '../src/planner.js';
import { projectState } from '../src/state.js';
const sourceDirectory = process.env.MONONOKE_ENGINE_DIR;
if (!sourceDirectory || !process.argv[2]) throw new Error('MONONOKE_ENGINE_DIRと再生するrunsのディレクトリを指定してください。');
const run = path.resolve(process.argv[2]);
const summary = JSON.parse(await readFile(path.join(run, 'summary.json'), 'utf8'));
const decisions = (await readFile(path.join(run, 'decisions.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
const { createSim } = await import(pathToFileURL(path.join(sourceDirectory, 'sim.js')));
const { createConfig } = await import(pathToFileURL(path.join(sourceDirectory, 'config.js')));
const cfg = createConfig();
const sim = createSim(summary.challenge, cfg);
const options = { route: false, depth: 20, width: 24, ...JSON.parse(process.env.PLANNER_OPTIONS || '{}') };
const policy = new PlannerPolicy({ ...await loadPredictionEngine({ sourceDirectory }), ...options });
let baseline;
if (process.env.MONONOKE_BASELINE_DIR) {
  const root = path.resolve(process.env.MONONOKE_BASELINE_DIR);
  const { loadPredictionEngine: load } = await import(pathToFileURL(path.join(root, 'src/engine.js')));
  const { PlannerPolicy: Policy } = await import(pathToFileURL(path.join(root, 'src/planner.js')));
  baseline = new Policy({ ...await load({ sourceDirectory }), ...options });
}
const timing = { beforeMs: 0, afterMs: 0 };
let checked = 0;
for (const recorded of decisions) {
  while (sim.state.elapsedMs < recorded.elapsedMs - 0.00001 && sim.state.status === 'playing') {
    sim.step(); sim.drainEvents();
  }
  assert.ok(Math.abs(sim.state.elapsedMs - recorded.elapsedMs) < 0.00001);
  assert.deepEqual({ x: sim.state.player.x, y: sim.state.player.y }, recorded.position);
  const snapshot = JSON.parse(JSON.stringify(projectState(sim.state, cfg, summary.challenge)));
  const forecasts = new Map();
  const order = checked % 2 ? [['beforeMs', baseline], ['afterMs', policy]] : [['afterMs', policy], ['beforeMs', baseline]];
  for (const [name, candidate] of order) if (candidate) {
    candidate.synchronize(snapshot);
    const start = performance.now();
    const forecast = candidate.chooseRollingAction(candidate.mirror, snapshot);
    timing[name] += performance.now() - start;
    forecasts.set(name, forecast);
    candidate.recordAction(snapshot, recorded.action);
  }
  const result = forecasts.get('afterMs');
  assert.deepEqual(result.candidates, recorded.candidates, `候補の評価値: ${recorded.elapsedMs}ms`);
  if (baseline) assert.deepEqual(result, forecasts.get('beforeMs'), `選択・枝数・全評価: ${recorded.elapsedMs}ms`);
  if (recorded.action !== 'wait') sim.input(recorded.action);
  checked++;
}
while (sim.state.status === 'playing') { sim.step(); sim.drainEvents(); }
assert.equal(sim.state.status, summary.status === 'failed' ? 'dying' : summary.status);
const result = { run, challenge: summary.challenge, options, checked, status: sim.state.status,
  damageTaken: sim.state.damageTaken, ...timing, speedup: baseline ? timing.beforeMs / timing.afterMs : null };
await writeFile(process.env.REPLAY_OUTPUT || 'verification/jev-exact-speed-replay.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
