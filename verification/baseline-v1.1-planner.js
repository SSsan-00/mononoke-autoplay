// 比較実験のために保存したv1.1.0の先読み実装です。通常プレイでは使用しません。
import { legalActions } from "../src/state.js";
import { cellRisk } from "../src/policy.js";

// 同じシード・同じ入力・同じ固定ステップ数なら、同じ結果になります。
// この性質を使い、本番とは別のシミュレーションだけを何度も試します。
export class PlannerPolicy {
  constructor({ createSim, depth = 5, width = 24 }) {
    this.createSim = createSim;
    this.depth = depth;
    this.width = width;
    this.mirror = null;
    this.visits = new Map();
  }

  synchronize(snapshot) {
    if (!snapshot.challenge)
      throw new Error(
        "先読みにはゲームのchallenge情報が必要です。最新版のstate.jsを使ってください。",
      );
    if (!this.mirror)
      this.mirror = this.createSim(snapshot.challenge, snapshot.cfg);
    while (
      this.mirror.state.elapsedMs < snapshot.elapsedMs - 0.00001 &&
      this.mirror.state.status === "playing"
    ) {
      this.mirror.step();
      this.mirror.drainEvents();
    }
    const a = this.mirror.state;
    // 手動の移動入力やルール更新で再現がずれた場合、誤った予測を使わず停止します。
    const enemiesMatch =
      a.enemies.length === snapshot.enemies.length &&
      a.enemies.every((e, i) => {
        const actual = snapshot.enemies[i];
        return (
          e.id === actual.id &&
          e.x === actual.x &&
          e.y === actual.y &&
          e.mode === actual.mode
        );
      });
    if (
      Math.abs(a.elapsedMs - snapshot.elapsedMs) > 0.001 ||
      a.player.x !== snapshot.player.x ||
      a.player.y !== snapshot.player.y ||
      a.lives !== snapshot.lives ||
      !enemiesMatch
    ) {
      throw new Error(
        "先読みと実ゲームの状態が一致しません。観戦中の移動操作をやめ、プログラムを再起動してください。",
      );
    }
  }

  evaluate(sim, snapshot) {
    const s = sim.state;
    const p = s.player;
    const view = { ...s, cfg: snapshot.cfg };
    let value = cellRisk(view, p.x, p.y, 0);
    // 過去の長い累積回数でなく、直近の滞在回数だけ軽く評価します。
    value += (this.visits.get(`${p.x},${p.y}`) || 0) * 0.2;
    if (s.heal && s.lives < s.maxLives)
      value += (Math.abs(p.x - s.heal.x) + Math.abs(p.y - s.heal.y)) * 0.5;
    return value;
  }

  async decide(snapshot) {
    this.synchronize(snapshot);
    const root = this.mirror;
    const initialDamage = root.state.damageTaken;
    const initialLives = root.state.lives;
    let beam = [{ sim: root, first: null, cost: 0 }];
    let lastBeam = beam;
    for (let depth = 0; depth < this.depth; depth++) {
      const children = [];
      for (const node of beam) {
        if (node.sim.state.status === "cleared") {
          children.push(node);
          continue;
        }
        for (const action of legalActions(node.sim.state)) {
          const copy = node.sim.agentFork();
          if (action !== "wait") copy.input(action);
          // 各候補について、移動が完了するまで正規のゲーム処理を進めます。
          // waitでも通常の判断間隔100msを進め、空の分岐でループするのを避けます。
          const endMs = copy.state.elapsedMs + snapshot.cfg.player.moveMs;
          do {
            copy.step();
            copy.drainEvents();
          } while (
            (copy.isMoving() || copy.state.elapsedMs < endMs - 0.00001) &&
            copy.state.status === "playing"
          );
          if (copy.state.status === "dying" || copy.state.status === "failed")
            continue;
          const damage = copy.state.damageTaken - initialDamage;
          const loss = Math.max(0, initialLives - copy.state.lives);
          children.push({
            sim: copy,
            first: node.first ?? action,
            cost:
              node.cost +
              this.evaluate(copy, snapshot) / (depth + 1) +
              damage * 100000 +
              loss * 100000,
          });
        }
      }
      if (!children.length) break;
      children.sort((a, b) => a.cost - b.cost);
      // 同じ位置の似た候補だけで枠が埋まらないよう、位置と時刻ごとに制限します。
      const counts = new Map();
      beam = [];
      for (const node of children) {
        const s = node.sim.state;
        const key = `${s.player.x},${s.player.y},${Math.round(s.elapsedMs / 100)},${s.lives}`;
        const count = counts.get(key) || 0;
        if (count >= 3) continue;
        counts.set(key, count + 1);
        beam.push(node);
        if (beam.length >= this.width) break;
      }
      lastBeam = beam;
    }
    // 現時点でどの候補も生存できない場合も、正規の入力範囲内で最善を試します。
    const winner = lastBeam.find((node) => node.first !== null);
    const action = winner?.first ?? legalActions(root.state)[0];
    if (action !== "wait") root.input(action);
    const key = `${snapshot.player.x},${snapshot.player.y}`;
    this.visits.set(key, (this.visits.get(key) || 0) + 1);
    for (const [key, value] of this.visits)
      if (value > 0.1) this.visits.set(key, value * 0.95);
      else this.visits.delete(key);
    return {
      action,
      provider: "planner",
      depth: this.depth,
      width: this.width,
      predictedCost: winner?.cost ?? null,
    };
  }
}
