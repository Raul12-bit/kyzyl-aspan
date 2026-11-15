import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildArchive } from '../archive';
import { tableFromRows, type FireRow } from '../detections';
import { geoToEcef } from '../orbit';
import type { OnboardModel } from '../onboard';
import { detectFires, PIXEL } from './contextual';
import { fuseArchive, fuseObservations, fuseProbability } from './fusion';
import {
  dangerClass,
  ffdi,
  forecastSpread,
  gfdi,
  lengthToBreadth,
  streamStatus,
  syntheticWeather,
  trackDelays,
  warningsFor,
  type Weather,
} from './ground';
import { lineOfSight, lossProbability, simulateLinks } from './link';
import { AI_FLOWS, AI_SYSTEMS } from './registry';
import { buildScene, FINE, observe, type SceneKind } from './scene';
import { brightnessTemp, frpMW, mixedBrightness, planck, SENSORS } from './thermal';
import { crc8, decodeAlert, encodeAlert, PACKET_BYTES, triage } from './triage';

const model = JSON.parse(
  readFileSync(new URL('../../../public/data/model.json', import.meta.url), 'utf8'),
) as OnboardModel;

function run(kind: SceneKind, day: boolean, sensor: 'MODIS' | 'VIIRS') {
  const scene = buildScene(kind, day);
  const img = observe(scene, sensor);
  return { scene, img, result: detectFires(img, day) };
}

describe('AI #1 · radiometry', () => {
  it('inverts Planck exactly', () => {
    for (const t of [250, 300, 400, 900]) {
      expect(brightnessTemp(SENSORS.VIIRS.mir, planck(SENSORS.VIIRS.mir, t))).toBeCloseTo(t, 6);
    }
  });

  it('a fire covering 0.1% of a pixel lifts 4 µm far more than 11 µm', () => {
    const parts = [{ fraction: 0.001, kelvin: 1000 }];
    const d4 = mixedBrightness(SENSORS.MODIS.mir, 300, parts) - 300;
    const d11 = mixedBrightness(SENSORS.MODIS.tir, 300, parts) - 300;
    expect(d4).toBeGreaterThan(10);
    expect(d11).toBeLessThan(2);
  });

  it('FRP is zero without excess heat and grows with it', () => {
    expect(frpMW(300, 300, 1)).toBe(0);
    expect(frpMW(340, 300, 1)).toBeGreaterThan(frpMW(320, 300, 1));
  });
});

describe('AI #1 · contextual detector and triage', () => {
  it('finds a large fire with both sensors and calls it critical', () => {
    for (const sensor of ['MODIS', 'VIIRS'] as const) {
      const { scene, result } = run('wildfire', true, sensor);
      expect(result.clusters.length).toBe(1);
      const c = result.clusters[0]!;
      const t = triage(model, {
        confidenceClass: c.confidenceClass,
        frpMW: c.frpMW,
        pixels: c.pixels.length,
        history: scene.history,
      });
      expect(t.priority).toBe('CRITICAL');
    }
  });

  it('sees a small burn at 375 m that a 1 km pixel dilutes away', () => {
    for (const day of [true, false]) {
      expect(run('smallBurn', day, 'VIIRS').result.fires.length).toBe(1);
      expect(run('smallBurn', day, 'MODIS').result.fires.length).toBe(0);
    }
  });

  it('detects a gas flare, and the triage model drops it from memory of the cell', () => {
    const { scene, result } = run('gasFlare', true, 'VIIRS');
    expect(result.fires.length).toBe(1);
    const c = result.clusters[0]!;
    const t = triage(model, {
      confidenceClass: c.confidenceClass,
      frpMW: c.frpMW,
      pixels: 1,
      history: scene.history,
    });
    expect(t.priority).toBe('DROP');
    expect(t.reasons).toContain('persistent');
  });

  it('rejects sun-baked ground by context', () => {
    const { result } = run('hotGround', true, 'VIIRS');
    expect(result.examined.length).toBeGreaterThan(0);
    expect(result.fires.length).toBe(0);
    expect(result.examined.every((v) => !v.tests.t4)).toBe(true);
  });

  it('never classifies water or cloud', () => {
    const { img, result } = run('wildfire', true, 'VIIRS');
    expect(img.size).toBe(FINE);
    for (let i = 0; i < img.mask.length; i++) if (img.mask[i]) expect(result.classes[i]).toBe(PIXEL.masked);
    expect([...img.mask].some((m) => m === 2)).toBe(true);
  });
});

