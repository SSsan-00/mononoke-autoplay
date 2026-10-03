import test from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { loadPredictionEngine } from "../src/engine.js";
import { PlannerPolicy } from "../src/planner.js";
import { legalActions, SNAPSHOT_EXPRESSION } from "../src/state.js";

const directory = process.env.MONONOKE_ENGINE_DIR;

test(
  "予測用コピーは元のルールと同じ結果を返し、枝同士を汚さない",
  { skip: !directory },
  async () => {
    const { createSim } = await loadPredictionEngine({
      sourceDirectory: directory,
    });
    const { createSim: original } = await import(
      pathToFileURL(path.join(directory, "sim.js"))
    );
    const { createConfig } = await import(
      pathToFileURL(path.join(directory, "config.js"))
    );
    const cfg = createConfig();
    const challenge = {
      enemies: {
        CHASER: 5,
        DASHER: 5,
        SHOOTER: 5,
        LASER: 5,
        MINE: 5,
        JAMMER: 5,
      },
      field: "L",
      time: 30,
      lives: 5,
      seed: 1234,
    };
    const a = original(challenge, cfg),
      b = createSim(challenge, cfg);
    const signature = (s) => JSON.stringify(s.state);
    for (let step = 0; step < 700; step++) {
      if (!a.isMoving()) {
        const actions = legalActions(a.state),
          action = actions[step % actions.length];
        if (action !== "wait") {
          a.input(action);
          b.input(action);
        }
      }
      a.step();
      b.step();
      a.drainEvents();
      b.drainEvents();
      assert.equal(signature(a), signature(b));
      if (step % 50 === 0) {
        const before = signature(b),
          copy = b.agentFork();
        for (let n = 0; n < 20; n++) {
          copy.step();
          copy.drainEvents();
        }
        assert.equal(signature(b), before, "別の枝の試行は親に影響しない");
        const fork = b.agentFork();
        for (let n = 0; n < 20; n++) {
          fork.step();
          fork.drainEvents();
        }
        assert.equal(
          signature(copy),
          signature(fork),
          "同じ分岐では乱数・攻撃・当たり判定も同じ",
        );
      }
    }
  },
);

test(
  "先読みは手動移動などによる再現のずれを検出する",
  { skip: !directory },
  async () => {
    const engine = await loadPredictionEngine({ sourceDirectory: directory });
    const { createConfig } = await import(
      pathToFileURL(path.join(directory, "config.js"))
    );
    const app = { cfg: createConfig() };
    const challenge = {
      enemies: { CHASER: 1 },
      field: "M",
      time: 30,
      lives: 3,
      seed: 1,
    };
    const sim = engine.createSim(challenge, app.cfg);
    const snapshot = JSON.parse(eval(SNAPSHOT_EXPRESSION));
    const policy = new PlannerPolicy(engine);
    policy.synchronize(snapshot);
    snapshot.player.x++;
    assert.throws(() => policy.synchronize(snapshot), /一致しません/);
  },
);

// 攻略性能に直接関係する経路を、予測用コピーではなく原本のルールで実行します。
test(
  "S・各5体・ライフ1の30秒経路を原本で再現する",
  { skip: !directory },
  async () => {
    const engine = await loadPredictionEngine({ sourceDirectory: directory });
    const { createSim } = await import(
      pathToFileURL(path.join(directory, "sim.js"))
    );
    const { createConfig } = await import(
      pathToFileURL(path.join(directory, "config.js"))
    );
    const app = { cfg: createConfig() };
    for (const seed of [1, 6]) {
      const challenge = {
        field: "S",
        time: 30,
        lives: 1,
        seed,
        enemies: {
          CHASER: 5,
          DASHER: 5,
          SHOOTER: 5,
          LASER: 5,
          MINE: 5,
          JAMMER: 5,
        },
      };
      const sim = createSim(challenge, app.cfg),
        policy = new PlannerPolicy(engine);
      let next = 0,
        decisions = 0;
      while (sim.state.status === "playing") {
        if (!sim.isMoving() && sim.state.elapsedMs + 1e-7 >= next) {
          const before = JSON.stringify(sim.state);
          const decision = await policy.decide(
            JSON.parse(eval(SNAPSHOT_EXPRESSION)),
          );
          assert.equal(
            JSON.stringify(sim.state),
            before,
            "探索中は原本の状態を変更しない",
          );
          assert.equal(decision.mode, "route");
          if (decisions === 0)
            assert.equal(decision.routeSearch.reason, "cleared");
          if (decision.action !== "wait") sim.input(decision.action);
          next = sim.state.elapsedMs + 100;
          decisions++;
        }
        sim.step();
        sim.drainEvents();
      }
      assert.equal(sim.state.status, "cleared");
      assert.equal(sim.state.damageTaken, 0);
      assert.ok(decisions > 200);
    }
  },
);

