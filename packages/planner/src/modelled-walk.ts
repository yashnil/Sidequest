import { tryLeg } from '@sidequest/geo';
import {
  deriveModelledDrive,
  describeTransitBlindWalk,
  transitBlindWalk,
  walkingLegBoundMinutes,
} from '@sidequest/core';
import type { TransportMode, TravelerProfile } from '@sidequest/core';
import {
  deriveModelledWalk as deriveWalkWithin,
  detourToleranceMinutesFor,
  DETOUR_STRETCH_MULTIPLIER,
  resolveLeg,
  scheduledTransportUnmeasured,
  transitModeOf,
  MODELLED_WALK_KMH,
  type LegRule,
  type TravelKnowledge,
  type TravelOption,
  type UnresolvedLeg,
} from './travel';

/**
 * Re-exported so `MODELLED_WALK_KMH` still has an address inside the planner —
 * it is the same constant, from the one module that owns it.
 */
export { MODELLED_WALK_KMH };

/**
 * THE PLANNER'S ANSWER TO A CAR-FREE TRIP HANDED A ROAD MATRIX.
 *
 * The contract says the compiler measures the network a trip is made on. When
 * that contract breaks — a car-free scope stored with a `car` matrix, which a
 * live Tokyo compilation actually produced — `resolveLeg` correctly refuses
 * every pair: a road duration is not a walk, and the traveller may not drive.
 * The refusal was right about every leg and wrong about the trip, because it
 * turned "the matrix measured the wrong network" into "there is no legal way in
 * to any of the 6 places you picked" — a dead end over stops that were a
 * fifteen-minute stroll from the hotel.
 *
 * This module is the narrow, honest repair. When nothing measured can carry a
 * leg, and the road matrix holds a *distance* for the pair, and that distance is
 * short enough that a person would plainly walk it, the leg becomes a **derived
 * walk**: the road kilometres at a deliberately slow pace, labelled
 * `modelled` so no surface can present it as a measurement.
 *
 * The three invariants it must never break, in the words of the module it
 * extends:
 *
 *   - a road *time* never stands in for any other mode — only the distance is
 *     read, and only to derive a walk;
 *   - it never renders as transit — the mode is `walk`, always;
 *   - unknown stays unknown — no distance, or a distance past what this
 *     traveller would walk, stays a refusal, now with the distance named.
 *
 * The cap is the traveller's own walking radius, not a constant: what they said
 * they would walk to reach something, widened by their stated detour tolerance.
 * A modelled number is a guess stacked on a distance, so unlike a *measured*
 * long walk — which `resolveLeg` offers and lets the traveller judge — a
 * modelled long walk is refused outright.
 */

/**
 * THE TWO BOUNDS A LEG IS JUDGED BY, CARRIED TOGETHER SO NEITHER CAN BE SPENT
 * ON THE OTHER'S QUESTION.
 *
 * One number used to answer both, and the two questions need different answers:
 *
 *   - `journeyCapMinutes` — *can this traveller reach this place at all?* On a
 *     car-free trip whose scheduled network nobody could time, the walking
 *     figure is the only price anybody could put on a journey the traveller
 *     will make by train, so the honest bound is the ride budget. This is what
 *     the reach test and the feasibility probes spend.
 *   - `walkingLegCapMinutes` — *how far will they walk on a leg we instruct?*
 *     Always the traveller's own walking answer, never widened by the rule
 *     above. Every leg the itinerary renders on foot is held to it.
 *
 * Spending the first on the second is the audited defect: a traveller who
 * answered twenty-five minutes was handed a per-leg ceiling of a hundred and
 * twelve, and two live car-free itineraries shipped legs reading "Walk to X —
 * 67 min on foot". They are separate fields off separate functions —
 * `walkingLegBoundMinutes` takes no knowledge at all, so the widening rule
 * cannot reach it.
 *
 * `knowledge` decides only whether the *journey* bound widens. Optional, and
 * absent is the walking bound for both: a caller with no travel knowledge
 * cannot establish the gap, and every caller that predates the distinction
 * keeps its exact cap.
 */
