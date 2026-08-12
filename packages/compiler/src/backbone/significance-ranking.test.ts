import { describe, expect, it } from 'vitest';
import {
  displayNameOf,
  geographicScopeSchema,
  localNameOf,
  type GeographicScope,
  type SourceRecord,
} from '@sidequest/core';
import { assemblePack } from './assemble';
import { buildInventory, foldAdjacentFragments, toCandidate } from './inventory';
import { partitionScope } from './partition';
import { classifySourceCategory } from './taxonomy';

/**
 * THE §8.3 REGRESSION CLASS, PINNED AT THE INVENTORY.
 *
 * The live failure this suite exists for: a metro board where museums and
 * temples lost to pocket parks and named slopes *inside the same pool*,
 * because the ordering function counted recorded attributes — six points for
 * a website, five for an open identifier — and the geographic layers tag
 * micro-features richly while the place catalogue tags monuments sparsely.
 * Ranking now reads significance (kind × established evidence), and each test
 * here is a shape the metadata-count heuristic got backwards.
 *
 * Nothing names a destination. Every fixture is "a kind of thing with a kind
 * of evidence", which is the only vocabulary the engine is allowed to reason
 * in.
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
  return assemblePack({
    id: 'pack-test',
    scope,
    releases: [{ catalog: 'test', releaseId: '2026-01-01.0', resolvedAt: '2026-01-01T00:00:00Z' }],
    partition: partitionScope(scope),
    layers: [
      {
        id: 'places',
        kind: 'primary_places',
        catalog: 'test',
        datasetPath: 'places/place',
        licenceId: 'CDLA-Permissive-2.0',
        records: records.filter((entry) => entry.layerId === 'places'),
        featuresRead: records.length,
        featuresRetained: records.filter((entry) => entry.layerId === 'places').length,
        failedCellIds: [],
      },
      ...(records.some((entry) => entry.layerId === 'land')
        ? [
            {
              id: 'land',
              kind: 'supplemental_geography' as const,
              catalog: 'test',
              datasetPath: 'base/land',
              licenceId: 'ODbL-1.0' as const,
              records: records.filter((entry) => entry.layerId === 'land'),
              featuresRead: records.length,
              featuresRetained: records.filter((entry) => entry.layerId === 'land').length,
              failedCellIds: [],
            },
          ]
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

function inventoryOf(records: SourceRecord[], limits?: Parameters<typeof buildInventory>[0]['limits']) {
  return buildInventory({
    pack: packWith(records),
    scope: scopeFor(),
    ...(limits ? { limits } : {}),
  });
}

describe('significance decides the order, never metadata volume', () => {
  /**
   * The exact inversion the old `knownness()` produced: a pocket park with a
   * website, posted hours, an operator and a bag of attributes against a
   * temple with an open identifier and nothing else filled in.
   */
  const richlyMappedPark = record({
    id: 'land:pocket-park',
    layerId: 'land',
    sourceId: 'pocket-park',
    name: 'Corner Pocket Green',
    sourceCategory: 'park',
    sourceCategoryPath: [],
    planningRole: 'outdoor',
    websiteCandidates: ['https://example.org/parks'],
    attributes: { opening_hours: 'Mo-Su 06:00-22:00', operator: 'Ward Office', surface: 'grass', lit: 'yes' },
    coordinates: { lat: 40.71, lng: -74.01 },
  });
  const sparselyMappedTemple = record({
    id: 'places:temple',
    sourceId: 'temple',
    name: 'Old Hill Temple',
    sourceCategory: 'buddhist_temple',
    sourceCategoryPath: ['attractions_and_activities', 'buddhist_temple'],
    wikidataId: 'Q1234',
    coordinates: { lat: 40.72, lng: -74.02 },
  });

  it('ranks the evidenced temple above the well-described pocket park', () => {
    const inventory = inventoryOf([sparselyMappedTemple, richlyMappedPark]);
    const names = inventory.candidates.map((candidate) => candidate.place.name);
    expect(names.indexOf('Old Hill Temple')).toBeLessThan(names.indexOf('Corner Pocket Green'));
  });

  it('carries the significance on the place, as its own dimension', () => {
    const inventory = inventoryOf([sparselyMappedTemple, richlyMappedPark]);
    const temple = inventory.candidates.find((candidate) => candidate.place.name === 'Old Hill Temple');
    const park = inventory.candidates.find((candidate) => candidate.place.name === 'Corner Pocket Green');
    expect(temple?.place.experienceSignificance).toBeGreaterThan(
      park?.place.experienceSignificance ?? 1,
    );
  });

  it('floors the board: micro-features with no evidence lose their seat to significant kinds', () => {
    /*
     * Ten unevidenced slopes and hills against two museums, with room for six.
     * Under attribute counting the slopes (richly tagged by their layer) took
     * every seat; under significance the museums must hold theirs.
     */
    const micro = Array.from({ length: 10 }, (_, index) =>
      record({
        id: `land:slope-${index}`,
        layerId: 'land',
        sourceId: `slope-${index}`,
        name: `Slope ${index} Rise`,
        sourceCategory: 'hill',
        sourceCategoryPath: [],
        planningRole: 'outdoor',
        attributes: { surface: 'paved', lit: 'yes', incline: 'up' },
        coordinates: { lat: 40.61 + index * 0.01, lng: -74.05 },
      }),
    );
    const museums = ['One', 'Two'].map((suffix, index) =>
      record({
        id: `places:museum-${suffix}`,
        sourceId: `museum-${suffix}`,
        name: `City Museum ${suffix}`,
        coordinates: { lat: 40.7 + index * 0.01, lng: -74.0 },
      }),
    );
    const inventory = inventoryOf([...micro, ...museums], {
      maxAttractions: 6,
      maxPerCategory: 22,
      maxSupport: 5,
      maxGateways: 2,
      maxFoodVenues: 5,
      maxAreaShare: 1,
    });
    const names = inventory.candidates.map((candidate) => candidate.place.name);
    expect(names).toContain('City Museum One');
    expect(names).toContain('City Museum Two');
  });
});

