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
const numArray = (v: unknown, max: number): v is number[] => Array.isArray(v) && v.length <= max && v.every(isNum);
const numOrNull = (v: unknown): v is number | null => v === null || isNum(v);
const YM = /^\d{4}-(0[1-9]|1[0-2])$/;
const isYm = (v: unknown): v is string => typeof v === 'string' && YM.test(v);
/** Inclusive number of months from 'YYYY-MM' to 'YYYY-MM'. */
const monthsBetween = (a: string, b: string) => (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + Number(b.slice(5)) - Number(a.slice(5)) + 1;

/**
 * Strict shape check of the request. Anything unexpected is rejected rather than forwarded to the
 * model: the summary is the only user-controlled text that reaches the prompt, so names are length-
 * limited, every numeric field must really be a number, and the summary is REBUILT from the known fields —
 * an extra key in the request never reaches the model.
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
  if (!numArray(area.bbox, 4) || area.bbox.length !== 4) return { ok: false, error: 'summary.area.bbox is invalid' };
  const p = s.period;
  if (!isObj(p) || !isYm(p.from) || !isYm(p.to) || p.from > p.to || !(p.months === undefined || (isNum(p.months) && p.months >= 1 && p.months <= 1200))) {
    return { ok: false, error: 'summary.period is invalid' };
  }
  const r = s.record;
  if (!(r === undefined || (isObj(r) && isYm(r.from) && isYm(r.to)))) return { ok: false, error: 'summary.record is invalid' };
  if (typeof s.synthetic !== 'boolean') return { ok: false, error: 'summary.synthetic is invalid' };
  const t = s.totals;
  if (!isObj(t) || ![t.detectionsConsidered, t.removedLowConfidence, t.removedStaticSources, t.staticCells].every(isNum)) {
    return { ok: false, error: 'summary.totals is invalid' };
  }
  if (!isObj(s.sensors) || !isNum(s.sensors.hexViirsToModis) || !numOrNull(s.sensors.rawViirsToModis)) {
    return { ok: false, error: 'summary.sensors is invalid' };
  }
  if (!Array.isArray(s.annual) || s.annual.length > 40 || !s.annual.every((a) => isObj(a) && isNum(a.year) && isNum(a.value) && isNum(a.lo) && isNum(a.hi))) {
    return { ok: false, error: 'summary.annual is invalid' };
  }
  if (!numArray(s.climatology, 12) || !numArray(s.peakMonths, 12)) return { ok: false, error: 'summary.climatology is invalid' };
  if (!numOrNull(s.trendPctPerYear) || !numOrNull(s.relativeUncertainty)) return { ok: false, error: 'summary trend/uncertainty is invalid' };
  if (!numOrNull(s.recentVsTypical)) return { ok: false, error: 'summary.recentVsTypical is invalid' };
  if (!Array.isArray(s.anomalies) || s.anomalies.length > 12 || !s.anomalies.every((a) => isObj(a) && isYm(a.month) && isNum(a.z))) {
    return { ok: false, error: 'summary.anomalies is invalid' };
  }
  const ahead = s.seasonAhead;
  if (!(ahead === null || (isObj(ahead) && numArray(ahead.months, 3) && isNum(ahead.share)))) {
    return { ok: false, error: 'summary.seasonAhead is invalid' };
  }
  if (!(s.interval === undefined || (isNum(s.interval) && s.interval > 0 && s.interval < 1))) return { ok: false, error: 'summary.interval is invalid' };
  const pt = s.periodTotal;
  if (!(pt === undefined || (isObj(pt) && isNum(pt.value) && isNum(pt.lo) && isNum(pt.hi)))) return { ok: false, error: 'summary.periodTotal is invalid' };

  const summary: AreaSummary = {
    area: { name: area.name, iso2: area.iso2 as string | null, bbox: area.bbox.slice(0, 4) as [number, number, number, number] },
    period: { from: p.from, to: p.to, months: isNum(p.months) ? p.months : monthsBetween(p.from, p.to) },
    record: r ? { from: r.from as string, to: r.to as string } : { from: p.from, to: p.to },
    unit: isStr(s.unit, 120) ? s.unit : 'MODIS-equivalent burning hexagon-days per month',
    synthetic: s.synthetic,
    totals: {
      detectionsConsidered: t.detectionsConsidered as number,
      removedLowConfidence: t.removedLowConfidence as number,
      removedStaticSources: t.removedStaticSources as number,
      staticCells: t.staticCells as number,
    },
    sensors: {
      rawViirsToModis: s.sensors.rawViirsToModis as number | null,
      hexViirsToModis: s.sensors.hexViirsToModis,
      calibrated: s.sensors.calibrated === true,
    },
    annual: (s.annual as Record<string, number>[]).map((a) => ({ year: a.year!, value: a.value!, lo: a.lo!, hi: a.hi! })),
    climatology: s.climatology,
    peakMonths: s.peakMonths,
    trendPctPerYear: s.trendPctPerYear,
    anomalies: (s.anomalies as { month: string; z: number }[]).map((a) => ({ month: a.month, z: a.z })),
    recentVsTypical: s.recentVsTypical,
    relativeUncertainty: s.relativeUncertainty,
    periodTotal: pt ? { value: pt.value as number, lo: pt.lo as number, hi: pt.hi as number } : { value: 0, lo: 0, hi: 0 },
    interval: s.interval as number | undefined,
    seasonAhead: ahead === null ? null : { months: ahead.months as number[], share: ahead.share as number },
  };
  return { ok: true, value: { summary, locale: locale as AnalyzeRequest['locale'] } };
}

/* ------------------------------------------------------------------ AI #3 ground forecast */

export interface GroundRequest {
  lat: number;
  lng: number;
  fuel: 'grass' | 'forest';
  /** Overrides of the synthetic weather at the point (all optional). */
  weather: Partial<Record<'windKmh' | 'windFromDeg' | 'tempC' | 'rh' | 'drought' | 'rain24h', number>>;
  hours: number[];
  localHour: number | null;
}

/** Allowed ranges of the weather overrides (physical limits, not forecasts). */
const WEATHER_RANGE: Record<keyof GroundRequest['weather'], [number, number]> = {
  windKmh: [0, 150],
  windFromDeg: [0, 360],
  tempC: [-40, 55],
  rh: [1, 100],
  drought: [0, 10],
  rain24h: [0, 500],
};

/** Validates POST /api/ai/ground/forecast. Unknown keys are rejected so typos never pass silently. */
export function parseGroundRequest(body: unknown): { ok: true; value: GroundRequest } | { ok: false; error: string } {
  if (!isObj(body)) return { ok: false, error: 'Body must be a JSON object' };
  const allowed = new Set(['lat', 'lng', 'fuel', 'weather', 'hours', 'localHour']);
  const unknown = Object.keys(body).find((k) => !allowed.has(k));
  if (unknown) return { ok: false, error: `Unknown field: ${unknown.slice(0, 40)}` };
  const { lat, lng } = body;
  if (!isNum(lat) || lat < -90 || lat > 90) return { ok: false, error: 'lat must be a number within ±90' };
  if (!isNum(lng) || lng < -180 || lng > 180) return { ok: false, error: 'lng must be a number within ±180' };
  const fuel = body.fuel ?? 'grass';
  if (fuel !== 'grass' && fuel !== 'forest') return { ok: false, error: 'fuel must be "grass" or "forest"' };
  const weather: GroundRequest['weather'] = {};
  if (body.weather !== undefined) {
    if (!isObj(body.weather)) return { ok: false, error: 'weather must be an object' };
    for (const [k, v] of Object.entries(body.weather)) {
      const range = WEATHER_RANGE[k as keyof GroundRequest['weather']];
      if (!range) return { ok: false, error: `Unknown weather field: ${k.slice(0, 40)}` };
      if (!isNum(v) || v < range[0] || v > range[1]) return { ok: false, error: `weather.${k} must be within ${range[0]}…${range[1]}` };
      weather[k as keyof GroundRequest['weather']] = v;
    }
  }
  const hours = body.hours ?? [6, 12, 24];
  if (!Array.isArray(hours) || hours.length === 0 || hours.length > 6 || !hours.every((h) => isNum(h) && Number.isInteger(h) && h >= 1 && h <= 72)) {
    return { ok: false, error: 'hours must be 1–6 whole numbers within 1…72' };
  }
  const localHour = body.localHour ?? null;
  if (!(localHour === null || (isNum(localHour) && localHour >= 0 && localHour < 24))) return { ok: false, error: 'localHour must be within 0…24' };
  return { ok: true, value: { lat, lng, fuel, weather, hours: hours as number[], localHour } };
}
