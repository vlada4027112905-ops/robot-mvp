// HTTP-сервис по спецификации арены «Завод роботов» (v1) + веб-интерфейс.
// Без внешних зависимостей: node server.mjs  (PORT=4001, TOKEN=… — необязательно)

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Strategy } from './src/strategy.mjs';
import { NaiveStrategy, LearningStrategy, OracleStrategy } from './src/baselines.mjs';
import { World } from './src/engine.mjs';
import { Recorder } from './src/recorder.mjs';

const PORT = Number(process.env.PORT || 4001);
const TOKEN = process.env.TOKEN || '';
const MAX_RUNS = 40;
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const VERSION = '1.0.0';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-private-network': 'true',
};

/** runId -> { strategy, rec, seqCache: Map<seq, response> } */
const runs = new Map();

function evict() {
  if (runs.size <= MAX_RUNS) return;
  const sorted = [...runs.entries()].sort((a, b) => a[1].rec.created - b[1].rec.created);
  for (const [id, r] of sorted) {
    if (runs.size <= MAX_RUNS) break;
    if (r.rec.finished || Date.now() - r.rec.created > 3600e3) runs.delete(id);
  }
}

function send(res, code, body, headers = {}) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', ...CORS, ...headers });
  res.end(JSON.stringify(body));
}
const fail = (res, code, errCode, message) => send(res, code, { error: { code: errCode, message } });

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 16e6) reject(new Error('body too large'));
    });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}

/** Безопасный ответ, если стратегия вдруг упала: принять поставку, если есть место. */
function safeResponse(body) {
  const commands = [];
  const ev = body?.event;
  if (ev?.type === 'supply' && ev.item?.id && (body.state?.storage?.free ?? 0) > 0) commands.push({ cmd: 'accept', itemId: ev.item.id });
  return { commands };
}

// ---------- протокол арены ----------

function handleStart(runId, body, source = 'arena', strategy = null) {
  const s = strategy || new Strategy();
  s.start(body);
  const rec = new Recorder(runId, body, source);
  runs.set(runId, { strategy: s, rec, seqCache: new Map() });
  evict();
  return { ok: true };
}

function handleEvent(runId, body, seqHeader) {
  const run = runs.get(runId);
  if (!run) return { status: 404, body: { error: { code: 'unknown_run', message: `run ${runId} не начат (нет start)` } } };
  const seq = Number.isFinite(body?.seq) ? body.seq : Number(seqHeader);
  if (Number.isFinite(seq) && run.seqCache.has(seq)) return { status: 200, body: run.seqCache.get(seq) };
  const t0 = performance.now();
  let resp;
  let error = null;
  try {
    resp = run.strategy.event(body);
    if (!resp || !Array.isArray(resp.commands)) throw new Error('strategy returned no commands');
  } catch (e) {
    error = e;
    console.error(`[${runId}] ошибка стратегии на seq=${seq}:`, e);
    resp = safeResponse(body);
  }
  const ms = performance.now() - t0;
  try {
    run.rec.onEvent(body, resp, ms, error);
  } catch (e) {
    console.error('recorder', e);
  }
  if (Number.isFinite(seq)) {
    run.seqCache.set(seq, resp);
    if (run.seqCache.size > 8) run.seqCache.delete(run.seqCache.keys().next().value);
  }
  return { status: 200, body: resp };
}

function handleFinish(runId, body) {
  const run = runs.get(runId);
  if (run) {
    run.strategy.finish(body || {});
    run.rec.finish(body || {});
    // Между прогонами данные о покупателях не переносятся: модель живёт только в объекте прогона.
  }
  return { ok: true };
}

// ---------- локальная симуляция для интерфейса ----------

const STRATS = {
  bayes: () => new Strategy(),
  learning: () => new LearningStrategy(),
  naive: () => new NaiveStrategy(),
  oracle: (w) => new OracleStrategy(w.hidden),
};

async function simulate({ seed = 1, strategy = 'bayes', horizon, delayMs = 4 }) {
  const w = new World(Number(seed) || 1, { mode: 'practice', params: horizon ? { horizon: Number(horizon) } : {} });
  const make = STRATS[strategy] || STRATS.bayes;
  const strat = make(w);
  const runId = `sim-${strategy}-${seed}-${Date.now().toString(36)}`;
  w.runId = runId;
  let lastT = -1;
  const wrapper = {
    start: (msg) => handleStart(runId, msg, 'local', strat),
    event: async (req) => {
      if (req.t !== lastT) {
        lastT = req.t;
        if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      }
      const out = handleEvent(runId, req);
      return out.body;
    },
    finish: (msg) => handleFinish(runId, msg),
  };
  w.run(wrapper)
    .then((r) => {
      const run = runs.get(runId);
      if (run) run.rec.world = { seed: w.seed, strategy, stats: r.stats };
    })
    .catch((e) => console.error('simulate', e));
  return { runId };
}