export interface PlannerLegBounds {
  /** The reach question. May be the ride budget for a transit-blind proxy. */
  journeyCapMinutes: number;
  /** The instruction question. The traveller's walking answer, always. */
  walkingLegCapMinutes: number;
  /**
   * The start/stop time the schedule actually books on a drive — parking,
   * boots, getting going. Absent means no caller established it, and then no
   * leg is switched off a measured mode. See `walkBeatsShortDrive`.
   */
  driveOverheadMinutes?: number;
  /** A stated mobility constraint, which no mode policy may override. */
  mobilityLimited: boolean;
}

export function plannerLegBounds(
  profile: TravelerProfile,
  knowledge?: TravelKnowledge,
  driveOverheadMinutes?: number,
): PlannerLegBounds {
  return {
    journeyCapMinutes: detourToleranceMinutesFor(profile, 'walk', {
      transitUnmeasured: knowledge ? scheduledTransportUnmeasured(knowledge) : false,
    }),
    walkingLegCapMinutes: walkingLegBoundMinutes(profile),
    ...(driveOverheadMinutes === undefined ? {} : { driveOverheadMinutes }),
    mobilityLimited: profile.accessibility.mobilityLimited,
  };
}

/**
 * The rule vocabulary, widened by the one value only the planner can produce.
 *
 * Kept out of core's `LegRule` on purpose: core resolves *measured* journeys,
 * and a derived walk is not one. A consumer that switches on the rule sees a
 * distinct name; a consumer that only reads `provenance` sees `modelled`, which
 * is the same fact in the vocabulary the stored artifact already has.
 */
export type PlannerLegRule = LegRule | 'modelled_walk' | 'transit_unverified';

export type PlannerResolvedLeg =
  | ({ ok: true; fromId: string; toId: string; rule: PlannerLegRule } & TravelOption)
  | UnresolvedLeg;

/**
 * A walk derived from the road distance, against **this** traveller's cap.
 *
 * The derivation itself — the pace, the arithmetic, and every part of the
 * honesty test around it — belongs to `@sidequest/core`, which is where the
 * board reads it from too. This function exists for one reason: the cap.
 *
 * Core caps a derived walk at `maxAccessWalkMinutes`, the furthest the traveller
 * said they would walk *to reach a place*, which is the right ceiling for the
 * question core asks ("is there a way in at all"). The planner asks a narrower
 * one — a leg taken mid-day between two stops already accepted — and the right
 * ceiling for that is the traveller's detour tolerance. The difference is
 * deliberate and predates the move; it is carried here by handing core a
 * knowledge whose walking ceiling is the planner's, so the two callers share one
 * derivation and keep their own limits.
 *
 * Null whenever any part of core's honesty test fails, or the derived walk is
 * past the cap given.
 */
export function deriveModelledWalk(
  knowledge: TravelKnowledge,
  fromId: string,
  toId: string,
  capMinutes: number,
): (TravelOption & { mode: 'walk'; provenance: 'modelled' }) | null {
  return deriveWalkWithin({ ...knowledge, maxWalkMinutes: capMinutes }, fromId, toId);
}

/**
 * `resolveLeg`, then a policy over what it answered, then the modelled walk as
 * the answer of last resort.
 *
 * Everything measured wins first, through the same ordered rules as always —
 * but "measured" is not the same as "right", and two of the results need a
 * policy applied on top before they become an instruction:
 *
 *   - a **measured drive short enough that walking plainly wins** once the
 *     parking allowance the schedule books is counted, which is
 *     `walkBeatsShortDrive`. The audited evidence: a plan that drove a hundred
 *     and seventy metres between two adjacent squares and spent an hour parking
 *     to cover three and three-quarter kilometres in a day, because the first
 *     mode that answered was taken;
 *   - a **measured walk past the traveller's walking answer**, which is
 *     `overLimitWalkOutcome`.
 *
 * Only a pair nothing measured can carry — the exact state that emptied the
 * Tokyo plan — falls through to the derivation, and only within the bound that
 * belongs to the question. `walkingLegCapMinutes` for a walk this becomes an
 * instruction to make; `journeyCapMinutes` only for a journey that is being
 * priced on foot because nobody could price the ride, and then the leg carries
 * `transit_unverified` rather than a walking instruction.
 *
 * When even the derivation cannot answer, the refusal is *upgraded*, not
 * replaced: a pair the road matrix holds a distance for is not "nothing
 * configured here can measure this journey", it is a stop this traveller's own
 * constraints rule out, and the sentence names the distance so they can weigh
 * it themselves. `conflict: true` is what routes that to a decision rather
 * than to a retry.
 */
