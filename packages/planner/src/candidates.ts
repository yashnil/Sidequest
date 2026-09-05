import {
  boardOrderingOf,
  boardPriorityOf,
  displayNameOf,
  establishedOrderingLean,
  INTEREST_EVIDENCE,
  INTERESTS,
  kindEvidences,
  namesOwnKind,
  type TravelerProfile,
} from '@sidequest/core';
import type {
  DiscoveryCandidate,
  DiscoverySelection,
  Interest,
  Place,
  UnscheduledPlace,
  UnscheduledReasonCode,
} from '@sidequest/core';
import { hasPoint, type TravelTimeMatrix } from '@sidequest/geo';
import type { TransportMode } from '@sidequest/core';
import { reachFromBase, type TravelKnowledge } from './travel';
import type { PlanningCandidate } from './types';

/**
 * What the matrix in hand is entitled to answer for.
 *
 * `unsupported` once multimodal knowledge was available and still could not
 * resolve the pair — because then the matrix's own mode is precisely the thing
 * this traveller may not use, and naming it would hand a road figure to a
 * driving budget belonging to somebody with no car.
 */
function matrixTravelMode(matrix: TravelTimeMatrix, resolverRan: boolean): TransportMode {
  if (resolverRan) return 'unsupported';
  return matrix.mode === 'foot' ? 'walk' : 'drive';
}

export interface ResolvedCandidates {
  eligible: PlanningCandidate[];
  /** Chosen but impossible. Never silently dropped. */
  rejected: UnscheduledPlace[];
}

/**
 * Priority bands. The gaps are wide enough that the board's own order can rank
 * places *within* a band but can never let an auto-pick outrank something the
 * traveller asked for by hand.
 */
const PRIORITY_BASE = {
  manual_included: 10_000,
  auto_included: 5_000,
  maybe: 1_000,
} as const;

/**
 * A CANDIDATE LIFTED INTO THE MANUAL BAND, KEEPING ITS PLACE IN THE BOARD'S ORDER.
 *
 * Pinning a stop and choosing a replacement by name are both "plan this as if
 * the traveller had picked it by hand", and both used to be written out by hand
 * at their own call site: `10_000 + fitScore` in `plan.ts` and in `edit.ts`'s
 * lock promotion, a bare `10_000` in its swap. All three threw the composed key
 * away — the first two for `fit.score`, which is the order the board stopped
 * using the moment significance entered it, and the third for nothing at all,
 * which flattened every hand-picked swap onto one number.
 *
 * One function, three callers, so the band offset and the within-band term
 * cannot come apart again. `Math.max` because a place already in this band —
 * hand-included on the board and then pinned — must not be *demoted* by being
 * promoted.
 */
export function pinnedPriority(candidate: PlanningCandidate): number {
  return Math.max(candidate.priority, PRIORITY_BASE.manual_included + candidate.boardPriority);
}

/**
 * The reason code for a selection whose candidate is not in the pool.
 *
 * `not_feasible` is a placeholder and it is the wrong word. The right one —
 * "this was on your board when you chose it and is not on the one we planned
 * against" — needs a value in `UNSCHEDULED_REASON_CODES`, which lives in
 * `packages/core/src/schemas/itinerary.ts` and is not this slice's to edit. The
 * per-place `reason` string below carries the truth in the meantime, so nothing
 * is silent; only the summary phrasing in `readiness.ts` is generic.
 *
 * Named as a constant rather than inlined so that swapping it for a dedicated
 * code is a one-line change at one site.
 */
const CANDIDATE_WITHDRAWN_CODE: UnscheduledReasonCode = 'selection_not_on_board';

