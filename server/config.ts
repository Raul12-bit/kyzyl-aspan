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

// On Vercel the bundled function has no .env next to it; its settings come from the project's variables.
const root = resolve(import.meta.dirname ?? process.cwd(), '..');
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
  /**
   * Model id; configurable because Google renames and retires models. gemini-2.5-flash answers 404 for new
   * keys since late 2026 ("no longer available to new users"), so the default is a current Flash model.
   */
  geminiModel: process.env.GEMINI_MODEL?.trim() || 'gemini-3.6-flash',
  /**
   * The in-app guide answers while the visitor waits: the fast model first, the main one as the fallback
   * (gemini-3.6-flash can take > 15 s on a long prompt).
   */
  geminiChatModels: (process.env.GEMINI_CHAT_MODELS ?? 'gemini-3.5-flash-lite,gemini-3.6-flash')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  /** Tried in order when the main model is retired, overloaded, over quota or too slow. */
  geminiFallbackModels: (process.env.GEMINI_FALLBACK_MODELS ?? 'gemini-3.5-flash-lite')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  /** Per model attempt. */
  geminiTimeoutMs: int(process.env.GEMINI_TIMEOUT_MS, 15_000),
  /** All attempts together; the browser gives up after 30 s. */
  geminiTotalTimeoutMs: int(process.env.GEMINI_TOTAL_TIMEOUT_MS, 26_000),
  /** Comma-separated origins allowed to call the API cross-origin (the Vite proxy is same-origin). */
  allowedOrigins: (process.env.ALLOWED_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  /** Requests per minute per client IP on the AI endpoint. */
  rateLimitPerMinute: int(process.env.AI_RATE_LIMIT_PER_MIN, 10),
  /** Requests per minute per client IP on the AI #3 ground endpoints (cheap, no external model). */
  groundRateLimitPerMinute: int(process.env.AI_GROUND_RATE_LIMIT_PER_MIN, 60),
  /** Questions per minute per client IP to the in-app AI guide (each one is a Gemini call). */
  chatRateLimitPerMinute: int(process.env.AI_CHAT_RATE_LIMIT_PER_MIN, 20),
  /** Serve the production build (dist/) as well, for one-process deployments. */
  serveStatic: process.env.SERVE_STATIC !== '0',
  /** HELIOS data API (Python, FastAPI): /v1/* is proxied there and AI briefs get its forecast as context. */
  heliosUrl: (process.env.HELIOS_API_URL || 'http://127.0.0.1:8000/v1').replace(/\/$/, ''),
  heliosTimeoutMs: int(process.env.HELIOS_TIMEOUT_MS, 4000),
};
