import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { configureGame, playSession } from '../src/cli.js';
import { loadPredictionEngine } from '../src/engine.js';
import { JevPolicy } from '../src/jev.js';
import { PlannerPolicy } from '../src/planner.js';
import { RandomPolicy } from '../src/survival.js';

test('ブラウザ中断の計測・停止解除・UIで同一シードを再実行する',
  { skip: process.env.RUN_BROWSER_TESTS !== '1', timeout: 120000 }, async t => {
    const engine = await loadPredictionEngine();
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 400, height: 700 } });
    await page.goto('https://aigengames.pages.dev/Games/SurviveLimitMononoke/', { waitUntil: 'domcontentloaded' });
    const enemyCounts = { CHASER: 10, DASHER: 10, SHOOTER: 0, LASER: 0, MINE: 0, JAMMER: 10 };
    await configureGame(page, { field: 'S', lives: '1', time: '30', enemyCounts });
    const planner = () => new PlannerPolicy({ ...engine, depth: 20, width: 24, route: false });
    let first;
    const jev = new JevPolicy({ planner: planner(), comparison: true, apiKey: 'mock',
      fetchImpl: async () => ({ ok: false, status: 503 }) });
    await assert.rejects(playSession(page, jev, { onState: s => { first ??= s; } }), error => {
      assert.equal(error.session.abortReason, 'HTTP_503');
      assert.ok(error.session.realElapsedMs >= 0);
      assert.equal(error.session.survivedMs, null);
      assert.equal(error.session.failedDecision.apiAttempted, true);
      return true;
    });
    assert.equal(await page.evaluate(() => 1), 1, 'デバッガ停止は解除済み');
    assert.deepEqual(first.challenge.enemies, { CHASER: 10, DASHER: 10, JAMMER: 10 }, '各10体の構成を通常の設定UIで指定できる');
    await page.getByRole('button', { name: 'II', exact: true }).click();
    const random = new RandomPolicy({ planner: planner(), selectionSeed: 7 });
    let decisions = 0;
    await assert.rejects(playSession(page, random, { startButton: 'やり直す',
      onState: s => {
        assert.deepEqual(s.challenge, first.challenge);
        if (decisions >= 2) throw Object.assign(new Error('Test complete'), { code: 'TEST_STOP' });
      }, onDecision: () => { decisions++; } }), error => {
      assert.equal(error.session.abortReason, 'TEST_STOP');
      assert.equal(error.session.failedDecision, undefined, '前の成功判断を失敗ログへ重複しない');
      return true;
    });
    assert.equal(decisions, 2);
  });
