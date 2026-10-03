import { legalActions } from './state.js';
import { SelectionRandom, prepareSurvivalDecision } from './survival.js';

// TypeSafe公式API: https://docs.typesafe.ai/introduction/quickstart
// APIキーはNode.js側だけで保持し、ゲームのページへ渡しません。
export class JevPolicy {
  constructor({ apiKey, model = 'jev-latest', maxCalls = 1000, timeoutMs = 10000, fetchImpl = fetch, planner,
    comparison = false, selectionSeed = 1, budgetPerAction }) {
    if (!apiKey) throw new Error('Jevを使うには TYPESAFE_API_KEY を設定してください。');
    this.planner = planner;
    this.apiKey = apiKey;
    this.model = model;
    this.maxCalls = maxCalls;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
    this.calls = 0;
    this.inputTokens = 0;
    this.apiMs = 0;
    this.comparison = comparison;
    this.selectionSeed = selectionSeed;
    this.budgetPerAction = budgetPerAction;
    this.fallbackRandom = new SelectionRandom((selectionSeed ^ 0xa5a5a5a5) >>> 0);
    if (comparison && !planner) throw new Error('比較モードには共通の先読みが必要です。');
  }

  async decide(state) {
    this.lastDecision = null;
    const startedAt = performance.now();
    let forecast;
    let legal = legalActions(state);
    if (this.comparison) {
      forecast = prepareSurvivalDecision(this.planner, state, this.fallbackRandom, this.budgetPerAction);
      legal = forecast.eligibleActions;
    } else if (this.planner) {
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
    const predictionMs = forecast?.predictionMs ?? (performance.now() - startedAt);
    const base = { ...(this.comparison ? forecast : {}),
      candidates: forecast?.candidates, eligibleActions: legal,
      evaluatedBranches: forecast?.evaluatedBranches, searchedDepth: forecast?.searchedDepth,
      planningMs: predictionMs, predictionMs, apiMs: 0,
      selectionSeed: this.comparison ? this.selectionSeed : undefined,
      fallbackDraws: this.comparison ? this.fallbackRandom.draws : undefined };
    this.lastDecision = base;
    const finish = (action, metadata = {}) => {
      this.planner?.signal?.throwIfAborted();
      this.planner?.recordAction(state, action);
      return this.lastDecision = { ...base, action, provider: 'jev', mode: this.comparison ? 'survival' : this.planner ? 'rolling' : 'direct',
        decisionMs: performance.now() - startedAt,
        calls: this.calls, inputTokens: this.inputTokens, ...metadata };
    };
    if (this.comparison && forecast.forcedAction)
      return finish(forecast.forcedAction, { selection: 'shared-fallback' });
    if (this.planner && legal.length === 1)
      return finish(legal[0], { selection: 'planner-only' });
    if (this.calls >= this.maxCalls) {
      const error = new Error('JevのAPI呼び出し上限に達しました。');
      error.code = 'API_CALL_LIMIT'; throw error;
    }
    const labels = {up:'Move one cell up (y - 1)',down:'Move one cell down (y + 1)',left:'Move one cell left (x - 1)',right:'Move one cell right (x + 1)',wait:'Stay in the current cell'};
    this.calls++; // 失敗した通信も上限に数え、無制限の再試行を防ぎます。
    const apiStarted = performance.now();
    let result;
    try {
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
            candidateDefinition: this.comparison ? 'At least one path survives the full horizon or clears earlier; future survival is not guaranteed.' : undefined,
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
    if (!response.ok) {
      const error = new Error(`Jev APIがHTTP ${response.status}を返しました。`);
      error.code = `HTTP_${response.status}`; throw error;
    }
    result = await response.json();
    } catch (error) {
      const failure = new Error(typeof error.code === 'string' && error.code.startsWith('HTTP_')
        ? error.message : 'Jev APIとの通信に失敗しました。');
      failure.code = typeof error.code === 'string' && error.code.startsWith('HTTP_') ? error.code
        : error.name === 'TimeoutError' ? 'API_TIMEOUT'
        : error.name === 'AbortError' ? 'CANCELLED' : 'API_TRANSPORT';
      throw failure;
    } finally {
      base.apiMs = performance.now() - apiStarted;
      this.apiMs += base.apiMs;
      this.lastDecision = { ...base, calls: this.calls, inputTokens: this.inputTokens, apiAttempted: true };
    }
    const answer = result.answers?.move;
    const used = Number(result.usage?.input_tokens || 0);
    if (Number.isFinite(used) && used >= 0) this.inputTokens += used;
    this.lastDecision.inputTokens = this.inputTokens;
    if (answer?.type !== 'choice' || !legal.includes(answer.choice)) {
      const error = new Error('Jevの返答が期待するChoice形式ではありません。');
      error.code = 'INVALID_CHOICE'; throw error;
    }
    return finish(answer.choice, { selection: 'jev', apiAttempted: true, apiMs: base.apiMs, probabilities: answer.probabilities,
      confidence: answer.confidence });
  }
}
