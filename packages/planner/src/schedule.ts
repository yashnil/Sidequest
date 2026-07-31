import {
  assessSeason,
  formatMinuteOfDay,
  INTEREST_LABELS,
  TRANSPORT_MODE_LABELS,
  type Interest,
  type ItineraryDay,
  type ItineraryItem,
  type Place,
  type TransportMode,
  type TravelerProfile,
} from '@sidequest/core';
import { leg, orderStops, type TravelTimeMatrix } from '@sidequest/geo';
import type { AccessLegPlan, AccessOption, AccessUnit } from './access';
import type { PlannedDay } from './windows';
import type { PlannerConfig, PlanningCandidate } from './types';

/**
 * A place's season resolved against one specific date rather than the whole
 * trip. The board only knows "open on some month of your trip", which is not
 * good enough once days are real: a trip spanning late October into November
 * must not put Tioga Pass on a November day just because October qualified.
 */
export function isOpenOnDate(place: Place, date: string): boolean {
  const month = Number(date.slice(5, 7));
  if (!Number.isInteger(month) || month < 1 || month > 12) return false;
  return assessSeason(place, [month]).status === 'open';
}

/** A day's stops, grouped into the gateway sequences that actually serve them. */
export interface ScheduledUnit {
  unit: AccessUnit;
  option: AccessOption;
  members: PlanningCandidate[];
}

/**
 * A way the day breaks the access rules. Distinct from a validation issue: these
 * are found while building, and a day that has one is never offered.
 */
export interface AccessViolation {
  code:
    | 'missed_last_return'
    | 'missed_last_outbound'
    | 'access_window_too_short'
    | 'missing_travel_data';
  message: string;
  placeId?: string;
}

export interface DayLayout {
  items: ItineraryItem[];
  endMinute: number;
  activityMinutes: number;
  /** Total transportation: driving, riding, walking to reach things and waiting. */
  travelMinutes: number;
  driveMinutes: number;
  transitMinutes: number;
  walkMinutes: number;
  waitMinutes: number;
  travelKm: number;
  freeMinutes: number;
  strenuousCount: number;
  violations: AccessViolation[];
  /** Modes actually used, in first-use order. */
  modes: TransportMode[];
}

export interface LayoutContext {
  day: PlannedDay;
  baseId: string;
  baseName: string;
  matrix: TravelTimeMatrix;
  config: PlannerConfig;
  profile: TravelerProfile;
}

/**
 * Lays a day out on the clock from an ordered set of access units.
 *
 * The plan is *built* and then measured, rather than estimated and then built —
 * so "does this fit?" is answered by the same code that produces the timeline.
 * An estimate that drifts from the layout is how itineraries end up overlapping
 * their own items, or scheduling a hike that ends after the last bus.
 *
 * The unit is the reason a shared shuttle is paid for once. Everything between
 * boarding and getting off again belongs to one sequence: drive to the gateway,
 * wait, ride, walk, do the things, walk, ride back.
 */
