import { describe, expect, it } from 'vitest';
import { compactPacketForModel } from './packet-compact';
import { buildResearchPacket } from './packet';
import { fixtureGeneration, fixturePacketInputs } from './fixtures';
import { toBenchmarkPlan } from './convert';

/**
 * THE MODEL-FACING PROJECTION, CHECKED AGAINST WHAT IT MUST NOT LOSE.
 *
 * `compactPacketForModel` exists to shrink what the model reads, not to
 * change what it can decide with. Every test here is about a specific thing
 * that would be a real product regression if the projection silently
 * dropped it — hard constraints, coverage signals, closure/base geography,
 * relocation evidence, and identity stability — plus the two properties
 * the composer-efficiency pass was actually measured against: a materially
 * smaller serialized packet on real fixture data, and no accidental
 * duplication of the same fact the task text already states as prose.
 */

const PACKET = buildResearchPacket(fixturePacketInputs());
const COMPACT = compactPacketForModel(PACKET);

describe('stable place identity', () => {
  it('keeps the same index-to-place order as the full packet', () => {
    expect(COMPACT.places.map((place) => place.index)).toEqual(PACKET.places.map((place) => place.index));
    expect(COMPACT.places.map((place) => place.name)).toEqual(PACKET.places.map((place) => place.name));
    expect(COMPACT.places).toHaveLength(PACKET.places.length);
  });

  it('carries the same evidence pointer per place, so a citation still resolves', () => {
    expect(COMPACT.places.map((place) => place.source)).toEqual(
      PACKET.places.map((place) => place.sourceIndex),
    );
  });
});

const SOURCE = { host: 'osm.example', title: 'test', url: 'https://osm.example/x', retrievedAt: null };

describe('traveller hard-constraint signals survive compaction', () => {
  it('turns a true access flag into a compact flag, not silence', () => {
    const withCar = buildResearchPacket(
      fixturePacketInputs({
        places: [
          {
            entityId: 'node/9001',
            name: 'Remote Overlook',
            latitude: 45.2,
            longitude: 9.1,
            kind: 'natural=peak',
            tags: [],
            typicalDurationMinutes: 60,
            daylightOnly: null,
            hours: { state: 'unknown' },
            seasonal: { state: 'unknown' },
            access: {
              requiresCar: true,
              unpavedApproach: true,
              remoteNoServices: true,
              strenuous: true,
              wheelchair: 'no',
              feeStated: null,
            },
            food: null,
            source: SOURCE,
          },
        ],
      }),
    );
    const compact = compactPacketForModel(withCar);
    const place = compact.places.find((p) => p.name === 'Remote Overlook');
    expect(place?.flags).toEqual(
      expect.arrayContaining([
        'requires_car',
        'unpaved_approach',
        'remote_no_services',
        'strenuous',
        'wheelchair_no',
      ]),
    );
  });

  it('states nothing for a place with no unusual access signal, rather than a wall of nulls', () => {
    const ordinary = COMPACT.places.find((place) => place.name === 'Ardenholt Museum');
    expect(ordinary?.flags).toBeUndefined();
  });
});

describe('regional/significance coverage survives', () => {
  it('carries a place’s significance figure through, unrounded and undropped', () => {
    const packet = buildResearchPacket(
      fixturePacketInputs({
        places: [
          {
            entityId: 'node/9002',
            name: 'Most Prominent Site',
            latitude: 45.1,
            longitude: 9.05,
            kind: 'tourism=attraction',
            tags: [],
            typicalDurationMinutes: 90,
            daylightOnly: null,
            hours: { state: 'unknown' },
            seasonal: { state: 'open_in_season' },
            access: {
              requiresCar: null,
              unpavedApproach: null,
              remoteNoServices: null,
              strenuous: null,
              wheelchair: 'unknown',
              feeStated: null,
            },
            food: null,
            source: SOURCE,
            significance: 0.94,
          },
        ],
      }),
    );
    const compact = compactPacketForModel(packet);
    const place = compact.places.find((p) => p.name === 'Most Prominent Site');
    expect(place?.significance).toBe(0.94);
  });

  it('omits significance rather than reporting it as zero when nobody scored the place', () => {
    const place = COMPACT.places.find((p) => p.name === 'Ardenholt Museum');
    expect(place && 'significance' in place ? place.significance : undefined).toBeUndefined();
  });
});