test(
  "弾と無敵時間のずれも検出し、誤った予測で操作しない",
  { skip: !directory },
  async () => {
    const engine = await loadPredictionEngine({ sourceDirectory: directory });
    const { createConfig } = await import(
      pathToFileURL(path.join(directory, "config.js"))
    );
    const app = { cfg: createConfig() },
      challenge = {
        field: "L",
        time: 30,
        lives: 1,
        seed: 1,
        enemies: { CHASER: 1 },
      };
    const sim = engine.createSim(challenge, app.cfg),
      snapshot = JSON.parse(eval(SNAPSHOT_EXPRESSION));
    for (const change of [
      (s) => s.player.invulnMs++,
      (s) =>
        s.bullets.push({ x: 0, y: 0, dx: 1, dy: 0, cellMs: 100, accMs: 0 }),
    ]) {
      const altered = structuredClone(snapshot);
      change(altered);
      assert.throws(
        () => new PlannerPolicy(engine).synchronize(altered),
        /一致しません/,
      );
    }
  },
);

test(
  "探索上限に達したら短期の先読みを使い、指定した判断間隔を守る",
  { skip: !directory },
  async () => {
    const engine = await loadPredictionEngine({ sourceDirectory: directory });
    const { createConfig } = await import(
      pathToFileURL(path.join(directory, "config.js"))
    );
    const app = { cfg: createConfig() },
      challenge = {
        field: "L",
        time: 30,
        lives: 2,
        seed: 1,
        enemies: { CHASER: 1 },
      };
    const sim = engine.createSim(challenge, app.cfg),
      policy = new PlannerPolicy({
        ...engine,
        depth: 1,
        routeBudget: 1,
        intervalMs: 150,
      });
    const d = await policy.decide(JSON.parse(eval(SNAPSHOT_EXPRESSION)));
    assert.equal(d.routeSearch.reason, "budget");
    assert.equal(d.routeSearch.branches, 1);
    assert.equal(d.mode, "rolling");
    assert.ok(d.predictedSurvivalMs >= 150 - 0.001);
    if (d.action !== "wait") sim.input(d.action);
    do {
      sim.step();
      sim.drainEvents();
    } while (sim.isMoving() || sim.state.elapsedMs < 150 - 0.00001);
    // 次の状態でも一致することを確認します。元の固定100msとの取り違えを検出します。
    await policy.decide(JSON.parse(eval(SNAPSHOT_EXPRESSION)));
  },
);

test(
  "経路探索を途中でキャンセルしても入力を送らない",
  { skip: !directory },
  async () => {
    const engine = await loadPredictionEngine({ sourceDirectory: directory });
    const { createConfig } = await import(
      pathToFileURL(path.join(directory, "config.js"))
    );
    const app = { cfg: createConfig() },
      challenge = {
        field: "L",
        time: 30,
        lives: 2,
        seed: 1,
        enemies: { CHASER: 1 },
      };
    const sim = engine.createSim(challenge, app.cfg),
      controller = new AbortController();
    const policy = new PlannerPolicy({
      ...engine,
      signal: controller.signal,
      onPlanningProgress: () => controller.abort(),
    });
    const before = JSON.stringify(sim.state);
    await assert.rejects(policy.decide(JSON.parse(eval(SNAPSHOT_EXPRESSION))), {
      name: "AbortError",
    });
    assert.equal(JSON.stringify(sim.state), before);
    assert.equal(policy.mirror.isMoving(), false);
  },
);