describe('the category is a prior the evidence can overcome', () => {
  /**
   * THE RELEASE BLOCKER, THROUGH THE WHOLE INVENTORY.
   *
   * `categoryWeight` used to multiply the finished score, which makes it a hard
   * ceiling rather than a prior: a kind weighted 0.4 could not exceed 0.4
   * however much the world had said about one particular instance, and a kind
   * weighted 0.85 started above that ceiling with nothing said about it at all.
   * A reviewer measured the consequence on a live board — a major, designated,
   * encyclopaedically documented urban park absent while anonymous galleries
   * held seats.
   *
   * Both records here are real shapes rather than extremes: the park holds
   * three separate statements somebody outside the record made, the museum
   * holds one.
   */
  const documentedPark = record({
    id: 'land:great-park',
    layerId: 'land',
    sourceId: 'great-park',
    name: 'Castle Grounds',
    sourceCategory: 'park',
    sourceCategoryPath: [],
    planningRole: 'outdoor',
    wikidataId: 'Q77',
    attributes: { wikipedia: 'aa:Castle Grounds', leisure: 'nature_reserve' },
    coordinates: { lat: 40.71, lng: -74.01 },
  });
  /** The heavier kind, held by records with a single statement behind them. */
  const barelyEvidencedTrails = Array.from({ length: 6 }, (_, index) =>
    record({
      id: `places:trail-${index}`,
      sourceId: `trail-${index}`,
      name: `Ridge Path ${index}`,
      sourceCategory: 'hiking_trail',
      sourceCategoryPath: ['landmarks_and_outdoors', 'hiking_trail'],
      planningRole: 'outdoor',
      wikidataId: `Q10${index}`,
      coordinates: { lat: 40.62 + index * 0.01, lng: -74.06 },
    }),
  );

  it('scores the well-evidenced modest kind above the barely-evidenced heavier one', () => {
    const inventory = inventoryOf([documentedPark, ...barelyEvidencedTrails]);
    const significanceOf = (name: string) =>
      inventory.candidates.find((candidate) => candidate.place.name === name)!.place
        .experienceSignificance!;
    expect(significanceOf('Castle Grounds')).toBeGreaterThan(significanceOf('Ridge Path 0'));
  });

  it('gives it the seat, where the old ceiling took the seat away', () => {
    /*
     * The consequence, rather than the number. One outdoor quota, seven
     * contenders, room for a couple: under a multiplicative ceiling the park
     * could not exceed 0.4 whatever it carried, so every thinly-evidenced trail
     * outranked it and it left the board — which is the shape of the absence the
     * reviewer measured.
     */
    const inventory = inventoryOf([documentedPark, ...barelyEvidencedTrails], {
      maxAttractions: 4,
      maxPerCategory: 22,
      maxSupport: 5,
      maxGateways: 2,
      maxFoodVenues: 5,
      maxAreaShare: 1,
    });
    const names = inventory.candidates.map((candidate) => candidate.place.name);
    expect(names.length).toBeLessThan(7);
    expect(names).toContain('Castle Grounds');
  });

  it('still lets the kind decide between two records nothing is known about', () => {
    /* The prior has to keep working, or the repair has traded one defect for its mirror. */
    const bareTrail = record({
      ...barelyEvidencedTrails[0]!,
      id: 'places:bare-trail',
      sourceId: 'bare-trail',
      name: 'Quiet Ridge Path',
    });
    delete (bareTrail as { wikidataId?: string }).wikidataId;
    const barePark = record({
      ...documentedPark,
      id: 'land:bare-park',
      sourceId: 'bare-park',
      name: 'Corner Green',
      attributes: {},
    });
    delete (barePark as { wikidataId?: string }).wikidataId;
    const inventory = inventoryOf([barePark, bareTrail]);
    const significanceOf = (name: string) =>
      inventory.candidates.find((candidate) => candidate.place.name === name)!.place
        .experienceSignificance!;
    expect(significanceOf('Quiet Ridge Path')).toBeGreaterThan(significanceOf('Corner Green'));
  });
});

