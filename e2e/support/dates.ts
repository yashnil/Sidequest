/**
 * TRIP DATES THAT KEEP THEIR MEANING AS THE CALENDAR MOVES.
 *
 * Every date a spec types used to be a literal, and a literal is a statement
 * about the day it was written. `2026-08-12` was "a summer trip a few weeks
 * out" in July 2026; by November it was a trip three months in the past, and
 * the suite was quietly testing a memory instead of a plan. `2026-11-10` was
 * "safely ahead of the clock" until the week it arrived.
 *
 * So a spec says what it needs and this module finds dates with that property
 * today, and again tomorrow:
 *
 * - **A season** (`seasonalTrip`): the next occurrence of a calendar date at
 *   least a month away. The Mammoth Lakes fixture is seasonal — Minaret Vista,
 *   Reds Meadow and the gondola are open June to October — so a spec that
 *   expects those places on its board must choose summer, explicitly, rather
 *   than inherit whatever month the suite happens to run in.
 * - **A weekday-shaped span** (`seasonalTripFrom` with `weekday`): the same,
 *   aligned to a weekday, for the opening-hours specs whose subject is which
 *   days of the week a place opens.
 * - **The forecast horizon** (`forecastTrip`): dates a few days from now, which
 *   is the only place a forecast exists. The weather provider reads the real
 *   clock, so these follow it.
 * - **Beyond any forecast** (`beyondForecastTrip`): more than a year out, where
 *   only historical patterns are honest evidence.
 *
 * Everything is computed in UTC on calendar dates (`YYYY-MM-DD`), which is the
 * shape the composer's date inputs take.
 *
 * Fixed dates still exist where a fixed clock is part of the test:
 * `FIXTURE_CLOCK_TRIP` belongs to `playwright.today.config.ts`, whose server
 * pins `SIDEQUEST_FIXTURE_NOW` inside that span.
 */

export interface TripDates {
  start: string;
  end: string;
}

const DAY_MS = 86_400_000;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
const MONTHS_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

/** The lead a "seasonal" trip keeps from today, so it is always a plan in the future and never inside the forecast horizon. */
export const SEASONAL_LEAD_DAYS = 30;
/**
 * How far ahead the fixture weather provider forecasts. Mirrors
 * `isInsideForecastHorizon` in `packages/core/src/time/zone.ts`; specs stay
 * well inside it so a slow run crossing midnight cannot push a day out.
 */
export const FORECAST_HORIZON_DAYS = 16;

function parse(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`);
}

export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Today's calendar date in UTC — the runner and the server share a machine and a clock. */
export function todayIso(): string {
  return isoDate(new Date());
}

export function addDays(iso: string, days: number): string {
  return isoDate(new Date(parse(iso).getTime() + days * DAY_MS));
}

/** A span of `days` calendar days (inclusive) starting on `start`. */
export function span(start: string, days: number): TripDates {
  if (!Number.isInteger(days) || days < 1) throw new Error(`A trip needs at least one day, got ${days}.`);
  return { start, end: addDays(start, days - 1) };
}

export interface SeasonalOptions {
  /** 1–12. */
  month: number;
  day: number;
  /** Inclusive length in days. */
  days: number;
  /** 0 = Sunday … 6 = Saturday: move the start forward to the first such weekday on or after `month`/`day`. */
  weekday?: number;
  /** Minimum days between today and the start. */
  minLeadDays?: number;
}

/**
 * The next `month`/`day` (optionally moved to a weekday) at least
 * `minLeadDays` from today. Deterministic for a given date, and always in the
 * requested season.
 */
export function seasonalTrip(options: SeasonalOptions): TripDates {
  const lead = options.minLeadDays ?? SEASONAL_LEAD_DAYS;
  const earliest = addDays(todayIso(), lead);
  const thisYear = new Date().getUTCFullYear();
  for (let year = thisYear; year <= thisYear + 2; year += 1) {
    let start = isoDate(new Date(Date.UTC(year, options.month - 1, options.day)));
    if (options.weekday !== undefined) {
      const shift = (options.weekday - parse(start).getUTCDay() + 7) % 7;
      start = addDays(start, shift);
    }
    if (start >= earliest) return span(start, options.days);
  }
  throw new Error('No seasonal date found within two years — the lead is longer than a year?');
}

/** A summer trip at Mammoth Lakes: mid-August, when every seasonal place in the fixture is open. */
export function summerTrip(days: number): TripDates {
  return seasonalTrip({ month: 8, day: 12, days });
}

/**
 * A trip inside the forecast horizon: starting `leadDays` from today. Note what
 * this cannot promise: the *season* is whatever month it is, so a spec using it
 * must not expect a seasonal place to be open.
 */
export function forecastTrip(days: number, leadDays = 2): TripDates {
  if (leadDays < 1 || leadDays + days - 1 > FORECAST_HORIZON_DAYS - 4) {
    throw new Error(`A forecast trip must sit well inside the ${FORECAST_HORIZON_DAYS}-day horizon.`);
  }
  return span(addDays(todayIso(), leadDays), days);
}

/** More than a year out: no forecast reaches it, so the only evidence is what past years did. */
export function beyondForecastTrip(days: number): TripDates {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear() + 1, now.getUTCMonth(), now.getUTCDate() + 40));
  return span(isoDate(start), days);
}

/** "Wed 12 Aug" — the day-heading form the itinerary renders. */
export function dayLabel(iso: string): string {
  const date = parse(iso);
  return `${WEEKDAYS[date.getUTCDay()]} ${date.getUTCDate()} ${MONTHS_SHORT[date.getUTCMonth()]}`;
}

/** "13 August 2027" — the form a booking confirmation writes. */
export function longDate(iso: string): string {
  const date = parse(iso);
  return `${date.getUTCDate()} ${MONTHS_LONG[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/**
 * The fixed trip the fixture-clock config is built around.
 * `playwright.today.config.ts` starts its server with
 * `SIDEQUEST_FIXTURE_NOW=2026-08-13T17:30:00Z`, which is day two of this span;
 * change one and the other must move with it.
 */
export const FIXTURE_CLOCK_TRIP: TripDates = { start: '2026-08-12', end: '2026-08-16' };
