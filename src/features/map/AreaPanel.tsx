import { useEffect, useId, useMemo, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useAppParams } from '@/app/useAppParams';
import { useRegionSearch } from '@/data/queries';
import type { BBox, Region } from '@/data/types';
import type { FireArchive } from '@/domain/archive';
import { findCountry, useCountries } from '@/features/geo/countries';
import { useHeliosAvailable } from '@/features/helios/api';
import { useI18n, type Messages } from '@/i18n';
import { bboxAreaKm2, polygonsAreaKm2 } from '@/lib/geo';
import { useDebounced } from '@/lib/useDebounced';
import { Button, Chip, cn, Icon, IconButton, Segmented, Spinner } from '@/ui';
import { AreaInsights } from './AreaInsights';
import { flyToArea } from './camera';
import { useMapStore } from './mapStore';
import { regionName, useAreaName } from './useRegion';

type Tab = 'search' | 'draw' | 'coords';

export function formatLng(v: number) {
  return `${Math.abs(v).toFixed(2)}°${v >= 0 ? 'E' : 'W'}`;
}
export function formatLat(v: number) {
  return `${Math.abs(v).toFixed(2)}°${v >= 0 ? 'N' : 'S'}`;
}

/* ------------------------------------------------------------------ search */

function RegionSearch({ onPick }: { onPick: (r: Region) => void }) {
  const { m, locale, fmt } = useI18n();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const debounced = useDebounced(query, 120);
  const results = useRegionSearch(debounced);
  const featured = useRegionSearch('');
  const listId = useId();
  const items = debounced.trim() ? (results.data ?? []) : [];
  const expanded = open && query.trim().length > 0;

  useEffect(() => setActive(0), [debounced]);

  const pick = (r: Region) => {
    onPick(r);
    setQuery('');
    setOpen(false);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActive((i) => Math.min(items.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter' && items[active]) {
      e.preventDefault();
      pick(items[active]);
    } else if (e.key === 'Escape') {
      setQuery('');
      setOpen(false);
    }
  };

  return (
    <div>
      <label htmlFor={`${listId}-input`} className="sr-only">
        {m.map.area.searchLabel}
      </label>
      <div className="relative">
        <div className="field">
          <Icon name="search" size={18} className="flex-none text-ink-dim" />
          <input
            id={`${listId}-input`}
            type="search"
            role="combobox"
            autoComplete="off"
            spellCheck={false}
            aria-expanded={expanded}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={expanded && items[active] ? `${listId}-${items[active].id}` : undefined}
            placeholder={m.map.area.searchPlaceholder}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onBlur={() => window.setTimeout(() => setOpen(false), 120)}
            onKeyDown={onKeyDown}
          />
          {results.isFetching && query ? <Spinner size={14} /> : null}
        </div>
        {expanded ? (
          <ul
            id={listId}
            role="listbox"
            aria-label={m.map.area.searchLabel}
            className="glass absolute inset-x-0 top-[calc(100%+6px)] z-10 m-0 max-h-72 list-none overflow-y-auto p-1.5"
            style={{ borderRadius: 14, animation: 'el-rise-in 180ms var(--el-ease-emphasized) both' }}
          >
            {items.length === 0 && !results.isFetching ? (
              <li className="px-3 py-2.5 text-sm text-ink-dim" role="presentation">
                {m.map.area.noResults(debounced)}
              </li>
            ) : null}
            {items.map((r, i) => (
              <li
                key={r.id}
                id={`${listId}-${r.id}`}
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(r);
                }}
                onMouseEnter={() => setActive(i)}
                className={cn(
                  'flex cursor-pointer items-center justify-between gap-3 rounded-[10px] px-3 py-2.5 text-sm',
                  i === active ? 'bg-[var(--el-tint-3)] text-ink' : 'text-ink-muted',
                )}
              >
                <span className="min-w-0">
                  <span className="block truncate font-medium">{regionName(r, locale, fmt.country)}</span>
                  {r.kind === 'province' && r.parentId ? (
                    <span className="block text-[12px] text-ink-dim">{fmt.country(r.parentId)}</span>
                  ) : null}
                </span>
                <span className="num flex-none text-[11px] text-ink-dim">{r.iso2 ?? r.id}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <p className="eyebrow mb-2.5 mt-5">{m.map.area.suggested}</p>
      <div className="flex flex-wrap gap-2">
        {(featured.data ?? []).map((r) => (
          <Chip key={r.id} onClick={() => pick(r)}>
            {regionName(r, locale, fmt.country)}
          </Chip>
        ))}
      </div>
      <p className="m-0 mt-4 flex items-start gap-2 text-[12px] leading-snug text-ink-dim">
        <Icon name="crosshair" size={14} className="mt-px flex-none text-kyzyl" />
        {m.map.area.clickHint}
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ coordinates */

type Field = 'w' | 's' | 'e' | 'n';

export function validateBox(values: Record<Field, string>, errors: Messages['map']['area']['errors']) {
  const out: Partial<Record<Field, string>> = {};
  const num: Partial<Record<Field, number>> = {};
  (Object.keys(values) as Field[]).forEach((k) => {
    const raw = values[k].trim().replace(',', '.');
    const v = Number(raw);
    if (!raw || !Number.isFinite(v)) out[k] = errors.number;
    else if ((k === 's' || k === 'n') && Math.abs(v) > 90) out[k] = errors.lat;
    else if ((k === 'w' || k === 'e') && Math.abs(v) > 180) out[k] = errors.lng;
    else num[k] = v;
  });
  if (num.s !== undefined && num.n !== undefined && num.s >= num.n) out.s = errors.order;
  const size = (a?: number, b?: number) => (a !== undefined && b !== undefined ? Math.abs(b - a) : 1);
  if (!out.w && !out.e && size(num.w, num.e) < 0.1) out.e = errors.small;
  if (!out.s && !out.n && size(num.s, num.n) < 0.1) out.n = errors.small;
  const ok = Object.keys(out).length === 0;
  return { errors: out, bbox: ok ? ([num.w, num.s, num.e, num.n] as unknown as BBox) : null };
}

function CoordsForm({ current, onApply }: { current: BBox | null; onApply: (b: BBox) => void }) {
  const { m } = useI18n();
  const id = useId();
  const init = (b: BBox | null): Record<Field, string> =>
    b ? { w: String(b[0]), s: String(b[1]), e: String(b[2]), n: String(b[3]) } : { w: '', s: '', e: '', n: '' };
  const [values, setValues] = useState(() => init(current));
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});

  useEffect(() => {
    setValues(init(current));
    setErrors({});
  }, [current]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const res = validateBox(values, m.map.area.errors);
    setErrors(res.errors);
    if (res.bbox) onApply(res.bbox);
  };

  const fields: { key: Field; label: string; placeholder: string }[] = [
    { key: 'w', label: m.map.area.coords.west, placeholder: '46.5' },
    { key: 'e', label: m.map.area.coords.east, placeholder: '87.4' },
    { key: 's', label: m.map.area.coords.south, placeholder: '40.6' },
    { key: 'n', label: m.map.area.coords.north, placeholder: '55.4' },
  ];

  return (
    <form onSubmit={submit} noValidate>
      <div className="grid grid-cols-2 gap-3">
        {fields.map((f) => (
          <div key={f.key}>
            <label htmlFor={`${id}-${f.key}`} className="eyebrow mb-1.5 block">
              {f.label}
            </label>
            <div className="field !h-10" data-invalid={errors[f.key] ? 'true' : undefined}>
              <input
                id={`${id}-${f.key}`}
                className="num"
                inputMode="text"
                autoComplete="off"
                placeholder={f.placeholder}
                value={values[f.key]}
                aria-invalid={errors[f.key] ? true : undefined}
                aria-describedby={errors[f.key] ? `${id}-${f.key}-err` : undefined}
                onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
              />
              <span aria-hidden className="text-[12px] text-ink-dim">
                °
              </span>
            </div>
            {errors[f.key] ? (
              <p id={`${id}-${f.key}-err`} className="m-0 mt-1 text-[12px] text-danger">
                {errors[f.key]}
              </p>
            ) : null}
          </div>
        ))}
      </div>
      <Button type="submit" variant="secondary" size="sm" icon="crosshair" className="mt-4 w-full">
        {m.map.area.coords.apply}
      </Button>
    </form>
  );
}

/* ------------------------------------------------------------------ draw */

function DrawTab() {
  const { m } = useI18n();
  const drawing = useMapStore((s) => s.drawing);
  const setDrawing = useMapStore((s) => s.setDrawing);
  return (
    <div>
      <p className="m-0 text-sm text-ink-muted">{m.map.area.drawHint}</p>
      <div className="mt-4 flex gap-2">
        <Button
          variant="secondary"
          icon="draw"
          aria-pressed={drawing}
          onClick={() => setDrawing(!drawing)}
          className="flex-1"
        >
          {drawing ? m.map.area.drawActive : m.map.area.drawStart}
        </Button>
        {drawing ? (
          <Button variant="quiet" onClick={() => setDrawing(false)}>
            {m.map.area.drawCancel}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ summary */

export function SelectionSummary({ compact = false }: { compact?: boolean }) {
  const { m, fmt } = useI18n();
  const { bbox, regionId, setArea } = useAppParams();
  const name = useAreaName(regionId);
  const world = useHeliosAvailable();
  const countries = useCountries();
  const country = regionId && /^[A-Z]{2}$/.test(regionId) ? findCountry(countries.data, regionId) : null;
  // A country's statistics are counted inside its outline (AreaInsights' polygon mask), so its area is the
  // outline's, not the box's — Kazakhstan's box is ≈5 M km², the country ≈2.7 M km².
  const outlineKm2 = useMemo(() => (country ? polygonsAreaKm2(country.polys) : null), [country]);

  if (!bbox) return <p className="m-0 text-sm leading-relaxed text-ink-dim">{m.map.area.none}</p>;
  const areaLine =
    outlineKm2 !== null
      ? m.map.area.areaOutline(fmt.compact(outlineKm2))
      : regionId && world
        ? m.map.area.areaRegion(fmt.compact(bboxAreaKm2(bbox)))
        : m.map.area.areaBox(fmt.compact(bboxAreaKm2(bbox)));

  return (
    <div>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="eyebrow m-0 mb-1.5">{m.map.area.selected}</p>
          <h3 className="m-0 truncate text-[17px] font-semibold tracking-[-0.01em] text-ink">{name}</h3>
        </div>
        <div className="flex flex-none gap-1">
          <IconButton icon="crosshair" size="sm" label={m.map.area.zoomTo} onClick={() => flyToArea(bbox)} />
          <IconButton
            icon="close"
            size="sm"
            label={m.map.area.clear}
            onClick={() => {
              setArea(null);
              useMapStore.getState().setDrawing(false);
            }}
          />
        </div>
      </div>
      {!compact ? (
        <dl className="num m-0 mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-[12px] text-ink-muted">
          <div>
            <dt className="sr-only">{m.map.area.coords.west} / {m.map.area.coords.south}</dt>
            <dd className="m-0">
              {formatLng(bbox[0])} {formatLat(bbox[1])}
            </dd>
          </div>
          <div>
            <dt className="sr-only">{m.map.area.coords.east} / {m.map.area.coords.north}</dt>
            <dd className="m-0">
              {formatLng(bbox[2])} {formatLat(bbox[3])}
            </dd>
          </div>
          <div className="col-span-2 font-sans leading-snug text-ink-dim">{areaLine}</div>
        </dl>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ panel */

export function AreaPanelBody({ archive }: { archive: FireArchive | null }) {
  const { m } = useI18n();
  const [tab, setTab] = useState<Tab>('search');
  const { bbox, setArea } = useAppParams();
  const setDrawing = useMapStore((s) => s.setDrawing);

  useEffect(() => {
    if (tab !== 'draw') setDrawing(false);
  }, [tab, setDrawing]);

  return (
    <>
      <Segmented<Tab>
        label={m.map.area.title}
        value={tab}
        onChange={setTab}
        className="w-full [&>button]:flex-1"
        options={[
          { value: 'search', label: m.map.area.tabs.search },
          { value: 'draw', label: m.map.area.tabs.draw },
          { value: 'coords', label: m.map.area.tabs.coords },
        ]}
      />
      <div className="mt-4 min-h-[148px]">
        {tab === 'search' ? (
          <RegionSearch
            onPick={(r) => {
              setArea(r.bbox, r.id);
              flyToArea(r.bbox);
            }}
          />
        ) : tab === 'draw' ? (
          <DrawTab />
        ) : (
          <CoordsForm
            current={bbox}
            onApply={(b) => {
              setArea(b, null);
              flyToArea(b);
            }}
          />
        )}
      </div>
      <div className="my-5 h-px bg-line" />
      <SelectionSummary />
      <div className="my-5 h-px bg-line" />
      <AreaInsights archive={archive} />
    </>
  );
}
