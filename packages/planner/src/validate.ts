import {
  CLOSED_REASON_COPY,
  displayNameOf,
  findOperatingCalendar,
  formatMinuteOfDay,
  operatingOn,
  serviceAvailabilityOn,
  type AccessDataset,
  type Itinerary,
  type ItineraryDay,
  type OperatingHoursDataset,
  type TravelerProfile,
  type UnscheduledPlace,
  type ValidationIssue,
  type WeatherDataset,
} from '@sidequest/core';
import { hasPoint, type TravelTimeMatrix } from '@sidequest/geo';
import { isOpenOnDate } from './schedule';
import { chargeFrequencyCost } from './frequency';
import { corroboratingKm, impossibleSpeed, modePhrase, roundKm } from './speed';
import { travelBucketFor } from './travel';
import { validateDayFood, validateTripFood } from './validate-food';
import { validateDayWeather } from './validate-weather';
import type { PlannerConfig } from './types';
import type { FoodPlan, Place } from '@sidequest/core';

export interface ValidationInput {
  days: readonly ItineraryDay[];
  unscheduled: readonly UnscheduledPlace[];
  profile: TravelerProfile;
  config: PlannerConfig;
  matrix: TravelTimeMatrix;
  placesById: ReadonlyMap<string, Place>;
  baseId: string;
  access: AccessDataset;
  hours: OperatingHoursDataset;
  weather: WeatherDataset;
  /** Derived from the finished plan, so the checks read the same thing the UI does. */
  foodPlan: FoodPlan;
  /** Whether any food data reached the planner. Absent is not the same as empty. */
  hadFoodDataset: boolean;
  /** "Now", for the staleness check only. Injected so the test is instant. */
  now?: Date;
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
  const foodInput = {
    profile,
    config,
    foodPlan: input.foodPlan,
    hadDataset: input.hadFoodDataset,
  };
  let scheduledAnything = false;

