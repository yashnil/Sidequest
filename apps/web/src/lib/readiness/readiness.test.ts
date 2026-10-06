import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isLoopbackUrl, probeAnthropic, probeValhalla } from './probes.mjs';
import { cachedProbe, composerKnownRejected, localRouterKnownUnreachable, probeCapability, resetProbeCache } from './probe-cache';
import { createCompositeRouting } from '../providers/routing-composite';
import type { RoutingProvider } from '@sidequest/compiler';

/**
 * V1 CONVERGENCE — CONFIGURED IS NOT WORKING.
 *
 * `/api/readiness` reported routing "ready" for a Valhalla on localhost that
 * nothing was listening on. These pin the probes (with a mocked fetch — no
 * test here reaches a network), the cache that keeps them off the request
 * path, and the routing composite skipping a router the probe found dead.
 */

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
const refused: FetchLike = async () => {
  throw Object.assign(new TypeError('fetch failed'), { name: 'TypeError' });
};
const answering = (status: number): FetchLike => async () => new Response('{}', { status });

describe('probes', () => {
  it('a dead local Valhalla is failing and unreachable, not ready', async () => {
    const verdict = await probeValhalla({ SIDEQUEST_ROUTES_PROVIDER: 'valhalla', SIDEQUEST_ROUTES_URL: 'http://127.0.0.1:8002' }, refused);
    expect(verdict.state).toBe('failing');
    expect(verdict.unreachable).toBe(true);
    expect(verdict.reason).toMatch(/loopback/);
  });

  it('a Valhalla that answers /status is working; one that 5xxs is failing', async () => {
    const seen: string[] = [];
    const ok = await probeValhalla({ SIDEQUEST_ROUTES_PROVIDER: 'valhalla', SIDEQUEST_ROUTES_URL: 'https://routes.example/' }, async (url) => {
      seen.push(url);
      return new Response('{}', { status: 200 });
    });
    expect(ok.state).toBe('working');
    expect(seen).toEqual(['https://routes.example/status']);
    expect((await probeValhalla({ SIDEQUEST_ROUTES_PROVIDER: 'valhalla', SIDEQUEST_ROUTES_URL: 'https://routes.example' }, answering(503))).state).toBe('failing');
    expect((await probeValhalla({}, answering(200))).state).toBe('not_configured');
  });

  it('the model probe uses the free models list and tells a rejected key from a busy one', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const env = { ANTHROPIC_API_KEY: 'sk-test-not-real' };
    const ok = await probeAnthropic(env, async (url, init) => {
      calls.push({ url, ...(init ? { init } : {}) });
      return new Response('{"data":[]}', { status: 200 });
    });
    expect(ok.state).toBe('working');
    expect(calls[0]?.url).toMatch(/\/v1\/models/);
    expect(calls[0]?.init?.method).toBe('GET');
    const rejected = await probeAnthropic(env, answering(401));
    expect(rejected.state).toBe('failing');
    expect(rejected.authRejected).toBe(true);
    /* The key never appears in what an operator reads. */
    expect(rejected.reason).not.toContain('sk-test-not-real');
    expect((await probeAnthropic(env, answering(429))).state).toBe('degraded');
    expect((await probeAnthropic({}, answering(200))).state).toBe('not_configured');
    expect((await probeAnthropic({ SIDEQUEST_COMPOSER_PROVIDER: 'fixture' }, refused)).state).toBe('configured_unverified');
  });

  it('knows a loopback URL when it sees one', () => {
    expect(isLoopbackUrl('http://127.0.0.1:8002')).toBe(true);
    expect(isLoopbackUrl('http://localhost:8002')).toBe(true);
    expect(isLoopbackUrl('https://valhalla1.openstreetmap.de')).toBe(false);
    expect(isLoopbackUrl('not a url')).toBe(false);
  });
});

