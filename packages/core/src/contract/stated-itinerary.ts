import { z } from 'zod';
import type { ContractConflict, LockLevel } from './trip-contract';

/**
 * THE STATED ITINERARY — A PLAN THE TRAVELLER ALREADY HAD, KEPT AS THEIRS.
 *
 * Mode 3 ("I already have a plan") used to hand the planner a destination
 * phrase, a total length and the place names as must-dos. "3 nights in Kyoto"
 * did not survive: the stay objective chose the beds and the nights again, as
 * if nobody had said anything. This is the record that carries what they said
 * through the canonical trip contract — ordered stops, each with its nights
 * or dates, whether it is fixed (a booked stay is), the attractions they named
 * at it, how they planned to get there, and their arrival and departure — with
 * per-field provenance, so every later sentence can say which numbers were
 * theirs and which were Sidequest's.
 *
 * Additive and versioned. It lives on `TripComposerAnswers.statedItinerary`
 * (an optional field at the composer's existing `schemaVersion`, exactly as
 * `interpretation` and `discovery` were added) and is read into
 * `TripContract.statedItinerary` with a lock per stop:
 *
 *   a booked / fixed stay            → booked_lock
 *   nights the traveller stated      → user_explicit
 *   nights read from their structure → user_explicit (parsed, still theirs)
 *   nights Sidequest split or moved  → sidequest_inferred
 *
 * The planner honours every stop at `user_explicit` or above; one it cannot
 * honour becomes a `ContractConflict` and a sentence on the plan, never a
 * silent replacement (`statedStayConflicts`).
 */

export const STATED_ITINERARY_VERSION = 1 as const;

export const STATED_PROVENANCES = ['stated', 'parsed', 'assumed'] as const;
export const statedProvenanceSchema = z.enum(STATED_PROVENANCES);
/** `stated`: their own words or number. `parsed`: read from the shape of what they wrote (a day list, "2 days"). `assumed`: Sidequest's split, default or suggestion. */
export type StatedProvenance = z.infer<typeof statedProvenanceSchema>;

export const STATED_TRANSPORT_MODES = ['rail', 'drive', 'bus', 'ferry', 'flight', 'walk'] as const;
export const statedTransportModeSchema = z.enum(STATED_TRANSPORT_MODES);
export type StatedTransportMode = z.infer<typeof statedTransportModeSchema>;

export const STATED_TRANSPORT_LABELS: Record<StatedTransportMode, string> = {
  rail: 'train',
  drive: 'car',
  bus: 'bus',
  ferry: 'ferry',
  flight: 'flight',
  walk: 'on foot',
};

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const statedStopSchema = z.object({
  /** Stable within the record: `s1`, `s2`… in the order written. */
  id: z.string().min(1).max(12),
  /** The traveller's words for the place. */
  label: z.string().trim().min(1).max(80),
  /** What a geocoder placed it as, for display only; the label stays theirs. */
  placedName: z.string().max(120).nullable().optional(),
  point: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }).nullable().optional(),
  countryCode: z.string().length(2).nullable().optional(),
  /** Nights slept here; 0 for a day trip. */
  nights: z.number().int().min(0).max(60),
  nightsProvenance: statedProvenanceSchema,
  /** A date range for this stay, when they gave one. */
  dates: z.object({ start: isoDate, end: isoDate }).nullable().optional(),
  /** Seen from the previous bed, not slept in. */
  dayTrip: z.boolean(),
  /** A booked or otherwise immovable stay. Fixed stays never move, change length or disappear. */
  fixed: z.boolean(),
  /** Attractions they named at this stop. Must-sees, never optional fill. */
  mustSee: z.array(z.string().trim().min(1).max(80)).max(8).default([]),
  /** How they planned to arrive here from the previous stop. */
  transportIn: z
    .object({ mode: statedTransportModeSchema, provenance: statedProvenanceSchema })
    .nullable()
    .optional(),
});
export type StatedStop = z.infer<typeof statedStopSchema>;
export type StatedStopInput = z.input<typeof statedStopSchema>;

const edgeSchema = z.object({
  place: z.string().trim().min(1).max(80).nullable().optional(),
  /** "15:00" when they said a time. */
  time: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
  provenance: statedProvenanceSchema,
});

export const statedItinerarySchema = z.object({
  version: z.literal(STATED_ITINERARY_VERSION),
  /** Which door wrote it. */
  source: z.enum(['plan_check', 'composer']),
  stops: z.array(statedStopSchema).min(1).max(12),
  arrival: edgeSchema.nullable().optional(),
  departure: edgeSchema.nullable().optional(),
  /** 0–1: how much of the plan the deterministic reading understood. */
  parseConfidence: z.number().min(0).max(1),
  /** The changes the traveller accepted before planning, by id and sentence, so the record says what was theirs and what they agreed to. */
  acceptedChanges: z
    .array(z.object({ id: z.string().min(1).max(60), kind: z.string().min(1).max(30), sentence: z.string().min(1).max(400) }))
    .max(24)
    .default([]),
  recordedAt: z.string().min(1),
});
export type StatedItinerary = z.infer<typeof statedItinerarySchema>;
export type StatedItineraryInput = z.input<typeof statedItinerarySchema>;

