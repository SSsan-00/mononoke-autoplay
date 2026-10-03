// 独立したゲームシードを別プロセスへ配分。候補生成やゲームのルールは変更しない。
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, open } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateEnemyCounts } from '../src/state.js';
import { writeExperimentReport } from '../src/experiment-report.js';

const { values } = parseArgs({ options: {
  output: { type: 'string' }, live: { type: 'boolean', default: false },
  workers: { type: 'string', default: '4' }, minutes: { type: 'string', default: '60' },
  'start-seed': { type: 'string', default: '1' },
  'seed-count': { type: 'string', default: '100' }, repeats: { type: 'string', default: '5' },
  enemies: { type: 'string', default: '{"CHASER":10,"DASHER":10,"JAMMER":10}' },
  'no-plot': { type: 'boolean', default: false },
} });
const integer = name => {
  const n = Number(values[name]);
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`${name}は正の整数が必要です。`);
  return n;
};
const seedCount = integer('seed-count'), repeats = integer('repeats'), startSeed = integer('start-seed');
if (startSeed + seedCount - 1 > 0xffffffff || startSeed + seedCount * repeats - 1 > 0xffffffff)
  throw new Error('ゲームまたは選択用シードが32bit範囲を超えます。');
const workers = Math.min(integer('workers'), seedCount), minutes = integer('minutes');
if (workers > 8 || minutes > 60) throw new Error('workersは最大8、minutesは最大60です。');
if (!values.output) throw new Error('新規のoutputディレクトリが必要です。');
const enemyCounts = validateEnemyCounts(JSON.parse(values.enemies));
if (values.live && !process.env.TYPESAFE_API_KEY) throw new Error('実JevにはTYPESAFE_API_KEYが必要です。');
const directory = path.resolve(values.output);
await mkdir(directory, { recursive: true });
const started = Date.now(), children = [], shards = [];
let stoppedReason = null;
await writeFile(path.join(directory, 'parallel.json'), '{}', { flag: 'wx' });
const stop = reason => {
  stoppedReason ??= reason;
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGINT');
};
const interrupt = () => stop('CANCELLED');
process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
// 集計のために30秒を予約。時間制限での欠測は敗北扱いしない。
const timer = setTimeout(() => stop('TIME_LIMIT'), Math.max(1000, minutes * 60000 - 30000));
const save = status => writeFile(path.join(directory, 'parallel.json'), JSON.stringify({
  status, startedAt: new Date(started).toISOString(), workers, minutes,
  plannedTrials: seedCount * repeats * 2, seedCount, repeats, startSeed, stoppedReason,
  elapsedMs: Date.now() - started, shards,
}, null, 2));
try {
  let offset = 0;
  const jobs = [];
  for (let i = 0; i < workers; i++) {
    const count = Math.floor(seedCount / workers) + Number(i < seedCount % workers);
    const name = `shard-${i + 1}`, shardDirectory = path.join(directory, name);
    const log = await open(path.join(directory, `${name}.log`), 'wx');
    const shard = { name, startSeed: offset + startSeed, seedCount: count, seedOffset: offset };
    shards.push(shard);
    const child = spawn(process.execPath, [fileURLToPath(new URL('./compare-survival.js', import.meta.url)),
      '--mode', 'simulator', '--time', '30', '--start-seed', String(offset + startSeed),
      '--seed-count', String(count), '--repeats', String(repeats),
      '--selection-seed', String(startSeed + offset * repeats), '--enemies', JSON.stringify(enemyCounts),
      '--max-calls', '1000000', '--output', shardDirectory, '--no-plot', ...(values.live ? ['--live'] : [])],
    { stdio: ['ignore', log.fd, log.fd] });
    children.push(child); shard.pid = child.pid; offset += count;
    jobs.push(new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', async code => {
        shard.exitCode = code;
        try {
          const manifest = JSON.parse(await readFile(path.join(shardDirectory, 'manifest.json'), 'utf8'));
          shard.stoppedReason = manifest.stoppedReason;
          if (manifest.stoppedReason && manifest.stoppedReason !== 'CANCELLED') stop(manifest.stoppedReason);
          await save('running'); resolve();
        } catch (error) { stop('SHARD_ERROR'); reject(error); }
        finally { await log.close(); }
      });
    }));
  }
  await save('running');
  const results = await Promise.allSettled(jobs);
  if (results.some(r => r.status === 'rejected')) throw new Error('並列子プロセスの結果を読み込めません。ログを確認してください。');
  const records = [], manifests = [];
  for (const shard of shards) {
    const folder = path.join(directory, shard.name);
    const manifest = JSON.parse(await readFile(path.join(folder, 'manifest.json'), 'utf8'));
    manifests.push(manifest);
    const trials = JSON.parse(await readFile(path.join(folder, 'trials.json'), 'utf8'));
    for (const trial of trials) {
      const seedIndex = trial.seedIndex + shard.seedOffset;
      records.push({ ...trial, seedIndex, trialId: `${seedIndex}-${trial.repeat}-${trial.method}`,
        pairId: `${seedIndex}-${trial.repeat}`, logFile: trial.logFile ? `${shard.name}/${trial.logFile}` : undefined });
    }
  }
  if (new Set(manifests.map(m => m.codeDigest + m.rulesDigest)).size !== 1)
    throw new Error('子プロセス間のコードまたはゲーム原本が一致しません。');
  const manifest = { ...manifests[0], seedCount, repeats, plannedTrials: seedCount * repeats * 2,
    startedAt: new Date(started).toISOString(), finishedAt: new Date().toISOString(),
    executionOrder: `parallel ${workers} processes; seed-disjoint shards; each pair sequential`,
    parallelWorkers: workers, timeLimitMinutes: minutes, maxCalls: 1000000 * workers,
    timingScope: 'Concurrent simulator throughput only; not isolated latency or browser timing',
    completed: manifests.every(m => m.completed) && !stoppedReason,
    stoppedReason, batchElapsedMs: Date.now() - started };
  await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2));
  await writeFile(path.join(directory, 'trials.json'), JSON.stringify(records, null, 2));
  await writeExperimentReport(directory);
  if (!values['no-plot']) {
    try { execFileSync(process.env.MONONOKE_PYTHON || 'python3',
      [fileURLToPath(new URL('./plot-survival.py', import.meta.url)), directory], { stdio: 'inherit' }); }
    catch { console.error('グラフは未生成。JSONとMarkdownの集計は保存しました。'); }
  }
  await save(manifest.completed ? 'completed' : 'partial');
  console.log(`並列比較結果: ${path.join(directory, 'REPORT.md')}`);
} finally {
  clearTimeout(timer);
  process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
  stop(stoppedReason ?? 'CANCELLED');
}
