import { z } from 'zod';
import type { PlaceClass } from './place-class';
import { OPERATIONAL_SEMANTICS } from './place-class';

/**
 * OPERATIONAL EVIDENCE — NORMALISED, PROVIDER-AGNOSTIC, USED IN THE CYCLE.
 *
 * A places provider says whether a venue is operating and, for the ones
 * that publish them, its regular weekly hours. The reconciler never sees a
 * provider's own shape: adapters normalise into this, and the reconciler
 * asks `assessOperational` one question per scheduled stop. Three rules:
 *
 *   UNKNOWN ≠ CLOSED. Missing hours, a timeout, a quota — the stop stays.
 *   AFFIRMATIVE ONLY. Only `closed_permanently` and a published schedule
 *     that contradicts the visit change the plan, and then minimally.
 *   TEMPORAL HONESTY. Regular hours are a schedule, usable for a future
 *     date with a recheck; a present-tense status is never a promise about
 *     a future one.
 *
 * Nothing here is persisted as-is. Provider hours and names are Maps
 * Content (see the terms note); the itinerary stores only the Sidequest
 * disposition — `ScheduledOperational` below — with provenance.
 */
export const OPERATIONAL_STATUSES = ['operational', 'closed_temporarily', 'closed_permanently', 'unknown'] as const;
export type OperationalStatus = (typeof OPERATIONAL_STATUSES)[number];

export interface OperationalEvidence {
  provider: string;
  providerRef?: string;
  checkedAt: string;
  status: OperationalStatus;
  /** What the hours describe: a regular weekly schedule, present-tense current hours, or nothing. */
  hoursBasis: 'regular' | 'current' | 'none';
  /** Weekly windows, `day` 0 = Sunday, minutes of day; only when `hoursBasis` is not `none`. */
  weekly?: readonly { day: number; openMinute: number; closeMinute: number }[];
  attribution: string;
  /** The provider was asked and could not answer (timeout, quota, error); `status` is then `unknown`. */
  unavailableReason?: string;
}

export const OPERATIONAL_OUTCOMES = [
  'open_at_time',
  'opens_later',
  'closes_earlier',
  'closed_on_date',
  'closed_permanently',
  'closed_temporarily_now',
  'hours_unknown',
  'not_applicable',
  'unavailable',
] as const;
export type OperationalOutcome = (typeof OPERATIONAL_OUTCOMES)[number];

/** The persisted, Sidequest-owned result of an operational check. No hours values, no provider names of places. */
export const scheduledOperationalSchema = z.object({
  provider: z.string().min(1),
  checkedAt: z.string().min(1),
  outcome: z.enum(OPERATIONAL_OUTCOMES),
  /** What the evidence was: a regular schedule or a present-tense status. */
  basis: z.enum(['regular', 'current', 'status_only', 'none']),
  /** Whether the traveller should look again before relying on it. */
  recheck: z.boolean(),
  attribution: z.string().min(1),
  note: z.string().min(1),
});
export type ScheduledOperational = z.infer<typeof scheduledOperationalSchema>;

export interface OperationalAssessment {
  outcome: OperationalOutcome;
  /** The window on the assessed date, in memory only — never persisted. */
  window?: { openMinute: number; closeMinute: number };
  /** True when the evidence affirmatively contradicts the visit as scheduled. */
  contradiction: boolean;
  persisted: ScheduledOperational;
}

function weekdayOf(date: string): number {
  return new Date(`${date}T12:00:00Z`).getUTCDay();
}

/** Weekly windows on a date; `null` when the evidence carries no hours. */
export function operationalWindowsOn(evidence: OperationalEvidence, date: string): { openMinute: number; closeMinute: number }[] | null {
  if (evidence.hoursBasis === 'none' || !evidence.weekly) return null;
  const day = weekdayOf(date);
  return evidence.weekly.filter((w) => w.day === day).map((w) => ({ openMinute: w.openMinute, closeMinute: w.closeMinute })).sort((a, b) => a.openMinute - b.openMinute);
}

