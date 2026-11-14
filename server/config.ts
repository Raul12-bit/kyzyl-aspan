import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Minimal .env reader (KEY=VALUE per line, # comments, optional quotes) so the server needs no
 * dependency. Real environment variables always win over the file.
 */
function loadDotEnv(file: string) {
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const root = resolve(import.meta.dirname, '..');
loadDotEnv(resolve(root, '.env'));

const int = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

export const config = {
  root,
  port: int(process.env.PORT, 8787),
  host: process.env.HOST || '127.0.0.1',
  /** Google AI Studio key. Never sent to the browser. */
  geminiKey: process.env.GEMINI_API_KEY?.trim() || null,
  /** Model id; configurable because Google renames and retires models. */
  geminiModel: process.env.GEMINI_MODEL?.trim() || 'gemini-2.5-flash',
  geminiTimeoutMs: int(process.env.GEMINI_TIMEOUT_MS, 20_000),
  /** Comma-separated origins allowed to call the API cross-origin (the Vite proxy is same-origin). */
  allowedOrigins: (process.env.ALLOWED_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  /** Requests per minute per client IP on the AI endpoint. */
  rateLimitPerMinute: int(process.env.AI_RATE_LIMIT_PER_MIN, 10),
  /** Serve the production build (dist/) as well, for one-process deployments. */
  serveStatic: process.env.SERVE_STATIC !== '0',
  /** HELIOS data API (Python, FastAPI): /v1/* is proxied there and AI briefs get its forecast as context. */
  heliosUrl: (process.env.HELIOS_API_URL || 'http://127.0.0.1:8000/v1').replace(/\/$/, ''),
  heliosTimeoutMs: int(process.env.HELIOS_TIMEOUT_MS, 4000),
};
