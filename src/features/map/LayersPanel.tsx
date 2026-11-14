import { useId, useMemo } from 'react';
import type { Sensor } from '@/data/types';
import type { FireArchive } from '@/domain/archive';
import { gridInfo } from '@/domain/hexgrid';
import { FLAG_LOW_CONFIDENCE, FLAG_STATIC } from '@/domain/noise';
import { useI18n } from '@/i18n';
import { VIIRS_START_INDEX } from '@/lib/date';
import { rampColors } from '@/styles/tokens';
import { Hex, Icon, Segmented, SensorMark, Skeleton, Switch } from '@/ui';
import { useMapStore, type MapView } from './mapStore';
import { useEffectiveRange } from './timeStore';
import { countRange, useFilterScore, type FireIndex } from './useFireData';

function SensorRow({ sensor, index }: { sensor: Sensor; index: FireIndex | null }) {
  const { m, fmt } = useI18n();
  const id = useId();
  const on = useMapStore((s) => s.sensors[sensor]);
  const setSensor = useMapStore((s) => s.setSensor);
  const range = useEffectiveRange();
  const notYet = sensor === 'VIIRS' && range[1] < VIIRS_START_INDEX;
  const count = index ? countRange(index[sensor], range) : null;
  const color = sensor === 'MODIS' ? 'var(--el-modis)' : 'var(--el-viirs)';

  return (
    <div className="flex items-center gap-3 py-2.5">
      <span className="grid h-8 w-8 flex-none place-items-center rounded-[10px] border border-line bg-[var(--el-tint-1)]">
        <SensorMark kind={sensor} size={10} />
      </span>
      <div className="min-w-0 flex-1">
        <p id={`${id}-label`} className="m-0 text-[14px] font-semibold" style={{ color }}>
          {sensor === 'MODIS' ? m.map.layers.modis : m.map.layers.viirs}
        </p>
        <p id={`${id}-desc`} className="m-0 text-[12px] text-ink-dim">
          {sensor === 'MODIS' ? m.map.layers.modisDesc : m.map.layers.viirsDesc}
        </p>
        <div className="num m-0 mt-0.5 h-4 text-[11.5px] text-ink-muted" aria-live="polite">
          {count === null ? <Skeleton className="mt-1 h-2.5 w-20 !rounded" /> : notYet ? m.map.layers.notAvailable : m.map.layers.count(fmt.int(count))}
        </div>
      </div>
      <Switch checked={on} onChange={(v) => setSensor(sensor, v)} labelledBy={`${id}-label`} describedBy={`${id}-desc`} color={color} />
    </div>
  );
}

function NoiseRow({ kind, removed }: { kind: 'lowConfidence' | 'staticSources'; removed: number | null }) {
  const { m, fmt } = useI18n();
  const id = useId();
  const on = useMapStore((s) => s.noise[kind]);
  const setNoise = useMapStore((s) => s.setNoise);
  const label = kind === 'lowConfidence' ? m.map.noise.lowConf : m.map.noise.static;
  const desc = kind === 'lowConfidence' ? m.map.noise.lowConfDesc : m.map.noise.staticDesc;
  return (
    <div className="flex items-start gap-3 py-2.5">
      <span className="mt-0.5 grid h-8 w-8 flex-none place-items-center rounded-[10px] border border-line bg-[var(--el-tint-1)] text-trust-low">
        <Icon name={kind === 'lowConfidence' ? 'alert' : 'flame'} size={16} />
      </span>
      <div className="min-w-0 flex-1">
        <p id={`${id}-label`} className="m-0 text-[13.5px] font-semibold text-ink">
          {label}
        </p>
        <p id={`${id}-desc`} className="m-0 text-[12px] leading-snug text-ink-dim">
          {desc}
        </p>
        <p className="num m-0 mt-0.5 text-[11.5px] text-ink-muted" aria-live="polite">
          {removed === null ? '—' : on ? m.map.noise.removed(fmt.int(removed)) : '0'}
        </p>
      </div>
      <Switch checked={on} onChange={(v) => setNoise({ [kind]: v })} labelledBy={`${id}-label`} describedBy={`${id}-desc`} color="var(--el-kyzyl)" />
    </div>
  );
}

