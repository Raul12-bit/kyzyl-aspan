import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { geolocationSupported, useGeoStore } from '@/features/geo/geoStore';
import { LOCALE_INFO, LOCALES, useI18n, useLocaleStore, type Locale } from '@/i18n';
import { cn, Icon } from '@/ui';

/**
 * Language menu: native names (a visitor looks for their own language, not its English name),
 * full keyboard support, and a shortcut to re-run the location-based choice.
 */
export function LanguageSwitch({ align = 'right' }: { align?: 'left' | 'right' }) {
  const { m, locale } = useI18n();
  const setLocale = useLocaleStore((s) => s.setLocale);
  const locate = useGeoStore((s) => s.locate);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(() => LOCALES.indexOf(locale));
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    setActive(LOCALES.indexOf(locale));
    listRef.current?.focus();
    const onDown = (e: PointerEvent) => !rootRef.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('pointerdown', onDown);
    return () => window.removeEventListener('pointerdown', onDown);
  }, [open, locale]);

  const choose = (l: Locale) => {
    void setLocale(l, 'manual');
    setOpen(false);
    buttonRef.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => (i + 1) % LOCALES.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => (i - 1 + LOCALES.length) % LOCALES.length);
    } else if (e.key === 'Home') {
      e.preventDefault();
      setActive(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setActive(LOCALES.length - 1);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      choose(LOCALES[active]!);
    } else if (e.key === 'Escape' || e.key === 'Tab') {
      setOpen(false);
      if (e.key === 'Escape') buttonRef.current?.focus();
    }
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        className="chip !h-9 cursor-pointer gap-1.5 !px-3 hover:border-line-hover"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        aria-label={`${m.app.language}: ${LOCALE_INFO[locale].native}`}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="globe" size={16} className="text-ink-dim" />
        <span className="num text-[12px] font-medium uppercase text-ink">{locale}</span>
        <Icon name="chevronDown" size={14} className={cn('text-ink-dim transition-transform duration-200', open && 'rotate-180')} />
      </button>
      {open ? (
        <div
          className={cn('glass absolute top-[calc(100%+8px)] w-56 p-1.5', align === 'right' ? 'right-0' : 'left-0')}
          style={{ borderRadius: 16, animation: 'el-rise-in 200ms var(--el-ease-emphasized) both', zIndex: 'var(--el-z-popover)' as unknown as number }}
        >
          <ul
            ref={listRef}
            id={`${id}-list`}
            role="listbox"
            tabIndex={-1}
            aria-label={m.app.language}
            aria-activedescendant={`${id}-${LOCALES[active]}`}
            onKeyDown={onKeyDown}
            className="m-0 list-none p-0 outline-none"
          >
            {LOCALES.map((l, i) => (
              <li
                key={l}
                id={`${id}-${l}`}
                role="option"
                aria-selected={l === locale}
                lang={l}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(l)}
                className={cn(
                  'flex cursor-pointer items-center justify-between rounded-[10px] px-3 py-2 text-[14px]',
                  i === active ? 'bg-[var(--el-tint-3)] text-ink' : 'text-ink-muted',
                )}
              >
                <span>{LOCALE_INFO[l].native}</span>
                {l === locale ? <Icon name="check" size={16} className="text-kyzyl" /> : <span className="num text-[11px] uppercase text-ink-dim">{l}</span>}
              </li>
            ))}
          </ul>
          {geolocationSupported() ? (
            <>
              <div className="mx-2 my-1.5 h-px bg-line" />
              <button
                type="button"
                className="flex w-full cursor-pointer items-center gap-2 rounded-[10px] border-0 bg-transparent px-3 py-2 text-left text-[13px] text-ink-muted hover:bg-hover hover:text-ink"
                onClick={() => {
                  setOpen(false);
                  void locate({ forceLocale: true });
                }}
              >
                <Icon name="pin" size={16} className="text-kyzyl" />
                {m.app.useLocation}
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
