import { describe, expect, it } from 'vitest';
import {
  ITINERARY_VERSION,
  autoSelect,
  buildDiscoveryBoard,
  describeReachFromBase,
  resolveCandidateReach,
  travelKnowledgeFor,
  unavailableWeatherDataset,
  type DiscoveryBoard,
  type DiscoveryCandidate,
  type DiscoverySelection,
  type TravelerProfile,
  type TripBasics,
  type WeatherDataset,
} from '@sidequest/core';
import {
  TRANSIT_CITY_DATES,
  TRANSIT_CITY_IDENTITY,
  TRANSIT_CITY_JOURNEYS,
  TRANSIT_CITY_PLACES,
  TRANSIT_CITY_REGION,
  transitCityBoardInput,
  transitCityKnowledge,
  transitCityRoadMatrix,
  transitCityTransit,
  transitCityTraveler,
  transitCityWalkMatrix,
} from '@sidequest/core/testing';
import { resolveCandidates } from './candidates';
import { planTrip } from './plan';

/**
 * THE ONE QUESTION PHASE 15D EXISTS TO ANSWER.
 *
 * > Can a place Sidequest knows is realistically reachable by this traveller
 * > survive research, Board scoring, auto-selection and planning without any
 * > layer reverting to the wrong transport assumption?
 *
 * Everything here runs the real chain against a fixture built so that the two
 * networks disagree: walking to the Hillside Shrine takes ninety-five minutes
 * and the train takes twenty-seven. Any layer that answers from the wrong one
 * gets a number four times out, and says so here rather than on a traveller's
 * screen.
 *
 * `TRANSIT_CITY_PLACES` deliberately carries the *walk* in the legacy
 * `travelFromBase.driveMinutes` field, so a fallback to it is a wrong answer
 * rather than a coincidentally right one.
 */

const IDS = TRANSIT_CITY_IDENTITY;

/** The fixture identity guard. Nothing below means anything without it. */
function expectTransitCity(board: DiscoveryBoard): void {
  expect(board.expansion.region.id, 'this ran against another region').toBe(IDS.regionId);
  const ids = new Set(board.candidates.map((candidate) => candidate.place.id));
  for (const id of [IDS.candidateA, IDS.candidateB, IDS.candidateC, IDS.candidateE]) {
    expect(ids.has(id), `${id} is not on this board`).toBe(true);
  }
  /*
   * And the disagreement itself, asserted rather than assumed. If the fixture
   * were ever edited so the walk and the train agreed, every expectation below
   * would still pass while proving nothing at all.
   */
  expect(TRANSIT_CITY_JOURNEYS.walkToB).toBeGreaterThan(TRANSIT_CITY_JOURNEYS.transitToB * 3);
}

function boardFor(profile: TravelerProfile): DiscoveryBoard {
  return buildDiscoveryBoard(transitCityBoardInput(profile));
}

function candidate(board: DiscoveryBoard, id: string): DiscoveryCandidate {
  const found = board.candidates.find((entry) => entry.place.id === id);
  if (!found) throw new Error(`No candidate for ${id}`);
  return found;
}

// ---------------------------------------------------------------------------
// The five candidates
// ---------------------------------------------------------------------------

