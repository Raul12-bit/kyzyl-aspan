import type { AreaSummary } from '../src/domain/summary';

export const LOCALE_LANGUAGE: Record<string, string> = {
  en: 'English',
  ru: 'Russian',
  kk: 'Kazakh',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
  pt: 'Portuguese (Brazil)',
  zh: 'Simplified Chinese',
};

export interface AnalyzeRequest {
  summary: AreaSummary;
  locale: keyof typeof LOCALE_LANGUAGE;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown, max = 120): v is string => typeof v === 'string' && v.length <= max;
const numArray = (v: unknown, max: number) => Array.isArray(v) && v.length <= max && v.every(isNum);

/**
 * Strict shape check of the request. Anything unexpected is rejected rather than forwarded to the
 * model: the summary is the only user-controlled text that reaches the prompt, so names are length-
 * limited and every numeric field must really be a number.
 */
export function parseAnalyzeRequest(body: unknown): { ok: true; value: AnalyzeRequest } | { ok: false; error: string } {
  if (!isObj(body)) return { ok: false, error: 'Body must be a JSON object' };
  const { summary: s, locale } = body;
  if (!isStr(locale, 5) || !(locale in LOCALE_LANGUAGE)) return { ok: false, error: 'Unsupported locale' };
  if (!isObj(s)) return { ok: false, error: 'summary is required' };
  const area = s.area;
  if (!isObj(area) || !isStr(area.name, 80) || !(area.iso2 === null || (isStr(area.iso2, 2) && /^[A-Z]{2}$/.test(area.iso2)))) {
    return { ok: false, error: 'summary.area is invalid' };
  }
  if (!numArray(area.bbox, 4) || (area.bbox as number[]).length !== 4) return { ok: false, error: 'summary.area.bbox is invalid' };
  if (!isObj(s.period) || !isStr(s.period.from, 7) || !isStr(s.period.to, 7)) return { ok: false, error: 'summary.period is invalid' };
  if (!isObj(s.totals) || !Object.values(s.totals).every(isNum)) return { ok: false, error: 'summary.totals is invalid' };
  if (!isObj(s.sensors) || !isNum(s.sensors.hexViirsToModis)) return { ok: false, error: 'summary.sensors is invalid' };
  if (!Array.isArray(s.annual) || s.annual.length > 40 || !s.annual.every((a) => isObj(a) && isNum(a.year) && isNum(a.value) && isNum(a.lo) && isNum(a.hi))) {
    return { ok: false, error: 'summary.annual is invalid' };
  }
  if (!numArray(s.climatology, 12) || !numArray(s.peakMonths, 12)) return { ok: false, error: 'summary.climatology is invalid' };
  if (!isNum(s.trendPctPerYear) || !isNum(s.relativeUncertainty)) return { ok: false, error: 'summary trend/uncertainty is invalid' };
  if (!(s.recentVsTypical === null || isNum(s.recentVsTypical))) return { ok: false, error: 'summary.recentVsTypical is invalid' };
  if (!Array.isArray(s.anomalies) || s.anomalies.length > 12 || !s.anomalies.every((a) => isObj(a) && isStr(a.month, 7) && isNum(a.z))) {
    return { ok: false, error: 'summary.anomalies is invalid' };
  }
  if (!isObj(s.seasonAhead) || !numArray(s.seasonAhead.months, 3) || !isNum(s.seasonAhead.share)) {
    return { ok: false, error: 'summary.seasonAhead is invalid' };
  }
  return { ok: true, value: { summary: s as unknown as AreaSummary, locale: locale as AnalyzeRequest['locale'] } };
}
