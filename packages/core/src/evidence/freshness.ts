import {
  factChangeClassSchema,
  type FactChangeClass,
  type FactFreshnessState,
} from '../schemas/evidence-store';
import type { FactPath } from '../schemas/source-fact';
import { shelfLifeFor } from './resolve';

/**
 * HOW LONG A FACT IS WORTH BELIEVING.
 *
 * `FACT_SHELF_LIFE_DAYS` already says *how many days*. This says *what kind of
 * thing it is*, and the difference is the difference between a table and a
 * policy. "A closure is fast-changing, and a fast-changing fact past its window
 * is never enforced" is a rule somebody can argue with; a list of numbers is not.
 *
 * Two properties hold, and both are the point of the phase:
 *
 * **A revalidation is not a re-verification.** A `304 Not Modified` proves the
 * publisher says the representation has not changed. It does not prove the
 * museum is still shut. So freshness is computed from when the *content* was last
 * observed to differ, never from when we last checked — and `checkedAt` is
 * deliberately not a parameter of `assessFreshness`, so it cannot be passed by
 * accident.
 *
 * **Freshness is relative to the traveller's dates, not to today.** A closure
 * that lifts before the trip begins is `expired` and must not block anything; one
 * that begins after the trip ends is `not_yet_applicable`. Both are still shown,
 * because "this reopens the week after you leave" is worth knowing.
 */

/**
 * The class each path belongs to.
 *
 * Complete over `FactPath` by construction — the type annotation makes a new path
 * a compile error rather than a silent `undefined` that would default a
 * safety notice to the slow-changing bucket.
 */
export const FACT_CHANGE_CLASS: Record<FactPath, FactChangeClass> = {
  'identity.officialSite': 'slow',
  'identity.bookingUrl': 'moderate',
  'hours.weekly': 'moderate',
  'hours.seasonal': 'moderate',
  'hours.lastAdmission': 'moderate',
  'hours.closure': 'fast',
  'access.method': 'slow',
  'access.permit': 'moderate',
  'booking.required': 'moderate',
  'booking.timedEntry': 'moderate',
  'booking.leadTime': 'moderate',
  'cost.admission': 'moderate',
  'cost.parking': 'moderate',
  'cost.transport': 'fast',
  'duration.typical': 'slow',
  'safety.caution': 'fast',
  'safety.requirement': 'slow',
  'food.hours': 'moderate',
  'food.price': 'moderate',
  'food.dietary': 'moderate',
  'food.reservation': 'moderate',
};

export function changeClassFor(path: FactPath): FactChangeClass {
  return factChangeClassSchema.parse(FACT_CHANGE_CLASS[path]);
}

/**
 * The share of a fact's shelf life after which it is worth rechecking.
 *
 * Not a second table: a fraction of the shelf life the path already declares, so
 * the two can never drift apart. Fast-changing facts get the earliest warning
 * because they are the ones most likely to have been lifted or imposed without
 * anybody updating the page we read.
 */
const RECHECK_FRACTION: Record<FactChangeClass, number> = {
  fast: 0.4,
  moderate: 0.6,
  slow: 0.75,
};

/**
 * How long a document version may go without a *full* re-read, whatever its
 * validators say.
 *
 * This is the answer to "the server returns 304 forever". A publisher whose ETag
 * never changes cannot keep a fact fresh indefinitely, because past this window
 * the store stops trusting conditional revalidation and fetches the body again.
 */
export const FULL_REREAD_DAYS: Record<FactChangeClass, number> = {
  fast: 14,
  moderate: 45,
  slow: 120,
};

export interface FreshnessInput {
  factPath: FactPath;
  /**
   * When the underlying content was last *observed to be what it is*.
   *
   * Not when it was last checked. A 304 does not move this, and that asymmetry is
   * the whole reason this module exists.
   */
  contentObservedAt: string;
  /** When the source states it was published or updated, where it states one. */
  publishedAt?: string;
  /** A validity window the source declared for itself. Beats the shelf life. */
  validFrom?: string;
  validThrough?: string;
  /** A dated applicability the claim itself carries — a closure's from/to. */
  appliesFrom?: string;
  appliesTo?: string;
  /** The traveller's dates, sorted. Empty means "judge against today". */
  travelDates: readonly string[];
  now: Date;
  /** A shelf life the fact declared for itself, in days. */
  shelfLifeDays?: number;
}

export interface FreshnessAssessment {
  state: FactFreshnessState;
  changeClass: FactChangeClass;
  /** Days since the content was last observed. Negative clocks read as 0. */
  ageDays: number;
  shelfLifeDays: number;
  /** Whether a planner may treat this as a hard constraint. */
  enforceable: boolean;
  /** One sentence naming why, in the product's voice. */
  rationale: string;
}

const DAY_MS = 86_400_000;

/**
 * Judge one fact, on these dates.
 *
 * Order matters and is deliberate: **applicability first, age second**. A closure
 * that ended last month is not "stale evidence about a current closure", it is
 * evidence about something that is over — and calling it stale would leave a
 * caution on a trip that has nothing to be cautious about.
 */
