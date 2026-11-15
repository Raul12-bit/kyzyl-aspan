import { useEffect, useMemo, useState } from 'react';
import { publishFact } from '@/features/assistant/assistantStore';
import { compassIndex, projectAhead, windFit, type FireEvent } from '@/domain/ai/temporal';
import { liveSat, LIVE_SATS, type BBox4, type LiveRow } from '@/domain/live/satellites';
import type { Pass } from '@/domain/live/sgp4';
import { useCountries } from '@/features/geo/countries';
import { feedUpdated, nearestWind, useNow, type LiveHours, type LiveWind } from '@/features/live/api';
import { useLiveAnalysis, type AnalysisRegion } from '@/features/live/useLiveAnalysis';
import { useI18n } from '@/i18n';
import { Card, Segmented, Skeleton } from '@/ui';
import { hexPoints } from './hex';

const HOURS: Record<'h24' | 'h48' | 'd7', LiveHours> = { h24: 24, h48: 48, d7: 168 };
const AHEAD_H = 12;
const SNPP = 2;

const hhmm = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'UTC',
});
const hms = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
  timeZone: 'UTC',
});
const ddmm = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: '2-digit', timeZone: 'UTC' });
const clockOf = (unixSec: number) => hhmm.format(new Date(unixSec * 1000));
const dateOf = (unixSec: number) => ddmm.format(new Date(unixSec * 1000)).replace('/', '.');
const dayOf = (unixSec: number) => Math.floor(unixSec / 86_400);
/** The moment the spread happened: halfway between the first and the last pass. */
const eventTime = (e: FireEvent) => (e.passes[0]!.t + e.passes[e.passes.length - 1]!.t) / 2;

/* ------------------------------------------------------------------ projection */

function projector(bbox: BBox4, width: number) {
  const [w, s, e, n] = bbox;
  const k = Math.cos((((s + n) / 2) * Math.PI) / 180);
  const height = (width * (n - s)) / ((e - w) * k);
  return {
    width,
    height,
    x: (lng: number) => ((lng - w) / (e - w)) * width,
    y: (lat: number) => ((n - lat) / (n - s)) * height,
  };
}

function polysPath(
  polys: readonly (readonly (readonly number[])[])[],
  p: ReturnType<typeof projector>,
): string {
  let d = '';
  for (const rings of polys)
    for (const ring of rings) {
      for (let i = 0; i < ring.length; i += 2)
        d += `${i ? 'L' : 'M'}${p.x(ring[i]!).toFixed(1)} ${p.y(ring[i + 1]!).toFixed(1)}`;
      d += 'Z';
    }
  return d;
}

/* ------------------------------------------------------------------ timeline */

