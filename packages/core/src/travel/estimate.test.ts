import { describe, expect, it } from 'vitest';
import { highSpeedRailBackbone } from '../reality/jurisdictions';
import { COLOCATED_KM, HIGH_SPEED_RAIL_MODEL, MODE_MODELS, averageSpeedKmh, dayPartFor, dayPrecisionOf, estimateLegMinutes, plausibleModeFor, timePrecisionOf, travelDurationStateOf, unknownLegAllowanceMinutes } from './estimate';

const CASHEL = { lat: 52.52, lng: -7.8906 };
const CORK_MARKET = { lat: 51.8979, lng: -8.4748 };
const DUBLIN = { lat: 53.3498, lng: -6.2603 };
const KILKENNY = { lat: 52.6541, lng: -7.2448 };

describe('travel duration state', () => {
  it('unknown ≠ zero: an unmeasured segment is unknown, never a number', () => {
    expect(travelDurationStateOf({ provenance: 'unmeasured', minutes: null })).toBe('unknown');
    expect(timePrecisionOf('unknown')).toBe('band');
  });
  it('measured, scheduled, geo and model estimates each have their own state and time style', () => {
    expect(travelDurationStateOf({ provenance: 'measured', minutes: 40, basis: 'static' })).toBe('measured');
    expect(travelDurationStateOf({ provenance: 'measured', minutes: 40, basis: 'scheduled' })).toBe('scheduled');
    expect(travelDurationStateOf({ provenance: 'estimated', minutes: 40, estimateKind: 'geo' })).toBe('geo_estimate');
    expect(travelDurationStateOf({ provenance: 'estimated', minutes: 40, estimateKind: 'model' })).toBe('model_estimate');
    expect(timePrecisionOf('scheduled')).toBe('fixed');
    expect(timePrecisionOf('geo_estimate')).toBe('estimated');
  });
});

describe('geo estimator', () => {
  it('Rock of Cashel → English Market is a believable drive of about 90 minutes, never zero and never a road measurement', () => {
    const estimate = estimateLegMinutes({ from: CASHEL, to: CORK_MARKET, mode: 'drive' })!;
    expect(estimate.straightLineKm).toBeGreaterThan(70);
    expect(estimate.straightLineKm).toBeLessThan(90);
    expect(estimate.minutes).toBeGreaterThanOrEqual(75);
    expect(estimate.minutes).toBeLessThanOrEqual(120);
    expect(estimate.minutes % 5).toBe(0);
    expect(estimate.approxKm).toBeGreaterThan(estimate.straightLineKm);
  });
  it('never prices a road journey past a long day of driving: a sea crossing is unknown, not a 26-hour drive', () => {
    expect(estimateLegMinutes({ from: { lat: 38.71, lng: -9.14 }, to: { lat: 37.81, lng: -25.47 }, mode: 'drive' })).toBeNull();
    // A long but ordinary road day still gets its figure.
    expect(estimateLegMinutes({ from: { lat: 52.52, lng: 13.4 }, to: { lat: 48.14, lng: 11.58 }, mode: 'drive' })).not.toBeNull();
  });
  it('Dublin → Kilkenny by car lands near the real 90 minutes', () => {
    const estimate = estimateLegMinutes({ from: DUBLIN, to: KILKENNY, mode: 'drive' })!;
    expect(estimate.minutes).toBeGreaterThanOrEqual(75);
    expect(estimate.minutes).toBeLessThanOrEqual(130);
  });
  it('a short urban hop is short but not instant; colocated points are zero', () => {
    const hop = estimateLegMinutes({ from: DUBLIN, to: { lat: 53.3438, lng: -6.2546 }, mode: 'walk' })!;
    expect(hop.minutes).toBeGreaterThanOrEqual(5);
    expect(hop.minutes).toBeLessThanOrEqual(20);
    const same = estimateLegMinutes({ from: DUBLIN, to: { lat: DUBLIN.lat + 0.0005, lng: DUBLIN.lng }, mode: 'drive' })!;
    expect(same.straightLineKm).toBeLessThan(COLOCATED_KM);
    expect(same.minutes).toBe(0);
  });
  it('where high-speed rail is the backbone, Tokyo → Kyoto is about three and a half hours door to door, not six and a half', () => {
    const tokyo = { lat: 35.6896, lng: 139.7006 };
    const kyoto = { lat: 35.0037, lng: 135.7788 };
    const regional = estimateLegMinutes({ from: tokyo, to: kyoto, mode: 'rail' })!;
    const fast = estimateLegMinutes({ from: tokyo, to: kyoto, mode: 'rail', highSpeedRail: true })!;
    expect(regional.minutes).toBeGreaterThan(330);
    expect(fast.minutes).toBeGreaterThanOrEqual(180);
    expect(fast.minutes).toBeLessThanOrEqual(240);
    /* Local lines are local lines: a short hop is the same either way. */
    expect(estimateLegMinutes({ from: tokyo, to: { lat: 35.45, lng: 139.63 }, mode: 'rail', highSpeedRail: true })!.minutes).toBe(estimateLegMinutes({ from: tokyo, to: { lat: 35.45, lng: 139.63 }, mode: 'rail' })!.minutes);
  });
  it('the high-speed profile never makes a longer leg quicker', () => {
    for (let i = 1; i < HIGH_SPEED_RAIL_MODEL.speedAnchors.length; i += 1) {
      expect(HIGH_SPEED_RAIL_MODEL.speedAnchors[i]![0]).toBeGreaterThan(HIGH_SPEED_RAIL_MODEL.speedAnchors[i - 1]![0]);
      expect(HIGH_SPEED_RAIL_MODEL.speedAnchors[i]![1]).toBeGreaterThanOrEqual(HIGH_SPEED_RAIL_MODEL.speedAnchors[i - 1]![1]);
    }
    expect(highSpeedRailBackbone('JP')).toBe(true);
    expect(highSpeedRailBackbone('IS')).toBe(false);
    expect(highSpeedRailBackbone(null)).toBe(false);
  });
  it('a ferry or an unsupported mode has no geometric estimate', () => {
    expect(estimateLegMinutes({ from: DUBLIN, to: KILKENNY, mode: 'ferry' })).toBeNull();
    expect(estimateLegMinutes({ from: DUBLIN, to: KILKENNY, mode: 'unsupported' })).toBeNull();
  });
});

