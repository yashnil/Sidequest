import {
  assessSeason,
  formatMinuteOfDay,
  INTEREST_LABELS,
  TRANSPORT_MODE_LABELS,
  type BookingRequirement,
  type DayAvailability,
  type Interest,
  type ItineraryDay,
  type ItineraryItem,
  type MinuteInterval,
  type OpeningWindowOnDate,
  type Place,
  type DayWeatherSummary,
  type ScheduledHours,
  type ScheduledWeather,
  type TransportMode,
  type TravelerProfile,
} from '@sidequest/core';
import { leg, orderStops, type TravelTimeMatrix } from '@sidequest/geo';
import type { AccessLegPlan, AccessOption, AccessUnit } from './access';
import {
  latestStartOn,
  placeVisit,
  type HoursBlockCode,
  type PlaceDayHours,
} from './hours';
import {
  isWeatherWorthFlagging,
  narrowByDaylight,
  type PlaceDayWeather,
} from './weather';
import { weatherPenaltyAt } from '@sidequest/core';
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
 * A way the day cannot legally be executed. Distinct from a validation issue:
 * these are found while building, and a day that has one is never offered.
 *
 * `kind` keeps the two failures apart on purpose. "The last bus left" and "the
 * gate was shut" are different problems with different remedies, and a traveller
 * told only that a stop "did not work" has been told nothing.
 */
export interface LayoutViolation {
  kind: 'access' | 'hours';
  code:
    | 'missed_last_return'
    | 'missed_last_outbound'
    | 'access_window_too_short'
    | 'missing_travel_data'
    | HoursBlockCode;
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
  violations: LayoutViolation[];
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
  /**
   * Opening hours for this day only, by place id. Already resolved against
   * `day.date`, so nothing downstream has to know a calendar exists.
   */
  hours: ReadonlyMap<string, PlaceDayHours>;
  /**
   * Weather and daylight for every stop on this date, resolved at the same
   * boundary as the hours. Weather only ever narrows or cautions here; the one
   * thing in it that constrains legality is daylight, which is a fact rather
   * than a prediction.
   */
  weather: ReadonlyMap<string, PlaceDayWeather>;
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
  const violations: LayoutViolation[] = [];
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

  /**
   * Lunch is split into "is it due?" and "put it there" because a stop's
   * legality now depends on when the traveller actually arrives, and lunch is
   * forty-five minutes of that. Deciding whether to eat before knowing whether
   * the next stop is still open would be how a plan eats its way past a last
   * admission.
   */
  const lunchDueAt = (minute: number) =>
    !lunchInserted && dayIsLongEnough && minute >= config.lunchEarliestMinute;

  const commitLunch = (minute: number): number => {
    items.push(
      mealItem(
        day.dayNumber,
        'Lunch',
        minute,
        config.lunchMinutes,
        'Slotted in before the next stop rather than skipped.',
      ),
    );
    lunchInserted = true;
    return minute + config.lunchMinutes;
  };

  const maybeLunch = () => {
    if (lunchDueAt(cursor)) cursor = commitLunch(cursor);
  };

