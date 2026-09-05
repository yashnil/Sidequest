import { describe, expect, it } from 'vitest';
import { buildTravelerProfile, defaultAnswers } from '@sidequest/core';
import { EASTERN_SIERRA_PLACES } from '@sidequest/core/data';
import type { TravelTimeMatrix } from '@sidequest/geo';
import { assignToDays } from './assign';
import type { AccessUnit } from './access';
import { buildDailyWindows } from './windows';
import { resolveConfig, type PlanningCandidate } from './types';
import { AUGUST_BASICS } from './testing/scenario';

/**
 * THE ROOT ARCHITECTURAL REGRESSION — A GENERIC, MULTI-BASE, DELIBERATELY
 * SPARSE-MATRIX FIXTURE.
 *
 * The live Iceland run this suite exists to prevent a repeat of: a real,
 * feasible, deterministically-repaired 7-base trip went from 15 feasible
 * candidates to 1 scheduled stop, because `assignToDays` asked one global
 * `clusterByTravelTime` call to resolve pairwise travel time across *every*
 * eligible candidate in the whole trip at once — including candidates that
 * belong to entirely different, geographically unrelated bases, which no
 * real routing evidence (primary matrix or `travelLegs`) ever connects, and
 * has no reason to.
 *
 * Four fictional bases, no Iceland names, no destination-specific logic —
 * `EASTERN_SIERRA_PLACES` is this test suite's own existing generic fixture
 * data (already reused by `strenuous-spacing.test.ts` and
 * `assign-fallback-matrix.test.ts`), not a real destination under test here.
 * The primary matrix and `travelLegs` between them are constructed to
 * contain **zero** cross-base entries anywhere, on purpose — proving the new
 * architecture never needs one.
 */

const PLACES = EASTERN_SIERRA_PLACES;
const BASE_A = 'base-a';
const BASE_B = 'base-b';
const BASE_C = 'base-c';
const BASE_D = 'base-d';

// Three candidates per base, plus one candidate at BASE_C with no routing
// evidence anywhere (the "one bad candidate" case).
const A = [PLACES[0]!, PLACES[1]!, PLACES[2]!];
const B = [PLACES[3]!, PLACES[4]!, PLACES[5]!];
const C = [PLACES[6]!, PLACES[7]!];
const C_UNROUTABLE = PLACES[8]!;
const D = [PLACES[9]!, PLACES[10]!, PLACES[11]!];

function matrixOf(ids: string[], minutes: number[][]): TravelTimeMatrix {
  return {
    mode: 'car',
    ids,
    minutes,
    km: minutes.map((row) => row.map((value) => value * 0.8)),
    provenance: { kind: 'measured', note: 'Test road network.' },
  };
}

/** A small, fully-resolved clique: base + its own candidates, every pair known both ways. */
function cliqueMatrix(baseId: string, places: readonly { id: string }[], baseToPlace = 30, placeToPlace = 20): { ids: string[]; minutes: number[][] } {
  const ids = [baseId, ...places.map((p) => p.id)];
  const minutes = ids.map((_, i) =>
    ids.map((_, j) => (i === j ? 0 : i === 0 || j === 0 ? baseToPlace : placeToPlace)),
  );
  return { ids, minutes };
}

/** Only BASE_A is in the primary matrix — everything else must come from `travelLegs`. */
function primaryMatrix(): TravelTimeMatrix {
  const clique = cliqueMatrix(BASE_A, A);
  return matrixOf(clique.ids, clique.minutes);
}

/**
 * BASE_B, BASE_C (routable half only) and BASE_D, each its own fully-resolved
 * clique — never merged into one matrix, never sharing a single cross-base
 * cell. `C_UNROUTABLE` is deliberately absent from every clique.
 */