export function layoutDay(
  context: LayoutContext,
  units: readonly ScheduledUnit[],
): DayLayout {
  const { day, baseId, baseName, matrix, config } = context;
  const items: ItineraryItem[] = [];
  const violations: AccessViolation[] = [];
  const modes: TransportMode[] = [];

  let cursor = day.window.startMinute;
  let activityMinutes = 0;
  let driveMinutes = 0;
  let transitMinutes = 0;
  let walkMinutes = 0;
  let waitMinutes = 0;
  let travelKm = 0;
  let strenuousCount = 0;
  let lunchInserted = false;
  let sequence = 0;

  const dayIsLongEnough = day.window.usableMinutes >= config.minDayMinutesForLunch;
  const useMode = (mode: TransportMode) => {
    if (!modes.includes(mode)) modes.push(mode);
  };

  let atRoutingId = baseId;
  let atName = baseName;
  /**
   * How the traveller gets home at the end.
   *
   * Null means "drive, measured from the matrix" — right for a car trip, and
   * catastrophic for a car-free one, where an unconditional drive home is a leg
   * the traveller cannot perform and silently blows their zero-minute driving
   * budget. When the way out was on foot or on a service, the way back mirrors
   * it, because that is what actually happens.
   */
  let homeward: { mode: TransportMode; minutes: number } | null = null;
  /**
   * Where the car is.
   *
   * Without this the vehicle teleports: a traveller who walks to a bus stop, rides
   * to the Lakes Basin and rides back can be scheduled to "drive" onward from the
   * bus stop, and the drive out to fetch the car never appears in the day or in
   * its driving total. Tracking the car means a later drive first has to go back
   * to where it was left.
   */
  let vehicleAt = baseId;

  const maybeLunch = () => {
    if (lunchInserted || !dayIsLongEnough || cursor < config.lunchEarliestMinute) return;
    items.push(
      mealItem(
        day.dayNumber,
        'Lunch',
        cursor,
        config.lunchMinutes,
        'Slotted in before the next stop rather than skipped.',
      ),
    );
    cursor += config.lunchMinutes;
    lunchInserted = true;
  };

  for (const scheduled of units) {
    const { option, members } = scheduled;

    // --- Approach: get to the gateway --------------------------------------
    if (option.approachMinutes === null && atRoutingId !== vehicleAt && homeward) {
      // The next leg is a drive and the traveller is not standing where the car
      // is. Get back to it the way they left it, before driving anywhere.
      items.push({
        id: `travel-${day.dayNumber}-${sequence++}`,
        kind: 'travel',
        title: `${TRANSPORT_MODE_LABELS[homeward.mode]} back to the car`,
        startMinute: cursor,
        endMinute: cursor + homeward.minutes,
        durationMinutes: homeward.minutes,
        reason: 'Back to where you left the car before driving on.',
        weatherSensitive: false,
        travel: {
          fromId: atRoutingId,
          toId: vehicleAt,
          fromName: atName,
          toName: baseName,
          minutes: homeward.minutes,
          km: 0,
          mode: homeward.mode,
          role: 'return',
          provenance: 'estimated',
        },
      });
      cursor += homeward.minutes;
      if (homeward.mode === 'walk') walkMinutes += homeward.minutes;
      else transitMinutes += homeward.minutes;
      useMode(homeward.mode);
      atRoutingId = vehicleAt;
      atName = baseName;
      homeward = null;
    }

    if (option.approachMinutes === null) {
      // Leaving later beats standing at a stop: if the first thing this day does
      // is catch a service, set off in time to meet it rather than in time to
      // wait for it.
      if (option.service && items.length === 0) {
        const ride = tryHop(matrix, atRoutingId, option.gatewayRoutingId);
        const leadIn =
          (ride ? ride.minutes + config.bufferMinutes : 0) +
          option.service.transferBufferMinutes;
        cursor = Math.max(cursor, option.service.window.firstDeparture - leadIn);
      }
      const hop = tryHop(matrix, atRoutingId, option.gatewayRoutingId);
      if (!hop) {
        violations.push({
          code: 'missing_travel_data',
          message: `No travel time is recorded from ${atName} to ${option.gatewayName ?? option.gatewayRoutingId}.`,
          ...(members[0] ? { placeId: members[0].place.id } : {}),
        });
        continue;
      }
      if (hop.minutes > 0) {
        maybeLunch();
        // Transition slack rides on the travel block rather than sitting as an
        // invisible gap: parking, boots, and getting going are real minutes.
        const duration = hop.minutes + config.bufferMinutes;
        const toName = gatewayLabel(option, members);
        items.push({
          id: `travel-${day.dayNumber}-${sequence++}`,
          kind: 'travel',
          title: `Drive to ${toName}`,
          startMinute: cursor,
          endMinute: cursor + duration,
          durationMinutes: duration,
          reason: `${hop.minutes} min on the road, plus ${config.bufferMinutes} min to park and get going.`,
          weatherSensitive: false,
          travel: {
            fromId: atRoutingId,
            toId: option.gatewayRoutingId,
            fromName: atName,
            toName,
            minutes: hop.minutes,
            km: hop.km,
            mode: 'drive',
            role: 'approach',
            provenance: matrix.provenance.kind,
          },
        });
        cursor += duration;
        driveMinutes += hop.minutes;
        travelKm += hop.km;
        useMode('drive');
        homeward = null;
        vehicleAt = option.gatewayRoutingId;
      }
    } else if (atRoutingId !== option.gatewayRoutingId && option.approachMinutes > 0) {
      if (option.service && items.length === 0) {
        cursor = Math.max(
          cursor,
          option.service.window.firstDeparture -
            option.approachMinutes -
            option.service.transferBufferMinutes,
        );
      }
      maybeLunch();
      const toName = gatewayLabel(option, members);
      items.push({
        id: `travel-${day.dayNumber}-${sequence++}`,
        kind: 'travel',
        title: `${TRANSPORT_MODE_LABELS[option.approachMode]} to ${toName}`,
        startMinute: cursor,
        endMinute: cursor + option.approachMinutes,
        durationMinutes: option.approachMinutes,
        reason: `${option.approachMinutes} min to get to ${toName}.`,
        weatherSensitive: false,
        travel: {
          fromId: atRoutingId,
          toId: option.gatewayRoutingId,
          fromName: atName,
          toName,
          minutes: option.approachMinutes,
          km: 0,
          mode: option.approachMode,
          role: 'approach',
          provenance: 'estimated',
        },
      });
      cursor += option.approachMinutes;
      if (option.approachMode === 'walk') walkMinutes += option.approachMinutes;
      else transitMinutes += option.approachMinutes;
      useMode(option.approachMode);
      homeward = { mode: option.approachMode, minutes: option.approachMinutes };
    } else if (option.approachMinutes !== null && option.approachMinutes > 0) {
      // Already standing at this gateway, so nothing to travel — but the way
      // home is still the way we arrived at it.
      homeward ??= { mode: option.approachMode, minutes: option.approachMinutes };
    }
    // Only the name is carried forward here; the routing id is set from the
    // option's exit once the unit is done, which may not be the gateway.
    atName = gatewayLabel(option, members);

    // --- Entry legs: board, ride, walk in ----------------------------------
    for (const plan of option.entryLegs) {
      if (plan.role === 'wait' && option.service) {
        // You cannot board before the first departure. Waiting for it is real
        // time on the day, and pretending otherwise is how a 07:00 start turns
        // into a plan that leaves before the bus exists.
        const readyToBoard = cursor + plan.minutes;
        const boarding = Math.max(readyToBoard, option.service.window.firstDeparture);
        if (boarding > option.service.window.lastOutboundDeparture) {
          violations.push({
            code: 'missed_last_outbound',
            message: `The last ${option.service.label} in leaves at ${formatMinuteOfDay(
              option.service.window.lastOutboundDeparture,
            )}, and this day does not reach the stop until ${formatMinuteOfDay(readyToBoard)}.`,
            ...(members[0] ? { placeId: members[0].place.id } : {}),
          });
        }
        const duration = boarding - cursor;
        if (duration > 0) {
          items.push({
            id: `travel-${day.dayNumber}-${sequence++}`,
            kind: 'travel',
            title: `Board the ${option.service.label}`,
            startMinute: cursor,
            endMinute: boarding,
            durationMinutes: duration,
            reason: plan.note ?? 'Ticket and wait for the next departure.',
            weatherSensitive: false,
            travel: {
              fromId: plan.fromId,
              toId: plan.toId,
              fromName: plan.fromName,
              toName: plan.toName,
              minutes: duration,
              km: 0,
              mode: plan.mode,
              role: 'wait',
              provenance: plan.provenance,
              serviceId: plan.serviceId,
            },
          });
          cursor = boarding;
          waitMinutes += duration;
        }
        continue;
      }
      // The option was resolved for the whole unit, before the packer decided
      // which of its members the day could hold. Naming the walk after a stop
      // that then got dropped would put a place on the timeline the traveller
      // never visits, so the endpoint is taken from what is actually scheduled.
      cursor = pushLeg(
        items,
        plan.role === 'walk' && members[0]
          ? { ...plan, toId: members[0].place.id, toName: members[0].place.name }
          : plan,
        day.dayNumber,
        cursor,
        () => sequence++,
      );
      if (plan.mode === 'walk') walkMinutes += plan.minutes;
      else transitMinutes += plan.minutes;
      useMode(plan.mode);
    }

    // --- The reason you came -----------------------------------------------
    members.forEach((candidate, index) => {
      const measured =
        index > 0 && !option.service
          ? tryHop(matrix, members[index - 1]!.place.id, candidate.place.id)
          : null;
      const transfer =
        measured !== null
          ? { mode: 'drive' as const, minutes: measured.minutes }
          : option.internalTransfer;

      if (index > 0 && transfer.minutes > 0) {
        items.push({
          id: `travel-${day.dayNumber}-${sequence++}`,
          kind: 'travel',
          title: `${TRANSPORT_MODE_LABELS[transfer.mode]} to ${candidate.place.name}`,
          startMinute: cursor,
          endMinute: cursor + transfer.minutes,
          durationMinutes: transfer.minutes,
          reason: 'Both sit inside the same access area, so this is a short hop.',
          weatherSensitive: false,
          travel: {
            fromId: members[index - 1]!.place.id,
            toId: candidate.place.id,
            fromName: members[index - 1]!.place.name,
            toName: candidate.place.name,
            minutes: transfer.minutes,
            km: 0,
            mode: transfer.mode,
            role: 'transfer',
            provenance: measured ? matrix.provenance.kind : 'estimated',
          },
        });
        cursor += transfer.minutes;
        if (transfer.mode === 'drive') {
          driveMinutes += transfer.minutes;
          if (measured) travelKm += measured.km;
          vehicleAt = candidate.place.id;
        } else if (transfer.mode === 'walk') walkMinutes += transfer.minutes;
        else transitMinutes += transfer.minutes;
        useMode(transfer.mode);
      }

      maybeLunch();

      const place = candidate.place;
      items.push({
        id: `activity-${day.dayNumber}-${place.id}`,
        kind: 'activity',
        title: place.name,
        startMinute: cursor,
        endMinute: cursor + candidate.durationMinutes,
        durationMinutes: candidate.durationMinutes,
        placeId: place.id,
        reason: reasonFor(candidate),
        weatherSensitive: place.weatherSensitivity === 'high',
        physicalIntensity: place.physicalIntensity,
        ...(place.seasonalAccess.note ? { seasonalNote: place.seasonalAccess.note } : {}),
        ...(place.logisticsNote ? { accessWarning: place.logisticsNote } : {}),
      });
      cursor += candidate.durationMinutes;
      activityMinutes += candidate.durationMinutes;

      if (place.physicalIntensity === 'strenuous') {
        strenuousCount += 1;
        items.push({
          id: `rest-${day.dayNumber}-${place.id}`,
          kind: 'rest',
          title: 'Sit down for a bit',
          startMinute: cursor,
          endMinute: cursor + config.restAfterStrenuousMinutes,
          durationMinutes: config.restAfterStrenuousMinutes,
          reason: 'You will want it after that one.',
          weatherSensitive: false,
        });
        cursor += config.restAfterStrenuousMinutes;
      }
    });

    // --- Exit legs: walk out, wait, ride back -------------------------------
    for (const plan of option.exitLegs) {
      if (plan.role === 'return' && option.service) {
        // Waiting for the bus home is the same real time as waiting for it out,
        // and the entry side already charges for it. Charging it here too is
        // what stops the planner building a day that reaches the stop at exactly
        // the minute the last bus pulls away.
        const buffer = option.service.transferBufferMinutes;
        if (buffer > 0) {
          items.push({
            id: `travel-${day.dayNumber}-${sequence++}`,
            kind: 'travel',
            title: `Wait for the ${option.service.label}`,
            startMinute: cursor,
            endMinute: cursor + buffer,
            durationMinutes: buffer,
            reason: `Be at the stop before it leaves — the last one goes at ${formatMinuteOfDay(
              option.service.window.lastReturnDeparture,
            )}.`,
            weatherSensitive: false,
            travel: {
              fromId: plan.fromId,
              toId: plan.toId,
              fromName: plan.fromName,
              toName: plan.toName,
              minutes: buffer,
              km: 0,
              mode: plan.mode,
              role: 'wait',
              provenance: 'estimated',
              ...(plan.serviceId ? { serviceId: plan.serviceId } : {}),
            },
          });
          cursor += buffer;
          waitMinutes += buffer;
        }

        // The one constraint that turns a pleasant afternoon into a night in the
        // woods. Checked against where the clock actually stands, not an estimate.
        if (cursor > option.service.window.lastReturnDeparture) {
          violations.push({
            code: 'missed_last_return',
            message: `The last ${option.service.label} out leaves at ${formatMinuteOfDay(
              option.service.window.lastReturnDeparture,
            )} and this day does not reach the stop until ${formatMinuteOfDay(cursor)}.`,
            ...(members[members.length - 1]
              ? { placeId: members[members.length - 1]!.place.id }
              : {}),
          });
        }
      }
      const last = members[members.length - 1];
      cursor = pushLeg(
        items,
        plan.role === 'walk' && last
          ? { ...plan, fromId: last.place.id, fromName: last.place.name }
          : plan,
        day.dayNumber,
        cursor,
        () => sequence++,
      );
      if (plan.mode === 'walk') walkMinutes += plan.minutes;
      else transitMinutes += plan.minutes;
      useMode(plan.mode);
    }

    atRoutingId = option.exitRoutingId;
    atName = exitLabel(option, members, atName);
    if (!option.service && option.approachMinutes === null) vehicleAt = option.exitRoutingId;
  }

  // --- Home ----------------------------------------------------------------
  if (atRoutingId !== baseId && homeward) {
    items.push({
      id: `travel-${day.dayNumber}-${sequence++}`,
      kind: 'travel',
      title: `${TRANSPORT_MODE_LABELS[homeward.mode]} back to ${baseName}`,
      startMinute: cursor,
      endMinute: cursor + homeward.minutes,
      durationMinutes: homeward.minutes,
      reason: `${homeward.minutes} min back to ${baseName}, the way you came.`,
      weatherSensitive: false,
      travel: {
        fromId: atRoutingId,
        toId: baseId,
        fromName: atName,
        toName: baseName,
        minutes: homeward.minutes,
        km: 0,
        mode: homeward.mode,
        role: 'return',
        provenance: 'estimated',
      },
    });
    cursor += homeward.minutes;
    if (homeward.mode === 'walk') walkMinutes += homeward.minutes;
    else transitMinutes += homeward.minutes;
    useMode(homeward.mode);
  } else if (atRoutingId !== baseId) {
    const hop = tryHop(matrix, atRoutingId, baseId);
    if (!hop) {
      violations.push({
        code: 'missing_travel_data',
        message: `No travel time is recorded from ${atName} back to ${baseName}.`,
      });
    } else if (hop.minutes > 0) {
      const duration = hop.minutes + config.bufferMinutes;
      items.push({
        id: `travel-${day.dayNumber}-${sequence++}`,
        kind: 'travel',
        title: `Drive to ${baseName}`,
        startMinute: cursor,
        endMinute: cursor + duration,
        durationMinutes: duration,
        reason: `${hop.minutes} min on the road, plus ${config.bufferMinutes} min to park and get going.`,
        weatherSensitive: false,
        travel: {
          fromId: atRoutingId,
          toId: baseId,
          fromName: atName,
          toName: baseName,
          minutes: hop.minutes,
          km: hop.km,
          mode: 'drive',
          role: 'return',
          provenance: matrix.provenance.kind,
        },
      });
      cursor += duration;
      driveMinutes += hop.minutes;
      travelKm += hop.km;
      useMode('drive');
    }
  }

  // Lunch never found a gap mid-route; give it one now if the clock allows.
  if (!lunchInserted && dayIsLongEnough && cursor + config.lunchMinutes <= day.window.endMinute) {
    items.push(
      mealItem(day.dayNumber, 'Lunch', cursor, config.lunchMinutes, 'Late, but better than skipping it.'),
    );
    cursor += config.lunchMinutes;
  }

  if (
    day.window.endMinute >= config.dinnerEarliestMinute &&
    cursor + config.dinnerMinutes <= day.window.endMinute
  ) {
    const dinnerStart = Math.max(cursor, config.dinnerEarliestMinute);
    if (dinnerStart + config.dinnerMinutes <= day.window.endMinute) {
      if (dinnerStart > cursor) {
        cursor = pushFreeTime(items, day, config, cursor, dinnerStart);
      }
      items.push(
        mealItem(day.dayNumber, 'Dinner', cursor, config.dinnerMinutes, 'Back at base, nothing booked.'),
      );
      cursor += config.dinnerMinutes;
    }
  }

  cursor = pushFreeTime(items, day, config, cursor, day.window.endMinute);

  const freeMinutes = items
    .filter((item) => item.kind === 'free_time')
    .reduce((sum, item) => sum + item.durationMinutes, 0);

  return {
    items,
    endMinute: cursor,
    activityMinutes,
    travelMinutes: driveMinutes + transitMinutes + walkMinutes + waitMinutes,
    driveMinutes,
    transitMinutes,
    walkMinutes,
    waitMinutes,
    travelKm: Math.round(travelKm * 10) / 10,
    freeMinutes,
    strenuousCount,
    violations,
    modes,
  };
}