describe('what the standing model is actually shown', () => {
  /**
   * An encyclopaedic *article* is a different statement from an identifier, and
   * the inventory was passing neither. Reading it is what took over the
   * discriminating work the alternate-name count had been doing: on real
   * compiled packs a third of the knowledge-base entries carry no article, and
   * the ones that do are the places somebody sat down and wrote about.
   *
   * Asserted through a gate rather than through a score, because the gate reads
   * `standingOf` — the pack-wide assessment used for ranking and admission —
   * and a channel wired into the emitted place but not into the assessment
   * would leave every gate exactly as blind as before.
   */
  it('admits an evidence-demanding kind on an encyclopaedic article alone', () => {
    const articleOnlyBridge = record({
      id: 'places:bridge-c',
      sourceId: 'bridge-c',
      name: 'Long Water Crossing',
      sourceCategory: 'bridge',
      sourceCategoryPath: [],
      planningRole: 'outdoor',
      attributes: { wikipedia: 'aa:Long Water Crossing' },
      coordinates: { lat: 40.71, lng: -74.03 },
    });
    const namelessBridge = record({
      id: 'places:bridge-d',
      sourceId: 'bridge-d',
      name: 'South Crossing',
      sourceCategory: 'bridge',
      sourceCategoryPath: [],
      planningRole: 'outdoor',
      coordinates: { lat: 40.72, lng: -74.04 },
    });
    const names = inventoryOf([articleOnlyBridge, namelessBridge]).candidates.map(
      (candidate) => candidate.place.name,
    );
    expect(names).toContain('Long Water Crossing');
    expect(names).not.toContain('South Crossing');
  });

  /**
   * A designation is very often recorded one level below the catalogue's own
   * category — a record classified `wood` carrying `leisure=nature_reserve` —
   * and the assessor was only ever shown the category and its path. On real
   * packs that was the single commonest way a designation is stated at all, so
   * the local-significance channel sat silent across whole regions while the
   * evidence for it was in the record.
   */
  it('reads a designation the source recorded as an attribute, not as its category', () => {
    const reserve = record({
      id: 'land:reserve',
      layerId: 'land',
      sourceId: 'reserve',
      name: 'Elm Ridge Woods',
      sourceCategory: 'wood',
      sourceCategoryPath: [],
      planningRole: 'outdoor',
      attributes: { leisure: 'nature_reserve' },
      bounds: {
        southWest: { lat: 40.7, lng: -74.0 },
        northEast: { lat: 40.704, lng: -73.997 },
      },
    });
    const plainWood = record({
      ...reserve,
      id: 'land:plain-wood',
      sourceId: 'plain-wood',
      name: 'Birch Ridge Woods',
      attributes: {},
    });
    const inventory = inventoryOf([reserve, plainWood]);
    const designated = inventory.candidates.find(
      (candidate) => candidate.place.name === 'Elm Ridge Woods',
    );
    expect(designated?.place.localSignificance).toBeGreaterThan(0);
    expect(designated?.place.shortDescription).toContain('protected or heritage designation');
    /* `wood` demands a witness, and the plain one still has none. */
    expect(inventory.candidates.map((candidate) => candidate.place.name)).not.toContain(
      'Birch Ridge Woods',
    );
  });

  it('changes no order and no score when only the name count moves', () => {
    /**
     * The second half of the §8.3 blocker, as a counterfactual rather than a
     * correlation. A count of translated names was made "corroborating only" —
     * unable to open a prominence, still able to raise one — and on a compiled
     * board of a dense city that turned out to be the entire ordering: every
     * distinct prominence was an entry, an entry plus two names, or an entry
     * plus four.
     */
    const records = ['One', 'Two', 'Three'].map((suffix, index) =>
      record({
        id: `places:m-${suffix}`,
        sourceId: `m-${suffix}`,
        name: `Harbour Museum ${suffix}`,
        wikidataId: `Q${index}`,
        coordinates: { lat: 40.7 + index * 0.01, lng: -74.0 },
      }),
    );
    const measure = (names: (index: number) => string[]) =>
      inventoryOf(
        records.map((entry, index) => ({ ...entry, alternateNames: names(index) })),
      ).candidates.map(
        (candidate) => `${candidate.place.id}:${candidate.place.experienceSignificance}`,
      );
    expect(measure(() => [])).toEqual(
      measure((index) => Array.from({ length: index * 4 }, (_, n) => `Alias ${index}-${n}`)),
    );
  });
});

