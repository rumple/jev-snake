// Runs input variants over the fixed position set and grades the answers.
//   node evals/run.js [--variants board,coords] [--limit 20] [--tag trap] [--mock]
//
// Each position is one independent call; nothing the model answers changes
// the next position, so variants are compared on identical inputs. Results go
// to evals/results/<timestamp>/.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { VARIANTS } from '../src/variants.js';
import { QUESTION } from '../src/describe.js';
import { createClientFromEnv, withCallCap } from '../src/jev.js';
import { createMockClient } from '../src/mock.js';
import { analyze, grade, chance } from './grade.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch {
  // no .env
}

const { values } = parseArgs({
  options: {
    variants: { type: 'string', default: Object.keys(VARIANTS).join(',') },
    limit: { type: 'string' },
    tag: { type: 'string' },
    mock: { type: 'boolean', default: false },
  },
});

const names = values.variants.split(',');
for (const n of names) {
  if (!VARIANTS[n]) throw new Error(`unknown variant "${n}" (have: ${Object.keys(VARIANTS).join(', ')})`);
}

let positions = fs
  .readFileSync(path.join(ROOT, 'evals', 'positions.jsonl'), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l));
if (values.tag) positions = positions.filter((p) => p.tags.includes(values.tag));
if (values.limit) positions = positions.slice(0, Number(values.limit));
if (positions.length === 0) throw new Error('no positions selected');

const base = values.mock ? createMockClient({ latencyMs: 0 }) : createClientFromEnv(process.env, { latencyMs: 0 });
const maxCalls = base.mode === 'live' ? Number(process.env.MAX_CALLS ?? 1500) : Infinity;
const client = withCallCap(base, maxCalls);

// A request with a single option needs no call: there is nothing to choose.
const requests = names.map((n) => positions.map((p) => VARIANTS[n](p.state)));
const optionIds = (request) => Object.keys(request.questions[QUESTION].criteria);
const planned = requests.flat().filter((r) => optionIds(r).length > 1).length;
console.log(`${positions.length} positions × ${names.length} variant(s) = ${planned} calls to ${client.mode} (${client.model})`);
if (planned > maxCalls) {
  throw new Error(`that exceeds MAX_CALLS=${maxCalls}; raise it, or narrow the run with --variants, --tag or --limit`);
}

const outDir = path.join(ROOT, 'evals', 'results', new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(outDir, { recursive: true });

function mulberry32(seed) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const median = (xs) => (xs.length ? [...xs].sort((a, b) => a - b)[xs.length >> 1] : null);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

// "84% (38/45)": the share of positions where the question applies that were
// answered well. Chance rows carry fractional credit, so they show no count.
function rate(grades, asks, field, fractional = false) {
  const on = grades.filter((g) => asks(g));
  if (on.length === 0) return '–';
  const got = on.reduce((s, g) => s + Number(g[field]), 0);
  const pct = `${Math.round((got / on.length) * 100)}%`;
  return fractional ? pct : `${pct} (${got}/${on.length})`;
}

function summarize(label, grades, extra = {}, fractional = false) {
  return {
    variant: label,
    survive: rate(grades, (g) => g.asks.survive, 'survived', fractional),
    'avoid trap': rate(grades, (g) => g.asks.avoidTrap, 'avoidedTrap', fractional),
    'toward food': rate(grades, (g) => g.asks.food, 'towardFood', fractional),
    '= heuristic': rate(grades, () => true, 'matchesHeuristic', fractional),
    'p(fatal)': `${Math.round(mean(grades.filter((g) => g.asks.survive).map((g) => g.fatalMass)) * 100)}%`,
    ...extra,
  };
}

const rows = [];
for (const [v, name] of names.entries()) {
  const records = [];
  for (const [i, position] of positions.entries()) {
    const request = requests[v][i];
    const ids = optionIds(request);
    const record = { id: position.id, tags: position.tags, request };
    if (ids.length === 1) {
      record.choice = ids[0];
      record.probabilities = { [ids[0]]: 1 };
      record.called = false;
    } else {
      record.called = true;
      try {
        const res = await client.decide(request);
        const answer = res.answers?.[QUESTION];
        const probabilities = {};
        for (const id of ids) {
          const p = Number(answer?.probabilities?.[id]);
          if (Number.isFinite(p)) probabilities[id] = p;
        }
        const ranked = Object.keys(probabilities).sort((a, b) => probabilities[b] - probabilities[a]);
        record.choice = ranked[0] ?? (ids.includes(answer?.choice) ? answer.choice : null);
        record.probabilities = probabilities;
        record.confidence = answer?.confidence ?? null;
        record.latencyMs = res.latencyMs;
        record.usage = res.raw?.usage ?? null;
        record.raw = res.raw;
      } catch (e) {
        record.error = e.message;
        record.choice = null;
        record.probabilities = {};
      }
    }
    record.grade = grade(position.state, record.choice, record.probabilities);
    records.push(record);
    if (process.stdout.isTTY) process.stdout.write(`\r${name}: ${i + 1}/${positions.length}`);
  }
  if (process.stdout.isTTY) process.stdout.write('\n');
  fs.writeFileSync(path.join(outDir, `${name}.jsonl`), records.map((r) => JSON.stringify(r)).join('\n') + '\n');

  const called = records.filter((r) => r.called);
  const tokens = (k) => {
    const xs = called.map((r) => r.usage?.[k]).filter((x) => x !== undefined);
    return xs.length ? Math.round(mean(xs)) : '–';
  };
  rows.push(
    summarize(name, records.map((r) => r.grade), {
      calls: called.length,
      errors: records.filter((r) => r.error || (r.called && !r.grade.valid)).length,
      'tokens in': tokens('input_tokens'),
      'tokens out': tokens('output_tokens'),
      'median ms': median(called.filter((r) => !r.error).map((r) => r.latencyMs)) ?? '–',
    }),
  );
}
// Free reference rows, played by code on the same positions: the hand-written
// bot, and one seeded uniform draw over the steerable moves. (chance) is what
// that draw scores on average.
const random = mulberry32(1);
const baselines = {
  '(heuristic)': (key) => Object.keys(key).find((d) => key[d].heuristic),
  '(random)': (key) => Object.keys(key)[Math.floor(random() * Object.keys(key).length)],
};
for (const [label, pick] of Object.entries(baselines)) {
  const records = positions.map((p) => {
    const choice = pick(analyze(p.state).key);
    return { id: p.id, tags: p.tags, choice, grade: grade(p.state, choice, { [choice]: 1 }) };
  });
  fs.writeFileSync(path.join(outDir, `${label.slice(1, -1)}.jsonl`), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  rows.push(summarize(label, records.map((r) => r.grade)));
}
rows.push(summarize('(chance)', positions.map((p) => chance(p.state)), {}, true));

console.table(Object.fromEntries(rows.map(({ variant, ...rest }) => [variant, rest])));
fs.writeFileSync(
  path.join(outDir, 'summary.json'),
  JSON.stringify({ mode: client.mode, model: client.model, positions: positions.length, filter: { tag: values.tag ?? null, limit: values.limit ?? null }, rows }, null, 2) + '\n',
);
console.log(`results: ${path.relative(ROOT, outDir)}`);
