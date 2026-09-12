import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTHORITATIVE_NO_ROUTE } from '../planning/skeleton-adapter';
import { computeMatrix, computeRoute, costingFor, type ValhallaFailureReason } from './valhalla';

/**
 * V9.1 — ROUTING TRUTH: ONLY AN ANSWER MAY CONTRADICT.
 *
 * A live structural refinement moved a day's base, and reverification then
 * removed a 56-minute drive as unreachable with the words "a real answer, not a
 * gap". It was a gap. Valhalla's `costmatrix` had declined the pair — returning
 * `time: null` while echoing snapped coordinates for both endpoints — and the
 * null was being read as positive evidence. `/route` solved the same pair in
 * 3,330 s over 51 km. Full chain: `V9.1-ROUTING-CONTRADICTION.md`.
 *
 * The rule these fixtures hold the adapter to: **`not_found` — the one reason
 * the architecture treats as affirmative (`AUTHORITATIVE_NO_ROUTE`) — may only
 * come from a provider that evaluated the endpoints and said no.** Every other
 * outcome is an absent answer and must classify as something a caller will
 * treat as unmeasured.
 */
const REYKJAVIK = { id: 'base', lat: 64.145981, lng: -21.9422367 };
const THINGVELLIR = { id: 'anchor', lat: 64.2821725, lng: -21.0764491 };

/** One programmable provider, so every row below is the same adapter meeting a different answer. */
function provider(handler: (url: string) => Promise<Response> | Response): typeof fetch {
  return ((input: RequestInfo | URL) => Promise.resolve(handler(String(input)))) as unknown as typeof fetch;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * A full 2×2 block, as the adapter asks for it. `cross` is what the off-diagonal
 * pairs say; the diagonals are always zero.
 */
const block = (cross: { time: number | null; distance: number | null }) => ({
  sources_to_targets: [
    [
      { from_index: 0, to_index: 0, time: 0, distance: 0 },
      { from_index: 0, to_index: 1, ...cross },
    ],
    [
      { from_index: 1, to_index: 0, ...cross },
      { from_index: 1, to_index: 1, time: 0, distance: 0 },
    ],
  ],
  /* Both endpoints snapped, exactly as the live instance reported while declining the pair. */
  sources: [{ lat: 64.146014, lon: -21.942925 }, { lat: 64.280344, lon: -21.084135 }],
  targets: [{ lat: 64.146014, lon: -21.942925 }, { lat: 64.280344, lon: -21.084135 }],
  units: 'kilometers',
  algorithm: 'costmatrix',
});

/** What the live instance actually returned for the pair it declined. */
const DECLINED_CELL = block({ time: null, distance: null });
const MEASURED_CELL = block({ time: 3330.9, distance: 50.99 });

async function matrixReason(handler: Parameters<typeof provider>[0]): Promise<ValhallaFailureReason | undefined> {
  const outcome = await computeMatrix([REYKJAVIK, THINGVELLIR], costingFor('car'), {
    fetchImpl: provider(handler),
    maxPairs: 8,
  });
  return outcome.failedPairs.find((pair) => pair.from === 'base' && pair.to === 'anchor')?.reason;
}

beforeEach(() => {
  vi.stubEnv('SIDEQUEST_ROUTES_URL', 'http://127.0.0.1:8002');
  vi.stubEnv('SIDEQUEST_ROUTES_PROVIDER', 'valhalla');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('a matrix that declines a pair', () => {
  /* The exact regression: the live response that cost a traveller a signature stop. */
  it('is unmeasured, never the authoritative no-route', { timeout: 30_000 }, async () => {
    const reason = await matrixReason(() => json(DECLINED_CELL));
    expect(reason).toBeDefined();
    expect(reason).not.toBe(AUTHORITATIVE_NO_ROUTE);
    expect(reason).toBe('insufficient_evidence');
  });

  it('measures the pair when the matrix answers with a time', { timeout: 30_000 }, async () => {
    const outcome = await computeMatrix([REYKJAVIK, THINGVELLIR], costingFor('car'), {
      fetchImpl: provider(() => json(MEASURED_CELL)),
      maxPairs: 8,
    });
    expect(outcome.minutes[0]?.[1]).toBe(56);
    expect(outcome.failedPairs.find((p) => p.from === 'base' && p.to === 'anchor')).toBeUndefined();
  });
});

describe('provider failures are absences, not verdicts', () => {
  const failures: [string, Parameters<typeof provider>[0]][] = [
    ['a 500', () => json({ error: 'boom' }, 500)],
    ['a 503', () => json({ error: 'unavailable' }, 503)],
    ['a malformed body', () => new Response('not json at all', { status: 200, headers: { 'content-type': 'application/json' } })],
    ['an empty body', () => new Response('', { status: 200, headers: { 'content-type': 'application/json' } })],
    ['a body with no cells', () => json({ units: 'kilometers' })],
    ['a refused connection', () => { throw new TypeError('fetch failed'); }],
    ['a rate limit', () => json({ error: 'slow down' }, 429)],
    ['an out-of-coverage answer', () => json({ error_code: 171, error: 'No suitable edges near location' }, 400)],
  ];

  it.each(failures)('%s never becomes a contradiction', { timeout: 30_000 }, async (_label, handler) => {
    const reason = await matrixReason(handler);
    expect(reason, 'a failure must never be read as the router answering "no"').not.toBe(AUTHORITATIVE_NO_ROUTE);
  });
});

describe('the direct route endpoint, which is the only thing that may contradict', () => {
  it('answers a routable leg with a measurement', async () => {
    const leg = await computeRoute(
      REYKJAVIK,
      THINGVELLIR,
      costingFor('car'),
      { fetchImpl: provider(() => json({ trip: { status: 0, summary: { time: 3330.9, length: 50.99 }, legs: [] } })) },
    );
    expect(leg.found).toBe(true);
    expect(leg.minutes).toBe(56);
  });

  /* The one fixture in this file allowed to produce a contradiction: NO_PATH, from the endpoint that evaluates a path. */
  it('answers a genuinely unroutable leg with the authoritative no-route', async () => {
    const leg = await computeRoute(
      REYKJAVIK,
      THINGVELLIR,
      costingFor('car'),
      { fetchImpl: provider(() => json({ error_code: 442, error: 'No path could be found for input' }, 400)) },
    );
    expect(leg.found).toBe(false);
    expect(leg.reason).toBe(AUTHORITATIVE_NO_ROUTE);
  });

  it('separates out-of-coverage from no-route, because a router without the tiles knows nothing about the ground', async () => {
    const leg = await computeRoute(
      REYKJAVIK,
      THINGVELLIR,
      costingFor('car'),
      { fetchImpl: provider(() => json({ error_code: 171, error: 'No suitable edges near location' }, 400)) },
    );
    expect(leg.found).toBe(false);
    expect(leg.reason).toBe('out_of_coverage');
    expect(leg.reason).not.toBe(AUTHORITATIVE_NO_ROUTE);
  });

  it('a timeout or an unreachable router is never a verdict either', async () => {
    for (const handler of [() => { throw new TypeError('fetch failed'); }, () => json({}, 504)]) {
      const leg = await computeRoute(
        REYKJAVIK,
        THINGVELLIR,
        costingFor('car'),
        { fetchImpl: provider(handler) },
      );
      expect(leg.found).toBe(false);
      expect(leg.reason).not.toBe(AUTHORITATIVE_NO_ROUTE);
    }
  });
});
