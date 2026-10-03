import { isDeepStrictEqual } from "node:util";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { legalActions, projectState } from "./state.js";
import { cellRisk } from "./policy.js";

// 変更するのはローカルの予測用ゲームだけです。
// クリアまでの経路が見つかればその経路を使い、見つからなければ短い先読みを繰り返します。
export class PlannerPolicy {
  constructor({
    createSim,
    digest,
    depth = 8,
    width = 24,
    intervalMs = 100,
    route = true,
    routeWidth = 128,
    routeBudget = 750000,
    signal,
    onPlanningProgress = () => {},
  }) {
    for (const [name, value, maximum] of [
      ["depth", depth, 20],
      ["width", width, 96],
      ["intervalMs", intervalMs, 10000],
      ["routeWidth", routeWidth, 256],
      ["routeBudget", routeBudget, 2000000],
    ]) {
      if (!Number.isInteger(value) || value < 1 || value > maximum)
        throw new Error(`${name}は1～${maximum}の整数で指定してください。`);
    }
    Object.assign(this, {
      createSim,
      digest,
      depth,
      width,
      intervalMs,
      route,
      routeWidth,
      routeBudget,
      signal,
      onPlanningProgress,
    });
    this.mirror = null;
    this.visits = new Map();
    this.routeAttempted = false;
    this.routeSteps = [];
    this.routeIndex = 0;
    this.routeSearch = null;
    this.reportedRouteSearch = false;
  }

  synchronize(snapshot) {
    if (!snapshot.challenge)
      throw new Error(
        "先読みにはゲームのchallenge情報が必要です。最新版のstate.jsを使ってください。",
      );
    if (!this.mirror) {
      this.challenge = structuredClone(snapshot.challenge);
      this.mirror = this.createSim(this.challenge, snapshot.cfg);
    }
    while (
      this.mirror.state.elapsedMs < snapshot.elapsedMs - 0.00001 &&
      this.mirror.state.status === "playing"
    ) {
      this.mirror.step();
      this.mirror.drainEvents();
    }
    // 座標だけでなく、弾・攻撃予告・タイマー・回復・無敵時間も照合します。
    // JSON化によるundefinedの省略も、ブラウザ側と同じにします。
    const expected = JSON.parse(
      JSON.stringify(
        projectState(this.mirror.state, this.mirror.cfg, this.challenge),
      ),
    );
    if (!isDeepStrictEqual(expected, snapshot))
      throw new Error(
        "先読みと実ゲームの状態が一致しません。観戦中の移動操作をやめ、プログラムを再起動してください。",
      );
  }

  evaluate(sim, snapshot) {
    const s = sim.state,
      p = s.player,
      view = { ...s, cfg: snapshot.cfg };
    let value =
      cellRisk(view, p.x, p.y, 0) +
      (this.visits.get(`${p.x},${p.y}`) || 0) * 0.2;
    if (s.heal && s.lives < s.maxLives)
      value += (Math.abs(p.x - s.heal.x) + Math.abs(p.y - s.heal.y)) * 0.5;
    // 安全な出口が少ない場所への入り込みを避けます。
    let exits = 0;
    for (const [dx, dy] of [
      [0, -1],
      [0, 1],
      [-1, 0],
      [1, 0],
    ]) {
      const x = p.x + dx,
        y = p.y + dy;
      if (
        x >= 0 &&
        y >= 0 &&
        x < s.w &&
        y < s.h &&
        cellRisk(view, x, y, this.intervalMs) < 150
      )
        exits++;
    }
    return value + [120, 45, 10, 0, 0][exits];
  }

  advanceCandidate(sim, action) {
    const copy = sim.agentFork();
    if (action !== "wait") copy.input(action);
    const endMs = copy.state.elapsedMs + this.intervalMs;
    // ゲームの正規ステップで、指定間隔と移動完了の両方を待ちます。
    // スロー床による移動時間の延長もゲーム自身が処理します。
    do {
      copy.step();
      copy.drainEvents();
    } while (
      copy.state.status === "playing" &&
      (copy.isMoving() || copy.state.elapsedMs < endMs - 0.00001)
    );
    return copy;
  }

  scoreCandidate(copy, root, snapshot, previousExposure, depth) {
    const exposure =
      previousExposure + this.evaluate(copy, snapshot) / (depth + 1);
    const damage = copy.state.damageTaken - root.state.damageTaken;
    const loss = root.state.lives - copy.state.lives;
    // ライフが満タンなのに回復を使い切る経路には、小さな罰点を付けます。
    const wastedHeal =
      root.state.maxLives > 1 &&
      root.state.heal &&
      !root.state.healTaken &&
      copy.state.healTaken &&
      damage === 0 &&
      root.state.lives === root.state.maxLives
        ? 50
        : 0;
    // 被弾・ライフ差は終点で一度だけ評価します。回復による増加も反映します。
    return {
      exposure,
      cost: exposure + damage * 10000 + loss * 100000 + wastedHeal,
    };
  }

