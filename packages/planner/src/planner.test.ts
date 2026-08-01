import { describe, expect, it } from 'vitest';
import {
  itineraryStructureFingerprint,
  type Itinerary,
  type ItineraryDay,
  type TravelerProfile,
} from '@sidequest/core';
import { planTrip } from './plan';
import { buildDailyWindows, eachDate } from './windows';
import { resolveCandidates } from './candidates';
import { reviseDayPlans } from './revise';
import { validateItinerary } from './validate';
import { isOpenOnDate } from './schedule';
import { buildFoodPlan } from './food-plan';
import { DEFAULT_PLANNER_CONFIG, resolveConfig, type PlannerInput } from './types';
import { buildScenario, type ScenarioOptions } from './testing/scenario';
import {
  EASTERN_SIERRA_ACCESS,
  EASTERN_SIERRA_BASE_ID,
  EASTERN_SIERRA_FOOD,
  EASTERN_SIERRA_HOURS,
  easternSierraTravelMatrix,
  placeById,
} from '@sidequest/core/data';

function plan(options: ScenarioOptions = {}): Itinerary {
  const result = planTrip(buildScenario(options));
  if (!result.ok) throw new Error(`Planning failed: ${result.code} — ${result.message}`);
  return result.itinerary;
}

function activities(day: ItineraryDay): string[] {
  return day.items.filter((item) => item.kind === 'activity').map((item) => item.placeId!);
}

function allActivities(itinerary: Itinerary): string[] {
  return itinerary.days.flatMap(activities);
}

function errors(itinerary: Itinerary) {
  return itinerary.issues.filter((issue) => issue.severity === 'error');
}

// ---------------------------------------------------------------------------
// Stage units
// ---------------------------------------------------------------------------

describe('date enumeration', () => {
  it('is inclusive and does not lose a day to a timezone', () => {
    expect(eachDate('2026-08-12', '2026-08-15')).toEqual([
      '2026-08-12',
      '2026-08-13',
      '2026-08-14',
      '2026-08-15',
    ]);
    expect(eachDate('2026-08-12', '2026-08-12')).toEqual(['2026-08-12']);
  });

  it('crosses a month and a daylight-saving boundary cleanly', () => {
    expect(eachDate('2026-10-31', '2026-11-02')).toEqual(['2026-10-31', '2026-11-01', '2026-11-02']);
    expect(eachDate('2026-11-01', '2026-10-31')).toEqual([]);
  });
});

describe('daily windows', () => {
  const profile = buildScenario().profile;

  it('gives a normal day the full preferred span', () => {
    const days = buildDailyWindows(
      { ...buildScenario().basics, startDate: '2026-08-12', endDate: '2026-08-15' },
      profile,
      DEFAULT_PLANNER_CONFIG,
    );
    const middle = days[1]!;
    expect(middle.window.startMinute).toBe(7 * 60 + 30);
    expect(middle.window.endMinute).toBe(19 * 60);
    expect(middle.isEdgeDay).toBe(false);
  });

  it('shortens the arrival day and says why', () => {
    const days = buildDailyWindows(
      { ...buildScenario().basics, arrivalTime: '15:00' },
      profile,
      DEFAULT_PLANNER_CONFIG,
    );
    expect(days[0]!.window.startMinute).toBe(16 * 60);
    expect(days[0]!.window.note).toMatch(/15:00/);
    expect(days[0]!.isEdgeDay).toBe(true);
    expect(days[0]!.capacityMinutes).toBeLessThan(days[1]!.capacityMinutes);
  });

  it('shortens the departure day', () => {
    const days = buildDailyWindows(
      { ...buildScenario().basics, departureTime: '11:00' },
      profile,
      DEFAULT_PLANNER_CONFIG,
    );
    const last = days[days.length - 1]!;
    expect(last.window.endMinute).toBe(9 * 60 + 30);
  });

  it('collapses to zero rather than negative hours on an impossible edge day', () => {
    const days = buildDailyWindows(
      { ...buildScenario().basics, arrivalTime: '23:00' },
      profile,
      DEFAULT_PLANNER_CONFIG,
    );
    expect(days[0]!.window.usableMinutes).toBe(0);
    expect(days[0]!.window.endMinute).toBeGreaterThanOrEqual(days[0]!.window.startMinute);
  });

  it('starts earlier for an early riser than a late one', () => {
    const early = buildDailyWindows(buildScenario().basics, profile, DEFAULT_PLANNER_CONFIG);
    const relaxed = buildDailyWindows(
      buildScenario().basics,
      { ...profile, dayStart: 'relaxed' } as TravelerProfile,
      DEFAULT_PLANNER_CONFIG,
    );
    expect(early[1]!.window.startMinute).toBeLessThan(relaxed[1]!.window.startMinute);
  });
});

