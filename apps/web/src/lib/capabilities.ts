import 'server-only';
import { TravelCapabilityRegistry, type TravelCapability } from '@sidequest/core';
import {
  isClimateEnabled,
  isGeocoderEnabled,
  isPlaceBackboneEnabled,
  isPoiProviderEnabled,
  isResearchModelConfigured,
  isRoutesProviderEnabled,
  isTimeZoneResolverEnabled,
  isTransitProviderEnabled,
  transitProviderName,
} from './providers/switches';

/**
 * WHAT THIS DEPLOYMENT CAN ACTUALLY ANSWER.
 *
 * The registry is a declaration and this is the declaration — one place that
 * says which adapters exist, under what terms, and what this particular build
 * has the configuration to reach.
 *
 * It imports only the switch predicates, which themselves import nothing. That
 * is deliberate and is the same rule `switches.ts` holds itself to: asking "can
 * we do X" must not pull the thing that does X into a render path's import
 * graph. The render-purity audit found three pages doing exactly that.
 *
 * The entry that matters most is the one with no provider behind it.
 * `route_transit` is registered by nobody, so `assess` returns
 * `reason: 'unsupported'` — a *stated* answer, distinguishable from "a provider
 * exists and is not configured" and from "a provider exists and does not cover
 * here". Those three were one sentence before, which is how a walking matrix
 * over a dense city came to stand in for a rail network.
 */
