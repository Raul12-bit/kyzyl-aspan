import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { publishFact } from '@/features/assistant/assistantStore';
import { ACTION, type ConstellationResponse, type DeliveryPath, type DropReason } from '@/features/helios/api';
import { useI18n } from '@/i18n';
import { satLabel, shortStation } from './constellationText';
import { CONSTELLATION_SLOW, CONSTELLATION_SPEED } from './EarthScene';

type Kind = 'down' | 'relay' | 'db' | 'store' | 'blocked';
export type Scenario = 'storm' | 'outage' | 'db';

export interface ConstellationCaptionProps {
  data: ConstellationResponse;
  index: number;
  slow: boolean;
  reducedMotion: boolean;
  /** Fresh NASA FIRMS detections behind the fire glow (real backend only). */
  detections?: number;
  /** Station the server put the storm over (it picks the one where a storm changes the most). */
  stormStation: string | null;
  /** Which scenarios are switched on, and which one is still being computed. */
  on: Record<Scenario, boolean>;
  loading: Scenario | null;
  onToggle: (s: Scenario) => void;
  /** Jumps to the next pass over Kazakhstan; absent when the window has none. */
  onNextPass?: () => void;
}

const COLLAPSE_KEY = 'kyzylaspan.liveCollapsed';

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === '1';
  } catch {
    return false;
  }
}

function writeCollapsed(v: boolean) {
  try {
    localStorage.setItem(COLLAPSE_KEY, v ? '1' : '0');
  } catch {
    /* storage unavailable — the panel just forgets */
  }
}

/**
 * The five real satellites at this moment of the playback, one line each: the link it is on (or what it holds on
 * board) and when data taken now reach the ground. The long explanations live in each row's tooltip, so the panel
 * stays small next to the planet; it also folds down to its title line.
 */
