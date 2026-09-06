import 'server-only';

/**
 * WHICH PROVIDERS THIS BUILD IS ALLOWED TO REACH — AND NOTHING ELSE.
 *
 * Every function here reads one environment variable and returns a boolean. The
 * module imports nothing, and that emptiness is the entire point.
 *
 * These predicates used to live beside the providers they gate — `isGeocoderEnabled`
 * in the Nominatim client, `isRoutesProviderEnabled` in the Valhalla client, and
 * so on. Reading an env var is harmless, but *importing the module that reads it*
 * pulls the whole client in behind it, and the render-purity audit found the
 * consequence: the plan page and both decide pages had a live provider in their
 * transitive import graph purely because they wanted to know whether that
 * provider was switched on. Nothing was ever called — but "nothing is called
 * today" is a property of the current control flow, not of the build, and it is
 * one refactor away from being false.
 *
 * So the question "is this switched on?" is now answerable without importing the
 * thing being asked about. The provider modules re-export from here, so their own
 * callers are unaffected; a render path imports this file directly and reaches no
 * socket, no SDK and no rate limiter.
 *
 * The rule, if you add one: **this file may never grow an import.**
 */

/** The geocoder that turns a typed destination into a place on the map. */
export function isGeocoderEnabled(): boolean {
  return process.env.SIDEQUEST_GEOCODER_PROVIDER?.trim().toLowerCase() === 'nominatim';
}

/** The release-versioned global place backbone. */
export function isPlaceBackboneEnabled(): boolean {
  return process.env.SIDEQUEST_PLACE_BACKBONE?.trim().toLowerCase() === 'overture';
}

/** The best-effort fallback place service. A fallback, never a requirement. */
export function isPoiProviderEnabled(): boolean {
  return process.env.SIDEQUEST_POI_PROVIDER?.trim().toLowerCase() === 'overpass';
}

/** The router that measures travel times. */
export function isRoutesProviderEnabled(): boolean {
  return process.env.SIDEQUEST_ROUTES_PROVIDER?.trim().toLowerCase() === 'valhalla';
}

/**
 * PRODUCT RECOVERY V1 — the optional global road router behind the local one
 * (`routing.global`). `SIDEQUEST_ROUTES_GLOBAL_PROVIDER=openrouteservice` plus a
 * key (`OPENROUTESERVICE_API_KEY`) or a recorded fixture file
 * (`SIDEQUEST_ROUTES_FIXTURE`). Never mandatory; never inferred.
 */
export function isGlobalRoutesProviderEnabled(): boolean {
  const chosen = process.env.SIDEQUEST_ROUTES_GLOBAL_PROVIDER?.trim().toLowerCase() === 'openrouteservice';
  return chosen && ((process.env.OPENROUTESERVICE_API_KEY?.length ?? 0) > 0 || (process.env.SIDEQUEST_ROUTES_FIXTURE?.length ?? 0) > 0);
}

/**
 * Whether a research-model credential exists.
 *
 * Length only. The value is never read, logged, compared or returned — a
 * predicate about a secret must not be a way to learn anything about it beyond
 * whether somebody set one.
 */
export function isResearchModelConfigured(): boolean {
  return (process.env.ANTHROPIC_API_KEY?.trim().length ?? 0) > 0;
}

/**
 * Whether the ONE composition call can be made.
 *
 * The same credential as the research model today, named separately because
 * the two are different capabilities: composition is the canonical product
 * path and needs nothing else; research (`SIDEQUEST_RESEARCH_PROVIDER`) is an
 * optional stage behind "Explore experiences first". Nothing on the normal
 * path may consult the research switch.
 */
export function isCompositionModelConfigured(): boolean {
  return (process.env.ANTHROPIC_API_KEY?.trim().length ?? 0) > 0;
}

/**
 * The climate archive.
 *
 * Defaults to **on**, unlike every other switch here, because Open-Meteo is free
 * and keyless: there is no credential to be missing and no volunteer service to
 * be polite to. Turning it off is a deliberate act, which is why the comparison
 * is against `'off'` rather than for a provider name.
 */
export function isClimateEnabled(): boolean {
  return process.env.SIDEQUEST_CLIMATE_PROVIDER?.trim().toLowerCase() !== 'off';
}