describe('AI #1 · alert packet', () => {
  const alert = {
    priority: 'CRITICAL' as const,
    sensor: 'VIIRS' as const,
    day: true,
    lat: 50.42,
    lng: 80.25,
    timeSec: 838_884_600,
    frpMW: 123.4,
    pReal: 0.97,
    pixels: 9,
  };

  it('round-trips 16 bytes with metre-level coordinates', () => {
    const b = encodeAlert(alert);
    expect(b.length).toBe(PACKET_BYTES);
    const d = decodeAlert(b)!;
    expect(d.priority).toBe('CRITICAL');
    expect(d.sensor).toBe('VIIRS');
    expect(Math.abs(d.lat - alert.lat)).toBeLessThan(2e-5);
    expect(Math.abs(d.lng - alert.lng)).toBeLessThan(3e-5);
    expect(d.timeSec).toBe(alert.timeSec);
    expect(d.frpMW).toBeCloseTo(123.4, 5);
    expect(d.pixels).toBe(9);
  });

  it('rejects a corrupted packet', () => {
    const b = encodeAlert(alert);
    b[5]! ^= 0x10;
    expect(decodeAlert(b)).toBeNull();
    expect(crc8([0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39])).toBe(0xf4); // CRC-8/SMBUS check value
  });

  it('handles negative coordinates', () => {
    const d = decodeAlert(encodeAlert({ ...alert, lat: -33.9, lng: -70.6 }))!;
    expect(d.lat).toBeCloseTo(-33.9, 4);
    expect(d.lng).toBeCloseTo(-70.6, 4);
  });
});

describe('AI #2 · link manager', () => {
  it('knows the Earth blocks a path to the far side', () => {
    const a = geoToEcef({ lat: 0, lng: 0 }, 700);
    const b = geoToEcef({ lat: 0, lng: 180 }, 700);
    const c = geoToEcef({ lat: 0, lng: 20 }, 700);
    expect(lineOfSight(a, b)).toBe(false);
    expect(lineOfSight(a, c)).toBe(true);
  });

  it('counts a link about to set as lost, whatever the weather', () => {
    expect(lossProbability({ stepsLeft: 3, pEnv: 0 })).toBe(1);
    expect(lossProbability({ stepsLeft: 40, pEnv: 0.1 })).toBeCloseTo(0.1, 6);
  });

  it('is deterministic', () => {
    const a = simulateLinks({ satelliteId: 'terra', policy: 'ai' });
    const b = simulateLinks({ satelliteId: 'terra', policy: 'ai' });
    expect(a.stats).toEqual(b.stats);
  });

  it('predicting beats reacting when a storm sits on a station', () => {
    for (const id of ['terra', 'noaa20']) {
      const ai = simulateLinks({ satelliteId: id, policy: 'ai', stormStation: 'fairbanks' });
      const re = simulateLinks({ satelliteId: id, policy: 'reactive', stormStation: 'fairbanks' });
      expect(ai.stats.drops).toBeLessThan(re.stats.drops);
      expect(ai.stats.handoffs).toBeGreaterThan(0);
      // The planner never sends Ka-band into the downpour.
      expect(ai.steps.some((s) => s.action === 'ka' && s.target === 'fairbanks')).toBe(false);
    }
  });

  it('sends alerts over the backup radio when no data link is up, unless a geomagnetic storm blocks it', () => {
    const calm = simulateLinks({ satelliteId: 'terra', policy: 'ai', alertsAtMin: [40], kp: 2 });
    const first = calm.alerts.find((a) => a.atStep === 80)!;
    expect(first.via).toBe('radio-ground');
    const storm = simulateLinks({ satelliteId: 'terra', policy: 'ai', alertsAtMin: [40], kp: 8 });
    expect(storm.alerts.find((a) => a.atStep === 80)!.via).not.toBe('radio-ground');
  });

  it('delivers everything it can and records every step', () => {
    const r = simulateLinks({ satelliteId: 'snpp', policy: 'ai', minutes: 120 });
    expect(r.steps.length).toBe(240);
    expect(r.stats.deliveredGB).toBeLessThanOrEqual(r.stats.generatedGB + 1e-9);
    expect(r.stats.deliveredGB).toBeGreaterThan(0);
  });
});

