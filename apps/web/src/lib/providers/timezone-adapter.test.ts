import { describe, expect, it } from 'vitest';
import { resolveCivilTimeZones, timeZoneCacheKey } from './timezone';

/**
 * THE ADAPTER THAT DECIDES WHAT TIME IT IS, EXERCISED.
 *
 * Its docstring makes three promises — it refuses a fixed offset, it never
 * returns a neighbour's zone, and it spends nothing when the answer is already
 * held — and none of them had a test. The refusal in particular is the whole
 * reason the file exists: Open-Meteo answers `GMT` for points at sea and for
 * ground its boundary set does not cover, and accepting that would put a zone
 * with no daylight saving on a trip and label it authoritative, which is exactly
 * what the longitude derivation was demoted for.
 */

const MADRID = { id: 'destination', lat: 40.4168, lng: -3.7038 };

function stub(body: unknown, init: { status?: number } = {}): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status: init.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
}

describe('resolving a coordinate to a civil time zone', () => {
  it('takes a real regional identifier', async () => {
    const { answers, calls } = await resolveCivilTimeZones([MADRID], {
      maxCalls: 1,
      fetchImpl: stub({ timezone: 'Europe/Madrid', utc_offset_seconds: 7200 }),
    });
    expect(calls).toBe(1);
    expect(answers[0]!.timeZone).toBe('Europe/Madrid');
  });

  it('REFUSES a fixed offset, however plausible the reply looks', async () => {
    /*
     * A successful 200 carrying a legitimate IANA identifier that is not a civil
     * zone. Only the civility check can reject it, so this is falsifiable by
     * construction — and the caller then falls back to the solar approximation
     * and labels it degraded, which is a visibly worse answer and a true one.
     */
    for (const zone of ['GMT', 'UTC', 'Etc/GMT+5', 'Etc/UTC']) {
      const { answers } = await resolveCivilTimeZones([MADRID], {
        maxCalls: 1,
        fetchImpl: stub({ timezone: zone }),
      });
      expect(answers[0]!.timeZone, `${zone} was accepted as a civil zone`).toBeNull();
      expect(answers[0]!.detail).toMatch(/fixed offset/i);
    }
  });

  it('says nothing rather than something when the service will not answer', async () => {
    for (const reply of [
      { body: {}, status: 200 },
      { body: { timezone: '' }, status: 200 },
      { body: { error: true }, status: 503 },
    ]) {
      const { answers } = await resolveCivilTimeZones([MADRID], {
        maxCalls: 1,
        fetchImpl: stub(reply.body, { status: reply.status }),
      });
      expect(answers[0]!.timeZone).toBeNull();
      expect(answers[0]!.detail.length).toBeGreaterThan(10);
    }
  });

  it('spends nothing on a point it already holds an answer for', async () => {
    const store = new Map<string, { timeZone: string }>();
    const cache = {
      read: (key: string) => store.get(key) ?? null,
      write: (key: string, value: { timeZone: string }) => void store.set(key, value),
    };
    const first = await resolveCivilTimeZones([MADRID], {
      maxCalls: 1,
      cache,
      fetchImpl: stub({ timezone: 'Europe/Madrid' }),
    });
    expect(first.calls).toBe(1);

    /* A fetch that would throw if it were reached. */
    const second = await resolveCivilTimeZones([MADRID], {
      maxCalls: 1,
      cache,
      fetchImpl: (() => {
        throw new Error('the cache was not consulted');
      }) as unknown as typeof fetch,
    });
    expect(second.calls).toBe(0);
    expect(second.cacheHits).toBe(1);
    expect(second.answers[0]!.timeZone).toBe('Europe/Madrid');
  });

  it('refuses a cached value that is not a civil zone', async () => {
    /*
     * A cache written before the civility check existed, or by a different
     * version, must not be able to reintroduce the very thing the live path
     * rejects. The stored answer is re-checked on the way out, not only on the
     * way in.
     */
    const cache = {
      read: () => ({ timeZone: 'Etc/GMT+3' }),
      write: () => undefined,
    };
    const { answers, calls } = await resolveCivilTimeZones([MADRID], {
      maxCalls: 1,
      cache,
      fetchImpl: stub({ timezone: 'Europe/Madrid' }),
    });
    /* It went and asked again rather than serving the offset. */
    expect(calls).toBe(1);
    expect(answers[0]!.timeZone).toBe('Europe/Madrid');
  });

  it('stops at the budget, and says so rather than guessing', async () => {
    const points = [
      MADRID,
      { id: 'b', lat: 41.3874, lng: 2.1686 },
      { id: 'c', lat: 37.3891, lng: -5.9845 },
    ];
    const { answers, calls } = await resolveCivilTimeZones(points, {
      maxCalls: 2,
      fetchImpl: stub({ timezone: 'Europe/Madrid' }),
    });
    expect(calls).toBe(2);
    expect(answers[2]!.timeZone).toBeNull();
    expect(answers[2]!.detail).toMatch(/stopped looking/i);
  });

  it('shares one lookup between points that are genuinely the same point', async () => {
    let issued = 0;
    const fetchImpl = (async () => {
      issued += 1;
      return new Response(JSON.stringify({ timezone: 'Europe/Madrid' }), { status: 200 });
    }) as unknown as typeof fetch;

    const { answers, calls } = await resolveCivilTimeZones(
      [MADRID, { ...MADRID, id: 'base' }],
      { maxCalls: 2, fetchImpl },
    );
    expect(issued).toBe(1);
    expect(calls).toBe(1);
    expect(answers[1]!.timeZone).toBe('Europe/Madrid');
  });

  it('does not treat two points a kilometre apart as the same point', async () => {
    /**
     * The precision this rounds to is the one thing standing between "two bases
     * in one town share an answer" and "a base on the far side of a zone boundary
     * is handed its neighbour's clock". A kilometre was the first choice and is
     * wide enough to straddle a real boundary — the Nevada/Utah line, the Rhine
     * at Basel — so points that far apart must resolve separately.
     */
    const a = { id: 'a', lat: 40.4168, lng: -3.7038 };
    const b = { id: 'b', lat: 40.4268, lng: -3.7038 };
    expect(timeZoneCacheKey(a)).not.toBe(timeZoneCacheKey(b));

    let issued = 0;
    const fetchImpl = (async () => {
      issued += 1;
      return new Response(JSON.stringify({ timezone: 'Europe/Madrid' }), { status: 200 });
    }) as unknown as typeof fetch;
    await resolveCivilTimeZones([a, b], { maxCalls: 2, fetchImpl });
    expect(issued).toBe(2);
  });

  it('answers nothing for a point with no usable coordinates', async () => {
    const { answers, calls } = await resolveCivilTimeZones(
      [{ id: 'broken', lat: Number.NaN, lng: 0 }],
      { maxCalls: 1, fetchImpl: stub({ timezone: 'Europe/Madrid' }) },
    );
    expect(calls).toBe(0);
    expect(answers[0]!.timeZone).toBeNull();
  });
});
