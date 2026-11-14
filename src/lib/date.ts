/**
 * Monthly time axis shared by the data layer, the mock generator and the UI.
 * A month is addressed by an integer index: 0 = 2000-01.
 */

export const START_YEAR = 2000;
export const START_MONTH = 1;
/** Last complete month in the (synthetic) archive. */
export const END_YEAR = 2026;
export const END_MONTH = 10;
/** First month with VIIRS 375 m data (S-NPP, January 2012). */
export const VIIRS_START_YEAR = 2012;
/** Aqua MODIS joined Terra in July 2002: before that only one MODIS overpass pair per day. */
export const AQUA_START_YEAR = 2002;
export const AQUA_START_MONTH = 7;

export function monthIndex(year: number, month: number): number {
  return (year - START_YEAR) * 12 + (month - START_MONTH);
}

export function fromMonthIndex(index: number): { year: number; month: number } {
  const year = START_YEAR + Math.floor(index / 12);
  const month = (((index % 12) + 12) % 12) + 1;
  return { year, month };
}

export const MONTH_COUNT = monthIndex(END_YEAR, END_MONTH) + 1;
export const VIIRS_START_INDEX = monthIndex(VIIRS_START_YEAR, 1);
export const AQUA_START_INDEX = monthIndex(AQUA_START_YEAR, AQUA_START_MONTH);

export function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** 'YYYY-MM' */
export function toYearMonth(year: number, month: number): string {
  return `${year}-${pad2(month)}`;
}

/** Parses 'YYYY-MM' or 'YYYY-MM-DD'; returns null when malformed or out of range. */
export function parseYearMonth(value: string | null | undefined): { year: number; month: number } | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  const idx = monthIndex(year, month);
  if (idx < 0 || idx >= MONTH_COUNT) return null;
  return { year, month };
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** First day of a month index as ISO date. */
export function monthStartIso(index: number): string {
  const { year, month } = fromMonthIndex(index);
  return `${year}-${pad2(month)}-01`;
}

/** Last day of a month index as ISO date. */
export function monthEndIso(index: number): string {
  const { year, month } = fromMonthIndex(index);
  return `${year}-${pad2(month)}-${pad2(daysInMonth(year, month))}`;
}

/** Month index of an ISO date string ('YYYY-MM-DD'). */
export function isoToMonthIndex(iso: string): number {
  return monthIndex(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)));
}

const EPOCH_MS = Date.UTC(START_YEAR, 0, 1);
const DAY_MS = 86_400_000;

/** Days since 2000-01-01 → ISO date. Used to keep fires.json compact. */
export function dayOffsetToIso(offset: number): string {
  return new Date(EPOCH_MS + offset * DAY_MS).toISOString().slice(0, 10);
}

export function isoToDayOffset(iso: string): number {
  const t = Date.parse(`${iso}T00:00:00Z`);
  return Math.round((t - EPOCH_MS) / DAY_MS);
}
