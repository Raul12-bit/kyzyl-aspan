/**
 * Proof that the three AIs COMPUTE their answers — they do not replay canned outputs.
 *
 * Metamorphic tests: change one input in a way whose physical effect is known, and check the output moves
 * the right way (or does not move when it must not). A lookup table of demo answers fails these at once:
 * fires planted at random places must be found exactly there, erased fires must disappear, more wind must
 * push the fire further, calm air must give a circle. `pnpm verify:ai` runs the same checks against the
 * deployed ground server over HTTP.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { STATIONS } from '../downlink';
import type { OnboardModel } from '../onboard';
import { detectFires } from './contextual';
import { fuseProbability } from './fusion';
import { ffdi, forecastSpread, gfdi, lengthToBreadth, type Weather } from './ground';
import { simulateLinks } from './link';
import { buildScene, FINE, observe, rng, type ThermalScene } from './scene';
import { crc8, decodeAlert, encodeAlert, PACKET_BYTES, triage } from './triage';

const model = JSON.parse(
  readFileSync(new URL('../../../public/data/model.json', import.meta.url), 'utf8'),
) as OnboardModel;
const clone = (s: ThermalScene): ThermalScene => ({
  ...s,
  pixels: s.pixels.map((p) => ({ ...p, fire: p.fire.map((c) => ({ ...c })) })),
});

/* ------------------------------------------------------------------ AI #1 */

