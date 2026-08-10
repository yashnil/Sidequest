import { describe, expect, it } from 'vitest';
import {
  departureBucket,
  localDateTimeValue,
  measureTransitJourneys,
  transitCacheKey,
} from './transit';

/**
 * THE ADAPTER'S ONE LOAD-BEARING CHECK, EXERCISED.
 *
 * `transit.ts` opens by naming the trap it exists to close: a Valhalla instance
 * with no timetable data for a pair does not refuse a multimodal request, it
 * **returns HTTP 200 and a pure walking route**, with nothing in the envelope
 * saying the transit graph was not consulted. A walking duration stored as
 * transit evidence is the substitution the whole capability was built to
 * prevent, and the only detection that survives a configuration change is
 * structural: at least one maneuver reporting `travel_mode: "transit"`.
 *
 * That check had no test. Neither did the error-code classification, the
 * departure-time construction, or the cache key — four hundred and eighty lines
 * of adapter whose correctness was asserted only by its own comments.
 *
 * Every case below drives the real function against a stubbed `fetch`, which is
 * the only way to reach these branches without a network or a bill.
 */

const PAIR = {
  fromId: 'base',
  toId: 'museum',
  from: { lat: 40.42, lng: -3.7 },
  to: { lat: 40.45, lng: -3.68 },
};

const CONTEXT = { departAt: new Date('2026-08-12T07:30:00.000Z'), timeZone: 'Europe/Madrid' };

function stub(body: unknown, init: { status?: number } = {}): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status: init.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
}

/** A reply with a real transit leg in it, as Valhalla shapes one. */
const WITH_TRANSIT = {
  trip: {
    summary: { time: 2_040, length: 9.4 },
    legs: [
      {
        maneuvers: [
          { travel_mode: 'pedestrian', time: 360 },
          {
            travel_mode: 'transit',
            travel_type: 'metro',
            time: 840,
            transit_info: { short_name: 'L1', long_name: 'Line 1' },
          },
          {
            travel_mode: 'transit',
            travel_type: 'rail',
            time: 540,
            transit_info: { short_name: 'C4' },
          },
          { travel_mode: 'pedestrian', time: 300 },
        ],
      },
    ],
  },
};

/** The same shape with the transit graph never consulted. This is the trap. */
const WALK_ONLY = {
  trip: {
    summary: { time: 4_200, length: 5.1 },
    legs: [{ maneuvers: [{ travel_mode: 'pedestrian', time: 4_200 }] }],
  },
};

describe('measuring a public-transport journey', () => {
  it('reads a real multimodal reply into a measured journey', async () => {
    const { journeys, calls } = await measureTransitJourneys([PAIR], CONTEXT, {
      maxPairs: 1,
      fetchImpl: stub(WITH_TRANSIT),
    });
    expect(calls).toBe(1);
    const journey = journeys[0]!;
    expect(journey.status).toBe('measured');
    /* The provider's own total, converted once. Never re-derived from the legs. */
    expect(journey.minutes).toBe(34);
    expect(journey.km).toBe(9.4);
    /* Two vehicles is one change. */
    expect(journey.transfers).toBe(1);
    /* Access and egress, counted as walking rather than folded into the ride. */
    expect(journey.walkingMinutes).toBe(11);
    expect(journey.legs?.map((leg) => leg.mode)).toEqual(['walk', 'subway', 'rail', 'walk']);
    /* Line names verbatim from the provider, or absent. Never invented. */
    expect(journey.legs?.[1]?.line).toBe('L1');
    expect(journey.legs?.[0]?.line).toBeUndefined();
    /* Valhalla publishes no fare, so no journey from here may carry one. */
    expect(journey.fare).toBeUndefined();
    expect(journey.requestBasis.timeZone).toBe('Europe/Madrid');
  });

  it('REFUSES a walking route returned under the name multimodal', async () => {
    /**
     * The check the whole file exists for. A tile-less server answers 200 with a
     * pedestrian path; accepting it would put a seventy-minute walk on the
     * artifact labelled as a measured public-transport journey, which is exactly
     * the one-network-standing-in-for-another failure the capability was split
     * out to make impossible.
     *
     * Falsifiable by construction: `WALK_ONLY` is a *successful* response with a
     * plausible duration in it. Nothing but the maneuver check can reject it.
     */
    const { journeys } = await measureTransitJourneys([PAIR], CONTEXT, {
      maxPairs: 1,
      fetchImpl: stub(WALK_ONLY),
    });
    expect(journeys[0]!.status).toBe('out_of_coverage');
    /* And carries no duration at all — the walk is measured elsewhere. */
    expect(journeys[0]!.minutes).toBeUndefined();
    expect(journeys[0]!.detail).toMatch(/only offer a walk/i);
  });

  /*
   * Twenty seconds, because the adapter's politeness gate is real: it waits
   * 1.1s between requests to a rate-limited routing service, and five sequential
   * cases genuinely take five and a half. Raising the bound for a test that
   * makes five real calls through the real gate is not weakening it — removing
   * the gate to make the test fast would be.
   */
  it('tells our instrument apart from their timetable, by error code', { timeout: 20_000 }, async () => {
    const cases: { code: number; status: string }[] = [
      /* No transit tiles at all: a fact about us. */
      { code: 170, status: 'out_of_coverage' },
      /* No stop within walking distance of the destination: a fact about the place. */
      { code: 440, status: 'no_route' },
      /* A snapping failure. Nothing to do with a timetable. */
      { code: 171, status: 'provider_error' },
      /* One of our own distance limits. Nothing to do with a timetable. */
      { code: 154, status: 'provider_error' },
      /* The generic no-path refusal: ambiguous, so we do not claim. */
      { code: 442, status: 'provider_error' },
    ];
    for (const { code, status } of cases) {
      const { journeys } = await measureTransitJourneys([PAIR], CONTEXT, {
        maxPairs: 1,
        fetchImpl: stub({ error_code: code, error: 'x' }, { status: 400 }),
      });
      expect(journeys[0]!.status, `error ${code}`).toBe(status);
      expect(journeys[0]!.minutes, `error ${code} carried a duration`).toBeUndefined();
    }
  });

  it('remembers an answer and refuses to remember a failure', async () => {
    /**
     * A provider error is a statement about a moment. Caching one would turn a
     * single bad afternoon into a fortnight of "this city has no trains" — and
     * the same argument applies to `out_of_coverage`, which is what a briefly
     * misconfigured instance answers for *everything*.
     */
    const written = new Map<string, unknown>();
    const cache = {
      read: (key: string) => (written.get(key) ?? null) as never,
      write: (key: string, value: unknown) => void written.set(key, value),
    };

    await measureTransitJourneys([PAIR], CONTEXT, {
      maxPairs: 1,
      cache,
      fetchImpl: stub({ error_code: 442 }, { status: 400 }),
    });
    expect(written.size, 'a provider error was cached').toBe(0);

    await measureTransitJourneys([PAIR], CONTEXT, {
      maxPairs: 1,
      cache,
      fetchImpl: stub(WALK_ONLY),
    });
    expect(written.size, 'an out-of-coverage answer was cached').toBe(0);

    await measureTransitJourneys([PAIR], CONTEXT, {
      maxPairs: 1,
      cache,
      fetchImpl: stub(WITH_TRANSIT),
    });
    expect(written.size).toBe(1);

    /* And the remembered answer is served without a second call. */
    const second = await measureTransitJourneys([PAIR], CONTEXT, {
      maxPairs: 1,
      cache,
      fetchImpl: stub({ error_code: 500 }, { status: 500 }),
    });
    expect(second.calls).toBe(0);
    expect(second.cacheHits).toBe(1);
    expect(second.journeys[0]!.status).toBe('measured');
  });

  it('never asks for more pairs than it was allowed', async () => {
    const pairs = [PAIR, { ...PAIR, toId: 'b' }, { ...PAIR, toId: 'c' }];
    const { journeys, calls } = await measureTransitJourneys(pairs, CONTEXT, {
      maxPairs: 2,
      fetchImpl: stub(WITH_TRANSIT),
    });
    expect(calls).toBe(2);
    expect(journeys).toHaveLength(2);
  });
});