function PassTimeline({
  passes,
  rows,
  now,
  hours,
}: {
  passes: Map<number, Pass[]>;
  rows: readonly LiveRow[];
  now: number;
  hours: LiveHours;
}) {
  const { m } = useI18n();
  const t = m.ai.lab.bridge;
  const W = 760;
  const L = 78;
  const R = 10;
  const ROW = 21;
  const top = 6;
  const from = now - hours * 3600;
  const to = now + AHEAD_H * 3600;
  const x = (u: number) => L + ((u - from) / (to - from)) * (W - L - R);
  const H = top + LIVE_SATS.length * ROW + 22;
  // Detections per satellite pass (FIRMS groups them by overpass minute): one dot per pass, area ∝ count.
  const dots = useMemo(() => {
    const out: { sat: number; t: number; n: number }[] = [];
    let cur: { sat: number; t: number; n: number } | null = null;
    const bySat = [...rows].sort((a, b) => a[2] - b[2] || a[3] - b[3]);
    for (const r of bySat) {
      if (cur && cur.sat === r[2] && r[3] - cur.t <= 900) cur.n += 1;
      else {
        cur = { sat: r[2], t: r[3], n: 1 };
        out.push(cur);
      }
    }
    return out;
  }, [rows]);
  const step = hours > 48 ? 24 : 6;
  const ticks: number[] = [];
  for (let u = Math.ceil(from / (step * 3600)) * step * 3600; u <= to; u += step * 3600) ticks.push(u);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="lab-tlx" role="img" aria-label={t.timeline}>
      {ticks.map((u) => (
        <g key={u}>
          <line x1={x(u)} x2={x(u)} y1={top} y2={H - 18} className="lab-tlx__grid" />
          <text x={x(u)} y={H - 5} className="lab-tlx__tick" textAnchor="middle">
            {hours > 48 ? new Date(u * 1000).toISOString().slice(5, 10) : clockOf(u)}
          </text>
        </g>
      ))}
      {LIVE_SATS.map((s, i) => {
        const y = top + i * ROW;
        const dead = s.code === SNPP && !dots.some((d) => d.sat === SNPP);
        return (
          <g key={s.code} opacity={dead ? 0.38 : 1}>
            <title>{dead ? `${s.name} · ${t.snppStopped}` : `${s.name} · ${s.sensor}`}</title>
            <polygon
              points={hexPoints(9, y + ROW / 2, 4)}
              fill={s.sensor === 'VIIRS' ? s.color : 'none'}
              stroke={s.color}
              strokeWidth="1.3"
            />
            <text x={18} y={y + ROW / 2 + 4} className="lab-tlx__name">
              {s.name}
            </text>
            <line x1={L} x2={W - R} y1={y + ROW / 2} y2={y + ROW / 2} className="lab-tlx__lane" />
            {(passes.get(s.code) ?? [])
              .filter((p) => p.tEnd >= from && p.tStart <= to)
              .map((p) => (
                <rect
                  key={p.tStart}
                  x={x(Math.max(from, p.tStart))}
                  y={y + ROW / 2 - 4}
                  width={Math.max(2.5, x(Math.min(to, p.tEnd)) - x(Math.max(from, p.tStart)))}
                  height="8"
                  rx="2"
                  fill={p.tStart > now ? 'none' : s.color}
                  fillOpacity={p.day ? 0.55 : 0.28}
                  stroke={s.color}
                  strokeOpacity={p.tStart > now ? 0.8 : 0}
                  strokeDasharray={p.tStart > now ? '2 2' : undefined}
                >
                  <title>{`${s.name} · ${clockOf(p.tMid)} UTC`}</title>
                </rect>
              ))}
            {dots
              .filter((d) => d.sat === s.code && d.t >= from)
              .map((d) => (
                <circle
                  key={d.t}
                  cx={x(d.t)}
                  cy={y + ROW / 2}
                  r={
                    hours > 48
                      ? Math.min(5, 1.5 + Math.sqrt(d.n) * 0.6)
                      : Math.min(7, 2 + Math.sqrt(d.n) * 0.9)
                  }
                  className="lab-tlx__dot"
                >
                  <title>{`${s.name} · ${clockOf(d.t)} UTC · ${t.points(String(d.n))}`}</title>
                </circle>
              ))}
          </g>
        );
      })}
      <line x1={x(now)} x2={x(now)} y1={top - 4} y2={H - 18} className="lab-tlx__now" />
      <text x={x(now) + 4} y={top + 4} className="lab-tlx__nowText">
        {t.now}
      </text>
    </svg>
  );
}

/* ------------------------------------------------------------------ map */

function ageClass(nowSec: number, t: number): 'fresh' | 'mid' | 'old' {
  const h = (nowSec - t) / 3600;
  return h < 3 ? 'fresh' : h < 12 ? 'mid' : 'old';
}