function travelLegs(): TravelTimeMatrix {
  const cliques = [cliqueMatrix(BASE_B, B), cliqueMatrix(BASE_C, C), cliqueMatrix(BASE_D, D)];
  const ids: string[] = [];
  const index = new Map<string, number>();
  for (const clique of cliques) for (const id of clique.ids) if (!index.has(id)) { index.set(id, ids.length); ids.push(id); }
  const size = ids.length;
  const minutes: number[][] = Array.from({ length: size }, (_, i) => Array.from({ length: size }, (_, j) => (i === j ? 0 : Number.NaN)));
  for (const clique of cliques) {
    for (let i = 0; i < clique.ids.length; i += 1) {
      for (let j = 0; j < clique.ids.length; j += 1) {
        const gi = index.get(clique.ids[i]!)!;
        const gj = index.get(clique.ids[j]!)!;
        minutes[gi]![gj] = clique.minutes[i]![j]!;
      }
    }
  }
  return matrixOf(ids, minutes);
}

function candidateFor(place: { id: string; physicalIntensity?: string }): PlanningCandidate {
  return {
    place,
    priority: 500,
    manual: false,
    selectionStatus: 'included',
    fitScore: 0.7,
    matchedInterests: [],
    durationMinutes: 90,
    travelMinutesFromBase: 30,
    travelModeFromBase: 'drive',
  } as unknown as PlanningCandidate;
}

const EIGHT_DAY_BASICS = { ...AUGUST_BASICS, startDate: '2026-08-01', endDate: '2026-08-08' };

function eightDays() {
  const profile = buildTravelerProfile(defaultAnswers({ travelerNeeds: [], tripDays: 8 }), {
    travelerNeeds: [],
    tripDays: 8,
  });
  return buildDailyWindows(EIGHT_DAY_BASICS, profile, resolveConfig());
}

/** Days 1-2 -> BASE_A, 3-4 -> BASE_B, 5-6 -> BASE_C, 7-8 -> BASE_D. */
function baseIdFor(date: string): string {
  const days = eightDays();
  const day = days.find((d) => d.date === date);
  const n = day?.dayNumber ?? 1;
  if (n <= 2) return BASE_A;
  if (n <= 4) return BASE_B;
  if (n <= 6) return BASE_C;
  return BASE_D;
}

function allEligible(): PlanningCandidate[] {
  return [...A, ...B, ...C, C_UNROUTABLE, ...D].map((place) => candidateFor(place));
}

function run(locks?: ReadonlyMap<string, number>) {
  return assignToDays(
    allEligible(),
    eightDays(),
    primaryMatrix(),
    baseIdFor,
    new Map<string, AccessUnit>(),
    new Map(),
    new Map(),
    () => null,
    false,
    travelLegs(),
    locks,
  );
}

function placedAt(assignments: ReturnType<typeof run>['assignments'], dayNumber: number): string[] {
  return assignments.find((entry) => entry.day.dayNumber === dayNumber)?.candidates.map((c) => c.place.id) ?? [];
}

function allPlacedIds(assignments: ReturnType<typeof run>['assignments']): string[] {
  return assignments.flatMap((entry) => entry.candidates.map((c) => c.place.id)).sort();
}

