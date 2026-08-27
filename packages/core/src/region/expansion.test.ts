import { describe, expect, it } from 'vitest';
import { expandRegion, worthDetourLabel } from './expansion';
import { assessSeason, describeOpenSeason } from './season';
import { EASTERN_SIERRA, EASTERN_SIERRA_ACCESS, EASTERN_SIERRA_PLACES, placeById } from '../data/index';
import { assessPlaceAccess, capabilityFromProfile } from '../access/feasibility';
import type { WorthDetourLabel } from '../schemas/region';
import type { TransitEvidence } from '../schemas/compiled-region';
import { autoSelect } from '../discovery/autoselect';
import { buildDiscoveryBoard } from '../discovery/board';
import { detourToleranceMinutesFor, DETOUR_STRETCH_MULTIPLIER } from '../travel/reach';
import {
  TRANSIT_CITY_IDENTITY,
  TRANSIT_CITY_JOURNEYS,
  transitCityBoardInput,
  transitCityTraveler,
} from '../testing/transit-city';
import {
  AUGUST_DATES,
  AUGUST_MONTHS,
  JANUARY_MONTHS,
  MAMMOTH_HIKER_ANSWERS,
  boardContext,
  context,
  expansionTravel,
  profile,
} from '../testing/fixtures';

const expand = (
  overrides: Parameters<typeof profile>[0] = MAMMOTH_HIKER_ANSWERS,
  dates = AUGUST_DATES,
  ctx = context(),
) => {
  const shared = boardContext(dates);
  return expandRegion({
    region: EASTERN_SIERRA,
    places: EASTERN_SIERRA_PLACES,
    profile: profile(overrides, ctx),
    months: shared.months,
    dates: shared.dates,
    access: shared.access,
    hours: shared.hours,
    travel: expansionTravel(profile(overrides, ctx)),
  });
};

describe('regional expansion', () => {
  it('turns a destination into a base plus satellites', () => {
    const expansion = expand();
    expect(expansion.base.length).toBeGreaterThan(0);
    expect(expansion.satellites.length).toBeGreaterThan(5);
    expect(expansion.base.every((item) => item.place.relationship === 'base')).toBe(true);
    expect(expansion.satellites.every((item) => item.place.relationship === 'satellite')).toBe(true);
  });

  it('reaches the Eastern Sierra names a Mammoth trip should include', () => {
    const ids = expand().satellites.map((item) => item.place.id);
    expect(ids).toContain('convict-lake');
    expect(ids).toContain('hot-creek-geologic-site');
    expect(ids).toContain('minaret-vista');
    expect(ids).toContain('june-lake-loop');
    expect(ids).toContain('mono-lake-south-tufa');
  });

  it('sorts satellites by how far out they are', () => {
    const times = expand().satellites.map((item) => item.travelMinutesFromBase);
    // Every satellite resolved: a null here would sort as a hole, not a time.
    expect(times.every((value) => value !== null)).toBe(true);
    expect([...times].sort((a, b) => a! - b!)).toEqual(times);
  });

  it('widens and narrows with the traveller’s stated radius', () => {
    const tight = expand({ ...MAMMOTH_HIKER_ANSWERS, regionalExpansion: 'destination_only' });
    const wide = expand({
      ...MAMMOTH_HIKER_ANSWERS,
      regionalExpansion: 'best_regional',
      detourToleranceMinutes: 150,
      maxDailyTravelMinutes: 300,
    });

    expect(tight.radiusMinutes).toBeLessThan(wide.radiusMinutes);
    expect(tight.satellites.length).toBeLessThan(wide.satellites.length);

    const tightIds = tight.satellites.map((item) => item.place.id);
    expect(tightIds).not.toContain('mono-lake-south-tufa');

    const wideIds = wide.satellites.map((item) => item.place.id);
    expect(wideIds).toContain('bodie-state-historic-park');
  });

  it('puts anything past the daily driving budget out of reach', () => {
    const expansion = expand();
    const beyond = expansion.beyondRadius.map((item) => item.place.id);
    // Two hours each way from Mammoth is a travel day, not a day trip.
    expect(beyond).toContain('alabama-hills');
    expect(beyond).toContain('manzanar-historic-site');
  });

  it('classifies a stop just outside the limit as a stretch rather than dropping it', () => {
    const expansion = expand({ ...MAMMOTH_HIKER_ANSWERS, detourToleranceMinutes: 40 });
    const monoLake = expansion.satellites.find((item) => item.place.id === 'mono-lake-south-tufa');
    expect(monoLake?.detourClass).toBe('stretch');
  });

  it('reports the share of the day a round trip consumes', () => {
    const monoLake = expand().satellites.find((item) => item.place.id === 'mono-lake-south-tufa');
    // 50 minutes each way against a 150 minute daily budget.
    expect(monoLake?.travelBudgetShare).toBeCloseTo(100 / 150, 5);
  });
});

