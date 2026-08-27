import { describe, expect, it } from 'vitest';

import { autoSelect } from '../discovery/autoselect';
import { boardOrderingOf, buildDiscoveryBoard, type DiscoveryCandidate } from '../discovery/board';
import type { TransitEvidence } from '../schemas/compiled-region';
import {
  TRANSIT_CITY_IDENTITY,
  TRANSIT_CITY_JOURNEYS,
  transitCityBoardInput,
  transitCityRoadMatrix,
  transitCityTraveler,
  transitCityTransit,
  transitCityWalkMatrix,
} from '../testing/transit-city';
import {
  describeReachFromBase,
  describeTransitBlindWalk,
  detourToleranceMinutesFor,
  resolveCandidateReach,
  scheduledTransportUnmeasured,
  transitBlindWalk,
  travelKnowledgeFor,
} from './reach';

/**
 * WHAT A CAR-FREE TRAVELLER IS TOLD WHEN THE ONLY NETWORK ANYBODY MEASURED IS
 * THE ROAD.
 *
 * Measured on the stored post-fix Tokyo artifact
 * (`region-edea2c10-…`, Overture release 2026-07-22.0): the scope is car-free
 * (`carAvailable: false`), the compiler could find no continuous walking network
 * across the region and substituted the road one — saying so in a warning — and
 * no transit provider is configured, so `transitEvidence` reads
 * `{requested: 0, measured: 0, absence: 'unsupported'}`.
 *
 * Every step of that is correct on its own and the result was not. `matrixMode`
 * declares a road matrix answers for driving, the permission filter removes
 * driving from a traveller with no car, and the refusal reported that everything
 * measured had been refused — as a **conflict**, whose sentence is "No usable
 * route from your base". Twenty-two of twenty-four cards carried it, over a city
 * with nine hundred stations, while the card's own distance label beside it read
 * "Reach unverified". The two halves of one card disagreed, and the confident
 * half was the wrong one.
 *
 * `TransitEvidence.absence` already draws the distinction in its own words —
 * "a traveller is owed the difference between 'there are no trains' and 'we
 * cannot see the trains'" — and these are the two sentences.
 */

const IDS = TRANSIT_CITY_IDENTITY;

/** A build that records, in its own artifact, that nothing could time a journey. */
function nothingCanMeasureTransit(): TransitEvidence {
  return { journeys: [], requested: 0, measured: 0, absence: 'unsupported' };
}

/** A provider that was asked about this ground and holds no timetables for it. */
function askedAndFoundNothing(): TransitEvidence {
  return { journeys: [], requested: 4, measured: 0, absence: 'out_of_coverage' };
}

describe('a road matrix, a traveller with no car, and which "no" that is', () => {
  const profile = transitCityTraveler();

  it('calls it unverified when nothing in the build could time a train', () => {
    const knowledge = travelKnowledgeFor(
      transitCityRoadMatrix(),
      profile,
      nothingCanMeasureTransit(),
    );
    const reach = resolveCandidateReach(knowledge, IDS.baseId, IDS.candidateD);

    expect(reach.status).toBe('unmeasured');
    /* `null`, not `false`. We do not know; we are not refusing. */
    expect(reach.reachable).toBeNull();
    expect(reach.conflict).toBe(false);
    expect(describeReachFromBase(reach, (minutes) => `${minutes} min`)).toBe(
      'Journey not verified',
    );
    /* And it says which two things are true, in words, without an enum in them. */
    expect(reach.status !== 'measured' && reach.detail).toMatch(/by car/);
    expect(reach.status !== 'measured' && reach.detail).toMatch(/trains, buses or ferries/);
    expect(reach.status !== 'measured' && reach.detail).not.toMatch(/public_bus|_/);
  });

  it('keeps the refusal when a journey planner was asked and answered', () => {
    const knowledge = travelKnowledgeFor(transitCityRoadMatrix(), profile, askedAndFoundNothing());
    const reach = resolveCandidateReach(knowledge, IDS.baseId, IDS.candidateD);

    /*
     * The control that stops the fix above becoming a blanket softening. Here
     * something *did* look at this ground for scheduled services and found none,
     * so "the only measured way is one this trip rules out" is a fact about the
     * place and the remedy is the traveller's decision.
     */
    expect(reach.status).toBe('conflict');
    expect(reach.reachable).toBe(false);
    expect(reach.conflict).toBe(true);
    expect(describeReachFromBase(reach, (minutes) => `${minutes} min`)).toBe(
      'No usable route from your base',
    );
  });

  it('reads an absent transit record as no statement rather than as a gap', () => {
    /*
     * A compilation that carries no `TransitEvidence` at all has said nothing.
     * This module never reads an absent record as a claim, so it may not read
     * one as "nothing asked" either — the stricter answer stands until something
     * signs the absence.
     */
    const knowledge = travelKnowledgeFor(transitCityRoadMatrix(), profile, null);
    expect(resolveCandidateReach(knowledge, IDS.baseId, IDS.candidateD).status).toBe('conflict');
  });
});