describe('the plausibility gates', () => {
  it('refuses a bridge nothing vouches for, and admits one with identity evidence', () => {
    const anonymousBridge = record({
      id: 'places:bridge-a',
      sourceId: 'bridge-a',
      name: 'North Crossing',
      sourceCategory: 'bridge',
      sourceCategoryPath: [],
      planningRole: 'outdoor',
    });
    const famousBridge = record({
      id: 'places:bridge-b',
      sourceId: 'bridge-b',
      name: 'Great Harbour Bridge',
      sourceCategory: 'bridge',
      sourceCategoryPath: [],
      planningRole: 'outdoor',
      wikidataId: 'Q99',
      coordinates: { lat: 40.71, lng: -74.03 },
    });
    const inventory = inventoryOf([anonymousBridge, famousBridge]);
    const names = inventory.candidates.map((candidate) => candidate.place.name);
    expect(names).toContain('Great Harbour Bridge');
    expect(names).not.toContain('North Crossing');
    expect(
      inventory.portfolio.rejected.find(
        (entry) => entry.reason === 'insufficient_significance_evidence',
      )?.count,
    ).toBe(1);
  });

  it('refuses a cemetery without evidence — a churchyard is not an easy walk', () => {
    const churchyard = record({
      id: 'places:yard',
      sourceId: 'yard',
      name: 'Elm Street Cemetery',
      sourceCategory: 'cemetery',
      sourceCategoryPath: [],
      planningRole: 'attraction',
    });
    const inventory = inventoryOf([churchyard]);
    expect(inventory.candidates).toHaveLength(0);
  });

  it('refuses a point claiming to be a mountain with no extent and no identity', () => {
    /*
     * The famous-distant-name class: a record named after a celebrated peak,
     * at city coordinates, category `peak`, no bounds, no knowledge base. Far
     * more often a restaurant named after the mountain than the mountain.
     */
    const implausiblePeak = record({
      id: 'places:peak',
      sourceId: 'peak',
      name: 'Everholt Summit',
      sourceCategory: 'peak',
      sourceCategoryPath: [],
      planningRole: 'outdoor',
    });
    const realPeak = record({
      id: 'places:real-peak',
      sourceId: 'real-peak',
      name: 'Round Mountain',
      sourceCategory: 'peak',
      sourceCategoryPath: [],
      planningRole: 'outdoor',
      bounds: {
        southWest: { lat: 40.69, lng: -74.05 },
        northEast: { lat: 40.73, lng: -74.0 },
      },
      coordinates: { lat: 40.71, lng: -74.02 },
    });
    const inventory = inventoryOf([implausiblePeak, realPeak]);
    const names = inventory.candidates.map((candidate) => candidate.place.name);
    expect(names).toContain('Round Mountain');
    expect(names).not.toContain('Everholt Summit');
    expect(
      inventory.portfolio.rejected.find((entry) => entry.reason === 'implausible_landscape_claim')
        ?.count,
    ).toBe(1);
  });

  /**
   * A LANDSCAPE CLAIM NEEDS A LANDSCAPE, NOT A POLYGON.
   *
   * The gate above used to read `record.bounds === undefined`, i.e. any outline
   * at all rescued the claim — and a bounding box a metre across is a point
   * with floating-point noise on it. A live metropolitan board carried seven
   * Peaks on that basis: three road slopes and four park mounds, one captioned
   * "A peak. Recorded at 14 m."
   */
  it('refuses a mountain claim whose outline is a metre across', () => {
    const roadSlope = record({
      id: 'land:slope',
      layerId: 'land',
      sourceId: 'slope',
      name: 'Temple Hill Slope',
      sourceCategory: 'peak',
      sourceCategoryPath: [],
      planningRole: 'outdoor',
      /* A real record's degenerate outline: a point, written as a box. */
      bounds: {
        southWest: { lat: 40.7, lng: -74.0 },
        northEast: { lat: 40.700009, lng: -73.999991 },
      },
      attributes: { ele: '14' },
    });
    const inventory = inventoryOf([roadSlope]);
    expect(inventory.candidates.map((candidate) => candidate.place.name)).not.toContain(
      'Temple Hill Slope',
    );
    expect(
      inventory.portfolio.rejected.find((entry) => entry.reason === 'implausible_landscape_claim')
        ?.count,
    ).toBe(1);
  });

  /**
   * THE STRUCTURAL CLAIMS, AND THE CLASS THEY LET ONTO A LIVE BOARD.
   *
   * `historic_site` is an assertion about a building rather than a kind of
   * building, and it is the assertion an open catalogue is least able to check.
   * The eighteen cards that leaf produced on a live metropolitan board were six
   * condominiums, a limited company's office, two roadside information
   * signboards, two road slopes and a demolished campus — each offered as a
   * seventy-five-minute paid attraction. `wood` is the same shape one layer
   * down: a land cover, not a use, and it delivered a cemetery as an easy
   * nature walk while the cemetery leaf's own gate sat unused beside it.
   */
  it('refuses an unwitnessed structural claim and keeps the witnessed one', () => {
    const apartmentBlock = record({
      id: 'places:block',
      sourceId: 'block',
      name: 'Parkview Court House',
      sourceCategory: 'historic_site',
      sourceCategoryPath: ['cultural_and_historic', 'historic_site'],
      planningRole: 'attraction',
    });
    const realSite = record({
      id: 'places:site',
      sourceId: 'site',
      name: 'Old Water Palace',
      sourceCategory: 'historic_site',
      sourceCategoryPath: ['cultural_and_historic', 'historic_site'],
      planningRole: 'attraction',
      wikidataId: 'Q4242',
      coordinates: { lat: 40.71, lng: -74.03 },
    });
    const returnsDesk = record({
      id: 'places:desk',
      sourceId: 'desk',
      name: 'Mall Library Counter',
      sourceCategory: 'library',
      sourceCategoryPath: ['education', 'library'],
      planningRole: 'attraction',
      coordinates: { lat: 40.72, lng: -74.04 },
    });
    const names = inventoryOf([apartmentBlock, realSite, returnsDesk]).candidates.map(
      (candidate) => candidate.place.name,
    );
    expect(names).toContain('Old Water Palace');
    expect(names).not.toContain('Parkview Court House');
    expect(names).not.toContain('Mall Library Counter');
  });

  it('refuses a burial ground the source published as woodland', () => {
    /*
     * The live record, in shape: `class: wood`, a real outline, one alternate
     * name, nothing else. Under the shared `forest` archetype it arrived as
     * `easy_walk` with `easy_nature_walks` stamped on it — §4's "a cemetery as
     * an easy walk", reached by a route that never touched the cemetery leaf.
     */
    const burialGround = record({
      id: 'land:wood',
      layerId: 'land',
      sourceId: 'wood',
      name: 'Old Temple Burial Ground',
      sourceCategory: 'wood',
      sourceCategoryPath: [],
      planningRole: 'outdoor',
      alternateNames: ['Alter Friedhof'],
      bounds: {
        southWest: { lat: 40.7, lng: -74.0 },
        northEast: { lat: 40.704, lng: -73.997 },
      },
    });
    expect(inventoryOf([burialGround]).candidates).toHaveLength(0);
  });

  it('folds a feature inside a paid enclosure into the enclosure', () => {
    const themePark = record({
      id: 'places:park',
      sourceId: 'park',
      name: 'Wondergarden Park',
      sourceCategory: 'theme_park',
      sourceCategoryPath: ['attractions_and_activities', 'theme_park'],
      bounds: {
        southWest: { lat: 40.7, lng: -74.02 },
        northEast: { lat: 40.72, lng: -74.0 },
      },
      coordinates: { lat: 40.71, lng: -74.01 },
    });
    const insideIsland = record({
      id: 'places:island',
      sourceId: 'island',
      name: 'Adventure Island',
      sourceCategory: 'park',
      sourceCategoryPath: [],
      planningRole: 'outdoor',
      coordinates: { lat: 40.71, lng: -74.011 },
    });
    const outsidePark = record({
      id: 'places:free-park',
      sourceId: 'free-park',
      name: 'Riverside Green',
      sourceCategory: 'park',
      sourceCategoryPath: [],
      planningRole: 'outdoor',
      coordinates: { lat: 40.75, lng: -74.06 },
    });
    const inventory = inventoryOf([themePark, insideIsland, outsidePark]);
    const names = inventory.candidates.map((candidate) => candidate.place.name);
    expect(names).toContain('Wondergarden Park');
    expect(names).toContain('Riverside Green');
    expect(names).not.toContain('Adventure Island');
    expect(
      inventory.portfolio.rejected.find((entry) => entry.reason === 'inside_paid_enclosure')?.count,
    ).toBe(1);
  });
});

