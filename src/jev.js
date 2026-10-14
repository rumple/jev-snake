// Live TypeSafe client, plus the env-driven choice between live and mock.
//
// The wire format below (endpoint, body shape, response fields) is
// reconstructed from public Jev demo repos, not from TypeSafe's docs. It works
// against the live API for Choice questions; other question types are untried,
// which is why normalizeResponse() stays tolerant of field-name variants.

import { createMockClient } from './mock.js';

export const DEFAULT_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const DEFAULT_MODEL = 'jev-latest';

function toWire(request, model) {
  return { model, state: request.state, questions: request.questions };
}

function first(obj, keys) {
  for (const k of keys) if (obj?.[k] !== undefined && obj[k] !== null) return obj[k];
  return undefined;
}

// Probabilities may arrive as {id: p}, as [p, p, ...] in criteria order, or as
// [{id, probability}, ...]. Percentages are scaled to 0..1.
function toProbabilityMap(raw, ids) {
  let map = {};
  if (Array.isArray(raw)) {
    raw.forEach((entry, i) => {
      if (typeof entry === 'number') map[ids[i]] = entry;
      else {
        const id = first(entry, ['id', 'key', 'option', 'choice']);
        const p = first(entry, ['probability', 'prob', 'p', 'value']);
        if (id !== undefined) map[id] = Number(p);
      }
    });
  } else if (raw && typeof raw === 'object') {
    map = { ...raw };
  }
  const out = {};
  for (const id of ids) {
    const p = Number(map[id]);
    if (Number.isFinite(p)) out[id] = p;
  }
  if (Object.values(out).some((p) => p > 1)) for (const id in out) out[id] /= 100;
  return out;
}

export function normalizeResponse(raw, request) {
  const answers = {};
  for (const [name, q] of Object.entries(request.questions)) {
    const a = raw?.answers?.[name] ?? raw?.[name];
    if (!a) continue;
    const ids = Object.keys(q.criteria ?? {});
    let confidence = Number(first(a, ['confidence']));
    if (!Number.isFinite(confidence)) confidence = null;
    else if (confidence > 1) confidence /= 100;
    answers[name] = {
      choice: first(a, ['choice', 'value', 'answer', 'key']),
      confidence,
      probabilities: toProbabilityMap(first(a, ['probabilities', 'probs', 'distribution']), ids),
    };
  }
  return { answers, model: raw?.model };
}

export function createLiveClient({
  apiKey,
  endpoint = DEFAULT_ENDPOINT,
  model = DEFAULT_MODEL,
  fetch = globalThis.fetch,
  timeoutMs = 10000,
} = {}) {
  if (!apiKey) throw new Error('TYPESAFE_API_KEY is required for live mode');
  return {
    mode: 'live',
    model,
    async decide(request) {
      const started = performance.now();
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(toWire(request, model)),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`TypeSafe API ${res.status}: ${text.slice(0, 300)}`);
      let raw;
      try {
        raw = JSON.parse(text);
      } catch {
        throw new Error(`TypeSafe API returned non-JSON: ${text.slice(0, 300)}`);
      }
      const normalized = normalizeResponse(raw, request);
      return {
        ...normalized,
        model: normalized.model ?? model,
        mode: 'live',
        latencyMs: Math.round(performance.now() - started),
        raw,
      };
    },
  };
}

// JEV_MODE wins; otherwise live when a key is present, mock when not.
export function createClientFromEnv(env = process.env, overrides = {}) {
  const mode = env.JEV_MODE || (env.TYPESAFE_API_KEY ? 'live' : 'mock');
  if (mode === 'mock') {
    return createMockClient({ latencyMs: Number(env.MOCK_LATENCY_MS ?? 120), ...overrides });
  }
  if (mode === 'live') {
    return createLiveClient({
      apiKey: env.TYPESAFE_API_KEY,
      endpoint: env.JEV_ENDPOINT || DEFAULT_ENDPOINT,
      model: env.JEV_MODEL || DEFAULT_MODEL,
    });
  }
  throw new Error(`Unknown JEV_MODE "${mode}" (expected mock or live)`);
}

// Wraps a client with a hard ceiling on calls.
export function withCallCap(client, maxCalls) {
  const capped = {
    ...client,
    calls: 0,
    maxCalls,
    async decide(request) {
      if (capped.calls >= maxCalls) {
        const err = new Error(`call cap reached (${maxCalls})`);
        err.code = 'CALL_CAP';
        throw err;
      }
      capped.calls++;
      return client.decide(request);
    },
  };
  return capped;
}
