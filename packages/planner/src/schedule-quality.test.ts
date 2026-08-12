import { describe, expect, it } from 'vitest';
import {
  unavailableWeatherDataset,
  type DiscoveryCandidate,
  type DiscoverySelection,
  type ItineraryDay,
  type TripBasics,
  type WeatherDataset,
} from '@sidequest/core';
import {
  TRANSIT_CITY_ACCESS,
  TRANSIT_CITY_DATES,
  TRANSIT_CITY_HOURS,
  TRANSIT_CITY_IDENTITY,
  TRANSIT_CITY_PLACES,
  TRANSIT_CITY_REGION,
  transitCityTraveler,
} from '@sidequest/core/testing';
import type { TravelTimeMatrix } from '@sidequest/geo';
import { planTrip } from './plan';
import { DEFAULT_PLANNER_CONFIG } from './types';
import { themeFor } from './schedule';
import { validateDayWeather } from './validate-weather';
import type { ValidationInput } from './validate';
import type { PlanningCandidate } from './types';
import type { DayLayout } from './schedule';

/**
 * PR-PLAN-11: THE STORED-PLAN AUDIT'S SCHEDULING-QUALITY FINDINGS, PINNED.
 *
 * Every case here is a sentence from a real stored plan: lunch at 09:20
 * apologising for being "late", a pond visited entirely after its own day's
 * recorded sunset, "Sunrise & sunset photography" over stops that ran
 * 07:40–11:00, an unexplained 7 h 55 m free block, and an arrival evening
 * with a 19:00 window and no dinner row at all.
 */

const IDS = TRANSIT_CITY_IDENTITY;
const WINDOWS = DEFAULT_PLANNER_CONFIG.mealWindows;

/** One near stop on a road matrix, so a light car-free day plans quickly. */
function nearOnlyMatrix(): TravelTimeMatrix {
  const ids = [IDS.baseId, IDS.candidateA];
  return {
    mode: 'car',
    ids,
    minutes: ids.map((from) => ids.map((to) => (from === to ? 0 : 5))),
    km: ids.map((from) => ids.map((to) => (from === to ? 0 : 1.2))),
    provenance: { kind: 'measured', note: 'Road network, by construction.' },
  };
}

function candidateFor(placeId: string): DiscoveryCandidate {
  const place = TRANSIT_CITY_PLACES.find((entry) => entry.id === placeId)!;
  return {
    place,
    fit: {
      score: 0.8,
      band: 'strong',
      matchedInterests: [],
      blockers: [],
      cautions: [],
      reasons: [],
      transportFit: 1,
      seasonFit: 1,
    },
    quality: { outcome: 'kept', reason: 'fixture', score: 1, signals: [] },
    detourClass: 'in_tolerance',
    season: { band: 'open', note: 'fixture', months: [8] },
    access: { requiredModes: [], cautions: [], available: true, summary: 'fixture' },
    operating: { status: 'open', note: 'fixture' },
  } as unknown as DiscoveryCandidate;
}

function unfetchedWeather(): WeatherDataset {
  return unavailableWeatherDataset({
    regionId: TRANSIT_CITY_REGION.id,
    locations: [
      {
        id: 'tc-weather',
        label: 'Two Rivers',
        coordinates: TRANSIT_CITY_REGION.baseCoordinates,
        elevationMetres: 20,
        timeZone: 'Europe/Lisbon',
        placeIds: TRANSIT_CITY_PLACES.map((place) => place.id),
        limitation: 'One point for the whole city.',
      },
    ],
    dates: TRANSIT_CITY_DATES,
    now: new Date('2026-08-10T09:00:00.000Z'),
    reason: 'not_configured',
    message: 'We have not fetched the weather for this trip yet.',
  });
}

function planLightDay(basics: Partial<TripBasics> = {}) {
  const selections: DiscoverySelection[] = [
    {
      placeId: IDS.candidateA,
      status: 'included',
      source: 'user',
      updatedAt: '2026-08-10T09:00:00.000Z',
    },
  ];
  return planTrip({
    tripId: 'schedule-quality-fixture',
    basics: {
      mode: 'known_destination',
      destinationInput: 'Two Rivers',
      regionId: IDS.regionId,
      startDate: TRANSIT_CITY_DATES[0]!,
      endDate: TRANSIT_CITY_DATES[TRANSIT_CITY_DATES.length - 1]!,
      arrivalTime: '10:00',
      departureTime: '19:00',
      adults: 2,
      children: 0,
      travelerNeeds: [],
      ...basics,
    },
    profile: transitCityTraveler(),
    region: TRANSIT_CITY_REGION,
    candidates: [candidateFor(IDS.candidateA)],
    selections,
    matrix: nearOnlyMatrix(),
    access: TRANSIT_CITY_ACCESS,
    hours: TRANSIT_CITY_HOURS,
    weather: unfetchedWeather(),
    baseId: IDS.baseId,
    now: new Date('2026-08-10T09:00:00.000Z'),
    generatedAt: '2026-08-10T09:00:00.000Z',
  });
}

