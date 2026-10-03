// 生存性能の比較とは別に、30判断だけでブラウザ制御の時間内訳を調べる。API不使用。
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { GameAdapter } from '../src/adapter.js';
import { configureGame, playSession } from '../src/cli.js';
import { loadPredictionEngine } from '../src/engine.js';
import { experimentPolicy, distribution } from '../src/experiment.js';

const output = path.resolve(process.argv[2] || 'runs/browser-profile');
await mkdir(output, { recursive: true });
await writeFile(path.join(output, 'profile.json'), '{}', { flag: 'wx' });
const samples = {}, decisions = [], record = (key, ms) => (samples[key] ??= []).push(ms);
const attach = GameAdapter.prototype.attach;
GameAdapter.prototype.attach = async function (...args) {
  await attach.apply(this, args);
  const send = this.session.send.bind(this.session);
  this.session.send = async (method, params) => {
    const started = performance.now();
    try { return await send(method, params); }
    finally { record(`CDP:${method}`, performance.now() - started); }
  };
};
for (const method of ['nextState', 'act']) {
  const original = GameAdapter.prototype[method];
  GameAdapter.prototype[method] = async function (...args) {
    const started = performance.now();
    try { return await original.apply(this, args); }
    finally { record(method, performance.now() - started); }
  };
}
const engine = await loadPredictionEngine();
const browser = await chromium.launch({ headless: true });
let summary, errorCode;
try {
  const page = await browser.newPage({ viewport: { width: 400, height: 700 } });
  await page.goto('https://aigengames.pages.dev/Games/SurviveLimitMononoke/', { waitUntil: 'domcontentloaded' });
  await configureGame(page, { field: 'S', lives: '1', time: '30',
    enemyCounts: { CHASER: 10, DASHER: 10, JAMMER: 10 } });
  const policy = experimentPolicy(engine, 'random', { selectionSeed: 301 });
  try {
    summary = await playSession(page, policy, { onDecision: d => {
      decisions.push(d);
      if (decisions.length >= 30) throw Object.assign(new Error('Profile finished'), { code: 'PROFILE_COMPLETE' });
    } });
  } catch (error) { summary = error.session; errorCode = error.code; }
} finally { await browser.close(); }
const report = { scope: 'Isolated headless browser, random policy, up to 30 decisions, no API. Instrumentation adds overhead.',
  rulesDigest: engine.rulesDigest, summary, errorCode, decisions: decisions.length,
  timings: Object.fromEntries(Object.entries(samples).map(([key, values]) => [key, distribution(values)])),
  predictionMs: distribution(decisions.map(d => d.predictionMs)),
  note: 'nextState includes waiting for the pause plus state extraction; act includes CDP calls. Nested timings must not be summed together.' };
await writeFile(path.join(output, 'profile.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
