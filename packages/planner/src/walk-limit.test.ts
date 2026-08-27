import { describe, expect, it } from 'vitest';
import {
  unavailableWeatherDataset,
  type DiscoveryCandidate,
  type DiscoverySelection,
  type TransitEvidence,
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
import { plannerLegBounds, resolvePlannerLeg, type PlannerLegBounds } from './modelled-walk';
import { DETOUR_STRETCH_MULTIPLIER, travelKnowledgeFor } from './travel';

/**
 * THE STATED WALKING ANSWER, ENFORCED PER LEG — THE RELEASE GATE FOR THE
 * SIXTY-FIVE-MINUTE WALKS.
 *
 * The audited live build: a traveller who answered "up to 25 minutes on foot
 * to reach a stop" received sixty-five-minute measured walks, each way, day
 * after day, because the answer bounded only which mode wins a contest — a
 * walk that was the *only* measured option was offered however long it was,
 * and the sole ceiling that ever applied was the daily transport budget.
 *
 * The contract this file gates:
 *
 *   1. a measured walking leg past the stated answer is refused, `conflict`,
 *      with the walk and the answer both named in the sentence;
 *   2. a measured, permitted ride for the same pair carries the leg instead of
 *      the refusal — the answer rules out the walk, not the place;
 *   3. end to end, the stop whose only measured way in is an over-limit walk
 *      is refused per stop under the transport-conflict code, with a remedy
 *      naming the answer to change — never silently scheduled;
 *   4. a stop inside the answer keeps planning exactly as before;
 *   5. a knowledge that carries no stated answer keeps the old behaviour.
 */

const IDS = TRANSIT_CITY_IDENTITY;

/** Inside the fixture traveller's 20-minute walking answer. */
const NEAR_WALK = { minutes: 15, km: 1.1 };
/** The audited shape: an hour-plus measured walk, inside the daily budget. */
const FAR_WALK = { minutes: 65, km: 4.9 };

/** A pedestrian matrix over the base and two stops — walking is all there is. */
function footMatrix(): TravelTimeMatrix {
  const ids = [IDS.baseId, IDS.candidateA, IDS.candidateB];
  const between = (from: string, to: string) => {
    if (from === to) return { minutes: 0, km: 0 };
    const other = from === IDS.baseId ? to : from;
    return other === IDS.candidateA ? NEAR_WALK : FAR_WALK;
  };
  return {
    mode: 'foot',
    ids,
    minutes: ids.map((from) => ids.map((to) => between(from, to).minutes)),
    km: ids.map((from) => ids.map((to) => between(from, to).km)),
    provenance: {
      kind: 'measured',
      note: 'Pedestrian network, measured by construction.',
      source: 'walk-limit.test.ts',
    },
  };
}

/** The compiler's signature for "this trip leaned on transit and none measured". */
function unverifiedTransit(): TransitEvidence {
  return { journeys: [], requested: 0, measured: 0, absence: 'unsupported' };
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

const SELECTIONS: DiscoverySelection[] = [IDS.candidateA, IDS.candidateB].map((placeId) => ({
  placeId,
  status: 'included',
  source: 'user',
  updatedAt: '2026-08-10T09:00:00.000Z',
}));

/**
 * A hand-set pair of bounds, for the cases whose point is a specific ceiling
 * rather than a specific traveller.
 *
 * Both halves the same number on purpose: these cases predate the split and
 * their subject is a single cap, so setting them equal keeps each one asserting
 * exactly what it always asserted. The cases whose subject *is* the split build
 * their bounds from the profile instead.
 */
function bothBoundsAt(minutes: number): PlannerLegBounds {
  return {
    journeyCapMinutes: minutes,
    walkingLegCapMinutes: minutes,
    mobilityLimited: false,
  };
}

const BASICS: TripBasics = {
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
        limitation: 'One point for the whole city.',
      },
    ],
    dates: TRANSIT_CITY_DATES,
    now: new Date('2026-08-10T09:00:00.000Z'),
    reason: 'not_configured',
    message: 'We have not fetched the weather for this trip yet.',
  });
}

