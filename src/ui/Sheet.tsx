import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from './cn';

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
}

function snapHeight(snap: SheetSnap, peek: number, viewport: number): number {
  if (snap === 'peek') return peek;
  if (snap === 'half') return Math.round(viewport * 0.52);
  return viewport - 72;
}

/**
 * Mobile bottom sheet with three snap points. Drag the handle (with fling velocity) or
 * activate it with Enter/Space to cycle. Content scrolls inside when expanded.
 */
export function Sheet({ label, snap, onSnapChange, header, children, className, peek = 148, id }: SheetProps) {
  const [vh, setVh] = useState(() => (typeof window === 'undefined' ? 800 : window.innerHeight));
  const [drag, setDrag] = useState<number | null>(null);
  const start = useRef<{ y: number; h: number; t: number } | null>(null);

  useEffect(() => {
    const onResize = () => setVh(window.innerHeight);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const full = snapHeight('full', peek, vh);
  const target = snapHeight(snap, peek, vh);
  const height = drag ?? target;

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
      <button
        type="button"
        aria-label={label}
        aria-expanded={snap !== 'peek'}
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
      {header ? <div className="flex-none px-4 pb-3">{header}</div> : null}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-6">{children}</div>
    </section>
  );
}
