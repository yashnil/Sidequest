import {
  formatMinuteOfDay,
  serviceAvailabilityOn,
  type AccessDataset,
  type Itinerary,
  type ItineraryDay,
  type TravelerProfile,
  type UnscheduledPlace,
  type ValidationIssue,
} from '@sidequest/core';
import { hasPoint, type TravelTimeMatrix } from '@sidequest/geo';
import { isOpenOnDate } from './schedule';
import type { PlannerConfig } from './types';
import type { Place } from '@sidequest/core';

export interface ValidationInput {
  days: readonly ItineraryDay[];
  unscheduled: readonly UnscheduledPlace[];
  profile: TravelerProfile;
  config: PlannerConfig;
  matrix: TravelTimeMatrix;
  placesById: ReadonlyMap<string, Place>;
  baseId: string;
  access: AccessDataset;
}

/**
 * Independent check on the finished plan.
 *
 * The scheduler already refuses to build most of these violations, which is the
 * right place to prevent them. This exists anyway because "the builder is careful"
 * is not a guarantee — it is an assumption, and this is the thing that fails
 * loudly when the assumption stops holding. Every issue carries a stable code so
 * the UI and the reviser can act on it without parsing prose.
 */
export function validateItinerary(input: ValidationInput): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const { days, profile, config, matrix, placesById, baseId } = input;

  const seenPlaces = new Map<string, number>();
  let scheduledAnything = false;

  for (const day of days) {
    const items = [...day.items].sort((a, b) => a.startMinute - b.startMinute);

    for (const item of items) {
      if (item.endMinute < item.startMinute || item.durationMinutes < 0) {
        issues.push({
          code: 'inconsistent_timestamps',
          severity: 'error',
          message: `"${item.title}" on day ${day.dayNumber} has a negative or inconsistent duration.`,
          dayNumber: day.dayNumber,
        });
      }
      if (item.durationMinutes !== item.endMinute - item.startMinute) {
        issues.push({
          code: 'inconsistent_timestamps',
          severity: 'error',
          message: `"${item.title}" on day ${day.dayNumber} has a duration that does not match its times.`,
          dayNumber: day.dayNumber,
        });
      }
      if (item.startMinute < day.window.startMinute || item.endMinute > day.window.endMinute) {
        issues.push({
          code: 'item_outside_window',
          severity: 'error',
          message: `"${item.title}" runs ${formatMinuteOfDay(item.startMinute)}–${formatMinuteOfDay(item.endMinute)}, outside day ${day.dayNumber}'s ${formatMinuteOfDay(day.window.startMinute)}–${formatMinuteOfDay(day.window.endMinute)}.`,
          dayNumber: day.dayNumber,
        });
      }
    }

    for (let index = 0; index + 1 < items.length; index += 1) {
      const current = items[index]!;
      const next = items[index + 1]!;
      if (next.startMinute < current.endMinute) {
        issues.push({
          code: 'items_overlap',
          severity: 'error',
          message: `"${current.title}" and "${next.title}" overlap on day ${day.dayNumber}.`,
          dayNumber: day.dayNumber,
        });
      }
    }

    for (const item of items) {
      if (item.kind !== 'activity' || !item.placeId) continue;
      scheduledAnything = true;

      const previous = seenPlaces.get(item.placeId);
      if (previous !== undefined) {
        issues.push({
          code: 'duplicate_place',
          severity: 'error',
          message: `${item.title} is scheduled on both day ${previous} and day ${day.dayNumber}.`,
          dayNumber: day.dayNumber,
          placeId: item.placeId,
        });
      } else {
        seenPlaces.set(item.placeId, day.dayNumber);
      }

      const place = placesById.get(item.placeId);
      if (place && !isOpenOnDate(place, day.date)) {
        issues.push({
          code: 'place_unavailable',
          severity: 'error',
          message: `${place.name} is not reachable on ${day.date}.`,
          dayNumber: day.dayNumber,
          placeId: place.id,
        });
      }
      if (place && !hasPoint(matrix, place.id)) {
        issues.push({
          code: 'matrix_entry_missing',
          severity: 'error',
          message: `No travel time is recorded for ${place.name}.`,
          dayNumber: day.dayNumber,
          placeId: place.id,
        });
      }
    }

    for (const item of items) {
      if (item.kind === 'travel' && item.travel && item.durationMinutes < item.travel.minutes) {
        issues.push({
          code: 'travel_without_time',
          severity: 'error',
          message: `Day ${day.dayNumber} allows ${item.durationMinutes} min for a ${item.travel.minutes} min drive.`,
          dayNumber: day.dayNumber,
        });
      }
    }

    // Two budgets, checked separately. An hour at the wheel and an hour on a bus
    // are not interchangeable, and a traveller who capped their driving has not
    // capped their willingness to be carried.
    if (day.totals.driveMinutes > profile.transport.maxDailyDriveMinutes) {
      issues.push({
        code: 'daily_drive_exceeded',
        severity: 'error',
        message: `Day ${day.dayNumber} has ${day.totals.driveMinutes} min at the wheel, past the ${profile.transport.maxDailyDriveMinutes} min you set.`,
        dayNumber: day.dayNumber,
      });
    }
    if (day.totals.travelMinutes > profile.transport.maxDailyTransportMinutes) {
      issues.push({
        code: 'daily_transport_exceeded',
        severity: 'error',
        message: `Day ${day.dayNumber} spends ${day.totals.travelMinutes} min getting places, past the ${profile.transport.maxDailyTransportMinutes} min of total travel this trip allows for.`,
        dayNumber: day.dayNumber,
      });
    }

    issues.push(...validateDayTransport(day, input));

    const strenuousAllowed = profile.derived.preferredPhysicalIntensity === 'strenuous' ? 2 : 1;
    if (day.totals.strenuousCount > strenuousAllowed) {
      issues.push({
        code: 'intensity_exceeded',
        severity: 'error',
        message: `Day ${day.dayNumber} stacks ${day.totals.strenuousCount} strenuous activities, more than the ${profile.dailyIntensity} days you asked for.`,
        dayNumber: day.dayNumber,
      });
    }

    const hasMeal = day.items.some((item) => item.kind === 'meal');
    if (!hasMeal && day.window.usableMinutes >= config.minDayMinutesForLunch && day.totals.activityMinutes > 0) {
      issues.push({
        code: 'missing_meal_break',
        severity: 'warning',
        message: `Day ${day.dayNumber} runs ${Math.round(day.window.usableMinutes / 60)} hours with no break to eat.`,
        dayNumber: day.dayNumber,
      });
    }

    const activityItems = day.items.filter((item) => item.kind === 'activity');
    if (activityItems.length > 0) {
      const first = day.items[0];
      const startsAtBase = first?.kind === 'travel' ? first.travel?.fromId === baseId : true;
      const endsAtBase = lastTravelReturnsToBase(day, baseId);
      if (!startsAtBase || !endsAtBase) {
        issues.push({
          code: 'base_not_returned',
          severity: 'warning',
          message: `Day ${day.dayNumber} does not start and finish at ${day.baseName}.`,
          dayNumber: day.dayNumber,
        });
      }
    }
  }

  // Edge days are capped during construction; this catches a cap that failed.
  for (const day of days) {
    const isEdge = day.dayNumber === 1 || day.dayNumber === days.length;
    if (!isEdge || days.length === 1) continue;
    const load = day.totals.activityMinutes + day.totals.travelMinutes;
    if (load > day.window.usableMinutes) {
      issues.push({
        code: 'edge_day_overfull',
        severity: 'error',
        message: `Day ${day.dayNumber} is an arrival or departure day and is scheduled beyond the hours it has.`,
        dayNumber: day.dayNumber,
      });
    }
  }

  const frequency = new Map<string, number>();
  for (const day of days) {
    for (const item of day.items) {
      if (item.kind !== 'activity' || !item.placeId) continue;
      const place = placesById.get(item.placeId);
      const primary = place?.interests[0];
      if (!primary) continue;
      frequency.set(primary, (frequency.get(primary) ?? 0) + 1);
    }
  }
  for (const [interest, count] of frequency) {
    const cap = profile.derived.frequencyCaps[interest as keyof typeof profile.derived.frequencyCaps];
    if (typeof cap === 'number' && count > cap) {
      issues.push({
        code: 'frequency_exceeded',
        severity: 'warning',
        message: `The plan has ${count} stops built around ${interest.replace(/_/g, ' ')}, more than the ${cap} you asked for.`,
      });
    }
  }

  for (const entry of input.unscheduled) {
    if (!entry.wasManual) continue;
    issues.push({
      code: 'must_include_unscheduled',
      severity: 'error',
      message: `${entry.name} is something you picked by hand and it could not be scheduled. ${entry.reason}`,
      placeId: entry.placeId,
    });
  }

  if (!scheduledAnything) {
    issues.push({
      code: 'empty_itinerary',
      severity: 'warning',
      message: 'Nothing could be scheduled from your selections.',
    });
  }

  return issues;
}

