/**
 * WHICH WAY THE TRAVELLER ACTUALLY GETS FROM ONE POINT TO THE NEXT.
 *
 * The planner used to answer this with a single travel-time matrix. A matrix has
 * exactly one `mode`, so every leg of every day was labelled with it and charged
 * to its budget — which is right for a road trip and false for anything else. In
 * a car-free city the matrix is a pedestrian one, so a pair forty minutes apart
 * by metro was scheduled as a ninety-minute walk; and before the reach fix, a
 * car-free trip of two nights got a *road* matrix, so those same minutes were a
 * drive the traveller could not make.
 *
 * Both are the same defect: a duration measured for one mode standing in for
 * another because it was the one that happened to exist.
 *
 * This module is the single place that decision is made. Every leg the scheduler
 * pushes goes through `resolveLeg`, which:
 *
 *   1. gathers the options actually *measured* for this exact ordered pair,
 *   2. drops the ones the traveller may not use,
 *   3. picks one by explicit ordered rules, and
 *   4. carries the rule it used, so the choice can be explained rather than
 *      trusted.
 *
 * The three things it must never do, each of which shipped at some point:
 *
 *   - answer a transit pair with a road duration,
 *   - answer a long transit pair with a walking duration,
 *   - answer one pair with another pair's number.
 *
 * The last is why every lookup here is keyed on `(fromId, toId)` in that order
 * and why a reversed journey is not a match. A matrix is not assumed symmetric —
 * `packages/geo` says so in as many words — and a timetable is far less so.
 *
 * ---
 *
 * WHY THIS LIVES IN `core` RATHER THAN IN `planner`.
 *
 * It was written in the planner, and for one release only the planner used it.
 * The Discovery Board went on deciding the same question for itself, from
 * `place.travelFromBase.driveMinutes` — one scalar, filled from whichever single
 * mode the compilation's matrix happened to be, wearing a name that says
 * driving. So a car-free traveller's board measured a metro journey as a walk,
 * called it a detour past a twenty-minute radius, scored it down, filed it under
 * "weak fit", and dropped it from auto-pick — while the planner, handed the same
 * region, would have reached it by train in twenty-seven minutes.
 *
 * The traveller never saw the place. Not because anything was unreachable, but
 * because the two halves of the product disagreed about what reachable means.
 *
 * `@sidequest/planner` depends on `@sidequest/core`, so core is the only package
 * both can share, and every input this module needs — `TransitEvidence`,
 * `TransportMode`, `TravelerProfile`, `UnmeasuredTravelReason` — was already
 * declared here. Moving it added no dependency edge and no second copy. The
 * planner keeps a re-export so its own imports never had to move.
 */

import { tryLeg, type TravelTimeMatrix } from '@sidequest/geo';

import type { TransportMode } from '../schemas/access';
import type { TransitEvidence, TransitJourneyRecord } from '../schemas/compiled-region';
import type { UnmeasuredTravelReason } from '../schemas/itinerary';
import type { TravelerProfile } from '../schemas/profile';

/**
 * How a leg's duration was arrived at. The same vocabulary the stored
 * `TravelSegment` uses, so nothing has to be translated on the way out.
 */
export type LegProvenance = 'measured' | 'modelled' | 'official' | 'estimated' | 'unmeasured';

/**
 * The rule that chose this mode.
 *
 * Carried rather than recomputed because "why is this a train?" is a question
 * the itinerary has to be able to answer, and because a rule name is the thing a
 * test can assert on. A duration alone cannot distinguish "we picked the metro
 * because the walk was an hour" from "we picked the metro because it was the
 * only row we had".
 */
export type LegRule =
  /** Short enough to walk, so we walk. Nothing is gained by waiting for a train. */
  | 'walk_within_tolerance'
  /** Measured public transport, for a pair beyond comfortable walking. */
  | 'transit_measured'
  /** The road, for a traveller who has a car and a road matrix that covers it. */
  | 'road_measured'
  /** The only permitted measured option there was. */
  | 'sole_option'
  /**
   * Nothing measured could carry this pair, and the road distance is short
   * enough that a person would plainly walk it. See `deriveModelledWalk`.
   *
   * The one rule here that is not a measurement, which is why it carries
   * `provenance: 'modelled'` and why every surface that prints a duration has to
   * be able to say so.
   */
  | 'modelled_walk'
  /**
   * The mirror image, for the traveller who declared a car: the only network
   * anybody measured is the pedestrian one, the walk is past what they said
   * they would walk, and the distance driven at a cautious pace is the honest
   * price of the journey they would actually make. See `deriveModelledDrive`.
   * Also `provenance: 'modelled'`, for the same reason.
   */
  | 'modelled_drive';

/** A journey between two points that somebody actually measured. */
export interface TravelOption {
  mode: TransportMode;
  minutes: number;
  /**
   * Road distance, where the mode is one that puts kilometres on a vehicle.
   * Null on a ride: a metro journey adds minutes to a day, not kilometres to a
   * car, and the day's `travelKm` is a road figure.
   */
  km: number | null;
  provenance: LegProvenance;
  source?: string;
  /** Transit only, and only when the provider supplied them. */
  transfers?: number;
  walkingMinutes?: number;
  /**
   * Which departure this duration is an answer to. A transit time without one is
   * not an answer — a Sunday evening is a different number — so it travels with
   * the leg and the itinerary can show it.
   */
  basis?: TransitJourneyRecord['requestBasis'];
}

/** Why a pair has no usable duration. */
export interface UnresolvedLeg {
  ok: false;
  fromId: string;
  toId: string;
  reason: UnmeasuredTravelReason;
  /**
   * True when the traveller's own constraints are what rules every option out,
   * rather than an absence of evidence.
   *
   * The difference decides what the product says. "Nobody measured this" is a
   * coverage gap with a data remedy. "You told us you will not drive, there are
   * no timetables here, and this is a two-hour walk" is a conflict in the trip
   * itself, and the traveller is the only one who can resolve it. Section 10E:
   * that case must be reported, never quietly answered off the road matrix.
   */
  conflict: boolean;
  detail: string;
}

export type ResolvedLeg =
  | ({ ok: true; fromId: string; toId: string; rule: LegRule } & TravelOption)
  | UnresolvedLeg;

/**
 * WHETHER A SCHEDULED-TRANSPORT NETWORK WAS SEEN ON THE DESTINATION'S GROUND.
 *
 * An *observation about the destination*, never about the traveller and never
 * about our instruments: 'observed' means the destination evidence itself
 * records scheduled-transport stops — rail stations, bus stations, ferry
 * terminals — and 'not_observed' means the same evidence was read and records
 * none. The caller that compiled or loaded the destination is the only party
 * who can say which, so the value arrives as data and is never inferred here.
 *
 * The third state is the absence of the field, and it is load-bearing exactly
 * as `TransitEvidence`'s absence is: a caller that did not say has made no
 * claim, and no rule below may read the silence as either answer. Every caller
 * that predates this field therefore keeps its exact behaviour.
 */
export type ScheduledNetworkPresence = 'observed' | 'not_observed';

