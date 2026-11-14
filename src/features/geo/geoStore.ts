import { create } from 'zustand';
import { nearestCountry } from '@/domain/countries';
import { applyCountryLocale, useLocaleStore, type Locale } from '@/i18n';
import { loadCountries } from './countries';

/**
 * Visitor location → country → interface language and landing area.
 *
 * Privacy: coordinates are used once, in memory, for an offline point-in-polygon lookup and then
 * dropped. Only the ISO country code and the consent decision are stored (localStorage), and
 * nothing location-related is ever sent to a server.
 */
export type GeoConsent = 'unknown' | 'granted' | 'denied';
export type GeoStatus = 'idle' | 'locating' | 'found' | 'outside' | 'error' | 'unsupported';

export interface GeoNotice {
  kind: 'found' | 'denied' | 'error' | 'outside';
  country?: string;
  /** Locale switched to by geolocation, with the previous one for Undo. */
  switchedTo?: Locale;
  previous?: Locale;
}

interface GeoState {
  consent: GeoConsent;
  status: GeoStatus;
  /** ISO 3166-1 alpha-2, or null when unknown / not shared. */
  country: string | null;
  notice: GeoNotice | null;
  /** Asks the browser (user gesture) and resolves the country. */
  locate: (opts?: { silent?: boolean; forceLocale?: boolean }) => Promise<void>;
  decline: () => void;
  dismissNotice: () => void;
}

const KEY = 'kyzylaspan.geo';

function readStored(): { consent: GeoConsent; country: string | null } {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as { consent?: unknown; country?: unknown } | null;
    if (v && (v.consent === 'granted' || v.consent === 'denied')) {
      const country = typeof v.country === 'string' && /^[A-Z]{2}$/.test(v.country) ? v.country : null;
      return { consent: v.consent, country };
    }
  } catch {
    /* ignore */
  }
  return { consent: 'unknown', country: null };
}

function persist(consent: GeoConsent, country: string | null) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ consent, country }));
  } catch {
    /* ignore */
  }
}

export function geolocationSupported(): boolean {
  return typeof navigator !== 'undefined' && 'geolocation' in navigator && window.isSecureContext !== false;
}

function position(): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) =>
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      // Country-level precision is all we need: fast, battery-friendly, cached for an hour.
      enableHighAccuracy: false,
      timeout: 12_000,
      maximumAge: 60 * 60_000,
    }),
  );
}

const stored = typeof window === 'undefined' ? { consent: 'unknown' as const, country: null } : readStored();

export const useGeoStore = create<GeoState>((set, get) => ({
  consent: stored.consent,
  status: geolocationSupported() ? 'idle' : 'unsupported',
  country: stored.country,
  notice: null,

  locate: async ({ silent = false, forceLocale = false } = {}) => {
    if (!geolocationSupported()) {
      set({ status: 'unsupported' });
      return;
    }
    if (get().status === 'locating') return;
    set({ status: 'locating' });
    try {
      const [pos, file] = await Promise.all([position(), loadCountries()]);
      const c = nearestCountry(file.countries, pos.coords.longitude, pos.coords.latitude);
      if (!c) {
        persist('granted', null);
        set({ consent: 'granted', status: 'outside', country: null, notice: silent ? null : { kind: 'outside' } });
        return;
      }
      const previous = useLocaleStore.getState().locale;
      const switchedTo = await applyCountryLocale(c.langs, forceLocale);
      persist('granted', c.id);
      set({
        consent: 'granted',
        status: 'found',
        country: c.id,
        // A silent refresh only speaks up when it actually changed something.
        notice: silent && !switchedTo ? null : { kind: 'found', country: c.id, switchedTo: switchedTo ?? undefined, previous },
      });
    } catch (err) {
      const denied = (err as GeolocationPositionError | undefined)?.code === 1;
      if (denied) {
        persist('denied', null);
        set({ consent: 'denied', status: 'idle', country: null, notice: silent ? null : { kind: 'denied' } });
      } else {
        set({ status: 'error', notice: silent ? null : { kind: 'error' } });
      }
    }
  },

  decline: () => {
    persist('denied', null);
    set({ consent: 'denied', country: null, notice: null });
  },

  dismissNotice: () => set({ notice: null }),
}));

/**
 * On start: if the browser already granted location (a returning visitor), refresh the country
 * silently; if it is blocked, remember that and never show the prompt.
 */
export async function syncGeoPermission(): Promise<void> {
  if (!geolocationSupported()) return;
  const { consent, locate } = useGeoStore.getState();
  try {
    const status = await navigator.permissions?.query({ name: 'geolocation' as PermissionName });
    if (status?.state === 'granted') {
      await locate({ silent: true });
      return;
    }
    if (status?.state === 'denied') {
      persist('denied', null);
      useGeoStore.setState({ consent: 'denied', country: null });
      return;
    }
    if (status?.state === 'prompt') {
      // Site permission was reset: never trigger a native prompt without a click — ask again with our card,
      // unless the visitor already said "not now" to the card.
      if (consent === 'granted') useGeoStore.setState({ consent: 'unknown' });
      return;
    }
  } catch {
    /* Permissions API missing (older Safari): rely on the stored decision */
  }
  if (consent === 'granted') await locate({ silent: true });
}
