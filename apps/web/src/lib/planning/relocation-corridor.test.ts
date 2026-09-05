import { describe, expect, it } from 'vitest';
import {
  corridorDistanceKm,
  findCorridorRemedyCandidates,
  pointAlongGreatCircle,
  pointAlongRoute,
  routeLengthKm,
  type CorridorLocality,
  type CorridorPoint,
} from './relocation-corridor';
import { isLocalityCandidate } from './skeleton-adapter';

/**
 * ENTIRELY FICTIONAL GEOGRAPHY — NO ICELAND, NO SIDEQUEST PLACE DATA.
 *
 * These prove the module's own logic in isolation: given a relocation that
 * measures over a hard ceiling, can a bounded, deterministic area search
 * find a real settlement whose two split legs both fit — even when that
 * settlement is not sitting exactly on the sampled route point — and
 * correctly refuse to, when nothing genuinely qualifies.
 * `assessRelocationFeasibility`'s own tests (`skeleton-adapter.test.ts`)
 * prove the *integration* — tiering against the board, joint whole-route
 * handling, the night-borrowing rule.
 */

const A: CorridorPoint = { lat: 40.0, lng: -100.0 };
const B: CorridorPoint = { lat: 40.5, lng: -99.0 };

function locality(overrides: Partial<CorridorLocality> = {}): CorridorLocality {
  return { sourceId: 'osm/midtown', name: 'Midtown', lat: 40.25, lng: -99.5, entityType: 'city', ...overrides };
}

describe('pointAlongGreatCircle / corridorDistanceKm — pure geometry', () => {
  it('fraction 0 and 1 land exactly on the two endpoints', () => {
    const start = pointAlongGreatCircle(A, B, 0);
    const end = pointAlongGreatCircle(A, B, 1);
    expect(start.lat).toBeCloseTo(A.lat, 6);
    expect(start.lng).toBeCloseTo(A.lng, 6);
    expect(end.lat).toBeCloseTo(B.lat, 6);
    expect(end.lng).toBeCloseTo(B.lng, 6);
  });

  it('the midpoint sits roughly equidistant from both endpoints', () => {
    const mid = pointAlongGreatCircle(A, B, 0.5);
    const toA = corridorDistanceKm(mid, A);
    const toB = corridorDistanceKm(mid, B);
    expect(Math.abs(toA - toB)).toBeLessThan(1); // km — a great-circle midpoint, not a rounding coincidence
  });

  it('a degenerate pair (identical points) does not divide by zero', () => {
    const point = pointAlongGreatCircle(A, A, 0.5);
    expect(point.lat).toBeCloseTo(A.lat, 6);
    expect(point.lng).toBeCloseTo(A.lng, 6);
  });

  it('distance is symmetric and zero for identical points', () => {
    expect(corridorDistanceKm(A, B)).toBeCloseTo(corridorDistanceKm(B, A), 9);
    expect(corridorDistanceKm(A, A)).toBe(0);
  });
});

describe('isLocalityCandidate — the same real-settlement rule assessRelocationFeasibility uses', () => {
  it('accepts a city or neighbourhood, rejects everything else including unclassified', () => {
    expect(isLocalityCandidate(locality({ entityType: 'city' }))).toBe(true);
    expect(isLocalityCandidate(locality({ entityType: 'neighbourhood' }))).toBe(true);
    expect(isLocalityCandidate(locality({ entityType: 'point_of_interest' }))).toBe(false);
    expect(isLocalityCandidate(locality({ entityType: 'unknown' }))).toBe(false);
    expect(isLocalityCandidate(locality({ entityType: undefined }))).toBe(false);
  });
});

