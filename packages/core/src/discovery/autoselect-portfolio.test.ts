import { describe, expect, it } from 'vitest';
import { autoSelect } from './autoselect';
import { boardOrderingOf, buildDiscoveryBoard, type DiscoveryCandidate } from './board';
import { worthDetourLabel, type DetourClass } from '../region/expansion';
import type { PlaceCategory } from '../schemas/common';
import type { Place } from '../schemas/place';
import type { FitBand } from '../scoring/fit';
import type { TransportMode } from '../schemas/access';
import {
  AUGUST_DATES,
  MAMMOTH_HIKER_ANSWERS,
  boardContext,
  context,
  profile,
  transitCityBoardInput,
  transitCityTraveler,
} from '../testing/fixtures';
import { detourToleranceMinutesFor, DETOUR_STRETCH_MULTIPLIER } from '../travel/reach';

/**
 * AUTO-PICK COMPOSES A PORTFOLIO; IT DOES NOT RANK A LIST.
 *
 * The defect these tests exist to catch, reproduced on a live Tokyo board: every
 * candidate scored within a point or two of the others, selection took strictly
 * the top N, and the traveller was handed six stops twenty-plus minutes away by
 * train while a stop fifteen minutes' walk from the bed sat unselected. Nothing
 * in the code was wrong in the sense of throwing; the ordering simply had no
 * opinion about travel burden, repetition or spread, which §10.7 says it must.
 *
 * The candidates here are *derived from a real board* rather than hand-built, so
 * every field a candidate carries is a field the board actually produces — a
 * synthetic literal would drift from the type the moment either changed, and the
 * assertions below are about ordering rather than about any one field's value.
 */

const REAL = (() => {
  const built = profile(MAMMOTH_HIKER_ANSWERS, context({ tripDays: 4 }));
  const board = buildDiscoveryBoard({ ...boardContext(AUGUST_DATES), profile: built, travelerNeeds: [] });
  const template = board.candidates.find(
    (candidate) => candidate.reach.status === 'measured' && candidate.detourClass === 'in_tolerance',
  );
  if (!template) throw new Error('the authored region no longer produces a measured candidate');
  return { profile: built, template };
})();

/**
 * One candidate that differs from a real one only in the ways under test.
 *
 * Score is pinned equal across every variant by default, on purpose: the whole
 * question is what happens when the scorer cannot separate two places, which on
 * a real board is most pairs. `score` and `significance` are there for the two
 * tests that are *about* a difference rather than about a tie.
 */
function variant(input: {
  id: string;
  minutes: number;
  category: PlaceCategory;
  lat: number;
  lng: number;
  score?: number;
  band?: FitBand;
  significance?: number;
}): DiscoveryCandidate {
  const { template } = REAL;
  if (template.reach.status !== 'measured') throw new Error('template lost its measured reach');
  /*
   * Interests follow the variant's category rather than the template's. Every
   * variant used to inherit the one template place's interests, which was
   * harmless while the frequency ledger charged one interest per stop — and a
   * false premise once the shared ledger (§29 G) charged every asked-for
   * interest a stop serves: sixteen "different" candidates all spending the
   * same two ceilings is a board that is *supposed* to stop at the ceiling,
   * not a fixture for testing variety. A museum is not a hike, and its
   * interests must not be one.
   */
  const INTERESTS_BY_CATEGORY: Partial<Record<PlaceCategory, Place['interests']>> = {
    easy_walk: ['easy_nature_walks'],
    viewpoint: ['scenic_viewpoints'],
    lake: ['lakes_and_rivers'],
    museum: ['history_and_culture'],
  };
  const place = {
    ...template.place,
    id: input.id,
    name: input.id,
    category: input.category,
    interests: INTERESTS_BY_CATEGORY[input.category] ?? template.place.interests,
    coordinates: { lat: input.lat, lng: input.lng },
    hiddenGemScore: 0.3,
    popularityScore: 0.3,
    ...(input.significance === undefined ? {} : { experienceSignificance: input.significance }),
  };
  const fit = {
    ...template.fit,
    placeId: input.id,
    score: input.score ?? 90,
    band: input.band ?? ('top_pick' as FitBand),
  };
  return {
    ...template,
    place,
    fit,
    // Recomputed rather than inherited: a candidate whose ordering key described
    // a different place is a fixture that lies about the type it claims to be.
    ordering: boardOrderingOf({ place, fit }),
    travelMinutesFromBase: input.minutes,
    reach: {
      ...template.reach,
      travelMinutes: input.minutes,
      returnMinutes: input.minutes,
      roundTripMinutes: input.minutes * 2,
    },
  };
}

