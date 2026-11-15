import { useMemo, useState } from 'react';
import { DataBadge } from '@/app/DataBadge';
import type { BBox, CalendarSeries } from '@/data/types';
import { useCalendar } from '@/data/queries';
import { fuseArchive } from '@/domain/ai/fusion';
import { bboxMask, polygonMask } from '@/domain/area';
import { SENSOR_MODIS } from '@/domain/detections';
import { FLAG_ALL_NOISE } from '@/domain/noise';
import { buildAreaSummary } from '@/domain/summary';
import { findCountry, useCountries } from '@/features/geo/countries';
import { useArchive } from '@/features/map/useFireData';
import { Meter } from '@/features/mission/Section';
import { useI18n } from '@/i18n';
import { Card, Segmented, SensorMark, Skeleton } from '@/ui';
import { LiveFusion } from './LiveFusion';

type AreaId = 'KZ' | 'world';
const AREAS: Record<AreaId, { bbox: BBox; regionId: string | null }> = {
  KZ: { bbox: [46.47, 40.66, 87.36, 55.39], regionId: 'KZ' },
  world: { bbox: [-180, -90, 180, 90], regionId: null },
};

/** Annual totals on the MODIS scale: raw MODIS hexagon-days, VIIRS ÷ k, the harmonized value with its interval. */
function AnnualChart({ calendar, name }: { calendar: CalendarSeries; name: string }) {
  const { m, fmt } = useI18n();
  const t = m.ai.lab.fusion.chart;
  const data = useMemo(() => {
    const summary = buildAreaSummary(calendar, { name, iso2: null, bbox: calendar.bbox });
    const k = calendar.meta.ratio.value || 1;
    const byYear = new Map<number, { modis: number; viirs: number | null }>();
    for (const p of calendar.points) {
      const y = byYear.get(p.year) ?? { modis: 0, viirs: null };
      y.modis += p.modisHex;
      if (p.viirsHex !== null) y.viirs = (y.viirs ?? 0) + p.viirsHex / k;
      byYear.set(p.year, y);
    }
    return (summary?.annual ?? []).map((a) => ({ ...a, ...byYear.get(a.year)! }));
  }, [calendar, name]);
  if (data.length < 2) return null;
  const W = 640;
  const H = 220;
  const pad = { l: 40, r: 12, t: 14, b: 26 };
  const maxY = Math.max(1, ...data.map((d) => Math.max(d.hi, d.modis, d.viirs ?? 0))) * 1.08;
  const x = (year: number) =>
    pad.l + ((year - data[0]!.year) / (data[data.length - 1]!.year - data[0]!.year)) * (W - pad.l - pad.r);
  const y = (v: number) => H - pad.b - (v / maxY) * (H - pad.t - pad.b);
  const line = (pts: [number, number][]) =>
    pts.map(([a, b], i) => `${i ? 'L' : 'M'}${x(a).toFixed(1)} ${y(b).toFixed(1)}`).join('');
  const band =
    line(data.map((d) => [d.year, d.hi])) +
    data
      .slice()
      .reverse()
      .map((d) => `L${x(d.year).toFixed(1)} ${y(d.lo).toFixed(1)}`)
      .join('') +
    'Z';
  const ticks = [0, 0.5, 1].map((f) => f * maxY);
  return (
    <figure className="m-0 grid gap-2">
      <figcaption className="flex flex-wrap items-center justify-between gap-2 text-[13px] text-ink">
        {t.title}
        <DataBadge />
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} className="lab-chart" role="img" aria-label={t.title}>
        {ticks.map((v) => (
          <g key={v}>
            <line x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} className="lab-chart__grid" />
            <text x={pad.l - 6} y={y(v) + 4} className="lab-chart__tick" textAnchor="end">
              {fmt.compact(v)}
            </text>
          </g>
        ))}
        {data
          .filter((d) => d.year % 5 === 0)
          .map((d) => (
            <text key={d.year} x={x(d.year)} y={H - 8} className="lab-chart__tick" textAnchor="middle">
              {d.year}
            </text>
          ))}
        <line x1={x(2012)} x2={x(2012)} y1={pad.t} y2={H - pad.b} className="lab-chart__viirs" />
        <path d={band} className="lab-chart__band" />
        <path d={line(data.map((d) => [d.year, d.modis]))} className="lab-chart__modis" />
        <path
          d={line(data.filter((d) => d.viirs !== null).map((d) => [d.year, d.viirs!]))}
          className="lab-chart__viirsLine"
        />
        <path d={line(data.map((d) => [d.year, d.value]))} className="lab-chart__harm" />
      </svg>
      <ul className="lab-legend">
        <li style={{ ['--c' as string]: 'var(--el-modis)' }}>{t.modis}</li>
        <li style={{ ['--c' as string]: 'var(--el-viirs)' }}>{t.viirs}</li>
        <li style={{ ['--c' as string]: 'var(--el-harmonized)' }}>{t.harmonized}</li>
        <li style={{ ['--c' as string]: 'var(--el-band)' }}>{t.interval}</li>
      </ul>
    </figure>
  );
}