/**
 * THE INTEREST THE PLAN MAY SPEAK FOR THIS PLACE — HELD TO THE PLACE'S OWN KIND.
 *
 * `fit.primaryInterest` is graded by the traveller but stamped through the
 * thirteen-value category bucket, and a bucket launders: a theme park files
 * under the food-and-towns category and, on a live plan, arrived carrying
 * `easy_nature_walks` — so its card read "Matches your interest in easy nature
 * walks" and its day was themed "Easy nature walks", over a seven-hour
 * amusement park. Every planner sentence built on this field claims that the
 * place *is* the interest, which is a claim about the record's own kind.
 *
 * So the interest the planner speaks has to be one the record's own identity
 * backs, and the kind channel alone is not enough to establish that. The
 * source-keyword channel matches substrings by design — `geolog` has to catch
 * `geology` — which means `theme_park` and `amusement_park` both contain
 * `park` and "evidence" an easy nature walk by the very channel that exists to
 * stop bucket-laundering. So a second witness is required when the channels
 * disagree:
 *
 *   - the *planning category itself* backs the interest → speak it. The
 *     thirteen-value bucket is coarse, but where it and the stamp agree —
 *     an `easy_walk` stamped `easy_nature_walks` — there is nothing to doubt;
 *   - the kind channels back it **and** the category is not positively
 *     claimed by a different interest → speak it. This is the case the
 *     category cannot see (`stargazing` has no category of its own);
 *   - otherwise say nothing. A theme park files under the food-and-towns
 *     category, which is `food_and_towns`' own ground — a nature-walk claim
 *     over it is exactly the contradiction the traveller laughed at. No
 *     substitute is hunted for, because a different interest the traveller
 *     never graded would be a different lie; the copy falls through to
 *     sentences that are true of any record.
 *
 * An authored place names no kind and keeps the curated verdict — its
 * interests and its category were written by the same hand.
 *
 * Deliberately only the *spoken* field. Frequency caps charge
 * `place.interests` directly and scoring is the board's; nothing about which
 * day a stop lands on changes here — only what the plan says about it.
 */
function categoryBacks(category: Place['category'], interest: Interest): boolean {
  return INTEREST_EVIDENCE[interest].categories?.includes(category) ?? false;
}

function categoryClaimedByAnother(category: Place['category'], interest: Interest): boolean {
  return INTERESTS.some((other) => other !== interest && categoryBacks(category, other));
}

function spokenInterestFor(candidate: DiscoveryCandidate): Interest | undefined {
  const primary = candidate.fit.primaryInterest;
  if (!primary) return undefined;
  /**
   * AND THE TRAVELLER HAS TO HAVE ASKED FOR IT.
   *
   * Everything below establishes that the *place* is the interest. The sentence
   * this field becomes — "Matches your interest in X" — makes a second claim on
   * top of that, about the person: that X is something they said they wanted.
   * Nothing was checking it.
   *
   * `primaryInterest` falls back to the place's best-graded interest whatever
   * that grade is (`scoring/fit.ts`), and `low` is shown to the traveller as
   * "Only if it is right there". So a delivered Osaka plan told a traveller who
   * had graded photography and easy nature walks at `low` that a viewpoint
   * "matches your interest in sunrise & sunset photography", and themed a whole
   * day "Easy nature walks around Osaka" — while the board's own fit record for
   * both places carried `matchedInterests: []`.
   *
   * `matchedInterests` is that record: the interests this place carries that
   * the traveller graded at `occasional` or above. Reading it here keeps one
   * definition of a match instead of a second, looser one — and leaves
   * `primaryInterest` alone for the board's frequency budgets, which charge
   * what a place *is* regardless of how it was graded.
   */
  if (!candidate.fit.matchedInterests.includes(primary)) return undefined;
  const { place } = candidate;
  if (!namesOwnKind(place)) return primary;
  if (categoryBacks(place.category, primary)) return primary;
  if (kindEvidences(place, primary) && !categoryClaimedByAnother(place.category, primary)) {
    return primary;
  }
  return undefined;
}

/**
 * Turns board selections into a planning queue.
 *
 * The contract that matters: a place the traveller actively chose either gets
 * scheduled or comes back in `rejected` with a reason. There is no third outcome
 * where it quietly disappears.
 *
 * That sentence has been in this file since the planner was written, and until
 * now it was false. The loop iterated the *candidate pool* and looked each
 * selection up inside it, so a selection whose candidate had left the pool was
 * visited by neither branch: not eligible, not rejected, not mentioned anywhere
 * on the finished plan. The traveller who pinned that place by hand was the one
 * who paid for it.
 *
 * The pool changes for entirely ordinary reasons — the region was recompiled,
 * deduplication merged two records into one, the evidence funnel dropped
 * something that could not be supported — so this was a routine loss rather than
 * an exotic one. The second pass below closes it: selections are iterated too,
 * and every one of them lands in exactly one list.
 */