  for (const day of days) {
    const items = [...day.items].sort((a, b) => a.startMinute - b.startMinute);

    /**
     * Only an *evening* meal earns the allowance. Keyed off the dinner hour
     * rather than off "the last meal", because the last meal on a day that ends
     * at half twelve is lunch, and letting every afternoon stop run
     * three-quarters of an hour past the window is not what this is for.
     */
    const lastMealStart =
      items
        .filter(
          (entry) =>
            entry.kind === 'meal' && entry.startMinute >= config.mealWindows.dinner.earliest,
        )
        .at(-1)?.startMinute ?? null;

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
      /**
       * The window bounds what the planner *schedules*. An evening meal is the
       * one thing a traveller carries on past it, so the last meal of the day —
       * and getting home from it — may finish a little outside.
       *
       * Without this a balanced-pace day ending at seven could hold an hour of
       * dinner and not a minute more, and every real restaurant in this region
       * takes longer than an hour: the plan held time for a meal instead of
       * naming one on days that had a table free. The allowance is one-sided,
       * starts at the last meal, and nothing may *begin* outside the window.
       */
      const ceiling =
        lastMealStart !== null &&
        item.startMinute >= lastMealStart &&
        (item.kind === 'meal' || item.kind === 'travel')
          ? day.window.endMinute + config.mealOverrunAllowanceMinutes
          : day.window.endMinute;
      if (item.startMinute < day.window.startMinute || item.endMinute > ceiling) {
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
          message: `${displayNameOf(place)} is not reachable on ${day.date}.`,
          dayNumber: day.dayNumber,
          placeId: place.id,
        });
      }
      if (place && !hasPoint(matrix, place.id)) {
        issues.push({
          code: 'matrix_entry_missing',
          severity: 'error',
          message: `No travel time is recorded for ${displayNameOf(place)}.`,
          dayNumber: day.dayNumber,
          placeId: place.id,
        });
      }
    }

    for (const item of items) {
      if (
        item.kind === 'travel' &&
        item.travel &&
        item.travel.minutes !== null &&
        item.durationMinutes < item.travel.minutes
      ) {
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
    issues.push(...validateDayHours(day, input));
    issues.push(...validateDayWeather(day, input));
    issues.push(...validateDayFood(day, foodInput));

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

  /*
   * Counted through `frequency.ts`, the one definition the packer also spends
   * against. Counting it here a second way is how a plan came back with a
   * caution about a ceiling the packer never thought was near — and a traveller
   * cannot act on two different answers to "how many of these did I ask for".
   */
  const frequency = new Map<string, number>();
  const stopsPerInterest = new Map<string, number>();
  for (const day of days) {
    for (const item of day.items) {
      if (item.kind !== 'activity' || !item.placeId) continue;
      const place = placesById.get(item.placeId);
      if (!place) continue;
      chargeFrequencyCost(place, profile, frequency);
      const primary = place.interests[0];
      if (primary) stopsPerInterest.set(primary, (stopsPerInterest.get(primary) ?? 0) + 1);
    }
  }
  for (const [interest, spent] of frequency) {
    const cap = profile.derived.frequencyCaps[interest as keyof typeof profile.derived.frequencyCaps];
    if (typeof cap !== 'number' || spent <= cap) continue;
    /*
     * Stated in stops, because "3.5 stops built around lakes" is not a sentence
     * anybody can act on. The ledger is fractional; the explanation is not.
     */
    const stops = stopsPerInterest.get(interest) ?? Math.ceil(spent);
    issues.push({
      code: 'frequency_exceeded',
      severity: 'warning',
      message: `The plan has ${Math.max(stops, 1)} stops built around ${interest.replace(/_/g, ' ')}, more than the ${cap} you asked for.`,
    });
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
    /**
     * An error, not a warning, and the difference is the whole point.
     *
     * As a warning this produced `ready_with_cautions` — so five dated days with
     * nothing on them came back as a finished plan with a note. A live
     * compilation did exactly that. `planTrip` now refuses before returning such
     * a plan at all, and this is the second line of defence: were one ever to
     * reach here, it would be `needs_decision` rather than ready.
     */
    issues.push({
      code: 'empty_itinerary',
      severity: 'error',
      message: 'Nothing could be scheduled from your selections.',
    });
  }

  issues.push(...validateTripFood(days, foodInput));

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
      unverified: acc.unverified + day.totals.unverifiedMinutes,
    }),
    { drive: 0, transit: 0, walk: 0, wait: 0, unverified: 0 },
  );
  if (
    actual.drive !== strategy.totals.driveMinutes ||
    actual.transit !== strategy.totals.transitMinutes ||
    actual.walk !== strategy.totals.walkMinutes ||
    actual.wait !== strategy.totals.waitMinutes ||
    actual.unverified !== strategy.totals.unverifiedMinutes
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
  // Classified by the *same function* the layout classifies with, rather than by
  // a second copy of the same rule — because the whole point of this check is
  // that the two agree, and two copies cannot check each other. They were two
  // copies, and they had already drifted: a `drive` leg with a stated allowance
  // went to riding in the layout and to driving here, so the day failed this
  // check and, until it did, a driving cap was enforced against a zero.
  const summed = travelItems.reduce(
    (acc, item) => {
      const travel = item.travel!;
      // An unmeasured leg contributes to no total. That is the whole point of the
      // null: a day's travel minutes are the minutes somebody stands behind, and
      // the count of what is missing rides beside them rather than inside them.
      if (travel.minutes === null) return acc;
      /*
       * The leg's own statement that its mode is a stand-in, read from the
       * stored timeline. Without it this sum classifies a proxy journey as a
       * walk and the layout's `unverifiedMinutes` looks like a discrepancy —
       * which is the check doing its job: the two must classify identically,
       * so both are told the same thing about the same leg.
       */
      acc[travelBucketFor(travel.mode, travel.role, travel.unverifiedScheduled === true)] +=
        travel.minutes;
      return acc;
    },
    { drive: 0, transit: 0, walk: 0, wait: 0, unverified: 0 },
  );
  if (
    summed.drive !== day.totals.driveMinutes ||
    summed.transit !== day.totals.transitMinutes ||
    summed.walk !== day.totals.walkMinutes ||
    summed.wait !== day.totals.waitMinutes ||
    summed.unverified !== day.totals.unverifiedMinutes
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

  issues.push(...impossibleSpeedIssues(day, input.matrix));

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
        message: `${displayNameOf(place)} is reached on an unpaved road, which you asked us to avoid.`,
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
        message: `${displayNameOf(place)} is out where there are no services, which you asked us to avoid.`,
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
        message: `${displayNameOf(place)} has a lot that fills early. Arriving late may mean no space.`,
        dayNumber: day.dayNumber,
        placeId: place.id,
      });
    }
  }

  return issues;
}

