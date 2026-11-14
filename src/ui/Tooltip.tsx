import {
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

interface TooltipProps {
  content: ReactNode;
  children: ReactElement<Record<string, unknown>>;
  placement?: 'top' | 'bottom';
  /** Hover delay, ms (focus shows immediately). */
  delay?: number;
}

/**
 * Accessible tooltip: shows on hover and keyboard focus, hides on Escape / blur / leave,
 * links itself with aria-describedby. Rendered in a portal with fixed positioning.
 */
export function Tooltip({ content, children, placement = 'top', delay = 280 }: TooltipProps) {
  const id = useId();
  const triggerRef = useRef<HTMLElement | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; side: 'top' | 'bottom' } | null>(null);

  const show = useCallback((immediate: boolean) => {
    window.clearTimeout(timer.current);
    if (immediate) setOpen(true);
    else timer.current = window.setTimeout(() => setOpen(true), delay);
  }, [delay]);
  const hide = useCallback(() => {
    window.clearTimeout(timer.current);
    setOpen(false);
  }, []);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && hide();
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', hide, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', hide, true);
    };
  }, [open, hide]);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current || !tipRef.current) return;
    const r = triggerRef.current.getBoundingClientRect();
    const t = tipRef.current.getBoundingClientRect();
    const gap = 8;
    let side: 'top' | 'bottom' = placement;
    if (side === 'top' && r.top - t.height - gap < 8) side = 'bottom';
    if (side === 'bottom' && r.bottom + t.height + gap > window.innerHeight - 8) side = 'top';
    const top = side === 'top' ? r.top - t.height - gap : r.bottom + gap;
    const left = Math.min(Math.max(8, r.left + r.width / 2 - t.width / 2), window.innerWidth - t.width - 8);
    setPos({ top, left, side });
  }, [open, placement, content]);

  if (!isValidElement(children)) return children;

  const child = children as ReactElement<Record<string, unknown>>;
  const props = child.props as Record<string, (e: unknown) => void>;
  const trigger = cloneElement(child, {
    ref: (node: HTMLElement | null) => {
      triggerRef.current = node;
    },
    'aria-describedby': open ? id : undefined,
    onMouseEnter: (e: unknown) => {
      props.onMouseEnter?.(e);
      show(false);
    },
    onMouseLeave: (e: unknown) => {
      props.onMouseLeave?.(e);
      hide();
    },
    onFocus: (e: unknown) => {
      props.onFocus?.(e);
      show(true);
    },
    onBlur: (e: unknown) => {
      props.onBlur?.(e);
      hide();
    },
  });

  return (
    <>
      {trigger}
      {open
        ? createPortal(
            <div
              ref={tipRef}
              id={id}
              role="tooltip"
              className="tooltip"
              style={{ position: 'fixed', top: pos?.top ?? -9999, left: pos?.left ?? -9999 }}
            >
              {content}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
