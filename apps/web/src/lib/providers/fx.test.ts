import { beforeEach, describe, expect, it } from 'vitest';
import { clearFxCache, fetchReferenceRates, fxProviderChoice } from './fx';

/** V1 CONVERGENCE — keyless ECB rates, on by default, one request, cached, and never a guess. */
function stub(body: unknown) {
  const urls: string[] = [];
  const fetchImpl = (async (url: string) => {
    urls.push(String(url));
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { urls, fetchImpl };
}

describe('FX defaults and coverage', () => {
  beforeEach(() => clearFxCache());

  it('is on by default and off only when asked', () => {
    expect(fxProviderChoice({})).toBe('frankfurter');
    expect(fxProviderChoice({ SIDEQUEST_FX_PROVIDER: 'off' })).toBe('off');
    expect(fxProviderChoice({ SIDEQUEST_FX_PROVIDER: 'fixture' })).toBe('fixture');
  });

  it('asks once for every currency it can answer, skips the ones the ECB does not publish, and caches', async () => {
    const http = stub({ amount: 1, base: 'USD', date: '2026-10-05', rates: { EUR: 0.86, CHF: 0.83 } });
    const now = new Date('2026-10-06T00:00:00Z');
    const rates = await fetchReferenceRates('USD', ['EUR', 'VND', 'CHF'], { fetchImpl: http.fetchImpl, choice: 'frankfurter', now });
    expect(http.urls).toHaveLength(1);
    expect(http.urls[0]).toContain('to=CHF,EUR');
    expect(http.urls[0]).not.toContain('VND');
    expect(rates.map((r) => r.quote)).toEqual(['CHF', 'EUR']);
    expect(rates[0]).toMatchObject({ base: 'USD', asOf: '2026-10-05', source: 'ECB via Frankfurter' });
    await fetchReferenceRates('USD', ['EUR', 'CHF'], { fetchImpl: http.fetchImpl, choice: 'frankfurter', now });
    expect(http.urls).toHaveLength(1);
  });

  it('makes no request at all when nothing it needs is published', async () => {
    const http = stub({});
    expect(await fetchReferenceRates('USD', ['VND', 'KGS'], { fetchImpl: http.fetchImpl, choice: 'frankfurter' })).toEqual([]);
    expect(http.urls).toHaveLength(0);
  });

  it('fixture serves dated table rates; off serves nothing', async () => {
    expect((await fetchReferenceRates('USD', ['EUR'], { choice: 'fixture' }))[0]).toMatchObject({ rate: 0.92, source: 'fixture' });
    expect(await fetchReferenceRates('USD', ['EUR'], { choice: 'off' })).toEqual([]);
  });
});
