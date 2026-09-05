import { readFileSync } from 'node:fs';

/**
 * RECORDED GOOGLE PLACES RESPONSES, SERVED AS `fetch`.
 *
 * `SIDEQUEST_PLACES_FIXTURE=<path.json>` points at a file shaped
 * `{ searchText: { "<textQuery>": <searchText response> }, places: { "<placeId>": <place> } }`.
 * The real adapter, field masks, normalisation and reconciliation all run;
 * only the network is replaced. Nothing is sent anywhere and no key is used.
 */
export interface RecordedPlacesFixture {
  searchText?: Record<string, unknown>;
  places?: Record<string, unknown>;
}

export function loadRecordedPlaces(path: string): RecordedPlacesFixture {
  return JSON.parse(readFileSync(path, 'utf8')) as RecordedPlacesFixture;
}

export function recordedPlacesFetch(fixture: RecordedPlacesFixture): typeof fetch {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (/places:searchText$/.test(url)) {
      const body = init?.body ? (JSON.parse(String(init.body)) as { textQuery?: string }) : {};
      const hit = fixture.searchText?.[body.textQuery ?? ''];
      return json(hit ?? { places: [] });
    }
    const match = /\/places\/([^/?]+)$/.exec(url);
    if (match) {
      const id = decodeURIComponent(match[1]!);
      const place = fixture.places?.[id];
      if (place === 'timeout') {
        const error = new Error('timeout');
        error.name = 'TimeoutError';
        throw error;
      }
      return place ? json(place) : json({ error: { message: 'not found' } }, 404);
    }
    return json({ error: { message: 'unrecorded' } }, 404);
  }) as typeof fetch;
}