function selectFrom(candidates: DiscoveryCandidate[], tripDays = 3) {
  return autoSelect({ candidates, profile: REAL.profile, tripDays });
}

/**
 * One candidate sitting at a chosen distance class and fit band, carrying the
 * card the board would actually print for that pair.
 *
 * `worthDetour` is recomputed through `worthDetourLabel` rather than inherited
 * from the template, because the label is the thing under test: copying the
 * template's would test that a string survives a spread.
 */
function cell(detourClass: DetourClass, band: FitBand): DiscoveryCandidate {
  const { template } = REAL;
  if (template.reach.status !== 'measured') throw new Error('template lost its measured reach');
  const id = `${detourClass}-${band}`;
  const measured = detourClass !== 'unknown';
  const place = { ...template.place, id, name: id };
  const fit = { ...template.fit, placeId: id, band };
  return {
    ...template,
    place,
    fit,
    ordering: boardOrderingOf({ place, fit }),
    detourClass,
    /*
     * A short, comfortably affordable journey on every cell, so the only thing
     * that can refuse one is the rule under test rather than the travel budget
     * incidentally running out. `unknown` is the one class defined by the
     * *absence* of a measurement, so it gets none: a candidate carrying both an
     * unresolved journey and a duration is a shape no board produces, and a
     * sweep built on one would prove nothing about the board.
     */
    travelMinutesFromBase: measured ? 20 : null,
    travelModeFromBase: measured ? template.travelModeFromBase : null,
    reach: measured
      ? { ...template.reach, travelMinutes: 20, returnMinutes: 20, roundTripMinutes: 40 }
      : {
          baseId: template.reach.baseId,
          candidateId: id,
          status: 'unmeasured',
          reachable: null,
          conflict: false,
          reason: 'no_route_found',
          detail: 'No provider answered for this pair.',
        },
    worthDetour: worthDetourLabel(detourClass, band),
  };
}

