import { z } from 'zod';
import { coordinatesSchema } from './common';
import { supplyAssessmentSchema } from './supply';

/**
 * THE CHEAP ANSWER, BEFORE THE EXPENSIVE ONE.
 *
 * Everything in here is produced from data already held — the destination index
 * and one climate request — in seconds rather than minutes, and none of it
 * involves a model, a page fetch or a router. That is the whole point: the
 * traveller finds out whether the system understands their trip *before* they
 * are asked to wait for it.
 *
 * Persisted as one blob rather than five columns because it is written and read
 * as a unit, and because a half-updated preflight (new portfolio, old supply
 * verdict) would be a screen disagreeing with itself.
 *
 * Nothing here is evidence. Every distance is a straight-line estimate, every
 * climate number is a normal rather than a forecast, and every cluster is a
 * grouping of index records rather than a researched place. The schema carries
 * `estimated: true` on the fields where somebody might forget that.
 */

export const preflightClusterSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  center: coordinatesSchema,
  memberCount: z.number().int().nonnegative(),
  memberNames: z.array(z.string().min(1)).default([]),
  distanceFromGatewayKm: z.number().nonnegative(),
  /** Straight-line over an assumed speed. Never a routed time. */
  transferMinutesFromGateway: z.number().nonnegative(),
});
export type PreflightCluster = z.infer<typeof preflightClusterSchema>;

export const preflightPortfolioSchema = z.object({
  gateway: z.object({ name: z.string().min(1), center: coordinatesSchema }).nullable(),
  route: z.array(preflightClusterSchema).default([]),
  excluded: z
    .array(z.object({ cluster: preflightClusterSchema, reason: z.string().min(1) }))
    .default([]),
  basesProposed: z.number().int().nonnegative(),
  transferDays: z.number().nonnegative(),
  mode: z.enum(['drive', 'transit', 'walk']),
  rationale: z.string().min(1),
  /** Present so nothing downstream can mistake these figures for measurements. */
  estimated: z.literal(true),
});
export type PreflightPortfolio = z.infer<typeof preflightPortfolioSchema>;

export const dateWindowSchema = z.object({
  month: z.number().int().min(1).max(12),
  year: z.number().int(),
  label: z.string().min(1),
  score: z.number().min(0).max(1),
  reasons: z.array(z.string()).default([]),
  tradeoffs: z.array(z.string()).default([]),
  unknowns: z.array(z.string()).default([]),
  climate: z.object({
    temperature: z.object({ low: z.number(), high: z.number() }),
    daylightHours: z.number(),
    wetDays: z.number(),
    snowDays: z.number(),
  }),
  evidenceNote: z.string().min(1),
});

export const dateGuidanceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('recommended'),
    windows: z.array(dateWindowSchema),
    sampleYearFrom: z.number().int(),
    sampleYearTo: z.number().int(),
    attribution: z.string().min(1),
    attributionUrl: z.string().optional(),
  }),
  z.object({ kind: z.literal('unavailable'), note: z.string().min(1) }),
]);

export const durationOptionSchema = z.object({
  minNights: z.number().int().min(1),
  maxNights: z.number().int().min(1),
  bases: z.number().int().min(1),
  label: z.string().min(1),
  covers: z.string(),
  tradeoff: z.string(),
  clustersReached: z.number().int().nonnegative(),
  transferDays: z.number().nonnegative(),
  recommended: z.boolean(),
});

export const durationGuidanceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('recommended'),
    options: z.array(durationOptionSchema),
    clusterCount: z.number().int().nonnegative(),
    basis: z.string().min(1),
  }),
  z.object({ kind: z.literal('unavailable'), note: z.string().min(1) }),
]);

export const scopeStrategySchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  detail: z.string().min(1),
  bases: z.number().int().min(1),
  covers: z.array(z.string()).default([]),
  available: z.boolean(),
  unavailableReason: z.string().optional(),
});

export const TRIP_PREFLIGHT_VERSION = 1 as const;

export const tripPreflightSchema = z.object({
  schemaVersion: z.literal(TRIP_PREFLIGHT_VERSION),
  /** The destination this preflight describes, so a stale one can be spotted. */
  destinationKey: z.string().min(1),
  portfolio: preflightPortfolioSchema.nullable(),
  strategies: z.array(scopeStrategySchema).default([]),
  dates: dateGuidanceSchema.nullable(),
  duration: durationGuidanceSchema.nullable(),
  /** Supply as far as the index can judge it, before any pack is built. */
  supply: supplyAssessmentSchema.nullable(),
  builtAt: z.string().min(1),
  /** Milliseconds the whole preflight took. Shown, because we promise it is fast. */
  elapsedMs: z.number().nonnegative(),
});
export type TripPreflight = z.infer<typeof tripPreflightSchema>;
