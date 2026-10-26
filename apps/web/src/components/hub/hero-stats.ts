import type { ItineraryDay } from '@sidequest/core';

/**
 * THE COVER'S GLANCEABLE FACTS.
 *
 * The hero used to carry the trip's shape as one long sentence ("A car: stops
 * sit up to 31 minutes from where you sleep, and a typical day has about 67
 * minutes of driving against your 150-minute limit"). The sentence is honest
 * and stays on the page (the Trip view's Getting around card prints it); the
 * cover now reads the same facts as tiles a first-time traveller can take in at
 * a glance — days, stops, where you sleep, a typical day's travel against the
 * limit, who is going.
 *
 * Pure: a function of the stored plan. Two honesty rules from CLAUDE.md:
 *
 * - **Unknown travel time is never zero.** A day with unmeasured legs makes its
 *   total a floor, so the tile says "at least" and names the gap; a trip whose
 *   travel nobody could time says "Not measured", never "0 min".
 * - **The plan's own figures win.** When the transport headline states a
 *   typical day and a limit (the planner writes both), the tile repeats those
 *   numbers rather than computing a second opinion that could disagree with the
 *   sentence printed a scroll below it.
 */
export interface HeroStat {
  id: 'days' | 'stops' | 'sleep' | 'travel' | 'party';
  label: string;
  value: string;
  /** A second short line under the value. */
  sub?: string;
  /** The honest long form, for a hover title and assistive technology. */
  detail?: string;
  /** 0–1: how much of the limit a typical day uses, when both are known. */
  gauge?: number;
}

export interface HeroStatsInput {
  days: readonly Pick<ItineraryDay, 'totals'>[];
  stopCount: number;
  baseCount: number;
  nights: number;
  travellers: number | null;
  withChildren?: boolean;
  primaryMode?: string | null;
  transportHeadline?: string | null;
}

function modeWord(mode: string | null | undefined): string {
  if (mode === 'drive') return 'driving';
  if (mode === 'walk') return 'walking';
  return 'travel';
}

/** The planner's own figures, when its sentence states them. */
export function headlineFigures(headline: string | null | undefined): { typical: number | null; limit: number | null } {
  if (!headline) return { typical: null, limit: null };
  const typical = /typical day has about (\d+) minutes/i.exec(headline);
  const limit = /against your (\d+)-minute limit/i.exec(headline);
  return { typical: typical ? Number(typical[1]) : null, limit: limit ? Number(limit[1]) : null };
}

/** "67 min", "150 min", "3 h 10 min" — minutes stay minutes up to three hours, where they read faster. */
export function shortMinutes(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m < 180) return `${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest === 0 ? `${h} h` : `${h} h ${rest} min`;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

export function heroStats(input: HeroStatsInput): HeroStat[] {
  const stats: HeroStat[] = [];
  const dayCount = input.days.length;
  stats.push({ id: 'days', label: 'Days', value: String(dayCount) });
  stats.push({ id: 'stops', label: 'Stops', value: String(input.stopCount) });
  if (input.baseCount > 0) {
    stats.push({
      id: 'sleep',
      label: input.baseCount === 1 ? 'Base' : 'Bases',
      value: String(input.baseCount),
      ...(input.nights > 0 ? { sub: `${input.nights} ${input.nights === 1 ? 'night' : 'nights'}` } : {}),
    });
  }

  const word = modeWord(input.primaryMode);
  const unmeasuredDays = input.days.filter((day) => day.totals.unmeasuredLegCount > 0 || day.totals.unmeasuredMajorTransfer).length;
  const travelDays = input.days.map((day) => day.totals.travelMinutes).filter((minutes) => minutes > 0);
  const stated = headlineFigures(input.transportHeadline);
  const typical = stated.typical ?? (travelDays.length > 0 ? median(travelDays) : null);
  const limitSub = stated.limit ? `${word} · your limit ${shortMinutes(stated.limit)}` : word;
  if (typical !== null && typical > 0) {
    const floor = unmeasuredDays > 0 && stated.typical === null;
    stats.push({
      id: 'travel',
      label: 'Typical day',
      value: `${floor ? '≥ ' : '≈ '}${shortMinutes(typical)}`,
      sub: limitSub,
      ...(input.transportHeadline ? { detail: input.transportHeadline } : {}),
      ...(stated.limit ? { gauge: Math.min(1, typical / stated.limit) } : {}),
    });
  } else if (unmeasuredDays > 0) {
    /* Nobody could time it: say so, never "0 min". */
    stats.push({ id: 'travel', label: 'Typical day', value: 'Not measured', sub: word, ...(input.transportHeadline ? { detail: input.transportHeadline } : {}) });
  }

  if (input.travellers) {
    stats.push({
      id: 'party',
      label: input.travellers === 1 ? 'Traveller' : 'Travellers',
      value: String(input.travellers),
      ...(input.withChildren ? { sub: 'with children' } : {}),
    });
  }
  return stats;
}

/**
 * A day's title, short enough for a card.
 *
 * Themes are written "Arrive and settle in — <first stop> & <second stop>": a
 * lead and the places. The card shows the lead as its title and the places as
 * its second line, rather than truncating one long string mid-name.
 */
export function splitDayTheme(theme: string): { title: string; places: string | null } {
  const clean = theme.replace(/\.$/, '').trim();
  const at = clean.indexOf(' — ');
  if (at > 0) return { title: clean.slice(0, at).trim(), places: clean.slice(at + 3).trim() || null };
  return { title: clean, places: null };
}
