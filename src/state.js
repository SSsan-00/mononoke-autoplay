// この式は停止中の gameScreen/frame スコープで評価します。
// ゲームのソースや状態を書き換えず、判断に必要な値だけをコピーします。
// source オブジェクトの重複参照と Infinity は、JSONに適した形へ整えます。
// ブラウザで読む状態と、ローカルで再現した状態に同じ変換を使います。
// この関数は単独で実行できるよう、外部の変数・importへ依存しません。
export function projectState(s, cfg, challenge) {
  const enemy = (e) => ({
    id: e.id,
    type: e.type,
    x: e.x,
    y: e.y,
    side: e.side,
    mode: e.mode,
    timerMs: e.timerMs,
    dir: e.dir,
    cooldownMs: e.cooldownMs,
    dropLeftMs: e.dropLeftMs,
    castLeftMs: e.castLeftMs,
  });
  return {
    w: s.w,
    h: s.h,
    elapsedMs: s.elapsedMs,
    durationMs: s.durationMs,
    lives: s.lives,
    maxLives: s.maxLives,
    status: s.status,
    deathAtMs: s.deathAtMs,
    player: { ...s.player },
    enemies: s.enemies.map(enemy),
    warnings: s.warnings.map((w) => ({
      id: w.id,
      cells: w.cells,
      fireAtMs: Number.isFinite(w.fireAtMs) ? w.fireAtMs : null,
      activeMs: w.activeMs,
      damage: w.damage,
      attack: w.attack,
      sourceId: w.source.id,
      fired: w.fired,
    })),
    bullets: s.bullets.map((b) => ({
      x: b.x,
      y: b.y,
      dx: b.dx,
      dy: b.dy,
      cellMs: b.cellMs,
      accMs: b.accMs,
    })),
    mines: s.mines.map((m) => ({
      x: m.x,
      y: m.y,
      fuseLeftMs: m.fuseLeftMs,
      warnMs: m.warnMs,
    })),
    yellows: s.yellows.map((z) => ({ cells: z.cells, untilMs: z.untilMs })),
    heal: s.heal,
    damageTaken: s.damageTaken,
    healTaken: s.healTaken,
    cfg,
    challenge,
  };
}

export const SNAPSHOT_EXPRESSION = `JSON.stringify((${projectState.toString()})(sim.state, app.cfg, challenge))`;

export const DIRECTIONS = Object.freeze({
  up: [0, -1],
  down: [0, 1],
  left: [-1, 0],
  right: [1, 0],
  wait: [0, 0],
});

const directionEntries = Object.entries(DIRECTIONS);

export function legalActions(state) {
  const actions = [];
  for (const [action, [dx, dy]] of directionEntries) {
    const x = state.player.x + dx;
    const y = state.player.y + dy;
    if (x >= 0 && y >= 0 && x < state.w && y < state.h) actions.push(action);
  }
  return actions;
}
