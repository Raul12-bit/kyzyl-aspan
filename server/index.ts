/**
 * Kyzyl Aspan — minimal backend (`pnpm server`).
 *
 *   GET  /api/health              → { ok, gemini: { configured, model } }
 *   POST /api/ai/analyze          → { source: 'gemini', model, text } | { source: 'rules', findings, reason? }
 *   GET  /api/ai/status           → the three AIs (registry), where each runs, Gemini / HELIOS availability
 *   POST /api/ai/ground/forecast  → AI #3: weather overlay + fire-spread forecast for one ignition point
 *   GET  /api/ai/ground/delays    → AI #3: age of each satellite stream's data on arrival (?storm=&kp=)
 *   GET  /v1/*                    → proxied to the HELIOS data API (HELIOS_API_URL, default http://127.0.0.1:8000/v1)
 *
 * Node built-ins only. Its one job today is to keep the Gemini key off the client and to put a
 * validated, rate-limited, size-limited door in front of the model. With SERVE_STATIC (default on)
 * it also serves the production build from dist/, so `pnpm build && pnpm server` is a full deployment.
 * Fire data itself is still served by the static mock files; see PROGRESS.md for the data API plan.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { forecastSpread, syntheticWeather, trackDelays } from '../src/domain/ai/ground';
import { AI_FLOWS, AI_SYSTEMS } from '../src/domain/ai/registry';
import { STATIONS } from '../src/domain/downlink';
import { ruleFindings, type AreaSummary, type Finding } from '../src/domain/summary';
import { config } from './config';
import { analyzeWithGemini, GeminiError } from './gemini';
import { parseAnalyzeRequest, parseGroundRequest } from './validate';

/* ------------------------------------------------------------------ HELIOS data API (Python) */

