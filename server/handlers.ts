/**
 * The /api/* endpoints of Kyzyl Aspan as one router, shared by the local server (server/index.ts) and the
 * Vercel functions (scripts/build-vercel.mjs bundles this file into each function of .vercel/output).
 *
 *   GET  /api/health              → { ok, gemini: { configured, model } }
 *   POST /api/ai/analyze          → { source: 'gemini', mode, period, model, text } | { source: 'rules', mode, period, findings, reason? }
 *                                   mode 'demo' (synthetic numbers: explained, never forecast) or 'risk' (real data)
 *   GET  /api/ai/status           → the three AIs (registry), where each runs, Gemini / HELIOS availability
 *   POST /api/ai/ground/forecast  → AI #3: weather overlay + fire-spread forecast for one ignition point
 *   GET  /api/ai/ground/delays    → AI #3: age of each satellite stream's data on arrival (?storm=&kp=)
 *   GET  /api/live/fires|tle|weather → real-time NASA FIRMS hot spots, CelesTrak orbits, Open-Meteo wind (server/live.ts)
 *   POST /api/ai/chat             → the in-app AI guide: { messages, locale, page?, facts? } → { source, text } (server/assistant.ts)
 *   POST /api/ai/link/predict     → run the trained AI #2 network on a situation set up by the visitor
 *   POST /api/ai/replay           → one real FIRMS fire played through AI #1 → AI #2 → AI #3 (server/replay.ts)
 *
 * Node built-ins only. Its one job is to keep the Gemini key off the client and to put a validated,
 * rate-limited, size-limited door in front of the model.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { forecastSpread, syntheticWeather, trackDelays } from '../src/domain/ai/ground';
import { AI_FLOWS, AI_SYSTEMS } from '../src/domain/ai/registry';
import { STATIONS } from '../src/domain/downlink';
import { ruleFindings, type AreaSummary, type Finding } from '../src/domain/summary';
import { answerChat, parseChatRequest, parseLinkProbe, probeLink } from './assistant';
import { parseReplay, replay } from './replay';
import { config } from './config';
import { handleLive } from './live';
import { analyzeWithGemini, GeminiError, type BriefMode } from './gemini';
import { parseAnalyzeRequest, parseGroundRequest } from './validate';

const MAX_BODY = 32 * 1024;

/**
 * Where a HELIOS data API can be reached. Locally it defaults to http://127.0.0.1:8000; on Vercel there is
 * none unless HELIOS_API_URL is set, so nothing waits for a connection that cannot succeed.
 */
const heliosEnabled = Boolean(process.env.HELIOS_API_URL) || !process.env.VERCEL;

export function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  res.end(json);
}

export function cors(req: IncomingMessage, res: ServerResponse) {
  const origin = req.headers.origin;
  if (origin && config.allowedOrigins.includes(origin)) {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('vary', 'Origin');
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type');
    res.setHeader('access-control-max-age', '600');
  }
}

