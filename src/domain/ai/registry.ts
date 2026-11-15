/**
 * The three AIs of Kyzyl Aspan in one place: where each runs, what implements it here, and its
 * counterpart in the HELIOS-SHIELD backend (Python, trained on real NASA FIRMS data). The UI and the
 * server's /api/ai/status read this, so the architecture is described once.
 *
 *   space segment ── AI #1 (detect + triage) ──alert packets──▶ AI #2 (orbits + links)
 *                                                                  │ laser · Ka/X · backup radio
 *   ground segment ◀───────────────────────────────────────────────┘
 *        AI #3 (noise filter, MODIS×VIIRS fusion, weather, spread, delays) ──▶ map, briefs, alerts
 *        AI #3 ──persistent-source table (uplink)──▶ AI #1's memory
 */
export type AiId = 'ai1' | 'ai2' | 'ai3';
export type Segment = 'space' | 'ground';

export interface AiSystem {
  id: AiId;
  segment: Segment;
  /** Pure TypeScript modules that implement it in this repository (also runnable in the browser). */
  modules: readonly string[];
  /** Endpoint of this repository's server that runs it, if any. */
  endpoint: string | null;
  /** HELIOS-SHIELD endpoints with the version trained on real data. */
  helios: readonly string[];
  /** How often it runs, s. */
  cadenceSec: number;
}

export const AI_SYSTEMS: readonly AiSystem[] = [
  {
    id: 'ai1',
    segment: 'space',
    modules: [
      'src/domain/ai/thermal.ts',
      'src/domain/ai/contextual.ts',
      'src/domain/onboard.ts',
      'src/domain/ai/triage.ts',
    ],
    endpoint: null,
    helios: ['/v1/helios/alerts', '/v1/helios/mission'],
    // One detector pass per scan (VIIRS ≈ 1.8 s, MODIS ≈ 3 s).
    cadenceSec: 1.8,
  },
  {
    id: 'ai2',
    segment: 'space',
    modules: ['src/domain/orbit.ts', 'src/domain/downlink.ts', 'src/domain/ai/link.ts'],
    endpoint: null,
    helios: ['/v1/helios/constellation', '/v1/helios/link', '/v1/helios/mission'],
    cadenceSec: 30,
  },
  {
    id: 'ai3',
    segment: 'ground',
    modules: [
      'src/domain/noise.ts',
      'src/domain/harmonize.ts',
      'src/domain/ai/fusion.ts',
      'src/domain/ai/ground.ts',
    ],
    endpoint: '/api/ai/ground/forecast',
    helios: ['/v1/helios/risk', '/v1/helios/spread', '/v1/helios/blind', '/v1/helios/static'],
    cadenceSec: 3600,
  },
];

/** Who talks to whom (the edges of the system diagram). */
export const AI_FLOWS = [
  { from: 'ai1', to: 'ai2', carries: 'alerts' },
  { from: 'ai2', to: 'ai3', carries: 'data' },
  { from: 'ai3', to: 'ai1', carries: 'memory' },
] as const;