describe('per-day seasonal availability', () => {
  it('resolves against the actual date, not the trip month set', () => {
    const postpile = placeById('devils-postpile')!;
    expect(isOpenOnDate(postpile, '2026-08-14')).toBe(true);
    expect(isOpenOnDate(postpile, '2026-01-14')).toBe(false);
    // The bug this guards: a trip spanning the closure must not schedule the
    // place on the closed side of it.
    expect(isOpenOnDate(postpile, '2026-11-02')).toBe(false);
  });
});

describe('candidate resolution', () => {
  const input = buildScenario();

  it('ranks a manual include above an auto-pick', () => {
    const scenario = buildScenario({ manualIncludes: ['hot-creek-geologic-site'] });
    const { eligible } = resolveCandidates(
      scenario.candidates,
      scenario.selections,
      scenario.matrix,
    );
    const manual = eligible.find((entry) => entry.place.id === 'hot-creek-geologic-site');
    expect(manual?.manual).toBe(true);
    const auto = eligible.find((entry) => !entry.manual);
    if (auto) expect(manual!.priority).toBeGreaterThan(auto.priority);
  });

  it('ignores skipped places without reporting them as conflicts', () => {
    const scenario = buildScenario({ manualExcludes: ['convict-lake'] });
    const { eligible, rejected } = resolveCandidates(
      scenario.candidates,
      scenario.selections,
      scenario.matrix,
    );
    expect(eligible.some((entry) => entry.place.id === 'convict-lake')).toBe(false);
    expect(rejected.some((entry) => entry.placeId === 'convict-lake')).toBe(false);
  });

  it('rejects an unworkable selection with a reason and a remedy', () => {
    const scenario = buildScenario({
      basics: { startDate: '2027-01-12', endDate: '2027-01-15' },
      manualIncludes: ['devils-postpile'],
    });
    const { rejected } = resolveCandidates(
      scenario.candidates,
      scenario.selections,
      scenario.matrix,
    );
    const entry = rejected.find((item) => item.placeId === 'devils-postpile');
    expect(entry?.reasonCode).toBe('seasonally_closed');
    expect(entry?.wasManual).toBe(true);
    expect(entry?.suggestedRemedy).toBeTruthy();
  });

  it('rejects a place with no travel data rather than assuming it is next door', () => {
    const trimmed = easternSierraTravelMatrix([EASTERN_SIERRA_BASE_ID, 'convict-lake']);
    const { rejected } = resolveCandidates(input.candidates, input.selections, trimmed);
    expect(rejected.some((entry) => entry.reasonCode === 'missing_travel_data')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Validator and reviser, driven directly with hostile input
// ---------------------------------------------------------------------------

describe('validator', () => {
  const scenario = buildScenario();
  const placesById = new Map(scenario.candidates.map((c) => [c.place.id, c.place]));
  const common = {
    unscheduled: [],
    profile: scenario.profile,
    config: resolveConfig(),
    matrix: scenario.matrix,
    placesById,
    baseId: scenario.baseId,
    access: EASTERN_SIERRA_ACCESS,
    hours: EASTERN_SIERRA_HOURS,
    weather: scenario.weather,
    foodPlan: buildFoodPlan({
      days: [],
      profile: scenario.profile,
      food: null,
      dataset: EASTERN_SIERRA_FOOD,
    }),
    hadFoodDataset: true,
  };

  function dayWith(overrides: Partial<ItineraryDay>): ItineraryDay {
    return {
      dayNumber: 1,
      date: '2026-08-12',
      baseId: scenario.baseId,
      baseName: 'Mammoth Lakes',
      theme: 'Test',
      window: { startMinute: 480, endMinute: 1080, usableMinutes: 600 },
      items: [],
      totals: { activityMinutes: 0, travelMinutes: 0, driveMinutes: 0, transitMinutes: 0, walkMinutes: 0, waitMinutes: 0, travelKm: 0, freeMinutes: 0, strenuousCount: 0 },
      transport: {
        primaryMode: 'drive',
        modes: ['drive'],
        serviceIds: [],
        parkingNotes: [],
        accessNotes: [],
        verifyBeforeTravel: [],
      },
      availability: {
        flexiblePlaceIds: [],
        cautions: [],
        verifyBeforeTravel: [],
        bookings: [],
      },
      weather: {
        evidence: 'unavailable',
        summary: 'No weather in this fixture.',
        precipitationProbabilityPercent: null,
        decisions: [],
        cautions: [],
        backups: [],
        provider: 'none',
        attribution: 'Fixture day with no weather attached.',
      },
      food: {
        summary: 'Fixture day with no food attached.',
        slots: [],
        remote: false,
        notes: [],
        reservations: [],
      },
      intensity: 'moderate',
      warnings: [],
      ...overrides,
    };
  }

  it('catches overlapping items', () => {
    const day = dayWith({
      items: [
        { id: 'a', kind: 'activity', title: 'A', startMinute: 500, endMinute: 600, durationMinutes: 100, placeId: 'convict-lake', reason: 'r', weatherSensitive: false },
        { id: 'b', kind: 'activity', title: 'B', startMinute: 550, endMinute: 650, durationMinutes: 100, placeId: 'hot-creek-geologic-site', reason: 'r', weatherSensitive: false },
      ],
    });
    const issues = validateItinerary({ ...common, days: [day] });
    expect(issues.some((issue) => issue.code === 'items_overlap')).toBe(true);
  });

  it('catches an item outside the day window', () => {
    const day = dayWith({
      items: [
        { id: 'a', kind: 'activity', title: 'A', startMinute: 300, endMinute: 400, durationMinutes: 100, placeId: 'convict-lake', reason: 'r', weatherSensitive: false },
      ],
    });
    expect(
      validateItinerary({ ...common, days: [day] }).some((issue) => issue.code === 'item_outside_window'),
    ).toBe(true);
  });

  it('catches inconsistent timestamps', () => {
    const day = dayWith({
      items: [
        { id: 'a', kind: 'activity', title: 'A', startMinute: 500, endMinute: 600, durationMinutes: 999, placeId: 'convict-lake', reason: 'r', weatherSensitive: false },
      ],
    });
    expect(
      validateItinerary({ ...common, days: [day] }).some((issue) => issue.code === 'inconsistent_timestamps'),
    ).toBe(true);
  });

  it('catches a duplicate place across days', () => {
    const item = { id: 'a', kind: 'activity' as const, title: 'A', startMinute: 500, endMinute: 600, durationMinutes: 100, placeId: 'convict-lake', reason: 'r', weatherSensitive: false };
    const issues = validateItinerary({
      ...common,
      days: [dayWith({ items: [item] }), dayWith({ dayNumber: 2, date: '2026-08-13', items: [item] })],
    });
    expect(issues.some((issue) => issue.code === 'duplicate_place')).toBe(true);
  });

  it('catches a place scheduled on a date it is shut', () => {
    const day = dayWith({
      date: '2026-01-12',
      items: [
        { id: 'a', kind: 'activity', title: 'Postpile', startMinute: 500, endMinute: 600, durationMinutes: 100, placeId: 'devils-postpile', reason: 'r', weatherSensitive: false },
      ],
    });
    expect(
      validateItinerary({ ...common, days: [day] }).some((issue) => issue.code === 'place_unavailable'),
    ).toBe(true);
  });

  it('catches excessive driving and excessive intensity', () => {
    const overDriven = dayWith({
      totals: { activityMinutes: 60, travelMinutes: 900, driveMinutes: 900, transitMinutes: 0, walkMinutes: 0, waitMinutes: 0, travelKm: 500, freeMinutes: 0, strenuousCount: 0 },
    });
    expect(
      validateItinerary({ ...common, days: [overDriven] }).some((issue) => issue.code === 'daily_drive_exceeded'),
    ).toBe(true);

    const overWorked = dayWith({
      totals: { activityMinutes: 400, travelMinutes: 60, driveMinutes: 60, transitMinutes: 0, walkMinutes: 0, waitMinutes: 0, travelKm: 40, freeMinutes: 0, strenuousCount: 3 },
    });
    expect(
      validateItinerary({ ...common, days: [overWorked] }).some((issue) => issue.code === 'intensity_exceeded'),
    ).toBe(true);
  });

  it('warns about a long day with nothing to eat', () => {
    const day = dayWith({
      totals: { activityMinutes: 300, travelMinutes: 30, driveMinutes: 30, transitMinutes: 0, walkMinutes: 0, waitMinutes: 0, travelKm: 20, freeMinutes: 0, strenuousCount: 0 },
      items: [
        { id: 'a', kind: 'activity', title: 'A', startMinute: 500, endMinute: 800, durationMinutes: 300, placeId: 'convict-lake', reason: 'r', weatherSensitive: false },
      ],
    });
    expect(
      validateItinerary({ ...common, days: [day] }).some((issue) => issue.code === 'missing_meal_break'),
    ).toBe(true);
  });

  it('raises a hard error when a hand-picked place went unscheduled', () => {
    const issues = validateItinerary({
      ...common,
      days: [dayWith({})],
      unscheduled: [
        {
          placeId: 'bodie-state-historic-park',
          name: 'Bodie',
          wasManual: true,
          reasonCode: 'no_time_left',
          reason: 'No room.',
        },
      ],
    });
    const issue = issues.find((entry) => entry.code === 'must_include_unscheduled');
    expect(issue?.severity).toBe('error');
  });
});

describe('reviser', () => {
  const scenario = buildScenario();
  const days = buildDailyWindows(scenario.basics, scenario.profile, resolveConfig());
  const { eligible } = resolveCandidates(scenario.candidates, scenario.selections, scenario.matrix);

  it('drops the lowest-priority stop from an offending day', () => {
    const dayPlans = [{ day: days[1]!, accepted: eligible.slice(0, 3) }];
    const outcome = reviseDayPlans(dayPlans, [
      { code: 'daily_travel_exceeded', severity: 'error', message: 'too far', dayNumber: 2 },
    ]);
    expect(outcome.changed).toBe(true);
    expect(outcome.dayPlans[0]!.accepted).toHaveLength(2);
    expect(outcome.actions[0]?.code).toBe('dropped_lowest_priority');
  });

  it('sacrifices an auto-pick before a hand-picked place', () => {
    const manual = { ...eligible[0]!, manual: true, priority: 10_000 };
    const auto = { ...eligible[1]!, manual: false, priority: 5_000 };
    const outcome = reviseDayPlans([{ day: days[1]!, accepted: [manual, auto] }], [
      { code: 'daily_travel_exceeded', severity: 'error', message: 'too far', dayNumber: 2 },
    ]);
    expect(outcome.dayPlans[0]!.accepted.map((entry) => entry.place.id)).toEqual([
      manual.place.id,
    ]);
  });

  it('when only hand-picked places remain, removing one is recorded as a conflict', () => {
    // The constraint must not be violated, so something has to give — but it comes
    // back flagged as manual, which the validator turns into a hard error the
    // traveller has to resolve rather than a silent omission.
    const manual = eligible.slice(0, 2).map((candidate) => ({ ...candidate, manual: true }));
    const outcome = reviseDayPlans([{ day: days[1]!, accepted: manual }], [
      { code: 'daily_travel_exceeded', severity: 'error', message: 'too far', dayNumber: 2 },
    ]);
    expect(outcome.removed).toHaveLength(1);
    expect(outcome.removed[0]!.candidate.manual).toBe(true);
  });

  it('reports an unschedulable must-include as unresolved rather than fixing it away', () => {
    const outcome = reviseDayPlans([{ day: days[1]!, accepted: [] }], [
      { code: 'must_include_unscheduled', severity: 'error', message: 'nope', placeId: 'bodie-state-historic-park' },
    ]);
    expect(outcome.actions[0]?.code).toBe('left_unresolved');
    expect(outcome.changed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Golden scenarios
// ---------------------------------------------------------------------------

describe('scenario 1 — the standard four-day Mammoth trip', () => {
  const itinerary = plan();

  it('produces four dated days in order', () => {
    expect(itinerary.days.map((day) => day.date)).toEqual([
      '2026-08-12',
      '2026-08-13',
      '2026-08-14',
      '2026-08-15',
    ]);
    expect(itinerary.days.map((day) => day.dayNumber)).toEqual([1, 2, 3, 4]);
  });

  it('schedules real stops with no hard violations', () => {
    expect(allActivities(itinerary).length).toBeGreaterThanOrEqual(5);
    expect(errors(itinerary)).toEqual([]);
    expect(itinerary.status).not.toBe('needs_decision');
  });

  it('never overlaps items and keeps every item inside its day', () => {
    for (const day of itinerary.days) {
      const sorted = [...day.items].sort((a, b) => a.startMinute - b.startMinute);
      for (let index = 0; index + 1 < sorted.length; index += 1) {
        expect(sorted[index + 1]!.startMinute).toBeGreaterThanOrEqual(sorted[index]!.endMinute);
      }
      // The last meal of the day, and the leg home from it, are allowed to run
      // a little past the window — the window bounds what gets scheduled, and
      // an evening meal is the one thing a traveller carries on past it.
      const lastMeal = day.items.filter((item) => item.kind === 'meal').at(-1)?.startMinute;
      for (const item of day.items) {
        expect(item.startMinute).toBeGreaterThanOrEqual(day.window.startMinute);
        const ceiling =
          lastMeal !== undefined && item.startMinute >= lastMeal
            ? day.window.endMinute + DEFAULT_PLANNER_CONFIG.mealOverrunAllowanceMinutes
            : day.window.endMinute;
        expect(item.endMinute).toBeLessThanOrEqual(ceiling);
      }
    }
  });

  it('starts and ends every active day at the base', () => {
    for (const day of itinerary.days) {
      const travels = day.items.filter((item) => item.travel);
      if (travels.length === 0) continue;
      expect(travels[0]!.travel!.fromId).toBe(itinerary.baseId);
      expect(travels[travels.length - 1]!.travel!.toId).toBe(itinerary.baseId);
    }
  });

  it('gives geographically coherent days rather than scattering nearby stops', () => {
    // Mono Basin and the Mammoth-side stops must not be mixed into one day.
    const dayOf = (placeId: string) =>
      itinerary.days.find((day) => activities(day).includes(placeId))?.dayNumber;
    const mono = dayOf('mono-lake-south-tufa');
    const june = dayOf('june-lake-loop');
    if (mono && june) expect(mono).toBe(june);
  });

  it('visits no place twice', () => {
    const visited = allActivities(itinerary);
    expect(new Set(visited).size).toBe(visited.length);
  });

  it('leaves visible slack and feeds the traveller on full days', () => {
    const fullDays = itinerary.days.filter(
      (day, index) =>
        index > 0 &&
        index < itinerary.days.length - 1 &&
        day.totals.activityMinutes > 0,
    );
    expect(fullDays.length).toBeGreaterThan(0);
    for (const day of fullDays) {
      expect(day.totals.freeMinutes).toBeGreaterThan(0);
      expect(day.items.some((item) => item.kind === 'meal')).toBe(true);
    }
  });

  it('records travel provenance so a model is never shown as measured', () => {
    expect(itinerary.diagnostics.matrixProvenance).toBe('modelled');
    for (const day of itinerary.days) {
      for (const item of day.items) {
        if (item.travel) expect(item.travel.provenance).toBe('modelled');
      }
    }
  });

  it('keeps the Reds Meadow corridor on a single day', () => {
    const corridor = ['minaret-vista', 'devils-postpile', 'rainbow-falls'];
    const daysUsed = new Set(
      itinerary.days
        .filter((day) => activities(day).some((id) => corridor.includes(id)))
        .map((day) => day.dayNumber),
    );
    expect(daysUsed.size).toBeLessThanOrEqual(1);
  });
});

describe('scenario 2 — late arrival and early departure', () => {
  const itinerary = plan({ basics: { arrivalTime: '19:00', departureTime: '09:00' } });

  it('leaves the edge days empty or nearly so and concentrates the trip in the middle', () => {
    const first = itinerary.days[0]!;
    const last = itinerary.days[itinerary.days.length - 1]!;
    expect(first.totals.activityMinutes).toBe(0);
    expect(last.totals.activityMinutes).toBe(0);

    const middle = itinerary.days.slice(1, -1);
    expect(middle.reduce((sum, day) => sum + day.totals.activityMinutes, 0)).toBeGreaterThan(0);
  });

  it('never schedules anything before the traveller has arrived', () => {
    const first = itinerary.days[0]!;
    for (const item of first.items) {
      expect(item.startMinute).toBeGreaterThanOrEqual(19 * 60 + 60);
    }
  });

  it('finishes the last day before the departure lead time', () => {
    const last = itinerary.days[itinerary.days.length - 1]!;
    expect(last.window.endMinute).toBeLessThanOrEqual(9 * 60 - 90 + 1);
  });
});

describe('scenario 3 — a low-intensity traveller', () => {
  const itinerary = plan({
    answers: { dailyIntensity: 'light', avoidances: ['strenuous_activity'] },
  });

  it('schedules nothing strenuous', () => {
    for (const day of itinerary.days) {
      expect(day.totals.strenuousCount).toBe(0);
      for (const item of day.items) {
        expect(item.physicalIntensity).not.toBe('strenuous');
      }
    }
  });

  it('still produces a real trip from gentler options', () => {
    expect(allActivities(itinerary).length).toBeGreaterThan(0);
    expect(errors(itinerary)).toEqual([]);
  });

  it('prefers the effort level asked for over the maximum tolerable', () => {
    const scheduled = allActivities(itinerary).map((id) => placeById(id)!);
    expect(scheduled.every((place) => place.physicalIntensity !== 'strenuous')).toBe(true);
  });
});

describe('scenario 4 — a strict driving limit', () => {
  const limit = 60;
  const itinerary = plan({ answers: { maxDailyTravelMinutes: limit } });

  it('keeps every day inside the hard driving budget', () => {
    for (const day of itinerary.days) {
      // The limit is on *driving*. Riding a shuttle and walking to the stop are
      // real minutes, but they are not the thing the traveller capped.
      expect(day.totals.driveMinutes).toBeLessThanOrEqual(limit);
    }
    expect(errors(itinerary).filter((issue) => issue.code === 'daily_drive_exceeded')).toEqual([]);
  });

  it('does not pretend a distant satellite is nearby', () => {
    const scheduled = allActivities(itinerary);
    expect(scheduled).not.toContain('bodie-state-historic-park');
    expect(scheduled).not.toContain('mono-lake-south-tufa');
  });
});

describe('scenario 5 — a seasonally unavailable manual include', () => {
  const itinerary = plan({
    basics: { startDate: '2027-04-10', endDate: '2027-04-13' },
    manualIncludes: ['devils-postpile'],
  });

  it('does not schedule it', () => {
    expect(allActivities(itinerary)).not.toContain('devils-postpile');
  });

  it('surfaces the conflict specifically rather than silently overriding the traveller', () => {
    const entry = itinerary.unscheduled.find((item) => item.placeId === 'devils-postpile');
    expect(entry).toBeDefined();
    expect(entry?.wasManual).toBe(true);
    expect(entry?.reasonCode).toBe('seasonally_closed');
    expect(entry?.reason.length).toBeGreaterThan(10);

    const issue = itinerary.issues.find((item) => item.code === 'must_include_unscheduled');
    expect(issue?.severity).toBe('error');
    expect(itinerary.status).toBe('needs_decision');
  });

  it('leaves the rest of the plan valid', () => {
    const otherErrors = errors(itinerary).filter(
      (issue) => issue.code !== 'must_include_unscheduled',
    );
    expect(otherErrors).toEqual([]);
  });
});

describe('scenario 6 — more selected places than a trip can hold', () => {
  const everything = [
    'convict-lake',
    'mono-lake-south-tufa',
    'june-lake-loop',
    'minaret-vista',
    'devils-postpile',
    'rainbow-falls',
    'mcgee-creek-canyon',
    'little-lakes-valley',
    'sherwin-lakes-trail',
    'hot-creek-geologic-site',
    'obsidian-dome',
    'inyo-craters',
    'earthquake-fault',
    'bishop-town',
    'wild-willys-hot-spring',
    'panorama-gondola',
    'mammoth-lakes-basin',
  ];
  const itinerary = plan({ manualIncludes: everything });

  it('schedules the highest-priority feasible places and explains the rest', () => {
    expect(allActivities(itinerary).length).toBeGreaterThan(4);
    expect(itinerary.unscheduled.length).toBeGreaterThan(0);
    for (const entry of itinerary.unscheduled) {
      expect(entry.reason.length).toBeGreaterThan(10);
      expect(entry.reasonCode).toBeTruthy();
    }
  });

  it('does not overpack a day to force everything in', () => {
    for (const day of itinerary.days) {
      const load = day.totals.activityMinutes + day.totals.travelMinutes;
      expect(load).toBeLessThanOrEqual(day.window.usableMinutes);
      expect(day.totals.travelMinutes).toBeLessThanOrEqual(150);
    }
  });

  it('accounts for every selected place exactly once', () => {
    const scheduled = new Set(allActivities(itinerary));
    const unscheduled = new Set(itinerary.unscheduled.map((entry) => entry.placeId));
    for (const placeId of everything) {
      expect(scheduled.has(placeId) || unscheduled.has(placeId)).toBe(true);
    }
    for (const placeId of scheduled) expect(unscheduled.has(placeId)).toBe(false);
  });
});

describe('scenario 7 — too few viable activities', () => {
  const itinerary = plan({
    selections: [
      { placeId: 'convict-lake', status: 'included', source: 'user', updatedAt: '2026-07-30T00:00:00.000Z' },
    ],
  });

  it('schedules what there is without padding or repeating', () => {
    const scheduled = allActivities(itinerary);
    expect(scheduled).toEqual(['convict-lake']);
    expect(new Set(scheduled).size).toBe(scheduled.length);
  });

  it('returns legitimate free time rather than inventing filler', () => {
    const totalFree = itinerary.days.reduce((sum, day) => sum + day.totals.freeMinutes, 0);
    expect(totalFree).toBeGreaterThan(4 * 60);
    expect(itinerary.diagnostics.capacity.freeMinutes).toBe(totalFree);
  });

  it('reports the spare capacity in diagnostics', () => {
    expect(itinerary.diagnostics.capacity.usableMinutes).toBeGreaterThan(
      itinerary.diagnostics.capacity.activityMinutes,
    );
    expect(itinerary.diagnostics.counts.scheduled).toBe(1);
  });
});

describe('scenario 8 — determinism', () => {
  it('produces a byte-identical structure from identical inputs', () => {
    const a = plan();
    const b = plan();
    expect(itineraryStructureFingerprint(a)).toBe(itineraryStructureFingerprint(b));
    expect(JSON.stringify(a.days)).toBe(JSON.stringify(b.days));
    expect(JSON.stringify(a.unscheduled)).toBe(JSON.stringify(b.unscheduled));
  });

  it('is insensitive to the order selections arrive in', () => {
    const forwards = buildScenario();
    const backwards: PlannerInput = {
      ...forwards,
      selections: [...forwards.selections].reverse(),
      candidates: [...forwards.candidates].reverse(),
    };
    const a = planTrip(forwards);
    const b = planTrip(backwards);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(itineraryStructureFingerprint(a.itinerary)).toBe(
        itineraryStructureFingerprint(b.itinerary),
      );
    }
  });

  it('gives the fingerprint the structure a narration layer must not change', () => {
    const itinerary = plan();
    const fingerprint = itineraryStructureFingerprint(itinerary);
    // Prose is deliberately outside the fingerprint; times and places are inside.
    const narrated: Itinerary = {
      ...itinerary,
      summary: 'A completely different summary written by a language model.',
      days: itinerary.days.map((day) => ({ ...day, theme: 'Rewritten theme' })),
    };
    expect(itineraryStructureFingerprint(narrated)).toBe(fingerprint);

    const tampered: Itinerary = {
      ...itinerary,
      days: itinerary.days.map((day, index) =>
        index === 0 ? { ...day, items: day.items.slice(1) } : day,
      ),
    };
    expect(itineraryStructureFingerprint(tampered)).not.toBe(fingerprint);
  });
});

describe('input safety', () => {
  it('never mutates the inputs it was given', () => {
    const input = buildScenario();
    const before = JSON.stringify({
      selections: input.selections,
      matrix: input.matrix,
      profile: input.profile,
      basics: input.basics,
      candidateIds: input.candidates.map((candidate) => candidate.place.id),
    });
    planTrip(input);
    const after = JSON.stringify({
      selections: input.selections,
      matrix: input.matrix,
      profile: input.profile,
      basics: input.basics,
      candidateIds: input.candidates.map((candidate) => candidate.place.id),
    });
    expect(after).toBe(before);
  });

  it('leaves the canonical place records untouched', () => {
    const input = buildScenario();
    const snapshot = JSON.stringify(input.candidates.map((candidate) => candidate.place));
    planTrip(input);
    expect(JSON.stringify(input.candidates.map((candidate) => candidate.place))).toBe(snapshot);
  });

  it('plans the same trip twice from one input object', () => {
    const input = buildScenario();
    const first = planTrip(input);
    const second = planTrip(input);
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(itineraryStructureFingerprint(first.itinerary)).toBe(
        itineraryStructureFingerprint(second.itinerary),
      );
    }
  });
});

describe('planner failure modes', () => {
  it('refuses an unusable travel-time matrix instead of guessing', () => {
    const scenario = buildScenario();
    const broken = { ...scenario.matrix, minutes: [[0, 1]], km: [[0, 1]] };
    const result = planTrip({ ...scenario, matrix: broken });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('matrix_unusable');
  });

  it('reports having nothing to plan rather than returning an empty itinerary', () => {
    const result = planTrip({ ...buildScenario(), selections: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('no_candidates');
  });

  it('still plans when every selection is impossible, and says so', () => {
    const result = planTrip(
      buildScenario({
        basics: { startDate: '2027-01-12', endDate: '2027-01-15' },
        selections: [
          { placeId: 'devils-postpile', status: 'included', source: 'user', updatedAt: '2026-07-30T00:00:00.000Z' },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.itinerary.unscheduled).toHaveLength(1);
      expect(result.itinerary.status).toBe('needs_decision');
      expect(result.itinerary.days).toHaveLength(4);
    }
  });
});