describe('probe cache', () => {
  beforeEach(() => resetProbeCache());

  it('is honoured within the TTL and asked again after it', async () => {
    let now = 1_000_000;
    const fetchImpl = vi.fn(refused);
    const env = { SIDEQUEST_ROUTES_PROVIDER: 'valhalla', SIDEQUEST_ROUTES_URL: 'http://127.0.0.1:8002' };
    const options = { env, fetchImpl, now: () => now };
    await probeCapability('routing.local', options);
    await probeCapability('routing.local', options);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    now += 30_000;
    expect(localRouterKnownUnreachable(now)).toBe(true);
    now += 61_000; /* past the routing TTL */
    expect(cachedProbe('routing.local', now)).toBeNull();
    expect(localRouterKnownUnreachable(now)).toBe(false);
    await probeCapability('routing.local', options);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('concurrent askers share one probe', async () => {
    const fetchImpl = vi.fn(answering(200));
    const env = { ANTHROPIC_API_KEY: 'sk-test-not-real' };
    await Promise.all([probeCapability('composition', { env, fetchImpl }), probeCapability('composition', { env, fetchImpl }), probeCapability('composition', { env, fetchImpl })]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('a cold cache is unknown, never "down", and a build read starts nothing', () => {
    expect(localRouterKnownUnreachable()).toBe(false);
    expect(composerKnownRejected()).toBe(false);
    expect(cachedProbe('routing.local')).toBeNull();
  });
});

describe('the routing composite and the probe', () => {
  function router(name: string, calls: string[]): RoutingProvider {
    return {
      name,
      supportedModes: () => ['car'],
      async matrix({ points }: { points: readonly { id: string }[] }) {
        calls.push(name);
        return { ids: points.map((p) => p.id), minutes: points.map(() => points.map(() => 5)), km: points.map(() => points.map(() => 3)), provenance: { kind: 'measured', note: name }, failedPairs: [], calls: 1, elements: points.length * points.length } as never;
      },
    } as unknown as RoutingProvider;
  }
  const coverage = { declared: false, label: 'undeclared', coversAll: () => true } as never;
  const points = [
    { id: 'a', lat: 64.1, lng: -21.9 },
    { id: 'b', lat: 64.2, lng: -21.8 },
  ];

  it('skips a local router the probe found unreachable, without asking it once', async () => {
    const calls: string[] = [];
    const composite = createCompositeRouting({ local: router('local', calls), localCoverage: coverage, global: router('global', calls), localKnownUnreachable: true });
    await composite!.matrix({ points, mode: 'car' } as never);
    expect(calls).toEqual(['global']);
  });

  it('asks the local router as before when the probe has said nothing', async () => {
    const calls: string[] = [];
    const composite = createCompositeRouting({ local: router('local', calls), localCoverage: coverage, global: router('global', calls) });
    await composite!.matrix({ points, mode: 'car' } as never);
    expect(calls).toEqual(['local']);
  });
});

describe('readiness report', () => {
  let dir: string;
  function releaseDatabase(): void {
    const holder = globalThis as unknown as { sidequestDb?: { close(): void } };
    holder.sidequestDb?.close();
    delete holder.sidequestDb;
  }
  beforeEach(() => {
    resetProbeCache();
    releaseDatabase();
    dir = mkdtempSync(join(tmpdir(), 'sq-readiness-'));
    vi.stubEnv('SIDEQUEST_DB_PATH', join(dir, 'readiness.db'));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    releaseDatabase();
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports a configured but dead router as failing, not ready, and spends no paid call', async () => {
    const { readinessReport } = await import('./report');
    const urls: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      urls.push(url);
      if (url.includes('127.0.0.1')) throw new TypeError('fetch failed');
      return new Response('{}', { status: 200 });
    };
    const env = {
      SIDEQUEST_DB_PATH: join(dir, 'readiness.db'),
      SIDEQUEST_ROUTES_PROVIDER: 'valhalla',
      SIDEQUEST_ROUTES_URL: 'http://127.0.0.1:8002',
      SIDEQUEST_COMPOSER_PROVIDER: 'fixture',
      SIDEQUEST_GEOCODER_PROVIDER: 'nominatim',
    };
    const report = await readinessReport({ env, fetchImpl });
    const routing = report.capabilities.find((row) => row.capability === 'routing');
    expect(routing?.state).toBe('failing');
    expect(report.degraded).toContain('routing');
    /* The geocoder is a volunteer service: configured, never polled. */
    expect(report.capabilities.find((row) => row.capability === 'destination_resolution')?.state).toBe('configured_unverified');
    expect(urls.some((url) => /nominatim|openstreetmap\.org\/search/.test(url))).toBe(false);
    /* Only free endpoints were asked. */
    for (const url of urls) expect(url).toMatch(/127\.0\.0\.1|open-meteo\.com/);
    /* The database answered and is on an absolute path. */
    expect(report.capabilities.find((row) => row.capability === 'database')?.state).toBe('working');
    expect(report.ready).toBe(true);
  });

  it('a refused fixture switch in production blocks readiness', async () => {
    const { readinessReport } = await import('./report');
    const env = { NODE_ENV: 'production', SIDEQUEST_DB_PATH: join(dir, 'readiness.db'), SIDEQUEST_COMPOSER_PROVIDER: 'fixture', SIDEQUEST_WEATHER_PROVIDER: 'off', SIDEQUEST_CLIMATE_PROVIDER: 'off' };
    const report = await readinessReport({ env, fetchImpl: refused });
    expect(report.ready).toBe(false);
    expect(report.blocking).toEqual(expect.arrayContaining(['fixtures', 'composition']));
    expect(report.problems.join(' ')).toMatch(/SIDEQUEST_COMPOSER_PROVIDER=fixture/);
  });
  it('every row carries a practical verdict: a missing model is broken, missing enrichment is degraded with its consequence', async () => {
    const { readinessReport } = await import('./report');
    const env = { SIDEQUEST_DB_PATH: join(dir, 'readiness.db'), SIDEQUEST_WEATHER_PROVIDER: 'off', SIDEQUEST_CLIMATE_PROVIDER: 'off', SIDEQUEST_BASE_URL: 'http://localhost:3000' };
    const report = await readinessReport({ env, fetchImpl: refused });
    const row = (capability: string) => report.capabilities.find((r) => r.capability === capability)!;
    expect(report.ready).toBe(false);
    expect(row('composition').verdict).toBe('broken');
    expect(row('composition').consequence).toMatch(/cannot be generated/);
    expect(row('routing').verdict).toBe('degraded');
    expect(row('routing').consequence).toMatch(/labelled distance estimates/);
    expect(row('food_grounding').consequence).toMatch(/area-level/);
    expect(row('base_url').verdict).toBe('degraded');
    expect(row('database').verdict).toBe('ready');
    expect(row('destination_suggestions').verdict).toBe('ready');
    expect(JSON.stringify(report)).not.toContain(dir);
  });
});
