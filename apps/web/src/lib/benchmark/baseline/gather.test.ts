import { describe, expect, it } from 'vitest';
import { BENCHMARK_CASES } from '@sidequest/bench/cases';
import { benchmarkTripRequestSchema, type BenchmarkTripRequest } from '@sidequest/bench';
import type { NormalizedOsmPlace } from '../../providers/overpass';
import { FIXTURE_DESTINATION, fixturePacketInputs } from './fixtures';
import {
  MATRIX_POINT_LIMIT,
  MAX_RADIUS_KM,
  hoursFor,
  matrixSample,
  readSettlements,
  searchRadiusKm,
  seasonalFor,
  tripMonthsOf,
} from './gather';
import { buildResearchPacket, type RawPlace } from './packet';
import { PACKET_CAPS, type PacketDestination } from './packet-types';

/**
 * WHAT THE PACKET IS ALLOWED TO BE THIN ABOUT, AND WHAT IT WAS THIN ABOUT BY
 * ACCIDENT.
 *
 * Every property here was a defect first. A region sized from the traveller's
 * own stated reach and then silently capped at a default they never saw; a
 * route matrix sampled from a list the packet was about to throw away; a
 * seasonal state hard-coded to `unknown`, which made a whole class of check
 * unreachable rather than undecided; and one base candidate for a traveller who
 * asked for as many as eight.
 *
 * None of them looked like a bug. Each read as a deliberate limitation, which is
 * why each is asserted here as a property rather than left to a reviewer's eye.
 */

function requestWith(movement: Partial<BenchmarkTripRequest['movement']>): BenchmarkTripRequest {
  const base = BENCHMARK_CASES[0]?.request;
  if (!base) throw new Error('The case library is empty.');
  return benchmarkTripRequestSchema.parse({
    ...base,
    movement: { ...base.movement, ...movement },
  });
}

function destinationWith(radiusKm: number | null): PacketDestination {
  return { ...FIXTURE_DESTINATION, radiusKm };
}

describe('how wide the packet looks', () => {
  /**
   * The shape every benchmarked run actually has. The shared identity the
   * harness hands both arms carries no bounding box, so `radiusKm` is null — and
   * the old ceiling therefore applied to every single run.
   */
  it('honours a stated daily drive when the geocoder says nothing at all', () => {
    const request = requestWith({
      carAvailable: true,
      maxDailyDriveMinutes: 600,
      maxDailyTravelMinutes: 660,
    });
    expect(searchRadiusKm(request, destinationWith(null))).toBe(MAX_RADIUS_KM);
  });

  it('gives a traveller who will drive further a wider region than one who will not', () => {
    const far = requestWith({
      carAvailable: true,
      maxDailyDriveMinutes: 240,
      maxDailyTravelMinutes: 300,
    });
    const near = requestWith({
      carAvailable: true,
      maxDailyDriveMinutes: 60,
      maxDailyTravelMinutes: 120,
    });
    expect(searchRadiusKm(far, destinationWith(null))).toBeGreaterThan(
      searchRadiusKm(near, destinationWith(null)),
    );
  });

  /**
   * The direction that was inverted. A geocoder's own extent is evidence that a
   * named place is at least that big; it is no evidence that a traveller's
   * stated reach is smaller.
   */
  it('lets the geocoder widen a small destination and never shrink a large intent', () => {
    const request = requestWith({
      carAvailable: true,
      maxDailyDriveMinutes: 120,
      maxDailyTravelMinutes: 180,
    });
    const stated = searchRadiusKm(request, destinationWith(null));

    expect(searchRadiusKm(request, destinationWith(5))).toBe(stated);
    expect(searchRadiusKm(request, destinationWith(stated + 40))).toBe(stated + 40);
  });

  it('keeps an absolute clamp, whatever anybody stated', () => {
    const request = requestWith({
      carAvailable: true,
      maxDailyDriveMinutes: 600,
      maxDailyTravelMinutes: 720,
    });
    expect(searchRadiusKm(request, destinationWith(4000))).toBe(MAX_RADIUS_KM);
    expect(searchRadiusKm(request, destinationWith(0))).toBeLessThanOrEqual(MAX_RADIUS_KM);
  });

  it('never collapses to nothing for a traveller with no car and little time', () => {
    const request = requestWith({
      preference: 'public_transport',
      carAvailable: false,
      maxDailyDriveMinutes: 0,
      maxDailyTravelMinutes: 30,
    });
    expect(searchRadiusKm(request, destinationWith(null))).toBeGreaterThanOrEqual(5);
  });
});