describe('a car-free traveller, and the five ways a journey can end', () => {
  const profile = transitCityTraveler();
  const board = boardFor(profile);

  it('A — a twelve-minute walk is a walk, and comfortably inside tolerance', () => {
    expectTransitCity(board);
    const a = candidate(board, IDS.candidateA);
    expect(a.reach.status).toBe('measured');
    expect(a.travelModeFromBase).toBe('walk');
    expect(a.travelMinutesFromBase).toBe(TRANSIT_CITY_JOURNEYS.walkToA);
    expect(a.detourClass).toBe('in_tolerance');
  });

  it('B — is reached by the measured train, not by the ninety-five-minute walk', () => {
    expectTransitCity(board);
    const b = candidate(board, IDS.candidateB);
    expect(b.reach.status).toBe('measured');
    expect(b.travelModeFromBase).toBe('rail');
    expect(b.travelMinutesFromBase).toBe(TRANSIT_CITY_JOURNEYS.transitToB);
    /*
     * The negative half, and the more important one. The walk is measured, it is
     * permitted, and it is sitting in the same matrix — the whole failure was
     * preferring it because it was the one the matrix held.
     */
    expect(b.travelMinutesFromBase).not.toBe(TRANSIT_CITY_JOURNEYS.walkToB);
    expect(b.reach.status === 'measured' && b.reach.rule).toBe('transit_measured');
  });

  it('B — is not too far, is not weak, and stays eligible for auto-pick', () => {
    expectTransitCity(board);
    const b = candidate(board, IDS.candidateB);
    /* Every gate the old semantics closed on it, one at a time. */
    expect(b.detourClass).not.toBe('too_far');
    expect(b.detourClass).toBe('in_tolerance');
    expect(b.fit.band).not.toBe('weak');
    expect(b.fit.band).not.toBe('not_workable');
    expect(b.group).not.toBe('weak_fit');
    expect(b.quality.outcome).not.toBe('not_worth_detour');
    expect(b.worthDetour).not.toBe('too_far_for_this_trip');

    const auto = autoSelect({ candidates: board.candidates, profile, tripDays: 3 });
    expect(auto.selectedIds).toContain(IDS.candidateB);
    expect(auto.excluded.find((entry) => entry.placeId === IDS.candidateB)).toBeUndefined();

    /*
     * And the budget it was charged against is the journey it will actually
     * make. Auto-pick used to spend a *driving* budget that a car-free traveller
     * has none of, drawn down by a scalar measured on the wrong network — so the
     * accounting was wrong twice and cancelled out into "no travel at all". The
     * total is derived from the same reach the card shows.
     */
    const spent = auto.selectedIds
      .map((placeId) => board.candidates.find((entry) => entry.place.id === placeId)!)
      .reduce((total, card) => total + (card.travelMinutesFromBase ?? 0), 0);
    expect(auto.stats.totalTravelMinutesOneWay).toBe(spent);
    expect(auto.stats.totalDriveMinutesOneWay).toBe(0);
    expect(spent).toBeGreaterThan(0);
  });

  it('C — a two-hour walk with no train is measured, permitted, and still too much', () => {
    expectTransitCity(board);
    const c = candidate(board, IDS.candidateC);
    /*
     * Reachable is not the same question as sensible. The walk *is* a journey
     * somebody measured and this traveller is allowed to make; it is the day's
     * transport budget that refuses it, which is the traveller's own answer.
     */
    expect(c.reach.status).toBe('measured');
    expect(c.travelModeFromBase).toBe('walk');
    expect(c.travelMinutesFromBase).toBe(TRANSIT_CITY_JOURNEYS.walkToC);
    expect(c.detourClass).toBe('too_far');

    const auto = autoSelect({ candidates: board.candidates, profile, tripDays: 3 });
    expect(auto.selectedIds).not.toContain(IDS.candidateC);
  });

  it('D — a measured road journey establishes nothing for somebody with no car', () => {
    /*
     * Against the road network, where the twenty-two-minute drive genuinely
     * exists. Proving this on the pedestrian matrix would only prove that an
     * absent leg is absent.
     */
    const roadKnowledge = transitCityKnowledge(profile, 'road');
    const reach = resolveCandidateReach(roadKnowledge, IDS.baseId, IDS.candidateD);
    expect(reach.status).toBe('conflict');
    expect(reach.reachable).toBe(false);
    expect(reach.conflict).toBe(true);
    /* And the number is nowhere on the result to be picked up by accident. */
    expect(Object.values(reach)).not.toContain(TRANSIT_CITY_JOURNEYS.driveToD);

    /* A driver, on the same road, reaches it. Otherwise this proves only that D is broken. */
    const driver = transitCityTraveler({ willDrive: true, maxDailyTravelMinutes: 180 });
    const driverReach = resolveCandidateReach(
      travelKnowledgeFor(transitCityRoadMatrix(), driver, null),
      IDS.baseId,
      IDS.candidateD,
    );
    expect(driverReach.status).toBe('measured');
    expect(driverReach.status === 'measured' && driverReach.mode).toBe('drive');
  });

  it('D — is never auto-picked, on either network', () => {
    const auto = autoSelect({ candidates: board.candidates, profile, tripDays: 3 });
    expect(auto.selectedIds).not.toContain(IDS.candidateD);
    const d = candidate(board, IDS.candidateD);
    expect(d.access.status).toBe('blocked');
    expect(d.detourClass).toBe('too_far');
  });

  it('E — a journey planner that failed leaves the journey unknown, not far and not near', () => {
    expectTransitCity(board);
    const e = candidate(board, IDS.candidateE);
    expect(e.reach.status).toBe('unmeasured');
    expect(e.reach.reachable).toBeNull();
    expect(e.travelMinutesFromBase).toBeNull();
    expect(e.travelModeFromBase).toBeNull();
    expect(e.detourClass).toBe('unknown');
    /*
     * Neither fabricated direction. The two ways this used to go wrong were
     * "too far for this trip" (a confident verdict from a timeout) and a
     * zero-minute hop (an unroutable place rendered as being on the doorstep).
     */
    expect(e.worthDetour).not.toBe('too_far_for_this_trip');
    expect(e.worthDetour).toBe('reach_unverified');

    const auto = autoSelect({ candidates: board.candidates, profile, tripDays: 3 });
    expect(auto.selectedIds).not.toContain(IDS.candidateE);
    expect(
      auto.excluded.find((entry) => entry.placeId === IDS.candidateE)?.reason,
    ).toBe('reach_unverified');
  });
});