function planWalkCity() {
  return planTrip({
    tripId: 'walk-limit-city',
    basics: BASICS,
    profile: transitCityTraveler(),
    region: TRANSIT_CITY_REGION,
    candidates: [candidateFor(IDS.candidateA), candidateFor(IDS.candidateB)],
    selections: SELECTIONS,
    matrix: footMatrix(),
    transit: unverifiedTransit(),
    access: TRANSIT_CITY_ACCESS,
    hours: TRANSIT_CITY_HOURS,
    weather: unfetchedWeather(),
    baseId: IDS.baseId,
    now: new Date('2026-08-10T09:00:00.000Z'),
    generatedAt: '2026-08-10T09:00:00.000Z',
  });
}

describe('a measured walking leg against the stated access-walk answer', () => {
  const profile = transitCityTraveler(); // maxAccessWalkMinutes: 20

  it('refuses an over-limit measured walk with the walk and the answer named', () => {
    const knowledge = travelKnowledgeFor(footMatrix(), profile, unverifiedTransit());
    /*
     * The cap the real callers pass for this profile is 20 min, so the
     * 65-minute walk sits past even the stretch band and the refusal stands.
     * A wider cap would make this walk a stretch the board had promised.
     */
    const resolved = resolvePlannerLeg(knowledge, IDS.baseId, IDS.candidateB, 'walk', {
      bounds: plannerLegBounds(profile),
    });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.conflict).toBe(true);
    expect(resolved.detail).toMatch(/on foot/);
    expect(resolved.detail).toContain('1 hr 5 min');
    expect(resolved.detail).toContain('20 min');
    expect(resolved.detail).toMatch(/furthest you would walk/);
  });

  it('keeps a walk inside the answer exactly as it was', () => {
    const knowledge = travelKnowledgeFor(footMatrix(), profile, unverifiedTransit());
    const resolved = resolvePlannerLeg(knowledge, IDS.baseId, IDS.candidateA, 'walk', {
      bounds: bothBoundsAt(60),
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.mode).toBe('walk');
    expect(resolved.minutes).toBe(NEAR_WALK.minutes);
  });

  it('rides a measured, permitted journey instead of refusing the pair', () => {
    /*
     * The walk to B is quicker on paper than this ride, so the mode contest
     * picks the walk — and the stated answer then rules the walk out. The
     * answer must rule out the walk, not the place: the measured ride carries
     * the leg.
     */
    const withRide: TransitEvidence = {
      journeys: [
        {
          fromId: IDS.baseId,
          toId: IDS.candidateB,
          status: 'measured',
          minutes: 70,
          transfers: 0,
          requestBasis: {
            kind: 'depart_at',
            instant: '2026-08-12T09:30:00.000Z',
            timeZone: 'Europe/Lisbon',
          },
          source: 'fixture-journey-planner',
          retrievedAt: '2026-08-10T09:00:00.000Z',
          detail: 'Measured against published timetables.',
          legs: [{ mode: 'rail', minutes: 70 }],
        },
      ],
      requested: 1,
      measured: 1,
    };
    const knowledge = travelKnowledgeFor(footMatrix(), profile, withRide);
    const resolved = resolvePlannerLeg(knowledge, IDS.baseId, IDS.candidateB, 'walk', {
      bounds: bothBoundsAt(60),
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.mode).toBe('rail');
    expect(resolved.minutes).toBe(70);
    /* Computed from timetables, never claimed as a stopwatch measurement. */
    expect(resolved.provenance).toBe('official');
  });

  it('keeps the old behaviour when the profile carries no answer', () => {
    const knowledge = travelKnowledgeFor(footMatrix(), profile, unverifiedTransit());
    const unanswered = { ...knowledge, maxWalkMinutes: undefined as unknown as number };
    const resolved = resolvePlannerLeg(unanswered, IDS.baseId, IDS.candidateB, 'walk', {
      bounds: bothBoundsAt(60),
    });
    /* A limit nobody set cannot refuse a leg: the measured walk stands. */
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.mode).toBe('walk');
    expect(resolved.minutes).toBe(FAR_WALK.minutes);
  });
});