describe('meal blocks against their own windows', () => {
  it('never opens a lunch block before the lunch window, however early the route ends', () => {
    /*
     * One 90-minute stop a 16-minute walk away: the route is done by
     * mid-morning, which is exactly the shape that used to print a 09:20 block
     * titled Lunch with "Late, but better than skipping it" underneath.
     */
    const result = planLightDay();
    expect(result.ok, result.ok ? '' : result.message).toBe(true);
    if (!result.ok) return;

    const lunches = result.itinerary.days.flatMap((day) =>
      day.items.filter((item) => item.kind === 'meal' && item.food?.slot === 'lunch'),
    );
    expect(lunches.length).toBeGreaterThan(0);
    for (const lunch of lunches) {
      expect(lunch.startMinute).toBeGreaterThanOrEqual(WINDOWS.lunch.earliest);
      /* And the copy no longer apologises for a lateness that never happened. */
      if (lunch.startMinute <= WINDOWS.lunch.latest) {
        expect(lunch.reason).not.toContain('Late');
      }
    }
  });

  it('holds a dinner row on an evening whose window closes at seven', () => {
    /*
     * The audited arrival-day gap: a 19:00 window, dinner earliest at 18:00,
     * and a 60-minute bare block that only fitted with the evening overrun the
     * venue path and the validator both already granted. Without the overrun,
     * days like this had no dinner row at all.
     */
    const result = planLightDay();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const fullDays = result.itinerary.days.filter(
      (day) => day.window.endMinute >= WINDOWS.dinner.earliest + 15,
    );
    expect(fullDays.length).toBeGreaterThan(0);
    for (const day of fullDays) {
      const dinner = day.items.find(
        (item) => item.kind === 'meal' && item.food?.slot === 'dinner',
      );
      expect(dinner, `day ${day.dayNumber} has an evening and no dinner row`).toBeDefined();
      expect(dinner!.startMinute).toBeGreaterThanOrEqual(WINDOWS.dinner.earliest);
    }
  });

  it('grants the evening overrun to the meal without charging it to the stop', () => {
    /*
     * The other half of the overrun above, and the half that bit.
     *
     * One day, arriving at three: the gallery and the walk each way run to
     * 18:02, and the held dinner hour then finishes two minutes past a seven
     * o'clock window — inside the allowance the layout grants and the validator
     * accepts. The packer measured every trial layout against the bare window
     * instead, so the moment the *held* block was allowed that overrun the
     * packer read it as the day not fitting and refused the stop that led to
     * it: the allowance given to the meal, charged against the traveller's stop.
     *
     * One stop and one day here, so the refusal takes the whole plan down and
     * is impossible to miss. On a real trip it was quieter — the stop spilled
     * onto whichever day would take it, and that day's drive grew to reach it.
     */
    const result = planLightDay({
      arrivalTime: '15:00',
      departureTime: '21:00',
      endDate: TRANSIT_CITY_DATES[0]!,
    });
    expect(result.ok, result.ok ? '' : result.message).toBe(true);
    if (!result.ok) return;

    const day = result.itinerary.days[0]!;
    expect(day.items.filter((item) => item.kind === 'activity')).toHaveLength(1);

    const last = day.items.at(-1)!;
    expect(last.kind).toBe('meal');
    expect(last.endMinute).toBeGreaterThan(day.window.endMinute);
    expect(last.endMinute).toBeLessThanOrEqual(
      day.window.endMinute + DEFAULT_PLANNER_CONFIG.mealOverrunAllowanceMinutes,
    );
  });
});

