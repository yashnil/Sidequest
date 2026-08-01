import { z } from 'zod';
import { httpUrlSchema, isoDateSchema } from './common';
import { factPathSchema, factVerificationStateSchema, resolvedFactSchema } from './source-fact';

/**
 * WHAT WE ESTABLISHED ABOUT A PLACE, as typed facts rather than prose.
 *
 * `Place` is what a place *is* — a category, an intensity, a duration. This is
 * what somebody published about it: when it opens, whether you must book, what
 * it costs, what is shut, what to bring. The two are separate because they have
 * different lifetimes and different truth conditions. A waterfall is a waterfall
 * for a century; its car park closes in November and reopens in April.
 *
 * Three properties hold throughout:
 *
 * - **Tri-state, never boolean.** `unknown` is a value, not a missing key. A
 *   `false` we invented and a `false` a park service published are different
 *   claims, and only one of them may keep somebody out of a plan.
 * - **Every claim names its fact.** `factId` points into the source manifest, so
 *   a card can show the page, the publisher and the date without the evidence
 *   being re-derived at render time.
 * - **Nothing here is a score.** There is no confidence number, because a number
 *   would have to be authored and nobody is entitled to author one.
 */

export const REGION_EVIDENCE_VERSION = 1 as const;

/** Yes, no, or nobody said. The third is not an absence — it is an answer. */
export const TRI_STATES = ['yes', 'no', 'unknown'] as const;
export const triStateSchema = z.enum(TRI_STATES);
export type TriState = z.infer<typeof triStateSchema>;

/**
 * One claim, with the fact behind it and the state we computed for it.
 *
 * `state` is never written by hand: it comes out of `evidence/resolve.ts`.
 */
export const evidenceClaimSchema = z.object({
  factId: z.string().min(1).optional(),
  state: factVerificationStateSchema,
  factPath: factPathSchema.optional(),
});
export type EvidenceClaim = z.infer<typeof evidenceClaimSchema>;

export const MONEY_UNITS = [
  'per_person',
  'per_vehicle',
  'per_group',
  'per_day',
  'per_reservation',
] as const;
export const moneyUnitSchema = z.enum(MONEY_UNITS);
export type MoneyUnit = z.infer<typeof moneyUnitSchema>;

export const MONEY_UNIT_LABELS: Record<MoneyUnit, string> = {
  per_person: 'per person',
  per_vehicle: 'per vehicle',
  per_group: 'per group',
  per_day: 'per day',
  per_reservation: 'per booking',
};

/**
 * A published price.
 *
 * `amount` and `maxAmount` rather than one number, because operators publish
 * bands ("£8–£14") far more often than a single figure, and collapsing a band to
 * its midpoint invents a price nobody charges.
 *
 * There is deliberately no way to express "free" here — that is a separate flag
 * on the cost record, because a missing price and a stated zero are the two
 * things this schema most needs to keep apart.
 */
export const moneySchema = z
  .object({
    currency: z.string().length(3),
    amount: z.number().min(0),
    maxAmount: z.number().min(0).optional(),
    unit: moneyUnitSchema,
    /** True when the figure is our reading of a range or a table, not a quote. */
    estimated: z.boolean().default(false),
    /** The source did not say whether tax and fees are included. */
    taxesUncertain: z.boolean().default(true),
  })
  .refine((value) => value.maxAmount === undefined || value.maxAmount >= value.amount, {
    message: 'A price range has to end at or above where it starts',
    path: ['maxAmount'],
  });
export type Money = z.infer<typeof moneySchema>;

export const COST_KINDS = ['admission', 'parking', 'transport', 'permit', 'tour'] as const;
export const costKindSchema = z.enum(COST_KINDS);
export type CostKind = z.infer<typeof costKindSchema>;

export const COST_KIND_LABELS: Record<CostKind, string> = {
  admission: 'Admission',
  parking: 'Parking',
  transport: 'Transport',
  permit: 'Permit',
  tour: 'Guided tour',
};

export const costEvidenceSchema = z
  .object({
    kind: costKindSchema,
    /** Only ever true when a source states it. A missing price is not free. */
    free: z.boolean().default(false),
    money: moneySchema.optional(),
    advancePurchaseRequired: triStateSchema.default('unknown'),
    note: z.string().min(1).max(200).optional(),
    claim: evidenceClaimSchema,
  })
  .refine((value) => !value.free || value.money === undefined, {
    message: 'Something free does not also have a price',
    path: ['money'],
  });
export type CostEvidence = z.infer<typeof costEvidenceSchema>;

/**
 * How hard a fact bites.
 *
 * The distinction the brief insists on and the one the planner branches on: a
 * `blocks` fact makes a candidate unschedulable, a `cautions` fact rides along
 * on the card and the itinerary, an `informs` fact is preparation.
 */
