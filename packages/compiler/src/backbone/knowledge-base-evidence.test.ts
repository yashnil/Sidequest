import { describe, expect, it } from 'vitest';
import {
  assessPlaceStanding,
  geographicScopeSchema,
  type GeographicScope,
  type SourceRecord,
} from '@sidequest/core';
import { assemblePack } from './assemble';
import {
  buildInventory,
  resolveKnowledgeBaseEvidence,
  toCandidate,
  type KnowledgeBaseEvidence,
} from './inventory';
import { partitionScope } from './partition';
import { classifySourceCategory } from './taxonomy';

/**
 * ============================================================================
 * KNOWLEDGE-BASE EVIDENCE THAT HAS A SOURCE, AND UNCERTAINTY THAT SURVIVES
 * WHERE IT HAS NONE.
 * ============================================================================
 *
 * ## The defect
 *
 * `assessPlaceStanding` was handed `inKnowledgeBase: record.wikidataId !==
 * undefined` for every record. For the *primary place layer* that is not a
 * measurement — the source publishes no place-level `wikidata` leaf and no
 * `source_tags` map at all, so the expression is a constant `false` in every
 * destination, permanently. Measured against the real catalogue (Overture
 * release 2026-07-22.0, all overlapping row groups decoded): 0 of 272,018
 * Tokyo place rows, 0 of 92,042 Osaka, 0 of 43,228 Lisbon.
 *
 * Two things followed and both are tested here:
 *
 * 1. The strongest global channel in the significance model was silent for the
 *    layer a board is built from, while the supplemental geography layers were
 *    holding the evidence — Q183536 sits at Tokyo Tower's coordinates in the
 *    infrastructure layer.
 * 2. The silence was written as an *observation*. `assessPlaceStanding` reads a
 *    `false` here as "we looked for an entry and no encyclopaedia has heard of
 *    this", which is the globally-obscure half of the hiddenness claim. We had
 *    not looked; we could not look.
 *
 * ## What these tests hold
 *
 * The transfer is deliberately narrow, and every one of its four gates has a
 * test that fails when the gate is removed. Name agreement alone matches a
 * ramen restaurant to the river it is named after, at ninety-four metres, on
 * the real Tokyo box; kind agreement alone matches any two neighbouring parks;
 * proximity alone matches everything in a city block. The measured false
 * transfers are what each fixture below is shaped from.
 *
 * ## What these tests deliberately do NOT claim
 *
 * That this rescues famous places. It does not, and the measurement says so:
 * on the Tokyo box exactly one of fifteen canonical subjects gains an
 * identifier this way, because the two layers do not name the same things —
 * where the geographic layer holds the landmark the place catalogue holds its
 * gate, and where the place catalogue holds the landmark no geographic twin
 * carries an identifier. A reader who mistakes this suite for a recall gate
 * will stop looking for the real one, which lives under `iq/recall`.
 * ============================================================================
 */

function scopeFor(): GeographicScope {
  return geographicScopeSchema.parse({
    schemaVersion: 1,
    revision: 1,
    destinationCandidateId: 'relation/1',
    destinationName: 'Testville',
    destinationEntityType: 'city',
    breadth: 'city',
    center: { lat: 40.7, lng: -74 },
    bounds: { southWest: { lat: 40.6, lng: -74.1 }, northEast: { lat: 40.8, lng: -73.9 } },
    timeZones: ['UTC'],
    shape: {
      kind: 'bounds',
      bounds: { southWest: { lat: 40.6, lng: -74.1 }, northEast: { lat: 40.8, lng: -73.9 } },
    },
    includedAreas: [],
    excludedAreas: [],
    gateways: [],
    transport: {
      primaryMode: 'walk',
      allowedModes: ['walk', 'rail'],
      carAvailable: false,
      acceptsWaterOrAirTransfers: true,
      basis: 'default',
      note: 'Test transport.',
    },
    maxBaseChanges: 0,
    nights: 4,
    rationale: 'A test scope.',
    confidence: { level: 'high', signals: [], note: 'Test.' },
    decidedBy: [],
    confirmedByUser: true,
  });
}

