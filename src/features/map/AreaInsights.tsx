import { useMemo } from 'react';
import { useAppParams } from '@/app/useAppParams';
import { useCalendar } from '@/data/queries';
import type { BBox } from '@/data/types';
import { bboxMask, polygonMask } from '@/domain/area';
import { hideMaskOf, type FireArchive } from '@/domain/archive';
import { aggregateHex } from '@/domain/hexStats';
import { buildAreaSummary, type AreaSummary } from '@/domain/summary';
import { AiPanel } from '@/features/ai/AiPanel';
import { findCountry, useCountries } from '@/features/geo/countries';
import { useI18n } from '@/i18n';
import { fromMonthIndex, VIIRS_START_INDEX, VIIRS_START_YEAR } from '@/lib/date';
import { Skeleton, Tooltip } from '@/ui';
import { useMapStore } from './mapStore';
import { useEffectiveRange } from './timeStore';
import { gridAt } from './useFireData';
import { useAreaName } from './useRegion';

const WORLD: BBox = [-180, -85, 180, 85];

function Stat({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: string }) {
  const body = (
    <div className="min-w-0 rounded-[12px] border border-line bg-[rgb(255_255_255/0.02)] px-3 py-2.5">
      <p className="m-0 line-clamp-2 min-h-[2lh] text-[11.5px] leading-tight text-ink-dim">{label}</p>
      <p className="stat-value m-0 mt-0.5 truncate !text-[18px]" style={tone ? { color: tone } : undefined}>
        {value}
      </p>
    </div>
  );
  return hint ? (
    <Tooltip content={hint} placement="top">
      <div tabIndex={0} className="rounded-[12px] outline-none focus-visible:shadow-[var(--el-focus-ring)]">
        {body}
      </div>
    </Tooltip>
  ) : (
    body
  );
}

/** Annual harmonized totals with their 90% intervals — the record the whole method exists to make. */
function AnnualChart({ summary }: { summary: AreaSummary }) {
  const { fmt } = useI18n();
  const data = summary.annual;
  const W = 320;
  const H = 96;
  const max = Math.max(1, ...data.map((d) => d.hi));
  const bw = W / data.length;
  const y = (v: number) => H - 14 - (v / max) * (H - 22);
  const viirsX = data.findIndex((d) => d.year === VIIRS_START_YEAR) * bw;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" role="img" aria-label={data.map((d) => `${d.year}: ${fmt.int(d.value)}`).join(', ')}>
      <defs>
        <linearGradient id="annual-bar" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--el-amber)" />
          <stop offset="1" stopColor="var(--el-kyzyl)" stopOpacity=".55" />
        </linearGradient>
      </defs>
      {viirsX > 0 ? (
        <g>
          <line x1={viirsX} x2={viirsX} y1={4} y2={H - 14} stroke="var(--el-viirs)" strokeOpacity=".5" strokeDasharray="2 3" />
          <text x={viirsX + 3} y={10} fontSize="8.5" fill="var(--el-viirs)" fontFamily="var(--el-font-mono)">
            VIIRS
          </text>
        </g>
      ) : null}
      {data.map((d, i) => {
        const x = i * bw;
        return (
          <g key={d.year}>
            <rect x={x + bw * 0.18} width={bw * 0.64} y={y(d.value)} height={Math.max(1, H - 14 - y(d.value))} rx={1.5} fill="url(#annual-bar)" />
            <line x1={x + bw / 2} x2={x + bw / 2} y1={y(d.hi)} y2={y(d.lo)} stroke="var(--el-ink)" strokeOpacity=".45" strokeWidth={1} />
          </g>
        );
      })}
      {[0, Math.floor(data.length / 2), data.length - 1].map((i) => (
        <text key={i} x={i * bw + bw / 2} y={H - 2} fontSize="9" textAnchor="middle" fill="var(--el-ink-dim)" fontFamily="var(--el-font-mono)">
          {data[i]?.year}
        </text>
      ))}
    </svg>
  );
}

/**
 * Statistics of the selected area (or the whole world) for the current time window and filters,
 * the harmonized 26-year record, and the AI briefing built from them.
 */
