import { z } from 'zod';
import { transportModeSchema } from './access';
import { coordinatesSchema } from './common';
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
