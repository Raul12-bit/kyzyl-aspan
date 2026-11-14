import { useEffect, useMemo, useRef } from 'react';
import { useAppParams } from '@/app/useAppParams';
import { FULL_RANGE } from '@/app/urlState';
import { useI18n } from '@/i18n';
import { fromMonthIndex, MONTH_COUNT, VIIRS_START_INDEX } from '@/lib/date';
import { Button, cn, IconButton, RangeSlider } from '@/ui';
import { useTimeStore } from './timeStore';
import type { FireIndex } from './useFireData';

const MAX = MONTH_COUNT - 1;
/** Playback: one month per step. 322 months ≈ 19 s. */
const STEP_MS = 60;
const PLAY_WINDOW = 12;

/** Two overlaid (never stacked) monthly detection curves behind the slider track. */
function Histogram({ index, range }: { index: FireIndex | null; range: readonly [number, number] }) {
  const paths = useMemo(() => {
    if (!index) return null;
    const W = MONTH_COUNT;
    const H = 32;
    const max = Math.max(...index.MODIS.histogram, ...index.VIIRS.histogram, 1);
    const toPath = (hist: Int32Array, from = 0) => {
      let d = `M${from} ${H}`;
      for (let i = from; i < W; i++) d += `L${i + 0.5} ${H - Math.sqrt(hist[i]! / max) * H}`;
      return `${d}L${W} ${H}Z`;
    };
    return { modis: toPath(index.MODIS.histogram), viirs: toPath(index.VIIRS.histogram, VIIRS_START_INDEX) };
  }, [index]);
  if (!paths) return null;
  const clipId = 'el-hist-window';
  return (
    <svg
      aria-hidden
      viewBox={`0 0 ${MONTH_COUNT} 32`}
      preserveAspectRatio="none"
      className="pointer-events-none absolute inset-x-0 bottom-[calc(50%+6px)] h-8 w-full"
    >
      <defs>
        <clipPath id={clipId}>
          <rect x={range[0]} y="0" width={range[1] - range[0] + 1} height="32" />
        </clipPath>
      </defs>
      <g opacity="0.28">
        <path d={paths.viirs} fill="var(--el-viirs)" fillOpacity="0.35" />
        <path d={paths.modis} fill="var(--el-modis)" fillOpacity="0.45" />
      </g>
      <g clipPath={`url(#${clipId})`}>
        <path d={paths.viirs} fill="var(--el-viirs)" fillOpacity="0.4" stroke="var(--el-viirs)" strokeWidth="0.6" vectorEffect="non-scaling-stroke" />
        <path d={paths.modis} fill="var(--el-modis)" fillOpacity="0.5" stroke="var(--el-modis)" strokeWidth="0.6" vectorEffect="non-scaling-stroke" />
      </g>
      <line x1={VIIRS_START_INDEX} x2={VIIRS_START_INDEX} y1="0" y2="32" stroke="var(--el-viirs)" strokeWidth="1" strokeDasharray="2 2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function TimeBar({ index, compact = false }: { index: FireIndex | null; compact?: boolean }) {
  const { m, fmt } = useI18n();
  const { range, setRange } = useAppParams();
  const live = useTimeStore((s) => s.live);
  const playing = useTimeStore((s) => s.playing);
  const { setLive, setPlaying } = useTimeStore.getState();
  const value = live ?? range;
  const valueRef = useRef(value);
  valueRef.current = value;

  const commit = (v: [number, number]) => {
    setRange(v);
    setLive(null);
  };

  useEffect(() => {
    if (!playing) return;
    const id = window.setInterval(() => {
      const [a, b] = valueRef.current;
      if (b >= MAX) {
        window.clearInterval(id);
        setPlaying(false);
        commit([a, b]);
        return;
      }
      setLive([a + 1, b + 1]);
    }, STEP_MS);
    return () => window.clearInterval(id);
    // commit/setRange identity is stable enough; restarting the timer on each render would stutter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing]);

  // Stop playback when the map screen unmounts.
  useEffect(() => () => useTimeStore.getState().setPlaying(false), []);

  const togglePlay = () => {
    if (playing) {
      setPlaying(false);
      commit(valueRef.current);
      return;
    }
    let [a, b] = valueRef.current;
    if (b - a >= MAX - 24) [a, b] = [0, PLAY_WINDOW - 1];
    else if (b >= MAX) [a, b] = [0, b - a];
    setLive([a, b]);
    setPlaying(true);
  };

  const label = (i: number) => {
    const { year, month } = fromMonthIndex(i);
    return fmt.yearMonth(year, month);
  };
  const isFull = value[0] === FULL_RANGE[0] && value[1] === FULL_RANGE[1];
  const years = [2000, 2005, 2010, 2015, 2020, 2025];

  return (
    <div>
      <div className="flex items-center gap-3">
        <IconButton
          icon={playing ? 'pause' : 'play'}
          label={playing ? m.map.time.pause : m.map.time.play}
          aria-pressed={playing}
          onClick={togglePlay}
          className="flex-none"
        />
        <div className="min-w-0 flex-1">
          <p className="eyebrow m-0">{m.map.time.label}</p>
          <p className="num m-0 truncate text-[14px] text-ink" aria-live={playing ? 'off' : 'polite'}>
            {label(value[0])} <span className="text-ink-dim">—</span> {label(value[1])}
          </p>
        </div>
        <Button
          variant="quiet"
          size="sm"
          icon="reset"
          disabled={isFull && !playing}
          onClick={() => {
            setPlaying(false);
            commit([...FULL_RANGE]);
          }}
          className={cn(compact && '!px-2.5')}
        >
          {compact ? <span className="sr-only">{m.map.time.reset}</span> : m.map.time.reset}
        </Button>
      </div>
      <div className="relative mt-2">
        <RangeSlider
          min={0}
          max={MAX}
          value={value}
          labels={[m.map.time.start, m.map.time.end]}
          formatValue={label}
          minGap={0}
          pageStep={12}
          className="!h-14"
          onChange={(v) => {
            if (playing) setPlaying(false);
            setLive(v);
          }}
          onCommit={commit}
        >
          <Histogram index={index} range={value} />
        </RangeSlider>
        <div aria-hidden className="relative h-4">
          {years.map((y) => (
            <span
              key={y}
              className="num absolute top-0 -translate-x-1/2 text-[10.5px] text-ink-dim"
              style={{ left: `${(((y - 2000) * 12) / MAX) * 100}%` }}
            >
              {y}
            </span>
          ))}
          <span
            className="num absolute -top-[66px] -translate-x-1/2 rounded-pill border border-[rgb(154_166_255/0.35)] bg-[var(--el-panel)] px-1.5 text-[9.5px] uppercase tracking-[0.1em] text-viirs"
            style={{ left: `${(VIIRS_START_INDEX / MAX) * 100}%` }}
          >
            {m.map.time.viirs}
          </span>
        </div>
      </div>
      <p className="sr-only">{m.map.time.histogram}</p>
    </div>
  );
}