describe('mode plausibility', () => {
  it('a 75 km "walk" becomes a drive for a driver and transit for a car-free trip', () => {
    expect(plausibleModeFor({ hinted: 'walk', straightLineKm: 75, canDrive: true, transitTrip: false })).toEqual({ mode: 'drive', corrected: true });
    expect(plausibleModeFor({ hinted: 'walk', straightLineKm: 75, canDrive: false, transitTrip: true })).toEqual({ mode: 'public_bus', corrected: true });
    /*
     * V11 §10 — neither driving nor a transit trip. This used to answer
     * `public_bus`, which is a service that either exists or does not and which
     * nothing here has checked; a road leg somebody else drives is the honest
     * shape with no such claim in it.
     */
    expect(plausibleModeFor({ hinted: 'walk', straightLineKm: 75, canDrive: false, transitTrip: false })).toEqual({ mode: 'rideshare', corrected: true });
  });

  /**
   * V11 §10 — THE CORRECTION READS THE TRIP'S OWN TRANSPORT CONTRACT.
   *
   * The founder's Kyrgyzstan trip said, at the top of its own plan, "Private
   * driver and local guides for all transfers and treks; no self-driving". Its
   * day 4 then read "Bus to Altyn-Arashan valley", because `canDrive` was false
   * and the fallback invented a bus. The trip has no bus in it.
   */
  it('corrects to the mode the trip actually uses, never to one it does not have', () => {
    expect(plausibleModeFor({ hinted: 'walk', straightLineKm: 22, arrangement: 'driver', canDrive: false, transitTrip: false })).toEqual({ mode: 'private_transfer', corrected: true });
    expect(plausibleModeFor({ hinted: 'walk', straightLineKm: 22, arrangement: 'self_drive', canDrive: true, transitTrip: false })).toEqual({ mode: 'drive', corrected: true });
    expect(plausibleModeFor({ hinted: 'walk', straightLineKm: 22, arrangement: 'operator', canDrive: false, transitTrip: false })).toEqual({ mode: 'shuttle', corrected: true });
    expect(plausibleModeFor({ hinted: 'walk', straightLineKm: 22, arrangement: 'transit', canDrive: false, transitTrip: true })).toEqual({ mode: 'public_bus', corrected: true });
  });

  it('leaves the hint alone on a trip with no ground mode at all, rather than inventing one', () => {
    expect(plausibleModeFor({ hinted: 'walk', straightLineKm: 22, arrangement: 'none', canDrive: false, transitTrip: false })).toEqual({ mode: 'walk', corrected: false });
  });
  it('a 1.5 km walk stays a walk; unknown geometry never corrects anything', () => {
    expect(plausibleModeFor({ hinted: 'walk', straightLineKm: 1.5, canDrive: true, transitTrip: false })).toEqual({ mode: 'walk', corrected: false });
    expect(plausibleModeFor({ hinted: 'walk', straightLineKm: null, canDrive: true, transitTrip: false })).toEqual({ mode: 'walk', corrected: false });
  });
  it('ferries and transfers are never overridden by geometry', () => {
    expect(plausibleModeFor({ hinted: 'ferry', straightLineKm: 300, canDrive: true, transitTrip: false })).toEqual({ mode: 'ferry', corrected: false });
  });
});

