import { describe, expect, it } from 'vitest';
import { FORBIDDEN_DERIVED_KEYS, benchmarkTripRequestSchema } from '../schemas/request';
import { BENCHMARK_CASES, CASE_LIBRARY_VERSION, caseById } from './index';
import { INJECTION_PROBE_HOST, PROMPT_INJECTION } from './conditions';
import { lengthForNights } from './builder';

/**
 * The library's own guard rail.
 *
 * Its job is not to check that the cases are good trips — nothing automated can
 * — but that the set still covers what the benchmark specification says it must.
 * A case quietly deleted, a profile silently duplicated or a destination dropped
 * during a refactor would each narrow the benchmark without narrowing anything
 * visible, and the aggregate would keep reporting a number.
 */

/** The day the library was authored against. Every trip must start after it. */
const AUTHORED_ON = '2026-08-06';

/**
 * The sixteen profiles the specification requires, each pinned to the case that
 * carries it. A table rather than an inference, because "is there a nightlife
 * case?" answered by scanning interests would pass the day somebody set
 * `nightlife: 'occasional'` on a museum trip.
 */
const REQUIRED_PROFILES: readonly { profile: string; caseId: string }[] = [
  { profile: 'dense city', caseId: 'city-dense-new-york' },
  { profile: 'public-transit city', caseId: 'city-transit-tokyo' },
  { profile: 'food-focused weekend', caseId: 'city-food-weekend-oaxaca' },
  { profile: 'nightlife-focused short trip', caseId: 'city-nightlife-berlin' },
  { profile: 'broad 10-12 day country trip', caseId: 'country-broad-slovenia' },
  { profile: 'multi-base road trip', caseId: 'road-trip-multi-base-iceland' },
  { profile: 'national park', caseId: 'park-yosemite' },
  { profile: 'remote outdoor region', caseId: 'outdoor-remote-kyrgyzstan' },
  { profile: 'island', caseId: 'island-bali' },
  { profile: 'archipelago or ferry trip', caseId: 'island-archipelago-cyclades' },
  { profile: 'family trip', caseId: 'family-costa-rica' },
  { profile: 'low-driving traveller', caseId: 'low-driving-scottish-highlands' },
  { profile: 'slow-paced traveller', caseId: 'slow-paced-madeira' },
  { profile: 'mobility-constrained traveller', caseId: 'mobility-constrained-amsterdam' },
  { profile: 'shoulder-season weather-sensitive trip', caseId: 'shoulder-season-dolomites' },
  { profile: 'weak-data destination', caseId: 'weak-data-sao-tome' },
];

/** The geographic spread, checked by resolved identity rather than by prose. */
const REQUIRED_GEOGRAPHY: readonly { geography: string; identityId: string }[] = [
  { geography: 'New York City', identityId: 'bench-new-york-city' },
  { geography: 'Bali', identityId: 'bench-bali' },
  { geography: 'Kyrgyzstan', identityId: 'bench-kyrgyzstan' },
  { geography: 'Iceland or Slovenia', identityId: 'bench-iceland' },
  { geography: 'a national park', identityId: 'bench-yosemite' },
  { geography: 'an East Asian city', identityId: 'bench-tokyo' },
  { geography: 'a Latin American destination', identityId: 'bench-oaxaca' },
  { geography: 'a small island', identityId: 'bench-madeira' },
  { geography: 'a weak-data destination', identityId: 'bench-sao-tome' },
];

function nightsBetween(startDate: string, endDate: string): number {
  const start = Date.parse(`${startDate}T00:00:00Z`);
  const end = Date.parse(`${endDate}T00:00:00Z`);
  return Math.round((end - start) / 86_400_000);
}

function everyKey(value: unknown, seen: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const entry of value) everyKey(entry, seen);
    return seen;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      seen.push(key);
      everyKey(child, seen);
    }
  }
  return seen;
}