describe('what a long open stretch says about itself', () => {
  it('explains a block over three hours instead of shrugging at it', () => {
    const result = planLightDay();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const longBlocks = result.itinerary.days.flatMap((day) =>
      day.items.filter((item) => item.kind === 'free_time' && item.durationMinutes > 180),
    );
    expect(longBlocks.length, 'the fixture should produce at least one long block').toBeGreaterThan(0);
    for (const block of longBlocks) {
      expect(block.reason).toContain('long open stretch');
      expect(block.reason).not.toBe(
        'Deliberately unbooked. A plan with no slack in it is a plan that breaks.',
      );
    }
  });

  it('says on an empty day why it is empty, so the totals and the warnings agree', () => {
    const result = planLightDay();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const empty = result.itinerary.days.filter(
      (day) =>
        day.window.usableMinutes > 0 && day.totals.activityMinutes === 0,
    );
    expect(empty.length, 'one stop across three days should leave empty days').toBeGreaterThan(0);
    for (const day of empty) {
      expect(day.warnings.some((warning) => warning.includes('Nothing is scheduled'))).toBe(true);
      /* And never the contradictory claim that the day has no hours. */
      expect(day.warnings.some((warning) => warning.includes('no usable hours'))).toBe(false);
    }
  });
});

describe('day themes against the day they describe', () => {
  const candidate = (interest: string): PlanningCandidate =>
    ({
      place: { id: 'p1', name: 'Overlook', locality: 'Two Rivers' },
      priority: 1,
      manual: false,
      selectionStatus: 'included',
      fitScore: 0.8,
      matchedInterests: [],
      durationMinutes: 90,
      travelMinutesFromBase: 10,
      travelModeFromBase: 'walk',
      primaryInterest: interest,
    }) as unknown as PlanningCandidate;

  const layoutWith = (start: number, end: number): DayLayout =>
    ({
      items: [
        {
          id: 'activity-1-p1',
          kind: 'activity',
          title: 'Overlook',
          startMinute: start,
          endMinute: end,
          durationMinutes: end - start,
          reason: 'fixture',
          weatherSensitive: false,
          placeId: 'p1',
        },
      ],
    }) as unknown as DayLayout;

  it('does not claim sunrise and sunset over a mid-morning schedule', () => {
    /* The audited shape: stops from 07:40–11:00 labelled golden-hour. */
    const theme = themeFor([candidate('photography_golden_hour')], 'Two Rivers', layoutWith(9 * 60 + 30, 11 * 60));
    expect(theme).not.toContain('Sunrise & sunset');
    expect(theme).toContain('Photography');
  });

  it('keeps the golden-hour label when the day actually touches an edge', () => {
    const theme = themeFor([candidate('photography_golden_hour')], 'Two Rivers', layoutWith(7 * 60, 8 * 60 + 30));
    expect(theme).toContain('Sunrise & sunset');
  });
});

describe('an outdoor stop after the recorded sunset', () => {
  function dayWithEveningStop(exposure: 'indoor' | 'exposed'): {
    day: ItineraryDay;
    input: ValidationInput;
  } {
    const day = {
      dayNumber: 2,
      date: '2026-08-13',
      items: [
        {
          id: 'activity-2-pond',
          kind: 'activity',
          title: 'City Pond',
          placeId: 'pond',
          startMinute: 18 * 60,
          endMinute: 19 * 60,
          durationMinutes: 60,
          reason: 'fixture',
          weatherSensitive: false,
        },
      ],
      totals: { activityMinutes: 60 },
      weather: {
        evidence: 'forecast',
        summary: 'Clear.',
        fetchedAt: '2026-08-10T09:00:00.000Z',
        sunsetMinute: 17 * 60,
        decisions: [],
        cautions: [],
        backups: [],
        provider: 'fixture',
        attribution: 'fixture',
        precipitationProbabilityPercent: null,
      },
    } as unknown as ItineraryDay;
    const input = {
      weather: { locations: [] },
      placesById: new Map([
        ['pond', { id: 'pond', name: 'City Pond', weather: { exposure } }],
      ]),
    } as unknown as ValidationInput;
    return { day, input };
  }

  it('cautions on an outdoor stop scheduled wholly after dark', () => {
    const { day, input } = dayWithEveningStop('exposed');
    const issues = validateDayWeather(day, input);
    const afterDark = issues.filter((issue) => issue.code === 'scheduled_after_dark');
    expect(afterDark).toHaveLength(1);
    expect(afterDark[0]!.severity).toBe('warning');
    expect(afterDark[0]!.message).toContain('sunset');
  });

  it('says nothing about an indoor place — the dark is not its problem', () => {
    const { day, input } = dayWithEveningStop('indoor');
    expect(
      validateDayWeather(day, input).filter((issue) => issue.code === 'scheduled_after_dark'),
    ).toHaveLength(0);
  });
});