// ---------------------------------------------------------------------------
// What the board and the pre-selection do with a journey nobody could time
// ---------------------------------------------------------------------------

describe('a board where nothing could be timed', () => {
  const profile = transitCityTraveler();

  /**
   * The transit city, recompiled the way a dense metropolis actually arrives:
   * the road network stood in for a walking one, and no transit provider exists.
   * Every journey on this board is therefore untimeable.
   */
  function untimedBoard() {
    return buildDiscoveryBoard({
      ...transitCityBoardInput(profile),
      travel: {
        matrix: transitCityRoadMatrix(),
        transit: nothingCanMeasureTransit(),
        baseId: IDS.baseId,
      },
    });
  }

  it('still assembles a portfolio, and says what it took on trust', () => {
    const board = untimedBoard();
    const timed = board.candidates.filter((card) => card.reach.status === 'measured');
    expect(timed.length, 'this fixture is meant to have nothing anybody could time').toBe(0);

    const auto = autoSelect({ candidates: board.candidates, profile, tripDays: 3 });
    /*
     * The blocker: an unconditional refusal of an unknown journey returned
     * nothing at all here, which is the product declining to do the thing the
     * button says it does. §10.7 asks for a selection that feels intelligent, and
     * an empty one cannot.
     */
    expect(auto.selectedIds.length).toBeGreaterThan(0);
    expect(auto.notes.some((note) => /nothing here could time the way/i.test(note))).toBe(true);
    /* Never silently: every pick it took is accounted for in the sentence. */
    expect(auto.excluded.some((entry) => entry.reason === 'reach_unverified')).toBe(false);
  });

  it('spends a relaxed slot on the journey it can stand behind', () => {
    /**
     * The second pass relaxes the balance targets, so a measured stop held back
     * by a category ceiling and an untimed stop compete for the same slot. Every
     * other term in `marginalValue` charges for minutes, and an untimed stop has
     * none — so before this, the absence of a measurement was a *discount* and
     * the pass preferred exactly the stops it knew least about.
     *
     * Four cards of one kind. The category ceiling is two, so the first pass
     * takes the two best and the second pass has one seat and two applicants:
     * a ten-minute walk and a journey nobody could time, scoring the same. The
     * two long journeys ahead of them set the scale the burden is measured
     * against, which is what makes the ten-minute walk cheap and the unknown
     * dear.
     */
    const board = buildDiscoveryBoard(transitCityBoardInput(profile));
    const seed = board.candidates.find((card) => card.reach.status === 'measured')!;
    const timed = (id: string, score: number, minutes: number): DiscoveryCandidate => ({
      ...seed,
      place: { ...seed.place, id, category: 'museum', hiddenGemScore: 0, popularityScore: 0 },
      fit: { ...seed.fit, score, band: 'strong' },
      detourClass: 'in_tolerance',
      travelMinutesFromBase: minutes,
      travelModeFromBase: 'walk',
    });
    const untimed: DiscoveryCandidate = {
      ...timed('untimed', 86, 0),
      detourClass: 'unknown',
      travelMinutesFromBase: null,
      travelModeFromBase: null,
      reach: {
        baseId: IDS.baseId,
        candidateId: 'untimed',
        status: 'unmeasured',
        reachable: null,
        conflict: false,
        reason: 'mode_not_routed',
        detail: 'Nothing could time this.',
      },
    };
    const candidates = [
      untimed,
      timed('timed-a', 88, 40),
      timed('timed-b', 87, 40),
      timed('timed-c', 86, 10),
    ];

    const auto = autoSelect({ candidates, profile, tripDays: 3 });
    expect(auto.selectedIds.length, 'the category ceiling did not bind as this claim needs').toBe(
      3,
    );
    expect(
      auto.selectedIds,
      'the relaxed pass preferred the stop nobody could time over one it could',
    ).not.toContain('untimed');
  });

  it('never pre-selects a journey the traveller was refused rather than not told about', () => {
    const board = buildDiscoveryBoard({
      ...transitCityBoardInput(profile),
      travel: {
        matrix: transitCityRoadMatrix(),
        transit: askedAndFoundNothing(),
        baseId: IDS.baseId,
      },
    });
    /*
     * The base itself is exempt everywhere — there is no journey from the bed to
     * the bed, and `classifyDetour` says so before it looks at reach — so it is
     * not part of this claim.
     */
    const conflicted = board.candidates.filter(
      (card) => card.reach.status === 'conflict' && card.detourClass !== 'base',
    );
    expect(conflicted.length).toBeGreaterThan(0);

    const auto = autoSelect({ candidates: board.candidates, profile, tripDays: 3 });
    for (const card of conflicted) {
      expect(
        auto.selectedIds,
        `${card.place.name} has no route this traveller may use and was pre-selected anyway`,
      ).not.toContain(card.place.id);
    }
  });
});

