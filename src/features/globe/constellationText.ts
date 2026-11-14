/** "Svalbard SvalSat (KSAT)" → "Svalbard SvalSat"; "TrollSat, Antarctica (KSAT)" → "TrollSat". */
export function shortStation(name: string | undefined): string {
  return (name ?? '').split(/[,(]/)[0]!.trim();
}

const SAT_LABEL: Record<string, string> = { TERRA: 'Terra', AQUA: 'Aqua', 'SUOMI NPP': 'Suomi NPP' };

/** CelesTrak names → how NASA writes them. */
export const satLabel = (name: string | undefined) => (name ? SAT_LABEL[name] ?? name : '');
