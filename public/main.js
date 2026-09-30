// Game loop and rendering. The engine and players are the same modules the
// benchmark uses; the only browser-specific part is that the Jev player's
// decide() goes through the server's proxy.

import { createGame, step } from '/src/snake.js';
import { createRandomPlayer, createHeuristicPlayer, createJevPlayer } from '/src/players.js';

const $ = (id) => document.getElementById(id);
const canvas = $('canvas');
const ctx = canvas.getContext('2d');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function decideViaServer(request) {
  const res = await fetch('/api/decide', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  });
  const body = await res.json();
  if (body.maxCalls !== undefined) showCalls(body);
  if (!res.ok) throw new Error(body.error ?? `server error ${res.status}`);
  return body;
}

const players = {
  jev: () => createJevPlayer(decideViaServer),
  heuristic: () => createHeuristicPlayer(),
  random: () => createRandomPlayer(),
};

let game;
let player;
let pending = null; // decision made but not yet played: drawn as a heatmap
let last = null; // most recent decision, shown in the panel
let stats;
let running = false;
let busy = false;
let generation = 0; // bumped on reset so a stale in-flight decision is dropped

function reset() {
  generation++;
  running = false;
  const size = Number($('size').value);
  game = createGame({ width: size, height: size, seed: Number($('seed').value) || 1 });
  player = players[$('player').value]();
  pending = null;
  last = null;
  stats = { calls: 0, latency: 0, fallbacks: 0 };
  $('history').replaceChildren();
  render();
}

async function tick() {
  if (busy || !game.alive) return false;
  busy = true;
  const mine = generation;
  try {
    const d = await player.choose(game);
    if (mine !== generation) return false;
    if (d.source === 'jev') {
      stats.calls++;
      stats.latency += d.latencyMs;
    }
    if (d.source === 'fallback') stats.fallbacks++;
    pending = last = d;
    logDecision(game.steps + 1, d);
    render();
    await sleep(Number($('delay').value));
    if (mine !== generation) return false;
    game = step(game, d.dir);
    pending = null;
    render();
    return true;
  } finally {
    busy = false;
  }
}

async function run() {
  running = true;
  render();
  while (running && game.alive) {
    if (!(await tick())) await sleep(30);
  }
  running = false;
  render();
}

// ---- rendering ----

