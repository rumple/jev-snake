// Turns a game state into the question the decision model answers: every
// steerable move is simulated, measured, and written up as a sentence.

import { DIRS, steerable, peek, step } from './snake.js';

export const QUESTION = 'move';

export const INSTRUCTIONS =
  'You are steering a snake on a grid. Pick the move that keeps the snake alive ' +
  'longest while collecting food. Survival matters more than food: avoid pockets ' +
  'smaller than the snake and moves that cut the head off from the tail. Among ' +
  'safe moves, prefer the one that eats or approaches the food.';

// Breadth-first distances from the head over cells not occupied by the snake.
function distancesFromHead(state) {
  const { width, height, snake } = state;
  const dist = new Array(width * height).fill(-1);
  const blocked = new Set(snake.map((c) => c.y * width + c.x));
  const start = snake[0].y * width + snake[0].x;
  dist[start] = 0;
  const queue = [start];
  for (let q = 0; q < queue.length; q++) {
    const i = queue[q];
    const x = i % width;
    const y = Math.floor(i / width);
    for (const d of Object.values(DIRS)) {
      const nx = x + d.x;
      const ny = y + d.y;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const n = ny * width + nx;
      if (dist[n] !== -1 || blocked.has(n)) continue;
      dist[n] = dist[i] + 1;
      queue.push(n);
    }
  }
  return dist;
}

function measure(state, dir) {
  const { grows } = peek(state, dir);
  const next = step(state, dir);
  const { width, height, snake } = next;
  const dist = distancesFromHead(next);
  const at = (c) => dist[c.y * width + c.x];

  const space = dist.filter((d) => d > 0).length;
  const free = width * height - snake.length;

  // The tail is reachable if the head stands next to it or can walk to a cell
  // that does. Chasing the tail is what keeps a long snake out of trouble.
  const tail = snake[snake.length - 1];
  const tailReachable = Object.values(DIRS).some((d) => {
    const c = { x: tail.x + d.x, y: tail.y + d.y };
    if (c.x < 0 || c.y < 0 || c.x >= width || c.y >= height) return false;
    return at(c) >= 0;
  });

  // After eating, the food in `next` is a fresh random one, so distance is
  // measured to the food this move was aiming at.
  const food = state.food;
  const head = state.snake[0];
  const manhattan = (c) => Math.abs(c.x - food.x) + Math.abs(c.y - food.y);
  const foodDist = grows ? 0 : at(food) >= 0 ? at(food) : null;

  return {
    eats: grows,
    wins: next.deathReason === 'won',
    foodDist,
    foodCloser: manhattan(snake[0]) < manhattan(head),
    space,
    free,
    length: snake.length,
    tailReachable,
    exits: next.alive ? steerable(next).filter((d) => !peek(next, d).fatal).length : 0,
  };
}

function sentence(f) {
  if (f.wins) return 'Eats the last food and fills the board.';
  const parts = [];
  if (f.eats) parts.push('Eats the food.');
  else if (f.foodDist === null) parts.push('Has no open path to the food from here.');
  else {
    const steps = `${f.foodDist} step${f.foodDist === 1 ? '' : 's'}`;
    parts.push(
      f.foodCloser
        ? `Moves closer to the food, now ${steps} away by open path.`
        : `Moves away from the food, now ${steps} away by open path.`,
    );
  }

  if (f.space >= f.free) parts.push(`Keeps the whole board reachable (${f.space} open cells).`);
  else if (f.space >= f.length) parts.push(`Keeps ${f.space} of ${f.free} open cells reachable.`);
  else {
    parts.push(
      `Enters a pocket of only ${f.space} open cell${f.space === 1 ? '' : 's'}, ` +
        `smaller than the snake's length of ${f.length}.`,
    );
  }

  parts.push(f.tailReachable ? 'Can still reach its own tail.' : 'Cannot reach its own tail.');

  if (f.exits === 0) parts.push('Dead end: no safe move next turn.');
  else if (f.exits === 1) parts.push('Only one safe move next turn.');
  return parts.join(' ');
}

// One entry per steerable direction. Fatal moves are listed (so the UI can
// show them) but carry no features and are never offered to the model.
export function describeMoves(state) {
  return steerable(state).map((dir) => {
    const { head, fatal } = peek(state, dir);
    if (fatal) return { id: dir, dir, cell: head, fatal, features: null, text: `Hits ${fatal === 'wall' ? 'the wall' : 'its own body'}.` };
    const features = measure(state, dir);
    return { id: dir, dir, cell: head, fatal: null, features, text: sentence(features) };
  });
}

const LEGEND = 'H head, o body, t tail, * food, . empty';

export function boardRows(state) {
  const rows = Array.from({ length: state.height }, () => new Array(state.width).fill('.'));
  if (state.food) rows[state.food.y][state.food.x] = '*';
  state.snake.forEach((c, i) => {
    rows[c.y][c.x] = i === 0 ? 'H' : i === state.snake.length - 1 ? 't' : 'o';
  });
  return rows.map((r) => r.join(''));
}

// The request sent to the decision model: state plus one Choice question whose
// options are the safe moves.
export function buildRequest(state, options) {
  const criteria = {};
  for (const o of options) if (!o.fatal) criteria[o.id] = o.text;
  return {
    state: {
      board_rows_top_to_bottom: boardRows(state),
      legend: LEGEND,
      width: state.width,
      height: state.height,
      heading: state.dir,
      head: [state.snake[0].x, state.snake[0].y],
      food: state.food ? [state.food.x, state.food.y] : null,
      snake_length: state.snake.length,
      score: state.score,
      steps_since_food: state.stepsSinceFood,
    },
    questions: {
      [QUESTION]: { type: 'choice', instructions: INSTRUCTIONS, criteria },
    },
  };
}
