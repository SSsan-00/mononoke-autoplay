// ゲームのRNGを消費しない選択用のMulberry32。fallbackは別ストリーム。
export class SelectionRandom {
  constructor(seed) {
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff)
      throw new Error("選択用シードは0～4294967295の整数で指定してください。");
    this.state = seed;
    this.draws = 0;
  }
  next() {
    let value = this.state = (this.state + 0x6d2b79f5) >>> 0;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    this.draws++;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  }
  choose(actions) {
    if (!actions.length) throw new Error("空の行動集合からは選択できません。");
    return actions[Math.floor(this.next() * actions.length)];
  }
}

export function prepareSurvivalDecision(planner, state, fallbackRandom, budgetPerAction) {
  planner.signal?.throwIfAborted();
  const started = performance.now();
  planner.synchronize(state);
  const forecast = planner.findSurvivalCandidates(planner.mirror, state, budgetPerAction);
  const eligibleActions = forecast.candidates.map(candidate => candidate.action);
  const forcedAction = eligibleActions.length === 1 ? eligibleActions[0]
    : eligibleActions.length === 0 ? fallbackRandom.choose(forecast.fallbackActions) : null;
  return { ...forecast, eligibleActions, forcedAction,
    candidateCount: eligibleActions.length,
    selectionReason: eligibleActions.length === 0 ? "longest-observed-path"
      : eligibleActions.length === 1 ? "single-survivor" : "multiple-survivors",
    predictionMs: performance.now() - started };
}

export class RandomPolicy {
  constructor({ planner, selectionSeed = 1, budgetPerAction }) {
    this.planner = planner;
    this.selectionSeed = selectionSeed;
    this.random = new SelectionRandom(selectionSeed);
    this.fallbackRandom = new SelectionRandom((selectionSeed ^ 0xa5a5a5a5) >>> 0);
    this.budgetPerAction = budgetPerAction;
  }
  async decide(state) {
    this.lastDecision = null;
    const forecast = prepareSurvivalDecision(this.planner, state, this.fallbackRandom, this.budgetPerAction);
    const action = forecast.forcedAction ?? this.random.choose(forecast.eligibleActions);
    this.planner.recordAction(state, action);
    return this.lastDecision = { ...forecast, action, provider: "random", mode: "survival",
      selection: forecast.forcedAction ? "shared-fallback" : "random",
      selectionSeed: this.selectionSeed, selectionDraws: this.random.draws,
      fallbackDraws: this.fallbackRandom.draws,
      planningMs: forecast.predictionMs, apiMs: 0, calls: 0, inputTokens: 0 };
  }
}
