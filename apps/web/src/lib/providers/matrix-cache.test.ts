import { describe, expect, it } from 'vitest';
import {
  computeMatrix,
  matrixPairCacheKey,
  type MatrixPairCache,
  type RoutePoint,
} from './valhalla';

/**
 * THE WARM BUILD, WHICH USED TO COST EXACTLY AS MUCH AS THE COLD ONE.
 *
 * Two live Tokyo builds three days apart both reported `routeCalls=4`,
 * `routePairs=676`, `routeCacheHits=0`. The second re-bought every pair and
 * spent 57.4 seconds doing it — 73% of its 78 seconds of machine time — for a
 * region whose ground had not moved.
 *
 * The cause was the cache key rather than the cache: an entry was a whole 20×20
 * block, named by the ordered coordinate lists of both its axes, so it could
 * only ever be read by a request that assembled the same forty points in the
 * same two orders. One extra place, one reordered candidate list, one different
 * block boundary, and every entry in the store became unreachable while
 * remaining perfectly valid.
 *
 * These tests are written against the counters rather than against the key,
 * because the counters are what a reviewer reads and what the regression
 * actually showed: `cacheHits` at zero on a rebuild is the defect, whatever the
 * key looks like.
 *
 * Nothing here opens a socket. `fetchImpl` is a stub that records what it was
 * asked for, which is also how the pairs-bought figure is measured.
 */

function grid(count: number): RoutePoint[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `p${index}`,
    // Spread over about 25 km so the plausibility check has room to accept the
    // durations below; a tighter grid would make every leg an implausible crawl.
    lat: 35.68 + index * 0.02,
    lng: 139.76 + index * 0.02,
  }));
}

/** A store with the shape the app's provider cache has, plus a call ledger. */
function memoryCache(): MatrixPairCache & { size(): number } {
  const held = new Map<string, { minutes: number; km: number }>();
  return {
    read: (key) => held.get(key) ?? null,
    write: (key, value) => {
      held.set(key, value);
    },
    size: () => held.size,
  };
}

interface Recorder {
  fetchImpl: typeof fetch;
  calls: number;
  pairsRequested: number;
}

/**
 * A router that answers every pair it is asked for, and counts them.
 *
 * The durations are derived from the index distance so that they and their
 * kilometres reconcile at an ordinary driving speed — otherwise the
 * plausibility filter would drop the cells and the counters would be measuring
 * the filter instead of the cache.
 */
function recordingRouter(): Recorder {
  const recorder: Recorder = {
    calls: 0,
    pairsRequested: 0,
    fetchImpl: (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        sources: { lat: number; lon: number }[];
        targets: { lat: number; lon: number }[];
      };
      recorder.calls += 1;
      recorder.pairsRequested += body.sources.length * body.targets.length;

      const cells: unknown[] = [];
      for (let from = 0; from < body.sources.length; from += 1) {
        for (let to = 0; to < body.targets.length; to += 1) {
          const source = body.sources[from]!;
          const target = body.targets[to]!;
          const km =
            Math.abs(source.lat - target.lat) * 111 + Math.abs(source.lon - target.lon) * 91;
          cells.push({
            from_index: from,
            to_index: to,
            // 60 km/h, which every band accepts for a car.
            time: Math.max(0, Math.round((km / 60) * 3600)),
            distance: km,
          });
        }
      }
      return new Response(JSON.stringify({ sources_to_targets: cells }), { status: 200 });
    }) as unknown as typeof fetch,
  };
  return recorder;
}

