/**
 * ONE DATE FORMATTER, BECAUSE THERE WERE NONE.
 *
 * Every customer-facing surface printed the stored string: `2026-10-12 →
 * 2026-10-18` on the homepage, in the trip context bar, in the composer's
 * summary. That is the database's format, chosen so dates sort as text, and a
 * traveller reading their own trip should never have to parse it.
 *
 * Two rules this module exists to hold, both of which have already been broken
 * elsewhere in the product:
 *
 * **No `Date` parsing of a calendar date.** `new Date('2026-10-12')` is parsed
 * as midnight UTC and then rendered in the *reader's* zone, so a traveller west
 * of Greenwich sees the day before — the trip that starts on the 12th is
 * announced as starting on the 11th. The parts are read as text and never
 * become an instant.
 *
 * **A string we cannot read comes back unchanged.** A row written by an older
 * build, or hand-edited, must not render as `Invalid Date` or `NaN`. The raw
 * value is at least true.
 */

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

/**
 * The three numbers in an ISO calendar date, or nothing.
 *
 * Deliberately strict about the shape rather than lenient: `Date.parse` accepts
 * a great many strings and answers with an instant, and an instant is the one
 * thing a calendar date must not become here.
 */
function readCalendarDate(value: string): CalendarDate | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year, month, day };
}

/** `Oct 12, 2026`. The stored string back, unchanged, if it will not read. */
export function formatDay(iso: string): string {
  const date = readCalendarDate(iso);
  if (!date) return iso;
  return `${MONTHS[date.month - 1]} ${date.day}, ${date.year}`;
}

/** `Oct 12` — the day without its year, for use beside a year stated once. */
function formatDayInYear(date: CalendarDate): string {
  return `${MONTHS[date.month - 1]} ${date.day}`;
}

/**
 * `Oct 12–18, 2026`, and the three other shapes a range can take.
 *
 * The year appears once when both ends share it, twice when they do not, and
 * the month is repeated only when it changes. This is the ordinary way a person
 * writes a date range, and the reason it is worth the branching is that the
 * alternative — printing both ends in full every time — reads as machine output
 * on the surface a traveller scans fastest.
 */
export function formatDayRange(startIso: string, endIso: string): string {
  const start = readCalendarDate(startIso);
  const end = readCalendarDate(endIso);
  if (!start || !end) return `${formatDay(startIso)} – ${formatDay(endIso)}`;

  if (start.year === end.year && start.month === end.month && start.day === end.day) {
    return formatDay(startIso);
  }
  if (start.year !== end.year) {
    return `${formatDay(startIso)} – ${formatDay(endIso)}`;
  }
  if (start.month !== end.month) {
    return `${formatDayInYear(start)} – ${formatDayInYear(end)}, ${start.year}`;
  }
  return `${formatDayInYear(start)}–${end.day}, ${start.year}`;
}

/** `October 2026`, for a month somebody named rather than a date they picked. */
const LONG_MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

export function formatMonthName(month: number): string {
  return LONG_MONTHS[month - 1] ?? String(month);
}
