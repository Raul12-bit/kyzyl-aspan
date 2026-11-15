import { describe, expect, it } from 'vitest';
import { KM_PER_DEG, type LiveRow } from '../live/satellites';
import { crossCheck, fitsDrift, summarizeChecks } from './crosscheck';
import { convexHull, fuseFootprints } from './fusion';
import { angleBetween, linkEvents, spreadVector, splitPasses, temporalBridge, windFit } from './temporal';

const LAT = 48;
const LNG = 67;
const kx = KM_PER_DEG * Math.cos((LAT * Math.PI) / 180);
const T0 = 1_794_500_000;

/** A hot pixel `east` / `north` km from the reference point, `h` hours after T0. */
function px(
  sat: number,
  east: number,
  north: number,
  h: number,
  frp = 8,
  size = sat <= 1 ? 1 : 0.375,
  conf = 1,
): LiveRow {
  return [
    LNG + east / kx,
    LAT + north / KM_PER_DEG,
    sat,
    T0 + Math.round(h * 3600),
    frp,
    conf,
    size,
    size,
    1,
  ];
}

/** A small fire front (3 pixels across the wind) whose centre is at (east, north). */
function front(sat: number, east: number, north: number, h: number): LiveRow[] {
  const s = sat <= 1 ? 1 : 0.375;
  return [-1, 0, 1].map((k) => px(sat, east + k * s, north, h));
}

describe('Temporal Bridge', () => {
  // A steppe fire running north-east at ~2 km/h: Terra 10:30 → NOAA-21 13:00 → Aqua 13:30 → NOAA-20 13:50.
  const ne = (h: number) => (2 * h) / Math.SQRT2;
  const rows = [
    ...front(0, ne(0), ne(0), 0),
    ...front(4, ne(2.5), ne(2.5), 2.5),
    ...front(1, ne(3), ne(3), 3),
    ...front(3, ne(3.33), ne(3.33), 3.33),
  ].sort((a, b) => a[3] - b[3]);

  it('links the four passes of one moving fire into one event', () => {
    const groups = linkEvents(rows);
    expect(groups).toHaveLength(1);
    const passes = splitPasses(rows, groups[0]!);
    expect(passes.map((p) => p.sat)).toEqual([0, 4, 1, 3]);
  });

  it('recovers the speed and bearing of the front', () => {
    const [e] = temporalBridge(rows);
    expect(e!.vector).not.toBeNull();
    expect(e!.vector!.speedKmh).toBeGreaterThan(1.6);
    expect(e!.vector!.speedKmh).toBeLessThan(2.4);
    expect(angleBetween(e!.vector!.bearingDeg, 45)).toBeLessThan(12);
    expect(e!.vector!.significant).toBe(true);
    expect(e!.vector!.frontKm).toBeGreaterThan(4);
    expect(e!.sensors).toBe(3);
  });

  it('weights VIIRS centres above MODIS ones (finer pixels)', () => {
    const passes = splitPasses(rows, linkEvents(rows)[0]!);
    const modis = passes.find((p) => p.sat === 0)!;
    const viirs = passes.find((p) => p.sat === 4)!;
    expect(viirs.sigmaKm).toBeLessThan(modis.sigmaKm);
  });

  it('calls a fire that does not move stationary, whatever the noise', () => {
    const still = [...front(0, 0, 0, 0), ...front(3, 0.1, -0.1, 3), ...front(1, -0.05, 0.05, 3.2)].sort(
      (a, b) => a[3] - b[3],
    );
    const [e] = temporalBridge(still);
    expect(e!.vector?.significant ?? false).toBe(false);
  });

  it('does not call a shifting centre spread when the front stands still', () => {
    // The hot core drifts west inside a fire whose western edge does not move (the east flank dies down).
    const a = [px(3, -1, 0, 0, 1), px(3, 0, 0, 0, 1), px(3, 1, 0, 0, 30)];
    const b = [px(4, -1, 0, 3, 30), px(4, 0, 0, 3, 1), px(4, 0.2, 0, 3, 1)];
    const [e] = temporalBridge([...a, ...b]);
    expect(e!.vector!.distKm).toBeGreaterThan(1);
    expect(e!.vector!.significant).toBe(false);
  });

  it('keeps two distant fires apart', () => {
    const two = [...front(0, 0, 0, 0), ...front(3, 60, 40, 3)].sort((a, b) => a[3] - b[3]);
    expect(temporalBridge(two)).toHaveLength(2);
  });

  it('checks the vector against the wind', () => {
    const v = spreadVector(rows, splitPasses(rows, linkEvents(rows)[0]!))!;
    expect(windFit(v, { windKmh: 25, windFromDeg: 225 })).toBe('with'); // from SW → blows to NE
    expect(windFit(v, { windKmh: 25, windFromDeg: 45 })).toBe('against');
    expect(windFit(v, { windKmh: 25, windFromDeg: 135 })).toBe('cross');
    expect(windFit(v, { windKmh: 25, windFromDeg: 306 })).toBe('cross'); // 99° off downwind: across, not against
    expect(windFit(v, { windKmh: 2, windFromDeg: 225 })).toBe('calm');
  });
});

