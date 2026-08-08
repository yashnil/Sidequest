import { eachDate } from '../geometry';
import type { BenchmarkGroundTruth } from '../ground-truth';
import {
  type BenchCheckCode,
  type BenchFinding,
  type BenchSeverity,
  type BenchSubject,
  type UnknownReason,
} from '../schemas/finding';
import { type BenchmarkPlan, type PlanBlock, type PlanDay } from '../schemas/plan';
import { type BenchmarkTripRequest } from '../schemas/request';

/**
 * The plumbing every neutral check shares.
 *
 * Two things live here rather than in the checks, because getting either wrong
 * once would be invisible and would corrupt every number the benchmark reports.
 *
 * The first is the verifiability ledger. `attempted` and `decided` are not
 * derived from the findings — they cannot be, because a check that *passes*
 * emits nothing and still counts as decided, and a report that inferred the
 * denominator from the findings would reward the plan that gave the checks
 * nothing to look at. So every check says out loud whether it reached an answer,
 * and the two counters only ever move through these two methods.
 *
 * The second is canonicalisation. A report has to be byte-identical for the same
 * plan however that plan's arrays happened to be ordered on the wire, so the
 * checks never see `plan.days` as it arrived: they see it sorted, with each day's
 * blocks sorted, and every `blockIndex` in a finding is an index into that
 * canonical order.
 */

export type Scalar = string | number | boolean | null;

export interface Detail {
  observed?: Record<string, Scalar>;
  expected?: Record<string, Scalar>;
}

export interface Tally {
  attempted: number;
  decided: number;
}

export interface CheckContext {
  /** The traveller's own statement. The only source of "what was asked for". */
  readonly request: BenchmarkTripRequest;
  /** Every calendar date the plan itself claims to cover. */
  readonly tripDates: readonly string[];
  /** Which inventory identity each declared base sleeps at, by base id. */
  readonly baseEntityById: ReadonlyMap<string, string | null>;
  readonly tally: Tally;
  /** A check reached an answer: a pass, a defect, or a note. */
  decided(): void;
  /** A check ran and the evidence needed to settle it was not there. */
  undecided(): void;
}

export function createContext(plan: BenchmarkPlan, truth: BenchmarkGroundTruth): CheckContext {
  const tally: Tally = { attempted: 0, decided: 0 };

  const baseEntityById = new Map<string, string | null>();
  for (const base of safeArray(plan.bases)) {
    const id = base?.id;
    if (typeof id === 'string' && id.length > 0 && !baseEntityById.has(id)) {
      baseEntityById.set(id, base.place?.entityId ?? null);
    }
  }

  return {
    request: truth.request,
    tripDates: eachDate(String(plan.startDate), String(plan.endDate)),
    baseEntityById,
    tally,
    decided() {
      tally.attempted += 1;
      tally.decided += 1;
    },
    undecided() {
      tally.attempted += 1;
    },
  };
}

/* ------------------------------------------------------------------ *
 * Finding construction
 * ------------------------------------------------------------------ */

/**
 * A settled finding.
 *
 * `groundTruth` names the accessor or the request field that decided it, so a
 * disputed finding can be re-derived from the same inputs rather than argued
 * about from the prose.
 */
export function report(
  code: BenchCheckCode,
  severity: Exclude<BenchSeverity, 'unknown'>,
  subject: BenchSubject,
  message: string,
  groundTruth: string,
  detail: Detail = {},
): BenchFinding {
  return {
    code,
    severity,
    subject,
    message: clampMessage(message),
    groundTruth,
    observed: detail.observed ?? {},
    expected: detail.expected ?? {},
  };
}

/**
 * A check that ran and could not answer.
 *
 * Never a defect, never counted as one, and always carrying the reason the
 * evidence was missing — because "we could not tell" and "this is wrong" are the
 * two things this benchmark exists to keep apart.
 */
export function unresolved(
  code: BenchCheckCode,
  subject: BenchSubject,
  message: string,
  groundTruth: string,
  unknownReason: UnknownReason,
  detail: Detail = {},
): BenchFinding {
  return {
    code,
    severity: 'unknown',
    subject,
    message: clampMessage(message),
    groundTruth,
    observed: detail.observed ?? {},
    expected: detail.expected ?? {},
    unknownReason,
  };
}

const MAX_MESSAGE_LENGTH = 600;

function clampMessage(message: string): string {
  const text = message.length > 0 ? message : 'No detail.';
  return text.length > MAX_MESSAGE_LENGTH ? `${text.slice(0, MAX_MESSAGE_LENGTH - 1)}…` : text;
}

/* ------------------------------------------------------------------ *
 * Canonical order
 * ------------------------------------------------------------------ */

