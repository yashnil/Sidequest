import {
  formatMinuteOfDay,
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

    if (day.totals.travelMinutes > profile.transport.maxDailyTravelMinutes) {
      issues.push({
        code: 'daily_travel_exceeded',
        severity: 'error',
        message: `Day ${day.dayNumber} has ${day.totals.travelMinutes} min of driving, past the ${profile.transport.maxDailyTravelMinutes} min you set.`,
        dayNumber: day.dayNumber,
      });
    }

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
      const last = day.items[day.items.length - 1];
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
      void last;
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