export function AreaInsights({ archive }: { archive: FireArchive | null }) {
  const { m, fmt } = useI18n();
  const { bbox, regionId } = useAppParams();
  const range = useEffectiveRange();
  const sensors = useMapStore((s) => s.sensors);
  const noise = useMapStore((s) => s.noise);
  const countries = useCountries();
  const areaName = useAreaName(regionId);
  const country = regionId && /^[A-Z]{2}$/.test(regionId) ? findCountry(countries.data, regionId) : null;
  const box = bbox ?? WORLD;
  const name = bbox ? areaName : m.map.area.world;

  const mask = useMemo(() => {
    if (!archive) return null;
    if (!bbox) return null; // whole archive
    return country ? polygonMask(archive.table, country.polys, bbox) : bboxMask(archive.table, bbox);
  }, [archive, bbox, country]);

  const agg = useMemo(() => {
    if (!archive) return null;
    const months = archive.table.month;
    const lb = (mo: number) => {
      let lo = 0;
      let hi = archive.table.n;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (months[mid]! < mo) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    };
    const opts = { flags: archive.flags, hideMask: hideMaskOf(noise), sensors: [sensors.MODIS, sensors.VIIRS] as const, area: mask };
    const grid = gridAt(archive, 5);
    const totals = aggregateHex(archive.table, grid, { ...opts, from: lb(range[0]), to: lb(range[1] + 1) }).totals;
    // Sensor ratios only mean something where both sensors fly: the overlap part of the window.
    const overlapFrom = Math.max(range[0], VIIRS_START_INDEX);
    const overlap =
      overlapFrom <= range[1] ? aggregateHex(archive.table, grid, { ...opts, from: lb(overlapFrom), to: lb(range[1] + 1) }).totals : null;
    return { totals, overlap };
  }, [archive, range, noise, sensors, mask]);
  const totals = agg?.totals ?? null;
  const overlap = agg?.overlap ?? null;

  const calendar = useCalendar({ bbox: box, regionId: bbox ? regionId : null });
  const summary = useMemo(
    () => (calendar.data ? buildAreaSummary(calendar.data, { name, iso2: country?.id ?? null, bbox: box }) : null),
    [calendar.data, name, country, box],
  );

  const a = fromMonthIndex(range[0]);
  const b = fromMonthIndex(range[1]);
  const removed = totals ? totals.removedLowConfidence + totals.removedStatic : 0;
  const rawRatio = overlap && overlap.rawModis > 0 && overlap.rawViirs > 0 ? overlap.rawViirs / overlap.rawModis : null;
  const hexRatio = overlap && overlap.hexDaysModis > 0 && overlap.hexDaysViirs > 0 ? overlap.hexDaysViirs / overlap.hexDaysModis : null;

  return (
    <div className="grid gap-4">
      <div>
        <div className="mb-2.5 flex items-baseline justify-between gap-3">
          <h3 className="eyebrow m-0">{m.map.stats.title}</h3>
          <span className="num text-[11px] text-ink-dim">{m.map.stats.period(fmt.yearMonth(a.year, a.month), fmt.yearMonth(b.year, b.month))}</span>
        </div>
        {totals ? (
          totals.considered === 0 ? (
            <p className="m-0 text-[13px] text-ink-dim">{m.map.stats.empty}</p>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              <Stat label={m.map.stats.hexCells} value={fmt.int(totals.cellsAny)} tone="var(--el-amber)" />
              <Stat label={m.map.stats.hexDays} value={fmt.int(totals.hexDaysAny)} />
              <Stat label={m.map.stats.kept} value={fmt.int(totals.rawModis + totals.rawViirs)} />
              <Stat label={m.map.stats.removed} value={`${fmt.int(removed)} · ${fmt.pct(removed / totals.considered)}`} tone="var(--el-trust-low)" />
              <Stat label={m.map.stats.ratioRaw} value={rawRatio === null ? '—' : `×${fmt.dec(rawRatio, 1)}`} hint={m.map.stats.ratioHint} />
              <Stat label={m.map.stats.ratioHex} value={hexRatio === null ? '—' : `×${fmt.dec(hexRatio, 1)}`} hint={m.map.stats.ratioHint} tone="var(--el-mint)" />
            </div>
          )
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-[58px] !rounded-[12px]" />
            ))}
          </div>
        )}
      </div>

      <div>
        <h3 className="eyebrow m-0 mb-1">{m.map.stats.calendar}</h3>
        <p className="m-0 mb-2 text-[11.5px] leading-snug text-ink-dim">{m.map.stats.calendarHint}</p>
        {calendar.isPending ? (
          <Skeleton className="h-[96px] w-full !rounded-[10px]" />
        ) : calendar.isError ? (
          <p className="m-0 text-[13px] text-danger">{m.map.stats.error}</p>
        ) : summary ? (
          <>
            <AnnualChart summary={summary} />
            <dl className="m-0 mt-2.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12.5px]">
              <dt className="text-ink-dim">{m.map.stats.peak}</dt>
              <dd className="m-0 text-ink-muted">
                {summary.peakMonths.length ? fmt.list(summary.peakMonths.map((mo) => fmt.month(mo, 'short'))) : m.map.stats.none}
              </dd>
              <dt className="text-ink-dim">{m.map.stats.trend}</dt>
              <dd className="num m-0 text-ink-muted">
                {fmt.pct(summary.trendPctPerYear / 100, 1, true)} {m.map.stats.perYear}
              </dd>
              <dt className="text-ink-dim">{m.map.stats.anomalies}</dt>
              <dd className="m-0 text-ink-muted">
                {summary.anomalies.length
                  ? fmt.list(
                      summary.anomalies.slice(0, 3).map((x) => {
                        const [y, mo] = x.month.split('-').map(Number);
                        return fmt.yearMonth(y!, mo!);
                      }),
                    )
                  : m.map.stats.none}
              </dd>
            </dl>
          </>
        ) : (
          <p className="m-0 text-[13px] text-ink-dim">{m.map.stats.empty}</p>
        )}
      </div>

      <AiPanel summary={summary} />
    </div>
  );
}
