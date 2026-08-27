import { describe, expect, it } from 'vitest';
import {
  composeExperienceSignificance,
  assessPlaceStanding,
  geographicScopeSchema,
  type GeographicScope,
  type SourceRecord,
} from '@sidequest/core';
import { assemblePack } from './assemble';
import { buildInventory } from './inventory';
import { partitionScope } from './partition';
import { classifySourceCategory } from './taxonomy';

/**
 * THE WITNESS-GRADING WAVE, PINNED — four defect classes from the live v8
 * artifacts, each with the shape that failed and the shape that must pass.
 *
 * The measured failure this suite exists for: a dense-metro board whose 24
 * seats held six amusement parks, three zoos and seven neighbourhood parks and
 * not one temple, shrine, museum or market — a local petting zoo composed 0.81
 * while the destination's palace composed 0.46 — because encyclopaedic notice
 * is minted at cataloguing scale for exactly the park family, while the gated
 * canon's pack rows carry only their own official site, which no door read.
 * Beside it: a famous named district refused as `insufficient_travel_value`, a
 * suburban knoll captioned as an established name off the same minted pair,
 * and a glacier tongue carded as a plain day hike because the hazard gate
 * keyed on the leaf while the catalogue filed the ice under a park word.
 *
 * Nothing here names a destination. Every fixture is "a kind of thing with a
 * kind of evidence", which is the only vocabulary the engine may reason in.
 */

function scopeFor(overrides: Partial<GeographicScope> = {}): GeographicScope {
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
      primaryMode: 'drive',
      allowedModes: ['drive', 'walk'],
      carAvailable: true,
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
    ...overrides,
  });
}

function record(overrides: Partial<SourceRecord> = {}): SourceRecord {
  return {
    id: 'places:a',
    layerId: 'places',
    sourceId: 'a',
    name: 'Harbour Museum',
    alternateNames: [],
    coordinates: { lat: 40.7, lng: -74 },
    sourceCategory: 'museum',
    sourceCategoryPath: ['arts_and_entertainment', 'museum'],
    planningRole: 'attraction',
    websiteCandidates: [],
    containment: { countryCode: 'AA', localityName: 'Testville', divisionIds: [] },
    attributes: {},
    sources: [{ dataset: 'primary', licenceId: 'CDLA-Permissive-2.0' }],
    cellId: 'g-0-0',
    ...overrides,
  };
}

function packWith(records: SourceRecord[]) {
  const scope = scopeFor();
  const layerFor = (layerId: string, kind: 'primary_places' | 'supplemental_geography') => ({
    id: layerId,
    kind,
    catalog: 'test',
    datasetPath: `base/${layerId}`,
    licenceId: (layerId === 'places' ? 'CDLA-Permissive-2.0' : 'ODbL-1.0') as
      | 'CDLA-Permissive-2.0'
      | 'ODbL-1.0',
    records: records.filter((entry) => entry.layerId === layerId),
    featuresRead: records.length,
    featuresRetained: records.filter((entry) => entry.layerId === layerId).length,
    failedCellIds: [],
  });
  return assemblePack({
    id: 'pack-test',
    scope,
    releases: [{ catalog: 'test', releaseId: '2026-01-01.0', resolvedAt: '2026-01-01T00:00:00Z' }],
    partition: partitionScope(scope),
    layers: [
      layerFor('places', 'primary_places'),
      ...(records.some((entry) => entry.layerId === 'land')
        ? [layerFor('land', 'supplemental_geography')]
        : []),
    ],
    diagnostics: {
      filesInspected: 1,
      rowGroupsInspected: 1,
      rowGroupsRead: 1,
      bytesTransferred: 1,
      durationMs: 1,
      budgetsExhausted: [],
      layerTimings: [],
    },
    now: new Date('2026-08-11T00:00:00Z'),
  });
}

function inventoryOf(
  records: SourceRecord[],
  limits?: Parameters<typeof buildInventory>[0]['limits'],
) {
  return buildInventory({
    pack: packWith(records),
    scope: scopeFor(),
    ...(limits ? { limits } : {}),
  });
}

function significanceIn(inventory: ReturnType<typeof buildInventory>, name: string): number {
  const found = inventory.candidates.find((candidate) => candidate.place.name === name);
  expect(found, `${name} is not among the candidates`).toBeDefined();
  return found!.place.experienceSignificance!;
}

// ---------------------------------------------------------------------------
// Class 1a — the witness bound's second door: the record's own published site,
// admitted only where the kind has a door somebody opens.
// ---------------------------------------------------------------------------