/** Tab "MODIS × VIIRS": the four fusion steps with live numbers from the archive. */
export default function FusionTab() {
  const { m, fmt } = useI18n();
  const t = m.ai.lab.fusion;
  const [areaId, setAreaId] = useState<AreaId>('KZ');
  const area = AREAS[areaId];
  const { archive } = useArchive();
  const countries = useCountries();
  const calendar = useCalendar({ bbox: area.bbox, regionId: area.regionId });

  const stats = useMemo(() => {
    if (!archive) return null;
    const shape = area.regionId ? findCountry(countries.data, area.regionId) : null;
    const mask =
      areaId === 'world'
        ? null
        : shape
          ? polygonMask(archive.table, shape.polys, area.bbox)
          : bboxMask(archive.table, area.bbox);
    const per = { MODIS: { n: 0, noise: 0 }, VIIRS: { n: 0, noise: 0 } };
    for (let i = 0; i < archive.table.n; i++) {
      if (mask && !mask[i]) continue;
      const s = archive.table.sensor[i] === SENSOR_MODIS ? per.MODIS : per.VIIRS;
      s.n += 1;
      if (archive.flags[i]! & FLAG_ALL_NOISE) s.noise += 1;
    }
    return { per, fusion: fuseArchive(archive, mask) };
  }, [archive, countries.data, area, areaId]);

  const meta = calendar.data?.meta;
  const ratio = (v: number | null | undefined) => (v === null || v === undefined ? '—' : fmt.dec(v, 2));

  return (
    <section aria-labelledby="fusion-title" className="grid gap-8">
      <header className="max-w-[780px]">
        <p className="eyebrow m-0 !text-kyzyl">{t.kicker}</p>
        <h2 id="fusion-title" className="display m-0 mt-3 text-[clamp(1.4rem,1.6vw+0.9rem,2.1rem)] text-ink">
          {t.title}
        </h2>
        <p className="m-0 mt-4 max-w-[64ch] text-[15px] leading-relaxed text-ink-muted">{t.body}</p>
      </header>

      <div className="grid gap-4 md:grid-cols-2">
        <Card className="flex items-start gap-3">
          <SensorMark kind="MODIS" size={14} />
          <div>
            <p className="m-0 text-[15px] text-ink">MODIS</p>
            <p className="m-0 mt-1 text-[13px] text-ink-muted">{t.sensors.modis}</p>
          </div>
        </Card>
        <Card className="flex items-start gap-3">
          <SensorMark kind="VIIRS" size={14} />
          <div>
            <p className="m-0 text-[15px] text-ink">VIIRS</p>
            <p className="m-0 mt-1 text-[13px] text-ink-muted">{t.sensors.viirs}</p>
          </div>
        </Card>
      </div>

      <LiveFusion />

      <div className="flex flex-wrap items-center gap-3">
        <span className="text-[12px] text-ink-dim">{t.area}</span>
        <Segmented<AreaId>
          label={t.area}
          value={areaId}
          onChange={setAreaId}
          options={[
            { value: 'KZ', label: t.areas.KZ },
            { value: 'world', label: t.areas.world },
          ]}
        />
      </div>

      {!stats || !meta ? (
        <div className="grid gap-3">
          <p className="m-0 text-[13px] text-ink-dim" role="status">
            {t.loading}
          </p>
          <Skeleton className="h-72 w-full !rounded-panel" />
        </div>
      ) : (
        <>
          <ol className="lab-steps">
            <li>
              <b>{t.steps.clean.title}</b>
              <span>
                {t.steps.clean.body(
                  fmt.pct(stats.per.MODIS.n ? stats.per.MODIS.noise / stats.per.MODIS.n : 0, 0),
                  fmt.pct(stats.per.VIIRS.n ? stats.per.VIIRS.noise / stats.per.VIIRS.n : 0, 0),
                )}
              </span>
            </li>
            <li>
              <b>{t.steps.snap.title}</b>
              <span>{t.steps.snap.body(ratio(meta.rawRatio), ratio(meta.ratio.value))}</span>
            </li>
            <li>
              <b>{t.steps.confirm.title}</b>
              <span>
                {t.steps.confirm.body(
                  fmt.int(stats.fusion.both),
                  fmt.int(stats.fusion.modisOnly),
                  fmt.int(stats.fusion.viirsOnly),
                )}
              </span>
            </li>
            <li>
              <b>{t.steps.blend.title}</b>
              <span>
                {t.steps.blend.body(ratio(meta.ratio.value), ratio(meta.ratio.lo), ratio(meta.ratio.hi))}
              </span>
            </li>
          </ol>

          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)]">
            <Card className="grid content-start gap-4">
              {[
                {
                  label: t.confirm.modisConfirmed,
                  v: stats.fusion.modisConfirmedByViirs,
                  c: 'var(--el-modis)',
                },
                { label: t.confirm.viirsSeen, v: stats.fusion.viirsSeenByModis, c: 'var(--el-viirs)' },
              ].map((r) => (
                <div key={r.label} className="grid gap-1.5">
                  <div className="flex justify-between gap-3 text-[12.5px]">
                    <span className="text-ink-dim">{r.label}</span>
                    <span className="num text-ink">{fmt.pct(r.v, 0)}</span>
                  </div>
                  <Meter value={r.v} color={r.c} label={r.label} />
                </div>
              ))}
              <dl className="lab-kv">
                <div>
                  <dt>
                    {t.confirm.confidence} · {t.confirm.both}
                  </dt>
                  <dd className="num">{fmt.pct(stats.fusion.meanConfidence.both, 0)}</dd>
                </div>
                <div>
                  <dt>
                    {t.confirm.confidence} · {t.confirm.single}
                  </dt>
                  <dd className="num">
                    {fmt.pct(
                      (stats.fusion.meanConfidence.modisOnly * stats.fusion.modisOnly +
                        stats.fusion.meanConfidence.viirsOnly * stats.fusion.viirsOnly) /
                        Math.max(1, stats.fusion.modisOnly + stats.fusion.viirsOnly),
                      0,
                    )}
                  </dd>
                </div>
              </dl>
              {stats.fusion.pixelsPerEvent ? (
                <p className="m-0 text-[12.5px] text-ink-muted">
                  {t.confirm.pixels(
                    fmt.dec(stats.fusion.pixelsPerEvent.modis, 2),
                    fmt.dec(stats.fusion.pixelsPerEvent.viirs, 2),
                  )}
                </p>
              ) : null}
            </Card>
            <Card>
              <AnnualChart calendar={calendar.data!} name={t.areas[areaId]} />
            </Card>
          </div>
          <p className="m-0 text-[12.5px] leading-snug text-ink-dim">{t.honest}</p>
        </>
      )}
    </section>
  );
}
