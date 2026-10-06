import { describe, expect, it } from 'vitest';
import { geocode } from './nominatim';

/*
 * V1 — a record with `"extratags": null` is a record with no extra tags, not a
 * malformed answer. Recorded from a real response shape (2026-10-06): one
 * tagless row used to fail the whole array.
 */
const BODY = JSON.stringify([
  { place_id: 1, osm_type: 'relation', osm_id: 1, lat: '38.72', lon: '-109.58', display_name: 'Test National Park, Test County, Test State', name: 'Test National Park', category: 'leisure', type: 'nature_reserve', place_rank: 22, importance: 0.6, addresstype: 'leisure', address: { country_code: 'us' }, extratags: { wikidata: 'Q1' }, namedetails: { name: 'Test National Park' }, boundingbox: ['1', '2', '3', '4'] },
  { place_id: 2, osm_type: 'way', osm_id: 2, lat: '40.5', lon: '-112.0', display_name: 'Test Park, Somewhere', name: 'Test Park', category: 'leisure', type: 'park', place_rank: 25, importance: 0.1, addresstype: 'leisure', address: { country_code: 'us' }, extratags: null, namedetails: null, boundingbox: ['1', '2', '3', '4'] },
]);

describe('nominatim — null tag fields', () => {
  it('reads every row when one has no extratags or namedetails', async () => {
    const fetchImpl = (async () => new Response(BODY, { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    const result = await geocode('Test National Park', { limit: 5, fetchImpl });
    expect(result.places).toHaveLength(2);
    expect(result.places[1]!.extratags).toBeUndefined();
    expect(result.places[0]!.extratags?.wikidata).toBe('Q1');
  });
});
