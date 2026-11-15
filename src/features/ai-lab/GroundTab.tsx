import { useMemo, useState } from 'react';
import {
  noiseReport,
  NRT_TARGET_MIN,
  type DangerClass,
  type Fuel,
  type SpreadForecast,
} from '@/domain/ai/ground';
import { useArchive } from '@/features/map/useFireData';
import { LabeledSlider } from '@/features/mission/Section';
import { useI18n } from '@/i18n';
import { useDebounced } from '@/lib/useDebounced';
import { Button, Card, Chip, Segmented, Skeleton } from '@/ui';
import { useGroundDelays, useGroundForecast, type ComputedOn, type WeatherOverrides } from './groundClient';
import { hexPoints } from './hex';

type PlaceId = 'semey' | 'north' | 'west' | 'ustyurt';
const PLACES: Record<PlaceId, { lat: number; lng: number; fuel: Fuel }> = {
  semey: { lat: 50.42, lng: 80.25, fuel: 'forest' },
  north: { lat: 53.28, lng: 69.39, fuel: 'grass' },
  west: { lat: 49.2, lng: 51.4, fuel: 'grass' },
  ustyurt: { lat: 44.2, lng: 56.1, fuel: 'grass' },
};

const DANGER_TONE: Record<DangerClass, string> = {
  low: 'var(--el-trust-high)',
  moderate: 'var(--el-ink-muted)',
  high: 'var(--el-amber)',
  veryHigh: 'var(--el-orange)',
  severe: 'var(--el-red)',
  extreme: 'var(--el-kyzyl-deep)',
  catastrophic: 'var(--el-kyzyl-deep)',
};

function SourceNote({ source, ms }: { source: ComputedOn; ms: number }) {
  const { m, fmt } = useI18n();
  const t = m.ai.lab.ai3;
  return (
    <p className="lab-source m-0" data-source={source}>
      <span aria-hidden className="lab-source__dot" />
      {source === 'server' ? t.computedServer(fmt.dec(ms, 2)) : t.computedBrowser}
    </p>
  );
}

/** The forecast in kilometres around the ignition: 24 h, 12 h and 6 h ellipses, wind arrow, scale. */
function SpreadMap({ forecast, at }: { forecast: SpreadForecast; at: { lat: number; lng: number } }) {
  const { m, fmt } = useI18n();
  const cos = Math.cos((at.lat * Math.PI) / 180);
  const toKm = (p: [number, number]) => [(p[0] - at.lng) * 111.32 * cos, (p[1] - at.lat) * 111.32] as const;
  const rings = forecast.horizons.map((h) => h.ring.map(toKm));
  const W = 400;
  const H = 300;
  const head = (forecast.headingDeg * Math.PI) / 180;
  const ax = Math.sin(head);
  const ay = Math.cos(head);
  // The wind arrow starts upwind of the ignition, a quarter of the burn's length away.
  const reach = Math.max(2, ...rings.flat().map(([x, y]) => Math.hypot(x, y)));
  const tail = [-ax * reach * 0.28, -ay * reach * 0.28] as const;
  // Frame the burnt area itself (plus the ignition and the arrow), not a box centred on the ignition.
  const pts = [[0, 0] as const, tail, ...rings.flat()];
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const pad = 34;
  const k = Math.min((W - 2 * pad) / Math.max(4, x1 - x0), (H - 2 * pad) / Math.max(4, y1 - y0));
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const sx = (x: number) => W / 2 + (x - cx) * k;
  const sy = (y: number) => H / 2 - (y - cy) * k;
  const nice = [1, 2, 5, 10, 20, 25, 50, 100, 200].find((v) => v * k >= 46) ?? 200;
  const fills = ['var(--el-ramp-4)', 'var(--el-ramp-3)', 'var(--el-ramp-2)'];
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="lab-spread"
      role="img"
      aria-label={m.ai.lab.ai3.spread.mapLabel}
    >
      <rect width={W} height={H} className="lab-spread__bg" />
      {[1, 2, 3, 4].map((r) => (
        <circle key={r} cx={sx(0)} cy={sy(0)} r={r * nice * k} className="lab-spread__ring" />
      ))}
      {[...rings].reverse().map((ring, i) => {
        const idx = rings.length - 1 - i;
        return (
          <path
            key={idx}
            d={
              ring.map(([x, y], j) => `${j ? 'L' : 'M'}${sx(x).toFixed(1)} ${sy(y).toFixed(1)}`).join('') +
              'Z'
            }
            fill={fills[idx] ?? fills[2]}
            className="lab-spread__area"
            data-h={idx}
          />
        );
      })}
      {/* wind: from the upwind side, pointing where the head fire runs */}
      <g className="lab-spread__wind">
        <line x1={sx(tail[0])} y1={sy(tail[1])} x2={sx(0) - ax * 26} y2={sy(0) + ay * 26} />
        <polygon
          points={`${sx(0) - ax * 18},${sy(0) + ay * 18} ${sx(0) - ax * 30 - ay * 5},${sy(0) + ay * 30 - ax * 5} ${sx(0) - ax * 30 + ay * 5},${sy(0) + ay * 30 + ax * 5}`}
        />
      </g>
      <polygon points={hexPoints(sx(0), sy(0), 6)} className="lab-spread__ignition" />
      {forecast.horizons.map((h, i) => {
        const r = rings[i]!;
        const tip = r.reduce((a, b) => (b[0] * ax + b[1] * ay > a[0] * ax + a[1] * ay ? b : a));
        return (
          <text key={h.hours} x={sx(tip[0]) + 4} y={sy(tip[1]) - 4} className="lab-spread__label">
            {m.ai.lab.ai3.spread.horizon(String(h.hours))}
          </text>
        );
      })}
      <g className="lab-spread__north">
        <line x1={W - 22} y1="40" x2={W - 22} y2="18" />
        <text x={W - 22} y="54">
          N
        </text>
      </g>
      <g className="lab-spread__scale">
        <line x1="18" y1={H - 18} x2={18 + nice * k} y2={H - 18} />
        <text x="18" y={H - 24}>
          {m.ai.lab.ai3.spread.km(fmt.int(nice))}
        </text>
      </g>
    </svg>
  );
}

