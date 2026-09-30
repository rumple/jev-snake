// Headless benchmark: every player plays the same seeds.
//   node tools/bench.js [--players random,heuristic,jev] [--seeds 10] [--max-steps 3000] [--size 12]
// The jev player uses the mock unless JEV_MODE=live (or a key) is set.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createGame, step } from '../src/snake.js';
import { createRandomPlayer, createHeuristicPlayer, createJevPlayer } from '../src/players.js';
import { createClientFromEnv, withCallCap } from '../src/jev.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch {
  // no .env
}

const { values } = parseArgs({
  options: {
    players: { type: 'string', default: 'random,heuristic,jev' },
    seeds: { type: 'string', default: '10' },
    'max-steps': { type: 'string', default: '3000' },
    size: { type: 'string', default: '12' },
  },
});
const seeds = Array.from({ length: Number(values.seeds) }, (_, i) => i + 1);
const maxSteps = Number(values['max-steps']);
const size = Number(values.size);

// The cap protects spend, so it only applies to the live model.
const base = createClientFromEnv(process.env, { latencyMs: 0 });
const client = withCallCap(base, base.mode === 'live' ? Number(process.env.MAX_CALLS ?? 1500) : Infinity);

function seededRandom(seed) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const factories = {
  random: (seed) => createRandomPlayer(seededRandom(seed)),
  heuristic: () => createHeuristicPlayer(),
  jev: () => createJevPlayer((req) => client.decide(req)),
};

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

const rows = [];
const notes = [];
for (const name of values.players.split(',')) {
  if (!factories[name]) throw new Error(`unknown player "${name}"`);
  const games = [];
  const sources = {};
  const latencies = [];
  for (const seed of seeds) {
    // A game played past the cap would be the heuristic's, not the model's.
    if (name === 'jev' && client.calls >= client.maxCalls) break;
    const player = factories[name](seed);
    let game = createGame({ width: size, height: size, seed });
    while (game.alive && game.steps < maxSteps) {
      const d = await player.choose(game);
      sources[d.source] = (sources[d.source] ?? 0) + 1;
      if (d.source === 'jev') latencies.push(d.latencyMs);
      game = step(game, d.dir);
    }
    games.push(game);
  }
  if (games.length < seeds.length) {
    notes.push(`${name}: call cap of ${client.maxCalls} reached, only ${games.length} of ${seeds.length} games played (the last one partly by the fallback heuristic).`);
  }
  const ends = {};
  for (const g of games) {
    const end = g.alive ? 'step-cap' : g.deathReason;
    ends[end] = (ends[end] ?? 0) + 1;
  }
  rows.push({
    player: name === 'jev' ? `jev (${client.mode})` : name,
    games: games.length,
    'mean score': mean(games.map((g) => g.score)).toFixed(1),
    'min–max': `${Math.min(...games.map((g) => g.score))}–${Math.max(...games.map((g) => g.score))}`,
    'mean steps': Math.round(mean(games.map((g) => g.steps))),
    ends: Object.entries(ends).map(([k, v]) => `${k}:${v}`).join(' '),
    'model calls': sources.jev ?? 0,
    fallbacks: sources.fallback ?? 0,
    'mean ms': latencies.length ? Math.round(mean(latencies)) : '-',
  });
}

console.log(`${seeds.length} seeds · ${size}x${size} board · ${maxSteps}-step cap`);
console.table(rows);
for (const n of notes) console.log(`note: ${n}`);
