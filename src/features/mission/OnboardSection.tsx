import { useMemo, useState } from 'react';
import { useOnboardModel } from '@/data/queries';
import { buildFeatures, featureVector, modelSizeBytes, predictAll, predictRow, type OnboardModel } from '@/domain/onboard';
import { useArchive } from '@/features/map/useFireData';
import { useI18n } from '@/i18n';
import { Card, Segmented, Skeleton } from '@/ui';
import { LabeledSlider, Section } from './Section';

/** Log-scale slider helpers: positions 0…100 ↔ values lo…hi. */
const logPos = (v: number, lo: number, hi: number) => (Math.log(v / lo) / Math.log(hi / lo)) * 100;
const logVal = (p: number, lo: number, hi: number) => lo * Math.pow(hi / lo, p / 100);

function MetricBars({ model }: { model: OnboardModel }) {
  const { m, fmt } = useI18n();
  const rows: { label: string; key: 'f1' | 'precision' | 'recall' }[] = [
    { label: m.mission.onboard.f1, key: 'f1' },
    { label: m.mission.onboard.precision, key: 'precision' },
    { label: m.mission.onboard.recall, key: 'recall' },
  ];
  // Differences are small, so the axis starts at 0.8 to make them visible (and says so).
  const x = (v: number) => `${Math.max(0, Math.min(100, ((v - 0.8) / 0.2) * 100))}%`;
  return (
    <div className="grid gap-3">
      {rows.map((r) => (
        <div key={r.key}>
          <div className="mb-1 flex justify-between text-[12px] text-ink-dim">
            <span>{r.label}</span>
            <span className="num">
              <span className="text-amber">{fmt.dec(model.metrics.test[r.key], 3)}</span> / {fmt.dec(model.metrics.baseline[r.key], 3)}
            </span>
          </div>
          <div className="grid gap-1">
            <span className="block h-2 rounded-full bg-[rgb(255_255_255/0.06)]">
              <span className="block h-2 rounded-full" style={{ width: x(model.metrics.test[r.key]), background: 'var(--el-grad-ember)' }} />
            </span>
            <span className="block h-2 rounded-full bg-[rgb(255_255_255/0.06)]">
              <span className="block h-2 rounded-full bg-ink-dim" style={{ width: x(model.metrics.baseline[r.key]) }} />
            </span>
          </div>
        </div>
      ))}
      <p className="num m-0 flex gap-4 text-[11px] text-ink-dim">
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-3 rounded-sm" style={{ background: 'var(--el-grad-ember)' }} />
          {m.mission.onboard.model}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-3 rounded-sm bg-ink-dim" />
          {m.mission.onboard.baseline}
        </span>
        <span>0.80 → 1.00</span>
      </p>
    </div>
  );
}