describe('findCorridorRemedyCandidates — the generic shape: A→B=336min, find C with both legs ≤240', () => {
  it('finds a real settlement whose two split legs both fit inside the ceiling', async () => {
    const searchCalls: { point: CorridorPoint; radiusKm: number }[] = [];
    const candidates = await findCorridorRemedyCandidates({
      from: A,
      to: B,
      ceilingMinutes: 240,
      directMinutes: 336,
      isLocalityCandidate,
      findNearbyLocalities: async (point, radiusKm) => {
        searchCalls.push({ point, radiusKm });
        return [locality()];
      },
      confirmRoute: async () => ({ found: true, minutes: 150, km: 180 }),
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.locality.sourceId).toBe('osm/midtown');
    expect(candidates[0]!.legOneMinutes).toBeLessThanOrEqual(240);
    expect(candidates[0]!.legTwoMinutes).toBeLessThanOrEqual(240);
    expect(searchCalls.length).toBeGreaterThan(0);
    expect(searchCalls.length).toBeLessThanOrEqual(4); // bounded search, never unbounded
    expect(searchCalls[0]!.radiusKm).toBeGreaterThan(0); // a real bound was actually passed, not left undefined
  });

  it('finds a real settlement that sits a real distance away from the exact sampled route point — the exact-point weakness this module exists to fix', async () => {
    // The sampled point itself resolves to nothing (an administrative region,
    // in the real Iceland case) — the town is 12 km away from where the
    // corridor was sampled, inside the search radius, and is what a bounded
    // area search finds that a single exact-point lookup could not.
    const nearbyTown = locality({ sourceId: 'osm/real-town', name: 'Real Town', lat: 40.28, lng: -99.45 });
    const candidates = await findCorridorRemedyCandidates({
      from: A,
      to: B,
      ceilingMinutes: 240,
      directMinutes: 336,
      isLocalityCandidate,
      findNearbyLocalities: async (point) => {
        const distanceKm = corridorDistanceKm(point, nearbyTown);
        return distanceKm <= 20 ? [nearbyTown] : [];
      },
      confirmRoute: async () => ({ found: true, minutes: 150, km: 180 }),
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.locality.sourceId).toBe('osm/real-town');
  });

  it('rejects a locality the search capability itself returned even though it is genuinely outside the requested radius — a safety bound independent of the injected search', async () => {
    const tooFar = locality({ sourceId: 'osm/too-far', lat: 41.5, lng: -95.0 }); // real distance from any sample point exceeds the radius
    const candidates = await findCorridorRemedyCandidates({
      from: A,
      to: B,
      ceilingMinutes: 240,
      directMinutes: 336,
      searchRadiusKm: 20,
      isLocalityCandidate,
      findNearbyLocalities: async () => [tooFar], // a misbehaving search returning something out of bounds
      confirmRoute: async () => ({ found: true, minutes: 150, km: 180 }),
    });
    expect(candidates).toHaveLength(0);
  });

  it('rejects a candidate with one leg still over the ceiling', async () => {
    let call = 0;
    const candidates = await findCorridorRemedyCandidates({
      from: A,
      to: B,
      ceilingMinutes: 240,
      directMinutes: 336,
      isLocalityCandidate,
      findNearbyLocalities: async () => [locality()],
      confirmRoute: async () => {
        call += 1;
        return call % 2 === 1 ? { found: true, minutes: 150, km: 180 } : { found: true, minutes: 300, km: 360 };
      },
    });
    expect(candidates).toHaveLength(0);
  });

  it('rejects a candidate reached only via an unreasonable detour', async () => {
    const candidates = await findCorridorRemedyCandidates({
      from: A,
      to: B,
      ceilingMinutes: 240,
      directMinutes: 336,
      isLocalityCandidate,
      findNearbyLocalities: async () => [locality({ lat: 10.0, lng: -100.0 })], // wildly off the corridor
      confirmRoute: async () => ({ found: true, minutes: 150, km: 180 }),
    });
    expect(candidates).toHaveLength(0);
  });

  it('rejects a non-locality result (an attraction/business/unclassified point, not a settlement)', async () => {
    const candidates = await findCorridorRemedyCandidates({
      from: A,
      to: B,
      ceilingMinutes: 240,
      directMinutes: 336,
      isLocalityCandidate,
      findNearbyLocalities: async () => [locality({ entityType: 'point_of_interest' })],
      confirmRoute: async () => ({ found: true, minutes: 150, km: 180 }),
    });
    expect(candidates).toHaveLength(0);
  });

  it('an honest empty result when the search finds nothing at every sampled point', async () => {
    const candidates = await findCorridorRemedyCandidates({
      from: A,
      to: B,
      ceilingMinutes: 240,
      directMinutes: 336,
      isLocalityCandidate,
      findNearbyLocalities: async () => [],
      confirmRoute: async () => ({ found: true, minutes: 150, km: 180 }),
    });
    expect(candidates).toHaveLength(0);
  });

  it('an honest empty result distinguishes "searched and found nothing" from "searched and found only an administrative region" — both produce zero candidates, never a guess', async () => {
    const adminRegion = locality({ sourceId: 'osm/some-district', name: 'Some District', entityType: 'subregion' });
    const candidates = await findCorridorRemedyCandidates({
      from: A,
      to: B,
      ceilingMinutes: 240,
      directMinutes: 336,
      isLocalityCandidate,
      findNearbyLocalities: async () => [adminRegion], // exactly what a bare reverse-geocode of an administrative area returns
      confirmRoute: async () => ({ found: true, minutes: 150, km: 180 }),
    });
    expect(candidates).toHaveLength(0);
  });

  it('excludes a named source id even when the search would otherwise return it (the endpoints themselves)', async () => {
    const candidates = await findCorridorRemedyCandidates({
      from: A,
      to: B,
      ceilingMinutes: 240,
      directMinutes: 336,
      isLocalityCandidate,
      excludeSourceIds: new Set(['osm/midtown']),
      findNearbyLocalities: async () => [locality()],
      confirmRoute: async () => ({ found: true, minutes: 150, km: 180 }),
    });
    expect(candidates).toHaveLength(0);
  });

  it('deduplicates the same real settlement found near more than one sampled point — confirms each real candidate once, not once per sample', async () => {
    let confirmCalls = 0;
    const candidates = await findCorridorRemedyCandidates({
      from: A,
      to: B,
      ceilingMinutes: 240,
      directMinutes: 336,
      isLocalityCandidate,
      findNearbyLocalities: async () => [locality()], // every sample's search returns the same real place
      confirmRoute: async () => {
        confirmCalls += 1;
        return { found: true, minutes: 150, km: 180 };
      },
    });
    expect(candidates).toHaveLength(1);
    expect(confirmCalls).toBe(2); // exactly one candidate's two legs, not one pair per sample
  });

  it('ranks multiple valid candidates deterministically — shortest combined travel first', async () => {
    const near = locality({ sourceId: 'osm/near', name: 'Near Town', lat: 40.2, lng: -99.6 });
    const far = locality({ sourceId: 'osm/far', name: 'Far Town', lat: 40.3, lng: -99.4 });
    let searchCallIndex = 0;
    let confirmCallIndex = 0;
    // Deterministic call order: `findCorridorRemedyCandidates` searches every
    // sample first (in sample order), then confirms each distinct
    // candidate's two legs in the order the candidates were found — so
    // near's two legs are confirm calls 1–2, far's are 3–4.
    const confirmMinutesByCall = [100, 100, 150, 150]; // near totals 200, far totals 300 — both under the 240 ceiling
    const candidates = await findCorridorRemedyCandidates({
      from: A,
      to: B,
      ceilingMinutes: 240,
      directMinutes: 336,
      splitFractions: [0.3, 0.7], // two distinct, reviewable samples — one per fictional town
      isLocalityCandidate,
      findNearbyLocalities: async () => [searchCallIndex++ === 0 ? near : far],
      confirmRoute: async () => {
        const minutes = confirmMinutesByCall[confirmCallIndex]!;
        confirmCallIndex += 1;
        return { found: true, minutes, km: minutes };
      },
    });
    expect(candidates).toHaveLength(2);
    expect(candidates[0]!.locality.sourceId).toBe('osm/near'); // 200 total beats far's 300
    expect(candidates[1]!.locality.sourceId).toBe('osm/far');
  });

  it('caps the number of candidates kept from a single sample point, even when the search returns many', async () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      locality({ sourceId: `osm/many-${i}`, name: `Many ${i}`, lat: 40.25 + i * 0.001, lng: -99.5 }),
    );
    let confirmCalls = 0;
    const candidates = await findCorridorRemedyCandidates({
      from: A,
      to: B,
      ceilingMinutes: 240,
      directMinutes: 336,
      splitFractions: [0.5], // one sample point, so every candidate necessarily comes from it
      isLocalityCandidate,
      findNearbyLocalities: async () => many,
      confirmRoute: async () => {
        confirmCalls += 1;
        return { found: true, minutes: 100, km: 100 };
      },
    });
    // At most a small, bounded number of the ten real settlements found at
    // one point are ever routed against — never all ten (two confirm calls
    // per surviving candidate).
    expect(candidates.length).toBeLessThan(many.length);
    expect(confirmCalls).toBeLessThan(many.length * 2);
  });

  it('caps the total number of distinct candidates considered across every sample point combined', async () => {
    let searchCallIndex = 0;
    const candidates = await findCorridorRemedyCandidates({
      from: A,
      to: B,
      ceilingMinutes: 240,
      directMinutes: 336,
      splitFractions: [0.2, 0.4, 0.6, 0.8],
      isLocalityCandidate,
      findNearbyLocalities: async (point) => {
        const index = searchCallIndex++;
        // Each sample point's search returns three distinct real settlements
        // right at that point (a hair apart from each other) — 12 distinct
        // candidates total if uncapped.
        return [0, 1, 2].map((i) =>
          locality({
            sourceId: `osm/point-${index}-${i}`,
            name: `Town ${index}-${i}`,
            lat: point.lat + i * 0.0001,
            lng: point.lng + i * 0.0001,
          }),
        );
      },
      confirmRoute: async () => ({ found: true, minutes: 100, km: 100 }),
    });
    expect(candidates.length).toBeLessThan(12);
  });

  it('never samples more than a small, bounded number of corridor points, regardless of how many fractions are requested', async () => {
    let searchCalls = 0;
    await findCorridorRemedyCandidates({
      from: A,
      to: B,
      ceilingMinutes: 240,
      isLocalityCandidate,
      splitFractions: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9], // far more than any real remedy needs
      findNearbyLocalities: async () => {
        searchCalls += 1;
        return [];
      },
      confirmRoute: async () => ({ found: true, minutes: 150, km: 180 }),
    });
    expect(searchCalls).toBeLessThanOrEqual(4);
  });
});