// ---------------------------------------------------------------------------
// The regressions a lenient fix would cause
// ---------------------------------------------------------------------------

describe('what a traveller who can drive sees in the same city', () => {
  it('reaches the vineyard on the road, and is not given the train instead', () => {
    const driver = transitCityTraveler({ willDrive: true, maxDailyTravelMinutes: 180 });
    const reach = resolveCandidateReach(
      travelKnowledgeFor(transitCityRoadMatrix(), driver, transitCityTransit()),
      IDS.baseId,
      IDS.candidateD,
    );
    expect(reach.status === 'measured' && reach.mode).toBe('drive');
    expect(reach.status === 'measured' && reach.travelMinutes).toBe(
      TRANSIT_CITY_JOURNEYS.driveToD,
    );
  });

  it('still walks to the gallery rather than boarding anything for twelve minutes', () => {
    const profile = transitCityTraveler();
    const reach = resolveCandidateReach(
      transitCityKnowledge(profile, 'walk'),
      IDS.baseId,
      IDS.candidateA,
    );
    expect(reach.status === 'measured' && reach.rule).toBe('walk_within_tolerance');
  });
});

// ---------------------------------------------------------------------------
// Board → planner → itinerary, for Candidate B
// ---------------------------------------------------------------------------

const BASICS: TripBasics = {
  mode: 'known_destination',
  destinationInput: 'Two Rivers',
  regionId: TRANSIT_CITY_REGION.id,
  startDate: TRANSIT_CITY_DATES[0]!,
  endDate: TRANSIT_CITY_DATES[TRANSIT_CITY_DATES.length - 1]!,
  arrivalTime: '09:00',
  departureTime: '19:00',
  adults: 2,
  children: 0,
  travelerNeeds: [],
};

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
        limitation: 'One point for the whole city; the headland is windier.',
      },
    ],
    dates: TRANSIT_CITY_DATES,
    now: new Date('2026-08-10T09:00:00.000Z'),
    reason: 'not_configured',
    message: 'We have not fetched the weather for this trip yet.',
  });
}

