import { z } from 'zod';
import { coordinatesSchema } from './common';
import { destinationFeatureTypeSchema } from './destination-index';

/**
 * WHERE SHOULD I GO — ANSWERED FROM A CANDIDATE SET, NOT FROM A MODEL.
 *
 * The mode has existed in the schema since Phase 7 and has never had a code
 * path. What made it buildable is that the pieces it needs now exist and are all
 * deterministic: a 109,853-entry destination index, climate normals, a region
 * portfolio, a duration model and a supply verdict. None of them is a model
 * call, and that is the whole design.
 *
 * The division of labour, stated so it cannot drift:
 *
 * | Layer | May decide |
 * | --- | --- |
 * | the index | which destinations exist at all |
 * | this file | how well each one fits, and in what order |
 * | a model | how to say it, once the order is already fixed |
 *
 * A model may not add a destination, remove one, change a number, reorder the
 * list, or assert a fact about anywhere. It receives a finished record and
 * returns prose. An architecture test holds the ranking module to that.
 *
 * ---
 *
 * THE ONE IDEA THIS FILE IS BUILT AROUND: **unknown is not zero.**
 *
 * Every scorer that came before this one collapsed the two. `scorePlace` gives
 * `seasonFit = 0` for a place that is closed and `0` for a place whose season
 * nobody published; `recommendDateWindows` refuses wholesale rather than per
 * dimension. At place scale that is survivable, because a place we know nothing
 * about is genuinely a worse suggestion. At *destination* scale it is not:
 * climate coverage is uneven, and a rule that scored "we could not reach the
 * archive" the same as "it is forty degrees and raining" would systematically
 * recommend the places our data happens to be good about.
 *
 * So a dimension is a `Measure`, unknown weight is **removed from the
 * denominator** rather than scored, and `coverage` — how much of the nominal
 * weight was actually measured — travels beside the score and gates the band. A
 * destination scored on two-fifths of the weight and one scored on nine-tenths
 * can both reach eighty-two, and `coverage` is what stops them being presented
 * as the same answer.
 */

// ---------------------------------------------------------------------------
// Measures
// ---------------------------------------------------------------------------

/**
 * Why a dimension could not be measured.
 *
 * A closed set, because each one has a different remedy and a different
 * sentence. "We did not ask" is a budget decision and is ours to fix; "nobody
 * publishes this" is the world's and never will be.
 */
export const UNKNOWN_REASONS = [
  /** No climate record exists for this point. */
  'no_climate_record',
  /** The archive did not answer. Ours to retry, not a fact about the place. */
  'climate_provider_unavailable',
  /** Deliberately not requested, to stay inside the budget. A cost, stated. */
  'not_requested',
  /** The index holds nothing here, which is a gap in us rather than in the world. */
  'no_index_coverage',
  /** The traveller has not said, and nothing may be assumed on their behalf. */
  'traveller_did_not_say',
  /** Nobody sources this. Crowds, prices, events. Permanent. */
  'not_sourced',
] as const;
export const unknownReasonSchema = z.enum(UNKNOWN_REASONS);
export type UnknownReason = z.infer<typeof unknownReasonSchema>;

export const UNKNOWN_REASON_COPY: Record<UnknownReason, string> = {
  no_climate_record: 'There are no climate records for this place.',
  climate_provider_unavailable: 'Our climate source did not answer, so we left this out of the score.',
  not_requested: 'We did not look this up for every candidate — only for the ones near the top.',
  no_index_coverage: 'Our place index does not cover this yet.',
  traveller_did_not_say: 'You have not told us, and we would rather not assume.',
  not_sourced: 'Nobody publishes this in a form we would stand behind.',
};

/**
 * One dimension's answer, or an honest absence.
 *
 * `min(0).max(1)` rather than `nonnegative()` deliberately: Zod rejects `NaN`
 * and accepts `Infinity`, an `Infinity` survives `JSON.stringify` as `null`, and
 * the row then fails to parse on the way back out — a corruption that only
 * appears on read, long after the write that caused it.
 */
export const measureSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('measured'),
    value: z.number().min(0).max(1),
    /** What the number came from, in one clause. Rendered. */
    basis: z.string().min(1),
  }),
  z.object({
    kind: z.literal('unknown'),
    reason: unknownReasonSchema,
  }),
]);
export type Measure = z.infer<typeof measureSchema>;

export function measured(value: number, basis: string): Measure {
  return { kind: 'measured', value: Math.min(1, Math.max(0, value)), basis };
}

export function unknown(reason: UnknownReason): Measure {
  return { kind: 'unknown', reason };
}

