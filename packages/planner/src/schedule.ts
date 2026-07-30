import {
  assessSeason,
  formatMinuteOfDay,
  INTEREST_LABELS,
  type Interest,
  type ItineraryDay,
  type ItineraryItem,
  type Place,
  type TravelerProfile,
} from '@sidequest/core';
import { leg, orderStops, type TravelTimeMatrix } from '@sidequest/geo';
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

export interface DayLayout {
  items: ItineraryItem[];
  endMinute: number;
  activityMinutes: number;
  travelMinutes: number;
  travelKm: number;
  freeMinutes: number;
  strenuousCount: number;
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
 * Lays a day out on the clock from an ordered path.
 *
 * The plan is *built* and then measured, rather than estimated and then built —
 * so "does this fit?" is answered by the same code that produces the timeline.
 * An estimate that drifts from the layout is how itineraries end up overlapping
 * their own items.
 */
export function layoutDay(
  context: LayoutContext,
  orderedPath: readonly string[],
  byId: ReadonlyMap<string, PlanningCandidate>,
): DayLayout {
  const { day, baseId, baseName, matrix, config } = context;
  const items: ItineraryItem[] = [];

  let cursor = day.window.startMinute;
  let activityMinutes = 0;
  let travelMinutes = 0;
  let travelKm = 0;
  let strenuousCount = 0;
  let lunchInserted = false;
  const dayIsLongEnough = day.window.usableMinutes >= config.minDayMinutesForLunch;

  const nameFor = (id: string) => (id === baseId ? baseName : byId.get(id)?.place.name ?? id);

  for (let index = 0; index + 1 < orderedPath.length; index += 1) {
    const fromId = orderedPath[index]!;
    const toId = orderedPath[index + 1]!;
    const hop = leg(matrix, fromId, toId);

    if (hop.minutes > 0) {
      // Transition slack rides on the travel block rather than sitting as an
      // invisible gap: parking, boots, and getting going are real minutes.
      const duration = hop.minutes + config.bufferMinutes;
      items.push({
        id: `travel-${day.dayNumber}-${index}`,
        kind: 'travel',
        title: `Drive to ${nameFor(toId)}`,
        startMinute: cursor,
        endMinute: cursor + duration,
        durationMinutes: duration,
        reason: `${hop.minutes} min on the road, plus ${config.bufferMinutes} min to park and get going.`,
        weatherSensitive: false,
        travel: {
          fromId,
          toId,
          fromName: nameFor(fromId),
          toName: nameFor(toId),
          minutes: hop.minutes,
          km: hop.km,
          mode: matrix.mode,
          provenance: matrix.provenance.kind,
        },
      });
      cursor += duration;
      travelMinutes += hop.minutes;
      travelKm += hop.km;
    }

    if (toId === baseId) continue;

    const candidate = byId.get(toId);
    if (!candidate) continue;

    if (!lunchInserted && dayIsLongEnough && cursor >= config.lunchEarliestMinute) {
      items.push(mealItem(day.dayNumber, 'Lunch', cursor, config.lunchMinutes, 'Slotted in before the next stop rather than skipped.'));
      cursor += config.lunchMinutes;
      lunchInserted = true;
    }

    const place = candidate.place;
    const duration = candidate.durationMinutes;
    items.push({
      id: `activity-${day.dayNumber}-${place.id}`,
      kind: 'activity',
      title: place.name,
      startMinute: cursor,
      endMinute: cursor + duration,
      durationMinutes: duration,
      placeId: place.id,
      reason: reasonFor(candidate),
      weatherSensitive: place.weatherSensitivity === 'high',
      physicalIntensity: place.physicalIntensity,
      ...(place.seasonalAccess.note ? { seasonalNote: place.seasonalAccess.note } : {}),
      ...(place.logisticsNote ? { accessWarning: place.logisticsNote } : {}),
    });
    cursor += duration;
    activityMinutes += duration;

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

  // Lunch never found a gap mid-route; give it one now if the clock allows.
  if (!lunchInserted && dayIsLongEnough && cursor + config.lunchMinutes <= day.window.endMinute) {
    items.push(mealItem(day.dayNumber, 'Lunch', cursor, config.lunchMinutes, 'Late, but better than skipping it.'));
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
      items.push(mealItem(day.dayNumber, 'Dinner', cursor, config.dinnerMinutes, 'Back at base, nothing booked.'));
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
    travelMinutes,
    travelKm: Math.round(travelKm * 10) / 10,
    freeMinutes,
    strenuousCount,
  };
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
 * Greedy packing by priority. Each candidate is added, the whole day is re-ordered
 * and re-laid-out, and it is kept only if the result still fits every constraint.
 * Expensive in theory, trivial at a handful of stops a day, and it means a day can
 * never be declared valid on an estimate that the timeline then contradicts.
 */
export interface PackResult {
  accepted: PlanningCandidate[];
  overflow: PlanningCandidate[];
  layout: DayLayout;
  orderedPath: string[];
}

export function packDay(
  context: LayoutContext,
  available: readonly PlanningCandidate[],
  options: { maxActivities: number; maxDailyTravelMinutes: number; maxStrenuous: number },
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
  const { day, baseId, matrix } = context;

  let bestLayout = layoutDay(context, [baseId], new Map());
  let bestPath: string[] = [baseId];

  for (const candidate of available) {
    if (accepted.length >= options.maxActivities) {
      overflow.push(candidate);
      continue;
    }
    if (!isOpenOnDate(candidate.place, day.date)) {
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
    const byId = new Map(tentative.map((item) => [item.place.id, item]));
    const route = orderStops(matrix, {
      startId: baseId,
      endId: baseId,
      stopIds: tentative.map((item) => item.place.id),
    });
    const layout = layoutDay({ ...context, day }, route.path, byId);

    const fitsClock = layout.endMinute <= day.window.endMinute;
    const fitsCapacity = layout.activityMinutes + layout.travelMinutes <= day.capacityMinutes;
    const fitsDriving = layout.travelMinutes <= options.maxDailyTravelMinutes;
    const requiredFree = tentative.length >= SLACK_APPLIES_FROM_STOP ? slackFloor : 0;
    const keepsSlack = layout.freeMinutes >= requiredFree;

    if (fitsClock && fitsCapacity && fitsDriving && keepsSlack) {
      accepted.push(candidate);
      bestLayout = layout;
      bestPath = route.path;
    } else {
      overflow.push(candidate);
    }
  }

  return { accepted, overflow, layout: bestLayout, orderedPath: bestPath };
}

export function buildDay(
  context: LayoutContext,
  accepted: readonly PlanningCandidate[],
  layout: DayLayout,
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
      travelKm: layout.travelKm,
      freeMinutes: layout.freeMinutes,
      strenuousCount: layout.strenuousCount,
    },
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
