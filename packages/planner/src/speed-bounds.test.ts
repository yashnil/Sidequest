import { describe, expect, it } from 'vitest';
import { EASTERN_SIERRA_ACCESS, EASTERN_SIERRA_PLACES } from '@sidequest/core/data';
import {
  buildTravelerProfile,
  defaultAnswers,
  type ItineraryDay,
  type TravelSegment,
} from '@sidequest/core';
import type { TravelTimeMatrix } from '@sidequest/geo';
import { planTrip } from './plan';
import { resolveAccess } from './access';
import { travelKnowledgeFor } from './travel';
import { impossibleSpeedIssues } from './validate';
import { buildScenario } from './testing/scenario';

/**
 * PR-PLAN-09: NO ITINERARY STATES IMPOSSIBLE TRANSPORT AS FACT.
 *
 * The stored Tokyo plan scheduled ten-minute "walks" to places its own pack
 * records as 16.4 road-km away — a legacy authored constant, printed with the
 * confidence of a measurement, ten times over. The validator now does the
 * arithmetic the reader cannot: distance over minutes, against what the mode
 * can physically do. Violations are refusals, which is what guards a Rebuild
 * against a pack still carrying the poisoned constants.
 */

function roadMatrix(km: number): TravelTimeMatrix {
  return {
    mode: 'car',
    ids: ['base', 'place-far'],
    minutes: [
      [0, 20],
      [20, 0],
    ],
    km: [
      [0, km],
      [km, 0],
    ],
    provenance: { kind: 'measured', note: 'Test road network.' },
  };
}

function dayWith(travel: Partial<TravelSegment> & Pick<TravelSegment, 'mode' | 'minutes'>): ItineraryDay {
  const segment: TravelSegment = {
    fromId: 'base',
    toId: 'place-far',
    fromName: 'Base',
    toName: 'Far Place',
    km: null,
    role: 'approach',
    provenance: 'estimated',
    ...travel,
  } as TravelSegment;
  return {
    dayNumber: 1,
    items: [
      {
        id: 'travel-1-0',
        kind: 'travel',
        title: 'Walk to Far Place',
        startMinute: 540,
        endMinute: 540 + (segment.minutes ?? 0),
        durationMinutes: segment.minutes ?? 0,
        reason: 'fixture',
        weatherSensitive: false,
        travel: segment,
      },
    ],
  } as unknown as ItineraryDay;
}

