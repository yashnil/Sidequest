import { describe, expect, it } from 'vitest';
import {
  benchmarkPlanSchema,
  planFingerprint,
  type BenchmarkPlan,
} from '@sidequest/bench';
import {
  autoSelect,
  buildDiscoveryBoard,
  buildTravelerProfile,
  countTripDays,
  itineraryStructureFingerprint,
  tripDates,
  tripMonths,
  type Itinerary,
  type PlannerReadiness,
  type TripBasics,
} from '@sidequest/core';
import {
  EASTERN_SIERRA,
  EASTERN_SIERRA_ACCESS,
  EASTERN_SIERRA_BASE_ID,
  EASTERN_SIERRA_FOOD,
  EASTERN_SIERRA_HOURS,
  EASTERN_SIERRA_PLACES,
  EASTERN_SIERRA_WEATHER_LOCATIONS,
  buildFixtureWeather,
  easternSierraTravelMatrix,
} from '@sidequest/core/data';
import { planTrip } from '@sidequest/planner';

import { toBenchmarkPlan, type ConversionContext } from './convert';

/**
 * The itinerary under test is a real one.
 *
 * Built by the actual planner, from the actual authored region, so the
 * conversion is exercised against the shapes production emits rather than
 * against a hand-written object that happens to satisfy the schema. A
 * hand-built fixture would drift the moment the planner learned to emit a new
 * kind of block, and the converter would keep passing while quietly dropping it.
 */

const NOW = new Date('2026-07-30T12:00:00.000Z');

const BASICS: TripBasics = {
  mode: 'known_destination',
  destinationInput: 'Mammoth Lakes',
  regionId: EASTERN_SIERRA.id,
  startDate: '2026-08-12',
  endDate: '2026-08-15',
  arrivalTime: '11:00',
  departureTime: '17:00',
  adults: 2,
  children: 0,
  travelerNeeds: [],
};

function realItinerary(): Itinerary {
  const tripDays = countTripDays(BASICS.startDate, BASICS.endDate);
  const context = { travelerNeeds: [], tripDays };
  const profile = buildTravelerProfile(
    {
      interests: {
        hiking: 'frequent',
        lakes_and_rivers: 'frequent',
        scenic_viewpoints: 'core',
        food_and_towns: 'occasional',
        scenic_drives: 'occasional',
        photography_golden_hour: 'occasional',
        geology_and_geothermal: 'occasional',
        easy_nature_walks: 'occasional',
        history_and_culture: 'low',
        hot_springs: 'low',
        wildlife: 'low',
        stargazing: 'low',
      },
      preferenceSignals: [],
      pace: 'balanced',
      dayStart: 'early',
      dailyIntensity: 'moderate',
      budgetStyle: 'midrange',
      discoveryMix: 'balanced',
      crowdTolerance: 'avoid_crowds',
      avoidTouristTraps: true,
      willDrive: true,
      comfortableMountainRoads: true,
      comfortableGravelRoads: true,
      maxDailyTravelMinutes: 150,
      willUseShuttles: true,
      maxAccessWalkMinutes: 25,
      transportPriority: 'best_value',
      regionalExpansion: 'nearby_60',
      detourToleranceMinutes: 60,
      avoidances: [],
      mobilityLimited: false,
      breakfastStyle: 'coffee_light',
      foodStyle: 'balanced',
      specialMealAppetite: 'one',
      willPackLunch: true,
      dietaryNeeds: [],
      dietaryStrict: false,
    },
    context,
  );

  const dates = tripDates(BASICS.startDate, BASICS.endDate);
  const weather = buildFixtureWeather({
    regionId: EASTERN_SIERRA.id,
    locations: EASTERN_SIERRA_WEATHER_LOCATIONS,
    dates,
    now: NOW,
  });
  const board = buildDiscoveryBoard({
    region: EASTERN_SIERRA,
    places: EASTERN_SIERRA_PLACES,
    profile,
    months: tripMonths(BASICS.startDate, BASICS.endDate),
    dates,
    access: EASTERN_SIERRA_ACCESS,
    hours: EASTERN_SIERRA_HOURS,
    weather,
    travelerNeeds: [],
  });
  const selection = autoSelect({ candidates: board.candidates, profile, tripDays });

  const result = planTrip({
    tripId: 'trip-under-test',
    basics: BASICS,
    profile,
    region: EASTERN_SIERRA,
    candidates: board.candidates,
    selections: selection.selectedIds.map((placeId) => ({
      placeId,
      status: 'included' as const,
      source: 'auto' as const,
      updatedAt: NOW.toISOString(),
    })),
    matrix: easternSierraTravelMatrix(),
    access: EASTERN_SIERRA_ACCESS,
    hours: EASTERN_SIERRA_HOURS,
    weather,
    food: EASTERN_SIERRA_FOOD,
    now: NOW,
    baseId: EASTERN_SIERRA_BASE_ID,
    generatedAt: NOW.toISOString(),
  });
  if (!result.ok) throw new Error(`The fixture itinerary did not plan: ${result.code}`);
  return result.itinerary;
}

const ITINERARY = realItinerary();

function contextFor(overrides: Partial<ConversionContext> = {}): ConversionContext {
  return {
    planId: 'plan-1',
    requestId: 'req-1',
    compiled: null,
    destinationName: 'Mammoth Lakes',
    generationState: 'complete',
    failureKind: null,
    failureDetail: null,
    startDate: BASICS.startDate,
    endDate: BASICS.endDate,
    ...overrides,
  };
}

