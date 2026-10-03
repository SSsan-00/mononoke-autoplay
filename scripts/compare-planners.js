// 同じシード・条件・判断間隔で、旧版と新版を原本のゲームルール上で比較します。
// シードは検証用の別ゲームへ渡します。ブラウザ側の乱数は変更しません。
import { pathToFileURL } from "node:url";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { loadPredictionEngine } from "../src/engine.js";
import { PlannerPolicy } from "../src/planner.js";
import { PlannerPolicy as BaselinePolicy } from "../verification/baseline-v1.1-planner.js";
import { projectState } from "../src/state.js";

const sourceDirectory = process.env.MONONOKE_ENGINE_DIR;
if (!sourceDirectory)
  throw new Error(
    "MONONOKE_ENGINE_DIRに取得済み原本のjs/coreを指定してください。",
  );
const { createSim } = await import(
  pathToFileURL(path.join(sourceDirectory, "sim.js"))
);
const { createConfig } = await import(
  pathToFileURL(path.join(sourceDirectory, "config.js"))
);
const engine = await loadPredictionEngine({ sourceDirectory });
const count = Number(process.argv[2] || 10);
const startSeed = Number(process.argv[3] || 1);
if (
  !Number.isInteger(count) ||
  count < 1 ||
  !Number.isInteger(startSeed) ||
  startSeed < 0
)
  throw new Error("試行数と開始シードは整数で指定してください。");
const profiles = process.env.BENCHMARK_PROFILES
  ? JSON.parse(process.env.BENCHMARK_PROFILES)
  : [
      { field: "L", lives: 1, time: 30 },
      { field: "S", lives: 2, time: 30 },
      { field: "S", lives: 1, time: 30 },
    ];
const records = [];
const output = path.resolve(
  process.env.BENCHMARK_OUTPUT || "verification/v1.2-comparison.json",
);
await mkdir(path.dirname(output), { recursive: true });
for (const profile of profiles)
  for (let seed = startSeed; seed < startSeed + count; seed++)
    for (const [version, Policy] of [
      ["1.1.0", BaselinePolicy],
      ["1.2.0", PlannerPolicy],
    ]) {
      const cfg = createConfig();
      const challenge = {
        ...profile,
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
      const sim = createSim(challenge, cfg),
        policy = new Policy({
          ...engine,
          ...(version === "1.2.0"
            ? JSON.parse(process.env.PLANNER_OPTIONS || "{}")
            : {}),
        });
      let next = 0,
        decisions = 0,
        planningMs = 0,
        maximumPlanningMs = 0;
      while (sim.state.status === "playing") {
        if (!sim.isMoving() && sim.state.elapsedMs + 1e-7 >= next) {
          const snapshot = JSON.parse(
            JSON.stringify(projectState(sim.state, cfg, challenge)),
          );
          const start = performance.now(),
            decision = await policy.decide(snapshot),
            elapsed = performance.now() - start;
          planningMs += elapsed;
          maximumPlanningMs = Math.max(maximumPlanningMs, elapsed);
          if (decision.action !== "wait") sim.input(decision.action);
          next = sim.state.elapsedMs + 100;
          decisions++;
        }
        sim.step();
        sim.drainEvents();
      }
      const result = {
        version,
        ...profile,
        seed,
        ...sim.result(),
        decisions,
        meanPlanningMs: Math.round((planningMs / decisions) * 100) / 100,
        maximumPlanningMs: Math.round(maximumPlanningMs * 100) / 100,
        ...(version === "1.2.0" ? { routeSearch: policy.routeSearch } : {}),
      };
      records.push(result);
      await writeFile(
        output,
        JSON.stringify(
          {
            mode: "original rules, fixed steps, identical seed and 100ms minimum decision interval",
            plannerOptions: JSON.parse(process.env.PLANNER_OPTIONS || "{}"),
            records,
          },
          null,
          2,
        ),
      );
      console.log(JSON.stringify(result));
    }
