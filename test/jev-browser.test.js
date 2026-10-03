import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { configureGame, playSession } from '../src/cli.js';
import { loadPredictionEngine } from '../src/engine.js';
import { PlannerPolicy } from '../src/planner.js';
import { JevPolicy } from '../src/jev.js';
import { fixtureRoute } from './fixture.js';

test('Jev補助モードを模擬APIでブラウザ上から実行し、状態同期と結果を確認する',
  { skip: process.env.RUN_BROWSER_TESTS !== '1', timeout: 180000 }, async (t) => {
    const engine = await loadPredictionEngine();
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    try {
      const page = await browser.newPage({ viewport: { width: 400, height: 700 } });
      await fixtureRoute(page);
      await page.goto('https://aigengames.pages.dev/Games/SurviveLimitMononoke/', { waitUntil: 'domcontentloaded' });
      await configureGame(page, { time: '30', lives: '5' });
      const planner = new PlannerPolicy({ ...engine, route: false, depth: 20, width: 24 });
      const policy = new JevPolicy({ apiKey: 'mock', planner, fetchImpl: async (_, request) => {
        const body = JSON.parse(request.body);
        return { ok: true, json: async () => ({ answers: { move: { type: 'choice', choice: Object.keys(body.questions.move.criteria)[0] } } }) };
      } });
      let reported = -5000;
      const summary = await playSession(page, policy, { onState: state => {
        if (state.elapsedMs - reported >= 5000) {
          console.log(`Jev mock browser: ${Math.round(state.elapsedMs)}ms ${state.status}`);
          reported = state.elapsedMs;
        }
      } });
      assert.equal(summary.status, 'cleared');
      assert.equal(summary.provider, 'jev');
      assert.equal(summary.jev.assisted, true);
      assert.ok(summary.decisions > 10);
      assert.equal(planner.routeAttempted, false);
      await page.getByRole('button', { name: '同条件で再出陣', exact: true }).waitFor();
    } finally { await browser.close(); }
  });
