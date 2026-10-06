import 'server-only';
import type { DestinationResolver, RoutingProvider, TransitRoutingProvider } from '@sidequest/compiler';
import { compilerProviderChoice, compilerProviders } from '../compiler/providers';
import { createOpenResolver, createOpenRouting, emptyVerificationDiagnostics, type VerificationDiagnostics } from '../providers/open-verification';
import { isGeocoderEnabled, isGlobalRoutesProviderEnabled, isRoutesProviderEnabled } from '../providers/switches';
import { routingCoverageFromEnv } from '../providers/routing-coverage';
import { createCompositeRouting } from '../providers/routing-composite';
import { localRouterKnownUnreachable } from '../readiness/probe-cache';
import { createOrsRouting } from '../providers/openrouteservice';
import { loadRecordedRoutes, recordedRoutesFetch } from '../providers/openrouteservice-fixture';
import { CACHE_TTL_MS, cacheKeyFor } from '../providers/cache-policy';
import { readProviderCache, writeProviderCache } from '../db/compiler-repository';

/**
 * WHAT THE CANONICAL BUILD MAY REACH TO VERIFY A DRAFT — NEVER THE RESEARCH MODEL.
 *
 * The one generation path needs a resolver (to put the typed destination on
 * the map), a road router (to time the legs that matter) and, where one is
 * configured, a transit seam. It never needs the compilation stack's research
 * model, and it must not be refused because that model is switched off: the
 * research provider is an optional capability behind "Explore experiences
 * first", not a prerequisite for composing a trip.
 *
 * Fixture compilations keep using the synthetic worlds' providers so browser
 * and integration tests run offline; everything else is built directly from
 * the open adapters, each present only when its own switch is on.
 */
export interface VerificationProviders {
  resolver: DestinationResolver | null;
  routing: RoutingProvider | null;
  transit: TransitRoutingProvider | null;
  diagnostics: VerificationDiagnostics;
}

export function verificationProviders(candidateId?: string): VerificationProviders {
  const diagnostics = emptyVerificationDiagnostics();
  if (compilerProviderChoice() === 'fixture') {
    const { providers } = compilerProviders(candidateId);
    return { resolver: providers.resolver, routing: providers.routing, transit: providers.transit ?? null, diagnostics };
  }
  /*
   * PRODUCT RECOVERY V1 — the routing hierarchy: local Valhalla inside its
   * declared coverage → openrouteservice when configured → nothing. Coverage
   * is checked before any request; a recorded fixture replaces only the
   * socket of the global router.
   */
  const local = isRoutesProviderEnabled() ? createOpenRouting(diagnostics) : null;
  const recorded = process.env.SIDEQUEST_ROUTES_FIXTURE;
  /*
   * V10 §6 — the durable static-route cache. A road leg does not change week to
   * week (`CACHE_TTL_MS.static_route`), so a rebuild of the same trip measures
   * nothing twice, and a regional trip whose legs were partly measured last time
   * starts with those already in hand. Injected here so the adapter never
   * reaches for a database itself.
   */
  const routeCache = {
    read: (key: string) => readProviderCache<{ minutes: number; km: number }>(cacheKeyFor('static_route', [key]), new Date()),
    write: (key: string, value: { minutes: number; km: number }) => {
      const at = new Date();
      writeProviderCache(cacheKeyFor('static_route', [key]), 'openrouteservice', value, CACHE_TTL_MS.static_route, at);
    },
  };
  const global = isGlobalRoutesProviderEnabled()
    ? createOrsRouting(diagnostics, recorded ? { fetchImpl: recordedRoutesFetch(loadRecordedRoutes(recorded)), apiKey: 'recorded-fixture' } : { cache: routeCache })
    : null;
  return {
    resolver: isGeocoderEnabled() ? createOpenResolver({ diagnostics }) : null,
    routing: createCompositeRouting({ local, localCoverage: routingCoverageFromEnv(), global, localKnownUnreachable: localRouterKnownUnreachable() }),
    transit: null,
    diagnostics,
  };
}