/** Client address for rate limiting: Vercel's edge sets x-forwarded-for; locally the socket is the client. */
function clientIp(req: IncomingMessage): string {
  if (process.env.VERCEL) {
    const fwd = req.headers['x-forwarded-for'];
    const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

/* ------------------------------------------------------------------ HELIOS data API (Python) */

/** HELIOS context for an area (AI #3 forecast, Fire DNA, blind spots, alerts). Null if the API is down. */
async function heliosContext(summary: AreaSummary): Promise<Record<string, unknown> | null> {
  if (!heliosEnabled) return null;
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
function findingsWithHelios(summary: AreaSummary, ctx: Record<string, unknown> | null, mode: BriefMode): Finding[] {
  const out = ruleFindings(summary, { demo: mode === 'demo' });
  if (mode === 'demo') return out;
  const f = (ctx?.forecast as { by_horizon?: Record<string, { max: number; mean: number; climatology_mean: number }> } | undefined)?.by_horizon?.['1'];
  if (f && Number.isFinite(f.max)) out.splice(1, 0, { kind: 'forecast', max: f.max, mean: f.mean, typical: f.climatology_mean });
  return out;
}

/**
 * Demo or risk brief. Synthetic numbers always get the demo brief; so does any request to a server that has
 * no real fire archive behind it (the Vercel site serves only the demo archive), whatever the request claims.
 */
export async function briefMode(summary: AreaSummary): Promise<BriefMode> {
  if (summary.synthetic) return 'demo';
  return (await probeHelios()).dataReady ? 'risk' : 'demo';
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

function readJson(req: IncomingMessage, maxBody = MAX_BODY): Promise<unknown> {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > maxBody) {
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

/* ------------------------------------------------------------------ endpoints */

async function analyze(req: IncomingMessage, res: ServerResponse) {
  if (!(req.headers['content-type'] ?? '').includes('application/json')) {
    send(res, 415, { error: 'Content-Type must be application/json' });
    return;
  }
  const retry = rateLimited(`analyze:${clientIp(req)}`, config.rateLimitPerMinute);
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
  const mode = await briefMode(summary);
  // The HELIOS forecast is real-data context: never fetched for (or mixed into) a demo brief.
  const helios = mode === 'risk' ? await heliosContext(summary) : null;
  const period = { from: summary.period.from, to: summary.period.to };
  if (!config.geminiKey) {
    send(res, 200, { source: 'rules', mode, period, findings: findingsWithHelios(summary, helios, mode), reason: 'not-configured' });
    return;
  }
  try {
    const out = await analyzeWithGemini(summary, locale, helios, mode);
    send(res, 200, { source: 'gemini', mode, period, model: out.model, text: out.text });
  } catch (err) {
    const status = err instanceof GeminiError ? err.status : null;
    console.warn(`[api] gemini failed (${status ?? 'network'}): ${(err as Error).message}`);
    // Degrade, don't fail: the visitor still gets the transparent rule-based summary.
    send(res, 200, { source: 'rules', mode, period, findings: findingsWithHelios(summary, helios, mode), reason: 'model-error' });
  }
}

/**
 * HELIOS reachability and whether it holds the real fire archive (`data_ready`), cached for a minute so
 * /api/ai/status and the brief stay fast. On Vercel there is no HELIOS data API: both false, no waiting.
 */
let heliosProbe: { at: number; reachable: boolean; dataReady: boolean } | null = null;
async function probeHelios(): Promise<{ reachable: boolean; dataReady: boolean }> {
  if (!heliosEnabled) return { reachable: false, dataReady: false };
  if (heliosProbe && Date.now() - heliosProbe.at < 60_000) return heliosProbe;
  let reachable = false;
  let dataReady = false;
  try {
    const res = await fetch(`${config.heliosUrl}/helios/status`, { signal: AbortSignal.timeout(1500) });
    reachable = res.ok;
    if (res.ok) {
      const body = (await res.json().catch(() => null)) as { data_ready?: unknown } | null;
      // Servers that predate the flag do not send it and count as ready (same rule as the browser's probe).
      dataReady = body !== null && body.data_ready !== false;
    }
  } catch {
    reachable = false;
  }
  heliosProbe = { at: Date.now(), reachable, dataReady };
  return heliosProbe;
}
async function heliosReachable(): Promise<boolean> {
  return (await probeHelios()).reachable;
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
  const retry = rateLimited(`ground:${clientIp(req)}`, config.groundRateLimitPerMinute);
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

/** Reads, validates and rate-limits a JSON POST; null when an answer has already been sent. */
async function jsonBody(
  req: IncomingMessage,
  res: ServerResponse,
  key: string,
  limit: number,
  maxBody = MAX_BODY,
): Promise<unknown | null> {
  if (!(req.headers['content-type'] ?? '').includes('application/json')) {
    send(res, 415, { error: 'Content-Type must be application/json' });
    return null;
  }
  const retry = rateLimited(`${key}:${clientIp(req)}`, limit);
  if (retry !== null) {
    send(res, 429, { error: 'Too many requests' }, { 'retry-after': String(retry) });
    return null;
  }
  try {
    return await readJson(req, maxBody);
  } catch (err) {
    sendBodyError(req, res, err);
    return null;
  }
}

async function replayFire(req: IncomingMessage, res: ServerResponse) {
  // A fire's detections (≤ 400 rows of 12 numbers) need more room than a chat message.
  const body = await jsonBody(req, res, 'replay', config.chatRateLimitPerMinute, 96 * 1024);
  if (body === null) return;
  const parsed = parseReplay(body);
  if (!parsed.ok) {
    send(res, 422, { error: parsed.error });
    return;
  }
  const t0 = performance.now();
  const out = await replay(parsed.value);
  send(res, 200, { source: 'replay', computedMs: Math.round(performance.now() - t0), ...out });
}

async function chat(req: IncomingMessage, res: ServerResponse) {
  const body = await jsonBody(req, res, 'chat', config.chatRateLimitPerMinute);
  if (body === null) return;
  const parsed = parseChatRequest(body);
  if (!parsed.ok) {
    send(res, 422, { error: parsed.error });
    return;
  }
  send(res, 200, await answerChat(parsed.value));
}

async function linkPredict(req: IncomingMessage, res: ServerResponse) {
  const body = await jsonBody(req, res, 'link', config.groundRateLimitPerMinute);
  if (body === null) return;
  const parsed = parseLinkProbe(body);
  if (!parsed.ok) {
    send(res, 422, { error: parsed.error });
    return;
  }
  const t0 = performance.now();
  const out = probeLink(parsed.value);
  send(res, 200, { source: 'ai2-network', computedMs: Math.round((performance.now() - t0) * 1000) / 1000, input: parsed.value, ...out });
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

/* ------------------------------------------------------------------ router */

/** Answers an /api/* request. Returns false when the path is not an API path (static files, /v1, …). */
export function handleApi(req: IncomingMessage, res: ServerResponse): boolean {
  const path = (req.url ?? '/').split('?')[0] ?? '/';
  if (!path.startsWith('/api/')) return false;
  cors(req, res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return true;
  }
  const fail = (label: string) => (err: unknown) => {
    console.error(`[api] ${label}`, err);
    if (!res.headersSent) send(res, 500, { error: 'Internal error' });
  };
  if (path === '/api/health' && req.method === 'GET') {
    send(res, 200, { ok: true, gemini: { configured: Boolean(config.geminiKey), model: config.geminiModel } });
  } else if (path === '/api/ai/analyze') {
    if (req.method !== 'POST') send(res, 405, { error: 'Method not allowed' }, { allow: 'POST' });
    else analyze(req, res).catch(fail('unexpected error'));
  } else if (path === '/api/ai/status' && req.method === 'GET') {
    aiStatus(res).catch(fail('status failed'));
  } else if (path === '/api/ai/ground/forecast') {
    if (req.method !== 'POST') send(res, 405, { error: 'Method not allowed' }, { allow: 'POST' });
    else groundForecast(req, res).catch(fail('ground forecast failed'));
  } else if (path === '/api/ai/ground/delays' && req.method === 'GET') {
    try {
      groundDelays(req, res);
    } catch (err) {
      fail('ground delays failed')(err);
    }
  } else if (path === '/api/ai/chat') {
    if (req.method !== 'POST') send(res, 405, { error: 'Method not allowed' }, { allow: 'POST' });
    else chat(req, res).catch(fail('chat failed'));
  } else if (path === '/api/ai/replay') {
    if (req.method !== 'POST') send(res, 405, { error: 'Method not allowed' }, { allow: 'POST' });
    else replayFire(req, res).catch(fail('replay failed'));
  } else if (path === '/api/ai/link/predict') {
    if (req.method !== 'POST') send(res, 405, { error: 'Method not allowed' }, { allow: 'POST' });
    else linkPredict(req, res).catch(fail('link predict failed'));
  } else if (path.startsWith('/api/live/')) {
    // Cached at the CDN and in memory; the limit only stops a client from hammering NASA through us.
    const retry = rateLimited(`live:${clientIp(req)}`, 120);
    if (retry !== null) send(res, 429, { error: 'Too many requests' }, { 'retry-after': String(retry) });
    else handleLive(req, res, send);
  } else {
    send(res, 404, { error: 'Unknown endpoint' });
  }
  return true;
}