/**
 * Everything needed to answer "how do they get from here to there", as data.
 *
 * The planner stays a pure function of what it is handed; nothing in here talks
 * to a provider. `transit` is null on the overwhelming majority of trips and
 * that is the ordinary case, not a degraded one — a trip planned around a car
 * buys no timetables at all.
 */
export interface TravelKnowledge {
  matrix: TravelTimeMatrix;
  transit: TransitEvidence | null;
  /** The modes this traveller may actually use. Walking is always in it. */
  permitted: ReadonlySet<TransportMode>;
  /** The longest single walk they accept to reach something. */
  maxWalkMinutes: number;
  /** Minutes at the wheel a day may hold. Zero for a traveller with no car. */
  maxDailyDriveMinutes: number;
  /** Driving plus riding plus walking to reach things. Always the larger cap. */
  maxDailyTransportMinutes: number;
  /**
   * Whether the destination's own evidence records a scheduled network.
   *
   * Optional, and `null` and absent read identically as "nobody said" —
   * nobody-said changes nothing anywhere. Optional rather than required so a
   * knowledge object built by hand before the observation existed (the
   * planner's own test fixtures do this) keeps compiling with its exact
   * meaning: it never said, and silence opens no gate.
   */
  scheduledNetwork?: ScheduledNetworkPresence | null;
  /** Measured journeys, keyed `from\u0000to`. Built once rather than scanned per leg. */
  journeys: ReadonlyMap<string, TransitJourneyRecord>;
}

const TRANSIT_MODES: readonly TransportMode[] = ['rail', 'public_bus', 'ferry'];

/**
 * WHETHER THE MODES THIS TRAVELLER WOULD ACTUALLY USE WERE EVER ASKED ABOUT.
 *
 * The one question that decides whether a permission refusal is a *conflict* or
 * a *gap*, and getting it wrong is what put "No usable route from your base" on
 * twenty-two of twenty-four cards of a car-free Tokyo board.
 *
 * The chain that produces it is not a bug anywhere along its length. The
 * compiler could not find a continuous walking network across the region, so it
 * substituted the road one and said so in a warning. `matrixMode` then correctly
 * declares a road matrix answers for driving, the permission filter correctly
 * removes driving from a traveller who has no car, and the refusal below
 * correctly reports that everything measured was refused. What is wrong is the
 * *sentence*: "the only measured way between these two is by car, which this
 * trip rules out" reads as a fact about the ground — there is no other way in —
 * when it is a fact about our instruments. In a city with nine hundred stations,
 * the traveller can plainly get there; nobody asked a timetable how long it
 * takes.
 *
 * `TransitEvidence.absence` already draws exactly this distinction, in its own
 * words: "a traveller is owed the difference between 'there are no trains' and
 * 'we cannot see the trains'". So this reads it rather than restating it.
 *
 *   - a measured journey, anywhere in this evidence, or `out_of_coverage` — a
 *     provider was asked about this ground and answered — means the scheduled
 *     modes *were* asked about. A refusal is then a genuine conflict, and the
 *     remedy is a decision the traveller makes.
 *   - `unsupported`, `budget_exhausted` or `not_needed` is the compilation
 *     stating, in its own record, that nothing ever asked. The remedy is more
 *     data, and the honest card says the journey could not be timed.
 *
 * **No transit evidence at all keeps the conflict**, and that asymmetry is
 * deliberate rather than an oversight. This module's standing rule is that an
 * absent record is never read as a claim; a missing `TransitEvidence` is
 * therefore not a statement that nothing asked, and softening a refusal on the
 * strength of a field nobody wrote would be inventing the very reassurance the
 * softer sentence carries. Where the compilation signed the absence, this reads
 * it; where it said nothing, the stricter answer stands.
 *
 * There is deliberately no test here for whether the traveller would board
 * anything. `permittedModesFor` grants rail and ferry to everybody and says why
 * — nothing in the questionnaire asks about them — so anyone who reaches this
 * refusal at all has a scheduled mode in their permitted set by construction. A
 * clause guarding against the opposite was written, could not fire, and is not
 * kept as decoration; the day the questionnaire gates rail, it belongs here.
 */
function unaskedScheduledModes(knowledge: TravelKnowledge): boolean {
  const transit = knowledge.transit;
  if (!transit) return false;
  return (
    transit.measured === 0 && transit.absence !== undefined && transit.absence !== 'out_of_coverage'
  );
}

/**
 * One key per ordered pair, with a separator no identifier can contain.
 *
 * Written as an escape rather than as a literal control character on purpose:
 * the literal made the file `data` to `file(1)` and would have made every future
 * `git diff` of the module read "Binary files differ" — a poor property for the
 * one place every mode decision is made. And if a formatter had then stripped
 * it, the key would collapse to plain concatenation and `("ab", "c")` would
 * collide with `("a", "bc")`: one pair answered with another pair's journey,
 * silently, which is the exact defect this module exists to prevent.
 */
function pairKey(fromId: string, toId: string): string {
  return `${fromId}\u0000${toId}`;
}

/**
 * The vehicle a measured journey is mostly spent on.
 *
 * A journey is a sequence of legs and the traveller wants one noun for it. The
 * longest ride wins, which is what a person would say themselves: a six-minute
 * walk, fourteen on the subway and nine on a train is "by train" only if the
 * train is the longer of the two, and it is not — so this one is "by metro".
 *
 * A measured journey with no ride in it is refused rather than guessed at. The
 * enum has no generic "public transport", so naming one would mean picking
 * between a bus and a train on no evidence, and the itinerary would print a
 * vehicle nobody measured. That cannot happen through either shipped adapter —
 * a journey only counts as measured if a maneuver reported a transit mode — and
 * if it ever does, an unmeasured leg is the honest output.
 */
export function transitModeOf(journey: TransitJourneyRecord): TransportMode | null {
  const rides = (journey.legs ?? []).filter((entry) => entry.mode !== 'walk');
  if (rides.length === 0) return null;
  const dominant = rides.reduce((best, entry) => (entry.minutes > best.minutes ? entry : best));
  switch (dominant.mode) {
    case 'bus':
      return 'public_bus';
    case 'ferry':
      return 'ferry';
    case 'rail':
    case 'subway':
    case 'tram':
    case 'cable':
      return 'rail';
    default:
      return null;
  }
}

/**
 * What a matrix's single mode means for a leg.
 *
 * `transit` is deliberately unmapped. A square matrix cannot hold a transit
 * answer — that answer is a property of two points *and an instant* — so a
 * matrix claiming that mode is not a source this module will schedule from, and
 * `matrixModeFor` no longer produces one. Returning null here rather than
 * pretending keeps a stale artifact from becoming a fabricated train.
 */
function matrixMode(matrix: TravelTimeMatrix): TransportMode | null {
  if (matrix.mode === 'car') return 'drive';
  if (matrix.mode === 'foot') return 'walk';
  return null;
}

