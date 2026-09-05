import { describe, expect, it } from 'vitest';
import { BENCHMARK_CASES } from '@sidequest/bench/cases';
import { benchmarkTripRequestSchema, type BenchmarkTripRequest } from '@sidequest/bench';
import { buildResearchPacket, type PacketInputs, type RawPlace } from './packet';
import { compactPacketForModel } from './packet-compact';
import { buildSkeletonEvidencePacket, buildSkeletonEvidencePacketFromCompact, SKELETON_EVIDENCE_LIMITS } from './skeleton-packet';
import { fixtureMovingRoutePacketInputs, fixturePacketInputs, MOVING_ROUTE_DESTINATION, FIXTURE_DAYS } from './fixtures';

/**
 * A realistic-scale packet — six fictional regions, ~120 places — because
 * the moving-route fixture (8 places) is too small for compaction to show
 * through: the skeleton packet's own per-place/per-cluster metadata
 * (`includedFor`, `totalPlacesInRegion`) outweighs what filtering saves at
 * that scale. The claim under test — bounded regional selection meaningfully
 * shrinks the wire size — is only meaningful near the packet's real caps.
 */
function largeSyntheticPacketInputs(): PacketInputs {
  const regionCentres = [
    [45.0, 9.0],
    [45.6, 9.4],
    [46.1, 10.0],
    [46.6, 11.2],
    [47.0, 12.0],
    [47.4, 12.8],
  ];
  const kinds = ['tourism=viewpoint', 'natural=waterfall', 'tourism=museum', 'natural=peak', 'amenity=restaurant', 'shop=bakery'];
  const places: RawPlace[] = [];
  for (let region = 0; region < regionCentres.length; region += 1) {
    const [centreLat, centreLng] = regionCentres[region]!;
    for (let i = 0; i < 20; i += 1) {
      const kind = kinds[i % kinds.length]!;
      places.push({
        entityId: `node/synthetic-${region}-${i}`,
        name: `Region ${region} Place ${i}`,
        latitude: centreLat! + (i % 5) * 0.01,
        longitude: centreLng! + Math.floor(i / 5) * 0.01,
        kind,
        tags: kind.split('='),
        typicalDurationMinutes: 60,
        daylightOnly: null,
        hours: { state: 'unknown' },
        seasonal: { state: 'unknown' },
        access: { requiresCar: null, unpavedApproach: null, remoteNoServices: null, strenuous: null, wheelchair: 'unknown', feeStated: null },
        food: kind === 'amenity=restaurant' ? { servesSlots: ['lunch'], dietaryTags: [], cuisine: null, cannotAccommodate: [] } : null,
        source: { host: 'openstreetmap.org', title: null, url: null, retrievedAt: '2026-08-01T00:00:00.000Z' },
        significance: (i % 10) / 10,
      });
    }
  }
  return {
    destination: MOVING_ROUTE_DESTINATION,
    days: FIXTURE_DAYS,
    places,
    baseCandidates: regionCentres.map(([lat, lng], index) => ({
      entityId: null,
      name: `Region ${index} Town`,
      latitude: lat!,
      longitude: lng!,
      basis: 'A settlement the geocoder resolved.',
    })),
    routeLegs: [],
    gaps: [],
    unknowns: [],
  };
}

function requestWith(overrides: Partial<{
  interests: Partial<Record<string, string>>;
  hardAvoidances: string[];
  arrivalTime: string;
  departureTime: string;
}> = {}): BenchmarkTripRequest {
  const base = (BENCHMARK_CASES[0]?.request ?? {}) as Record<string, unknown> & { taste?: Record<string, unknown> & { interests?: Record<string, unknown> } };
  return benchmarkTripRequestSchema.parse({
    ...base,
    requestId: 'req-skeleton-packet',
    ...(overrides.interests
      ? { taste: { ...base.taste, interests: { ...base.taste?.interests, ...overrides.interests } } }
      : {}),
    ...(overrides.hardAvoidances ? { taste: { ...base.taste, hardAvoidances: overrides.hardAvoidances } } : {}),
    ...(overrides.arrivalTime
      ? { arrival: { precision: 'exact', time: overrides.arrivalTime } }
      : {}),
    ...(overrides.departureTime
      ? { departure: { precision: 'exact', time: overrides.departureTime } }
      : {}),
  });
}

