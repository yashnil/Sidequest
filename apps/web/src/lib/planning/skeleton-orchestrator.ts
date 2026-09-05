import 'server-only';
import { classifyNominatim, geocode, osmElementId, reverseGeocode } from '../providers/nominatim';
import { fetchSettlements, isPoiProviderEnabled, normalizeSettlement, type BoundingBox } from '../providers/overpass';
import { createOpenProviders } from '../providers/live';
import { getProfile, getTrip } from '../db/repository';
import { resolveTripRegion, boardFor } from '../region';
import {
  planFromSkeleton,
  type BaseResolutionScope,
  type GeocodedLocality,
  type RouteFailureReason,
  type RouteMatrixResult,
  type SkeletonPlanResult,
  type SubregionGeometry,
} from './skeleton-adapter';

import type { CompiledRegion } from '@sidequest/core';
import type { TripSkeleton } from '@/lib/benchmark/baseline/skeleton';
import type { SkeletonEvidencePacket } from '@/lib/benchmark/baseline/skeleton-packet';

/**
 * THE PRODUCTION CALLER BOUNDARY — WHERE A VALIDATED TRIPSKELETON MEETS THE
 * REAL TRIP.
 *
 * `planFromSkeleton()` needs a `SkeletonPlanningContext` — real region,
 * board, matrix, profile — assembled the one way that context is ever
 * assembled in production: `resolveTripRegion()` + `boardFor()`, exactly as
 * `plannerInputForTrip()` in `build.ts` does for the questionnaire path. This
 * file is that same assembly, for the skeleton path, plus the two
 * capabilities `planFromSkeleton()` can use but does not construct itself —
 * a deterministic geocoder and an on-demand router — wired to real
 * production infrastructure.
 *
 * `planFromSkeletonForTrip()` is the legacy TripSkeleton bridge and is no
 * longer on the product path; the canonical orchestrator (`production-plan.ts`)
 * reuses the production wiring exported below — `productionGeocodeLocality`,
 * `productionRouteMatrix`, `productionConfirmRoute`,
 * `productionFindNearbyLocalities`, `productionDestinationScope`,
 * `productionSubregionGeometries` — and hands them to `reconcile.ts`.
 *
 * ZERO ANTHROPIC EXPOSURE, STRUCTURALLY, NOT BY CONVENTION.
 *
 * `createOpenProviders({ maxModelCalls: 0 })` is not merely "no model calls
 * this run" — it is the same mechanism that gives `ResearchModel.structured()`
 * nothing to call even if some future edit here tried. This orchestrator's
 * own invariant (see `skeleton-adapter.ts`'s header): a validated
 * `TripSkeleton` never needs the model to rediscover the bases it already
 * states, so nothing here reaches for the model at all — routing, alone, is
 * the one provider this file actually uses, and it never touched the model
 * even when built for a live compilation.
 */
export async function planFromSkeletonForTrip(input: {
  tripId: string;
  skeleton: TripSkeleton;
  skeletonPacket: SkeletonEvidencePacket;
  now?: Date;
}): Promise<{ ok: true; result: SkeletonPlanResult } | { ok: false; error: string }> {
  const trip = getTrip(input.tripId);
  if (!trip) return { ok: false, error: 'We could not find that trip any more.' };
  const profile = getProfile(input.tripId);
  if (!profile) {
    return { ok: false, error: 'Finish the questionnaire first — we need your profile to plan around.' };
  }

  const resolved = await resolveTripRegion(trip);
  if (!resolved.ok) return { ok: false, error: resolved.error };
  const context = resolved.context;
  const board = boardFor(trip, profile, context);

  // Zero-budget by construction — see this file's own header.
  const { providers } = createOpenProviders({ maxModelCalls: 0 });

  const result = await planFromSkeleton({
    skeleton: input.skeleton,
    skeletonPacket: input.skeletonPacket,
    context: {
      tripId: input.tripId,
      basics: trip.basics,
      profile,
      region: context.region,
      candidates: board.candidates,
      matrix: context.matrix,
      ...(context.transit ? { transit: context.transit } : {}),
      scheduledNetwork: context.scheduledNetwork,
      access: context.access,
      hours: context.hours,
      weather: context.weather,
      ...(context.food ? { food: context.food } : {}),
      now: input.now ?? new Date(),
      baseId: context.baseId,
      compiledBases: context.compiled.bases,
      geocodeLocality: productionGeocodeLocality,
      routeMatrix: (points) => productionRouteMatrix(providers.routing, context.matrix.mode, points),
      confirmRoute: (from, to) => productionConfirmRoute(providers.routing, context.matrix.mode, from, to),
      findNearbyLocalities: productionFindNearbyLocalities,
      destinationScope: productionDestinationScope(context.compiled),
      subregionGeometries: productionSubregionGeometries(context.compiled),
    },
  });

  return { ok: true, result };
}