describe('unknown allowances and day precision', () => {
  it('holds a conservative allowance that is never zero', () => {
    expect(unknownLegAllowanceMinutes({ mode: 'drive', sameLocality: false, role: 'approach' })).toBe(60);
    expect(unknownLegAllowanceMinutes({ mode: 'drive', sameLocality: false, role: 'transfer' })).toBe(120);
    expect(unknownLegAllowanceMinutes({ mode: 'walk', sameLocality: true, role: 'approach' })).toBe(15);
  });
  it('a day is as precise as its least precise leg', () => {
    const measured = { kind: 'travel' as const, travel: { fromId: 'a', toId: 'b', fromName: 'A', toName: 'B', minutes: 30, km: 20, mode: 'drive' as const, role: 'approach' as const, provenance: 'measured' as const, basis: 'static' as const } };
    const estimated = { ...measured, travel: { ...measured.travel, provenance: 'estimated' as const, estimateKind: 'geo' as const, basis: undefined } };
    const unknown = { ...measured, travel: { ...measured.travel, minutes: null, km: null, provenance: 'unmeasured' as const, basis: undefined, unmeasuredReason: 'no_route_found' as const } };
    expect(dayPrecisionOf([measured])).toBe('measured');
    expect(dayPrecisionOf([measured, estimated])).toBe('estimated');
    expect(dayPrecisionOf([measured, estimated, unknown])).toBe('band');
  });
  it('day parts read as a traveller would say them', () => {
    expect(dayPartFor(8 * 60)).toBe('Early morning');
    expect(dayPartFor(10 * 60)).toBe('Morning');
    expect(dayPartFor(12 * 60)).toBe('Late morning');
    expect(dayPartFor(15 * 60)).toBe('Afternoon');
    expect(dayPartFor(18 * 60)).toBe('Early evening');
    expect(dayPartFor(20 * 60)).toBe('Evening');
  });
});

describe('the estimate is continuous and never quicker for a longer leg (release pass, 2026-11)', () => {
  /** A point `km` east of the start along the equator, which is ~111.2 km per degree. */
  const at = (km: number) => ({ lat: 0, lng: km / 111.195 });
  const origin = { lat: 0, lng: 0 };
  const MODES = ['drive', 'rideshare', 'private_transfer', 'shuttle', 'walk', 'public_bus', 'rail', 'bicycle'] as const;

  it('every model’s anchors keep the unrounded time non-decreasing between them', () => {
    for (const model of Object.values(MODE_MODELS)) {
      let previous = 0;
      for (let km = 0.2; km <= 600; km += 0.05) {
        const minutes = ((km * model.detour) / averageSpeedKmh(model, km)) * 60;
        expect(minutes).toBeGreaterThanOrEqual(previous - 1e-9);
        previous = minutes;
      }
    }
  });

  it('no 100 m changes the rounded estimate by more than one five-minute step, and a longer leg is never quicker', () => {
    for (const mode of MODES) {
      let previous: number | null = null;
      for (let km = 0.2; km <= (mode === 'walk' ? 6 : mode === 'bicycle' ? 60 : 400); km += 0.1) {
        const estimate = estimateLegMinutes({ from: origin, to: at(km), mode });
        if (!estimate) continue;
        if (previous !== null) {
          expect(estimate.minutes, `${mode} at ${km.toFixed(1)} km`).toBeGreaterThanOrEqual(previous);
          expect(estimate.minutes - previous, `${mode} at ${km.toFixed(1)} km`).toBeLessThanOrEqual(5);
        }
        previous = estimate.minutes;
      }
    }
  });

  it('the old band edges no longer jump: 25 km by bus, 30 km by car', () => {
    const bus = (km: number) => estimateLegMinutes({ from: origin, to: at(km), mode: 'public_bus' })!.minutes;
    const car = (km: number) => estimateLegMinutes({ from: origin, to: at(km), mode: 'drive' })!.minutes;
    expect(Math.abs(bus(25.1) - bus(24.9))).toBeLessThanOrEqual(5);
    expect(Math.abs(car(30.1) - car(29.9))).toBeLessThanOrEqual(5);
    for (const edge of [3, 5, 10, 25, 80]) expect(car(edge + 0.2) - car(edge - 0.2)).toBeGreaterThanOrEqual(0);
  });

  it('stays in a realistic range for ordinary legs', () => {
    const t = (km: number, mode: (typeof MODES)[number]) => estimateLegMinutes({ from: origin, to: at(km), mode })!.minutes;
    // A 15 km regional bus (≈20 km of road) is about an hour door to door; a 60 km coach about two.
    expect(t(15, 'public_bus')).toBeGreaterThanOrEqual(50);
    expect(t(15, 'public_bus')).toBeLessThanOrEqual(75);
    expect(t(60, 'public_bus')).toBeGreaterThanOrEqual(100);
    expect(t(60, 'public_bus')).toBeLessThanOrEqual(140);
    // 30 km by car (≈40 km of road) is under an hour; 100 km under two and a half.
    expect(t(30, 'drive')).toBeLessThanOrEqual(60);
    expect(t(100, 'drive')).toBeLessThanOrEqual(150);
    // Long-distance rail outruns a coach.
    expect(t(300, 'rail')).toBeLessThan(t(300, 'public_bus'));
  });
});
