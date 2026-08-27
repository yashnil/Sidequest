import { describe, expect, it } from 'vitest';
import {
  buildTravelerProfile,
  defaultAnswers,
  foodDatasetSchema,
  type FoodDataset,
  type Itinerary,
} from '@sidequest/core';
import { EASTERN_SIERRA_PLACES } from '@sidequest/core/data';
import type { TravelTimeMatrix } from '@sidequest/geo';
import { resolveFood } from './food';
import { planTrip } from './plan';
import { DEFAULT_PLANNER_CONFIG, type PlanningCandidate } from './types';
import type { PlannedDay } from './windows';
import { buildScenario } from './testing/scenario';

/**
 * REMOTENESS IS A FACT ABOUT THE GROUND, NEVER ABOUT OUR OWN INDEX.
 *
 * The audited live artifact: every lunch "Packed lunch", food summary "Carried
 * food, because there is nothing verified to buy where this day goes",
 * `remote: true` — in the middle of a dense metro, because the compiler's
 * *coverage-shortfall* gap ("we found 10 places against the 12 a trip like
 * yours would draw on", provenance `estimated`, source: our own place data)
 * was read as the agency-attested "there is no food in the valley" record the
 * packed-lunch copy was written for.
 *
 * The contract: only a gap somebody with standing attested (`official` or
 * `authored`), or a day whose every stop the compiled record itself marks
 * remote-no-services, may make a day remote. An index shortfall yields a
 * caution in the compiler's own words plus one actionable line — and never
 * `remote: true`, never a carried lunch.
 */

const NOW = new Date('2026-08-10T09:00:00.000Z');

function profile() {
  const context = { travelerNeeds: [], tripDays: 2 };
  return buildTravelerProfile(defaultAnswers(context), context);
}

function day(dayNumber: number): PlannedDay {
  return {
    dayNumber,
    date: `2026-08-1${dayNumber}`,
    window: { startMinute: 540, endMinute: 1140, usableMinutes: 600 },
    isEdgeDay: false,
    capacityMinutes: 480,
  };
}

function stop(id: string, remoteNoServices: boolean): PlanningCandidate {
  return {
    place: {
      id,
      name: id,
      access: {
        roadSurface: 'paved',
        mountainRoad: false,
        parkingDifficulty: 'easy',
        remoteNoServices,
      },
    },
    priority: 1,
    boardPriority: 1,
    manual: false,
    selectionStatus: 'included',
    fitScore: 80,
    matchedInterests: [],
    durationMinutes: 90,
    travelMinutesFromBase: 10,
    travelModeFromBase: 'walk',
  } as unknown as PlanningCandidate;
}

function matrix(): TravelTimeMatrix {
  return {
    mode: 'foot',
    ids: ['base', 'stop-a', 'stop-b'],
    minutes: [
      [0, 10, 12],
      [10, 0, 6],
      [12, 6, 0],
    ],
    km: [
      [0, 0.8, 1],
      [0.8, 0, 0.5],
      [1, 0.5, 0],
    ],
    provenance: { kind: 'measured', note: 'fixture', source: 'food-remoteness.test.ts' },
  };
}

function datasetWithGap(kind: 'official' | 'estimated', placeIds: string[]): FoodDataset {
  return foodDatasetSchema.parse({
    version: 1,
    regionId: 'gap-city',
    venues: [],
    gaps: [
      {
        area: 'the whole fixture',
        placeIds,
        note:
          kind === 'official'
            ? 'The managing agency states there is nothing to eat out there.'
            : 'We found 3 places to eat here against the 12 a trip like yours would normally draw on.',
        provenance: {
          kind,
          sourceName: kind === 'official' ? 'Fixture Park Service' : 'Sidequest place data',
          confidence: 0.9,
          volatility: 'dynamic',
          recheckNote: 'Worth checking on the day.',
          ...(kind === 'official' ? { lastVerified: '2026-08-01' } : {}),
        },
      },
    ],
  });
}

function resolve(dataset: FoodDataset, remoteStops = false) {
  return resolveFood({
    dataset,
    profile: profile(),
    selections: [],
    days: [{ day: day(1), candidates: [stop('stop-a', remoteStops), stop('stop-b', remoteStops)] }],
    matrix: matrix(),
    baseId: 'base',
    windows: DEFAULT_PLANNER_CONFIG.mealWindows,
  });
}