export function resolvePlannerLeg(
  knowledge: TravelKnowledge,
  fromId: string,
  toId: string,
  allowed: TransportMode | readonly TransportMode[],
  options: { bounds: PlannerLegBounds; spent?: { driveMinutes: number } },
): PlannerResolvedLeg {
  const { bounds } = options;
  const resolved = resolveLeg(knowledge, fromId, toId, allowed, options.spent);
  if (resolved.ok) {
    if (resolved.mode === 'drive') {
      const onFoot = walkBeatsShortDrive(knowledge, resolved, fromId, toId, bounds);
      if (onFoot) return onFoot;
    }
    if (resolved.mode === 'walk' && exceedsStatedWalkLimit(knowledge, resolved.minutes)) {
      return overLimitWalkOutcome(knowledge, resolved, fromId, toId, bounds);
    }
    return resolved;
  }

  /*
   * Walking is always permitted — the tolerance bounds how far, not whether —
   * so the only gate here is whether an honest walk can be derived at all.
   *
   * The bound is the walking one, because this derivation becomes a leg the
   * itinerary tells the traveller to walk. Deriving it against the journey
   * bound is how the widening rule reached a rendered instruction the first
   * time: a road matrix on a car-free trip through a served city produced
   * hour-long "walks" nobody would take.
   */
  const walk = deriveModelledWalk(knowledge, fromId, toId, bounds.walkingLegCapMinutes);
  if (walk) return { ok: true, fromId, toId, rule: 'modelled_walk', ...walk };

  /*
   * Past what they would walk, and the walk was only ever pricing a journey
   * nobody could time. The journey bound may carry it — that is the whole
   * point of having a second bound — but it may not carry it as a walk.
   */
  const proxy = deriveModelledWalk(knowledge, fromId, toId, stretched(bounds.journeyCapMinutes));
  if (proxy && transitBlindWalk(knowledge, proxy.minutes)) {
    return unverifiedScheduledJourney(fromId, toId, proxy);
  }

  const road = knowledge.matrix.mode === 'car' ? tryLeg(knowledge.matrix, fromId, toId) : null;
  if (road && road.km > 0 && !knowledge.permitted.has('drive')) {
    const walkMinutes = Math.ceil((road.km * 60) / MODELLED_WALK_KMH);
    return {
      ok: false,
      fromId,
      toId,
      reason: 'mode_not_routed',
      conflict: true,
      detail: `The only measured way here is ${formatKm(road.km)} km by road — this trip has no car, and at roughly ${formatSpan(walkMinutes)} on foot it is past what you said you would walk.`,
    };
  }
  return resolved;
}

/** The one stretch band every verdict about a journey shares. */
function stretched(minutes: number): number {
  return Math.floor(minutes * DETOUR_STRETCH_MULTIPLIER);
}

/**
 * A JOURNEY NOBODY COULD PRICE, PRESENTED AS ONE.
 *
 * The leg the traveller will make is a scheduled one; the only number anybody
 * measured is the walk that stood in for it. Both facts have to survive, and
 * two things must not happen: the itinerary must not instruct an hour-long
 * walk, and it must not invent a train nobody timed.
 *
 * So the minutes stay — they are the honest upper bound and the schedule needs
 * a clock to lay against — and the rule says what they are. Every surface that
 * renders this leg reads `describeTransitBlindWalk`, which is the sentence this
 * product already mints for exactly this state: "We could not verify the
 * transit route yet; about N on foot". The provenance drops to `modelled`,
 * because a measured walk is not a measurement of the journey this leg is: no
 * screen may put a measurement's confidence behind a duration for a route
 * nobody could confirm.
 *
 * The rule alone was not enough, and that is the audited gap. Only the row
 * title branched on it, so the mode chip beside the title read WALK, the day's
 * accumulator booked all of it to `walkMinutes`, and a stored day carried
 * `{"travelMinutes":124,"walkMinutes":124}` — every minute of a journey the
 * product had just said it could not price, billed as time on foot to somebody
 * who answered twenty-five minutes. `isUnverifiedScheduledJourney` is now what
 * every classifier, accumulator and surface asks, not only the one that names
 * the row.
 */
