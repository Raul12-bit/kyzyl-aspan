import { useQuery } from '@tanstack/react-query';
import type { CountriesFile, CountryShape } from '@/domain/countries';

let pending: Promise<CountriesFile> | null = null;

/**
 * Country outlines (Natural Earth 1:110m, ~150 kB) — static reference data, not fire data, so they
 * are served with the app rather than through the DataSource. One fetch per session.
 */
export function loadCountries(): Promise<CountriesFile> {
  if (!pending) {
    pending = fetch(`${import.meta.env.BASE_URL}data/countries.json`)
      .then((res) => {
        if (!res.ok) throw new Error(`countries.json → HTTP ${res.status}`);
        return res.json() as Promise<CountriesFile>;
      })
      .catch((err: unknown) => {
        pending = null;
        throw err;
      });
  }
  return pending;
}

export function useCountries() {
  return useQuery({ queryKey: ['countries'], queryFn: loadCountries, staleTime: Number.POSITIVE_INFINITY });
}

export function findCountry(file: CountriesFile | undefined, id: string | null | undefined): CountryShape | null {
  if (!file || !id) return null;
  return file.countries.find((c) => c.id === id) ?? null;
}
