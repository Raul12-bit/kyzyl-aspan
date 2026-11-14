import { useEffect, useId, useRef, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useReveal } from '@/features/intro/useReveal';
import { useI18n } from '@/i18n';
import { cn, Icon, Tooltip } from '@/ui';
import { LanguageSwitch } from './LanguageSwitch';
import { Logo } from './Logo';

function NavItems({ onNavigate, vertical }: { onNavigate?: () => void; vertical?: boolean }) {
  const { m } = useI18n();
  const { search } = useLocation();
  const items = [
    { to: '/', label: m.app.nav.map, icon: 'map' as const, end: true },
    { to: '/mission', label: m.app.nav.mission, icon: 'satellite' as const },
    { to: '/method', label: m.app.nav.method, icon: 'help' as const },
  ];
  return (
    <ul className={cn('m-0 flex list-none gap-1 p-0', vertical && 'flex-col gap-0.5')}>
      {items.map((item) => (
        <li key={item.to}>
          <NavLink
            to={{ pathname: item.to, search }}
            end={item.end}
            onClick={onNavigate}
            className={({ isActive }) =>
              cn(
                'flex h-9 items-center gap-2 rounded-pill px-3.5 text-[13.5px] font-medium no-underline transition-colors duration-200 focus-visible:shadow-[var(--el-focus-ring)] focus-visible:outline-none',
                vertical && 'h-12 rounded-control px-4 text-[15px]',
                isActive ? 'bg-[rgb(255_255_255/0.08)] text-ink' : 'text-ink-muted hover:bg-hover hover:text-ink',
              )
            }
          >
            {vertical ? <Icon name={item.icon} size={18} /> : null}
            {item.label}
          </NavLink>
        </li>
      ))}
    </ul>
  );
}

function MobileMenu() {
  const { m } = useI18n();
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const { pathname } = useLocation();

  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    const onClick = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onClick);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onClick);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative md:hidden">
      <button
        type="button"
        className="icon-btn"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={m.app.nav.label}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name={open ? 'close' : 'menu'} size={18} />
      </button>
      {open ? (
        <nav
          id={menuId}
          aria-label={m.app.nav.label}
          className="glass absolute right-0 top-[calc(100%+8px)] w-64 p-2"
          style={{ animation: 'el-rise-in 220ms var(--el-ease-emphasized) both', borderRadius: 16 }}
        >
          <NavItems vertical onNavigate={() => setOpen(false)} />
          <div className="mt-2 flex items-center justify-between border-t border-line px-2 pt-3">
            <span className="eyebrow">{m.app.language}</span>
            <LanguageSwitch />
          </div>
        </nav>
      ) : null}
    </div>
  );
}

export function TopBar({ overMap }: { overMap: boolean }) {
  const { m } = useI18n();
  const reveal = useReveal(0);
  // On the map the bar rides the intro reveal; elsewhere it is simply there.
  const revealProps = overMap ? reveal : { className: '', 'data-revealed': 'instant' as const, style: {} };

  return (
    <header
      className={cn('pointer-events-none fixed inset-x-0 top-0 px-[var(--el-gutter)] pt-3', revealProps.className)}
      data-revealed={revealProps['data-revealed']}
      style={{ ...revealProps.style, zIndex: 'var(--el-z-header)' as unknown as number }}
    >
      <div
        className={cn(
          'pointer-events-auto mx-auto flex h-[52px] max-w-[1600px] items-center justify-between gap-4 rounded-pill border border-line pl-4 pr-2',
          'bg-[rgb(8_12_22/0.72)] shadow-panel backdrop-blur-xl',
        )}
      >
        <NavLink to={{ pathname: '/' }} aria-label={`${m.app.name} — ${m.app.nav.map}`} className="rounded-pill focus-visible:shadow-[var(--el-focus-ring)] focus-visible:outline-none">
          <Logo />
        </NavLink>
        <nav aria-label={m.app.nav.label} className="hidden md:block">
          <NavItems />
        </nav>
        <div className="flex items-center gap-2">
          <Tooltip content={m.app.syntheticHint} placement="bottom">
            <button type="button" className="chip hidden cursor-help lg:inline-flex" aria-label={`${m.app.synthetic}. ${m.app.syntheticHint}`}>
              <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-trust-medium" />
              {m.app.synthetic}
            </button>
          </Tooltip>
          <div className="hidden md:block">
            <LanguageSwitch />
          </div>
          <MobileMenu />
        </div>
      </div>
    </header>
  );
}

