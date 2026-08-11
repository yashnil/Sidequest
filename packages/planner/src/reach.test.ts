import { describe, expect, it } from 'vitest';
import {
  buildTravelerProfile,
  defaultAnswers,
  type DiscoveryCandidate,
  type DiscoverySelection,
  type Place,
  type TransitEvidence,
  type TravelerProfile,
} from '@sidequest/core';
import { EASTERN_SIERRA_PLACES } from '@sidequest/core/data';
import type { TravelTimeMatrix } from '@sidequest/geo';
import { resolveCandidates } from './candidates';
import { chooseBackups, type BackupCandidate } from './backups';
import { resolveAccess } from './access';
import { assessMustDoFeasibility } from './feasibility';
import { travelKnowledgeFor } from './travel';
import type { PlanningCandidate } from './types';

/**
 * THE READERS BETWEEN THE BOARD AND THE SCHEDULER.
 *
 * `travel.test.ts` proves `reachFromBase` answers correctly. This proves the
 * things that *consume* it do — because the defect was never in the arithmetic,
 * it was that three separate readers took a figure named `driveMinutesFromBase`,
 * which holds whatever mode the single matrix measured, and treated it as time
 * at the wheel.
 *
 * On a car-free trip that meant: an arrival bound pushed most of an hour into
 * the day by a walk the traveller would never take, a refusal comparing that
 * walk against `maxDailyDriveMinutes` — zero, for somebody with no car — and a
 * weather-backup ceiling of that same zero, which silently meant no car-free
 * trip has ever been offered a backup at all.
 */

const PLACE = EASTERN_SIERRA_PLACES[0]!;
const OTHER = EASTERN_SIERRA_PLACES[1]!;

function profileWith(overrides: Partial<TravelerProfile['transport']>): TravelerProfile {
  const base = buildTravelerProfile(defaultAnswers({ travelerNeeds: [], tripDays: 3 }), {
    travelerNeeds: [],
    tripDays: 3,
  });
  return { ...base, transport: { ...base.transport, ...overrides } };
}

const CAR_FREE = profileWith({
  willDrive: false,
  maxDailyDriveMinutes: 0,
  maxDailyTransportMinutes: 180,
  maxAccessWalkMinutes: 15,
});

/** A pedestrian matrix on which this place is an hour and a half away on foot. */
function footMatrix(): TravelTimeMatrix {
  return {
    mode: 'foot',
    ids: ['base', PLACE.id],
    minutes: [
      [0, 88],
      [88, 0],
    ],
    km: [
      [0, 6.5],
      [6.5, 0],
    ],
    provenance: { kind: 'measured', note: 'Measured on the pedestrian network.' },
  };
}

function transit(minutes: number): TransitEvidence {
  const leg = (fromId: string, toId: string) => ({
    fromId,
    toId,
    status: 'measured' as const,
    minutes,
    transfers: 0,
    walkingMinutes: 5,
    legs: [
      { mode: 'walk' as const, minutes: 3 },
      { mode: 'subway' as const, minutes: minutes - 5 },
      { mode: 'walk' as const, minutes: 2 },
    ],
    requestBasis: {
      kind: 'depart_at' as const,
      instant: '2026-08-12T08:30:00.000Z',
      timeZone: 'America/Los_Angeles',
    },
    source: 'test-transit',
    retrievedAt: '2026-08-01T00:00:00.000Z',
    detail: 'Measured against published timetables.',
  });
  return {
    journeys: [leg('base', PLACE.id), leg(PLACE.id, 'base')],
    provider: 'test-transit',
    requested: 2,
    measured: 2,
  };
}

function candidateFor(place: Place, driveMinutes: number): DiscoveryCandidate {
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
    detourClass: 'nearby',
    driveMinutes,
    distanceKm: 6.5,
    season: { band: 'open', note: 'fixture', months: [8] },
    access: { requiredModes: [], cautions: [], available: true, summary: 'fixture' },
    operating: { status: 'open', note: 'fixture' },
  } as unknown as DiscoveryCandidate;
}

const INCLUDED: DiscoverySelection[] = [
  { placeId: PLACE.id, status: 'included', source: 'auto', updatedAt: '2026-08-01T00:00:00.000Z' },
];