/* ------------------------------------------------------------------ *
 * Season
 * ------------------------------------------------------------------ */

function osmPlace(
  planningTags: Record<string, string>,
  latitude = 45,
): NormalizedOsmPlace {
  return {
    elementId: 'node/1',
    name: 'Somewhere',
    coordinates: { lat: latitude, lng: 9 },
    primaryTag: 'natural=peak',
    planningTags,
    sourceTimestamp: undefined,
    url: 'https://www.openstreetmap.org/node/1',
  };
}

const SEPTEMBER = tripMonthsOf(['2026-09-01', '2026-09-02']);

/**
 * THE HOURS THIS ARM WAS REFUSING TO READ.
 *
 * It read `24/7` and nothing else, on the argument that a half-correct parser is
 * worse than none and that hours handling is one of the things being compared.
 * The repository already held a *refusing* parser — one that returns nothing at
 * all for any construct it cannot fully model — and "hours and access" is a
 * provider boundary this arm is permitted to use. The cost of the omission was
 * one-sided and landed where a reviewer looks first: one plan with times on every
 * block and one saying "hours unknown" throughout.
 *
 * The property that matters is the refusal, so it is asserted first.
 */
describe('the opening hours the packet is willing to state', () => {
  const DATES = ['2026-09-14', '2026-09-15', '2026-09-16'] as const;

  it('says nothing at all when there is nothing to read', () => {
    expect(hoursFor(osmPlace({}), DATES).state).toBe('unknown');
  });

  it('refuses an expression it cannot fully model, rather than half-reading it', () => {
    for (const raw of ['sunrise-sunset', 'Mo-Fr 09:00-17:00 || "ring the bell"', 'Apr: open']) {
      expect(hoursFor(osmPlace({ opening_hours: raw }), DATES).state, raw).toBe('unknown');
    }
  });

  it('still reads a place with no gate as always open', () => {
    expect(hoursFor(osmPlace({ opening_hours: '24/7' }), DATES).state).toBe('always_open');
  });

  it('resolves a weekday schedule onto the trip’s own dates, and names the days it shuts', () => {
    // 2026-09-14 is a Monday.
    const hours = hoursFor(osmPlace({ opening_hours: 'Tu-Su 10:00-18:00' }), DATES);
    expect(hours.state).toBe('known');
    if (hours.state !== 'known') return;
    expect(hours.closedDates).toEqual(['2026-09-14']);
    expect(hours.windows.map((window) => window.date)).toEqual(['2026-09-15', '2026-09-16']);
    expect(hours.windows[0]).toMatchObject({ openMinute: 600, closeMinute: 1080 });
  });

  it('stays unknown when the expression covers none of the trip’s dates', () => {
    // Shut for the whole trip is a refusal to state hours rather than a claim
    // the place is permanently closed: the expression may not cover these months.
    expect(hoursFor(osmPlace({ opening_hours: 'Jan-Feb 10:00-16:00' }), DATES).state).toBe(
      'unknown',
    );
  });
});

