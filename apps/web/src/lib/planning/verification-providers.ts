import 'server-only';
import type { DestinationResolver, RoutingProvider, TransitRoutingProvider } from '@sidequest/compiler';
import { compilerProviderChoice, compilerProviders } from '../compiler/providers';
import { createOpenResolver, createOpenRouting, emptyVerificationDiagnostics, type VerificationDiagnostics } from '../providers/open-verification';
import { isGeocoderEnabled, isRoutesProviderEnabled } from '../providers/switches';

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
  return {
    resolver: isGeocoderEnabled() ? createOpenResolver({ diagnostics }) : null,
    routing: isRoutesProviderEnabled() ? createOpenRouting(diagnostics) : null,
    transit: null,
    diagnostics,
  };
}
