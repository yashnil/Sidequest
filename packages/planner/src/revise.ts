import type { RevisionAction, ValidationIssue } from '@sidequest/core';
import type { PlannedDay } from './windows';
import type { PlanningCandidate } from './types';

export interface DayPlan {
  day: PlannedDay;
  accepted: PlanningCandidate[];
}

export interface RevisionOutcome {
  dayPlans: DayPlan[];
  /** Candidates the revision took out; they become unscheduled with a reason. */
  removed: { candidate: PlanningCandidate; reason: string }[];
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
    removed.push({ candidate: victim, reason: reasonForRemoval(issue) });
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
    case 'daily_travel_exceeded':
    case 'edge_day_overfull':
      return 'dropped_lowest_priority';
    case 'place_unavailable':
    case 'duplicate_place':
      return 'moved_to_another_day';
    default:
      return 'dropped_lowest_priority';
  }
}

function reasonForRemoval(issue: ValidationIssue): string {
  switch (issue.code) {
    case 'daily_travel_exceeded':
      return 'the day was over your driving limit.';
    case 'intensity_exceeded':
      return 'it stacked too much hard effort into one day.';
    case 'edge_day_overfull':
      return 'an arrival or departure day does not have the hours for it.';
    case 'place_unavailable':
      return 'it is not open on that date.';
    case 'duplicate_place':
      return 'it was already scheduled on another day.';
    case 'items_overlap':
    case 'item_outside_window':
      return 'the day would have run past the hours available.';
    default:
      return 'the day did not fit otherwise.';
  }
}
