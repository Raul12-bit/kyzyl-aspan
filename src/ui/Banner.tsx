import type { ReactNode } from 'react';
import { Button } from './Button';
import { cn } from './cn';
import { Icon, type IconName } from './Icon';

type Tone = 'error' | 'warning' | 'info';

const TONE: Record<Tone, { icon: IconName; color: string; bg: string; border: string }> = {
  error: { icon: 'alert', color: 'var(--el-danger)', bg: 'var(--el-danger-bg)', border: 'color-mix(in srgb, var(--el-danger) 35%, transparent)' },
  warning: { icon: 'alert', color: 'var(--el-trust-medium)', bg: 'var(--el-warning-bg)', border: 'color-mix(in srgb, var(--el-trust-medium) 30%, transparent)' },
  info: { icon: 'info', color: 'var(--el-teal)', bg: 'var(--el-info-bg)', border: 'color-mix(in srgb, var(--el-teal) 30%, transparent)' },
};

interface BannerProps {
  tone?: Tone;
  title: ReactNode;
  children?: ReactNode;
  onRetry?: () => void;
  retryLabel?: string;
  onDismiss?: () => void;
  dismissLabel?: string;
  className?: string;
}

/** Inline status banner. Errors announce assertively; info/warnings politely. */
export function Banner({ tone = 'info', title, children, onRetry, retryLabel, onDismiss, dismissLabel, className }: BannerProps) {
  const t = TONE[tone];
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={cn('flex items-start gap-3 rounded-[14px] border px-4 py-3 text-sm backdrop-blur-md', className)}
      style={{ background: t.bg, borderColor: t.border }}
    >
      <span className="mt-0.5 flex-none" style={{ color: t.color }}>
        <Icon name={t.icon} size={18} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="m-0 font-medium text-ink">{title}</p>
        {children ? <div className="mt-1 text-ink-muted">{children}</div> : null}
      </div>
      {onRetry ? (
        <Button size="sm" variant="secondary" icon="refresh" onClick={onRetry} className="flex-none">
          {retryLabel}
        </Button>
      ) : null}
      {onDismiss ? (
        <button
          type="button"
          onClick={onDismiss}
          aria-label={dismissLabel}
          className="icon-btn icon-btn--sm icon-btn--ghost -mr-1 flex-none"
        >
          <Icon name="close" size={16} />
        </button>
      ) : null}
    </div>
  );
}
