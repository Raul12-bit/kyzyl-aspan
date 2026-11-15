import { useDataMode } from '@/features/helios/api';
import { useI18n } from '@/i18n';
import { cn, Hex, Tooltip } from '@/ui';

/**
 * Where the numbers on screen come from — shown wherever fire data is: the map, its statistics and charts.
 * "Synthetic demo data" (amber) while the session runs on the generated archive, "Real NASA FIRMS data"
 * (mint) when the HELIOS API serves the real one. Nothing while the start-up probe is still running, so
 * the label never flips from one claim to the other.
 *
 * `overlay`: a glass chip over the map. `inline`: a small label next to a heading or a chart.
 */
export function DataBadge({
  variant = 'inline',
  className,
}: {
  variant?: 'overlay' | 'inline';
  className?: string;
}) {
  const { m } = useI18n();
  const mode = useDataMode();
  if (mode === 'pending') return null;
  const real = mode === 'http';
  const color = real ? 'var(--el-trust-high)' : 'var(--el-amber)';
  const label = real ? m.app.realData : m.app.synthetic;
  return (
    <Tooltip
      content={real ? m.app.realDataHint : m.app.syntheticHint}
      placement={variant === 'overlay' ? 'bottom' : 'top'}
    >
      <span
        tabIndex={0}
        data-data-mode={real ? 'real' : 'synthetic'}
        className={cn(
          'inline-flex flex-none items-center gap-1.5 whitespace-nowrap rounded-pill font-medium outline-none focus-visible:shadow-[var(--el-focus-ring)]',
          variant === 'overlay'
            ? 'pointer-events-auto min-h-8 border px-3 text-[12.5px] backdrop-blur-md'
            : 'min-h-5 border px-2 text-[11px] leading-none',
          className,
        )}
        style={{
          color,
          borderColor: `color-mix(in srgb, ${color} 42%, transparent)`,
          background:
            variant === 'overlay'
              ? 'color-mix(in srgb, var(--el-panel) 88%, transparent)'
              : `color-mix(in srgb, ${color} 9%, transparent)`,
        }}
      >
        <Hex
          size={variant === 'overlay' ? 9 : 7}
          fill={real ? color : 'transparent'}
          stroke={real ? undefined : color}
          strokeWidth={1.4}
        />
        {label}
      </span>
    </Tooltip>
  );
}
