import { useQuery } from '@tanstack/react-query';

/**
 * Is the ground server (AI #3, /api/ai/*) answering, and does it reach a HELIOS data API? Kept apart from
 * groundClient.ts so the landing page can show the live status without loading the AI #3 domain code.
 */
export interface ServerStatus {
  online: boolean;
  helios: boolean;
}

export function useAiServerStatus() {
  return useQuery({
    queryKey: ['ai', 'server-status'],
    queryFn: async ({ signal }): Promise<ServerStatus> => {
      try {
        const res = await fetch('/api/ai/status', {
          signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]),
        });
        if (!res.ok || !(res.headers.get('content-type') ?? '').includes('application/json'))
          return { online: false, helios: false };
        const r = (await res.json()) as { ok?: boolean; helios?: { reachable?: boolean } };
        return { online: Boolean(r?.ok), helios: Boolean(r?.helios?.reachable) };
      } catch (err) {
        if (signal.aborted) throw err;
        return { online: false, helios: false };
      }
    },
    staleTime: 60_000,
    retry: false,
  });
}