describe('a measured walk inside the stretch band the board already promised', () => {
  /*
   * THE STRETCH THE BOARD OFFERS IS A LEG THE PLANNER MUST LAY.
   *
   * The live evidence class: a carless city trip whose auto-pick chose seats
   * with measured foot legs a handful of minutes past the stated walking
   * answer — inside the band the detour classifier files as a permitted
   * stretch (`radius × DETOUR_STRETCH_MULTIPLIER`) — and whose planner then
   * refused every one of them on the raw answer. Four seats promised, four
   * refused, readiness 'insufficient', no itinerary: the board and the plan
   * were two verdicts about one journey.
   */
  const profile = transitCityTraveler(); // maxAccessWalkMinutes: 20
  const walkCap = plannerLegBounds(profile).walkingLegCapMinutes;

  /** Past the stated answer, inside the stretch band. The fixture guards say so. */
  const STRETCH_WALK = { minutes: 25, km: 1.9 };

  function stretchMatrix(): TravelTimeMatrix {
    const ids = [IDS.baseId, IDS.candidateB];
    const between = (from: string, to: string) =>
      from === to ? { minutes: 0, km: 0 } : STRETCH_WALK;
    return {
      mode: 'foot',
      ids,
      minutes: ids.map((from) => ids.map((to) => between(from, to).minutes)),
      km: ids.map((from) => ids.map((to) => between(from, to).km)),
      provenance: {
        kind: 'measured',
        note: 'Pedestrian network, measured by construction.',
        source: 'walk-limit.test.ts',
      },
    };
  }

  it('sits where the fixture claims: over the answer, inside the stretch band', () => {
    expect(STRETCH_WALK.minutes).toBeGreaterThan(profile.transport.maxAccessWalkMinutes);
    expect(STRETCH_WALK.minutes).toBeLessThanOrEqual(walkCap * DETOUR_STRETCH_MULTIPLIER);
  });

  it('lays the measured walk when no ride or drive can carry the leg', () => {
    /*
     * The live shape exactly: no car, no measured journey for the pair, a
     * measured walk past the answer but inside the stretch band the board
     * classed the seat under. The leg is the walk that was measured.
     */
    const knowledge = travelKnowledgeFor(stretchMatrix(), profile, unverifiedTransit());
    const resolved = resolvePlannerLeg(knowledge, IDS.baseId, IDS.candidateB, 'walk', {
      bounds: bothBoundsAt(walkCap),
    });
    expect(resolved.ok, resolved.ok ? '' : `refused: ${resolved.detail}`).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.mode).toBe('walk');
    expect(resolved.minutes).toBe(STRETCH_WALK.minutes);
    /* The measured leg, not a model of one. */
    expect(resolved.provenance).toBe('measured');
  });

  it('still refuses a walk beyond the stretch band, naming the stated answer', () => {
    /*
     * The live board's fourth seat: a far outlier past even the stretch band.
     * That one is a decision for the traveller, and the refusal keeps the
     * sentence naming the walk and the answer that rules it out.
     */
    const knowledge = travelKnowledgeFor(footMatrix(), profile, unverifiedTransit());
    expect(FAR_WALK.minutes).toBeGreaterThan(walkCap * DETOUR_STRETCH_MULTIPLIER);
    const resolved = resolvePlannerLeg(knowledge, IDS.baseId, IDS.candidateB, 'walk', {
      bounds: bothBoundsAt(walkCap),
    });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.conflict).toBe(true);
    expect(resolved.detail).toContain('20 min');
    expect(resolved.detail).toMatch(/furthest you would walk/);
  });

  it('still lets a measured, permitted ride win over a stretch-band walk', () => {
    /*
     * The rung order the live trip needed and the ordering the fix must not
     * disturb: the ride is checked before the stretch, so a seat the board
     * promised is carried by the measured journey when one exists, and the
     * traveller only walks past their answer when nothing rides.
     */
    const withRide: TransitEvidence = {
      journeys: [
        {
          fromId: IDS.baseId,
          toId: IDS.candidateB,
          status: 'measured',
          minutes: 40,
          transfers: 0,
          requestBasis: {
            kind: 'depart_at',
            instant: '2026-08-12T09:30:00.000Z',
            timeZone: 'Europe/Lisbon',
          },
          source: 'fixture-journey-planner',
          retrievedAt: '2026-08-10T09:00:00.000Z',
          detail: 'Measured against published timetables.',
          legs: [{ mode: 'rail', minutes: 40 }],
        },
      ],
      requested: 1,
      measured: 1,
    };
    const knowledge = travelKnowledgeFor(stretchMatrix(), profile, withRide);
    const resolved = resolvePlannerLeg(knowledge, IDS.baseId, IDS.candidateB, 'walk', {
      bounds: bothBoundsAt(walkCap),
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.mode).toBe('rail');
    expect(resolved.minutes).toBe(40);
  });
});