  for (const scheduled of units) {
    const { option } = scheduled;

    /**
     * The bounds a visit inside this unit has to sit between, before its own
     * opening hours are even consulted: the day's usable hours, narrowed by the
     * way in. On a shuttle-served unit `latestActivityEnd` is the moment after
     * which you cannot get back out — the constraint that has been computed
     * since the transport slice and, until now, never read.
     */
    const bounds: MinuteInterval = {
      startMinute: Math.max(
        day.window.startMinute,
        option.earliestActivityStart ?? Number.NEGATIVE_INFINITY,
      ),
      endMinute: Math.min(
        day.window.endMinute,
        option.latestActivityEnd ?? Number.POSITIVE_INFINITY,
      ),
    };

    /**
     * Which of this unit's stops are worth going out for, decided *before* a
     * single leg is pushed.
     *
     * Sound because a later arrival can only make a visit less legal, never
     * more: testing against the clock as it stands now — before the drive, the
     * boarding and the walk in, all of which only advance it — cannot reject
     * anything that would have worked later. Anything it does reject is
     * genuinely impossible.
     *
     * Doing it here rather than inside the loop is what stops a day from
     * driving out, boarding a shuttle and walking to a gate that is shut. The
     * walk legs are named after these members, so with the filter in front of
     * them the timeline can never point at a stop it does not visit.
     */
    const members: PlanningCandidate[] = [];
    for (const candidate of scheduled.members) {
      const placement = visitFor(context, candidate, cursor, bounds);
      if (placement.ok) members.push(candidate);
      else violations.push(placement.violation);
    }
    // Nothing here can be done: do not pay for the journey out to it.
    if (members.length === 0) continue;

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
      /**
       * Leaving later beats standing about: if the first thing this day does is
       * catch a service or wait for a gate, set off in time to meet it rather
       * than in time to queue for it. Restricted to the first move of the day
       * because that is the only point where delaying costs nothing — mid-route
       * the traveller is already somewhere, and pushing the clock forward there
       * would eat into a later stop's hours.
       */
      if (items.length === 0) {
        const ride = tryHop(matrix, atRoutingId, option.gatewayRoutingId);
        const driveIn = ride ? ride.minutes + config.bufferMinutes : 0;
        if (option.service) {
          const leadIn = driveIn + option.service.transferBufferMinutes;
          cursor = Math.max(cursor, option.service.window.firstDeparture - leadIn);
        } else {
          const opensAt = openingMinuteFor(context, members[0]);
          if (opensAt !== null) cursor = Math.max(cursor, opensAt - driveIn);
        }
      }
      const hop = tryHop(matrix, atRoutingId, option.gatewayRoutingId);
      if (!hop) {
        violations.push({
          kind: 'access',
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
            kind: 'access',
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
    let previous: PlanningCandidate | null = null;
    for (const candidate of members) {
      /**
       * Everything is measured before anything is pushed.
       *
       * A stop that turns out to be shut must not leave a transfer leg pointing
       * at it, or a lunch eaten on the way to it, sitting on the timeline. So
       * the arrival time is computed through the transfer and through lunch, the
       * legality test runs against that, and only then is any of it committed.
       */
      const measured =
        previous && !option.service ? tryHop(matrix, previous.place.id, candidate.place.id) : null;
      const transfer =
        measured !== null
          ? { mode: 'drive' as const, minutes: measured.minutes }
          : option.internalTransfer;
      const transferMinutes = previous && transfer.minutes > 0 ? transfer.minutes : 0;

      const afterTransfer = cursor + transferMinutes;
      const lunchMinutes = lunchDueAt(afterTransfer) ? config.lunchMinutes : 0;
      const arrival = afterTransfer + lunchMinutes;

      // The real arrival, which is later than the one the pre-filter used and so
      // can still fail. Rare, and never leaves a leg pointing at nothing,
      // because the walk legs were named from the pre-filtered set.
      const placement = visitFor(context, candidate, arrival, bounds);
      if (!placement.ok) {
        violations.push(placement.violation);
        continue;
      }

      if (transferMinutes > 0 && previous) {
        items.push({
          id: `travel-${day.dayNumber}-${sequence++}`,
          kind: 'travel',
          title: `${TRANSPORT_MODE_LABELS[transfer.mode]} to ${candidate.place.name}`,
          startMinute: cursor,
          endMinute: cursor + transferMinutes,
          durationMinutes: transferMinutes,
          reason: 'Both sit inside the same access area, so this is a short hop.',
          weatherSensitive: false,
          travel: {
            fromId: previous.place.id,
            toId: candidate.place.id,
            fromName: previous.place.name,
            toName: candidate.place.name,
            minutes: transferMinutes,
            km: 0,
            mode: transfer.mode,
            role: 'transfer',
            provenance: measured ? matrix.provenance.kind : 'estimated',
          },
        });
        cursor += transferMinutes;
        if (transfer.mode === 'drive') {
          driveMinutes += transferMinutes;
          if (measured) travelKm += measured.km;
          vehicleAt = candidate.place.id;
        } else if (transfer.mode === 'walk') walkMinutes += transferMinutes;
        else transitMinutes += transferMinutes;
        useMode(transfer.mode);
      }

      if (lunchMinutes > 0) cursor = commitLunch(cursor);

      // Turning up before the doors open does not get you in sooner. The gap is
      // shown rather than hidden, so nobody sets off at seven for a nine o'clock
      // opening believing the plan needed them to.
      if (placement.startMinute > cursor) {
        cursor = pushWaitForOpening(
          items,
          day.dayNumber,
          cursor,
          placement.startMinute,
          candidate.place.name,
          placement.window?.openMinute ?? null,
        );
      }

      const place = candidate.place;
      const hours = context.hours.get(place.id);
      const evidence = scheduledHoursFrom(hours, placement.window);
      const booking = hours ? bookingFor(place, hours) : undefined;
      const weather = context.weather.get(place.id);
      const weatherEvidence = scheduledWeatherFrom(weather);
      items.push({
        id: `activity-${day.dayNumber}-${place.id}`,
        kind: 'activity',
        title: place.name,
        startMinute: cursor,
        endMinute: cursor + candidate.durationMinutes,
        durationMinutes: candidate.durationMinutes,
        placeId: place.id,
        reason: reasonFor(candidate),
        // Was `weatherSensitivity === 'high'`, which fired on four places out of
        // twenty-three whatever the sky was doing. It now means what the badge
        // beside it says: the weather on *this* day works against *this* stop.
        weatherSensitive: isWeatherWorthFlagging(weather),
        physicalIntensity: place.physicalIntensity,
        ...(place.seasonalAccess.note ? { seasonalNote: place.seasonalAccess.note } : {}),
        ...(place.logisticsNote ? { accessWarning: place.logisticsNote } : {}),
        ...(evidence ? { hours: evidence } : {}),
        ...(booking ? { booking } : {}),
        ...(weatherEvidence ? { weather: weatherEvidence } : {}),
        ...(hours?.daylightOnly ? { daylightOnly: true } : {}),
        ...(hours?.daylightOnly && weather?.solar
          ? {
              daylight: {
                sunriseMinute: weather.solar.sunriseMinute,
                sunsetMinute: weather.solar.sunsetMinute,
                source: weather.solar.source,
              },
            }
          : {}),
        ...(hours?.requiresVerification && hours.verifyNote
          ? { verifyBeforeTravel: hours.verifyNote }
          : {}),
      });
      cursor += candidate.durationMinutes;
      activityMinutes += candidate.durationMinutes;
      previous = candidate;

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
    }

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
            kind: 'access',
            code: 'missed_last_return',
            message: `The last ${option.service.label} out leaves at ${formatMinuteOfDay(
              option.service.window.lastReturnDeparture,
            )} and this day does not reach the stop until ${formatMinuteOfDay(cursor)}.`,
            ...(previous ? { placeId: previous.place.id } : {}),
          });
        }
      }
      // The walk out starts from the last stop actually made, not from the last
      // stop the unit contains — the packer routinely takes a subset.
      cursor = pushLeg(
        items,
        plan.role === 'walk' && previous
          ? { ...plan, fromId: previous.place.id, fromName: previous.place.name }
          : plan,
        day.dayNumber,
        cursor,
        () => sequence++,
      );
      if (plan.mode === 'walk') walkMinutes += plan.minutes;
      else transitMinutes += plan.minutes;
      useMode(plan.mode);
    }

    /**
     * Where the traveller — and the car — actually stand now.
     *
     * `option.exitRoutingId` is computed over the *unit's* members, which is
     * right when you rode in and are back at the boarding point, and wrong when
     * you drove and the day took only some of the unit's stops: the onward drive
     * would then be measured from a place nobody went to, and the car recorded
     * as parked there. With a service the exit is the gateway either way.
     */
    const exitedFrom = option.service ? option.exitRoutingId : (previous?.place.id ?? option.exitRoutingId);
    atRoutingId = exitedFrom;
    atName = option.service ? option.gatewayName : (previous?.place.name ?? atName);
    if (!option.service && option.approachMinutes === null) vehicleAt = exitedFrom;
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
        kind: 'access',
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