/**
 * The source that resolves a coordinate to a real civil time zone.
 *
 * Defaults to **on**, like the climate archive and for the same reasons: it is
 * the same keyless, free, CC BY 4.0 service, so there is no credential to be
 * missing. Turning it off is a deliberate act — and a deliberate acceptance that
 * every destination falls back to a solar approximation, which the product then
 * says out loud on screen.
 */
export function isTimeZoneResolverEnabled(): boolean {
  return process.env.SIDEQUEST_TIMEZONE_PROVIDER?.trim().toLowerCase() !== 'off';
}

/**
 * The source that measures a public-transport journey.
 *
 * Off unless named, unlike the two above, because there is no free keyless
 * service that answers it: a transit journey needs timetable data built into a
 * routing graph, and a deployment either has one or does not. Naming the value
 * rather than testing for `'off'` is what keeps a build from *appearing* to have
 * transit because somebody left a variable blank.
 *
 * `valhalla` means a Valhalla instance built with GTFS tiles — the public demo
 * server is not one, which is why this is not simply tied to
 * `SIDEQUEST_ROUTES_PROVIDER`.
 */
export function transitProviderName(): 'valhalla' | null {
  return process.env.SIDEQUEST_TRANSIT_PROVIDER?.trim().toLowerCase() === 'valhalla'
    ? 'valhalla'
    : null;
}

export function isTransitProviderEnabled(): boolean {
  return transitProviderName() !== null;
}

/**
 * Whether the whole open-licensed stack can run.
 *
 * The backbone *or* the fallback place service — not neither. A build with the
 * backbone on and Overpass off is the intended production shape; a build with
 * neither cannot discover anything, so it is refused up front rather than three
 * stages in.
 */
export function openProvidersEnabled(): boolean {
  return (
    isGeocoderEnabled() &&
    (isPlaceBackboneEnabled() || isPoiProviderEnabled()) &&
    isRoutesProviderEnabled() &&
    isResearchModelConfigured() &&
    process.env.SIDEQUEST_RESEARCH_PROVIDER?.trim().toLowerCase() === 'anthropic'
  );
}

/**
 * Which switches are missing, by name.
 *
 * Names, never values. A developer needs to know which one to set; nobody needs
 * to see what is in it, and a message that echoed a key would put one in a log.
 */
export function missingProviderSwitches(): string[] {
  const missing: string[] = [];
  if (!isGeocoderEnabled()) missing.push('SIDEQUEST_GEOCODER_PROVIDER=nominatim');
  if (!isPlaceBackboneEnabled() && !isPoiProviderEnabled()) {
    missing.push('SIDEQUEST_PLACE_BACKBONE=overture');
  }
  if (!isRoutesProviderEnabled()) missing.push('SIDEQUEST_ROUTES_PROVIDER=valhalla');
  if (process.env.SIDEQUEST_RESEARCH_PROVIDER?.trim().toLowerCase() !== 'anthropic') {
    missing.push('SIDEQUEST_RESEARCH_PROVIDER=anthropic');
  }
  /*
   * The credential, named — because it was the one thing `openProvidersEnabled`
   * required and this list did not report.
   *
   * A deployment with every switch set and no key produced `ready: false` with
   * an empty list, which rendered as the sentence **"This build is missing: ."**
   * A diagnostic that knows something is wrong and will not say what is worse
   * than no diagnostic, because it is the one a developer trusts.
   *
   * The variable's *name*, never any part of its value. `isResearchModelConfigured`
   * reads length alone for the same reason.
   */
  if (!isResearchModelConfigured()) missing.push('ANTHROPIC_API_KEY');
  return missing;
}

/**
 * WHICH COMPOSER WRITES THE TRIP DRAFT.
 *
 * `fixture` swaps the frontier model for a deterministic, offline draft
 * composer (`lib/planning/fixture-composer.ts`) so the whole canonical
 * generation path — composition, verification, reconciliation,
 * persistence, rendering — runs in a browser test or an integration test
 * with zero model calls. Anything else means the real model. Like every
 * other switch here, this is read from the environment and imports nothing.
 */
export function isFixtureComposer(): boolean {
  return process.env.SIDEQUEST_COMPOSER_PROVIDER?.trim().toLowerCase() === 'fixture';
}