describe('the route matrix cache', () => {
  it('buys every pair on a cold build and none of them on an identical warm one', async () => {
    const points = grid(6);
    const cache = memoryCache();

    const cold = recordingRouter();
    const first = await computeMatrix(points, 'auto', {
      maxPairs: 400,
      fetchImpl: cold.fetchImpl,
      cache,
    });
    expect(first.cacheHits).toBe(0);
    expect(cold.calls).toBeGreaterThan(0);
    expect(first.failedPairs).toEqual([]);

    const warm = recordingRouter();
    const second = await computeMatrix(points, 'auto', {
      maxPairs: 400,
      fetchImpl: warm.fetchImpl,
      cache,
    });

    /*
     * The assertion the old key could not satisfy even for a byte-identical
     * request list, because the block it stored was keyed on an endpoint the
     * second run reproduced only by luck.
     */
    expect(warm.calls, 'a warm build called the router').toBe(0);
    expect(second.calls).toBe(0);
    expect(second.cacheHits).toBe(second.pairs);
    // And the answers are the same ones, not a differently-shaped rebuild.
    expect(second.minutes).toEqual(first.minutes);
    expect(second.km).toEqual(first.km);
  });

  it('reuses held pairs when the point set is reordered', async () => {
    const points = grid(6);
    const cache = memoryCache();

    const cold = recordingRouter();
    await computeMatrix(points, 'auto', { maxPairs: 400, fetchImpl: cold.fetchImpl, cache });

    /*
     * THE CASE THAT MADE THE OLD CACHE USELESS IN PRACTICE.
     *
     * Nothing about the region changed; the candidate list simply came back in a
     * different order, which changes every block's composition and therefore
     * every block key. The pairs are the same pairs.
     */
    const shuffled = [...points].reverse();
    const warm = recordingRouter();
    const second = await computeMatrix(shuffled, 'auto', {
      maxPairs: 400,
      fetchImpl: warm.fetchImpl,
      cache,
    });

    expect(warm.calls, 'a reordered point set re-bought the region').toBe(0);
    expect(second.cacheHits).toBe(second.pairs);
  });

  it('buys only the pairs a new place adds, not the whole square again', async () => {
    const points = grid(6);
    const cache = memoryCache();

    const cold = recordingRouter();
    await computeMatrix(points, 'auto', { maxPairs: 400, fetchImpl: cold.fetchImpl, cache });
    const coldPairs = cold.pairsRequested;

    const withOneMore = [...points, { id: 'p6', lat: 35.68 + 6 * 0.02, lng: 139.76 + 6 * 0.02 }];
    const warm = recordingRouter();
    const second = await computeMatrix(withOneMore, 'auto', {
      maxPairs: 400,
      fetchImpl: warm.fetchImpl,
      cache,
    });

    /*
     * Adding a seventh point adds its row and its column: thirteen new ordered
     * pairs out of forty-nine. The old cache bought all forty-nine, which is
     * what made a local itinerary edit as expensive as a fresh compilation.
     */
    expect(second.failedPairs).toEqual([]);
    expect(warm.pairsRequested).toBeLessThan(coldPairs);
    expect(second.cacheHits).toBe(36);
    expect(second.pairs - second.cacheHits).toBe(13);
  });

  it('keeps a cached pair off the router budget, so a warm build is never the smaller one', async () => {
    const points = grid(6);
    const cache = memoryCache();

    const cold = recordingRouter();
    const first = await computeMatrix(points, 'auto', {
      maxPairs: 400,
      fetchImpl: cold.fetchImpl,
      cache,
    });
    expect(first.failedPairs).toEqual([]);

    /*
     * A budget far below the square. Charging held pairs to it — which is what
     * the block loop did — made the second build report the whole region as
     * unroutable despite already holding every answer.
     */
    const warm = recordingRouter();
    const second = await computeMatrix(points, 'auto', {
      maxPairs: 1,
      fetchImpl: warm.fetchImpl,
      cache,
    });
    expect(second.failedPairs).toEqual([]);
    expect(warm.calls).toBe(0);
  });

  it('does not store a pair the router could not answer', async () => {
    const points = grid(2);
    const cache = memoryCache();

    const refusing = (async () =>
      new Response(
        JSON.stringify({
          sources_to_targets: [
            { from_index: 0, to_index: 0, time: 0, distance: 0 },
            // Valhalla's way of saying "no route", which is a real answer about
            // today rather than a fact about the ground.
            { from_index: 0, to_index: 1, time: null, distance: null },
            { from_index: 1, to_index: 0, time: null, distance: null },
            { from_index: 1, to_index: 1, time: 0, distance: 0 },
          ],
        }),
        { status: 200 },
      )) as unknown as typeof fetch;

    await computeMatrix(points, 'auto', { maxPairs: 400, fetchImpl: refusing, cache });
    expect(cache.read(matrixPairCacheKey(points[0]!, points[1]!, 'auto'))).toBeNull();

    /*
     * So the next build asks again. A cache that made a transient refusal
     * permanent would keep the place out of every plan until the entry expired.
     */
    const retry = recordingRouter();
    const second = await computeMatrix(points, 'auto', {
      maxPairs: 400,
      fetchImpl: retry.fetchImpl,
      cache,
    });
    expect(retry.calls).toBeGreaterThan(0);
    expect(second.failedPairs).toEqual([]);
  });

  it('does not answer one costing with another costing\'s numbers', async () => {
    const points = grid(4);
    const cache = memoryCache();

    const driving = recordingRouter();
    await computeMatrix(points, 'auto', { maxPairs: 400, fetchImpl: driving.fetchImpl, cache });

    const walking = recordingRouter();
    const onFoot = await computeMatrix(points, 'pedestrian', {
      maxPairs: 400,
      fetchImpl: walking.fetchImpl,
      cache,
    });

    // The whole road matrix is held and none of it is a walk.
    expect(walking.calls).toBeGreaterThan(0);
    expect(onFoot.cacheHits).toBe(0);
  });
});