function unverifiedScheduledJourney(
  fromId: string,
  toId: string,
  walk: TravelOption & { mode: 'walk' },
): PlannerResolvedLeg {
  /*
   * The spread first, then the two fields this function exists to set. The
   * other order reads better and is wrong: a leg arriving here already carries
   * a `rule` from the resolver, and spreading it afterwards puts that rule
   * straight back — the walk goes out labelled `sole_option` and every surface
   * downstream renders a walking instruction again.
   */
  return {
    ok: true,
    ...walk,
    fromId,
    toId,
    rule: 'transit_unverified',
    provenance: 'modelled',
  };
}

/**
 * Whether this leg is one the itinerary must present as an unverified
 * scheduled journey rather than as a walk.
 *
 * The one predicate every rendering surface asks, so no screen has to know how
 * the rule is spelled and no two screens can come to spell it differently.
 */
export function isUnverifiedScheduledJourney(leg: { rule: PlannerLegRule }): boolean {
  return leg.rule === 'transit_unverified';
}

/**
 * WHICH MODE A SHORT LEG IS ACTUALLY MADE IN, AS A POLICY RATHER THAN A RACE.
 *
 * `resolveLeg` returns the first mode its ordered rules can answer with, and on
 * a drive-primary trip that is the road for every pair the road matrix holds —
 * including a pair a hundred and seventy metres apart. The audited plan drove
 * between two adjacent squares and spent sixty minutes parking to cover three
 * and three-quarter kilometres across a day, and every one of those legs was a
 * correct measurement.
 *
 * The policy is the comparison the traveller would make themselves, with no
 * magic distance in it anywhere. A drive costs its measured minutes **plus the
 * start/stop time the schedule really books** — `config.bufferMinutes`, the
 * parking-and-getting-going allowance, carried in as `driveOverheadMinutes`
 * rather than restated here so the threshold moves when that allowance moves. A
 * walk costs the road distance at the same conservative pace every derived walk
 * in this product uses. Walking wins when it costs no more than the drive and
 * the overhead together, which makes the distance it wins up to a *consequence*
 * of the overhead rather than a constant: raise the parking allowance and more
 * of the map becomes walkable, which is exactly the relationship being modelled.
 *
 * Two conditions bound it, and both are the traveller's, and both can only ever
 * refuse the switch:
 *
 *   - a stated mobility constraint stops it outright. Accessibility overrides
 *     the policy, never the reverse;
 *   - the walk has to fit inside the walking answer *as stated*, not the
 *     stretch band and not the widened journey bound. A stretch is something a
 *     traveller accepts for a place they chose; being put on foot instead of in
 *     the car they said they would drive is not, so this switch never spends
 *     anything the traveller did not already agree to.
 *
 * Null wherever any of that fails, and null when no caller established the
 * overhead — a policy with no overhead to beat is not a policy.
 */
function walkBeatsShortDrive(
  knowledge: TravelKnowledge,
  drive: { ok: true; fromId: string; toId: string; rule: PlannerLegRule } & TravelOption,
  fromId: string,
  toId: string,
  bounds: PlannerLegBounds,
): PlannerResolvedLeg | null {
  const overhead = bounds.driveOverheadMinutes;
  if (overhead === undefined || overhead <= 0) return null;
  if (bounds.mobilityLimited) return null;

  const agreed = knowledge.maxWalkMinutes;
  if (typeof agreed !== 'number' || !Number.isFinite(agreed)) return null;

  const walk = deriveModelledWalk(
    knowledge,
    fromId,
    toId,
    Math.min(agreed, bounds.walkingLegCapMinutes),
  );
  if (!walk) return null;
  if (walk.minutes > drive.minutes + overhead) return null;
  return { ok: true, fromId, toId, rule: 'modelled_walk', ...walk };
}