export function resolveCandidates(
  candidates: readonly DiscoveryCandidate[],
  selections: readonly DiscoverySelection[],
  matrix: TravelTimeMatrix,
  /**
   * The same evidence the scheduler resolves legs from, and the base it would
   * resolve them against.
   *
   * Optional so that a caller with no multimodal knowledge — there are none in
   * the product, but the tests build inputs by hand — still gets the old
   * matrix-derived figure rather than nothing.
   */
  reach?: { knowledge: TravelKnowledge; baseId: string },
  /**
   * The traveller whose board this plan is built from, for the one ordering
   * term that depends on them: which way the significance lift leans. Optional
   * so a hand-built test input keeps the established-first order it always
   * had; `planTrip` always passes it, so the plan and the board agree about
   * the traveller by construction.
   */
  profile?: Pick<TravelerProfile, 'derived' | 'transport'>,
): ResolvedCandidates {
  const byPlaceId = new Map(selections.map((selection) => [selection.placeId, selection]));
  const candidateIds = new Set(candidates.map((candidate) => candidate.place.id));
  const eligible: PlanningCandidate[] = [];
  const rejected: UnscheduledPlace[] = [];

  for (const candidate of candidates) {
    const selection = byPlaceId.get(candidate.place.id);
    // Not chosen at all, or actively skipped. Neither is a conflict worth
    // reporting — the traveller already made that call.
    if (!selection || selection.status === 'excluded') continue;

    const manual = selection.source === 'user' && selection.status === 'included';

    if (candidate.fit.band === 'not_workable') {
      const blocker = candidate.fit.blockers[0];
      rejected.push({
        placeId: candidate.place.id,
        name: displayNameOf(candidate.place),
        wasManual: manual,
        reasonCode: reasonCodeForBlocker(blocker?.code),
        reason: blocker?.message ?? 'This one will not work on your dates or with your answers.',
        ...remedyFor(blocker?.code, profile?.transport.willDrive ?? false),
      });
      continue;
    }

    const routableOnDemand = Boolean(
      reach?.knowledge.travelLegs && hasPoint(reach.knowledge.travelLegs, candidate.place.id),
    );
    if (!hasPoint(matrix, candidate.place.id) && !routableOnDemand) {
      rejected.push({
        placeId: candidate.place.id,
        name: displayNameOf(candidate.place),
        wasManual: manual,
        reasonCode: 'missing_travel_data',
        reason: 'We have no travel time recorded to this place, so we cannot fit it into a day honestly.',
      });
      continue;
    }

    const base =
      selection.status === 'maybe'
        ? PRIORITY_BASE.maybe
        : manual
          ? PRIORITY_BASE.manual_included
          : PRIORITY_BASE.auto_included;

    /**
     * HOW FAR OUT THIS IS, RESOLVED RATHER THAN READ OFF A MISNAMED FIELD.
     *
     * `place.travelFromBase.driveMinutes` is whatever mode the compilation's
     * single matrix measured, under a name that says driving. Using it as the
     * arrival bound is what let a stop be ruled out before the scheduler had a
     * chance to reach it: a museum twenty minutes away by a measured metro
     * journey carried an eighty-five minute *walking* figure, and `boundsFor`
     * pushed its earliest arrival eighty-five minutes into the day.
     *
     * Nothing is *rejected* here. Whether a place can be reached at all is the
     * access layer's judgement and it has more to go on than this does — an
     * authored shuttle reaches places no matrix leg does, and a pre-filter that
     * refused them would delete stops the scheduler could plan. What this
     * changes is the number and the mode, so that every reader downstream is
     * measuring the right thing against the right budget.
     *
     * Since Phase 15D the board resolves the same relationship through the same
     * function, so `candidate.travelMinutesFromBase` and `reached` are the same
     * journey by construction rather than by two modules agreeing to be careful.
     * This still resolves rather than reading the card, because the planner may
     * be handed a base the board was not built against — a multi-base trip
     * re-measures per day — and because a planner that trusts a number it was
     * given cannot notice when the two disagree.
     */
    const reached = reach ? reachFromBase(reach.knowledge, reach.baseId, candidate.place.id) : null;

    const boardPriority = boardPriorityOf(
      boardOrderingOf({
        ...candidate,
        ...(profile ? { establishedLean: establishedOrderingLean(profile) } : {}),
      }),
    );

    const spokenInterest = spokenInterestFor(candidate);

    eligible.push({
      place: candidate.place,
      /**
       * THE ORDER THE TRAVELLER WAS JUST SHOWN, NOT A SECOND ONE.
       *
       * This was `base + candidate.fit.score`, and it stopped agreeing with the
       * board the moment the board composed its order out of two terms. Inside
       * one selection band the plan ranked by match alone while the board ranked
       * by the label it printed and then by how much each place matters — so of
       * two candidates the fit scorer could not separate, the board put one
       * first and the trip put the other first, with nothing anywhere saying
       * why. It is the §10 complaint in its most literal form: the plan
       * disagreeing with the board it was built from.
       *
       * `boardPriorityOf` is the board's own composed key, exported from where
       * the comparator lives, and it stays on `fit.score`'s 0–100 scale — so the
       * band offsets above keep their meaning.
       *
       * The key is rebuilt from the place and the fit rather than read off
       * `candidate.ordering`, for the same reason `reached` is resolved below:
       * `boardOrderingOf` is a pure function of exactly those two, so the
       * rebuild is the board's answer by construction, and it cannot inherit a
       * carried key that describes some earlier version of the card.
       *
       * It is also kept on the candidate below, because the band offset is not
       * the last word on priority: a pin lifts a place into the manual band, and
       * a promotion that re-derived the within-band term from `fitScore` would
       * undo this composition for precisely the places the traveller cared most
       * about.
       */
      priority: base + boardPriority,
      boardPriority,
      manual,
      selectionStatus: selection.status,
      fitScore: candidate.fit.score,
      matchedInterests: candidate.fit.matchedInterests,
      durationMinutes: candidate.place.typicalDurationMinutes,
      /*
       * Three cases, and the middle one is the fix within the fix.
       *
       * Resolved: the measured journey. No knowledge at all (`reach` absent —
       * only direct unit callers): the legacy scalar, exactly as before.
       * Knowledge present and the journey *failed to resolve*: **zero**, not
       * the scalar. The first version fell through `null ?? driveMinutes` and
       * handed the road matrix's figure to a traveller with no car — so a
       * card that honestly said "no usable route" was planned with an earliest
       * arrival ninety-five minutes into the day, off the exact number the
       * resolver had just declined to endorse. Zero claims nothing: the bounds
       * do not delay it, and whether it can actually be reached is decided
       * where it always was — the access rules and the scheduler's own leg
       * resolution, which have more to go on than this does.
       */
      travelMinutesFromBase: reached?.ok
        ? reached.outMinutes
        : reach !== undefined
          ? 0
          : (candidate.travelMinutesFromBase ?? candidate.place.travelFromBase.driveMinutes),
      /*
       * `unsupported` when nothing resolved, which is the honest answer and the
       * safe one: it is the one mode no budget claims, so a figure taken off a
       * road matrix can never be charged to a driving cap for a traveller who
       * told us they have no car.
       */
      travelModeFromBase: reached?.ok ? reached.mode : matrixTravelMode(matrix, reach !== undefined),
      ...(spokenInterest ? { primaryInterest: spokenInterest } : {}),
    });
  }

  /*
   * THE SECOND PASS, AND THE WHOLE POINT OF IT.
   *
   * Everything above walks the candidate pool. This walks the selections, which
   * is the only way a choice with no candidate behind it can be seen at all.
   *
   * An `excluded` selection is skipped here for the same reason it is skipped
   * above — the traveller said no, and reporting their own decision back to them
   * as an unscheduled place would be noise. Everything else gets a row.
   *
   * The place has no name to show, because the record that carried the name is
   * exactly what went missing. The identity is used instead: ugly, and true.
   * Inventing a plausible name for a record we cannot find would be the same
   * class of mistake one layer down.
   */
  for (const selection of selections) {
    if (selection.status === 'excluded') continue;
    if (candidateIds.has(selection.placeId)) continue;

    rejected.push({
      placeId: selection.placeId,
      name: selection.placeId,
      wasManual: selection.source === 'user' && selection.status === 'included',
      reasonCode: CANDIDATE_WITHDRAWN_CODE,
      reason:
        'You chose this, and it is not on the board we planned against — the region has been rebuilt since. We will not quietly leave it out, but we cannot place it either.',
      suggestedRemedy:
        'Open the board again and pick it back up if it is still there; if it is not, the reconciliation panel says what became of it.',
    });
  }

  // Highest priority first; id breaks ties so the queue is stable.
  eligible.sort((a, b) => b.priority - a.priority || a.place.id.localeCompare(b.place.id));
  rejected.sort((a, b) => Number(b.wasManual) - Number(a.wasManual) || a.placeId.localeCompare(b.placeId));

  return { eligible, rejected };
}

