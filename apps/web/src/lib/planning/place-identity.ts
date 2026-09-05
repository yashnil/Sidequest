import 'server-only';
import type { PackageAnchor } from '@sidequest/core';
import { getItinerary } from '../db/repository';
import { capability } from '../providers/registry';
import { operationalFacts, resolveIdentity, type OperationalFacts, type PlacesHttp } from '../providers/google-places';
import { loadRecordedPlaces, recordedPlacesFetch } from '../providers/google-places-fixture';
import { ProviderFailure, type OperationalEvidence } from '@sidequest/core';
import type { ProviderBudget } from '../providers/cost-budget';
import { normalizeName } from './skeleton-adapter';
import type { ProviderPlaceIdentity, ReconcileContext } from './reconcile';

/**
 * PLACE RESOLUTION V2 — THE TWO SEAMS THE ORCHESTRATOR HANDS THE RECONCILER.
 *
 *   persisted identity → board → compiled → places provider → geocoder → unresolved
 *
 * Persisted identities come from the trip's last saved package: a name a
 * places provider already resolved is reused, never paid for twice. The
 * places seam is Google Places at IDENTITY level only (id, name, location,
 * address components, types — no hours, no photos), gated by the capability
 * registry and by the per-build budget; when the key is absent or the
 * compiler is a fixture, the seam is simply not offered and the reconciler
 * falls through to the geocoder exactly as before.
 */

export function persistedIdentitiesFor(tripId: string): NonNullable<ReconcileContext['persistedIdentities']> {
  const anchors = getItinerary(tripId)?.package?.anchors ?? [];
  const map = new Map<string, NonNullable<PackageAnchor['identity']> & { name: string; placeId: string }>();
  for (const anchor of anchors) {
    const identity = anchor.identity;
    if (!identity || !anchor.placeId) continue;
    // Only provider-resolved identities are worth persisting; board and compiled evidence is re-read fresh, and a geocoder guess is retried.
    if (identity.method !== 'places' && identity.method !== 'persisted') continue;
    if (!identity.providerRef) continue;
    // Google coordinates may be held for 30 days (Service Terms §14.3); past that the place is re-resolved, place id kept.
    if (identity.provider === 'google-places' && identity.resolvedAt && Date.now() - Date.parse(identity.resolvedAt) > 30 * 86_400_000) continue;
    map.set(normalizeName(anchor.name), { ...identity, name: anchor.name, placeId: anchor.placeId });
  }
  return map;
}

/** The HTTP the Google adapter uses: the network, or recorded responses when `SIDEQUEST_PLACES_FIXTURE` names a file. */
export function placesHttpFor(env: Record<string, string | undefined> = process.env): PlacesHttp {
  const recorded = env.SIDEQUEST_PLACES_FIXTURE;
  if (recorded) return { fetchImpl: recordedPlacesFetch(loadRecordedPlaces(recorded)), apiKey: 'recorded-fixture', counter: { calls: 0, failures: 0 } };
  return { counter: { calls: 0, failures: 0 } };
}

function googlePlacesUsable(id: 'places.identity' | 'places.hours', env: Record<string, string | undefined>): boolean {
  const cap = capability(id, env);
  if (!cap?.configured || cap.provider !== 'google-places') return false;
  // A recorded fixture is the one "fixture" this seam accepts: the real adapter runs against saved responses.
  return !cap.fixture || Boolean(env.SIDEQUEST_PLACES_FIXTURE);
}

export function placesIdentitySeam(budget: ProviderBudget, env: Record<string, string | undefined> = process.env): ReconcileContext['resolvePlaceIdentity'] | undefined {
  if (!googlePlacesUsable('places.identity', env)) return undefined;
  const http = placesHttpFor(env);
  return async (input): Promise<ProviderPlaceIdentity | null> => {
    if (!budget.take('place_identity')) return null;
    const found = await resolveIdentity({ name: input.name, ...(input.locality ? { locality: input.locality } : {}), category: input.category, near: input.near, radiusKm: input.radiusKm }, http);
    if (!found) return null;
    return {
      providerRef: found.providerRef,
      provider: found.provider,
      // The traveller's plan keeps the name the model wrote; Google's display name is matched against, never stored (§3.2.3(a)(iii)).
      name: input.name,
      coordinates: found.coordinates,
      ...(found.countryCode ? { countryCode: found.countryCode } : {}),
      placeClass: found.placeClass,
      confidence: found.confidence,
      attribution: found.attribution,
    };
  };
}

/**
 * OPERATIONAL SEAM — status and regular hours for a provider-identified stop.
 *
 * Google's operational level is normalised here into `OperationalEvidence`;
 * the reconciler never sees the provider shape. A failure is evidence that
 * the provider did not answer, never evidence about the place. Budgeted by
 * `place_operational`; refused means "verify later".
 */
export function normalizeOperationalFacts(facts: OperationalFacts): OperationalEvidence {
  return {
    provider: 'google-places',
    providerRef: facts.providerRef,
    checkedAt: facts.checkedAt,
    status: facts.businessStatus ?? 'unknown',
    hoursBasis: facts.weeklyHours && facts.weeklyHours.length > 0 ? 'regular' : 'none',
    ...(facts.weeklyHours && facts.weeklyHours.length > 0 ? { weekly: facts.weeklyHours } : {}),
    attribution: facts.attribution,
  };
}

export function operationalEvidenceSeam(budget: ProviderBudget, env: Record<string, string | undefined> = process.env, now: Date = new Date()): ReconcileContext['operationalEvidence'] | undefined {
  if (!googlePlacesUsable('places.hours', env)) return undefined;
  const http = placesHttpFor(env);
  return async (input): Promise<OperationalEvidence | null> => {
    if (input.provider !== 'google-places' || !input.providerRef) return null;
    if (!budget.take('place_operational')) return null;
    try {
      const facts = await operationalFacts(input.providerRef, http, now);
      return facts ? normalizeOperationalFacts(facts) : null;
    } catch (error) {
      const reason = error instanceof ProviderFailure ? error.reason : 'provider_error';
      return { provider: 'google-places', providerRef: input.providerRef, checkedAt: now.toISOString(), status: 'unknown', hoursBasis: 'none', attribution: 'Place data © Google', unavailableReason: reason };
    }
  };
}