function record(overrides: Partial<SourceRecord> = {}): SourceRecord {
  return {
    id: 'places:a',
    layerId: 'places',
    sourceId: 'a',
    name: 'Riverside Park',
    alternateNames: [],
    coordinates: { lat: 40.7, lng: -74 },
    sourceCategory: 'park',
    sourceCategoryPath: ['landmarks_and_outdoors', 'park'],
    planningRole: 'outdoor',
    websiteCandidates: [],
    containment: { countryCode: 'AA', localityName: 'Testville', divisionIds: [] },
    attributes: {},
    sources: [{ dataset: 'primary', licenceId: 'CDLA-Permissive-2.0' }],
    cellId: 'g-0-0',
    ...overrides,
  };
}

const kindOf = (entry: SourceRecord): string =>
  classifySourceCategory({ category: entry.sourceCategory, path: entry.sourceCategoryPath }).subrole;

function evidenceFor(records: SourceRecord[]): Map<string, KnowledgeBaseEvidence> {
  return resolveKnowledgeBaseEvidence(records, kindOf);
}

/** Metres, at this latitude, as a degree offset — so fixtures read as distances. */
function metresNorth(from: { lat: number; lng: number }, metres: number) {
  return { lat: from.lat + metres / 111_320, lng: from.lng };
}

// ---------------------------------------------------------------------------

describe('an absence the source cannot answer is not an observation', () => {
  it('reports a layer that publishes no identifier as unobservable, not as absent', () => {
    const places = [
      record({ id: 'places:1', name: 'One' }),
      record({ id: 'places:2', name: 'Two' }),
    ];
    const evidence = evidenceFor(places);

    for (const entry of places) {
      const resolved = evidence.get(entry.id);
      expect(resolved?.origin).toBe('unobservable');
      /*
       * The load-bearing assertion. `assessPlaceStanding` distinguishes an
       * absent channel from a false one, and writing `false` here would state
       * that no encyclopaedia has heard of a place we never asked about.
       */
      expect(resolved?.inKnowledgeBase).toBeUndefined();
    }
  });

  it('reports absence as an observation once the layer answers for anything', () => {
    const evidence = evidenceFor([
      record({ id: 'places:known', name: 'Known', wikidataId: 'Q1' }),
      record({ id: 'places:unknown', name: 'Unknown' }),
    ]);

    expect(evidence.get('places:known')?.origin).toBe('own_layer');
    expect(evidence.get('places:unknown')?.origin).toBe('absent');
    expect(evidence.get('places:unknown')?.inKnowledgeBase).toBe(false);
  });
});

describe('a twin in another layer carries its evidence across', () => {
  const park = record({ id: 'places:park', name: 'Riverside Park' });
  const parkPolygon = record({
    id: 'land_use:park',
    layerId: 'land_use',
    sourceId: 'park',
    name: 'Riverside Park',
    sourceCategory: 'park',
    sourceCategoryPath: [],
    coordinates: metresNorth(park.coordinates, 40),
    wikidataId: 'Q9001',
    attributes: { wikipedia: 'en:Riverside Park' },
    sources: [{ dataset: 'OpenStreetMap', licenceId: 'ODbL-1.0' }],
  });

  it('gives the place its twin’s identifier and names the layer it came from', () => {
    const evidence = evidenceFor([park, parkPolygon]);
    const resolved = evidence.get(park.id);

    expect(resolved?.origin).toBe('cross_layer');
    expect(resolved?.inKnowledgeBase).toBe(true);
    expect(resolved?.fromLayerId).toBe('land_use');
  });

  it('carries the encyclopaedia article from the twin, not from the recipient', () => {
    /*
     * The recipient claims an article of its own. The transfer must report the
     * *donor's*, because the identifier and the article are one statement about
     * one entity and mixing them would let a record claim prose the match never
     * established.
     */
    const claimant = { ...park, attributes: { wikipedia: 'en:Something Else' } };
    const withoutArticle = { ...parkPolygon, attributes: {} };
    const evidence = evidenceFor([claimant, withoutArticle]);

    expect(evidence.get(park.id)?.origin).toBe('cross_layer');
    expect(evidence.get(park.id)?.encyclopaedicArticle).toBe(false);
  });

  it('matches through an alternate name in another script', () => {
    const localName = { ...park, name: '川辺公園', alternateNames: ['Riverside Park'] };
    const evidence = evidenceFor([localName, parkPolygon]);
    expect(evidence.get(park.id)?.origin).toBe('cross_layer');
  });
});

