import { z } from 'zod';
import { coordinatesSchema } from './common';
import { geoBoundsSchema } from './geography';
import { licenceIdSchema } from './licence';
import { destinationFeatureTypeSchema } from './destination-index';
import { planningRoleSchema, VISITABLE_ROLES, type PlanningRole } from './region-pack';

/**
 * WHAT IS ACTUALLY HERE, AND WHERE IT IS.
 *
 * The destination index answers "which place did you mean". It is a geographic
 * *identity* index built from division records, and Phase 11 proved it is very
 * good at that and structurally unable to answer the next question: **is there
 * anything to do here, and is it spread across the region or piled into one
 * city?**
 *
 * A live Kyrgyzstan compilation is the measurement that forced this file. It
 * reached a real itinerary — and twenty-four of its kept places were Bishkek
 * city venues, because the only thing the pipeline could count was *records*,
 * and records concentrate where commercial mapping is dense. That is a property
 * of the data, not of the country, and a product that inherits it uncorrected is
 * telling every traveller that every country is its largest city.
 *
 * So there is a second index beside the identity one:
 *
 * | Index | Keyed on | Answers |
 * | --- | --- | --- |
 * | `destination_index` | a division record | which place did you mean |
 * | **the profile** | a destination + release | what is here, in what roles, spread how |
 *
 * Three rules hold throughout, and each exists because breaking it is a specific
 * failure somebody could ship:
 *
 * 1. **A planning role is not a category.** A ferry terminal and a museum are
 *    both real, mapped, useful records. One of them is an attraction. Keeping
 *    the two vocabularies apart is what stops a car park being ranked as a thing
 *    to do *and* what stops it being thrown away when an outdoor day needs it.
 *    The roles are `PlanningRole` — the same ones the pack carries, not a second
 *    parallel vocabulary that could drift from it.
 * 2. **Nothing traveller-specific is ever stored here.** Exactly like the
 *    evidence store and the destination index, and for the same reason: a count
 *    that depended on who was asking could not be shared, and a cache that held
 *    one traveller's preferences would serve them to the next.
 * 3. **A profile is a measurement, not a judgement.** It counts what the source
 *    holds. Whether that is *enough* is `assessSupply`'s job; whether any of it
 *    is *good* is the evidence layer's. Collapsing the three is how "150
 *    candidates" came to mean a hundred and fifty populated places.
 */

/**
 * Counts by role.
 *
 * A partial record rather than a total one, because a total one would require
 * every profile to carry a zero for every role — including `administrative` and
 * `excluded`, which are never candidates — and because an absent role reads
 * correctly as "none of these here", which is what it means.
 */
export const roleCountsSchema = z.partialRecord(
  planningRoleSchema,
  z.number().int().nonnegative(),
);
export type RoleCounts = z.infer<typeof roleCountsSchema>;

/**
 * One geographic grouping inside a destination, with what it holds.
 *
 * The unit the whole anti-concentration mechanism operates on. A country is not
 * one place with a thousand records; it is a handful of areas with wildly
 * different densities, and the only defensible way to stop the densest one
 * absorbing the board is to count per area and cap per area.
 */
export const profileAreaSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  center: coordinatesSchema,
  /** Straight-line kilometres from the destination's principal gateway. */
  distanceFromGatewayKm: z.number().min(0).max(40_000),
  counts: roleCountsSchema.default({}),
  /** Distinct place categories represented. One category is not a day. */
  categoryCount: z.number().int().nonnegative(),
  /** Candidates eligible to anchor a day. The denominator supply is judged on. */
  anchorCount: z.number().int().nonnegative(),
  /** Whether anything here could plausibly be slept in. */
  hasBaseCandidate: z.boolean(),
  /**
   * Whether this area made the profile, and why not when it did not.
   *
   * An area is allowed to be excluded — most of a country's are — but never
   * *silently*. "We left four areas out" with no reason is indistinguishable
   * from a bug, and it is the thing a traveller would most reasonably ask about.
   */
  retained: z.boolean(),
  exclusionReason: z.string().min(1).optional(),
});
export type ProfileArea = z.infer<typeof profileAreaSchema>;