/**
 * The modes a traveller is allowed to be put on.
 *
 * Two gates, both the traveller's own answer rather than anything about the
 * region: a road matrix existing is not permission to drive on it, and a
 * timetable existing is not permission to put somebody on a bus they said they
 * did not want. Walking is always permitted — the tolerance bounds how far, not
 * whether.
 *
 * `willUseShuttles` covers **buses as well as shuttles**, and the first version
 * of this function read it for one and not the other. That was not a judgement
 * call, it was a mistake with a witness: `validate.ts` raises a hard
 * `required_mode_unavailable` for either mode against that same answer, so a
 * traveller who unchecked "shuttles and buses are fine" would have had a
 * measured bus journey scheduled and their plan then refused by the validator
 * for containing it. The two files now read the one answer the same way.
 *
 * Rail and ferry are not gated, because nothing in the questionnaire asks about
 * them and the validator does not refuse them. Inventing a permission the
 * traveller was never offered would be worse than the gap.
 */
export function permittedModesFor(profile: TravelerProfile): Set<TransportMode> {
  const modes = new Set<TransportMode>(['walk', 'rail', 'ferry']);
  if (profile.transport.willDrive) modes.add('drive');
  if (profile.transport.willUseShuttles) {
    modes.add('shuttle');
    modes.add('public_bus');
  }
  return modes;
}

export function travelKnowledgeFor(
  matrix: TravelTimeMatrix,
  profile: TravelerProfile,
  transit: TransitEvidence | null | undefined,
  /**
   * See `ScheduledNetworkPresence`. Optional so that every caller written
   * before the observation existed keeps compiling and keeps its exact
   * behaviour: an absent argument stores `null`, and `null` opens no gate.
   */
  scheduledNetwork?: ScheduledNetworkPresence | null,
): TravelKnowledge {
  const journeys = new Map<string, TransitJourneyRecord>();
  for (const journey of transit?.journeys ?? []) {
    journeys.set(pairKey(journey.fromId, journey.toId), journey);
  }
  return {
    matrix,
    transit: transit ?? null,
    permitted: permittedModesFor(profile),
    /*
     * The traveller's stated access-walk limit is the right number and already
     * exists. It is what they said they would walk to reach something, which is
     * exactly the question a mode choice asks.
     */
    maxWalkMinutes: profile.transport.maxAccessWalkMinutes,
    maxDailyDriveMinutes: profile.transport.maxDailyDriveMinutes,
    maxDailyTransportMinutes: profile.transport.maxDailyTransportMinutes,
    journeys,
    scheduledNetwork: scheduledNetwork ?? null,
  };
}

/**
 * A WALK PRICING A TRAVELLER WHOSE OWN MODE NOBODY COULD MEASURE.
 *
 * The Tokyo skip list, as a rule. A car-free trip through a served city is
 * compiled onto the one network anybody measured — the pedestrian one — so
 * every card prices its journey "on foot from base", and everything past the
 * walking radius is filed as too far *for a traveller who never intended to
 * walk it*. The traveller stated a travel-time tolerance, not a walking-time
 * tolerance; skipping what walking cannot reach converts "we cannot see the
 * trains" into "the trains do not exist", which is the exact substitution this
 * module exists to prevent, one layer up from the leg it usually guards.
 *
 * True only when all three of these hold, and each is somebody's signed record
 * rather than an inference:
 *
 *   - **the walk is past what the traveller said they would walk** — inside
 *     that tolerance a walk is simply the journey, and there is nothing to
 *     soften;
 *   - **the compilation signed that nothing could measure a scheduled
 *     journey** — `absence: 'unsupported'` or `'budget_exhausted'` with zero
 *     journeys measured, which the compiler writes only for a trip that leans
 *     on scheduled transport. `'not_needed'` is the compilation stating the
 *     trip is planned around a car and stays out; `'out_of_coverage'` is a
 *     provider that was asked about this ground and holds nothing, which is
 *     the closest thing to "there are no trains" a build can attest and keeps
 *     the walking verdict; a measured journey anywhere in the evidence means
 *     the evidence, not this gate, is the story; and an absent record is no
 *     statement at all;
 *   - **the destination evidence observes a scheduled network** — without
 *     that observation, softening a walking verdict would promise a transit
 *     route in a world that may genuinely have none, which is the same lie in
 *     the other direction.
 *
 * What it deliberately is not: a reach answer. The walk stays measured, stays
 * a walk, and stays on the card; this only says the *verdict* built on it —
 * how far away this place is for this traveller — cannot honestly be passed.
 */
export function transitBlindWalk(knowledge: TravelKnowledge, walkMinutes: number): boolean {
  if (walkMinutes <= knowledge.maxWalkMinutes) return false;
  return scheduledTransportUnmeasured(knowledge);
}

/**
 * THE TWO CLAUSES OF THE RULE ABOVE THAT ARE FACTS ABOUT THE TRIP, NOT A LEG.
 *
 * A bound has to be chosen before any particular walk is in hand — a cap the
 * planner computes once for a whole resolution, a radius the classifier applies
 * to every candidate — and the question those callers are asking is the first
 * two thirds of `transitBlindWalk`: does this compilation sign that nothing
 * could time a scheduled journey, over ground whose own evidence observes a
 * scheduled network. The third clause is about one measured walk and belongs
 * only where one is being judged.
 *
 * Split out rather than restated, and read by `transitBlindWalk` itself, so the
 * board's verdict and the planner's bound cannot come to hold two different
 * definitions of the same gap.
 */
export function scheduledTransportUnmeasured(knowledge: TravelKnowledge): boolean {
  const transit = knowledge.transit;
  if (!transit || knowledge.scheduledNetwork !== 'observed') return false;
  return (
    transit.measured === 0 &&
    (transit.absence === 'unsupported' || transit.absence === 'budget_exhausted')
  );
}

/**
 * The honest sentence for a transit-blind walk, minted once.
 *
 * Both halves are load-bearing: the first admits what nobody verified without
 * asserting a train that may not run at a time that suits, and the second
 * keeps the one measured number on the card, labelled as the walk it is.
 * Never a fabricated transit time; never a walk relabelled as a ride.
 */
export function describeTransitBlindWalk(
  walkMinutes: number,
  formatMinutes: (minutes: number) => string,
  options?: { pastDayBudget?: boolean },
): string {
  /*
   * The same sentence with the refusal in it, for the journey the day cannot
   * hold at walking pace.
   *
   * Without this branch the two facts reached the traveller as two
   * contradictory sentences on one card: a confident "2 hr 17 min on foot from
   * base" beside "we cannot say how far away it really is". Both were derived
   * from the same walk; only the second was true about the journey. Said
   * together and in that order — what nobody verified first, then what the one
   * priced option would cost — the card makes one claim instead of two.
   */
  if (options?.pastDayBudget === true) {
    return `We could not verify the transit route yet; on foot it would be about ${formatMinutes(walkMinutes)} each way, more than a day here can hold`;
  }
  return `We could not verify the transit route yet; about ${formatMinutes(walkMinutes)} on foot`;
}

/**
 * WHICH CAP BOUNDS A JOURNEY MADE THIS WAY.
 *
 * Two budgets, not one, and which applies is a property of the mode rather than
 * of the trip: an hour behind the wheel and an hour on a train with a book are
 * not the same hour, and the traveller said so separately. Only a drive is time
 * at the wheel.
 *
 * This is the rule a pre-scheduler reach test needs and did not have. Every one
 * of them compared a figure taken off whatever matrix existed against
 * `maxDailyDriveMinutes` — which for a traveller with no car is **zero**, so a
 * walking or riding journey of any length at all read as "past the 0 min at the
 * wheel you said you would accept".
 */
