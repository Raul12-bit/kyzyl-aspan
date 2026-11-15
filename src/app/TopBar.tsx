import { useEffect, useId, useRef, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useIntroStore } from '@/features/intro/introStore';
import { diveBridge } from '@/features/landing/diveBridge';
import { useReveal } from '@/features/intro/useReveal';
import { useI18n } from '@/i18n';
import { ButtonLink, cn, Icon } from '@/ui';
import { LanguageSwitch } from './LanguageSwitch';
import { Logo } from './Logo';

export type TopBarVariant = 'landing' | 'page' | 'map';

function NavItems({ onNavigate, vertical }: { onNavigate?: () => void; vertical?: boolean }) {
  const { m } = useI18n();
  const { search, pathname } = useLocation();
  const items = [
    { to: '/map', label: m.app.nav.map, icon: 'map' as const },
    { to: '/ai', label: m.app.nav.ai, icon: 'sparkles' as const },
    { to: '/method', label: m.app.nav.method, icon: 'help' as const },
  ];
  return (
    <ul className={cn('m-0 flex list-none items-center gap-1 p-0', vertical && 'flex-col items-stretch gap-0.5')}>
      {items.map((item) => (
        <li key={item.to}>
          <NavLink
            // Keep the area and time window when moving between the map and the explainers.
            to={{ pathname: item.to, search: pathname === '/' ? '' : search }}
            onClick={onNavigate}
            className={({ isActive }) =>
              cn(
                'relative flex h-9 items-center gap-2 rounded-pill px-3.5 text-[13.5px] font-[450] tracking-[-0.005em] no-underline transition-colors duration-200 focus-visible:shadow-[var(--el-focus-ring)] focus-visible:outline-none',
                vertical && 'h-12 rounded-control px-4 text-[15px]',
                isActive ? 'text-ink' : 'text-ink-muted hover:text-ink',
                isActive && !vertical && 'after:absolute after:left-1/2 after:-bottom-[2px] after:h-[3px] after:w-[3px] after:-translate-x-1/2 after:rounded-full after:bg-gold',
                vertical && isActive && 'bg-tint-2',
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

function MobileMenu({ showCta, onCta }: { showCta: boolean; onCta: (e: React.MouseEvent) => void }) {
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
        className="icon-btn icon-btn--ghost"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={m.app.nav.label}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name={open ? 'close' : 'menu'} size={20} />
      </button>
      {open ? (
        <nav
          id={menuId}
          aria-label={m.app.nav.label}
          className="glass absolute right-0 top-[calc(100%+10px)] w-[min(300px,calc(100vw-2*var(--el-gutter)))] p-2"
          style={{ animation: 'el-rise-in 240ms var(--el-ease-emphasized) both', borderRadius: 20 }}
        >
          <NavItems vertical onNavigate={() => setOpen(false)} />
          <div className="mt-2 flex items-center gap-2 border-t border-line px-2 pt-3">
            <LanguageSwitch />
          </div>
          {showCta ? (
            <ButtonLink to="/map" variant="primary" className="mt-3 w-full" iconRight="arrowRight" onClick={(e) => {
                setOpen(false);
                onCta(e);
              }}>
              {m.landing.navCta}
            </ButtonLink>
          ) : null}
        </nav>
      ) : null}
    </div>
  );
}

/** True once the page has scrolled past the very top. */
function useScrolled(threshold = 16): boolean {
  const [scrolled, setScrolled] = useState(() => typeof window !== 'undefined' && window.scrollY > threshold);
  useEffect(() => {
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setScrolled(window.scrollY > threshold));
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('scroll', onScroll);
    };
  }, [threshold]);
  return scrolled;
}

export function TopBar({ variant }: { variant: TopBarVariant }) {
  const { m } = useI18n();
  const reveal = useReveal(0);
  const scrolled = useScrolled();
  const phase = useIntroStore((s) => s.phase);
  const onMap = variant === 'map';
  // On the map the bar rides the intro reveal; elsewhere it is simply there.
  const revealProps = onMap ? reveal : { className: '', 'data-revealed': 'instant' as const, style: {} };
  // The bar steps aside while the planet dives.
  const diving = variant === 'landing' && phase !== 'intro' && phase !== 'done';
  const solid = onMap || scrolled || variant === 'page';
  // On the landing page, "Open map" dives into the planet while it is still on screen.
  const onCta = (e: React.MouseEvent) => {
    if (variant !== 'landing' || !diveBridge.start || window.scrollY > window.innerHeight * 0.5) return;
    e.preventDefault();
    diveBridge.start();
  };

  return (
    <header
      className={cn('site-header pointer-events-none fixed inset-x-0 top-0', revealProps.className)}
      data-revealed={revealProps['data-revealed']}
      data-solid={solid ? 'true' : 'false'}
      style={
        // The map bar rides the intro reveal; the site bar only fades away while the planet dives.
        // (Never mix the `transition` shorthand with the reveal's transitionDelay/Duration.)
        onMap
          ? { ...revealProps.style, zIndex: 'var(--el-z-header)' as unknown as number }
          : { zIndex: 'var(--el-z-header)' as unknown as number, opacity: diving ? 0 : 1, transition: 'opacity 220ms ease' }
      }
    >
      <div
        className={cn(
          'pointer-events-auto relative mx-auto flex items-center justify-between gap-4',
          // Same bar on every screen; on the map it spans the full width so it lines up with the panels.
          'site-header__inner h-[var(--el-header-h)]',
          onMap && 'site-header__inner--wide',
        )}
      >
        <div className="flex flex-1 items-center">
          <NavLink
            to="/"
            aria-label={m.app.name}
            className="rounded-pill focus-visible:shadow-[var(--el-focus-ring)] focus-visible:outline-none"
          >
            <Logo />
          </NavLink>
        </div>
        <nav aria-label={m.app.nav.label} className="hidden md:block">
          <NavItems />
        </nav>
        <div className="flex flex-1 items-center justify-end gap-1.5">
          <div className="hidden items-center gap-1 md:flex">
            <LanguageSwitch />
          </div>
          {!onMap ? (
            <ButtonLink to="/map" variant="primary" size="sm" className="ml-1.5 hidden md:inline-flex" onClick={onCta}>
              {m.landing.navCta}
            </ButtonLink>
          ) : null}
          <MobileMenu showCta={!onMap} onCta={onCta} />
        </div>
      </div>
    </header>
  );
}
