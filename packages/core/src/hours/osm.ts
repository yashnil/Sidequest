import type { OperatingPeriod, OpeningWindow } from '../schemas/hours';

/** 0 = Sunday, matching `dayOfWeekSchema`. */
type DayOfWeek = 0 | 1 | 2 | 3 | 4 | 5 | 6;
type MonthNumber = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12;

/**
 * A CONSERVATIVE READER FOR THE `opening_hours` GRAMMAR.
 *
 * OpenStreetMap's `opening_hours` is a real specification with a real grammar,
 * and a complete implementation of it is a library in its own right. This is not
 * that. It reads the shapes that make up the overwhelming majority of real
 * values — `24/7`, `Mo-Fr 09:00-17:00`, `Mo-Sa 10:00-14:00,15:00-18:00`,
 * `Apr-Oct Mo-Su 08:00-20:00`, with `; PH off` and `; Su off` tails — and it
 * **refuses everything else**.
 *
 * Refusing is the important half. A partially-understood opening-hours
 * expression is worse than none: `Mo-Fr 09:00-17:00; Sa["by appointment"]` read
 * as "weekdays nine to five" quietly deletes a Saturday rule, and the traveller
 * finds out at the door. So anything containing a construct this parser does not
 * fully model — comments, `open`/`unknown`, week selectors, `sunrise`/`sunset`,
 * ordinal weekdays, date ranges with days of month — returns `null`, and `null`
 * becomes an `unknown` calendar rather than a guess.
 *
 * Pure, offline, and destination-agnostic: it is a grammar, not a place.
 */

export interface ParsedOsmHours {
  kind: 'always_open' | 'scheduled';
  periods: OperatingPeriod[];
  /** Days the expression explicitly closes, e.g. from a `Su off` tail. */
  closedNote?: string;
}

const DAY_INDEX: Record<string, DayOfWeek> = {
  su: 0,
  mo: 1,
  tu: 2,
  we: 3,
  th: 4,
  fr: 5,
  sa: 6,
};

const MONTH_INDEX: Record<string, MonthNumber> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