describe('the same journey, all the way to a rendered day', () => {
  it('carries one mode and one duration from provider evidence to the itinerary', () => {
    const profile = transitCityTraveler();
    const board = boardFor(profile);
    expectTransitCity(board);

    /* 1 — the provider's own evidence. */
    const evidence = transitCityTransit();
    const journey = evidence.journeys.find(
      (entry) => entry.fromId === IDS.baseId && entry.toId === IDS.candidateB,
    );
    expect(journey?.status).toBe('measured');
    expect(journey?.minutes).toBe(TRANSIT_CITY_JOURNEYS.transitToB);

    /* 2 — the shared resolver. */
    const reach = resolveCandidateReach(
      transitCityKnowledge(profile, 'walk'),
      IDS.baseId,
      IDS.candidateB,
    );
    expect(reach.status === 'measured' && reach.mode).toBe('rail');
    expect(reach.status === 'measured' && reach.travelMinutes).toBe(
      TRANSIT_CITY_JOURNEYS.transitToB,
    );

    /* 3 — regional expansion and detour classification. */
    const satellite = board.expansion.satellites.find(
      (entry) => entry.place.id === IDS.candidateB,
    );
    expect(satellite, 'B did not survive the expansion as a satellite').toBeDefined();
    expect(satellite!.detourClass).toBe('in_tolerance');
    expect(satellite!.travelModeFromBase).toBe('rail');

    /* 4 — the Board card and its band. */
    const b = candidate(board, IDS.candidateB);
    expect(b.travelModeFromBase).toBe('rail');
    expect(b.group).not.toBe('weak_fit');

    /* 5 — auto-selection. */
    const auto = autoSelect({ candidates: board.candidates, profile, tripDays: 3 });
    expect(auto.selectedIds).toContain(IDS.candidateB);
    const selections: DiscoverySelection[] = auto.selectedIds.map((placeId) => ({
      placeId,
      status: 'included' as const,
      source: 'auto' as const,
      updatedAt: '2026-08-10T00:00:00.000Z',
    }));

    /*
     * 6 — the planner's own candidate, resolved independently.
     *
     * This is the assertion mutation 10 exists to defeat, and it needs its own
     * line: the *scheduler* resolves each leg for itself, so a planner that
     * reverted `PlanningCandidate` to the matrix figure would still emit a rail
     * leg on the timeline while carrying a ninety-five-minute walking bound
     * behind it. The two are different readers of the same question, and the
     * card is what the traveller agreed to — so this is where the board and the
     * planner must be shown to agree, before a day is laid out at all.
     */
    const resolved = resolveCandidates(
      board.candidates,
      selections,
      transitCityWalkMatrix(),
      { knowledge: transitCityKnowledge(profile, 'walk'), baseId: IDS.baseId },
    );
    const plannedB = resolved.eligible.find((entry) => entry.place.id === IDS.candidateB);
    expect(plannedB, 'B was selected and the planner did not take it').toBeDefined();
    expect(plannedB!.travelModeFromBase).toBe(b.travelModeFromBase);
    expect(plannedB!.travelMinutesFromBase).toBe(b.travelMinutesFromBase);
    expect(plannedB!.travelMinutesFromBase).toBe(TRANSIT_CITY_JOURNEYS.transitToB);

    /* And every other selected stop agrees too, not just the one being watched. */
    for (const entry of resolved.eligible) {
      const card = board.candidates.find((item) => item.place.id === entry.place.id);
      if (!card || card.reach.status !== 'measured') continue;
      expect(
        entry.travelModeFromBase,
        `${entry.place.name}: planner says ${entry.travelModeFromBase}, board says ${card.travelModeFromBase}`,
      ).toBe(card.travelModeFromBase);
      expect(entry.travelMinutesFromBase).toBe(card.travelMinutesFromBase);
    }

    /* 7-9 — the planner, resolveLeg, and the scheduled day. */
    const plan = planTrip({
      tripId: 'transit-city-fixture',
      basics: BASICS,
      profile,
      region: TRANSIT_CITY_REGION,
      candidates: board.candidates,
      selections,
      matrix: transitCityWalkMatrix(),
      transit: evidence,
      access: transitCityBoardInput(profile).access,
      hours: transitCityBoardInput(profile).hours,
      weather: unfetchedWeather(),
      baseId: IDS.baseId,
      now: new Date('2026-08-10T09:00:00.000Z'),
      generatedAt: '2026-08-10T09:00:00.000Z',
    });

    expect(plan.ok, plan.ok ? '' : `${plan.code}: ${plan.message}`).toBe(true);
    if (!plan.ok) return;
    expect(plan.itinerary.version).toBe(ITINERARY_VERSION);

    /*
     * The strategy panel may not contradict its own timeline. A shipped build
     * printed "Everything here is walkable from your base" directly above four
     * train legs, because the sentence was derived from the *authored* service
     * list — empty here — rather than from what the days actually ride.
     */
    const ridesTransit = plan.itinerary.days.some((day) => day.totals.transitMinutes > 0);
    expect(ridesTransit, 'no day rides anything, so the guard below is vacuous').toBe(true);
    expect(plan.itinerary.transportStrategy.transitSummary).not.toMatch(/walkable/i);
    expect(plan.itinerary.transportStrategy.transitSummary).toMatch(/public transport/i);
    const scheduled = plan.itinerary.days.flatMap((day) =>
      day.items.filter((item) => item.kind === 'activity' && item.placeId === IDS.candidateB),
    );
    expect(scheduled.length, 'B was selected on the board and never scheduled').toBeGreaterThan(0);

    /*
     * 10 — and the leg that reaches it. This is the assertion the whole pass is
     * for: the mode on the itinerary and the mode on the board are the same
     * mode, and the minutes are the pair's own measured minutes rather than the
     * walk that sits beside them in the matrix.
     */
    const legsToB = plan.itinerary.days.flatMap((day) =>
      day.items
        .filter((item) => item.kind === 'travel' && item.travel?.toId === IDS.candidateB)
        .map((item) => item.travel!),
    );
    expect(legsToB.length, 'nothing travels to B').toBeGreaterThan(0);
    for (const leg of legsToB) {
      expect(leg.mode).toBe(b.travelModeFromBase);
      expect(leg.minutes).toBe(TRANSIT_CITY_JOURNEYS.transitToB);
      expect(leg.minutes).not.toBe(TRANSIT_CITY_JOURNEYS.walkToB);
    }
  });
});

// ---------------------------------------------------------------------------
// The three sentences a card may say about getting there
// ---------------------------------------------------------------------------