/**
 * The trip-level strategy against the days it claims to describe.
 *
 * Run after the strategy is derived rather than inside the main pass, because a
 * strategy that contradicts its own itinerary is a defect in this code, not a
 * problem with the traveller's choices — and it should be impossible.
 */
export function validateStrategy(
  strategy: Itinerary['transportStrategy'],
  days: readonly ItineraryDay[],
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const modesUsed = new Set(days.flatMap((day) => day.transport.modes));

  if (modesUsed.size > 0 && !modesUsed.has(strategy.primaryMode)) {
    issues.push({
      code: 'strategy_mode_mismatch',
      severity: 'error',
      message: `The plan recommends travelling by ${strategy.primaryMode}, but no day actually does.`,
    });
  }

  const actual = days.reduce(
    (acc, day) => ({
      drive: acc.drive + day.totals.driveMinutes,
      transit: acc.transit + day.totals.transitMinutes,
      walk: acc.walk + day.totals.walkMinutes,
      wait: acc.wait + day.totals.waitMinutes,
    }),
    { drive: 0, transit: 0, walk: 0, wait: 0 },
  );
  if (
    actual.drive !== strategy.totals.driveMinutes ||
    actual.transit !== strategy.totals.transitMinutes ||
    actual.walk !== strategy.totals.walkMinutes ||
    actual.wait !== strategy.totals.waitMinutes
  ) {
    issues.push({
      code: 'inconsistent_transport_totals',
      severity: 'error',
      message: 'The transportation summary does not add up to the days it describes.',
    });
  }

  return issues;
}

