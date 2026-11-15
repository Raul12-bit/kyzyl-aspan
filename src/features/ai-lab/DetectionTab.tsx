import { useEffect, useMemo, useRef, useState } from 'react';
import { detectFires, PIXEL, type DetectionResult, type PixelVerdict } from '@/domain/ai/contextual';
import { fuseObservations } from '@/domain/ai/fusion';
import {
  buildScene,
  observe,
  pixelLatLng,
  SCENE_KINDS,
  type SceneKind,
  type SensorImage,
} from '@/domain/ai/scene';
import { encodeAlert, decodeAlert, triage, type Priority, type TriageResult } from '@/domain/ai/triage';
import { useOnboardModel } from '@/data/queries';
import type { OnboardModel } from '@/domain/onboard';
import { OnboardSection } from '@/features/mission/OnboardSection';
import { Meter } from '@/features/mission/Section';
import { useI18n } from '@/i18n';
import { Button, Card, Chip, Segmented, Skeleton } from '@/ui';

/* ------------------------------------------------------------------ thermal image */

/** 4 µm brightness → colour: night-black ground, ember, orange, amber, white-hot. */
const RAMP = [
  '#0e0e10',
  '#1c1614',
  '#3b150b',
  '#7c220d',
  '#c23a14',
  '#ec6420',
  '#ff9133',
  '#ffbf5a',
  '#fff1d6',
];
const hex2rgb = (h: string) =>
  [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)] as const;
const RAMP_RGB = RAMP.map(hex2rgb);

function thermalColor(t4: number): string {
  // Ordinary ground stays dark (with its texture visible); only real excess heat reaches orange and white.
  const t = Math.max(0, Math.min(1, (t4 - 290) / (372 - 290))) ** 1.25;
  const x = t * (RAMP_RGB.length - 1);
  const i = Math.min(RAMP_RGB.length - 2, Math.floor(x));
  const f = x - i;
  const a = RAMP_RGB[i]!;
  const b = RAMP_RGB[i + 1]!;
  return `rgb(${Math.round(a[0] + (b[0] - a[0]) * f)} ${Math.round(a[1] + (b[1] - a[1]) * f)} ${Math.round(a[2] + (b[2] - a[2]) * f)})`;
}