describe('seasonal access', () => {
  it('reports a summer-only place as open in August and closed in January', () => {
    const postpile = placeById('devils-postpile')!;
    expect(assessSeason(postpile, AUGUST_MONTHS).status).toBe('open');
    expect(assessSeason(postpile, JANUARY_MONTHS).status).toBe('closed');
  });

  it('leaves the shuttle to the access rules rather than answering by month', () => {
    // `assessSeason` answers "is the road open"; it deliberately no longer
    // answers "is a shuttle mandatory", because that question needs a weekday
    // and an hour and this one only ever had a month.
    const postpile = placeById('devils-postpile')!;
    expect(assessSeason(postpile, AUGUST_MONTHS)).not.toHaveProperty('shuttleRequired');
    expect(assessSeason(postpile, [10]).status).toBe('open');

    const capability = capabilityFromProfile(profile(MAMMOTH_HIKER_ANSWERS, context()));
    const august = assessPlaceAccess({
      placeId: 'devils-postpile',
      dataset: EASTERN_SIERRA_ACCESS,
      dates: ['2026-08-12'],
      capability,
    });
    expect(august.requiredModes).toContain('shuttle');

    // October: the road is open and the shuttle has stopped, so you drive.
    const october = assessPlaceAccess({
      placeId: 'devils-postpile',
      dataset: EASTERN_SIERRA_ACCESS,
      dates: ['2026-10-12'],
      capability,
    });
    expect(october.requiredModes).not.toContain('shuttle');
    expect(october.requiredModes).toContain('drive');
  });

  it('reports a partially open window when a trip straddles the closure', () => {
    const tioga = placeById('tioga-pass-tuolumne')!;
    const assessment = assessSeason(tioga, [10, 11]);
    expect(assessment.status).toBe('partially_open');
    expect(assessment.openTripMonths).toEqual([10]);
  });

  it('leaves a year-round place open whenever you go', () => {
    const convict = placeById('convict-lake')!;
    expect(assessSeason(convict, JANUARY_MONTHS).status).toBe('open');
    expect(describeOpenSeason(convict)).toBe('Open year-round');
  });

  it('describes a contiguous season readably', () => {
    expect(describeOpenSeason(placeById('devils-postpile')!)).toBe('Usually open June to October');
  });
});

