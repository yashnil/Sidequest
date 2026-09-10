import { impliesSelfDriving, type TripDraft } from '../planning/trip-draft';

/**
 * WHAT A PATCHED TRIP MUST STILL BE TRUE OF.
 *
 * PRODUCTION LOCK V5 §9. The Zod schema says the patched draft is well-formed;
 * these are the things a well-formed draft can still get wrong — two days
 * numbered the same, a day that sleeps nowhere, ten nights of beds on an
 * eleven-day trip, the same experience twice, a booking whose date the patch
 * moved out from under it. Every one of them is a trip that would render and be
 * wrong, which is the worst failure mode this product has.
 *
 * Three rules the checks obey:
 *
 * 1. **Deterministic and provider-free.** A violation is arithmetic on the draft,
 *    never a judgement and never a lookup. This runs on the edit path, inside
 *    the traveller's wait.
 * 2. **They fire only on what a patch can break.** The window is only checked
 *    when the patch actually moved it, because a trip built before an earlier
 *    fix may legitimately hold a window this check would reject, and refusing a
 *    traveller's unrelated edit over old data punishes the wrong person.
 * 3. **No taste.** "Too many hard days in a row" is the quality audit's business
 *    (`quality-audit.ts`) and is a warning there. Everything here is an
 *    impossibility.
 *
 * A violation refuses the whole patch (`patch.ts` restores the original draft),
 * because a half-applied structural change is the one outcome nobody can reason
 * about afterwards.
 */

/** What a booked fact needs to stay attached to. Deliberately narrower than `BookedPlanItem`. */
export interface BookingDependency {
  title: string;
  date?: string;
  endDate?: string;
  baseId?: string;
}

export interface InvariantInput {
  draft: TripDraft;
  /** Bookings whose dependencies must survive the patch. Absent means none are known. */
  booked?: readonly BookingDependency[];
  /** True when the patch itself moved the trip window; the date checks are otherwise skipped. */
  windowMutated?: boolean;
  today?: Date;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function dayCountBetween(startDate: string, endDate: string): number {
  const start = Date.parse(`${startDate}T00:00:00Z`);
  const end = Date.parse(`${endDate}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end)) return Number.NaN;
  return Math.round((end - start) / 86_400_000);
}

/**
 * Every way a patched draft can be structurally impossible, as sentences.
 *
 * Returns an empty array for a sound trip. The strings are written for a log and
 * for a refusal reason, not for a traveller — `describe.ts` owns that boundary.
 */
export function patchInvariantViolations(input: InvariantInput): string[] {
  const { draft } = input;
  const violations: string[] = [];

  /* --- days ------------------------------------------------------- */
  const dayNumbers = draft.days.map((day) => day.dayNumber);
  if (draft.days.length === 0) violations.push('the trip has no days left');
  if (new Set(dayNumbers).size !== dayNumbers.length) violations.push('two days carry the same day number');
  if (dayNumbers.some((number, position) => number !== position + 1)) violations.push('the day numbers are not a run from one');

  /* --- bases and overnights --------------------------------------- */
  const baseIds = new Set(draft.bases.map((base) => base.id));
  for (const day of draft.days) {
    if (!baseIds.has(day.baseId)) violations.push(`day ${day.dayNumber} sleeps at a stay the trip does not have`);
  }
  for (const base of draft.bases) {
    if (base.nights < 1) violations.push(`${base.name} is a stay with no nights`);
  }
  const nights = draft.bases.reduce((total, base) => total + base.nights, 0);
  if (draft.days.length > 0 && nights !== draft.days.length - 1) {
    violations.push(`${draft.days.length} days need ${draft.days.length - 1} nights of beds and the trip has ${nights}`);
  }
  /* An unused stay is an orphan: nights paid for on a day that no longer exists. */
  const slept = new Set(draft.days.map((day) => day.baseId));
  for (const base of draft.bases) {
    if (!slept.has(base.id)) violations.push(`${base.name} is a stay no day uses`);
  }

  /* --- activities -------------------------------------------------- */
  const seen = new Map<string, number>();
  for (const day of draft.days) {
    const withinDay = new Set<string>();
    for (const anchor of day.anchors) {
      const key = anchor.name.trim().toLowerCase();
      if (withinDay.has(key)) violations.push(`day ${day.dayNumber} holds ${anchor.name} twice`);
      withinDay.add(key);
      const first = seen.get(key);
      if (first !== undefined && first !== day.dayNumber) violations.push(`${anchor.name} appears on both day ${first} and day ${day.dayNumber}`);
      else if (first === undefined) seen.set(key, day.dayNumber);
    }
  }

  /* --- multi-day experiences --------------------------------------- */
  const signatures = new Set((draft.signatures ?? []).map((entry) => entry.trim().toLowerCase()));
  for (const day of draft.days) {
    if (day.partOf && signatures.size > 0 && !signatures.has(day.partOf.trim().toLowerCase())) {
      violations.push(`day ${day.dayNumber} belongs to "${day.partOf}", which the trip no longer lists`);
    }
  }

  /* --- meals -------------------------------------------------------- */
  for (const day of draft.days) {
    const meals = [day.meals?.breakfast, day.meals?.lunch, day.meals?.dinner].filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0).map((entry) => entry.trim().toLowerCase());
    if (new Set(meals).size !== meals.length) violations.push(`day ${day.dayNumber} eats the same meal twice`);
  }

  /* --- backups ------------------------------------------------------ */
  const dayNumberSet = new Set(dayNumbers);
  for (const backup of draft.package?.backups ?? []) {
    if (backup.day !== undefined && !dayNumberSet.has(backup.day)) {
      violations.push(`the backup for "${backup.trigger}" is pinned to day ${backup.day}, which the trip no longer has`);
    }
  }

  /* --- transport ---------------------------------------------------- */
  if (draft.driving !== undefined && !impliesSelfDriving(draft.driving)) {
    const advice = [draft.package?.transport?.summary ?? '', ...(draft.package?.transport?.notes ?? [])].join(' ');
    if (/\b(rent(al|ing)?\s+(a\s+)?car|hire\s+(a\s+)?car|your\s+own\s+car|you\s+drive|drive\s+yourself|self-drive)\b/i.test(advice)) {
      violations.push('the transport plan tells the traveller to drive on a trip they are not driving');
    }
  }

  /* --- dates -------------------------------------------------------- */
  if (input.windowMutated && draft.window) {
    const { startDate, endDate } = draft.window;
    if (!ISO_DATE.test(startDate) || !ISO_DATE.test(endDate)) violations.push('the new dates are not real dates');
    else {
      const span = dayCountBetween(startDate, endDate);
      if (!Number.isFinite(span) || span <= 0) violations.push('the new dates end before they start');
      else if (span !== nights) violations.push(`the new dates cover ${span} night${span === 1 ? '' : 's'} and the trip has ${nights}`);
      const today = input.today ?? new Date();
      const floor = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())).toISOString().slice(0, 10);
      if (startDate < floor) violations.push('the new dates start in the past');
    }
  }

  /* --- bookings ------------------------------------------------------ */
  for (const booking of input.booked ?? []) {
    if (booking.baseId && !baseIds.has(booking.baseId)) violations.push(`the booking "${booking.title}" is attached to a stay the trip no longer has`);
    if (draft.window) {
      for (const date of [booking.date, booking.endDate].filter((entry): entry is string => typeof entry === 'string')) {
        if (date < draft.window.startDate || date > draft.window.endDate) violations.push(`the booking "${booking.title}" falls outside the trip's dates`);
      }
    }
  }

  return [...new Set(violations)];
}