describe('what may make a day remote', () => {
  it('an index-shortfall gap makes nothing remote and packs no lunch', () => {
    const context = resolve(datasetWithGap('estimated', ['stop-a', 'stop-b']));
    const plan = context.byDay.get(1)!;
    expect(plan.remote).toBe(false);
    const lunch = plan.slots.find((slot) => slot.slot === 'lunch');
    expect(lunch, 'the day lost its lunch slot entirely').toBeDefined();
    expect(lunch!.fallback).toBe('unplanned');
    /* The shortfall is carried as a caution, in the compiler's own words. */
    expect(plan.coverageNote).toMatch(/what our sources hold|We found/);
    expect(plan.gapNote).toBeNull();
  });

  it('an attested gap still means a carried lunch', () => {
    const context = resolve(datasetWithGap('official', ['stop-a', 'stop-b']));
    const plan = context.byDay.get(1)!;
    expect(plan.remote).toBe(true);
    expect(plan.slots.find((slot) => slot.slot === 'lunch')!.fallback).toBe('packed');
    expect(plan.gapNote).toMatch(/managing agency/);
  });

  it('a day whose every stop the record marks remote-no-services is remote without a gap', () => {
    const bare = foodDatasetSchema.parse({
      version: 1,
      regionId: 'gap-city',
      venues: [],
      gaps: [],
    });
    const context = resolve(bare, true);
    expect(context.byDay.get(1)!.remote).toBe(true);
  });

  it('one remote stop on a day that comes back through town does not', () => {
    const bare = foodDatasetSchema.parse({
      version: 1,
      regionId: 'gap-city',
      venues: [],
      gaps: [],
    });
    const context = resolveFood({
      dataset: bare,
      profile: profile(),
      selections: [],
      days: [{ day: day(1), candidates: [stop('stop-a', true), stop('stop-b', false)] }],
      matrix: matrix(),
      baseId: 'base',
      windows: DEFAULT_PLANNER_CONFIG.mealWindows,
    });
    expect(context.byDay.get(1)!.remote).toBe(false);
  });
});

describe('a thin-coverage region, end to end', () => {
  /**
   * The Eastern Sierra with its food index emptied and the compiler's
   * index-shortfall gap written over every place — the audited dense-metro
   * shape, reproduced on the fixture region. Before the gate, every day with a
   * stop came back `remote: true` with a carried lunch.
   */
  function thinnedFood(): FoodDataset {
    return foodDatasetSchema.parse({
      version: 1,
      regionId: 'eastern-sierra',
      venues: [],
      gaps: [
        {
          area: 'the region',
          /* Every place the region holds, so every day with a stop matches. */
          placeIds: EASTERN_SIERRA_PLACES.map((place) => place.id),
          note: 'We found 0 places to eat here against the 8 a 4-day trip like yours would normally draw on. This is what our sources hold, not a claim that there is nothing else — expect to find some meals yourself.',
          provenance: {
            kind: 'estimated',
            sourceName: 'Sidequest place data',
            confidence: 0.9,
            volatility: 'dynamic',
            recheckNote: 'Worth checking a map app on the day — this is what we found, not what is there.',
          },
        },
      ],
    });
  }

  function planned(): Itinerary {
    const result = planTrip(buildScenario({ food: thinnedFood(), now: NOW }));
    if (!result.ok) throw new Error(`planning failed: ${result.code} — ${result.message}`);
    return result.itinerary;
  }

  it('never calls a coverage shortfall remote, and carries no food for it', () => {
    const itinerary = planned();
    for (const day of itinerary.days) {
      expect(day.food.remote, `day ${day.dayNumber} called an index shortfall remote`).toBe(false);
      for (const item of day.items) {
        expect(item.food?.stopKind, `day ${day.dayNumber} packed a lunch over an index gap`).not.toBe(
          'packed',
        );
      }
      expect(day.food.summary).not.toMatch(/Carried food/);
    }
  });

  it('says the honest thing instead: unverified coverage, check locally', () => {
    const itinerary = planned();
    const withStops = itinerary.days.filter((day) =>
      day.items.some((item) => item.kind === 'activity'),
    );
    expect(withStops.length).toBeGreaterThan(0);
    for (const day of withStops) {
      const notes = day.food.notes.join(' ');
      expect(notes).toMatch(/could not verify places to eat/i);
      expect(notes).toMatch(/check locally/i);
    }
  });
});
