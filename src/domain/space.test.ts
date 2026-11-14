import { describe, expect, it } from 'vitest';
import { planCue, priorityFor } from './crosscue';
import { linkReliability, planDownlinks, rainAttenuationDb, STATIONS } from './downlink';
import { elevationDeg, findPasses, FLEET, groundDistanceKm, periodSec, subSatellitePoint } from './orbit';

const terra = FLEET.find((s) => s.id === 'terra')!;
const snpp = FLEET.find((s) => s.id === 'snpp')!;
const svalbard = STATIONS.find((s) => s.id === 'svalbard')!;

describe('orbit', () => {
  it('has the right periods for 705 km and 824 km circular orbits', () => {
    expect(periodSec(terra) / 60).toBeCloseTo(98.8, 0);
    expect(periodSec(snpp) / 60).toBeCloseTo(101.3, 0);
  });

  it('ground track latitude never exceeds 180° − inclination', () => {
    const limit = 180 - terra.inclinationDeg;
    let max = 0;
    for (let t = 0; t < 86_400; t += 60) max = Math.max(max, Math.abs(subSatellitePoint(terra, t).lat));
    expect(max).toBeLessThanOrEqual(limit + 0.01);
    expect(max).toBeGreaterThan(limit - 1);
  });

  it('sees a polar orbiter from Svalbard on most of its ~14.6 daily orbits', () => {
    const passes = findPasses(terra, svalbard.location, 0, 86_400);
    expect(passes.length).toBeGreaterThanOrEqual(8);
    expect(passes.length).toBeLessThanOrEqual(15);
    for (const p of passes) {
      expect(p.los).toBeGreaterThan(p.aos);
      expect(p.los - p.aos).toBeLessThan(20 * 60);
      expect(elevationDeg(terra, p.tca, svalbard.location)).toBeGreaterThanOrEqual(5);
    }
  });

  it('computes great-circle distances', () => {
    expect(groundDistanceKm({ lat: 0, lng: 0 }, { lat: 0, lng: 90 })).toBeCloseTo(10_007.5, 0);
  });
});

describe('downlink planner', () => {
  it('Ka fades in heavy rain, X barely notices', () => {
    expect(rainAttenuationDb('Ka', 20, 30)).toBeGreaterThan(10);
    expect(rainAttenuationDb('X', 20, 30)).toBeLessThan(2);
    const storm = { scenarios: [{ rate: 25, p: 1 }] };
    expect(linkReliability('Ka', storm, 30)).toBe(0);
    expect(linkReliability('X', storm, 30)).toBe(1);
  });

  it('never schedules Ka below the reliability threshold and clears the backlog', () => {
    const plan = planDownlinks(snpp, STATIONS, { from: 0, horizonSec: 12 * 3600, backlogGbit: 400, weatherSeed: 3 });
    expect(plan.passes.length).toBeGreaterThan(5);
    for (const p of plan.passes) {
      if (p.band === 'Ka') expect(p.kaReliability!).toBeGreaterThanOrEqual(0.75);
      if (p.decision === 'x-only') expect(p.station.bands).not.toContain('Ka');
    }
    expect(plan.doneAt).not.toBeNull();
    expect(plan.expectedFailures).toBeLessThanOrEqual(plan.naiveExpectedFailures + 1e-9);
  });

  it('is deterministic for a weather seed', () => {
    const a = planDownlinks(terra, STATIONS, { from: 0, horizonSec: 6 * 3600, backlogGbit: 100, weatherSeed: 9 });
    const b = planDownlinks(terra, STATIONS, { from: 0, horizonSec: 6 * 3600, backlogGbit: 100, weatherSeed: 9 });
    expect(b).toEqual(a);
  });
});

describe('cross-satellite cueing', () => {
  const site = { lat: 48.0, lng: 67.0 };

  it('picks the earliest other satellite that will cover the spot', () => {
    const plan = planCue(
      { site, detectedAt: 3600, detectedBy: terra, confidence: 0.6, relayLatencySec: 120, clearSkyProbability: 0.8 },
      FLEET,
    );
    expect(plan.chosen).not.toBeNull();
    expect(plan.chosen!.satellite.id).not.toBe('terra');
    expect(plan.chosen!.coverageAt!).toBeGreaterThanOrEqual(3600 + 120);
    const times = plan.candidates.map((c) => c.coverageAt).filter((t): t is number => t !== null);
    expect(plan.chosen!.coverageAt! - Math.min(...times)).toBeLessThan(600);
    expect(plan.confirmProbability).toBeGreaterThan(0);
    expect(plan.confirmProbability).toBeLessThanOrEqual(0.8);
  });

  it('promotes confirmed alerts', () => {
    expect(priorityFor(0.6, false)).toBe('watch');
    expect(priorityFor(0.6, true)).toBe('critical');
    expect(priorityFor(0.9, false)).toBe('high');
  });
});
