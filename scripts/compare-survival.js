import { parseArgs } from 'node:util';
import { mkdir, appendFile, writeFile, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright';
import { loadPredictionEngine } from '../src/engine.js';
import { configureGame, playSession } from '../src/cli.js';
import { EXPERIMENT_OPTIONS, EXPERIMENT_ENEMIES, experimentPolicy, simulatorTrial, finishTrial } from '../src/experiment.js';
import { writeExperimentReport } from '../src/experiment-report.js';
import { validateEnemyCounts } from '../src/state.js';

const { values } = parseArgs({ options: {
  mode: { type: 'string', default: 'simulator' }, live: { type: 'boolean', default: false },
  'seed-count': { type: 'string', default: '1' }, 'start-seed': { type: 'string', default: '1' },
  repeats: { type: 'string', default: '1' }, time: { type: 'string', default: '30' },
  'max-calls': { type: 'string', default: '300' }, 'selection-seed': { type: 'string', default: '1' },
  output: { type: 'string' }, 'no-plot': { type: 'boolean', default: false },
  enemies: { type: 'string' },
} });
function integer(name, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const n = Number(values[name]);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`${name}は${min}～${max}の整数で指定してください。`);
  return n;
}
const seedCount = integer('seed-count'), repeats = integer('repeats'), time = integer('time');
const startSeed = integer('start-seed', 0, 0xffffffff), selectionSeed = integer('selection-seed', 0, 0xffffffff);
const maxCalls = integer('max-calls', 0);
const enemyCounts = validateEnemyCounts(values.enemies ? JSON.parse(values.enemies) : EXPERIMENT_ENEMIES);
if (!Number.isSafeInteger(seedCount * repeats * 2)) throw new Error('予定試行数が安全な整数範囲を超えます。');
if (!['simulator', 'browser'].includes(values.mode)) throw new Error('modeはsimulatorまたはbrowserです。');
if (![30, 120].includes(time)) throw new Error('比較のtimeは30または120秒です。');
if (startSeed + seedCount - 1 > 0xffffffff) throw new Error('ゲームシードが32bit範囲を超えます。');
if (values.live && !process.env.TYPESAFE_API_KEY) throw new Error('実JevにはTYPESAFE_API_KEYが必要です。');
const directory = path.resolve(values.output ?? `runs/comparison-${new Date().toISOString().replaceAll(':', '-')}`);
await mkdir(directory, { recursive: true });
// 上書きで以前の結果を消さない。
await writeFile(path.join(directory, 'trials.json'), '[]', { flag: 'wx' });
const controller = new AbortController();
const interrupt = () => controller.abort();
process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
const started = performance.now(), engine = await loadPredictionEngine();
const enginePreparationMs = performance.now() - started;
let browser, page;
const methods = ['random', values.live ? 'jev' : 'mock-jev'];
const model = process.env.JEV_MODEL || 'jev-latest';
const sourceFiles = ['src/adapter.js', 'src/state.js', 'src/planner.js', 'src/survival.js', 'src/jev.js',
  'src/engine.js', 'src/cli.js', 'src/experiment.js', 'src/experiment-report.js', 'scripts/compare-survival.js'];
const sourceContents = await Promise.all(sourceFiles.map(async name => [name, await readFile(new URL(`../${name}`, import.meta.url), 'utf8')]));
const manifest = { version: 1, issue: 'https://github.com/SSsan-00/mononoke-autoplay/issues/1',
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  codeDigest: createHash('sha256').update(JSON.stringify(sourceContents)).digest('hex'),
  rulesDigest: engine.rulesDigest, predictionDigest: engine.digest,
  startedAt: new Date().toISOString(), mode: values.mode, live: values.live,
  model: values.live ? model : 'mock (last supplied candidate)', time,
  profile: { field: 'S', lives: 1, time, enemies: enemyCounts },
  options: EXPERIMENT_OPTIONS, seedCount, repeats, plannedTrials: seedCount * repeats * 2,
  startSeed: values.mode === 'simulator' ? startSeed : null,
  selectionSeed, maxCalls, retryPolicy: 'none; stop entire batch on HTTP 401/402/403, global call limit, or 3 consecutive Jev trials aborted for the same reason',
  executionOrder: 'alternate method order by seed index and repetition; sequential',
  node: process.version, os: `${os.platform()} ${os.release()} ${os.arch()}`,
  cpu: os.cpus()[0]?.model, memoryBytes: os.totalmem(), enginePreparationMs,
  browser: null, browserPreparationMs: null, completed: false };