describe('pointAlongRoute / routeLengthKm — pure route-following geometry', () => {
  const GEOMETRY: readonly CorridorPoint[] = [
    { lat: 0, lng: 0 },
    { lat: 3, lng: 2 },
    { lat: 0, lng: 4 },
  ];

  it('fraction 0 and 1 land exactly on the first and last polyline vertices', () => {
    const start = pointAlongRoute(GEOMETRY, 0);
    const end = pointAlongRoute(GEOMETRY, 1);
    expect(start.lat).toBeCloseTo(GEOMETRY[0]!.lat, 6);
    expect(start.lng).toBeCloseTo(GEOMETRY[0]!.lng, 6);
    expect(end.lat).toBeCloseTo(GEOMETRY[2]!.lat, 6);
    expect(end.lng).toBeCloseTo(GEOMETRY[2]!.lng, 6);
  });

  it('a symmetric two-segment route lands its 0.5 fraction exactly on the middle vertex', () => {
    // GEOMETRY's two segments are equal length by construction (mirrored
    // around the middle vertex), so half the cumulative distance lands
    // exactly on it, not partway along a segment.
    const midpoint = pointAlongRoute(GEOMETRY, 0.5);
    expect(midpoint.lat).toBeCloseTo(GEOMETRY[1]!.lat, 3);
    expect(midpoint.lng).toBeCloseTo(GEOMETRY[1]!.lng, 3);
  });

  it('the real route length exceeds the straight chord for a genuinely curved route', () => {
    const chordKm = corridorDistanceKm(GEOMETRY[0]!, GEOMETRY[2]!);
    const routeKm = routeLengthKm(GEOMETRY);
    expect(routeKm).toBeGreaterThan(chordKm);
  });

  it('degenerate geometry (fewer than 2 points) returns the single point rather than throwing', () => {
    expect(pointAlongRoute([{ lat: 5, lng: 5 }], 0.5)).toEqual({ lat: 5, lng: 5 });
  });

  it('empty geometry has zero length and does not throw', () => {
    expect(routeLengthKm([])).toBe(0);
  });
});