function NoiseCard() {
  const { m, fmt } = useI18n();
  const t = m.ai.lab.ai3.noise;
  const { archive } = useArchive();
  const report = useMemo(() => (archive ? noiseReport(archive) : null), [archive]);
  if (!report) return <Skeleton className="h-48 w-full !rounded-panel" />;
  const parts = [
    { key: 'kept', n: report.kept, color: 'var(--el-ink-muted)', label: t.kept },
    { key: 'low', n: report.lowConfidence, color: 'var(--el-amber)', label: t.low },
    { key: 'static', n: report.staticSources, color: 'var(--el-red)', label: t.static },
  ];
  return (
    <Card className="grid content-start gap-4">
      <h3 className="lab-h3">{t.title}</h3>
      <div
        className="lab-stack"
        role="img"
        aria-label={parts.map((p) => `${p.label}: ${fmt.int(p.n)}`).join(', ')}
      >
        {parts.map((p) => (
          <span key={p.key} style={{ flexGrow: p.n, background: p.color }} />
        ))}
      </div>
      <ul className="lab-legend">
        {parts.map((p) => (
          <li key={p.key} style={{ ['--c' as string]: p.color }}>
            {p.label} · <span className="num">{fmt.int(p.n)}</span> ({fmt.pct(p.n / report.detections, 0)})
          </li>
        ))}
      </ul>
      <p className="m-0 text-[13px] text-ink-muted">{t.cells(fmt.int(report.staticCells))}</p>
      {report.score ? (
        <p className="m-0 text-[12.5px] leading-snug text-ink-dim">
          {t.score(
            fmt.pct(report.score.precision, 0),
            fmt.pct(report.score.recall, 0),
            fmt.pct(report.score.firesKept, 0),
          )}
        </p>
      ) : null}
    </Card>
  );
}

