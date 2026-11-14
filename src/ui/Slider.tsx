import { useCallback, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { cn } from './cn';

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}

function keyDelta(e: KeyboardEvent, step: number, pageStep: number): number | 'min' | 'max' | null {
  switch (e.key) {
    case 'ArrowRight':
    case 'ArrowUp':
      return step;
    case 'ArrowLeft':
    case 'ArrowDown':
      return -step;
    case 'PageUp':
      return pageStep;
    case 'PageDown':
      return -pageStep;
    case 'Home':
      return 'min';
    case 'End':
      return 'max';
    default:
      return null;
  }
}

interface RangeSliderProps {
  min: number;
  max: number;
  step?: number;
  pageStep?: number;
  /** Minimum distance between thumbs. */
  minGap?: number;
  value: readonly [number, number];
  onChange: (value: [number, number]) => void;
  /** Fired when a drag or key interaction ends. */
  onCommit?: (value: [number, number]) => void;
  labels: [string, string];
  formatValue: (v: number) => string;
  disabled?: boolean;
  className?: string;
  /** Decorations drawn under the track (histogram, markers). */
  children?: ReactNode;
}

type DragMode = { kind: 'thumb'; index: 0 | 1 } | { kind: 'window'; origin: number; start: [number, number] };

/**
 * Two-thumb slider with full keyboard support (arrows, PageUp/Down, Home/End).
 * Dragging the filled segment moves the whole window — handy for scrubbing through time.
 */
export function RangeSlider({
  min,
  max,
  step = 1,
  pageStep = 12,
  minGap = 0,
  value,
  onChange,
  onCommit,
  labels,
  formatValue,
  disabled,
  className,
  children,
}: RangeSliderProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragMode | null>(null);
  const latest = useRef(value);
  latest.current = value;
  const [dragging, setDragging] = useState<0 | 1 | 'window' | null>(null);

  const toValue = useCallback(
    (clientX: number) => {
      const rect = rootRef.current!.getBoundingClientRect();
      const ratio = clamp((clientX - rect.left) / rect.width, 0, 1);
      return Math.round((min + ratio * (max - min)) / step) * step;
    },
    [min, max, step],
  );

  const setThumb = useCallback(
    (index: 0 | 1, v: number) => {
      const [a, b] = latest.current;
      const next: [number, number] =
        index === 0 ? [clamp(v, min, b - minGap), b] : [a, clamp(v, a + minGap, max)];
      if (next[0] !== a || next[1] !== b) onChange(next);
      return next;
    },
    [min, max, minGap, onChange],
  );

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled || e.button !== 0) return;
    const target = e.target as HTMLElement;
    const v = toValue(e.clientX);
    const [a, b] = latest.current;
    if (target.dataset.role === 'window') {
      dragRef.current = { kind: 'window', origin: v, start: [a, b] };
      setDragging('window');
    } else {
      const thumbAttr = target.dataset.thumb;
      const index: 0 | 1 = thumbAttr ? (Number(thumbAttr) as 0 | 1) : Math.abs(v - a) <= Math.abs(v - b) ? 0 : 1;
      dragRef.current = { kind: 'thumb', index };
      setDragging(index);
      if (!thumbAttr) setThumb(index, v);
      rootRef.current?.querySelector<HTMLElement>(`[data-thumb="${index}"]`)?.focus({ preventScroll: true });
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const v = toValue(e.clientX);
    if (drag.kind === 'thumb') {
      setThumb(drag.index, v);
    } else {
      const width = drag.start[1] - drag.start[0];
      const a = clamp(drag.start[0] + (v - drag.origin), min, max - width);
      const next: [number, number] = [a, a + width];
      if (next[0] !== latest.current[0]) onChange(next);
    }
  };

  const endDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setDragging(null);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    onCommit?.([latest.current[0], latest.current[1]]);
  };

  const onKeyDown = (index: 0 | 1) => (e: KeyboardEvent<HTMLDivElement>) => {
    const d = keyDelta(e, step, pageStep);
    if (d === null) return;
    e.preventDefault();
    const current = latest.current[index];
    const target = d === 'min' ? min : d === 'max' ? max : current + d;
    const next = setThumb(index, target);
    onCommit?.(next);
  };

  const pct = (v: number) => ((v - min) / (max - min)) * 100;
  const [a, b] = value;

  return (
    <div
      ref={rootRef}
      className={cn('slider', className)}
      aria-disabled={disabled || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      {children}
      <div className="slider__track" />
      <div
        className="slider__fill"
        data-role="window"
        style={{ left: `${pct(a)}%`, width: `${pct(b) - pct(a)}%`, cursor: dragging === 'window' ? 'grabbing' : 'grab', height: 8, marginTop: -4 }}
      />
      {([0, 1] as const).map((i) => (
        <div
          key={i}
          role="slider"
          tabIndex={disabled ? -1 : 0}
          data-thumb={i}
          data-dragging={dragging === i || undefined}
          aria-label={labels[i]}
          aria-valuemin={i === 0 ? min : a + minGap}
          aria-valuemax={i === 0 ? b - minGap : max}
          aria-valuenow={value[i]}
          aria-valuetext={formatValue(value[i])}
          aria-orientation="horizontal"
          className="slider__thumb"
          style={{ left: `${pct(value[i])}%` }}
          onKeyDown={onKeyDown(i)}
        />
      ))}
    </div>
  );
}