describe('adjacent fragments of one feature', () => {
  it('folds two same-named adjacent parcels into one candidate', () => {
    const parcelA = record({
      id: 'land:forest-a',
      layerId: 'land',
      sourceId: 'forest-a',
      name: 'Milbrook Nature Forest Reserve Green',
      sourceCategory: 'park',
      sourceCategoryPath: [],
      planningRole: 'outdoor',
      coordinates: { lat: 40.7, lng: -74.0 },
    });
    const parcelB = record({
      id: 'land:forest-b',
      layerId: 'land',
      sourceId: 'forest-b',
      name: 'Milbrook Nature Forest Reserve',
      sourceCategory: 'park',
      sourceCategoryPath: [],
      planningRole: 'outdoor',
      coordinates: { lat: 40.7008, lng: -74.0005 },
    });
    const inventory = inventoryOf([parcelA, parcelB]);
    const matching = inventory.candidates.filter((candidate) =>
      candidate.place.name.startsWith('Milbrook'),
    );
    expect(matching).toHaveLength(1);
  });

  it('does not fold distinct places that merely share a distant name', () => {
    const north = record({
      id: 'land:north',
      layerId: 'land',
      sourceId: 'north',
      name: 'Milbrook Community Garden',
      sourceCategory: 'park',
      sourceCategoryPath: [],
      planningRole: 'outdoor',
      coordinates: { lat: 40.62, lng: -74.08 },
    });
    const south = record({
      id: 'land:south',
      layerId: 'land',
      sourceId: 'south',
      name: 'Milbrook Community Garden',
      sourceCategory: 'park',
      sourceCategoryPath: [],
      planningRole: 'outdoor',
      /* Same name, ten kilometres away: a chain of community gardens. */
      coordinates: { lat: 40.75, lng: -74.0 },
    });
    const folds = foldAdjacentFragments(
      [north, south],
      (entry) => classifySourceCategory({ category: entry.sourceCategory }),
      () => 0.5,
    );
    expect(folds.size).toBe(0);
  });
});

