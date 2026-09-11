/**
 * V8 — WHAT ASK SIDEQUEST SAYS ABOUT A CHANGE, IN THE TRAVELLER'S ORDER.
 *
 * The refinement graph reports a change as flat lists of sentences — changed,
 * kept, rechecking, refused. Nothing here rewrites a sentence: the lines are
 * grouped by the day they name so "Day 3: fewer stops" and "Day 3: the big
 * walk kept" sit under one heading, and lines about the whole trip lead.
 */
export interface DayLines {
  /** Null for lines about the trip as a whole. */
  day: number | null;
  lines: string[];
}

const DAY_PREFIX = /^day\s+(\d+)\s*[:—–-]?\s*/i;

export function groupByDay(lines: readonly string[]): DayLines[] {
  const whole: string[] = [];
  const byDay = new Map<number, string[]>();
  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const match = DAY_PREFIX.exec(line);
    if (!match) {
      whole.push(line);
      continue;
    }
    const day = Number(match[1]);
    const rest = line.slice(match[0].length).trim();
    const text = rest.length > 0 ? rest.charAt(0).toUpperCase() + rest.slice(1) : line;
    const bucket = byDay.get(day) ?? [];
    bucket.push(text);
    byDay.set(day, bucket);
  }
  const days = [...byDay.entries()].sort((a, b) => a[0] - b[0]).map(([day, entries]) => ({ day, lines: entries }));
  return whole.length > 0 ? [{ day: null, lines: whole }, ...days] : days;
}

/**
 * The example prompts, phrased as a traveller would say them. Where the trip's
 * own facts are known they are used; where they are not, the examples name no
 * day and no place rather than invent one.
 */
export function suggestionsFor(trip: { dayCount?: number; baseNames?: readonly string[] } = {}): string[] {
  const middle = trip.dayCount && trip.dayCount > 0 ? Math.max(1, Math.ceil(trip.dayCount / 2)) : null;
  const base = trip.baseNames?.find((name) => name.trim().length > 0);
  return [
    'Make this less rushed',
    middle !== null ? `Give me a harder day ${middle}` : 'Give me a harder day',
    'Keep the big walk but reduce the driving',
    base ? `Find a more interesting place to stay in ${base}` : 'Find a more interesting place to stay',
    'Make this trip more food-focused',
    'Why did you put this here?',
  ];
}
