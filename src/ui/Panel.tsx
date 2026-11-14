import { forwardRef, type HTMLAttributes, type ReactNode } from 'react';
import { cn } from './cn';

interface PanelProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  title?: ReactNode;
  eyebrow?: ReactNode;
  actions?: ReactNode;
  as?: 'section' | 'aside' | 'div';
  padded?: boolean;
}

/** Glass panel with an optional header row. */
export const Panel = forwardRef<HTMLElement, PanelProps>(function Panel(
  { title, eyebrow, actions, as: Tag = 'section', padded = true, className, children, ...rest },
  ref,
) {
  return (
    <Tag ref={ref as never} className={cn('glass', padded && 'p-6', className)} {...rest}>
      {title || actions || eyebrow ? (
        <header className="mb-5 flex items-start justify-between gap-3">
          <div className="min-w-0">
            {eyebrow ? <p className="eyebrow m-0 mb-1.5">{eyebrow}</p> : null}
            {title ? <h2 className="m-0 text-[19px] font-[440] leading-tight tracking-[-0.02em] text-ink">{title}</h2> : null}
          </div>
          {actions ? <div className="flex flex-none items-center gap-1">{actions}</div> : null}
        </header>
      ) : null}
      {children}
    </Tag>
  );
});

/** Plain card used inside pages (no blur, cheaper to stack). */
export function Card({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('rounded-panel border border-line bg-[var(--el-panel)] p-5 shadow-panel', className)}
      {...rest}
    >
      {children}
    </div>
  );
}
