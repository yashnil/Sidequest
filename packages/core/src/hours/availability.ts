import { dayOfWeekFor, monthDayFor, monthFor } from '../schemas/calendar';
import { formatMinuteOfDay } from '../schemas/common';
import type {
  AdmissionRequirement,
  OperatingCalendar,
  OperatingPeriod,
} from '../schemas/hours';
import type { SourceProvenance } from '../schemas/provenance';

/**
 * Resolving a recurring operating calendar against real dates.
 *
 * This layer knows about the clock but nothing about the traveller's day. It
 * answers "what hours is this place open on 14 August?" — whether those hours
 * intersect the shuttle window and leave room for a three-hour visit is the
 * planner's question, because only the planner knows what else is on the day.
 *
 * Nothing here mutates a calendar. A `Place` and its `OperatingCalendar` are
 * source facts; everything computed for a specific trip is a separate value.
 */

/** One opening window resolved onto a date. Closed interval, minutes from midnight. */
export interface OpeningWindowOnDate {
  openMinute: number;
  closeMinute: number;
  /** Published last entry, or null when the operator publishes none. */
  lastAdmissionMinute: number | null;
}

export const CLOSED_REASONS = ['out_of_season', 'closed_weekday', 'closed_date'] as const;
export type ClosedReason = (typeof CLOSED_REASONS)[number];

export const CLOSED_REASON_COPY: Record<ClosedReason, string> = {
  out_of_season: 'closed for the season',
  closed_weekday: 'closed that day of the week',
  closed_date: 'closed on that date every year',
};

export type DateOperatingStatus = 'always_open' | 'open' | 'closed' | 'unknown';

export interface DateOperating {
  date: string;
  status: DateOperatingStatus;
  /** Non-empty only when `status === 'open'`. Sorted, non-overlapping. */
  windows: OpeningWindowOnDate[];
  /** Which recurring period produced these hours, for the explanation. */
  periodLabel: string | null;
  closedReason: ClosedReason | null;
}

/**
 * Hours on one date.
 *
 * A place with no matching period is closed, not unknown — the calendar claims
 * to be complete, and "we listed summer and winter and your date is neither" is
 * a statement that it is shut, which is exactly right for a seasonal attraction.
 */
export function operatingOn(calendar: OperatingCalendar, date: string): DateOperating {
  if (calendar.kind === 'always_open') {
    return { date, status: 'always_open', windows: [], periodLabel: null, closedReason: null };
  }
  if (calendar.kind === 'unknown') {
    return { date, status: 'unknown', windows: [], periodLabel: null, closedReason: null };
  }

  // Throws on a date that is not a real day, in one place, before any rule runs.
  const monthDay = monthDayFor(date);
  if (calendar.closedAnnualDates.includes(monthDay)) {
    return { date, status: 'closed', windows: [], periodLabel: null, closedReason: 'closed_date' };
  }

  const month = monthFor(date);
  const weekday = dayOfWeekFor(date);
  const inMonth = calendar.periods.filter((period) => period.months.includes(month));
  if (inMonth.length === 0) {
    return {
      date,
      status: 'closed',
      windows: [],
      periodLabel: null,
      closedReason: 'out_of_season',
    };
  }

  const period = inMonth.find((entry) => !entry.daysOfWeek || entry.daysOfWeek.includes(weekday));
  if (!period) {
    return {
      date,
      status: 'closed',
      windows: [],
      periodLabel: inMonth[0]!.label,
      closedReason: 'closed_weekday',
    };
  }

  return {
    date,
    status: 'open',
    windows: windowsOf(period),
    periodLabel: period.label,
    closedReason: null,
  };
}

function windowsOf(period: OperatingPeriod): OpeningWindowOnDate[] {
  return [...period.windows]
    .sort((a, b) => a.openMinute - b.openMinute)
    .map((window) => ({
      openMinute: window.openMinute,
      closeMinute: window.closeMinute,
      lastAdmissionMinute: window.lastAdmissionMinute ?? null,
    }));
}

// ---------------------------------------------------------------------------
// Across a whole trip
// ---------------------------------------------------------------------------

export const OPERATING_TRIP_STATUSES = [
  'always_open',
  'open_every_day',
  'open_some_days',
  'closed_throughout',
  'unknown',
] as const;
export type OperatingTripStatus = (typeof OPERATING_TRIP_STATUSES)[number];