// ---------------------------------------------------------------------------
// Dimensions
// ---------------------------------------------------------------------------

/**
 * What a destination is scored on.
 *
 * Every one is computable from something already in this codebase, and none is
 * a proxy for fame. Population and cartographic prominence are deliberately
 * **absent**: they are the Denali-versus-Delhi defect at destination scale, and
 * the rule that fixed it there — prominence is evidence about a place, never
 * about whether it is the place somebody wants — holds here identically.
 */
export const RANK_DIMENSIONS = [
  /** Do the months they can travel suit being here? */
  'climateFit',
  /** Will there be enough daylight to use the days? */
  'daylightFit',
  /** Does the trip they have fit the ground this covers? */
  'durationFit',
  /** Does the number of bases it needs match how often they will move? */
  'structureFit',
  /** Is there enough here to build their days from? */
  'supplyFit',
  /** Is there more than one kind of thing to do? */
  'varietyFit',
  /** Do the things here match what they came for? */
  'themeFit',
  /** Does it work with how they intend to get around? */
  'transportFit',
] as const;
export const rankDimensionSchema = z.enum(RANK_DIMENSIONS);
export type RankDimension = z.infer<typeof rankDimensionSchema>;

export const RANK_DIMENSION_LABELS: Record<RankDimension, string> = {
  climateFit: 'Weather at that time of year',
  daylightFit: 'Daylight',
  durationFit: 'Fits your trip length',
  structureFit: 'Number of bases',
  supplyFit: 'Enough to do',
  varietyFit: 'Variety',
  themeFit: 'Matches what you came for',
  transportFit: 'Getting around',
};

/**
 * Nominal weights.
 *
 * They sum to one, and the sum is load-bearing rather than cosmetic: `coverage`
 * is measured weight over nominal weight, so a table that did not sum to one
 * would report a coverage nobody could interpret.
 */
export const RANK_WEIGHTS: Record<RankDimension, number> = {
  climateFit: 0.24,
  daylightFit: 0.08,
  durationFit: 0.18,
  structureFit: 0.1,
  supplyFit: 0.16,
  varietyFit: 0.08,
  themeFit: 0.12,
  transportFit: 0.04,
};

export const rankFactorSchema = z.object({
  id: rankDimensionSchema,
  label: z.string().min(1),
  weight: z.number().min(0).max(1),
  measure: measureSchema,
  /** `weight × value`, or zero when unknown — in which case the weight is dropped. */
  contribution: z.number().min(0).max(1),
});
export type RankFactor = z.infer<typeof rankFactorSchema>;

// ---------------------------------------------------------------------------
// Exclusions and conflicts
// ---------------------------------------------------------------------------

/**
 * The complete list of reasons a destination may be removed outright.
 *
 * Four, and it is a closed enum precisely so that adding a fifth is a decision
 * somebody makes rather than a condition that accretes. Every one is backed by a
 * measured number, and every one is a statement about the *trip* being
 * impossible rather than about the destination being unappealing.
 *
 * What is deliberately **not** here: airfare, visas, border rules, lodging
 * prices, crowd levels and safety. The product has no sourced data for any of
 * them, and a hard filter on an unsourced dimension is the most damaging thing
 * this file could contain — it would remove destinations for reasons nobody
 * could check and we could not defend.
 */
export const EXCLUSION_CODES = [
  /** Every month they can travel is outside a limit they explicitly stated. */
  'climate_conflicts_with_stated_limit',
  /** The index covers this ground and found nowhere to sleep in it. */
  'nowhere_to_stay',
  /** Their trip is less than half the shortest one this ground supports. */
  'far_too_short_for_this_ground',
  /** They named it in what they wanted to avoid, on an exact match. */
  'traveller_ruled_it_out',
] as const;
export const exclusionCodeSchema = z.enum(EXCLUSION_CODES);
export type ExclusionCode = z.infer<typeof exclusionCodeSchema>;

export const exclusionSchema = z.object({
  code: exclusionCodeSchema,
  /** One sentence, with the number that produced it. */
  message: z.string().min(1),
});
export type Exclusion = z.infer<typeof exclusionSchema>;

/**
 * Something that is wrong with this suggestion and does not disqualify it.
 *
 * Its own vocabulary rather than a free-text list because a conflict is
 * actionable — each one names a thing the traveller could change — and a list of
 * sentences cannot be turned into a control.
 */
export const CONFLICT_CODES = [
  'dates_outside_the_best_months',
  'shape_needs_more_nights',
  'assumed_no_car',
  'concentrated_in_one_area',
] as const;
export const conflictCodeSchema = z.enum(CONFLICT_CODES);
export type ConflictCode = z.infer<typeof conflictCodeSchema>;

