import {
  ITINERARY_VERSION,
  itinerarySchema,
  type Itinerary,
  type ItineraryDay,
  type Place,
  type UnscheduledPlace,
} from '@sidequest/core';
import { MatrixError, orderStops, tryLeg, validateMatrix } from '@sidequest/geo';
import { assignToDays } from './assign';
import { resolveCandidates } from './candidates';
import { reviseDayPlans, type DayPlan } from './revise';
import { buildDay, isOpenOnDate, layoutDay, packDay, type LayoutContext } from './schedule';
import { statusFor, validateItinerary } from './validate';
import { buildDailyWindows } from './windows';
import {
  PLANNER_VERSION,
  resolveConfig,
  type PlannerInput,
  type PlanningCandidate,
  type PlanResult,
} from './types';

/**
 * The whole pipeline, in order:
 *
 *   1. validate the matrix                7. order stops within each day
 *   2. build real daily windows           8. insert travel, meals, rest, free time
 *   3. resolve selections and exclusions  9. time-block the day
 *   4. drop infeasible places            10. validate the finished plan
 *   5. rank by planning priority         11. revise, bounded, deterministically
 *   6. group geographically              12. return plan, diagnostics, conflicts
 *
 * Pure: no I/O, no clock, no randomness. Same inputs in, byte-identical plan out.
 * The travel-time matrix arrives as data rather than being fetched here, which is
 * what makes that possible — and what will let a real routing provider slot in
 * without this file changing at all.
 */
export function planTrip(input: PlannerInput): PlanResult {
  const config = resolveConfig(input.config);
  const generatedAt = input.generatedAt ?? new Date().toISOString();

  try {
    validateMatrix(input.matrix);
  } catch (error) {
    const message =
      error instanceof MatrixError
        ? error.message
        : 'The travel-time data for this region is unusable.';
    return { ok: false, code: 'matrix_unusable', message };
  }

  const { eligible, rejected } = resolveCandidates(
    input.candidates,
    input.selections,
    input.matrix,
  );
  const unscheduled: UnscheduledPlace[] = [...rejected];

  const days = buildDailyWindows(input.basics, input.profile, config);
  if (days.length === 0) {
    return { ok: false, code: 'no_usable_days', message: 'That date range does not contain a day.' };
  }
  if (eligible.length === 0 && rejected.length === 0) {
    return {
      ok: false,
      code: 'no_candidates',
      message: 'Nothing on the Discovery Board is marked to include yet.',
    };
  }

  const placesById = new Map<string, Place>(
    input.candidates.map((candidate) => [candidate.place.id, candidate.place]),
  );
  const baseName = input.region.baseName;

  const contextFor = (day: DayPlan['day']): LayoutContext => ({
    day,
    baseId: input.baseId,
    baseName,
    matrix: input.matrix,
    config,
    profile: input.profile,
  });

  const maxStrenuousPerDay =
    input.profile.derived.preferredPhysicalIntensity === 'strenuous' ? 2 : 1;

  const maxActivitiesFor = (day: DayPlan['day']) => {
    const slots = input.profile.derived.activitySlotsPerDay;
    const base = day.isEdgeDay ? slots * config.edgeDayCapacityShare : slots;
    return Math.max(1, Math.round(base));
  };

  // --- First pass: geographic groups onto days ---------------------------
  const assignments = assignToDays(eligible, days, input.matrix, input.baseId);
  let dayPlans: DayPlan[] = [];
  const overflow: PlanningCandidate[] = [];

  for (const assignment of assignments) {
    const packed = packDay(contextFor(assignment.day), assignment.candidates, {
      maxActivities: maxActivitiesFor(assignment.day),
      maxDailyTravelMinutes: input.profile.transport.maxDailyTravelMinutes,
      maxStrenuous: maxStrenuousPerDay,
    });
    dayPlans.push({ day: assignment.day, accepted: packed.accepted });
    overflow.push(...packed.overflow);
  }

  // --- Second pass: overflow into whatever room is left -------------------
  const placed = new Set(dayPlans.flatMap((plan) => plan.accepted.map((c) => c.place.id)));
  const stillHomeless: PlanningCandidate[] = [];

  for (const candidate of [...overflow].sort(
    (a, b) => b.priority - a.priority || a.place.id.localeCompare(b.place.id),
  )) {
    if (placed.has(candidate.place.id)) continue;

    let landed = false;
    // Prefer the day already going nearest to it, so a spill does not invent a
    // second long drive on a day that was not heading that way.
    const detourCost = (plan: DayPlan) => {
      if (plan.accepted.length === 0) return tryLeg(input.matrix, input.baseId, candidate.place.id)?.minutes ?? Infinity;
      return Math.min(
        ...plan.accepted.map(
          (entry) => tryLeg(input.matrix, entry.place.id, candidate.place.id)?.minutes ?? Infinity,
        ),
      );
    };
    const ordered = [...dayPlans].sort(
      (a, b) => detourCost(a) - detourCost(b) || a.day.dayNumber - b.day.dayNumber,
    );
    for (const plan of ordered) {
      if (!isOpenOnDate(candidate.place, plan.day.date)) continue;
      const trial = packDay(contextFor(plan.day), [...plan.accepted, candidate], {
        maxActivities: maxActivitiesFor(plan.day),
        maxDailyTravelMinutes: input.profile.transport.maxDailyTravelMinutes,
        maxStrenuous: maxStrenuousPerDay,
      });
      if (trial.accepted.some((entry) => entry.place.id === candidate.place.id)) {
        plan.accepted = trial.accepted;
        placed.add(candidate.place.id);
        landed = true;
        break;
      }
    }
    if (!landed) stillHomeless.push(candidate);
  }

  for (const candidate of stillHomeless) {
    unscheduled.push(unscheduledFor(candidate, days.length));
  }

  // --- Build, validate, revise -------------------------------------------
  let built = buildAll(dayPlans, contextFor);
  let issues = validateItinerary({
    days: built,
    unscheduled,
    profile: input.profile,
    config,
    matrix: input.matrix,
    placesById,
    baseId: input.baseId,
  });

  const revisions = [];
  let passes = 0;

  while (passes < config.maxRevisionPasses && issues.some((issue) => issue.severity === 'error')) {
    const outcome = reviseDayPlans(dayPlans, issues);
    revisions.push(...outcome.actions);
    if (!outcome.changed) break;

    dayPlans = outcome.dayPlans;
    for (const { candidate, reason } of outcome.removed) {
      unscheduled.push({
        placeId: candidate.place.id,
        name: candidate.place.name,
        wasManual: candidate.manual,
        reasonCode: 'no_time_left',
        reason: `Taken out because ${reason}`,
        suggestedRemedy: 'Free up room by dropping another stop, or give the trip more days.',
      });
    }

    built = buildAll(dayPlans, contextFor);
    issues = validateItinerary({
      days: built,
      unscheduled,
      profile: input.profile,
      config,
      matrix: input.matrix,
      placesById,
      baseId: input.baseId,
    });
    passes += 1;
  }

  const scheduledCount = built.reduce(
    (sum, day) => sum + day.items.filter((item) => item.kind === 'activity').length,
    0,
  );
  const totals = built.reduce(
    (acc, day) => ({
      usable: acc.usable + day.window.usableMinutes,
      activity: acc.activity + day.totals.activityMinutes,
      travel: acc.travel + day.totals.travelMinutes,
      free: acc.free + day.totals.freeMinutes,
    }),
    { usable: 0, activity: 0, travel: 0, free: 0 },
  );

  const itinerary: Itinerary = {
    version: ITINERARY_VERSION,
    tripId: input.tripId,
    regionId: input.region.id,
    baseId: input.baseId,
    baseName,
    startDate: input.basics.startDate,
    endDate: input.basics.endDate,
    status: statusFor(issues),
    summary: summarise(built, scheduledCount, unscheduled.length, totals.travel),
    days: built,
    unscheduled: dedupeUnscheduled(unscheduled),
    issues,
    diagnostics: {
      plannerVersion: PLANNER_VERSION,
      generatedAt,
      matrixProvenance: input.matrix.provenance.kind,
      matrixNote: input.matrix.provenance.note,
      revisionPasses: passes,
      revisions,
      capacity: {
        usableMinutes: totals.usable,
        activityMinutes: totals.activity,
        travelMinutes: totals.travel,
        freeMinutes: totals.free,
      },
      counts: {
        considered: input.candidates.length,
        scheduled: scheduledCount,
        unscheduled: dedupeUnscheduled(unscheduled).length,
      },
    },
  };

  try {
    return { ok: true, itinerary: itinerarySchema.parse(itinerary) };
  } catch (error) {
    return {
      ok: false,
      code: 'internal_error',
      message: error instanceof Error ? error.message : 'The planner produced an invalid itinerary.',
    };
  }
}

