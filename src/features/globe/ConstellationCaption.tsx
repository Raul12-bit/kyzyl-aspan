import { useMemo, type ReactNode } from 'react';
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

/**
 * What each of the five real satellites is doing at this moment of the playback, worked out on the ground
 * from orbits, link physics and the weather forecast over the antennas (no satellite is changed): its link
 * and when that link will end, when data taken now will be on the ground, and which pass brings the news of
 * a fire in Kazakhstan first.
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
  const fmt = useMemo(
    () => ({
      int: new Intl.NumberFormat(locale),
      min: new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }),
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
      text = L.tdrs(stationName(station));
    } else if (action === ACTION.DOWNLINK) {
      kind = 'down';
      text = L.downlink(stationName(station), channel || '—');
    } else if (action === ACTION.BROADCAST) {
      kind = 'db';
      text = L.broadcast(stationName(broadcastAt));
    } else if (f?.[3] === 'outage' && outageName) {
      kind = 'blocked';
      text = L.blocked(outageName);
    } else {
      kind = 'store';
      text = L.store(queue >= 1000 ? fmt.gb.format(queue / 1000) : fmt.mb.format(queue));
    }
    let forecast: string | null = null;
    if (f) {
      const [drop, next, nextStation, reason, p] = f;
      if (action === ACTION.DOWNLINK) {
        forecast = drop === null ? L.steady : L.dropIn(fmt.min.format(drop), why(reason));
        if (drop !== null && p >= 0.2) forecast += ` · ${L.risk(fmt.pct.format(p))}`;
      } else {
        forecast = next === null ? L.noNext : L.nextIn(fmt.min.format(next), stationName(nextStation));
      }
    }
    let delivery: string | null = null;
    if (d) {
      const [ground, path, st, dumpOnly] = d;
      if (ground === null) delivery = L.groundLater;
      else delivery = ground === 0 ? L.groundNow(via(path, st)) : L.groundIn(fmt.min.format(ground), via(path, st));
      if (path === 'db' && dumpOnly !== null && dumpOnly > 0) delivery += ` · ${L.withoutDb(fmt.min.format(dumpOnly))}`;
    }
    const retired = sat.retired ? L.retired(fmt.date.format(new Date(sat.retired))) : null;
    return { key: sat.name, name: satLabel(sat.name), kind, text, forecast, delivery, retired };
  });

  const passes = data.region.passes
    .filter((p) => p.t_end >= index)
    .slice(0, 3)
    .map((p) => {
      const now = p.t_start <= index;
      const when = now ? L.regionNow : `${clock(p.t_start)} UTC`;
      const ground = p.ground_t === null ? L.later : clock(p.ground_t);
      let how = p.ground_t === null ? null : via(p.path, p.station);
      // With the Astana antenna: how long the same pass would have waited for the satellite's own station.
      if (how && p.path === 'db' && p.wait_dump_min !== null && p.wait_dump_min > 0) how += ` · ${L.withoutDb(fmt.min.format(p.wait_dump_min))}`;
      return { key: `${p.sat}-${p.t_start}`, now, text: L.regionPass(satLabel(data.satellites[p.sat]?.name), when, ground), via: how };
    });
  // The antenna only serves passes over Kazakhstan, so compare those (the planet-wide median barely moves).
  const kz = data.region.passes.filter((p) => p.wait_min !== null && p.wait_dump_min !== null);
  const median = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length ? (s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2) : null;
  };
  const kzNow = median(kz.map((p) => p.wait_dump_min!));
  const kzDb = median(kz.map((p) => p.wait_min!));

  const lat = data.summary.latency;
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

  return (
    <div className="lp-live" role="group" aria-label={L.title}>
      <div className="lp-live__head">
        <span className="lp-live__title">{L.title}</span>
        <span className="lp-live__clock">
          {fmt.time.format(at)} UTC
          {reducedMotion ? null : (
            <span data-slow={slow ? 'true' : 'false'}>
              {' · '}
              {slow ? L.slow(String(CONSTELLATION_SLOW)) : L.speed(String(CONSTELLATION_SPEED))}
            </span>
          )}
        </span>
      </div>
      <ul className="lp-live__sats">
        {rows.map((r) =>
          r ? (
            <li key={r.key} data-kind={r.kind}>
              <span className="lp-live__dot" aria-hidden />
              <span className="lp-live__name">{r.name}</span>
              <span className="lp-live__text">
                {r.retired ? <span className="lp-live__why lp-live__retired">{r.retired}</span> : null}
                {r.text}
                {r.forecast ? <span className="lp-live__why">{r.forecast}</span> : null}
                {r.delivery ? <span className="lp-live__why lp-live__ground">{r.delivery}</span> : null}
              </span>
            </li>
          ) : null,
        )}
      </ul>
      <div className="lp-live__region">
        <p className="lp-live__regionTitle">
          <span className="lp-live__flame" aria-hidden />
          {L.regionTitle}
        </p>
        {passes.length ? (
          <ul className="lp-live__passes">
            {passes.map((p) => (
              <li key={p.key} data-now={p.now ? 'true' : 'false'}>
                {p.text}
                {p.via ? <span className="lp-live__why">{p.via}</span> : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="lp-live__hint">{L.regionNone}</p>
        )}
        {data.db && kzNow !== null && kzDb !== null && kzDb < kzNow ? (
          <p className="lp-live__sum">{L.latencyDb(fmt.min.format(kzNow), fmt.min.format(kzDb))}</p>
        ) : null}
      </div>
      {lat.now.median_min !== null && lat.now.p90_min !== null ? (
        <p className="lp-live__sum">{L.latency(fmt.min.format(lat.now.median_min), fmt.min.format(lat.now.p90_min))}</p>
      ) : null}
      {detections !== undefined ? (
        <p className="lp-live__fires">
          <span className="lp-live__flame" aria-hidden />
          <span className="lp-live__firesText">{L.fires(fmt.int.format(detections))}</span>
        </p>
      ) : null}
      <div className="lp-live__actions">
        {onNextPass ? (
          <button type="button" className="lp-live__btn" onClick={onNextPass}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden>
              <circle cx="12" cy="12" r="8.5" />
              <path d="M4 14c4-1 12-5 16-9" strokeLinecap="round" />
              <circle cx="15.5" cy="8" r="1.6" fill="currentColor" />
            </svg>
            <span>{L.nextPass}</span>
          </button>
        ) : null}
        {toggles.map((t) => (
          <button
            key={t.id}
            type="button"
            className="lp-live__btn lp-live__storm"
            data-tone={t.id}
            aria-pressed={on[t.id]}
            data-busy={loading === t.id ? 'true' : 'false'}
            onClick={() => onToggle(t.id)}
            title={hints[t.id]}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden>
              {t.icon}
            </svg>
            <span>{t.label}</span>
            <span className="lp-live__switch" aria-hidden />
          </button>
        ))}
      </div>
      {(Object.keys(hints) as Scenario[])
        .filter((id) => on[id])
        .map((id) => (
          <p key={id} className="lp-live__hint">
            {hints[id]}
          </p>
        ))}
      <ul className="lp-live__legend" aria-hidden>
        <li data-kind="down">{L.legendDown}</li>
        <li data-kind="relay">{L.legendTdrs}</li>
        <li data-kind="db">{L.legendDb}</li>
      </ul>
    </div>
  );
}
