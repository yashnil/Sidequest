import 'server-only';
import type { DestinationResolver, RoutingProvider, TransitRoutingProvider } from '@sidequest/compiler';
import { compilerProviderChoice, compilerProviders } from '../compiler/providers';
import { createOpenResolver, createOpenRouting, emptyVerificationDiagnostics, type VerificationDiagnostics } from '../providers/open-verification';
import { isGeocoderEnabled, isGlobalRoutesProviderEnabled, isRoutesProviderEnabled } from '../providers/switches';
import { routingCoverageFromEnv } from '../providers/routing-coverage';
import { createCompositeRouting } from '../providers/routing-composite';
import { createOrsRouting } from '../providers/openrouteservice';
import { loadRecordedRoutes, recordedRoutesFetch } from '../providers/openrouteservice-fixture';

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
  const global = isGlobalRoutesProviderEnabled()
    ? createOrsRouting(diagnostics, recorded ? { fetchImpl: recordedRoutesFetch(loadRecordedRoutes(recorded)), apiKey: 'recorded-fixture' } : {})
    : null;
  return {
    resolver: isGeocoderEnabled() ? createOpenResolver({ diagnostics }) : null,
    routing: createCompositeRouting({ local, localCoverage: routingCoverageFromEnv(), global }),
    transit: null,
    diagnostics,
  };
}