function buildAll(
  dayPlans: readonly DayPlan[],
  contextFor: (day: DayPlan['day']) => LayoutContext,
): ItineraryDay[] {
  return dayPlans.map((plan) => {
    const context = contextFor(plan.day);
    const byId = new Map(plan.accepted.map((candidate) => [candidate.place.id, candidate]));
    const route = orderStops(context.matrix, {
      startId: context.baseId,
      endId: context.baseId,
      stopIds: plan.accepted.map((candidate) => candidate.place.id),
    });
    const layout = layoutDay(context, route.path, byId);
    return buildDay(context, plan.accepted, layout);
  });
}

function unscheduledFor(candidate: PlanningCandidate, dayCount: number): UnscheduledPlace {
  const optional = !candidate.manual && candidate.selectionStatus === 'maybe';
  return {
    placeId: candidate.place.id,
    name: candidate.place.name,
    wasManual: candidate.manual,
    reasonCode: optional ? 'lower_priority' : 'no_time_left',
    reason: optional
      ? 'A maybe that there was no room for once the things you actually chose were placed.'
      : `There was no day in these ${dayCount} with the hours and the driving budget left for it.`,
    suggestedRemedy: candidate.manual
      ? 'Drop something else from the board, or give the trip another day.'
      : undefined,
  } as UnscheduledPlace;
}

function dedupeUnscheduled(entries: readonly UnscheduledPlace[]): UnscheduledPlace[] {
  const byId = new Map<string, UnscheduledPlace>();
  for (const entry of entries) {
    // Keep the first reason recorded; it is the most specific.
    if (!byId.has(entry.placeId)) byId.set(entry.placeId, entry);
  }
  return [...byId.values()].sort(
    (a, b) => Number(b.wasManual) - Number(a.wasManual) || a.placeId.localeCompare(b.placeId),
  );
}

function summarise(
  days: readonly ItineraryDay[],
  scheduled: number,
  unscheduled: number,
  travelMinutes: number,
): string {
  const activeDays = days.filter((day) => day.totals.activityMinutes > 0).length;
  const hours = Math.round(travelMinutes / 6) / 10;
  const parts = [
    `${scheduled} ${scheduled === 1 ? 'stop' : 'stops'} across ${activeDays} of ${days.length} days`,
    `about ${hours} hours of driving in total`,
  ];
  if (unscheduled > 0) {
    parts.push(`${unscheduled} left off, each with a reason`);
  }
  return `${parts.join(', ')}.`;
}

export { validateItinerary, statusFor } from './validate';