function pushLeg(
  items: ItineraryItem[],
  plan: AccessLegPlan,
  dayNumber: number,
  cursor: number,
  nextSequence: () => number,
): number {
  if (plan.minutes <= 0) return cursor;
  items.push({
    id: `travel-${dayNumber}-${nextSequence()}`,
    kind: 'travel',
    title: legTitle(plan),
    startMinute: cursor,
    endMinute: cursor + plan.minutes,
    durationMinutes: plan.minutes,
    reason: plan.note ?? `${plan.minutes} min ${TRANSPORT_MODE_LABELS[plan.mode].toLowerCase()}.`,
    weatherSensitive: false,
    travel: {
      fromId: plan.fromId,
      toId: plan.toId,
      fromName: plan.fromName,
      toName: plan.toName,
      minutes: plan.minutes,
      km: plan.km,
      mode: plan.mode,
      role: plan.role,
      provenance: plan.provenance,
      ...(plan.serviceId ? { serviceId: plan.serviceId } : {}),
    },
  });
  return cursor + plan.minutes;
}

function legTitle(plan: AccessLegPlan): string {
  switch (plan.role) {
    case 'walk':
      return `Walk to ${plan.toName}`;
    case 'ride':
      return `Ride to ${plan.toName}`;
    case 'return':
      return `Ride back to ${plan.toName}`;
    case 'transfer':
      return `Transfer to ${plan.toName}`;
    default:
      return `${TRANSPORT_MODE_LABELS[plan.mode]} to ${plan.toName}`;
  }
}

