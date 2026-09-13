import { describe, expect, it } from 'vitest';
import { assessLegPlausibility, screeningModeFor } from './plausibility';

/** Real coordinates, so every figure below is a figure about the actual world. */
const BISHKEK = { lat: 42.8746, lng: 74.5698 };
const KARAKOL = { lat: 42.4907, lng: 78.3936 };
const FIELD_BC = { lat: 51.3961, lng: -116.4892 };
const EMERALD_LAKE = { lat: 51.4437, lng: -116.5317 };
const BANFF = { lat: 51.1784, lng: -115.5708 };
const ALTYN_ARASHAN = { lat: 42.4087, lng: 78.5784 };

describe('V11 §3 — the founder measurements that must never reach a traveller', () => {
  it('REFUSES Bishkek → Karakol at 434 km / 5209 min', () => {
    const verdict = assessLegPlausibility({ minutes: 5209, km: 434, from: BISHKEK, to: KARAKOL, mode: 'private_transfer' });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('too_slow_for_mode');
    /* 5.0 km/h — the figure that passed the old 5 km/h car floor by a hair. */
    expect(verdict.impliedKmh).toBeCloseTo(5, 1);
  });

  it('REFUSES it as a drive too, so the profile a matrix was asked on cannot rescue it', () => {
    expect(assessLegPlausibility({ minutes: 5209, km: 434, from: BISHKEK, to: KARAKOL, mode: 'drive' }).ok).toBe(false);
  });

  it('REFUSES "Bus to Altyn-Arashan": 22 km in 4 hr 30 min', () => {
    const verdict = assessLegPlausibility({ minutes: 270, km: 22, from: KARAKOL, to: ALTYN_ARASHAN, mode: 'public_bus' });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('too_slow_for_mode');
  });

  it('ACCEPTS the same road journey at its real duration', () => {
    expect(assessLegPlausibility({ minutes: 380, km: 434, from: BISHKEK, to: KARAKOL, mode: 'private_transfer' }).ok).toBe(true);
  });

  it('REFUSES a zero-minute leg between two distinct places', () => {
    const verdict = assessLegPlausibility({ minutes: 0, km: 0, from: FIELD_BC, to: BANFF, mode: 'walk' });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('zero_minutes_between_distinct_places');
  });

  it('ACCEPTS zero minutes between two points that really are the same place', () => {
    expect(assessLegPlausibility({ minutes: 0, km: 0, from: BANFF, to: { lat: 51.1785, lng: -115.5709 }, mode: 'walk' }).ok).toBe(true);
  });

  it('REFUSES a multi-hour walk across a city-scale separation', () => {
    const verdict = assessLegPlausibility({ minutes: 600, km: 6, from: FIELD_BC, to: EMERALD_LAKE, mode: 'walk' });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('too_slow_for_mode');
  });

  it('REFUSES an impossible implied driving speed', () => {
    expect(assessLegPlausibility({ minutes: 30, km: 300, from: BANFF, to: FIELD_BC, mode: 'drive' }).reason).toBe('too_fast_for_mode');
  });

  it('REFUSES a road distance that cannot correspond to the geometry', () => {
    /* The founder's Field → Emerald Lake: 6.1 km apart, reported as 208 km. 34x. */
    const verdict = assessLegPlausibility({ minutes: 155, km: 208, from: FIELD_BC, to: EMERALD_LAKE, mode: 'drive' });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('distance_exceeds_geometry');
  });

  it('ACCEPTS the switchbacks and fjords the ratio must never refuse', () => {
    /*
     * A pass road or a fjord head legitimately runs many times the straight
     * line. 6.1 km apart by air and 55 km by road is a nine-times detour and an
     * entirely ordinary mountain drive; a tighter ratio would trade one founder
     * defect for a class of new ones in exactly the geography Sidequest is for.
     */
    expect(assessLegPlausibility({ minutes: 60, km: 55, from: FIELD_BC, to: EMERALD_LAKE, mode: 'drive' }).ok).toBe(true);
  });

  it('ACCEPTS a short leg whose endpoints the router snapped away from the points we asked about', () => {
    /* Two trailheads 3 km apart, snapped to a road that makes the drive 2.2 km. Slack, not a verdict. */
    expect(assessLegPlausibility({ minutes: 6, km: 2.2, from: { lat: 51.4, lng: -116.5 }, to: { lat: 51.427, lng: -116.5 }, mode: 'drive' }).ok).toBe(true);
  });

  it('REFUSES a road distance shorter than the straight line (a coordinate-inversion signature)', () => {
    const verdict = assessLegPlausibility({ minutes: 240, km: 40, from: BISHKEK, to: KARAKOL, mode: 'drive' });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('distance_below_geometry');
  });

  it('REFUSES a single road leg longer than any road leg is, whatever the distance', () => {
    expect(assessLegPlausibility({ minutes: 20 * 60, km: 1500, from: BISHKEK, to: KARAKOL, mode: 'drive' }).reason).toBe('duration_exceeds_mode_ceiling');
  });
});

describe('V11 §3 — an absence is never turned into an objection', () => {
  it('accepts a leg with no duration at all', () => {
    expect(assessLegPlausibility({ minutes: null, km: 434, from: BISHKEK, to: KARAKOL, mode: 'drive' }).ok).toBe(true);
  });

  it('accepts a leg with no distance and no endpoints, where nothing about it is impossible', () => {
    expect(assessLegPlausibility({ minutes: 240, mode: 'drive' }).ok).toBe(true);
  });

  it('still refuses a bare duration that no journey of the mode could take', () => {
    /* 87 hours with no distance and no endpoints is impossible on its own terms. */
    expect(assessLegPlausibility({ minutes: 5209, mode: 'drive' }).reason).toBe('duration_exceeds_mode_ceiling');
  });

  it('accepts a slow leg with a distance but no endpoints, because the floor still applies', () => {
    /* The distance alone is enough for the speed test; the geometry tests simply do not run. */
    expect(assessLegPlausibility({ minutes: 5209, km: 434, mode: 'drive' }).ok).toBe(false);
  });

  it('never judges a mode nothing measures — a ferry, a flight, an operator transfer', () => {
    for (const mode of ['ferry', 'unsupported'] as const) {
      expect(assessLegPlausibility({ minutes: 5209, km: 4, from: BISHKEK, to: KARAKOL, mode }).ok).toBe(true);
    }
  });

  it('exempts a short leg from the speed floor, where overhead legitimately dominates', () => {
    /* 1.5 km of city crawl in 20 minutes is 4.5 km/h and completely ordinary. */
    expect(assessLegPlausibility({ minutes: 20, km: 1.5, mode: 'drive' }).ok).toBe(true);
  });

  it('accepts a genuinely slow mountain transfer that is merely unusual', () => {
    /* 120 km of rough mountain road in four hours — 30 km/h. */
    expect(assessLegPlausibility({ minutes: 240, km: 120, mode: 'private_transfer' }).ok).toBe(true);
  });

  it('accepts a stopping rural bus at 15 km/h over 30 km', () => {
    expect(assessLegPlausibility({ minutes: 120, km: 30, mode: 'public_bus' }).ok).toBe(true);
  });
});

describe('V11 §3 — the router profile decides which envelope screens the answer', () => {
  it('maps every routing profile to exactly one screening mode', () => {
    expect(screeningModeFor('car')).toBe('drive');
    expect(screeningModeFor('foot')).toBe('walk');
    expect(screeningModeFor('bicycle')).toBe('bicycle');
    expect(screeningModeFor('transit')).toBe('public_bus');
  });
});