/**
 * WIRES `BaseResolutionScope` TO THE REAL DESTINATION IDENTITY ALREADY ON
 * THE COMPILED ARTIFACT.
 *
 * `CompiledRegion.scope: GeographicScope` is confirmed once, by the
 * traveller, before any compilation runs — the destination's own real
 * administrative identity and boundary evidence, not something this file
 * computes. Mapped down to the small shape base resolution needs; see
 * `BaseResolutionScope`'s own header in `skeleton-adapter.ts` for why this
 * is a separate concept from `Region.maxRadiusKm`.
 */
export function productionDestinationScope(compiled: CompiledRegion): BaseResolutionScope {
  const scope = compiled.scope;
  return {
    ...(scope.administrative.countryCode ? { countryCode: scope.administrative.countryCode } : {}),
    ...(scope.administrativeBoundary
      ? { administrativeBounds: scope.administrativeBoundary }
      : scope.bounds
        ? { administrativeBounds: scope.bounds }
        : {}),
    boundaryEvidence: scope.boundaryEvidence,
    ...(scope.reachRadiusKm ? { reachRadiusKm: scope.reachRadiusKm } : {}),
  };
}

/** Real, explicit geometry Sidequest already has for named areas inside this destination, when any exist. */
export function productionSubregionGeometries(compiled: CompiledRegion): readonly SubregionGeometry[] {
  return compiled.subregions.map((subregion) => ({ center: subregion.center, radiusKm: subregion.radiusKm }));
}

/**
 * WIRES `SkeletonBaseGeocoder` TO THE REAL PRODUCTION GEOCODER.
 *
 * Calls `geocode()` — the same Nominatim client `resolveDestinationAction`
 * calls — directly, never through `DestinationResolver.resolve()`, which
 * bundles a model "is this a place" corroboration this path must never make.
 * Ids use `osmElementId()`, the same `way/12345` convention OSM-backed places
 * already carry elsewhere in this codebase, so a locality resolved here and
 * one discovered during a live compilation are the same identity if they are
 * the same place, not two different spellings of it.
 */