describe('no single agreement is enough on its own', () => {
  const river = record({
    id: 'water:river',
    layerId: 'water',
    sourceId: 'river',
    name: 'Kanda River',
    sourceCategory: 'river',
    sourceCategoryPath: [],
    planningRole: 'outdoor',
    coordinates: { lat: 40.7, lng: -74 },
    wikidataId: 'Q7788',
  });

  it('refuses a restaurant the identifier of the river it is named after', () => {
    /*
     * Measured on the real Tokyo box: 神田川 the ramen restaurant sits 94 m from
     * 神田川 the river, shares its name exactly, and is not the river. Name and
     * proximity both agree; the kind does not.
     */
    const restaurantNamedAfterIt = record({
      id: 'places:ramen',
      name: 'Kanda River',
      sourceCategory: 'ramen_restaurant',
      sourceCategoryPath: ['eat_and_drink', 'ramen_restaurant'],
      planningRole: 'food',
      coordinates: metresNorth(river.coordinates, 94),
    });

    const evidence = evidenceFor([restaurantNamedAfterIt, river]);
    expect(evidence.get('places:ramen')?.origin).toBe('unobservable');
    expect(evidence.get('places:ramen')?.inKnowledgeBase).toBeUndefined();
  });

  it('refuses a neighbouring park that merely shares a kind', () => {
    const otherPark = record({
      id: 'places:other',
      name: 'Corner Green',
      coordinates: metresNorth({ lat: 40.7, lng: -74 }, 30),
    });
    const namedPark = record({
      id: 'land_use:named',
      layerId: 'land_use',
      sourceId: 'named',
      name: 'Riverside Park',
      sourceCategory: 'park',
      sourceCategoryPath: [],
      coordinates: { lat: 40.7, lng: -74 },
      wikidataId: 'Q4242',
    });

    const evidence = evidenceFor([otherPark, namedPark]);
    expect(evidence.get('places:other')?.origin).toBe('unobservable');
  });

  it('refuses a namesake too far away to be the same thing', () => {
    const namedPark = record({
      id: 'land_use:named',
      layerId: 'land_use',
      sourceId: 'named',
      name: 'Riverside Park',
      sourceCategory: 'park',
      sourceCategoryPath: [],
      coordinates: { lat: 40.7, lng: -74 },
      wikidataId: 'Q4242',
    });

    /*
     * Six hundred metres, deliberately, and not six kilometres.
     *
     * A distance far beyond the radius is also far beyond the blocking grid,
     * so it would be refused even with the distance check deleted — the test
     * would pass while protecting nothing. This one sits *inside* the search
     * and outside the radius, which is the only arrangement that holds the
     * check itself. The far case is asserted below so the blocking is covered
     * too, but it is the weaker of the two and is labelled as such.
     */
    const outsideRadius = record({
      id: 'places:near-ish',
      name: 'Riverside Park',
      coordinates: metresNorth(namedPark.coordinates, 600),
    });
    expect(evidenceFor([outsideRadius, namedPark]).get('places:near-ish')?.origin).toBe(
      'unobservable',
    );

    const wellOutsideTheSearch = record({
      id: 'places:far',
      name: 'Riverside Park',
      coordinates: metresNorth(namedPark.coordinates, 6_000),
    });
    expect(evidenceFor([wellOutsideTheSearch, namedPark]).get('places:far')?.origin).toBe(
      'unobservable',
    );
  });

  it('lets a published boundary widen the search, and only a published one', () => {
    /*
     * A land-use polygon records a large garden at its centroid while the place
     * catalogue records it at the entrance, and on real boxes that separation
     * runs past the base radius. The widening comes from the twin's *published*
     * extent — never from an assumed radius, which would be proximity wearing a
     * better name — so the same pair without a boundary is refused.
     */
    const gardenPoint = record({
      id: 'places:garden',
      name: 'Great Garden',
      coordinates: metresNorth({ lat: 40.7, lng: -74 }, 600),
    });
    const withoutBoundary = record({
      id: 'land_use:garden',
      layerId: 'land_use',
      sourceId: 'garden',
      name: 'Great Garden',
      sourceCategory: 'garden',
      sourceCategoryPath: [],
      coordinates: { lat: 40.7, lng: -74 },
      wikidataId: 'Q5150',
    });
    const withBoundary = {
      ...withoutBoundary,
      bounds: {
        southWest: { lat: 40.69, lng: -74.01 },
        northEast: { lat: 40.71, lng: -73.99 },
      },
    };

    expect(evidenceFor([gardenPoint, withoutBoundary]).get('places:garden')?.origin).toBe(
      'unobservable',
    );
    expect(evidenceFor([gardenPoint, withBoundary]).get('places:garden')?.origin).toBe(
      'cross_layer',
    );
  });

  it('refuses a same-layer namesake, which is the dedupe layer’s business', () => {
    const twinInSameLayer = record({
      id: 'places:twin',
      name: 'Riverside Park',
      coordinates: metresNorth({ lat: 40.7, lng: -74 }, 20),
    });
    const namedPark = record({
      id: 'places:named',
      name: 'Riverside Park',
      coordinates: { lat: 40.7, lng: -74 },
      wikidataId: 'Q4242',
    });

    const evidence = evidenceFor([twinInSameLayer, namedPark]);
    expect(evidence.get('places:twin')?.origin).toBe('absent');
    expect(evidence.get('places:twin')?.inKnowledgeBase).toBe(false);
  });
});