describe('witness-bounded canon: the published-site door', () => {
  it('opens for a gated kind publishing its own site, and never for one without a door', () => {
    /*
     * The measured pre-fix shape: the gated canon's pack rows carry exactly
     * one attribute — their own official site — and the operational door read
     * only hours and fees, so the bound was a permanent ceiling for every
     * gated worship building and palace in a dense metro while an
     * encyclopaedia-noted crossing composed the same number.
     */
    const standing = assessPlaceStanding({
      groundWitnessCount: 1,
    });
    const withDoor = composeExperienceSignificance({
      standing,
      categoryWeight: 0.6,
      witnessRequired: true,
      expectsVisitors: false,
      publishedSiteAtGate: true,
    });
    const withoutDoor = composeExperienceSignificance({
      standing,
      categoryWeight: 0.6,
      witnessRequired: true,
      expectsVisitors: false,
    });
    expect(withDoor.witnessBounded).toBe(false);
    expect(withoutDoor.witnessBounded).toBe(true);
    expect(withDoor.score).toBeGreaterThan(withoutDoor.score);
  });

  it('ranks the site-publishing worship building above its unattested tie tier', () => {
    /*
     * Five evidence-starved worship buildings in a witness-silent layer, one
     * publishing its own site. Pre-fix the five tied exactly and the degraded
     * seats fell to the id lottery; the site door is what lets the one that
     * operates a door outrank the halls that do not.
     */
    const halls = ['a', 'b', 'c', 'd'].map((suffix, index) =>
      record({
        id: `places:hall-${suffix}`,
        sourceId: `hall-${suffix}`,
        name: `Quarter Hall ${suffix}`,
        sourceCategory: 'place_of_worship',
        sourceCategoryPath: ['cultural_and_historic', 'place_of_worship'],
        coordinates: { lat: 40.62 + index * 0.02, lng: -74.0 },
      }),
    );
    const withSite = record({
      id: 'places:zz-great-sanctuary',
      sourceId: 'zz-great-sanctuary',
      name: 'Great Sanctuary',
      sourceCategory: 'place_of_worship',
      sourceCategoryPath: ['cultural_and_historic', 'place_of_worship'],
      websiteCandidates: ['https://example.org/great-sanctuary'],
      coordinates: { lat: 40.74, lng: -74.0 },
    });
    /*
     * The ground's own member — the sacred tree at the door, the true-pair
     * shape the ground channel documents. It raises the standing the site
     * door then lets speak in full; on the live artifact the destination's
     * famous temple carried exactly this pair (its own tree, its own site)
     * and composed at the bound anyway, because no door read the site.
     */
    const sacredElm = record({
      id: 'places:sanctuary-elm',
      sourceId: 'sanctuary-elm',
      name: 'Great Sanctuary Sacred Elm',
      sourceCategory: 'cafe',
      sourceCategoryPath: ['eat_and_drink', 'cafe'],
      planningRole: 'food',
      coordinates: { lat: 40.7403, lng: -74.0 },
    });
    /* An answering layer elsewhere, so the places layer reads witness-silent. */
    const answering = record({
      id: 'land:answering',
      layerId: 'land',
      sourceId: 'answering',
      name: 'Documented Ridge Reserve',
      sourceCategory: 'nature_reserve',
      sourceCategoryPath: [],
      planningRole: 'outdoor',
      wikidataId: 'Q1',
      coordinates: { lat: 40.79, lng: -73.91 },
    });
    const inventory = inventoryOf([...halls, withSite, sacredElm, answering]);
    const admittedHall = inventory.candidates.find((candidate) =>
      candidate.place.name.startsWith('Quarter Hall'),
    );
    expect(admittedHall).toBeDefined();
    expect(significanceIn(inventory, 'Great Sanctuary')).toBeGreaterThan(
      admittedHall!.place.experienceSignificance!,
    );
  });
});

// ---------------------------------------------------------------------------
// Class 1b — commonplace notice: park-family evidence is bounded unless
// somebody expects the visit, and the bound is stamped on the place.
// ---------------------------------------------------------------------------

