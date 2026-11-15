import { useMemo } from 'react';
import type { ConstellationResponse, ConstellationState } from '@/features/helios/api';
import { useI18n } from '@/i18n';
import { satLabel, shortStation } from './constellationText';
import { CONSTELLATION_SLOW, CONSTELLATION_SPEED } from './EarthScene';

type Kind = 'down' | 'laser' | 'radio' | 'store';
const KIND_BY_ACTION: Record<number, Kind> = { 0: 'store', 1: 'down', 2: 'laser', 3: 'down', 4: 'radio' };

export interface ConstellationCaptionProps {
  data: ConstellationResponse;
  index: number;
  slow: boolean;
  reducedMotion: boolean;
  /** Fresh NASA FIRMS detections behind the fire glow (real backend only). */
  detections?: number;
  /** Station the server put the storm over (it picks the one where a storm changes the most). */
  stormStation: string | null;
  stormOn: boolean;
  stormLoading: boolean;
  onStorm: () => void;
  /** Jumps to the next laser handoff; absent when the window has none. */
  onNextHandoff?: () => void;
}

/**
 * What each of the three satellites is doing at this moment of the real-orbit playback: dumping data to a
 * station, handing it to a neighbour by laser before the link drops (and why), relaying, sending only
 * alerts over the backup S-band radio, or holding data on board.
 */
export function ConstellationCaption({
  data,
  index,
  slow,
  reducedMotion,
  detections,
  stormStation,
  stormOn,
  stormLoading,
  onStorm,
  onNextHandoff,
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
    }),
    [locale],
  );

  const at = new Date(Date.parse(data.start) + index * data.step_s * 1000);
  const rows = data.satellites.map((sat, i) => {
    const list = data.states[i] ?? [];
    const s: ConstellationState | undefined = list[Math.min(index, list.length - 1)];
    if (!s) return null;
    const [action, partner, station, p, ttl, queue, ch] = s;
    const st = station >= 0 ? shortStation(data.stations[station]?.name) : '';
    const mate = partner >= 0 ? satLabel(data.satellites[partner]?.name) : '';
    let text: string;
    let why: string | null = null;
    if (action === 1) text = L.downlink(st, ch === 'OPT' ? L.optical : ch || '—');
    else if (action === 3) text = L.relay(mate, st);
    else if (action === 2) {
      text = L.handoff(mate);
      why = station < 0 ? L.whyNone : p >= 0.5 ? L.whyAi2(fmt.pct.format(p)) : L.whyLos(fmt.min.format(ttl));
    } else if (action === 4) text = L.alerts(st);
    else text = L.store(queue >= 1000 ? fmt.gb.format(queue / 1000) : fmt.mb.format(queue));
    return { name: satLabel(sat.name), kind: KIND_BY_ACTION[action] ?? 'store', text, why };
  });

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
        {rows.map((r, i) =>
          r ? (
            <li key={data.satellites[i]!.name} data-kind={r.kind}>
              <span className="lp-live__dot" aria-hidden />
              <span className="lp-live__name">{r.name}</span>
              <span className="lp-live__text">
                {r.text}
                {r.why ? <span className="lp-live__why">{r.why}</span> : null}
              </span>
            </li>
          ) : null,
        )}
      </ul>
      {detections !== undefined ? (
        <p className="lp-live__fires">
          <span className="lp-live__flame" aria-hidden />
          <span className="lp-live__firesText">{L.fires(fmt.int.format(detections))}</span>
        </p>
      ) : null}
      <div className="lp-live__actions">
        {onNextHandoff ? (
          <button type="button" className="lp-live__btn" onClick={onNextHandoff}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden>
              <circle cx="5" cy="12" r="2.2" />
              <circle cx="19" cy="12" r="2.2" />
              <path d="M7.5 12h9" strokeDasharray="2 2.2" strokeLinecap="round" />
              <path d="m13.5 9 3 3-3 3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span>{L.nextHandoff}</span>
          </button>
        ) : null}
        <button
          type="button"
          className="lp-live__btn lp-live__storm"
          aria-pressed={stormOn}
          data-busy={stormLoading ? 'true' : 'false'}
          onClick={onStorm}
          title={L.stormHint}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden>
            <path d="M7 16.5H6a4 4 0 0 1-.6-7.96A6 6 0 0 1 17 7.5h.5a4.5 4.5 0 0 1 .9 8.91" strokeLinecap="round" />
            <path d="m12.5 12-2.5 4.5h4L11.5 21" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span>{stormOn && stormStation ? L.storm(stormStation) : L.stormAny}</span>
          <span className="lp-live__switch" aria-hidden />
        </button>
      </div>
      {stormOn ? <p className="lp-live__hint">{L.stormHint}</p> : null}
      <ul className="lp-live__legend" aria-hidden>
        <li data-kind="down">{L.legendDown}</li>
        <li data-kind="laser">{L.legendLaser}</li>
        <li data-kind="radio">{L.legendRadio}</li>
      </ul>
    </div>
  );
}