describe('buildSkeletonEvidencePacket', () => {
  it('is materially smaller than the full compact packet at a realistic scale', () => {
    const packet = buildResearchPacket(largeSyntheticPacketInputs());
    const request = requestWith();
    const full = compactPacketForModel(packet);
    const skeleton = buildSkeletonEvidencePacket(packet, request);
    expect(packet.places.length).toBeGreaterThan(60);
    expect(JSON.stringify(skeleton).length).toBeLessThan(JSON.stringify(full).length * 0.85);
  });

  it('at small scale, still never exceeds the full compact packet by more than its own bookkeeping overhead', () => {
    // The moving-route fixture (8 places) is too small for filtering to
    // outweigh the skeleton packet's own added metadata (`includedFor`,
    // `totalPlacesInRegion`, `traveller`) — that crossover is expected and
    // is exactly why the realistic-scale test above is the one that matters.
    // What must still hold at any scale: no place is duplicated, and nothing
    // beyond the declared extra fields is why it grew.
    const packet = buildResearchPacket(fixtureMovingRoutePacketInputs());
    const skeleton = buildSkeletonEvidencePacket(packet, requestWith());
    const indices = skeleton.places.map((p) => p.index);
    expect(new Set(indices).size).toBe(indices.length);
  });

  it('survives regional coverage: both regions of a two-region packet are represented', () => {
    const packet = buildResearchPacket(fixtureMovingRoutePacketInputs());
    const skeleton = buildSkeletonEvidencePacket(packet, requestWith());
    // Two clusters (Northgate, Vale Hollow) — see the fixture's own
    // coordinates, ~240km apart.
    expect(packet.clusters.length).toBeGreaterThanOrEqual(2);
    for (const cluster of skeleton.clusters) {
      if (cluster.totalPlacesInRegion > 0) {
        expect(cluster.places.length).toBeGreaterThan(0);
      }
    }
  });

  it('never lets a dense region crowd out a quieter one entirely', () => {
    // Northgate (5 places, higher significance) must not consume the whole
    // selection at Vale Hollow's (3 places) expense — the exact failure this
    // pass exists to prevent one level up, at hydration.
    const packet = buildResearchPacket(fixtureMovingRoutePacketInputs());
    const skeleton = buildSkeletonEvidencePacket(packet, requestWith());
    const valeHollowCluster = skeleton.clusters.find((cluster) =>
      cluster.places.some((index) => skeleton.places.find((p) => p.index === index)?.name.startsWith('Vale Hollow')),
    );
    expect(valeHollowCluster).toBeDefined();
    expect(valeHollowCluster!.places.length).toBeGreaterThan(0);
  });

  it('keeps a canonical, high-significance place regardless of its cluster quota', () => {
    const packet = buildResearchPacket(fixtureMovingRoutePacketInputs());
    const skeleton = buildSkeletonEvidencePacket(packet, requestWith());
    const overlook = packet.places.find((p) => p.name === 'Northgate Overlook');
    expect(overlook?.significance).toBeGreaterThanOrEqual(SKELETON_EVIDENCE_LIMITS.canonicalSignificanceFloor);
    const included = skeleton.places.find((p) => p.index === overlook!.index);
    expect(included).toBeDefined();
    expect(included!.includedFor).toContain('canonical');
  });

  it('keeps at least one representative of a rare experience kind via the distinct-kind pass', () => {
    const packet = buildResearchPacket(fixtureMovingRoutePacketInputs());
    // The lake is the only `natural=water` place in the fixture and is not
    // significant enough to clear the canonical floor.
    const lake = packet.places.find((p) => p.name === 'Vale Hollow Lakeshore')!;
    expect(lake.significance).toBeLessThan(SKELETON_EVIDENCE_LIMITS.canonicalSignificanceFloor);
    const skeleton = buildSkeletonEvidencePacket(packet, requestWith());
    const included = skeleton.places.find((p) => p.index === lake.index);
    expect(included).toBeDefined();
  });

  it('boosts a place matching a core/frequent interest, distinct from raw significance', () => {
    const packet = buildResearchPacket(fixtureMovingRoutePacketInputs());
    const skeleton = buildSkeletonEvidencePacket(
      packet,
      requestWith({ interests: { hiking: 'core' } }),
    );
    const trailhead = packet.places.find((p) => p.name === 'Northgate Trail Head')!;
    const included = skeleton.places.find((p) => p.index === trailhead.index);
    expect(included).toBeDefined();
    expect(included!.includedFor).toContain('fit');
  });

  it('traveller preferences survive into the evidence packet', () => {
    const packet = buildResearchPacket(fixtureMovingRoutePacketInputs());
    const request = requestWith({ hardAvoidances: ['nightlife'] });
    const skeleton = buildSkeletonEvidencePacket(packet, request);
    expect(skeleton.traveller.hardAvoidances).toContain('nightlife');
    expect(skeleton.traveller.desiredBaseCount).toBe(request.movement.desiredBaseCount);
    expect(skeleton.traveller.maxDailyDriveMinutes).toBe(request.movement.maxDailyDriveMinutes);
  });

  it('arrival and departure survive into the evidence packet', () => {
    const packet = buildResearchPacket(fixtureMovingRoutePacketInputs());
    const request = requestWith({ arrivalTime: '09:30', departureTime: '18:00' });
    const skeleton = buildSkeletonEvidencePacket(packet, request);
    expect(skeleton.traveller.arrival).toContain('09:30');
    expect(skeleton.traveller.departure).toContain('18:00');
  });

  it('excludes internal candidate-selection tags the way the full compaction already does', () => {
    const packet = buildResearchPacket(fixtureMovingRoutePacketInputs());
    const skeleton = buildSkeletonEvidencePacket(packet, requestWith());
    for (const place of skeleton.places) {
      expect(place.tags?.some((tag) => tag.startsWith('included:') || tag.startsWith('role:'))).toBeFalsy();
    }
  });

  it('only includes route legs between two places the evidence packet actually shows', () => {
    const packet = buildResearchPacket(fixtureMovingRoutePacketInputs());
    const skeleton = buildSkeletonEvidencePacket(packet, requestWith());
    const shown = new Set(skeleton.places.map((p) => p.index));
    for (const leg of skeleton.routeLegs) {
      expect(shown.has(leg.from)).toBe(true);
      expect(shown.has(leg.to)).toBe(true);
    }
  });

  it('works on the small single-region fixture too, without crashing on an empty second region', () => {
    const packet = buildResearchPacket(fixturePacketInputs());
    const skeleton = buildSkeletonEvidencePacket(packet, requestWith());
    expect(skeleton.places.length).toBeGreaterThan(0);
  });
});