export function assessOperational(input: {
  evidence: OperationalEvidence | null;
  placeClass: PlaceClass;
  date: string;
  /** Planned visit, minutes of day; absent when assessing the date alone. */
  startMinute?: number;
  endMinute?: number;
  /** Days from `now` to the visit; drives freshness and recheck. */
  daysUntil: number;
}): OperationalAssessment {
  const semantics = OPERATIONAL_SEMANTICS[input.placeClass];
  const { evidence } = input;
  const persist = (outcome: OperationalOutcome, note: string, extra: Partial<ScheduledOperational> = {}): ScheduledOperational => ({
    provider: evidence?.provider ?? 'none',
    checkedAt: evidence?.checkedAt ?? new Date(0).toISOString(),
    outcome,
    basis: evidence ? (evidence.hoursBasis === 'none' ? (evidence.status === 'unknown' ? 'none' : 'status_only') : evidence.hoursBasis) : 'none',
    recheck: true,
    attribution: evidence?.attribution ?? 'No provider',
    note,
    ...extra,
  });

  if (!semantics.hoursMatter && !semantics.businessStatusMatters) {
    return { outcome: 'not_applicable', contradiction: false, persisted: persist('not_applicable', 'Open ground or an area: no opening hours apply, and none were looked for.', { recheck: false }) };
  }
  if (!evidence) {
    return { outcome: 'hours_unknown', contradiction: false, persisted: persist('hours_unknown', 'No operational evidence was available; hours unknown is not closed.') };
  }
  if (evidence.unavailableReason) {
    return { outcome: 'unavailable', contradiction: false, persisted: persist('unavailable', `The places provider did not answer (${evidence.unavailableReason.replace(/_/g, ' ')}); the stop is kept as unverified.`) };
  }
  if (evidence.status === 'closed_permanently' && semantics.businessStatusMatters) {
    return { outcome: 'closed_permanently', contradiction: true, persisted: persist('closed_permanently', `Listed as permanently closed on ${evidence.checkedAt.slice(0, 10)}.`, { recheck: false }) };
  }
  if (evidence.status === 'closed_temporarily' && semantics.businessStatusMatters) {
    // Present tense. Inside a week it is the fact that matters; beyond that it is a reason to look again, never a verdict on a future date.
    return {
      outcome: 'closed_temporarily_now',
      contradiction: false,
      persisted: persist('closed_temporarily_now', input.daysUntil <= 7 ? `Listed as temporarily closed on ${evidence.checkedAt.slice(0, 10)}, within a week of your visit; check before you go.` : `Listed as temporarily closed on ${evidence.checkedAt.slice(0, 10)}; that says nothing certain about ${input.date}. Kept on the plan; look again nearer the time.`),
    };
  }
  const windows = operationalWindowsOn(evidence, input.date);
  if (evidence.hoursBasis === 'current') {
    // Current hours describe today, not the visit. Reference evidence only.
    return { outcome: 'hours_unknown', contradiction: false, persisted: persist('hours_unknown', `Only present-day hours were available (read ${evidence.checkedAt.slice(0, 10)}); they are not a schedule for ${input.date}. Check hours nearer the time.`) };
  }
  if (!windows || !semantics.hoursMatter) {
    return { outcome: 'hours_unknown', contradiction: false, persisted: persist('hours_unknown', evidence.status === 'operational' ? `Listed as operating on ${evidence.checkedAt.slice(0, 10)}; no published hours, which is not the same as closed.` : 'No published hours; not the same as closed.') };
  }
  const stale = input.daysUntil > 7;
  const rechecked = stale ? ' Regular hours can change; check again within a week of the visit.' : '';
  if (windows.length === 0) {
    return { outcome: 'closed_on_date', contradiction: true, persisted: persist('closed_on_date', `Its regular schedule (read ${evidence.checkedAt.slice(0, 10)}) has no opening on that weekday.${rechecked}`) };
  }
  const first = windows[0]!;
  const last = windows[windows.length - 1]!;
  const window = { openMinute: first.openMinute, closeMinute: last.closeMinute };
  if (input.startMinute === undefined || input.endMinute === undefined) {
    return { outcome: 'open_at_time', window, contradiction: false, persisted: persist('open_at_time', `Open that weekday on its regular schedule (read ${evidence.checkedAt.slice(0, 10)}).${rechecked}`, { recheck: stale }) };
  }
  if (input.endMinute <= window.openMinute || input.startMinute >= window.closeMinute) {
    return { outcome: input.startMinute >= window.closeMinute ? 'closes_earlier' : 'opens_later', window, contradiction: true, persisted: persist(input.startMinute >= window.closeMinute ? 'closes_earlier' : 'opens_later', `The visit as planned falls outside its regular hours for that weekday (read ${evidence.checkedAt.slice(0, 10)}); moved to fit.${rechecked}`) };
  }
  if (input.startMinute < window.openMinute) {
    return { outcome: 'opens_later', window, contradiction: true, persisted: persist('opens_later', `Opens later than the plan arrived; arrival set to opening time (read ${evidence.checkedAt.slice(0, 10)}).${rechecked}`) };
  }
  if (input.endMinute > window.closeMinute) {
    return { outcome: 'closes_earlier', window, contradiction: false, persisted: persist('closes_earlier', `The visit may run past closing time on its regular schedule (read ${evidence.checkedAt.slice(0, 10)}); check hours.${rechecked}`) };
  }
  return { outcome: 'open_at_time', window, contradiction: false, persisted: persist('open_at_time', `Open at the planned time on its regular schedule (read ${evidence.checkedAt.slice(0, 10)}).${rechecked}`, { recheck: stale }) };
}
