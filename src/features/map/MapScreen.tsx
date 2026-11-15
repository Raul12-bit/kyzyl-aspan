import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useAppParams } from '@/app/useAppParams';
import type { BBox } from '@/data/types';
import type { FireArchive } from '@/domain/archive';
import { nearestCountry } from '@/domain/countries';
import { loadCountries } from '@/features/geo/countries';
import { HeliosSync } from '@/features/helios/HeliosSync';
import { introSelectors } from '@/features/intro/introMachine';
import { useIntroStore, WORLD_BOUNDS } from '@/features/intro/introStore';
import { useReveal } from '@/features/intro/useReveal';
import { Tour } from '@/features/onboarding/Tour';
import { WorldSync } from '@/features/world/WorldSync';
import { useI18n } from '@/i18n';
import { BREAKPOINTS, useMediaQuery } from '@/lib/useMediaQuery';
import { Banner, cn, Icon, IconButton, Panel, Segmented, Sheet, Spinner, type SheetSnap } from '@/ui';
import { AreaPanelBody, SelectionSummary } from './AreaPanel';
import { flyToArea, zoomBy } from './camera';
import { LayersPanelBody } from './LayersPanel';
import { MapHover } from './MapHover';
import { useMapStore } from './mapStore';
import { MapSync } from './MapSync';
import { TimeBar } from './TimeBar';
import { useBoxDraw } from './useBoxDraw';
import { useFireIndex } from './useFireData';

function Reveal({ index, className, children, id }: { index: number; className?: string; children: ReactNode; id?: string }) {
  const r = useReveal(index);
  return (
    <div id={id} className={cn(r.className, 'pointer-events-auto', className)} data-revealed={r['data-revealed']} style={r.style}>
      {children}
    </div>
  );
}

function MapControls({ vertical = true }: { vertical?: boolean }) {
  const { m } = useI18n();
  const { bbox } = useAppParams();
  return (
    <div className={cn('flex gap-1.5', vertical ? 'flex-col' : 'flex-row')}>
      <IconButton icon="plus" label={m.map.controls.zoomIn} onClick={() => zoomBy(1)} />
      <IconButton icon="minus" label={m.map.controls.zoomOut} onClick={() => zoomBy(-1)} />
      <IconButton icon="reset" label={m.map.controls.reset} onClick={() => flyToArea(bbox)} />
      <IconButton icon="globe" label={m.map.controls.world} onClick={() => flyToArea(WORLD_BOUNDS)} />
    </div>
  );
}

function StatusStack({ loading, error, onRetry }: { loading: boolean; error: boolean; onRetry: () => void }) {
  const { m } = useI18n();
  const basemapOk = useMapStore((s) => s.basemapOk);
  const status = useMapStore((s) => s.status);
  const [basemapDismissed, setBasemapDismissed] = useState(false);
  return (
    <div className="pointer-events-none absolute inset-x-0 top-[calc(var(--el-header-h)+12px)] flex flex-col items-center gap-2 px-[var(--el-gutter)]">
      {loading ? (
        <div className="chip pointer-events-auto !bg-[var(--el-panel)] backdrop-blur-md">
          <Spinner size={14} label={m.map.status.loading} />
          {m.map.status.loading}
        </div>
      ) : null}
      {error ? (
        <Banner tone="error" title={m.map.status.error} onRetry={onRetry} retryLabel={m.common.retry} className="pointer-events-auto w-full max-w-md" />
      ) : null}
      {status === 'unsupported' || status === 'error' ? (
        <Banner tone="warning" title={m.map.status.noWebgl} className="pointer-events-auto w-full max-w-md" />
      ) : null}
      {!basemapOk && !basemapDismissed ? (
        <Banner
          tone="warning"
          title={m.map.status.basemapDown}
          onDismiss={() => setBasemapDismissed(true)}
          dismissLabel={m.common.close}
          className="pointer-events-auto w-full max-w-md"
        />
      ) : null}
    </div>
  );
}

type MobileTab = 'area' | 'layers' | 'time';

function MobileLayout({ index, archive }: { index: ReturnType<typeof useFireIndex>['index']; archive: FireArchive | null }) {
  const { m } = useI18n();
  const [snap, setSnap] = useState<SheetSnap>('peek');
  const [tab, setTab] = useState<MobileTab>('area');
  const r = useReveal(1);
  return (
    <>
      <Reveal index={2} className="absolute right-[var(--el-gutter)] top-[calc(var(--el-header-h)+16px)]">
        <MapControls />
      </Reveal>
      <div className={cn(r.className, 'pointer-events-auto')} data-revealed={r['data-revealed']} style={r.style}>
        <Sheet
          id="tour-area"
          label={m.map.area.title}
          snap={snap}
          onSnapChange={setSnap}
          peek={176}
          header={
            <Segmented<MobileTab>
              label={m.app.nav.map}
              value={tab}
              onChange={(t) => {
                setTab(t);
                if (snap === 'peek') setSnap('half');
              }}
              className="w-full [&>button]:flex-1"
              options={[
                { value: 'area', label: m.map.area.title },
                { value: 'layers', label: m.map.layers.title },
                { value: 'time', label: m.map.time.label },
              ]}
            />
          }
        >
          {tab === 'area' ? (
            snap === 'peek' ? (
              <SelectionSummary compact />
            ) : (
              <AreaPanelBody archive={archive} />
            )
          ) : tab === 'layers' ? (
            <LayersPanelBody index={index} archive={archive} />
          ) : (
            <TimeBar index={index} compact />
          )}
        </Sheet>
      </div>
    </>
  );
}

type DesktopPanel = 'area' | 'layers' | null;

