import { readFileSync } from 'node:fs';

/**
 * RECORDED OPENROUTESERVICE RESPONSES — `SIDEQUEST_ROUTES_FIXTURE=<file.json>`.
 *
 * Same convention as the recorded Places fixture: the real adapter, headers
 * and parsing run; only the socket is replaced. The file maps a key built from
 * the profile and the two coordinates (4 dp) to the documented GeoJSON body
 * the hosted service returns, or to an error body with its HTTP status.
 *
 *   { "legs": { "driving-car|52.5200,-7.8906|51.8979,-8.4748": { "status": 200, "body": { ...geojson } } } }
 *
 * A key that is not recorded answers 404 with error code 2010 (no routable
 * point), which the adapter classifies as `insufficient_evidence` — honest
 * "not recorded", never "no route". The sentinel body `"timeout"` throws a
 * `TimeoutError`, so the timeout path is testable offline too.
 */
export interface RecordedRoutesFixture {
  legs: Record<string, { status: number; body: unknown }>;
}

export function loadRecordedRoutes(path: string): RecordedRoutesFixture {
  return JSON.parse(readFileSync(path, 'utf8')) as RecordedRoutesFixture;
}

export function recordedRouteKey(profile: string, from: { lat: number; lng: number }, to: { lat: number; lng: number }): string {
  const f = (n: number) => n.toFixed(4);
  return `${profile}|${f(from.lat)},${f(from.lng)}|${f(to.lat)},${f(to.lng)}`;
}

export function recordedRoutesFetch(fixture: RecordedRoutesFixture): typeof fetch {
  return (async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const match = /\/directions\/([a-z-]+)\/geojson$/.exec(url);
    if (!match) return new Response('unrecorded', { status: 404 });
    const body = init?.body ? (JSON.parse(String(init.body)) as { coordinates: [number, number][] }) : null;
    const [from, to] = body?.coordinates ?? [];
    if (!from || !to) return new Response(JSON.stringify({ error: { code: 2001, message: 'Missing coordinates' } }), { status: 400, headers: { 'content-type': 'application/json' } });
    const key = recordedRouteKey(match[1]!, { lat: from[1], lng: from[0] }, { lat: to[1], lng: to[0] });
    const recorded = fixture.legs[key];
    if (!recorded) return new Response(JSON.stringify({ error: { code: 2010, message: `Not recorded: ${key}` } }), { status: 404, headers: { 'content-type': 'application/json' } });
    if (recorded.body === 'timeout') {
      const error = new Error('aborted');
      error.name = 'TimeoutError';
      throw error;
    }
    return new Response(JSON.stringify(recorded.body), { status: recorded.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}