function reasonCodeForBlocker(code: string | undefined): UnscheduledReasonCode {
  switch (code) {
    case 'closed_on_your_dates':
      return 'seasonally_closed';
    // A different fact with a different remedy: the road is open and the doors
    // are not. Collapsing the two would send someone to check road conditions
    // about a museum that shuts on Wednesdays.
    case 'no_open_hours':
      return 'closed_on_trip_dates';
    case 'exceeds_daily_travel':
      return 'exceeds_daily_travel';
    case 'mobility':
    case 'too_strenuous':
      return 'exceeds_intensity';
    // Transport blockers keep their own codes all the way to the conflict list,
    // so the traveller is told which of their answers to change rather than
    // being handed a generic "this will not work".
    case 'needs_car':
    case 'mode_declined':
      return 'transport_mode_unavailable';
    case 'service_unavailable':
      return 'service_not_operating';
    case 'no_way_in':
      return 'access_unavailable';
    default:
      return 'not_feasible';
  }
}

/** The smallest change that would make this schedulable, where one exists. */
/**
 * `hasCar` decides one clause, and defaults to false when no profile was given.
 *
 * The conservative default is deliberate: with nothing known about the
 * traveller, proposing they acquire a vehicle is the one answer that can
 * contradict something they already said, and "this is one to drop" cannot.
 * `planTrip` always passes a profile, so only hand-built inputs take the
 * default.
 */