describe('auto-pick portfolio', () => {
  it('prefers the stop next door to a further one the scorer cannot separate from it', () => {
    /*
     * The live Tokyo shape: one near stop, six far ones, identical scores. Top-N
     * takes the six far ones and leaves the near one; a portfolio does not.
     */
    const nearby = variant({ id: 'near', minutes: 15, category: 'easy_walk', lat: 37.6, lng: -119.0 });
    const far = Array.from({ length: 6 }, (_, index) =>
      variant({
        id: `far-${index}`,
        minutes: 22 + index,
        category: 'easy_walk',
        lat: 37.9 + index * 0.01,
        lng: -119.4 - index * 0.01,
      }),
    );

    // The far stops are offered first, so a selector that respects input order
    // rather than value would fail this outright.
    const selection = selectFrom([...far, nearby]);
    expect(selection.selectedIds).toContain('near');
  });

  it('spreads picks across kinds of thing rather than repeating the highest-scoring one', () => {
    const categories: PlaceCategory[] = ['easy_walk', 'viewpoint', 'lake', 'museum'];
    const candidates = categories.flatMap((category, categoryIndex) =>
      Array.from({ length: 4 }, (_, index) =>
        variant({
          id: `${category}-${index}`,
          // Distance is held constant so the only axis left is variety.
          minutes: 20,
          category,
          lat: 37.6 + categoryIndex * 0.2,
          lng: -119.0 - index * 0.2,
        }),
      ),
    );

    const selection = selectFrom(candidates);
    const kinds = new Set(
      selection.selectedIds.map((id) => id.slice(0, id.lastIndexOf('-'))),
    );
    expect(selection.selectedIds.length).toBeGreaterThan(2);
    expect(kinds.size).toBeGreaterThan(1);
  });

  it('spreads picks across the map rather than filling one pocket of it', () => {
    /*
     * Two clusters, one of them large. Everything scores the same and everything
     * is the same distance from base, so nothing but geography can decide — and
     * a selector with no geography term would take the big cluster whole.
     */
    const crowded = Array.from({ length: 8 }, (_, index) =>
      variant({
        id: `crowded-${index}`,
        minutes: 20,
        category: index % 2 === 0 ? 'easy_walk' : 'viewpoint',
        lat: 37.6 + index * 0.0001,
        lng: -119.0 + index * 0.0001,
      }),
    );
    const elsewhere = Array.from({ length: 2 }, (_, index) =>
      variant({
        id: `elsewhere-${index}`,
        minutes: 20,
        category: index % 2 === 0 ? 'easy_walk' : 'viewpoint',
        lat: 38.4 + index * 0.0001,
        lng: -118.2 + index * 0.0001,
      }),
    );

    const selection = selectFrom([...crowded, ...elsewhere]);
    expect(selection.selectedIds.some((id) => id.startsWith('elsewhere'))).toBe(true);
  });

  it('always says what it did, even when nothing went wrong', () => {
    /*
     * The observed failure: pressing "choose for me" changed some borders far
     * down a very long page and produced no sentence at all. An unexplained
     * decision made on somebody's behalf is not an intelligent one.
     */
    const candidates = Array.from({ length: 5 }, (_, index) =>
      variant({
        id: `place-${index}`,
        minutes: 15 + index,
        category: index % 2 === 0 ? 'easy_walk' : 'viewpoint',
        lat: 37.6 + index * 0.1,
        lng: -119.0 - index * 0.1,
      }),
    );

    const selection = selectFrom(candidates);
    expect(selection.selectedIds.length).toBeGreaterThan(0);
    expect(selection.notes.length).toBeGreaterThan(0);
    expect(selection.notes.join(' ')).toMatch(/^We picked \d+ place/);
  });

  it('never pre-selects a place whose own card tells the traveller not to go', () => {
    /**
     * THE BOARD AND THE PLAN, ON THE SAME PLACE, ON THE SAME SCREEN.
     *
     * Auto-pick accepts exactly one stop past the stated detour tolerance and
     * announces it — "one pick sits past your usual detour limit because it
     * earned the extra journey". The card for that stop was decided by
     * `worthDetourLabel`, which read the *fit band* to reach a *distance*
     * verdict, so a `stretch` at band `good` came back "Too far for this trip".
     * On the remote-road world that pair landed on the itinerary with its own
     * card telling the traveller not to go.
     *
     * The sweep is the whole grid rather than that one pair, because the fault
     * was a rule and not a cell: every distance class against every band, each
     * offered to auto-pick on its own so that acceptance is decided by the cell
     * under test rather than by whichever other cell reached a shared ceiling
     * first.
     */
    const classes: DetourClass[] = ['base', 'in_tolerance', 'stretch', 'too_far', 'unknown'];
    const bands: FitBand[] = ['top_pick', 'strong', 'good', 'optional', 'weak', 'not_workable'];

    const accepted: DiscoveryCandidate[] = [];
    for (const detourClass of classes) {
      for (const band of bands) {
        const candidate = cell(detourClass, band);
        if (selectFrom([candidate]).selectedIds.includes(candidate.place.id)) {
          accepted.push(candidate);
        }
      }
    }

    expect(
      accepted
        .filter((candidate) => candidate.worthDetour === 'too_far_for_this_trip')
        .map((candidate) => candidate.place.id),
      'auto-pick would put these on the trip while their cards say they are too far to visit',
    ).toEqual([]);
    /*
     * And the sweep has to have reached the case that matters. A run in which
     * auto-pick accepted no `stretch` at all would pass this vacuously, and the
     * one-stop-past-tolerance allowance is documented behaviour.
     */
    expect(
      accepted.some((candidate) => candidate.detourClass === 'stretch'),
      'the sweep never got auto-pick to accept a stop past the tolerance, so it proved nothing',
    ).toBe(true);
  });

  it('takes the stop that matters over the one beside it the scorer cannot separate', () => {
    /*
     * §16B, in the pre-selection rather than in the list. Two stops with the
     * same score, the same category, the same distance and coordinates a few
     * metres apart, so nothing but standing can decide between them.
     */
    const known = variant({
      id: 'known',
      minutes: 20,
      category: 'viewpoint',
      lat: 37.6,
      lng: -119.0,
      significance: 0.8,
    });
    const anonymous = variant({
      id: 'anonymous',
      minutes: 20,
      category: 'viewpoint',
      lat: 37.6001,
      lng: -119.0001,
      significance: 0.2,
    });

    // Offered worse-first, so input order cannot produce the result. Both fit
    // inside the slots, so what is under test is which one was reached for
    // first — the order of the greedy pass is the preference it expresses.
    const selection = selectFrom([anonymous, known], 2);
    expect(selection.selectedIds).toHaveLength(2);
    expect(selection.selectedIds[0]).toBe('known');
  });

  it('does not let standing overturn a materially better fit', () => {
    /**
     * THE GUARD ON THE LINE ABOVE, AND THE REASON `SIGNIFICANCE_PULL` IS A TENTH.
     *
     * The board bounds significance structurally — the fit band is the outer
     * sort key, so nothing crosses one. This pass has no such gate, so the bound
     * is numeric: the full width of the significance scale is worth ten points
     * of fit, which is the narrowest gap between two adjacent bands. Standing
     * orders candidates the scorer rates alike and stops there.
     *
     * Twenty points apart is two of those, so the well-matched stop has to win
     * even against total canonical significance. Otherwise the first destination
     * where recall improved would hand every traveller the same famous list —
     * §7's flood, arriving by way of the fix for §9's ranking.
     */
    const famous = variant({
      id: 'famous-but-wrong',
      minutes: 20,
      category: 'viewpoint',
      lat: 37.6,
      lng: -119.0,
      score: 70,
      band: 'good',
      significance: 1,
    });
    const suited = variant({
      id: 'quietly-right',
      minutes: 20,
      category: 'viewpoint',
      lat: 37.6001,
      lng: -119.0001,
      score: 90,
      significance: 0,
    });

    const selection = selectFrom([famous, suited], 2);
    expect(selection.selectedIds).toHaveLength(2);
    expect(selection.selectedIds[0]).toBe('quietly-right');
  });

  it('does not flood the pre-selection with the established places once recall improves', () => {
    /**
     * §7, stated as the shape this change could plausibly have broken.
     *
     * Eight canonically significant stops of one kind in one pocket of the map,
     * two unremarkable ones of another kind elsewhere. Ranked by standing the
     * answer is eight of the first and none of the second, and the traveller
     * gets a day of the same thing in the same street. A portfolio reaches the
     * other side of the map and the other kind of thing anyway, because variety
     * and spread are dimensions of their own rather than tie-breaks under
     * significance.
     */
    const established = Array.from({ length: 8 }, (_, index) =>
      variant({
        id: `established-${index}`,
        minutes: 20,
        category: 'museum',
        lat: 37.6 + index * 0.0001,
        lng: -119.0 + index * 0.0001,
        significance: 0.9,
      }),
    );
    const elsewhere = Array.from({ length: 2 }, (_, index) =>
      variant({
        id: `elsewhere-${index}`,
        minutes: 20,
        category: 'easy_walk',
        lat: 38.4 + index * 0.0001,
        lng: -118.2 + index * 0.0001,
        significance: 0.2,
      }),
    );

    const selection = selectFrom([...established, ...elsewhere]);
    expect(selection.selectedIds.length).toBeGreaterThan(2);
    expect(
      selection.selectedIds.some((id) => id.startsWith('elsewhere')),
      'every pick came from the one significant cluster, which is a ranked list rather than a trip',
    ).toBe(true);
    expect(new Set(selection.stats.byCategory ? Object.keys(selection.stats.byCategory) : []).size)
      .toBeGreaterThan(1);
  });

  it('stays deterministic: the same board and profile give the same set', () => {
    const candidates = Array.from({ length: 9 }, (_, index) =>
      variant({
        id: `place-${index}`,
        minutes: 12 + index * 3,
        category: (['easy_walk', 'viewpoint', 'lake'] as PlaceCategory[])[index % 3]!,
        lat: 37.6 + index * 0.05,
        lng: -119.0 - index * 0.05,
      }),
    );

    expect(selectFrom(candidates).selectedIds).toEqual(selectFrom(candidates).selectedIds);
  });
});

