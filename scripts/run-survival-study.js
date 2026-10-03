// 各段階を順次実行。API異常で止まった段階は再試行せず、その時点で報告する。
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { distribution } from '../src/experiment.js';

if (!process.argv[2]) throw new Error('結果を保存する新規ディレクトリを指定してください。');
if (!process.env.TYPESAFE_API_KEY) throw new Error('TYPESAFE_API_KEYが必要です。');
const root = path.resolve(process.argv[2]);
let currentChild;
const interrupt = () => currentChild?.kill('SIGINT');
process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
await mkdir(root, { recursive: true });
const state = { startedAt: new Date().toISOString(), status: 'running', phases: [],
  apiCallLimitPerPhase: 1000000, plan: '30s simulator pilot (60), browser timing pilot (60), simulator full (1000); extend to 120s if both full clear rates >=95% and paired survival CI includes zero' };
await writeFile(path.join(root, 'study.json'), JSON.stringify(state, null, 2), { flag: 'wx' });
const save = () => writeFile(path.join(root, 'study.json'), JSON.stringify(state, null, 2));

async function phase(name, mode, time, seeds, repeats) {
  const directory = path.join(root, name);
  const entry = { name, mode, time, scheduled: seeds * repeats * 2, status: 'running', startedAt: new Date().toISOString() };
  state.phases.push(entry); state.currentPhase = name; await save();
  const child = spawn(process.execPath, [fileURLToPath(new URL('./compare-survival.js', import.meta.url)),
    '--live', '--mode', mode, '--time', String(time), '--seed-count', String(seeds), '--repeats', String(repeats),
    '--max-calls', String(state.apiCallLimitPerPhase), '--output', directory], { stdio: 'inherit' });
  currentChild = child;
  entry.pid = child.pid; await save();
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  currentChild = null;
  entry.exitCode = code; entry.finishedAt = new Date().toISOString();
  const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
  entry.status = manifest.completed && !manifest.stoppedReason && code === 0 ? 'completed' : 'stopped';
  entry.reason = manifest.stoppedReason ?? (code ? 'PROCESS_ERROR' : null);
  await save();
  if (entry.status !== 'completed') throw Object.assign(new Error('実験の段階が中断しました。'), { code: entry.reason ?? 'INCOMPLETE_PHASE' });
  return JSON.parse(await readFile(path.join(directory, 'aggregate.json'), 'utf8'));
}

try {
  const pilot = await phase('pilot-30', 'simulator', 30, 30, 1);
  const trials = JSON.parse(await readFile(path.join(root, 'pilot-30', 'trials.json'), 'utf8'));
  const jev = trials.filter(r => r.method === 'jev');
  state.estimate = { fromTrialsPerMethod: 30,
    expectedCallsFor500JevTrials: distribution(jev.map(r => r.calls)).mean * 500,
    expectedObservedInputTokensFor500JevTrials: distribution(jev.map(r => r.inputTokens)).mean * 500,
    expectedSimulatorFullMs: distribution(trials.map(r => r.simulatorElapsedMs)).mean * 1000,
    pilotClearRates: Object.fromEntries(Object.entries(pilot.methods).map(([key, value]) => [key, value.clearRate])) };
  await writeFile(path.join(root, 'ESTIMATE.md'), `# 30試行ずつのpilotによる見積もり\n\n\`\`\`json\n${JSON.stringify(state.estimate, null, 2)}\n\`\`\`\n\n使用量は観測できた入力トークンであり、料金の見積もりではありません。API上限は各段階100万回、再試行なし。利用者から本実験とAPI利用の承認を得ています。\n`);
  await save();
  await phase('browser-pilot-30', 'browser', 30, 30, 1);
  const full = await phase('full-30', 'simulator', 30, 100, 5);
  const [lo, hi] = full.paired.survivalSeconds.ci95 ?? [Infinity, Infinity];
  if (Object.values(full.methods).every(m => m.clearRate >= 0.95) && lo <= 0 && hi >= 0) {
    state.extensionReason = 'Both 30s full clear rates >=95% and survival-difference interval includes zero; extend to 120s.';
    await save();
    await phase('browser-pilot-120', 'browser', 120, 30, 1);
    await phase('full-120', 'simulator', 120, 100, 5);
  }
  state.status = 'completed';
} catch (error) {
  state.status = 'stopped'; state.stoppedReason = error.code ?? 'STUDY_ERROR';
} finally {
  process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
  state.finishedAt = new Date().toISOString(); await save();
  let report = `# issue #1の実験進捗\n\n状態: **${state.status}**。開始: ${state.startedAt}。\n\n`;
  report += '| 段階 | 経路 | 秒 | 予定試行数 | 状態 |\n|---|---|---:|---:|---|\n';
  for (const p of state.phases) report += `| [${p.name}](${p.name}/REPORT.md) | ${p.mode} | ${p.time} | ${p.scheduled} | ${p.status} ${p.reason ?? ''} |\n`;
  if (state.stoppedReason) report += `\n停止理由: ${state.stoppedReason}。後続の予定段階は未実行です。\n`;
  if (state.estimate) report += '\n[API使用量と所要時間の見積もり](ESTIMATE.md)\n';
  report += '\n生存性能の本実験は原本シミュレーターで1,000試行、ブラウザの実時間評価は各条件60試行を別集計します。API異常を敗北へ置き換えず、各段階のJSONLと集計結果を残します。\n';
  await writeFile(path.join(root, 'STUDY.md'), report);
  console.log(`実験全体の報告: ${path.join(root, 'STUDY.md')}`);
}