function gatewayLabel(option: AccessOption, members: readonly PlanningCandidate[]): string {
  if (option.service) return option.gatewayName;
  return members[0]?.place.name ?? option.gatewayName;
}

function exitLabel(
  option: AccessOption,
  members: readonly PlanningCandidate[],
  fallback: string,
): string {
  if (option.service) return option.gatewayName;
  return members[members.length - 1]?.place.name ?? fallback;
}

function tryHop(
  matrix: TravelTimeMatrix,
  fromId: string,
  toId: string,
): { minutes: number; km: number } | null {
  try {
    return leg(matrix, fromId, toId);
  } catch {
    return null;
  }
}

function pushFreeTime(
  items: ItineraryItem[],
  day: PlannedDay,
  config: PlannerConfig,
  from: number,
  to: number,
): number {
  const span = to - from;
  if (span < config.minFreeTimeBlockMinutes) return from;
  items.push({
    id: `free-${day.dayNumber}-${from}`,
    kind: 'free_time',
    title: 'Free time',
    startMinute: from,
    endMinute: to,
    durationMinutes: span,
    reason: 'Deliberately unbooked. A plan with no slack in it is a plan that breaks.',
    weatherSensitive: false,
  });
  return to;
}

function mealItem(
  dayNumber: number,
  title: string,
  start: number,
  minutes: number,
  reason: string,
): ItineraryItem {
  return {
    id: `meal-${dayNumber}-${title.toLowerCase()}-${start}`,
    kind: 'meal',
    title,
    startMinute: start,
    endMinute: start + minutes,
    durationMinutes: minutes,
    reason,
    weatherSensitive: false,
  };
}