function drawBoard() {
  const cell = canvas.width / game.width;
  ctx.fillStyle = '#12161b';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = '#1c222a';
  ctx.lineWidth = 1;
  for (let i = 1; i < game.width; i++) {
    ctx.beginPath();
    ctx.moveTo(i * cell, 0);
    ctx.lineTo(i * cell, canvas.height);
    ctx.moveTo(0, i * cell);
    ctx.lineTo(canvas.width, i * cell);
    ctx.stroke();
  }

  if (game.food) {
    ctx.fillStyle = '#ef6a6a';
    ctx.beginPath();
    ctx.arc((game.food.x + 0.5) * cell, (game.food.y + 0.5) * cell, cell * 0.3, 0, Math.PI * 2);
    ctx.fill();
  }

  game.snake.forEach((c, i) => {
    const t = i / Math.max(1, game.snake.length - 1);
    ctx.fillStyle = i === 0 ? '#9af0b4' : `rgb(${Math.round(70 - 30 * t)}, ${Math.round(190 - 80 * t)}, ${Math.round(110 - 40 * t)})`;
    ctx.beginPath();
    ctx.roundRect(c.x * cell + 2, c.y * cell + 2, cell - 4, cell - 4, 6);
    ctx.fill();
  });

  // Candidate cells, lit by the probability the player gave each move.
  if (pending && $('heatmap').checked) {
    ctx.font = `600 ${Math.round(cell * 0.3)}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const o of pending.options) {
      if (o.fatal) continue;
      const p = pending.probabilities[o.id] ?? 0;
      const chosen = o.dir === pending.dir;
      ctx.fillStyle = `rgba(242, 184, 75, ${0.12 + 0.6 * p})`;
      ctx.beginPath();
      ctx.roundRect(o.cell.x * cell + 2, o.cell.y * cell + 2, cell - 4, cell - 4, 6);
      ctx.fill();
      if (chosen) {
        ctx.strokeStyle = '#f2b84b';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      ctx.fillStyle = '#fff';
      ctx.fillText(`${Math.round(p * 100)}`, (o.cell.x + 0.5) * cell, (o.cell.y + 0.5) * cell);
    }
  }
}

const SOURCE_LABEL = {
  jev: 'answered by the model',
  heuristic: 'heuristic bot',
  random: 'random pick',
  forced: 'only one safe move, no call made',
  'no-safe-move': 'no safe move left',
  fallback: 'model unavailable, heuristic played',
};

const VIA = {
  jev: 'model',
  heuristic: 'heuristic',
  random: 'random',
  forced: 'forced',
  'no-safe-move': 'no safe move',
  fallback: 'fallback',
};

// One row per move in the scrolling history table, newest at the bottom.
function logDecision(stepNumber, d) {
  const scroller = $('historyScroll');
  const pinned = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 24;
  const tr = document.createElement('tr');
  const cell = (text, className) => {
    const td = document.createElement('td');
    td.textContent = text;
    if (className) td.className = className;
    tr.append(td);
  };

  cell(stepNumber);
  for (const dir of ['up', 'down', 'left', 'right']) {
    const o = d.options.find((x) => x.dir === dir);
    const p = d.probabilities[dir];
    if (!o) cell('–', 'na'); // a reversal: never on the menu
    else if (o.fatal && dir !== d.dir) cell('✕', 'na');
    else cell(p === undefined ? '' : `${Math.round(p * 100)}%`, dir === d.dir ? 'picked' : '');
  }
  cell(d.dir, 'choice');
  cell(d.confidence == null ? '' : `${Math.round(d.confidence * 100)}%`);
  cell(VIA[d.source] ?? d.source, d.source === 'fallback' ? 'warn' : 'via');

  $('history').append(tr);
  if (pinned) scroller.scrollTop = scroller.scrollHeight;
}

function renderDecision() {
  const list = $('options');
  list.replaceChildren();
  $('source').textContent = last ? `· ${SOURCE_LABEL[last.source] ?? last.source}` : '';
  $('error').hidden = !last?.error;
  $('error').textContent = last?.error ? `Fallback: ${last.error}` : '';
  if (!last) return;

  const sorted = [...last.options].sort(
    (a, b) => (last.probabilities[b.id] ?? -1) - (last.probabilities[a.id] ?? -1),
  );
  for (const o of sorted) {
    const p = last.probabilities[o.id];
    const li = document.createElement('li');
    if (o.dir === last.dir) li.classList.add('chosen');
    if (o.fatal) li.classList.add('fatal');

    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.style.width = `${Math.round((p ?? 0) * 100)}%`;

    const row = document.createElement('div');
    row.className = 'row';
    const name = document.createElement('span');
    name.textContent = o.dir;
    const pct = document.createElement('span');
    pct.className = 'pct';
    pct.textContent = o.fatal ? 'not offered' : p === undefined ? '' : `${(p * 100).toFixed(0)}%`;
    row.append(name, pct);

    const text = document.createElement('div');
    text.className = 'text';
    text.textContent = o.text;

    li.append(bar, row, text);
    list.append(li);
  }
}

function render() {
  drawBoard();
  renderDecision();
  $('score').textContent = game.score;
  $('length').textContent = game.snake.length;
  $('steps').textContent = game.steps;
  $('gameCalls').textContent = stats.calls;
  $('latency').textContent = stats.calls ? `${Math.round(stats.latency / stats.calls)} ms` : '–';
  $('fallbacks').textContent = stats.fallbacks;

  const status = $('status');
  status.className = 'status';
  if (game.alive) status.textContent = running ? 'Playing…' : 'Paused';
  else if (game.deathReason === 'won') {
    status.textContent = 'Board filled. The snake won.';
    status.classList.add('won');
  } else {
    const why = { wall: 'hit the wall', self: 'ran into itself', starved: 'went too long without eating' };
    status.textContent = `Game over: ${why[game.deathReason] ?? game.deathReason}.`;
    status.classList.add('dead');
  }

  $('play').textContent = running ? 'Pause' : 'Play';
  $('play').disabled = !game.alive;
  $('stepBtn').disabled = running || !game.alive;
}

function showCalls({ calls, maxCalls }) {
  $('calls').textContent = `${calls} / ${maxCalls} calls used this session`;
}

async function loadConfig() {
  const badge = $('mode');
  try {
    const config = await (await fetch('/api/config')).json();
    badge.textContent = config.mode === 'live' ? `LIVE · ${config.model}` : 'MOCK MODEL';
    badge.classList.add(config.mode);
    showCalls(config);
  } catch {
    badge.textContent = 'server unreachable';
  }
}

// ---- wiring ----

$('play').addEventListener('click', () => {
  if (running) {
    running = false;
    render();
  } else run();
});
$('stepBtn').addEventListener('click', () => tick());
$('reset').addEventListener('click', reset);
$('player').addEventListener('change', reset);
$('size').addEventListener('change', reset);
$('seed').addEventListener('change', reset);
$('heatmap').addEventListener('change', () => {
  try {
    localStorage.setItem('heatmap', $('heatmap').checked ? 'on' : 'off');
  } catch {
    // storage unavailable: the setting just won't persist
  }
  render();
});
$('delay').addEventListener('input', () => {
  $('delayLabel').textContent = `${$('delay').value} ms`;
});

try {
  $('heatmap').checked = localStorage.getItem('heatmap') !== 'off';
} catch {
  // keep the default
}
reset();
loadConfig();