describe('cross-check noise filter', () => {
  const wind = { windKmh: 30, windFromDeg: 270 }; // from the west: fires run east

  it('accepts a later hot spot downwind and refuses one as far upwind', () => {
    const a = px(0, 0, 0, 0);
    expect(fitsDrift(a, px(3, 6, 0, 3), wind)).toBe(true);
    expect(fitsDrift(a, px(3, -6, 0, 3), wind)).toBe(false);
    // Without wind the same distance is too far for 3 h.
    expect(fitsDrift(a, px(3, 6, 0, 3), null)).toBe(false);
  });

  it('confirms a fire seen by MODIS and then by VIIRS downwind', () => {
    const rows = [px(0, 0, 0, 0), px(3, 5, 0.2, 3)];
    const res = crossCheck(rows, { now: T0 + 10 * 3600, wind: () => wind });
    expect(res[0]!.status).toBe('confirmed');
    expect(res[0]!.cross).toBe(true);
    expect(res[1]!.status).toBe('confirmed');
  });

  it('drops a weak glint the next satellite flew over without seeing', () => {
    const glint = px(1, 0, 0, 0, 3);
    const coverage = (code: number, _lat: number, _lng: number, from: number, to: number) => {
      const t = T0 + 2 * 3600; // NOAA-20 covered the spot 2 h later
      return code === 3 && t >= from && t <= to ? [t] : [];
    };
    const res = crossCheck([glint], { now: T0 + 8 * 3600, coverage, satellites: [0, 1, 3] });
    expect(res[0]!.status).toBe('noise');
    expect(res[0]!.other).toBe(3);
  });

  it('keeps a strong lone fire as unconfirmed, and a young one as pending', () => {
    const coverage = (code: number) => (code === 3 ? [T0 + 2 * 3600] : []);
    const strong = crossCheck([px(1, 0, 0, 0, 60, 1, 2)], {
      now: T0 + 8 * 3600,
      coverage,
      satellites: [1, 3],
    });
    expect(strong[0]!.status).toBe('unconfirmed');
    // The covering pass happened 1 h ago: its data may still be on the way.
    const young = crossCheck([px(1, 0, 0, 0, 3)], { now: T0 + 3 * 3600, coverage, satellites: [1, 3] });
    expect(young[0]!.status).toBe('pending');
    expect(young[0]!.nextPass).toBe(T0 + 2 * 3600);
  });

  it('summarizes the statuses', () => {
    const rows = [px(0, 0, 0, 0), px(3, 1, 0, 3), px(1, 300, 0, 0, 2)];
    const s = summarizeChecks(crossCheck(rows, { now: T0 + 4 * 3600, wind: () => wind }));
    expect(s.total).toBe(3);
    expect(s.confirmed).toBe(2);
    expect(s.cross).toBe(2);
  });
});

describe('MODIS × VIIRS spatial matching', () => {
  const at = (east: number, north: number) => ({ lng: LNG + east / kx, lat: LAT + north / KM_PER_DEG });

  it('splits each MODIS pixel’s FRP over the VIIRS pixels inside it and sharpens the outline', () => {
    const modis = [
      { ...at(0, 0), frp: 40, scanKm: 1, trackKm: 1 },
      { ...at(1, 0), frp: 20, scanKm: 1, trackKm: 1 },
      { ...at(5, 5), frp: 9, scanKm: 1, trackKm: 1 },
    ];
    const viirs = [
      { ...at(-0.2, 0.1), frp: 6, scanKm: 0.375, trackKm: 0.375 },
      { ...at(0.2, -0.1), frp: 2, scanKm: 0.375, trackKm: 0.375 },
      { ...at(1.1, 0), frp: 3, scanKm: 0.375, trackKm: 0.375 },
      { ...at(3, -3), frp: 1, scanKm: 0.375, trackKm: 0.375 },
    ];
    const f = fuseFootprints(modis, viirs);
    expect(f.refined[0]!.frp).toBeCloseTo(30, 5); // 40 × 6/8
    expect(f.refined[1]!.frp).toBeCloseTo(10, 5);
    expect(f.refined[2]!.frp).toBeCloseTo(20, 5);
    expect(f.refined[3]!.matched).toBe(false);
    expect(f.modisOnly).toHaveLength(1);
    // The refined pixels carry the MODIS power of the pixels they explain (no double counting).
    expect(f.refined.filter((p) => p.matched).reduce((s, p) => s + p.frp, 0)).toBeCloseTo(60, 5);
    expect(f.sharpen).toBeGreaterThan(5);
    expect(f.hull.length).toBeGreaterThan(3);
  });

  it('builds a closed convex hull', () => {
    const h = convexHull([
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
      [0.5, 0.5],
    ]);
    expect(h).toHaveLength(5);
    expect(h[0]).toEqual(h[h.length - 1]);
  });
});