  selectBeam(children, width, perCell) {
    children.sort((a, b) => a.cost - b.cost);
    const counts = new Map(),
      beam = [];
    for (const node of children) {
      const s = node.sim.state,
        key = `${s.player.x},${s.player.y},${Math.round(s.elapsedMs / this.intervalMs)},${s.lives}`;
      const count = counts.get(key) || 0;
      if (count >= perCell) continue;
      counts.set(key, count + 1);
      beam.push(node);
      if (beam.length >= width) break;
    }
    return beam;
  }

  async buildRoute(
    root,
    snapshot,
    { width = this.routeWidth, budget = this.routeBudget } = {},
  ) {
    let beam = [{ sim: root, exposure: 0, cost: 0, trace: null }];
    let branches = 0,
      searchedDepth = 0;
    const startedAt = performance.now();
    const result = (steps, reason) => ({
      steps,
      reason,
      width,
      branches,
      searchedDepth,
      planningMs: Math.round((performance.now() - startedAt) * 100) / 100,
    });
    // 1候補で最低でも判断間隔分だけ進むため、この深さで制限時間へ到達できます。
    const maximumDepth =
      Math.ceil(
        (root.state.durationMs - root.state.elapsedMs) / this.intervalMs,
      ) + 1;
    for (let depth = 0; depth < maximumDepth; depth++) {
      this.signal?.throwIfAborted();
      const children = [];
      for (const node of beam)
        for (const action of legalActions(node.sim.state)) {
          if (branches >= budget) return result([], "budget");
          branches++;
          const copy = this.advanceCandidate(node.sim, action);
          if (copy.state.status === "dying" || copy.state.status === "failed")
            continue;
          const trace = {
            action,
            atMs: node.sim.state.elapsedMs,
            previous: node.trace,
          };
          if (copy.state.status === "cleared") {
            const steps = [];
            for (let item = trace; item; item = item.previous)
              steps.push({ action: item.action, atMs: item.atMs });
            searchedDepth = depth + 1;
            return result(steps.reverse(), "cleared");
          }
          children.push({
            sim: copy,
            trace,
            ...this.scoreCandidate(copy, root, snapshot, node.exposure, depth),
          });
        }
      searchedDepth = depth + 1;
      if (!children.length) return result([], "no-route");
      beam = this.selectBeam(children, width, 8);
      if (depth % 16 === 0) {
        this.onPlanningProgress({
          searchedDepth,
          branches,
          furthestMs: Math.max(...beam.map((n) => n.sim.state.elapsedMs)),
        });
        // 長い探索中にもCtrl+Cやブラウザ終了を処理できるよう、定期的に制御を戻します。
        await yieldToEventLoop();
      }
    }
    return result([], "no-route");
  }

  chooseRollingAction(root, snapshot) {
    let beam = [{ sim: root, first: null, cost: 0, exposure: 0 }],
      lastBeam = beam;
    let evaluatedBranches = 0,
      searchedDepth = 0,
      bestFatal = null;
    for (let depth = 0; depth < this.depth; depth++) {
      const children = [];
      for (const node of beam) {
        if (node.sim.state.status === "cleared") {
          children.push(node);
          continue;
        }
        for (const action of legalActions(node.sim.state)) {
          evaluatedBranches++;
          const copy = this.advanceCandidate(node.sim, action),
            first = node.first ?? action;
          if (copy.state.status === "dying" || copy.state.status === "failed") {
            // 全候補が致命的でも、最も長く生存した候補の最初の入力を選びます。
            const survivedMs = copy.state.deathAtMs ?? copy.state.elapsedMs;
            if (!bestFatal || survivedMs > bestFatal.survivedMs)
              bestFatal = { first, survivedMs };
            continue;
          }
          children.push({
            sim: copy,
            first,
            ...this.scoreCandidate(copy, root, snapshot, node.exposure, depth),
          });
        }
      }
      if (!children.length) break;
      beam = this.selectBeam(children, this.width, 3);
      lastBeam = beam;
      searchedDepth = depth + 1;
    }
    const winner = lastBeam.find((node) => node.first !== null);
    return {
      action: winner?.first ?? bestFatal?.first ?? "wait",
      mode: "rolling",
      candidates: [...new Set(lastBeam.map(node => node.first).filter(Boolean))].map(action => {
        const node = lastBeam.find(node => node.first === action);
        return { action, cost: node.cost, lives: node.sim.state.lives,
          damageTaken: node.sim.state.damageTaken - root.state.damageTaken,
          survivalMs: node.sim.state.elapsedMs - snapshot.elapsedMs };
      }),
      evaluatedBranches,
      searchedDepth,
      predictedCost: winner?.cost ?? null,
      predictedSurvivalMs: winner
        ? winner.sim.state.elapsedMs - snapshot.elapsedMs
        : 0,
    };
  }

  recordAction(snapshot, action) {
    if (action !== "wait") this.mirror.input(action);
    const key = `${snapshot.player.x},${snapshot.player.y}`;
    this.visits.set(key, (this.visits.get(key) || 0) + 1);
    for (const [key, value] of this.visits)
      if (value > 0.1) this.visits.set(key, value * 0.95);
      else this.visits.delete(key);
  }