describe('the speed a leg implies against what its mode can do', () => {
  it('refuses the poisoned-pack shape: a 10-minute walk over 16.4 road-km', () => {
    const issues = impossibleSpeedIssues(dayWith({ mode: 'walk', minutes: 10 }), roadMatrix(16.4));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.code).toBe('travel_leg_speed_impossible');
    expect(issues[0]!.severity).toBe('error');
    expect(issues[0]!.message).toContain('16.4 km');
    expect(issues[0]!.message).toContain('on foot');
  });

  it('refuses a zero-minute leg over real distance — a zero hides better than a ten', () => {
    const issues = impossibleSpeedIssues(dayWith({ mode: 'walk', minutes: 0 }), roadMatrix(16.4));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.code).toBe('travel_leg_speed_impossible');
  });

  it('accepts an honest walk, an honest drive, and does not bound scheduled vehicles', () => {
    /* 1.2 km in 16 min is 4.5 km/h — a person. */
    expect(
      impossibleSpeedIssues(dayWith({ mode: 'walk', minutes: 16, km: 1.2 }), roadMatrix(1.2)),
    ).toHaveLength(0);
    /* 80 km in 60 min is 80 km/h — a road. */
    expect(
      impossibleSpeedIssues(dayWith({ mode: 'drive', minutes: 60, km: 80 }), roadMatrix(80)),
    ).toHaveLength(0);
    /* 40 km in 10 min is 240 km/h — not a car. */
    expect(
      impossibleSpeedIssues(dayWith({ mode: 'drive', minutes: 10, km: 40 }), roadMatrix(40)),
    ).toHaveLength(1);
    /* A rail leg carries no ceiling: a bullet train outruns every bound here. */
    expect(
      impossibleSpeedIssues(dayWith({ mode: 'rail', minutes: 10, km: 40 }), roadMatrix(40)),
    ).toHaveLength(0);
  });

  it('leaves sub-half-kilometre legs alone, where rounding noise dominates', () => {
    expect(
      impossibleSpeedIssues(dayWith({ mode: 'walk', minutes: 1, km: 0.3 }), roadMatrix(0.3)),
    ).toHaveLength(0);
  });

  it('never lets a plan through the whole pipeline with an impossible leg', () => {
    /**
     * The end-to-end poison path: an access dataset whose every rule states a
     * ten-minute walking allowance — the live provider's old constant — against
     * the road matrix, for a traveller with no car. Whatever the planner
     * produces, no leg on it may state a speed its mode cannot do.
     */
    const poisoned = {
      ...EASTERN_SIERRA_ACCESS,
      rules: EASTERN_SIERRA_ACCESS.rules.map((rule) => ({
        ...rule,
        approachMode: 'walk' as const,
        approachMinutes: 10,
        walkMinutesFromDropOff: 0,
        serviceRequirement: 'none' as const,
      })),
      services: [],
    };
    const scenario = buildScenario({ answers: { willDrive: false }, access: poisoned });
    const result = planTrip(scenario);

    if (!result.ok) return; // A refusal is the other honest outcome.
    for (const day of result.itinerary.days) {
      expect(impossibleSpeedIssues(day, scenario.matrix)).toHaveLength(0);
    }
  });

  it('does not convict an honest walk on a road distance for the same two points', () => {
    /**
     * THE LEG THAT WAS BEING WRONGLY CONVICTED.
     *
     * A car-free trip is planned against a road matrix, so the fallback distance
     * for an approach leg is a *driving* distance and the leg is a walk. An
     * authored "20 minutes on foot" to somewhere the road loops 3 km around is a
     * perfectly ordinary 1.2 km stroll, and the raw comparison called it 9 km/h
     * and impossible. Two figures from two networks were being held against each
     * other as if they were one measurement.
     */
    expect(
      impossibleSpeedIssues(dayWith({ mode: 'walk', minutes: 20 }), roadMatrix(3)),
    ).toHaveLength(0);

    /*
     * And the class it exists for still convicts: no footpath between two points
     * is half a 16.4 km road, so ten minutes is impossible however generously
     * the road figure is discounted.
     */
    const poisoned = impossibleSpeedIssues(dayWith({ mode: 'walk', minutes: 10 }), roadMatrix(16.4));
    expect(poisoned).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------

describe('an authored travel allowance, checked before anything is scheduled on it', () => {
  /**
   * THE TOKYO 10-MINUTE WALK, CAUGHT WHERE IT ENTERS RATHER THAN WHERE IT LANDS.
   *
   * `buildOption` took `rule.approachMinutes` verbatim whenever the matrix could
   * not measure the rule's mode and nothing else could either. Nothing compared
   * that allowance against the distance the matrix already holds for the very
   * same pair — so a pack asserting "walk, 10 min" to a place measured at 74.7
   * road-km was accepted, scheduled, and only convicted at the end of the
   * pipeline by `travel_leg_speed_impossible`, by which point the revision loop
   * had stripped every stop off the day trying to repair it.
   */
  const PLACE = EASTERN_SIERRA_PLACES[0]!;

  function roadMatrixTo(km: number, minutes: number): TravelTimeMatrix {
    return {
      mode: 'car',
      ids: ['base', PLACE.id],
      minutes: [
        [0, minutes],
        [minutes, 0],
      ],
      km: [
        [0, km],
        [km, 0],
      ],
      provenance: { kind: 'measured', note: 'Test road network.' },
    };
  }

  function walkRuleDataset(approachMinutes: number) {
    return {
      version: 1,
      regionId: 'test-region',
      points: [],
      services: [],
      rules: [
        {
          id: 'rule-walk',
          label: 'On foot',
          placeIds: [PLACE.id],
          months: [8],
          approachMode: 'walk' as const,
          /* An authored constant. Nothing measured it; the pack simply says so. */
          approachMinutes,
          privateVehicle: 'allowed',
          serviceRequirement: 'none',
          walkMinutesFromDropOff: 0,
          internalTransfer: { mode: 'walk' as const, minutes: 0 },
          permitRequired: false,
          notes: [],
          provenance: {
            kind: 'authored' as const,
            sourceName: 'fixture',
            confidence: 1,
            volatility: 'stable' as const,
          },
        },
      ],
    } as unknown as Parameters<typeof resolveAccess>[0]['dataset'];
  }

  const units = () =>
    [
      {
        key: 'unit-1',
        gatewayRoutingId: PLACE.id,
        gatewayName: PLACE.name,
        members: [
          {
            place: PLACE,
            priority: 1,
            manual: false,
            selectionStatus: 'included',
            fitScore: 0.8,
            matchedInterests: [],
            durationMinutes: 60,
            travelMinutesFromBase: 80,
            travelModeFromBase: 'drive',
          },
        ],
      },
    ] as unknown as Parameters<typeof resolveAccess>[0]['units'];

  const DRIVER = buildTravelerProfile(defaultAnswers({ travelerNeeds: [], tripDays: 3 }), {
    travelerNeeds: [],
    tripDays: 3,
  });

  function resolve(km: number, approachMinutes: number) {
    const matrix = roadMatrixTo(km, 80);
    return [
      ...resolveAccess({
        units: units(),
        dates: ['2026-08-12'],
        dataset: walkRuleDataset(approachMinutes),
        profile: DRIVER,
        matrix,
        travel: { knowledge: travelKnowledgeFor(matrix, DRIVER, null), baseId: 'base' },
      }).values(),
    ][0]!;
  }

  it('refuses the unit, by name and by distance, rather than scheduling the claim', () => {
    const entry = resolve(74.7, 10);
    expect(entry.available, 'a 10-minute walk over 74.7 km was accepted').toBe(false);
    if (entry.available) return;
    expect(entry.blockers[0]!.code).toBe('walk_too_long');
    /* The sentence has to carry the distance, or it is not a fact anyone can weigh. */
    expect(entry.blockers[0]!.message).toContain('74.7 km');
    expect(entry.blockers[0]!.message).toContain(PLACE.name);
  });

  it('leaves an allowance the distance supports exactly where it was', () => {
    /*
     * 5 km of road is at worst 2.5 km on foot, and 40 minutes covers that at
     * under 4 km/h. The check must not touch it — refusing an allowance the
     * evidence supports would cost stops for no reason at all, which is the
     * failure mode a validator this blunt has to be tested against.
     */
    const entry = resolve(5, 40);
    expect(entry.available, 'a supportable 40-minute walk was refused').toBe(true);
    if (!entry.available) return;
    expect(entry.option.approachMinutes).toBe(40);
  });
});
