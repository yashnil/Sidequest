import { z } from 'zod';
import { dayOfWeekFor } from '../schemas/calendar';
import { freshnessClassSchema as claimFreshnessSchema } from '../intelligence/claims';

/**
 * V12 §22 §23 §24 — DATE-SENSITIVE OPERATIONAL TRUTH, IN ONE LAYER.
 *
 * ── THE DEFECT THIS EXISTS FOR ──────────────────────────────────────────────
 *
 * The V11 live Kyrgyzstan build put a "Karakol Sunday-style bazaar" on
 * 2026-08-09. That date **is** a Sunday, so the plan was right — and nothing in
 * Sidequest checked it. The model knew; the product did not ask. Sidequest only
 * validates a weekday requirement where a compiled hours calendar exists for
 * the place, and the normal composition path has no compiled hours at all, so
 * the same trip with the market on the Saturday would have shipped identically.
 *
 * Being right by the model's knowledge is not the same as being verified, and
 * the difference is the whole of V12 Part II.
 *
 * ── WHAT THIS IS, AND WHAT IT REFUSES TO BE ─────────────────────────────────
 *
 * A small, effective-dated, authority-ranked store of facts that can *move or
 * invalidate an item on a date*. §22 is explicit that it must not become a
 * generic events scraper, so a fact earns its place only by answering: could
 * this change what day something is planned for, or whether it can be planned
 * at all?
 *
 * Every claim carries where it came from and when it was checked, and — the
 * rule V11 established for access constraints and V9.1 for routing — **only an
 * affirmative statement from a confirming authority may establish anything**.
 * A gap is a gap, never a "no".
 *
 * ── §24'S SPECIFIC WARNING ──────────────────────────────────────────────────
 *
 * "Do not infer a Sunday requirement merely from a name unless evidence
 * supports it." A stop called "Sunday market" is a *name*, and a name is not a
 * source. `weekdayClaimFromName` exists to be the one place that reads one, it
 * returns a claim marked `inferred_from_name`, and `validateOn` refuses to fail
 * a day on an inferred claim — it can only ever raise a question.
 */

export const CALENDAR_FACT_KINDS = [
  'weekly_opening',
  'seasonal_opening',
  'known_closure',
  'permit_season',
  'reservation_window',
  'trail_season',
  'road_season',
  'ferry_season',
  'transit_service_window',
  'public_holiday',
  'wildlife_season',
  'market_day',
] as const;
export const calendarFactKindSchema = z.enum(CALENDAR_FACT_KINDS);
export type CalendarFactKind = z.infer<typeof calendarFactKindSchema>;

/**
 * How fast a fact goes stale.
 *
 * §23 insists these not be mixed — a currency and a ferry timetable are both
 * "facts" and nothing else about them is alike — and the codebase already has
 * exactly this vocabulary on `intelligence/claims.ts`, where entry rules,
 * weather and opening hours are already separated by it. A second, parallel
 * freshness scale would be the same mistake §23 is warning about, one level up:
 * two layers disagreeing about how long a fact is good for.
 *
 * `date_bound` is the class a calendar fact usually falls in; a seasonal road or
 * ferry period is `regulatory_volatile` where an authority sets it, and a
 * weekly opening pattern is `stable_reference`.
 */
export { FRESHNESS_CLASSES, freshnessClassSchema, type FreshnessClass } from '../intelligence/claims';

/** Who said so. Only the first two may establish a fact; the rest may only raise a question. */
export const CALENDAR_AUTHORITIES = ['official_current', 'operator', 'reference', 'model_knowledge', 'inferred_from_name'] as const;
export const calendarAuthoritySchema = z.enum(CALENDAR_AUTHORITIES);
export type CalendarAuthority = z.infer<typeof calendarAuthoritySchema>;

export const CONFIRMING_CALENDAR_AUTHORITY: ReadonlySet<CalendarAuthority> = new Set<CalendarAuthority>(['official_current', 'operator']);

export const calendarFactSchema = z.object({
  id: z.string().min(1).max(96),
  kind: calendarFactKindSchema,
  /** What this is about, as the plan names it. Matched by the caller, never here. */
  subject: z.string().min(1).max(160),
  /** 0 = Sunday. Present when the fact is about which days of the week apply. */
  daysOfWeek: z.array(z.number().int().min(0).max(6)).max(7).optional(),
  /** Inclusive `YYYY-MM-DD` bounds, when the fact only holds for part of the year. */
  validFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  validUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  /** Whether the subject is available on the days this fact covers, or unavailable. */
  available: z.boolean(),
  authority: calendarAuthoritySchema,
  freshness: claimFreshnessSchema,
  sourceName: z.string().min(1).max(160),
  checkedAt: z.string().min(10),
  /** One traveller-readable sentence. No field names (§19). */
  note: z.string().min(1).max(240),
});
export type CalendarFact = z.infer<typeof calendarFactSchema>;

export type CalendarVerdict =
  /** The date works, and something said so. */
  | { status: 'available'; basis: CalendarFact }
  /** The date does not work, and a confirming source said so. Safe to act on. */
  | { status: 'unavailable'; basis: CalendarFact; note: string }
  /** Something suggests a problem, but nothing that may establish one. Ask, never move. */
  | { status: 'questionable'; basis: CalendarFact; note: string }
  /** Nothing is known. Not a pass and not a failure. */
  | { status: 'unknown' };

