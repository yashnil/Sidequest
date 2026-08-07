import { z } from 'zod';
import { transportModeSchema } from './access';
import { coordinatesSchema } from './common';
import { TRIP_SCOPE_CONTRACT_VERSION } from './containment';
import {
  confidenceAssessmentSchema,
  destinationEntityTypeSchema,
  geoBoundsSchema,
  scopeBreadthSchema,
  scopeShapeSchema,
} from './geography';

/**
 * The ground a trip covers, after the traveller has agreed to it.
 *
 * This is the contract between "what did they mean" and "what are we going to
 * spend money compiling". Everything expensive downstream is bounded by it, so
 * it is confirmed by a human before any of that happens — not because the
 * interpretation is likely to be wrong, but because being wrong here is the one
 * failure the traveller cannot see afterwards.
 */

export const GATEWAY_KINDS = ['airport', 'rail_station', 'ferry_port', 'road_entry', 'other'] as const;
export const gatewayKindSchema = z.enum(GATEWAY_KINDS);
export type GatewayKind = z.infer<typeof gatewayKindSchema>;

export const GATEWAY_ROLES = ['arrival', 'departure', 'both'] as const;
export const gatewayRoleSchema = z.enum(GATEWAY_ROLES);
export type GatewayRole = z.infer<typeof gatewayRoleSchema>;

export const gatewaySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: gatewayKindSchema,
  role: gatewayRoleSchema,
  coordinates: coordinatesSchema.optional(),
  /** True only when the traveller said so. An inferred gateway is not fixed. */
  fixed: z.boolean().default(false),
});
export type Gateway = z.infer<typeof gatewaySchema>;

export const namedAreaSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  center: coordinatesSchema.optional(),
  note: z.string().min(1).optional(),
});
export type NamedArea = z.infer<typeof namedAreaSchema>;

/**
 * What the traveller can get around on here, as an assumption rather than a fact.
 *
 * `carAvailable` is a nullable boolean and the null is the point: "we have not
 * established whether a car is on the table" is a different state from "no car",
 * and treating the two the same is how a plan quietly becomes undrivable or
 * quietly becomes a car trip for someone who cannot drive.
 */
export const transportAssumptionsSchema = z.object({
  primaryMode: transportModeSchema,
  allowedModes: z.array(transportModeSchema).min(1),
  carAvailable: z.boolean().nullable(),
  /** Ferries, small planes, anything that can be cancelled by weather. */
  acceptsWaterOrAirTransfers: z.boolean().nullable(),
  /** Where the assumption came from, so a wrong one can be traced. */
  basis: z.enum(['profile', 'clarification', 'region_evidence', 'default']),
  note: z.string().min(1),
});
export type TransportAssumptions = z.infer<typeof transportAssumptionsSchema>;

export const GEOGRAPHIC_SCOPE_VERSION = 1 as const;

export const geographicScopeSchema = z.object({
  schemaVersion: z.literal(GEOGRAPHIC_SCOPE_VERSION),
  /**
   * Bumped whenever the traveller changes anything on this screen. Compiled
   * regions record which scope version produced them, so a plan can never be
   * silently attributed to a scope it was not built from.
   */
  revision: z.number().int().min(1),

  /** The interpretation this scope was built from. */
  destinationCandidateId: z.string().min(1),
  destinationName: z.string().min(1),
  destinationEntityType: destinationEntityTypeSchema,
  breadth: scopeBreadthSchema,
  center: coordinatesSchema,
  bounds: geoBoundsSchema.optional(),
  /**
   * WHETHER `shape` IS A BORDER OR A CIRCLE DRAWN AROUND A POINT.
   *
   * Measured, and load-bearing. Every city, town, county and district in the
   * destination index publishes a centre and **no polygon** — 12,080 of 12,080
   * cities, 53,542 of 53,542 towns — so `deriveShape` falls through to a radius
   * for very nearly every trip anybody takes.
   *
   * A layer that reads that circle as a border admits whatever the circle
   * happened to cover. That is exactly what happened to a five-night New York
   * trip: a 168 km reach circle, a partition drawn around it, and a Pennsylvania
   * county 166 km away accepted as New York. Saying which of the two this is
   * lets a consumer refuse to use it as a boundary.
   *
   * Defaulted, so a stored scope written before this existed still parses — as
   * `reach_circle`, which is the truthful reading of a scope whose provenance we
   * cannot establish.
   */
  boundaryEvidence: z
    .enum(['published_boundary', 'measured_extent', 'reach_circle'])
    .default('reach_circle'),
  /**
   * The destination's own published extent, **unclipped**.
   *
   * `deriveShape` intersects a published boundary with the trip's reach, which
   * is the right call for deciding what to compile and the wrong one for
   * deciding what belongs: the clipped box is smaller than the boundary, so it
   * can confirm membership and can never refute it. Kept alongside the clipped
   * shape rather than instead of it.
   */
  administrativeBoundary: geoBoundsSchema.optional(),
  /**
   * What the destination *is*, administratively.
   *
   * Straight off the index entry, which has held it all along. Containment's
   * strongest usable rung compares a record's own country and region against the
   * destination's; without this it has to resolve the destination by looking its
   * centre back up in a divisions layer — a round trip for a fact we already
   * had, and one unavailable to any caller without that layer.
   */
  administrative: z
    .object({
      countryCode: z.string().length(2).optional(),
      /** ISO 3166-2. A code, and the only region value that compares reliably. */
      regionCode: z.string().min(1).optional(),
      regionName: z.string().min(1).optional(),
      localityName: z.string().min(1).optional(),
      /** Other spellings of *this entity*. Compared only at its own level. */
      aliases: z.array(z.string().min(1)).default([]),
      /**
       * The published hierarchy, flat and unlevelled.
       *
       * Kept, and deliberately never poured into a level: the two producers
       * order it differently and one of them flattens country, state, county and
       * city into it, so a country's name would land in the region accept-set.
       * It corroborates; it cannot refuse. See `schemas/geographic-evidence.ts`.
       */
      hierarchy: z.array(z.string().min(1)).default([]),
      divisionIds: z.array(z.string().min(1)).default([]),
    })
    .default({ hierarchy: [], divisionIds: [], aliases: [] }),
  /**
   * How far the trip can actually reach, kept as its own number.
   *
   * Deriving it back out of `shape` gives the wrong answer for a bounds-shaped
   * scope, because that shape has already been clipped *to* reach — so the
   * derived figure is the smaller of boundary and reach, and a legitimate
   * gateway just beyond the boundary falls outside it. Reach bounds spending and
   * gateway candidacy; membership is a different question with a different
   * number.
   */
  reachRadiusKm: z.number().positive().optional(),
  countryCode: z.string().length(2).optional(),
  /**
   * Plural, and never collapsed to one. A scope spanning a zone boundary is
   * common — most of Europe, any US Mountain/Pacific border region — and taking
   * the first entry as "the trip's timezone" is how a shuttle timetable moves by
   * an hour.
   */
  timeZones: z.array(z.string().min(1)).min(1),

  shape: scopeShapeSchema,
  includedAreas: z.array(namedAreaSchema).default([]),
  excludedAreas: z.array(namedAreaSchema).default([]),
  gateways: z.array(gatewaySchema).default([]),

  transport: transportAssumptionsSchema,
  /** Zero means one base for the whole trip. */
  maxBaseChanges: z.number().int().min(0).max(10),
  nights: z.number().int().min(0).max(30),

  /** Why the scope is this and not something wider or narrower. Shown, not logged. */
  rationale: z.string().min(1),
  confidence: confidenceAssessmentSchema,
  /** Answers that shaped this scope, so the screen can explain itself. */
  decidedBy: z
    .array(z.object({ questionId: z.string().min(1), values: z.array(z.string().min(1)) }))
    .default([]),
  confirmedByUser: z.boolean(),
  confirmedAt: z.string().min(1).optional(),
});
export type GeographicScope = z.infer<typeof geographicScopeSchema>;

