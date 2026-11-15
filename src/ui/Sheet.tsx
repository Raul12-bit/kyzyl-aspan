import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { cn } from './cn';
import { Icon } from './Icon';

export type SheetSnap = 'peek' | 'half' | 'full';
const ORDER: SheetSnap[] = ['peek', 'half', 'full'];

interface SheetProps {
  label: string;
  snap: SheetSnap;
  onSnapChange: (snap: SheetSnap) => void;
  /** Always-visible area under the grab handle (tabs, summary). */
  header?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Height of the peek state in px. */
  peek?: number;
  /** Extra id for tour targeting. */
  id?: string;
  /** Text of the explicit expand / collapse button (the handle alone is easy to miss). */
  expandLabel?: string;
  collapseLabel?: string;
}

function snapHeight(snap: SheetSnap, peek: number, viewport: number): number {
  if (snap === 'peek') return peek;
  if (snap === 'half') return Math.round(viewport * 0.52);
  return viewport - 72;
}

/**
 * Mobile bottom sheet with three snap points. Drag the handle (with fling velocity), activate it with
 * Enter/Space to cycle, or use the explicit expand / collapse button. Content scrolls inside.
 *
 * The sheet is always laid out at full height and slid down with a transform (cheap to animate), so at the
 * peek and half snaps its lower part is below the screen edge. The scroll area pads its end by exactly that
 * hidden height: scrolled to the bottom, the last control sits at the visible edge instead of off-screen.
 */
export function Sheet({ label, snap, onSnapChange, header, children, className, peek = 148, id, expandLabel, collapseLabel }: SheetProps) {
  const [vh, setVh] = useState(() => (typeof window === 'undefined' ? 800 : window.innerHeight));
  const [drag, setDrag] = useState<number | null>(null);
  const start = useRef<{ y: number; h: number; t: number } | null>(null);
  const contentId = useId();

  useEffect(() => {
    const onResize = () => setVh(window.innerHeight);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const full = snapHeight('full', peek, vh);
  const target = snapHeight(snap, peek, vh);
  const height = drag ?? target;
  /** Height of the sheet below the screen edge at the current snap (not while dragging: no layout jank). */
  const hiddenBelow = Math.max(0, full - target);
  const expanded = snap === 'full';

  const settle = (h: number, velocity: number) => {
    const projected = h - velocity * 180; // px/ms → fling projection
    let best: SheetSnap = 'peek';
    let bestD = Number.POSITIVE_INFINITY;
    for (const s of ORDER) {
      const d = Math.abs(snapHeight(s, peek, vh) - projected);
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    onSnapChange(best);
  };

  return (
    <section
      id={id}
      aria-label={label}
      className={cn('glass fixed inset-x-0 bottom-0 flex flex-col !rounded-b-none', className)}
      style={{
        height: full,
        transform: `translate3d(0, ${full - height}px, 0)`,
        transition: drag === null ? 'transform var(--el-dur-panel) var(--el-ease-emphasized)' : 'none',
        zIndex: 'var(--el-z-sheet)' as unknown as number,
        paddingBottom: 'env(safe-area-inset-bottom)',
      }}
    >
      <div className="relative flex h-8 flex-none items-center justify-center">
      <button
        type="button"
        aria-label={label}
        aria-expanded={snap !== 'peek'}
        aria-controls={contentId}
        className="mx-auto flex h-7 w-24 flex-none cursor-grab touch-none items-center justify-center rounded-pill focus-visible:shadow-[var(--el-focus-ring)] focus-visible:outline-none"
        onPointerDown={(e) => {
          start.current = { y: e.clientY, h: height, t: performance.now() };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (!start.current) return;
          const h = Math.min(full, Math.max(peek * 0.7, start.current.h + (start.current.y - e.clientY)));
          setDrag(h);
        }}
        onPointerUp={(e) => {
          const s = start.current;
          start.current = null;
          if (!s) return;
          const moved = Math.abs(e.clientY - s.y);
          if (moved < 6) {
            // treat as a tap: cycle
            setDrag(null);
            onSnapChange(ORDER[(ORDER.indexOf(snap) + 1) % ORDER.length]!);
            return;
          }
          const dt = Math.max(1, performance.now() - s.t);
          const velocity = (e.clientY - s.y) / dt;
          const h = drag ?? height;
          setDrag(null);
          settle(h, velocity);
        }}
        onPointerCancel={() => {
          start.current = null;
          setDrag(null);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onSnapChange(ORDER[(ORDER.indexOf(snap) + 1) % ORDER.length]!);
          }
        }}
      >
        <span aria-hidden className="block h-1 w-10 rounded-pill bg-[var(--el-line-hover)]" />
      </button>
      {expandLabel && collapseLabel ? (
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={contentId}
          onClick={() => onSnapChange(expanded ? 'peek' : 'full')}
          className="absolute right-2 top-1/2 inline-flex h-8 -translate-y-1/2 cursor-pointer items-center gap-1 rounded-pill border-0 bg-transparent px-2.5 text-[12px] font-medium text-ink-muted hover:text-ink focus-visible:shadow-[var(--el-focus-ring)] focus-visible:outline-none"
        >
          <Icon name="chevronDown" size={14} className={cn('transition-transform', !expanded && 'rotate-180')} />
          {expanded ? collapseLabel : expandLabel}
        </button>
      ) : null}
      </div>
      {header ? <div className="flex-none px-4 pb-3">{header}</div> : null}
      <div id={contentId} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4" style={{ paddingBottom: hiddenBelow + 24 }}>
        {children}
      </div>
    </section>
  );
}
