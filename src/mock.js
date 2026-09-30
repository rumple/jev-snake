// Stand-in for the decision model, with the same decide() contract as the live
// client in src/jev.js. It reads only what the real model would read — the
// sentences in the Choice criteria — and scores them by keyword, then adds
// seeded noise so its answers are plausible but not perfect.

const RULES = [
  [/fills the board/i, 8],
  [/Eats the food/i, 2],
  [/Moves closer to the food/i, 1],
  [/Moves away from the food/i, -0.5],
  [/no open path to the food/i, -1],
  [/whole board reachable/i, 1],
  [/Enters a pocket/i, -2],
  [/Can still reach its own tail/i, 1],
  [/Cannot reach its own tail/i, -2],
  [/Dead end/i, -5],
  [/Only one safe move/i, -1],
];

function mulberry32(seed) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createMockClient({ latencyMs = 0, seed = 1, noise = 0.6 } = {}) {
  const random = mulberry32(seed);

  function answerChoice(question) {
    const ids = Object.keys(question.criteria ?? {});
    if (ids.length === 0) throw new Error('mock: Choice question has no criteria');
    const logits = ids.map((id) => {
      const text = question.criteria[id];
      const score = RULES.reduce((s, [re, w]) => (re.test(text) ? s + w : s), 0);
      return score + (random() - 0.5) * 2 * noise;
    });
    const max = Math.max(...logits);
    const exps = logits.map((l) => Math.exp(l - max));
    const sum = exps.reduce((a, b) => a + b, 0);
    const probabilities = Object.fromEntries(ids.map((id, i) => [id, exps[i] / sum]));
    const choice = ids.reduce((a, b) => (probabilities[b] > probabilities[a] ? b : a));
    return { choice, confidence: probabilities[choice], probabilities };
  }

  return {
    mode: 'mock',
    model: 'mock-keywords',
    async decide(request) {
      const started = performance.now();
      const answers = {};
      for (const [name, q] of Object.entries(request.questions ?? {})) {
        if (q.type !== 'choice') throw new Error(`mock: unsupported question type "${q.type}"`);
        answers[name] = answerChoice(q);
      }
      if (latencyMs > 0) await sleep(latencyMs * (0.7 + random() * 0.6));
      return { answers, model: 'mock-keywords', mode: 'mock', latencyMs: Math.round(performance.now() - started) };
    },
  };
}
