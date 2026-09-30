import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, step, peek, steerable } from '../src/snake.js';
import { describeMoves, buildRequest, QUESTION } from '../src/describe.js';
import { createJevPlayer, createHeuristicPlayer } from '../src/players.js';
import { createMockClient } from '../src/mock.js';
import { createLiveClient, normalizeResponse, withCallCap } from '../src/jev.js';
import { createApp } from '../server.js';

// A hand-built state: snake given head-first as [x, y] pairs.
function stateWith({ snake, food, dir = 'right', width = 6, height = 6 }) {
  return {
    ...createGame({ width, height, seed: 1 }),
    snake: snake.map(([x, y]) => ({ x, y })),
    food: { x: food[0], y: food[1] },
    dir,
  };
}

test('same seed and moves give the same game', () => {
  const play = () => {
    let g = createGame({ seed: 7 });
    for (const d of ['up', 'up', 'left', 'down', 'down', 'right']) g = step(g, d);
    return g;
  };
  assert.deepEqual(play(), play());
  assert.notDeepEqual(createGame({ seed: 7 }).food, createGame({ seed: 8 }).food);
});

test('a reversal is refused and the snake keeps its heading', () => {
  const g = createGame({ seed: 1 });
  const next = step(g, 'left');
  assert.equal(next.dir, 'right');
  assert.equal(next.alive, true);
  assert.deepEqual(next.snake[0], { x: g.snake[0].x + 1, y: g.snake[0].y });
  assert.ok(!steerable(g).includes('left'));
});

test('walls and the body are fatal, but the vacating tail cell is not', () => {
  const atWall = stateWith({ snake: [[5, 0], [4, 0], [3, 0]], food: [0, 5] });
  assert.equal(step(atWall, 'right').deathReason, 'wall');

  // A 2x2 loop: the head moves into the cell the tail is leaving.
  const loop = stateWith({ snake: [[1, 1], [1, 2], [2, 2], [2, 1]], food: [5, 5], dir: 'up' });
  assert.equal(peek(loop, 'right').fatal, null);
  assert.equal(step(loop, 'right').alive, true);

  const coiled = stateWith({ snake: [[1, 1], [1, 2], [2, 2], [2, 1], [3, 1]], food: [5, 5], dir: 'up' });
  assert.equal(step(coiled, 'right').deathReason, 'self');
});

test('eating grows the snake, scores, and places new food off the body', () => {
  const g = stateWith({ snake: [[2, 2], [1, 2], [0, 2]], food: [3, 2] });
  const next = step(g, 'right');
  assert.equal(next.score, 1);
  assert.equal(next.snake.length, 4);
  assert.ok(!next.snake.some((c) => c.x === next.food.x && c.y === next.food.y));
});

test('moves are described from what they lead to', () => {
  // Heading right along the top row with the body curled underneath: going
  // down is fatal, right eats.
  const g = stateWith({ snake: [[2, 0], [1, 0], [1, 1], [2, 1], [3, 1]], food: [3, 0] });
  const byId = Object.fromEntries(describeMoves(g).map((o) => [o.id, o]));
  assert.equal(byId.up.fatal, 'wall');
  assert.equal(byId.down.fatal, 'self');
  assert.equal(byId.right.features.eats, true);
  assert.match(byId.right.text, /^Eats the food\./);

  const request = buildRequest(g, Object.values(byId));
  assert.deepEqual(Object.keys(request.questions[QUESTION].criteria), ['right']);
  assert.equal(request.state.board_rows_top_to_bottom[0], '.oH*..');
});

