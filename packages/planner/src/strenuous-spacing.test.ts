import { describe, expect, it } from 'vitest';
import { buildTravelerProfile, defaultAnswers, type QuestionnaireAnswers } from '@sidequest/core';
import { EASTERN_SIERRA_PLACES } from '@sidequest/core/data';
import type { TravelTimeMatrix } from '@sidequest/geo';
import { assignToDays, wantsStrenuousDaysApart } from './assign';
import type { AccessUnit } from './access';
import { buildDailyWindows } from './windows';
import { resolveConfig, type PlanningCandidate } from './types';
import { AUGUST_BASICS } from './testing/scenario';

/**
 * §9.3: "LONG HIKES ON CONSECUTIVE DAYS WHEN PACE SAYS OTHERWISE."
 *
 * `maxStrenuousPerDay` bounds effort *within* a day and nothing at all bounded
 * it *between* days, so a balanced-pace traveller who likes hiking could be
 * handed three long climbs in a row: every day passed every check it was given,
 * and the week was punishing. Composition is a property of the sequence, and
 * nothing was looking at the sequence.
 */

const PLACES = EASTERN_SIERRA_PLACES.slice(0, 4);

/** Four stops around one base, two of them hard, all equally reachable. */
function matrix(): TravelTimeMatrix {
  const ids = ['base', ...PLACES.map((place) => place.id)];
  /* Descending, so the clusterer's weight ordering is a property of the fixture. */
  const minutes = [70, 60, 50, 40];
  const size = ids.length;
  const grid = (value: (i: number, j: number) => number) =>
    Array.from({ length: size }, (_, i) => Array.from({ length: size }, (_, j) => value(i, j)));
  return {
    mode: 'car',
    ids,
    minutes: grid((i, j) => (i === j ? 0 : Math.max(minutes[i - 1] ?? 30, minutes[j - 1] ?? 30))),
    km: grid((i, j) => (i === j ? 0 : 40)),
    provenance: { kind: 'measured', note: 'Test road network.' },
  };
}

function candidate(index: number, strenuous: boolean): PlanningCandidate {
  const place = PLACES[index]!;
  return {
    place: { ...place, physicalIntensity: strenuous ? 'strenuous' : 'easy' },
    priority: 1000 - index,
    manual: false,
    selectionStatus: 'included',
    fitScore: 0.8,
    matchedInterests: [],
    durationMinutes: 120,
    travelMinutesFromBase: [70, 60, 50, 40][index]!,
    travelModeFromBase: 'drive',
  } as unknown as PlanningCandidate;
}

/** Places 0 and 2 are the hard ones — separated in the pool, not adjacent in it. */
const POOL = [candidate(0, true), candidate(1, false), candidate(2, true), candidate(3, false)];

function daysHoldingHardStops(separate: boolean): number[] {
  const profile = buildTravelerProfile(defaultAnswers({ travelerNeeds: [], tripDays: 4 }), {
    travelerNeeds: [],
    tripDays: 4,
  });
  const days = buildDailyWindows(AUGUST_BASICS, profile, resolveConfig());
  const assignments = assignToDays(
    POOL,
    days,
    matrix(),
    () => 'base',
    new Map<string, AccessUnit>(),
    new Map(),
    new Map(),
    () => null,
    separate,
  );
  return assignments
    .filter((entry) =>
      entry.candidates.some((item) => item.place.physicalIntensity === 'strenuous'),
    )
    .map((entry) => entry.day.dayNumber)
    .sort((a, b) => a - b);
}

function anyAdjacent(dayNumbers: readonly number[]): boolean {
  return dayNumbers.some((day, index) => index > 0 && day - dayNumbers[index - 1]! === 1);
}

describe('hard days, spaced out', () => {
  it('does not put two hard days back to back when the traveller did not ask for that', () => {
    const spaced = daysHoldingHardStops(true);
    expect(spaced.length, 'both hard stops have to land somewhere').toBe(2);
    expect(
      anyAdjacent(spaced),
      `two strenuous days in a row: ${spaced.join(', ')}`,
    ).toBe(false);
  });

  it('is the only thing separating them — without it they land side by side', () => {
    /*
     * The control. If the unspaced assignment already scattered them, the test
     * above would pass for reasons that have nothing to do with the code it is
     * meant to cover.
     */
    expect(anyAdjacent(daysHoldingHardStops(false))).toBe(true);
  });

  it('reads the traveller’s own answers, and exempts the ones who asked for hard days', () => {
    const profileFor = (answers: Partial<QuestionnaireAnswers>) =>
      buildTravelerProfile(
        { ...defaultAnswers({ travelerNeeds: [], tripDays: 4 }), ...answers },
        { travelerNeeds: [], tripDays: 4 },
      );

    expect(wantsStrenuousDaysApart(profileFor({ pace: 'balanced' }))).toBe(true);
    expect(wantsStrenuousDaysApart(profileFor({ pace: 'slow' }))).toBe(true);
    /* A fast pace is a request for a full week; spacing it out is not a kindness. */
    expect(wantsStrenuousDaysApart(profileFor({ pace: 'fast' }))).toBe(false);
    /* And so is asking for hard days outright. */
    const hardHiker = profileFor({ pace: 'balanced', dailyIntensity: 'intense' });
    if (hardHiker.derived.preferredPhysicalIntensity === 'strenuous') {
      expect(wantsStrenuousDaysApart(hardHiker)).toBe(false);
    }
  });
});
