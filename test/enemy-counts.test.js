import test from 'node:test';
import assert from 'node:assert/strict';
import { validateEnemyCounts } from '../src/state.js';

test('敵構成はゲームの各10体・計30体の範囲で正規化し、不正な指定を拒否する', () => {
  assert.deepEqual(validateEnemyCounts({ CHASER: 10, DASHER: 10, JAMMER: 10 }),
    { CHASER: 10, DASHER: 10, SHOOTER: 0, LASER: 0, MINE: 0, JAMMER: 10 });
  for (const counts of [null, [], {}, { CHASER: 11 }, { CHASER: -1 }, { CHASER: '10' },
    { CHASER: null }, { CHASER: 0.5 }, { UNKNOWN: 1 }, { CHASER: 10, DASHER: 10, LASER: 10, JAMMER: 1 }])
    assert.throws(() => validateEnemyCounts(counts));
});
