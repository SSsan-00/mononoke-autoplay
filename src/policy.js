import { DIRECTIONS, legalActions } from './state.js';

const distance = (ax, ay, bx, by) => Math.abs(ax - bx) + Math.abs(ay - by);
const contains = (cells, x, y) => cells.some(c => c.x === x && c.y === y);
const INNER_TYPES = new Set(['CHASER', 'DASHER', 'MINE', 'JAMMER']);

// 将来の危険度の近似です。ゲームの乱数や敵AIを完全再現するものではありません。
// 予告・弾・突進の時刻を考慮し、単に敵との距離だけで逃げるより判断材料を増やします。
export function cellRisk(state, x, y, offsetMs) {
  let risk = 0;
  const protectedNow = state.player.invulnMs > offsetMs;
  const hitPenalty = protectedNow ? 15 : 2000;
  for (const e of state.enemies) {
    if (!INNER_TYPES.has(e.type)) continue;
    let ex = e.x;
    let ey = e.y;
    if (e.type === 'DASHER' && e.dir && ['warn', 'dash'].includes(e.mode)) {
      const delay = e.mode === 'warn' ? Math.max(0, e.timerMs) : 0;
      if (offsetMs >= delay) {
        const cells = Math.floor((offsetMs - delay) / state.cfg.enemies.DASHER.dashCellMs);
        ex += e.dir[0] * cells;
        ey += e.dir[1] * cells;
      }
    }
    const d = distance(x, y, ex, ey);
    risk += d === 0 ? hitPenalty : 16 / d;
    // 追跡敵の次の移動が迫っているなら、隣接マスを避けます。
    if (['CHASER', 'DASHER'].includes(e.type) && d === 1 && e.timerMs <= offsetMs &&
        state.elapsedMs + offsetMs >= state.cfg.startGraceMs && !['warn', 'dash', 'stun'].includes(e.mode)) {
      risk += protectedNow ? 5 : 200;
    }
  }
  for (const warning of state.warnings) {
    if (!warning.damage || warning.fireAtMs === null || !contains(warning.cells, x, y)) continue;
    const untilFire = warning.fireAtMs - state.elapsedMs;
    // 1区間中に発動する攻撃と、現在継続中の攻撃を危険と判定します。
    if (untilFire <= offsetMs && untilFire + warning.activeMs >= offsetMs - 100) risk += hitPenalty;
    else if (untilFire > offsetMs) risk += 30 / (1 + (untilFire - offsetMs) / 100);
  }
  for (const b of state.bullets) {
    const steps = Math.floor((b.accMs + offsetMs) / b.cellMs);
    const previousSteps = Math.floor((b.accMs + Math.max(0, offsetMs - 100)) / b.cellMs);
    for (let n = previousSteps; n <= steps; n++) {
      if (x === b.x + b.dx * n && y === b.y + b.dy * n) risk += hitPenalty;
    }
  }
  for (const m of state.mines) {
    const fireIn = m.fuseLeftMs + m.warnMs;
    if (Math.abs(x - m.x) <= 1 && Math.abs(y - m.y) <= 1) {
      risk += fireIn <= offsetMs && fireIn >= offsetMs - 100 ? hitPenalty : 8;
    }
  }
  for (const e of state.enemies) {
    if (e.type !== 'SHOOTER' || e.mode !== 'charge') continue;
    const inLine = ['top', 'bottom'].includes(e.side) ? x === e.x : y === e.y;
    if (inLine) risk += 40;
  }
  const slowed = state.yellows.some(z => z.untilMs > state.elapsedMs + offsetMs && contains(z.cells, x, y));
  if (slowed) risk += 12;
  // 外周に張り付き続けると逃げ道が減るため、軽いペナルティを付けます。
  if (x === 0 || y === 0 || x === state.w - 1 || y === state.h - 1) risk += 2;
  return risk;
}

export class HeuristicPolicy {
  constructor() { this.visits = new Map(); }

  async decide(state) {
    const currentKey = `${state.player.x},${state.player.y}`;
    this.visits.set(currentKey, (this.visits.get(currentKey) || 0) + 1);
    const candidates = legalActions(state).map(action => {
      const [dx, dy] = DIRECTIONS[action];
      const x = state.player.x + dx;
      const y = state.player.y + dy;
      const moveMs = state.cfg.player.moveMs;
      let score = cellRisk(state, x, y, 0) + cellRisk(state, x, y, moveMs);
      score += (this.visits.get(`${x},${y}`) || 0) * 0.25;
      if (action === 'wait') score += 0.5;
      if (state.heal && state.lives < state.maxLives) {
        score += distance(x, y, state.heal.x, state.heal.y) * 0.8;
        if (x === state.heal.x && y === state.heal.y) score -= 20;
      }
      // 次の1歩に安全な逃げ道があるか、簡単な先読みを行います。
      const future = Object.values(DIRECTIONS).map(([fx, fy]) => ({x:x+fx,y:y+fy}))
        .filter(p => p.x >= 0 && p.y >= 0 && p.x < state.w && p.y < state.h);
      score += Math.min(...future.map(p => cellRisk(state, p.x, p.y, moveMs * 2))) * 0.6;
      return { action, score: Math.round(score * 100) / 100 };
    }).sort((a, b) => a.score - b.score);
    return { action: candidates[0].action, provider: 'heuristic', candidates };
  }
}