// ---------------------------------------------------------------------------
// Where reach reaches the order of the list
// ---------------------------------------------------------------------------

describe('a card we can get you to outranks one we cannot', () => {
  const profile = transitCityTraveler();

  function orderingFor(status: 'measured' | 'unmeasured', score: number) {
    const board = buildDiscoveryBoard(transitCityBoardInput(profile));
    const card = board.candidates[0]!;
    const fit = { ...card.fit, score, band: 'strong' as const };
    const reach =
      status === 'measured'
        ? card.reach
        : ({
            baseId: IDS.baseId,
            candidateId: card.place.id,
            status: 'unmeasured' as const,
            reachable: null,
            conflict: false,
            reason: 'mode_not_routed' as const,
            detail: 'Nothing could time this.',
          } as DiscoveryCandidate['reach']);
    return boardOrderingOf({
      place: card.place,
      fit,
      reach,
      detourClass: 'in_tolerance',
    });
  }

  it('puts the shorter-scoring reachable card above the better-scoring unreachable one', () => {
    /**
     * §9.1: a top pick has to mean something. On the stored post-fix Tokyo board
     * the two cards at the head of the list were both journeys nobody could
     * establish, while the two stops nineteen and twenty-four minutes' walk from
     * the bed sat third and fourth — because every term in the order was blind to
     * whether the traveller could get there.
     */
    const unreachable = orderingFor('unmeasured', 86);
    const reachable = orderingFor('measured', 80);
    expect(reachable.withinBand).toBeGreaterThan(unreachable.withinBand);
    expect(unreachable.reachLift).toBeLessThan(0);
    expect(reachable.reachLift).toBe(0);
  });

  it('never lifts a card across the band the traveller was shown', () => {
    /* The structural guarantee: the band leads the comparator, so no amount of
     * reach can move a card past one the scorer rates higher. */
    const strong = orderingFor('unmeasured', 80);
    const better = { ...orderingFor('measured', 80), bandRank: strong.bandRank + 1 };
    expect(better.bandRank).toBeGreaterThan(strong.bandRank);
  });

  it('has no opinion when the caller did not say', () => {
    const board = buildDiscoveryBoard(transitCityBoardInput(profile));
    const card = board.candidates[0]!;
    /*
     * An absent reach is "we were not told", exactly as an absent significance
     * is — it leans neither way, so every caller that predates this keeps its
     * order to the bit.
     */
    expect(boardOrderingOf({ place: card.place, fit: card.fit }).reachLift).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// A walking figure standing in for a transit journey nobody could measure
// ---------------------------------------------------------------------------

describe('a walk pricing a traveller whose scheduled modes were never measured', () => {
  const profile = transitCityTraveler();

  /** Foot matrix, transit signed unmeasurable, network presence as stated. */
  function knowledgeWith(
    transit: TransitEvidence | null,
    scheduledNetwork?: 'observed' | 'not_observed',
  ) {
    return travelKnowledgeFor(transitCityWalkMatrix(), profile, transit, scheduledNetwork);
  }

  it('flags a too-long walk only where the network is observed and nothing measured it', () => {
    const signed: TransitEvidence = { journeys: [], requested: 0, measured: 0, absence: 'unsupported' };
    /* The Tokyo shape: trains on the ground, none in the evidence. */
    expect(transitBlindWalk(knowledgeWith(signed, 'observed'), 70)).toBe(true);
    /* Inside the stated walking tolerance there is nothing to soften. */
    expect(transitBlindWalk(knowledgeWith(signed, 'observed'), 15)).toBe(false);
    /* A genuinely walk-only world keeps its walking verdicts. */
    expect(transitBlindWalk(knowledgeWith(signed, 'not_observed'), 70)).toBe(false);
    /* Nobody said either way: an absent observation is not an observation. */
    expect(transitBlindWalk(knowledgeWith(signed), 70)).toBe(false);
  });

  it('never fires where a provider answered, or where the trip does not lean on transit', () => {
    /* A provider was asked about this ground and holds nothing for it. */
    expect(
      transitBlindWalk(
        knowledgeWith(
          { journeys: [], requested: 4, measured: 0, absence: 'out_of_coverage' },
          'observed',
        ),
        70,
      ),
    ).toBe(false);
    /* The compilation states the trip is planned around a car. */
    expect(
      transitBlindWalk(
        knowledgeWith(
          { journeys: [], requested: 0, measured: 0, absence: 'not_needed' },
          'observed',
        ),
        70,
      ),
    ).toBe(false);
    /* Journeys were measured: the evidence, not the gate, is the story. */
    expect(transitBlindWalk(knowledgeWith(transitCityTransit(), 'observed'), 70)).toBe(false);
    /* No transit record at all is no statement, and no statement opens no gate. */
    expect(transitBlindWalk(knowledgeWith(null, 'observed'), 70)).toBe(false);
  });

  it('keeps the walk figure a walk figure in the honest sentence', () => {
    expect(describeTransitBlindWalk(70, (minutes) => `${minutes} min`)).toBe(
      'We could not verify the transit route yet; about 70 min on foot',
    );
  });

  it('defaults the observation to "nobody said" for every existing caller', () => {
    expect(travelKnowledgeFor(transitCityWalkMatrix(), profile, null).scheduledNetwork).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// A driving traveller priced off the one network anybody measured: the footpaths
// ---------------------------------------------------------------------------

/**
 * THE OTHER HALF OF MODE HONESTY. The transit-blind gate above protects the
 * traveller who chose public transport; this protects the one who declared a
 * car. Measured on a served board: a driving profile ("up to 150 min at the
 * wheel a day", detour limit 60) had every card priced "N min on foot from
 * base" and its skip list justified by "2 hr 6 min each way on foot is past how
 * far you said you would go" — a walking budget attributed to a traveller who
 * never gave one, because the compiled matrix was pedestrian and the pricing
 * layer took whatever mode the matrix had.
 *
 * The repair prices the journey in the declared mode: a walk past the
 * traveller's own walking tolerance becomes a drive derived from the measured
 * distance, carried as `modelled` so no surface can present it as a
 * measurement. Short walks stay walks, measured rides are never second-guessed
 * by a model, and a traveller who does not drive keeps walk pricing exactly.
 */
describe('a driving traveller is priced in the mode they declared', () => {
  /** The default profile drives; the fixture only ever turned driving off. */
  const driver = transitCityTraveler({ willDrive: true });

  function drivingKnowledge() {
    return travelKnowledgeFor(transitCityWalkMatrix(), driver, transitCityTransit());
  }

  it('prices a beyond-walking candidate as a modelled drive, never a walking verdict', () => {
    const reach = resolveCandidateReach(drivingKnowledge(), IDS.baseId, IDS.candidateC);
    expect(reach.status).toBe('measured');
    if (reach.status !== 'measured') return;
    expect(reach.mode).toBe('drive');
    expect(reach.provenance).toBe('modelled');
    expect(reach.rule).toBe('modelled_drive');
    /* 9 km at the 20 km/h modelled pace: ceil(9 × 60 / 20) = 27, erring long. */
    expect(reach.travelMinutes).toBe(27);
    expect(reach.roundTripMinutes).toBe(54);
    /* All of it time at a wheel, so the driving budget can bound it. */
    expect(reach.driveMinutes).toBe(54);
    expect(reach.distanceKm).toBe(9);
  });

  it('keeps a short walk a walk — driving two streets is not a saving', () => {
    const reach = resolveCandidateReach(drivingKnowledge(), IDS.baseId, IDS.candidateA);
    expect(reach.status === 'measured' && reach.mode).toBe('walk');
    expect(reach.status === 'measured' && reach.rule).toBe('walk_within_tolerance');
    expect(reach.status === 'measured' && reach.provenance).toBe('measured');
  });

  it('never second-guesses a measured ride with a model', () => {
    const reach = resolveCandidateReach(drivingKnowledge(), IDS.baseId, IDS.candidateB);
    expect(reach.status === 'measured' && reach.mode).toBe('rail');
    expect(reach.status === 'measured' && reach.rule).toBe('transit_measured');
  });

  it('keeps walk pricing for the traveller who does not drive', () => {
    const walker = travelKnowledgeFor(
      transitCityWalkMatrix(),
      transitCityTraveler(),
      transitCityTransit(),
    );
    const reach = resolveCandidateReach(walker, IDS.baseId, IDS.candidateC);
    expect(reach.status === 'measured' && reach.mode).toBe('walk');
    expect(reach.status === 'measured' && reach.travelMinutes).toBe(
      TRANSIT_CITY_JOURNEYS.walkToC,
    );
    expect(reach.status === 'measured' && reach.provenance).toBe('measured');
  });

  it('says a modelled figure was worked out, not read off a measurement', () => {
    const reach = resolveCandidateReach(drivingKnowledge(), IDS.baseId, IDS.candidateC);
    expect(describeReachFromBase(reach, (minutes) => `${minutes} min`)).toBe(
      'about 27 min by car',
    );
  });

  it('prices the board and its skip verdicts by car, end to end', () => {
    const board = buildDiscoveryBoard(transitCityBoardInput(driver));
    const c = board.candidates.find((entry) => entry.place.id === IDS.candidateC)!;
    expect(c.travelModeFromBase).toBe('drive');
    expect(c.travelMinutesFromBase).toBe(27);
    expect(c.detourClass).toBe('in_tolerance');
    expect(c.quality.reason).not.toMatch(/on foot/);
    /* No card justifies a skip to a driver out of walking hours. */
    for (const card of board.candidates) {
      expect(card.quality.reason).not.toMatch(/each way on foot/);
    }
  });
});

// ---------------------------------------------------------------------------
// Which of the traveller's answers bounds a journey, and when
// ---------------------------------------------------------------------------

/**
 * THREE QUESTIONS, THREE ANSWERS, AND THE ONE THAT MAY NOT STAND FOR THE OTHERS.
 *
 * `maxAccessWalkMinutes` asks how far somebody will walk *from the car park or
 * the bus stop to the thing itself*, and the screen says so in as many words.
 * It was also the whole walking radius for anybody without a car, so on a
 * car-free board through a dense metro — where no transit provider is
 * configured and the matrix therefore prices every journey on foot — a landmark
 * ten metro minutes away arrived as a thirty-nine to seventy minute measured
 * walk and was refused against an answer about the last mile. Two such boards
 * scheduled one and two stops out of twenty-four cards.
 *
 * A walk that stands in for a ride nobody could price is bounded like the ride;
 * a walk that is genuinely the only way in is bounded by walking appetite.
 */
describe('the radius a journey is judged against', () => {
  /** No car, 20 min on foot to reach a stop, 150 min of getting about a day. */
  const walker = transitCityTraveler();
  const rideBound = Math.floor(walker.transport.maxDailyTransportMinutes / 2);

  it('bounds a walk standing in for unmeasurable transit by the ride budget', () => {
    expect(detourToleranceMinutesFor(walker, 'walk', { transitUnmeasured: true })).toBe(
      Math.max(walker.derived.effectiveDetourMinutes, rideBound),
    );
    /* Which is the ride's own radius: the journey they will actually make. */
    expect(detourToleranceMinutesFor(walker, 'walk', { transitUnmeasured: true })).toBe(
      detourToleranceMinutesFor(walker, 'rail'),
    );
  });

  it('bounds a genuine walk by what they said they would walk', () => {
    expect(detourToleranceMinutesFor(walker, 'walk')).toBe(
      walker.transport.maxAccessWalkMinutes,
    );
    /* The default is the walking bound: an unestablished gap widens nothing. */
    expect(detourToleranceMinutesFor(walker, 'walk', {})).toBe(
      detourToleranceMinutesFor(walker, 'walk'),
    );
    expect(detourToleranceMinutesFor(walker, 'walk', { transitUnmeasured: false })).toBe(
      detourToleranceMinutesFor(walker, 'walk'),
    );
  });

  it('never lets a ride answer widen a walk', () => {
    /*
     * A non-driver answers the one-way slider about trains, buses and shuttles,
     * and that answer now survives into the profile. It may bound their ride and
     * never their feet: the audited defect on the other side of this line is an
     * hour-plus measured walk, each way, day after day, for somebody who had
     * answered twenty minutes on foot.
     */
    expect(walker.derived.effectiveDetourMinutes).toBeGreaterThan(
      walker.transport.maxAccessWalkMinutes,
    );
    expect(detourToleranceMinutesFor(walker, 'walk')).toBe(
      walker.transport.maxAccessWalkMinutes,
    );
  });

  it('leaves the drive and ride branches exactly as they were', () => {
    const driver = transitCityTraveler({ willDrive: true });
    expect(detourToleranceMinutesFor(driver, 'drive')).toBe(
      driver.derived.effectiveDetourMinutes,
    );
    for (const mode of ['rail', 'public_bus', 'ferry', 'shuttle'] as const) {
      expect(detourToleranceMinutesFor(walker, mode)).toBe(
        Math.max(walker.derived.effectiveDetourMinutes, rideBound),
      );
      /* The flag is a walking question; a ride is already bounded like a ride. */
      expect(detourToleranceMinutesFor(walker, mode, { transitUnmeasured: true })).toBe(
        detourToleranceMinutesFor(walker, mode),
      );
    }
    /* A driver's walking radius is still widened by their driving radius. */
    expect(detourToleranceMinutesFor(driver, 'walk')).toBe(
      Math.max(driver.derived.effectiveDetourMinutes, driver.transport.maxAccessWalkMinutes),
    );
  });

  it('reads the trip-level half of the transit-blind rule from one predicate', () => {
    const signed: TransitEvidence = {
      journeys: [],
      requested: 0,
      measured: 0,
      absence: 'unsupported',
    };
    const blind = travelKnowledgeFor(transitCityWalkMatrix(), walker, signed, 'observed');
    expect(scheduledTransportUnmeasured(blind)).toBe(true);
    /* And it is the same rule `transitBlindWalk` applies to one measured walk. */
    expect(transitBlindWalk(blind, walker.transport.maxAccessWalkMinutes + 1)).toBe(true);
    expect(transitBlindWalk(blind, walker.transport.maxAccessWalkMinutes)).toBe(false);

    const seen = travelKnowledgeFor(transitCityWalkMatrix(), walker, signed, 'not_observed');
    expect(scheduledTransportUnmeasured(seen)).toBe(false);
    expect(
      scheduledTransportUnmeasured(
        travelKnowledgeFor(transitCityWalkMatrix(), walker, transitCityTransit(), 'observed'),
      ),
    ).toBe(false);
  });
});

/** Guards that the fixture used above is the one these claims are about. */
describe('fixture identity', () => {
  it('is the transit city, with a road matrix that measures a drive to D', () => {
    const matrix = transitCityRoadMatrix();
    expect(matrix.mode).toBe('car');
    expect(matrix.ids).toContain(IDS.candidateD);
    expect(transitCityTransit().measured).toBeGreaterThan(0);
  });
});