/**
 * The gap between getting there and being let in.
 *
 * Shown rather than swallowed: a hole in the timeline reads as a mistake, and
 * hiding the wait would leave the traveller unable to see that leaving half an
 * hour later costs them nothing. Not subject to the free-time minimum, because
 * this block exists to explain an adjacency rather than to offer a rest.
 */
function pushWaitForOpening(
  items: ItineraryItem[],
  dayNumber: number,
  from: number,
  to: number,
  placeName: string,
  openMinute: number | null,
): number {
  const span = to - from;
  if (span <= 0) return from;
  items.push({
    id: `open-wait-${dayNumber}-${from}`,
    kind: 'free_time',
    title: `Time before ${placeName} opens`,
    startMinute: from,
    endMinute: to,
    durationMinutes: span,
    reason:
      openMinute === null
        ? 'A gap before the next stop can start.'
        : `${placeName} opens at ${formatMinuteOfDay(openMinute)}. Getting there earlier does not get you in sooner.`,
    weatherSensitive: false,
  });
  return to;
}

/**
 * The evidence a visit was placed against, carried onto the item so a stored
 * plan can explain itself and a validator can check it. Absent for a place with
 * no hours to respect — an empty badge on a roadside viewpoint is noise.
 */
function scheduledHoursFrom(
  hours: PlaceDayHours | undefined,
  window: { openMinute: number; closeMinute: number; lastAdmissionMinute: number | null } | null,
): ScheduledHours | undefined {
  if (!hours || !window) return undefined;
  return {
    openMinute: window.openMinute,
    closeMinute: window.closeMinute,
    ...(window.lastAdmissionMinute !== null
      ? { lastAdmissionMinute: window.lastAdmissionMinute }
      : {}),
    ...(hours.periodLabel ? { periodLabel: hours.periodLabel } : {}),
    sourceKind: hours.provenance.kind,
    sourceName: hours.provenance.sourceName,
    ...(hours.provenance.sourceUrl ? { sourceUrl: hours.provenance.sourceUrl } : {}),
    ...(hours.provenance.lastVerified ? { lastVerified: hours.provenance.lastVerified } : {}),
    confidence: hours.provenance.confidence,
  };
}