describe('what the traveller is told about a journey', () => {
  /*
   * `describeReachFromBase` is the single producer of the card's travel copy,
   * and until these tests a mutation could replace its whole body with
   * `return reach.detail` — a raw resolver sentence, enum values and all — with
   * every suite green. The renderer of last resort gets its outputs pinned.
   */
  const fmt = (minutes: number) => `${minutes} min`;
  const profile = transitCityTraveler();

  it('a measured journey is the duration and the mode, as a person would say it', () => {
    const reach = resolveCandidateReach(
      transitCityKnowledge(profile, 'walk'),
      IDS.baseId,
      IDS.candidateB,
    );
    expect(describeReachFromBase(reach, fmt)).toBe(
      `${TRANSIT_CITY_JOURNEYS.transitToB} min by train`,
    );
  });

  it('a ruled-out journey and an unknown journey are different sentences', () => {
    const conflict = resolveCandidateReach(
      transitCityKnowledge(profile, 'road'),
      IDS.baseId,
      IDS.candidateD,
    );
    expect(conflict.status).toBe('conflict');
    expect(describeReachFromBase(conflict, fmt)).toBe('No usable route from your base');

    const unknown = resolveCandidateReach(
      transitCityKnowledge(profile, 'walk'),
      IDS.baseId,
      IDS.candidateE,
    );
    expect(unknown.status).toBe('unmeasured');
    expect(describeReachFromBase(unknown, fmt)).toBe('Journey not verified');
  });

  it('never leaks a raw transport enum, in the sentence or the detail behind it', () => {
    const conflict = resolveCandidateReach(
      transitCityKnowledge(profile, 'road'),
      IDS.baseId,
      IDS.candidateD,
    );
    expect(conflict.status).toBe('conflict');
    /*
     * The conflict detail travels in the board's client payload and is one
     * renderer away from a screen, so it is held to screen rules: mode names
     * appear as words ("by car"), never as enum values.
     */
    const detail = conflict.status === 'conflict' ? conflict.detail : '';
    expect(detail).toContain('by car');
    for (const raw of ['public_bus', 'private_transfer', 'unsupported', 'drive,']) {
      expect(detail).not.toContain(raw);
    }
  });
});

// ---------------------------------------------------------------------------
// Multi-base: from base means from *your* base that day
// ---------------------------------------------------------------------------

describe('a trip that sleeps in two places', () => {
  it('measures each candidate from the base that can actually reach it', () => {
    /*
     * The Bali regression, at board level. The compiler has measured
     * `travelFromBase` from each place's own cluster base since a stop beside
     * the third base was scored as though driven to from the first, six hours
     * away — and a board that resolved everything from the primary base alone
     * would reintroduce exactly that: candidate C is a two-hour walk from the
     * old town and eight minutes from the second base, and on a one-base
     * reading it is `too_far` with a hard travel-budget refusal.
     */
    const secondBase = 'tc-second-base';
    const walk = transitCityWalkMatrix();
    const ids = [...walk.ids, secondBase];
    const withSecondBase = {
      ...walk,
      ids,
      minutes: ids.map((from, i) =>
        ids.map((to, j) => {
          if (i === j) return 0;
          if (from === secondBase || to === secondBase) {
            const other = from === secondBase ? to : from;
            /* Eight minutes to the headland, an honest hike to everything else. */
            return other === IDS.candidateC ? 8 : 110;
          }
          return walk.minutes[i]![j]!;
        }),
      ),
      km: ids.map((from, i) =>
        ids.map((to, j) => {
          if (i === j) return 0;
          if (from === secondBase || to === secondBase) return 1;
          return walk.km[i]![j]!;
        }),
      ),
    };

    const profile = transitCityTraveler();
    const input = transitCityBoardInput(profile);
    const board = buildDiscoveryBoard({
      ...input,
      travel: {
        matrix: withSecondBase,
        transit: transitCityTransit(),
        baseId: IDS.baseId,
        baseIds: [IDS.baseId, secondBase],
      },
    });

    const c = board.candidates.find((entry) => entry.place.id === IDS.candidateC)!;
    expect(c.reach.status).toBe('measured');
    /* Measured from the second base — the identity says which. */
    expect(c.reach.status === 'measured' && c.reach.baseId).toBe(secondBase);
    expect(c.travelMinutesFromBase).toBe(8);
    expect(c.detourClass).toBe('in_tolerance');

    /* And a single-base board still refuses it, so the fix is the baseIds. */
    const singleBase = buildDiscoveryBoard(transitCityBoardInput(profile));
    const cSingle = singleBase.candidates.find((entry) => entry.place.id === IDS.candidateC)!;
    expect(cSingle.detourClass).toBe('too_far');
  });
});