describe('AI #3 · ground segment', () => {
  const w: Weather = {
    windKmh: 30,
    windFromDeg: 270,
    tempC: 30,
    rh: 20,
    drought: 9,
    rain24h: 0,
    pressureHpa: 1010,
    airMass: 'continentalDry',
  };

  it('reproduces the McArthur indices', () => {
    expect(ffdi({ tempC: 40, rh: 10, windKmh: 50, drought: 10 })).toBeCloseTo(109.2, 0);
    expect(gfdi({ tempC: 30, rh: 20, windKmh: 30 }, 100, 4.5)).toBeCloseTo(32.8, 0);
    expect(dangerClass(109, 'forest')).toBe('catastrophic');
    expect(dangerClass(10, 'forest')).toBe('moderate');
    expect(dangerClass(10, 'grass')).toBe('high');
  });

  it('turns no wind into a circle and wind into an ellipse', () => {
    expect(lengthToBreadth(0)).toBe(1);
    expect(lengthToBreadth(40)).toBeGreaterThan(3);
  });

  it('runs the fire downwind, growing with time and slowing at night', () => {
    const f = forecastSpread({ lat: 50, lng: 70 }, w, { fuel: 'grass', localHour: 14 });
    expect(f.headingDeg).toBe(90);
    const [h6, h12, h24] = f.horizons;
    expect(h6!.areaHa).toBeLessThan(h12!.areaHa);
    expect(h12!.areaHa).toBeLessThan(h24!.areaHa);
    // Eastward head: the ring reaches further east than west of the ignition.
    const lngs = h6!.ring.map((p) => p[0]);
    expect(Math.max(...lngs) - 70).toBeGreaterThan(70 - Math.min(...lngs));
    // The second 12 hours (the night) add less than the first 12 hours.
    expect(h24!.headKm - h12!.headKm).toBeLessThan(h12!.headKm);
  });

  it('raises storm and fire-weather warnings', () => {
    expect(warningsFor({ ...w, windKmh: 70 }, 'high')).toContain('gale');
    expect(warningsFor({ ...w, rain24h: 40 }, 'low')).toContain('heavyRain');
    expect(warningsFor({ ...w, tempC: 35, rh: 12, windKmh: 35 }, 'veryHigh')).toContain('fireWeather');
  });

  it('gives plausible synthetic weather', () => {
    const s = syntheticWeather(50, 70, 8);
    expect(s.windKmh).toBeGreaterThan(0);
    expect(s.windKmh).toBeLessThan(110);
    expect(s.rh).toBeGreaterThanOrEqual(8);
    expect(s.rh).toBeLessThanOrEqual(97);
    expect(s.windFromDeg).toBeGreaterThanOrEqual(0);
    expect(s.windFromDeg).toBeLessThan(360);
  });

  it('tracks every stream against the 3-hour target', () => {
    const d = trackDelays({ minutes: 120 });
    expect(d.map((s) => s.satelliteId)).toEqual(['terra', 'aqua', 'snpp', 'noaa20']);
    expect(streamStatus(10)).toBe('fast');
    expect(streamStatus(60)).toBe('nrt');
    expect(streamStatus(400)).toBe('late');
  });
});

describe('MODIS × VIIRS fusion', () => {
  it('combines independent evidence', () => {
    expect(fuseProbability(0.65, 0.65)).toBeCloseTo(0.8775, 6);
    expect(fuseProbability(null, 0.9)).toBeCloseTo(0.9, 6);
  });

  it('counts confirmed and single-sensor events after the noise filter', () => {
    const day = 4500; // 2012-04 — inside the overlap era
    const rows: FireRow[] = [
      [70, 50, 0, day, 20, 2, 0], // MODIS
      [70.001, 50.001, 1, day, 8, 1, 0], // VIIRS, same cell and day → confirmed
      [72, 48, 1, day, 5, 1, 0], // VIIRS only
      [72, 48, 1, day, 4, 1, 0], // second pixel of the same event
      [60, 45, 0, day + 1, 30, 1, 0], // MODIS only
      [61, 45, 1, day, 3, 0, 2], // low confidence → removed by the filter
    ];
    const s = fuseArchive(buildArchive(tableFromRows(rows)));
    expect(s.events).toBe(3);
    expect(s.both).toBe(1);
    expect(s.viirsOnly).toBe(1);
    expect(s.modisOnly).toBe(1);
    expect(s.modisConfirmedByViirs).toBeCloseTo(0.5, 6);
  });

  it('locates a fused fire with the finer sensor', () => {
    const viirs = run('smallBurn', true, 'VIIRS').result.clusters[0] ?? null;
    expect(fuseObservations(null, viirs)).toMatchObject({ status: 'viirsOnly', locatedBy: 'VIIRS' });
    const m = run('wildfire', true, 'MODIS').result.clusters[0]!;
    const v = run('wildfire', true, 'VIIRS').result.clusters[0]!;
    const f = fuseObservations(m, v);
    expect(f.status).toBe('both');
    expect(f.p).toBeGreaterThan(0.9);
  });
});

describe('AI registry', () => {
  it('describes three AIs and closes the loop', () => {
    expect(AI_SYSTEMS.map((a) => a.id)).toEqual(['ai1', 'ai2', 'ai3']);
    expect(AI_SYSTEMS.filter((a) => a.segment === 'space').length).toBe(2);
    expect(AI_FLOWS.some((f) => f.from === 'ai3' && f.to === 'ai1')).toBe(true);
  });
});