/** HELIOS context for an area (AI #3 forecast, Fire DNA, blind spots, alerts). Null if the API is down. */
async function heliosContext(summary: AreaSummary): Promise<Record<string, unknown> | null> {
  const params = new URLSearchParams({ bbox: summary.area.bbox.join(',') });
  if (summary.area.iso2) params.set('region', summary.area.iso2);
  try {
    const res = await fetch(`${config.heliosUrl}/helios/context?${params}`, { signal: AbortSignal.timeout(config.heliosTimeoutMs) });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Rule-based findings + the HELIOS forecast line (right after the risk level), when available. */
function findingsWithHelios(summary: AreaSummary, ctx: Record<string, unknown> | null): Finding[] {
  const out = ruleFindings(summary);
  const f = (ctx?.forecast as { by_horizon?: Record<string, { max: number; mean: number; climatology_mean: number }> } | undefined)?.by_horizon?.['1'];
  if (f && Number.isFinite(f.max)) out.splice(1, 0, { kind: 'forecast', max: f.max, mean: f.mean, typical: f.climatology_mean });
  return out;
}

/** Same-origin access to the HELIOS data API in production (`pnpm build && pnpm start`). GET only. */
async function proxyHelios(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== 'GET') {
    send(res, 405, { error: 'Method not allowed' }, { allow: 'GET' });
    return;
  }
  try {
    const upstream = await fetch(`${new URL(config.heliosUrl).origin}${req.url ?? '/v1/'}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    });
    const body = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(upstream.status, {
      'content-type': upstream.headers.get('content-type') ?? 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    res.end(body);
  } catch {
    send(res, 502, { error: 'HELIOS data API is not reachable' });
  }
}

const MAX_BODY = 32 * 1024;

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  res.end(json);
}

function cors(req: IncomingMessage, res: ServerResponse) {
  const origin = req.headers.origin;
  if (origin && config.allowedOrigins.includes(origin)) {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('vary', 'Origin');
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type');
    res.setHeader('access-control-max-age', '600');
  }
}

/* ------------------------------------------------------------------ rate limit (fixed window per IP) */

const hits = new Map<string, { count: number; reset: number }>();
/** Seconds to wait when `key` (endpoint + IP) went over `limit` requests this minute, else null. */
function rateLimited(key: string, limit: number): number | null {
  const now = Date.now();
  const entry = hits.get(key);
  if (!entry || entry.reset <= now) {
    hits.set(key, { count: 1, reset: now + 60_000 });
    return null;
  }
  entry.count += 1;
  return entry.count > limit ? Math.ceil((entry.reset - now) / 1000) : null;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of hits) if (e.reset <= now) hits.delete(ip);
}, 60_000).unref();

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > MAX_BODY) {
        // Stop buffering and answer 413; the socket is closed once the answer is out (see sendBodyError).
        tooLarge = true;
        chunks.length = 0;
        reject(Object.assign(new Error('Payload too large'), { status: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) return;
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('Invalid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Answers a body that could not be read. A 413 is sent with "Connection: close" and the socket is closed
 * after the answer has been written, so the client gets a clean status instead of a reset connection.
 */
function sendBodyError(req: IncomingMessage, res: ServerResponse, err: unknown) {
  const status = (err as { status?: number }).status ?? 400;
  if (status === 413) {
    res.once('finish', () => req.socket.destroy());
    send(res, 413, { error: 'Payload too large' }, { connection: 'close' });
    return;
  }
  send(res, status, { error: (err as Error).message });
}

async function analyze(req: IncomingMessage, res: ServerResponse) {
  if (!(req.headers['content-type'] ?? '').includes('application/json')) {
    send(res, 415, { error: 'Content-Type must be application/json' });
    return;
  }
  const ip = req.socket.remoteAddress ?? 'unknown';
  const retry = rateLimited(`analyze:${ip}`, config.rateLimitPerMinute);
  if (retry !== null) {
    send(res, 429, { error: 'Too many requests' }, { 'retry-after': String(retry) });
    return;
  }
  let body: unknown;
  try {
    body = await readJson(req);
  } catch (err) {
    sendBodyError(req, res, err);
    return;
  }
  const parsed = parseAnalyzeRequest(body);
  if (!parsed.ok) {
    send(res, 422, { error: parsed.error });
    return;
  }
  const { summary, locale } = parsed.value;
  const helios = await heliosContext(summary);
  if (!config.geminiKey) {
    send(res, 200, { source: 'rules', findings: findingsWithHelios(summary, helios), reason: 'not-configured' });
    return;
  }
  try {
    const out = await analyzeWithGemini(summary, locale, helios);
    send(res, 200, { source: 'gemini', model: out.model, text: out.text });
  } catch (err) {
    const status = err instanceof GeminiError ? err.status : null;
    console.warn(`[api] gemini failed (${status ?? 'network'}): ${(err as Error).message}`);
    // Degrade, don't fail: the visitor still gets the transparent rule-based summary.
    send(res, 200, { source: 'rules', findings: findingsWithHelios(summary, helios), reason: 'model-error' });
  }
}

/* ------------------------------------------------------------------ AI #3 on the ground */

/** HELIOS reachability, cached for a minute so /api/ai/status stays fast. */
let heliosProbe: { at: number; ok: boolean } | null = null;
async function heliosReachable(): Promise<boolean> {
  if (heliosProbe && Date.now() - heliosProbe.at < 60_000) return heliosProbe.ok;
  let ok = false;
  try {
    const res = await fetch(`${config.heliosUrl}/helios/status`, { signal: AbortSignal.timeout(1500) });
    ok = res.ok;
  } catch {
    ok = false;
  }
  heliosProbe = { at: Date.now(), ok };
  return ok;
}

async function aiStatus(res: ServerResponse) {
  send(res, 200, {
    ok: true,
    systems: AI_SYSTEMS,
    flows: AI_FLOWS,
    gemini: { configured: Boolean(config.geminiKey), model: config.geminiModel },
    helios: { reachable: await heliosReachable() },
  });
}

async function groundForecast(req: IncomingMessage, res: ServerResponse) {
  if (!(req.headers['content-type'] ?? '').includes('application/json')) {
    send(res, 415, { error: 'Content-Type must be application/json' });
    return;
  }
  const retry = rateLimited(`ground:${req.socket.remoteAddress ?? 'unknown'}`, config.groundRateLimitPerMinute);
  if (retry !== null) {
    send(res, 429, { error: 'Too many requests' }, { 'retry-after': String(retry) });
    return;
  }
  let body: unknown;
  try {
    body = await readJson(req);
  } catch (err) {
    sendBodyError(req, res, err);
    return;
  }
  const parsed = parseGroundRequest(body);
  if (!parsed.ok) {
    send(res, 422, { error: parsed.error });
    return;
  }
  const q = parsed.value;
  const t0 = performance.now();
  // The synthetic weather overlay at the point, with the caller's overrides on top.
  const weather = { ...syntheticWeather(q.lat, q.lng), ...q.weather };
  const forecast = forecastSpread({ lat: q.lat, lng: q.lng }, weather, {
    fuel: q.fuel,
    hours: q.hours,
    localHour: q.localHour ?? undefined,
  });
  const computedMs = Math.round((performance.now() - t0) * 100) / 100;
  send(res, 200, { source: 'ground-server', computedMs, weather, forecast });
}

function groundDelays(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const storm = url.searchParams.get('storm') || null;
  const kpRaw = url.searchParams.get('kp');
  const kp = kpRaw === null ? 2 : Number(kpRaw);
  if (storm !== null && !STATIONS.some((s) => s.id === storm)) {
    send(res, 422, { error: 'Unknown station' });
    return;
  }
  if (!Number.isFinite(kp) || kp < 0 || kp > 9) {
    send(res, 422, { error: 'kp must be within 0…9' });
    return;
  }
  const t0 = performance.now();
  const streams = trackDelays({ stormStation: storm, kp });
  send(res, 200, { source: 'ground-server', computedMs: Math.round(performance.now() - t0), streams });
}

/* ------------------------------------------------------------------ static files (production build) */

const DIST = resolve(config.root, 'dist');
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

function serveStatic(req: IncomingMessage, res: ServerResponse) {
  const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]!);
  const safe = normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  let file = join(DIST, safe);
  if (file !== DIST && !file.startsWith(DIST + sep)) {
    send(res, 403, { error: 'Forbidden' });
    return;
  }
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(DIST, 'index.html'); // SPA fallback
  if (!existsSync(file)) {
    send(res, 404, { error: 'Not found — run "pnpm build" first, or use the Vite dev server.' });
    return;
  }
  const ext = extname(file);
  res.writeHead(200, {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'cache-control': file.includes(`${join('dist', 'assets')}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
    'x-content-type-options': 'nosniff',
  });
  createReadStream(file).pipe(res);
}

const server = createServer((req, res) => {
  cors(req, res);
  const path = (req.url ?? '/').split('?')[0];
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  if (path === '/api/health' && req.method === 'GET') {
    send(res, 200, { ok: true, gemini: { configured: Boolean(config.geminiKey), model: config.geminiModel } });
    return;
  }
  if (path === '/api/ai/analyze') {
    if (req.method !== 'POST') {
      send(res, 405, { error: 'Method not allowed' }, { allow: 'POST' });
      return;
    }
    analyze(req, res).catch((err: unknown) => {
      console.error('[api] unexpected error', err);
      if (!res.headersSent) send(res, 500, { error: 'Internal error' });
    });
    return;
  }
  if (path === '/api/ai/status' && req.method === 'GET') {
    void aiStatus(res);
    return;
  }
  if (path === '/api/ai/ground/forecast') {
    if (req.method !== 'POST') {
      send(res, 405, { error: 'Method not allowed' }, { allow: 'POST' });
      return;
    }
    groundForecast(req, res).catch((err: unknown) => {
      console.error('[api] ground forecast failed', err);
      if (!res.headersSent) send(res, 500, { error: 'Internal error' });
    });
    return;
  }
  if (path === '/api/ai/ground/delays' && req.method === 'GET') {
    try {
      groundDelays(req, res);
    } catch (err) {
      console.error('[api] ground delays failed', err);
      if (!res.headersSent) send(res, 500, { error: 'Internal error' });
    }
    return;
  }
  if (path?.startsWith('/v1/')) {
    void proxyHelios(req, res);
    return;
  }
  if (path?.startsWith('/api/')) {
    send(res, 404, { error: 'Unknown endpoint' });
    return;
  }
  if (config.serveStatic && (req.method === 'GET' || req.method === 'HEAD')) {
    serveStatic(req, res);
    return;
  }
  send(res, 404, { error: 'Not found' });
});

server.listen(config.port, config.host, () => {
  console.warn(
    `Kyzyl Aspan API on http://${config.host}:${config.port} · Gemini ${config.geminiKey ? `on (${config.geminiModel})` : 'off → rule-based summaries'}`,
  );
});
