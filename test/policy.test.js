import test from 'node:test';
import assert from 'node:assert/strict';
import { HeuristicPolicy, cellRisk } from '../src/policy.js';
import { legalActions } from '../src/state.js';

function state(overrides = {}) {
  return {
    w: 5, h: 5, elapsedMs: 2000, durationMs: 30000, lives: 3, maxLives: 3,
    player: { x: 2, y: 2, invulnMs: 0 },
    enemies: [], warnings: [], bullets: [], mines: [], yellows: [], heal: null,
    cfg: { player: { moveMs: 100 }, startGraceMs: 1500, enemies: { DASHER: { dashCellMs: 40 } } },
    ...overrides,
  };
}

test('外周では盤面外への行動を候補にしない', () => {
  assert.deepEqual(legalActions(state({player:{x:0,y:0}})), ['down','right','wait']);
});

test('発動間近のレーザーから退避する', async () => {
  const s = state({ warnings:[{cells:[{x:2,y:2},{x:1,y:2},{x:3,y:2}],fireAtMs:2050,activeMs:200,damage:true}] });
  const result = await new HeuristicPolicy().decide(s);
  assert.ok(['up','down'].includes(result.action));
});

test('弾の現在位置と次の進行位置を避ける', async () => {
  const s = state({bullets:[{x:1,y:2,dx:1,dy:0,cellMs:100,accMs:0}]});
  const result = await new HeuristicPolicy().decide(s);
  assert.ok(!['left','wait'].includes(result.action));
});

test('非ダメージの突進予告はInfinityをJSON化したnullでも評価できる', async () => {
  const s = state({warnings:[{cells:[{x:2,y:2}],fireAtMs:null,activeMs:0,damage:false}]});
  assert.ok(Number.isFinite(cellRisk(s,2,2,100)));
  assert.ok(legalActions(s).includes((await new HeuristicPolicy().decide(s)).action));
});

test('負傷時は安全に取れる回復を選ぶ', async () => {
  const s = state({lives:1,heal:{x:3,y:2}});
  assert.equal((await new HeuristicPolicy().decide(s)).action,'right');
});

export { state };
