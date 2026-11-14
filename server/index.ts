/**
 * Kyzyl Aspan — minimal backend (`pnpm server`).
 *
 *   GET  /api/health       → { ok, gemini: { configured, model } }
 *   POST /api/ai/analyze   → { source: 'gemini', model, text } | { source: 'rules', findings, reason? }
 *   GET  /v1/*             → proxied to the HELIOS data API (HELIOS_API_URL, default http://127.0.0.1:8000/v1)
 *
 * Node built-ins only. Its one job today is to keep the Gemini key off the client and to put a
 * validated, rate-limited, size-limited door in front of the model. With SERVE_STATIC (default on)
 * it also serves the production build from dist/, so `pnpm build && pnpm server` is a full deployment.
 * Fire data itself is still served by the static mock files; see PROGRESS.md for the data API plan.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { ruleFindings, type AreaSummary, type Finding } from '../src/domain/summary';
import { config } from './config';
import { analyzeWithGemini, GeminiError } from './gemini';
import { parseAnalyzeRequest } from './validate';

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
function rateLimited(ip: string): number | null {
  const now = Date.now();
  const entry = hits.get(ip);
  if (!entry || entry.reset <= now) {
    hits.set(ip, { count: 1, reset: now + 60_000 });
    return null;
  }
  entry.count += 1;
  return entry.count > config.rateLimitPerMinute ? Math.ceil((entry.reset - now) / 1000) : null;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of hits) if (e.reset <= now) hits.delete(ip);
}, 60_000).unref();

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('Payload too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('Invalid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

async function analyze(req: IncomingMessage, res: ServerResponse) {
  if (!(req.headers['content-type'] ?? '').includes('application/json')) {
    send(res, 415, { error: 'Content-Type must be application/json' });
    return;
  }
  const ip = req.socket.remoteAddress ?? 'unknown';
  const retry = rateLimited(ip);
  if (retry !== null) {
    send(res, 429, { error: 'Too many requests' }, { 'retry-after': String(retry) });
    return;
  }
  let body: unknown;
  try {
    body = await readJson(req);
  } catch (err) {
    send(res, (err as { status?: number }).status ?? 400, { error: (err as Error).message });
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
