import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import path from "node:path";
import os from "node:os";

const BASE = "https://aigengames.pages.dev/Games/SurviveLimitMononoke/js/core/";
const FILES = [
  "sim.js",
  "rng.js",
  "config.js",
  "enemies/index.js",
  "enemies/common.js",
  "enemies/chaser.js",
  "enemies/dasher.js",
  "enemies/shooter.js",
  "enemies/laser.js",
  "enemies/mine.js",
  "enemies/jammer.js",
];

// オンラインで動いているゲームのファイルには一切手を加えません。
// 先読み専用の別インスタンスをNode.js側に作り、候補ごとの結果を調べます。
// 取得した原文は保持し、その別コピーにだけ複製用APIを追加します。
export async function loadPredictionEngine({
  sourceDirectory = process.env.MONONOKE_ENGINE_DIR,
} = {}) {
  const originals = await Promise.all(
    FILES.map(async (file) => {
      if (sourceDirectory)
        return [file, await readFile(path.join(sourceDirectory, file), "utf8")];
      const response = await fetch(BASE + file, {
        signal: AbortSignal.timeout(30000),
      });
      if (!response.ok)
        throw new Error(
          `先読み用ルールの取得に失敗しました: ${file} (HTTP ${response.status})`,
        );
      return [file, await response.text()];
    }),
  );
  const sources = new Map(originals);
  const replaceOnce = (source, marker, replacement) => {
    if (source.split(marker).length !== 2)
      throw new Error(
        "ゲームルールの構造が更新されています。先読みエンジンを確認してください。",
      );
    return source.replace(marker, replacement);
  };
  // この追加APIは予測用コピーだけのものです。本番ゲームへ注入しません。
  const rng = replaceOnce(
    sources.get("rng.js"),
    "    next,",
    "    next,\n    agentRngState: () => a,\n    agentRestoreRng: value => { a = value >>> 0; },",
  );
  const sim = replaceOnce(
    sources.get("sim.js"),
    "    isMoving: () => state.player.moveLeftMs > 0,",
    `    agentRestore(restoredState, rngState, restoredNextId) {
      Object.assign(state, restoredState);
      rng.agentRestoreRng(rngState);
      nextId = restoredNextId;
      events = [];
    },
    agentFork() {
      const copy = createSim({ ...challenge, enemies: {} }, cfg);
      const enemies = state.enemies.map(agentCloneEnemy);
      const byId = new Map(enemies.map(enemy => [enemy.id, enemy]));
      const withSource = object => ({ ...object, source: byId.get(object.source.id) || { ...object.source } });
      // マスの配列はゲームルール中で変更されないため共有できます。
      // 移動する敵・弾・タイマー・配列そのものは候補ごとに複製します。
      const restored = {
        ...state, player: { ...state.player }, enemies,
        warnings: state.warnings.map(withSource), bullets: state.bullets.map(withSource),
        mines: state.mines.map(withSource), yellows: state.yellows.map(zone => ({ ...zone })),
        heal: state.heal ? { ...state.heal } : null,
        lastHit: state.lastHit ? { ...state.lastHit } : null
      };
      copy.agentRestore(restored, rng.agentRngState(), nextId);
      return copy;
    },
    isMoving: () => state.player.moveLeftMs > 0,`,
  );
  sources.set("rng.js", rng);
  // 種類ごとに複製箇所を分け、異なる形の敵を同じ箇所で複製する負担を避けます。
  sources.set("sim.js", `function agentCloneEnemy(enemy) {
    switch (enemy.type) {
      case 'CHASER': return { ...enemy };
      case 'DASHER': return { ...enemy };
      case 'SHOOTER': return { ...enemy };
      case 'LASER': return { ...enemy };
      case 'MINE': return { ...enemy };
      case 'JAMMER': return { ...enemy };
      default: return { ...enemy };
    }
  }\n` + sim);
  const digest = createHash("sha256")
    .update(JSON.stringify([...sources]))
    .digest("hex");
  const directory = path.join(os.tmpdir(), "mononoke-agent-prediction", digest);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "package.json"), ' {"type":"module"}');
  for (const [file, source] of sources) {
    await mkdir(path.dirname(path.join(directory, file)), { recursive: true });
    await writeFile(path.join(directory, file), source);
  }
  const { createSim } = await import(
    pathToFileURL(path.join(directory, "sim.js")).href
  );
  return { createSim, digest };
}