/**
 * AUTO-PICK MAY NOT SPEND A SLOT ON A LEG THE PLANNER WILL REFUSE.
 *
 * The evidence class: a traveller with no car in a dense transit metropolis,
 * where no transit provider is configured, so the compiled matrix prices every
 * journey on foot. Two live trips, each a twenty-four-card board — one chose
 * five seats and had one laid, the other chose eight and had two laid, and every
 * refusal on both was the same measured walk of thirty-nine to sixty-six minutes
 * against a stated twenty-five. The board was honest throughout: the card said
 * the transit route could not be verified and named the walk. Only the
 * pre-selection was wrong, and it was wrong from data it already held.
 *
 * The traveller for these is the car-free fixture, whose walking answer is the
 * whole arithmetic: the planner lays a measured walk within
 * `detourToleranceMinutesFor(profile, 'walk') × DETOUR_STRETCH_MULTIPLIER` and
 * refuses one past it, so the pre-selection is held to exactly that bound.
 */
const CARLESS = (() => {
  const built = transitCityTraveler();
  const board = buildDiscoveryBoard(transitCityBoardInput(built));
  const template = board.candidates.find(
    (candidate) =>
      candidate.detourClass !== 'base' &&
      candidate.reach.status === 'measured' &&
      candidate.reach.mode === 'walk',
  );
  if (!template) throw new Error('the car-free fixture no longer produces a measured walk');
  return { profile: built, template, walkCap: detourToleranceMinutesFor(built, 'walk') };
})();