describe('when the journey is asked about', () => {
  it('sends the destination’s wall clock, not ours', () => {
    /*
     * Valhalla wants local time. Sending an instant in the wrong zone is how a
     * request meant for mid-morning arrives as half past two in the morning —
     * and comes back with no service, which the product would then report as the
     * city having no timetables.
     */
    expect(localDateTimeValue(new Date('2026-08-12T07:30:00.000Z'), 'Europe/Madrid')).toBe(
      '2026-08-12T09:30',
    );
    expect(localDateTimeValue(new Date('2026-08-12T16:30:00.000Z'), 'America/Los_Angeles')).toBe(
      '2026-08-12T09:30',
    );
    /* Midnight renders as 00, never as 24, which the engine rejects. */
    expect(localDateTimeValue(new Date('2026-08-12T22:00:00.000Z'), 'Europe/Madrid')).toBe(
      '2026-08-13T00:00',
    );
  });

  it('buckets the cache by when, in the destination’s own clock', () => {
    /*
     * A timetable answers the same twice in a minute and differently on a Sunday
     * evening, so the key is a weekday class and an hour. Taken in any other zone
     * the Friday-night boundary falls in the wrong place, which is where a
     * timetable changes most.
     */
    expect(departureBucket(new Date('2026-08-12T07:30:00.000Z'), 'Europe/Madrid')).toBe(
      'weekday-09',
    );
    /* 23:30 Saturday UTC is already Sunday in Madrid. */
    expect(departureBucket(new Date('2026-08-15T23:30:00.000Z'), 'Europe/Madrid')).toBe(
      'sunday-01',
    );
    expect(departureBucket(new Date('2026-08-15T23:30:00.000Z'), 'UTC')).toBe('saturday-23');
  });

  it('gives two different questions two different cache entries', () => {
    const base = { from: PAIR.from, to: PAIR.to, ...CONTEXT };
    const other = { ...base, to: { lat: 41.0, lng: -3.68 } };
    expect(transitCacheKey(base)).not.toBe(transitCacheKey(other));
    /* Direction is part of the question: a return leg is not the outbound one. */
    expect(transitCacheKey(base)).not.toBe(
      transitCacheKey({ ...base, from: base.to, to: base.from }),
    );
    /* A Sunday is a different answer from a Tuesday. */
    expect(transitCacheKey(base)).not.toBe(
      transitCacheKey({ ...base, departAt: new Date('2026-08-16T07:30:00.000Z') }),
    );
    /* And the same question twice is the same entry, or nothing ever hits. */
    expect(transitCacheKey(base)).toBe(transitCacheKey({ ...base }));
  });
});