describe('one identifier reaches one record', () => {
  it('gives the identifier to the nearest claimant and leaves the rest unevidenced', () => {
    /*
     * Without this guard, 6.7% of transferred identifiers in the Tokyo box and
     * 8.1% in Lisbon were claimed by several records at once. An identifier
     * spread across several records is one source becoming global truth, and
     * the conservative loss — a legitimate second claimant staying unevidenced —
     * is the direction this model is built to carry.
     */
    const donor = record({
      id: 'land_use:park',
      layerId: 'land_use',
      sourceId: 'park',
      name: 'Riverside Park',
      sourceCategory: 'park',
      sourceCategoryPath: [],
      coordinates: { lat: 40.7, lng: -74 },
      wikidataId: 'Q4242',
    });
    const near = record({ id: 'places:near', coordinates: metresNorth(donor.coordinates, 10) });
    const far = record({ id: 'places:far', coordinates: metresNorth(donor.coordinates, 200) });

    const evidence = evidenceFor([far, near, donor]);
    expect(evidence.get('places:near')?.origin).toBe('cross_layer');
    expect(evidence.get('places:far')?.origin).toBe('unobservable');
  });
});

// ---------------------------------------------------------------------------
// End to end, through the inventory the product actually builds
// ---------------------------------------------------------------------------

function packWith(records: SourceRecord[]) {
  const scope = scopeFor();
  const layerIds = [...new Set(records.map((entry) => entry.layerId))];
  return assemblePack({
    id: 'pack-knowledge',
    scope,
    releases: [{ catalog: 'test', releaseId: '2026-01-01.0', resolvedAt: '2026-01-01T00:00:00Z' }],
    partition: partitionScope(scope),
    layers: layerIds.map((layerId) => ({
      id: layerId,
      kind: layerId === 'places' ? ('primary_places' as const) : ('supplemental_geography' as const),
      catalog: 'test',
      datasetPath: layerId === 'places' ? 'places/place' : `base/${layerId}`,
      licenceId: layerId === 'places' ? ('CDLA-Permissive-2.0' as const) : ('ODbL-1.0' as const),
      records: records.filter((entry) => entry.layerId === layerId),
      featuresRead: records.length,
      featuresRetained: records.filter((entry) => entry.layerId === layerId).length,
      failedCellIds: [],
    })),
    diagnostics: {
      filesInspected: 1,
      rowGroupsInspected: 1,
      rowGroupsRead: 1,
      bytesTransferred: 1,
      durationMs: 1,
      budgetsExhausted: [],
      layerTimings: [],
    },
    now: new Date('2026-08-12T00:00:00Z'),
  });
}

/**
 * The case that decides whether any of this is worth having.
 *
 * A place record and its geographic twin describe one thing, so the linker
 * calls them the same entity and `supersededRecordIds` keeps whichever is
 * better described — which, for a well-mapped venue against a bare polygon, is
 * the *place* record. The identifier lived on the polygon. Without a transfer
 * the survivor carries no knowledge-base evidence and the polygon that had it
 * is gone from the inventory: the evidence does not merely fail to arrive, it
 * is destroyed by the deduplication that was supposed to keep the better half.
 */