  // 初手ごとに独立した同幅のbeamを使う。未到達・予算切れは生存候補にしない。
  findSurvivalCandidates(root, snapshot, budgetPerAction = this.depth * this.width * 5) {
    if (!Number.isInteger(budgetPerAction) || budgetPerAction < 1)
      throw new Error("初手ごとの探索予算は正の整数で指定してください。");
    const candidates = [], outcomes = [];
    for (const first of legalActions(root.state)) {
      let beam = [{ sim: root, cost: 0, exposure: 0 }];
      let branches = 0, reachedDepth = 0, longestMs = 0, found = null, reason = "no-route";
      for (let depth = 0; depth < this.depth; depth++) {
        this.signal?.throwIfAborted();
        const children = [];
        let exhausted = false;
        for (const node of beam) {
          for (const action of depth === 0 ? [first] : legalActions(node.sim.state)) {
            if (branches >= budgetPerAction) { exhausted = true; break; }
            branches++;
            const copy = this.advanceCandidate(node.sim, action);
            longestMs = Math.max(longestMs,
              (copy.state.deathAtMs ?? copy.state.elapsedMs) - snapshot.elapsedMs);
            if (copy.state.status === "dying" || copy.state.status === "failed") continue;
            const child = { sim: copy,
              ...this.scoreCandidate(copy, root, snapshot, node.exposure, depth) };
            if (copy.state.status === "cleared" || depth + 1 === this.depth) {
              found = child; reason = copy.state.status === "cleared" ? "cleared" : "horizon"; break;
            }
            children.push(child);
          }
          if (exhausted || found) break;
        }
        reachedDepth = depth + 1;
        if (found) break;
        if (exhausted) { reason = "budget"; break; }
        if (!children.length) break;
        beam = this.selectBeam(children, this.width, 3);
        if (reachedDepth === this.depth) { found = beam[0]; reason = "horizon"; }
      }
      outcomes.push({ action: first, reason, reachedDepth, evaluatedBranches: branches, longestMs });
      if (found) candidates.push({ action: first, cost: found.cost,
        lives: found.sim.state.lives, damageTaken: found.sim.state.damageTaken - root.state.damageTaken,
        survivalMs: found.sim.state.elapsedMs - snapshot.elapsedMs,
        reachedDepth, reason });
    }
    const longestMs = Math.max(...outcomes.map(item => item.longestMs));
    return { candidates, outcomes, searchedDepth: this.depth, budgetPerAction,
      evaluatedBranches: outcomes.reduce((sum, item) => sum + item.evaluatedBranches, 0),
      fallbackActions: outcomes.filter(item => Math.abs(item.longestMs - longestMs) < 0.001)
        .map(item => item.action), predictedSurvivalMs: longestMs };
  }

  async decide(snapshot) {
    this.signal?.throwIfAborted();
    this.synchronize(snapshot);
    const startedAt = performance.now(),
      root = this.mirror;
    if (this.route && !this.routeAttempted) {
      this.routeAttempted = true;
      const attempts = [];
      let branches = 0,
        width = this.routeWidth,
        search;
      const searchStartedAt = performance.now();
      do {
        search = await this.buildRoute(root, snapshot, {
          width,
          budget: this.routeBudget - branches,
        });
        const { steps, ...metrics } = search;
        attempts.push(metrics);
        branches += search.branches;
        // 候補が尽きた場合だけ幅を広げます。候補数の上限は全探索で共通です。
        if (
          search.reason !== "no-route" ||
          width >= 256 ||
          branches >= this.routeBudget
        )
          break;
        width = Math.min(256, width * 2);
      } while (true);
      this.routeSteps = search.steps;
      this.routeSearch = {
        reason: search.reason,
        branches,
        searchedDepth: search.searchedDepth,
        planningMs:
          Math.round((performance.now() - searchStartedAt) * 100) / 100,
        plannedActions: search.steps.length,
        attempts,
      };
    }
    let decision;
    const planned = this.routeSteps[this.routeIndex];
    if (planned && Math.abs(planned.atMs - snapshot.elapsedMs) < 0.001) {
      decision = {
        action: planned.action,
        mode: "route",
        routeIndex: this.routeIndex++,
        routeLength: this.routeSteps.length,
        evaluatedBranches: 0,
        searchedDepth: 0,
        predictedSurvivalMs: root.state.durationMs - snapshot.elapsedMs,
      };
    } else {
      // 判断時刻が予定とずれた場合、その古い経路は使いません。
      this.routeSteps = [];
      decision = this.chooseRollingAction(root, snapshot);
    }
    this.recordAction(snapshot, decision.action);
    const routeSearch =
      this.routeSearch && !this.reportedRouteSearch ? this.routeSearch : null;
    this.reportedRouteSearch = true;
    return {
      ...decision,
      provider: "planner",
      depth: this.depth,
      width: this.width,
      planningMs: Math.round((performance.now() - startedAt) * 100) / 100,
      ...(routeSearch ? { routeSearch } : {}),
    };
  }
}