describe('AI #1 computes: the detector follows the fire, wherever it is put', () => {
  it('finds a fire planted at ANY clear land pixel — exactly there, and nowhere else', () => {
    const base = buildScene('hotGround', true); // a scene with no fire at all
    let planted = 0;
    for (let y = 1; y < FINE - 1; y += 2) {
      for (let x = 1; x < FINE - 1; x += 2) {
        const p = base.pixels[y * FINE + x]!;
        if (p.water || p.cloud) continue;
        const s = clone(base);
        s.pixels[y * FINE + x]!.fire.push({ fraction: 0.005, kelvin: 1000 });
        const r = detectFires(observe(s, 'VIIRS'), true);
        expect(
          r.fires.map((f) => [f.x, f.y]),
          `fire planted at ${x},${y}`,
        ).toEqual([[x, y]]);
        planted += 1;
      }
    }
    expect(planted).toBeGreaterThan(100);
  });

  it('reports nothing once the fire is erased from a scene (both sensors, day and night)', () => {
    for (const day of [true, false]) {
      for (const kind of ['wildfire', 'smallBurn', 'gasFlare'] as const) {
        const withFire = buildScene(kind, day);
        expect(
          detectFires(observe(withFire, 'VIIRS'), day).fires.length,
          `${kind} with fire`,
        ).toBeGreaterThan(0);
        const erased = clone(withFire);
        for (const p of erased.pixels) p.fire = [];
        for (const sensor of ['VIIRS', 'MODIS'] as const) {
          expect(
            detectFires(observe(erased, sensor), day).fires.length,
            `${kind} erased · ${sensor} · ${day ? 'day' : 'night'}`,
          ).toBe(0);
        }
      }
    }
  });

  it('needs a ~10× larger fire to trigger MODIS than VIIRS: the 1 km pixel dilutes it (physics, not a rule)', () => {
    const fractions = [1e-5, 2e-5, 5e-5, 1e-4, 2e-4, 5e-4, 1e-3, 2e-3, 5e-3, 1e-2];
    for (const day of [true, false]) {
      const first: Record<'VIIRS' | 'MODIS', number | null> = { VIIRS: null, MODIS: null };
      for (const f of fractions) {
        const s = clone(buildScene('hotGround', day));
        s.pixels[20 * FINE + 6]!.fire.push({ fraction: f, kelvin: 1000 });
        for (const sensor of ['VIIRS', 'MODIS'] as const) {
          if (first[sensor] === null && detectFires(observe(s, sensor), day).fires.length) first[sensor] = f;
        }
      }
      expect(first.VIIRS).not.toBeNull();
      expect(first.MODIS).not.toBeNull();
      const ratio = first.MODIS! / first.VIIRS!;
      // A MODIS pixel here is 3 × 3 VIIRS pixels: the fire's share of it is 9× smaller.
      expect(ratio, `MODIS/VIIRS detection threshold, ${day ? 'day' : 'night'}`).toBeGreaterThanOrEqual(5);
      expect(ratio).toBeLessThanOrEqual(40);
    }
  });

  it('gives a bigger fire more radiative power', () => {
    const frp = (scale: number) => {
      const s = clone(buildScene('wildfire', true));
      for (const p of s.pixels) for (const c of p.fire) c.fraction *= scale;
      return detectFires(observe(s, 'MODIS'), true).clusters.reduce((a, c) => a + c.frpMW, 0);
    };
    expect(frp(2)).toBeGreaterThan(frp(1));
    expect(frp(1)).toBeGreaterThan(frp(0.5));
  });

  it('trusts a hot pixel less the more years and seasons its cell has been hot (memory of the archive)', () => {
    // Same number of past detections in the cell; only how persistent they were changes. (The model also
    // learned that MORE detections in a cell mean a fire-prone landscape — so the count is held fixed.)
    const p = (years: number, months: number) =>
      triage(model, { confidenceClass: 1, frpMW: 25, pixels: 2, history: { years, months, count: 60 } })
        .pReal;
    const byYears = [1, 3, 6, 12, 20].map((y) => p(y, 4));
    for (let i = 1; i < byYears.length; i++) expect(byYears[i]!).toBeLessThan(byYears[i - 1]!);
    const byMonths = [1, 3, 6, 9, 12].map((mo) => p(4, mo));
    for (let i = 1; i < byMonths.length; i++) expect(byMonths[i]!).toBeLessThan(byMonths[i - 1]!);
    // A gas flare (hot in every season for 21 years) is dropped; a never-seen hot cell with a strong fire is not.
    expect(
      triage(model, {
        confidenceClass: 2,
        frpMW: 40,
        pixels: 1,
        history: { years: 21, months: 12, count: 400 },
      }).priority,
    ).toBe('DROP');
    expect(
      triage(model, { confidenceClass: 2, frpMW: 40, pixels: 4, history: { years: 0, months: 0, count: 0 } })
        .priority,
    ).not.toBe('DROP');
  });

  it('rejects EVERY single-bit corruption of the 16-byte alert (CRC-8)', () => {
    const packet = encodeAlert({
      priority: 'CRITICAL',
      sensor: 'VIIRS',
      day: true,
      lat: 50.42,
      lng: 80.25,
      timeSec: 838_884_600,
      frpMW: 123.4,
      pReal: 0.97,
      pixels: 9,
    });
    expect(packet.length).toBe(PACKET_BYTES);
    expect(decodeAlert(packet)).not.toBeNull();
    for (let bit = 0; bit < PACKET_BYTES * 8; bit++) {
      const b = packet.slice();
      b[bit >> 3]! ^= 1 << (bit & 7);
      expect(decodeAlert(b), `bit ${bit}`).toBeNull();
    }
    expect(crc8(packet, PACKET_BYTES - 1)).toBe(packet[PACKET_BYTES - 1]);
  });

  it('round-trips random alerts', () => {
    const next = rng(2026);
    for (let i = 0; i < 200; i++) {
      const lat = -80 + next() * 160;
      const lng = -179 + next() * 358;
      const d = decodeAlert(
        encodeAlert({
          priority: 'HIGH',
          sensor: next() < 0.5 ? 'MODIS' : 'VIIRS',
          day: next() < 0.5,
          lat,
          lng,
          timeSec: Math.floor(next() * 2 ** 30),
          frpMW: next() * 500,
          pReal: next(),
          pixels: 1 + Math.floor(next() * 20),
        }),
      )!;
      expect(Math.abs(d.lat - lat)).toBeLessThan(1e-4);
      expect(Math.abs(d.lng - lng)).toBeLessThan(1e-4);
    }
  });
});

