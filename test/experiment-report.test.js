import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeTrials, pairedDifference } from '../src/experiment-report.js';

test('シード単位の対応bootstrap、中断・未開始・ブラウザ時間の区別', () => {
  const records = [];
  for (const seed of [11, 22]) for (let repeat = 0; repeat < 5; repeat++) {
    const common = { challenge: { seed }, pairId: `${seed}-${repeat}`, status: 'cleared', calls: 0, inputTokens: 0 };
    records.push({ ...common, method: 'random', survivedMs: 30000, realElapsedMs: 60000 });
    records.push({ ...common, method: 'jev', survivedMs: seed === 11 ? 30000 : 10000,
      status: seed === 11 ? 'cleared' : 'failed', realElapsedMs: 70000 });
  }
  records.push({ method: 'jev', status: 'aborted', abortReason: 'HTTP_503', calls: 1, inputTokens: 32, survivedMs: null });
  records.push({ method: 'jev', status: 'not-started', abortReason: 'API_CALL_LIMIT' });
  const result = analyzeTrials(records);
  assert.equal(result.methods.jev.normal, 10);
  assert.equal(result.methods.jev.aborted, 1);
  assert.equal(result.methods.jev.notStarted, 1);
  assert.equal(result.methods.jev.normalCompletionRate, 10 / 11);
  assert.equal(result.methods.jev.clearRate, 0.5);
  assert.equal(result.methods.jev.calls, 1);
  assert.equal(result.paired.survivalSeconds.seedCount, 2, '5反復を10個の独立シードとみなさない');
  assert.equal(result.paired.survivalSeconds.pairCount, 10);
  assert.equal(result.paired.survivalSeconds.mean, -10);
  assert.equal(result.paired.bothClearedRealElapsedMs.pairCount, 5);
  assert.equal(result.paired.bothClearedRealElapsedMs.mean, 10000);
  assert.deepEqual(pairedDifference(records, r => r.survivedMs), pairedDifference(records, r => r.survivedMs));
  for (const r of records) r.realElapsedMs = null;
  assert.equal(analyzeTrials(records).paired.realElapsedMs.mean, null, 'シミュレーター実行時間で代用しない');
});
