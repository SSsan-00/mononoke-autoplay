import { chromium } from "playwright";
import { parseArgs } from "node:util";
import { mkdir, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { GameAdapter } from "./adapter.js";
import { HeuristicPolicy } from "./policy.js";
import { JevPolicy } from "./jev.js";
import { PlannerPolicy } from "./planner.js";
import { loadPredictionEngine } from "./engine.js";

const GAME_URL = "https://aigengames.pages.dev/Games/SurviveLimitMononoke/";

export async function playSession(
  page,
  policy,
  {
    manual = false,
    intervalMs = 100,
    timeoutMs = 30000,
    maxDecisions = 3000,
    onDecision = () => {},
    onState = () => {},
  } = {},
) {
  const adapter = new GameAdapter(page, { timeoutMs });
  let decisions = 0;
  const planning = {
    totalMs: 0,
    maximumMs: 0,
    routeDecisions: 0,
    rollingDecisions: 0,
  };
  try {
    await adapter.attach();
    if (!manual)
      await page
        .getByRole("button", { name: "百鬼結界にいざ出陣", exact: true })
        .click();
    // clickの完了より先に停止すると、Playwrightのクリック自体が待ち続けます。
    // 自動開始はクリック完了後、手動開始は待機に入る前に停止を設定します。
    await adapter.setBreakpoint(0);
    while (true) {
      const state = await adapter.nextState();
      await onState(state);
      if (state.status === "cleared" || state.status === "failed") {
        // 停止を解除した後、ゲーム自身が演出・結果画面への遷移を処理します。
        return {
          status: state.status,
          survivedMs:
            state.deathAtMs ?? Math.min(state.elapsedMs, state.durationMs),
          livesLeft: state.lives,
          damageTaken: state.damageTaken,
          healTaken: state.healTaken,
          decisions,
          challenge: state.challenge,
          ...(policy instanceof PlannerPolicy
            ? {
                planning,
                planner: {
                  depth: policy.depth,
                  width: policy.width,
                  intervalMs: policy.intervalMs,
                  routeWidth: policy.routeWidth,
                  routeBudget: policy.routeBudget,
                  rulesDigest: policy.digest,
                  routeSearch: policy.routeSearch,
                },
              }
            : {}),
          ...(policy instanceof JevPolicy
            ? { jev: { calls: policy.calls, inputTokens: policy.inputTokens,
                assisted: Boolean(policy.planner) }, planning }
            : {}),
          provider:
            policy instanceof JevPolicy
              ? "jev"
              : policy instanceof PlannerPolicy
                ? "planner"
                : "heuristic",
        };
      }
      if (state.status === "dying") {
        await adapter.resume();
        continue;
      }
      if (decisions >= maxDecisions)
        throw new Error("判断回数の上限に達したため、自動操作を停止します。");
      const decision = await policy.decide(state);
      decisions++;
      if (policy instanceof PlannerPolicy || policy.planner instanceof PlannerPolicy) {
        planning.totalMs += decision.planningMs || 0;
        planning.maximumMs = Math.max(
          planning.maximumMs,
          decision.planningMs || 0,
        );
        if (decision.mode === "route") planning.routeDecisions++;
        else planning.rollingDecisions++;
      }
      await onDecision({
        ...decision,
        elapsedMs: state.elapsedMs,
        position: { x: state.player.x, y: state.player.y },
        lives: state.lives,
      });
      await adapter.act(decision.action, state, intervalMs);
    }
  } finally {
    // 例外・APIタイムアウトでも、ブレークポイントを残したまま終了しません。
    await adapter.close();
  }
}

// ゲーム自身の設定画面だけを操作し、内部の設定値を書き換えません。
export async function configureGame(page, values) {
  // 制限時間の変更も、ゲームが提供している設定ボタンだけを使います。
  if (values.time) {
    const button = page.getByRole("button", { name: /^刻:/ });
    for (
      let i = 0;
      i < 5 && !(await button.innerText()).includes(`${values.time}秒`);
      i++
    )
      await button.click();
    if (!(await button.innerText()).includes(`${values.time}秒`))
      throw new Error("制限時間の設定に失敗しました。");
  }
  if (values.field) {
    const button = page.getByRole("button", { name: /^盤面:/ });
    for (
      let i = 0;
      i < 3 && !(await button.innerText()).endsWith(values.field);
      i++
    )
      await button.click();
    if (!(await button.innerText()).endsWith(values.field))
      throw new Error("盤面の設定に失敗しました。");
  }
  if (values.lives) {
    const button = page.getByRole("button", { name: /^命:/ });
    for (
      let i = 0;
      i < 5 && !(await button.innerText()).includes(`×${values.lives}`);
      i++
    )
      await button.click();
    if (!(await button.innerText()).includes(`×${values.lives}`))
      throw new Error("ライフの設定に失敗しました。");
  }
  if (values["each-enemy"] !== undefined) {
    const target = Number(values["each-enemy"]);
    const rows = page.locator(".enemy-row");
    // まず全種類を0体へ戻し、途中で合計30体の上限に当たらないようにします。
    for (let i = 0; i < 6; i++) {
      const row = rows.nth(i);
      while (Number(await row.locator(".count").innerText()) > 0)
        await row.getByRole("button", { name: "−", exact: true }).click();
    }
    for (let i = 0; i < 6; i++)
      for (let n = 0; n < target; n++)
        await rows
          .nth(i)
          .getByRole("button", { name: "+", exact: true })
          .click();
  }
}

export async function main() {
  const { values } = parseArgs({
    options: {
      provider: { type: "string", default: "planner" },
      channel: { type: "string" },
      executable: { type: "string" },
      headless: { type: "boolean", default: false },
      manual: { type: "boolean", default: false },
      "close-after": { type: "boolean", default: false },
      time: { type: "string" },
      field: { type: "string" },
      lives: { type: "string" },
      "each-enemy": { type: "string" },
      hard: { type: "boolean", default: false },
      attempts: { type: "string" },
      depth: { type: "string" },
      width: { type: "string" },
      "route-width": { type: "string", default: "128" },
      "route-budget": { type: "string", default: "750000" },
      rolling: { type: "boolean", default: false },
      "jev-direct": { type: "boolean", default: false },
      interval: { type: "string", default: "100" },
      "max-calls": { type: "string", default: "1000" },
      "max-decisions": { type: "string", default: "3000" },
      output: { type: "string", default: "runs" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    console.log(
      "npm start -- [--provider heuristic|planner|jev] [--hard] [--rolling] [--jev-direct] [--depth N] [--width N] [--route-width 128] [--route-budget 750000] [--attempts 3] [--field S|M|L] [--lives 1..5] [--each-enemy 0..5] [--time 30|45|60|90|120] [--manual] [--channel chrome] [--headless] [--close-after] [--interval 100] [--max-calls 1000] [--output runs]",
    );
    return;
  }
  if (!["heuristic", "planner", "jev"].includes(values.provider))
    throw new Error("providerはheuristic、planner、jevのいずれかです。");
  if (values.hard) {
    // ユーザーと合意した最初の難条件。元ゲームの設定UIで指定します。
    values.field ??= "L";
    values.lives ??= "1";
    values.time ??= "30";
    values["each-enemy"] ??= "5";
    values.attempts ??= "3";
  }
  const positive = (value, name) => {
    const n = Number(value);
    if (!Number.isInteger(n) || n <= 0)
      throw new Error(`${name}には正の整数を指定してください。`);
    return n;
  };
  const intervalMs = positive(values.interval, "interval");
  const maxDecisions = positive(values["max-decisions"], "max-decisions");
  const maxCalls = positive(values["max-calls"], "max-calls");
  const attempts = positive(values.attempts ?? "1", "attempts");
  if (values.time && !["30", "45", "60", "90", "120"].includes(values.time))
    throw new Error("timeは30,45,60,90,120のいずれかです。");
  if (values.field && !["S", "M", "L"].includes(values.field))
    throw new Error("fieldはS,M,Lのいずれかです。");
  if (values.lives && !["1", "2", "3", "4", "5"].includes(values.lives))
    throw new Error("livesは1～5の整数です。");
  if (
    values["each-enemy"] &&
    !["0", "1", "2", "3", "4", "5"].includes(values["each-enemy"])
  )
    throw new Error("each-enemyは0～5の整数です（合計最大30体）。");
  if (values["each-enemy"] === "0" && !values.manual) {
    throw new Error(
      "敵が0体ではゲームを開始できません。1～5体を指定するか、manualで設定してください。",
    );
  }
  if (values.manual && values.headless)
    throw new Error("manualとheadlessは同時に指定できません。");
  const controller = new AbortController();
  let lastProgressAt = 0;
  const plannerOptions = {
    depth: positive(
      values.depth ?? (values.provider === "jev" ? "20" : "8"), "depth"),
    width: positive(
      values.width ?? "24", "width"),
    intervalMs,
    route: !values.rolling,
    routeWidth: positive(values["route-width"], "route-width"),
    routeBudget: positive(values["route-budget"], "route-budget"),
    signal: controller.signal,
    onPlanningProgress: (progress) => {
      if (performance.now() - lastProgressAt >= 2000) {
        console.log(
          `経路探索中: ${(progress.furthestMs / 1000).toFixed(1)}秒先 / ${progress.branches}候補`,
        );
        lastProgressAt = performance.now();
      }
    },
  };
  // ブラウザや通信を始める前に、探索設定の範囲も検証します。
  const usesPrediction = values.provider === "planner" ||
    (values.provider === "jev" && !values["jev-direct"]);
  if (usesPrediction)
    new PlannerPolicy({ createSim: () => {}, ...plannerOptions });
  const makePlanner = (engine) =>
    new PlannerPolicy({ ...engine, ...plannerOptions });
  const engine =
    usesPrediction ? await loadPredictionEngine() : null;
  let policy =
    values.provider === "jev"
      ? new JevPolicy({
          apiKey: process.env.TYPESAFE_API_KEY,
          model: process.env.JEV_MODEL || "jev-latest",
          maxCalls,
          planner: engine
            ? new PlannerPolicy({ ...engine, ...plannerOptions, route: false })
            : undefined,
        })
      : values.provider === "planner"
        ? makePlanner(engine)
        : new HeuristicPolicy();
  const runId = new Date().toISOString().replaceAll(":", "-");
  const output = path.resolve(values.output, runId);
  await mkdir(output, { recursive: true });
  const browser = await chromium.launch({
    headless: values.headless,
    ...(values.channel ? { channel: values.channel } : {}),
    ...(values.executable ? { executablePath: values.executable } : {}),
  });
  const page = await browser.newPage({
    viewport: { width: 1000, height: 900 },
  });
  const onInterrupt = () => {
    controller.abort();
    void browser.close();
  };
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onInterrupt);
  try {
    await page.goto(GAME_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await page
      .getByRole("button", { name: "百鬼結界にいざ出陣", exact: true })
      .waitFor();
    await configureGame(page, values);
    browser.once("disconnected", () => controller.abort());
    console.log(`自動プレイ: ${values.provider} / ${GAME_URL}`);
    if (policy instanceof JevPolicy)
      console.log(policy.planner
        ? `Jev補助: ${policy.planner.depth}回先 / ${policy.planner.width}候補 / 判断間隔${intervalMs}ms（全経路の事前探索なし）`
        : "Jev単独: 短期予測なし");
    if (values.manual)
      console.log(
        "Chromeで敵などを設定し、「百鬼結界にいざ出陣」を押してください（待機は5分）。",
      );
    const summaries = [];
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const attemptOutput =
        attempts === 1 ? output : path.join(output, `attempt-${attempt}`);
      await mkdir(attemptOutput, { recursive: true });
      if (attempt > 1) {
        // 「同条件で再出陣」は同じシードを繰り返すため、設定画面から再開します。
        // ゲーム自身が新しいシードを生成します。良いシードへの書き換えはしません。
        await page
          .getByRole("button", { name: "結界条件を再調整", exact: true })
          .click();
        policy =
          values.provider === "planner"
            ? makePlanner(engine)
            : values.provider === "heuristic"
              ? new HeuristicPolicy()
              : policy;
      }
      if (attempt > 1 && policy instanceof JevPolicy && engine)
        policy.planner = new PlannerPolicy({ ...engine, ...plannerOptions, route: false });
      console.log(`試行 ${attempt}/${attempts}`);
      let lastPrintedMs = -1000;
      const summary = await playSession(page, policy, {
        manual: values.manual && attempt === 1,
        intervalMs,
        timeoutMs: values.manual ? 300000 : 30000,
        maxDecisions,
        onDecision: async (decision) => {
          if (decision.routeSearch) {
            console.log(
              `経路探索: ${decision.routeSearch.reason} / ${decision.routeSearch.branches}候補 / ${(decision.routeSearch.planningMs / 1000).toFixed(2)}秒`,
            );
          }
          await appendFile(
            path.join(attemptOutput, "decisions.jsonl"),
            `${JSON.stringify(decision)}\n`,
          );
          if (decision.elapsedMs - lastPrintedMs >= 1000) {
            console.log(
              `${(decision.elapsedMs / 1000).toFixed(1)}秒 / 命${decision.lives} / (${decision.position.x},${decision.position.y}) → ${decision.action}`,
            );
            lastPrintedMs = decision.elapsedMs;
          }
        },
      });
      summaries.push(summary);
      await writeFile(
        path.join(attemptOutput, "summary.json"),
        JSON.stringify(summary, null, 2),
      );
      // ゲーム自身の結果画面を待って記録します。固定sleepは使いません。
      await page
        .getByRole("button", { name: "同条件で再出陣", exact: true })
        .waitFor({ timeout: 15000 });
      await page.screenshot({
        path: path.join(attemptOutput, "result.png"),
        fullPage: true,
      });
      console.log(
        `結果: ${summary.status} / 命${summary.livesLeft} / 判断${summary.decisions}回`,
      );
      if (policy instanceof JevPolicy)
        console.log(`Jev累計: API${policy.calls}回 / 入力${policy.inputTokens}tokens`);
      if (summary.status === "cleared") break;
    }
    if (attempts > 1)
      await writeFile(
        path.join(output, "attempts.json"),
        JSON.stringify(summaries, null, 2),
      );
    console.log(`記録: ${output}`);
    if (!values.headless && !values["close-after"]) {
      console.log("観戦終了。Chromeを閉じるかCtrl+Cで終了してください。");
      await new Promise((resolve) => browser.once("disconnected", resolve));
    }
  } finally {
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onInterrupt);
    await browser.close();
  }
}

// テストからplaySessionをimportした時にはCLIを起動しません。
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(`停止: ${error.message}`);
    process.exitCode = 1;
  });
}