export function safeArray<T>(value: readonly T[] | undefined | null): readonly T[] {
  return Array.isArray(value) ? value : [];
}

/**
 * The plan as the checks see it.
 *
 * Sorting is what makes a report reproducible, and it is also why blocks are
 * ordered by the clock rather than by the position they arrived in: two systems
 * that emit the same day in different array orders have made the same plan, and
 * a validator that disagreed with itself about that would be measuring
 * serialisation.
 *
 * The cost is real and is handled where it lands: a block with no stated times
 * sorts to the end of its day, so nothing positional may be the *only* evidence
 * for a finding. The routing checks accept a travel block that joins the right
 * two places wherever it sits, for exactly this reason.
 */
export function canonicalisePlan(plan: BenchmarkPlan): BenchmarkPlan {
  const days = safeArray(plan.days)
    .map((day) => ({ ...day, blocks: [...safeArray(day.blocks)].sort(compareBlocks) }))
    .sort(compareDays);
  return { ...plan, days };
}

function compareDays(a: PlanDay, b: PlanDay): number {
  const dateA = String(a.date ?? '');
  const dateB = String(b.date ?? '');
  if (dateA !== dateB) return dateA < dateB ? -1 : 1;
  const numberA = Number.isFinite(a.dayNumber) ? a.dayNumber : 0;
  const numberB = Number.isFinite(b.dayNumber) ? b.dayNumber : 0;
  if (numberA !== numberB) return numberA - numberB;
  const keyA = dayTieKey(a);
  const keyB = dayTieKey(b);
  return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
}

/** Enough of a day to separate two that share a date and a number. */
function dayTieKey(day: PlanDay): string {
  return `${safeArray(day.blocks).length}:${day.baseId ?? '-'}:${day.theme ?? ''}`;
}

const UNTIMED = Number.MAX_SAFE_INTEGER;

function compareBlocks(a: PlanBlock, b: PlanBlock): number {
  const startA = a.startMinute ?? UNTIMED;
  const startB = b.startMinute ?? UNTIMED;
  if (startA !== startB) return startA - startB;
  const endA = a.endMinute ?? UNTIMED;
  const endB = b.endMinute ?? UNTIMED;
  if (endA !== endB) return endA - endB;
  if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
  const titleA = String(a.title ?? '');
  const titleB = String(b.title ?? '');
  if (titleA !== titleB) return titleA < titleB ? -1 : 1;
  const placeA = placeKey(a);
  const placeB = placeKey(b);
  return placeA < placeB ? -1 : placeA > placeB ? 1 : 0;
}

function placeKey(block: PlanBlock): string {
  return block.place?.entityId ?? block.place?.name ?? '-';
}

/* ------------------------------------------------------------------ *
 * Reading a plan without trusting it
 * ------------------------------------------------------------------ */

export function isActivity(block: PlanBlock): boolean {
  return block.kind === 'activity';
}

/** Travel and transfer are one thing for every check that sums minutes. */
export function isTravel(block: PlanBlock): boolean {
  return block.kind === 'travel' || block.kind === 'transfer';
}

export function isMeal(block: PlanBlock): boolean {
  return block.kind === 'meal';
}

export function activityBlocks(day: PlanDay): PlanBlock[] {
  return safeArray(day.blocks).filter(isActivity);
}

export function travelBlocks(day: PlanDay): PlanBlock[] {
  return safeArray(day.blocks).filter((block) => isTravel(block) && block.travel !== null);
}

export function mealBlocks(day: PlanDay): PlanBlock[] {
  return safeArray(day.blocks).filter(isMeal);
}

/** The inventory identity of what a block visits, or null when it names none. */
export function entityIdOf(block: PlanBlock): string | null {
  return block.place?.entityId ?? null;
}

/**
 * The inventory identity of where a meal happens.
 *
 * `meal.venue` first, and then the block's own place, because a plan that put
 * the restaurant's identity on the block rather than inside the meal detail has
 * named the same restaurant. The fallback is not cosmetic: one converter fills
 * `meal.venue.entityId` and the other hard-codes it null while still placing the
 * block, and reading only the first field made every venue check structurally
 * undecidable for one arm and decidable for the other — an asymmetry in what
 * could be *caught*, which is the one asymmetry a neutral checker must not have.
 */
export function venueIdOf(block: PlanBlock): string | null {
  return block.meal?.venue?.entityId ?? block.place?.entityId ?? null;
}

