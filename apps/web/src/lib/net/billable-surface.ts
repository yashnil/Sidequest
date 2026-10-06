/**
 * WHETHER THIS DEPLOYMENT CAN TURN A REQUEST INTO A BILL, AND WHO MAY DO IT.
 *
 * These predicates used to live inside `middleware.ts`, which was the only
 * thing that asked them. A fresh review proved that placement was the defect
 * rather than the design: Next resolves a server action from its `Next-Action`
 * id against a *global* manifest and runs it whatever URL it was POSTed to, so
 * a `matcher: ['/labs/:path*']` gate never sees the request that presses the
 * spending control. A labs action POSTed to `/` executed, verified against the
 * running production build.
 *
 * The fix needs the same two predicates in two runtimes at once — the edge
 * middleware that still guards the *pages*, and a node-side guard inside every
 * labs action — so they live here, in one copy, rather than being written twice
 * and drifting.
 *
 * **This module imports nothing, deliberately.** It is loaded by middleware on
 * the edge runtime, where pulling in the model SDK or the database client
 * behind `lib/benchmark/budget` would be a hard failure; and a predicate about
 * spending must not depend on anything that could fail to load. The two
 * conditions are literal `process.env` comparisons, the same shape `switches.ts`
 * uses, for the same reason.
 */

/** Live benchmark mode with a budget set: the harness will spend real money. */
export function liveSpendingConfigured(): boolean {
  const mode = process.env.SIDEQUEST_BENCHMARK_MODE?.trim().toLowerCase();
  const budget = process.env.SIDEQUEST_BENCHMARK_BUDGET_USD?.trim();
  return mode === 'live' && budget !== undefined && budget.length > 0;
}

/**
 * Whether the compiler itself is on the billable stack — the gap the first
 * gate left open. The benchmark's *sidequest arm* compiles real regions
 * whenever the compiler is open, so a deployment in fixture *benchmark* mode
 * with an open compiler had a spending control on the open internet and this
 * predicate said otherwise.
 *
 * Mirrors `compilerProviderChoice()` in `lib/compiler/readiness.ts` plus the
 * `openProvidersEnabled()` inference behind it, as literal env reads, for the
 * same runtime reason as above. `doctor.test.ts`'s pattern applies here too:
 * `proxy.test.ts` runs the matrix so the two copies cannot disagree
 * quietly.
 */
export function compilerIsOpen(): boolean {
  const set = (name: string): boolean => (process.env[name]?.trim() ?? '').length > 0;
  const equals = (name: string, value: string): boolean =>
    process.env[name]?.trim().toLowerCase() === value;

  const configured = process.env.SIDEQUEST_COMPILER_PROVIDER?.trim().toLowerCase();
  if (configured === 'open') return true;
  if (configured === 'fixture' || configured === 'off') return false;

  // Nothing (or garbage) configured: the choice is inferred from the provider
  // switches, exactly as `compilerProviderChoice()` infers it.
  return (
    equals('SIDEQUEST_GEOCODER_PROVIDER', 'nominatim') &&
    (equals('SIDEQUEST_PLACE_BACKBONE', 'overture') ||
      equals('SIDEQUEST_POI_PROVIDER', 'overpass')) &&
    equals('SIDEQUEST_ROUTES_PROVIDER', 'valhalla') &&
    equals('SIDEQUEST_RESEARCH_PROVIDER', 'anthropic') &&
    set('ANTHROPIC_API_KEY')
  );
}

/** Any way this deployment can turn a request into a bill closes the door. */
export function billableSurfaceConfigured(): boolean {
  return liveSpendingConfigured() || compilerIsOpen();
}

/** Fixed-width, constant-time-ish comparison without importing node:crypto. */
export function secretsMatch(offered: string, expected: string): boolean {
  if (offered.length !== expected.length) return false;
  let diff = 0;
  for (let index = 0; index < offered.length; index += 1) {
    diff |= offered.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return diff === 0;
}

export const LABS_TOKEN_HEADER = 'x-sidequest-labs';
export const LABS_TOKEN_COOKIE = 'sidequest_labs';

/**
 * The refusal a closed deployment gives when no token was ever configured. A
 * deployment that turns on spending and forgets the secret gets a locked door,
 * not an open one.
 */
export const LABS_UNCONFIGURED_MESSAGE =
  'The comparison harness is closed on this deployment: it is hosted or can spend, and no SIDEQUEST_LABS_TOKEN is set.';

export type LabsAccess =
  | { allowed: true }
  | { allowed: false; status: 404 | 401; message: string };

/**
 * The whole decision, given whatever credential the caller presented.
 *
 * Deliberately conditional rather than absolute, because an unconditional gate
 * would break the thing it protects. **Fixture mode stays open**: the default
 * configuration — and everything the browser suite runs against — makes no paid
 * call at all, so requiring a secret there would add a login to a surface that
 * cannot cost anything. **Any billable configuration closes it** unless a token
 * is set and presented.
 *
 * Takes the offered credential rather than reading it, because the two callers
 * read it from different places: `NextRequest` on the edge, `next/headers` in a
 * server action. Where the string came from is their problem; what it is worth
 * is this function's.
 */
export function labsAccess(offered: string): LabsAccess {
  /*
   * Private alpha — a hosted deployment is closed too. The rule above is about
   * spending; but an internal evaluation harness and design lab on a URL handed
   * to alpha testers is not a surface they should land on, whatever it costs.
   * Same platform signal as `requiredConfigProblems` (Railway sets
   * RAILWAY_ENVIRONMENT; SIDEQUEST_REQUIRE_CONFIG=on elsewhere), read inline
   * because this module stays import-free for the proxy.
   */
  const hosted = (process.env.RAILWAY_ENVIRONMENT ?? '').trim() !== '' || (process.env.SIDEQUEST_REQUIRE_CONFIG ?? '').trim().toLowerCase() === 'on';
  if (!billableSurfaceConfigured() && !hosted) return { allowed: true };

  const expected = process.env.SIDEQUEST_LABS_TOKEN?.trim();
  if (!expected) return { allowed: false, status: 404, message: LABS_UNCONFIGURED_MESSAGE };

  if (!offered || !secretsMatch(offered, expected)) {
    return { allowed: false, status: 401, message: 'Not authorised.' };
  }
  return { allowed: true };
}
