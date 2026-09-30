// Static hosting plus the /api/decide proxy. The API key lives here and is
// never sent to the browser.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClientFromEnv, withCallCap } from './src/jev.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
// Engine modules the browser imports directly. Everything else in src/ stays server-side.
const SHARED = new Set(['snake.js', 'describe.js', 'players.js']);
const MAX_BODY = 64 * 1024;

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('request body too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('invalid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(res, pathname) {
  let file;
  if (pathname.startsWith('/src/')) {
    const name = pathname.slice('/src/'.length);
    if (!SHARED.has(name)) return sendJson(res, 404, { error: 'not found' });
    file = path.join(ROOT, 'src', name);
  } else {
    const publicDir = path.join(ROOT, 'public');
    file = path.join(publicDir, pathname === '/' ? 'index.html' : pathname);
    if (!file.startsWith(publicDir + path.sep)) return sendJson(res, 404, { error: 'not found' });
  }
  fs.readFile(file, (err, data) => {
    if (err) return sendJson(res, 404, { error: 'not found' });
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(data);
  });
}

// client: anything with decide(), mode and model. logFile: jsonl path or null.
export function createApp({ client, maxCalls = 1500, logFile = null }) {
  const capped = withCallCap(client, maxCalls);
  const log = (entry) => {
    if (!logFile) return;
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
  };
  const config = () => ({ mode: capped.mode, model: capped.model, calls: capped.calls, maxCalls });

  return http.createServer(async (req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && pathname === '/api/config') return sendJson(res, 200, config());

    if (req.method === 'POST' && pathname === '/api/decide') {
      let request;
      try {
        request = await readJson(req);
        if (!request?.questions || typeof request.questions !== 'object') {
          throw Object.assign(new Error('missing questions'), { status: 400 });
        }
      } catch (e) {
        return sendJson(res, e.status ?? 400, { error: e.message });
      }
      try {
        const { raw, ...result } = await capped.decide(request);
        log({ request, result, raw });
        return sendJson(res, 200, { ...result, ...config() });
      } catch (e) {
        log({ request, error: e.message });
        return sendJson(res, e.code === 'CALL_CAP' ? 429 : 502, { error: e.message, ...config() });
      }
    }

    if (req.method === 'GET') return serveStatic(res, pathname);
    sendJson(res, 405, { error: 'method not allowed' });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.loadEnvFile(path.join(ROOT, '.env'));
  } catch {
    // no .env: mock mode unless the environment says otherwise
  }
  const client = createClientFromEnv();
  const maxCalls = Number(process.env.MAX_CALLS ?? 1500);
  const logFile = path.join(ROOT, 'runs', `${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
  const port = Number(process.env.PORT ?? 5173);
  createApp({ client, maxCalls, logFile }).listen(port, () => {
    console.log(`jev-snake: http://localhost:${port}  [${client.mode} · ${client.model} · cap ${maxCalls} calls]`);
    console.log(`call log: ${path.relative(ROOT, logFile)}`);
  });
}
