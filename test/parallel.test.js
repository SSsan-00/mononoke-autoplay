import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('並列比較は独立したシード・乱数・対応IDと判断ログを統合する',
  { skip: !process.env.MONONOKE_ENGINE_DIR, timeout: 120000 }, async t => {
    const output = await mkdtemp(path.join(os.tmpdir(), 'mononoke-parallel-'));
    t.after(() => rm(output, { recursive: true, force: true }));
    await promisify(execFile)(process.execPath, ['scripts/compare-parallel.js', '--output', output,
      '--workers', '2', '--minutes', '5', '--seed-count', '2', '--repeats', '1',
      '--enemies', '{"CHASER":1}', '--no-plot']);
    const records = JSON.parse(await readFile(path.join(output, 'trials.json'), 'utf8'));
    const manifest = JSON.parse(await readFile(path.join(output, 'manifest.json'), 'utf8'));
    assert.equal(manifest.completed, true);
    assert.equal(records.length, 4);
    assert.equal(new Set(records.map(r => r.trialId)).size, 4);
    for (const seed of [1, 2]) {
      const pair = records.filter(r => r.challenge.seed === seed);
      assert.equal(pair.length, 2);
      assert.equal(pair[0].pairId, pair[1].pairId);
      assert.equal(pair[0].selectionSeed, seed);
      assert.equal(pair[1].selectionSeed, seed);
      for (const r of pair) assert.ok((await readFile(path.join(output, r.logFile), 'utf8')).length);
    }
    const aggregate = JSON.parse(await readFile(path.join(output, 'aggregate.json'), 'utf8'));
    assert.equal(aggregate.paired.survivalSeconds.pairCount, 2);
    assert.equal(aggregate.paired.survivalSeconds.seedCount, 2);
  });
