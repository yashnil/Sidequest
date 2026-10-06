import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
// @ts-expect-error — an internal Next build module with no published types.
// `expect-error` rather than `ignore`, as `e2e/live/harness.test.ts` argues: if
// a future Next ships types for it, this line fails and somebody looks at the
// import rather than at nothing. The rationale for reaching in at all is on
// `the matcher that decides whether the gate runs at all` below.
import { getMiddlewareMatchers } from 'next/dist/build/analysis/get-page-static-info.js';
import { config, proxy } from './proxy';

/**
 * The spending control, asserted rather than assumed.
 *
 * `/labs` had no authentication of any kind and could start billed model work.
 * The posture below is the one the fix takes: closed when a deployment has
 * configured live spending, open otherwise so local development and the browser
 * suite are unaffected.
 */

const KEYS = [
  'SIDEQUEST_BENCHMARK_MODE',
  'SIDEQUEST_BENCHMARK_BUDGET_USD',
  'SIDEQUEST_LABS_TOKEN',
  'SIDEQUEST_COMPILER_PROVIDER',
  'SIDEQUEST_GEOCODER_PROVIDER',
  'SIDEQUEST_PLACE_BACKBONE',
  'SIDEQUEST_POI_PROVIDER',
  'SIDEQUEST_ROUTES_PROVIDER',
  'SIDEQUEST_RESEARCH_PROVIDER',
  'ANTHROPIC_API_KEY',
];
const saved = new Map(KEYS.map((key) => [key, process.env[key]]));

beforeEach(() => {
  // A clean slate, not an inherited shell: a developer with the open stack
  // configured must get the same verdicts CI gets.
  for (const key of KEYS) delete process.env[key];
});

