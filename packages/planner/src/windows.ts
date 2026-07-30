import { parseMinuteOfDay, type DailyWindow, type TravelerProfile, type TripBasics } from '@sidequest/core';
import type { PlannerConfig } from './types';

export interface PlannedDay {
  dayNumber: number;
  date: string;
  window: DailyWindow;
  /** True for the arrival or departure day, which are capped harder. */
  isEdgeDay: boolean;
  /** Activity minutes this day may hold, after meals and the edge-day cap. */
  capacityMinutes: number;
}

/**
 * Enumerates the trip's dates in UTC.
 *
 * Dates here are calendar labels, not instants — stepping in UTC means a trip
 * never gains or loses a day to a timezone offset or a daylight-saving boundary.
 * Clock times live separately as minutes from local midnight.
 */
export function eachDate(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  const cursor = new Date(`${startDate}T00:00:00Z`);
  const last = new Date(`${endDate}T00:00:00Z`);
  if (Number.isNaN(cursor.getTime()) || Number.isNaN(last.getTime())) return dates;

  // Guard against a malformed range producing an unbounded loop.
  let guard = 0;
  while (cursor <= last && guard < 400) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    guard += 1;
  }
  return dates;
}

/**
 * Turns trip dates, arrival and departure times, and the traveller's preferred
 * rhythm into the hours each day actually has.
 *
 * The arrival and departure days are genuinely different days, not full days with
 * a note attached: a 15:00 arrival plus an hour to settle leaves an afternoon, and
 * an 11:00 departure leaves a slow breakfast and nothing else. Getting this wrong
 * is the classic way an itinerary looks fine and cannot be executed.
 */
export function buildDailyWindows(
  basics: TripBasics,
  profile: TravelerProfile,
  config: PlannerConfig,
): PlannedDay[] {
  const dates = eachDate(basics.startDate, basics.endDate);
  const normalStart = config.dayStartByPreference[profile.dayStart];
  const normalEnd = config.dayEndByPace[profile.pace];
  const arrivalMinute = parseMinuteOfDay(basics.arrivalTime);
  const departureMinute = parseMinuteOfDay(basics.departureTime);

  const normalUsable = Math.max(0, normalEnd - normalStart);

  return dates.map((date, index) => {
    const isFirst = index === 0;
    const isLast = index === dates.length - 1;

    let startMinute = normalStart;
    let endMinute = normalEnd;
    const notes: string[] = [];

    if (isFirst) {
      const readyAt = arrivalMinute + config.arrivalSettleMinutes;
      if (readyAt > startMinute) {
        startMinute = readyAt;
        notes.push(`Arriving at ${basics.arrivalTime}, so the day starts after you have landed and settled.`);
      }
    }
    if (isLast) {
      const mustLeaveBy = departureMinute - config.departureLeadMinutes;
      if (mustLeaveBy < endMinute) {
        endMinute = mustLeaveBy;
        notes.push(`Leaving at ${basics.departureTime}, so this day wraps up early.`);
      }
    }

    // A late arrival or an early departure can wipe the day out entirely; that is
    // a real outcome and it should read as zero hours, not as negative time.
    endMinute = Math.max(startMinute, endMinute);
    const usableMinutes = endMinute - startMinute;

    const isEdgeDay = (isFirst || isLast) && dates.length > 1;
    const cap = isEdgeDay
      ? Math.min(usableMinutes, Math.round(normalUsable * config.edgeDayCapacityShare))
      : usableMinutes;

    const window: DailyWindow = {
      startMinute,
      endMinute,
      usableMinutes,
      ...(notes.length > 0 ? { note: notes.join(' ') } : {}),
    };

    return {
      dayNumber: index + 1,
      date,
      window,
      isEdgeDay,
      capacityMinutes: Math.max(0, cap),
    };
  });
}