export function assessFreshness(input: FreshnessInput): FreshnessAssessment {
  const changeClass = changeClassFor(input.factPath);
  const shelfLifeDays = input.shelfLifeDays ?? shelfLifeFor(input.factPath);

  const tripStart = input.travelDates[0];
  const tripEnd = input.travelDates[input.travelDates.length - 1];

  // ---- Applicability, against the trip rather than against today ----------
  const windowEnd = input.validThrough ?? input.appliesTo;
  const windowStart = input.validFrom ?? input.appliesFrom;

  if (windowEnd && tripStart && windowEnd < tripStart) {
    return {
      state: 'expired',
      changeClass,
      ageDays: ageInDays(input.contentObservedAt, input.now),
      shelfLifeDays,
      enforceable: false,
      rationale: `This ended on ${windowEnd}, before your trip starts.`,
    };
  }
  if (windowStart && tripEnd && windowStart > tripEnd) {
    return {
      state: 'not_yet_applicable',
      changeClass,
      ageDays: ageInDays(input.contentObservedAt, input.now),
      shelfLifeDays,
      enforceable: false,
      rationale: `This begins on ${windowStart}, after your trip ends.`,
    };
  }

  /**
   * A source that states its own validity window is more authoritative about
   * that window than our default shelf life. If it says it holds through a date
   * that covers the trip, age does not make it stale — the publisher has already
   * told us how long they stand behind it.
   */
  if (windowEnd && tripEnd && windowEnd >= tripEnd && windowStart !== undefined) {
    return {
      state: 'fresh',
      changeClass,
      ageDays: ageInDays(input.contentObservedAt, input.now),
      shelfLifeDays,
      enforceable: true,
      rationale: `The source says this holds from ${windowStart} through ${windowEnd}.`,
    };
  }

  // ---- Age, from the content clock ---------------------------------------
  const ageDays = ageInDays(input.contentObservedAt, input.now);
  const recheckAfter = shelfLifeDays * RECHECK_FRACTION[changeClass];

  if (ageDays > shelfLifeDays) {
    return {
      state: 'stale',
      changeClass,
      ageDays,
      shelfLifeDays,
      /**
       * A fast-changing fact past its window is never enforced.
       *
       * The asymmetry with the other classes is the point: a museum's opening
       * hours from four months ago are probably still roughly right, and a
       * closure notice from four months ago is as likely to have been lifted as
       * not. Planning around the second one strands somebody.
       */
      enforceable: false,
      rationale:
        changeClass === 'fast'
          ? `This changes without notice and was last confirmed ${ageDays} days ago, so we are not planning around it.`
          : `This was last confirmed ${ageDays} days ago, which is past what we would rely on.`,
    };
  }

  if (ageDays > recheckAfter) {
    return {
      state: 'due_recheck',
      changeClass,
      ageDays,
      shelfLifeDays,
      enforceable: true,
      rationale: `Last confirmed ${ageDays} days ago. Worth a look at the official page before you go.`,
    };
  }

  return {
    state: 'fresh',
    changeClass,
    ageDays,
    shelfLifeDays,
    enforceable: true,
    rationale: `Confirmed ${ageDays === 0 ? 'today' : `${ageDays} days ago`}.`,
  };
}

function ageInDays(observedAt: string, now: Date): number {
  const observed = Date.parse(observedAt);
  if (Number.isNaN(observed)) return Number.MAX_SAFE_INTEGER;
  return Math.max(0, Math.floor((now.getTime() - observed) / DAY_MS));
}

/**
 * Whether a stored document must be fetched in full rather than revalidated.
 *
 * The defence against a server whose validators never change. Past this window a
 * 304 is no longer accepted as evidence that the content is current, and the body
 * is read again — which is the only way to notice that a page changed while its
 * ETag did not.
 */
export function needsFullReread(input: {
  contentObservedAt: string;
  /** The fastest-changing class of fact anyone wants out of this document. */
  changeClass: FactChangeClass;
  now: Date;
}): boolean {
  return ageInDays(input.contentObservedAt, input.now) > FULL_REREAD_DAYS[input.changeClass];
}

/**
 * How long a *revalidation* is good for before it is worth doing again.
 *
 * Deliberately short compared with a shelf life: revalidating is cheap — one
 * conditional request, usually no body — so the store checks often and re-reads
 * rarely. This is the number that keeps a warm recompilation from making any
 * network call at all when nothing has aged.
 */
export const REVALIDATE_AFTER_HOURS: Record<FactChangeClass, number> = {
  fast: 6,
  moderate: 24,
  slow: 72,
};

export function needsRevalidation(input: {
  lastCheckedAt: string;
  changeClass: FactChangeClass;
  now: Date;
}): boolean {
  const checked = Date.parse(input.lastCheckedAt);
  if (Number.isNaN(checked)) return true;
  const hours = (input.now.getTime() - checked) / 3_600_000;
  return hours > REVALIDATE_AFTER_HOURS[input.changeClass];
}

/**
 * How long a robots verdict is good for.
 *
 * A day, and deliberately shorter than any content window. Permission is cheap
 * to recheck — one small file, and the check rides along with the conditional
 * request we were going to make anyway — and expensive to get wrong: continuing
 * to read a site that has asked us to stop is the kind of mistake that is nobody
 * else's fault.
 */
export const ROBOTS_FRESHNESS_HOURS = 24;

/**
 * Whether we may reuse a held document *without asking the site anything*.
 *
 * Separate from content freshness because it answers a different question. A
 * page can be unchanged for a year and its site can have added a `Disallow` this
 * morning, and reuse-without-a-request would never notice.
 */
export function robotsVerdictIsFresh(input: {
  robotsCheckedAt: string | undefined;
  now: Date;
}): boolean {
  if (!input.robotsCheckedAt) return false;
  const checked = Date.parse(input.robotsCheckedAt);
  if (Number.isNaN(checked)) return false;
  return (input.now.getTime() - checked) / 3_600_000 <= ROBOTS_FRESHNESS_HOURS;
}

/** The fastest-changing class among a set of paths. Governs a whole document. */
export function fastestClass(paths: readonly FactPath[]): FactChangeClass {
  let fastest: FactChangeClass = 'slow';
  for (const path of paths) {
    const cls = changeClassFor(path);
    if (cls === 'fast') return 'fast';
    if (cls === 'moderate') fastest = 'moderate';
  }
  return fastest;
}