/* ------------------------------------------------------------------ *
 * Locks
 * ------------------------------------------------------------------ */

/** The lock a stated stop's stay is held at. */
export function statedStopLock(stop: Pick<StatedStop, 'fixed' | 'nightsProvenance'>): LockLevel {
  if (stop.fixed) return 'booked_lock';
  return stop.nightsProvenance === 'assumed' ? 'sidequest_inferred' : 'user_explicit';
}

/** The stops that are places to sleep, in order. */
export function statedBeds(itinerary: Pick<StatedItinerary, 'stops'>): StatedStop[] {
  return itinerary.stops.filter((s) => !s.dayTrip && s.nights > 0);
}

export interface ContractStatedStay {
  stopId: string;
  label: string;
  nights: number;
  lock: LockLevel;
  provenance: StatedProvenance;
  fixed: boolean;
  dates: { start: string; end: string } | null;
  mustSee: string[];
  transportIn: StatedTransportMode | null;
  transportLock: LockLevel | null;
}

export interface ContractStatedItinerary {
  version: typeof STATED_ITINERARY_VERSION;
  stays: readonly ContractStatedStay[];
  dayTrips: readonly { label: string; mustSee: readonly string[] }[];
  /** Nights the stated stays add up to. */
  statedNights: number;
  parseConfidence: number;
  acceptedChanges: number;
}

export function contractStatedItinerary(itinerary: StatedItinerary): ContractStatedItinerary {
  const stays = statedBeds(itinerary).map((stop) => ({
    stopId: stop.id,
    label: stop.label,
    nights: stop.nights,
    lock: statedStopLock(stop),
    provenance: stop.nightsProvenance,
    fixed: stop.fixed,
    dates: stop.dates ?? null,
    mustSee: [...(stop.mustSee ?? [])],
    transportIn: stop.transportIn?.mode ?? null,
    transportLock: stop.transportIn ? (stop.transportIn.provenance === 'assumed' ? ('sidequest_inferred' as const) : ('user_explicit' as const)) : null,
  }));
  return {
    version: STATED_ITINERARY_VERSION,
    stays,
    dayTrips: itinerary.stops.filter((s) => s.dayTrip).map((s) => ({ label: s.label, mustSee: [...(s.mustSee ?? [])] })),
    statedNights: stays.reduce((n, s) => n + s.nights, 0),
    parseConfidence: itinerary.parseConfidence,
    acceptedChanges: itinerary.acceptedChanges?.length ?? 0,
  };
}

/** Plain sentences for the composition brief's MUST KEEP band. */
export function statedItineraryBands(stated: ContractStatedItinerary): string[] {
  const lines: string[] = [];
  if (stated.stays.length === 0) return lines;
  const held = stated.stays.filter((s) => s.lock !== 'sidequest_inferred');
  if (held.length > 0) {
    lines.push(`The traveller's own stays, in this order: ${stated.stays.map((s) => `${s.label} (${s.nights} night${s.nights === 1 ? '' : 's'}${s.lock === 'sidequest_inferred' ? ', Sidequest’s split' : s.fixed ? ', booked' : ''})`).join(', then ')}. Sleep where and for as long as they said; do not merge, drop or reorder these stays.`);
  }
  for (const s of stated.stays) if (s.transportIn && s.transportLock === 'user_explicit') lines.push(`They planned to reach ${s.label} by ${STATED_TRANSPORT_LABELS[s.transportIn]}.`);
  for (const s of stated.stays) if (s.mustSee.length > 0) lines.push(`At ${s.label} they want to see: ${s.mustSee.join(', ')}.`);
  for (const d of stated.dayTrips) lines.push(`A day trip they planned: ${d.label}.`);
  return lines;
}

/* ------------------------------------------------------------------ *
 * Honouring, checked afterwards
 * ------------------------------------------------------------------ */