/**
 * Desktop: the map owns the screen. One small toolbar opens one panel at a time (area or layers);
 * the time bar sits low and centred; zoom controls in the corner. Selecting an area opens its panel.
 */
function DesktopLayout({ index, archive }: { index: ReturnType<typeof useFireIndex>['index']; archive: FireArchive | null }) {
  const { m } = useI18n();
  const { bbox } = useAppParams();
  const [panel, setPanel] = useState<DesktopPanel>(() => (bbox ? 'area' : null));
  const hasArea = bbox !== null;
  const prevArea = useRef(hasArea);

  // A new selection (map click, search, dive landing) brings its panel forward.
  useEffect(() => {
    if (hasArea && !prevArea.current) setPanel('area');
    prevArea.current = hasArea;
  }, [hasArea]);

  // Escape closes the open panel (when focus is not inside a field that handles it itself).
  useEffect(() => {
    if (!panel) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      setPanel(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [panel]);

  const toggle = (p: Exclude<DesktopPanel, null>) => setPanel((cur) => (cur === p ? null : p));
  const tabs: { id: Exclude<DesktopPanel, null>; label: string; icon: 'search' | 'layers' }[] = [
    { id: 'area', label: m.map.area.title, icon: 'search' },
    { id: 'layers', label: m.map.layers.title, icon: 'layers' },
  ];

  return (
    <>
      <div className="pointer-events-none absolute bottom-6 left-6 top-[calc(var(--el-header-h)+12px)] flex w-[var(--el-panel-w)] flex-col gap-3">
        <Reveal index={1} className="flex-none">
          <div role="toolbar" aria-label={m.app.nav.map} className="map-dock">
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                id={`tour-${t.id}`}
                className="map-dock__btn"
                aria-pressed={panel === t.id}
                aria-controls={`map-panel-${t.id}`}
                onClick={() => toggle(t.id)}
              >
                <Icon name={t.icon} size={16} />
                {t.label}
                {t.id === 'area' && hasArea ? <span className="map-dock__dot" aria-hidden /> : null}
              </button>
            ))}
          </div>
        </Reveal>
        {panel ? (
          // pointer-events-auto: the column around it ignores the pointer so the map stays draggable, and
          // without this the panel inherited that — search, region buttons and the AI button did not click.
          <div key={panel} className="map-panel pointer-events-auto min-h-0 flex-shrink overflow-y-auto rounded-panel">
            <Panel
              as="section"
              id={`map-panel-${panel}`}
              title={panel === 'area' ? m.map.area.title : m.map.layers.title}
              aria-label={panel === 'area' ? m.map.area.title : m.map.layers.title}
              actions={<IconButton icon="close" size="sm" ghost label={m.common.close} onClick={() => setPanel(null)} />}
            >
              {panel === 'area' ? <AreaPanelBody archive={archive} /> : <LayersPanelBody index={index} archive={archive} />}
            </Panel>
          </div>
        ) : null}
      </div>

      <Reveal index={3} id="tour-time" className="absolute bottom-6 left-1/2 w-[min(820px,calc(100vw-2*var(--el-panel-w)-96px))] min-w-[520px] -translate-x-1/2">
        <section className="glass px-5 pb-3 pt-4" aria-label={m.map.time.label}>
          <TimeBar index={index} />
        </section>
      </Reveal>

      <Reveal index={4} className="absolute bottom-6 right-6">
        <MapControls />
      </Reveal>
    </>
  );
}

/** Map screen UI. Mounted under the white flash, revealed with a stagger in phase C. */
export function MapScreen() {
  const { m } = useI18n();
  const mounted = useIntroStore(introSelectors.uiMounted);
  const phase = useIntroStore((s) => s.phase);
  const fires = useFireIndex();
  const { bbox, setArea } = useAppParams();
  const desktop = useMediaQuery(BREAKPOINTS.md);

  const onDrawn = useCallback((b: BBox) => setArea(b, null), [setArea]);
  useBoxDraw(onDrawn, bbox);

  // Click on the map (not on a detection) → select the country under the pointer.
  const onPickCountry = useCallback(
    (lng: number, lat: number) => {
      void loadCountries().then((file) => {
        const c = nearestCountry(file.countries, lng, lat, 0.6);
        if (!c) return;
        setArea(c.bbox, c.id);
        flyToArea(c.bbox);
      });
    },
    [setArea],
  );

  // Click on a region (admin-1) of the shaded map → select that region.
  const onPickRegion = useCallback(
    (id: string, box: BBox) => {
      setArea(box, id);
      flyToArea(box);
    },
    [setArea],
  );

  // Landing from the intro on the visitor's country: make it the selected area (once).
  const landed = useRef(false);
  useEffect(() => {
    if (landed.current) return;
    const target = useIntroStore.getState().target;
    if (!mounted || !target) return;
    landed.current = true;
    if (target.country && !bbox) setArea(target.bounds, target.country);
  }, [mounted, bbox, setArea]);

  if (!mounted) return null;

  return (
    <>
      <MapSync index={fires.index} archive={fires.archive} />
      <HeliosSync />
      <WorldSync />
      <MapHover onPickCountry={onPickCountry} onPickRegion={onPickRegion} />
      <main id="main" className="pointer-events-none fixed inset-0" style={{ zIndex: 'var(--el-z-ui)' as unknown as number }}>
        <h1 className="sr-only">
          {m.app.name} — {m.app.nav.map}
        </h1>
        <StatusStack loading={fires.isPending} error={fires.isError} onRetry={() => void fires.refetch()} />

        {desktop ? (
          <DesktopLayout index={fires.index} archive={fires.archive} />
        ) : (
          <MobileLayout index={fires.index} archive={fires.archive} />
        )}
      </main>
      {phase === 'done' ? <Tour /> : null}
    </>
  );
}
