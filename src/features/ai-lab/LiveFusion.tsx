import { useEffect, useMemo } from 'react';
import { publishFact } from '@/features/assistant/assistantStore';
import { spreadReachKmh } from '@/domain/ai/crosscheck';
import { fuseFootprints, type Footprint, type FootprintFusion } from '@/domain/ai/fusion';
import type { EventPass, FireEvent } from '@/domain/ai/temporal';
import { isModis, KM_PER_DEG, liveSat, type LiveRow } from '@/domain/live/satellites';
import { nearestWind, type LiveWind } from '@/features/live/api';
import { useLiveAnalysis } from '@/features/live/useLiveAnalysis';
import { useI18n } from '@/i18n';
import { Card, Skeleton } from '@/ui';

const hhmm = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'UTC',
});
const clockOf = (unixSec: number) => hhmm.format(new Date(unixSec * 1000));

interface Pair {
  event: FireEvent;
  modis: EventPass;
  viirs: EventPass;
  fusion: FootprintFusion;
}

const toFootprint = (r: LiveRow): Footprint => ({
  lng: r[0],
  lat: r[1],
  frp: r[4],
  scanKm: r[6],
  trackKm: r[7],
});

/** The fire seen by MODIS and VIIRS closest in time (≤ 3 h), with the most pixels — fused pixel by pixel. */
function bestPair(
  events: readonly FireEvent[],
  rows: readonly LiveRow[],
  winds: readonly LiveWind[] | undefined,
): Pair | null {
  let best: { event: FireEvent; modis: EventPass; viirs: EventPass; score: number } | null = null;
  for (const e of events) {
    if (e.sensors !== 3) continue;
    for (const m of e.passes.filter((p) => isModis(p.sat))) {
      for (const v of e.passes.filter((p) => !isModis(p.sat))) {
        const dtH = Math.abs(v.t - m.t) / 3600;
        if (dtH > 3) continue;
        const score = (m.n + v.n) * 10 - dtH;
        if (!best || score > best.score) best = { event: e, modis: m, viirs: v, score };
      }
    }
  }
  if (!best) return null;
  const w = nearestWind(winds, best.event.lat, best.event.lng, (best.modis.t + best.viirs.t) / 2);
  const drift = Math.min(5, (spreadReachKmh(w) * Math.abs(best.viirs.t - best.modis.t)) / 3600);
  const fusion = fuseFootprints(
    best.modis.rows.map((i) => toFootprint(rows[i]!)),
    best.viirs.rows.map((i) => toFootprint(rows[i]!)),
    drift,
  );
  return { event: best.event, modis: best.modis, viirs: best.viirs, fusion };
}

/** Pixel sketch of one fused fire: MODIS footprints shaded by FRP, VIIRS pixels, the fused front. */
function FootprintSketch({ pair, rows }: { pair: Pair; rows: readonly LiveRow[] }) {
  const { m } = useI18n();
  const t = m.ai.lab.fusion.live;
  const { fusion, event } = pair;
  const kx = KM_PER_DEG * Math.cos((event.lat * Math.PI) / 180);
  const modis = pair.modis.rows.map((i) => toFootprint(rows[i]!));
  const viirs = fusion.refined;
  // Frame every footprint (km around the event centre) with a margin.
  const xs: number[] = [];
  const ys: number[] = [];
  for (const b of [...modis, ...viirs]) {
    const cx = (b.lng - event.lng) * kx;
    const cy = (b.lat - event.lat) * KM_PER_DEG;
    xs.push(cx - b.scanKm / 2, cx + b.scanKm / 2);
    ys.push(cy - b.trackKm / 2, cy + b.trackKm / 2);
  }
  const W = 420;
  const H = 280;
  const pad = 0.8;
  const minX = Math.min(...xs) - pad;
  const maxX = Math.max(...xs) + pad;
  const minY = Math.min(...ys) - pad;
  const maxY = Math.max(...ys) + pad;
  const s = Math.min(W / (maxX - minX), H / (maxY - minY));
  const ox = (W - (maxX - minX) * s) / 2;
  const oy = (H - (maxY - minY) * s) / 2;
  const X = (lng: number) => ((lng - event.lng) * kx - minX) * s + ox;
  const Y = (lat: number) => (maxY - (lat - event.lat) * KM_PER_DEG) * s + oy;
  const frpMax = Math.max(1, ...modis.map((p) => p.frp));
  const shareMax = Math.max(0.1, ...viirs.map((p) => p.frp));

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="lab-fp" role="img" aria-label={t.spatial}>
      {modis.map((p, i) => (
        <rect
          key={`m${i}`}
          x={X(p.lng) - (p.scanKm / 2) * s}
          y={Y(p.lat) - (p.trackKm / 2) * s}
          width={p.scanKm * s}
          height={p.trackKm * s}
          className="lab-fp__modis"
          fill={`rgb(147 175 204 / ${(0.08 + 0.32 * (p.frp / frpMax)).toFixed(2)})`}
        >
          <title>{`MODIS · ${p.frp} MW`}</title>
        </rect>
      ))}
      {fusion.hull.length > 2 ? (
        <path
          d={`M${fusion.hull.map(([lng, lat]) => `${X(lng).toFixed(1)} ${Y(lat).toFixed(1)}`).join('L')}Z`}
          className="lab-fp__hull"
        />
      ) : null}
      {viirs.map((p, i) => (
        <rect
          key={`v${i}`}
          x={X(p.lng) - (p.scanKm / 2) * s}
          y={Y(p.lat) - (p.trackKm / 2) * s}
          width={Math.max(2, p.scanKm * s)}
          height={Math.max(2, p.trackKm * s)}
          className="lab-fp__viirs"
          data-matched={p.matched ? 'true' : 'false'}
          style={p.matched ? { fillOpacity: 0.45 + 0.55 * (p.frp / shareMax) } : undefined}
        >
          <title>{`VIIRS · ${p.frp} MW`}</title>
        </rect>
      ))}
    </svg>
  );
}

