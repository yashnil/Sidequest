import {
  ITINERARY_VERSION,
  itinerarySchema,
  tripDates,
  type Itinerary,
  type ItineraryDay,
  type MinuteInterval,
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
import {
  couldVisitOnDate,
  hoursKey,
  resolveOperatingHours,
  type PlaceDayHours,
} from './hours';
import { reviseDayPlans, type DayPlan } from './revise';
import {
  buildDay,
  isOpenOnDate,
  layoutBestOrder,
  packDay,
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
 *    1. validate the matrix                 11. assign groups to days
 *    2. build real daily windows            12. choose a legal way in for each group
 *    3. resolve selections and exclusions   13. order the groups, then their stops
 *    4. drop infeasible places              14. insert access legs, meals, rest, slack
 *    5. rank by planning priority           15. time-block inside every open window
 *    6. resolve date-aware access           16. validate the finished plan
 *    7. drop what cannot be reached         17. revise, bounded, deterministically
 *    8. resolve date-aware opening hours    18. derive the transport strategy
 *    9. drop what is never open in reach    19. return plan, diagnostics, conflicts
 *   10. group geographically and by access
 *
 * Steps 6 and 8 answer two different questions and both have to pass. Access
 * asks whether the traveller can legally get there and back; hours ask whether
 * anyone will let them in when they arrive. A place can be reachable and shut,
 * or open and unreachable, and collapsing the two is how a plan drives eighty
 * minutes to a locked gate.
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

  const reachable: PlanningCandidate[] = [];
  for (const candidate of eligible) {
    const unit = unitByPlaceId.get(candidate.place.id);
    if (unit && reachableUnitKeys.has(unit.key)) {
      reachable.push(candidate);
      continue;
    }
    unscheduled.push(accessBlocked(candidate, unit, accessByUnitDate, dates));
  }

  // --- Hours: which places are open, on which dates, within reach ----------
  const hoursByPlaceDate = resolveOperatingHours({
    placeIds: reachable.map((candidate) => candidate.place.id),
    dates,
    dataset: input.hours,
  });
  const dayByDate = new Map(days.map((day) => [day.date, day]));

  /**
   * The intersection that decides everything downstream: the day's usable
   * hours, narrowed by the window the way in allows, then tested against the
   * place's own opening hours and the time the visit takes.
   *
   * Computed once, here, for every place against every date — because day
   * assignment has to know that Bodie is shut on a Wednesday *before* it hands
   * the cluster containing Bodie to Wednesday. Discovering it later means the
   * packer rejects it and it spills into an overflow pass by which time the days
   * that would have worked are full.
   */
  const boundsFor = (candidate: PlanningCandidate, date: string): MinuteInterval | null => {
    const day = dayByDate.get(date);
    if (!day) return null;
    const unit = unitByPlaceId.get(candidate.place.id);
    const resolved = unit ? accessByUnitDate.get(accessKey(unit.key, date)) : undefined;
    if (!resolved?.available) return null;
    return {
      startMinute: Math.max(
        // You cannot be standing at a place before you have travelled to it.
        // Without this the filter is optimistic enough to call a stop feasible
        // that no day can actually reach in time, and the traveller then gets
        // "there was no room" instead of "you cannot get there before it stops
        // letting people in" — the second of which names something they can act on.
        day.window.startMinute + candidate.driveMinutesFromBase,
        resolved.option.earliestActivityStart ?? Number.NEGATIVE_INFINITY,
      ),
      endMinute: Math.min(
        day.window.endMinute,
        resolved.option.latestActivityEnd ?? Number.POSITIVE_INFINITY,
      ),
    };
  };

  const openDates = new Map<string, ReadonlySet<string>>(
    reachable.map((candidate) => [
      candidate.place.id,
      new Set(
        dates.filter((date) => {
          const hours = hoursByPlaceDate.get(hoursKey(candidate.place.id, date));
          const bounds = boundsFor(candidate, date);
          if (!hours || !bounds) return false;
          return couldVisitOnDate({
            hours,
            placeName: candidate.place.name,
            durationMinutes: candidate.durationMinutes,
            bounds,
          });
        }),
      ),
    ]),
  );

  const plannable: PlanningCandidate[] = [];
  for (const candidate of reachable) {
    if ((openDates.get(candidate.place.id)?.size ?? 0) > 0) {
      plannable.push(candidate);
      continue;
    }
    unscheduled.push(hoursBlocked(candidate, hoursByPlaceDate, dates));
  }

  /** Hours for one day, keyed by place — everything the layout needs. */
  const hoursFor = (date: string): Map<string, PlaceDayHours> => {
    const map = new Map<string, PlaceDayHours>();
    for (const candidate of reachable) {
      const hours = hoursByPlaceDate.get(hoursKey(candidate.place.id, date));
      if (hours) map.set(candidate.place.id, hours);
    }
    return map;
  };

  const contextFor = (day: DayPlan['day']): LayoutContext => ({
    day,
    baseId: input.baseId,
    baseName,
    matrix: input.matrix,
    config,
    profile: input.profile,
    hours: hoursFor(day.date),
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
    openDates,
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
      // The deterministic reassignment the spill pass has always been: a stop
      // that lost its first choice of day gets offered every other legal one,
      // nearest-detour first. Hours narrow "legal" without changing the search.
      if (!openDates.get(candidate.place.id)?.has(plan.day.date)) continue;
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
  /**
   * Builds every day, and records anything the layout could not actually place.
   *
   * The packer only ever offers a day it has proved legal, so in the ordinary
   * case nothing is dropped here. The gap is the rebuild after a revision: the
   * reviser removes a stop, which changes the route the remaining ones are
   * ordered on, and the day is re-laid without being re-packed. A stop lost that
   * way used to disappear from the timeline while still counting as accepted —
   * neither scheduled nor reported. `dropped` closes that: `buildDay` is handed
   * only what is really on the day, and the caller turns the rest into
   * conflicts. Nothing the traveller chose can go missing without a reason.
   */
  const buildAll = (plans: readonly DayPlan[]) => {
    const dropped = new Map<string, { candidate: PlanningCandidate; message: string }>();
    const days = plans.map((plan) => {
      const context = contextFor(plan.day);
      const options = packOptionsFor(plan.day);
      const { scheduled, layout } = layoutBestOrder(context, plan.accepted, options);

      const placed = new Set(
        layout.items
          .filter((item) => item.kind === 'activity' && item.placeId)
          .map((item) => item.placeId!),
      );
      for (const candidate of plan.accepted) {
        if (placed.has(candidate.place.id)) continue;
        const violation = layout.violations.find((entry) => entry.placeId === candidate.place.id);
        dropped.set(candidate.place.id, {
          candidate,
          message:
            violation?.message ??
            `${candidate.place.name} could not be fitted into day ${plan.day.dayNumber} once the rest of it was laid out.`,
        });
      }

      return buildDay(
        context,
        plan.accepted.filter((candidate) => placed.has(candidate.place.id)),
        layout,
        summariseDayTransport(scheduled, layout, input.access),
      );
    });
    return { days, dropped };
  };

  let build = buildAll(dayPlans);
  let built = build.days;
  const validationInput = () => ({
    days: built,
    unscheduled,
    profile: input.profile,
    config,
    matrix: input.matrix,
    placesById,
    baseId: input.baseId,
    access: input.access,
    hours: input.hours,
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

    build = buildAll(dayPlans);
    built = build.days;
    issues = validateItinerary(validationInput());
    passes += 1;
  }

  /**
   * The last thing that could quietly lose a stop.
   *
   * Everything the final layout could not place comes back with the reason the
   * layout gave, whatever produced it. Appended after the revision loop so it
   * describes the plan actually being returned rather than an intermediate one.
   */
  for (const { candidate, message } of build.dropped.values()) {
    unscheduled.push({
      placeId: candidate.place.id,
      name: candidate.place.name,
      wasManual: candidate.manual,
      reasonCode: 'hours_do_not_fit',
      reason: message,
      suggestedRemedy: 'Drop something else from that day, or give the trip another day.',
    });
  }
  if (build.dropped.size > 0) issues = validateItinerary(validationInput());

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
      operatingHoursVersion: input.hours.version,
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

/**
 * A place the traveller can reach on some day of this trip and that will not
 * let them in on any of them.
 *
 * Two situations, and telling them apart is the whole value of the message.
 * "Shut for the season" means change your dates or drop it; "open, but never
 * long enough after you could get there" means change what else is on the day.
 * A single "does not fit your logistics" would leave the traveller guessing at
 * which of their own decisions to revisit.
 */
function hoursBlocked(
  candidate: PlanningCandidate,
  hoursByPlaceDate: ReadonlyMap<string, PlaceDayHours>,
  dates: readonly string[],
): UnscheduledPlace {
  const resolved = dates
    .map((date) => hoursByPlaceDate.get(hoursKey(candidate.place.id, date)))
    .filter((entry): entry is PlaceDayHours => entry !== undefined);
  const shutEveryDay = resolved.length > 0 && resolved.every((entry) => entry.status === 'closed');

  if (shutEveryDay) {
    // Any weekday closure is the more specific answer, and it can appear on a
    // date other than the first when a trip straddles a season boundary.
    const weekday = resolved.find((entry) => entry.closedReason === 'closed_weekday');
    const what = weekday?.periodLabel
      ? `its ${weekday.periodLabel.toLowerCase()}`
      : candidate.place.name;
    const reason = weekday
      ? `${candidate.place.name} is shut on every day of the week your trip covers — ${what} does not open on any of them.`
      : `${candidate.place.name} is closed for the season on your dates.`;
    return {
      placeId: candidate.place.id,
      name: candidate.place.name,
      wasManual: candidate.manual,
      reasonCode: 'closed_on_trip_dates',
      reason,
      suggestedRemedy: 'Move your dates into a period it is open, or take it off the board.',
    };
  }

  return {
    placeId: candidate.place.id,
    name: candidate.place.name,
    wasManual: candidate.manual,
    reasonCode: 'hours_do_not_fit',
    reason: `${candidate.place.name} is open on your dates, but never for long enough after you could get there — a ${candidate.durationMinutes} min visit does not fit inside its hours on any day of this trip.`,
    suggestedRemedy:
      'Start the day earlier, or free up a day by dropping something else from the board.',
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