/**
 * THE SAME WALK, WHERE IT IS STANDING IN FOR A TRAIN NOBODY COULD TIME.
 *
 * The refusals above are right about a walk the traveller would make. They were
 * also applied, unchanged, to a walking figure that exists only because no
 * transit provider is configured and the compiled matrix therefore prices the
 * pedestrian network: two live car-free dense-metro trips whose every canonical
 * seat sat thirty-nine to seventy measured walking minutes from base, each one
 * refused by an answer about the last mile from a stop, and which delivered one
 * and two scheduled stops out of twenty-four-card boards.
 *
 * The traveller rides. So where the compilation signs that nothing could time a
 * scheduled journey and the destination evidence observes a scheduled network,
 * the *journey* bound is the ride budget — and where either half is missing, the
 * walk is the journey and nothing moves.
 *
 * What the ride budget never becomes is the walking bound. The first fix spent
 * one number on both questions, so the widened figure arrived at the leg
 * resolver as a walking ceiling: a traveller who answered twenty-five was given
 * a hundred and twelve, and the itinerary laid "Walk to X — 67 min on foot".
 * These cases hold both halves — the seat stays reachable, and the leg is never
 * an instruction to walk it.
 */
describe('a measured walk that is only pricing an unmeasurable ride', () => {
  const profile = transitCityTraveler(); // maxAccessWalkMinutes: 20

  /** The build's own record, over ground whose evidence observes a network. */
  function blindKnowledge(network?: 'observed' | 'not_observed') {
    return travelKnowledgeFor(footMatrix(), profile, unverifiedTransit(), network);
  }

  it('widens the journey bound and never the walking one', () => {
    const walkingWorld = plannerLegBounds(profile, blindKnowledge('not_observed'));
    const ridingWorld = plannerLegBounds(profile, blindKnowledge('observed'));

    expect(walkingWorld.journeyCapMinutes).toBe(profile.transport.maxAccessWalkMinutes);
    expect(ridingWorld.journeyCapMinutes).toBeGreaterThan(walkingWorld.journeyCapMinutes);
    /* Half the day's getting-about, which is the ride branch's own arithmetic. */
    expect(ridingWorld.journeyCapMinutes).toBe(
      Math.max(
        profile.derived.effectiveDetourMinutes,
        Math.floor(profile.transport.maxDailyTransportMinutes / 2),
      ),
    );
    /*
     * THE HALF THE FIRST FIX GAVE AWAY. The gap that widens a reach verdict must
     * leave the walking ceiling exactly where the traveller set it, in both
     * worlds, or the widening arrives at a rendered leg.
     */
    expect(ridingWorld.walkingLegCapMinutes).toBe(profile.transport.maxAccessWalkMinutes);
    expect(walkingWorld.walkingLegCapMinutes).toBe(ridingWorld.walkingLegCapMinutes);
    /* No knowledge, no gap established, no widening. */
    expect(plannerLegBounds(profile).journeyCapMinutes).toBe(walkingWorld.journeyCapMinutes);
  });

  it('carries the seat as an unverified journey, never as a walk to make', () => {
    const knowledge = blindKnowledge('observed');
    const bounds = plannerLegBounds(profile, knowledge);
    /* The fixture is only a witness while the two bounds disagree about it. */
    expect(FAR_WALK.minutes).toBeGreaterThan(
      bounds.walkingLegCapMinutes * DETOUR_STRETCH_MULTIPLIER,
    );
    expect(FAR_WALK.minutes).toBeLessThanOrEqual(
      bounds.journeyCapMinutes * DETOUR_STRETCH_MULTIPLIER,
    );

    const laid = resolvePlannerLeg(knowledge, IDS.baseId, IDS.candidateB, 'walk', { bounds });
    /* The seat is still reachable — the journey bound is what carries it. */
    expect(laid.ok, laid.ok ? '' : `refused: ${laid.detail}`).toBe(true);
    if (!laid.ok) return;
    /* And it is not an instruction to walk for over an hour. */
    expect(laid.rule).toBe('transit_unverified');
    /* No train is invented: the minutes are still the one measurement there is. */
    expect(laid.minutes).toBe(FAR_WALK.minutes);
    /* A measured walk is not a measurement of the journey this leg actually is. */
    expect(laid.provenance).toBe('modelled');

    /*
     * The control: the identical matrix and the identical leg, over ground where
     * nobody observed a scheduled network. The walk is the journey, and the
     * refusal keeps the sentence naming the walk and the answer that rules it
     * out.
     */
    const real = blindKnowledge('not_observed');
    const refused = resolvePlannerLeg(real, IDS.baseId, IDS.candidateB, 'walk', {
      bounds: plannerLegBounds(profile, real),
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.conflict).toBe(true);
    expect(refused.detail).toContain('1 hr 5 min');
    expect(refused.detail).toContain('20 min');
    expect(refused.detail).toMatch(/furthest you would walk/);
  });

  it('never blames the walking answer for a journey nobody could verify', () => {
    /*
     * The far outlier, where even the journey bound cannot carry it. The refusal
     * is right; the sentence the old one used was not. "You said 20 min is the
     * furthest you would walk" is a charge against the traveller's own answer
     * for a route this product failed to price — the skip-list copy, one layer
     * down.
     */
    const knowledge = blindKnowledge('observed');
    const bounds = plannerLegBounds(profile, knowledge);
    const beyond = { ...bounds, journeyCapMinutes: 20 };
    expect(FAR_WALK.minutes).toBeGreaterThan(
      beyond.journeyCapMinutes * DETOUR_STRETCH_MULTIPLIER,
    );

    const refused = resolvePlannerLeg(knowledge, IDS.baseId, IDS.candidateB, 'walk', {
      bounds: beyond,
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.conflict).toBe(true);
    expect(refused.detail).toMatch(/could not verify the transit route/);
    expect(refused.detail).not.toMatch(/furthest you would walk/);
    expect(refused.detail).not.toMatch(/you said/);
  });
});

describe('a trip whose far stop is only reachable by an over-limit walk', () => {
  it('schedules the near stop and never lays an over-limit walking leg', () => {
    const result = planWalkCity();
    expect(result.ok, result.ok ? '' : `refused: ${result.message}`).toBe(true);
    if (!result.ok) return;

    const scheduled = result.itinerary.days.flatMap((day) =>
      day.items.filter((item) => item.kind === 'activity').map((item) => item.placeId),
    );
    expect(scheduled).toContain(IDS.candidateA);
    expect(scheduled).not.toContain(IDS.candidateB);

    for (const day of result.itinerary.days) {
      for (const item of day.items) {
        if (item.travel?.mode !== 'walk') continue;
        expect(
          item.travel.minutes,
          `day ${day.dayNumber} walks ${item.travel.minutes} min against a 20 min answer`,
        ).toBeLessThanOrEqual(20);
      }
    }
  });

  it('refuses the far stop by name, under the transport-conflict code, citing the answer', () => {
    const result = planWalkCity();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const far = result.itinerary.unscheduled.find((entry) => entry.placeId === IDS.candidateB);
    expect(far, 'the far stop vanished instead of being refused by name').toBeDefined();
    expect(far!.reasonCode).toBe('transport_mode_unavailable');
    expect(far!.reason).toContain('20 min');
    expect(far!.reason).toMatch(/on foot/);
    expect(far!.suggestedRemedy).toMatch(/how far you will walk/);
  });

  it('writes no day transport mode the trip cannot legally use', () => {
    const result = planWalkCity();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    /*
     * The audited artifact wrote `primaryMode: 'drive'` on the empty first and
     * last days of a trip whose traveller declared no car — the hard-coded end
     * of a fallback chain, not anything any day did.
     */
    for (const day of result.itinerary.days) {
      expect(
        day.transport.primaryMode,
        `day ${day.dayNumber} claims a drive on a car-free trip`,
      ).not.toBe('drive');
    }
  });
});