/**
 * The opening-hours half of the check.
 *
 * The layout already refuses to build any of this, which is the right place to
 * prevent it. This exists for the same reason its transport counterpart does:
 * "the builder is careful" is an assumption, and the assumption here is that
 * nobody is ever scheduled to arrive at a gate that shut an hour earlier.
 *
 * Everything is checked twice over — once against the evidence stored on the
 * item, once against the calendar the plan was built from — because those two
 * disagreeing is itself the defect worth catching. An itinerary that says
 * "open until 18:00" over a visit ending at 18:40 is worse than one that says
 * nothing, and it survives a refresh.
 */
function validateDayHours(day: ItineraryDay, input: ValidationInput): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const { hours, placesById } = input;

  for (const item of day.items) {
    if (item.kind !== 'activity' || !item.placeId) continue;
    const place = placesById.get(item.placeId);
    const name = place?.name ?? item.title;

    const calendar = findOperatingCalendar(hours, item.placeId);
    if (!calendar) {
      issues.push({
        code: 'missing_operating_data',
        severity: 'error',
        message: `We hold no opening hours for ${name}, and day ${day.dayNumber} schedules it anyway.`,
        dayNumber: day.dayNumber,
        placeId: item.placeId,
      });
      continue;
    }

    const onDate = operatingOn(calendar, day.date);

    if (onDate.status === 'closed') {
      issues.push({
        code: 'attraction_closed_on_date',
        severity: 'error',
        message: `${name} is ${onDate.closedReason ? CLOSED_REASON_COPY[onDate.closedReason] : 'closed'} on ${day.date}, and day ${day.dayNumber} visits it.`,
        dayNumber: day.dayNumber,
        placeId: item.placeId,
      });
      continue;
    }

    if (onDate.status === 'unknown') {
      /**
       * A caution, and — after two attempts at making it more than that — still
       * a caution. The reasoning is worth keeping, because it is a fair argument
       * that loses to the data.
       *
       * The defect is real: nothing stopped an unknown-hours place being the
       * thing a day was built around, so a plan could put a museum at seven in
       * the evening on no evidence and report itself ready with cautions. The
       * obvious fix is to escalate the severity when the visit falls outside the
       * hours most staffed places keep.
       *
       * It does not survive contact with two facts. `unknown` is the compiler's
       * *default* for every OSM record with no `opening_hours` tag — which is
       * most lakes, viewpoints and trailheads — and `dayStartByPreference.early`
       * is 07:30. So any early riser's first stop of the day trips the rule, the
       * reviser drops it, the next stop slides into 07:30 and trips it again,
       * and three passes later the whole trip is refused. Narrowing the band
       * until that stops happening leaves 07:30–20:00, and `dayEndByPace.fast`
       * is 20:00, so the ceiling becomes unreachable and the rule can only ever
       * fire as a false positive.
       *
       * What the check actually needs is a staffed-versus-unstaffed signal, and
       * the open record does not carry one. Until it does, the honest
       * consequence of unknown hours is the one already in place everywhere it
       * matters: the place cannot be a weather backup (`backups.ts`), and it
       * becomes a named verification action in the preparation list.
       */
      issues.push({
        code: 'operating_hours_unknown',
        severity: 'warning',
        message: `Nobody has confirmed opening hours for ${name}. Check them before you rely on day ${day.dayNumber}.`,
        dayNumber: day.dayNumber,
        placeId: item.placeId,
      });
    }

    if (item.booking) {
      issues.push({
        code: 'booking_unresolved',
        severity: 'warning',
        message: `${name} needs ${item.booking.kind === 'permit' ? 'a permit' : 'a booking'} you have to arrange yourself. We have not made it.`,
        dayNumber: day.dayNumber,
        placeId: item.placeId,
      });
    }

    /**
     * Evidence for hours the place does not have.
     *
     * The reverse of the check below, and the one that catches a plan stored
     * before a calendar changed shape — a visit to the Manzanar grounds carrying
     * the visitor centre's 09:00–16:30, say, after the two were split apart. The
     * timeline would render a window that is no longer anyone's, so the plan is
     * surfaced as needing a rebuild rather than quietly lying.
     */
    if (onDate.status !== 'open') {
      if (item.hours) {
        issues.push({
          code: 'operating_evidence_inconsistent',
          severity: 'error',
          message: `Day ${day.dayNumber} records opening hours against ${name}, which has none on ${day.date}. Rebuild this plan.`,
          dayNumber: day.dayNumber,
          placeId: item.placeId,
        });
      }
      continue;
    }

    // The window the plan claims to have used must be one the calendar offers.
    const evidence = item.hours;
    if (!evidence) {
      issues.push({
        code: 'operating_evidence_inconsistent',
        severity: 'error',
        message: `${name} has opening hours on ${day.date}, but day ${day.dayNumber} records none against the visit.`,
        dayNumber: day.dayNumber,
        placeId: item.placeId,
      });
      continue;
    }
    const matching = onDate.windows.find(
      (window) =>
        window.openMinute === evidence.openMinute && window.closeMinute === evidence.closeMinute,
    );
    if (!matching) {
      issues.push({
        code: 'operating_evidence_inconsistent',
        severity: 'error',
        message: `Day ${day.dayNumber} says ${name} is open ${formatMinuteOfDay(evidence.openMinute)}–${formatMinuteOfDay(evidence.closeMinute)}, which is not one of its windows on ${day.date}.`,
        dayNumber: day.dayNumber,
        placeId: item.placeId,
      });
      continue;
    }

    if (item.startMinute < matching.openMinute) {
      issues.push({
        code: 'arrives_before_opening',
        severity: 'error',
        message: `Day ${day.dayNumber} starts ${name} at ${formatMinuteOfDay(item.startMinute)}, before it opens at ${formatMinuteOfDay(matching.openMinute)}.`,
        dayNumber: day.dayNumber,
        placeId: item.placeId,
      });
    }
    if (matching.lastAdmissionMinute !== null && item.startMinute > matching.lastAdmissionMinute) {
      issues.push({
        code: 'arrives_after_last_admission',
        severity: 'error',
        message: `Day ${day.dayNumber} arrives at ${name} at ${formatMinuteOfDay(item.startMinute)}, after the last entry at ${formatMinuteOfDay(matching.lastAdmissionMinute)}.`,
        dayNumber: day.dayNumber,
        placeId: item.placeId,
      });
    }
    if (item.endMinute > matching.closeMinute) {
      issues.push({
        code: 'visit_ends_after_closing',
        severity: 'error',
        message: `Day ${day.dayNumber} has you at ${name} until ${formatMinuteOfDay(item.endMinute)}, after it closes at ${formatMinuteOfDay(matching.closeMinute)}.`,
        dayNumber: day.dayNumber,
        placeId: item.placeId,
      });
    }

    // A visit legal against the clock but impossible against the way out: the
    // shuttle window and the opening window simply never overlap that day.
    const lastReturn = lastReturnGoverning(day, item.id, input);
    if (lastReturn !== null && matching.openMinute > lastReturn) {
      issues.push({
        code: 'no_operating_window_in_access_window',
        severity: 'error',
        message: `${name} does not open until ${formatMinuteOfDay(matching.openMinute)}, by which time the last way out of day ${day.dayNumber} has gone.`,
        dayNumber: day.dayNumber,
        placeId: item.placeId,
      });
    }
  }

  return issues;
}