export const ADVISORY_SEVERITIES = ['blocks', 'cautions', 'informs'] as const;
export const advisorySeveritySchema = z.enum(ADVISORY_SEVERITIES);
export type AdvisorySeverity = z.infer<typeof advisorySeveritySchema>;

export const closureEvidenceSchema = z
  .object({
    /** As published, in one sentence. */
    statement: z.string().min(1).max(300),
    /** Dates the closure covers. Absent ends mean "until further notice". */
    from: isoDateSchema.optional(),
    to: isoDateSchema.optional(),
    severity: advisorySeveritySchema,
    claim: evidenceClaimSchema,
  })
  .refine((value) => value.from === undefined || value.to === undefined || value.to >= value.from, {
    message: 'A closure cannot end before it starts',
    path: ['to'],
  });
export type ClosureEvidence = z.infer<typeof closureEvidenceSchema>;

/**
 * A dated, sourced safety or preparation statement.
 *
 * Never a risk score, never a crime inference, never a claim about a person's
 * health. `appliesTo` exists because "the north rim road is icy" is about a
 * road, not about a region, and a caution shown against the wrong subject is
 * noise that teaches people to stop reading cautions.
 */
export const safetyEvidenceSchema = z.object({
  statement: z.string().min(1).max(300),
  severity: advisorySeveritySchema,
  /** Free text naming what it covers: a trail, a road, a season. */
  appliesTo: z.string().min(1).max(120).optional(),
  /** Kit or preparation the source explicitly names. */
  requires: z.array(z.string().min(1).max(80)).max(6).default([]),
  claim: evidenceClaimSchema,
});
export type SafetyEvidence = z.infer<typeof safetyEvidenceSchema>;

export const bookingEvidenceSchema = z.object({
  reservationRequired: triStateSchema.default('unknown'),
  timedEntry: triStateSchema.default('unknown'),
  permitRequired: triStateSchema.default('unknown'),
  guideRequired: triStateSchema.default('unknown'),
  /** How far ahead the operator says to book. Only ever from a source. */
  leadTimeDays: z.number().int().min(0).max(365).optional(),
  bookingUrl: httpUrlSchema.optional(),
  note: z.string().min(1).max(200).optional(),
  claim: evidenceClaimSchema,
});
export type BookingEvidence = z.infer<typeof bookingEvidenceSchema>;

export const placeEvidenceSchema = z.object({
  /** A place id or a food venue id. Evidence does not care which. */
  subjectId: z.string().min(1),
  /** The operator's own page, where one was established. */
  officialUrl: httpUrlSchema.optional(),
  officialUrlClaim: evidenceClaimSchema.optional(),
  /** Names the same thing goes by, harvested from structured sources. */
  aliases: z.array(z.string().min(1).max(120)).max(6).default([]),
  /** The larger site this belongs to, where one was established. */
  parentSubjectId: z.string().min(1).optional(),
  booking: bookingEvidenceSchema.optional(),
  costs: z.array(costEvidenceSchema).max(8).default([]),
  closures: z.array(closureEvidenceSchema).max(6).default([]),
  safety: z.array(safetyEvidenceSchema).max(8).default([]),
  /** Minutes the operator suggests allowing. Distinct from our own estimate. */
  suggestedDurationMinutes: z.number().int().min(5).max(1440).optional(),
  suggestedDurationClaim: evidenceClaimSchema.optional(),
  /** Every path we resolved for this subject, including the unknowns. */
  resolved: z.array(resolvedFactSchema).default([]),
});
export type PlaceEvidence = z.infer<typeof placeEvidenceSchema>;

export const regionEvidenceSchema = z.object({
  version: z.literal(REGION_EVIDENCE_VERSION),
  places: z.array(placeEvidenceSchema).default([]),
  /** Region-wide facts: an advisory, a seasonal road, a festival week. */
  regionSafety: z.array(safetyEvidenceSchema).max(12).default([]),
});
export type RegionEvidence = z.infer<typeof regionEvidenceSchema>;

export function evidenceFor(
  evidence: RegionEvidence | undefined,
  subjectId: string,
): PlaceEvidence | undefined {
  return evidence?.places.find((entry) => entry.subjectId === subjectId);
}

/**
 * Whether anything here is worth a traveller's attention before they leave.
 *
 * Used to decide whether a card gets an evidence section at all — an evidence
 * panel that opens onto "nothing known" is worse than no panel.
 */
export function hasActionableEvidence(evidence: PlaceEvidence | undefined): boolean {
  if (!evidence) return false;
  return (
    evidence.closures.length > 0 ||
    evidence.safety.length > 0 ||
    evidence.costs.length > 0 ||
    evidence.officialUrl !== undefined ||
    (evidence.booking !== undefined &&
      (evidence.booking.reservationRequired === 'yes' ||
        evidence.booking.permitRequired === 'yes' ||
        evidence.booking.timedEntry === 'yes' ||
        evidence.booking.guideRequired === 'yes'))
  );
}
