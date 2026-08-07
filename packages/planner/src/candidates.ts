import type {
  DiscoveryCandidate,
  DiscoverySelection,
  UnscheduledPlace,
  UnscheduledReasonCode,
} from '@sidequest/core';
import { hasPoint, type TravelTimeMatrix } from '@sidequest/geo';
import type { PlanningCandidate } from './types';

export interface ResolvedCandidates {
  eligible: PlanningCandidate[];
  /** Chosen but impossible. Never silently dropped. */
  rejected: UnscheduledPlace[];
}

/**
 * Priority bands. The gaps are wide enough that fit score can order places
 * *within* a band but can never let an auto-pick outrank something the traveller
 * asked for by hand.
 */
const PRIORITY_BASE = {
  manual_included: 10_000,
  auto_included: 5_000,
  maybe: 1_000,
} as const;

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
        name: candidate.place.name,
        wasManual: manual,
        reasonCode: reasonCodeForBlocker(blocker?.code),
        reason: blocker?.message ?? 'This one will not work on your dates or with your answers.',
        ...remedyFor(blocker?.code),
      });
      continue;
    }

    if (!hasPoint(matrix, candidate.place.id)) {
      rejected.push({
        placeId: candidate.place.id,
        name: candidate.place.name,
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

    eligible.push({
      place: candidate.place,
      priority: base + candidate.fit.score,
      manual,
      selectionStatus: selection.status,
      fitScore: candidate.fit.score,
      matchedInterests: candidate.fit.matchedInterests,
      durationMinutes: candidate.place.typicalDurationMinutes,
      driveMinutesFromBase: candidate.driveMinutes,
      ...(candidate.fit.primaryInterest ? { primaryInterest: candidate.fit.primaryInterest } : {}),
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
function remedyFor(code: string | undefined): { suggestedRemedy?: string } {
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
      return { suggestedRemedy: 'This needs a vehicle. Renting one would open up most of the region.' };
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