describe('whether a place is reachable in the trip’s months', () => {
  it('reads a trip’s months off its dates', () => {
    expect([...tripMonthsOf(['2026-12-30', '2026-12-31', '2027-01-01'])].sort()).toEqual([1, 12]);
    expect(tripMonthsOf(['not a date']).size).toBe(0);
  });

  it('records a source that says a place is there all year', () => {
    expect(seasonalFor(osmPlace({ seasonal: 'no' }), SEPTEMBER)).toEqual({
      state: 'open_in_season',
    });
  });

  /**
   * The honest half. A source saying "this is seasonal" without saying which
   * season cannot place the trip inside or outside it, and a packet that guessed
   * would be inventing the very fact it is recording.
   */
  it('stays unknown when the source says seasonal without saying when', () => {
    expect(seasonalFor(osmPlace({ seasonal: 'yes' }), SEPTEMBER).state).toBe('unknown');
    expect(seasonalFor(osmPlace({}), SEPTEMBER).state).toBe('unknown');
  });

  it('reads a month range, both ways round', () => {
    expect(seasonalFor(osmPlace({ seasonal: 'Apr-Oct' }), SEPTEMBER).state).toBe('open_in_season');
    const shut = seasonalFor(osmPlace({ seasonal: 'Nov-Mar' }), SEPTEMBER);
    expect(shut.state).toBe('closed_in_season');
    if (shut.state === 'closed_in_season') expect(shut.note.length).toBeGreaterThan(0);
  });

  it('stays unknown when the season covers some of the trip but not all of it', () => {
    const straddling = tripMonthsOf(['2026-10-30', '2026-11-01']);
    expect(seasonalFor(osmPlace({ seasonal: 'Apr-Oct' }), straddling).state).toBe('unknown');
  });

  /**
   * A hut tagged `seasonal=summer` in Patagonia is shut in July. A table that
   * quietly meant the northern summer would tell half the world the opposite of
   * the truth.
   */
  it('reads a season word on the hemisphere the place is actually in', () => {
    expect(seasonalFor(osmPlace({ seasonal: 'summer' }, 45), SEPTEMBER).state).toBe(
      'closed_in_season',
    );
    expect(seasonalFor(osmPlace({ seasonal: 'summer' }, -45), SEPTEMBER).state).toBe(
      'closed_in_season',
    );
    const january = tripMonthsOf(['2027-01-10']);
    expect(seasonalFor(osmPlace({ seasonal: 'summer' }, -45), january).state).toBe(
      'open_in_season',
    );
    expect(seasonalFor(osmPlace({ seasonal: 'summer' }, 45), january).state).toBe(
      'closed_in_season',
    );
  });

  /**
   * A bare month range in `opening_hours` is a statement about the season. Any
   * clock time in it makes the string an hours expression, and this module does
   * not parse those — half an hours parser is worse than none.
   */
  it('reads a bare month range in opening hours and refuses to parse anything more', () => {
    expect(seasonalFor(osmPlace({ opening_hours: 'Apr-Oct' }), SEPTEMBER).state).toBe(
      'open_in_season',
    );
    expect(seasonalFor(osmPlace({ opening_hours: 'Nov-Mar 09:00-17:00' }), SEPTEMBER).state).toBe(
      'unknown',
    );
    expect(seasonalFor(osmPlace({ opening_hours: '24/7' }), SEPTEMBER).state).toBe('unknown');
  });

  it('stays unknown when nobody knows what months the trip covers', () => {
    expect(seasonalFor(osmPlace({ seasonal: 'Nov-Mar' }), new Set()).state).toBe('unknown');
  });
});

/* ------------------------------------------------------------------ *
 * Somewhere to sleep
 * ------------------------------------------------------------------ */

describe('the settlements offered as somewhere to sleep', () => {
  const elements = [
    { type: 'node', id: 1, lat: 45.4, lon: 9, tags: { name: 'Far Village', place: 'village' } },
    { type: 'node', id: 2, lat: 45.05, lon: 9, tags: { name: 'Near Village', place: 'village' } },
    { type: 'node', id: 3, lat: 45.6, lon: 9, tags: { name: 'Distant Town', place: 'town' } },
    { type: 'way', id: 4, center: { lat: 45.2, lon: 9 }, tags: { name: 'Wayside', place: 'hamlet' } },
    // Everything below is unusable and must be skipped rather than defaulted.
    { type: 'node', id: 5, lat: 45.1, lon: 9, tags: { place: 'town' } },
    { type: 'node', id: 6, tags: { name: 'Nowhere', place: 'town' } },
    { type: 'node', id: 7, lat: 45.1, lon: 9, tags: { name: 'A Farm', place: 'farm' } },
    'not an element at all',
  ];

  const found = readSettlements(elements, FIXTURE_DESTINATION);

  it('reads the settlements and skips whatever it cannot use', () => {
    expect(found.map((entry) => entry.name)).toEqual([
      'Distant Town',
      'Near Village',
      'Far Village',
      'Wayside',
    ]);
  });

  /**
   * The order is the map's own classification and then plain geometry. Neither
   * is a judgement about where is nice to stay — that judgement is one of the
   * things under test, and it belongs to the plan.
   */
  it('says what it is and how far, and claims nothing about staying there', () => {
    const near = found.find((entry) => entry.name === 'Near Village');
    expect(near?.basis).toContain('village');
    expect(near?.basis).toContain('km from the destination');
    expect(near?.basis).toContain('not stated');
    expect(near?.entityId).toBeNull();
  });

  it('offers nothing at all rather than something invented', () => {
    expect(readSettlements([], FIXTURE_DESTINATION)).toEqual([]);
  });

  /**
   * The packet's own cap has to be able to hold the destination and the
   * settlements together, or the alphabetical slice downstream drops whichever
   * names begin late.
   */
  it('fits inside the packet’s cap once the destination is added', () => {
    expect(PACKET_CAPS.baseCandidates).toBeGreaterThan(1);
  });
});