function runView(runId) {
  const run = runs.get(runId);
  if (!run) return null;
  const s = run.strategy;
  return run.rec.full({
    beliefs: typeof s.beliefs === 'function' && s.models ? s.beliefs() : [],
    buyerSummary: typeof s.buyerSummary === 'function' && s.models ? s.buyerSummary() : [],
    world: run.rec.world || null,
  });
}

// ---------- статика ----------

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
async function serveStatic(res, rel) {
  const file = path.join(ROOT, 'public', path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!file.startsWith(path.join(ROOT, 'public'))) return fail(res, 403, 'forbidden', 'нет доступа');
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(data);
  } catch {
    fail(res, 404, 'not_found', 'нет такого файла');
  }
}

// ---------- маршрутизация ----------

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS);
      return res.end();
    }
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;

    if (p === '/v1/health') return send(res, 200, { status: 'ok' });
    if (p === '/v1/info') return send(res, 200, { name: 'bayes-factory', version: VERSION, project: 'factory', specVersion: ['v1'] });

    const m = p.match(/^\/v1\/runs\/([^/]+)\/(start|event|finish|debug)$/);
    if (m) {
      if (TOKEN && req.headers.authorization !== `Bearer ${TOKEN}`) return fail(res, 401, 'unauthorized', 'неверный токен');
      const runId = decodeURIComponent(m[1]);
      const action = m[2];
      if (action === 'debug') {
        const run = runs.get(runId);
        if (!run) return fail(res, 404, 'unknown_run', 'нет такого прогона');
        return send(res, 200, { beliefs: run.strategy.beliefs().map((b) => ({ buyerId: b.buyerId, color: b.color, handles: b.handles, low: b.low, high: b.high, note: `среднее ${b.mean}` })) });
      }
      if (req.method !== 'POST') return fail(res, 405, 'method_not_allowed', 'нужен POST');
      let body;
      try {
        const raw = await readBody(req);
        body = raw ? JSON.parse(raw) : {};
      } catch {
        return fail(res, 400, 'bad_json', 'тело не является JSON');
      }
      if (action === 'start') {
        if (!body || typeof body !== 'object' || !Number.isFinite(body.horizon)) return fail(res, 400, 'bad_start', 'в start нет параметров мира');
        return send(res, 200, handleStart(runId, body));
      }
      if (action === 'event') {
        if (!body || typeof body !== 'object' || !body.event || !body.state) return fail(res, 400, 'bad_event', 'в событии нет event/state');
        const out = handleEvent(runId, body, req.headers['x-arena-seq']);
        return send(res, out.status, out.body);
      }
      return send(res, 200, handleFinish(runId, body));
    }

    // интерфейс
    if (p === '/ui/runs') return send(res, 200, [...runs.values()].map((r) => r.rec.summary()).sort((a, b) => b.created - a.created));
    const rv = p.match(/^\/ui\/runs\/([^/]+)$/);
    if (rv) {
      const v = runView(decodeURIComponent(rv[1]));
      return v ? send(res, 200, v) : fail(res, 404, 'unknown_run', 'нет такого прогона');
    }
    if (p === '/ui/simulate' && req.method === 'POST') {
      let body = {};
      try {
        body = JSON.parse((await readBody(req)) || '{}');
      } catch {}
      return send(res, 200, await simulate(body));
    }
    if (p === '/favicon.ico') {
      res.writeHead(204);
      return res.end();
    }
    if (p === '/' || p === '/index.html') return serveStatic(res, 'index.html');
    if (req.method === 'GET' && /^\/[\w.-]+\.(js|css|svg)$/.test(p)) return serveStatic(res, p);
    return fail(res, 404, 'not_found', `нет маршрута ${p}`);
  } catch (e) {
    console.error(e);
    return fail(res, 500, 'internal', String(e?.message || e));
  }
});

server.keepAliveTimeout = 65000;
server.listen(PORT, () => {
  console.log(`Завод роботов: API и интерфейс на http://localhost:${PORT}  (токен ${TOKEN ? 'включён' : 'не задан'})`);
});
