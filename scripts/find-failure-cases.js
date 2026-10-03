// S・30秒・ライフ1・深さ20・幅24を固定。ゲームが許可する各10体・計30体以内を探索。
import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { loadPredictionEngine } from '../src/engine.js';
import { experimentPolicy, simulatorTrial, finishTrial, EXPERIMENT_OPTIONS } from '../src/experiment.js';
import { parseArgs } from 'node:util';
import { validateEnemyCounts } from '../src/state.js';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { 'confirm-profile': { type: 'string' } } });
const explicitProfile = values['confirm-profile'] ? validateEnemyCounts(JSON.parse(values['confirm-profile'])) : null;
const directory = path.resolve(positionals[0] || 'runs/failure-search');
await mkdir(directory, { recursive: true });
await writeFile(path.join(directory, 'records.json'), '[]', { flag: 'wx' });
const engine = await loadPredictionEngine();
const types = ['CHASER', 'DASHER', 'SHOOTER', 'LASER', 'MINE', 'JAMMER'];
const triples = [ ['CHASER','DASHER','JAMMER'], ['CHASER','LASER','JAMMER'],
  ['DASHER','LASER','JAMMER'], ['CHASER','DASHER','LASER'] ];
for (let a = 0; a < types.length; a++) for (let b = a + 1; b < types.length; b++)
  for (let c = b + 1; c < types.length; c++) {
    const triple = [types[a], types[b], types[c]];
    if (!triples.some(t => [...t].sort().join() === [...triple].sort().join())) triples.push(triple);
  }
const profiles = triples.map(t => Object.fromEntries(types.map(type => [type, t.includes(type) ? 10 : 0])));
const records = [];
const manifest = { commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  startedAt: new Date().toISOString(), rulesDigest: engine.rulesDigest,
  fixed: { field: 'S', time: 30, lives: 1, ...EXPERIMENT_OPTIONS },
  mode: 'original simulator, random selection, no API',
  design: 'Screen up to 20 three-species profiles at 10 each, seeds 1 and 2; first profile with an observed failure gets held-out seeds 3..12 with independent selection seeds 11 and 29. Not an exhaustive optimum search.' };
if (explicitProfile) manifest.design = 'Confirm a previously screened profile on held-out game seeds 3..12, two independent selection seeds (11 and 29) each; selection and validation are separate.';
await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2));
const controller = new AbortController();
const interrupt = () => controller.abort();
process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);

async function run(enemies, seed, selectionSeed, phase) {
  const challenge = { field: 'S', time: 30, lives: 1, enemies, seed };
  const policy = experimentPolicy(engine, 'random', { selectionSeed, signal: controller.signal });
  let state;
  const decide = policy.decide.bind(policy);
  policy.decide = async snapshot => { state = snapshot; return decide(snapshot); };
  const samples = [], trialId = `${records.length + 1}-${phase}`;
  const logFile = `${trialId}.jsonl`;
  await writeFile(path.join(directory, logFile), '');
  const summary = await simulatorTrial(engine, challenge, policy, async d => {
    samples.push(d);
    await appendFile(path.join(directory, logFile), JSON.stringify({ ...d, state }) + '\n');
  });
  const record = { phase, selectionSeed, trialId, logFile, ...finishTrial(summary, samples, policy) };
  records.push(record);
  await writeFile(path.join(directory, 'records.json'), JSON.stringify(records, null, 2));
  console.log(JSON.stringify({ trialId, enemies, seed, selectionSeed, status: record.status,
    survivedMs: record.survivedMs, seconds: record.simulatorElapsedMs / 1000 }));
  return record;
}

let selected = explicitProfile;
try {
  if (!selected) for (const enemies of profiles) {
    const results = [];
    for (const seed of [1, 2]) {
      if (controller.signal.aborted) break;
      results.push(await run(enemies, seed, seed, 'screen'));
    }
    if (controller.signal.aborted) break;
    if (results.some(r => r.status === 'failed')) { selected = enemies; break; }
  }
  if (selected) for (let seed = 3; seed <= 12 && !controller.signal.aborted; seed++)
    for (const selectionSeed of [11, 29]) {
      if (controller.signal.aborted) break;
      await run(selected, seed, selectionSeed, 'confirm');
    }
} finally {
  process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
  const normal = records.filter(r => ['cleared', 'failed'].includes(r.status));
  const confirm = normal.filter(r => r.phase === 'confirm');
  const report = { selected, completed: !controller.signal.aborted, totalTrials: records.length,
    failures: normal.filter(r => r.status === 'failed').length,
    confirmationTrials: confirm.length, confirmationFailures: confirm.filter(r => r.status === 'failed').length,
    confirmationGameSeeds: new Set(confirm.map(r => r.challenge.seed)).size,
    confirmedFailingGameSeeds: [...new Set(confirm.filter(r => r.status === 'failed').map(r => r.challenge.seed))],
    finishedAt: new Date().toISOString() };
  await writeFile(path.join(directory, 'summary.json'), JSON.stringify(report, null, 2));
  await writeFile(path.join(directory, 'REPORT.md'), `# S盤面・30秒の敗北条件探索\n\n\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\`\n\nライフ1、共通20手生存候補から均等ランダム選択。APIは不使用。各敵10体・合計30体のゲーム設定範囲内です。探索で選んだ条件と、独立シードでの確認結果を区別し、全体の最難構成とは断定しません。判断JSONLには観測状態と候補も保存しています。\n`);
  console.log(JSON.stringify(report));
}