/* ------------------------------------------------------------------ *
 * What is worth measuring
 * ------------------------------------------------------------------ */

function place(index: number, latitude: number, longitude: number): RawPlace {
  return {
    entityId: `node/${9000 + index}`,
    name: `Place ${index}`,
    latitude,
    longitude,
    kind: 'tourism=attraction',
    tags: ['tourism'],
    typicalDurationMinutes: null,
    daylightOnly: null,
    hours: { state: 'unknown' },
    seasonal: { state: 'unknown' },
    access: {
      requiresCar: null,
      unpavedApproach: null,
      remoteNoServices: null,
      strenuous: null,
      wheelchair: 'unknown',
      feeStated: null,
    },
    food: null,
    source: null,
  };
}

/** More places than the packet may hold, spread over a region with real clusters. */
function crowdedInputs() {
  const places = Array.from({ length: PACKET_CAPS.places + 80 }, (_, index) =>
    place(index, 45 + (index % 8) * 0.06, 9 + Math.floor(index / 8) * 0.04),
  );
  return fixturePacketInputs({ places });
}

describe('which places the routing engine is asked about', () => {
  const packet = buildResearchPacket(crowdedInputs());
  const sample = matrixSample(packet);

  it('takes them from the packet rather than from the list it was cut from', () => {
    expect(sample).toHaveLength(MATRIX_POINT_LIMIT);
    const held = new Set(packet.places.map((entry) => entry.entityId));
    for (const entry of sample) expect(held.has(entry.entityId)).toBe(true);
    expect(new Set(sample.map((entry) => entry.entityId)).size).toBe(sample.length);
  });

  /**
   * THE PROPERTY THE WHOLE FIX EXISTS FOR.
   *
   * Every measured pair has to survive the packet build, because a leg pointing
   * at a place the packet does not hold is discarded on the way in. Sampling the
   * raw provider list produced a matrix of which almost nothing landed, and the
   * plan then reported `unknown` for journeys somebody had paid to measure.
   */
  it('produces legs that all survive into the packet', () => {
    const legs = sample.flatMap((from) =>
      sample
        .filter((to) => to.entityId !== from.entityId)
        .map((to) => ({
          fromEntityId: from.entityId,
          toEntityId: to.entityId,
          minutes: 20,
          km: 12,
          mode: 'drive' as const,
        })),
    );

    /*
     * Rebuilt from the same world the sample came from, so what is measured is
     * the survival of the legs rather than the arrival of a second inventory.
     */
    const rebuilt = buildResearchPacket({ ...crowdedInputs(), routeLegs: legs });

    expect(rebuilt.routeLegs).toHaveLength(legs.length);
    expect(legs.length).toBeLessThanOrEqual(PACKET_CAPS.routeLegs);
    expect(
      rebuilt.gaps.some((gap) => gap.detail.includes('referenced a place the packet does not hold')),
    ).toBe(false);
  });

  /**
   * A day is spent inside one cluster, so the pairs worth measuring are the ones
   * inside a cluster. A flat stride down an identity order that correlates with
   * nothing spatial measured mostly the journeys nobody would ever make.
   */
  it('reaches every cluster, and gives most of them a pair worth measuring', () => {
    const perCluster = new Map<number | null, number>();
    for (const entry of sample) {
      perCluster.set(entry.clusterIndex, (perCluster.get(entry.clusterIndex) ?? 0) + 1);
    }

    // Every cluster is represented, so no area of the region is left with no
    // measured leg at all.
    for (const cluster of packet.clusters) {
      expect(perCluster.get(cluster.index) ?? 0).toBeGreaterThanOrEqual(1);
    }
    // And most clusters get two, which is what makes a within-cluster journey —
    // the kind a day is actually made of — a measured one.
    const withAPair = [...perCluster.values()].filter((count) => count >= 2).length;
    expect(withAPair).toBeGreaterThan(perCluster.size / 2);
  });

  it('asks for nothing when there is nothing to compare', () => {
    const empty = buildResearchPacket(fixturePacketInputs({ places: [] }));
    expect(matrixSample(empty)).toEqual([]);
  });

  it('never returns more than it was asked for', () => {
    expect(matrixSample(packet, 5)).toHaveLength(5);
    expect(matrixSample(packet, 0)).toEqual([]);
  });
});