/* ------------------------------------------------------------------ AI #2 */

describe('AI #2 computes: predicting the drop beats reacting to it, everywhere', () => {
  it('loses fewer links than the reactive rule for every satellite and every storm position', () => {
    for (const satelliteId of ['terra', 'aqua', 'snpp', 'noaa20']) {
      for (const stormStation of [null, ...STATIONS.map((s) => s.id)]) {
        const ai = simulateLinks({ satelliteId, policy: 'ai', stormStation });
        const reactive = simulateLinks({ satelliteId, policy: 'reactive', stormStation });
        expect(ai.stats.drops, `${satelliteId} · storm ${stormStation ?? 'none'}`).toBeLessThan(
          reactive.stats.drops,
        );
      }
    }
  });

  it('reacts to the storm it is given: the reactive rule suffers there, AI #2 routes around it', () => {
    const calm = simulateLinks({ satelliteId: 'noaa20', policy: 'reactive', stormStation: null });
    const storm = simulateLinks({ satelliteId: 'noaa20', policy: 'reactive', stormStation: 'fairbanks' });
    expect(storm.stats.drops).toBeGreaterThan(calm.stats.drops);
    const ai = simulateLinks({ satelliteId: 'noaa20', policy: 'ai', stormStation: 'fairbanks' });
    expect(ai.steps.some((s) => s.action === 'ka' && s.target === 'fairbanks')).toBe(false);
  });
});

/* ------------------------------------------------------------------ AI #3 */

