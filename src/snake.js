// Snake engine. Pure functions over plain-object state, shared by the browser,
// the server-side benchmark and the tests. Deterministic for a given seed.

export const DIRS = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

export const OPPOSITE = { up: 'down', down: 'up', left: 'right', right: 'left' };

// mulberry32, with the generator state kept in the game state so that a game
// can be replayed from any point.
function nextRandom(s) {
  s = (s + 0x6d2b79f5) | 0;
  let t = Math.imul(s ^ (s >>> 15), 1 | s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return [((t ^ (t >>> 14)) >>> 0) / 4294967296, s];
}

function placeFood(state) {
  const taken = new Set(state.snake.map((c) => c.y * state.width + c.x));
  const free = [];
  for (let i = 0; i < state.width * state.height; i++) {
    if (!taken.has(i)) free.push(i);
  }
  if (free.length === 0) return { ...state, food: null };
  const [r, rng] = nextRandom(state.rng);
  const i = free[Math.floor(r * free.length)];
  return { ...state, rng, food: { x: i % state.width, y: Math.floor(i / state.width) } };
}

export function createGame({ width = 12, height = 12, seed = 1 } = {}) {
  const cx = Math.floor(width / 2);
  const cy = Math.floor(height / 2);
  return placeFood({
    width,
    height,
    seed,
    rng: seed | 0,
    snake: [
      { x: cx, y: cy },
      { x: cx - 1, y: cy },
      { x: cx - 2, y: cy },
    ],
    dir: 'right',
    food: null,
    score: 0,
    steps: 0,
    stepsSinceFood: 0,
    alive: true,
    deathReason: null,
  });
}

// Directions the snake may be steered in: everything except a reversal.
export function steerable(state) {
  return Object.keys(DIRS).filter((d) => d !== OPPOSITE[state.dir]);
}

// What would happen on a move, without applying it.
// fatal is null, 'wall' or 'self'.
export function peek(state, dir) {
  const d = DIRS[dir];
  const head = { x: state.snake[0].x + d.x, y: state.snake[0].y + d.y };
  const grows = !!state.food && head.x === state.food.x && head.y === state.food.y;
  let fatal = null;
  if (head.x < 0 || head.y < 0 || head.x >= state.width || head.y >= state.height) {
    fatal = 'wall';
  } else {
    // The tail cell is vacated this turn unless the snake grows.
    const body = grows ? state.snake : state.snake.slice(0, -1);
    if (body.some((c) => c.x === head.x && c.y === head.y)) fatal = 'self';
  }
  return { head, grows, fatal };
}

// Advance one tick. A reversal or unknown direction is refused and the snake
// keeps its current heading.
export function step(state, dir) {
  if (!state.alive) return state;
  if (!DIRS[dir] || dir === OPPOSITE[state.dir]) dir = state.dir;
  const { head, grows, fatal } = peek(state, dir);
  const steps = state.steps + 1;
  if (fatal) return { ...state, dir, steps, alive: false, deathReason: fatal };

  const body = grows ? state.snake : state.snake.slice(0, -1);
  let next = { ...state, dir, steps, snake: [head, ...body] };
  if (grows) {
    next = placeFood({ ...next, score: state.score + 1, stepsSinceFood: 0 });
    if (!next.food) return { ...next, alive: false, deathReason: 'won' };
    return next;
  }
  next.stepsSinceFood = state.stepsSinceFood + 1;
  // Stop games that circle forever without eating.
  if (next.stepsSinceFood > state.width * state.height * 2) {
    return { ...next, alive: false, deathReason: 'starved' };
  }
  return next;
}
