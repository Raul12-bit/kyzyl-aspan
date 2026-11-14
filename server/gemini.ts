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

/**
 * The instructions are fixed on the server; the client only supplies numbers and an area name.
 * The model is told to use only the given figures and to say when the data are synthetic.
 */
function systemPrompt(language: string): string {
  return [
    'You are a wildfire risk analyst writing for the general public.',
    'You receive a JSON brief of satellite fire statistics for one area: MODIS and VIIRS active-fire detections,',
    'cleaned of low-confidence pixels and persistent industrial heat sources, harmonized to one MODIS-equivalent',
    'scale of burning H3 hexagon-days. Detections are hot pixels, not individual fires.',
    'Rules:',
    '- Use ONLY the numbers in the brief. Never invent figures, places, dates or events.',
    '- Month numbers are 1–12; write month names.',
    '- If "synthetic" is true, say in one short line that the figures are a synthetic demo.',
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
    '- 1–2 bullets: uncertainty, what the filter removed, synthetic data if applicable.',
  ].join('\n');
}

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
}

export async function analyzeWithGemini(
  summary: AreaSummary,
  locale: keyof typeof LOCALE_LANGUAGE,
  helios: Record<string, unknown> | null = null,
): Promise<{ text: string; model: string }> {
  if (!config.geminiKey) throw new GeminiError('GEMINI_API_KEY is not configured', null);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.geminiModel)}:generateContent`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': config.geminiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt(LOCALE_LANGUAGE[locale] ?? 'English') }] },
        contents: [{ role: 'user', parts: [{ text: JSON.stringify(helios ? { ...summary, helios } : summary) }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 900 },
      }),
      signal: AbortSignal.timeout(config.geminiTimeoutMs),
    });
  } catch (err) {
    throw new GeminiError(`Gemini request failed: ${(err as Error).message}`, null);
  }
  if (!res.ok) {
    // Do not echo the upstream body: it may contain request details. Status is enough for logs.
    throw new GeminiError(`Gemini returned HTTP ${res.status}`, res.status);
  }
  const data = (await res.json()) as GeminiResponse;
  if (data.promptFeedback?.blockReason) throw new GeminiError(`Gemini blocked the prompt: ${data.promptFeedback.blockReason}`, 200);
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('').trim();
  if (!text) throw new GeminiError('Gemini returned no text', 200);
  return { text: text.slice(0, 4000), model: config.geminiModel };
}