describe('what a compiled card says (names, kinds, hours, durations)', () => {
  const scope = scopeFor();
  const asCandidate = (source: SourceRecord) =>
    toCandidate({
      record: source,
      scope,
      crossLayerCorroborated: false,
      role: 'attraction',
      inclusion: 'inside_scope',
    });

  it('leads with the romanised alternate and keeps the native name beside it', () => {
    const candidate = asCandidate(
      record({
        name: '隅田川',
        alternateNames: ['Sumida River'],
        sourceCategory: 'river',
        sourceCategoryPath: [],
      }),
    );
    expect(candidate.place.name).toBe('Sumida River');
    expect(displayNameOf(candidate.place)).toBe('Sumida River');
    expect(localNameOf(candidate.place)).toBe('隅田川');
    expect(candidate.place.names?.canonical).toBe('隅田川');
  });

  it('captions a river as a river, never as a lake', () => {
    const candidate = asCandidate(
      record({ name: 'Green River', sourceCategory: 'river', sourceCategoryPath: [] }),
    );
    /* The archetype still plans it like a lake; the card must not say so. */
    expect(candidate.place.category).toBe('lake');
    expect(candidate.place.displayKind).toBe('River');
    expect(candidate.place.shortDescription).toContain('river');
    expect(candidate.place.shortDescription).not.toContain('lake');
  });

  it('agrees its articles: "An easy walk", never "A easy walk"', () => {
    const candidate = asCandidate(
      record({ name: 'Willow Path', sourceCategory: 'garden', sourceCategoryPath: [] }),
    );
    expect(candidate.place.shortDescription).toMatch(/^An easy walk/);
    expect(candidate.place.shortDescription).not.toContain('A easy walk');
  });

  it('marks open ground as needing no hours, and gated kinds as gated', () => {
    const river = asCandidate(
      record({ name: 'Green River', sourceCategory: 'river', sourceCategoryPath: [] }),
    );
    const museum = asCandidate(record({}));
    expect(river.place.hoursExpectation).toBe('open_ground');
    expect(museum.place.hoursExpectation).toBe('gated');
  });

  it('marks the archetype duration as an estimate, never a measured fact', () => {
    const candidate = asCandidate(record({}));
    expect(candidate.place.durationBasis).toBe('category_estimate');
  });

  it('says what is interesting when the record holds it, and says so when it does not', () => {
    const designated = asCandidate(
      record({
        name: 'Old Growth Wood',
        sourceCategory: 'nature_reserve',
        sourceCategoryPath: [],
        planningRole: 'outdoor',
      }),
    );
    expect(designated.place.shortDescription).toContain('protected or heritage designation');

    /**
     * NO CARD SHIPS THE BANNED FORM.
     *
     * This assertion used to be `length < 60`, which is the same sentence as
     * "the minimal description is acceptable" — and the minimal description is
     * `"An easy walk."`, one of the four strings §8.7 bans by name. A live
     * board shipped fifty-two of ninety-nine cards in that form. §8.7 also
     * forbids the obvious escape ("do not fabricate flavor"), so what is left
     * is the true thing: this is a name on a map, said plainly, which is a fact
     * the traveller can weigh and the bare noun was not.
     */
    const bare = asCandidate(record({ name: 'Quiet Corner', sourceCategory: 'garden', sourceCategoryPath: [] }));
    expect(bare.place.shortDescription).not.toMatch(/^(A|An) [a-z][a-z '-]*( in [^.]+)?\.$/);
    expect(bare.place.shortDescription).toContain('Nothing beyond its name and position');
    /* And nothing was invented to get there: every clause traces to a field. */
    expect(bare.place.shortDescription).toBe(
      'An easy walk in Testville. Nothing beyond its name and position is published about it.',
    );
  });
});