describe('worth-the-detour verdict', () => {
  it('combines distance with fit rather than reporting distance alone', () => {
    expect(worthDetourLabel('in_tolerance', 'top_pick')).toBe('definitely_worth_it');
    expect(worthDetourLabel('stretch', 'top_pick')).toBe('definitely_worth_it');
    expect(worthDetourLabel('stretch', 'strong')).toBe('worth_it_if_you_like_this');
    expect(worthDetourLabel('in_tolerance', 'optional')).toBe('only_if_nearby');
    expect(worthDetourLabel('too_far', 'good')).toBe('too_far_for_this_trip');
    expect(worthDetourLabel('base', 'strong')).toBe('core_to_trip');
    expect(worthDetourLabel('in_tolerance', 'not_workable')).toBe('skip_for_your_style');
  });

  /**
   * WHAT EACH VERDICT CLAIMS ABOUT THE JOURNEY, AS OPPOSED TO ABOUT THE PLACE.
   *
   * `skip_for_your_style` is deliberately its own claim rather than folded into
   * one of the others: it is the single label here that says nothing about a
   * road, so the bands that produce it are compared against each other and
   * never against a distance verdict.
   */
  const REACH_CLAIM: Record<WorthDetourLabel, string> = {
    core_to_trip: 'no journey to make',
    definitely_worth_it: 'reachable',
    worth_it_if_you_like_this: 'reachable',
    only_if_nearby: 'reachable',
    too_far_for_this_trip: 'out of this trip’s reach',
    reach_unverified: 'nobody established it',
    skip_for_your_style: 'not a claim about the journey',
  };

  const WORKABLE_BANDS = ['top_pick', 'strong', 'good', 'optional'] as const;

  it('gives one journey one distance verdict, whatever the traveller makes of the place', () => {
    /*
     * THE DEFECT: a sixty-nine-minute `stretch` read "worth it if this is your
     * thing" at band `strong` and "too far for this trip" at band `good`. How
     * far somewhere is does not move with how much somebody would enjoy it, and
     * a card that says otherwise is free to contradict the plan built from the
     * same measurement — which is exactly what it did.
     */
    for (const detourClass of ['base', 'in_tolerance', 'stretch', 'too_far', 'unknown'] as const) {
      const claims = new Map(
        WORKABLE_BANDS.map((band) => [band, REACH_CLAIM[worthDetourLabel(detourClass, band)]]),
      );
      expect(
        new Set(claims.values()).size,
        `one ${detourClass} journey is described as ${[...claims]
          .map(([band, claim]) => `${claim} at ${band}`)
          .join(', ')}`,
      ).toBe(1);
    }
  });

  it('never sells a journey this trip cannot make as one worth taking', () => {
    /*
     * The mirror of the same fault, and the one that reaches the traveller as a
     * broken promise rather than a broken warning. `too_far` is the class
     * auto-pick refuses outright and the scheduler's daily caps refuse again, so
     * a positive detour verdict on one recommends a stop nothing downstream will
     * ever schedule. It used to say "worth it if this is your thing" the moment
     * the place was a top pick.
     */
    for (const band of WORKABLE_BANDS) {
      expect(
        worthDetourLabel('too_far', band),
        `a ${band} past this trip's reach is offered to the traveller anyway`,
      ).toBe('too_far_for_this_trip');
    }
  });
});

// ---------------------------------------------------------------------------
// A walking figure pricing a traveller whose own mode nobody could measure
// ---------------------------------------------------------------------------

/**
 * THE TOKYO SKIP LIST, REBUILT AS A WORLD.
 *
 * Measured on the fresh Tokyo artifact (`region-25590a1e-…`): the trip is
 * scoped car-free, the compiler measured a pedestrian matrix, no transit
 * provider is configured, and `transitEvidence` reads
 * `{requested: 0, measured: 0, absence: 'unsupported'}`. Every board card
 * priced its journey "on foot from base", and the Probably-skip group told the
 * traveller "1 hr 42 min each way on foot is past how far you said you would
 * go" — over Yoyogi Park, in a city whose own pack records a hundred and seven
 * railway stations. The traveller stated a travel-time tolerance, not a
 * walking-time tolerance; pricing the whole city on foot and skipping what
 * walking cannot reach converts "we cannot see the trains" into "the trains do
 * not exist".
 *
 * The fixture walks are chosen so each rule bites unambiguously for the
 * transit-city traveller (walking tolerance 20, car-free transport day 150,
 * car-free detour radius 20 → stretch ceiling 30):
 *
 *   A  12 min walk  → inside tolerance, verdicts never move
 *   B  70 min walk  → past the radius, and the round trip (140) fits the day:
 *                     the *radius* verdict is the only refusal, priced on foot
 *   C 120 min walk  → the round trip (240) is past what any day of this trip
 *                     holds; even the measured walk cannot fit, whatever the
 *                     trains do
 */