const records = [], seenSeeds = new Set();
let usedCalls = 0, stopReason = null, lastJevError = null, jevErrorCount = 0;
const save = async () => {
  await writeFile(path.join(directory, 'trials.json'), JSON.stringify(records, null, 2));
  await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2));
};
await save();
console.log(JSON.stringify({ output: directory, mode: manifest.mode, live: values.live,
  plannedTrials: manifest.plannedTrials, globalApiCallLimit: maxCalls, enginePreparationMs }));

async function browserSetup() {
  const adjust = page.getByRole('button', { name: /^(結界条件を再調整|脅威度を上げて挑む)$/ });
  if (await adjust.count()) await adjust.click();
  else if (await page.getByRole('button', { name: 'THREAT SETUP へ戻る', exact: true }).isVisible())
    await page.getByRole('button', { name: 'THREAT SETUP へ戻る', exact: true }).click();
  await configureGame(page, { field: 'S', lives: '1', time: String(time), enemyCounts });
}

try {
  if (values.mode === 'browser') {
    const before = performance.now();
    browser = await chromium.launch({ headless: true });
    manifest.browser = browser.version();
    page = await browser.newPage({ viewport: { width: 400, height: 700 } });
    await page.goto('https://aigengames.pages.dev/Games/SurviveLimitMononoke/', { waitUntil: 'domcontentloaded' });
    await browserSetup();
    manifest.browserPreparationMs = performance.now() - before;
  }
  for (let index = 0; index < seedCount; index++) {
    let gameSeed = values.mode === 'simulator' ? startSeed + index : null;
    let startButton = '百鬼結界にいざ出陣';
    if (page && index > 0 && !stopReason) await browserSetup();
    for (let repeat = 0; repeat < repeats; repeat++) {
      const order = (index + repeat + (values.mode === 'simulator' ? startSeed - 1 : 0)) % 2 ? [...methods].reverse() : methods;
      for (const method of order) {
        if (controller.signal.aborted) stopReason ??= 'CANCELLED';
        const trialId = `${index + 1}-${repeat + 1}-${method}`;
        const identity = { trialId, pairId: `${index + 1}-${repeat + 1}`, method,
          seedIndex: index + 1, repeat: repeat + 1,
          selectionSeed: (selectionSeed + index * repeats + repeat) >>> 0 };
        if (stopReason) {
          records.push({ ...identity, status: 'not-started', abortReason: stopReason,
            challenge: gameSeed === null ? null : { ...manifest.profile, seed: gameSeed } });
          continue;
        }
        const logFile = `decisions/${trialId}.jsonl`;
        await mkdir(path.join(directory, 'decisions'), { recursive: true });
        await writeFile(path.join(directory, logFile), '');
        const before = performance.now();
        const policy = experimentPolicy(engine, method, { selectionSeed: identity.selectionSeed,
          apiKey: process.env.TYPESAFE_API_KEY, model, maxCalls: Math.max(0, maxCalls - usedCalls),
          mock: !values.live, signal: controller.signal });
        const preparationMs = performance.now() - before;
        const samples = [];
        const onDecision = async d => { samples.push(d); await appendFile(path.join(directory, logFile), JSON.stringify(d) + '\n'); };
        let summary;
        if (page) {
          try {
            summary = await playSession(page, policy, { startButton, intervalMs: 100,
              maxDecisions: time * 10 + 100, onDecision,
              onState: state => {
                if (gameSeed === null) {
                  gameSeed = state.challenge.seed;
                  if (seenSeeds.has(gameSeed)) throw Object.assign(new Error('Duplicate seed'), { code: 'DUPLICATE_GAME_SEED' });
                  seenSeeds.add(gameSeed);
                }
                if (state.challenge.seed !== gameSeed) throw Object.assign(new Error('Seed mismatch'), { code: 'GAME_SEED_MISMATCH' });
              } });
            await page.getByRole('button', { name: '同条件で再出陣', exact: true }).waitFor({ timeout: 15000 });
            startButton = '同条件で再出陣';
          } catch (error) {
            summary = error.session ?? { status: 'aborted', abortReason: error.code ?? 'BROWSER_ERROR', survivedMs: null, realElapsedMs: null };
            // ゲーム自身の一時停止とやり直すUIで、内部のseedや状態を変更せず再開する。
            try {
              const retry = page.getByRole('button', { name: '同条件で再出陣', exact: true });
              if (await retry.isVisible()) startButton = '同条件で再出陣';
              else {
                await page.getByRole('button', { name: 'II', exact: true }).click({ timeout: 5000 });
                await page.getByRole('button', { name: 'やり直す', exact: true }).waitFor({ timeout: 5000 });
                startButton = 'やり直す';
              }
            } catch { stopReason = 'BROWSER_RESTART_UNAVAILABLE'; }
          }
        } else summary = await simulatorTrial(engine, { ...manifest.profile, seed: gameSeed }, policy, onDecision);
        if (summary.failedDecision) await appendFile(path.join(directory, logFile), JSON.stringify({ ...summary.failedDecision,
          elapsedMs: summary.elapsedMs, status: 'aborted', abortReason: summary.abortReason }) + '\n');
        const record = { ...identity, ...finishTrial(summary, samples, policy), gameSeed, logFile, preparationMs,
          model: method === 'random' ? null : manifest.model, finishedAt: new Date().toISOString() };
        records.push(record); usedCalls += policy.calls ?? 0;
        if (method !== 'random') {
          if (record.status === 'aborted') {
            jevErrorCount = record.abortReason === lastJevError ? jevErrorCount + 1 : 1;
            lastJevError = record.abortReason;
            if (jevErrorCount >= 3) stopReason = `PERSISTENT_${record.abortReason}`;
          } else { lastJevError = null; jevErrorCount = 0; }
        }
        if (['HTTP_401', 'HTTP_402', 'HTTP_403', 'API_CALL_LIMIT', 'CANCELLED', 'DUPLICATE_GAME_SEED', 'GAME_SEED_MISMATCH'].includes(record.abortReason))
          stopReason = record.abortReason;
        await save();
        console.log(JSON.stringify({ trial: records.length, of: manifest.plannedTrials, trialId, gameSeed,
          status: record.status, survivedMs: record.survivedMs, abortReason: record.abortReason,
          calls: record.calls, usedCalls, inputTokens: record.inputTokens,
          realElapsedMs: record.realElapsedMs, simulatorElapsedMs: record.simulatorElapsedMs }));
      }
    }
  }
} catch (error) {
  stopReason = error.code ?? 'EXPERIMENT_SETUP_ERROR';
  console.error(`実験を停止: ${stopReason}`);
} finally {
  await browser?.close();
  process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
  manifest.completed = records.length === manifest.plannedTrials && !records.some(r => r.status === 'not-started');
  manifest.stoppedReason = stopReason;
  manifest.finishedAt = new Date().toISOString();
  manifest.batchElapsedMs = performance.now() - started;
  await save();
  await writeExperimentReport(directory);
  if (!values['no-plot']) {
    try { execFileSync(process.env.MONONOKE_PYTHON || 'python3', [fileURLToPath(new URL('./plot-survival.py', import.meta.url)), directory], { stdio: 'inherit' }); }
    catch { console.error('グラフ未生成: matplotlibがあるPythonをMONONOKE_PYTHONで指定して再集計してください。'); }
  }
  console.log(`集計・検証報告: ${path.join(directory, 'REPORT.md')}`);
}
