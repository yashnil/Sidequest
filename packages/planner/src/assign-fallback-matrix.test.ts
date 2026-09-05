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
 * THE GENERAL PLANNER DEFECT `assignToDays()`'s OWN `clusterByTravelTime()`
 * CALL EXPOSED — A LIVE ICELAND RUN FIRST HIT THIS FOR REAL, ON A LOCKED
 * HIKING ANCHOR ("Lónsöræfi") THAT HAD REAL ROUTING EVIDENCE ONLY IN
 * `PlannerInput.travelLegs`, NEVER IN THE PRIMARY STATIC MATRIX.
 *
 * `assignToDays()` already threads `travelLegs` through to
 * `reachableFromDayBase()` (its own day-reachability gate, further down in
 * the same function) — but its `clusterByTravelTime()` call, immediately
 * above that gate, was still handed only the primary matrix, and
 * `clusterByTravelTime()` itself fails early and unconditionally
 * (`matrixIndex`) for any id absent from whatever matrix it is given, with
 * no fallback concept of its own. A stop upstream eligibility
 * (`resolveCandidates()`) had already accepted *because* it has real
 * `travelLegs` coverage would still crash clustering with a raw
 * `MatrixError`, destroying the whole plan.
 *
 * Entirely fictional geography — no Iceland names, no destination-specific
 * logic. `EASTERN_SIERRA_PLACES` is this test suite's own existing generic
 * fixture data (already reused by `strenuous-spacing.test.ts`), not a
 * reference to any real destination's identity being tested here.
 */

const PLACES = EASTERN_SIERRA_PLACES.slice(0, 3);
const [P0, P1, P2] = PLACES;

function matrixOf(ids: string[], minutes: number[][]): TravelTimeMatrix {
  return {
    mode: 'car',
    ids,
    minutes,
    km: minutes.map((row) => row.map((value) => value * 0.8)),
    provenance: { kind: 'measured', note: 'Test road network.' },
  };
}

/** P2 is deliberately absent — the exact shape of the real failure. */
function primaryMatrixMissingP2(): TravelTimeMatrix {
  return matrixOf(
    ['base', P0!.id, P1!.id],
    [
      [0, 30, 40],
      [30, 0, 20],
      [40, 20, 0],
    ],
  );
}

/** Full coverage for P2 — the on-demand evidence a real routing call would have produced for it. */
function travelLegsCoveringP2(): TravelTimeMatrix {
  return matrixOf(
    ['base', P0!.id, P1!.id, P2!.id],
    [
      [0, 30, 40, 35],
      [30, 0, 20, 25],
      [40, 20, 0, 15],
      [35, 25, 15, 0],
    ],
  );
}