function blindFootMatrix(walkToB = 70) {
  const walks: Record<string, { minutes: number; km: number }> = {
    [TRANSIT_CITY_IDENTITY.candidateA]: { minutes: 12, km: 1 },
    [TRANSIT_CITY_IDENTITY.candidateB]: { minutes: walkToB, km: 5 },
    [TRANSIT_CITY_IDENTITY.candidateC]: { minutes: 120, km: 9 },
  };
  const ids = [TRANSIT_CITY_IDENTITY.baseId, ...Object.keys(walks)];
  const between = (from: string, to: string, field: 'minutes' | 'km'): number => {
    if (from === to) return 0;
    const other = from === TRANSIT_CITY_IDENTITY.baseId ? to : from;
    return walks[other]?.[field] ?? 0;
  };
  return {
    mode: 'foot' as const,
    ids,
    minutes: ids.map((from) => ids.map((to) => between(from, to, 'minutes'))),
    km: ids.map((from) => ids.map((to) => between(from, to, 'km'))),
    provenance: {
      kind: 'measured' as const,
      note: 'Fixture pedestrian network, measured by construction.',
      source: 'packages/core/src/region/expansion.test.ts',
    },
  };
}

/** The build's own record that nothing in it could time a scheduled journey. */
function transitNeverMeasured(): TransitEvidence {
  return { journeys: [], requested: 0, measured: 0, absence: 'unsupported' };
}

function blindBoard(scheduledNetwork?: 'observed' | 'not_observed', walkToB?: number) {
  const traveler = transitCityTraveler();
  const board = buildDiscoveryBoard({
    ...transitCityBoardInput(traveler),
    travel: {
      matrix: blindFootMatrix(walkToB),
      transit: transitNeverMeasured(),
      baseId: TRANSIT_CITY_IDENTITY.baseId,
      ...(scheduledNetwork ? { scheduledNetwork } : {}),
    },
  });
  const of = (id: string) => board.candidates.find((entry) => entry.place.id === id)!;
  return { traveler, board, of };
}