/**
 * One real card whose journey is replaced by the leg under test.
 *
 * Derived from a board the fixture actually builds rather than hand-written, for
 * the reason `variant` above states: every other field then holds whatever the
 * board puts there, so nothing but the journey can decide the outcome. The
 * distance class is given rather than recomputed because it is an *input* to the
 * pre-selection here — the classifier's own verdicts have their own tests.
 */
function leg(input: {
  id: string;
  minutes: number;
  mode: TransportMode;
  detourClass: DetourClass;
}): DiscoveryCandidate {
  const { template } = CARLESS;
  if (template.reach.status !== 'measured') throw new Error('template lost its measured reach');
  const place = { ...template.place, id: input.id, name: input.id };
  const fit = { ...template.fit, placeId: input.id };
  return {
    ...template,
    place,
    fit,
    ordering: boardOrderingOf({ place, fit }),
    detourClass: input.detourClass,
    travelMinutesFromBase: input.minutes,
    travelModeFromBase: input.mode,
    reach: {
      ...template.reach,
      mode: input.mode,
      travelMinutes: input.minutes,
      returnMinutes: input.minutes,
      roundTripMinutes: input.minutes * 2,
    },
  };
}

describe('auto-pick and the walk the planner will not lay', () => {
  /** Past the planner's acceptance band, and comfortably inside every budget. */
  const PAST_THE_ANSWER = Math.ceil(CARLESS.walkCap * DETOUR_STRETCH_MULTIPLIER) + 15;
  /** The far edge of the same band: the longest walk the planner still lays. */
  const INSIDE_THE_BAND = Math.floor(CARLESS.walkCap * DETOUR_STRETCH_MULTIPLIER);

  function selectOne(candidate: DiscoveryCandidate) {
    return autoSelect({ candidates: [candidate], profile: CARLESS.profile, tripDays: 3 });
  }

  it('leaves a stop whose only measured journey is a walk past the planner’s bound', () => {
    /*
     * The defect itself: `unknown` is not `too_far`, the reach is measured, so
     * every existing rule admitted a leg the plan then refused — which is a board
     * that promises and a planner that takes it back.
     */
    const candidate = leg({
      id: 'only-a-long-walk',
      minutes: PAST_THE_ANSWER,
      mode: 'walk',
      detourClass: 'unknown',
    });

    const selection = selectOne(candidate);
    expect(selection.selectedIds).not.toContain('only-a-long-walk');
    expect(
      selection.excluded.find((entry) => entry.placeId === 'only-a-long-walk')?.reason,
    ).toBe('walk_too_long');
    expect(
      selection.notes.some((note) => /walk longer than you said you would go on foot/.test(note)),
      'a pass left thin by this refusal has to say so once',
    ).toBe(true);
  });

  it('still pre-selects a walk inside the band, which is the leg the planner lays', () => {
    /*
     * The guard against over-refusal, and the reason the bound is the shared
     * constant rather than the raw answer. `resolvePlannerLeg` accepts a measured
     * walk out to the stretch band; refusing it here would empty the
     * pre-selection of exactly the car-free town trips this rule exists to
     * protect, and for the same reason the rule exists: two verdicts about one
     * journey.
     */
    const candidate = leg({
      id: 'a-walk-we-will-make',
      minutes: INSIDE_THE_BAND,
      mode: 'walk',
      detourClass: 'stretch',
    });

    expect(selectOne(candidate).selectedIds).toContain('a-walk-we-will-make');
  });

  it('exempts a place at the base, where there is no journey to verify', () => {
    /*
     * Same exemption as the rules beside it. A base-area stop carries whatever
     * the matrix measured between two points in the same town, and refusing one
     * on that figure would empty the pre-selection of a trip whose every stop is
     * on the doorstep.
     */
    const candidate = leg({
      id: 'on-the-doorstep',
      minutes: PAST_THE_ANSWER,
      mode: 'walk',
      detourClass: 'base',
    });

    expect(selectOne(candidate).selectedIds).toContain('on-the-doorstep');
  });

  /**
   * AND THE SAME WALK, WHERE IT IS ONLY STANDING IN FOR A TRAIN.
   *
   * The live boards this rule was written from are exactly this shape: a
   * scheduled network on the ground, nothing in the build able to time it, and a
   * pedestrian matrix pricing every seat at thirty-nine to seventy minutes on
   * foot. Bounding those by the walking answer is what left five picks with one
   * scheduled stop and eight with two. The traveller rides; the bound is the
   * ride budget, which is the bound `modelledWalkCapMinutes` hands the planner
   * for the same board, so neither surface can refuse what the other promises.
   */
  it('takes a stand-in walk the planner will lay, and refuses the same walk where it is real', () => {
    const candidate = leg({
      id: 'a-train-we-could-not-time',
      minutes: PAST_THE_ANSWER,
      mode: 'walk',
      detourClass: 'unknown',
    });
    const rideBound = detourToleranceMinutesFor(CARLESS.profile, 'walk', {
      transitUnmeasured: true,
    });
    /* The fixture is only a witness while the two bounds disagree about it. */
    expect(PAST_THE_ANSWER).toBeGreaterThan(CARLESS.walkCap * DETOUR_STRETCH_MULTIPLIER);
    expect(PAST_THE_ANSWER).toBeLessThanOrEqual(rideBound * DETOUR_STRETCH_MULTIPLIER);

    expect(
      autoSelect({
        candidates: [candidate],
        profile: CARLESS.profile,
        tripDays: 3,
        transitUnmeasured: true,
      }).selectedIds,
    ).toContain('a-train-we-could-not-time');

    /*
     * The control, and the default. Where nothing establishes that a scheduled
     * network went unmeasured, the walk is the journey and the refusal stands —
     * a board that cannot establish the gap does not get to widen anything on
     * the strength of it.
     */
    expect(selectOne(candidate).selectedIds).not.toContain('a-train-we-could-not-time');
    expect(
      autoSelect({
        candidates: [candidate],
        profile: CARLESS.profile,
        tripDays: 3,
        transitUnmeasured: false,
      }).excluded.find((entry) => entry.placeId === 'a-train-we-could-not-time')?.reason,
    ).toBe('walk_too_long');
  });

  it('does not bound a train by walking arithmetic', () => {
    /*
     * The other half of the same evidence class: on these boards a ride is the
     * journey the traveller would actually make, and the walking answer says
     * nothing about it. A rule that read the minutes without reading the mode
     * would refuse the metro seats too, which is the original defect with the
     * sign flipped.
     */
    const candidate = leg({
      id: 'twenty-minutes-underground',
      minutes: PAST_THE_ANSWER,
      mode: 'rail',
      detourClass: 'in_tolerance',
    });

    expect(selectOne(candidate).selectedIds).toContain('twenty-minutes-underground');
  });
});
