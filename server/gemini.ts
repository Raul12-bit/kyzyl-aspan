import type { AreaSummary } from '../src/domain/summary';
import { config } from './config';
import { LOCALE_LANGUAGE } from './validate';

export class GeminiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = 'GeminiError';
  }
}

/** What the brief is: a worked example on synthetic numbers, or a risk briefing on real data. */
export type BriefMode = 'demo' | 'risk';

/** Rules shared by both modes: the period, null fields, no invented numbers. */
const COMMON_RULES = [
  '- Use ONLY the numbers in the brief. Never invent figures, places, dates or events.',
  '- Every number describes the selected period ("period", inclusive months) — name it once. "record" is the',
  '  whole archive of the area, given for context only.',
  '- A null field or an empty list was not computed because the period is too short; say so briefly, never guess it.',
  '- Month numbers are 1–12; write month names.',
];

/**
 * The instructions are fixed on the server; the client only supplies numbers and an area name.
 * Demo mode (synthetic numbers) forbids any risk level or forecast: a generated archive says nothing about a
 * real place. Risk mode forecasts only when the period ends with the latest data (`seasonAhead` is set).
 */
export function systemPrompt(language: string, mode: BriefMode): string {
  if (mode === 'demo') {
    return [
      'You explain satellite fire statistics to the general public.',
      'The JSON brief describes one area and one period. It is a SYNTHETIC DEMO: every number comes from a data',
      'generator shaped like the NASA MODIS and VIIRS archives, not from real satellite detections.',
      'Rules:',
      '- This is NOT a forecast. Never assess real-world fire risk, never write a risk level (low, moderate,',
      '  elevated, high) and never predict future months or seasons.',
      ...COMMON_RULES,
      `- Write in ${language}. Plain language, at most 150 words.`,
      'Format exactly (markdown, translate the headings):',
      '## Demo briefing',
      'One sentence: these are synthetic demo numbers for the area and the period — a worked example of the',
      'method, not a forecast for a real place.',
      '## What the numbers show',
      '- 2–3 bullets: when activity peaks, the trend, unusual months, how active the period was.',
      '## How the method treated them',
      '- 1–2 bullets: what the noise filter removed; why VIIRS/MODIS differ less in hexagons than in pixels.',
      '## Caveats',
      '- 1 bullet: synthetic data and the uncertainty of the period total.',
    ].join('\n');
  }
  return [
    'You are a wildfire risk analyst writing for the general public.',
    'You receive a JSON brief of satellite fire statistics for one area and one period: MODIS and VIIRS active-fire',
    'detections, cleaned of low-confidence pixels and persistent industrial heat sources, harmonized to one',
    'MODIS-equivalent scale of burning H3 hexagon-days. Detections are hot pixels, not individual fires.',
    'Rules:',
    ...COMMON_RULES,
    '- "seasonAhead" is set only when the period ends with the latest data. If it is null, do not forecast:',
    '  describe the period instead, and use the heading "## Period" in place of "## Risk".',
    '- The brief may contain "helios": results of the HELIOS-SHIELD server pipeline on real NASA data.',
    '  helios.forecast.by_horizon["1"].max / .mean = AI-predicted probability (0–1) of any fire next week in the area,',
    '  .climatology_mean = the typical probability for this week; fire_dna = counts of burn-type classes',
    '  (industrial, agricultural, wildfire, sporadic); season_shift = shift of the fire season in days per decade;',
    '  blind_cells > 0 = cells cloudy during satellite overpasses where fires may have been missed; alerts = live',
    '  onboard-AI alerts by priority. Use these numbers too, and say so when blind spots are present.',
    '- Do not give evacuation or emergency orders; point to local authorities for warnings.',
    `- Write in ${language}. Plain language, at most 170 words.`,
    'Format exactly (markdown, translate the headings):',
    '## Risk',
    'One sentence with a level: low, moderate, elevated or high, for the next three months, and why.',
    '## Why',
    '- 2–3 bullets: season, trend, recent activity vs typical, notable anomalies.',
    '## Watch next',
    '- 1–2 bullets: what to monitor.',
    '## Caveats',
    '- 1–2 bullets: uncertainty, what the filter removed.',
  ].join('\n');
}

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
}