describe('a converted plan is a legal neutral plan', () => {
  const plan = toBenchmarkPlan(ITINERARY, null, contextFor());

  it('parses under the neutral schema', () => {
    expect(benchmarkPlanSchema.safeParse(plan).success).toBe(true);
  });

  it('round-trips through storage without changing its fingerprint', () => {
    const reparsed = benchmarkPlanSchema.parse(JSON.parse(JSON.stringify(plan)));
    expect(planFingerprint(reparsed)).toBe(planFingerprint(plan));
  });

  it('carries every day of the source plan, in order', () => {
    expect(plan.days.map((day) => day.date)).toEqual(ITINERARY.days.map((day) => day.date));
    expect(plan.days.map((day) => day.dayNumber)).toEqual(
      ITINERARY.days.map((day) => day.dayNumber),
    );
  });

  it('carries every block of every day', () => {
    for (const [index, day] of plan.days.entries()) {
      expect(day.blocks.length).toBe(ITINERARY.days[index]!.items.length);
    }
  });

  it('never states a travel time as measured when nobody measured it', () => {
    for (const day of plan.days) {
      for (const block of day.blocks) {
        const source = ITINERARY.days
          .flatMap((entry) => entry.items)
          .find((item) => item.travel && item.title === block.title);
        if (!block.travel || !source?.travel) continue;
        if (source.travel.provenance === 'modelled' || source.travel.provenance === 'estimated') {
          expect(block.travel.provenance).toBe('unknown');
        }
      }
    }
  });

  it('leaves the native artifact untouched', () => {
    // The conversion reads and never writes. If it mutated the itinerary — a
    // sort in place, a spliced array — the structural fingerprint of the source
    // would move, and the artifact stored beside the plan would no longer be the
    // thing the plan was made from.
    const before = itineraryStructureFingerprint(ITINERARY);
    toBenchmarkPlan(ITINERARY, null, contextFor({ planId: 'plan-2' }));
    expect(itineraryStructureFingerprint(ITINERARY)).toBe(before);
  });

  it('keeps backups as alternatives rather than scheduling them', () => {
    const scheduled = new Set(
      plan.days.flatMap((day) => day.blocks.map((block) => block.place?.name).filter(Boolean)),
    );
    for (const day of plan.days) {
      for (const alternative of day.alternatives) {
        expect(scheduled.has(alternative.place.name)).toBe(false);
      }
    }
  });
});

describe('a run that produced nothing still produces a reviewable plan', () => {
  const readiness: PlannerReadiness = {
    schemaVersion: 2,
    level: 'insufficient',
    funnel: {
      considered: 12,
      selected: 6,
      eligible: 6,
      accessFeasible: 2,
      hoursFeasible: 0,
      feasible: 0,
      scheduled: 0,
    },
    supply: {},
    unresolved: {
      routePairs: 4,
      criticalHours: 3,
      accessRequirements: 1,
      blockingClosures: 0,
      exhaustedBudgets: ['pages'],
    },
    daysRequested: 4,
    daysWithFullMeals: 0,
    rejections: [],
    dominantBlockers: [],
    remedies: [],
    summary: 'Nothing on the board could be placed on these dates.',
  };

  const failed = toBenchmarkPlan(
    null,
    readiness,
    contextFor({
      generationState: 'failed',
      failureKind: 'insufficient_data',
      failureDetail: 'No day-by-day plan could be built from what was available for these dates.',
    }),
  );

  it('is a row a reviewer can open', () => {
    expect(benchmarkPlanSchema.safeParse(failed).success).toBe(true);
    expect(failed.generationState).toBe('failed');
    expect(failed.days).toEqual([]);
  });

  it('says what it did not know, in counts it actually measured', () => {
    expect(failed.unknowns.some((entry) => entry.includes('4 pairs'))).toBe(true);
    expect(failed.unknowns.some((entry) => entry.includes('3 chosen places'))).toBe(true);
  });

  it('names nothing that would identify the system that produced it', () => {
    expectNeutral(failed);
  });
});

describe('a partial run is reported as partial rather than as a success', () => {
  const partial = toBenchmarkPlan(
    ITINERARY,
    null,
    contextFor({
      generationState: 'partial',
      failureKind: 'insufficient_data',
      failureDetail: 'Some of what was asked for could not be fitted into these dates.',
    }),
  );

  it('keeps the days it managed and the reason it fell short', () => {
    expect(partial.generationState).toBe('partial');
    expect(partial.days.length).toBeGreaterThan(0);
    expect(partial.failureDetail).toBeTruthy();
    expectNeutral(partial);
  });
});

/**
 * The blinding check, applied to everything a reviewer could read.
 *
 * The token scan cannot prove a reviewer will not guess from tone or structure —
 * that is what the post-reveal question is for — but a plan that says the name
 * out loud makes the whole session worthless, and that is cheap to prevent.
 */
function expectNeutral(plan: BenchmarkPlan): void {
  const readable = JSON.stringify({
    summary: plan.summary,
    scopeNote: plan.scopeNote,
    failureDetail: plan.failureDetail,
    unknowns: plan.unknowns,
    warnings: plan.warnings,
    preparation: plan.preparation,
    days: plan.days,
    exclusions: plan.exclusions,
  }).toLowerCase();

  for (const token of ['sidequest', 'compiler', 'planner', 'provider', 'anthropic', 'openai']) {
    expect(readable, token).not.toContain(token);
  }
}