/**
 * What the plan is actually spending on a journey.
 *
 * The stated duration where there is one, and otherwise the slot the timeline
 * gives the leg — which is a fact about the plan rather than an estimate about
 * the world, and is exactly as binding on the traveller as a number written in a
 * field would have been. Only a leg with neither is unanswerable.
 *
 * The fallback is what keeps the travel budgets and the day's arithmetic
 * checkable for a plan that declines to state minutes on a leg nobody measured.
 * A check that could only run on stated minutes was a check one converter could
 * never fail, because it drops that field on exactly those legs while the other
 * fills it whatever the provenance.
 *
 * The stated value wins where both exist, and taking the larger of the two was
 * considered and rejected. A plan that leaves an hour on the clock for a
 * forty-minute drive has left twenty minutes of slack, not spent an hour driving
 * — and padding is a habit one converter has and the other does not, so charging
 * for it would have swapped one arm-shaped asymmetry for another. Where the two
 * genuinely disagree about a *day*, `stated_totals_contradict_timeline` is the
 * check that says so.
 */
export function travelMinutesOf(block: PlanBlock): number | null {
  const stated = typeof block.travel?.minutes === 'number' ? block.travel.minutes : null;
  return stated ?? blockMinutes(block);
}

export function displayNameOf(block: PlanBlock): string {
  return block.place?.name ?? block.title ?? 'this stop';
}

export interface Window {
  start: number;
  end: number;
}

export function timesOf(block: PlanBlock): Window | null {
  const start = block.startMinute;
  const end = block.endMinute;
  if (typeof start !== 'number' || typeof end !== 'number') return null;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return { start, end };
}

export function blockMinutes(block: PlanBlock): number | null {
  const times = timesOf(block);
  return times ? Math.max(0, times.end - times.start) : null;
}

/** Earliest start to latest end across everything the day puts a clock on. */
export function daySpan(day: PlanDay): Window | null {
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  for (const block of safeArray(day.blocks)) {
    const times = timesOf(block);
    if (!times) continue;
    start = Math.min(start, times.start);
    end = Math.max(end, times.end);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return { start, end };
}

/** Minutes the day has spoken for. Free time and rest are deliberately absent. */
export function committedMinutes(day: PlanDay): number {
  let total = 0;
  for (const block of safeArray(day.blocks)) {
    if (block.kind === 'free_time' || block.kind === 'rest') continue;
    total += blockMinutes(block) ?? 0;
  }
  return total;
}

/* ------------------------------------------------------------------ *
 * Subjects
 * ------------------------------------------------------------------ */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A subject the finding schema will accept.
 *
 * Built defensively rather than spread from the day, because a malformed date or
 * a zero day number has to produce a finding about the malformation rather than
 * a finding that is itself invalid.
 */
export function subjectOf(
  day: PlanDay | null,
  extra: { entityId?: string | null; blockIndex?: number } = {},
): BenchSubject {
  const subject: BenchSubject = {};
  if (day) {
    if (typeof day.dayNumber === 'number' && Number.isInteger(day.dayNumber) && day.dayNumber >= 1) {
      subject.dayNumber = day.dayNumber;
    }
    if (typeof day.date === 'string' && ISO_DATE.test(day.date)) subject.date = day.date;
  }
  if (typeof extra.entityId === 'string' && extra.entityId.length > 0) {
    subject.entityId = extra.entityId;
  }
  if (typeof extra.blockIndex === 'number' && Number.isInteger(extra.blockIndex) && extra.blockIndex >= 0) {
    subject.blockIndex = extra.blockIndex;
  }
  return subject;
}

/** How a day is named in a sentence, whatever state its fields are in. */
export function dayLabel(day: PlanDay): string {
  if (typeof day.dayNumber === 'number' && Number.isFinite(day.dayNumber)) {
    return `Day ${day.dayNumber}`;
  }
  return typeof day.date === 'string' ? day.date : 'A day';
}

export function clockLabel(minute: number): string {
  const wrapped = ((minute % 1440) + 1440) % 1440;
  const hours = Math.floor(wrapped / 60);
  const minutes = wrapped % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/* ------------------------------------------------------------------ *
 * Text
 * ------------------------------------------------------------------ */

/**
 * Flattened text, for the two checks where matching against words is
 * unavoidable: the traveller's free-text must-do list, and the tag and dietary
 * vocabularies the inventory publishes. Nothing here ever resolves a *place* —
 * places are matched by `entityId` only, and matching them by name would turn
 * phrasing into a scoring axis.
 */
export function normaliseText(value: string): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function normaliseTag(value: string): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** Minutes past local midnight for a `HH:MM` request field, or null. */
export function minutesFromClock(value: string | null | undefined): number | null {
  if (typeof value !== 'string') return null;
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  const hours = match?.[1];
  const minutes = match?.[2];
  if (hours === undefined || minutes === undefined) return null;
  return Number(hours) * 60 + Number(minutes);
}