describe('the benchmark case library', () => {
  it('is versioned and holds at least the sixteen required profiles', () => {
    expect(CASE_LIBRARY_VERSION).toBe(1);
    expect(BENCHMARK_CASES.length).toBeGreaterThanOrEqual(16);
  });

  it('gives every case a unique id, and finds each one by it', () => {
    const ids = BENCHMARK_CASES.map((benchmarkCase) => benchmarkCase.caseId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(caseById(id)?.caseId).toBe(id);
    expect(caseById('nothing-of-the-sort')).toBeNull();
  });

  it.each(REQUIRED_PROFILES)('carries the $profile profile as $caseId', ({ caseId }) => {
    expect(caseById(caseId)).not.toBeNull();
  });

  it.each(REQUIRED_GEOGRAPHY)('reaches $geography', ({ identityId }) => {
    const found = BENCHMARK_CASES.some(
      (benchmarkCase) => benchmarkCase.request.destination.identity?.id === identityId,
    );
    expect(found).toBe(true);
  });

  it.each(BENCHMARK_CASES.map((benchmarkCase) => [benchmarkCase.caseId, benchmarkCase] as const))(
    '%s parses, and parsing it again changes nothing',
    (_caseId, benchmarkCase) => {
      const reparsed = benchmarkTripRequestSchema.parse(benchmarkCase.request);
      expect(reparsed).toEqual(benchmarkCase.request);
    },
  );

  it.each(BENCHMARK_CASES.map((benchmarkCase) => [benchmarkCase.caseId, benchmarkCase] as const))(
    '%s states dates that agree with its night count and lie in the future',
    (_caseId, benchmarkCase) => {
      const { dates } = benchmarkCase.request;
      if (dates.startDate !== null && dates.endDate !== null) {
        expect(nightsBetween(dates.startDate, dates.endDate)).toBe(dates.nights);
        expect(dates.startDate > AUTHORED_ON).toBe(true);
      } else {
        // A month-mode request has no span, so the only thing to check is that
        // the year it names has not already gone by.
        expect(dates.year).not.toBeNull();
        expect(dates.year ?? 0).toBeGreaterThanOrEqual(2026);
      }
    },
  );

  it.each(BENCHMARK_CASES.map((benchmarkCase) => [benchmarkCase.caseId, benchmarkCase] as const))(
    '%s declares a length trait that matches its nights',
    (_caseId, benchmarkCase) => {
      expect(benchmarkCase.traits.length).toBe(lengthForNights(benchmarkCase.request.dates.nights));
    },
  );

  it.each(BENCHMARK_CASES.map((benchmarkCase) => [benchmarkCase.caseId, benchmarkCase] as const))(
    '%s carries no key a system would have derived',
    (_caseId, benchmarkCase) => {
      const keys = new Set(everyKey(benchmarkCase.request));
      for (const forbidden of FORBIDDEN_DERIVED_KEYS) expect(keys.has(forbidden)).toBe(false);
    },
  );

  it('breaks the traits across enough of each axis to slice a result by', () => {
    const kinds = new Set(BENCHMARK_CASES.map((benchmarkCase) => benchmarkCase.traits.kind));
    expect(kinds).toEqual(new Set(['city', 'country', 'road_trip', 'outdoor', 'island', 'park']));

    const lengths = new Set(BENCHMARK_CASES.map((benchmarkCase) => benchmarkCase.traits.length));
    expect(lengths).toEqual(new Set(['short', 'medium', 'long']));

    const weak = BENCHMARK_CASES.filter(
      (benchmarkCase) => benchmarkCase.traits.dataStrength === 'weak',
    );
    expect(weak.length).toBeGreaterThanOrEqual(2);

    const transit = BENCHMARK_CASES.filter((benchmarkCase) => benchmarkCase.traits.transit);
    expect(transit.length).toBeGreaterThanOrEqual(4);
    expect(transit.length).toBeLessThan(BENCHMARK_CASES.length);
  });

  it('keeps the injection payload in exactly one clearly named case', () => {
    const carrying = BENCHMARK_CASES.filter((benchmarkCase) =>
      benchmarkCase.request.freeText.includes(INJECTION_PROBE_HOST),
    );
    expect(carrying.map((benchmarkCase) => benchmarkCase.caseId)).toEqual([
      PROMPT_INJECTION.caseId,
    ]);
    expect(PROMPT_INJECTION.caseId).toContain('injection');

    for (const benchmarkCase of BENCHMARK_CASES) {
      if (benchmarkCase.caseId === PROMPT_INJECTION.caseId) continue;
      expect(benchmarkCase.request.freeText.toLowerCase()).not.toContain('ignore all previous');
    }
  });

  it('respects the movement refinements every case has to satisfy', () => {
    for (const { caseId, request } of BENCHMARK_CASES) {
      const { movement } = request;
      if (!movement.carAvailable) {
        expect(movement.maxDailyDriveMinutes, caseId).toBe(0);
      }
      expect(movement.maxDailyTravelMinutes, caseId).toBeGreaterThanOrEqual(
        movement.maxDailyDriveMinutes,
      );
      expect(movement.maxBaseChanges + 1, caseId).toBeGreaterThanOrEqual(
        movement.desiredBaseCount,
      );
    }
  });
});
