// Pluggable players. Every player has the same shape:
//   choose(state) -> { dir, options, probabilities, confidence, source, latencyMs, ... }
// so the game loop and the benchmark don't care who is playing.

import { describeMoves, buildRequest, QUESTION } from './describe.js';

// Hand-written baseline the model is measured against.
export function heuristicScore(f) {
  if (f.wins) return 1e6;
  let s = 0;
  if (f.exits === 0) s -= 1000;
  if (!f.tailReachable) s += f.space < f.length ? -500 + f.space : -40;
  if (f.eats) s += 30;
  else if (f.foodDist === null) s -= 20;
  else s -= f.foodDist;
  s += (f.space / Math.max(1, f.free)) * 10;
  return s;
}

function bestByHeuristic(safe) {
  return safe.reduce((a, b) => (heuristicScore(b.features) > heuristicScore(a.features) ? b : a));
}

function decision(options, chosen, extra) {
  return {
    dir: chosen.dir,
    options,
    probabilities: { [chosen.id]: 1 },
    confidence: null,
    latencyMs: 0,
    ...extra,
  };
}

// Shared preamble: nothing to decide when there are zero or one safe moves.
function forced(state, options) {
  const safe = options.filter((o) => !o.fatal);
  if (safe.length === 0) {
    const straight = options.find((o) => o.dir === state.dir) ?? options[0];
    return decision(options, straight, { source: 'no-safe-move' });
  }
  if (safe.length === 1) return decision(options, safe[0], { source: 'forced' });
  return null;
}

export function createRandomPlayer(random = Math.random) {
  return {
    name: 'random',
    async choose(state) {
      const options = describeMoves(state);
      const f = forced(state, options);
      if (f) return f;
      const safe = options.filter((o) => !o.fatal);
      const probabilities = Object.fromEntries(safe.map((o) => [o.id, 1 / safe.length]));
      const chosen = safe[Math.floor(random() * safe.length)];
      return { ...decision(options, chosen, { source: 'random' }), probabilities };
    },
  };
}

export function createHeuristicPlayer() {
  return {
    name: 'heuristic',
    async choose(state) {
      const options = describeMoves(state);
      const f = forced(state, options);
      if (f) return f;
      const safe = options.filter((o) => !o.fatal);
      return decision(options, bestByHeuristic(safe), { source: 'heuristic' });
    },
  };
}

// decide(request) -> { answers: { move: { choice, confidence, probabilities } }, latencyMs, mode }
// is either a client from src/jev.js / src/mock.js (node) or a fetch to the
// server's proxy (browser). If the model fails or answers with something that
// isn't on the menu, the heuristic plays the move and the decision says so.
export function createJevPlayer(decide) {
  return {
    name: 'jev',
    async choose(state) {
      const options = describeMoves(state);
      const f = forced(state, options);
      if (f) return f;
      const safe = options.filter((o) => !o.fatal);

      let error;
      try {
        const res = await decide(buildRequest(state, options));
        const answer = res?.answers?.[QUESTION];
        const probabilities = {};
        for (const o of safe) {
          const p = Number(answer?.probabilities?.[o.id]);
          if (Number.isFinite(p) && p >= 0) probabilities[o.id] = p;
        }
        let chosen = safe.find((o) => o.id === answer?.choice);
        if (Object.keys(probabilities).length > 0) {
          chosen = safe.reduce((a, b) => ((probabilities[b.id] ?? 0) > (probabilities[a.id] ?? 0) ? b : a));
        }
        if (chosen) {
          return {
            dir: chosen.dir,
            options,
            probabilities: Object.keys(probabilities).length ? probabilities : { [chosen.id]: 1 },
            confidence: answer.confidence ?? null,
            latencyMs: res.latencyMs ?? 0,
            source: 'jev',
            mode: res.mode,
          };
        }
        error = 'model answer did not match any offered move';
      } catch (e) {
        error = e.message;
      }
      return decision(options, bestByHeuristic(safe), { source: 'fallback', error });
    },
  };
}