/**
 * The last departure that governs *this* stop, or null when none does.
 *
 * Scoped to the service the stop actually sits behind, found by walking the
 * timeline for the ride in and the ride back out that bracket it. Taking the
 * tightest last-return across the whole day instead would apply a trolley's
 * 17:30 deadline to a place the traveller drives to afterwards, and the reviser
 * would then drop that place for a constraint it has nothing to do with.
 */
function lastReturnGoverning(
  day: ItineraryDay,
  itemId: string,
  input: ValidationInput,
): number | null {
  const index = day.items.findIndex((entry) => entry.id === itemId);
  if (index < 0) return null;

  const rideIn = [...day.items.slice(0, index)]
    .reverse()
    .find((entry) => entry.travel?.role === 'ride' && entry.travel.serviceId);
  if (!rideIn?.travel?.serviceId) return null;

  const serviceId = rideIn.travel.serviceId;
  const ridesBackOut = day.items
    .slice(index)
    .some((entry) => entry.travel?.role === 'return' && entry.travel.serviceId === serviceId);
  if (!ridesBackOut) return null;

  const service = input.access.services.find((entry) => entry.id === serviceId);
  return service ? service.window.lastReturnDeparture : null;
}

/**
 * THE SPEED A LEG'S OWN NUMBERS IMPLY, CHECKED AGAINST WHAT THE MODE CAN DO.
 *
 * A stored Tokyo plan scheduled ten-minute "walks" to places its own pack
 * records as 16.4 road-km away — every one of them a legacy authored constant,
 * every one rendered as a fact. Nothing upstream can be trusted to never write
 * such a leg again (the constants arrive inside packs the planner did not
 * build), so the finished plan is checked arithmetically: distance over
 * minutes, against a generous ceiling per mode.
 *
 * Errors, not cautions. A plan that states impossible transport as fact is
 * the artifact this validator class exists to refuse — and because the check
 * runs on every build, it guards the Rebuild path against a poisoned pack.
 *
 * Scheduled vehicles carry no ceiling: a bullet train is faster than anything
 * here, and asserting a bound for it would refuse real journeys. Waits are
 * time standing still and are skipped for the same reason.
 *
 * The ceilings themselves live in `speed.ts`, because `access.ts` refuses the
 * same class *before* scheduling and the two must convict identically. A leg the
 * scheduler accepted and the validator rejects is not caught, it is an itinerary
 * ground to nothing by a revision loop chasing a repair that does not exist.
 */
