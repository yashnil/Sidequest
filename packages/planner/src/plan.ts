import {
  ITINERARY_VERSION,
  itinerarySchema,
  tripDates,
  type Itinerary,
  type ItineraryDay,
  type Place,
  type UnscheduledPlace,
} from '@sidequest/core';
import { MatrixError, tryLeg, validateMatrix } from '@sidequest/geo';
import {
  accessKey,
  buildAccessUnits,
  resolveAccess,
  summariseDayTransport,
  type AccessOption,
  type AccessUnit,
} from './access';
import { assignToDays } from './assign';
import { resolveCandidates } from './candidates';
import { reviseDayPlans, type DayPlan } from './revise';
import {
  buildDay,
  isOpenOnDate,
  layoutDay,
  packDay,
  scheduleUnits,
  type LayoutContext,
  type PackOptions,
} from './schedule';
import { buildTransportStrategy } from './strategy';
import { statusFor, validateItinerary, validateStrategy } from './validate';
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
 *   1. validate the matrix                10. choose a legal way in for each group
 *   2. build real daily windows           11. order the groups, then their stops
 *   3. resolve selections and exclusions  12. insert access legs, meals, rest, slack
 *   4. drop infeasible places             13. time-block the day
 *   5. rank by planning priority          14. validate the finished plan
 *   6. resolve date-aware access          15. revise, bounded, deterministically
 *   7. drop what cannot be reached        16. derive the transport strategy
 *   8. group geographically and by access 17. return plan, diagnostics, conflicts
 *   9. assign groups to days
 *
 * Pure: no I/O, no clock, no randomness. Same inputs in, byte-identical plan out.
 * Both the travel-time matrix and the access dataset arrive as data rather than
 * being fetched here, which is what makes that possible — and what will let a
 * real routing or transit provider slot in without this file changing at all.
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
  const dates = tripDates(input.basics.startDate, input.basics.endDate);

  // --- Access: which units can be reached, on which dates -----------------
  const units = buildAccessUnits(eligible, input.access, baseName);
  const unitByPlaceId = new Map<string, AccessUnit>();
  for (const unit of units) {
    for (const member of unit.members) unitByPlaceId.set(member.place.id, unit);
  }
  const accessByUnitDate = resolveAccess({
    units,
    dates,
    dataset: input.access,
    profile: input.profile,
    matrix: input.matrix,
  });

  /** The legal ways in available on one specific day, keyed by unit. */
  const accessFor = (date: string): Map<string, AccessOption> => {
    const map = new Map<string, AccessOption>();
    for (const unit of units) {
      const resolved = accessByUnitDate.get(accessKey(unit.key, date));
      if (resolved?.available) map.set(unit.key, resolved.option);
    }
    return map;
  };

  /** A unit is plannable at all only if some day of the trip can take it. */
  const feasibleDates = new Map<string, ReadonlySet<string>>(
    units.map((unit) => [
      unit.key,
      new Set(dates.filter((date) => accessByUnitDate.get(accessKey(unit.key, date))?.available)),
    ]),
  );
  const reachableUnitKeys = new Set(
    units.filter((unit) => (feasibleDates.get(unit.key)?.size ?? 0) > 0).map((unit) => unit.key),
  );

  const plannable: PlanningCandidate[] = [];
  for (const candidate of eligible) {
    const unit = unitByPlaceId.get(candidate.place.id);
    if (unit && reachableUnitKeys.has(unit.key)) {
      plannable.push(candidate);
      continue;
    }
    unscheduled.push(accessBlocked(candidate, unit, accessByUnitDate, dates));
  }

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

  const packOptionsFor = (day: DayPlan['day']): PackOptions => ({
    maxActivities: maxActivitiesFor(day),
    maxDailyDriveMinutes: input.profile.transport.maxDailyDriveMinutes,
    maxDailyTransportMinutes: input.profile.transport.maxDailyTransportMinutes,
    maxStrenuous: maxStrenuousPerDay,
    accessByUnit: accessFor(day.date),
    unitByPlaceId,
  });

  // --- First pass: geographic and access groups onto days -----------------
  const assignments = assignToDays(
    plannable,
    days,
    input.matrix,
    input.baseId,
    unitByPlaceId,
    feasibleDates,
  );
  let dayPlans: DayPlan[] = [];
  const overflow: PlanningCandidate[] = [];

  for (const assignment of assignments) {
    const packed = packDay(
      contextFor(assignment.day),
      assignment.candidates,
      packOptionsFor(assignment.day),
    );
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
      if (plan.accepted.length === 0) {
        return tryLeg(input.matrix, input.baseId, candidate.place.id)?.minutes ?? Infinity;
      }
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
      const trial = packDay(
        contextFor(plan.day),
        [...plan.accepted, candidate],
        packOptionsFor(plan.day),
      );
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
    unscheduled.push(unscheduledFor(candidate, days.length, accessByUnitDate, unitByPlaceId, dates));
  }

  // --- Build, validate, revise -------------------------------------------
  const buildAll = (plans: readonly DayPlan[]): ItineraryDay[] =>
    plans.map((plan) => {
      const context = contextFor(plan.day);
      const options = packOptionsFor(plan.day);
      const scheduled = scheduleUnits(context, plan.accepted, options);
      const layout = layoutDay(context, scheduled);
      return buildDay(
        context,
        plan.accepted,
        layout,
        summariseDayTransport(scheduled, layout, input.access),
      );
    });

  let built = buildAll(dayPlans);
  const validationInput = () => ({
    days: built,
    unscheduled,
    profile: input.profile,
    config,
    matrix: input.matrix,
    placesById,
    baseId: input.baseId,
    access: input.access,
  });
  let issues = validateItinerary(validationInput());

  const revisions = [];
  let passes = 0;

  while (passes < config.maxRevisionPasses && issues.some((issue) => issue.severity === 'error')) {
    const outcome = reviseDayPlans(dayPlans, issues);
    revisions.push(...outcome.actions);
    if (!outcome.changed) break;

    dayPlans = outcome.dayPlans;
    for (const { candidate, reason, code } of outcome.removed) {
      unscheduled.push({
        placeId: candidate.place.id,
        name: candidate.place.name,
        wasManual: candidate.manual,
        reasonCode: code,
        reason: `Taken out because ${reason}`,
        suggestedRemedy: 'Free up room by dropping another stop, or give the trip more days.',
      });
    }

    built = buildAll(dayPlans);
    issues = validateItinerary(validationInput());
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

  const transportStrategy = buildTransportStrategy({
    days: built,
    profile: input.profile,
    region: input.region,
    dataset: input.access,
    unscheduled,
    matrixNote: input.matrix.provenance.note,
    matrixProvenance: input.matrix.provenance.kind,
  });
  issues = [...issues, ...validateStrategy(transportStrategy, built)];

  const itinerary: Itinerary = {
    version: ITINERARY_VERSION,
    tripId: input.tripId,
    regionId: input.region.id,
    baseId: input.baseId,
    baseName,
    startDate: input.basics.startDate,
    endDate: input.basics.endDate,
    status: statusFor(issues),
    summary: summarise(built, scheduledCount, unscheduled.length),
    transportStrategy,
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

/**
 * A place the traveller chose that no day of this trip can legally reach.
 *
 * The reason has to name the actual constraint. "Low logistics fit" tells nobody
 * anything; "the shuttle is out of season on your dates, and it is the only way
 * past the gate" tells them exactly which of their choices to change.
 */
function accessBlocked(
  candidate: PlanningCandidate,
  unit: AccessUnit | undefined,
  resolved: ReadonlyMap<string, { available: boolean; blockers?: { code: string; message: string }[] }>,
  dates: readonly string[],
): UnscheduledPlace {
  const blockers = unit
    ? dates.flatMap((date) => {
        const entry = resolved.get(accessKey(unit.key, date));
        return entry && !entry.available ? (entry.blockers ?? []) : [];
      })
    : [];
  const first = blockers[0];

  return {
    placeId: candidate.place.id,
    name: candidate.place.name,
    wasManual: candidate.manual,
    reasonCode: reasonCodeForAccess(first?.code),
    reason:
      first?.message ??
      'We have no record of a way to reach this on your dates, so we will not put it on a day.',
    suggestedRemedy: remedyForAccess(first?.code),
  };
}

function reasonCodeForAccess(code: string | undefined): UnscheduledPlace['reasonCode'] {
  switch (code) {
    case 'service_out_of_season':
    case 'service_not_operating':
      return 'service_not_operating';
    case 'needs_private_vehicle':
    case 'shuttle_declined':
    case 'unsupported_mode':
      return 'transport_mode_unavailable';
    case 'no_access_data':
      return 'missing_travel_data';
    default:
      return 'access_unavailable';
  }
}

function remedyForAccess(code: string | undefined): string | undefined {
  switch (code) {
    case 'service_out_of_season':
      return 'Move your dates into the season the service runs, or drop this from the board.';
    case 'service_not_operating':
      return 'Shift a day so it lands on a day the service runs.';
    case 'needs_private_vehicle':
      return 'This needs a vehicle. Renting one would open up most of the region.';
    case 'shuttle_declined':
      return 'Say you are willing to use a shuttle, if you are — it is the only way in here.';
    case 'walk_too_long':
      return 'Raise how far you will walk to reach a stop, or pick something closer to the road.';
    default:
      return undefined;
  }
}

function unscheduledFor(
  candidate: PlanningCandidate,
  dayCount: number,
  resolved: ReadonlyMap<string, { available: boolean }>,
  unitByPlaceId: ReadonlyMap<string, AccessUnit>,
  dates: readonly string[],
): UnscheduledPlace {
  const unit = unitByPlaceId.get(candidate.place.id);
  const reachableDays = unit
    ? dates.filter((date) => resolved.get(accessKey(unit.key, date))?.available).length
    : dates.length;

  // Distinguishing "there was no room" from "there was room, but not on the days
  // it runs" is the difference between a useful remedy and a shrug.
  if (reachableDays > 0 && reachableDays < dayCount) {
    return {
      placeId: candidate.place.id,
      name: candidate.place.name,
      wasManual: candidate.manual,
      reasonCode: 'service_not_operating',
      reason: `Only ${reachableDays} of your ${dayCount} days can reach this, and those days were already full.`,
      suggestedRemedy: 'Free up one of those days by dropping something else from the board.',
    };
  }

  const optional = !candidate.manual && candidate.selectionStatus === 'maybe';
  return {
    placeId: candidate.place.id,
    name: candidate.place.name,
    wasManual: candidate.manual,
    reasonCode: optional ? 'lower_priority' : 'no_time_left',
    reason: optional
      ? 'A maybe that there was no room for once the things you actually chose were placed.'
      : `There was no day in these ${dayCount} with the hours and the travel budget left for it.`,
    ...(candidate.manual
      ? { suggestedRemedy: 'Drop something else from the board, or give the trip another day.' }
      : {}),
  };
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
): string {
  const activeDays = days.filter((day) => day.totals.activityMinutes > 0).length;
  const driveMinutes = days.reduce((sum, day) => sum + day.totals.driveMinutes, 0);
  const otherMinutes = days.reduce(
    (sum, day) => sum + day.totals.transitMinutes + day.totals.walkMinutes + day.totals.waitMinutes,
    0,
  );
  const parts = [
    `${scheduled} ${scheduled === 1 ? 'stop' : 'stops'} across ${activeDays} of ${days.length} days`,
  ];
  if (driveMinutes > 0) parts.push(`about ${hours(driveMinutes)} hours of driving`);
  if (otherMinutes > 0) parts.push(`${hours(otherMinutes)} hours riding and on foot to reach them`);
  if (unscheduled > 0) parts.push(`${unscheduled} left off, each with a reason`);
  return `${parts.join(', ')}.`;
}

function hours(minutes: number): number {
  return Math.round(minutes / 6) / 10;
}

export { validateItinerary, statusFor } from './validate';