function reasonFor(candidate: PlanningCandidate): string {
  if (candidate.manual) return 'You picked this one yourself, so it was placed first.';
  if (candidate.selectionStatus === 'maybe') return 'A maybe from your board that fitted the day.';
  const interest = candidate.primaryInterest;
  return interest
    ? `Matches your interest in ${INTEREST_LABELS[interest].toLowerCase()}.`
    : 'A strong fit for how you said you travel.';
}

/**
 * Greedy packing by priority, over access units rather than loose places.
 *
 * Each candidate is added, the whole day is re-ordered and re-laid-out, and it
 * is kept only if the result still fits every constraint — including the access
 * ones, which is the part an estimate cannot answer. Expensive in theory,
 * trivial at a handful of stops a day, and it means a day can never be declared
 * valid on an arithmetic that the timeline then contradicts.
 */
export interface PackResult {
  accepted: PlanningCandidate[];
  overflow: PlanningCandidate[];
}

export interface PackOptions {
  maxActivities: number;
  maxDailyDriveMinutes: number;
  maxDailyTransportMinutes: number;
  maxStrenuous: number;
  /** Unit key → the legal way in on this day, if any. */
  accessByUnit: ReadonlyMap<string, AccessOption>;
  /** Which unit each place belongs to. */
  unitByPlaceId: ReadonlyMap<string, AccessUnit>;
}

