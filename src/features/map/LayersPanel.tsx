import { useId } from 'react';
import type { Sensor } from '@/data/types';
import { useI18n } from '@/i18n';
import { VIIRS_START_INDEX } from '@/lib/date';
import { Icon, SensorMark, Skeleton, Switch } from '@/ui';
import { useMapStore } from './mapStore';
import { useEffectiveRange } from './timeStore';
import { countRange, type FireIndex } from './useFireData';

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
      <span className="grid h-8 w-8 flex-none place-items-center rounded-[10px] border border-line bg-[rgb(255_255_255/0.03)]">
        <SensorMark kind={sensor} size={10} />
      </span>
      <div className="min-w-0 flex-1">
        <p id={`${id}-label`} className="m-0 text-[14px] font-semibold" style={{ color }}>
          {sensor === 'MODIS' ? m.map.layers.modis : m.map.layers.viirs}
        </p>
        <p id={`${id}-desc`} className="m-0 text-[12px] text-ink-dim">
          {sensor === 'MODIS' ? m.map.layers.modisDesc : m.map.layers.viirsDesc}
        </p>
        <p className="num m-0 mt-0.5 h-4 text-[11.5px] text-ink-muted" aria-live="polite">
          {count === null ? (
            <Skeleton className="mt-1 h-2.5 w-20 !rounded" />
          ) : notYet ? (
            m.map.layers.notAvailable
          ) : (
            m.map.layers.count(fmt.int(count))
          )}
        </p>
      </div>
      <Switch
        checked={on}
        onChange={(v) => setSensor(sensor, v)}
        labelledBy={`${id}-label`}
        describedBy={`${id}-desc`}
        color={color}
      />
    </div>
  );
}

export function LayersPanelBody({ index }: { index: FireIndex | null }) {
  const { m } = useI18n();
  return (
    <>
      <div className="divide-y divide-[var(--el-line)]">
        <SensorRow sensor="MODIS" index={index} />
        <SensorRow sensor="VIIRS" index={index} />
      </div>
      <p className="m-0 mt-2 flex items-start gap-2 text-[12.5px] leading-snug text-ink-muted">
        <Icon name="layers" size={16} className="mt-px flex-none text-ink-dim" />
        {m.map.layers.notSummed}
      </p>

      <div className="mt-5 rounded-[14px] border border-[rgb(61_219_217/0.22)] bg-info-bg px-3.5 py-3">
        <p className="m-0 flex items-start gap-2 text-[12.5px] leading-snug text-ink-muted">
          <Icon name="info" size={16} className="mt-px flex-none text-teal" />
          {m.map.layers.detectionNotFire}
        </p>
      </div>

      <h3 className="eyebrow mb-3 mt-5">{m.map.legend.title}</h3>
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
          <span className="flex w-6 items-end justify-center gap-0.5" aria-hidden>
            <span className="h-1 w-1 rounded-full bg-ink-dim" />
            <span className="h-1.5 w-1.5 rounded-full bg-ink-dim" />
            <span className="h-2.5 w-2.5 rounded-full bg-ink-dim" />
          </span>
          {m.map.legend.size}
        </li>
        <li className="flex items-center gap-3">
          <span className="grid w-6 place-items-center" aria-hidden>
            <span className="h-4 w-4 rounded-full border border-ink-dim" />
          </span>
          {m.map.legend.cluster}
        </li>
        <li className="flex items-center gap-3">
          <span className="grid w-6 place-items-center" aria-hidden>
            <span className="h-3.5 w-5 rounded-[2px] border border-dashed border-amber-soft" />
          </span>
          {m.map.legend.selection}
        </li>
      </ul>
    </>
  );
}