describe('what the planner is told a place costs to reach', () => {
  it('takes the measured journey, not the walking figure the matrix carried', () => {
    const knowledge = travelKnowledgeFor(footMatrix(), CAR_FREE, transit(21));
    const { eligible } = resolveCandidates(
      [candidateFor(PLACE, 88)],
      INCLUDED,
      footMatrix(),
      { knowledge, baseId: 'base' },
    );

    expect(eligible).toHaveLength(1);
    const resolved = eligible[0]!;
    /*
     * Twenty-one, off the journey measured for this exact pair — not the
     * eighty-eight the pedestrian matrix holds and not the number the board
     * handed over under the name `driveMinutes`.
     */
    expect(resolved.travelMinutesFromBase).toBe(21);
    expect(resolved.travelMinutesFromBase).not.toBe(88);
    expect(resolved.travelModeFromBase).toBe('rail');
  });

  it('falls back to the walk when no journey was bought for the pair', () => {
    const knowledge = travelKnowledgeFor(footMatrix(), CAR_FREE, {
      journeys: [],
      requested: 0,
      measured: 0,
    });
    const { eligible } = resolveCandidates(
      [candidateFor(PLACE, 88)],
      INCLUDED,
      footMatrix(),
      { knowledge, baseId: 'base' },
    );

    expect(eligible[0]!.travelMinutesFromBase).toBe(88);
    expect(eligible[0]!.travelModeFromBase).toBe('walk');
  });

  it('never hands a car-free traveller a figure off a road matrix', () => {
    const road: TravelTimeMatrix = { ...footMatrix(), mode: 'car' };
    const knowledge = travelKnowledgeFor(road, CAR_FREE, null);
    const { eligible } = resolveCandidates([candidateFor(PLACE, 88)], INCLUDED, road, {
      knowledge,
      baseId: 'base',
    });

    /*
     * The figure survives — a bound that is too *late* delays nothing anybody
     * can act on — but the mode does not, because naming it `drive` is what
     * would charge it to a wheel budget this traveller does not have.
     */
    expect(eligible[0]!.travelModeFromBase).toBe('unsupported');
    expect(eligible[0]!.travelModeFromBase).not.toBe('drive');
  });
});

// ---------------------------------------------------------------------------

function backupCandidate(place: Place, minutes: number, mode: 'walk' | 'drive'): BackupCandidate {
  return {
    /*
     * Indoors and explicitly a poor-weather option, which is what makes it a
     * *backup* at all. `isLessExposed` reads the place's own weather profile,
     * and offering a rain-exposed alternative to somebody rained off is offering
     * them the same afternoon somewhere else.
     */
    place: {
      ...place,
      /*
       * Indoors and explicitly a wet-weather option, which is what makes it a
       * *backup* at all. `isLessExposed` reads the place's own profile, and
       * offering a rain-exposed alternative to somebody rained off is offering
       * them the same afternoon somewhere else.
       */
      weather: {
        ...place.weather,
        exposure: 'indoor',
        precipitation: 'low',
        wind: 'low',
        cold: 'low',
        heat: 'low',
        visibilityDependent: false,
        approachDegradesWhenWet: false,
        /*
         * Absent, not false: this is the one weather fact that may take a place
         * off a plan, so it is unrepresentable without naming a source.
         */
        dryConditionsRequired: undefined,
        poorWeatherBackup: true,
      },
    },
    travelMinutesFromBase: minutes,
    travelModeFromBase: mode,
    selectionStatus: undefined,
    reachable: true,
    hours: {
      placeId: place.id,
      date: '2026-08-12',
      status: 'always_open',
      windows: [],
      periodLabel: null,
      closedReason: null,
      admission: { kind: 'none' },
      daylightOnly: false,
      requiresVerification: false,
    } as unknown as BackupCandidate['hours'],
    weather: {
      placeId: place.id,
      date: '2026-08-12',
      locationId: 'point',
      locationLabel: 'point',
      locationLimitation: 'fixture',
      assessment: {
        score: 0.9,
        band: 'good',
        suitability: 'good',
        summary: 'fixture',
        rankable: true,
        evidence: 'forecast',
        reasons: [],
        conditions: [],
        notes: [],
      },
      evidence: {},
      solar: undefined,
      profile: { sensitivity: 'indoor', exposure: 'sheltered' },
    } as unknown as BackupCandidate['weather'],
  };
}