function Weights({ model }: { model: OnboardModel }) {
  const { m } = useI18n();
  const max = Math.max(...model.weights.map(Math.abs), 1e-6);
  return (
    <ul className="m-0 grid list-none gap-1.5 p-0">
      {model.features.map((f, i) => {
        const w = model.weights[i]!;
        const pct = (Math.abs(w) / max) * 50;
        return (
          <li key={f} className="grid grid-cols-[7.5rem_1fr] items-center gap-2 text-[11.5px]">
            <span className="truncate text-ink-dim">{m.mission.onboard.features[f as keyof typeof m.mission.onboard.features]}</span>
            <span className="relative h-2 rounded-full bg-[rgb(255_255_255/0.05)]">
              <span className="absolute inset-y-0 left-1/2 w-px bg-line-strong" />
              <span
                className="absolute inset-y-0 rounded-full"
                style={
                  w >= 0
                    ? { left: '50%', width: `${pct}%`, background: 'var(--el-amber)' }
                    : { right: '50%', width: `${pct}%`, background: 'var(--el-viirs)' }
                }
              />
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function TryIt({ model }: { model: OnboardModel }) {
  const { m, fmt } = useI18n();
  const [conf, setConf] = useState<'0' | '1' | '2'>('1');
  const [frpPos, setFrpPos] = useState(() => logPos(12, 0.5, 300));
  const [years, setYears] = useState(1);
  const [months, setMonths] = useState(2);
  const [countPos, setCountPos] = useState(() => logPos(3, 1, 500));
  const frp = logVal(frpPos, 0.5, 300);
  const count = Math.round(logVal(countPos, 1, 500));
  const p = predictRow(model, featureVector({ confidence: Number(conf) as 0 | 1 | 2, frp, years, months, cellCount: count }), 0);
  const fire = p >= model.threshold;

  return (
    <div className="grid gap-4">
      <div>
        <p className="m-0 mb-2 text-[12px] text-ink-dim">{m.mission.onboard.confidence}</p>
        <Segmented<'0' | '1' | '2'>
          label={m.mission.onboard.confidence}
          value={conf}
          onChange={setConf}
          className="w-full [&>button]:flex-1"
          options={[
            { value: '0', label: m.map.tooltip.conf.low },
            { value: '1', label: m.map.tooltip.conf.nominal },
            { value: '2', label: m.map.tooltip.conf.high },
          ]}
        />
      </div>
      <LabeledSlider label={m.mission.onboard.frp} min={0} max={100} value={frpPos} onChange={setFrpPos} formatValue={() => fmt.dec(frp, frp < 10 ? 1 : 0)} />
      <LabeledSlider label={m.mission.onboard.years} min={0} max={27} value={years} onChange={setYears} formatValue={(v) => fmt.int(v)} />
      <LabeledSlider label={m.mission.onboard.months} min={1} max={12} value={months} onChange={setMonths} formatValue={(v) => fmt.int(v)} />
      <LabeledSlider label={m.mission.onboard.count} min={0} max={100} value={countPos} onChange={setCountPos} formatValue={() => fmt.int(count)} />

      <div
        className="flex items-center justify-between gap-4 rounded-[14px] border px-4 py-3 transition-colors duration-300"
        style={{
          borderColor: fire ? 'rgb(255 82 54 / 0.5)' : 'var(--el-line-strong)',
          background: fire ? 'rgb(255 82 54 / 0.08)' : 'rgb(255 255 255 / 0.02)',
        }}
        aria-live="polite"
      >
        <div>
          <p className="m-0 text-[12px] text-ink-dim">{m.mission.onboard.probability}</p>
          <p className="stat-value m-0 !text-[26px]">{fmt.pct(p, 0)}</p>
        </div>
        <span
          className="rounded-pill px-3 py-1.5 text-[12.5px] font-semibold"
          style={{ background: fire ? 'var(--el-grad-ember)' : 'rgb(255 255 255 / 0.08)', color: fire ? 'var(--el-ink-on-fire)' : 'var(--el-ink-muted)' }}
        >
          {fire ? m.mission.onboard.verdictFire : m.mission.onboard.verdictNoise}
        </span>
      </div>
    </div>
  );
}

/** Idea 4 — the onboard triage model, its honest scores and a playground. */
export function OnboardSection() {
  const { m, fmt } = useI18n();
  const model = useOnboardModel();
  const { archive } = useArchive();

  const replay = useMemo(() => {
    if (!model.data || !archive) return null;
    const X = buildFeatures(archive.table, archive.base, archive.persistence);
    const p = predictAll(model.data, X, archive.table.n);
    let held = 0;
    for (let i = 0; i < p.length; i++) if (p[i]! < model.data.threshold) held += 1;
    return { held, total: archive.table.n };
  }, [model.data, archive]);

  return (
    <Section
      id="onboard"
      kicker={m.mission.onboard.kicker}
      title={m.mission.onboard.title}
      body={m.mission.onboard.body}
      aside={
        model.data ? (
          <dl className="m-0 grid grid-cols-3 gap-2">
            {[
              [m.mission.onboard.size, m.mission.onboard.bytes(fmt.int(modelSizeBytes(model.data)))],
              [m.mission.onboard.inputs, fmt.int(model.data.features.length)],
              [m.mission.onboard.heldOut, fmt.int(model.data.metrics.test.rows)],
            ].map(([k, v]) => (
              <div key={k} className="rounded-[12px] border border-line px-3 py-2.5">
                <dt className="text-[11px] leading-tight text-ink-dim">{k}</dt>
                <dd className="stat-value m-0 mt-1 !text-[17px]">{v}</dd>
              </div>
            ))}
          </dl>
        ) : null
      }
    >
      {model.isPending ? (
        <Skeleton className="h-80 w-full !rounded-panel" />
      ) : model.isError || !model.data ? (
        <Card>
          <p className="m-0 text-danger">{m.map.status.error}</p>
        </Card>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          <Card className="grid content-start gap-5">
            <MetricBars model={model.data} />
            <p className="m-0 rounded-[12px] border border-[rgb(255_196_107/0.3)] bg-warning-bg px-3 py-2.5 text-[12.5px] leading-snug text-ink-muted">
              {m.mission.onboard.honest(fmt.dec(model.data.metrics.test.f1, 3), fmt.dec(model.data.metrics.baseline.f1, 3))}
            </p>
            <Weights model={model.data} />
            {replay ? (
              <p className="m-0 text-[12.5px] leading-snug text-ink-muted">
                {m.mission.onboard.replay(fmt.int(replay.held), fmt.int(replay.total), fmt.pct(replay.held / replay.total))}
              </p>
            ) : null}
          </Card>
          <Card>
            <h3 className="m-0 mb-4 text-[15px] font-semibold text-ink">{m.mission.onboard.tryTitle}</h3>
            <TryIt model={model.data} />
            <p className="m-0 mt-4 text-[11.5px] leading-snug text-ink-dim">{m.mission.onboard.imageNote}</p>
          </Card>
        </div>
      )}
    </Section>
  );
}