function remedyFor(code: string | undefined, hasCar: boolean): { suggestedRemedy?: string } {
  switch (code) {
    case 'closed_on_your_dates':
      return { suggestedRemedy: 'Move your dates into its open season, or drop it from the board.' };
    case 'no_open_hours':
      return {
        suggestedRemedy: 'Move your dates onto days it opens, or drop it from the board.',
      };
    case 'exceeds_daily_travel':
      return { suggestedRemedy: 'Raise your daily travel limit in the questionnaire, or treat this as a trip of its own.' };
    case 'rough_road':
      return { suggestedRemedy: 'Say you are comfortable with graded dirt roads, if you are.' };
    case 'mobility':
    case 'too_strenuous':
      return { suggestedRemedy: 'Raise the effort level you are happy with, or pick a gentler alternative from the board.' };
    case 'needs_car':
      return {
        suggestedRemedy: hasCar
          ? 'This needs a vehicle. Renting one would open up most of the region.'
          : 'Nothing scheduled goes there and a vehicle is the only way in, so this is one to drop.',
      };
    case 'service_unavailable':
      return { suggestedRemedy: 'Move your dates into the season the service runs, or drop it.' };
    case 'mode_declined':
      return {
        suggestedRemedy: 'Say you are willing to use a shuttle — it is the only way in here.',
      };
    default:
      return {};
  }
}
