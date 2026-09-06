import { describe, expect, it } from 'vitest';
import { ORS_BASE, computeOrsRoute, createOrsRouting } from './openrouteservice';
import { recordedRouteKey, recordedRoutesFetch } from './openrouteservice-fixture';
import { parseRoutingCoverage } from './routing-coverage';
import { createCompositeRouting } from './routing-composite';
import type { RoutingProvider } from '@sidequest/compiler';

const CASHEL = { lat: 52.52, lng: -7.8906 };
const CORK = { lat: 51.8979, lng: -8.4748 };
const REYKJAVIK = { lat: 64.1466, lng: -21.9426 };
const VIK = { lat: 63.4187, lng: -19.0061 };

/** A documented ORS GeoJSON directions body: duration in seconds, distance in metres, coordinates lon/lat. */
function geojson(durationS: number, distanceM: number, coords: [number, number][]) {
  return { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { summary: { distance: distanceM, duration: durationS }, way_points: [0, coords.length - 1] }, geometry: { type: 'LineString', coordinates: coords } }], metadata: { attribution: 'openrouteservice.org | OpenStreetMap contributors', service: 'routing' } };
}

function stub(handler: (url: string, init?: RequestInit) => { status: number; body: unknown } | Promise<{ status: number; body: unknown }>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    expect(url).toMatch(/^https:\/\/api\.heigit\.org\/openrouteservice\/v2\//);
    calls.push({ url, ...(init ? { init } : {}) });
    const answer = await handler(url, init);
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe('openrouteservice adapter', () => {
  it('uses the current hosted base, sends lon/lat and the key, and reads duration, distance and geometry', async () => {
    const http = stub(() => ({ status: 200, body: geojson(5460, 91_200, [[-7.8906, 52.52], [-8.2, 52.2], [-8.4748, 51.8979]]) }));
    const result = await computeOrsRoute({ from: CASHEL, to: CORK, profile: 'driving-car' }, { fetchImpl: http.fetchImpl, apiKey: 'test-key' });
    expect(ORS_BASE).toBe('https://api.heigit.org/openrouteservice/v2');
    expect(http.calls[0]!.url).toBe(`${ORS_BASE}/directions/driving-car/geojson`);
    const headers = http.calls[0]!.init!.headers as Record<string, string>;
    expect(headers.authorization).toBe('test-key');
    expect(JSON.parse(http.calls[0]!.init!.body as string).coordinates).toEqual([[-7.8906, 52.52], [-8.4748, 51.8979]]);
    expect(result).toMatchObject({ found: true, minutes: 91, km: 91.2, provider: 'openrouteservice' });
    expect(result.geometry).toEqual([{ lat: 52.52, lng: -7.8906 }, { lat: 52.2, lng: -8.2 }, { lat: 51.8979, lng: -8.4748 }]);
  });
  it('2009 is the one honest "no route"; 2010 is a snapping gap; 429 is rate-limited; everything else is a provider error, and nothing throws', async () => {
    const answer = (status: number, code: number) => stub(() => ({ status, body: { error: { code, message: 'x' } } })).fetchImpl;
    expect((await computeOrsRoute({ from: CASHEL, to: CORK, profile: 'driving-car' }, { fetchImpl: answer(404, 2009), apiKey: 'k' })).reason).toBe('not_found');
    expect((await computeOrsRoute({ from: CASHEL, to: CORK, profile: 'driving-car' }, { fetchImpl: answer(404, 2010), apiKey: 'k' })).reason).toBe('insufficient_evidence');
    expect((await computeOrsRoute({ from: CASHEL, to: CORK, profile: 'driving-car' }, { fetchImpl: answer(429, 0), apiKey: 'k' })).reason).toBe('rate_limited');
    expect((await computeOrsRoute({ from: CASHEL, to: CORK, profile: 'driving-car' }, { fetchImpl: answer(500, 0), apiKey: 'k' })).reason).toBe('provider_error');
    const thrown = (async () => { const e = new Error('aborted'); e.name = 'TimeoutError'; throw e; }) as unknown as typeof fetch;
    expect((await computeOrsRoute({ from: CASHEL, to: CORK, profile: 'driving-car' }, { fetchImpl: thrown, apiKey: 'k' })).found).toBe(false);
    expect((await computeOrsRoute({ from: CASHEL, to: CORK, profile: 'driving-car' }, { fetchImpl: thrown })).reason).toBe('provider_error');
  });
  it('the matrix seam times only consecutive legs and the closing pair — never N²', async () => {
    const http = stub(() => ({ status: 200, body: geojson(1800, 30_000, [[-7.9, 52.5], [-8.4, 51.9]]) }));
    const routing = createOrsRouting({ routeCalls: 0, routePairs: 0 }, { fetchImpl: http.fetchImpl, apiKey: 'k' });
    const points = [{ id: 'a', ...CASHEL }, { id: 'b', ...CORK }, { id: 'c', lat: 51.7, lng: -8.5 }, { id: 'd', lat: 52.0, lng: -9.5 }];
    const result = await routing.matrix({ points, mode: 'car', maxElements: 100 });
    expect(http.calls).toHaveLength(4); // a→b, b→c, c→d, d→a
    expect(result.minutes[0]![1]).toBe(30);
    expect(result.minutes[1]![0]).toBe(30);
    expect(Number.isNaN(result.minutes[0]![2]!)).toBe(true);
    expect(result.failedPairs.filter((p) => p.reason === 'insufficient_evidence').length).toBe(4);
  });
  it('a recorded fixture answers the real adapter offline, and an unrecorded pair is a snapping gap, never a route', async () => {
    const key = recordedRouteKey('driving-car', CASHEL, CORK);
    const fetchImpl = recordedRoutesFetch({ legs: { [key]: { status: 200, body: geojson(5400, 90_000, [[-7.8906, 52.52], [-8.4748, 51.8979]]) } } });
    const hit = await computeOrsRoute({ from: CASHEL, to: CORK, profile: 'driving-car' }, { fetchImpl, apiKey: 'recorded-fixture' });
    expect(hit).toMatchObject({ found: true, minutes: 90, km: 90 });
    const miss = await computeOrsRoute({ from: CORK, to: CASHEL, profile: 'driving-car' }, { fetchImpl, apiKey: 'recorded-fixture' });
    expect(miss).toMatchObject({ found: false, reason: 'insufficient_evidence' });
  });
});

describe('routing coverage', () => {
  it('country codes and boxes declare coverage; undeclared coverage never blocks', () => {
    const iceland = parseRoutingCoverage('IS');
    expect(iceland.declared).toBe(true);
    expect(iceland.covers(REYKJAVIK)).toBe(true);
    expect(iceland.covers(CASHEL)).toBe(false);
    const box = parseRoutingCoverage('51,-11,56,-5');
    expect(box.covers(CASHEL)).toBe(true);
    expect(box.covers(REYKJAVIK)).toBe(false);
    const none = parseRoutingCoverage(undefined);
    expect(none.declared).toBe(false);
    expect(none.covers(CASHEL)).toBe(true);
    expect(parseRoutingCoverage('IS;51,-11,56,-5').coversAll([CASHEL, REYKJAVIK])).toBe(true);
  });
});

describe('composite routing', () => {
  const fake = (name: string, log: string[]): RoutingProvider => ({
    name,
    supportedModes: () => ['car', 'foot'],
    async matrix({ points }) {
      log.push(`${name}:matrix:${points.map((p) => p.id).join(',')}`);
      return { ids: points.map((p) => p.id), minutes: points.map(() => points.map(() => 10)), km: points.map(() => points.map(() => 5)), provenance: { kind: 'measured', note: name }, failedPairs: [], calls: 1, elements: points.length };
    },
    async route({ from }) {
      log.push(`${name}:route:${from.lat}`);
      return { found: true, minutes: 10, km: 5 };
    },
  });
  it('the local router is never asked outside its coverage; the global one answers there; nothing is asked when neither can', async () => {
    const log: string[] = [];
    const composite = createCompositeRouting({ local: fake('valhalla', log), localCoverage: parseRoutingCoverage('IS'), global: fake('ors', log) })!;
    await composite.matrix({ points: [{ id: 'r', ...REYKJAVIK }, { id: 'v', ...VIK }], mode: 'car', maxElements: 10 });
    await composite.matrix({ points: [{ id: 'c', ...CASHEL }, { id: 'k', ...CORK }], mode: 'car', maxElements: 10 });
    await composite.route!({ from: CASHEL, to: CORK, mode: 'car' });
    expect(log).toEqual(['valhalla:matrix:r,v', 'ors:matrix:c,k', `ors:route:${CASHEL.lat}`]);
    const localOnly = createCompositeRouting({ local: fake('valhalla', log), localCoverage: parseRoutingCoverage('IS'), global: null })!;
    const skipped = await localOnly.matrix({ points: [{ id: 'c', ...CASHEL }, { id: 'k', ...CORK }], mode: 'car', maxElements: 10 });
    expect(skipped.calls).toBe(0);
    expect(skipped.failedPairs.every((p) => p.reason === 'insufficient_evidence')).toBe(true);
    expect(log.filter((l) => l.startsWith('valhalla:matrix:c'))).toHaveLength(0);
  });
  it('with no declared coverage and no global router the local router is returned as-is', () => {
    const local = fake('valhalla', []);
    expect(createCompositeRouting({ local, localCoverage: parseRoutingCoverage(undefined), global: null })).toBe(local);
    expect(createCompositeRouting({ local: null, localCoverage: parseRoutingCoverage(undefined), global: null })).toBeNull();
  });
});
