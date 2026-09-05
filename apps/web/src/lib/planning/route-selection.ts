import type { RoutingProvider } from '@sidequest/compiler';
import { providerRegistry } from '@/lib/providers/registry';
import { decideRouting } from '@/lib/providers/routing-policy';
import { computeGoogleRoute } from '@/lib/providers/google-routes';
import { productionConfirmRoute } from './skeleton-orchestrator';
import type { RouteConfirmation } from './skeleton-adapter';

/**
 * ONE ROUTE CONFIRMATION, THROUGH THE POLICY.
 *
 * The reconciler asks "how long from here to there by this trip's mode".
 * The policy answers with the provider that should time it: Valhalla for
 * road modes when configured, Google Routes for timetabled transit or a
 * near-term traffic figure, nothing for air, water and guided legs. Whatever
 * answers, the confirmation carries its basis, provider, static figure and
 * geometry, so the itinerary can say what kind of number it holds.
 */
export async function policyConfirmRoute(input: {
  routing: RoutingProvider;
  mode: 'car' | 'foot' | 'transit';
  from: { lat: number; lng: number };
  to: { lat: number; lng: number };
  departAt?: Date | null;
  now: Date;
  highValue?: boolean;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}): Promise<RouteConfirmation | null> {
  const registry = providerRegistry(input.env ?? process.env);
  const requested = input.mode === 'car' ? 'drive' : input.mode === 'foot' ? 'walk' : 'transit';
  const decision = decideRouting({ mode: requested, registry, departAt: input.departAt ?? null, now: input.now, highValue: input.highValue ?? true, needGeometry: true });
  const measuredAt = input.now.toISOString();

  if (decision.provider === 'google-routes') {
    const result = await computeGoogleRoute({ from: input.from, to: input.to, mode: requested === 'drive' ? 'DRIVE' : requested === 'walk' ? 'WALK' : 'TRANSIT', ...(input.departAt ? { departAt: input.departAt } : {}), traffic: decision.traffic, now: input.now }, { ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}) });
    if (!result.found) {
      return { found: false, minutes: null, km: null, reason: result.reason === 'no_route' || result.reason === 'not_found' ? 'not_found' : result.reason === 'rate_limited' ? 'rate_limited' : 'provider_error', provider: 'google-routes' };
    }
    return {
      found: true,
      minutes: result.minutes,
      km: result.km,
      provider: 'google-routes',
      basis: result.basis,
      measuredAt,
      ...(result.staticMinutes !== null ? { staticMinutes: result.staticMinutes } : {}),
      ...(result.effectiveDepartAt ? { effectiveDepartAt: result.effectiveDepartAt } : {}),
      ...(result.geometry ? { geometry: result.geometry } : {}),
      ...(result.transitSummary ? { transitSummary: result.transitSummary } : {}),
    };
  }
  if (decision.provider === 'valhalla' || decision.provider === 'valhalla-multimodal' || decision.provider === 'fixture') {
    const result = await productionConfirmRoute(input.routing, input.mode, input.from, input.to);
    if (!result) return null;
    return { ...result, basis: input.mode === 'transit' ? 'scheduled' : 'static', measuredAt };
  }
  return null;
}