describe('the transfer reaches the standing model', () => {
  /*
   * Three records that differ in exactly one thing: what their twin publishes.
   *
   * Written as a three-way comparison inside one pack rather than as a single
   * "is it greater than zero" assertion, because a single assertion would pass
   * with the transfer removed. A place linked to *any* twin in another layer
   * already earns `cross_catalogue_corroboration` — 0.30 on its own — so "has a
   * prominence" cannot distinguish a record that gained an identifier from one
   * that merely has a neighbour. What distinguishes them is the value: 0.65
   * against 0.30, and the gap is the channel this file is about.
   *
   * The donors carry their name in a local script with the recipient's name as
   * an alternate, which is the shape the real catalogue takes: the geographic
   * layer holds 新宿御苑 with "Shinjuku Gyoen" among its alternates while the
   * place catalogue holds the English form.
   */
  const twinned = record({
    id: 'places:twinned',
    name: 'Riverside Park',
    websiteCandidates: ['https://example.test/riverside'],
    attributes: { opening_hours: 'Mo-Su 06:00-22:00', operator: 'Ward Office' },
  });
  const merelyCorroborated = record({
    id: 'places:corroborated',
    name: 'Corner Green',
    coordinates: { lat: 40.72, lng: -74.02 },
    websiteCandidates: ['https://example.test/corner'],
    attributes: { opening_hours: 'Mo-Su 06:00-22:00', operator: 'Ward Office' },
  });
  const unevidenced = record({
    id: 'places:plain',
    name: 'Back Lane Green',
    coordinates: { lat: 40.74, lng: -74.05 },
  });
  const donorWithIdentifier = record({
    id: 'land_use:riverside',
    layerId: 'land_use',
    sourceId: 'riverside',
    name: '川辺公園',
    alternateNames: ['Riverside Park'],
    sourceCategory: 'park',
    sourceCategoryPath: [],
    coordinates: metresNorth(twinned.coordinates, 30),
    wikidataId: 'Q9001',
    sources: [{ dataset: 'OpenStreetMap', licenceId: 'ODbL-1.0' }],
  });
  const donorWithoutIdentifier = record({
    id: 'land_use:corner',
    layerId: 'land_use',
    sourceId: 'corner',
    name: '角の緑地',
    alternateNames: ['Corner Green'],
    sourceCategory: 'park',
    sourceCategoryPath: [],
    coordinates: metresNorth(merelyCorroborated.coordinates, 30),
    sources: [{ dataset: 'OpenStreetMap', licenceId: 'ODbL-1.0' }],
  });

  const world = [twinned, merelyCorroborated, unevidenced, donorWithIdentifier, donorWithoutIdentifier];

  function placesOf() {
    const inventory = buildInventory({ pack: packWith(world), scope: scopeFor() });
    return {
      inventory,
      byId: new Map(
        [...inventory.candidates, ...inventory.supporting].map((entry) => [entry.place.id, entry.place]),
      ),
    };
  }

  it('separates a transferred identifier from a bare neighbour and from nothing at all', () => {
    const { byId } = placesOf();

    /*
     * An identifier its twin published, plus the corroboration that twin gives
     * — read off the standing model rather than written as a literal, because
     * the literal was 0.65 (the bare presence union) and the notice-magnitude
     * gate moved what a presence union is worth. What this test is about is the
     * *transfer*, so it asserts that the transferred evidence assesses to
     * exactly what the same evidence assesses to anywhere, and cannot drift
     * again when a weight moves.
     */
    expect(byId.get(twinned.id)?.globalProminence).toBe(
      assessPlaceStanding({ inKnowledgeBase: true, crossDatasetCorroboration: true })
        .globalProminence,
    );
    // A twin, and nothing published about it. Corroboration only.
    expect(byId.get(merelyCorroborated.id)?.globalProminence).toBeCloseTo(0.3, 2);
    /* And the transfer is what separates them, in the direction it claims. */
    expect(byId.get(twinned.id)!.globalProminence!).toBeGreaterThan(
      byId.get(merelyCorroborated.id)!.globalProminence!,
    );
    /*
     * Preserved uncertainty, stated as an assertion: a record nothing vouches
     * for carries an *absent* prominence rather than a low one, because "we
     * know nothing about it" and "the world has not noticed it" are different
     * sentences and only one of them is supported.
     */
    expect(byId.get(unevidenced.id)?.globalProminence).toBeUndefined();
  });

  it('keeps the evidence when the collapse keeps a different twin than the one the claim landed on', () => {
    /*
     * The Tokyo Disneyland shape of 2026-08-13, as a fixture. One land-use
     * polygon carries the identifier and the article; several place-catalogue
     * twins of the same entity stand beside it. The transfer's one-recipient
     * rule hands the evidence to the *nearest* twin; the collapse keeps the
     * *strongest* twin; and when those are different records, the entity the
     * linker just proved famous used to enter ranking with no evidence at all
     * — the live pack lost the theme park to exactly this intersection.
     */
    const base = { lat: 40.75, lng: -74.06 };
    const donor = record({
      id: 'land_use:rings',
      layerId: 'land_use',
      sourceId: 'rings',
      name: '環公園',
      alternateNames: ['Harbour Rings'],
      sourceCategory: 'park',
      sourceCategoryPath: [],
      coordinates: base,
      wikidataId: 'Q9002',
      attributes: { wikipedia: 'en:Harbour Rings' },
      sources: [{ dataset: 'OpenStreetMap', licenceId: 'ODbL-1.0' }],
    });
    /* Nearest to the donor, so the claim lands here — and weakest, so it dies. */
    const nearestTwin = record({
      id: 'places:rings-thin',
      sourceId: 'rings-thin',
      name: 'Harbour Rings',
      coordinates: metresNorth(base, 10),
    });
    /* Strongest, so the collapse keeps it — and farther, so it never claimed. */
    const survivingTwin = record({
      id: 'places:rings-strong',
      sourceId: 'rings-strong',
      name: 'Harbour Rings',
      coordinates: metresNorth(base, 60),
      websiteCandidates: ['https://example.test/harbour-rings'],
      attributes: { opening_hours: 'Mo-Su 09:00-17:00', operator: 'Rings Trust' },
      sources: [
        { dataset: 'primary', licenceId: 'CDLA-Permissive-2.0' },
        { dataset: 'secondary', licenceId: 'CDLA-Permissive-2.0' },
      ],
    });

    const inventory = buildInventory({
      pack: packWith([...world, donor, nearestTwin, survivingTwin]),
      scope: scopeFor(),
    });
    const byId = new Map(
      [...inventory.candidates, ...inventory.supporting].map((entry) => [entry.place.id, entry.place]),
    );

    /* One survivor, and it carries the component's whole knowledge evidence —
     * an entry, an article and the corroboration — not the bare corroboration a
     * mere neighbour earns, which is what it read while the claim died with the
     * collapsed twin. Asserted against the standing model rather than as the
     * literal 0.79, because that literal was the bare presence union and the
     * notice-magnitude gate changed what a presence union is worth; what is
     * being tested here is which evidence reached the survivor. */
    expect(byId.has(donor.id)).toBe(false);
    expect(byId.has(nearestTwin.id)).toBe(false);
    expect(byId.get(survivingTwin.id)?.globalProminence).toBe(
      assessPlaceStanding({
        inKnowledgeBase: true,
        encyclopaedicArticle: true,
        crossDatasetCorroboration: true,
      }).globalProminence,
    );
    expect(byId.get(survivingTwin.id)!.globalProminence!).toBeGreaterThan(
      assessPlaceStanding({ crossDatasetCorroboration: true }).globalProminence!,
    );
  });

  it('keeps the evidence when deduplication removes the record it came from', () => {
    const { byId } = placesOf();
    /*
     * The polygon and the place record are one thing, so the linker calls them
     * the same entity and the better-described half survives — which here is
     * the place record, because it carries hours, an operator and a website
     * while the polygon carries a bare identifier. Before the transfer the
     * identifier went with the loser and nothing downstream could recover it.
     */
    expect(byId.has(donorWithIdentifier.id)).toBe(false);
    expect(byId.get(twinned.id)?.globalProminence).toBe(
      assessPlaceStanding({ inKnowledgeBase: true, crossDatasetCorroboration: true })
        .globalProminence,
    );
  });

  it('reports what the channel reached, split by whether the question could be asked', () => {
    const { inventory } = placesOf();
    const knowledge = inventory.diagnostics.knowledgeBase;

    expect(knowledge.ownLayer).toBe(1);
    expect(knowledge.crossLayer).toBe(1);
    expect(knowledge.crossLayerByDonorLayer).toEqual([{ layerId: 'land_use', gained: 1 }]);
    /*
     * The two numbers that did not exist before, and the distinction between
     * them is the point. `land_use:corner` sits in a layer that answered the
     * question for another record, so its own silence is an observation. The
     * two remaining place records sit in a layer that answered for nothing, so
     * theirs is not — they are not places the world has failed to notice, they
     * are places nobody asked about.
     */
    expect(knowledge.unevidenced).toBe(1);
    expect(knowledge.unobservable).toBe(2);
  });
});