export function dailyCapFor(knowledge: TravelKnowledge, mode: TransportMode): number {
  return mode === 'drive' ? knowledge.maxDailyDriveMinutes : knowledge.maxDailyTransportMinutes;
}

/**
 * WHAT IT TAKES TO GET OUT TO A PLACE AND BACK, IN THE MODE ACTUALLY AVAILABLE.
 *
 * The same `resolveLeg` the scheduler uses, asked about the same pairs, so that
 * a stop cannot be rejected before the scheduler has had the chance to reach it
 * by the mode the evidence supports. That was the gap: the arrival bound and the
 * round-trip test both read a scalar taken off the single matrix, so a museum
 * twenty minutes away by metro carried an eighty-five minute walking figure and
 * was ruled out on a bound the scheduler would never have hit.
 *
 * Both directions are resolved. A timetable is not symmetric, and the way home
 * is where a car-free trip most often fails.
 */
export type BaseReach =
  | {
      ok: true;
      /** The outbound mode, for labelling. Never used as a budget on its own. */
      mode: TransportMode;
      outMinutes: number;
      backMinutes: number;
      roundTripMinutes: number;
      /**
       * The part of the round trip actually spent at a wheel.
       *
       * Separate from the total because the two are bounded by different
       * budgets, and collapsing them is how a forty-five minute train out and a
       * twenty-five minute drive back came to be reported as "seventy minutes of
       * driving, past the sixty you said you would accept" — a sentence with a
       * false quantity, a false mode and a false remedy in it.
       */
      driveMinutes: number;
    }
  | { ok: false; reason: UnmeasuredTravelReason; conflict: boolean; detail: string };

export function reachFromBase(
  knowledge: TravelKnowledge,
  baseId: string,
  placeId: string,
): BaseReach {
  const reach = resolveCandidateReach(knowledge, baseId, placeId);
  if (reach.status !== 'measured') {
    return { ok: false, reason: reach.reason, conflict: reach.conflict, detail: reach.detail };
  }
  return {
    ok: true,
    mode: reach.mode,
    outMinutes: reach.travelMinutes,
    backMinutes: reach.returnMinutes,
    roundTripMinutes: reach.roundTripMinutes,
    driveMinutes: reach.driveMinutes,
  };
}

/**
 * WHETHER THIS TRAVELLER CAN GET TO THIS PLACE FROM THIS BASE, AND HOW.
 *
 * The shared relationship — the one object the Discovery Board, the regional
 * expansion, the scorer, the auto-selector and the planner all read, so that
 * none of them has to work out transport semantics for itself. It is
 * `reachFromBase` with the two things a board needs and a scheduler does not:
 * the identifiers it is an answer *about*, and the provenance of the answer.
 *
 * Three states, and the third is not a polite way of saying the second:
 *
 *   - `reachable: true`  — a permitted, measured journey exists in both
 *     directions. `mode` is what it is made in.
 *   - `reachable: false` — a journey exists and this traveller may not use it.
 *     Road evidence for somebody with no car is the archetype. `conflict` is
 *     true, because the remedy is a decision rather than more data.
 *   - `reachable: null`  — nobody measured it. Unknown stays unknown: a card
 *     that says "we could not check" is honest, and one that says "too far"
 *     because a provider timed out is a lie the traveller cannot see through.
 *
 * Reachability is deliberately **not** a burden judgement. A measured
 * two-hour walk is reachable and is also almost certainly a bad idea; deciding
 * which is `classifyDetour`'s job, against the traveller's own stated budgets.
 * Folding the two together is how "we could not route this" and "this is far"
 * came to be the same board state in the first place.
 */
export type ReachStatus =
  /** A permitted journey was measured, both ways. */
  | 'measured'
  /** Something was measured and this traveller may not use any of it. */
  | 'conflict'
  /** Nothing usable was measured. Not a statement about the place. */
  | 'unmeasured';

/** Which base this answer is about, and which candidate. */
interface ReachIdentity {
  baseId: string;
  candidateId: string;
}

/**
 * A union rather than one shape with nine nullable fields, and the reason is
 * that a reader must not be able to *forget* to check.
 *
 * With optional numbers, `reach.travelMinutes ?? 0` compiles, reads as
 * defensive, and puts a zero-minute hop on a board for a place nobody could
 * route — which is Phase 9's defect returning through the type system. Here
 * there is no number to reach for until `status` has been read.
 */
export type ReachFromBase = ReachResolved | ReachUnresolved;

export interface ReachResolved extends ReachIdentity {
  status: 'measured';
  reachable: true;
  conflict: false;
  mode: TransportMode;
  /** One way, out. */
  travelMinutes: number;
  /** One way, home. Resolved separately: a timetable is not symmetric. */
  returnMinutes: number;
  roundTripMinutes: number;
  /**
   * The part of the round trip actually spent at a wheel, which is the only
   * part the driving budget bounds. Zero on a journey nobody drives.
   */
  driveMinutes: number;
  /** Road distance, where the outbound mode puts kilometres on a vehicle. */
  distanceKm: number | null;
  provenance: LegProvenance;
  /** Which rule chose the outbound mode, so the choice can be explained. */
  rule: LegRule;
}

export interface ReachUnresolved extends ReachIdentity {
  status: 'conflict' | 'unmeasured';
  /** `false` is a refusal this traveller caused; `null` is "we do not know". */
  reachable: false | null;
  /** True when the traveller's own answers rule out every measured option. */
  conflict: boolean;
  reason: UnmeasuredTravelReason;
  detail: string;
}

/**
 * Deliberately slow. A road distance walked by somebody carrying a day bag, so
 * the derived figure should err long: a number that understates a walk puts a
 * traveller at a gate after it shut.
 */
export const MODELLED_WALK_KMH = 4.5;

/**
 * A WALK DERIVED FROM A ROAD DISTANCE, WHEN ONE CAN HONESTLY BE DERIVED.
 *
 * The contract says the compiler measures the network a trip is made on. When
 * that contract breaks — a car-free scope stored with a `car` matrix, which a
 * live Tokyo compilation actually produced — `resolveLeg` correctly refuses
 * every pair: a road *duration* is not a walk, and the traveller may not drive.
 * The refusal is right about every leg and wrong about the trip, because it
 * turns "the matrix measured the wrong network" into "there is no legal way in
 * to any of these places" over stops that are a fifteen-minute stroll from the
 * hotel.
 *
 * WHY IT LIVES HERE. The planner grew this repair first, in its own module, and
 * a fresh reviewer found the consequence on a real board: the planner walked to
 * a stop 1.2 road-km away while the Discovery Board — which resolves reach
 * through `resolveCandidateReach` and knew nothing about the derivation — called
 * the same stop a transport conflict, scored it out and left auto-pick with
 * nothing to select. Two modules answering one question two ways is the defect
 * this whole module exists to end, so the derivation belongs beside the
 * resolution rather than beside one of its callers.
 *
 * The three invariants it must never break:
 *
 *   - a road *time* never stands in for any other mode — only the distance is
 *     read, and only to derive a walk;
 *   - it never renders as transit — the mode is `walk`, always, and the
 *     provenance is `modelled` so no surface can present it as a measurement;
 *   - unknown stays unknown — no distance, or a distance past what this
 *     traveller said they would walk, stays a refusal.
 *
 * Null whenever any part of that fails, including when the matrix is *not* a
 * road matrix: a pedestrian matrix already measures walks, and second-guessing
 * a measurement with a model would be the substitution this layer exists to
 * stop.
 *
 * The cap is `knowledge.maxWalkMinutes` — the traveller's own answer to
 * "furthest you would walk to reach a stop" — and nothing else. A modelled
 * number is a guess stacked on a distance, so unlike a *measured* long walk,
 * which `resolveLeg` offers and lets the traveller judge, a modelled long walk
 * is refused outright.
 */
