import type { ReactNode } from 'react';
import { Slider } from '@/ui';

/** Shared layout of a mission section: kicker, headline, body on the left; the live simulation on the right. */
export function Section({
  id,
  kicker,
  title,
  body,
  aside,
  children,
}: {
  id: string;
  kicker: string;
  title: string;
  body: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="grid gap-6 border-t border-line pt-10 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-10 lg:pt-14">
      <div className="lg:sticky lg:top-[calc(var(--el-header-h)+32px)] lg:self-start">
        <p className="eyebrow m-0 !text-kyzyl">{kicker}</p>
        <h2 id={`${id}-title`} className="display m-0 mt-3 text-[clamp(1.4rem,1.6vw+0.9rem,2.1rem)] text-ink">
          {title}
        </h2>
        <p className="m-0 mt-4 max-w-[46ch] text-[15px] leading-relaxed text-ink-muted">{body}</p>
        {aside ? <div className="mt-6">{aside}</div> : null}
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  );
}

/** Tiny labelled meter (0…1) for probabilities and reliabilities. */
export function Meter({ value, color = 'var(--el-amber)', label }: { value: number; color?: string; label?: string }) {
  return (
    <span className="inline-flex items-center gap-2" aria-label={label}>
      <span className="relative h-1.5 w-16 overflow-hidden rounded-full bg-[var(--el-tint-3)]">
        <span className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${Math.round(value * 100)}%`, background: color }} />
      </span>
    </span>
  );
}

/** Slider with a visible label and live value (the base Slider only exposes them to assistive tech). */
export function LabeledSlider(props: Parameters<typeof Slider>[0]) {
  return (
    <div className="min-w-0">
      <div className="mb-2 flex items-baseline justify-between gap-3 text-[12px]">
        <span className="text-ink-dim">{props.label}</span>
        <span className="num text-ink">{props.formatValue(props.value)}</span>
      </div>
      <Slider {...props} />
    </div>
  );
}