export function capabilityRegistry(): TravelCapabilityRegistry {
  const registry = new TravelCapabilityRegistry();

  registry.register({
    provider: 'nominatim',
    capability: 'destination_identity',
    authority: 'open_structured_database',
    freshness: 'static',
    persistence: 'storable',
    coverage: 'global',
    configured: isGeocoderEnabled(),
    missing: isGeocoderEnabled() ? [] : ['SIDEQUEST_GEOCODER_PROVIDER'],
    attribution: '© OpenStreetMap contributors',
  });

  for (const capability of [
    'place_inventory',
    'administrative_membership',
  ] as const satisfies readonly TravelCapability[]) {
    registry.register({
      provider: 'overture',
      capability,
      authority: 'open_structured_database',
      freshness: 'seasonal',
      persistence: 'storable',
      coverage: 'global',
      configured: isPlaceBackboneEnabled(),
      missing: isPlaceBackboneEnabled() ? [] : ['SIDEQUEST_PLACE_BACKBONE'],
      attribution: 'Overture Maps Foundation',
      note: 'Release-pinned, so a compilation is reproducible against a named release.',
    });
  }

  registry.register({
    provider: 'overpass',
    capability: 'place_inventory',
    authority: 'open_structured_database',
    freshness: 'daily',
    persistence: 'storable',
    coverage: 'global',
    configured: isPoiProviderEnabled(),
    missing: isPoiProviderEnabled() ? [] : ['SIDEQUEST_POI_PROVIDER'],
    attribution: '© OpenStreetMap contributors',
    note: 'A fallback. The public endpoint names apps for non-mapper audiences as abuse.',
  });

  for (const capability of [
    'route_drive',
    'route_walk',
    'travel_time_matrix',
  ] as const satisfies readonly TravelCapability[]) {
    registry.register({
      provider: 'valhalla',
      capability,
      authority: 'structured_provider',
      freshness: 'seasonal',
      persistence: 'storable',
      coverage: 'global',
      configured: isRoutesProviderEnabled(),
      missing: isRoutesProviderEnabled() ? [] : ['SIDEQUEST_ROUTES_PROVIDER'],
      attribution: 'Valhalla / © OpenStreetMap contributors',
    });
  }

  registry.register({
    provider: 'anthropic',
    capability: 'official_web_research',
    authority: 'model_inference',
    freshness: 'live',
    persistence: 'storable',
    coverage: 'global',
    configured: isResearchModelConfigured(),
    missing: isResearchModelConfigured() ? [] : ['ANTHROPIC_API_KEY'],
    note: 'Finds pages. The facts come from reading them here, under our own limits.',
  });

  registry.register({
    provider: 'open-meteo',
    capability: 'climate_normals',
    authority: 'structured_provider',
    freshness: 'static',
    persistence: 'storable',
    coverage: 'global',
    configured: isClimateEnabled(),
    missing: isClimateEnabled() ? [] : ['SIDEQUEST_CLIMATE_PROVIDER'],
    attribution: 'Open-Meteo, CC BY 4.0',
  });

  registry.register({
    provider: 'open-meteo',
    capability: 'weather_forecast',
    authority: 'structured_provider',
    /*
     * Live, and bounded. The published horizon is sixteen days; beyond it the
     * honest answer is climate rather than a forecast, and the weather layer
     * already refuses to present one as the other.
     */
    freshness: 'live',
    persistence: 'time_limited',
    coverage: 'global',
    configured: process.env.SIDEQUEST_WEATHER_PROVIDER?.trim().toLowerCase() !== 'off',
    missing: [],
    attribution: 'Open-Meteo, CC BY 4.0',
  });

  /**
   * THE ENTRY THAT MOVED FROM "NOT REGISTERED, ON PURPOSE" TO A REAL PROVIDER.
   *
   * The same keyless CC BY 4.0 service the weather and climate rows already
   * name, asked a different question: `timezone=auto` resolves a coordinate to
   * an IANA identifier. `storable` is the load-bearing word — a compiled region
   * outlives the request that made it, and the one obvious alternative publishes
   * terms that forbid keeping a `timeZone` at all.
   */
  registry.register({
    provider: 'open-meteo',
    capability: 'civil_time_zone',
    authority: 'structured_provider',
    freshness: 'static',
    persistence: 'storable',
    coverage: 'global',
    configured: isTimeZoneResolverEnabled(),
    missing: isTimeZoneResolverEnabled() ? [] : ['SIDEQUEST_TIMEZONE_PROVIDER'],
    attribution: 'Open-Meteo, CC BY 4.0',
    note: 'Answers with a real zone or with nothing. A fixed offset is refused rather than accepted.',
  });

  /**
   * PUBLIC TRANSPORT, REGISTERED ONLY WHEN SOMETHING CAN MEASURE IT.
   *
   * `route_transit` was the registry's worked example of an unsupplied
   * capability, and the point of the example was never that transit is
   * unmeasurable — it was that a walking matrix must not be allowed to answer
   * for it. This registration keeps that guarantee and adds the other half: a
   * deployment whose router was built with timetable data registers here, and
   * one whose was not still reports `unsupported`.
   *
   * Deliberately not tied to `SIDEQUEST_ROUTES_PROVIDER`. A Valhalla instance
   * only speaks about transit if GTFS tiles were built into it, and the public
   * demo endpoint's were not — so "we have a router" and "we have transit" are
   * two facts and are configured as two.
   */
  if (isTransitProviderEnabled()) {
    registry.register({
      provider: transitProviderName() ?? 'valhalla',
      capability: 'route_transit',
      authority: 'structured_provider',
      freshness: 'daily',
      persistence: 'storable',
      coverage: 'global',
      configured: true,
      missing: [],
      attribution: 'Valhalla / © OpenStreetMap contributors / transit agency GTFS',
      note: 'Measured journeys only. Where no service runs, that is reported rather than filled in.',
    });
  }

  registry.register({
    provider: 'derived',
    capability: 'daylight',
    authority: 'structured_provider',
    freshness: 'static',
    persistence: 'storable',
    coverage: 'global',
    configured: true,
    missing: [],
    note: 'Computed from the destination’s own coordinates. A fact, not a prediction.',
  });

  /*
   * NOT REGISTERED, ON PURPOSE:
   *
   *   transit_schedule, route_ferry, gateway_discovery, place_details,
   *   place_images, opening_hours, seasonal_access, food_near_anchor,
   *   local_context
   *
   * Some of these are supplied *within* a compilation by the research funnel
   * rather than by a standalone adapter, and some have no supplier at all. Both
   * cases are better reported as `unsupported` than registered against something
   * that does not really answer them: a capability claimed and then quietly
   * served by a different measurement is exactly the substitution this registry
   * exists to make impossible.
   *
   * `route_transit` left this list conditionally rather than outright — see
   * above. A build with no transit provider still lands here, and the readiness
   * layer still reports the gap.
   */

  return registry;
}