export function deriveModelledWalk(
  knowledge: TravelKnowledge,
  fromId: string,
  toId: string,
): (TravelOption & { mode: 'walk'; provenance: 'modelled' }) | null {
  if (knowledge.matrix.mode !== 'car') return null;
  const measured = tryLeg(knowledge.matrix, fromId, toId);
  if (!measured || measured.km <= 0) return null;
  const minutes = Math.ceil((measured.km * 60) / MODELLED_WALK_KMH);
  if (minutes > knowledge.maxWalkMinutes) return null;
  return {
    mode: 'walk',
    minutes,
    /*
     * The road distance, carried so the leg can be checked against the same
     * speed bounds every other leg is. It is the basis of the model, not a
     * claim about the footpath.
     */
    km: measured.km,
    provenance: 'modelled',
    source: 'derived from road distance at a conservative walking pace',
  };
}

/**
 * Deliberately slow, like the walking figure above it. Twenty km/h is a dense
 * urban door-to-door pace — junctions, one-way loops, finding somewhere to put
 * the car — and it also absorbs the gap between the pedestrian network the
 * distance was measured on and the longer road a car actually takes. A figure
 * that overstates a drive delays a traveller; one that understates it strands
 * them, so the model errs long.
 */
export const MODELLED_DRIVE_KMH = 20;

/**
 * A DRIVE DERIVED FROM A PEDESTRIAN DISTANCE, FOR THE TRAVELLER WHO DRIVES.
 *
 * The mirror of `deriveModelledWalk`, and the same contract breach behind it:
 * the compiler measures the network a trip is made on, and when the stored
 * matrix is pedestrian while the traveller declared a car, every journey prices
 * as a walk. On a served board that read as "N min on foot from base" on every
 * card and "2 hr 6 min each way on foot is past how far you said you would go"
 * on the skip list — a walking budget attributed to somebody whose stated
 * budget was minutes at a wheel, with verdicts derived from it.
 *
 * The same three invariants as the walk derivation, mirrored:
 *
 *   - a pedestrian *time* never stands in for a drive — only the distance is
 *     read, and only to derive one;
 *   - the mode is `drive` and the provenance is `modelled`, so no surface can
 *     present the figure as a measurement;
 *   - unknown stays unknown — no distance stays a refusal, and a matrix that is
 *     not pedestrian returns null, because a road matrix already measures
 *     drives and second-guessing a measurement with a model is the substitution
 *     this layer exists to stop.
 *
 * Null for a traveller whose permitted modes hold no drive: this derivation
 * exists to price the declared mode, never to invent one. Walk pricing stays
 * exactly as it was for walkers — the transit-blind gate above is their honest
 * treatment, and this function is the driver's.
 */
export function deriveModelledDrive(
  knowledge: TravelKnowledge,
  fromId: string,
  toId: string,
): (TravelOption & { mode: 'drive'; provenance: 'modelled' }) | null {
  if (knowledge.matrix.mode !== 'foot') return null;
  if (!knowledge.permitted.has('drive')) return null;
  const measured = tryLeg(knowledge.matrix, fromId, toId);
  if (!measured || measured.km <= 0) return null;
  const minutes = Math.ceil((measured.km * 60) / MODELLED_DRIVE_KMH);
  return {
    mode: 'drive',
    minutes,
    /*
     * The pedestrian-network distance, carried as the basis of the model — not
     * a claim about the road, exactly as the modelled walk carries the road
     * distance it was derived from.
     */
    km: measured.km,
    provenance: 'modelled',
    source: 'derived from the walking-network distance at a cautious city driving pace',
  };
}

/**
 * `resolveLeg`, then the honest repair for a matrix that measured the wrong
 * network: the modelled walk when nothing usable was measured at all, and the
 * modelled drive when the only measured answer is a walk past the traveller's
 * own walking tolerance and they declared a car. A walk inside that tolerance
 * stays a walk — driving two streets is not a saving — and a measured ride is
 * never second-guessed by a model.
 */
function resolveReachLeg(
  knowledge: TravelKnowledge,
  fromId: string,
  toId: string,
  legal: TransportMode,
): ResolvedLeg {
  const resolved = resolveLeg(knowledge, fromId, toId, legal);
  if (resolved.ok) {
    if (
      resolved.mode === 'walk' &&
      resolved.minutes > knowledge.maxWalkMinutes &&
      knowledge.permitted.has('drive')
    ) {
      const drive = deriveModelledDrive(knowledge, fromId, toId);
      if (drive) return { ok: true, fromId, toId, rule: 'modelled_drive', ...drive };
    }
    return resolved;
  }
  const walk = deriveModelledWalk(knowledge, fromId, toId);
  return walk ? { ok: true, fromId, toId, rule: 'modelled_walk', ...walk } : resolved;
}

export function resolveCandidateReach(
  knowledge: TravelKnowledge,
  baseId: string,
  candidateId: string,
): ReachFromBase {
  /*
   * The matrix's own mode is what the matrix may answer for; transit is added by
   * `resolveLeg` whenever a journey was measured for the pair. A traveller with
   * no car therefore gains nothing from a road matrix here — the permission
   * filter removes the only option it could have offered — which is the second
   * half of the guarantee and the reason this cannot be written as "take
   * whatever number is available".
   */
  const legal = matrixMode(knowledge.matrix);
  const unresolved = (leg: UnresolvedLeg): ReachUnresolved => ({
    baseId,
    candidateId,
    /*
     * A conflict is a *no*; anything else is a *don't know*. The difference is
     * the whole reason this returns three states: "you told us you will not
     * drive and the road is the only thing measured here" is an answer the
     * traveller can act on, and "the journey planner did not reply" is not an
     * answer at all.
     */
    reachable: leg.conflict ? false : null,
    status: leg.conflict ? 'conflict' : 'unmeasured',
    reason: leg.reason,
    conflict: leg.conflict,
    detail: leg.detail,
  });

  const out = resolveReachLeg(knowledge, baseId, candidateId, legal ?? 'unsupported');
  if (!out.ok) return unresolved(out);
  /*
   * Both directions, and the way home is the one that fails. A car-free trip
   * out to a valley on the last morning bus is a trip that ends there; the
   * outbound measurement alone would have called it reachable.
   */
  const back = resolveReachLeg(knowledge, candidateId, baseId, legal ?? 'unsupported');
  if (!back.ok) return unresolved(back);

  return {
    baseId,
    candidateId,
    reachable: true,
    mode: out.mode,
    travelMinutes: out.minutes,
    returnMinutes: back.minutes,
    roundTripMinutes: out.minutes + back.minutes,
    driveMinutes:
      (out.mode === 'drive' ? out.minutes : 0) + (back.mode === 'drive' ? back.minutes : 0),
    distanceKm: out.km,
    provenance: out.provenance,
    rule: out.rule,
    status: 'measured',
    conflict: false,
  };
}