export function packDay(
  context: LayoutContext,
  available: readonly PlanningCandidate[],
  options: PackOptions,
): PackResult {
  // The slack floor exists to stop a day being crammed, so it only guards the
  // third stop onward. Applying it from the first would do the opposite of what
  // it is for: it would veto pairing two stops that sit on the same road and
  // leave the traveller driving an hour each way for a single afternoon.
  const slackFloor = context.day.isEdgeDay
    ? 0
    : context.config.minFreeMinutesByPace[context.profile.pace];
  const SLACK_APPLIES_FROM_STOP = 3;
  const accepted: PlanningCandidate[] = [];
  const overflow: PlanningCandidate[] = [];
  const { day } = context;

  for (const candidate of available) {
    if (accepted.length >= options.maxActivities) {
      overflow.push(candidate);
      continue;
    }
    if (!isOpenOnDate(candidate.place, day.date)) {
      overflow.push(candidate);
      continue;
    }
    const unit = options.unitByPlaceId.get(candidate.place.id);
    if (!unit || !options.accessByUnit.has(unit.key)) {
      overflow.push(candidate);
      continue;
    }
    const strenuousSoFar = accepted.filter(
      (item) => item.place.physicalIntensity === 'strenuous',
    ).length;
    if (candidate.place.physicalIntensity === 'strenuous' && strenuousSoFar >= options.maxStrenuous) {
      overflow.push(candidate);
      continue;
    }

    const tentative = [...accepted, candidate];
    const scheduled = scheduleUnits(context, tentative, options);
    const layout = layoutDay(context, scheduled);

    const fitsClock = layout.endMinute <= day.window.endMinute;
    const fitsCapacity = layout.activityMinutes + layout.travelMinutes <= day.capacityMinutes;
    const fitsDriving = layout.driveMinutes <= options.maxDailyDriveMinutes;
    const fitsTransport = layout.travelMinutes <= options.maxDailyTransportMinutes;
    const legalAccess = layout.violations.length === 0;
    const requiredFree = tentative.length >= SLACK_APPLIES_FROM_STOP ? slackFloor : 0;
    const keepsSlack = layout.freeMinutes >= requiredFree;

    if (fitsClock && fitsCapacity && fitsDriving && fitsTransport && legalAccess && keepsSlack) {
      accepted.push(candidate);
    } else {
      overflow.push(candidate);
    }
  }

  return { accepted, overflow };
}

