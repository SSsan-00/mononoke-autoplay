// 有料APIは呼びません。候補内の選択とローカル先読みを原本のルールで検証します。
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { writeFile, mkdir } from 'node:fs/promises';
import { loadPredictionEngine } from '../src/engine.js';
import { PlannerPolicy } from '../src/planner.js';
import { JevPolicy } from '../src/jev.js';
import { projectState } from '../src/state.js';
const directory = process.env.MONONOKE_ENGINE_DIR;
if (!directory) throw new Error('MONONOKE_ENGINE_DIRに原本のjs/coreを指定してください。');
const { createSim } = await import(pathToFileURL(path.join(directory, 'sim.js')));
const { createConfig } = await import(pathToFileURL(path.join(directory, 'config.js')));
const engine = await loadPredictionEngine({ sourceDirectory: directory });
const options = { depth: 20, width: 24, ...JSON.parse(process.env.PLANNER_OPTIONS || '{}') };
const profiles = JSON.parse(process.env.BENCHMARK_PROFILES || '[{"field":"L","lives":1,"time":30},{"field":"S","lives":1,"time":30}]');
const seeds = JSON.parse(process.env.BENCHMARK_SEEDS || '[1,6]');
const records = [];
const output = path.resolve(process.env.BENCHMARK_OUTPUT || 'verification/jev-assisted-benchmark.json');
await mkdir(path.dirname(output), { recursive: true });
for (const profile of profiles) for (const seed of seeds) {
  const cfg = createConfig();
  const challenge = { ...profile, seed, enemies: { CHASER:5,DASHER:5,SHOOTER:5,LASER:5,MINE:5,JAMMER:5 } };
  const sim = createSim(challenge, cfg);
  const planner = new PlannerPolicy({ ...engine, ...options, route: false });
  // 最も評価の低い許可候補を選ぶ模擬API。実Jevの成功率や通信時間は測定しません。
  const policy = new JevPolicy({ apiKey: 'mock', planner, fetchImpl: async (_, request) => {
    const body = JSON.parse(request.body);
    const candidates = body.state.prediction.candidates;
    return { ok: true, json: async () => ({ answers: { move: { type: 'choice', choice: candidates.at(-1).action } } }) };
  } });
  let next = 0, decisions = 0, firstDecisionMs;
  const started = performance.now();
  while (sim.state.status === 'playing') {
    if (!sim.isMoving() && sim.state.elapsedMs + 1e-7 >= next) {
      const decisionStarted = performance.now();
      const d = await policy.decide(JSON.parse(JSON.stringify(projectState(sim.state, cfg, challenge))));
      firstDecisionMs ??= performance.now() - decisionStarted;
      if (d.action !== 'wait') sim.input(d.action);
      next = sim.state.elapsedMs + planner.intervalMs;
      decisions++;
    }
    sim.step(); sim.drainEvents();
  }
  const result = { ...profile, seed, ...sim.result(), decisions, calls: policy.calls,
    firstDecisionMs, totalDecisionMs: performance.now() - started };
  records.push(result);
  await writeFile(output, JSON.stringify({ mode: 'mock Jev, lowest-ranked eligible choice; original game rules; no API cost', options, records }, null, 2));
  console.log(JSON.stringify(result));
}
