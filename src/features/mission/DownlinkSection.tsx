import { useMemo, useState } from 'react';
import { planDownlinks, STATIONS, type Decision } from '@/domain/downlink';
import { FLEET } from '@/domain/orbit';
import { useI18n } from '@/i18n';
import { Button, Card, Segmented } from '@/ui';
import { LabeledSlider, Meter, Section } from './Section';

const HORIZON = 12 * 3600;

const DECISION_STYLE: Record<Decision, { bg: string; fg: string }> = {
  ka: { bg: 'rgb(126 230 196 / 0.16)', fg: 'var(--el-trust-high)' },
  'x-fallback': { bg: 'rgb(255 196 107 / 0.16)', fg: 'var(--el-trust-medium)' },
  'x-only': { bg: 'rgb(154 166 255 / 0.14)', fg: 'var(--el-viirs)' },
  skip: { bg: 'rgb(255 82 54 / 0.14)', fg: 'var(--el-kyzyl)' },
};

/** Idea 5 — weather-aware downlink planning over a real-shaped ground network. */
export function DownlinkSection() {
  const { m, fmt } = useI18n();
  const [satId, setSatId] = useState('snpp');
  const [backlog, setBacklog] = useState(300);
  const [seed, setSeed] = useState(4);
  const sat = FLEET.find((s) => s.id === satId)!;
  const plan = useMemo(() => planDownlinks(sat, STATIONS, { from: 0, horizonSec: HORIZON, backlogGbit: backlog, weatherSeed: seed }), [sat, backlog, seed]);

  return (
    <Section
      id="downlink"
      kicker={m.mission.downlink.kicker}
      title={m.mission.downlink.title}
      body={m.mission.downlink.body}
      aside={<p className="m-0 text-[12px] leading-snug text-ink-dim">{m.mission.downlink.assumptions}</p>}
    >
      <Card className="grid gap-5">
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(180px,1fr)_auto] xl:items-end">
          <div>
            <p className="m-0 mb-2 text-[12px] text-ink-dim">{m.mission.downlink.satellite}</p>
            <Segmented<string>
              label={m.mission.downlink.satellite}
              value={satId}
              onChange={setSatId}
              className="w-full [&>button]:flex-1"
              options={FLEET.map((s) => ({ value: s.id, label: s.name.replace('Suomi ', 'S-') }))}
            />
          </div>
          <LabeledSlider label={m.mission.downlink.backlog} min={50} max={900} step={10} value={backlog} onChange={setBacklog} formatValue={(v) => `${fmt.int(v)} Gbit`} />
          <Button variant="secondary" size="sm" icon="refresh" onClick={() => setSeed((s) => s + 1)}>
            {m.mission.downlink.reroll}
          </Button>
        </div>

        {/* 12-hour timeline: one lane per station, passes coloured by the decision. */}
        <div className="grid gap-1.5" aria-hidden>
          {STATIONS.map((st) => (
            <div key={st.id} className="grid grid-cols-[6.5rem_1fr] items-center gap-2">
              <span className="truncate text-[11px] text-ink-dim">{st.name}</span>
              <span className="relative h-3 rounded-full bg-[rgb(255_255_255/0.04)]">
                {plan.passes
                  .filter((p) => p.station.id === st.id)
                  .map((p) => (
                    <span
                      key={p.pass.aos}
                      className="absolute inset-y-0 rounded-full"
                      style={{
                        left: `${(p.pass.aos / HORIZON) * 100}%`,
                        width: `${Math.max(0.6, ((p.pass.los - p.pass.aos) / HORIZON) * 100)}%`,
                        background: DECISION_STYLE[p.decision].fg,
                      }}
                    />
                  ))}
                {plan.doneAt !== null ? (
                  <span className="absolute -inset-y-1 w-px bg-ink" style={{ left: `${(plan.doneAt / HORIZON) * 100}%` }} />
                ) : null}
              </span>
            </div>
          ))}
          <div className="grid grid-cols-[6.5rem_1fr] gap-2">
            <span />
            <span className="num flex justify-between text-[10px] text-ink-dim">
              {[0, 3, 6, 9, 12].map((h) => (
                <span key={h}>{fmt.clock(h * 3600)}</span>
              ))}
            </span>
          </div>
        </div>

        <div className="grid gap-2 rounded-[14px] border border-line bg-[rgb(255_255_255/0.02)] px-4 py-3 text-[13px]" aria-live="polite">
          <p className="m-0 font-semibold text-ink">
            {plan.doneAt !== null ? m.mission.downlink.done(fmt.duration(plan.doneAt)) : m.mission.downlink.notDone}
          </p>
          <p className="m-0 text-ink-muted">
            {m.mission.downlink.failures(fmt.dec(plan.expectedFailures, 1), fmt.dec(plan.naiveExpectedFailures, 1))}
          </p>
        </div>

        <div className="max-h-[22rem] overflow-auto rounded-[12px] border border-line">
          <table className="w-full border-collapse text-left text-[12.5px]">
            <thead className="sticky top-0 bg-panel-solid text-[11px] uppercase tracking-[0.08em] text-ink-dim">
              <tr>
                {[m.mission.downlink.time, m.mission.downlink.station, m.mission.downlink.elevation, m.mission.downlink.rain, m.mission.downlink.ka, m.mission.downlink.decision].map((h) => (
                  <th key={h} scope="col" className="whitespace-nowrap px-3 py-2 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {plan.passes.map((p) => (
                <tr key={`${p.station.id}-${p.pass.aos}`} className="border-t border-line">
                  <td className="num whitespace-nowrap px-3 py-2 text-ink-muted">{fmt.clock(p.pass.aos)}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-ink">{p.station.name}</td>
                  <td className="num px-3 py-2 text-ink-muted">{fmt.int(p.pass.maxElevationDeg)}°</td>
                  <td className="num whitespace-nowrap px-3 py-2 text-ink-muted">{fmt.dec(p.expectedRain, 1)} mm/h</td>
                  <td className="px-3 py-2">
                    {p.kaReliability === null ? (
                      <span className="text-ink-dim">—</span>
                    ) : (
                      <span className="num inline-flex items-center gap-2 text-ink-muted">
                        <Meter value={p.kaReliability} color={p.kaReliability >= 0.75 ? 'var(--el-trust-high)' : 'var(--el-kyzyl)'} />
                        {fmt.pct(p.kaReliability)}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className="inline-block whitespace-nowrap rounded-pill px-2 py-0.5 text-[11.5px] font-medium"
                      style={{ background: DECISION_STYLE[p.decision].bg, color: DECISION_STYLE[p.decision].fg }}
                    >
                      {m.mission.downlink.decisions[p.decision]}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </Section>
  );
}
