import { useEffect, useMemo, useRef, useState } from 'react';
import {
  RELAYS,
  satelliteName,
  simulateLinks,
  STEP_SEC,
  type SimResult,
  type StepRecord,
} from '@/domain/ai/link';
import { STATIONS } from '@/domain/downlink';
import { FLEET, subSatellitePoint } from '@/domain/orbit';
import { useCountries } from '@/features/geo/countries';
import { useHeliosAvailable } from '@/features/helios/api';
import { prefersReducedMotion } from '@/features/intro/introStore';
import { CueSection } from '@/features/mission/CueSection';
import { DownlinkSection } from '@/features/mission/DownlinkSection';
import { DeliverySection, PhysicsSection } from '@/features/mission/HeliosSections';
import { Meter } from '@/features/mission/Section';
import { useI18n } from '@/i18n';
import { Button, Card, Chip, Segmented, Slider, Switch } from '@/ui';
import { hexPoints } from './hex';

const MINUTES = 180;
const N = (MINUTES * 60) / STEP_SEC;
/** Fire alerts AI #1 raises during the window (minutes); the visitor can add more at the playhead. */
const DEFAULT_ALERTS = [40, 95, 150];

/* ------------------------------------------------------------------ projection */

const X = (lng: number) => (lng + 180) * 2;
const Y = (lat: number) => (90 - lat) * 2;

function countriesPath(polys: readonly (readonly (readonly number[])[])[]): string {
  let d = '';
  for (const rings of polys) {
    for (const ring of rings) {
      for (let i = 0; i < ring.length; i += 2)
        d += `${i === 0 ? 'M' : 'L'}${X(ring[i]!).toFixed(1)} ${Y(ring[i + 1]!).toFixed(1)}`;
      d += 'Z';
    }
  }
  return d;
}

/** Ground track as polylines, split where it jumps across the antimeridian. */
function trackPaths(steps: readonly StepRecord[], from: number, to: number): string[] {
  const out: string[] = [];
  let cur = '';
  let prev: number | null = null;
  for (let k = from; k <= to && k < steps.length; k++) {
    const p = steps[k]!.sub;
    if (prev !== null && Math.abs(p.lng - prev) > 180) {
      out.push(cur);
      cur = '';
    }
    cur += `${cur ? 'L' : 'M'}${X(p.lng).toFixed(1)} ${Y(p.lat).toFixed(1)}`;
    prev = p.lng;
  }
  if (cur) out.push(cur);
  return out;
}

const ACTION_COLOR: Record<StepRecord['action'], string> = {
  'laser-relay': 'var(--el-link-laser)',
  'laser-neighbour': '#ffd28a',
  ka: 'var(--el-link-rf)',
  x: '#a9efe0',
  acquire: 'rgb(238 233 224 / 0.28)',
  store: 'rgb(238 233 224 / 0.07)',
};

function targetPoint(step: StepRecord): { lat: number; lng: number } | null {
  if (!step.target) return null;
  const relay = RELAYS.find((r) => r.id === step.target);
  if (relay) return { lat: 0, lng: relay.lng };
  const st = STATIONS.find((s) => s.id === step.target);
  if (st) return st.location;
  const sat = FLEET.find((s) => s.id === step.target);
  return sat ? subSatellitePoint(sat, step.tSec) : null;
}

function targetName(id: string | null): string {
  if (!id) return '';
  return (
    RELAYS.find((r) => r.id === id)?.name ?? STATIONS.find((s) => s.id === id)?.name ?? satelliteName(id)
  );
}

/* ------------------------------------------------------------------ map */