function candidateFor(place: (typeof PLACES)[number]): PlanningCandidate {
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

function fourDays() {
  const profile = buildTravelerProfile(defaultAnswers({ travelerNeeds: [], tripDays: 4 }), {
    travelerNeeds: [],
    tripDays: 4,
  });
  return buildDailyWindows(AUGUST_BASICS, profile, resolveConfig());
}

function assign(eligible: PlanningCandidate[], matrix: TravelTimeMatrix, travelLegs?: TravelTimeMatrix) {
  return assignToDays(
    eligible,
    fourDays(),
    matrix,
    () => 'base',
    new Map<string, AccessUnit>(),
    new Map(),
    new Map(),
    () => null,
    false,
    travelLegs,
  ).assignments;
}

function allPlaceIds(assignments: ReturnType<typeof assign>): string[] {
  return assignments.flatMap((entry) => entry.candidates.map((candidate) => candidate.place.id)).sort();
}

describe('assignToDays — clustering sees fallback travelLegs evidence, not just the primary matrix', () => {
  it('THE LOAD-BEARING REGRESSION: a stop absent from the primary matrix but present in travelLegs no longer crashes clustering, and is actually placed', () => {
    const eligible = [candidateFor(P0!), candidateFor(P1!), candidateFor(P2!)];
    expect(() => assign(eligible, primaryMatrixMissingP2(), travelLegsCoveringP2())).not.toThrow();
    const assignments = assign(eligible, primaryMatrixMissingP2(), travelLegsCoveringP2());
    expect(allPlaceIds(assignments)).toEqual([P0!.id, P1!.id, P2!.id].sort());
  });

  it('the primary matrix alone (no fallback-only stop involved) is unaffected — the ordinary path still works', () => {
    const eligible = [candidateFor(P0!), candidateFor(P1!)];
    const assignments = assign(eligible, primaryMatrixMissingP2());
    expect(allPlaceIds(assignments)).toEqual([P0!.id, P1!.id].sort());
  });

  it('a primary-matrix edge is still preferred over a conflicting fallback one during clustering', () => {
    // travelLegs disagrees with the primary matrix about base<->P0 (99 vs 30);
    // since P0 is already in the primary matrix, the primary value governs.
    const conflictingTravelLegs = matrixOf(
      ['base', P0!.id, P1!.id, P2!.id],
      [
        [0, 99, 99, 35],
        [99, 0, 99, 25],
        [99, 99, 0, 15],
        [35, 25, 15, 0],
      ],
    );
    const eligible = [candidateFor(P0!), candidateFor(P1!), candidateFor(P2!)];
    // Still succeeds and places everyone — proving the primary/fallback
    // disagreement did not stop clustering (`resolveSubMatrix` resolves the
    // primary-covered pairs from primary regardless of what the fallback
    // says about the same pair).
    expect(() => assign(eligible, primaryMatrixMissingP2(), conflictingTravelLegs)).not.toThrow();
  });

  it('genuinely missing evidence (no travelLegs configured at all) drops the unresolvable stop rather than crashing — never fabricated', () => {
    const eligible = [candidateFor(P0!), candidateFor(P1!), candidateFor(P2!)];
    expect(() => assign(eligible, primaryMatrixMissingP2())).not.toThrow(); // no travelLegs argument at all
    const assignments = assign(eligible, primaryMatrixMissingP2());
    const placed = allPlaceIds(assignments);
    expect(placed).toContain(P0!.id);
    expect(placed).toContain(P1!.id);
    // P2 has no evidence anywhere and is honestly left out, never assigned
    // via a fabricated straight-line/default/zero distance.
    expect(placed).not.toContain(P2!.id);
  });

  it('genuinely missing evidence for one stop does not prevent the rest of the trip from being assigned', () => {
    const eligible = [candidateFor(P0!), candidateFor(P1!), candidateFor(P2!)];
    const assignments = assign(eligible, primaryMatrixMissingP2());
    const totalPlaced = assignments.reduce((sum, entry) => sum + entry.candidates.length, 0);
    expect(totalPlaced).toBe(2); // P0 and P1 placed; P2 dropped, not the whole trip
  });

  it('a fallback edge known only in one direction is not silently treated as symmetric — the stop it would require stays unresolved', () => {
    // base -> P2 is known; P2 -> base and P2 <-> P1 are not (NaN, not merely absent).
    const oneDirectionOnly = matrixOf(
      ['base', P0!.id, P1!.id, P2!.id],
      [
        [0, 30, 40, 35],
        [30, 0, 20, Number.NaN],
        [40, 20, 0, Number.NaN],
        [Number.NaN, Number.NaN, Number.NaN, 0],
      ],
    );
    const eligible = [candidateFor(P0!), candidateFor(P1!), candidateFor(P2!)];
    expect(() => assign(eligible, primaryMatrixMissingP2(), oneDirectionOnly)).not.toThrow();
    const placed = allPlaceIds(assign(eligible, primaryMatrixMissingP2(), oneDirectionOnly));
    // P2's own reverse legs are unmeasured everywhere, so it is dropped —
    // never given a fabricated, mirrored duration.
    expect(placed).not.toContain(P2!.id);
    expect(placed).toContain(P0!.id);
    expect(placed).toContain(P1!.id);
  });

  it('is deterministic: identical inputs (including fallback-resolved stops) produce identical assignments', () => {
    const eligible = [candidateFor(P0!), candidateFor(P1!), candidateFor(P2!)];
    const once = assign(eligible, primaryMatrixMissingP2(), travelLegsCoveringP2());
    const twice = assign([...eligible].reverse(), primaryMatrixMissingP2(), travelLegsCoveringP2());
    const normalize = (assignments: ReturnType<typeof assign>) =>
      assignments.map((entry) => ({
        dayNumber: entry.day.dayNumber,
        placeIds: entry.candidates.map((c) => c.place.id).sort(),
      }));
    expect(JSON.stringify(normalize(once))).toBe(JSON.stringify(normalize(twice)));
  });
});