export const DESTINATION_PROFILE_VERSION = 1 as const;

/**
 * What was counted, so two profiles can be compared honestly.
 *
 * A profile built from division records and one built from a full place pack are
 * both useful and are not the same measurement — and a shortlist that ranked
 * them against each other without saying so would be rewarding whichever
 * destination happened to have been compiled before.
 */
export const PROFILE_BASES = ['division_records', 'place_records'] as const;
export const profileBasisSchema = z.enum(PROFILE_BASES);
export type ProfileBasis = z.infer<typeof profileBasisSchema>;

export const destinationProfileSchema = z.object({
  schemaVersion: z.literal(DESTINATION_PROFILE_VERSION),
  /** The destination index entry this describes. */
  destinationId: z.string().min(1),
  displayName: z.string().min(1),
  localName: z.string().min(1).optional(),
  qualifiedName: z.string().min(1),
  featureType: destinationFeatureTypeSchema,
  countryCode: z.string().length(2).optional(),
  hierarchy: z.array(z.string().min(1)).default([]),
  center: coordinatesSchema,
  bounds: geoBoundsSchema.optional(),

  /** What was counted. Decides whether two profiles are comparable. */
  basis: profileBasisSchema,
  /** The pinned catalogue release the records came from. */
  catalog: z.string().min(1),
  releaseId: z.string().min(1),

  areas: z.array(profileAreaSchema).default([]),
  /** Totals across retained areas only. Excluded ground is not supply. */
  counts: roleCountsSchema.default({}),
  categoryCount: z.number().int().nonnegative(),
  anchorCount: z.number().int().nonnegative(),
  baseCandidateCount: z.number().int().nonnegative(),

  /**
   * The share of visitable candidates sitting in the single densest area.
   *
   * 0–1, and the one number this whole file exists to make visible. A country
   * whose top area holds nine-tenths of its supply is a country the product
   * knows only one city of, and saying so is better than quietly planning it.
   *
   * Bounded on both sides deliberately: `z.number().nonnegative()` accepts
   * `Infinity`, which survives a `JSON.stringify` as `null` and fails to parse
   * on the way back out — a corruption that only shows up on read.
   */
  concentration: z.number().min(0).max(1),

  /** Share of retained candidates carrying a website. The research-lead rate. */
  websiteCoverage: z.number().min(0).max(1),
  /** Share carrying an open identifier. The cross-source-linking rate. */
  identityCoverage: z.number().min(0).max(1),

  /** Every licence any contributing record was published under. */
  licences: z.array(licenceIdSchema).default([]),
  attribution: z.array(z.string().min(1)).default([]),

  builtAt: z.string().min(1),
  /** Milliseconds the build took. Shown, because we promise it is bounded. */
  elapsedMs: z.number().min(0).max(3_600_000),
});
export type DestinationProfile = z.infer<typeof destinationProfileSchema>;

export function countInRole(counts: RoleCounts, role: PlanningRole): number {
  return counts[role] ?? 0;
}

/** Every candidate a traveller would choose between. */
export function visitableCount(counts: RoleCounts): number {
  return VISITABLE_ROLES.reduce((total, role) => total + countInRole(counts, role), 0);
}

/**
 * Where a profile stops describing a region and starts describing a city.
 *
 * A judgement with a stated threshold rather than a bare number, so the copy and
 * the ranking read the same rule. Seven-tenths is where a "regional" trip stops
 * being one: above it, more than two in three things worth doing are in one
 * place, and the honest description of that trip is a city break with
 * excursions.
 */
export const CONCENTRATION_CEILING = 0.7;

export function isSingleAreaHeavy(profile: DestinationProfile): boolean {
  const retained = profile.areas.filter((area) => area.retained).length;
  return retained > 1 && profile.concentration > CONCENTRATION_CEILING;
}

/**
 * How many distinct roles a profile actually holds.
 *
 * The diversity signal a shortlist reads. One role is not a trip however many
 * records it has: forty museums and nothing else is a day, repeated.
 */
export function roleDiversity(counts: RoleCounts): number {
  return VISITABLE_ROLES.filter((role) => countInRole(counts, role) > 0).length;
}
