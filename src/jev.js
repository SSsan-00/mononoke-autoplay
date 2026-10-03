import { legalActions } from './state.js';

// TypeSafe公式API: https://docs.typesafe.ai/introduction/quickstart
// APIキーはNode.js側だけで保持し、ゲームのページへ渡しません。
export class JevPolicy {
  constructor({ apiKey, model = 'jev-latest', maxCalls = 1000, timeoutMs = 10000, fetchImpl = fetch, planner }) {
    if (!apiKey) throw new Error('Jevを使うには TYPESAFE_API_KEY を設定してください。');
    this.planner = planner;
    this.apiKey = apiKey;
    this.model = model;
    this.maxCalls = maxCalls;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
    this.calls = 0;
    this.inputTokens = 0;
  }

  async decide(state) {
    const startedAt = performance.now();
    let forecast;
    let legal = legalActions(state);
    if (this.planner) {
      this.planner.signal?.throwIfAborted();
      this.planner.synchronize(state);
      forecast = this.planner.chooseRollingAction(this.planner.mirror, state);
      const best = forecast.candidates[0];
      // ponytail: 短期予測で同等に評価した候補だけを渡す。長期の生存保証には全経路探索が必要。
      legal = best ? forecast.candidates.filter(candidate =>
        candidate.damageTaken === best.damageTaken && candidate.lives >= best.lives &&
        candidate.survivalMs >= best.survivalMs - 0.001 && candidate.cost <= best.cost + 10
      ).map(candidate => candidate.action) : [forecast.action];
    }
    const finish = (action, metadata = {}) => {
      this.planner?.signal?.throwIfAborted();
      this.planner?.recordAction(state, action);
      return { action, provider: 'jev', mode: this.planner ? 'rolling' : 'direct',
        candidates: forecast?.candidates, eligibleActions: legal,
        evaluatedBranches: forecast?.evaluatedBranches, searchedDepth: forecast?.searchedDepth,
        planningMs: Math.round((performance.now() - startedAt) * 100) / 100,
        calls: this.calls, inputTokens: this.inputTokens, ...metadata };
    };
    if (this.planner && legal.length === 1)
      return finish(legal[0], { selection: 'planner-only' });
    if (this.calls >= this.maxCalls) throw new Error('JevのAPI呼び出し上限に達しました。');
    const labels = {up:'Move one cell up (y - 1)',down:'Move one cell down (y + 1)',left:'Move one cell left (x - 1)',right:'Move one cell right (x + 1)',wait:'Stay in the current cell'};
    this.calls++; // 失敗した通信も上限に数え、無制限の再試行を防ぎます。
    const response = await this.fetchImpl('https://api.typesafe.ai/v1/systemone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
      signal: this.planner?.signal
        ? AbortSignal.any([this.planner.signal, AbortSignal.timeout(this.timeoutMs)])
        : AbortSignal.timeout(this.timeoutMs),
      body: JSON.stringify({
        model: this.model,
        state: forecast ? { ...state, prediction: {
          horizonDecisions: forecast.searchedDepth, intervalMs: this.planner.intervalMs,
          candidates: forecast.candidates.filter(candidate => legal.includes(candidate.action)),
        } } : state,
        questions: {
          move: {
            type: 'choice',
            instructions: 'Which next movement best avoids damage in this grid survival game? Coordinates x increase right and y increase down. Avoid enemy contact, bullets, and warnings that fire soon. Dash warnings have damage=false but their source enemy can dash. Prefer escape routes; collect heal if injured and safe. Remain alive until durationMs. Choose only the supplied legal action. If prediction is provided, its candidates were simulated using the actual game rules: prefer lower cost and damage, more lives and longer survival. These are short-horizon forecasts, not a guarantee of survival.',
            criteria: Object.fromEntries(legal.map(action => [action, labels[action]])),
          },
        },
      }),
    });
    // エラー本文に秘密情報が含まれる可能性を避け、ステータスだけ表示します。
    if (!response.ok) throw new Error(`Jev APIがHTTP ${response.status}を返しました。`);
    const result = await response.json();
    const answer = result.answers?.move;
    if (answer?.type !== 'choice' || !legal.includes(answer.choice)) {
      throw new Error('Jevの返答が期待するChoice形式ではありません。');
    }
    const used = Number(result.usage?.input_tokens || 0);
    if (Number.isFinite(used) && used >= 0) this.inputTokens += used;
    return finish(answer.choice, { selection: 'jev', probabilities: answer.probabilities,
      confidence: answer.confidence });
  }
}
