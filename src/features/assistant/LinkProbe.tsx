import { useEffect, useState } from 'react';
import { LabeledSlider } from '@/features/mission/Section';
import { useI18n } from '@/i18n';
import { Chip, Spinner } from '@/ui';

/**
 * "Run AI #2 yourself": the visitor sets up a pass (station, elevation, rain over the antenna, Kp, minutes to the
 * horizon) and the trained AI #2 network answers for each downlink band — next to the reactive "margin below 2 dB"
 * rule. The default is the case that shows the point of the AI: Ka at TrollSat in light rain, where the rule still
 * says the link holds and AI #2 already switches to X.
 */
type Station = 'SVALSAT' | 'POKER_FLAT' | 'TROLLSAT' | 'MCMURDO';
const STATIONS: { id: Station; name: string }[] = [
  { id: 'SVALSAT', name: 'Svalbard' },
  { id: 'POKER_FLAT', name: 'Poker Flat' },
  { id: 'TROLLSAT', name: 'Troll' },
  { id: 'MCMURDO', name: 'McMurdo' },
];

interface BandResult {
  band: 'Ka' | 'X';
  rateMbps: number;
  risk: number;
  network: number;
  physics: number;
  marginDb: number;
  marginIn5MinDb: number;
  rule: 'drop' | 'holds';
}

interface ProbeResult {
  computedMs: number;
  bands: BandResult[];
  choice: 'Ka' | 'X';
  model: { parameters: number; trainedOn: number; rocAuc: number; ruleRocAuc: number };
}

export function LinkProbe() {
  const { m, fmt } = useI18n();
  const t = m.assistant.probe;
  const [station, setStation] = useState<Station>('TROLLSAT');
  const [elDeg, setEl] = useState(15);
  const [rainMmH, setRain] = useState(5);
  const [kp, setKp] = useState(3);
  const [losMin, setLos] = useState(5);
  const [result, setResult] = useState<ProbeResult | null>(null);
  const [state, setState] = useState<'idle' | 'busy' | 'error'>('busy');

  useEffect(() => {
    const ctrl = new AbortController();
    setState('busy');
    const timer = window.setTimeout(async () => {
      try {
        const res = await fetch('/api/ai/link/predict', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ station, elDeg, rainMmH, kp, losMin }),
          signal: AbortSignal.any([ctrl.signal, AbortSignal.timeout(10_000)]),
        });
        if (!res.ok) throw new Error(String(res.status));
        setResult((await res.json()) as ProbeResult);
        setState('idle');
      } catch {
        if (!ctrl.signal.aborted) setState('error');
      }
    }, 180);
    return () => {
      ctrl.abort();
      window.clearTimeout(timer);
    };
  }, [station, elDeg, rainMmH, kp, losMin]);

  const pct = (v: number) => fmt.pct(v, v > 0 && v < 0.01 ? 1 : 0);

  return (
    <div className="chat-probe">
      <p className="chat-probe__title">
        <span className="chat-probe__badge">AI #2</span>
        {t.title}
        {state === 'busy' ? <Spinner size={12} label={m.common.loading} /> : null}
      </p>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label={t.station}>
        {STATIONS.map((s) => (
          <Chip key={s.id} pressed={station === s.id} onClick={() => setStation(s.id)}>
            {s.name}
          </Chip>
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <LabeledSlider
          min={5}
          max={80}
          value={elDeg}
          onChange={setEl}
          label={t.elevation}
          formatValue={(v) => `${v}°`}
        />
        <LabeledSlider
          min={0}
          max={30}
          value={rainMmH}
          onChange={setRain}
          label={t.rain}
          formatValue={(v) => `${v} mm/h`}
        />
        <LabeledSlider
          min={0}
          max={9}
          value={kp}
          onChange={setKp}
          label={t.kp}
          formatValue={(v) => String(v)}
        />
        <LabeledSlider
          min={1}
          max={15}
          value={losMin}
          onChange={setLos}
          label={t.los}
          formatValue={(v) => `${v} min`}
        />
      </div>
      {state === 'error' && !result ? <p className="m-0 text-[12.5px] text-danger">{t.error}</p> : null}
      {result ? (
        <>
          <ul className="chat-probe__bands" aria-live="polite">
            {result.bands.map((b) => (
              <li
                key={b.band}
                data-chosen={b.band === result.choice ? 'true' : 'false'}
                data-danger={b.risk >= 0.5 ? 'true' : 'false'}
              >
                <span className="chat-probe__band">
                  {b.band} <span className="text-ink-dim">· {fmt.int(b.rateMbps)} Mbit/s</span>
                </span>
                <span className="chat-probe__risk num" title={t.parts(pct(b.network), pct(b.physics))}>
                  {pct(b.risk)}
                </span>
                <span className="chat-probe__bar" aria-hidden>
                  <i style={{ width: `${Math.max(2, b.risk * 100)}%` }} />
                </span>
                <span className="chat-probe__meta">
                  {t.margin(fmt.dec(b.marginDb, 1), fmt.dec(b.marginIn5MinDb, 1))} ·{' '}
                  <span data-rule={b.rule}>{t.rule[b.rule]}</span>
                </span>
              </li>
            ))}
          </ul>
          <p className="chat-probe__choice">{t.choice(result.choice)}</p>
          <p className="chat-probe__note">
            {t.note(
              fmt.int(result.model.parameters),
              fmt.int(result.model.trainedOn),
              fmt.dec(result.model.rocAuc, 3),
              fmt.dec(result.model.ruleRocAuc, 3),
            )}
          </p>
        </>
      ) : null}
    </div>
  );
}