/**
 * THE CURVED-ROUTE REGRESSION — LOAD-BEARING.
 *
 * Reproduces the exact generic failure class the live Iceland run exposed:
 * two endpoints connected by a straight chord that cuts through genuinely
 * uninhabited terrain, while the real drivable route bends substantially
 * around it. A viable town sits close to the real road but far (>20 km)
 * from every point the OLD chord-sampling strategy would have sampled.
 * Fictional geography throughout — no Iceland names.
 */
describe('curved-route regression — route-following sampling finds what straight-line sampling could not', () => {
  // A straight run along the equator; the real road instead bulges north to
  // lat 3 before returning — a large, genuine curve, not a rounding wobble.
  const ORIGIN: CorridorPoint = { lat: 0, lng: 0 };
  const DESTINATION: CorridorPoint = { lat: 0, lng: 4 };
  const ROAD_APEX: CorridorPoint = { lat: 3, lng: 2 };
  const CURVED_ROUTE: readonly CorridorPoint[] = [ORIGIN, ROAD_APEX, DESTINATION];

  // A real town near the road's own apex — a few km off it, never exactly
  // on it (a real settlement's centre rarely sits precisely on a sampled
  // route point either).
  const ROAD_TOWN = { sourceId: 'osm/road-town', name: 'Road Town', lat: 2.95, lng: 2.0, entityType: 'city' as const };

  /** Returns the town only when queried within `radiusKm` of its real coordinates — a real bounded-search fixture, not a scripted per-call answer. */
  function boundedSearchFor(town: CorridorLocality) {
    return async (point: CorridorPoint, radiusKm: number): Promise<readonly CorridorLocality[]> => {
      return corridorDistanceKm(point, town) <= radiusKm ? [town] : [];
    };
  }

  it('old straight-chord sampling cannot discover the town; route-following sampling does, and remediation succeeds', async () => {
    const confirmRoute = async () => ({ found: true, minutes: 150, km: 400 }); // comfortably under a 240-min ceiling

    // Old behaviour: no route geometry supplied, falls back to the chord —
    // exactly this module's pre-existing sampling.
    const withoutGeometry = await findCorridorRemedyCandidates({
      from: ORIGIN,
      to: DESTINATION,
      ceilingMinutes: 240,
      splitFractions: [0.5],
      isLocalityCandidate,
      findNearbyLocalities: boundedSearchFor(ROAD_TOWN),
      confirmRoute,
    });
    expect(withoutGeometry).toHaveLength(0); // the chord's own 0.5 sample is ~330 km from the town — the exact class of miss this round fixes

    // New behaviour: the real curved route is supplied.
    const withGeometry = await findCorridorRemedyCandidates({
      from: ORIGIN,
      to: DESTINATION,
      ceilingMinutes: 240,
      splitFractions: [0.5],
      isLocalityCandidate,
      routeGeometry: CURVED_ROUTE,
      findNearbyLocalities: boundedSearchFor(ROAD_TOWN),
      confirmRoute,
    });
    expect(withGeometry).toHaveLength(1);
    expect(withGeometry[0]!.locality.sourceId).toBe('osm/road-town');
    expect(withGeometry[0]!.foundVia).toBe('route_geometry');
    // The detour baseline used the real route's own length, not the much
    // shorter chord — a candidate essentially on the curved road itself
    // is not penalised for the road's own natural bend.
    expect(withGeometry[0]!.detourRatio).toBeLessThan(1.5);
  });

  it('a settlement near the straight chord but far from the actual curved road is not found once real geometry is supplied', async () => {
    const nearChordNotRoad = { sourceId: 'osm/near-chord', name: 'Near Chord', lat: 0.05, lng: 2.0, entityType: 'city' as const };
    const result = await findCorridorRemedyCandidates({
      from: ORIGIN,
      to: DESTINATION,
      ceilingMinutes: 240,
      splitFractions: [0.5],
      isLocalityCandidate,
      routeGeometry: CURVED_ROUTE,
      findNearbyLocalities: boundedSearchFor(nearChordNotRoad),
      confirmRoute: async () => ({ found: true, minutes: 150, km: 400 }),
    });
    expect(result).toHaveLength(0); // route-following sampling never looks near the chord once curved geometry is known
  });

  it('a real road-adjacent settlement is still rejected when one measured split leg exceeds the ceiling', async () => {
    let call = 0;
    const result = await findCorridorRemedyCandidates({
      from: ORIGIN,
      to: DESTINATION,
      ceilingMinutes: 240,
      splitFractions: [0.5],
      isLocalityCandidate,
      routeGeometry: CURVED_ROUTE,
      findNearbyLocalities: boundedSearchFor(ROAD_TOWN),
      confirmRoute: async () => {
        call += 1;
        return call === 1 ? { found: true, minutes: 150, km: 400 } : { found: true, minutes: 300, km: 400 }; // second leg over 240
      },
    });
    expect(result).toHaveLength(0);
  });

  it('an excessive detour is still rejected under the route-length baseline, not just the chord one', async () => {
    const wildlyOffRoute = { sourceId: 'osm/off-route', name: 'Off Route', lat: -20, lng: 2, entityType: 'city' as const };
    const result = await findCorridorRemedyCandidates({
      from: ORIGIN,
      to: DESTINATION,
      ceilingMinutes: 240,
      searchRadiusKm: 3000, // deliberately generous, so this fails on the detour ratio, not the radius bound
      splitFractions: [0.5],
      isLocalityCandidate,
      routeGeometry: CURVED_ROUTE,
      findNearbyLocalities: async () => [wildlyOffRoute],
      confirmRoute: async () => ({ found: true, minutes: 150, km: 400 }),
    });
    expect(result).toHaveLength(0);
  });

  it('an honest empty result when no qualifying settlement exists near the real route at all', async () => {
    const result = await findCorridorRemedyCandidates({
      from: ORIGIN,
      to: DESTINATION,
      ceilingMinutes: 240,
      splitFractions: [0.5],
      isLocalityCandidate,
      routeGeometry: CURVED_ROUTE,
      findNearbyLocalities: async () => [],
      confirmRoute: async () => ({ found: true, minutes: 150, km: 400 }),
    });
    expect(result).toHaveLength(0);
  });

  it('route geometry unavailable (absent, empty, or a single point) degrades to the straight-line fallback honestly — never a fabricated route', async () => {
    const nearChord = { sourceId: 'osm/near-chord-2', name: 'Near Chord Two', lat: 0.02, lng: 2.0, entityType: 'city' as const };
    for (const geometry of [undefined, [], [ORIGIN]] as const) {
      const result = await findCorridorRemedyCandidates({
        from: ORIGIN,
        to: DESTINATION,
        ceilingMinutes: 240,
        splitFractions: [0.5],
        isLocalityCandidate,
        ...(geometry !== undefined ? { routeGeometry: geometry } : {}),
        findNearbyLocalities: boundedSearchFor(nearChord),
        confirmRoute: async () => ({ found: true, minutes: 150, km: 400 }),
      });
      expect(result).toHaveLength(1);
      expect(result[0]!.foundVia).toBe('straight_line');
    }
  });
});