/**
 * Gemini 2.5 and 3.x "think" before answering, and the thinking tokens count against maxOutputTokens:
 * with the old limit of 900, gemini-3.6-flash spent ~950 tokens thinking and the brief came back cut or
 * empty. Rewriting a dozen given numbers needs little thought, so thinking is kept low.
 */
export function thinkingConfig(model: string): Record<string, unknown> {
  if (/^gemini-2\.5-flash/.test(model)) return { thinkingBudget: 0 };
  if (/^gemini-2\.5-pro/.test(model)) return { thinkingBudget: 128 };
  return { thinkingLevel: 'low' };
}

/** Room for low thinking (~1k tokens) plus a 170-word answer in any of the eight languages. */
const MAX_OUTPUT_TOKENS = 4096;

async function askModel(model: string, prompt: { system: string; user: string }, timeoutMs: number): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': config.geminiKey! },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: prompt.system }] },
        contents: [{ role: 'user', parts: [{ text: prompt.user }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: MAX_OUTPUT_TOKENS, thinkingConfig: thinkingConfig(model) },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new GeminiError(`request failed: ${(err as Error).message}`, null);
  }
  if (!res.ok) {
    // Do not echo the upstream body: it may contain request details. Status is enough for logs.
    throw new GeminiError(`HTTP ${res.status}`, res.status);
  }
  const data = (await res.json()) as GeminiResponse;
  if (data.promptFeedback?.blockReason) throw new GeminiError(`blocked the prompt: ${data.promptFeedback.blockReason}`, 200);
  const candidate = data.candidates?.[0];
  // A brief cut at the token limit would end mid-sentence: let the next model (or the rules) answer instead.
  if (candidate?.finishReason === 'MAX_TOKENS') throw new GeminiError('answer cut at the token limit', 200);
  const text = candidate?.content?.parts
    ?.filter((p) => !p.thought)
    .map((p) => p.text ?? '')
    .join('')
    .trim();
  if (!text) throw new GeminiError('returned no text', 200);
  return text.slice(0, 4000);
}

/**
 * Asks the configured model, then the fallbacks, within one overall deadline. A wrong key (401/403) or a
 * blocked prompt fails the same way everywhere, so those stop the chain at once.
 */
export async function analyzeWithGemini(
  summary: AreaSummary,
  locale: keyof typeof LOCALE_LANGUAGE,
  helios: Record<string, unknown> | null = null,
  mode: BriefMode = summary.synthetic ? 'demo' : 'risk',
): Promise<{ text: string; model: string }> {
  if (!config.geminiKey) throw new GeminiError('GEMINI_API_KEY is not configured', null);
  const prompt = {
    system: systemPrompt(LOCALE_LANGUAGE[locale] ?? 'English', mode),
    // Real HELIOS context never joins a demo brief: synthetic and real numbers are not mixed.
    user: JSON.stringify(helios && mode === 'risk' ? { ...summary, helios } : summary),
  };
  const models = [...new Set([config.geminiModel, ...config.geminiFallbackModels])];
  const deadline = Date.now() + config.geminiTotalTimeoutMs;
  let last: GeminiError | null = null;
  for (const model of models) {
    const left = deadline - Date.now();
    if (left < 2000) break;
    try {
      return { text: await askModel(model, prompt, Math.min(config.geminiTimeoutMs, left)), model };
    } catch (err) {
      last = err instanceof GeminiError ? err : new GeminiError((err as Error).message, null);
      console.warn(`[api] gemini ${model}: ${last.message}`);
      if (last.status === 401 || last.status === 403 || last.message.startsWith('blocked')) break;
    }
  }
  throw last ?? new GeminiError('no Gemini model answered in time', null);
}