export function ConstellationCaption({
  data,
  index,
  slow,
  reducedMotion,
  detections,
  stormStation,
  on,
  loading,
  onToggle,
  onNextPass,
}: ConstellationCaptionProps) {
  const { m, locale } = useI18n();
  const L = m.landing.live;
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const fmt = useMemo(
    () => ({
      int: new Intl.NumberFormat(locale),
      min: new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }),
      pct: new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }),
      mb: new Intl.NumberFormat(locale, { style: 'unit', unit: 'megabyte', unitDisplay: 'short', maximumFractionDigits: 0 }),
      gb: new Intl.NumberFormat(locale, { style: 'unit', unit: 'gigabyte', unitDisplay: 'short', maximumFractionDigits: 1 }),
      time: new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }),
      date: new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }),
    }),
    [locale],
  );

  const t0 = Date.parse(data.start);
  const stepMs = data.step_s * 1000;
  const at = new Date(t0 + index * stepMs);
  const clock = (step: number) => fmt.time.format(new Date(t0 + step * stepMs));
  const stationName = (j: number) => {
    const st = data.stations[j];
    if (!st) return '';
    return st.id === 'ASTANA_DB' ? L.astana : shortStation(st.name);
  };
  const outageName = data.outage ? stationName(data.stations.findIndex((s) => s.id === data.outage)) : '';
  const via = (path: DeliveryPath, station: number) =>
    path === 'db' ? L.viaDb(stationName(station)) : path === 'tdrs' ? L.viaTdrs : L.viaDump(stationName(station));
  const why = (r: DropReason) =>
    r === 'weather' ? L.whyWeather : r === 'margin' ? L.whyMargin : r === 'outage' ? L.whyOutage : L.whyLos;

  const rows = data.satellites.map((sat, i) => {
    const pick = <T,>(list: T[] | undefined): T | undefined => list?.[Math.min(index, list.length - 1)];
    const s = pick(data.states[i]);
    if (!s) return null;
    const f = pick(data.forecast[i]);
    const d = pick(data.delivery[i]);
    const [action, broadcastAt, station, , , queue, channel] = s;
    let kind: Kind;
    let text: string;
    if (action === ACTION.DOWNLINK && channel === 'TDRS') {
      kind = 'relay';
      text = `TDRS → ${stationName(station)}`;
    } else if (action === ACTION.DOWNLINK) {
      kind = 'down';
      text = `${stationName(station)} · ${channel || '—'}`;
    } else if (action === ACTION.BROADCAST) {
      kind = 'db';
      text = L.viaDb(stationName(broadcastAt));
    } else if (f?.[3] === 'outage' && outageName) {
      kind = 'blocked';
      text = L.outage(outageName);
    } else {
      kind = 'store';
      text = L.onBoard(queue >= 1000 ? fmt.gb.format(queue / 1000) : fmt.mb.format(queue));
    }
    // The full story goes to the tooltip: why the link ends, when the next one comes, how the data travel.
    const details: string[] = [];
    if (f) {
      const [drop, next, nextStation, reason, p] = f;
      if (action === ACTION.DOWNLINK) {
        let line = drop === null ? L.steady : L.dropIn(fmt.min.format(drop), why(reason));
        if (drop !== null && p >= 0.2) line += ` · ${L.risk(fmt.pct.format(p))}`;
        details.push(line);
      } else {
        details.push(next === null ? L.noNext : L.nextIn(fmt.min.format(next), stationName(nextStation)));
      }
    }
    let ground: string | null = null;
    if (d) {
      const [g, path, st] = d;
      ground = g === null ? L.later : g === 0 ? L.now : L.inMin(fmt.min.format(g));
      details.push(g === null ? L.groundLater : g === 0 ? L.groundNow(via(path, st)) : L.groundIn(fmt.min.format(g), via(path, st)));
    }
    const retired = sat.retired ? L.retired(fmt.date.format(new Date(sat.retired))) : null;
    if (retired) details.unshift(retired);
    return { key: sat.name, name: satLabel(sat.name), kind, text, ground, retired: !!retired, title: details.join('\n') };
  });

  const next = data.region.passes.find((p) => p.t_end >= index) ?? null;
  const region = next
    ? {
        text: L.regionPass(
          satLabel(data.satellites[next.sat]?.name),
          next.t_start <= index ? L.regionNow : clock(next.t_start),
          next.ground_t === null ? L.later : clock(next.ground_t),
        ),
        title: next.ground_t === null ? '' : via(next.path, next.station),
        now: next.t_start <= index,
      }
    : null;

  // For the AI guide: what the five satellites are doing in this playback (refreshed every 10 s, not every frame).
  const factRef = useRef('');
  factRef.current =
    `Home-page satellites (real orbits and ground stations, playback at ${fmt.time.format(at)} UTC): ` +
    rows
      .filter((r): r is NonNullable<typeof r> => r !== null)
      .map((r) => `${r.name} — ${r.retired ? 'no near-real-time data since 2 Nov 2026' : `${r.text}, data taken now on the ground ${r.ground ?? 'later'}`}`)
      .join('; ') +
    (region ? `. Kazakhstan: ${region.text}.` : '.');
  useEffect(() => {
    publishFact('constellation', factRef.current);
    const id = window.setInterval(() => publishFact('constellation', factRef.current), 10_000);
    return () => {
      window.clearInterval(id);
      publishFact('constellation', null);
    };
  }, []);

  const toggles: { id: Scenario; label: string; icon: ReactNode }[] = [
    {
      id: 'storm',
      label: on.storm && stormStation ? L.storm(stormStation) : L.stormAny,
      icon: (
        <>
          <path d="M7 16.5H6a4 4 0 0 1-.6-7.96A6 6 0 0 1 17 7.5h.5a4.5 4.5 0 0 1 .9 8.91" strokeLinecap="round" />
          <path d="m12.5 12-2.5 4.5h4L11.5 21" strokeLinecap="round" strokeLinejoin="round" />
        </>
      ),
    },
    {
      id: 'outage',
      label: L.outage('McMurdo'),
      icon: (
        <>
          <path d="M12 3v4M5 21h14M8 21l4-14 4 14" strokeLinecap="round" strokeLinejoin="round" />
          <path d="m4 4 16 16" strokeLinecap="round" />
        </>
      ),
    },
    {
      id: 'db',
      label: L.db,
      icon: (
        <>
          <path d="M4 10a8 8 0 0 1 16 0" strokeLinecap="round" />
          <path d="M8 10a4 4 0 0 1 8 0" strokeLinecap="round" />
          <path d="M12 10v11M8 21h8" strokeLinecap="round" />
        </>
      ),
    },
  ];
  const hints: Record<Scenario, string> = { storm: L.stormHint, outage: L.outageHint, db: L.dbHint };
  const toggleCollapsed = () => {
    setCollapsed((c) => {
      writeCollapsed(!c);
      return !c;
    });
  };

  return (
    <div className="lp-live" role="group" aria-label={L.title} data-collapsed={collapsed ? 'true' : 'false'}>
      <div className="lp-live__head">
        <span className="lp-live__title">{L.title}</span>
        {collapsed ? (
          <span className="lp-live__mini" aria-hidden>
            {rows.map((r) => (r ? <span key={r.key} className="lp-live__dot" data-kind={r.kind} /> : null))}
          </span>
        ) : null}
        <span className="lp-live__clock">
          {fmt.time.format(at)} UTC
          {reducedMotion ? null : (
            <span
              className="lp-live__speed"
              data-slow={slow ? 'true' : 'false'}
              title={slow ? L.slow(String(CONSTELLATION_SLOW)) : L.speed(String(CONSTELLATION_SPEED))}
            >
              ×{slow ? CONSTELLATION_SLOW : CONSTELLATION_SPEED}
            </span>
          )}
        </span>
        <button
          type="button"
          className="lp-live__fold"
          aria-expanded={!collapsed}
          aria-label={collapsed ? L.expand : L.collapse}
          title={collapsed ? L.expand : L.collapse}
          onClick={toggleCollapsed}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden>
            <path d={collapsed ? 'm6 15 6-6 6 6' : 'm6 9 6 6 6-6'} strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>

      {collapsed ? null : (
        <>
          <p className="lp-live__col" aria-hidden>
            {L.groundCol}
          </p>
          <ul className="lp-live__sats">
            {rows.map((r) =>
              r ? (
                <li key={r.key} data-kind={r.kind} data-retired={r.retired ? 'true' : 'false'} title={r.title}>
                  <span className="lp-live__dot" data-kind={r.kind} aria-hidden />
                  <span className="lp-live__name">{r.name}</span>
                  <span className="lp-live__text">{r.retired ? '—' : r.text}</span>
                  <span className="lp-live__eta">{r.retired ? L.stopped : r.ground ?? '—'}</span>
                </li>
              ) : null,
            )}
          </ul>
          <p className="lp-live__region" data-now={region?.now ? 'true' : 'false'} title={region?.title || undefined}>
            <span className="lp-live__flame" aria-hidden />
            <span className="lp-live__regionText">
              <b>{L.regionTitle}</b> {region ? region.text : L.regionNone}
            </span>
          </p>
          <div className="lp-live__actions">
            {onNextPass ? (
              <button type="button" className="lp-live__btn" onClick={onNextPass} aria-label={L.nextPass} title={L.nextPass}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden>
                  <circle cx="12" cy="12" r="8.5" />
                  <path d="M4 14c4-1 12-5 16-9" strokeLinecap="round" />
                  <circle cx="15.5" cy="8" r="1.6" fill="currentColor" />
                </svg>
              </button>
            ) : null}
            {toggles.map((t) => (
              <button
                key={t.id}
                type="button"
                className="lp-live__btn lp-live__storm"
                data-tone={t.id}
                aria-pressed={on[t.id]}
                aria-label={t.label}
                data-busy={loading === t.id ? 'true' : 'false'}
                onClick={() => onToggle(t.id)}
                title={`${t.label}\n${hints[t.id]}`}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden>
                  {t.icon}
                </svg>
              </button>
            ))}
            {detections !== undefined ? (
              <span className="lp-live__fires" title={L.fires(fmt.int.format(detections))}>
                <span className="lp-live__flame" aria-hidden />
                {fmt.int.format(detections)}
              </span>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}