export function impossibleSpeedIssues(
  day: ItineraryDay,
  matrix: TravelTimeMatrix,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const item of day.items) {
    const travel = item.travel;
    if (!travel || travel.minutes === null || travel.role === 'wait') continue;

    /**
     * The distance this leg may be convicted on, and where it is allowed to come
     * from.
     *
     * The leg's own kilometres are the strongest evidence: a leg that carries a
     * distance carries it alongside the minutes it was derived from — a measured
     * pair, or the corridor model, whose own road distance is exactly what its
     * minutes were computed from. Those two figures are one statement and may be
     * held against each other freely.
     *
     * The matrix fallback is a *different* statement. On a car-free trip the
     * matrix is a road matrix and the leg is a walk, so the kilometres describe
     * a journey by another network entirely — and holding an authored
     * "20 min walk" against a road that loops 3 km around convicted a leg that
     * was a perfectly ordinary 1.2 km stroll. `corroboratingKm` is what keeps the
     * fallback honest: same network, the measurement; different network, the
     * floor below which no route of this mode between those points can fall.
     *
     * Still restricted to approach/transfer/return roles: an authored `walk`-role
     * leg describes a trail from a drop-off, and any distance between the same
     * two ids describes a different journey entirely.
     */
    const own = typeof travel.km === 'number' ? travel.km : 0;
    const borrowed =
      travel.role === 'approach' || travel.role === 'return' || travel.role === 'transfer'
        ? corroboratingKm(matrix, travel.fromId, travel.toId, travel.mode)
        : null;
    const usableKm = Math.max(own, borrowed?.usableKm ?? 0);
    const verdict = impossibleSpeed(travel.mode, usableKm, travel.minutes);
    if (!verdict) continue;

    /*
     * Quoted from the leg's own distance when it has one, and otherwise from the
     * matrix's measurement rather than the discounted figure the verdict used —
     * the traveller can check "16.4 km by road"; nobody can check a floor.
     */
    const statedKm = own >= (borrowed?.usableKm ?? 0) ? own : borrowed!.measuredKm;
    /*
     * Deliberately day-scoped and not attributed to the leg's destination. An
     * impossible leg is a property of the *order* the day was laid out in, not
     * of the stop at the far end of it — dropping any stop re-routes the day and
     * can remove the leg entirely. Naming the destination was tried and made the
     * reviser worse: it turned "re-lay this day out with one less stop" into
     * "the hand-picked place at the end of the bad leg cannot be dropped, so
     * nothing can be done", and refused plans that repaired themselves.
     */
    issues.push({
      code: 'travel_leg_speed_impossible',
      severity: 'error',
      message: `Day ${day.dayNumber} allows ${travel.minutes} min to cover ${roundKm(statedKm)} km ${modePhrase(travel.mode)} (${travel.fromName} to ${travel.toName}) — around ${Math.round(verdict.kmh)} km/h, which is not possible. The travel time behind this leg cannot be trusted.`,
      dayNumber: day.dayNumber,
    });
  }

  return issues;
}