function WorldTrack({ sim, k, storm, kp }: { sim: SimResult; k: number; storm: string | null; kp: number }) {
  const { m } = useI18n();
  const countries = useCountries();
  const land = useMemo(
    () => (countries.data ? countries.data.countries.map((c) => countriesPath(c.polys)).join('') : ''),
    [countries.data],
  );
  const step = sim.steps[k]!;
  const past = useMemo(() => trackPaths(sim.steps, 0, k), [sim.steps, k]);
  const future = useMemo(() => trackPaths(sim.steps, k, sim.steps.length - 1), [sim.steps, k]);
  const target = step.action === 'store' ? null : targetPoint(step);
  const linkColor = step.action === 'acquire' ? 'rgb(238 233 224 / 0.45)' : ACTION_COLOR[step.action];
  const neighbours = FLEET.filter((s) => s.id !== sim.satellite.id).map((s) => ({
    id: s.id,
    p: subSatellitePoint(s, step.tSec),
  }));
  const alertDots = sim.alerts
    .filter((a) => a.atStep <= k)
    .map((a) => ({ k: a.atStep, p: sim.steps[a.atStep]!.sub }));

  return (
    <svg viewBox="0 0 720 360" className="lab-world" role="img" aria-label={m.ai.lab.ai2.mapLabel}>
      <rect width="720" height="360" className="lab-world__sea" />
      <path d={land} className="lab-world__land" />
      {[-60, -30, 0, 30, 60].map((lat) => (
        <line key={lat} x1="0" x2="720" y1={Y(lat)} y2={Y(lat)} className="lab-world__grid" />
      ))}
      {future.map((d, i) => (
        <path key={`f${i}`} d={d} className="lab-world__track lab-world__track--future" />
      ))}
      {past.map((d, i) => (
        <path key={`p${i}`} d={d} className="lab-world__track" />
      ))}

      {STATIONS.map((st) => {
        const stormy = st.id === storm;
        const scint = kp >= 7 && Math.abs(st.location.lat) >= 55;
        return (
          <g
            key={st.id}
            className="lab-world__station"
            data-storm={stormy ? 'true' : 'false'}
            data-scint={scint ? 'true' : 'false'}
          >
            {stormy ? (
              <circle cx={X(st.location.lng)} cy={Y(st.location.lat)} r="11" className="lab-world__storm" />
            ) : null}
            <polygon points={hexPoints(X(st.location.lng), Y(st.location.lat), 4.6)} />
          </g>
        );
      })}
      {RELAYS.map((r) => (
        <g key={r.id} className="lab-world__relay">
          <polygon points={hexPoints(X(r.lng), Y(0), 5.2)} />
          <text x={X(r.lng)} y={Y(0) + 15}>
            {r.name}
          </text>
        </g>
      ))}

      {target ? (
        <line
          x1={X(step.sub.lng)}
          y1={Y(step.sub.lat)}
          x2={X(target.lng)}
          y2={Y(target.lat)}
          stroke={linkColor}
          className="lab-world__link"
          data-acquire={step.action === 'acquire' ? 'true' : 'false'}
        />
      ) : null}
      {neighbours.map((n) => (
        <circle key={n.id} cx={X(n.p.lng)} cy={Y(n.p.lat)} r="2.6" className="lab-world__neighbour" />
      ))}
      {alertDots.map((a) => (
        <polygon key={a.k} points={hexPoints(X(a.p.lng), Y(a.p.lat), 4)} className="lab-world__alert" />
      ))}
      <g className="lab-world__sat">
        <circle cx={X(step.sub.lng)} cy={Y(step.sub.lat)} r="9" className="lab-world__halo" />
        <polygon points={hexPoints(X(step.sub.lng), Y(step.sub.lat), 5)} />
      </g>
    </svg>
  );
}

/* ------------------------------------------------------------------ timeline */

function Timeline({ sim, label, k }: { sim: SimResult; label: string; k: number }) {
  return (
    <div className="lab-tl">
      <span className="lab-tl__label">{label}</span>
      <svg viewBox={`0 0 ${N} 10`} preserveAspectRatio="none" className="lab-tl__bar" aria-hidden>
        {sim.steps.map((s) => (
          <rect key={s.k} x={s.k} y="0" width="1.02" height="10" fill={ACTION_COLOR[s.action]} />
        ))}
        {sim.steps
          .filter((s) => s.handoff || s.dropped)
          .map((s) => (
            <rect
              key={`m${s.k}`}
              x={s.k}
              y="0"
              width="1.4"
              height="10"
              className={s.dropped ? 'lab-tl__drop' : 'lab-tl__handoff'}
            />
          ))}
        {sim.alerts.map((a) => (
          <rect key={`a${a.atStep}`} x={a.atStep} y="0" width="1.6" height="10" className="lab-tl__alert" />
        ))}
        <rect x={k} y="0" width="0.9" height="10" className="lab-tl__head" />
      </svg>
    </div>
  );
}

/* ------------------------------------------------------------------ the tab */