/**
 * Fusion on the live feed: every hot spot of the last 48 h over Kazakhstan checked against the other satellites
 * (wind-aware), and one fire seen by both sensors fused pixel by pixel.
 */
export function LiveFusion() {
  const { m, fmt } = useI18n();
  const t = m.ai.lab.fusion.live;
  const live = useLiveAnalysis('kz', 48);
  const pair = useMemo(
    () => bestPair(live.events, live.rows, live.wind.data?.points),
    [live.events, live.rows, live.wind.data],
  );
  const s = live.summary;
  const seg = (n: number) => (s.total ? `${(n / s.total) * 100}%` : '0');
  const fact = live.fires.data
    ? `Live MODIS × VIIRS cross-check (Kazakhstan, last 48 h): ${s.total} hot spots — ${s.cross} confirmed by the other sensor family, ${s.confirmed - s.cross} by a sister satellite, ${s.unconfirmed} unconfirmed, ${s.pending} awaiting a pass, ${s.noise} dropped as glint.` +
      (pair
        ? ` Spatial match: ${liveSat(pair.modis.sat).name} ${clockOf(pair.modis.t)} + ${liveSat(pair.viirs.sat).name} ${clockOf(pair.viirs.t)} UTC — MODIS FRP ${pair.fusion.modis.frp} MW split over ${pair.fusion.viirs.n} VIIRS pixels, outline ${pair.fusion.sharpen.toFixed(1)}× finer.`
        : '')
    : null;
  useEffect(() => publishFact('fusion', fact), [fact]);
  useEffect(() => () => publishFact('fusion', null), []);
  const parts = [
    { k: 'cross', n: s.cross, c: 'var(--el-trust-high)', label: t.cross },
    { k: 'confirmed', n: s.confirmed - s.cross, c: '#5f8f6b', label: t.confirmed },
    { k: 'unconfirmed', n: s.unconfirmed, c: 'var(--el-ink-dim)', label: t.unconfirmed },
    { k: 'pending', n: s.pending, c: 'var(--el-link-radio)', label: t.pending },
    { k: 'noise', n: s.noise, c: 'var(--el-danger)', label: t.noise },
  ];

  return (
    <Card className="grid gap-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="lab-h3">{t.title}</h3>
        <span className="lab-live">
          <span className="lab-live__dot" aria-hidden />
          {m.ai.lab.bridge.live} <span className="num">· 48 h · FIRMS</span>
        </span>
      </div>
      <p className="m-0 max-w-[70ch] text-[13.5px] leading-relaxed text-ink-muted">{t.body}</p>
      {live.fires.isPending ? (
        <Skeleton className="h-40 w-full !rounded-panel" />
      ) : live.fires.isError && !live.fires.data ? (
        <p className="m-0 text-[13px] text-danger">{m.ai.lab.bridge.error}</p>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="grid content-start gap-3">
            <p className="m-0 text-[13px] text-ink">
              <span className="num text-[22px]">{fmt.int(s.total)}</span>{' '}
              <span className="text-ink-dim">{t.total}</span>
            </p>
            <div
              className="lab-xbar"
              role="img"
              aria-label={parts.map((p) => `${p.label}: ${p.n}`).join(', ')}
            >
              {parts.map((p) =>
                p.n ? <span key={p.k} style={{ width: seg(p.n), background: p.c }} /> : null,
              )}
            </div>
            <ul className="lab-xlegend">
              {parts.map((p) => (
                <li key={p.k} style={{ ['--c' as string]: p.c }}>
                  {p.label} <b>{fmt.int(p.n)}</b>
                </li>
              ))}
            </ul>
          </div>
          <div className="grid content-start gap-3">
            <p className="m-0 text-[13px] text-ink">{t.spatial}</p>
            {pair ? (
              <>
                <FootprintSketch pair={pair} rows={live.rows} />
                <p className="m-0 text-[12.5px] leading-snug text-ink-muted">
                  {t.spatialBody(fmt.dec(pair.fusion.modis.frp, 1), fmt.int(pair.fusion.viirs.n))} ·{' '}
                  <span className="text-gold-soft">{t.sharpen(fmt.dec(pair.fusion.sharpen, 1))}</span>
                </p>
                <p className="m-0 text-[12px] text-ink-dim">
                  {liveSat(pair.modis.sat).name} {clockOf(pair.modis.t)} · {liveSat(pair.viirs.sat).name}{' '}
                  {clockOf(pair.viirs.t)} UTC
                </p>
                <ul className="lab-legend">
                  <li style={{ ['--c' as string]: 'var(--el-modis)' }}>{t.legend.modis}</li>
                  <li style={{ ['--c' as string]: 'var(--el-viirs)' }}>{t.legend.viirs}</li>
                  <li style={{ ['--c' as string]: 'var(--el-gold)' }}>{t.legend.front}</li>
                </ul>
              </>
            ) : (
              <p className="m-0 text-[13px] text-ink-dim">{t.noPair}</p>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}