/**
 * Groups a day's accepted candidates into units and puts the units in road
 * order.
 *
 * Ordering runs over each unit's gateway rather than over its members, which is
 * what stops the optimiser from "visiting" Rainbow Falls between two roadside
 * stops it cannot reach it from.
 */
export function scheduleUnits(
  context: LayoutContext,
  candidates: readonly PlanningCandidate[],
  options: Pick<PackOptions, 'accessByUnit' | 'unitByPlaceId'>,
): ScheduledUnit[] {
  const byUnit = new Map<string, PlanningCandidate[]>();
  for (const candidate of candidates) {
    const unit = options.unitByPlaceId.get(candidate.place.id);
    if (!unit) continue;
    const bucket = byUnit.get(unit.key);
    if (bucket) bucket.push(candidate);
    else byUnit.set(unit.key, [candidate]);
  }

  const pending = [...byUnit.entries()].flatMap(([key, members]) => {
    const unit = options.unitByPlaceId.get(members[0]!.place.id);
    const option = options.accessByUnit.get(key);
    if (!unit || !option) return [];
    return [{ unit, option, members }];
  });
  if (pending.length === 0) return [];

  const anchors = pending.map((entry) => entry.option.gatewayRoutingId);
  const route = orderStops(context.matrix, {
    startId: context.baseId,
    endId: context.baseId,
    stopIds: [...new Set(anchors)],
  });

  const position = new Map<string, number>();
  route.path.forEach((id, index) => {
    if (!position.has(id)) position.set(id, index);
  });

  return pending
    .map((entry) => ({
      ...entry,
      // Inside a unit, keep the order the unit was built in — nearest the base
      // first — so a shuttle run reads as a route rather than a shuffle.
      members: [...entry.members].sort(
        (a, b) =>
          entry.unit.members.findIndex((member) => member.place.id === a.place.id) -
          entry.unit.members.findIndex((member) => member.place.id === b.place.id),
      ),
    }))
    .sort(
      (a, b) =>
        (position.get(a.option.gatewayRoutingId) ?? Number.MAX_SAFE_INTEGER) -
          (position.get(b.option.gatewayRoutingId) ?? Number.MAX_SAFE_INTEGER) ||
        a.unit.key.localeCompare(b.unit.key),
    );
}