/**
 * HOW FAR THIS TRAVELLER WILL WALK ON A LEG THIS PRODUCT INSTRUCTS.
 *
 * The **walking-leg bound**, and the first of the two bounds this module keeps
 * apart. It answers one question and is spent on nothing else: *how far will
 * they walk on a leg we lay, and what may we say when we refuse one in walking
 * terms.* Every leg the itinerary renders as a walk, and every refusal that
 * quotes a walking clock, is held to it.
 *
 * It takes no options, and the omission is the guarantee. The journey bound
 * below widens for a walk that is only standing in for an unpriced ride — and
 * the moment that widened figure was spent on this question, a traveller who
 * had answered twenty-five minutes was handed a per-leg ceiling of a hundred
 * and twelve and two live car-free itineraries laid legs reading "Walk to X —
 * 67 min on foot". There is no parameter here that could carry that fact, so
 * there is no way to widen this bound with it.
 *
 * `maxAccessWalkMinutes` is the answer; the driving radius joins it only for a
 * traveller who drives, for whom the two questions were asked of the same
 * person about the same journeys.
 */
export function walkingLegBoundMinutes(profile: TravelerProfile): number {
  const drivingRadius = profile.transport.willDrive
    ? Math.max(1, profile.derived.effectiveDetourMinutes)
    : 0;
  return Math.max(drivingRadius, profile.transport.maxAccessWalkMinutes);
}

/**
 * HOW FAR OUT THIS TRAVELLER WILL GO, IN THE MODE THEY WOULD ACTUALLY GO IN.
 *
 * The **journey/reach bound**, and the second of the two. It answers *can this
 * traveller reach this place at all* — the question candidate feasibility and
 * detour classification ask — and it is the only one of the two that may be
 * widened when a walking figure is standing in for a journey nobody could
 * price. It is never the ceiling on a leg the product instructs on foot; that
 * is `walkingLegBoundMinutes` above.
 *
 * One radius per traveller was the assumption, and it was wrong in the one place
 * it mattered most. `derived.effectiveDetourMinutes` is a *driving* figure — it
 * is negotiated from the road-trip questions and, for anybody who said they will
 * not drive, it is replaced wholesale by a twenty-minute constant whose comment
 * reads "only the base town and its trolley stops are realistically reachable".
 *
 * That sentence is a claim about a world without timetables. Applied to a city
 * with a measured metro, it turns a twenty-seven minute train — a journey this
 * product paid a provider to measure — into a detour past the traveller's limit,
 * and from there into a scoring penalty, a `weak_fit`, and a card they never see.
 *
 * So the radius is chosen by the mode the journey is actually made in:
 *
 *   - a **drive** is bounded by the driving radius, unchanged;
 *   - a **ride** — train, bus, ferry, shuttle — is bounded by half the
 *     traveller's own daily transport budget, which is the furthest thing that
 *     can be reached and returned from inside a day they said they would accept.
 *     Never below the driving radius, so this only ever widens;
 *   - a **walk** is bounded by what they said they would walk, and by the
 *     driving radius, whichever is larger — unless the walk is only pricing the
 *     journey because nobody could price the ride, in which case it is bounded
 *     like the ride. See `transitUnmeasured` below.
 *
 * "The driving radius" in the walking rule is the driving radius and not the
 * stated figure, which are the same number only for somebody who drives. A
 * traveller with no car answers the one-way slider about trains, buses and
 * shuttles — the question says so on the screen — and that answer reached this
 * branch as a walking allowance the moment it stopped being replaced by a
 * constant. The audited defect it would have re-opened is on the record: an
 * hour-plus measured walk, each way, day after day, for somebody who had
 * answered twenty minutes on foot. A ride answer may widen a ride and never a
 * walk.
 *
 * Nothing here is a distance. The numbers are all the traveller's own answers.
 */
export function detourToleranceMinutesFor(
  profile: TravelerProfile,
  mode: TransportMode,
  /**
   * WHETHER THIS WALK IS THE JOURNEY, OR A STAND-IN FOR ONE NOBODY COULD PRICE.
   *
   * `transitUnmeasured` is `scheduledTransportUnmeasured(knowledge)`: the
   * compilation signed that nothing could time a scheduled journey, over ground
   * whose evidence observes a scheduled network. Where that holds, the walking
   * figure on a car-free trip is not a walk anybody intends to take — it is the
   * only network the compiler could route, standing in for the trains the
   * traveller will actually ride — so bounding it by walking appetite answers a
   * question about the wrong mode. Two live car-free dense-metro boards priced
   * every canonical seat at thirty-nine to seventy minutes on foot and refused
   * each one against a twenty-five minute answer about the last mile from a
   * stop; one delivered a single scheduled stop out of a twenty-four card board.
   *
   * So the bound becomes the ride bound — half the daily transport budget, the
   * same arithmetic the ride branch below uses — because that is the journey
   * they will make. The walk keeps its measured minutes on the card as the
   * honest upper bound; only the verdict about how far away this is changes.
   *
   * It widens *this* bound and nothing else. A leg the product instructs on
   * foot, and a refusal phrased in walking minutes, are held to
   * `walkingLegBoundMinutes`, which cannot be handed this fact at all.
   *
   * Optional, and absent is the walking bound: a caller with no travel
   * knowledge in hand cannot establish the gap, and an unestablished gap is not
   * a licence to widen anything.
   */
  options?: { transitUnmeasured?: boolean },
): number {
  const stated = Math.max(1, profile.derived.effectiveDetourMinutes);
  if (mode === 'drive') return stated;
  if (mode === 'walk' && !options?.transitUnmeasured) return walkingLegBoundMinutes(profile);
  /*
   * Half a day's transport, because a detour is a there-and-back. The cap is
   * the traveller's answer to "how much getting about will you accept in a
   * day", so the furthest thing inside it is exactly half of it — and a
   * candidate at that radius spends the whole budget, which is why
   * `classifyDetour` still checks the round trip afterwards rather than
   * treating this as a licence.
   */
  return Math.max(stated, Math.floor(profile.transport.maxDailyTransportMinutes / 2));
}

/**
 * The one stretch band both verdicts about a journey must share. The board's
 * detour classifier permits a journey past the radius above but within
 * radius × this multiplier as a stretch — further than the traveller said they
 * would usually go, but a strong enough fit it earns the extra journey — and
 * the planner's leg resolution accepts the same band, because a board that
 * promises a stretch the planner refuses is two verdicts about one journey.
 */
export const DETOUR_STRETCH_MULTIPLIER = 1.5;

