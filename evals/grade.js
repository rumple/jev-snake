// Answer key for a position. The model never sees any of this: it is computed
// by the same move analysis the sentence describer uses, and only used to
// grade what the model chose.

import { describeMoves } from '../src/describe.js';
import { heuristicScore } from '../src/players.js';

// A move that survives this turn but leaves the snake with no way out.
const isTrap = (f) => !f.wins && (f.exits === 0 || (f.space < f.length && !f.tailReachable));

export function analyze(state) {
  const moves = describeMoves(state).map((o) => ({
    dir: o.dir,
    fatal: o.fatal,
    trap: !o.fatal && isTrap(o.features),
    eats: !o.fatal && o.features.eats,
    foodDist: o.fatal ? null : o.features.foodDist,
    score: o.fatal ? -Infinity : heuristicScore(o.features),
  }));
  const alive = moves.filter((m) => !m.fatal);
  const sound = alive.filter((m) => !m.trap);
  // Moves worth choosing between on food: the sound ones, or failing that
  // whatever keeps the snake alive this turn.
  const pool = sound.length ? sound : alive;
  const reachable = pool.filter((m) => m.foodDist !== null);
  const nearest = reachable.length ? Math.min(...reachable.map((m) => m.foodDist)) : null;
  const best = alive.reduce((a, b) => (b.score > a.score ? b : a), alive[0]);

  const key = {};
  for (const m of moves) {
    key[m.dir] = {
      fatal: m.fatal,
      trap: m.trap,
      eats: m.eats,
      towardFood: pool.includes(m) && nearest !== null && m.foodDist === nearest,
      heuristic: m === best,
    };
  }

  const tags = [];
  if (moves.some((m) => m.fatal === 'wall')) tags.push('wall');
  if (moves.some((m) => m.fatal === 'self')) tags.push('body');
  if (alive.some((m) => m.trap) && sound.length) tags.push('trap');
  if (pool.some((m) => m.eats)) tags.push('eat');
  if (!tags.includes('wall') && !tags.includes('body') && !tags.includes('trap')) tags.push('open');

  return {
    key,
    tags,
    // Whether each question can be asked of this position at all.
    asks: {
      survive: moves.some((m) => m.fatal),
      avoidTrap: tags.includes('trap'),
      food: nearest !== null && pool.some((m) => !key[m.dir].towardFood),
    },
  };
}

// Grade one answer. `probabilities` may be empty; `choice` is the move played.
export function grade(state, choice, probabilities = {}) {
  const { key, asks, tags } = analyze(state);
  const picked = key[choice];
  const mass = (test) => Object.entries(key).reduce((s, [dir, k]) => s + (test(k) ? probabilities[dir] ?? 0 : 0), 0);
  return {
    tags,
    asks,
    valid: !!picked,
    survived: !!picked && !picked.fatal,
    avoidedTrap: !!picked && !picked.fatal && !picked.trap,
    towardFood: !!picked && picked.towardFood,
    matchesHeuristic: !!picked && picked.heuristic,
    fatalMass: mass((k) => !!k.fatal),
  };
}

// What picking uniformly at random would score on this position.
export function chance(state) {
  const { key, asks, tags } = analyze(state);
  const ks = Object.values(key);
  const share = (test) => ks.filter(test).length / ks.length;
  return {
    tags,
    asks,
    valid: true,
    survived: share((k) => !k.fatal),
    avoidedTrap: share((k) => !k.fatal && !k.trap),
    towardFood: share((k) => k.towardFood),
    matchesHeuristic: share((k) => k.heuristic),
    fatalMass: share((k) => !!k.fatal),
  };
}
