import { describe, expect, it } from 'vitest';
import { ProviderFailure, encodePolyline, decodePolyline, placeClassFor, OPERATIONAL_SEMANTICS } from '@sidequest/core';
import { capabilityRegistry, modeLabel } from './capabilities.mjs';
import { discoverNearby, mediaFacts, operationalFacts, resolveIdentity } from './google-places';
import { computeGoogleRoute, summariseTransit, trafficIsMeaningful } from './google-routes';
import { decideRouting, durationLabel } from './routing-policy';
import { fetchReferenceRate } from './fx';
import { CACHE_TTL_MS, cacheKeyFor, isExpired } from './cache-policy';
import { ProviderBudget, boundedAll, ceilingsFor } from './cost-budget';

/**
 * PROVIDER CONTRACTS, EXERCISED AGAINST REALISTIC PAYLOADS.
 *
 * Every response below is shaped like the documented API answer, never
 * `{ ok: true }`. No request leaves the process: `fetchImpl` is a stub, and a
 * test that reached the network would fail on the hostname assertion.
 */
const NOW = new Date('2026-09-04T12:00:00Z');

function stub(handler: (url: string, init?: RequestInit) => { status: number; body: unknown } | Promise<{ status: number; body: unknown }>): { fetchImpl: typeof fetch; calls: { url: string; init?: RequestInit }[] } {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    expect(url).toMatch(/^https:\/\/(places|routes)\.googleapis\.com|^https:\/\/api\.frankfurter\.app/);
    calls.push({ url, ...(init ? { init } : {}) });
    const answer = await handler(url, init);
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const googlePlace = (over: Record<string, unknown> = {}) => ({
  id: 'ChIJrTLr-GyuEmsRBfy61i59si0',
  displayName: { text: 'Convict Lake', languageCode: 'en' },
  formattedAddress: 'Convict Lake, Mammoth Lakes, CA 93546, USA',
  location: { latitude: 37.5893, longitude: -118.8545 },
  types: ['natural_feature', 'tourist_attraction', 'point_of_interest'],
  primaryType: 'natural_feature',
  addressComponents: [
    { longText: 'Mammoth Lakes', shortText: 'Mammoth Lakes', types: ['locality', 'political'] },
    { longText: 'California', shortText: 'CA', types: ['administrative_area_level_1', 'political'] },
    { longText: 'United States', shortText: 'US', types: ['country', 'political'] },
  ],
  ...over,
});

describe('Google Places — identity level', () => {
  it('resolves an exact name near the destination, with a field mask that asks for identity fields only', async () => {
    const http = stub(() => ({ status: 200, body: { places: [googlePlace()] } }));
    const hit = await resolveIdentity({ name: 'Convict Lake', locality: 'Mammoth Lakes', category: 'water', near: { lat: 37.65, lng: -118.97 }, radiusKm: 30 }, { fetchImpl: http.fetchImpl, apiKey: 'test' });
    expect(hit?.providerRef).toBe('ChIJrTLr-GyuEmsRBfy61i59si0');
    expect(hit?.confidence).toBe('exact');
    expect(hit?.placeClass).toBe('open_ground');
    expect(hit?.countryCode).toBe('US');
    expect(hit?.attribution).toMatch(/Google/);
    const headers = http.calls[0]!.init!.headers as Record<string, string>;
    expect(headers['x-goog-fieldmask']).not.toMatch(/regularOpeningHours|photos|priceLevel/);
    expect(headers['x-goog-api-key']).toBe('test');
  });

  it('a same-name place in the wrong city is not a match: distance and locality disqualify it', async () => {
    const http = stub(() => ({ status: 200, body: { places: [googlePlace({ displayName: { text: 'Starbucks' }, formattedAddress: 'Starbucks, Seattle, WA', location: { latitude: 47.6, longitude: -122.3 }, addressComponents: [{ longText: 'Seattle', types: ['locality'] }] })] } }));
    const hit = await resolveIdentity({ name: 'Starbucks', locality: 'Mammoth Lakes', category: 'food', near: { lat: 37.65, lng: -118.97 }, radiusKm: 10 }, { fetchImpl: http.fetchImpl, apiKey: 'test' });
    expect(hit).toBeNull();
  });

  it('ambiguity: two candidates, the one whose address carries the locality wins', async () => {
    const http = stub(() => ({ status: 200, body: { places: [googlePlace({ id: 'far', displayName: { text: 'Lake Museum' }, formattedAddress: 'Lake Museum, Bishop, CA', location: { latitude: 37.36, longitude: -118.39 }, addressComponents: [{ longText: 'Bishop', types: ['locality'] }] }), googlePlace({ id: 'near', displayName: { text: 'Lake Museum' }, formattedAddress: 'Lake Museum, Mammoth Lakes, CA', location: { latitude: 37.64, longitude: -118.96 } })] } }));
    const hit = await resolveIdentity({ name: 'Lake Museum', locality: 'Mammoth Lakes', category: 'museum', near: { lat: 37.65, lng: -118.97 }, radiusKm: 10 }, { fetchImpl: http.fetchImpl, apiKey: 'test' });
    expect(hit?.providerRef).toBe('near');
    expect(hit?.placeClass).toBe('business_venue');
  });

  it('normalises failures: 429 is rate_limited, 403 is unauthorized, a timeout is timeout — never not_found', async () => {
    const limited = stub(() => ({ status: 429, body: { error: { code: 429, status: 'RESOURCE_EXHAUSTED' } } }));
    await expect(resolveIdentity({ name: 'X', near: { lat: 0, lng: 0 }, radiusKm: 1 }, { fetchImpl: limited.fetchImpl, apiKey: 'test' })).rejects.toMatchObject({ reason: 'rate_limited' });
    const denied = stub(() => ({ status: 403, body: { error: { code: 403, status: 'PERMISSION_DENIED' } } }));
    await expect(resolveIdentity({ name: 'X', near: { lat: 0, lng: 0 }, radiusKm: 1 }, { fetchImpl: denied.fetchImpl, apiKey: 'test' })).rejects.toMatchObject({ reason: 'unauthorized' });
    const slow = (async () => {
      const error = new Error('aborted');
      error.name = 'TimeoutError';
      throw error;
    }) as unknown as typeof fetch;
    await expect(resolveIdentity({ name: 'X', near: { lat: 0, lng: 0 }, radiusKm: 1 }, { fetchImpl: slow, apiKey: 'test' })).rejects.toMatchObject({ reason: 'timeout' });
    await expect(resolveIdentity({ name: 'X', near: { lat: 0, lng: 0 }, radiusKm: 1 }, { fetchImpl: slow, apiKey: '' })).rejects.toBeInstanceOf(ProviderFailure);
  });
});

describe('Google Places — operational, media and discovery levels', () => {
  it('reads current hours and a closed business status without paying for photos', async () => {
    const http = stub(() => ({
      status: 200,
      body: { ...googlePlace({ displayName: { text: 'Peat Museum' }, types: ['museum'] }), businessStatus: 'CLOSED_TEMPORARILY', regularOpeningHours: { periods: [{ open: { day: 1, hour: 9, minute: 0 }, close: { day: 1, hour: 17, minute: 0 } }], weekdayDescriptions: ['Monday: 9:00 AM – 5:00 PM'] }, websiteUri: 'https://example.org', priceLevel: 'PRICE_LEVEL_MODERATE', googleMapsUri: 'https://maps.google.com/?cid=1' },
    }));
    const facts = await operationalFacts('ChIJ1', { fetchImpl: http.fetchImpl, apiKey: 'test' }, NOW);
    expect(facts?.businessStatus).toBe('closed_temporarily');
    expect(facts?.weeklyHours?.[0]).toEqual({ day: 1, openMinute: 540, closeMinute: 1020 });
    expect(facts?.priceLevel).toBe('moderate');
    expect(facts?.checkedAt).toBe(NOW.toISOString());
    const headers = http.calls[0]!.init!.headers as Record<string, string>;
    expect(headers['x-goog-fieldmask']).not.toMatch(/photos/);
    expect(http.calls[0]!.url).toMatch(/\/places\/ChIJ1$/);
  });

  it('media level carries photo attribution verbatim', async () => {
    const http = stub(() => ({ status: 200, body: { id: 'ChIJ1', photos: [{ name: 'places/ChIJ1/photos/abc', widthPx: 4032, heightPx: 3024, authorAttributions: [{ displayName: 'A Traveller', uri: 'https://maps.google.com/maps/contrib/1' }] }] } }));
    const media = await mediaFacts('ChIJ1', { fetchImpl: http.fetchImpl, apiKey: 'test' });
    expect(media?.photos[0]).toMatchObject({ name: 'places/ChIJ1/photos/abc', attribution: 'A Traveller', attributionUri: 'https://maps.google.com/maps/contrib/1' });
  });

  it('lodging discovery returns a bounded shortlist with no price and no availability, and drops permanently closed properties', async () => {
    const http = stub(() => ({
      status: 200,
      body: {
        places: [
          googlePlace({ id: 'h1', displayName: { text: 'Creekside Inn' }, types: ['lodging', 'hotel'], priceLevel: 'PRICE_LEVEL_MODERATE', rating: 4.4, userRatingCount: 812, businessStatus: 'OPERATIONAL', location: { latitude: 37.648, longitude: -118.972 } }),
          googlePlace({ id: 'h2', displayName: { text: 'Old Lodge' }, types: ['lodging'], businessStatus: 'CLOSED_PERMANENTLY', location: { latitude: 37.65, longitude: -118.97 } }),
          googlePlace({ id: 'h3', displayName: { text: 'Village Suites' }, types: ['lodging'], location: { latitude: 37.65, longitude: -118.98 } }),
          googlePlace({ id: 'h4', displayName: { text: 'Far Motel' }, types: ['lodging'], location: { latitude: 37.6, longitude: -118.9 } }),
        ],
      },
    }));
    const found = await discoverNearby({ kind: 'lodging', near: { lat: 37.65, lng: -118.97 }, radiusKm: 5 }, { fetchImpl: http.fetchImpl, apiKey: 'test' });
    expect(found.map((p) => p.providerRef)).toEqual(['h1', 'h3', 'h4']);
    expect(found.length).toBeLessThanOrEqual(3);
    expect(JSON.stringify(found)).not.toMatch(/tonight|available|\$\d/);
    expect(found[0]).toMatchObject({ priceLevel: 'moderate', rating: 4.4, attribution: 'Place data © Google' });
    const body = JSON.parse(http.calls[0]!.init!.body as string) as { includedType: string; pageSize: number };
    expect(body.includedType).toBe('lodging');
    expect(body.pageSize).toBeLessThanOrEqual(10);
  });

  it('food discovery is one call around a point, capped, never a destination sweep', async () => {
    const http = stub(() => ({ status: 200, body: { places: Array.from({ length: 12 }, (_, i) => googlePlace({ id: `r${i}`, displayName: { text: `Restaurant ${i}` }, types: ['restaurant'], location: { latitude: 37.65 + i * 0.001, longitude: -118.97 } })) } }));
    const found = await discoverNearby({ kind: 'food', near: { lat: 37.65, lng: -118.97 }, radiusKm: 2, query: 'casual dinner', maxResults: 5 }, { fetchImpl: http.fetchImpl, apiKey: 'test' });
    expect(http.calls).toHaveLength(1);
    expect(found).toHaveLength(5);
  });
});

describe('Google Routes — computeRoutes', () => {
  const polyline = encodePolyline([{ lat: 37.65, lng: -118.97 }, { lat: 37.62, lng: -118.9 }, { lat: 37.589, lng: -118.854 }]);
  it('a static drive: duration, distance and geometry, TRAFFIC_UNAWARE far from departure, static basis', async () => {
    const http = stub(() => ({ status: 200, body: { routes: [{ duration: '1500s', staticDuration: '1500s', distanceMeters: 22400, polyline: { encodedPolyline: polyline } }] } }));
    const result = await computeGoogleRoute({ from: { lat: 37.65, lng: -118.97 }, to: { lat: 37.589, lng: -118.854 }, mode: 'DRIVE', departAt: new Date('2027-01-01T09:00:00Z'), traffic: true, now: NOW }, { fetchImpl: http.fetchImpl, apiKey: 'test' });
    expect(result).toMatchObject({ found: true, minutes: 25, staticMinutes: 25, km: 22.4, basis: 'static', provider: 'google-routes' });
    expect(decodePolyline(result.encodedPolyline!)).toHaveLength(3);
    const body = JSON.parse(http.calls[0]!.init!.body as string) as { routingPreference: string; departureTime?: string };
    expect(body.routingPreference).toBe('TRAFFIC_UNAWARE');
    expect(body.departureTime).toBeUndefined();
  });

  it('traffic-aware inside the horizon keeps both figures and stamps the effective departure', async () => {
    const http = stub(() => ({ status: 200, body: { routes: [{ duration: '1980s', staticDuration: '1500s', distanceMeters: 22400, polyline: { encodedPolyline: polyline } }] } }));
    const departAt = new Date('2026-09-05T08:00:00Z');
    const result = await computeGoogleRoute({ from: { lat: 37.65, lng: -118.97 }, to: { lat: 37.589, lng: -118.854 }, mode: 'DRIVE', departAt, traffic: true, now: NOW }, { fetchImpl: http.fetchImpl, apiKey: 'test' });
    expect(result).toMatchObject({ minutes: 33, staticMinutes: 25, basis: 'traffic_aware', effectiveDepartAt: departAt.toISOString() });
    const body = JSON.parse(http.calls[0]!.init!.body as string) as { routingPreference: string; departureTime: string };
    expect(body.routingPreference).toBe('TRAFFIC_AWARE');
    expect(body.departureTime).toBe(departAt.toISOString());
  });

  it('transit: a summary the traveller can read, from the documented step shape', async () => {
    const http = stub(() => ({
      status: 200,
      body: {
        routes: [
          {
            duration: '1440s',
            staticDuration: '1440s',
            distanceMeters: 6200,
            polyline: { encodedPolyline: polyline },
            legs: [
              {
                steps: [
                  { travelMode: 'WALK', staticDuration: '300s' },
                  { travelMode: 'TRANSIT', staticDuration: '900s', transitDetails: { transitLine: { nameShort: 'Tsuen Wan', vehicle: { type: 'SUBWAY' } }, stopCount: 4 } },
                  { travelMode: 'WALK', staticDuration: '240s' },
                ],
              },
            ],
          },
        ],
      },
    }));
    const result = await computeGoogleRoute({ from: { lat: 22.28, lng: 114.16 }, to: { lat: 22.32, lng: 114.17 }, mode: 'TRANSIT', departAt: new Date('2026-10-10T01:00:00Z'), now: NOW }, { fetchImpl: http.fetchImpl, apiKey: 'test' });
    expect(result.basis).toBe('scheduled');
    expect(result.transitSummary).toBe('24 min by metro + walk');
    expect(result.transitLegs?.map((l) => l.mode)).toEqual(['walk', 'subway', 'walk']);
  });

  it('an empty routes array is the one honest no_route; a 503 is temporarily_unavailable; a timeout is a timeout', async () => {
    const none = stub(() => ({ status: 200, body: { routes: [] } }));
    expect((await computeGoogleRoute({ from: { lat: 0, lng: 0 }, to: { lat: 1, lng: 1 }, mode: 'TRANSIT', now: NOW }, { fetchImpl: none.fetchImpl, apiKey: 'test' })).reason).toBe('no_route');
    const down = stub(() => ({ status: 503, body: { error: { code: 503, status: 'UNAVAILABLE' } } }));
    expect((await computeGoogleRoute({ from: { lat: 0, lng: 0 }, to: { lat: 1, lng: 1 }, mode: 'DRIVE', now: NOW }, { fetchImpl: down.fetchImpl, apiKey: 'test' })).reason).toBe('temporarily_unavailable');
    const slow = (async () => {
      const error = new Error('aborted');
      error.name = 'TimeoutError';
      throw error;
    }) as unknown as typeof fetch;
    expect((await computeGoogleRoute({ from: { lat: 0, lng: 0 }, to: { lat: 1, lng: 1 }, mode: 'DRIVE', now: NOW }, { fetchImpl: slow, apiKey: 'test' })).reason).toBe('timeout');
  });

  it('summariseTransit collapses transfers into one readable line', () => {
    expect(summariseTransit([{ mode: 'walk', minutes: 5 }, { mode: 'bus', minutes: 12 }, { mode: 'rail', minutes: 20 }, { mode: 'walk', minutes: 3 }], 40)).toBe('40 min by bus + train + walk (1 change)');
    expect(trafficIsMeaningful(new Date('2026-09-05T12:00:00Z'), NOW)).toBe(true);
    expect(trafficIsMeaningful(new Date('2026-12-05T12:00:00Z'), NOW)).toBe(false);
  });
});

describe('routing policy', () => {
  const env = (over: Record<string, string>) => ({ SIDEQUEST_COMPILER_PROVIDER: 'open', SIDEQUEST_GEOCODER_PROVIDER: 'nominatim', ...over });
  it('Valhalla is the driving backbone; Google is used for traffic only inside the horizon on a high-value leg', () => {
    // Google traffic is an explicit opt-in (terms: Routes durations are not persistable) — never inferred from the key alone.
    const registry = capabilityRegistry(env({ SIDEQUEST_ROUTES_PROVIDER: 'valhalla', SIDEQUEST_ROUTES_URL: 'http://127.0.0.1:8002', GOOGLE_MAPS_API_KEY: 'k', SIDEQUEST_TRAFFIC_PROVIDER: 'google' }));
    const keyOnly = capabilityRegistry(env({ SIDEQUEST_ROUTES_PROVIDER: 'valhalla', GOOGLE_MAPS_API_KEY: 'k' }));
    expect(decideRouting({ mode: 'drive', registry: keyOnly, now: NOW, departAt: new Date('2026-09-05T09:00:00Z'), highValue: true }).provider).toBe('valhalla');
    expect(decideRouting({ mode: 'drive', registry, now: NOW, departAt: new Date('2027-01-01T09:00:00Z'), highValue: true }).provider).toBe('valhalla');
    const near = decideRouting({ mode: 'drive', registry, now: NOW, departAt: new Date('2026-09-05T09:00:00Z'), highValue: true });
    expect(near).toMatchObject({ provider: 'google-routes', traffic: true });
    expect(decideRouting({ mode: 'drive', registry, now: NOW, departAt: new Date('2026-09-05T09:00:00Z'), highValue: false }).provider).toBe('valhalla');
  });
  it('transit goes to Google only when Valhalla has no transit tiles; flights, boats and guides are never road-routed', () => {
    const withGoogle = capabilityRegistry(env({ SIDEQUEST_ROUTES_PROVIDER: 'valhalla', GOOGLE_MAPS_API_KEY: 'k', SIDEQUEST_TRANSIT_PROVIDER: 'google' }));
    expect(decideRouting({ mode: 'transit', registry: withGoogle, now: NOW }).provider).toBe('google-routes');
    const withTiles = capabilityRegistry(env({ SIDEQUEST_ROUTES_PROVIDER: 'valhalla', SIDEQUEST_TRANSIT_PROVIDER: 'valhalla', GOOGLE_MAPS_API_KEY: 'k' }));
    expect(decideRouting({ mode: 'transit', registry: withTiles, now: NOW }).provider).toBe('valhalla-multimodal');
    const none = capabilityRegistry(env({ SIDEQUEST_ROUTES_PROVIDER: 'valhalla' }));
    expect(decideRouting({ mode: 'transit', registry: none, now: NOW }).provider).toBe('schedule_or_estimate');
    for (const mode of ['flight', 'boat', 'ferry', 'guide_transfer', 'lodge_transfer', 'private_transfer'] as const) expect(decideRouting({ mode, registry: withGoogle, now: NOW }).provider).toBe('schedule_or_estimate');
  });
  it('nothing defaults to drive: a walk with no walking router is none, and the label never says live for static', () => {
    const registry = capabilityRegistry(env({}));
    expect(decideRouting({ mode: 'walk', registry, now: NOW }).provider).toBe('none');
    expect(durationLabel('static', 'measured')).toBe('measured, no traffic');
    expect(durationLabel('traffic_aware', 'measured')).toMatch(/with traffic/);
    expect(durationLabel(undefined, 'unmeasured')).toBe('not measured');
  });
});

describe('capability registry and modes', () => {
  it('fixture, mixed and live are decided from the environment, and live price/availability are never configured', () => {
    const fixture = capabilityRegistry({ SIDEQUEST_COMPOSER_PROVIDER: 'fixture', SIDEQUEST_COMPILER_PROVIDER: 'fixture', SIDEQUEST_WEATHER_PROVIDER: 'fixture', SIDEQUEST_IMAGERY_PROVIDER: 'fixture' });
    expect(fixture.mode).toBe('fixture');
    expect(modeLabel(fixture.mode)).toBe('Fixture');
    const mixed = capabilityRegistry({ ANTHROPIC_API_KEY: 'sk', SIDEQUEST_COMPILER_PROVIDER: 'fixture', SIDEQUEST_WEATHER_PROVIDER: 'fixture', SIDEQUEST_IMAGERY_PROVIDER: 'fixture' });
    expect(mixed.mode).toBe('mixed');
    const live = capabilityRegistry({ ANTHROPIC_API_KEY: 'sk-ant-SECRET-VALUE', SIDEQUEST_COMPILER_PROVIDER: 'open', SIDEQUEST_GEOCODER_PROVIDER: 'nominatim', SIDEQUEST_ROUTES_PROVIDER: 'valhalla', GOOGLE_MAPS_API_KEY: 'AIza-SECRET-VALUE', SIDEQUEST_TRAFFIC_PROVIDER: 'google' });
    expect(live.mode).toBe('live');
    expect(live.byId['lodging.live_price']!.available).toBe(false);
    expect(live.byId['lodging.availability']!.configured).toBe(false);
    expect(live.byId['lodging.discovery']!.configured).toBe(true);
    expect(live.byId['routing.traffic']!.configured).toBe(true);
    expect(JSON.stringify(live)).not.toMatch(/SECRET-VALUE/);
  });
});

describe('FX, cache policy and cost budgets', () => {
  it('Frankfurter answers a dated ECB reference rate; off means no conversion; a missing currency is not_found', async () => {
    const http = stub(() => ({ status: 200, body: { amount: 1, base: 'USD', date: '2026-09-03', rates: { EUR: 0.9187 } } }));
    const rate = await fetchReferenceRate('USD', 'EUR', { fetchImpl: http.fetchImpl, choice: 'frankfurter' });
    expect(rate).toEqual({ base: 'USD', quote: 'EUR', rate: 0.9187, asOf: '2026-09-03', source: 'ECB via Frankfurter' });
    expect(await fetchReferenceRate('USD', 'EUR', { choice: 'off' })).toBeNull();
    const missing = stub(() => ({ status: 200, body: { amount: 1, base: 'USD', date: '2026-09-03', rates: {} } }));
    await expect(fetchReferenceRate('USD', 'XXX', { fetchImpl: missing.fetchImpl, choice: 'frankfurter' })).rejects.toMatchObject({ reason: 'not_found' });
    expect((await fetchReferenceRate('USD', 'ISK', { choice: 'fixture' }))?.source).toBe('fixture');
  });
  it('volatile data expires; identity does not; FX and forecast keys carry their date', () => {
    const written = new Date('2026-09-01T00:00:00Z');
    expect(isExpired('traffic_route', written, new Date('2026-09-01T00:20:00Z'))).toBe(true);
    expect(isExpired('identity', written, new Date('2026-09-20T00:00:00Z'))).toBe(false);
    expect(isExpired('hours', written, new Date('2026-09-02T01:00:00Z'))).toBe(true);
    expect(CACHE_TTL_MS.traffic_route).toBeLessThan(CACHE_TTL_MS.hours);
    expect(cacheKeyFor('fx', ['USD', 'EUR'], { date: '2026-09-03' })).toBe('fx|USD|EUR|2026-09-03');
    expect(cacheKeyFor('traffic_route', ['a', 'b'], { departBucket: '2026-09-05T08' })).toContain('2026-09-05T08');
  });
  it('budgets refuse beyond the ceiling without retrying, and bounded concurrency never runs everything at once', async () => {
    const budget = new ProviderBudget(ceilingsFor({ anchors: 30, days: 12, bases: 6, mealsNeedingVenue: 4 }));
    expect(budget.ceilings.traffic).toBe(4);
    for (let i = 0; i < 4; i += 1) expect(budget.take('traffic')).toBe(true);
    expect(budget.take('traffic')).toBe(false);
    expect(budget.report().refused.traffic).toBe(1);
    let inFlight = 0;
    let peak = 0;
    const results = await boundedAll(Array.from({ length: 30 }, (_, i) => i), 4, () => false, async (i) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return i * 2;
    });
    expect(peak).toBeLessThanOrEqual(4);
    expect(results.filter((r) => r !== null)).toHaveLength(30);
    const late = await boundedAll([1, 2, 3], 2, () => true, async (i) => i);
    expect(late).toEqual([null, null, null]);
  });
});

describe('place-class semantics', () => {
  it('a lake has no hours, a museum has hours that may be unknown, a station runs on a schedule', () => {
    expect(OPERATIONAL_SEMANTICS[placeClassFor('water')].noHoursMeaning).toBe('open_access');
    expect(OPERATIONAL_SEMANTICS[placeClassFor('museum')].hoursMatter).toBe(true);
    expect(OPERATIONAL_SEMANTICS[placeClassFor('museum')].noHoursMeaning).toBe('hours_unknown');
    expect(OPERATIONAL_SEMANTICS[placeClassFor(undefined, { googleTypes: ['train_station'] })].scheduleMatters).toBe(true);
    expect(placeClassFor('nature', { googleTypes: ['natural_feature'] })).toBe('open_ground');
  });
});