/** Accent- and case-folded, punctuation as spaces: the comparison a label and a base name share. */
export function foldPlaceLabel(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** True when a planned base name is the stated place: equal after folding, or one contains the other as whole words. */
export function sameStatedPlace(label: string, baseName: string): boolean {
  const a = foldPlaceLabel(label);
  const b = foldPlaceLabel(baseName);
  if (!a || !b) return false;
  if (a === b) return true;
  /*
   * One containing the other as whole words ("Kyoto" in "Kyoto Higashiyama"),
   * but never a phrase that joins places ("Rome and Florence") and never a much
   * longer name, which is a different place that happens to share a word.
   */
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  const longWords = longer.split(' ');
  if (longWords.some((w) => w === 'and' || w === 'or' || w === 'to')) return false;
  if (longWords.length > shorter.split(' ').length + 2) return false;
  return ` ${longer} `.includes(` ${shorter} `);
}

export interface PlannedStay {
  baseName: string;
  nights: number;
}

/** Consecutive nights at the same base, from the nightly base names (the night of each day but the last). */
export function plannedStaysFromNights(nightlyBaseNames: readonly string[]): PlannedStay[] {
  const stays: PlannedStay[] = [];
  for (const name of nightlyBaseNames) {
    const last = stays[stays.length - 1];
    if (last && last.baseName === name) last.nights += 1;
    else stays.push({ baseName: name, nights: 1 });
  }
  return stays;
}

export interface StatedStayOutcome {
  stopId: string;
  label: string;
  statedNights: number;
  plannedNights: number;
  plannedBase: string | null;
  lock: LockLevel;
  outcome: 'honoured' | 'nights_changed' | 'not_slept' | 'reordered';
}

/**
 * Compare the planned stays with the stated ones. Every stated stay held at
 * `user_explicit` or above that the plan does not keep — not slept in, a
 * different number of nights, or out of the stated order — is a
 * `ContractConflict` with `contract_kept` resolution when Sidequest kept it
 * and `field_rejected` when it could not. Stays Sidequest split itself
 * (`sidequest_inferred`) are reported, never conflicts.
 */
export function statedStayConflicts(stated: ContractStatedItinerary, planned: readonly PlannedStay[], at: string): { outcomes: StatedStayOutcome[]; conflicts: ContractConflict[] } {
  const outcomes: StatedStayOutcome[] = [];
  const conflicts: ContractConflict[] = [];
  let cursor = 0;
  for (const stay of stated.stays) {
    const matches = planned.map((p, i) => ({ p, i })).filter(({ p }) => sameStatedPlace(stay.label, p.baseName));
    const nights = matches.reduce((n, { p }) => n + p.nights, 0);
    const first = matches[0];
    let outcome: StatedStayOutcome['outcome'] = 'honoured';
    if (!first) outcome = 'not_slept';
    else if (nights !== stay.nights) outcome = 'nights_changed';
    else if (first.i < cursor) outcome = 'reordered';
    if (first) cursor = Math.max(cursor, first.i);
    outcomes.push({ stopId: stay.stopId, label: stay.label, statedNights: stay.nights, plannedNights: nights, plannedBase: first?.p.baseName ?? null, lock: stay.lock, outcome });
    if (outcome === 'honoured' || stay.lock === 'sidequest_inferred') continue;
    const whose = stay.fixed ? 'booked' : 'stated';
    conflicts.push({
      field: `stated.stay.${stay.stopId}`,
      lock: stay.lock,
      contractValue: `${stay.label}: ${stay.nights} night${stay.nights === 1 ? '' : 's'}`,
      proposedValue: first ? `${first.p.baseName}: ${nights} night${nights === 1 ? '' : 's'}` : 'not slept in',
      resolution: 'field_rejected',
      detail:
        outcome === 'not_slept'
          ? `Your ${whose} ${stay.nights} night${stay.nights === 1 ? '' : 's'} in ${stay.label} could not be planned as a stay — we could not place a bed there, so the days around it are planned from the nearest base. Nothing about your plan was changed on purpose.`
          : outcome === 'nights_changed'
            ? `You ${whose === 'booked' ? 'booked' : 'gave'} ${stay.nights} night${stay.nights === 1 ? '' : 's'} in ${stay.label}; ${nights < stay.nights ? `the plan could only hold ${nights}` : `the plan gives it ${nights}, because a stay beside it could not be planned`}.`
            : `${stay.label} comes earlier in the plan than in yours; the order could not be kept.`,
      at,
    });
  }
  return { outcomes, conflicts };
}

/**
 * Fit the stated nights to the trip's length without touching what is held.
 * Assumed nights absorb the difference first (last stays first); if every
 * stay is held, nothing is changed and the mismatch is reported.
 */
export function fitStatedNights(stays: readonly Pick<ContractStatedStay, 'stopId' | 'nights' | 'lock'>[], tripNights: number): { nights: Map<string, number>; mismatch: number } {
  const nights = new Map(stays.map((s) => [s.stopId, s.nights] as const));
  let diff = tripNights - stays.reduce((n, s) => n + s.nights, 0);
  const flexible = [...stays].reverse().filter((s) => s.lock === 'sidequest_inferred');
  for (const s of flexible) {
    if (diff === 0) break;
    const current = nights.get(s.stopId)!;
    const next = Math.max(1, current + diff);
    diff -= next - current;
    nights.set(s.stopId, next);
  }
  return { nights, mismatch: diff };
}