describe('commonplace notice: bounded unless somebody expects the visit', () => {
  const parkWith = (
    overrides: Partial<SourceRecord>,
    id = 'land:green',
    name = 'Ninebridge Common',
  ): SourceRecord =>
    record({
      id,
      layerId: 'land',
      sourceId: id.slice(id.indexOf(':') + 1),
      name,
      sourceCategory: 'park',
      sourceCategoryPath: [],
      planningRole: 'outdoor',
      wikidataId: 'Q42',
      attributes: { wikipedia: 'aa:Ninebridge Common', leisure: 'park' },
      coordinates: { lat: 40.71, lng: -74.0 },
      ...overrides,
    });

  it('bounds the article-only park and stamps the bound onto the place', () => {
    /*
     * The measured defect: entry + article is minted for nearly every park
     * polygon in a dense catalogue, so a local petting zoo composed 0.81 and
     * outranked the destination's palace at 0.46 on the strength of a pair
     * every neighbourhood lawn also carries.
     */
    const inventory = inventoryOf([parkWith({})]);
    const seated = inventory.candidates.find(
      (candidate) => candidate.place.name === 'Ninebridge Common',
    )!;
    const composition = composeExperienceSignificance({
      standing: assessPlaceStanding({ inKnowledgeBase: true, encyclopaedicArticle: true }),
      categoryWeight: 0.4,
      commonplaceKind: true,
      expectsVisitors: false,
    });
    expect(composition.witnessBounded).toBe(true);
    /* The stamped field the caption and classics group read. */
    expect(seated.place.significanceBounded).toBe(true);
    /* Bounded: the evidence contributes at most what the kind is worth. */
    expect(composition.evidenceContribution).toBeLessThanOrEqual(composition.kindContribution);
  });

  it('unbounds the park somebody charges admission for', () => {
    const inventory = inventoryOf([
      parkWith({ attributes: { wikipedia: 'aa:Ninebridge Common', leisure: 'park', fee: 'yes' } }),
    ]);
    const seated = inventory.candidates.find(
      (candidate) => candidate.place.name === 'Ninebridge Common',
    )!;
    expect(seated.place.significanceBounded).toBeUndefined();
  });

  it('reads the value under the key: fee=no and 24/7 hours are not a door', () => {
    /*
     * The key test alone read `fee=no` and `opening_hours=24/7` as operational
     * visit evidence — on a live metro pack every riverside lawn carried
     * exactly that pair, and the door was a formality for the whole family.
     */
    const inventory = inventoryOf([
      parkWith({
        attributes: {
          wikipedia: 'aa:Ninebridge Common',
          leisure: 'park',
          fee: 'no',
          opening_hours: '24/7',
        },
      }),
    ]);
    const seated = inventory.candidates.find(
      (candidate) => candidate.place.name === 'Ninebridge Common',
    )!;
    expect(seated.place.significanceBounded).toBe(true);
  });

  it('opens the ground door only for a precinct beyond the boundary, never for own furniture', () => {
    /*
     * The leak this closes: a scattered multi-facility park counted its own
     * point-mapped ballfields — "<park> South End", "<park> Plot 23" — as a
     * precinct, because they stand beyond a point record's member radius. A
     * name that merely extends the park's own name from its first character
     * is the park's signage wherever it stands; a witness that embeds the
     * name mid-way is naming itself by the landmark.
     */
    const furniture = ['South End', 'Fishing Area', 'Plot 23'].map((suffix, index) =>
      record({
        id: `places:furniture-${index}`,
        sourceId: `furniture-${index}`,
        name: `Ninebridge Common ${suffix}`,
        sourceCategory: 'cafe',
        sourceCategoryPath: ['eat_and_drink', 'cafe'],
        planningRole: 'food',
        coordinates: { lat: 40.715 + index * 0.001, lng: -74.0 },
      }),
    );
    const furnished = inventoryOf([parkWith({}), ...furniture]);
    expect(
      furnished.candidates.find((candidate) => candidate.place.name === 'Ninebridge Common')!
        .place.significanceBounded,
    ).toBe(true);

    const precinct = ['Boathouse by Ninebridge Common', 'Cafe at Ninebridge Common', 'The Ninebridge Common Rowing Club'].map(
      (name, index) =>
        record({
          id: `places:precinct-${index}`,
          sourceId: `precinct-${index}`,
          name,
          sourceCategory: 'cafe',
          sourceCategoryPath: ['eat_and_drink', 'cafe'],
          planningRole: 'food',
          coordinates: { lat: 40.715 + index * 0.001, lng: -74.0 },
        }),
    );
    const named = inventoryOf([parkWith({}), ...precinct]);
    expect(
      named.candidates.find((candidate) => candidate.place.name === 'Ninebridge Common')!.place
        .significanceBounded,
    ).toBeUndefined();
  });

  it('lets a paid-enclosure kind stand on its annex tier', () => {
    /*
     * The flagship theme park's pack row carries no hours and no polygon —
     * only a station, hotels and a ticket office wearing its name. Same-named
     * annexes exist only around an operation of standing, so enclosure kinds
     * read the full near tier where open ground reads the beyond-boundary
     * ring; without this door the destination's headline attraction lost its
     * seat to the minor parks that happened to post hours.
     */
    const annexes = ['Grand Pier Funfair Station', 'Grand Pier Funfair Ticket Office', 'Grand Pier Funfair Hotel'].map(
      (name, index) =>
        record({
          id: `places:annex-${index}`,
          sourceId: `annex-${index}`,
          name,
          sourceCategory: 'hotel',
          sourceCategoryPath: ['lodging', 'hotel'],
          planningRole: 'lodging',
          coordinates: { lat: 40.7 + index * 0.001, lng: -73.95 },
        }),
    );
    const funfair = record({
      id: 'places:funfair',
      sourceId: 'funfair',
      name: 'Grand Pier Funfair',
      sourceCategory: 'amusement_park',
      sourceCategoryPath: ['arts_and_entertainment', 'amusement_attraction', 'amusement_park'],
      wikidataId: 'Q77',
      attributes: { wikipedia: 'aa:Grand Pier Funfair' },
      coordinates: { lat: 40.7005, lng: -73.95 },
    });
    const inventory = inventoryOf([funfair, ...annexes]);
    const seated = inventory.candidates.find(
      (candidate) => candidate.place.name === 'Grand Pier Funfair',
    )!;
    expect(seated.place.significanceBounded).toBeUndefined();
  });

  it('keeps the bound a ceiling, not a flattener: the ground-named record still outranks its tie', () => {
    const composed = (established: Parameters<typeof assessPlaceStanding>[0]) =>
      composeExperienceSignificance({
        standing: assessPlaceStanding(established),
        categoryWeight: 0.4,
        commonplaceKind: true,
        expectsVisitors: false,
      });
    const named = composed({
      inKnowledgeBase: true,
      encyclopaedicArticle: true,
      groundWitnessCount: 1,
    });
    const unnamed = composed({ inKnowledgeBase: true, encyclopaedicArticle: true });
    expect(named.witnessBounded).toBe(true);
    expect(unnamed.witnessBounded).toBe(true);
    expect(named.score).toBeGreaterThan(unnamed.score);
  });
});