/** One stop on the day, rained off, so `chooseBackups` has something to replace. */
function rainedOff(): { candidate: PlanningCandidate; weather: BackupCandidate['weather'] }[] {
  return [
    {
      candidate: {
        place: OTHER,
        priority: 1,
        manual: false,
        selectionStatus: 'included',
        fitScore: 0.5,
        matchedInterests: [],
        durationMinutes: 90,
        travelMinutesFromBase: 30,
        travelModeFromBase: 'walk',
      },
      weather: {
        ...backupCandidate(OTHER, 30, 'walk').weather!,
        assessment: {
          ...backupCandidate(OTHER, 30, 'walk').weather!.assessment,
          score: 0.1,
          reasons: [
            { code: 'heavy_precipitation', weight: -0.6, detail: 'Rain most of the day.' },
          ],
        },
      } as unknown as BackupCandidate['weather'],
    },
  ] as unknown as { candidate: PlanningCandidate; weather: BackupCandidate['weather'] }[];
}

describe('a weather backup a traveller without a car can actually take', () => {
  /**
   * The ceiling was `min(maxDailyDriveMinutes, 75)`, and that first number is
   * zero for everybody who said they would not drive — so the filter rejected
   * every candidate, `chooseBackups` returned nothing, and the copy underneath
   * went on saying nothing on the board was reachable. No car-free trip has ever
   * been offered a backup.
   */
  it('offers one reached on foot inside the travelling budget', () => {
    const backups = chooseBackups({
      date: '2026-08-12',
      scheduledPlaceIds: new Set([OTHER.id]),
      atRisk: rainedOff() as never,
      pool: [backupCandidate(PLACE, 30, 'walk')],
      maxDriveMinutes: 0,
      maxTransportMinutes: 180,
    });

    expect(backups.length, 'a car-free trip was offered no backup at all').toBeGreaterThan(0);
    /* And the sentence does not put them on roads they are not using. */
    expect(backups[0]!.accessSummary).not.toMatch(/roads you are already using/);
    expect(backups[0]!.accessSummary).toMatch(/on foot/);
  });

  it('claims no mode at all when nothing established one', () => {
    /*
     * `unsupported` is what the reach resolver leaves behind when nothing it
     * could use answered for the pair — and the minutes then fall back to the
     * raw matrix figure, which on a road matrix is a *car* number for somebody
     * who may have no car. Describing that as a ride, which an earlier version
     * of this function did, invents a journey nobody measured.
     */
    const unresolved = backupCandidate(PLACE, 30, 'walk');
    const backups = chooseBackups({
      date: '2026-08-12',
      scheduledPlaceIds: new Set([OTHER.id]),
      atRisk: rainedOff() as never,
      pool: [{ ...unresolved, travelModeFromBase: 'unsupported' }],
      maxDriveMinutes: 0,
      maxTransportMinutes: 180,
    });

    /* Not offered at all: an unestablished way there is not a rescue. */
    expect(backups).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe('what a measured journey rescues from the pre-scheduler gates', () => {
  /**
   * THE REFUSAL THAT EMPTIED A WHOLE PLAN.
   *
   * `matrixCoversMode` knows two networks — road and pedestrian — and returns
   * false for every scheduled mode. A car-free traveller in a city whose bounds
   * span more than the walkable threshold gets a **road** matrix, while every
   * synthesised access rule says `approachMode: 'walk'` with no stated
   * allowance. The refusal in `buildOption` then dropped every unit on every
   * date and the plan came back empty — with measured base-to-place journeys
   * sitting unread in `PlannerInput.transit`.
   */
  function walkRuleDataset() {
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
          /* No source for the allowance. The matrix is supposed to measure it. */
          approachMinutes: null,
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

  const unit = () =>
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
            travelMinutesFromBase: 21,
            travelModeFromBase: 'rail',
          },
        ],
      },
    ] as unknown as Parameters<typeof resolveAccess>[0]['units'];

  it('drops the unit when a road matrix is all a car-free traveller has', () => {
    const road: TravelTimeMatrix = { ...footMatrix(), mode: 'car' };
    const resolved = resolveAccess({
      units: unit(),
      dates: ['2026-08-12'],
      dataset: walkRuleDataset(),
      profile: CAR_FREE,
      matrix: road,
      travel: { knowledge: travelKnowledgeFor(road, CAR_FREE, null), baseId: 'base' },
    });

    /* Nothing measured a way in this traveller could take. Refusing is correct. */
    expect([...resolved.values()].every((entry) => !entry.available)).toBe(true);
  });

  it('keeps it when a measured journey reaches the same gateway', () => {
    const road: TravelTimeMatrix = { ...footMatrix(), mode: 'car' };
    const resolved = resolveAccess({
      units: unit(),
      dates: ['2026-08-12'],
      dataset: walkRuleDataset(),
      profile: CAR_FREE,
      matrix: road,
      travel: {
        knowledge: travelKnowledgeFor(road, CAR_FREE, transit(21)),
        baseId: 'base',
      },
    });

    const entry = [...resolved.values()][0]!;
    expect(entry.available, 'a unit a measured journey reaches was dropped anyway').toBe(true);
    if (!entry.available) return;
    /*
     * And left for the scheduler to time, rather than pinned to an authored
     * constant — `null` is what sends `layoutDay` through `resolveLeg`.
     */
    expect(entry.option.approachMinutes).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe('whether the traveller’s own picks can fit', () => {
  /**
   * `lowerBoundTravelMinutes` walked the matrix, so on a car-free city trip it
   * measured a nearest-neighbour tour **on foot** — three to five times the
   * measured metro journeys between the same points. A `must_do_conflict` is a
   * hard refusal of the entire plan, so the bound being read off the wrong
   * network abandoned trips that fitted comfortably.
   */
  function picks(count: number): PlanningCandidate[] {
    return Array.from({ length: count }, (_, index) => ({
      place: { ...PLACE, id: `pick-${index}` },
      priority: 1,
      manual: true,
      selectionStatus: 'included' as const,
      fitScore: 0.8,
      matchedInterests: [],
      durationMinutes: 90,
      travelMinutesFromBase: 20,
      travelModeFromBase: 'rail' as const,
    })) as unknown as PlanningCandidate[];
  }

  /** Every pair an hour and a quarter apart on foot, a quarter of an hour by metro. */
  function cityMatrix(ids: readonly string[]): TravelTimeMatrix {
    return {
      mode: 'foot',
      ids: [...ids],
      minutes: ids.map((_, i) => ids.map((__, j) => (i === j ? 0 : 75))),
      km: ids.map((_, i) => ids.map((__, j) => (i === j ? 0 : 5))),
      provenance: { kind: 'measured', note: 'Pedestrian network.' },
    };
  }

  function cityTransit(ids: readonly string[]): TransitEvidence {
    const journeys = ids.flatMap((from) =>
      ids
        .filter((to) => to !== from)
        .map((to) => ({
          ...transit(15).journeys[0]!,
          fromId: from,
          toId: to,
        })),
    );
    return { journeys, provider: 'test', requested: journeys.length, measured: journeys.length };
  }

  it('refuses a set the walking network genuinely cannot fit', () => {
    const chosen = picks(10);
    const ids = chosen.map((candidate) => candidate.place.id);
    const conflict = assessMustDoFeasibility({
      candidates: chosen,
      matrix: cityMatrix(ids),
      days: 2,
    });
    expect(conflict, 'ten stops 75 min apart on foot over two days should not fit').not.toBeNull();
  });

  it('accepts the same set once the measured journeys are in hand', () => {
    const chosen = picks(10);
    const ids = chosen.map((candidate) => candidate.place.id);
    const matrix = cityMatrix(ids);
    const conflict = assessMustDoFeasibility({
      candidates: chosen,
      matrix,
      travel: travelKnowledgeFor(matrix, CAR_FREE, cityTransit(ids)),
      days: 2,
    });
    expect(
      conflict,
      'the whole trip was refused over a walking figure the traveller would never walk',
    ).toBeNull();
  });
});