/**
 * The transportation half of the check.
 *
 * The scheduler already refuses to build most of these — it is the right place
 * to prevent them. This exists because "the builder is careful" is an assumption,
 * and an assumption about the last bus out of a valley with no phone signal is
 * one worth having a second opinion on.
 */
function validateDayTransport(day: ItineraryDay, input: ValidationInput): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const { profile, access, placesById } = input;
  const travelItems = day.items.filter((item) => item.kind === 'travel' && item.travel);

  // 1. Totals must equal what is on the timeline, or every budget check above is
  //    checking a number nobody produced.
  // Classified exactly as the layout classifies it — by mode, with waiting split
  // out — because the whole point of this check is that the two agree. A leg
  // counted as walking here and as riding there is how a budget silently stops
  // being enforced.
  const summed = travelItems.reduce(
    (acc, item) => {
      const travel = item.travel!;
      if (travel.mode === 'drive') acc.drive += travel.minutes;
      else if (travel.role === 'wait') acc.wait += travel.minutes;
      else if (travel.mode === 'walk') acc.walk += travel.minutes;
      else acc.transit += travel.minutes;
      return acc;
    },
    { drive: 0, transit: 0, walk: 0, wait: 0 },
  );
  if (
    summed.drive !== day.totals.driveMinutes ||
    summed.transit !== day.totals.transitMinutes ||
    summed.walk !== day.totals.walkMinutes ||
    summed.wait !== day.totals.waitMinutes
  ) {
    issues.push({
      code: 'inconsistent_transport_totals',
      severity: 'error',
      message: `Day ${day.dayNumber}'s transport totals do not match the legs on its timeline.`,
      dayNumber: day.dayNumber,
    });
  }

  for (const item of travelItems) {
    const travel = item.travel!;
    if (!travel.fromId || !travel.toId || !travel.fromName || !travel.toName) {
      issues.push({
        code: 'transport_leg_without_endpoint',
        severity: 'error',
        message: `A leg on day ${day.dayNumber} does not say where it starts or ends.`,
        dayNumber: day.dayNumber,
      });
    }
    if (travel.mode === 'drive' && !profile.transport.willDrive) {
      issues.push({
        code: 'required_mode_unavailable',
        severity: 'error',
        message: `Day ${day.dayNumber} has you driving, and you told us you would not have a car.`,
        dayNumber: day.dayNumber,
      });
    }
    if (
      (travel.mode === 'shuttle' || travel.mode === 'public_bus') &&
      !profile.transport.willUseShuttles
    ) {
      issues.push({
        code: 'required_mode_unavailable',
        severity: 'error',
        message: `Day ${day.dayNumber} puts you on a ${travel.mode === 'shuttle' ? 'shuttle' : 'bus'}, which you asked us to leave out.`,
        dayNumber: day.dayNumber,
      });
    }
  }

  // 2. Boarding the same service twice in a day means the shared-access grouping
  //    failed and the traveller is paying and queueing twice.
  const boardings = travelItems
    .filter((item) => item.travel!.role === 'ride' && item.travel!.serviceId)
    .map((item) => item.travel!.serviceId!);
  for (const serviceId of new Set(boardings)) {
    if (boardings.filter((id) => id === serviceId).length > 1) {
      issues.push({
        code: 'duplicate_access_sequence',
        severity: 'error',
        message: `Day ${day.dayNumber} boards the same service more than once. Everything behind it should be one trip in and one trip out.`,
        dayNumber: day.dayNumber,
      });
    }
  }

  // 3. The services this day leans on must actually run on this date.
  for (const serviceId of day.transport.serviceIds) {
    const service = access.services.find((entry) => entry.id === serviceId);
    if (!service) {
      issues.push({
        code: 'missing_access_data',
        severity: 'error',
        message: `Day ${day.dayNumber} depends on a service we have no timetable for.`,
        dayNumber: day.dayNumber,
      });
      continue;
    }
    const availability = serviceAvailabilityOn(service, day.date);
    if (!availability.available) {
      issues.push({
        code:
          availability.reason === 'out_of_season'
            ? 'service_out_of_season'
            : 'service_not_operating_on_date',
        severity: 'error',
        message: `${service.label} does not run on ${day.date}, and day ${day.dayNumber} is built around it.`,
        dayNumber: day.dayNumber,
      });
    }

    // 4. The last way out. The failure this whole layer exists to prevent.
    const returnLeg = travelItems.find(
      (item) => item.travel!.role === 'return' && item.travel!.serviceId === serviceId,
    );
    if (returnLeg && returnLeg.startMinute > service.window.lastReturnDeparture) {
      issues.push({
        code: 'missed_last_return',
        severity: 'error',
        message: `Day ${day.dayNumber} reaches the stop at ${formatMinuteOfDay(returnLeg.startMinute)}, after the last ${service.label} out at ${formatMinuteOfDay(service.window.lastReturnDeparture)}.`,
        dayNumber: day.dayNumber,
      });
    }
    // In and back out, including the wait each way and the walk at the far end —
    // the same arithmetic the layout performs, so the two cannot disagree.
    const rule = access.rules.find((entry) => entry.serviceId === service.id);
    const roundTrip =
      service.rideMinutes * 2 +
      service.transferBufferMinutes * 2 +
      (rule?.walkMinutesFromDropOff ?? 0) * 2;
    if (service.window.lastReturnDeparture - service.window.firstDeparture < roundTrip) {
      issues.push({
        code: 'access_window_too_short',
        severity: 'error',
        message: `${service.label} does not run long enough in a day to get in and back out.`,
        dayNumber: day.dayNumber,
      });
    }
  }

  // 5. Road and remoteness preferences, checked against what was actually
  //    scheduled rather than only against what was offered.
  for (const item of day.items) {
    if (item.kind !== 'activity' || !item.placeId) continue;
    const place = placesById.get(item.placeId);
    if (!place) continue;

    const roughRoad = place.access.roadSurface !== 'paved';
    const drivesThere = day.transport.modes.includes('drive');
    if (
      roughRoad &&
      drivesThere &&
      (profile.avoidances.includes('rough_or_gravel_roads') ||
        (place.access.roadSurface === 'unpaved' && !profile.transport.comfortableGravelRoads))
    ) {
      issues.push({
        code: 'road_surface_incompatible',
        severity: 'error',
        message: `${place.name} is reached on an unpaved road, which you asked us to avoid.`,
        dayNumber: day.dayNumber,
        placeId: place.id,
      });
    }
    if (
      place.access.remoteNoServices &&
      profile.avoidances.includes('remote_areas_without_services')
    ) {
      issues.push({
        code: 'remote_area_incompatible',
        severity: 'error',
        message: `${place.name} is out where there are no services, which you asked us to avoid.`,
        dayNumber: day.dayNumber,
        placeId: place.id,
      });
    }
    if (
      place.access.parkingDifficulty === 'hard' &&
      drivesThere &&
      day.transport.serviceIds.length === 0
    ) {
      issues.push({
        code: 'parking_unavailable',
        severity: 'warning',
        message: `${place.name} has a lot that fills early. Arriving late may mean no space.`,
        dayNumber: day.dayNumber,
        placeId: place.id,
      });
    }
  }

  return issues;
}

function lastTravelReturnsToBase(day: ItineraryDay, baseId: string): boolean {
  const travels = day.items.filter((item) => item.kind === 'travel' && item.travel);
  const last = travels[travels.length - 1];
  return last?.travel?.toId === baseId;
}

/** Plain state from real validator output — never a fabricated numeric score. */
export function statusFor(issues: readonly ValidationIssue[]): Itinerary['status'] {
  if (issues.some((issue) => issue.severity === 'error')) return 'needs_decision';
  if (issues.some((issue) => issue.severity === 'warning')) return 'ready_with_cautions';
  return 'ready';
}
