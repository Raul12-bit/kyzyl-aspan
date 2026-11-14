import { useMemo, useState } from 'react';
import { planCue, type Priority } from '@/domain/crosscue';
import { FLEET, type GeoPoint } from '@/domain/orbit';
import { findCountry, useCountries } from '@/features/geo/countries';
import { useGeoStore } from '@/features/geo/geoStore';
import { useI18n } from '@/i18n';
import { Card, Icon, Segmented } from '@/ui';
import { LabeledSlider, Section } from './Section';

/** Default spot: the Kostanay steppe, Kazakhstan (the demo focus). */
const DEFAULT_SITE: GeoPoint = { lat: 52.4, lng: 63.6 };
const DETECTED_AT = 2 * 3600;
const RELAY_LATENCY = 90;

const PRIORITY_COLOR: Record<Priority, string> = {
  critical: 'var(--el-kyzyl)',
  high: 'var(--el-orange)',
  watch: 'var(--el-trust-medium)',
};

/** Idea 6 — tip and cue between satellites, with the follow-up chosen from orbit geometry. */
export function CueSection() {
  const { m, fmt } = useI18n();
  const [detectedBy, setDetectedBy] = useState('terra');
  const [confidence, setConfidence] = useState(55);
  const [clear, setClear] = useState(70);
  const countries = useCountries();
  const geoCountry = useGeoStore((s) => s.country);
  const country = findCountry(countries.data, geoCountry);
  const site: GeoPoint = country
    ? { lat: (country.bbox[1] + country.bbox[3]) / 2, lng: country.bbox[0] <= country.bbox[2] ? (country.bbox[0] + country.bbox[2]) / 2 : DEFAULT_SITE.lng }
    : DEFAULT_SITE;
  const sat = FLEET.find((s) => s.id === detectedBy)!;

  const plan = useMemo(
    () =>
      planCue(
        { site, detectedAt: DETECTED_AT, detectedBy: sat, confidence: confidence / 100, relayLatencySec: RELAY_LATENCY, clearSkyProbability: clear / 100 },
        FLEET,
      ),
    // site is derived from stable inputs
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sat, confidence, clear, site.lat, site.lng],
  );

  const steps = [
    { label: m.mission.cue.steps.detect, t: 0, icon: 'flame' as const, who: sat.name },
    { label: m.mission.cue.steps.relay, t: RELAY_LATENCY, icon: 'satellite' as const, who: '' },
    { label: m.mission.cue.steps.follow, t: plan.chosen?.delaySec ?? null, icon: 'crosshair' as const, who: plan.chosen?.satellite.name ?? '' },
    { label: m.mission.cue.steps.confirm, t: plan.chosen?.delaySec ?? null, icon: 'check' as const, who: fmt.pct(plan.confirmProbability) },
  ];

  return (
    <Section
      id="cue"
      kicker={m.mission.cue.kicker}
      title={m.mission.cue.title}
      body={m.mission.cue.body}
      aside={
        <p className="m-0 flex items-start gap-2 rounded-[12px] border border-[rgb(255_82_54/0.3)] bg-[rgb(255_82_54/0.06)] px-3 py-2.5 text-[12.5px] leading-snug text-ink-muted">
          <Icon name="alert" size={16} className="mt-px flex-none text-kyzyl" />
          {m.mission.cue.limitation}
        </p>
      }
    >
      <Card className="grid gap-5">
        <div className="grid gap-4 xl:grid-cols-3 xl:items-end">
          <div>
            <p className="m-0 mb-2 text-[12px] text-ink-dim">{m.mission.cue.detectedBy}</p>
            <Segmented<string>
              label={m.mission.cue.detectedBy}
              value={detectedBy}
              onChange={setDetectedBy}
              className="w-full [&>button]:flex-1"
              options={FLEET.map((s) => ({ value: s.id, label: s.name.replace('Suomi ', 'S-') }))}
            />
          </div>
          <LabeledSlider label={m.mission.cue.confidence} min={5} max={100} value={confidence} onChange={setConfidence} formatValue={(v) => `${v}%`} />
          <LabeledSlider label={m.mission.cue.clear} min={5} max={100} value={clear} onChange={setClear} formatValue={(v) => `${v}%`} />
        </div>

        <p className="num m-0 text-[12px] text-ink-dim">
          {m.mission.cue.site}: {fmt.dec(Math.abs(site.lat), 1)}°{site.lat >= 0 ? 'N' : 'S'} {fmt.dec(Math.abs(site.lng), 1)}°{site.lng >= 0 ? 'E' : 'W'}
          {country ? ` · ${fmt.country(country.id, country.name)}` : ''}
        </p>

        <ol className="m-0 grid list-none gap-0 p-0 sm:grid-cols-4">
          {steps.map((s, i) => (
            <li key={s.label} className="relative flex gap-3 pb-4 sm:flex-col sm:pb-0 sm:pr-3">
              <span className="relative z-[1] grid h-9 w-9 flex-none place-items-center rounded-full border border-line-strong bg-panel-solid text-kyzyl">
                <Icon name={s.icon} size={16} />
              </span>
              {i < steps.length - 1 ? (
                <span aria-hidden className="absolute left-[17px] top-9 h-[calc(100%-36px)] w-px bg-[var(--el-grad-orbit)] sm:left-9 sm:top-[17px] sm:h-px sm:w-[calc(100%-36px)]" style={{ background: 'var(--el-grad-orbit)' }} />
              ) : null}
              <div>
                <p className="m-0 text-[13px] font-semibold text-ink">{s.label}</p>
                <p className="num m-0 text-[12px] text-ink-dim">{s.t === null ? '—' : `T+${fmt.duration(s.t)}`}</p>
                {s.who ? <p className="m-0 text-[12px] text-ink-muted">{s.who}</p> : null}
              </div>
            </li>
          ))}
        </ol>

        <div className="grid gap-3 rounded-[14px] border border-line bg-[rgb(255_255_255/0.02)] px-4 py-3 sm:grid-cols-3" aria-live="polite">
          <div className="sm:col-span-3">
            <p className="m-0 text-[13.5px] font-semibold text-ink">
              {plan.chosen && plan.chosen.delaySec !== null ? m.mission.cue.next(plan.chosen.satellite.name, fmt.duration(plan.chosen.delaySec)) : m.mission.cue.none}
            </p>
          </div>
          <div>
            <p className="m-0 text-[11.5px] text-ink-dim">{m.mission.cue.confirmChance}</p>
            <p className="stat-value m-0 !text-[20px]">{fmt.pct(plan.confirmProbability)}</p>
          </div>
          {(['priorityNow', 'priorityConfirmed'] as const).map((k) => {
            const p = k === 'priorityNow' ? plan.priorityNow : plan.priorityIfConfirmed;
            return (
              <div key={k}>
                <p className="m-0 text-[11.5px] text-ink-dim">{m.mission.cue[k]}</p>
                <p className="m-0 mt-1 inline-flex items-center gap-1.5 text-[14px] font-semibold" style={{ color: PRIORITY_COLOR[p] }}>
                  <span className="h-2 w-2 rounded-full" style={{ background: PRIORITY_COLOR[p] }} />
                  {m.mission.cue.priorities[p]}
                </p>
              </div>
            );
          })}
        </div>

        <ul className="m-0 grid list-none gap-1.5 p-0 text-[12.5px]">
          {plan.candidates.map((c) => (
            <li key={c.satellite.id} className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-2 text-ink-muted">
                <span className="h-2 w-2" style={{ background: c.satellite.sensor === 'MODIS' ? 'var(--el-modis)' : 'var(--el-viirs)', borderRadius: c.satellite.sensor === 'MODIS' ? 1 : 99 }} />
                {c.satellite.name} · {c.satellite.sensor}
              </span>
              <span className="num text-ink-dim">{c.delaySec === null ? '—' : `T+${fmt.duration(c.delaySec)}`}</span>
            </li>
          ))}
        </ul>
      </Card>
    </Section>
  );
}