function coversDate(fact: CalendarFact, date: string): boolean {
  if (fact.validFrom && date < fact.validFrom) return false;
  if (fact.validUntil && date > fact.validUntil) return false;
  return true;
}

function coversWeekday(fact: CalendarFact, date: string): boolean {
  if (!fact.daysOfWeek || fact.daysOfWeek.length === 0) return true;
  return fact.daysOfWeek.includes(dayOfWeekFor(date));
}

/**
 * Whether the plan may keep this subject on this date.
 *
 * The three-way answer is the point. `unknown` is the commonest and is not a
 * failure; `questionable` is what a name or a model's recollection can produce
 * and is never enough to move a day; only `unavailable` — an affirmative
 * statement from an official or operator source — may.
 */
export function validateOn(input: { facts: readonly CalendarFact[]; subject: string; date: string }): CalendarVerdict {
  const normalized = input.subject.trim().toLowerCase();
  const relevant = input.facts.filter((fact) => fact.subject.trim().toLowerCase() === normalized && coversDate(fact, input.date));
  if (relevant.length === 0) return { status: 'unknown' };

  /* A confirming source is heard first, whatever else is present. */
  const ordered = [...relevant].sort((a, b) => Number(CONFIRMING_CALENDAR_AUTHORITY.has(b.authority)) - Number(CONFIRMING_CALENDAR_AUTHORITY.has(a.authority)));
  for (const fact of ordered) {
    const applies = coversWeekday(fact, input.date);
    const confirming = CONFIRMING_CALENDAR_AUTHORITY.has(fact.authority);
    if (fact.available) {
      /* "Open on these days" — a date outside them is a closure only if the source could establish one. */
      if (applies) return { status: 'available', basis: fact };
      if (confirming) return { status: 'unavailable', basis: fact, note: fact.note };
      return { status: 'questionable', basis: fact, note: fact.note };
    }
    /* "Closed on these days" — only the covered days are affected. */
    if (applies) {
      if (confirming) return { status: 'unavailable', basis: fact, note: fact.note };
      return { status: 'questionable', basis: fact, note: fact.note };
    }
  }
  return { status: 'unknown' };
}

/**
 * The next date on or after `from`, within the trip, that this subject allows.
 *
 * Returns null when nothing in the window works, which is a different answer
 * from "we do not know" and is what lets a caller choose between moving an item
 * and taking it off.
 */
export function nextWorkingDate(input: { facts: readonly CalendarFact[]; subject: string; dates: readonly string[] }): string | null {
  for (const date of input.dates) {
    const verdict = validateOn({ facts: input.facts, subject: input.subject, date });
    if (verdict.status === 'available') return date;
  }
  return null;
}

const WEEKDAY_WORDS: Record<string, number> = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };

/**
 * §24 — a weekday named *inside a name*, read as a question rather than a fact.
 *
 * "Karakol Sunday-style bazaar", "Monday closed", "Friday market". The claim
 * this produces carries `authority: 'inferred_from_name'`, which
 * `CONFIRMING_CALENDAR_AUTHORITY` excludes, so it can only ever make a date
 * `questionable`. A name is a reason to check, never a reason to move a day.
 */
export function weekdayClaimFromName(input: { subject: string; checkedAt: string }): CalendarFact | null {
  const lowered = input.subject.toLowerCase();
  for (const [word, day] of Object.entries(WEEKDAY_WORDS)) {
    if (!lowered.includes(word)) continue;
    return {
      id: `name:${word}:${input.subject.slice(0, 40)}`,
      kind: 'market_day',
      subject: input.subject,
      daysOfWeek: [day],
      available: true,
      authority: 'inferred_from_name',
      freshness: 'stable_reference',
      sourceName: 'The name of the stop itself',
      checkedAt: input.checkedAt,
      note: `Its name says ${word[0]!.toUpperCase()}${word.slice(1)}. Nobody has confirmed that, so check before you rely on it.`,
    };
  }
  return null;
}

/**
 * Every item whose planned date its own calendar disagrees with.
 *
 * Deterministic and side-effect free: it reports, and the caller decides whether
 * to move an item, drop it, or raise it. §26 forbids repairing this with another
 * model call, and reordering is only safe where it is obviously valid.
 */
export function calendarConflicts(input: {
  facts: readonly CalendarFact[];
  items: readonly { subject: string; date: string; dayNumber: number }[];
  tripDates: readonly string[];
}): { subject: string; dayNumber: number; status: 'unavailable' | 'questionable'; note: string; moveTo: string | null }[] {
  const out: { subject: string; dayNumber: number; status: 'unavailable' | 'questionable'; note: string; moveTo: string | null }[] = [];
  for (const item of input.items) {
    const verdict = validateOn({ facts: input.facts, subject: item.subject, date: item.date });
    if (verdict.status !== 'unavailable' && verdict.status !== 'questionable') continue;
    out.push({
      subject: item.subject,
      dayNumber: item.dayNumber,
      status: verdict.status,
      note: verdict.note,
      moveTo: nextWorkingDate({ facts: input.facts, subject: item.subject, dates: input.tripDates }),
    });
  }
  return out;
}
