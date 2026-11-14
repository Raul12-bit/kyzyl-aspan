import { useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from './cn';

/* ------------------------------------------------------------------ Chip */

interface ChipProps {
  children: ReactNode;
  pressed?: boolean;
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
  leading?: ReactNode;
  title?: string;
}

/** A pressable chip when `onClick` is set, otherwise a static tag. */
export function Chip({ children, pressed, onClick, disabled, className, leading, title }: ChipProps) {
  if (!onClick) {
    return (
      <span className={cn('chip', className)} title={title}>
        {leading}
        {children}
      </span>
    );
  }
  return (
    <button
      type="button"
      className={cn('chip', className)}
      aria-pressed={pressed}
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      {leading}
      {children}
    </button>
  );
}

/* ------------------------------------------------------------------ Switch */

interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: string;
  labelledBy?: string;
  describedBy?: string;
  disabled?: boolean;
  /** Colour of the "on" state (sensor identity). */
  color?: string;
  id?: string;
}

export function Switch({ checked, onChange, label, labelledBy, describedBy, disabled, color, id }: SwitchProps) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={labelledBy ? undefined : label}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      disabled={disabled}
      className="switch"
      style={color ? ({ '--switch-color': color } as CSSProperties) : undefined}
      onClick={() => onChange(!checked)}
    />
  );
}

/* ------------------------------------------------------------------ Segmented */

interface SegmentedProps<T extends string> {
  value: T;
  options: readonly { value: T; label: string; disabled?: boolean }[];
  onChange: (value: T) => void;
  label: string;
  className?: string;
  size?: 'sm' | 'md';
}

/** Radio-group semantics with roving tabindex; arrows move and select. Animated thumb. */
export function Segmented<T extends string>({ value, options, onChange, label, className }: SegmentedProps<T>) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = useState<{ x: number; w: number } | null>(null);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const measure = () => {
      const active = root.querySelector<HTMLButtonElement>('[aria-checked="true"]');
      if (active) setThumb({ x: active.offsetLeft, w: active.offsetWidth });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(root);
    return () => ro.disconnect();
  }, [value, options]);

  const enabled = options.filter((o) => !o.disabled);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const idx = enabled.findIndex((o) => o.value === value);
    let next = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (idx + 1) % enabled.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (idx - 1 + enabled.length) % enabled.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = enabled.length - 1;
    if (next < 0) return;
    e.preventDefault();
    const target = enabled[next]!;
    onChange(target.value);
    requestAnimationFrame(() =>
      rootRef.current?.querySelector<HTMLButtonElement>(`[data-value="${CSS.escape(target.value)}"]`)?.focus(),
    );
  };

  return (
    <div ref={rootRef} role="radiogroup" aria-label={label} className={cn('seg', className)} onKeyDown={onKeyDown}>
      {thumb ? (
        <span className="seg__thumb" aria-hidden style={{ width: thumb.w, transform: `translateX(${thumb.x - 3}px)`, left: 3 }} />
      ) : null}
      {options.map((o) => {
        const checked = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            data-value={o.value}
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            disabled={o.disabled}
            className="seg__item"
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ Skeleton */

export function Skeleton({ className, style }: { className?: string; style?: CSSProperties }) {
  return <div className={cn('skeleton', className)} style={style} aria-hidden />;
}

/* ------------------------------------------------------------------ Spinner */

export function Spinner({ size = 16, label }: { size?: number; label?: string }) {
  return (
    <span role={label ? 'status' : undefined} aria-label={label} className="inline-flex">
      <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden style={{ animation: 'el-spin 0.9s linear infinite' }}>
        <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2.5" />
        <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
      </svg>
    </span>
  );
}

/* ------------------------------------------------------------------ Hexagon glyph + sensor marks */

/** Pointy-top hexagon — the product's one shape (H3 cells, markers, legends). */
export function Hex({ size = 10, fill = 'currentColor', stroke, strokeWidth = 1.5, className }: { size?: number; fill?: string; stroke?: string; strokeWidth?: number; className?: string }) {
  const h = size * 1.1547;
  return (
    <svg aria-hidden width={size} height={h} viewBox="0 0 100 115.47" className={cn('inline-block flex-none', className)}>
      <polygon
        points="50,4 96,30.7 96,84.8 50,111.5 4,84.8 4,30.7"
        fill={fill}
        stroke={stroke}
        strokeWidth={stroke ? (strokeWidth * 100) / size : 0}
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Legend glyphs. MODIS = outline hexagon (steel), VIIRS = filled hexagon (amber), harmonized = ink line.
 * Shape + colour, so the encoding survives colour blindness.
 */
export function SensorMark({ kind, size = 10 }: { kind: 'MODIS' | 'VIIRS' | 'harmonized' | 'band'; size?: number }) {
  if (kind === 'MODIS') return <Hex size={size} fill="transparent" stroke="var(--el-modis)" strokeWidth={1.6} />;
  if (kind === 'VIIRS') return <Hex size={size} fill="var(--el-viirs)" />;
  if (kind === 'band') {
    return (
      <span
        aria-hidden
        className="inline-block flex-none"
        style={{ width: size * 1.8, height: size, borderRadius: 2, background: 'var(--el-band)', border: '1px solid var(--el-line-strong)' }}
      />
    );
  }
  return <span aria-hidden className="inline-block flex-none" style={{ width: size * 1.8, height: 2, borderRadius: 2, background: 'var(--el-harmonized)' }} />;
}
