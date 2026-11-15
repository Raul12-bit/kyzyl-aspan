/**
 * Kyzyl Aspan — minimal backend (`pnpm server`).
 *
 *   /api/*   → server/handlers.ts (Gemini brief, AI status, AI #3 ground endpoints) — the same router the
 *              Vercel functions run (scripts/build-vercel.mjs)
 *   GET /v1/* → proxied to the HELIOS data API (HELIOS_API_URL, default http://127.0.0.1:8000/v1)
 *   anything else → the production build from dist/ (SERVE_STATIC, default on), so
 *              `pnpm build && pnpm server` is a full one-process deployment.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { config } from './config';
import { handleApi, send } from './handlers';
import { handleHeliosLite } from './heliosLite';

/**
 * Same-origin access to the HELIOS data API in production (`pnpm build && pnpm start`). GET only. When the
 * Python API is down, the live satellites (status + constellation) come from the TypeScript port instead.
 */
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
    if (await handleHeliosLite(req, res)) return;
    send(res, 502, { error: 'HELIOS data API is not reachable' });
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
  '.jpg': 'image/jpeg',
  '.glb': 'model/gltf-binary',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
};

/** Client-side routes of src/app/router.tsx — same list as scripts/build-vercel.mjs. */
const SPA_ROUTE = /^\/(?:map|ai|method|mission|how-it-works|analysis)?\/?$/;

/**
 * Same rules as the Vercel deployment: existing files as they are; the app's pages → index.html (200); a
 * missing file (anything with an extension) → 404; any other path → index.html with status 404, so the
 * app shows its "not found" page and crawlers get a real 404.
 */
function serveStatic(req: IncomingMessage, res: ServerResponse) {
  const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]!);
  const safe = normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  let file = join(DIST, safe);
  if (file !== DIST && !file.startsWith(DIST + sep)) {
    send(res, 403, { error: 'Forbidden' });
    return;
  }
  let status = 200;
  if (!existsSync(file) || statSync(file).isDirectory()) {
    if (!SPA_ROUTE.test(urlPath) && /\.[A-Za-z0-9]{1,8}$/.test(urlPath)) {
      send(res, 404, { error: 'Not found' });
      return;
    }
    if (!SPA_ROUTE.test(urlPath)) status = 404;
    file = join(DIST, 'index.html');
  }
  if (!existsSync(file)) {
    send(res, 404, { error: 'Not found — run "pnpm build" first, or use the Vite dev server.' });
    return;
  }
  const ext = extname(file);
  res.writeHead(status, {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'cache-control': file.includes(`${join('dist', 'assets')}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
    'x-content-type-options': 'nosniff',
  });
  createReadStream(file).pipe(res);
}

const server = createServer((req, res) => {
  if (handleApi(req, res)) return;
  const path = (req.url ?? '/').split('?')[0];
  if (path?.startsWith('/v1/')) {
    void proxyHelios(req, res);
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
