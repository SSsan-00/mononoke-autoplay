import test from 'node:test';
import assert from 'node:assert/strict';
import { JevPolicy } from '../src/jev.js';

const state = { w:5,h:5,player:{x:0,y:0},enemies:[] };

test('公式Choice形式のリクエスト・返答と利用量を処理する', async () => {
  const policy = new JevPolicy({apiKey:'test-key',fetchImpl:async (url, options) => {
    assert.equal(url,'https://api.typesafe.ai/v1/systemone');
    assert.equal(options.headers.Authorization,'Bearer test-key');
    const body=JSON.parse(options.body);
    assert.equal(body.questions.move.type,'choice');
    assert.deepEqual(Object.keys(body.questions.move.criteria),['down','right','wait']);
    return {ok:true,json:async()=>({answers:{move:{type:'choice',choice:'right',probabilities:{right:1}}},usage:{input_tokens:500}})};
  }});
  const result=await policy.decide(state);
  assert.equal(result.action,'right');
  assert.equal(result.inputTokens,500);
});

test('API呼び出し上限を超えたら送信せず停止する', async () => {
  let calls=0;
  const policy=new JevPolicy({apiKey:'test-key',maxCalls:1,fetchImpl:async()=>{
    calls++;
    return {ok:true,json:async()=>({answers:{move:{type:'choice',choice:'wait'}}})};
  }});
  await policy.decide(state);
  await assert.rejects(policy.decide(state),/上限/);
  assert.equal(calls,1);
});

test('不正な行動やHTTPエラーを自動操作へ流さない', async () => {
  const invalid=new JevPolicy({apiKey:'test-key',fetchImpl:async()=>({ok:true,json:async()=>({answers:{move:{type:'choice',choice:'left'}}})})});
  await assert.rejects(invalid.decide(state),/形式/);
  const error=new JevPolicy({apiKey:'test-key',fetchImpl:async()=>({ok:false,status:401})});
  await assert.rejects(error.decide(state),/401/);
});

function assistedPolicy(candidates, fetchImpl) {
  const committed = [];
  const planner = {
    intervalMs: 100,
    mirror: {},
    synchronize() {},
    chooseRollingAction: () => ({ action: candidates[0]?.action || 'wait', candidates, searchedDepth: 8, evaluatedBranches: 120 }),
    recordAction: (_, action) => committed.push(action),
  };
  return { policy: new JevPolicy({ apiKey: 'test-key', planner, fetchImpl }), committed };
}

const forecast = (action, cost = 0, damageTaken = 0, lives = 1, survivalMs = 800) =>
  ({ action, cost, damageTaken, lives, survivalMs });

test('短期予測で劣る行動を除外し、Jevの選択を予測ゲームにも反映する', async () => {
  const { policy, committed } = assistedPolicy([
    forecast('right'), forecast('wait', 5), forecast('down', 20),
    forecast('left', 5, 1), forecast('up', 5, 0, 0),
  ], async (_, options) => {
    const body = JSON.parse(options.body);
    assert.deepEqual(Object.keys(body.questions.move.criteria), ['right', 'wait']);
    assert.equal(body.state.prediction.intervalMs, 100);
    assert.equal(body.state.prediction.candidates.length, 2);
    return { ok: true, json: async () => ({ answers: { move: { type: 'choice', choice: 'wait' } } }) };
  });
  const result = await policy.decide(state);
  assert.equal(result.selection, 'jev');
  assert.deepEqual(committed, ['wait']);
});

test('候補が1つか全候補が致命的ならAPIを消費せず先読みの選択を使う', async () => {
  for (const candidates of [[forecast('right')], []]) {
    const { policy, committed } = assistedPolicy(candidates, () => assert.fail('APIを呼ばない'));
    const result = await policy.decide(state);
    assert.equal(result.selection, 'planner-only');
    assert.equal(result.calls, 0);
    assert.deepEqual(committed, [result.action]);
  }
});

test('候補外の返答・通信失敗では予測ゲームへ入力しない', async () => {
  for (const response of [
    { ok: true, json: async () => ({ answers: { move: { type: 'choice', choice: 'down' } } }) },
    { ok: false, status: 503 },
  ]) {
    const { policy, committed } = assistedPolicy([forecast('right'), forecast('wait')], async () => response);
    await assert.rejects(policy.decide(state));
    assert.deepEqual(committed, []);
  }
});

test('補助モードでもAPI上限を守り、キャンセル時は入力しない', async () => {
  let sent = 0;
  const { policy, committed } = assistedPolicy([forecast('right'), forecast('wait')], async () => {
    sent++;
    return { ok: true, json: async () => ({ answers: { move: { type: 'choice', choice: 'right' } } }) };
  });
  policy.maxCalls = 1;
  await policy.decide(state);
  await assert.rejects(policy.decide(state), /上限/);
  assert.equal(sent, 1);
  assert.deepEqual(committed, ['right']);
  const controller = new AbortController();
  policy.planner.signal = controller.signal;
  controller.abort();
  await assert.rejects(policy.decide(state), { name: 'AbortError' });
  assert.deepEqual(committed, ['right']);
});