interface SliderProps {
  min: number;
  max: number;
  step?: number;
  value: number;
  onChange: (value: number) => void;
  onCommit?: (value: number) => void;
  label: string;
  formatValue: (v: number) => string;
  className?: string;
  disabled?: boolean;
  /** Paint the filled part (default: ember gradient). */
  fillStyle?: string;
}

export function Slider({ min, max, step = 1, value, onChange, onCommit, label, formatValue, className, disabled, fillStyle }: SliderProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const [dragging, setDragging] = useState(false);
  const latest = useRef(value);
  latest.current = value;

  const toValue = (clientX: number) => {
    const rect = rootRef.current!.getBoundingClientRect();
    const ratio = clamp((clientX - rect.left) / rect.width, 0, 1);
    return clamp(Math.round((min + ratio * (max - min)) / step) * step, min, max);
  };
  const set = (v: number) => {
    if (v !== latest.current) onChange(v);
  };
  const pct = ((value - min) / (max - min)) * 100;

  return (
    <div
      ref={rootRef}
      className={cn('slider', className)}
      aria-disabled={disabled || undefined}
      onPointerDown={(e) => {
        if (disabled || e.button !== 0) return;
        draggingRef.current = true;
        setDragging(true);
        set(toValue(e.clientX));
        e.currentTarget.setPointerCapture(e.pointerId);
        rootRef.current?.querySelector<HTMLElement>('[role="slider"]')?.focus({ preventScroll: true });
        e.preventDefault();
      }}
      onPointerMove={(e) => draggingRef.current && set(toValue(e.clientX))}
      onPointerUp={(e) => {
        if (!draggingRef.current) return;
        draggingRef.current = false;
        setDragging(false);
        e.currentTarget.releasePointerCapture(e.pointerId);
        onCommit?.(latest.current);
      }}
      onPointerCancel={() => {
        draggingRef.current = false;
        setDragging(false);
      }}
    >
      <div className="slider__track" />
      <div className="slider__fill" style={{ left: 0, width: `${pct}%`, background: fillStyle }} />
      <div
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-valuetext={formatValue(value)}
        className="slider__thumb"
        data-dragging={dragging || undefined}
        style={{ left: `${pct}%` }}
        onKeyDown={(e) => {
          const d = keyDelta(e, step, (max - min) / 10);
          if (d === null) return;
          e.preventDefault();
          const v = d === 'min' ? min : d === 'max' ? max : clamp(latest.current + d, min, max);
          set(v);
          onCommit?.(v);
        }}
      />
    </div>
  );
}