/**
 * THE TRAVELLER'S OWN WALKING ANSWER, ENFORCED ON EVERY LEG THE PLANNER LAYS.
 *
 * `maxAccessWalkMinutes` — "how far will you walk to reach a stop" — bounded
 * exactly one thing here: which mode wins when several were measured
 * (`walk_within_tolerance`). A walk *past* the answer was still offered as
 * `sole_option` whenever walking was all anybody measured, on the stated
 * grounds that a measured number is the traveller's to weigh. On a live
 * pedestrian-matrix build that reasoning scheduled sixty-five-minute walks,
 * each way, for a traveller who had answered twenty-five — the only ceiling
 * that ever applied was the *daily* transport budget, so the answer was
 * collected, stored, displayed, and enforced nowhere a leg was actually laid.
 *
 * So the planner holds every walking leg it resolves to the stated answer.
 * Over the limit, in order:
 *
 *   1. a measured, permitted ride for the same pair carries the leg — the
 *      walk only won on the clock, and the traveller's answer says the clock
 *      is not the deciding vote;
 *   2. a declared car prices the leg as a modelled drive, exactly as the
 *      board's own reach resolver does for the same traveller — the two
 *      surfaces must not disagree about the same pair;
 *   3. a measured walk inside the board's stretch band — the **walking-leg**
 *      bound widened by `DETOUR_STRETCH_MULTIPLIER`, the same arithmetic the
 *      detour classifier uses — stands as the walk it is: a seat the board
 *      classed as a permitted stretch must not be taken back here, because that
 *      is two verdicts about one journey;
 *   4. a walk that is only pricing a scheduled journey nobody could time, and
 *      that the *journey* bound can carry, becomes an unverified scheduled
 *      journey — never a walking instruction. This is the rung that used to be
 *      absent, and its absence is why the widening rule had to reach rung 3
 *      instead: the caller's cap was the ride budget, so rung 3 laid
 *      sixty-seven-minute walks for a traveller who answered twenty-five;
 *   5. otherwise the leg is refused, `conflict: true`. Where the walk was the
 *      journey the sentence names the walk and the answer that rules it out;
 *      where it was standing in for a route nobody could verify it says that
 *      instead, because blaming a walking answer for a train is the same
 *      substitution one sentence later.
 *
 * A knowledge that carries no stated answer keeps the old behaviour: a limit
 * nobody set cannot refuse a leg.
 */
function exceedsStatedWalkLimit(knowledge: TravelKnowledge, minutes: number): boolean {
  const limit = knowledge.maxWalkMinutes;
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return false;
  return minutes > limit;
}