// ---------------------------------------------------------------------------
// Class 2 — named canonical districts: witness-gated admission with a rank
// that can actually be seated, in the pool a district belongs to.
// ---------------------------------------------------------------------------

describe('named canonical districts: the witness is the gate, and the seat is real', () => {
  const district = record({
    id: 'places:millgate',
    sourceId: 'millgate',
    name: 'Millgate Quarter',
    sourceCategory: 'geographic_entities',
    sourceCategoryPath: ['geographic_entities'],
    coordinates: { lat: 40.7, lng: -74.0 },
  });
  /*
   * The waterway twin: a different layer, the same kind of thing, one trailing
   * character of name — the geographic layer fuses the feature class into the
   * word — carrying the knowledge-base identity the district record attests.
   */
  const waterway = record({
    id: 'land:millgate-canal',
    layerId: 'land',
    sourceId: 'millgate-canal',
    name: 'Millgate Quarters',
    sourceCategory: 'river',
    sourceCategoryPath: [],
    planningRole: 'outdoor',
    wikidataId: 'Q900',
    coordinates: { lat: 40.7003, lng: -74.0004 },
  });

  it('admits the witnessed district at the visitable floor, as an urban place', () => {
    const inventory = inventoryOf([district, waterway]);
    const seated = inventory.candidates.find(
      (candidate) => candidate.place.name === 'Millgate Quarter',
    );
    expect(seated, 'the witnessed district must hold a candidate seat').toBeDefined();
    /*
     * The pre-fix number: the rescue admitted it at the unrecognised
     * fragment's prior and it composed 0.1 — a seat that could never be sat
     * in. The witness converts unrecognised ground into a named place, so it
     * ranks at least at the unweighted-visitable floor's composition.
     */
    expect(seated!.place.experienceSignificance!).toBeGreaterThanOrEqual(0.4);
    /*
     * And it competes as what it is: named ground inside a stated locality is
     * a district, not an easy walk paying a lawn category's saturation.
     */
    expect(seated!.place.category).toBe('town_and_food');
  });

  it('still refuses the same record when nothing vouches for it', () => {
    const inventory = inventoryOf([district]);
    expect(
      inventory.candidates.find((candidate) => candidate.place.name === 'Millgate Quarter'),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Class 4 — hazard aliasing: the gate reads the evidenced ground, not the
// catalogue's filing.
// ---------------------------------------------------------------------------

describe('hazardous approach: the evidenced ground outranks the filing', () => {
  it('marks a park-word filing hazardous when its own attributes say ice or cave', () => {
    expect(
      classifySourceCategory({
        category: 'national_park',
        path: ['sports_and_recreation', 'park', 'national_park'],
        attributes: { natural: 'glacier' },
      }).hazardousAccess,
    ).toBe(true);
    expect(
      classifySourceCategory({
        category: 'hiking_trail',
        path: ['landmarks_and_outdoors', 'hiking_trail'],
        attributes: { natural: 'cave_entrance' },
      }).hazardousAccess,
    ).toBe(true);
    /* Strict protection classes are the same statement from a register. */
    expect(
      classifySourceCategory({
        category: 'nature_reserve',
        path: [],
        attributes: { protect_class: '1a' },
      }).hazardousAccess,
    ).toBe(true);
    /* Evidence only, never inference: an unadorned park stays a park. */
    expect(
      classifySourceCategory({ category: 'national_park', path: [], attributes: {} })
        .hazardousAccess,
    ).toBe(false);
  });

  it('refuses the ice filed under a park word unless somebody expects visitors', () => {
    /*
     * The live shape: a glacier tongue arrived under a tour lister's
     * `national_park` filing and carded as a plain day hike; its own
     * attributes said `natural=glacier` in as many words.
     */
    const tongue = record({
      id: 'places:ice-tongue',
      sourceId: 'ice-tongue',
      name: 'Coldwater Tongue',
      sourceCategory: 'national_park',
      sourceCategoryPath: ['sports_and_recreation', 'park', 'national_park'],
      planningRole: 'outdoor',
      wikidataId: 'Q31',
      attributes: { wikipedia: 'aa:Coldwater Tongue', natural: 'glacier' },
      coordinates: { lat: 40.7, lng: -74.0 },
    });
    const refused = inventoryOf([tongue]);
    expect(
      refused.candidates.find((candidate) => candidate.place.name === 'Coldwater Tongue'),
    ).toBeUndefined();

    /* A managed approach — posted hours — is exactly what the gate asks for. */
    const managed = inventoryOf([
      {
        ...tongue,
        attributes: { ...tongue.attributes, opening_hours: '09:00-17:00' },
      },
    ]);
    expect(
      managed.candidates.find((candidate) => candidate.place.name === 'Coldwater Tongue'),
    ).toBeDefined();
  });

  it('carries the hazard across the collapse to the benign survivor', () => {
    /*
     * The other half of the live shape: the hazard sat on the land twin
     * (`natural=glacier`) while the survivor was the tour lister's filing
     * with no ground attributes at all. The entity is a hazardous approach
     * whichever record won the collapse.
     */
    const survivor = record({
      id: 'places:cold-tongue',
      sourceId: 'cold-tongue',
      name: 'Coldwater Tongue',
      sourceCategory: 'national_park',
      sourceCategoryPath: ['sports_and_recreation', 'park', 'national_park'],
      planningRole: 'outdoor',
      wikidataId: 'Q32',
      attributes: { wikipedia: 'aa:Coldwater Tongue' },
      coordinates: { lat: 40.7, lng: -74.0 },
    });
    const iceTwin = record({
      id: 'land:cold-tongue-ice',
      layerId: 'land',
      sourceId: 'cold-tongue-ice',
      name: 'Coldwater Tongue',
      sourceCategory: 'glacier',
      sourceCategoryPath: [],
      planningRole: 'outdoor',
      attributes: { natural: 'glacier' },
      coordinates: { lat: 40.7001, lng: -74.0001 },
    });
    const inventory = inventoryOf([survivor, iceTwin]);
    expect(
      inventory.candidates.find((candidate) => candidate.place.name === 'Coldwater Tongue'),
      'the hazard must follow the entity through the collapse',
    ).toBeUndefined();
  });

  it('gives a cave entrance a cave face, never a free easy-going hike', () => {
    const cave = classifySourceCategory({ category: 'cave_entrance', path: [] });
    expect(cave.displayKind).toBe('Cave');
    expect(cave.plausiblyGated).toBe(true);
    expect(cave.costLevel).toBeGreaterThan(0);
    expect(cave.hazardousAccess).toBe(true);
  });
});