describe('assignToDays — multi-base local clustering (the general fix, no destination-specific logic)', () => {
  it('candidates at completely different bases never need a pairwise edge between them — every routable candidate is still placed', () => {
    const { assignments } = run();
    const placed = allPlacedIds(assignments);
    for (const place of [...A, ...B, ...C, ...D]) expect(placed).toContain(place.id);
  });

  it('the deliberately unroutable candidate at BASE_C does not collapse BASE_C, let alone the rest of the trip', () => {
    const { assignments } = run();
    const placed = allPlacedIds(assignments);
    expect(placed).not.toContain(C_UNROUTABLE.id);
    // Its two routable BASE_C neighbours still made it, on BASE_C's own days (5-6).
    expect([...placedAt(assignments, 5), ...placedAt(assignments, 6)]).toEqual(
      expect.arrayContaining(C.map((p) => p.id)),
    );
  });

  it('local clustering works entirely from travelLegs fallback evidence for bases with no primary-matrix coverage at all', () => {
    const { assignments } = run();
    const placed = allPlacedIds(assignments);
    // BASE_B and BASE_D have zero primary-matrix presence (only BASE_A does) —
    // every one of their candidates is placeable only via travelLegs.
    for (const place of [...B, ...D]) expect(placed).toContain(place.id);
  });

  it('every locked anchor, one per base, is scheduled on its own pinned day — never silently absent', () => {
    const locks = new Map<string, number>([
      [A[0]!.id, 1],
      [B[0]!.id, 3],
      [C[0]!.id, 5],
      [D[0]!.id, 7],
    ]);
    const { assignments, funnel } = run(locks);
    expect(placedAt(assignments, 1)).toContain(A[0]!.id);
    expect(placedAt(assignments, 3)).toContain(B[0]!.id);
    expect(placedAt(assignments, 5)).toContain(C[0]!.id);
    expect(placedAt(assignments, 7)).toContain(D[0]!.id);
    expect(funnel.lockedRequested).toBe(4);
    expect(funnel.lockedScheduled).toBe(4);
    expect(funnel.lockedRejected).toBe(0);
  });

  it('a lock with no routing evidence to its pinned day’s base is typed-rejected, never silently dropped and never force-placed', () => {
    const locks = new Map<string, number>([[C_UNROUTABLE.id, 5]]);
    const { funnel } = run(locks);
    expect(funnel.lockedRequested).toBe(1);
    expect(funnel.lockedScheduled).toBe(0);
    expect(funnel.lockedRejected).toBe(1);
    expect(funnel.lockedRejections[0]).toEqual({ placeId: C_UNROUTABLE.id, reason: 'not_routable_to_target_base' });
  });

  it('a lock pinned to a day outside the trip is typed-rejected as day_not_usable, never crashes', () => {
    const locks = new Map<string, number>([[A[0]!.id, 999]]);
    expect(() => run(locks)).not.toThrow();
    const { funnel } = run(locks);
    expect(funnel.lockedRejections).toEqual([{ placeId: A[0]!.id, reason: 'day_not_usable' }]);
  });

  it('total trip days remain exactly 8 regardless of any drop, local or locked', () => {
    const { assignments } = run();
    expect(assignments).toHaveLength(8);
    expect(assignments.map((entry) => entry.day.dayNumber).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('the funnel accounts for every candidate: entering, assigned, scheduled, and the one genuine drop, by reason', () => {
    const { funnel } = run();
    expect(funnel.candidatesEntering).toBe(A.length + B.length + C.length + 1 + D.length);
    expect(funnel.candidatesScheduled).toBe(A.length + B.length + C.length + D.length); // everyone but the one unroutable candidate
    expect(funnel.droppedByReason.no_base_window_reachable).toBe(1); // exactly the unroutable one, nothing else
  });

  it('is deterministic — identical inputs in a different presentation order produce identical output', () => {
    const once = run();
    const reordered = assignToDays(
      [...allEligible()].reverse(),
      eightDays(),
      primaryMatrix(),
      baseIdFor,
      new Map<string, AccessUnit>(),
      new Map(),
      new Map(),
      () => null,
      false,
      travelLegs(),
    );
    const normalize = (assignments: ReturnType<typeof run>['assignments']) =>
      assignments.map((entry) => ({ dayNumber: entry.day.dayNumber, placeIds: entry.candidates.map((c) => c.place.id).sort() }));
    expect(JSON.stringify(normalize(once.assignments))).toBe(JSON.stringify(normalize(reordered.assignments)));
  });

  it('free time exists only where there genuinely are not enough acceptable candidates for that base, not because of cross-base matrix sparsity', () => {
    // BASE_A has 3 real, fully-connected candidates across its own 2 days —
    // all 3 are placed somewhere within BASE_A's own window; none are lost
    // to the cross-base matrix sparsity this fixture deliberately has
    // everywhere else. (Exactly how clustering splits 2 vs 1 across the two
    // days is `clusterByTravelTime`'s own, separately-tested behaviour.)
    const { assignments } = run();
    const day1 = placedAt(assignments, 1);
    const day2 = placedAt(assignments, 2);
    expect([...day1, ...day2].sort()).toEqual(A.map((p) => p.id).sort());
  });
});
