import { useAppParams } from '@/app/useAppParams';
import type { BBox } from '@/data/types';
import { useI18n } from '@/i18n';
import { Skeleton } from '@/ui';
import { useHeliosArea, useHeliosAvailable } from './api';
import { PRIORITY_COLOR } from './heliosLayers';

const WORLD: BBox = [-180, -85, 180, 85];
const DNA_COLORS: Record<string, string> = {
  wildfire: 'var(--el-kyzyl)',
  agricultural: 'var(--el-amber)',
  industrial: '#b9c6e4',
  sporadic: 'var(--el-ink-dim)',
};

function Tile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="min-w-0 rounded-[12px] border border-line bg-[rgb(255_255_255/0.02)] px-3 py-2.5">
      <p className="m-0 line-clamp-2 min-h-[2lh] text-[11.5px] leading-tight text-ink-dim">{label}</p>
      <p className="stat-value m-0 mt-0.5 truncate !text-[18px]" style={tone ? { color: tone } : undefined}>
        {value}
      </p>
      {sub ? <p className="num m-0 truncate text-[11px] text-ink-dim">{sub}</p> : null}
    </div>
  );
}

/** HELIOS block of the area panel: AI #3 forecast, Fire DNA mix, season shift, blind spots, live alerts. */
export function HeliosAreaCard() {
  const { m, fmt } = useI18n();
  const available = useHeliosAvailable();
  const { bbox, regionId } = useAppParams();
  const area = useHeliosArea(bbox ?? WORLD, bbox ? regionId : null, available);
  if (!available) return null;
  const t = m.helios.area;
  const d = area.data;
  const h1 = d?.forecast?.by_horizon['1'];
  const dnaTotal = d?.fire_dna ? Object.values(d.fire_dna).reduce((a, b) => a + b, 0) : 0;
  const alertsTotal = d?.alerts ? Object.values(d.alerts).reduce((a, b) => a + b, 0) : 0;

  return (
    <section
      aria-labelledby="helios-area-title"
      className="rounded-[16px] border border-[rgb(255_181_71/0.28)] bg-[linear-gradient(160deg,rgb(255_181_71/0.07),transparent_70%)] p-4"
    >
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h3 id="helios-area-title" className="eyebrow m-0 !text-amber">
          {t.title}
        </h3>
        {d?.forecast ? <span className="num text-[11px] text-ink-dim">{d.forecast.as_of_week}</span> : null}
      </div>
      {area.isPending ? (
        <div className="grid grid-cols-2 gap-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-[58px] !rounded-[12px]" />
          ))}
        </div>
      ) : area.isError || !d ? (
        <p className="m-0 text-[12.5px] text-ink-dim">{m.helios.mission.offline}</p>
      ) : !d.covered ? (
        <p className="m-0 text-[12.5px] text-ink-dim">{t.notCovered}</p>
      ) : (
        <div className="grid gap-3">
          <div className="grid grid-cols-2 gap-2">
            {h1 ? (
              <>
                <Tile
                  label={t.nextWeek}
                  value={t.upTo(fmt.pct(h1.max, h1.max < 0.1 ? 1 : 0))}
                  sub={t.typical(fmt.pct(h1.climatology_mean, 1))}
                  tone="var(--el-amber)"
                />
                <Tile
                  label={t.hotCells}
                  value={fmt.int(h1.cells_over_10pct)}
                  tone={h1.cells_over_10pct ? 'var(--el-kyzyl)' : undefined}
                />
              </>
            ) : null}
            <Tile
              label={t.alerts}
              value={fmt.int(alertsTotal)}
              sub={
                d.alerts
                  ? Object.entries(d.alerts)
                      .map(([k, v]) => `${m.helios.priorities[k as 'HIGH'] ?? k} ${v}`)
                      .join(' · ')
                  : undefined
              }
              tone={d.alerts?.CRITICAL ? PRIORITY_COLOR.CRITICAL() : undefined}
            />
            <Tile label={t.statics} value={fmt.int(d.static_sources ?? 0)} />
          </div>

          {d.fire_dna && dnaTotal > 0 ? (
            <div>
              <p className="m-0 mb-1.5 text-[12px] text-ink-dim">{t.dna}</p>
              <div className="flex h-2.5 w-full overflow-hidden rounded-full" role="img" aria-label={t.dna}>
                {Object.entries(d.fire_dna).map(([k, v]) => (
                  <span
                    key={k}
                    style={{
                      width: `${(v / dnaTotal) * 100}%`,
                      background: DNA_COLORS[k] ?? 'var(--el-ink-dim)',
                    }}
                  />
                ))}
              </div>
              <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11.5px] text-ink-muted">
                {Object.entries(d.fire_dna).map(([k, v]) => (
                  <span key={k} className="flex items-center gap-1.5">
                    <span
                      className="h-2 w-2 rounded-full"
                      style={{ background: DNA_COLORS[k] ?? 'var(--el-ink-dim)' }}
                    />
                    {t.dnaClasses[k as keyof typeof t.dnaClasses] ?? k} · {fmt.pct(v / dnaTotal, 0)}
                  </span>
                ))}
              </div>
            </div>
          ) : null}

          {d.season_shift || d.season_shift_region ? (
            <p className="m-0 text-[12.5px] leading-snug text-ink-muted">
              <span className="text-ink-dim">{t.shift}: </span>
              {d.season_shift
                ? `${t.shiftValue(fmt.dec(d.season_shift.median_days_per_decade, 1))} · ${t.shiftCells(fmt.int(d.season_shift.cells), fmt.int(d.season_shift.significant_cells))}`
                : d.season_shift_region?.peak_doy != null
                  ? t.shiftValue(fmt.dec(d.season_shift_region.peak_doy, 1))
                  : '—'}
            </p>
          ) : null}
          {d.blind_cells ? (
            <p className="m-0 text-[12.5px] text-trust-medium">{t.blind(fmt.int(d.blind_cells))}</p>
          ) : null}
          {d.model_quality ? (
            <p className="num m-0 text-[11px] leading-snug text-ink-dim">
              {m.helios.qualityLatest(
                fmt.dec(d.model_quality.roc_auc, 3),
                fmt.dec(d.model_quality.pr_auc, 2),
                fmt.dec(d.model_quality.baseline_pr_auc, 2),
              )}
            </p>
          ) : null}
        </div>
      )}
    </section>
  );
}
