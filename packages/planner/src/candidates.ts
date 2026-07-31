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
 * Turns board selections into a planning queue.
 *
 * The contract that matters: a place the traveller actively chose either gets
 * scheduled or comes back in `rejected` with a reason. There is no third
 * outcome where it quietly disappears.
 */
export function resolveCandidates(
  candidates: readonly DiscoveryCandidate[],
  selections: readonly DiscoverySelection[],
  matrix: TravelTimeMatrix,
): ResolvedCandidates {
  const byPlaceId = new Map(selections.map((selection) => [selection.placeId, selection]));
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

  // Highest priority first; id breaks ties so the queue is stable.
  eligible.sort((a, b) => b.priority - a.priority || a.place.id.localeCompare(b.place.id));
  rejected.sort((a, b) => Number(b.wasManual) - Number(a.wasManual) || a.placeId.localeCompare(b.placeId));

  return { eligible, rejected };
}

function reasonCodeForBlocker(code: string | undefined): UnscheduledReasonCode {
  switch (code) {
    case 'closed_on_your_dates':
      return 'seasonally_closed';
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