/**
 * A stable identity for "this scope, at this revision".
 *
 * Cache keys and compiled-region provenance both key off it. Deliberately not a
 * hash of the whole object: the rationale text is allowed to change without
 * invalidating a compilation, and the fields below are the ones that actually
 * change what gets compiled.
 */
export function scopeFingerprint(scope: GeographicScope): string {
  const shape =
    scope.shape.kind === 'radius'
      ? `radius:${round(scope.shape.center.lat)},${round(scope.shape.center.lng)},${round(scope.shape.radiusKm)}`
      : scope.shape.kind === 'bounds'
        ? `bounds:${round(scope.shape.bounds.southWest.lat)},${round(scope.shape.bounds.southWest.lng)},${round(scope.shape.bounds.northEast.lat)},${round(scope.shape.bounds.northEast.lng)}`
        : scope.shape.kind === 'corridor'
          ? `corridor:${scope.shape.waypoints.map((point) => `${round(point.lat)},${round(point.lng)}`).join('|')}:${round(scope.shape.corridorWidthKm)}`
          : `areas:${[...scope.shape.areas]
              .map((area) => `${area.id}@${round(area.center.lat)},${round(area.center.lng)},${round(area.radiusKm)}`)
              .sort()
              .join('|')}`;

  return [
    `v${GEOGRAPHIC_SCOPE_VERSION}`,
    `r${scope.revision}`,
    scope.destinationCandidateId,
    scope.breadth,
    shape,
    /*
     * A scope that changed from a circle to a boundary compiles differently, so
     * it must not reuse the circle's artifact. Without this, gaining real
     * geometry for a destination would silently serve the old, wider result.
     */
    `edge:${scope.boundaryEvidence}`,
    /*
     * The containment contract this artifact was decided under.
     *
     * A scoped artifact is a set of *verdicts*, and a verdict means whatever the
     * contract that produced it meant. Without this segment, changing what
     * `membership_unknown` is allowed to do would leave every stored artifact
     * claiming the new meaning while carrying the old one — which is exactly how
     * a contaminated compiled region kept rendering after the pack that produced
     * it had been invalidated three ways over.
     */
    `contract:${TRIP_SCOPE_CONTRACT_VERSION}`,
    `in:${[...scope.includedAreas.map((area) => area.id)].sort().join(',')}`,
    `ex:${[...scope.excludedAreas.map((area) => area.id)].sort().join(',')}`,
    `mode:${scope.transport.primaryMode}`,
    `modes:${[...scope.transport.allowedModes].sort().join(',')}`,
    `car:${String(scope.transport.carAvailable)}`,
    `bases:${scope.maxBaseChanges}`,
    `nights:${scope.nights}`,
  ].join('/');
}

function round(value: number): string {
  return value.toFixed(4);
}

/** The centre a radius-shaped scope has, or the middle of whatever shape it is. */
export function scopeCenter(scope: GeographicScope): { lat: number; lng: number } {
  const shape = scope.shape;
  if (shape.kind === 'radius') return shape.center;
  if (shape.kind === 'bounds') {
    return {
      lat: (shape.bounds.southWest.lat + shape.bounds.northEast.lat) / 2,
      lng: (shape.bounds.southWest.lng + shape.bounds.northEast.lng) / 2,
    };
  }
  if (shape.kind === 'corridor') {
    const midpoint = shape.waypoints[Math.floor(shape.waypoints.length / 2)];
    return midpoint ?? scope.center;
  }
  const first = shape.areas[0];
  return first?.center ?? scope.center;
}