function SpreadCard() {
  const { m, fmt } = useI18n();
  const t = m.ai.lab.ai3.spread;
  const [place, setPlace] = useState<PlaceId>('north');
  const [fuel, setFuel] = useState<Fuel>(PLACES.north.fuel);
  const [over, setOver] = useState<WeatherOverrides>({});
  const p = PLACES[place];
  // The weather model's default hour is 08:00 UTC: early afternoon in Kazakhstan.
  const localHour = (((8 + p.lng / 15) % 24) + 24) % 24;
  const live = useMemo(
    () => ({ lat: p.lat, lng: p.lng, fuel, weather: over, localHour }),
    [p.lat, p.lng, fuel, over, localHour],
  );
  const query = useDebounced(live, 180);
  const q = useGroundForecast(query);
  const r = q.data;

  const choose = (id: PlaceId) => {
    setPlace(id);
    setFuel(PLACES[id].fuel);
    setOver({});
  };
  const set = (key: keyof WeatherOverrides) => (v: number) => setOver((o) => ({ ...o, [key]: v }));
  const value = (key: keyof WeatherOverrides) => over[key] ?? r?.weather[key] ?? 0;

  return (
    <Card className="grid content-start gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h3 className="lab-h3">{t.title}</h3>
        {r ? <SourceNote source={r.source} ms={r.computedMs} /> : null}
      </div>
      <div className="grid gap-3">
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t.place}>
          {(Object.keys(PLACES) as PlaceId[]).map((id) => (
            <Chip key={id} pressed={place === id} onClick={() => choose(id)}>
              {t.places[id]}
            </Chip>
          ))}
        </div>
        <Segmented<Fuel>
          label={t.fuel}
          value={fuel}
          onChange={setFuel}
          className="w-full sm:w-fit [&>button]:flex-1"
          options={[
            { value: 'grass', label: t.fuels.grass },
            { value: 'forest', label: t.fuels.forest },
          ]}
        />
      </div>

      {r ? (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
          <div className="grid content-start gap-4">
            <LabeledSlider
              label={t.wind}
              min={0}
              max={90}
              value={Math.round(value('windKmh'))}
              onChange={set('windKmh')}
              formatValue={(v) => fmt.int(v)}
            />
            <LabeledSlider
              label={t.windFrom}
              min={0}
              max={355}
              step={5}
              value={Math.round(value('windFromDeg') / 5) * 5}
              onChange={set('windFromDeg')}
              formatValue={(v) => `${fmt.int(v)}°`}
            />
            <LabeledSlider
              label={t.temp}
              min={-10}
              max={45}
              value={Math.round(value('tempC'))}
              onChange={set('tempC')}
              formatValue={(v) => fmt.int(v)}
            />
            <LabeledSlider
              label={t.rh}
              min={5}
              max={100}
              value={Math.round(value('rh'))}
              onChange={set('rh')}
              formatValue={(v) => fmt.int(v)}
            />
            {fuel === 'forest' ? (
              <LabeledSlider
                label={t.drought}
                min={0}
                max={10}
                step={0.5}
                value={value('drought')}
                onChange={set('drought')}
                formatValue={(v) => fmt.dec(v, 1)}
              />
            ) : null}
            <Button
              variant="quiet"
              size="sm"
              icon="reset"
              className="justify-self-start"
              disabled={!Object.keys(over).length}
              onClick={() => setOver({})}
            >
              {t.reset}
            </Button>
            <p className="m-0 text-[12.5px] text-ink-dim">
              {t.airMass}: {t.airMasses[r.weather.airMass]} · {t.pressure(fmt.int(r.weather.pressureHpa))}
            </p>
          </div>

          <div className="grid content-start gap-4">
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-2">
              <span className="lab-priority" style={{ ['--tone' as string]: DANGER_TONE[r.forecast.danger] }}>
                {t.danger[r.forecast.danger]}
              </span>
              <span className="num text-[13px] text-ink-muted">
                {t.index[r.forecast.fuel]} {fmt.dec(r.forecast.index, 1)}
              </span>
            </div>
            <dl className="lab-kv">
              <div>
                <dt>{t.ros}</dt>
                <dd className="num">{t.kmh(fmt.dec(r.forecast.rosKmh, 2))}</dd>
              </div>
              <div>
                <dt>{t.shape(fmt.dec(r.forecast.lengthToBreadth, 1))}</dt>
                <dd className="num">{t.heading(fmt.int(r.forecast.headingDeg))}</dd>
              </div>
            </dl>
            <div className="flex flex-wrap gap-2">
              {r.forecast.warnings.length ? (
                r.forecast.warnings.map((w) => (
                  <span key={w} className="lab-warning">
                    {t.warnings[w]}
                  </span>
                ))
              ) : (
                <span className="text-[12.5px] text-ink-dim">{t.noWarnings}</span>
              )}
            </div>
            <SpreadMap forecast={r.forecast} at={p} />
            <div className="lab-scroll">
              <table className="lab-table lab-table--compact">
                <thead>
                  <tr>
                    <th scope="col" />
                    <th scope="col">{t.head}</th>
                    <th scope="col">{t.area}</th>
                    <th scope="col">{t.perimeter}</th>
                  </tr>
                </thead>
                <tbody>
                  {r.forecast.horizons.map((h) => (
                    <tr key={h.hours}>
                      <th scope="row">{t.horizon(String(h.hours))}</th>
                      <td className="num">{t.km(fmt.dec(h.headKm, 1))}</td>
                      <td className="num">{t.ha(fmt.int(h.areaHa))}</td>
                      <td className="num">{t.km(fmt.dec(h.perimeterKm, 0))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : (
        <Skeleton className="h-80 w-full !rounded-panel" />
      )}
      <p className="m-0 text-[12px] leading-snug text-ink-dim">{t.caveat}</p>
    </Card>
  );
}

function DelaysCard() {
  const { m, fmt } = useI18n();
  const t = m.ai.lab.ai3.delays;
  const q = useGroundDelays(null, 2);
  const mins = (v: number | null) => (v === null ? '—' : t.min(fmt.dec(v, v < 10 ? 1 : 0)));
  return (
    <Card className="grid content-start gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h3 className="lab-h3">{t.title}</h3>
        {q.data ? <SourceNote source={q.data.source} ms={q.data.computedMs} /> : null}
      </div>
      {q.data ? (
        <div className="lab-scroll">
          <table className="lab-table lab-table--compact">
            <thead>
              <tr>
                <th scope="col">{t.stream}</th>
                <th scope="col">{t.mean}</th>
                <th scope="col">{t.p90}</th>
                <th scope="col">{t.max}</th>
                <th scope="col" />
              </tr>
            </thead>
            <tbody>
              {q.data.streams.map((s) => (
                <tr key={s.satelliteId}>
                  <th scope="row">
                    {s.satellite} <span className="text-ink-dim">· {s.sensor}</span>
                  </th>
                  <td className="num">{mins(s.meanMin)}</td>
                  <td className="num">{mins(s.p90Min)}</td>
                  <td className="num">{mins(s.maxMin)}</td>
                  <td>
                    <span className="lab-badge" data-status={s.status}>
                      {t.status[s.status]}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Skeleton className="h-40 w-full !rounded-panel" />
      )}
      <p className="m-0 text-[12px] text-ink-dim">
        {t.target} ({fmt.int(NRT_TARGET_MIN)} min)
      </p>
    </Card>
  );
}

/** Tab "AI #3": what the ground segment computes. */
export default function GroundTab({ serverOnline }: { serverOnline: boolean }) {
  const { m } = useI18n();
  const t = m.ai.lab.ai3;
  return (
    <section aria-labelledby="ai3-title" className="grid gap-8">
      <header className="max-w-[760px]">
        <p className="eyebrow m-0 !text-kyzyl">{t.kicker}</p>
        <h2 id="ai3-title" className="display m-0 mt-3 text-[clamp(1.4rem,1.6vw+0.9rem,2.1rem)] text-ink">
          {t.title}
        </h2>
        <p className="m-0 mt-4 max-w-[62ch] text-[15px] leading-relaxed text-ink-muted">{t.body}</p>
        {!serverOnline ? <p className="m-0 mt-3 text-[12.5px] text-ink-dim">{t.computedBrowser}</p> : null}
      </header>
      <SpreadCard />
      <div className="grid gap-4 xl:grid-cols-2">
        <NoiseCard />
        <DelaysCard />
      </div>
      <p className="lab-note m-0 text-[13px] leading-relaxed text-ink-muted">{t.floods}</p>
    </section>
  );
}