function Lab() {
  const { m, fmt } = useI18n();
  const t = m.ai.lab.ai2;
  const [satId, setSatId] = useState('terra');
  const [storm, setStorm] = useState<string | null>(null);
  const [geomag, setGeomag] = useState(false);
  const [userAlerts, setUserAlerts] = useState<number[]>(DEFAULT_ALERTS);
  const [k, setK] = useState(80);
  const [playing, setPlaying] = useState(false);
  const kp = geomag ? 8 : 2;

  const [ai, reactive] = useMemo(() => {
    const opts = { satelliteId: satId, minutes: MINUTES, stormStation: storm, kp, alertsAtMin: userAlerts };
    return [
      simulateLinks({ ...opts, policy: 'ai' }),
      simulateLinks({ ...opts, policy: 'reactive' }),
    ] as const;
  }, [satId, storm, kp, userAlerts]);

  // Playback: ~10 steps (5 orbit minutes) per second, paused at the end; never with reduced motion.
  const raf = useRef(0);
  useEffect(() => {
    if (!playing) return;
    let last = performance.now();
    let acc = 0;
    const tick = (now: number) => {
      acc += ((now - last) / 1000) * 10;
      last = now;
      if (acc >= 1) {
        const add = Math.floor(acc);
        acc -= add;
        setK((v) => {
          const next = Math.min(N - 1, v + add);
          if (next === N - 1) setPlaying(false);
          return next;
        });
      }
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [playing]);

  const step = ai.steps[k]!;
  const minute = (k * STEP_SEC) / 60;
  const secs = (v: number | null) => (v === null ? '—' : v < 120 ? t.seconds(fmt.int(v)) : fmt.duration(v));
  const mins = (v: number | null) => (v === null ? '—' : fmt.duration(v * 60));

  const summary: { label: string; ai: string; re: string }[] = [
    { label: t.summary.drops, ai: fmt.int(ai.stats.drops), re: fmt.int(reactive.stats.drops) },
    { label: t.summary.handoffs, ai: fmt.int(ai.stats.handoffs), re: fmt.int(reactive.stats.handoffs) },
    { label: t.summary.alert, ai: secs(ai.stats.alertMedianSec), re: secs(reactive.stats.alertMedianSec) },
    { label: t.summary.alertMax, ai: secs(ai.stats.alertMaxSec), re: secs(reactive.stats.alertMaxSec) },
    { label: t.summary.age, ai: mins(ai.stats.p90DelayMin), re: mins(reactive.stats.p90DelayMin) },
  ];

  return (
    <section aria-labelledby="ai2-title" className="lab-grid">
      <div className="lab-side">
        <p className="eyebrow m-0 !text-kyzyl">{t.kicker}</p>
        <h2 id="ai2-title" className="display m-0 mt-3 text-[clamp(1.4rem,1.6vw+0.9rem,2.1rem)] text-ink">
          {t.title}
        </h2>
        <p className="m-0 mt-4 max-w-[46ch] text-[15px] leading-relaxed text-ink-muted">{t.body}</p>
        <ol className="lab-stages">
          {t.stages.map((s) => (
            <li key={s.title}>
              <b>{s.title}</b>
              <span>{s.body}</span>
            </li>
          ))}
        </ol>
        <p className="m-0 mt-6 text-[12px] leading-snug text-ink-dim">{t.assumptions}</p>
      </div>

      <div className="grid min-w-0 gap-4">
        <Card className="grid gap-4">
          <div className="grid gap-3">
            <Segmented<string>
              label={t.satellite}
              value={satId}
              onChange={(v) => {
                setSatId(v);
                setUserAlerts(DEFAULT_ALERTS);
              }}
              className="w-full [&>button]:flex-1"
              options={FLEET.map((s) => ({ value: s.id, label: s.name.replace('Suomi ', 'S-') }))}
            />
            <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t.storm}>
              <span className="mr-1 text-[12px] text-ink-dim">{t.storm}</span>
              <Chip pressed={storm === null} onClick={() => setStorm(null)}>
                {t.stormNone}
              </Chip>
              {STATIONS.map((st) => (
                <Chip key={st.id} pressed={storm === st.id} onClick={() => setStorm(st.id)}>
                  {st.name}
                </Chip>
              ))}
            </div>
            <label className="flex items-center gap-3 text-[13px] text-ink-muted">
              <Switch checked={geomag} onChange={setGeomag} label={t.geomag} />
              {t.geomag}
            </label>
          </div>

          <WorldTrack sim={ai} k={k} storm={storm} kp={kp} />

          <div className="grid gap-2">
            <Timeline sim={ai} label={t.rows.ai} k={k} />
            <Timeline sim={reactive} label={t.rows.reactive} k={k} />
            <ul className="lab-legend lab-legend--links">
              {(['laser-relay', 'laser-neighbour', 'ka', 'x', 'acquire', 'store'] as const).map((a) => (
                <li key={a} style={{ ['--c' as string]: ACTION_COLOR[a] }}>
                  {t.actions[a]}
                </li>
              ))}
              <li data-k="handoff">{t.legend.handoff}</li>
              <li data-k="drop">{t.legend.drop}</li>
              <li data-k="alert">{t.legend.alert}</li>
            </ul>
          </div>

          <div className="grid items-center gap-3 sm:grid-cols-[auto_minmax(0,1fr)_auto]">
            <Button
              variant="secondary"
              size="sm"
              icon={playing ? 'pause' : 'play'}
              disabled={prefersReducedMotion()}
              onClick={() => {
                if (!playing && k >= N - 1) setK(0);
                setPlaying((p) => !p);
              }}
            >
              {playing ? t.pause : t.play}
            </Button>
            <Slider
              min={0}
              max={N - 1}
              value={k}
              onChange={(v) => {
                setPlaying(false);
                setK(v);
              }}
              label={t.playhead}
              formatValue={(v) => fmt.clock(v * STEP_SEC)}
            />
            <span className="num text-[13px] text-ink">{fmt.clock(step.tSec)}</span>
          </div>
        </Card>

        <div className="grid gap-4 xl:grid-cols-2">
          <Card className="grid content-start gap-3" aria-live="polite">
            <p className="m-0 text-[12px] text-ink-dim">
              {t.rows.ai} · {fmt.clock(step.tSec)}
            </p>
            <p className="m-0 flex items-center gap-2 text-[17px] text-ink">
              <span className="lab-swatch" style={{ background: ACTION_COLOR[step.action] }} aria-hidden />
              {t.actions[step.action]}
              {step.target && step.action !== 'store' ? (
                <span className="text-ink-muted">· {targetName(step.target)}</span>
              ) : null}
            </p>
            {step.pLoss !== null ? (
              <div className="grid gap-1.5">
                <div className="flex justify-between gap-3 text-[12px]">
                  <span className="text-ink-dim">{t.now.loss}</span>
                  <span className="num text-ink">{fmt.pct(step.pLoss, 0)}</span>
                </div>
                <Meter
                  value={step.pLoss}
                  color={step.pLoss >= 0.5 ? 'var(--el-red)' : 'var(--el-link-rf)'}
                  label={t.now.loss}
                />
              </div>
            ) : null}
            <dl className="lab-kv">
              {step.minutesToLos !== null ? (
                <div>
                  <dt>{t.now.los}</dt>
                  <dd className="num">{fmt.duration(step.minutesToLos * 60)}</dd>
                </div>
              ) : null}
              <div>
                <dt>{t.now.queue}</dt>
                <dd className="num">{fmt.dec(step.queueMB / 1000, 2)} GB</dd>
              </div>
            </dl>
            {step.handoff ? <p className="m-0 text-[12.5px] text-gold-soft">{t.now.handoff}</p> : null}
            {step.dropped ? <p className="m-0 text-[12.5px] text-danger">{t.now.dropped}</p> : null}
            <Button
              variant="primary"
              size="sm"
              icon="flame"
              className="mt-1 justify-self-start"
              onClick={() =>
                setUserAlerts((list) =>
                  list.includes(minute) ? list : [...list, minute].sort((a, b) => a - b),
                )
              }
            >
              {t.alertNow}
            </Button>
          </Card>

          <Card className="grid content-start gap-3">
            <h3 className="lab-h3">{t.alerts.title}</h3>
            <ul className="lab-alerts">
              {ai.alerts.map((a, i) => {
                const re = reactive.alerts[i];
                return (
                  <li key={a.atStep}>
                    <span className="num text-[12px] text-ink-dim">
                      {t.alerts.raised(fmt.clock(a.atStep * STEP_SEC))}
                    </span>
                    <span className="text-[13px] text-ink">
                      {t.rows.ai}:{' '}
                      {a.latencySec !== null && a.via
                        ? t.alerts.delivered(secs(a.latencySec), t.alerts.via[a.via])
                        : t.alerts.waiting}
                    </span>
                    {re ? (
                      <span className="text-[12.5px] text-ink-muted">
                        {t.rows.reactive}:{' '}
                        {re.latencySec !== null && re.via
                          ? t.alerts.delivered(secs(re.latencySec), t.alerts.via[re.via])
                          : t.alerts.waiting}
                      </span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </Card>
        </div>

        <Card className="lab-compare">
          <div className="lab-scroll">
            <table className="lab-table lab-table--compact">
              <thead>
                <tr>
                  <th scope="col" />
                  <th scope="col">{t.rows.ai}</th>
                  <th scope="col">{t.rows.reactive}</th>
                </tr>
              </thead>
              <tbody>
                {summary.map((r) => (
                  <tr key={r.label}>
                    <th scope="row">{r.label}</th>
                    <td className="num text-gold-soft">{r.ai}</td>
                    <td className="num">{r.re}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </section>
  );
}

/** Tab "AI #2": the link manager on three hours of orbit, then the concept sections it builds on. */
export default function LinksTab() {
  const helios = useHeliosAvailable();
  return (
    <div className="grid gap-14">
      <Lab />
      <DownlinkSection />
      <CueSection />
      {helios ? (
        <>
          <PhysicsSection />
          <DeliverySection />
        </>
      ) : null}
    </div>
  );
}
