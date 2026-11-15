import { lazy, Suspense, useEffect, useId, useRef, type KeyboardEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useHeliosAvailable } from '@/features/helios/api';
import { useI18n } from '@/i18n';
import { Skeleton } from '@/ui';
import { useAiServerStatus } from './groundClient';
import { SystemTab } from './SystemTab';
import './ailab.css';

const DetectionTab = lazy(() => import('./DetectionTab'));
const LinksTab = lazy(() => import('./LinksTab'));
const GroundTab = lazy(() => import('./GroundTab'));
const FusionTab = lazy(() => import('./FusionTab'));

const TABS = ['system', 'ai1', 'ai2', 'ai3', 'fusion'] as const;
type LabTab = (typeof TABS)[number];

function tabFromHash(hash: string): LabTab {
  const h = hash.replace('#', '');
  return (TABS as readonly string[]).includes(h) ? (h as LabTab) : 'system';
}

function StatusChip({ tone, children }: { tone: 'on' | 'off' | 'wait'; children: string }) {
  return (
    <span className="lab-status" data-tone={tone}>
      <span className="lab-status__dot" aria-hidden />
      {children}
    </span>
  );
}

/**
 * /ai — the AI lab: the three AIs and the MODIS × VIIRS fusion, each in a tab where it actually runs.
 * The tab lives in the URL hash (#ai1 …), so the landing cards and the map can link straight to it.
 */
export function AiLabPage() {
  const { m } = useI18n();
  const t = m.ai.lab;
  const { hash } = useLocation();
  const navigate = useNavigate();
  const tab = tabFromHash(hash);
  const server = useAiServerStatus();
  const helios = useHeliosAvailable();
  const baseId = useId();
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    document.title = `${m.app.nav.ai} — ${m.app.name}`;
  }, [m]);

  const select = (next: LabTab, focus = false) => {
    navigate({ hash: `#${next}` }, { replace: true });
    if (focus)
      requestAnimationFrame(() =>
        listRef.current?.querySelector<HTMLButtonElement>(`[data-tab="${next}"]`)?.focus(),
      );
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = TABS.indexOf(tab);
    let n = -1;
    if (e.key === 'ArrowRight') n = (i + 1) % TABS.length;
    else if (e.key === 'ArrowLeft') n = (i - 1 + TABS.length) % TABS.length;
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = TABS.length - 1;
    if (n < 0) return;
    e.preventDefault();
    select(TABS[n]!, true);
  };

  const serverChip = server.isPending ? (
    <StatusChip tone="wait">{t.status.checking}</StatusChip>
  ) : server.data?.online ? (
    <StatusChip tone="on">{t.status.server}</StatusChip>
  ) : (
    <StatusChip tone="off">{t.status.fallback}</StatusChip>
  );

  return (
    <main id="main" className="page lab">
      <div className="page-inner">
        <header className="lab-head">
          <p className="eyebrow m-0">{t.eyebrow}</p>
          <h1 className="display m-0 mt-4 text-[clamp(2rem,3.4vw+0.8rem,3.6rem)] text-ink">{t.title}</h1>
          <div className="orbit-rule mt-6 w-24" aria-hidden />
          <p className="m-0 mt-5 max-w-[64ch] text-[16px] leading-relaxed text-ink-muted md:text-[17px]">
            {t.lead}
          </p>
          <div className="mt-6 flex flex-wrap gap-2">
            <StatusChip tone="on">{t.status.browser}</StatusChip>
            {serverChip}
            <StatusChip tone={helios ? 'on' : 'off'}>
              {helios ? t.status.helios : t.status.heliosOff}
            </StatusChip>
          </div>
        </header>

        <div ref={listRef} role="tablist" aria-label={t.tabsLabel} className="lab-tabs" onKeyDown={onKeyDown}>
          {TABS.map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              id={`${baseId}-tab-${id}`}
              data-tab={id}
              aria-selected={tab === id}
              aria-controls={`${baseId}-panel`}
              tabIndex={tab === id ? 0 : -1}
              className="lab-tab"
              onClick={() => select(id)}
            >
              {t.tabs[id]}
            </button>
          ))}
        </div>

        <div
          role="tabpanel"
          id={`${baseId}-panel`}
          aria-labelledby={`${baseId}-tab-${tab}`}
          className="lab-panel"
          key={tab}
        >
          <Suspense fallback={<Skeleton className="h-[480px] w-full !rounded-panel" />}>
            {tab === 'system' ? <SystemTab onSelect={(id) => select(id)} /> : null}
            {tab === 'ai1' ? <DetectionTab /> : null}
            {tab === 'ai2' ? <LinksTab /> : null}
            {tab === 'ai3' ? <GroundTab serverOnline={server.data?.online ?? false} /> : null}
            {tab === 'fusion' ? <FusionTab /> : null}
          </Suspense>
        </div>
      </div>
    </main>
  );
}