/**
 * A booking the traveller has to make themselves. Never resolved here: the plan
 * hands back the requirement and the official link, and says nothing that could
 * be read as "this is arranged".
 */
function bookingFor(place: Place, hours: PlaceDayHours): BookingRequirement | undefined {
  const { admission } = hours;
  const kind = admission.timedEntry
    ? 'timed_entry'
    : admission.reservationRequired
      ? 'reservation'
      : admission.permitRequired
        ? 'permit'
        : null;
  if (!kind) return undefined;
  return {
    placeId: place.id,
    name: place.name,
    kind,
    ...(admission.note ? { note: admission.note } : {}),
    ...(admission.bookingUrl ? { url: admission.bookingUrl } : {}),
  };
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
    const { layout } = layoutBestOrder(context, tentative, options);

    const fitsClock = layout.endMinute <= day.window.endMinute;
    const fitsCapacity = layout.activityMinutes + layout.travelMinutes <= day.capacityMinutes;
    const fitsDriving = layout.driveMinutes <= options.maxDailyDriveMinutes;
    const fitsTransport = layout.travelMinutes <= options.maxDailyTransportMinutes;
    // Covers both kinds of illegality: no way out, and no way in through the
    // door. A day with either is never offered.
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
 * Comparing deadlines, including the `Infinity` most places have.
 *
 * `Infinity - Infinity` is `NaN`, and a comparator that returns `NaN` produces
 * an implementation-defined order — which in a planner that promises byte-identical
 * output for identical input is not a style problem.
 */
function byDeadline(a: number, b: number): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** When this stop must have started by, on this day. `Infinity` if it never shuts. */
function latestStartFor(context: LayoutContext, candidate: PlanningCandidate): number {
  return latestStartOn(context.hours.get(candidate.place.id), candidate.durationMinutes);
}

/**
 * One legality test for a stop, used by both the pre-filter and the real
 * placement so the two can never come to different conclusions.
 *
 * The missing-record branch is unreachable through the provider boundary, which
 * refuses a dataset that leaves a place out. It exists because refusing is the
 * safe way to be wrong: the alternative is scheduling on hours nobody holds.
 */
function visitFor(
  context: LayoutContext,
  candidate: PlanningCandidate,
  arrivalMinute: number,
  bounds: MinuteInterval,
): { ok: true; startMinute: number; window: OpeningWindowOnDate | null } | { ok: false; violation: LayoutViolation } {
  const hours = context.hours.get(candidate.place.id);
  if (!hours) {
    return {
      ok: false,
      violation: {
        kind: 'hours',
        code: 'no_window_in_reach',
        message: `We hold no opening-hours record for ${candidate.place.name}, so we will not put it on a day.`,
        placeId: candidate.place.id,
      },
    };
  }

  /**
   * Daylight, folded in before the opening hours are consulted.
   *
   * A place signed sunrise-to-sunset has a closing time like any other; the
   * only difference is that nobody prints it, so it has to be computed. Doing
   * it here rather than at one of the two call sites means the pre-filter and
   * the real placement cannot disagree — which is the same reason `visitFor`
   * exists at all.
   *
   * `narrowByDaylight` returns the original bounds untouched when there is no
   * solar record: an uncomputed sunset must not shrink anything, because "we
   * did not work out the light" is not "the light runs out".
   */
  const daylit = narrowByDaylight(
    bounds,
    context.weather.get(candidate.place.id),
    hours.daylightOnly,
  );
  if (!daylit) {
    return {
      ok: false,
      violation: {
        kind: 'hours',
        code: 'no_window_in_reach',
        message: `${candidate.place.name} is signed for daylight use only, and there is no daylight left inside what the rest of this day allows.`,
        placeId: candidate.place.id,
      },
    };
  }

  const placement = placeVisit({
    hours,
    placeName: candidate.place.name,
    arrivalMinute,
    durationMinutes: candidate.durationMinutes,
    bounds: daylit,
  });
  return placement.ok
    ? { ok: true, startMinute: placement.startMinute, window: placement.window }
    : {
        ok: false,
        violation: {
          kind: 'hours',
          code: placement.code,
          message: placement.message,
          placeId: candidate.place.id,
        },
      };
}

/** The earliest this stop opens today, or null when it has no opening time. */
function openingMinuteFor(
  context: LayoutContext,
  candidate: PlanningCandidate | undefined,
): number | null {
  if (!candidate) return null;
  const hours = context.hours.get(candidate.place.id);
  if (!hours || hours.status !== 'open' || hours.windows.length === 0) return null;
  return Math.min(...hours.windows.map((window) => window.openMinute));
}

/**
 * Lays the day out and, if the road order breaks somebody's opening hours,
 * tries the one alternative worth trying.
 *
 * The shortest route is not the right route when it arrives after closing. But
 * a general constrained-ordering search is both slow and a good way to produce a
 * day that zig-zags across a valley to save four minutes at a gate, so the
 * choice is deliberately between exactly two candidate orders:
 *
 *   1. **road order** — the existing behaviour, and what nearly every day uses.
 *   2. **deadline order** — earliest closing time first, road order breaking
 *      ties. Only reached when the first produced a violation.
 *
 * The first legal one wins; if neither is legal the first is returned, so the
 * violations that get reported are the ones from the plan the traveller would
 * otherwise have been handed. Two fixed orders, evaluated in a fixed sequence:
 * the result is deterministic and there is no search to oscillate.
 */
export function layoutBestOrder(
  context: LayoutContext,
  candidates: readonly PlanningCandidate[],
  options: Pick<PackOptions, 'accessByUnit' | 'unitByPlaceId'>,
): { scheduled: ScheduledUnit[]; layout: DayLayout } {
  const byRoad = scheduleUnits(context, candidates, options);
  const first = layoutDay(context, byRoad);
  if (first.violations.length === 0) {
    return preferByHourlyWeather(context, byRoad, first);
  }

  const byClosing = orderByDeadline(context, byRoad);
  if (sameOrder(byRoad, byClosing)) return { scheduled: byRoad, layout: first };

  const second = layoutDay(context, byClosing);
  return second.violations.length === 0
    ? preferByHourlyWeather(context, byClosing, second)
    : { scheduled: byRoad, layout: first };
}

/**
 * The third fixed order, and the only one weather is allowed to propose.
 *
 * On a summer afternoon in the Sierra the difference between starting an exposed
 * walk at nine and at two is the difference between a hike and a thunderstorm,
 * and the provider does return hour-by-hour values that can say which. So when
 * — and only when — there is genuine hourly evidence, one alternative order is
 * tried: the stops the weather most disfavours placed earliest.
 *
 * Three things keep this from being an optimiser:
 *
 * 1. It is one extra candidate order, not a search. There is nothing to
 *    oscillate and the result is a pure function of the inputs.
 * 2. The alternative has to be *legal on its own terms* — it goes through the
 *    same `layoutDay`, so access windows, opening hours, last admissions and
 *    daylight all still apply. Weather cannot buy a relaxation of any of them.
 * 3. It has to be meaningfully better, not merely different, or the day stays
 *    as the road left it. Reordering somebody's morning to move a 12% chance of
 *    rain to a 9% one is churn dressed up as intelligence.
 *
 * With no hourly data — every date past the forecast horizon, and every provider
 * that returns daily values only — this returns the road order untouched, which
 * is the honest behaviour rather than a degraded one.
 */
function preferByHourlyWeather(
  context: LayoutContext,
  scheduled: ScheduledUnit[],
  layout: DayLayout,
): { scheduled: ScheduledUnit[]; layout: DayLayout } {
  const incumbent = weatherPenaltyOf(context, layout);
  if (incumbent === null) return { scheduled, layout };

  const byWeather = orderByWeather(context, scheduled);
  if (sameOrder(scheduled, byWeather)) return { scheduled, layout };

  const alternative = layoutDay(context, byWeather);
  if (alternative.violations.length > 0) return { scheduled, layout };

  const challenger = weatherPenaltyOf(context, alternative);
  if (challenger === null) return { scheduled, layout };

  return challenger <= incumbent - HOURLY_WEATHER_MARGIN
    ? { scheduled: byWeather, layout: alternative }
    : { scheduled, layout };
}

/**
 * How much better an alternative order has to be before a day is rearranged.
 *
 * The penalty scale runs roughly 0 for a settled hour to 2 or so for a
 * thunderstorm at an exposed stop, so a quarter of a point is about the width of
 * one category — showers appearing, or a gust threshold being crossed. Anything
 * finer than that is noise the forecast cannot support.
 */
const HOURLY_WEATHER_MARGIN = 0.25;

/** Mean hourly weather cost of the activities on a laid-out day, or null. */
function weatherPenaltyOf(context: LayoutContext, layout: DayLayout): number | null {
  const scores: number[] = [];
  for (const item of layout.items) {
    if (item.kind !== 'activity' || !item.placeId) continue;
    const weather = context.weather.get(item.placeId);
    if (!weather) continue;
    const penalty = weatherPenaltyAt({
      day: weather.evidence,
      profile: weather.profile,
      startMinute: item.startMinute,
      durationMinutes: item.durationMinutes,
    });
    if (penalty !== null) scores.push(penalty);
  }
  if (scores.length === 0) return null;
  return scores.reduce((sum, value) => sum + value, 0) / scores.length;
}

/**
 * Units ordered so the stops the weather most disfavours come first.
 *
 * Ranked on the worst hour anywhere in the day rather than on the stop's current
 * slot, so the ordering is a property of the day rather than of the layout it
 * came from — which is what stops it depending on its own output. Ties fall back
 * to the incoming order, so an ordinary day is unchanged.
 */
function orderByWeather(
  context: LayoutContext,
  units: readonly ScheduledUnit[],
): ScheduledUnit[] {
  const position = new Map(units.map((unit, index) => [unit.unit.key, index]));
  const exposure = (unit: ScheduledUnit): number => {
    const scores = unit.members
      .map((member) => context.weather.get(member.place.id))
      .filter((entry): entry is PlaceDayWeather => entry !== undefined)
      .map((entry) => entry.assessment.score);
    return scores.length === 0 ? 1 : Math.min(...scores);
  };
  return [...units].sort(
    (a, b) =>
      exposure(a) - exposure(b) ||
      (position.get(a.unit.key) ?? 0) - (position.get(b.unit.key) ?? 0),
  );
}

function orderByDeadline(
  context: LayoutContext,
  scheduled: readonly ScheduledUnit[],
): ScheduledUnit[] {
  const roadPosition = new Map(scheduled.map((entry, index) => [entry.unit.key, index]));
  const unitDeadline = (entry: ScheduledUnit) =>
    Math.min(...entry.members.map((member) => latestStartFor(context, member)));

  return [...scheduled].sort(
    (a, b) =>
      byDeadline(unitDeadline(a), unitDeadline(b)) ||
      (roadPosition.get(a.unit.key) ?? 0) - (roadPosition.get(b.unit.key) ?? 0) ||
      a.unit.key.localeCompare(b.unit.key),
  );
}

function sameOrder(a: readonly ScheduledUnit[], b: readonly ScheduledUnit[]): boolean {
  return a.length === b.length && a.every((entry, index) => entry.unit.key === b[index]!.unit.key);
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
      /**
       * Inside a unit, whatever shuts first goes first — and since almost
       * nothing in this region shuts at all, that is `Infinity` for both sides
       * and the tie-break does the work: the order the unit was built in,
       * nearest the base first, so a shuttle run reads as a route rather than a
       * shuffle. It only reorders when two stops behind one gate genuinely keep
       * different hours, which is exactly when it should.
       */
      members: [...entry.members].sort(
        (a, b) =>
          byDeadline(latestStartFor(context, a), latestStartFor(context, b)) ||
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
  weather?: DayWeatherSummary,
): ItineraryDay {
  const { day, baseId, baseName, profile } = context;
  const intensity = classifyIntensity(layout, profile);
  const warnings: string[] = [];

  if (day.window.usableMinutes === 0) {
    warnings.push('There are no usable hours on this day once travel in or out is accounted for.');
  }
  // The old warning here told the traveller to "have a fallback in mind", which
  // is the product handing back its own job. Weather cautions now live on the
  // day's weather block, next to the concrete fallback the planner found.
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
    availability: summariseAvailability(context, layout),
    weather: weather ?? unknownDayWeather(),
    intensity,
    warnings: [...new Set(warnings)],
  };
}

/**
 * What the day's opening hours did to its shape, read back off the timeline
 * rather than declared alongside it — so it cannot claim something the schedule
 * does not show.
 *
 * The anchor is the point of this. A day holding one place that shuts at four
 * and three that never shut is really "be at the one with a closing time by this
 * hour, and move the rest around it", and saying that is more use than four
 * rows of times for the traveller to compare themselves.
 */
function summariseAvailability(context: LayoutContext, layout: DayLayout): DayAvailability {
  const activities = layout.items.filter((item) => item.kind === 'activity' && item.placeId);

  /**
   * Having hours is not the same as being constrained by them. A day-use site
   * posted 06:00 to 22:00 on a day that runs 07:30 to 19:00 has no bearing on
   * anything, and calling it the day's anchor would bury the one stop that
   * genuinely does decide the shape.
   */
  const binds = (item: (typeof activities)[number]) =>
    item.hours !== undefined &&
    (item.hours.openMinute > context.day.window.startMinute ||
      item.hours.closeMinute < context.day.window.endMinute ||
      item.hours.lastAdmissionMinute !== undefined);

  const constrained = activities.filter(binds);
  const flexiblePlaceIds = activities
    .filter((item) => !binds(item))
    .map((item) => item.placeId!)
    .sort();

  // Tightest closing time wins: that is the one you can actually miss.
  const anchor = [...constrained].sort(
    (a, b) =>
      a.hours!.closeMinute - b.hours!.closeMinute || a.placeId!.localeCompare(b.placeId!),
  )[0];

  const cautions: string[] = [];
  const verifyBeforeTravel: string[] = [];
  const bookings: BookingRequirement[] = [];

  for (const item of activities) {
    if (item.verifyBeforeTravel) verifyBeforeTravel.push(item.verifyBeforeTravel);
    if (item.booking) bookings.push(item.booking);
    const hours = context.hours.get(item.placeId!);
    if (hours?.status === 'unknown') {
      cautions.push(
        `We could not confirm opening hours for ${item.title}. Check before you build the day around it.`,
      );
    }
  }
  for (const violation of layout.violations) {
    if (violation.kind === 'hours') cautions.push(violation.message);
  }

  return {
    ...(anchor?.placeId ? { anchorPlaceId: anchor.placeId } : {}),
    ...(anchor?.hours ? { anchorNote: anchorNoteFor(anchor.title, anchor.hours) } : {}),
    flexiblePlaceIds,
    cautions: [...new Set(cautions)],
    verifyBeforeTravel: [...new Set(verifyBeforeTravel)],
    bookings: [...new Map(bookings.map((entry) => [entry.placeId, entry])).values()].sort((a, b) =>
      a.placeId.localeCompare(b.placeId),
    ),
  };
}

/** Names the edge that actually binds, rather than reciting the whole window. */
function anchorNoteFor(title: string, hours: ScheduledHours): string {
  const opens = `opens at ${formatMinuteOfDay(hours.openMinute)}`;
  const closes = `closes at ${formatMinuteOfDay(hours.closeMinute)}`;
  if (hours.lastAdmissionMinute !== undefined) {
    return `${title} sets the shape of this day: it ${opens}, ${closes}, and stops letting people in at ${formatMinuteOfDay(hours.lastAdmissionMinute)}.`;
  }
  return `${title} sets the shape of this day: it ${opens} and ${closes}.`;
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


/**
 * The weather evidence carried onto a scheduled visit.
 *
 * Only where the weather actually bore on the stop. A clear Tuesday at a place
 * nothing about the weather touches carries nothing at all — the same rule the
 * opening-hours evidence follows, and for the same reason: a badge on every row
 * is a badge nobody reads.
 */
function scheduledWeatherFrom(weather: PlaceDayWeather | undefined): ScheduledWeather | undefined {
  if (!weather) return undefined;
  const { assessment } = weather;
  const worthSaying =
    assessment.suitability === 'poor' ||
    assessment.suitability === 'incompatible' ||
    assessment.suitability === 'favorable' ||
    assessment.suitability === 'unknown';
  if (!worthSaying) return undefined;

  return {
    evidence: assessment.evidence,
    suitability: assessment.suitability,
    summary: assessment.summary,
    reasonCodes: assessment.reasons.map((reason) => reason.code),
    locationId: weather.locationId,
    locationLabel: weather.locationLabel,
    ...(weather.evidence.kind === 'forecast' ? { fetchedAt: weather.evidence.fetchedAt } : {}),
    provider:
      weather.evidence.kind === 'unavailable'
        ? weather.evidence.attemptedProvider
        : weather.evidence.attribution.provider,
  };
}

/**
 * The day-weather block for a day nobody could resolve weather for.
 *
 * Reachable only when a caller builds a day without passing one, which the
 * planner never does. It exists so the shape is total and the honest answer —
 * "we do not know" — is the one that survives, rather than an empty object that
 * a reader would take for a clear day.
 */
function unknownDayWeather(): DayWeatherSummary {
  return {
    evidence: 'unavailable',
    summary: 'We have no weather for this day, so nothing here was placed against it.',
    precipitationProbabilityPercent: null,
    decisions: [],
    cautions: [],
    backups: [],
    provider: 'none',
    attribution: 'No weather source was reached for this trip.',
  };
}