describe('a caller holding one record cannot fabricate pack-wide evidence', () => {
  it('falls back to what the record itself carries when no evidence is supplied', () => {
    const candidate = toCandidate({
      record: record({ id: 'places:lonely', name: 'Lonely Garden' }),
      scope: scopeFor(),
      crossLayerCorroborated: false,
      role: 'outdoor',
      inclusion: 'inside_scope',
    });
    expect(candidate.place.globalProminence).toBeUndefined();
  });

  it('honours supplied evidence over the record’s own emptiness', () => {
    const candidate = toCandidate({
      record: record({ id: 'places:lonely', name: 'Lonely Garden' }),
      scope: scopeFor(),
      crossLayerCorroborated: false,
      role: 'outdoor',
      inclusion: 'inside_scope',
      knowledgeBase: { inKnowledgeBase: true, origin: 'cross_layer', fromLayerId: 'land_use' },
    });
    expect(candidate.place.globalProminence).toBeGreaterThan(0);
  });
});

describe('a class-suffixed twin still names the same ground', () => {
  /**
   * A geographic layer names a feature with its class fused into the word —
   * the waterway carries one extra trailing character naming what kind of
   * water it is — while the place catalogue names the ground itself. On a
   * live metro pack that single character kept an encyclopaedic identity on
   * the water layer while the famous district it attests died at eligibility
   * as unrecognisable: the exact-name test could not see the pair. The match
   * now tolerates exactly one trailing character, and nothing else — the
   * kind test, the radius and the one-recipient guard still hold.
   */
  it('carries an identifier across one trailing character of name difference', () => {
    const waterway = record({
      id: 'water:channel',
      layerId: 'water',
      sourceId: 'channel',
      name: '緑川堀川',
      sourceCategory: 'canal',
      sourceCategoryPath: [],
      planningRole: 'outdoor',
      wikidataId: 'Q77001',
      coordinates: { lat: 40.7001, lng: -74.0001 },
    });
    const district = record({
      id: 'places:district',
      sourceId: 'district',
      name: '緑川堀',
      sourceCategory: 'geographic_entities',
      sourceCategoryPath: ['geographic_entities'],
      coordinates: { lat: 40.7, lng: -74 },
    });
    const evidence = resolveKnowledgeBaseEvidence([waterway, district], kindOf);
    expect(evidence.get('places:district')).toMatchObject({
      inKnowledgeBase: true,
      origin: 'cross_layer',
      fromLayerId: 'water',
    });
  });

  it('still refuses a suffix cousin of a different kind', () => {
    /* Same one-character shape, but the recipient is a transit stop: the kind
     * test refuses it before the name tolerance can matter. */
    const waterway = record({
      id: 'water:channel',
      layerId: 'water',
      sourceId: 'channel',
      name: '緑川堀川',
      sourceCategory: 'canal',
      sourceCategoryPath: [],
      planningRole: 'outdoor',
      wikidataId: 'Q77002',
      coordinates: { lat: 40.7001, lng: -74.0001 },
    });
    const stop = record({
      id: 'places:stop',
      sourceId: 'stop',
      name: '緑川堀',
      sourceCategory: 'train_station',
      sourceCategoryPath: ['travel_and_transportation', 'transport_hub', 'train_station'],
      planningRole: 'gateway',
      coordinates: { lat: 40.7, lng: -74 },
    });
    const evidence = resolveKnowledgeBaseEvidence([waterway, stop], kindOf);
    expect(evidence.get('places:stop')?.inKnowledgeBase).not.toBe(true);
  });

  it('refuses two or more trailing characters — tolerance is not similarity', () => {
    const waterway = record({
      id: 'water:channel',
      layerId: 'water',
      sourceId: 'channel',
      name: '緑川堀川筋',
      sourceCategory: 'canal',
      sourceCategoryPath: [],
      planningRole: 'outdoor',
      wikidataId: 'Q77003',
      coordinates: { lat: 40.7001, lng: -74.0001 },
    });
    const district = record({
      id: 'places:district',
      sourceId: 'district',
      name: '緑川堀',
      sourceCategory: 'geographic_entities',
      sourceCategoryPath: ['geographic_entities'],
      coordinates: { lat: 40.7, lng: -74 },
    });
    const evidence = resolveKnowledgeBaseEvidence([waterway, district], kindOf);
    expect(evidence.get('places:district')?.inKnowledgeBase).not.toBe(true);
  });
});
