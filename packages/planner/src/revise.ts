import type {
  RevisionAction,
  UnscheduledReasonCode,
  ValidationIssue,
} from '@sidequest/core';
import type { PlannedDay } from './windows';
import type { PlanningCandidate } from './types';

export interface DayPlan {
  day: PlannedDay;
  accepted: PlanningCandidate[];
}

export interface RevisionOutcome {
  dayPlans: DayPlan[];
  /** Candidates the revision took out; they become unscheduled with a reason. */
  removed: { candidate: PlanningCandidate; reason: string; code: UnscheduledReasonCode }[];
  actions: RevisionAction[];
  /** True when something actually changed and another pass is worth running. */
  changed: boolean;
}

/**
 * One bounded, deterministic revision pass.
 *
 * The rules are deliberately blunt, and always subtractive in the same direction:
 * when a day breaks a constraint, the lowest-priority thing on it goes. Blunt is
 * a feature here — a clever reviser that shuffles things between days can
 * oscillate, and an itinerary planner that sometimes fails to terminate is worse
 * than one that occasionally drops an optional stop.
 *
 * The one thing it will never do is drop something the traveller chose by hand to
 * make a machine-generated constraint work out. Those come back as unresolved
 * conflicts for the traveller to decide on.
 */
export function reviseDayPlans(
  dayPlans: readonly DayPlan[],
  issues: readonly ValidationIssue[],
): RevisionOutcome {
  const next: DayPlan[] = dayPlans.map((plan) => ({ day: plan.day, accepted: [...plan.accepted] }));
  const removed: RevisionOutcome['removed'] = [];
  const actions: RevisionAction[] = [];

  const errors = issues.filter((issue) => issue.severity === 'error');
  // One fix per day per pass keeps each change attributable to one cause.
  const handledDays = new Set<number>();

  for (const issue of errors) {
    if (issue.code === 'must_include_unscheduled') {
      actions.push({
        code: 'left_unresolved',
        description: `${issue.message} We left it for you rather than quietly dropping it or breaking a limit you set.`,
        ...(issue.placeId ? { placeId: issue.placeId } : {}),
      });
      continue;
    }

    if (issue.dayNumber === undefined || handledDays.has(issue.dayNumber)) continue;
    const plan = next.find((entry) => entry.day.dayNumber === issue.dayNumber);
    if (!plan || plan.accepted.length === 0) continue;

    const victim = chooseVictim(plan, issue);
    if (!victim) continue;

    plan.accepted = plan.accepted.filter((candidate) => candidate.place.id !== victim.place.id);
    handledDays.add(issue.dayNumber);
    removed.push({
      candidate: victim,
      reason: reasonForRemoval(issue),
      code: unscheduledCodeFor(issue),
    });
    actions.push({
      code: actionCodeFor(issue),
      description: `Took ${victim.place.name} off day ${issue.dayNumber}: ${reasonForRemoval(issue)}`,
      dayNumber: issue.dayNumber,
      placeId: victim.place.id,
    });
  }

  return { dayPlans: next, removed, actions, changed: removed.length > 0 };
}

function chooseVictim(plan: DayPlan, issue: ValidationIssue): PlanningCandidate | undefined {
  // A specific place is at fault: take that one, whatever its priority.
  if (issue.placeId) {
    const named = plan.accepted.find((candidate) => candidate.place.id === issue.placeId);
    if (named && !named.manual) return named;
    if (named?.manual) return undefined;
  }

  const pool =
    issue.code === 'intensity_exceeded'
      ? plan.accepted.filter((candidate) => candidate.place.physicalIntensity === 'strenuous')
      : plan.accepted;

  // Lowest priority first, and never a manual pick while an auto-pick remains.
  const ordered = [...pool].sort(
    (a, b) =>
      Number(a.manual) - Number(b.manual) ||
      a.priority - b.priority ||
      a.place.id.localeCompare(b.place.id),
  );
  const candidate = ordered[0];
  if (!candidate) return undefined;
  if (candidate.manual && pool.some((entry) => !entry.manual)) return undefined;
  return candidate;
}

function actionCodeFor(issue: ValidationIssue): RevisionAction['code'] {
  switch (issue.code) {
    case 'intensity_exceeded':
      return 'separated_strenuous';
    case 'daily_drive_exceeded':
    case 'daily_transport_exceeded':
    case 'edge_day_overfull':
      return 'dropped_lowest_priority';
    case 'place_unavailable':
    case 'duplicate_place':
    case 'attraction_closed_on_date':
      return 'moved_to_another_day';
    case 'arrives_before_opening':
    case 'arrives_after_last_admission':
    case 'visit_ends_after_closing':
    case 'no_operating_window_in_access_window':
      // The layout already tried both stop orders before this issue could
      // exist, so what is left to change is the day's contents, not its shape.
      return 'dropped_lowest_priority';
    case 'missed_last_return':
    case 'access_window_too_short':
      return 'shortened_access_group';
    default:
      return 'dropped_lowest_priority';
  }
}

/** So an unscheduled entry can say *which* limit took it out, not just "no room". */
function unscheduledCodeFor(issue: ValidationIssue): UnscheduledReasonCode {
  switch (issue.code) {
    case 'missed_last_return':
      return 'missed_last_return';
    case 'daily_drive_exceeded':
    case 'daily_transport_exceeded':
      return 'exceeds_daily_travel';
    case 'intensity_exceeded':
      return 'exceeds_intensity';
    case 'place_unavailable':
      return 'seasonally_closed';
    case 'attraction_closed_on_date':
      return 'closed_on_trip_dates';
    case 'arrives_before_opening':
    case 'arrives_after_last_admission':
    case 'visit_ends_after_closing':
    case 'no_operating_window_in_access_window':
    case 'operating_evidence_inconsistent':
      return 'hours_do_not_fit';
    case 'required_mode_unavailable':
      return 'transport_mode_unavailable';
    case 'service_out_of_season':
    case 'service_not_operating_on_date':
      return 'service_not_operating';
    case 'road_surface_incompatible':
    case 'remote_area_incompatible':
      return 'not_feasible';
    default:
      return 'no_time_left';
  }
}

function reasonForRemoval(issue: ValidationIssue): string {
  switch (issue.code) {
    case 'daily_drive_exceeded':
      return 'the day was over your driving limit.';
    case 'daily_transport_exceeded':
      return 'the day spent more time getting places than you wanted to.';
    case 'missed_last_return':
      return 'the day would not have finished before the last way out.';
    case 'access_window_too_short':
      return 'there was not enough time between the first way in and the last way out.';
    case 'road_surface_incompatible':
      return 'the approach is a road surface you asked us to avoid.';
    case 'remote_area_incompatible':
      return 'it is out where there are no services, which you asked us to avoid.';
    case 'intensity_exceeded':
      return 'it stacked too much hard effort into one day.';
    case 'edge_day_overfull':
      return 'an arrival or departure day does not have the hours for it.';
    case 'place_unavailable':
      return 'it is not open on that date.';
    case 'attraction_closed_on_date':
      return 'it is shut on that date.';
    case 'arrives_before_opening':
      return 'the day could not get there before it opens.';
    case 'arrives_after_last_admission':
      return 'the day could not get there before it stops letting people in.';
    case 'visit_ends_after_closing':
      return 'the visit would still have been going after it closed.';
    case 'no_operating_window_in_access_window':
      return 'its opening hours and the only way out of there never overlap.';
    case 'duplicate_place':
      return 'it was already scheduled on another day.';
    case 'items_overlap':
    case 'item_outside_window':
      return 'the day would have run past the hours available.';
    default:
      return 'the day did not fit otherwise.';
  }
}
