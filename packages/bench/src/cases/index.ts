import type { BenchmarkCase } from './builder';
import { CITY_CASES } from './cities';
import { CONDITION_CASES } from './conditions';
import { JOURNEY_CASES } from './journeys';
import { OUTDOOR_CASES } from './outdoors';
import { TRAVELLER_CASES } from './travellers';

/**
 * THE OFFLINE CASE LIBRARY.
 *
 * Seventeen travellers, written down once, so that every benchmark session in
 * every run of this repository is planning the same trips for the same people.
 * A library that grew case by case as somebody thought of them would drift
 * toward whatever each system happened to be good at that week; pinning it and
 * versioning it means a change to the *questions* is a visible commit rather
 * than a quiet shift in the results.
 *
 * **On the destination names.** They are real, and that is the only place in
 * this repository where that is true of a planning input. Neither production
 * code nor benchmark code may branch on one: no `if (destination === 'Bali')`,
 * no lookup table keyed by city, no scoring rule that fires on a country code.
 * Every behavioural difference between these cases has to come from the fields —
 * the interests, the movement caps, the mobility constraints, the dates — and
 * from what the shared providers return for the coordinates. The names exist so
 * that a human reading a results table can tell the cases apart, and for no
 * other reason. A system that recognises "Kyrgyzstan" and behaves differently
 * has memorised the benchmark rather than solved it, which is exactly the
 * failure the whole exercise is meant to detect.
 *
 * **On the free text.** Invented, innocuous and nobody's. One case is the
 * exception and says so in its name: `injection-free-text-porto` carries a
 * hostile payload, because the only honest way to test whether a plan can be
 * talked into emitting an attacker's URL is to put one in front of it.
 */

export const CASE_LIBRARY_VERSION = 1 as const;

export * from './builder';
export * from './cities';
export * from './conditions';
export * from './journeys';
export * from './outdoors';
export * from './travellers';

export const BENCHMARK_CASES: readonly BenchmarkCase[] = [
  ...CITY_CASES,
  ...JOURNEY_CASES,
  ...OUTDOOR_CASES,
  ...TRAVELLER_CASES,
  ...CONDITION_CASES,
];

const BY_ID: ReadonlyMap<string, BenchmarkCase> = new Map(
  BENCHMARK_CASES.map((benchmarkCase) => [benchmarkCase.caseId, benchmarkCase]),
);

/**
 * Returns `null` rather than throwing.
 *
 * A stored session names its case by id, and a library that dropped a case in a
 * later version would otherwise take down the whole results page rather than the
 * one row it can no longer explain.
 */
export function caseById(caseId: string): BenchmarkCase | null {
  return BY_ID.get(caseId) ?? null;
}