export const conflictSchema = z.object({
  code: conflictCodeSchema,
  message: z.string().min(1),
});
export type Conflict = z.infer<typeof conflictSchema>;

// ---------------------------------------------------------------------------
// The ranked destination
// ---------------------------------------------------------------------------

export const RANK_BANDS = ['strong_match', 'worth_a_look', 'possible', 'thin_evidence'] as const;
export const rankBandSchema = z.enum(RANK_BANDS);
export type RankBand = z.infer<typeof rankBandSchema>;

export const RANK_BAND_LABELS: Record<RankBand, string> = {
  strong_match: 'Strong match',
  worth_a_look: 'Worth a look',
  possible: 'Possible',
  thin_evidence: 'Not enough to judge',
};

export const rankedDestinationSchema = z.object({
  /** The index entry. Never invented: a model has no way to put a name here. */
  entryId: z.string().min(1),
  releaseId: z.string().min(1),
  displayName: z.string().min(1),
  localName: z.string().min(1).optional(),
  qualifiedName: z.string().min(1),
  featureType: destinationFeatureTypeSchema,
  center: coordinatesSchema,
  countryCode: z.string().length(2).optional(),

  /** 0–100 over the **measured** weight only. Shown as a band, never as a number. */
  score: z.number().min(0).max(100),
  /** Share of the nominal weight that was actually measured. Gates the band. */
  coverage: z.number().min(0).max(1),
  band: rankBandSchema,

  factors: z.array(rankFactorSchema).default([]),
  conflicts: z.array(conflictSchema).default([]),
  /** Rendered, never omitted. The dimensions we could not see at all. */
  unknowns: z.array(z.string().min(1)).default([]),
  /** Deterministic and sourced. A model may rephrase these and nothing else. */
  reasons: z.array(z.string().min(1)).default([]),
  tradeoffs: z.array(z.string().min(1)).default([]),

  /** Nights this ground actually supports, when the model could say. */
  suggestedNights: z.number().int().min(1).max(60).optional(),
  suggestedBases: z.number().int().min(1).max(10).optional(),
});
export type RankedDestination = z.infer<typeof rankedDestinationSchema>;

export const DESTINATION_SHORTLIST_VERSION = 1 as const;
/** Bumping this invalidates every stored shortlist, by design. */
export const DESTINATION_RANKER_VERSION = 'ranker/2026-08-03.1';

export const destinationShortlistSchema = z.object({
  schemaVersion: z.literal(DESTINATION_SHORTLIST_VERSION),
  rankerVersion: z.string().min(1),
  /**
   * Everything the ranking depended on, as one string.
   *
   * Built like `scopeFingerprint` — an explicit field list rather than a hash of
   * a whole object — so that adding a field to the composer does not silently
   * invalidate every stored shortlist, and so that a change which *should*
   * invalidate them is a visible edit to one function.
   */
  inputKey: z.string().min(1),
  picks: z.array(rankedDestinationSchema).default([]),
  /** How many candidates the ranking actually scored. */
  considered: z.number().int().nonnegative(),
  /**
   * Removed, and why.
   *
   * Returned rather than dropped: a silently shortened list teaches nothing, and
   * an exclusion the traveller disagrees with is one they can act on only if
   * they can see it.
   */
  excluded: z
    .array(
      z.object({
        entryId: z.string().min(1),
        displayName: z.string().min(1),
        exclusion: exclusionSchema,
      }),
    )
    .default([]),
  /**
   * What the ranking could not see at all.
   *
   * Named at the top level rather than per candidate, because these are
   * properties of the *method* — a whole class of destination the index does not
   * hold, a dimension nobody sources — and repeating them on eight cards would
   * teach people to skip them.
   */
  blindSpots: z.array(z.string().min(1)).default([]),
  /** How diversity changed the order, when it did. */
  diversityNote: z.string().min(1).optional(),
  builtAt: z.string().min(1),
  elapsedMs: z.number().min(0).max(3_600_000),
  /** Climate lookups this shortlist cost. Shown, because it is a real cost. */
  climateRequests: z.number().int().nonnegative(),
});
export type DestinationShortlist = z.infer<typeof destinationShortlistSchema>;

/**
 * How many suggestions is a useful number.
 *
 * Five to eight. Below five a shortlist is a verdict rather than a choice; above
 * eight nobody reads the last ones, and the ones they do read are diluted by the
 * ones they do not.
 */
export const MIN_SHORTLIST = 5;
export const MAX_SHORTLIST = 8;