describe('AI #3 computes: the spread forecast obeys the physics of fire weather', () => {
  const base: Weather = {
    windKmh: 20,
    windFromDeg: 270,
    tempC: 30,
    rh: 25,
    drought: 8,
    rain24h: 0,
    pressureHpa: 1010,
    airMass: 'continentalDry',
  };
  const head24 = (w: Partial<Weather>, fuel: 'grass' | 'forest' = 'grass') =>
    forecastSpread({ lat: 50, lng: 70 }, { ...base, ...w }, { fuel, localHour: 14, hours: [24] }).horizons[0]!
      .headKm;

  it('calm air (no wind): the fire still spreads, as a circle', () => {
    const f = forecastSpread({ lat: 50, lng: 70 }, { ...base, windKmh: 0 }, { fuel: 'grass', localHour: 14 });
    expect(f.lengthToBreadth).toBe(1);
    for (const h of f.horizons) {
      expect(h.headKm).toBeGreaterThan(0);
      expect(h.backKm).toBeCloseTo(h.headKm, 9); // no downwind side: back = head
    }
  });

  it('more wind → longer run and a more elongated ellipse (monotone over 0…150 km/h)', () => {
    const winds = [0, 5, 10, 20, 40, 60, 80, 100, 150];
    const heads = winds.map((windKmh) => head24({ windKmh }));
    const lbs = winds.map(lengthToBreadth);
    for (let i = 1; i < winds.length; i++) {
      // Strictly faster below the index ceiling; at gale force it runs at the ceiling (26 km/h), never slower.
      if (winds[i]! <= 60) expect(heads[i]!, `wind ${winds[i]}`).toBeGreaterThan(heads[i - 1]!);
      else expect(heads[i]!, `wind ${winds[i]}`).toBeGreaterThanOrEqual(heads[i - 1]!);
      expect(lbs[i]!).toBeGreaterThan(lbs[i - 1]!);
    }
    expect(heads[heads.length - 1]!).toBeCloseTo(26 * 24, 6);
  });

  it('more humidity → slower fire; more heat → faster fire; drier fuel → more forest danger', () => {
    const rh = [5, 15, 30, 50, 70, 95].map((r) => head24({ rh: r }));
    for (let i = 1; i < rh.length; i++) expect(rh[i]!).toBeLessThan(rh[i - 1]!);
    const temp = [10, 20, 30, 40].map((tempC) => head24({ tempC }));
    for (let i = 1; i < temp.length; i++) expect(temp[i]!).toBeGreaterThan(temp[i - 1]!);
    const drought = [1, 3, 5, 7, 10].map((d) => ffdi({ ...base, drought: d }));
    for (let i = 1; i < drought.length; i++) expect(drought[i]!).toBeGreaterThan(drought[i - 1]!);
    // The forest model (FFDI) reads the drought factor, the grass model (GFDI) has none: two different models.
    expect(head24({ drought: 10 }, 'forest')).toBeGreaterThan(head24({ drought: 2 }, 'forest'));
    expect(head24({ drought: 10 }, 'grass')).toBeCloseTo(head24({ drought: 2 }, 'grass'), 12);
    expect(gfdi(base)).not.toBeCloseTo(ffdi(base), 3);
  });

  it('stays finite and physical over the whole input range the server accepts (frost, gale, desert air)', () => {
    // Regression: the grass moisture equation has a pole at −6 °C; −10 °C used to forecast ~10¹⁶ km in 24 h.
    const temps = [-40, -20, -10, -6, -5, 0, 5, 15, 25, 35, 45, 55];
    for (const fuel of ['grass', 'forest'] as const) {
      const heads = temps.map((tempC) => head24({ tempC }, fuel));
      heads.forEach((h, i) => expect(Number.isFinite(h), `${fuel} ${temps[i]} °C`).toBe(true));
      for (let i = 1; i < heads.length; i++)
        expect(heads[i]!, `${fuel} ${temps[i]} °C`).toBeGreaterThanOrEqual(heads[i - 1]!);
    }
    expect(head24({ tempC: -10 }, 'grass')).toBe(0); // frozen grass carries no fire
    // The harshest corner the API allows: 150 km/h, 55 °C, 1% humidity, drought 10.
    for (const fuel of ['grass', 'forest'] as const) {
      const f = forecastSpread(
        { lat: 50, lng: 70 },
        { ...base, windKmh: 150, tempC: 55, rh: 1, drought: 10 },
        { fuel, hours: [6, 12, 24] },
      );
      expect(f.danger).toBe('catastrophic');
      expect(f.index).toBeLessThanOrEqual(200);
      expect(f.rosKmh).toBeLessThanOrEqual(26 + 1e-9);
      for (const h of f.horizons)
        for (const v of [h.headKm, h.areaHa, h.perimeterKm]) expect(Number.isFinite(v)).toBe(true);
    }
  });

  it('runs downwind for every wind direction', () => {
    for (let from = 0; from < 360; from += 15) {
      const f = forecastSpread({ lat: 50, lng: 70 }, { ...base, windFromDeg: from }, { fuel: 'grass' });
      expect(f.headingDeg).toBe((from + 180) % 360);
    }
  });

  it('is deterministic: the same inputs give the same forecast, bit for bit', () => {
    const a = forecastSpread({ lat: 48.2, lng: 76.9 }, base, { fuel: 'forest', localHour: 11 });
    const b = forecastSpread({ lat: 48.2, lng: 76.9 }, base, { fuel: 'forest', localHour: 11 });
    expect(a).toEqual(b);
  });
});

describe('MODIS × VIIRS fusion computes: two independent looks are never worse than one', () => {
  it('is symmetric, monotone and at least as confident as the better sensor', () => {
    const next = rng(7);
    for (let i = 0; i < 500; i++) {
      const a = next();
      const b = next();
      const f = fuseProbability(a, b);
      expect(f).toBeCloseTo(fuseProbability(b, a), 12);
      expect(f).toBeGreaterThanOrEqual(Math.max(a, b) - 1e-12);
      expect(f).toBeLessThanOrEqual(1);
      expect(fuseProbability(Math.min(1, a + 0.05), b)).toBeGreaterThanOrEqual(f - 1e-12);
    }
  });
});