export const OPERATING_BADGES = [
  'limited_hours',
  'closed_some_days',
  'closed_on_your_dates',
  'last_admission',
  'reservation_required',
  'timed_entry',
  'admission_permit',
  'hours_unknown',
  'verify_hours',
  'daylight_only',
] as const;
export type OperatingBadge = (typeof OPERATING_BADGES)[number];

export const OPERATING_BADGE_LABELS: Record<OperatingBadge, string> = {
  limited_hours: 'Limited hours',
  closed_some_days: 'Shut some of your days',
  closed_on_your_dates: 'Closed on your dates',
  last_admission: 'Last entry',
  reservation_required: 'Booking needed',
  timed_entry: 'Timed entry',
  admission_permit: 'Entry permit',
  hours_unknown: 'Hours unconfirmed',
  verify_hours: 'Recheck hours',
  daylight_only: 'Daylight only',
};

/**
 * Said the same way everywhere, and deliberately admits the gap rather than
 * implying a check nobody performed.
 */
export const DAYLIGHT_ONLY_CAUTION =
  'Signed for daylight use only. We do not work out sunrise and sunset yet, so check how much light your dates give you.';

export interface OperatingAssessment {
  placeId: string;
  status: OperatingTripStatus;
  byDate: DateOperating[];
  /** Trip dates on which the place is open at all. */
  openDates: string[];
  /**
   * The hours the traveller actually needs, not the annual timetable — "09:00
   * to 18:00" when every trip day is the same, and the distinct windows when
   * they differ. Null when there is nothing useful to state.
   */
  hoursSummary: string | null;
  /** Set only when the operator publishes a last entry that applies on a trip date. */
  lastAdmissionSummary: string | null;
  admission: AdmissionRequirement;
  /** Usable only between sunrise and sunset, which the planner cannot yet compute. */
  daylightOnly: boolean;
  /** True when the plan must tell the traveller to confirm before travelling. */
  requiresVerification: boolean;
  verifyNote: string | null;
  badges: OperatingBadge[];
  cautions: string[];
  provenance: SourceProvenance;
}

export interface AssessOperatingInput {
  calendar: OperatingCalendar;
  /** Every date of the trip, as `YYYY-MM-DD`. */
  dates: readonly string[];
}

export function assessOperatingHours(input: AssessOperatingInput): OperatingAssessment {
  const { calendar, dates } = input;
  const byDate = dates.map((date) => operatingOn(calendar, date));
  const openDates = byDate
    .filter((entry) => entry.status === 'open' || entry.status === 'always_open')
    .map((entry) => entry.date);

  const status = tripStatus(calendar.kind, byDate, openDates.length);
  const scheduled = byDate.filter((entry) => entry.status === 'open');

  const badges: OperatingBadge[] = [];
  const cautions: string[] = [];

  if (status === 'closed_throughout') badges.push('closed_on_your_dates');
  else if (status === 'open_some_days' && scheduled.length > 0) badges.push('closed_some_days');
  if (scheduled.length > 0 && narrowestWindow(scheduled) < LIMITED_HOURS_THRESHOLD) {
    badges.push('limited_hours');
  }

  const lastAdmission = tightestLastAdmission(scheduled);
  if (lastAdmission !== null) badges.push('last_admission');

  if (calendar.admission.timedEntry) badges.push('timed_entry');
  else if (calendar.admission.reservationRequired) badges.push('reservation_required');
  if (calendar.admission.permitRequired) badges.push('admission_permit');
  if (calendar.kind === 'unknown') badges.push('hours_unknown');
  if (calendar.daylightOnly) {
    badges.push('daylight_only');
    cautions.push(DAYLIGHT_ONLY_CAUTION);
  }

  /**
   * A recheck note is, by definition, an instruction to the traveller. Keying
   * this off `volatility === 'dynamic'` alone would swallow the notes on
   * seasonally recurring facts — "Bodie closes early in bad weather and the
   * highway can stay under snow into May" is exactly the sentence somebody
   * needs before an eighty-minute drive.
   */
  const needsRecheck = calendar.provenance.recheckNote !== undefined || calendar.kind === 'unknown';
  if (needsRecheck) badges.push('verify_hours');

  // "Open 24 hours a day, no fee" is reassurance, not a caution, and filing it
  // under "worth knowing" alongside the things that can ruin a day devalues the
  // list. Only a place with a schedule, or none we could confirm, has a note
  // worth flagging.
  if (calendar.note && calendar.kind !== 'always_open') cautions.push(calendar.note);
  if (calendar.admission.note) cautions.push(calendar.admission.note);
  if (calendar.admission.capacityLimited) {
    cautions.push('Entry is capped, so arriving does not guarantee getting in.');
  }
  if (!calendar.admission.walkInAllowed) {
    cautions.push('There is no walk-up entry — this has to be arranged in advance.');
  }
  const closedWeekdays = byDate.filter((entry) => entry.closedReason === 'closed_weekday');
  if (closedWeekdays.length > 0) {
    cautions.push(
      `Shut on ${listDates(closedWeekdays.map((entry) => entry.date))} — those are its closed days.`,
    );
  }

  const verifyNote =
    calendar.provenance.recheckNote ??
    (calendar.kind === 'unknown'
      ? 'We have no confirmed opening hours for this. Check with the operator before you build a day around it.'
      : null);

  return {
    placeId: calendar.placeId,
    status,
    byDate,
    openDates,
    hoursSummary: summariseHours(scheduled),
    lastAdmissionSummary:
      lastAdmission === null ? null : `Last entry ${formatMinuteOfDay(lastAdmission)}`,
    admission: calendar.admission,
    daylightOnly: calendar.daylightOnly,
    requiresVerification: needsRecheck,
    verifyNote,
    badges,
    cautions: [...new Set(cautions)],
    provenance: calendar.provenance,
  };
}

