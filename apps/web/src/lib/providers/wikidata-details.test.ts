import { describe, expect, it, vi } from 'vitest';
import recorded from './fixtures/wikidata/lisbon-around-details.json';
import { MAX_DETAIL_IDS, detailsFromBindings, fetchWikidataDetails, sparqlDetails } from './wikidata-details';

const bindings = (recorded as unknown as { bindings: unknown[] }).bindings;
const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('fetchWikidataDetails', () => {
  it('asks once for the whole pool, capped, and caches the answer', async () => {
    const ids = Array.from({ length: 80 }, (_, i) => `Q${i + 1}`);
    const fetchImpl = vi.fn(async () => answer({ results: { bindings } }));
    const store = new Map<string, unknown>();
    const cache = { read: (k: string) => (store.get(k) as never) ?? null, write: (k: string, v: unknown) => void store.set(k, v) };
    const first = await fetchWikidataDetails(ids, { fetchImpl: fetchImpl as unknown as typeof fetch, cache });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const url = new URL(String((fetchImpl.mock.calls[0] as unknown[])[0]));
    const query = url.searchParams.get('query')!;
    expect(query.match(/wd:Q\d+/g)).toHaveLength(MAX_DETAIL_IDS);
    expect(first.get('Q636780')?.description).toBe('Moorish castle in Lisbon, Portugal');
    const again = await fetchWikidataDetails(ids, { fetchImpl: fetchImpl as unknown as typeof fetch, cache });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(again.get('Q636780')?.heritage).toEqual(['National Monument of Portugal']);
  });

  it('is nothing known, never a throw, when the service refuses or answers garbage', async () => {
    expect((await fetchWikidataDetails(['Q1'], { fetchImpl: (async () => answer({}, 503)) as unknown as typeof fetch })).size).toBe(0);
    expect((await fetchWikidataDetails(['Q1'], { fetchImpl: (async () => answer({ nope: 1 })) as unknown as typeof fetch })).size).toBe(0);
    expect((await fetchWikidataDetails(['Q1'], { fetchImpl: (async () => { throw new Error('down'); }) as unknown as typeof fetch })).size).toBe(0);
    expect((await fetchWikidataDetails(['not-an-id'], {})).size).toBe(0);
  });

  it('refuses links and markup in world-editable text', () => {
    const out = detailsFromBindings([{ item: { value: 'http://www.wikidata.org/entity/Q5' }, description: { value: 'see https://spam.example' }, styles: { value: 'Gothic<script>|Baroque' } }]);
    expect(out.get('Q5')?.description).toBeUndefined();
    expect(out.get('Q5')?.styles).toEqual(['Gothic script', 'Baroque']);
  });

  it('builds one VALUES query with every field optional', () => {
    const q = sparqlDetails(['Q1', 'Q2']);
    expect(q).toContain('VALUES ?item { wd:Q1 wd:Q2 }');
    expect(q.match(/OPTIONAL/g)!.length).toBe(7);
  });
});
