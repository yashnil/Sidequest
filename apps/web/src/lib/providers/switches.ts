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
  return missing;
}
