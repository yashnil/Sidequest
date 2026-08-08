import { describe, expect, it } from 'vitest';
import { fixturePacketInputs } from './fixtures';
import { buildResearchPacket, type RawPlace } from './packet';
import { PACKET_CAPS } from './packet-types';

/**
 * THE PACKET IS REPRODUCIBLE, BOUNDED, HONEST ABOUT WHAT IT DROPPED, AND
 * OPINIONLESS.
 *
 * Four properties, and each one is protecting a different way the benchmark
 * could produce a wrong answer.
 *
 * Reproducibility is what lets a difference between two runs be blamed on the
 * model rather than on the harness. Boundedness is what stops one arm quietly
 * receiving a context window's worth more of the world than it can use.
 * Recording the drop is what stops a plan looking decisive about a region it was
 * shown a third of. And the absence of a score is what stops this arm becoming
 * Sidequest's candidate selector with a language model bolted on the end.
 */

function placeAt(index: number, latitude: number, longitude: number): RawPlace {
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

describe('the research packet', () => {
  it('is byte-identical for byte-identical inputs', () => {
    const first = buildResearchPacket(fixturePacketInputs());
    const second = buildResearchPacket(fixturePacketInputs());
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  /**
   * Input order is an accident of whichever provider answered first. A packet
   * that inherited it would produce a different context window — and therefore a
   * different plan — from the same world, which would show up in the results as
   * model variance and would not be.
   */
  it('does not inherit the order the providers happened to answer in', () => {
    const inputs = fixturePacketInputs();
    const reversed = { ...inputs, places: [...inputs.places].reverse() };
    expect(JSON.stringify(buildResearchPacket(inputs))).toBe(
      JSON.stringify(buildResearchPacket(reversed)),
    );
  });

  it('addresses everything by index, and the indices are dense and in order', () => {
    const packet = buildResearchPacket(fixturePacketInputs());
    packet.places.forEach((place, index) => expect(place.index).toBe(index));
    packet.sources.forEach((source, index) => expect(source.index).toBe(index));
    for (const leg of packet.routeLegs) {
      expect(packet.places[leg.fromIndex]).toBeDefined();
      expect(packet.places[leg.toIndex]).toBeDefined();
    }
    for (const cluster of packet.clusters) {
      for (const member of cluster.placeIndices) expect(packet.places[member]).toBeDefined();
    }
  });

  it('drops a leg whose endpoints it does not hold, and says it did', () => {
    const packet = buildResearchPacket(
      fixturePacketInputs({
        routeLegs: [
          { fromEntityId: 'node/1001', toEntityId: 'node/does-not-exist', minutes: 12, km: 8, mode: 'drive' },
        ],
      }),
    );
    expect(packet.routeLegs).toHaveLength(0);
    expect(packet.gaps.some((gap) => gap.subject === 'measured route legs')).toBe(true);
  });

  describe('when there is more of the world than it may hold', () => {
    // Spread across a wide box so the grid has several cells to round-robin over.
    const many = Array.from({ length: PACKET_CAPS.places + 60 }, (_, index) =>
      placeAt(index, 45 + (index % 8) * 0.05, 9 + Math.floor(index / 8) * 0.05),
    );
    const packet = buildResearchPacket(fixturePacketInputs({ places: many }));

    it('keeps exactly the cap', () => {
      expect(packet.places).toHaveLength(PACKET_CAPS.places);
    });

    it('records the omission rather than truncating quietly', () => {
      const gap = packet.gaps.find(
        (entry) => entry.kind === 'capped_by_count' && entry.subject === 'places',
      );
      expect(gap).toBeDefined();
      expect(gap?.detail).toContain(String(many.length));
    });

    /**
     * The cap is by count with a geographic spread, not by quality. Reading
     * straight down the identity order would keep one corner of the region, and
     * the plan would be confidently local about somewhere that is not.
     */
    it('spreads what it keeps across the region rather than keeping one corner', () => {
      const latitudes = new Set(packet.places.map((place) => place.latitude));
      const longitudes = new Set(packet.places.map((place) => place.longitude));
      expect(latitudes.size).toBeGreaterThan(4);
      expect(longitudes.size).toBeGreaterThan(4);
      expect(packet.clusters.length).toBeGreaterThan(1);
    });
  });

  it('holds the same place once, however many providers described it', () => {
    const inputs = fixturePacketInputs();
    const doubled = { ...inputs, places: [...inputs.places, ...inputs.places] };
    const packet = buildResearchPacket(doubled);
    expect(new Set(packet.places.map((place) => place.entityId)).size).toBe(
      packet.places.length,
    );
    expect(packet.gaps.some((gap) => gap.subject === 'duplicate places')).toBe(true);
  });

  /**
   * THE PROPERTY THIS WHOLE ARM RESTS ON.
   *
   * A fit score, a rank, a base assignment or a day assignment anywhere in this
   * structure would mean the deterministic layer had already made the decisions
   * the model is supposed to be making, and the benchmark would be comparing two
   * renderers. Asserted over the serialised packet rather than over the type, so
   * a field added to the type without being added here is still caught.
   */
  it('carries no score, no rank, no base assignment and no day assignment', () => {
    const packet = buildResearchPacket(fixturePacketInputs());
    const serialised = JSON.stringify(packet);
    for (const forbidden of [
      'fitScore',
      'personalFit',
      'score',
      'rank',
      'ranking',
      'priority',
      'recommended',
      'shortlist',
      'selected',
      'baseId',
      'assignedBase',
      'dayNumber":null',
      'suggestedDay',
      'hiddenGem',
    ]) {
      expect(serialised.includes(forbidden), `the packet contains "${forbidden}"`).toBe(false);
    }
    // The one grouping it does carry, and its neutrality is in its label.
    expect(packet.clusters.every((cluster) => /^Cluster \d+$/.test(cluster.label))).toBe(true);
  });

  it('keeps unknown as a value rather than as a missing key', () => {
    const packet = buildResearchPacket(fixturePacketInputs());
    for (const place of packet.places) {
      expect(place.hours.state).toBeDefined();
      expect(place.seasonal.state).toBeDefined();
      expect(place.access.wheelchair).toBeDefined();
    }
    for (const day of packet.days) {
      expect(day.weather.state).toBeDefined();
      expect(day.daylight.state).toBeDefined();
    }
    expect(packet.days.some((day) => day.weather.state === 'unknown')).toBe(true);
  });

  it('carries the shared inventory identity for every place, so a plan can be resolved', () => {
    const packet = buildResearchPacket(fixturePacketInputs());
    expect(packet.places.length).toBeGreaterThan(0);
    for (const place of packet.places) {
      expect(place.entityId.length).toBeGreaterThan(0);
    }
  });
});