export async function productionGeocodeLocality(query: string): Promise<readonly GeocodedLocality[]> {
  const result = await geocode(query, { limit: 5 });
  const localities: GeocodedLocality[] = [];
  for (const place of result.places) {
    const lat = Number(place.lat);
    const lng = Number(place.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const sourceId = osmElementId(place) ?? (place.place_id !== undefined ? `nominatim/${place.place_id}` : null);
    if (!sourceId) continue;
    // `addressdetails=1` is already requested in `geocode()` (see its own
    // comment on why), so `address.country_code` is real, structured,
    // ISO-3166-1 alpha-2 evidence — never guessed from the display name.
    const countryCode = place.address?.country_code;
    // Reuses `classifyNominatim()` (`nominatim.ts`) — the same translation of
    // Nominatim's `addresstype`/`type`/`category` already used by
    // `live.ts`'s destination-candidate scoring — rather than inventing a
    // second reading of the same raw fields.
    const { entityType } = classifyNominatim(place);
    localities.push({
      sourceId,
      name: place.namedetails?.['name:en'] ?? place.name ?? place.display_name,
      lat,
      lng,
      ...(countryCode ? { countryCode } : {}),
      entityType,
      ...(place.importance !== undefined ? { importance: place.importance } : {}),
    });
  }
  return localities;
}

/** `place=city`/`town` reads the same as Nominatim's own `addresstype: city`; `village`/`hamlet` reads as `neighbourhood` — the same two buckets `classifyNominatim()`'s `LOCALITY_ENTITY_TYPES` already recognises, so an Overpass-found settlement and a Nominatim-found one are judged by the identical rule. */
function settlementEntityType(placeType: string): 'city' | 'neighbourhood' {
  return placeType === 'city' || placeType === 'town' ? 'city' : 'neighbourhood';
}

/** A small, conservative box around one point — the same `radiusKm / 111` / `radiusKm / (111 * cos(lat))` conversion already used in `live.ts`/`gather.ts` for the identical "how far in degrees is this many km" question. */
function boxAroundPoint(point: { lat: number; lng: number }, radiusKm: number): BoundingBox {
  const latSpan = radiusKm / 111;
  const lngSpan = radiusKm / (111 * Math.max(0.1, Math.cos((point.lat * Math.PI) / 180)));
  return {
    south: point.lat - latSpan,
    north: point.lat + latSpan,
    west: point.lng - lngSpan,
    east: point.lng + lngSpan,
  };
}

function haversineKmLocal(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const EARTH_RADIUS_KM = 6371.0088;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h = sinLat * sinLat + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sinLng * sinLng;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** At most this many real settlements are returned per point, nearest first — `relocation-corridor.ts` applies its own further caps on top. */
const MAX_SETTLEMENTS_PER_POINT = 5;

/**
 * WIRES `SkeletonCorridorLocalitySearch` TO REAL PRODUCTION MAP DATA.
 *
 * `relocation-corridor.ts`'s remedy tier needs the other direction from
 * `productionGeocodeLocality` above: a coordinate along a route corridor in,
 * the real settlements found nearby out. A single exact-point reverse
 * geocode cannot answer this well — the live Iceland run found a corridor
 * sample landing inside `Þingeyjarsveit`, a real administrative municipality,
 * even though a real town may sit a short distance away from that exact
 * coordinate. So this asks a bounded *area* question instead: a real
 * Overpass `place=city/town/village/hamlet` search (`fetchSettlements()`,
 * the same shared, cached, rate-gated provider every other map-data query in
 * this codebase uses) over a small box around the point, sized to the
 * caller's own `radiusKm`.
 *
 * Falls back to Nominatim's exact-point `/reverse` (wrapped to a 0-or-1
 * element array) only when the map-data provider is switched off or the
 * bounded search itself fails — a real degradation, not a silent one, and
 * exactly the previous behaviour this module had before the bounded search
 * existed, preserved rather than removed.
 */
export async function productionFindNearbyLocalities(
  point: { lat: number; lng: number },
  radiusKm: number,
): Promise<readonly GeocodedLocality[]> {
  if (isPoiProviderEnabled()) {
    try {
      const box = boxAroundPoint(point, radiusKm);
      const result = await fetchSettlements(box, { limit: 20 });
      const localities = result.elements
        .map((element) => normalizeSettlement(element))
        .filter((settlement): settlement is NonNullable<typeof settlement> => settlement !== null)
        .map((settlement) => ({
          sourceId: settlement.elementId,
          name: settlement.name,
          lat: settlement.coordinates.lat,
          lng: settlement.coordinates.lng,
          entityType: settlementEntityType(settlement.placeType),
          distanceKm: haversineKmLocal(point, settlement.coordinates),
        }))
        .sort((a, b) => a.distanceKm - b.distanceKm)
        .slice(0, MAX_SETTLEMENTS_PER_POINT)
        .map(({ distanceKm: _distanceKm, ...locality }) => locality);
      if (localities.length > 0) return localities;
    } catch {
      // A genuine provider failure degrades to the exact-point fallback
      // below, exactly like every other optional capability in this file —
      // never thrown through the whole remedy attempt.
    }
  }

  const fallback = await productionReverseGeocodeLocality(point);
  return fallback ? [fallback] : [];
}

/**
 * The exact-point reverse geocoder this module used before the bounded
 * search above existed — kept as `productionFindNearbyLocalities`'s own
 * fallback for when Overpass is unavailable, same client, same identity
 * convention (`osmElementId()`), same `classifyNominatim()` reuse.
 */
async function productionReverseGeocodeLocality(point: { lat: number; lng: number }): Promise<GeocodedLocality | null> {
  const result = await reverseGeocode(point.lat, point.lng);
  const place = result.place;
  if (!place) return null;
  const lat = Number(place.lat);
  const lng = Number(place.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const sourceId = osmElementId(place) ?? (place.place_id !== undefined ? `nominatim/${place.place_id}` : null);
  if (!sourceId) return null;
  const countryCode = place.address?.country_code;
  const { entityType } = classifyNominatim(place);
  return {
    sourceId,
    name: place.namedetails?.['name:en'] ?? place.name ?? place.display_name,
    lat,
    lng,
    ...(countryCode ? { countryCode } : {}),
    entityType,
    ...(place.importance !== undefined ? { importance: place.importance } : {}),
  };
}

/**
 * WIRES `SkeletonRouteMatrixProvider` TO THE REAL PRODUCTION ROUTER.
 *
 * `providers.routing` is the same `RoutingProvider` (Valhalla-backed) a live
 * compilation's own matrix stage calls — reused, not duplicated. Bounded to
 * exactly the points asked for (resolved bases, never the whole board), so
 * the cost is proportional to a trip's own base count rather than the
 * region's candidate count.
 */
/**
 * `ProviderGapReason`'s values are a superset of `RouteFailureReason`'s;
 * anything a provider can produce that skeleton hydration has no vocabulary
 * for degrades to `'provider_error'` rather than losing the entry.
 */
function toRouteFailureReason(reason: string): RouteFailureReason {
  return (['not_found', 'provider_error', 'rate_limited', 'budget_exhausted', 'insufficient_evidence'] as const).includes(
    reason as RouteFailureReason,
  )
    ? (reason as RouteFailureReason)
    : 'provider_error';
}

export async function productionRouteMatrix(
  routing: ReturnType<typeof createOpenProviders>['providers']['routing'],
  mode: 'car' | 'foot' | 'transit',
  points: readonly { id: string; lat: number; lng: number }[],
): Promise<RouteMatrixResult | null> {
  if (points.length < 2) return null;
  if (!routing.supportedModes().includes(mode)) return null;
  const result = await routing.matrix({ points, mode, maxElements: points.length * points.length });
  return {
    ids: result.ids,
    minutes: result.minutes,
    km: result.km,
    // Forwarded, not dropped: `resolveSkeletonBase`'s routability checks
    // need the real reason a pair has no value (see `RouteFailureReason`),
    // not just the fact that it doesn't.
    failedPairs: result.failedPairs.map((pair) => ({
      fromId: pair.from,
      toId: pair.to,
      reason: toRouteFailureReason(pair.reason),
    })),
  };
}

/**
 * WIRES `SkeletonRouteConfirmationProvider` TO THE REAL PRODUCTION ROUTER'S
 * SINGLE-ROUTE CAPABILITY.
 *
 * The bounded fallback `resolveSkeletonBase`'s callers use only for a leg a
 * hard feasibility decision depends on — see `confirmMandatoryLeg` in
 * `skeleton-adapter.ts`'s own header for why it exists at all. `null` when
 * the current provider or mode offers no such capability (an optional
 * `RoutingProvider.route`), which callers already treat exactly like
 * "attempted, no evidence" — never a reason to fabricate a value.
 */
export async function productionConfirmRoute(
  routing: ReturnType<typeof createOpenProviders>['providers']['routing'],
  mode: 'car' | 'foot' | 'transit',
  from: { lat: number; lng: number },
  to: { lat: number; lng: number },
): Promise<{
  found: boolean;
  minutes: number | null;
  km: number | null;
  reason?: RouteFailureReason;
  provider?: string;
  latencyMs?: number;
  geometry?: readonly { lat: number; lng: number }[];
} | null> {
  if (!routing.supportedModes().includes(mode)) return null;
  if (!routing.route) return null;
  const result = await routing.route({ from, to, mode });
  return {
    found: result.found,
    minutes: result.minutes,
    km: result.km,
    ...(result.reason ? { reason: toRouteFailureReason(result.reason) } : {}),
    provider: routing.name,
    ...(result.latencyMs !== undefined ? { latencyMs: result.latencyMs } : {}),
    // The route's own real shape, when the provider's response carried one
    // — see `RouteConfirmationResult.geometry`'s own header for why this
    // costs no extra request. Forwarded, never fabricated: absent when the
    // provider had nothing.
    ...(result.geometry ? { geometry: result.geometry } : {}),
  };
}
