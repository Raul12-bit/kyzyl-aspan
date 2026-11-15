import type { Finding } from '@/domain/summary';
import type { AreaSummary } from '@/domain/summary';

/** 'demo': synthetic numbers, explained and never forecast; 'risk': a risk briefing on real data. */
export type BriefMode = 'demo' | 'risk';

interface BriefMeta {
  /** Sent by the server; absent from older servers (the client then falls back to `summary.synthetic`). */
  mode?: BriefMode;
  /** The period the server analysed — echoed so the UI can show it next to the answer. */
  period?: { from: string; to: string };
}

export type AnalysisResult =
  | (BriefMeta & { source: 'gemini'; model: string; text: string })
  | (BriefMeta & { source: 'rules'; findings: Finding[]; reason?: 'not-configured' | 'model-error' | 'offline' });

export class AiOfflineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiOfflineError';
  }
}

function isResult(v: unknown): v is AnalysisResult {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  if (r.source === 'gemini') return typeof r.text === 'string' && typeof r.model === 'string';
  if (r.source === 'rules') return Array.isArray(r.findings);
  return false;
}

/**
 * Sends the statistical brief (never the map or the visitor's location) to the backend, which holds
 * the Gemini key. Network failures surface as AiOfflineError so the UI can fall back locally.
 */
export async function requestAnalysis(summary: AreaSummary, locale: string, signal?: AbortSignal): Promise<AnalysisResult> {
  let res: Response;
  try {
    res = await fetch(`${import.meta.env.BASE_URL}api/ai/analyze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ summary, locale }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new AiOfflineError('The analysis server is not reachable');
  }
  // Vite answers unknown /api paths with index.html (no server running) — treat as offline too.
  const type = res.headers.get('content-type') ?? '';
  if (res.status === 404 || res.status === 502 || res.status === 504 || !type.includes('application/json')) {
    throw new AiOfflineError(`Analysis server unavailable (HTTP ${res.status})`);
  }
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = typeof body === 'object' && body && 'error' in body ? String((body as { error: unknown }).error) : `HTTP ${res.status}`;
    throw new Error(msg);
  }
  if (!isResult(body)) throw new Error('Unexpected response from the analysis server');
  return body;
}
