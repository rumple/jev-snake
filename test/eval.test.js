import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createGame } from '../src/snake.js';
import { QUESTION } from '../src/describe.js';
import { VARIANTS } from '../src/variants.js';
import { analyze, grade, chance } from '../evals/grade.js';

function stateWith({ snake, food, dir, width = 6, height = 6 }) {
  return {
    ...createGame({ width, height, seed: 1 }),
    snake: snake.map(([x, y]) => ({ x, y })),
    food: { x: food[0], y: food[1] },
    dir,
  };
}

// Head in the top-left corner region walled in by its own body: up and right
// both lead into a 3-cell pocket, left is the wall.
const pocket = stateWith({
  snake: [[0, 1], [0, 2], [1, 2], [2, 2], [2, 1], [2, 0], [3, 0], [4, 0]],
  food: [5, 5],
  dir: 'up',
});
// Top row, body curled underneath, food straight ahead.
const corridor = stateWith({ snake: [[2, 0], [1, 0], [1, 1], [2, 1], [3, 1]], food: [3, 0], dir: 'right' });

test('answer key marks fatal, eating and food-ward moves', () => {
  const { key, tags, asks } = analyze(corridor);
  assert.equal(key.up.fatal, 'wall');
  assert.equal(key.down.fatal, 'self');
  assert.equal(key.right.eats, true);
  assert.equal(key.right.towardFood, true);
  assert.deepEqual(tags, ['wall', 'body', 'eat']);
  assert.equal(asks.survive, true);
  assert.equal(asks.avoidTrap, false);

  assert.equal(grade(corridor, 'right', { right: 0.5, up: 0.3, down: 0.2 }).survived, true);
  const died = grade(corridor, 'up', { right: 0.5, up: 0.3, down: 0.2 });
  assert.equal(died.survived, false);
  assert.equal(died.fatalMass, 0.5);
  assert.equal(grade(corridor, null).valid, false);
  assert.ok(Math.abs(chance(corridor).survived - 1 / 3) < 1e-9);
});

test('a trap is only asked about when there is a way to avoid it', () => {
  const { key, asks } = analyze(pocket);
  assert.equal(key.left.fatal, 'wall');
  assert.equal(key.up.trap, true);
  assert.equal(key.right.trap, true);
  assert.equal(asks.avoidTrap, false);
});

test('raw variants offer every steerable move and carry no analysis', () => {
  for (const name of ['board', 'coords', 'board-coords']) {
    const q = VARIANTS[name](corridor).questions[QUESTION];
    assert.deepEqual(Object.keys(q.criteria), ['up', 'down', 'right'], name);
    assert.doesNotMatch(JSON.stringify(q.criteria), /Eats|Hits|reach|pocket/i, name);
  }
  assert.deepEqual(Object.keys(VARIANTS.sentences(corridor).questions[QUESTION].criteria), ['right']);
  assert.deepEqual(VARIANTS.coords(corridor).state.head, [2, 0]);
  assert.equal(VARIANTS.board(corridor).state.board_rows_top_to_bottom[0], '.oH*..');
  assert.equal(VARIANTS.board(corridor).state.head, undefined);
});

test('the committed position set is well formed and stored tags match the answer key', () => {
  const positions = fs.readFileSync(new URL('../evals/positions.jsonl', import.meta.url), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(positions.length > 0);
  assert.equal(new Set(positions.map((p) => p.id)).size, positions.length);
  for (const p of positions) {
    const { key, tags } = analyze(p.state);
    assert.deepEqual(tags, p.tags, p.id);
    assert.ok(Object.values(key).some((k) => !k.fatal), `${p.id} has a survivable move`);
  }
});