describe('departure/closure and moving-route relocation context survives', () => {
  it('keeps base candidates with real coordinates, for closure and relocation geography', () => {
    expect(COMPACT.baseCandidates.length).toBeGreaterThan(0);
    for (const base of COMPACT.baseCandidates) {
      expect(typeof base.lat).toBe('number');
      expect(typeof base.lng).toBe('number');
      expect(base.name.length).toBeGreaterThan(0);
    }
  });

  it('keeps measured route legs with minutes and mode, for relocation-leg planning', () => {
    expect(COMPACT.routeLegs.length).toBe(PACKET.routeLegs.length);
    for (const leg of COMPACT.routeLegs) {
      expect(typeof leg.minutes).toBe('number');
      expect(['drive', 'walk', 'transit']).toContain(leg.mode);
    }
  });
});

describe('no duplicated information', () => {
  it('does not carry gaps or unknowns — buildGenerationTask already states them as prose', () => {
    expect('gaps' in COMPACT).toBe(false);
    expect('unknowns' in COMPACT).toBe(false);
  });

  it('does not send a full source record for the model to read — only a count', () => {
    expect('sources' in COMPACT).toBe(false);
    expect(COMPACT.sourceCount).toBe(PACKET.sources.length);
  });
});

describe('materially smaller on real fixture data', () => {
  it('reduces total serialized packet size substantially', () => {
    const fullBytes = JSON.stringify(PACKET).length;
    const compactBytes = JSON.stringify(COMPACT).length;
    expect(compactBytes).toBeLessThan(fullBytes * 0.6);
  });

  it('reduces the places section specifically — the measured dominant cost', () => {
    const fullPlacesBytes = JSON.stringify(PACKET.places).length;
    const compactPlacesBytes = JSON.stringify(COMPACT.places).length;
    expect(compactPlacesBytes).toBeLessThan(fullPlacesBytes * 0.7);
  });
});

/**
 * THE VALIDATOR HYDRATES FROM WHAT THE MODEL COULD ONLY EVER SEE AS AN
 * INDEX.
 *
 * The model reads `COMPACT` and returns integers; `convert.ts` resolves
 * those integers against `PACKET` — the full, unabridged packet — never the
 * compact view. This is the property that makes the whole projection safe:
 * an index the model picked from the smaller view still means the same
 * place in the bigger one, so conversion recovers everything the compact
 * view left out (entity id, full coordinates, source metadata) without the
 * model ever having needed to state it.
 */
describe('conversion hydrates full data from indices the model only saw compactly', () => {
  it('resolves a place the model referenced by index to its full record, entity id included', () => {
    const generation = fixtureGeneration();
    // Confirms the fixture generation actually references an index this
    // packet's compact view carries — a test that resolved nothing would
    // pass for the wrong reason.
    const referencedIndex = generation.days[0]!.blocks[0]!.placeIndex;
    expect(referencedIndex).not.toBeNull();
    expect(COMPACT.places[referencedIndex!]).toBeDefined();

    const { plan, danglingReferences } = toBenchmarkPlan({
      planId: 'plan-compact-1',
      requestId: 'req-1',
      output: generation,
      packet: PACKET,
      startDate: '2026-09-01',
      endDate: '2026-09-02',
      generationState: 'complete',
      failureKind: null,
      failureDetail: null,
    });

    expect(danglingReferences).toBe(0);
    const resolvedPlace = plan.days[0]!.blocks[0]!.place;
    const fullPlace = PACKET.places[referencedIndex!]!;
    expect(resolvedPlace?.entityId).toBe(fullPlace.entityId);
    expect(resolvedPlace?.latitude).toBe(fullPlace.latitude);
    expect(resolvedPlace?.longitude).toBe(fullPlace.longitude);
  });
});