/**
 * HOW A JOURNEY IS MADE, AS A TRAVELLER WOULD SAY IT.
 *
 * One map, read by the board card, the fit reasons and the backup summaries, so
 * that a train cannot be a train on one screen and a drive on the next. The
 * phrases complete a duration: "27 min **by train**", "12 min **on foot**".
 *
 * `TRANSPORT_MODE_LABELS` is the noun form and is not interchangeable with this
 * — "27 min Train" is not a sentence, and the previous board wrote exactly that
 * class of string by pasting an enum label after a number.
 */
export const REACH_MODE_PHRASE: Record<TransportMode, string> = {
  drive: 'by car',
  walk: 'on foot',
  shuttle: 'by shuttle',
  public_bus: 'by bus',
  rail: 'by train',
  ferry: 'by ferry',
  rideshare: 'by taxi',
  private_transfer: 'by private transfer',
  bicycle: 'by bike',
  /*
   * Reachable through a mode this product does not model. It cannot be produced
   * by `resolveLeg` — `matrixMode` never returns it and no transit journey maps
   * to it — but the enum has the case and a silent gap in a label map renders as
   * `undefined` on a card.
   */
  unsupported: 'by a means we cannot describe',
};

/**
 * WHAT THE TRAVELLER IS TOLD ABOUT GETTING THERE.
 *
 * The whole of §8's rule in one function, so a surface cannot invent its own
 * phrasing and cannot accidentally print a road duration for a train. Three
 * shapes, and the difference between the last two is the difference between a
 * decision and a gap:
 *
 *   - measured   → `27 min by train`
 *   - conflict   → `No usable route from your base`
 *   - unmeasured → `Journey not verified`
 *
 * The duration formatter is injected because "1 hr 20 min" is the web app's
 * house style and core does not own it. Nothing else about the sentence is the
 * caller's to choose.
 */
export function describeReachFromBase(
  reach: ReachFromBase,
  formatMinutes: (minutes: number) => string,
): string {
  if (reach.status === 'measured') {
    const figure = `${formatMinutes(reach.travelMinutes)} ${REACH_MODE_PHRASE[reach.mode]}`;
    /*
     * "About" is what a person says of a figure they worked out rather than
     * read. A modelled duration must never print with a measurement's
     * confidence — the same rule the board applies to its own travel phrase.
     */
    return reach.provenance === 'modelled' ? `about ${figure}` : figure;
  }
  return reach.status === 'conflict' ? 'No usable route from your base' : 'Journey not verified';
}

function matrixOption(knowledge: TravelKnowledge, fromId: string, toId: string): TravelOption | null {
  const mode = matrixMode(knowledge.matrix);
  if (!mode) return null;
  /*
   * `tryLeg`, not `leg` inside a bare `catch`.
   *
   * A sparse matrix writes NaN for a pair nobody measured — deliberately, and
   * `geo` says so — and `leg` throws on one. Constructing an exception per
   * unmeasured cell, per leg, per day, per layout variant is a real cost on
   * exactly the sparse regions that hit it most. The bare `catch` was also
   * swallowing every other error class `leg` can raise, including a corrupt
   * diagonal, and turning a matrix that should fail loudly into a quiet "no road
   * option here".
   */
  const measured = tryLeg(knowledge.matrix, fromId, toId);
  if (!measured) return null;
  return {
    mode,
    minutes: measured.minutes,
    km: measured.km,
    provenance: knowledge.matrix.provenance.kind,
    ...(knowledge.matrix.provenance.source ? { source: knowledge.matrix.provenance.source } : {}),
  };
}

function transitOption(
  knowledge: TravelKnowledge,
  fromId: string,
  toId: string,
): { option: TravelOption | null; journey: TransitJourneyRecord | null } {
  const journey = knowledge.journeys.get(pairKey(fromId, toId)) ?? null;
  if (!journey || journey.status !== 'measured' || journey.minutes === undefined) {
    return { option: null, journey };
  }
  const mode = transitModeOf(journey);
  if (!mode) return { option: null, journey };
  return {
    journey,
    option: {
      mode,
      minutes: journey.minutes,
      /*
       * Never a road distance. A metro ride is minutes on the day, not
       * kilometres on a car, and the day's `travelKm` is what the vehicle
       * covered — folding a rail distance into it would inflate a figure the
       * traveller reads as driving.
       */
      km: null,
      /*
       * `official`, not `measured`. A multimodal route is computed against the
       * operators' published timetables, and the itinerary renders the two
       * differently on purpose — "published timetable" against "measured travel
       * time". Calling this measured would claim somebody stood at the platform
       * with a stopwatch.
       */
      provenance: 'official',
      source: journey.source,
      ...(journey.transfers === undefined ? {} : { transfers: journey.transfers }),
      ...(journey.walkingMinutes === undefined ? {} : { walkingMinutes: journey.walkingMinutes }),
      basis: journey.requestBasis,
    },
  };
}

/**
 * The mode for one ordered pair, chosen from what was measured for that pair.
 *
 * `allowed` is the set of modes this particular leg may legally use, which is a
 * different question from what the traveller will accept. The access dataset
 * decides it: a gateway reached only by shuttle is reached only by shuttle, and
 * a road that does not exist cannot be invented because a car is available. So
 * the caller passes the mode its access rule declared, and this function may add
 * *measured public transport* to it and nothing else — a measured journey
 * between two points is direct evidence that the journey is possible, which is
 * the one thing no other source here can assert.
 *
 * The ordering, in full:
 *
 *   1. a walk inside the traveller's stated tolerance beats everything, because
 *      waiting for a train to save four minutes is not a saving;
 *   2. otherwise measured transit, which is what a long pair in a served city
 *      actually is;
 *   3. otherwise the road, for a traveller who has a car;
 *   4. otherwise whatever single permitted option is left.
 *
 * Nothing here compares straight-line distance, and nothing chooses a mode
 * because the destination is the sort of place that usually has one.
 */