function BridgeMap({
  bbox,
  rows,
  events,
  winds,
  now,
  selected,
  onSelect,
}: {
  bbox: BBox4;
  rows: readonly LiveRow[];
  events: readonly FireEvent[];
  winds: readonly LiveWind[] | undefined;
  now: number;
  selected: number | null;
  onSelect: (id: number) => void;
}) {
  const { m } = useI18n();
  const t = m.ai.lab.bridge;
  const countries = useCountries();
  const p = useMemo(() => projector(bbox, 720), [bbox]);
  const land = useMemo(() => {
    if (!countries.data) return { all: '', kz: '' };
    const [w, s, e, n] = bbox;
    const near = countries.data.countries.filter(
      (c) => c.bbox[0] < e + 5 && c.bbox[2] > w - 5 && c.bbox[1] < n + 5 && c.bbox[3] > s - 5,
    );
    return {
      all: near.map((c) => polysPath(c.polys, p)).join(''),
      kz: near
        .filter((c) => c.id === 'KZ')
        .map((c) => polysPath(c.polys, p))
        .join(''),
    };
  }, [countries.data, bbox, p]);
  const moving = events.filter((e) => e.vector?.significant).slice(0, 12);

  return (
    <svg
      viewBox={`0 0 ${p.width} ${p.height.toFixed(0)}`}
      className="lab-world lab-bridge__map"
      role="img"
      aria-label={t.mapLabel}
    >
      <defs>
        <marker
          id="br-arrow"
          viewBox="0 0 10 10"
          refX="8"
          refY="5"
          markerWidth="5"
          markerHeight="5"
          orient="auto-start-reverse"
        >
          <path d="M0 0 10 5 0 10z" fill="var(--el-gold)" />
        </marker>
        <marker
          id="br-wind"
          viewBox="0 0 10 10"
          refX="8"
          refY="5"
          markerWidth="4"
          markerHeight="4"
          orient="auto-start-reverse"
        >
          <path d="M0 0 10 5 0 10z" fill="var(--el-link-rf)" />
        </marker>
      </defs>
      <rect width={p.width} height={p.height} className="lab-world__sea" />
      <path d={land.all} className="lab-world__land" />
      {land.kz ? <path d={land.kz} className="lab-bridge__kz" /> : null}
      {rows.map((r, i) => {
        const age = ageClass(now, r[3]);
        return (
          <polygon
            key={i}
            points={hexPoints(p.x(r[0]), p.y(r[1]), age === 'fresh' ? 2.6 : 2.1)}
            className="lab-bridge__hot"
            data-age={age}
          />
        );
      })}
      {moving.map((e) => {
        const first = e.passes[0]!;
        const ahead = projectAhead(e, 3);
        const w = nearestWind(winds, e.lat, e.lng, eventTime(e));
        const wx = p.x(e.lng);
        const wy = p.y(e.lat);
        const wl = w && w.windKmh >= 5 ? Math.min(26, 8 + w.windKmh * 0.6) : 0;
        const wd = w ? (((w.windFromDeg + 180) % 360) * Math.PI) / 180 : 0;
        return (
          <g
            key={e.id}
            className="lab-bridge__event"
            data-on={selected === e.id ? 'true' : 'false'}
            onClick={() => onSelect(e.id)}
          >
            {wl ? (
              <line
                x1={wx}
                y1={wy}
                x2={wx + Math.sin(wd) * wl}
                y2={wy - Math.cos(wd) * wl}
                className="lab-bridge__wind"
                markerEnd="url(#br-wind)"
              />
            ) : null}
            <line
              x1={p.x(first.lng)}
              y1={p.y(first.lat)}
              x2={wx}
              y2={wy}
              className="lab-bridge__vec"
              markerEnd="url(#br-arrow)"
            />
            {ahead ? (
              <line x1={wx} y1={wy} x2={p.x(ahead.lng)} y2={p.y(ahead.lat)} className="lab-bridge__ahead" />
            ) : null}
            <circle cx={wx} cy={wy} r="9" className="lab-bridge__ring" />
            <text x={wx + 11} y={wy - 8} className="lab-bridge__label">
              {e.id}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/* ------------------------------------------------------------------ events */

function EventList({
  events,
  winds,
  selected,
  onSelect,
}: {
  events: readonly FireEvent[];
  winds: readonly LiveWind[] | undefined;
  selected: number | null;
  onSelect: (id: number) => void;
}) {
  const { m, fmt } = useI18n();
  const t = m.ai.lab.bridge;
  const dir = (deg: number) => t.compass[compassIndex(deg)] ?? '';
  return (
    <ol className="lab-events">
      {events.slice(0, 8).map((e) => {
        const w = nearestWind(winds, e.lat, e.lng, eventTime(e));
        const fit = windFit(e.vector, w);
        return (
          <li key={e.id} data-on={selected === e.id ? 'true' : 'false'}>
            <button type="button" onClick={() => onSelect(e.id)} className="lab-events__row">
              <span className="lab-events__id num">{e.id}</span>
              <span className="lab-events__passes">
                {e.passes.slice(-4).map((ps, i, list) => {
                  const newDay = i === 0 || dayOf(list[i - 1]!.t) !== dayOf(ps.t);
                  return (
                    <span
                      key={`${ps.sat}-${ps.t}`}
                      className="lab-events__pass"
                      title={`${liveSat(ps.sat).name} · ${dateOf(ps.t)} ${clockOf(ps.t)} UTC · ${t.points(String(ps.n))}`}
                    >
                      {i ? <span className="lab-events__to">→</span> : null}
                      <i style={{ background: liveSat(ps.sat).color }} />
                      <span className="num">
                        {newDay ? <span className="text-ink-dim">{dateOf(ps.t)} </span> : null}
                        {clockOf(ps.t)}
                      </span>
                    </span>
                  );
                })}
              </span>
              <span className="lab-events__vec">
                {e.persistent ? (
                  <span className="text-ink-dim">{t.persistent}</span>
                ) : e.vector?.significant ? (
                  <>
                    <span
                      className="lab-events__arrow"
                      style={{ transform: `rotate(${e.vector.bearingDeg}deg)` }}
                      aria-hidden
                    >
                      ↑
                    </span>
                    {t.moving(fmt.dec(e.vector.speedKmh, 1), dir(e.vector.bearingDeg))}
                  </>
                ) : (
                  <span className="text-ink-dim">{e.passes.length > 1 ? t.still : t.single}</span>
                )}
              </span>
              <span className="lab-events__wind" data-fit={fit ?? 'none'}>
                {w ? t.windNow(fmt.int(w.windKmh), dir(w.windFromDeg)) : ''}
                {fit ? ` · ${t.wind[fit]}` : ''}
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

/* ------------------------------------------------------------------ tab */

/** Tab "Temporal bridge": live NASA FIRMS hot spots + real orbits → fire events, spread vectors, wind check. */
export default function BridgeTab() {
  const { m, fmt } = useI18n();
  const t = m.ai.lab.bridge;
  const [region, setRegion] = useState<AnalysisRegion>('kz');
  // A week by default: November is quiet, and the bridge needs fires seen on several passes.
  const [win, setWin] = useState<keyof typeof HOURS>('d7');
  const hours = HOURS[win];
  const live = useLiveAnalysis(region, hours);
  const nowMs = useNow(1000);
  const now = nowMs / 1000;
  const [selected, setSelected] = useState<number | null>(null);
  const updated = feedUpdated(live.fires.data);

  const over = useMemo(() => {
    let current: { code: number; p: Pass } | null = null;
    let next: { code: number; p: Pass } | null = null;
    for (const [code, list] of live.passes) {
      if (code === SNPP) continue;
      for (const p of list) {
        if (p.tStart <= now && p.tEnd >= now) current = { code, p };
        else if (p.tStart > now && (!next || p.tStart < next.p.tStart)) next = { code, p };
      }
    }
    return { current, next };
    // Re-evaluated every second through `now`.
  }, [live.passes, now]);

  const fact = useMemo(() => {
    if (!live.fires.data) return null;
    const moving = live.events.filter((e) => e.vector?.significant);
    const top = moving[0];
    const w = top ? nearestWind(live.wind.data?.points, top.lat, top.lng, eventTime(top)) : null;
    const next = over.current
      ? `${liveSat(over.current.code).name} is over the region now`
      : over.next
        ? `next pass ${liveSat(over.next.code).name} at ${clockOf(over.next.p.tStart)} UTC`
        : '';
    return [
      `Temporal Bridge (${region === 'kz' ? 'Kazakhstan' : 'Central Asia'}, last ${hours} h): ${live.rows.length} live NASA FIRMS hot spots → ${live.events.length} fire events, ${moving.length} with a significant spread vector.`,
      top?.vector
        ? ` Top moving fire: ${top.vector.speedKmh.toFixed(1)} km/h towards ${Math.round(top.vector.bearingDeg)}°, seen on ${top.passes.length} passes (${top.passes
            .slice(-4)
            .map((p) => `${liveSat(p.sat).name} ${dateOf(p.t)} ${clockOf(p.t)}`)
            .join(
              ', ',
            )} UTC)${w ? `; wind then ${Math.round(w.windKmh)} km/h from ${Math.round(w.windFromDeg)}° (${windFit(top.vector, w) ?? 'n/a'})` : ''}.`
        : '',
      next ? ` ${next}.` : '',
    ].join('');
    // `over` changes each second through `now`; the fact only needs the pass names.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    live.fires.data,
    live.events,
    live.rows.length,
    live.wind.data,
    region,
    hours,
    over.current?.code,
    over.next?.code,
  ]);
  useEffect(() => publishFact('bridge', fact), [fact]);
  useEffect(() => () => publishFact('bridge', null), []);

  return (
    <section aria-labelledby="bridge-title" className="grid gap-6">
      <header className="max-w-[780px]">
        <p className="eyebrow m-0 !text-kyzyl">{t.kicker}</p>
        <h2 id="bridge-title" className="display m-0 mt-3 text-[clamp(1.4rem,1.6vw+0.9rem,2.1rem)] text-ink">
          {t.title}
        </h2>
        <p className="m-0 mt-3 max-w-[64ch] text-[15px] leading-relaxed text-ink-muted">{t.body}</p>
      </header>

      <div className="lab-livebar">
        <span className="lab-live" aria-live="off">
          <span className="lab-live__dot" aria-hidden />
          {t.live} <span className="num">{hms.format(new Date(nowMs))} UTC</span>
        </span>
        {updated ? (
          <span className="lab-livebar__meta">
            {t.updated(fmt.int(Math.max(0, (nowMs - updated) / 60_000)))}
          </span>
        ) : null}
        {over.current ? (
          <span className="lab-livebar__meta lab-livebar__over">
            {t.overNow(liveSat(over.current.code).name)}
          </span>
        ) : over.next ? (
          <span className="lab-livebar__meta">
            {t.nextPass(liveSat(over.next.code).name, `${clockOf(over.next.p.tStart)} UTC`)}
          </span>
        ) : null}
        <span className="lab-livebar__controls">
          <Segmented<AnalysisRegion>
            label={t.regions.kz}
            value={region}
            onChange={(v) => {
              setRegion(v);
              setSelected(null);
            }}
            options={[
              { value: 'kz', label: t.regions.kz },
              { value: 'ca', label: t.regions.ca },
            ]}
          />
          <Segmented<keyof typeof HOURS>
            label={t.win.h48}
            value={win}
            onChange={(v) => {
              setWin(v);
              setSelected(null);
            }}
            options={[
              { value: 'h24', label: t.win.h24 },
              { value: 'h48', label: t.win.h48 },
              { value: 'd7', label: t.win.d7 },
            ]}
          />
        </span>
      </div>

      {live.fires.isPending ? (
        <div className="grid gap-3">
          <p className="m-0 text-[13px] text-ink-dim" role="status">
            {t.loading}
          </p>
          <Skeleton className="h-80 w-full !rounded-panel" />
        </div>
      ) : live.fires.isError && !live.fires.data ? (
        <p className="m-0 text-[13px] text-danger" role="status">
          {t.error}
        </p>
      ) : (
        <>
          <Card className="grid gap-2 !p-4">
            <h3 className="lab-h3">{t.timeline}</h3>
            <PassTimeline passes={live.passes} rows={live.rows} now={now} hours={hours} />
          </Card>
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
            <Card className="grid content-start gap-2 !p-4">
              <h3 className="lab-h3">{t.map}</h3>
              <BridgeMap
                bbox={live.bbox}
                rows={live.rows}
                events={live.events}
                winds={live.wind.data?.points}
                now={now}
                selected={selected}
                onSelect={setSelected}
              />
              <ul className="lab-legend">
                <li style={{ ['--c' as string]: 'var(--el-ramp-6)' }}>{t.age.fresh}</li>
                <li style={{ ['--c' as string]: 'var(--el-ramp-4)' }}>{t.age.mid}</li>
                <li style={{ ['--c' as string]: 'var(--el-ramp-2)' }}>{t.age.old}</li>
                <li style={{ ['--c' as string]: 'var(--el-gold)' }}>{t.vector}</li>
                <li style={{ ['--c' as string]: 'var(--el-link-rf)' }}>{t.windLegend}</li>
              </ul>
            </Card>
            <Card className="grid content-start gap-2 !p-4">
              <h3 className="lab-h3">
                {t.events} <span className="num text-ink-dim">· {fmt.int(live.events.length)}</span>
              </h3>
              {live.events.length ? (
                <EventList
                  events={live.events}
                  winds={live.wind.data?.points}
                  selected={selected}
                  onSelect={setSelected}
                />
              ) : (
                <p className="m-0 text-[13px] text-ink-dim">{t.none}</p>
              )}
            </Card>
          </div>
          <p className="m-0 text-[12px] leading-snug text-ink-dim">{t.honest}</p>
        </>
      )}
    </section>
  );
}