function overLimitWalkOutcome(
  knowledge: TravelKnowledge,
  walk: { ok: true; fromId: string; toId: string; rule: PlannerLegRule } & TravelOption,
  fromId: string,
  toId: string,
  bounds: PlannerLegBounds,
): PlannerResolvedLeg {
  /*
   * Scanned by endpoint rather than looked up by key: the pair key is the
   * evidence module's own internal spelling, and a copy of it here would be a
   * second definition waiting to drift. The refusal path runs once per refused
   * leg, so a linear scan costs nothing that matters.
   */
  for (const journey of knowledge.journeys.values()) {
    if (journey.fromId !== fromId || journey.toId !== toId) continue;
    if (journey.status !== 'measured' || journey.minutes === undefined) continue;
    const mode = transitModeOf(journey);
    if (!mode || !knowledge.permitted.has(mode)) continue;
    return {
      ok: true,
      fromId,
      toId,
      rule: 'transit_measured',
      mode,
      minutes: journey.minutes,
      /* Never a road distance: a ride adds minutes to the day, not km to a car. */
      km: null,
      /* Computed from published timetables, not stood at a platform with a watch. */
      provenance: 'official',
      source: journey.source,
      ...(journey.transfers === undefined ? {} : { transfers: journey.transfers }),
      ...(journey.walkingMinutes === undefined ? {} : { walkingMinutes: journey.walkingMinutes }),
      basis: journey.requestBasis,
    };
  }

  if (knowledge.permitted.has('drive')) {
    const drive = deriveModelledDrive(knowledge, fromId, toId);
    if (drive) return { ok: true, fromId, toId, rule: 'modelled_drive', ...drive };
  }

  /*
   * No ride and no car: the measured walk is the journey, and the board's
   * detour classifier files a walk past the stated answer but within the
   * stretch band — the **walking-leg** bound widened by
   * `DETOUR_STRETCH_MULTIPLIER` — as a permitted stretch. A seat the board
   * offers on that arithmetic must not be refused here on the raw answer,
   * because that is two verdicts about one journey. The leg stays exactly the
   * walk that was measured.
   *
   * The walking bound and not the journey one, and that is the whole of the
   * per-leg repair. When this line read the caller's single cap it read the
   * ride budget on any car-free trip through a served city, so the band it
   * permitted reached a hundred and twelve minutes for a traveller who had
   * answered twenty-five, and two live itineraries laid "Walk to X — 67 min on
   * foot". A ride answer may widen a ride; it may never widen a walk this
   * product tells somebody to take.
   */
  if (walk.minutes <= stretched(bounds.walkingLegCapMinutes)) {
    return walk;
  }

  /*
   * Past what they will walk — but the walk may never have been the journey.
   * Where the compilation signed that nothing could time a scheduled route over
   * ground whose evidence observes one, the journey bound is the honest bound
   * and the leg is presented as the unverified journey it is.
   */
  const proxy = transitBlindWalk(knowledge, walk.minutes);
  if (proxy && walk.minutes <= stretched(bounds.journeyCapMinutes)) {
    return unverifiedScheduledJourney(fromId, toId, walk as TravelOption & { mode: 'walk' });
  }

  return {
    ok: false,
    fromId,
    toId,
    reason: 'mode_not_routed',
    conflict: true,
    /*
     * Two sentences, because two different things are true. A real walk is
     * refused by the traveller's own answer and naming it is what lets them
     * change it. A stand-in walk is refused by nothing they said: quoting their
     * walking answer at a journey they would make by train blames them for our
     * missing timetable, which is the sentence the live skip list shipped.
     */
    detail: proxy
      ? `${describeTransitBlindWalk(walk.minutes, formatSpan)}, which is further than this trip's travel allows for. Nothing here confirms a scheduled route, so we will not build a day on it.`
      : `The only usable way to make this leg is about ${formatSpan(
          walk.minutes,
        )} on foot, and you said ${knowledge.maxWalkMinutes} min is the furthest you would walk to reach a stop. Raise that answer if you would take this walk.`,
  };
}

/**
 * Whether any honest way from the base to this place — and back — exists for
 * this traveller: measured in a permitted mode, or a derivable walk.
 *
 * This is the mode-aware answer to the funnel's "measurable" gate. The old
 * definition was `hasPoint(matrix, id)`, which counted a road row as
 * measurable for somebody with no car — so the refusal screen said
 * "MEASURABLE 6" one line above "6 with no measured travel time", two claims
 * about the same six places that cannot both be true.
 *
 * Both directions, like every reach question here: a walk out that cannot be
 * walked back is a trip that ends there.
 */
export function plannerReachResolves(
  knowledge: TravelKnowledge,
  baseId: string,
  placeId: string,
  bounds: PlannerLegBounds,
): boolean {
  const legal: TransportMode =
    knowledge.matrix.mode === 'car' ? 'drive' : knowledge.matrix.mode === 'foot' ? 'walk' : 'unsupported';
  const out = resolvePlannerLeg(knowledge, baseId, placeId, legal, { bounds });
  if (!out.ok) return false;
  const back = resolvePlannerLeg(knowledge, placeId, baseId, legal, { bounds });
  return back.ok;
}

function formatKm(km: number): string {
  return (Math.round(km * 10) / 10).toString();
}

/**
 * "1 hr 5 min", not "65 min". Exported because the refusal sentence written
 * here and the timeline row written in `schedule.ts` are two halves of one
 * claim about the same leg, and a second copy of this would let them start
 * spelling the same duration differently.
 */
export function formatSpan(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} hr` : `${hours} hr ${rest} min`;
}