export function resolveLeg(
  knowledge: TravelKnowledge,
  fromId: string,
  toId: string,
  allowed: TransportMode | readonly TransportMode[],
  /**
   * What the day has already spent at the wheel, when the caller is tracking it.
   *
   * Absent by default, and absent everywhere except the scheduler. What it buys
   * is one narrow correction: the ordered rules below pick the *quickest*
   * measured option, which is right until the quickest one is a drive the
   * traveller has no budget left for. The packer then refuses the whole stop —
   * so a day dropped a museum for want of twenty minutes at a wheel while a
   * measured train sat in the evidence, unconsidered, because the mode was
   * chosen before anyone asked what it would cost.
   *
   * Deliberately not a general optimiser. It removes an option the traveller
   * demonstrably cannot afford; it does not score, rank or trade anything off.
   */
  spent?: { driveMinutes: number },
): ResolvedLeg {
  const legal = typeof allowed === 'string' ? [allowed] : allowed;
  const options: TravelOption[] = [];

  const road = matrixOption(knowledge, fromId, toId);
  /*
   * The matrix answers only for a mode this leg is legally made in. A pedestrian
   * matrix does not license a drive and a road matrix does not license a walk —
   * they measure different networks — and this membership test is what stops the
   * substitution the module exists to prevent.
   *
   * A *set* rather than one mode, because two of the callers legitimately have
   * two answers. Retracing a step to a parked car is made in the mode the
   * traveller left in, and it is also a pair the matrix may have measured; with
   * a single mode, passing the retraced one locked the matrix out of the return
   * entirely and the caller fell back to the outbound journey's duration — one
   * pair answered with another pair's number, reached through this function's own
   * signature. Passing the matrix's mode alone was worse: it turned the walk back
   * to a parked car into a drive.
   */
  if (road && legal.includes(road.mode)) options.push(road);

  const { option: transit, journey } = transitOption(knowledge, fromId, toId);
  if (transit) options.push(transit);

  const permitted = options.filter((option) => knowledge.permitted.has(option.mode));

  /*
   * A drive the day can no longer pay for is not an option, provided something
   * else measured can carry this leg. When driving is all there is, it stays —
   * an unaffordable drive is a refusal the packer should make loudly, not one
   * this function should disguise as "nothing was measured".
   */
  const hasAlternative = permitted.some((option) => option.mode !== 'drive');
  const usable =
    spent === undefined || !hasAlternative
      ? permitted
      : permitted.filter(
          (option) =>
            option.mode !== 'drive' ||
            spent.driveMinutes + option.minutes <= knowledge.maxDailyDriveMinutes,
        );

  if (usable.length === 0) {
    /*
     * Nothing usable. Which of the three sentences the traveller gets depends on
     * why, and they are not interchangeable.
     */
    const refusedForPermission = options.length > 0 && permitted.length === 0;
    if (refusedForPermission) {
      /*
       * Traveller-facing words, never enum values. This string used to join the
       * raw modes — "public_bus" on a card — and Phase 15D widened its audience:
       * it now travels on `ReachFromBase.detail` into the board's client
       * payload, one untested renderer away from a screen.
       */
      const named = options.map((option) => REACH_MODE_PHRASE[option.mode]).join(', or ');
      if (unaskedScheduledModes(knowledge)) {
        return {
          ok: false,
          fromId,
          toId,
          reason: 'mode_not_routed',
          conflict: false,
          detail: `The only journey anybody measured between these two is ${named}, which this trip rules out — and nothing here could time the trains, buses or ferries it would use instead.`,
        };
      }
      return {
        ok: false,
        fromId,
        toId,
        reason: 'mode_not_routed',
        conflict: true,
        detail: `The only measured way between these two is ${named}, which this trip rules out.`,
      };
    }
    if (journey && journey.status === 'no_route') {
      return {
        ok: false,
        fromId,
        toId,
        reason: 'no_route_found',
        conflict: false,
        detail: journey.detail,
      };
    }
    return {
      ok: false,
      fromId,
      toId,
      reason: 'mode_not_routed',
      conflict: false,
      detail: 'Nothing configured here can measure this journey.',
    };
  }

  const walk = usable.find((option) => option.mode === 'walk');
  if (walk && walk.minutes <= knowledge.maxWalkMinutes) {
    return { ok: true, fromId, toId, rule: 'walk_within_tolerance', ...walk };
  }

  if (usable.length === 1) {
    /*
     * One option, which on the great majority of trips is the whole story: a
     * driving region has a road matrix and no timetables, and there is nothing
     * to choose between. Named as its own rule so a test can tell "this was the
     * only thing measured" from "this won on the clock".
     */
    return { ok: true, fromId, toId, rule: 'sole_option', ...usable[0]! };
  }

  /*
   * Beyond a comfortable walk, the quickest of what was actually measured.
   *
   * Not "transit, because this is a city": that would put a traveller on a train
   * to go two streets, and it would pick a mode on the strength of the
   * destination's reputation rather than on a measurement. Not "whatever the
   * matrix holds" either, which is the substitution this module exists to stop.
   *
   * Ties are broken by an explicit order rather than by array position, so the
   * answer does not depend on which option happened to be pushed first.
   */
  const order: Record<string, number> = { rail: 0, public_bus: 1, ferry: 2, walk: 3, drive: 4 };
  const best = [...usable].sort(
    (a, b) => a.minutes - b.minutes || (order[a.mode] ?? 9) - (order[b.mode] ?? 9),
  )[0]!;
  if (TRANSIT_MODES.includes(best.mode)) {
    return { ok: true, fromId, toId, rule: 'transit_measured', ...best };
  }
  if (best.mode === 'drive') {
    return { ok: true, fromId, toId, rule: 'road_measured', ...best };
  }
  /*
   * A walk longer than the traveller said they would take, and still the
   * quickest thing anybody measured.
   *
   * Offered rather than refused: refusing would delete a stop over a preference
   * the traveller can weigh for themselves, and the walk is genuinely measured —
   * it is the one number here nobody is guessing at, and the alternative was to
   * leave unmeasured a pair somebody actually measured.
   */
  return { ok: true, fromId, toId, rule: 'sole_option', ...best };
}

/**
 * WHICH OF A DAY'S FIVE TRAVEL BUCKETS A LEG'S MINUTES BELONG TO.
 *
 * One function, imported by the layout that accumulates the totals and by the
 * validator that re-derives them, because the check the validator performs is
 * *that the two agree* — and two copies of a rule cannot check each other.
 *
 * They were two copies, and they had already drifted apart in the way that
 * matters. The layout classified with "walk, else riding" at six sites and with
 * "drive, else walking" at four others; the validator classified with "drive,
 * else waiting, else walk, else riding". So a leg the access dataset declared a
 * `drive` with a stated allowance — legal, and reachable on any pedestrian
 * matrix — was charged to `transitMinutes` by the layout and to `driveMinutes`
 * by the validator. The day then failed `inconsistent_transport_totals`, and
 * until it did, the traveller's driving cap was being checked against a zero.
 *
 * `bicycle`, `rideshare` and `private_transfer` are riding rather than driving:
 * none of them is time at the wheel, which is the only thing the driving cap
 * bounds.
 *
 * `unverified` is the bucket a mode cannot decide, and it is asked first for
 * that reason. Where a measured walk is standing in for a scheduled journey
 * nobody could price, the leg's mode is the stand-in rather than the journey:
 * charging it by that mode booked every minute of a route the product had just
 * said it could not price as time on foot, and a car-free day reading
 * `{"walkMinutes":124}` told a traveller who answered twenty-five minutes to
 * plan two hours of walking. Its own bucket is what lets a total say how long
 * the day holds for such a leg without saying how it is made.
 */
export type TravelBucket = 'drive' | 'transit' | 'walk' | 'wait' | 'unverified';

export function travelBucketFor(
  mode: TransportMode,
  role: string,
  /** True only on a leg whose mode stands in for a journey nobody could price. */
  unverifiedScheduled = false,
): TravelBucket {
  if (unverifiedScheduled) return 'unverified';
  if (mode === 'drive') return 'drive';
  if (role === 'wait') return 'wait';
  if (mode === 'walk') return 'walk';
  return 'transit';
}

/**
 * Whether a leg's distance belongs in the day's road total.
 *
 * `travelKm` is documented as road distance — "a shuttle ride adds minutes here,
 * not kilometres" — and was accumulated on drives *and* on two of the homeward
 * walking branches, so a walking day reported kilometres under a heading the
 * itinerary renders as "Road distance".
 */
export function countsTowardRoadDistance(mode: TransportMode): boolean {
  return mode === 'drive';
}