test('a pocket smaller than the snake is called out', () => {
  // The body walls off the top-left corner with the head inside it.
  const g = stateWith({
    snake: [[0, 1], [0, 2], [1, 2], [2, 2], [2, 1], [2, 0], [3, 0], [4, 0]],
    food: [5, 5],
    dir: 'up',
  });
  const up = describeMoves(g).find((o) => o.id === 'up');
  assert.match(up.text, /Enters a pocket of only 2 open cells, smaller than the snake's length of 8\./);
  assert.match(up.text, /Cannot reach its own tail\./);
  assert.equal(up.features.space, 2);
});

test('mock answers a Choice with a probability per offered move', async () => {
  const g = createGame({ seed: 3 });
  const request = buildRequest(g, describeMoves(g));
  const { answers } = await createMockClient({ seed: 1 }).decide(request);
  const a = answers[QUESTION];
  const ids = Object.keys(request.questions[QUESTION].criteria);
  assert.deepEqual(Object.keys(a.probabilities), ids);
  assert.ok(Math.abs(Object.values(a.probabilities).reduce((x, y) => x + y, 0) - 1) < 1e-9);
  assert.ok(ids.includes(a.choice));

  const again = await createMockClient({ seed: 1 }).decide(request);
  assert.deepEqual(again.answers, answers);
});

test('jev player plays the most probable move and falls back when the model fails', async () => {
  const g = createGame({ seed: 3 });
  const picksUp = createJevPlayer(async () => ({
    answers: { [QUESTION]: { choice: 'up', confidence: 0.7, probabilities: { up: 0.7, down: 0.2, right: 0.1 } } },
    latencyMs: 5,
  }));
  const d = await picksUp.choose(g);
  assert.equal(d.dir, 'up');
  assert.equal(d.source, 'jev');

  const broken = createJevPlayer(async () => {
    throw new Error('boom');
  });
  const fb = await broken.choose(g);
  assert.equal(fb.source, 'fallback');
  assert.equal(fb.error, 'boom');
  assert.equal(fb.dir, (await createHeuristicPlayer().choose(g)).dir);

  const offMenu = createJevPlayer(async () => ({ answers: { [QUESTION]: { choice: 'left', probabilities: {} } } }));
  assert.equal((await offMenu.choose(g)).source, 'fallback');
});

test('no model call is made when only one move is safe', async () => {
  const g = stateWith({ snake: [[2, 0], [1, 0], [1, 1], [2, 1], [3, 1]], food: [3, 0] });
  let calls = 0;
  const player = createJevPlayer(async () => {
    calls++;
    return {};
  });
  const d = await player.choose(g);
  assert.equal(d.source, 'forced');
  assert.equal(d.dir, 'right');
  assert.equal(calls, 0);
});

test('live responses are normalized across field-name and scale variants', () => {
  const request = { questions: { move: { type: 'choice', criteria: { up: 'a', left: 'b' } } } };
  const expected = { choice: 'up', confidence: 0.8, probabilities: { up: 0.8, left: 0.2 } };
  assert.deepEqual(
    normalizeResponse({ answers: { move: { choice: 'up', confidence: 80, probabilities: { up: 80, left: 20 } } } }, request).answers.move,
    expected,
  );
  assert.deepEqual(
    normalizeResponse({ move: { value: 'up', confidence: 0.8, probs: [0.8, 0.2] } }, request).answers.move,
    expected,
  );
});

test('live client sends the key as a bearer token and surfaces API errors', async () => {
  const request = { state: { x: 1 }, questions: { move: { type: 'choice', criteria: { up: 'a', left: 'b' } } } };
  let seen;
  const ok = createLiveClient({
    apiKey: 'sk_test',
    fetch: async (url, init) => {
      seen = { url, init };
      return new Response(JSON.stringify({ answers: { move: { choice: 'left', probabilities: { up: 0.1, left: 0.9 } } } }));
    },
  });
  const res = await ok.decide(request);
  assert.equal(res.answers.move.choice, 'left');
  assert.equal(seen.init.headers.authorization, 'Bearer sk_test');
  assert.deepEqual(JSON.parse(seen.init.body).questions, request.questions);

  const denied = createLiveClient({ apiKey: 'sk_bad', fetch: async () => new Response('nope', { status: 401 }) });
  await assert.rejects(denied.decide(request), /TypeSafe API 401: nope/);
  assert.throws(() => createLiveClient({}), /TYPESAFE_API_KEY is required/);
});

test('server proxies decisions, enforces the call cap, and hides non-shared source', async (t) => {
  const app = createApp({ client: createMockClient(), maxCalls: 2 });
  await new Promise((r) => app.listen(0, r));
  t.after(() => app.close());
  const base = `http://localhost:${app.address().port}`;

  const g = createGame({ seed: 3 });
  const post = () =>
    fetch(`${base}/api/decide`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(buildRequest(g, describeMoves(g))),
    });

  const first = await post();
  assert.equal(first.status, 200);
  const body = await first.json();
  assert.equal(body.mode, 'mock');
  assert.ok(body.answers[QUESTION].choice);
  assert.equal(body.calls, 1);

  assert.equal((await post()).status, 200);
  assert.equal((await post()).status, 429);

  assert.equal((await fetch(`${base}/api/config`).then((r) => r.json())).calls, 2);
  assert.equal((await fetch(`${base}/`)).status, 200);
  assert.equal((await fetch(`${base}/src/snake.js`)).status, 200);
  assert.equal((await fetch(`${base}/src/jev.js`)).status, 404);
  assert.equal((await fetch(`${base}/..%2Fserver.js`)).status, 404);
  assert.equal((await fetch(`${base}/api/decide`, { method: 'POST', body: 'not json' })).status, 400);
});

test('withCallCap counts calls and refuses past the limit', async () => {
  const capped = withCallCap(createMockClient(), 1);
  const g = createGame({ seed: 3 });
  const request = buildRequest(g, describeMoves(g));
  await capped.decide(request);
  await assert.rejects(capped.decide(request), { code: 'CALL_CAP' });
  assert.equal(capped.calls, 1);
});