const ALL_MONTHS: MonthNumber[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

/**
 * Constructs this parser does not model. Their presence anywhere in the value
 * refuses the whole expression rather than the clause that contains them.
 */
const UNSUPPORTED = /(sunrise|sunset|dusk|dawn|week\s|\[|"|open\b|unknown\b|=>|\|\||easter)/i;

export function parseOsmOpeningHours(raw: string): ParsedOsmHours | null {
  const value = raw.trim();
  if (value.length === 0 || value.length > 200) return null;
  if (UNSUPPORTED.test(value)) return null;

  if (/^24\/7$/i.test(value)) return { kind: 'always_open', periods: [] };

  const clauses = value
    .split(';')
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0);
  if (clauses.length === 0 || clauses.length > 6) return null;

  const periods: OperatingPeriod[] = [];
  const closedLabels: string[] = [];

  for (const clause of clauses) {
    if (/\boff\b/i.test(clause) || /\bclosed\b/i.test(clause)) {
      // "PH off", "Su off" — recorded as prose, never silently dropped and never
      // turned into a rule this model cannot express.
      closedLabels.push(clause.replace(/\s+/g, ' '));
      continue;
    }
    const period = parseClause(clause);
    if (!period) return null;
    periods.push(period);
  }

  if (periods.length === 0) return null;

  /**
   * Two clauses covering the same weekday in the same months would produce a
   * calendar where a day has two schedules, and the planner would take the
   * first. Rather than pick, refuse.
   */
  if (hasOverlap(periods)) return null;

  return {
    kind: 'scheduled',
    periods,
    ...(closedLabels.length > 0
      ? { closedNote: `The source also states: ${closedLabels.join('; ')}.` }
      : {}),
  };
}

function parseClause(clause: string): OperatingPeriod | null {
  const parts = clause.split(/\s+/).filter((part) => part.length > 0);
  if (parts.length === 0) return null;

  let months: MonthNumber[] = ALL_MONTHS;
  let days: DayOfWeek[] | undefined;
  const timeTokens: string[] = [];
  let sawMonths = false;
  let sawDays = false;

  for (const part of parts) {
    if (/^\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}(,\d{1,2}:\d{2}-\d{1,2}:\d{2})*$/.test(part)) {
      timeTokens.push(part);
      continue;
    }
    const monthRange = parseMonthToken(part);
    if (monthRange) {
      if (sawMonths) return null;
      months = monthRange;
      sawMonths = true;
      continue;
    }
    const dayRange = parseDayToken(part);
    if (dayRange) {
      if (sawDays) return null;
      days = dayRange;
      sawDays = true;
      continue;
    }
    return null;
  }

  if (timeTokens.length === 0) return null;

  const windows: OpeningWindow[] = [];
  for (const token of timeTokens.join(',').split(',')) {
    const window = parseWindow(token);
    if (!window) return null;
    windows.push(window);
  }
  if (windows.length === 0 || windows.length > 4) return null;

  return {
    label: labelFor(months, days),
    months,
    ...(days ? { daysOfWeek: days } : {}),
    windows,
  };
}

function parseWindow(token: string): OpeningWindow | null {
  const match = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(token.trim());
  if (!match) return null;
  const openMinute = Number(match[1]) * 60 + Number(match[2]);
  const closeMinuteRaw = Number(match[3]) * 60 + Number(match[4]);
  // `24:00` is a legal closing time in the grammar and means midnight.
  const closeMinute = closeMinuteRaw === 0 ? 1440 : closeMinuteRaw;
  if (openMinute < 0 || openMinute > 1439) return null;
  if (closeMinute <= openMinute || closeMinute > 1440) return null;
  return { openMinute, closeMinute };
}

function parseDayToken(token: string): DayOfWeek[] | null {
  const cleaned = token.replace(/,$/, '');
  const groups = cleaned.split(',');
  const days = new Set<DayOfWeek>();
  for (const group of groups) {
    const range = /^([A-Za-z]{2})(?:-([A-Za-z]{2}))?$/.exec(group.trim());
    if (!range) return null;
    const from = DAY_INDEX[range[1]!.toLowerCase()];
    if (from === undefined) return null;
    if (range[2] === undefined) {
      days.add(from);
      continue;
    }
    const to = DAY_INDEX[range[2].toLowerCase()];
    if (to === undefined) return null;
    // Wrapping ranges (`Fr-Mo`) are legal in the grammar and are handled by
    // walking forward with a modulus rather than by assuming from <= to.
    for (let step = 0; step < 7; step += 1) {
      const day = ((from + step) % 7) as DayOfWeek;
      days.add(day);
      if (day === to) break;
    }
  }
  return days.size > 0 ? [...days].sort((a, b) => a - b) : null;
}

function parseMonthToken(token: string): MonthNumber[] | null {
  const range = /^([A-Za-z]{3})(?:-([A-Za-z]{3}))?$/.exec(token.replace(/,$/, '').trim());
  if (!range) return null;
  const from = MONTH_INDEX[range[1]!.toLowerCase()];
  if (from === undefined) return null;
  if (range[2] === undefined) return [from];
  const to = MONTH_INDEX[range[2].toLowerCase()];
  if (to === undefined) return null;
  const months: MonthNumber[] = [];
  for (let step = 0; step < 12; step += 1) {
    const month = (((from - 1 + step) % 12) + 1) as MonthNumber;
    months.push(month);
    if (month === to) break;
  }
  return months;
}

function labelFor(months: readonly MonthNumber[], days: readonly DayOfWeek[] | undefined): string {
  const seasonal = months.length < 12 ? 'Seasonal' : 'Year-round';
  if (!days || days.length === 7) return `${seasonal} hours`;
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return `${seasonal}, ${days.map((day) => names[day]).join('/')}`;
}

function hasOverlap(periods: readonly OperatingPeriod[]): boolean {
  for (let i = 0; i < periods.length; i += 1) {
    for (let j = i + 1; j < periods.length; j += 1) {
      const a = periods[i]!;
      const b = periods[j]!;
      const monthsOverlap = a.months.some((month) => b.months.includes(month));
      if (!monthsOverlap) continue;
      const aDays = a.daysOfWeek ?? [0, 1, 2, 3, 4, 5, 6];
      const bDays = b.daysOfWeek ?? [0, 1, 2, 3, 4, 5, 6];
      if (aDays.some((day) => bDays.includes(day))) return true;
    }
  }
  return false;
}