function hexPath(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number) {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i + Math.PI / 6;
    const x = cx + r * Math.cos(a);
    const y = cy + r * Math.sin(a);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

function ThermalImage({
  image,
  result,
  label,
}: {
  image: SensorImage;
  result: DetectionResult;
  label: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const draw = () => {
      const css = canvas.clientWidth || 300;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(css * dpr);
      canvas.height = Math.round(css * dpr);
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const n = image.size;
      const px = css / n;
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          const i = y * n + x;
          ctx.fillStyle =
            image.mask[i] === 1 ? '#0f1a24' : image.mask[i] === 2 ? '#3d4048' : thermalColor(image.t4[i]!);
          // Overlap by a hair so no seams show between pixels.
          ctx.fillRect(x * px, y * px, px + 0.6, px + 0.6);
        }
      }
      for (const v of result.examined) {
        const cx = (v.x + 0.5) * px;
        const cy = (v.y + 0.5) * px;
        if (result.classes[v.y * n + v.x] === PIXEL.fire) {
          hexPath(ctx, cx, cy, Math.max(4, px * 0.62));
          ctx.lineWidth = Math.max(1.4, px * 0.07);
          ctx.strokeStyle = '#fff6e8';
          ctx.stroke();
        } else {
          hexPath(ctx, cx, cy, Math.max(3, px * 0.4));
          ctx.lineWidth = 1;
          ctx.setLineDash([2, 2]);
          ctx.strokeStyle = 'rgb(238 233 224 / 0.55)';
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [image, result]);
  return <canvas ref={ref} className="lab-thermal" role="img" aria-label={label} />;
}

/* ------------------------------------------------------------------ helpers */

interface SensorRun {
  image: SensorImage;
  result: DetectionResult;
  ms: number;
}

function runSensor(kind: SceneKind, day: boolean, sensor: 'MODIS' | 'VIIRS'): SensorRun {
  const scene = buildScene(kind, day);
  const image = observe(scene, sensor);
  // Warm up once (JIT), then time a batch: browsers coarsen performance.now(), single runs read as 0.
  let result = detectFires(image, day);
  const runs = 40;
  const t0 = performance.now();
  for (let k = 0; k < runs; k++) result = detectFires(image, day);
  return { image, result, ms: (performance.now() - t0) / runs };
}

/** The pixel worth explaining: the hottest fire, else the hottest rejected candidate. */
function focusPixel(r: DetectionResult): PixelVerdict | null {
  const pick = (list: PixelVerdict[]) =>
    list.reduce<PixelVerdict | null>((a, b) => (!a || b.t4 > a.t4 ? b : a), null);
  return pick(r.fires) ?? pick(r.examined);
}

const PRIORITY_TONE: Record<Priority, string> = {
  CRITICAL: 'var(--el-red)',
  HIGH: 'var(--el-gold)',
  ROUTINE: 'var(--el-ink-muted)',
  DROP: 'var(--el-ink-dim)',
};

const PACKET_GROUPS: {
  from: number;
  to: number;
  key: 'head' | 'lat' | 'lng' | 'time' | 'frp' | 'p' | 'px' | 'crc';
}[] = [
  { from: 0, to: 0, key: 'head' },
  { from: 1, to: 3, key: 'lat' },
  { from: 4, to: 6, key: 'lng' },
  { from: 7, to: 10, key: 'time' },
  { from: 11, to: 12, key: 'frp' },
  { from: 13, to: 13, key: 'p' },
  { from: 14, to: 14, key: 'px' },
  { from: 15, to: 15, key: 'crc' },
];

/* ------------------------------------------------------------------ panels */

function TestsPanel({ verdict, day }: { verdict: PixelVerdict | null; day: boolean }) {
  const { m, fmt } = useI18n();
  const t = m.ai.lab.ai1.tests;
  if (!verdict) return <p className="m-0 text-[13px] text-ink-dim">{m.ai.lab.ai1.noFire}</p>;
  const bg = verdict.background;
  const k = (v: number) => `${fmt.dec(v, 1)} K`;
  const rows: { label: string; pass: boolean; detail: string; skip?: boolean }[] = [
    {
      label: t.absolute,
      pass: verdict.tests.absolute,
      detail: `${k(verdict.t4)} > ${day ? '360' : '320'} K`,
    },
    {
      label: t.dTTest,
      pass: verdict.tests.dT,
      detail: bg ? `${k(verdict.dT)} > ${k(bg.meanDT + 3.5 * bg.madDT)}` : '—',
    },
    {
      label: t.dTOffset,
      pass: verdict.tests.dTOffset,
      detail: bg ? `${k(verdict.dT)} > ${k(bg.meanDT + 6)}` : '—',
    },
    {
      label: t.t4Test,
      pass: verdict.tests.t4,
      detail: bg ? `${k(verdict.t4)} > ${k(bg.mean4 + 3 * bg.mad4)}` : '—',
    },
    {
      label: t.t11Test,
      pass: verdict.tests.t11,
      detail: bg ? `${k(verdict.t11)} > ${k(bg.mean11 + bg.mad11 - 4)}` : '—',
      skip: !day,
    },
  ];
  return (
    <div className="grid gap-3">
      <dl className="lab-kv">
        <div>
          <dt>{t.t4}</dt>
          <dd className="num">{k(verdict.t4)}</dd>
        </div>
        <div>
          <dt>{t.dT}</dt>
          <dd className="num">{k(verdict.dT)}</dd>
        </div>
      </dl>
      {bg ? (
        <p className="m-0 text-[12px] text-ink-dim">
          {t.background(fmt.int(bg.n), `${bg.radius * 2 + 1}×${bg.radius * 2 + 1}`)}
        </p>
      ) : null}
      <ul className="lab-tests">
        {rows
          .filter((r) => !r.skip)
          .map((r) => (
            <li key={r.label} data-pass={r.pass ? 'true' : 'false'}>
              <span className="lab-tests__mark" aria-hidden />
              <span className="min-w-0">
                <span className="block text-[13px] text-ink">{r.label}</span>
                <span className="num block text-[11.5px] text-ink-dim">{r.detail}</span>
              </span>
              <span className="lab-tests__verdict">{r.pass ? t.pass : t.fail}</span>
            </li>
          ))}
      </ul>
    </div>
  );
}

function PacketView({ bytes }: { bytes: Uint8Array }) {
  const { m, fmt } = useI18n();
  const p = m.ai.lab.ai1.packet;
  const decoded = decodeAlert(bytes);
  const when = decoded
    ? new Date(Date.UTC(2000, 0, 1) + decoded.timeSec * 1000).toISOString().slice(0, 16).replace('T', ' ')
    : '';
  return (
    <div className="grid gap-3">
      <div className="lab-bytes" aria-label={p.title}>
        {PACKET_GROUPS.map((g) => (
          <span key={g.key} className="lab-bytes__group" data-field={g.key} title={p.fields[g.key]}>
            {Array.from(bytes.slice(g.from, g.to + 1), (b, i) => (
              <span key={i} className="lab-bytes__b">
                {b.toString(16).padStart(2, '0')}
              </span>
            ))}
          </span>
        ))}
      </div>
      <ul className="lab-bytes__legend">
        {PACKET_GROUPS.map((g) => (
          <li key={g.key} data-field={g.key}>
            {p.fields[g.key]}
          </li>
        ))}
      </ul>
      {decoded ? (
        <p className="num m-0 text-[12px] leading-relaxed text-ink-dim">
          {p.decoded}: {fmt.dec(decoded.lat, 5)}°, {fmt.dec(decoded.lng, 5)}° · {when} UTC ·{' '}
          {fmt.dec(decoded.frpMW, 1)} MW · p {fmt.dec(decoded.pReal, 2)} · {decoded.pixels} px ·{' '}
          {m.ai.lab.ai1.triage.priorities[decoded.priority]} · CRC ✓
        </p>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ the tab */

function Lab({ model }: { model: OnboardModel }) {
  const { m, fmt } = useI18n();
  const t = m.ai.lab.ai1;
  const [kind, setKind] = useState<SceneKind>('smallBurn');
  const [time, setTime] = useState<'day' | 'night'>('day');
  const [explain, setExplain] = useState<'VIIRS' | 'MODIS'>('VIIRS');
  const [bench, setBench] = useState<{ ms: number; n: number } | null>(null);
  const day = time === 'day';

  const scene = useMemo(() => buildScene(kind, day), [kind, day]);
  const viirs = useMemo(() => runSensor(kind, day, 'VIIRS'), [kind, day]);
  const modis = useMemo(() => runSensor(kind, day, 'MODIS'), [kind, day]);
  useEffect(() => setBench(null), [kind, day]);

  const run = explain === 'VIIRS' ? viirs : modis;
  const verdict = focusPixel(run.result);
  const cluster = run.result.clusters[0] ?? null;
  const decision: TriageResult | null = cluster
    ? triage(model, {
        confidenceClass: cluster.confidenceClass,
        frpMW: cluster.frpMW,
        pixels: cluster.pixels.length,
        history: scene.history,
      })
    : null;
  const packet = useMemo(() => {
    if (!cluster || !decision || decision.priority === 'DROP') return null;
    const at = pixelLatLng(scene, run.image, Math.round(cluster.x), Math.round(cluster.y));
    return encodeAlert({
      priority: decision.priority,
      sensor: run.image.sensor,
      day,
      lat: at.lat,
      lng: at.lng,
      timeSec: scene.timeSec,
      frpMW: cluster.frpMW,
      pReal: decision.pReal,
      pixels: cluster.pixels.length,
    });
  }, [cluster, decision, scene, run.image, day]);
  const fused = fuseObservations(modis.result.clusters[0] ?? null, viirs.result.clusters[0] ?? null);
  const saturated = explain === 'VIIRS' && (cluster?.maxT4 ?? 0) >= 366.9;

  const measure = () => {
    const n = 400;
    const t0 = performance.now();
    for (let k = 0; k < n; k++) {
      const r = detectFires(viirs.image, day);
      const c = r.clusters[0];
      if (c) {
        const d = triage(model, {
          confidenceClass: c.confidenceClass,
          frpMW: c.frpMW,
          pixels: c.pixels.length,
          history: scene.history,
        });
        encodeAlert({
          priority: d.priority,
          sensor: 'VIIRS',
          day,
          lat: scene.lat,
          lng: scene.lng,
          timeSec: scene.timeSec,
          frpMW: c.frpMW,
          pReal: d.pReal,
          pixels: c.pixels.length,
        });
      }
    }
    setBench({ ms: (performance.now() - t0) / n, n });
  };

  // The lab's MODIS pixel is 3 × 375 m = 1125 m: shown as "≈1125 m", honest about the simulation grid.
  const size = (r: SensorRun) =>
    r.image.sensor === 'MODIS' ? `≈${fmt.int(r.image.pixelM)}` : fmt.int(r.image.pixelM);
  const imageCard = (r: SensorRun, sensor: 'VIIRS' | 'MODIS') => (
    <figure className="m-0 grid gap-2">
      <ThermalImage image={r.image} result={r.result} label={t.imageLabel(sensor, size(r))} />
      <figcaption className="grid gap-0.5">
        <span className="text-[13px] text-ink">{t.imageLabel(sensor, size(r))}</span>
        <span className="num text-[11.5px] text-ink-dim">
          {t.stats(fmt.int(r.result.fires.length), fmt.int(r.result.examined.length), fmt.dec(r.ms, 3))}
        </span>
      </figcaption>
    </figure>
  );

  return (
    <section aria-labelledby="ai1-title" className="lab-grid">
      <div className="lab-side">
        <p className="eyebrow m-0 !text-kyzyl">{t.kicker}</p>
        <h2 id="ai1-title" className="display m-0 mt-3 text-[clamp(1.4rem,1.6vw+0.9rem,2.1rem)] text-ink">
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
      </div>

      <div className="grid min-w-0 gap-4">
        <Card className="grid gap-5">
          <div className="grid gap-3">
            <p className="m-0 text-[12px] text-ink-dim">{t.scene}</p>
            <div className="flex flex-wrap gap-2" role="group" aria-label={t.scene}>
              {SCENE_KINDS.map((k) => (
                <Chip key={k} pressed={kind === k} onClick={() => setKind(k)}>
                  {t.scenes[k]}
                </Chip>
              ))}
            </div>
            <p className="m-0 text-[13px] leading-snug text-ink-muted">{t.sceneNotes[kind]}</p>
            <Segmented<'day' | 'night'>
              label={t.time}
              value={time}
              onChange={setTime}
              className="w-full sm:w-fit [&>button]:flex-1"
              options={[
                { value: 'day', label: t.day },
                { value: 'night', label: t.night },
              ]}
            />
          </div>
          <div className="grid grid-cols-2 gap-3 sm:gap-5">
            {imageCard(viirs, 'VIIRS')}
            {imageCard(modis, 'MODIS')}
          </div>
          <ul className="lab-legend">
            <li data-k="fire">{t.legend.fire}</li>
            <li data-k="rejected">{t.legend.rejected}</li>
            <li data-k="masked">{t.legend.masked}</li>
          </ul>
          <p className="lab-fused m-0" data-status={fused.status}>
            {fused.status === 'both'
              ? t.fused.both(fmt.pct(fused.p, 0))
              : fused.status === 'viirsOnly'
                ? t.fused.viirsOnly
                : fused.status === 'modisOnly'
                  ? t.fused.modisOnly
                  : t.fused.none}
          </p>
        </Card>

        <div className="grid gap-4 xl:grid-cols-2">
          <Card className="grid content-start gap-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 className="lab-h3">{t.tests.title}</h3>
              <Segmented<'VIIRS' | 'MODIS'>
                label={t.tests.title}
                value={explain}
                onChange={setExplain}
                options={[
                  { value: 'VIIRS', label: 'VIIRS' },
                  { value: 'MODIS', label: 'MODIS' },
                ]}
              />
            </div>
            <TestsPanel verdict={verdict} day={day} />
          </Card>

          <Card className="grid content-start gap-4">
            <h3 className="lab-h3">{t.triage.title}</h3>
            {cluster && decision ? (
              <>
                <div className="flex flex-wrap items-center gap-3">
                  <span
                    className="lab-priority"
                    style={{ ['--tone' as string]: PRIORITY_TONE[decision.priority] }}
                  >
                    {t.triage.priorities[decision.priority]}
                  </span>
                  <span className="text-[13px] text-ink-muted">
                    {decision.reasons.map((r) => t.triage.reasons[r]).join(' · ')}
                  </span>
                </div>
                <div className="grid gap-1.5">
                  <div className="flex items-baseline justify-between gap-3 text-[12px]">
                    <span className="text-ink-dim">{t.triage.probability}</span>
                    <span className="num text-ink">{fmt.pct(decision.pReal, 1)}</span>
                  </div>
                  <Meter
                    value={decision.pReal}
                    color={decision.pReal >= 0.5 ? 'var(--el-gold)' : 'var(--el-ink-dim)'}
                    label={t.triage.probability}
                  />
                </div>
                <p className="num m-0 text-[12px] text-ink-dim">
                  {t.triage.history(
                    fmt.int(scene.history.years),
                    fmt.int(scene.history.months),
                    fmt.int(scene.history.count),
                  )}{' '}
                  · {t.triage.frp} {fmt.dec(cluster.frpMW, 1)} MW
                </p>
                {saturated ? (
                  <p className="m-0 text-[12px] leading-snug text-ink-dim">{t.triage.saturated}</p>
                ) : null}
                <div className="border-t border-line pt-4">
                  <h4 className="m-0 mb-3 text-[13px] font-medium text-ink">{t.packet.title}</h4>
                  {packet ? (
                    <PacketView bytes={packet} />
                  ) : (
                    <p className="m-0 text-[13px] text-ink-dim">{t.packet.notSent}</p>
                  )}
                </div>
              </>
            ) : (
              <p className="m-0 text-[13px] text-ink-dim">{t.noFire}</p>
            )}
          </Card>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button variant="secondary" size="sm" icon="play" onClick={measure}>
            {t.bench.run}
          </Button>
          {bench ? (
            <span className="num text-[12.5px] text-ink-muted" role="status">
              {t.bench.result(fmt.dec(bench.ms, 3), fmt.int(bench.n))}
            </span>
          ) : null}
        </div>
      </div>
    </section>
  );
}

/** Tab "AI #1": the onboard detector on a thermal scene, then the triage model it uses. */
export default function DetectionTab() {
  const model = useOnboardModel();
  return (
    <div className="grid gap-14">
      {model.data ? <Lab model={model.data} /> : <Skeleton className="h-[520px] w-full !rounded-panel" />}
      <OnboardSection />
    </div>
  );
}