export function buildDay(
  context: LayoutContext,
  accepted: readonly PlanningCandidate[],
  layout: DayLayout,
  transport: ItineraryDay['transport'],
): ItineraryDay {
  const { day, baseId, baseName, profile } = context;
  const intensity = classifyIntensity(layout, profile);
  const warnings: string[] = [];

  if (day.window.usableMinutes === 0) {
    warnings.push('There are no usable hours on this day once travel in or out is accounted for.');
  }
  for (const candidate of accepted) {
    if (candidate.place.weatherSensitivity === 'high') {
      warnings.push(`${candidate.place.name} is weather-dependent — have a fallback in mind.`);
    }
  }
  for (const violation of layout.violations) warnings.push(violation.message);

  return {
    dayNumber: day.dayNumber,
    date: day.date,
    baseId,
    baseName,
    theme: themeFor(accepted, baseName),
    window: day.window,
    items: layout.items,
    totals: {
      activityMinutes: layout.activityMinutes,
      travelMinutes: layout.travelMinutes,
      driveMinutes: layout.driveMinutes,
      transitMinutes: layout.transitMinutes,
      walkMinutes: layout.walkMinutes,
      waitMinutes: layout.waitMinutes,
      travelKm: layout.travelKm,
      freeMinutes: layout.freeMinutes,
      strenuousCount: layout.strenuousCount,
    },
    transport,
    intensity,
    warnings: [...new Set(warnings)],
  };
}

function classifyIntensity(
  layout: DayLayout,
  profile: TravelerProfile,
): ItineraryDay['intensity'] {
  const load = layout.activityMinutes + layout.travelMinutes;
  if (layout.strenuousCount >= 2 || load > 8 * 60) return 'intense';
  if (layout.strenuousCount === 0 && load <= 3 * 60) return 'light';
  if (profile.dailyIntensity === 'light' && layout.strenuousCount > 0) return 'intense';
  return 'moderate';
}

/** Deterministic: the dominant interest, plus where the day actually went. */
function themeFor(accepted: readonly PlanningCandidate[], baseName: string): string {
  if (accepted.length === 0) return 'An open day';

  // Weighted by time on site, not by headcount. A day with a three-hour canyon
  // hike and a one-hour stop in town is a hiking day, and counting stops instead
  // of minutes would label it a food day on an alphabetical tie-break.
  const weights = new Map<Interest, number>();
  for (const candidate of accepted) {
    const interest = candidate.primaryInterest;
    if (interest) {
      weights.set(interest, (weights.get(interest) ?? 0) + candidate.durationMinutes);
    }
  }

  const dominant = [...weights.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  )[0]?.[0];

  const farthest = [...accepted].sort(
    (a, b) =>
      b.driveMinutesFromBase - a.driveMinutesFromBase || a.place.id.localeCompare(b.place.id),
  )[0];

  const area =
    farthest && farthest.driveMinutesFromBase > 20 ? farthest.place.locality : baseName;
  const lead = dominant ? INTEREST_LABELS[dominant] : 'Mixed';
  return `${lead} around ${area}`;
}

export { formatMinuteOfDay };