function lastTravelReturnsToBase(day: ItineraryDay, baseId: string): boolean {
  const travels = day.items.filter((item) => item.kind === 'travel' && item.travel);
  const last = travels[travels.length - 1];
  return last?.travel?.toId === baseId;
}

/**
 * Errors that mean "we could not give you something you asked for", as distinct
 * from "this plan does not work".
 *
 * Both are errors and both must be loud. Only the second invalidates the
 * itinerary: the first is surfaced as a named conflict with its reason, which is
 * the honest answer to a request nothing could satisfy.
 *
 * Lives here, next to the codes themselves, because two places have to agree on
 * it — the gate `planTrip` closes before it hands a plan back, and the gate
 * `assemble` closes before an edit is saved. When only the first had the list,
 * the second had no gate at all.
 */
export const REQUEST_NOT_MET_CODES: ReadonlySet<ValidationIssue['code']> = new Set([
  'must_include_unscheduled',
  'food_choice_unscheduled',
  /*
   * A thin plan is a disappointing one, not a broken one. Every day in it is
   * internally valid — that is precisely why the status was reading "Ready,
   * with cautions" — so the honest outcome is `needs_decision` over a plan the
   * traveller can still see, not a refusal that leaves them with nothing.
   */
  'coverage_below_pace',
]);

/**
 * The errors that make a plan unshippable.
 *
 * Findings the planner resolved by removing their subject never reach here:
 * they are carried forward as warnings, because the hazard they describe is no
 * longer in the plan.
 */
export function blockingIssues(
  issues: readonly ValidationIssue[],
): readonly ValidationIssue[] {
  return issues.filter(
    (issue) => issue.severity === 'error' && !REQUEST_NOT_MET_CODES.has(issue.code),
  );
}

/** Plain state from real validator output — never a fabricated numeric score. */
export function statusFor(issues: readonly ValidationIssue[]): Itinerary['status'] {
  if (issues.some((issue) => issue.severity === 'error')) return 'needs_decision';
  if (issues.some((issue) => issue.severity === 'warning')) return 'ready_with_cautions';
  return 'ready';
}