afterEach(() => {
  for (const key of KEYS) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function request(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost:4200/labs/benchmark', { headers });
}

function liveMode(): void {
  process.env.SIDEQUEST_BENCHMARK_MODE = 'live';
  process.env.SIDEQUEST_BENCHMARK_BUDGET_USD = '5.00';
}

describe('the labs gate', () => {
  it('lets everything through when no live spending is configured', () => {
    delete process.env.SIDEQUEST_BENCHMARK_MODE;
    delete process.env.SIDEQUEST_BENCHMARK_BUDGET_USD;
    expect(proxy(request()).status).toBe(200);
  });

  it('stays open in fixture mode even with a budget set', () => {
    /** Both keys are required, exactly as the budget layer requires both. */
    process.env.SIDEQUEST_BENCHMARK_MODE = 'fixture';
    process.env.SIDEQUEST_BENCHMARK_BUDGET_USD = '5.00';
    expect(proxy(request()).status).toBe(200);
  });

  it('refuses an unauthenticated request once live spending is configured', () => {
    liveMode();
    process.env.SIDEQUEST_LABS_TOKEN = 'a-secret';
    expect(proxy(request()).status).toBe(401);
  });

  it('accepts the configured token', () => {
    liveMode();
    process.env.SIDEQUEST_LABS_TOKEN = 'a-secret';
    expect(proxy(request({ 'x-sidequest-labs': 'a-secret' })).status).toBe(200);
  });

  it('refuses a wrong token, and one of a different length', () => {
    liveMode();
    process.env.SIDEQUEST_LABS_TOKEN = 'a-secret';
    expect(proxy(request({ 'x-sidequest-labs': 'b-secret' })).status).toBe(401);
    expect(proxy(request({ 'x-sidequest-labs': 'a-secret-longer' })).status).toBe(401);
  });

  it('closes the door when live spending is on and nobody set a token', () => {
    /**
     * The direction this fails matters. A deployment that turns on spending and
     * forgets the secret must get a locked surface, not an open one.
     */
    liveMode();
    delete process.env.SIDEQUEST_LABS_TOKEN;
    expect(proxy(request()).status).toBe(404);
  });
});

describe('the labs gate, against an open compiler', () => {
  /**
   * The gap the first gate left. The benchmark's sidequest arm compiles REAL
   * regions whenever the compiler is open — the compiler has no idea it is in
   * a benchmark, by design — so `SIDEQUEST_BENCHMARK_MODE=fixture` was
   * spending money behind a predicate that said nothing billable existed.
   * The gate now mirrors `compilerProviderChoice() === 'open'`, inference and
   * all.
   */
  it('gates /labs when the compiler is explicitly open, whatever the benchmark mode', () => {
    process.env.SIDEQUEST_COMPILER_PROVIDER = 'open';
    process.env.SIDEQUEST_BENCHMARK_MODE = 'fixture';
    expect(proxy(request()).status).toBe(404);

    process.env.SIDEQUEST_LABS_TOKEN = 'a-secret';
    expect(proxy(request()).status).toBe(401);
    expect(proxy(request({ 'x-sidequest-labs': 'a-secret' })).status).toBe(200);
  });

  it('gates /labs when the open stack is merely inferred from the switches', () => {
    /** The inference `compilerProviderChoice()` makes with nothing configured. */
    process.env.SIDEQUEST_GEOCODER_PROVIDER = 'nominatim';
    process.env.SIDEQUEST_PLACE_BACKBONE = 'overture';
    process.env.SIDEQUEST_ROUTES_PROVIDER = 'valhalla';
    process.env.SIDEQUEST_RESEARCH_PROVIDER = 'anthropic';
    process.env.ANTHROPIC_API_KEY = 'sk-test-never-real';
    expect(proxy(request()).status).toBe(404);
  });

  it('stays open when the switches are set but the compiler is pinned to fixture', () => {
    /** The browser suite's exact shape: fixture pin beats every other switch. */
    process.env.SIDEQUEST_GEOCODER_PROVIDER = 'nominatim';
    process.env.SIDEQUEST_PLACE_BACKBONE = 'overture';
    process.env.SIDEQUEST_ROUTES_PROVIDER = 'valhalla';
    process.env.SIDEQUEST_RESEARCH_PROVIDER = 'anthropic';
    process.env.ANTHROPIC_API_KEY = 'sk-test-never-real';
    process.env.SIDEQUEST_COMPILER_PROVIDER = 'fixture';
    expect(proxy(request()).status).toBe(200);
  });

  it('stays open with an incomplete inferred stack, which cannot compile', () => {
    process.env.SIDEQUEST_GEOCODER_PROVIDER = 'nominatim';
    process.env.SIDEQUEST_ROUTES_PROVIDER = 'valhalla';
    // No place source, no research provider, no key: choice falls to `off`.
    expect(proxy(request()).status).toBe(200);
  });
});

describe('the matcher that decides whether the gate runs at all', () => {
  /**
   * THE PREDICATE WAS TESTED; THE WIRING WAS NOT.
   *
   * Every assertion above calls `proxy()` directly, so all of them hold
   * with `config.matcher` pointed at a route that does not exist — and a gate
   * Next never invokes is not a gate. That is not hypothetical: the whole
   * suite stayed green with the matcher rewritten to `/never-a-real-route/:path*`,
   * which means the release-blocking "labs is unreachable without a token"
   * claim rested on nobody having typo'd a string no test read.
   *
   * A string comparison against `'/labs/:path*'` would only move the problem:
   * it pins the spelling, not the meaning, and the meaning is Next's. So the
   * declared matcher is compiled by **Next's own** `getMiddlewareMatchers` —
   * the exact function the build runs to produce `middleware-manifest.json` —
   * and the resulting regexp is asked about real paths. If a future Next moves
   * that function this test fails loudly, which is the correct outcome: the
   * semantics of this file's one security-relevant constant would then be
   * decided by something nobody here has read.
   *
   * `{}` for the config because `next.config.ts` declares neither `basePath`
   * nor `i18n`; both would rewrite the source, and the day one is added this
   * test should be told about it.
   */
  const compiled = (getMiddlewareMatchers(config.matcher, {}) as { regexp: string }[]).map(
    (entry) => new RegExp(entry.regexp),
  );

  const matches = (pathname: string): boolean =>
    compiled.some((pattern) => pattern.test(pathname));

  it('runs the proxy for every path under the labs tree', () => {
    // The tree root, the one page in it, and a nested action target — the URL
    // shapes a labs request actually takes.
    expect(matches('/labs')).toBe(true);
    expect(matches('/labs/benchmark')).toBe(true);
    expect(matches('/labs/benchmark/some-run/detail')).toBe(true);
  });

  it('leaves the traveller journey alone, which is why the matcher is narrow', () => {
    /**
     * The other half of the property. A matcher wide enough to catch `/labs`
     * by catching everything would put an edge function in front of every
     * page in the product, and the file's own header promises it does not.
     */
    expect(matches('/')).toBe(false);
    expect(matches('/trips/a-trip-id/plan')).toBe(false);
    expect(matches('/decide')).toBe(false);
  });
});
