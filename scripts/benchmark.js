// 取得済みの無変更のルールで、ブラウザ描画を含まない固定ステップ検証をします。
import { pathToFileURL } from "node:url";
import path from "node:path";
import { SNAPSHOT_EXPRESSION } from "../src/state.js";
const directory = process.env.MONONOKE_ENGINE_DIR;
if (!directory)
  throw new Error("MONONOKE_ENGINE_DIR に原本の js/core を指定してください。");
const { createSim } = await import(
  pathToFileURL(path.join(directory, "sim.js"))
);
const { createConfig } = await import(
  pathToFileURL(path.join(directory, "config.js"))
);
const field = process.argv[2] || "L";
const seeds = Number(process.argv[3] || "10");
if (!["S", "M", "L"].includes(field) || !Number.isInteger(seeds) || seeds < 1)
  throw new Error("盤面S/M/Lと試行数を指定してください。");
const cfg = createConfig();
const app = { cfg };
const { loadPredictionEngine } = await import("../src/engine.js");
const { PlannerPolicy } = await import("../src/planner.js");
const { createSim: predictor } = await loadPredictionEngine({
  sourceDirectory: directory,
});
const results = [];
for (const lives of [1, 2]) {
  for (let seed = 1; seed <= seeds; seed++) {
    const challenge = {
      enemies: {
        CHASER: 5,
        DASHER: 5,
        SHOOTER: 5,
        LASER: 5,
        MINE: 5,
        JAMMER: 5,
      },
      field,
      time: 30,
      lives,
      seed,
    };
    const sim = createSim(challenge, cfg);
    const policy = new PlannerPolicy({ createSim: predictor });
    let next = 0,
      decisions = 0;
    while (sim.state.status === "playing") {
      if (!sim.isMoving() && sim.state.elapsedMs + 1e-7 >= next) {
        const state = JSON.parse(eval(SNAPSHOT_EXPRESSION));
        const decision = await policy.decide(state);
        if (decision.action !== "wait") sim.input(decision.action);
        next = sim.state.elapsedMs + 100;
        decisions++;
      }
      sim.step();
      sim.drainEvents();
    }
    results.push({ lives, seed, ...sim.result(), decisions });
    console.log(JSON.stringify(results.at(-1)));
  }
}
for (const lives of [1, 2]) {
  const r = results.filter((r) => r.lives === lives);
  console.log(
    JSON.stringify({
      lives,
      clear: r.filter((r) => r.cleared).length,
      total: r.length,
      averageSeconds: r.reduce((a, r) => a + r.survivedMs, 0) / r.length / 1000,
      results: r,
    }),
  );
}
