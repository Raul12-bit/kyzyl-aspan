import type { Region } from './types';

/** Lowercase, strip diacritics, unify ё/е and apostrophes. */
export function normalizeText(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/['’ʻ`]/g, '')
    .trim();
}

function scoreTerm(term: string, q: string): number {
  if (term === q) return 100;
  if (term.startsWith(q)) return 80;
  if (term.split(/[\s\-–(),]+/).some((w) => w.startsWith(q))) return 60;
  if (term.includes(q)) return 40;
  return 0;
}

/** Ranked, deterministic region search used by the mock source (and handy for an offline fallback). */
export function searchRegionList(regions: readonly Region[], query: string, limit = 8): Region[] {
  const q = normalizeText(query);
  if (!q) {
    return regions.filter((r) => r.featured).slice(0, limit);
  }
  const scored: { region: Region; score: number }[] = [];
  for (const region of regions) {
    const terms = [region.name.en, region.name.ru, ...(region.aliases ?? [])].map(normalizeText);
    let score = Math.max(...terms.map((t) => scoreTerm(t, q)));
    if (normalizeText(region.id) === q) score = Math.max(score, 100);
    if (score === 0) continue;
    if (region.group === 'central-asia') score += 5;
    if (region.kind === 'country') score += 2;
    scored.push({ region, score });
  }
  scored.sort((a, b) => b.score - a.score || a.region.name.en.localeCompare(b.region.name.en));
  return scored.slice(0, limit).map((s) => s.region);
}