export function LayersPanelBody({ index, archive }: { index: FireIndex | null; archive: FireArchive | null }) {
  const { m, fmt } = useI18n();
  const view = useMapStore((s) => s.view);
  const setView = useMapStore((s) => s.setView);
  const hexRes = useMapStore((s) => s.hexRes);
  const range = useEffectiveRange();
  const score = useFilterScore(archive);
  const ramp = rampColors();

  // Noise in the current window, per class (static wins when both flags are set).
  const removed = useMemo(() => {
    if (!archive) return null;
    let low = 0;
    let stat = 0;
    const t = archive.table;
    for (let i = 0; i < t.n; i++) {
      const mo = t.month[i]!;
      if (mo < range[0] || mo > range[1]) continue;
      const f = archive.flags[i]!;
      if (f & FLAG_LOW_CONFIDENCE) low += 1;
      else if (f & FLAG_STATIC) stat += 1;
    }
    return { low, stat };
  }, [archive, range]);

  const info = gridInfo(hexRes);

  return (
    <>
      <Segmented<MapView>
        label={m.map.view.label}
        value={view}
        onChange={setView}
        className="w-full [&>button]:flex-1"
        options={[
          { value: 'points', label: m.map.view.points },
          { value: 'hex', label: m.map.view.hex },
        ]}
      />
      {view === 'hex' ? (
        <p className="num m-0 mt-2 text-[11.5px] text-ink-dim">{m.map.view.hexHint(String(hexRes), fmt.int(info.areaKm2))}</p>
      ) : null}

      <div className="mt-3 divide-y divide-[var(--el-line)]">
        <SensorRow sensor="MODIS" index={index} />
        <SensorRow sensor="VIIRS" index={index} />
      </div>
      <p className="m-0 mt-2 flex items-start gap-2 text-[12.5px] leading-snug text-ink-muted">
        <Icon name="layers" size={16} className="mt-px flex-none text-ink-dim" />
        {m.map.layers.notSummed}
      </p>

      <h3 className="eyebrow mb-1 mt-5">{m.map.noise.title}</h3>
      <div className="divide-y divide-[var(--el-line)]">
        <NoiseRow kind="lowConfidence" removed={removed?.low ?? null} />
        <NoiseRow kind="staticSources" removed={removed?.stat ?? null} />
      </div>
      {archive ? (
        <p className="m-0 mt-1 text-[11.5px] leading-snug text-ink-dim">
          {m.map.noise.staticCells(fmt.int(archive.persistence.staticCells))}
          {score ? ` ${m.map.noise.score(fmt.pct(score.precision), fmt.pct(score.firesKept))}` : ''}
        </p>
      ) : null}

      <div className="mt-5 rounded-[14px] border border-[rgb(61_219_217/0.22)] bg-info-bg px-3.5 py-3">
        <p className="m-0 flex items-start gap-2 text-[12.5px] leading-snug text-ink-muted">
          <Icon name="info" size={16} className="mt-px flex-none text-teal" />
          {m.map.layers.detectionNotFire}
        </p>
      </div>

      <h3 className="eyebrow mb-3 mt-5">{m.map.legend.title}</h3>
      {view === 'hex' ? (
        <div>
          <div className="h-2.5 w-full rounded-full" style={{ background: `linear-gradient(90deg, ${ramp[2]}, ${ramp[3]}, ${ramp[4]}, ${ramp[5]}, ${ramp[6]})` }} />
          <div className="mt-1.5 flex justify-between text-[11.5px] text-ink-dim">
            <span>{m.map.legend.less}</span>
            <span>{m.map.legend.hex}</span>
            <span>{m.map.legend.more}</span>
          </div>
        </div>
      ) : (
        <ul className="m-0 grid list-none gap-2.5 p-0 text-[12.5px] text-ink-muted">
          <li className="flex items-center gap-3">
            <span className="grid w-6 place-items-center">
              <SensorMark kind="MODIS" size={8} />
            </span>
            {m.map.legend.square}
          </li>
          <li className="flex items-center gap-3">
            <span className="grid w-6 place-items-center">
              <SensorMark kind="VIIRS" size={8} />
            </span>
            {m.map.legend.dot}
          </li>
          <li className="flex items-center gap-3">
            <span className="grid w-6 place-items-center" aria-hidden>
              <Hex size={15} fill="transparent" stroke="var(--el-ink-dim)" strokeWidth={1.2} />
            </span>
            {m.map.legend.cluster}
          </li>
        </ul>
      )}
      <p className="m-0 mt-3 flex items-center gap-3 text-[12.5px] text-ink-muted">
        <span className="grid w-6 place-items-center" aria-hidden>
          <span className="h-3.5 w-5 rounded-[2px] border border-orange" style={{ background: 'color-mix(in srgb, var(--el-orange) 8%, transparent)' }} />
        </span>
        {m.map.legend.selection}
      </p>
    </>
  );
}