describe('a walk pricing a transit traveller, where nothing could see the trains', () => {
  it('holds the walking verdicts where no scheduled network was observed', () => {
    /*
     * The control, pinned against the outputs the board produced *before* the
     * transit-blind gate existed, so any drift in the genuinely walk-only world
     * fails loudly. In a world without a scheduled network — or where nobody
     * said there is one — a seventy-minute walk past a twenty-minute radius is
     * exactly what the card says it is, and the skip verdict stands.
     */
    for (const world of [undefined, 'not_observed' as const]) {
      const { traveler, board, of } = blindBoard(world);
      const b = of(TRANSIT_CITY_IDENTITY.candidateB);

      expect(b.detourClass, 'the walking distance verdict must stand').toBe('too_far');
      expect(b.travelMinutesFromBase).toBe(70);
      expect(b.travelModeFromBase).toBe('walk');
      expect(b.worthDetour).toBe('too_far_for_this_trip');
      expect(b.quality.outcome).toBe('not_worth_detour');
      expect(b.quality.reason).toMatch(/each way on foot is past how far you said you would go/);
      expect(b.group).toBe('weak_fit');

      const auto = autoSelect({ candidates: board.candidates, profile: traveler, tripDays: 3 });
      expect(
        auto.excluded.some(
          (entry) =>
            entry.placeId === TRANSIT_CITY_IDENTITY.candidateB &&
            entry.reason === 'travel_budget',
        ),
        'auto-pick must keep refusing the walk for distance in a walk-only world',
      ).toBe(true);
    }
  });

  it('does not auto-skip for distance when the trains exist and nobody could time them', () => {
    /*
     * The fix itself. The traveller chose public transport, the compilation
     * signed — in its own artifact — that nothing could measure a scheduled
     * journey, and the destination evidence observes a scheduled network. A
     * seventy-minute walking figure is then a fact about the fallback network,
     * not about how far away the place is for this traveller: the honest
     * verdict is that the transit route is unverified, the walk figure stays a
     * walk figure, and the card stays selectable.
     */
    const { traveler, board, of } = blindBoard('observed');
    const b = of(TRANSIT_CITY_IDENTITY.candidateB);

    expect(b.detourClass, 'a radius refusal priced on foot must become unknown').toBe('unknown');
    /* The measured walk survives, as a walk. Never erased, never relabelled. */
    expect(b.travelMinutesFromBase).toBe(70);
    expect(b.travelModeFromBase).toBe('walk');
    expect(b.reach.status).toBe('measured');
    expect(b.worthDetour).toBe('reach_unverified');
    /* No distance verdict from a number that is not the traveller's mode. */
    expect(b.quality.outcome).not.toBe('not_worth_detour');
    expect(b.quality.reason).not.toMatch(/past how far you said you would go/);
    expect(b.group).not.toBe('weak_fit');

    const auto = autoSelect({ candidates: board.candidates, profile: traveler, tripDays: 3 });
    expect(
      auto.excluded.some(
        (entry) =>
          entry.placeId === TRANSIT_CITY_IDENTITY.candidateB && entry.reason === 'travel_budget',
      ),
      'auto-pick refused for distance a journey nobody established',
    ).toBe(false);
  });

  it('never overrides the traveller’s own day budget, whatever the network', () => {
    /*
     * The boundary that keeps this from recreating Phase 9. C's walk is 120
     * minutes each way — past what any day of this trip holds even before a
     * train is imagined — and the planner's daily caps, which are settled,
     * would refuse it on the same arithmetic. Softening it would put a card on
     * the board that the plan must always take back.
     */
    const { of } = blindBoard('observed');
    const c = of(TRANSIT_CITY_IDENTITY.candidateC);
    expect(c.detourClass).toBe('too_far');
    expect(c.worthDetour).toBe('too_far_for_this_trip');
  });

  /**
   * THE SEAT SIZE THE LIVE FAILURE WAS MADE OF, AT BOTH VERDICTS.
   *
   * Forty-five minutes is the middle of the range two live car-free
   * dense-metro boards actually produced: thirty-nine to seventy measured
   * walking minutes to every canonical seat, because no transit provider was
   * configured and the matrix therefore priced the pedestrian network. Each one
   * was refused against "twenty-five minutes is the furthest you would walk to
   * reach a stop" — an answer about the last mile from a stop, standing in for
   * a whole-journey verdict, on a walk the traveller was never going to take.
   */
  it('passes no walking-radius refusal on a stand-in walk, and still passes one on a real walk', () => {
    const traveler = transitCityTraveler();
    const walkingRadius = detourToleranceMinutesFor(traveler, 'walk');
    const rideBound = detourToleranceMinutesFor(traveler, 'walk', { transitUnmeasured: true });
    /* The fixture is only a witness if the two bounds actually differ here. */
    expect(45).toBeGreaterThan(walkingRadius * DETOUR_STRETCH_MULTIPLIER);
    expect(45).toBeLessThanOrEqual(rideBound);

    /* Trains on the ground, none in the evidence: no distance verdict at all. */
    const blind = blindBoard('observed', 45).of(TRANSIT_CITY_IDENTITY.candidateB);
    expect(blind.detourClass).toBe('unknown');
    expect(blind.worthDetour).toBe('reach_unverified');
    expect(blind.quality.outcome).not.toBe('not_worth_detour');
    expect(blind.quality.reason).not.toMatch(/past how far you said you would go/);
    /* The measured walk survives on the card, as the walk it is. */
    expect(blind.travelMinutesFromBase).toBe(45);
    expect(blind.travelModeFromBase).toBe('walk');

    /*
     * And the control, which is the same walk in a world with no scheduled
     * network to stand in for: the walking verdict is the honest one and the
     * refusal stands.
     */
    const genuine = blindBoard('not_observed', 45).of(TRANSIT_CITY_IDENTITY.candidateB);
    expect(genuine.detourClass).toBe('too_far');
    expect(genuine.worthDetour).toBe('too_far_for_this_trip');
  });

  it('says a measured ride is a ride, with no unverified copy anywhere near it', () => {
    /*
     * The third direction: where a journey planner did answer, the measured
     * ride is the story and the unverified-transit verdict must not appear.
     * This is the untouched transit-city world — pedestrian matrix, measured
     * train to B — and the settled semantics it encodes.
     */
    const traveler = transitCityTraveler();
    const board = buildDiscoveryBoard(transitCityBoardInput(traveler));
    const b = board.candidates.find(
      (entry) => entry.place.id === TRANSIT_CITY_IDENTITY.candidateB,
    )!;

    expect(b.travelModeFromBase).toBe('rail');
    expect(b.travelMinutesFromBase).toBe(TRANSIT_CITY_JOURNEYS.transitToB);
    expect(b.detourClass).not.toBe('unknown');
    expect(b.quality.reason).not.toMatch(/could not verify the transit route/i);
  });
});
