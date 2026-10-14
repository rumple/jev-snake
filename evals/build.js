// Builds evals/positions.jsonl from the call logs in runs/.
//   node evals/build.js [--size 150] [--seed 1]
//
// The logs hold only a drawing of the board, which does not say in what order
// the body cells are connected. So each logged game is replayed from its seed,
// checking the replay against every logged board, which recovers the exact
// engine state at every step — including the steps where no call was made
// because only one move was safe.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createGame, step } from '../src/snake.js';
import { describeMoves, boardRows } from '../src/describe.js';
import { heuristicScore } from '../src/players.js';
import { analyze } from './grade.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({
  options: { size: { type: 'string', default: '150' }, seed: { type: 'string', default: '1' } },
});

const safeMoves = (state) => describeMoves(state).filter((o) => !o.fatal);
const sameBoard = (state, logged) => boardRows(state).join('\n') === logged.board_rows_top_to_bottom.join('\n');

// Play the moves that were made without a call, collecting each position.
function throughForced(state, out) {
  while (state.alive) {
    const safe = safeMoves(state);
    if (safe.length !== 1) break;
    out.push(state);
    state = step(state, safe[0].dir);
  }
  return state;
}

// The move the UI played for a logged entry, by the same rule as the jev player.
function playedMove(state, entry) {
  const safe = safeMoves(state);
  const probs = entry.result?.answers?.move?.probabilities;
  if (probs && Object.keys(probs).length) {
    return safe.reduce((a, b) => ((probs[b.id] ?? 0) > (probs[a.id] ?? 0) ? b : a)).dir;
  }
  return safe.reduce((a, b) => (heuristicScore(b.features) > heuristicScore(a.features) ? b : a)).dir;
}

function findStart(logged) {
  for (let seed = 1; seed <= 200; seed++) {
    const skipped = [];
    const state = throughForced(createGame({ width: logged.width, height: logged.height, seed }), skipped);
    if (state.alive && sameBoard(state, logged)) return { state, skipped };
  }
  return null;
}

const positions = new Map(); // keyed by board + heading, so repeats collapse
const stats = { files: 0, entries: 0, replayed: 0, lost: 0, games: 0 };

function record(state, file) {
  if (!state.alive || safeMoves(state).length === 0) return;
  const key = `${boardRows(state).join('/')}|${state.dir}`;
  if (!positions.has(key)) positions.set(key, { state, file });
}

const runsDir = path.join(ROOT, 'runs');
for (const file of fs.existsSync(runsDir) ? fs.readdirSync(runsDir).sort() : []) {
  if (!file.endsWith('.jsonl')) continue;
  stats.files++;
  const entries = fs.readFileSync(path.join(runsDir, file), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  let state = null;
  for (const entry of entries) {
    const logged = entry.request?.state;
    if (!logged?.board_rows_top_to_bottom) continue;
    stats.entries++;
    if (!state || !state.alive || !sameBoard(state, logged)) {
      const start = findStart(logged);
      if (!start) {
        // Mid-game entry whose game start is not in the log: cannot be replayed.
        state = null;
        stats.lost++;
        continue;
      }
      stats.games++;
      start.skipped.forEach((s) => record(s, file));
      state = start.state;
    }
    stats.replayed++;
    record(state, file);
    const forced = [];
    state = throughForced(step(state, playedMove(state, entry)), forced);
    forced.forEach((s) => record(s, file));
  }
}

// ---- stratified sample ----

function mulberry32(seed) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const random = mulberry32(Number(values.seed));
const shuffle = (xs) => {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [xs[i], xs[j]] = [xs[j], xs[i]];
  }
  return xs;
};

const all = [...positions.values()].map((p) => ({ ...p, tags: analyze(p.state).tags }));
const available = {};
for (const p of all) for (const t of p.tags) available[t] = (available[t] ?? 0) + 1;

// Open-board positions dominate the logs, so the rarer kinds are taken first
// and open positions only fill what is left.
const target = Number(values.size);
const chosen = new Set();
const perTag = Math.ceil(target / 5);
for (const tag of ['trap', 'body', 'wall', 'eat']) {
  let taken = 0;
  for (const p of shuffle(all.filter((x) => x.tags.includes(tag)))) {
    if (chosen.size >= target || taken >= perTag) break;
    if (!chosen.has(p)) {
      chosen.add(p);
      taken++;
    }
  }
}
for (const p of shuffle(all.filter((x) => x.tags.includes('open')))) {
  if (chosen.size >= target) break;
  chosen.add(p);
}
for (const p of shuffle([...all])) {
  if (chosen.size >= target) break;
  chosen.add(p);
}

const picked = [...chosen].sort(
  (a, b) => a.state.snake.length - b.state.snake.length || a.state.steps - b.state.steps,
);
const outFile = path.join(ROOT, 'evals', 'positions.jsonl');
fs.writeFileSync(
  outFile,
  picked.map((p, i) => JSON.stringify({ id: `p${String(i + 1).padStart(3, '0')}`, source: p.file, tags: p.tags, state: p.state })).join('\n') + '\n',
);

const inSet = {};
for (const p of picked) for (const t of p.tags) inSet[t] = (inSet[t] ?? 0) + 1;
console.log(`logs: ${stats.files} files, ${stats.entries} logged calls, ${stats.games} games replayed, ${stats.lost} calls not recoverable`);
console.log(`positions recovered: ${all.length} distinct (including steps played without a call)`);
console.table(Object.fromEntries(Object.keys(available).sort().map((t) => [t, { available: available[t], 'in eval set': inSet[t] ?? 0 }])));
const lengths = picked.map((p) => p.state.snake.length);
console.log(`wrote ${picked.length} positions to ${path.relative(ROOT, outFile)} (snake length ${Math.min(...lengths)}–${Math.max(...lengths)})`);