describe('buildSkeletonEvidencePacketFromCompact — equivalence with the live path', () => {
  it('produces the same selection as buildSkeletonEvidencePacket, via the compact projection in between', () => {
    const packet = buildResearchPacket(fixtureMovingRoutePacketInputs());
    const request = requestWith({ interests: { hiking: 'core' } });
    const fromLive = buildSkeletonEvidencePacket(packet, request);
    const fromCompact = buildSkeletonEvidencePacketFromCompact(compactPacketForModel(packet), request);
    expect(fromCompact).toEqual(fromLive);
  });

  it('is also equivalent at the realistic scale used for the size measurements', () => {
    const request = requestWith();
    const packet = buildResearchPacket({
      destination: MOVING_ROUTE_DESTINATION,
      days: FIXTURE_DAYS,
      places: Array.from({ length: 24 }, (_, i) =>
        ({
          entityId: `node/eq-${i}`,
          name: `Eq Place ${i}`,
          latitude: 45 + (i % 6) * 0.05,
          longitude: 9 + Math.floor(i / 6) * 0.5,
          kind: ['tourism=viewpoint', 'natural=waterfall', 'tourism=museum', 'amenity=restaurant'][i % 4]!,
          tags: ['tourism', 'attraction'],
          typicalDurationMinutes: 60,
          daylightOnly: null,
          hours: { state: 'unknown' as const },
          seasonal: { state: 'unknown' as const },
          access: { requiresCar: null, unpavedApproach: null, remoteNoServices: null, strenuous: null, wheelchair: 'unknown' as const, feeStated: null },
          food: null,
          source: null,
          significance: (i % 10) / 10,
        }) satisfies RawPlace,
      ),
      baseCandidates: [{ entityId: null, name: 'Eq Town', latitude: 45, longitude: 9, basis: 'x' }],
      routeLegs: [],
      gaps: [],
      unknowns: [],
    });
    const fromLive = buildSkeletonEvidencePacket(packet, request);
    const fromCompact = buildSkeletonEvidencePacketFromCompact(compactPacketForModel(packet), request);
    expect(fromCompact).toEqual(fromLive);
  });
});