function tripStatus(
  kind: OperatingCalendar['kind'],
  byDate: readonly DateOperating[],
  openCount: number,
): OperatingTripStatus {
  if (kind === 'always_open') return 'always_open';
  if (kind === 'unknown') return 'unknown';
  if (byDate.length === 0 || openCount === 0) return 'closed_throughout';
  return openCount === byDate.length ? 'open_every_day' : 'open_some_days';
}

/**
 * Below this many minutes a day, opening hours are a constraint worth a badge.
 *
 * Twelve hours, because that is longer than any usable trip day this planner
 * builds — so a window wider than it cannot bind, and saying "limited hours"
 * about it is false. The Forest Service posts several sites here as day use
 * 06:00 to 22:00; badging a sixteen-hour window as limited put a caution on
 * three cards where the hours can never matter, and a badge that fires when
 * nothing is wrong is a badge people learn to skip on the card where it is.
 */
const LIMITED_HOURS_THRESHOLD = 12 * 60;

function narrowestWindow(entries: readonly DateOperating[]): number {
  const spans = entries.flatMap((entry) =>
    entry.windows.map((window) => window.closeMinute - window.openMinute),
  );
  return spans.length === 0 ? 0 : Math.min(...spans);
}

function tightestLastAdmission(entries: readonly DateOperating[]): number | null {
  const values = entries.flatMap((entry) =>
    entry.windows
      .map((window) => window.lastAdmissionMinute)
      .filter((minute): minute is number => minute !== null),
  );
  return values.length === 0 ? null : Math.min(...values);
}

/**
 * The hours that apply on this trip, not the whole year's timetable. One line
 * when every open day is the same, up to two distinct lines when they differ,
 * and a plain count beyond that — a card is not a spreadsheet.
 */
function summariseHours(entries: readonly DateOperating[]): string | null {
  if (entries.length === 0) return null;
  const shapes = [
    ...new Set(
      entries.map((entry) =>
        entry.windows
          .map((window) => `${formatMinuteOfDay(window.openMinute)}–${formatMinuteOfDay(window.closeMinute)}`)
          .join(' and '),
      ),
    ),
  ].sort();
  if (shapes.length === 1) return shapes[0]!;
  if (shapes.length === 2) return shapes.join(' · ');
  return `${shapes.length} different schedules across your dates`;
}

function listDates(dates: readonly string[]): string {
  if (dates.length <= 2) return dates.join(' and ');
  return `${dates.slice(0, 2).join(', ')} and ${dates.length - 2} more`;
}
