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
    /*
     * `fee: 'yes'` is load-bearing since the commonplace-notice bound: a park
     * is a kind the catalogue mints entries for at scale, so encyclopaedic
     * notice alone no longer buys a park's seat — somebody charging admission
     * is the operational statement that this one receives visitors, which is
     * exactly what a documented headline park publishes and a lawn does not.
     */
    attributes: { wikipedia: 'aa:Castle Grounds', leisure: 'nature_reserve', fee: 'yes' },
    coordinates: { lat: 40.71, lng: -74.01 },
    /*
     * The ground the reserve status was conferred on, and it is load-bearing
     * since the notice-magnitude gate: the entry and the article a catalogue
     * mints are the same pair it mints for every lawn, so they no longer carry
     * the park past a trail on their own. What separates a headline park from a
     * lawn is that somebody surveyed it and drew its edges at destination scale
     * — which the `land` layer publishes for exactly this kind of record, and
     * publishes for no point feature. Without it the fixture was asserting fame
     * off a record whose only claim to it was that a mapper linked a row.
     */
    bounds: {
      southWest: { lat: 40.705, lng: -74.015 },
      northEast: { lat: 40.72, lng: -74.0 },
    },
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

  /**
   * THE ADMISSION HALF OF THE CATEGORY-WEIGHT PROOF.
   *
   * The three tests above prove the *ordering* half: evidence can outrank a
   * heavier kind. This one proves the half admission owns — that a highly
   * significant instance of the lowest-priority, evidence-demanding kind in
   * the table **survives the admission gates at all** and then competes,
   * while the kind alone can neither buy admission for its unwitnessed
   * instances nor block the witnessed one.
   *
   * `wood` is the table's hardest case on purpose: weight 0.2 — beneath the
   * credibility floor, so its evidence is scaled down — and gated behind
   * `requiresSignificanceEvidence`. If this kind, carrying an encyclopaedic
   * entry, an article and a designation conferred on a real boundary, reaches
   * the shortlist above an unevidenced museum, then no admission gate is
   * reading the category as a verdict.
   *
   * Traveller preferences are deliberately absent here: `buildInventory` runs
   * before any traveller exists, and *that* is the invariant — preferences
   * move ranking downstream at the fit/board layer, never admission.
   */
  it('admits the witnessed instance of the lowest-priority kind and lets it outrank an unwitnessed heavier one', () => {
    const witnessedWood = record({
      id: 'land:sacred-wood',
      layerId: 'land',
      sourceId: 'sacred-wood',
      name: 'Elder Shrine Wood',
      sourceCategory: 'wood',
      sourceCategoryPath: [],
      planningRole: 'outdoor',
      wikidataId: 'Q555',
      attributes: { wikipedia: 'aa:Elder Shrine Wood', leisure: 'nature_reserve' },
      /*
       * Standing-scale ground: a kilometre of drawn boundary, because the
       * designation channel is now graded by the extent it was conferred on —
       * a pocket boundary keeps a voice and no longer certifies the visit.
       */
      bounds: {
        southWest: { lat: 40.7, lng: -74.0 },
        northEast: { lat: 40.71, lng: -73.988 },
      },
      coordinates: { lat: 40.705, lng: -73.994 },
    });
    const unwitnessedWood = record({
      id: 'land:back-lot-trees',
      layerId: 'land',
      sourceId: 'back-lot-trees',
      name: 'Back Lot Trees',
      sourceCategory: 'wood',
      sourceCategoryPath: [],
      planningRole: 'outdoor',
      coordinates: { lat: 40.76, lng: -74.05 },
    });
    const unwitnessedMuseum = record({
      id: 'places:plain-museum',
      sourceId: 'plain-museum',
      name: 'Quayside Museum',
      coordinates: { lat: 40.72, lng: -74.02 },
    });
    const inventory = inventoryOf([witnessedWood, unwitnessedWood, unwitnessedMuseum]);
    const names = inventory.candidates.map((candidate) => candidate.place.name);
    /* Admission: the witness admits the low kind; its absence still refuses. */
    expect(names).toContain('Elder Shrine Wood');
    expect(names).not.toContain('Back Lot Trees');
    /* The ordinary heavier instance keeps its seat — the prior still works. */
    expect(names).toContain('Quayside Museum');
    /* Ordering: what the world established outweighs what the kind implies. */
    const significanceOf = (name: string) =>
      inventory.candidates.find((candidate) => candidate.place.name === name)!.place
        .experienceSignificance!;
    expect(significanceOf('Elder Shrine Wood')).toBeGreaterThan(significanceOf('Quayside Museum'));
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

  /**
   * THE EXEMPTION THAT DEFEATED THE ENCLOSURE FOLD.
   *
   * `enclosureContaining` used to exempt every record whose *kind* is a paid
   * enclosure, so that a park could not fold into itself. But a global
   * catalogue files a big park's individual rides under the park's own kind —
   * a fresh dense-metro pack kept fifteen `amusement_park` records, most of
   * them single rides and a ticket booth inside one park — and the blanket
   * exemption let each compete as a free-standing attraction, filling the
   * category cap the real park then lost seats to. The narrow true statement:
   * an enclosure kind folds into a containing enclosure that is unambiguously
   * the larger ground, and nothing can fold into a metre-wide box.
   */
  it('folds a ride wearing the park’s own kind into the park, and keeps the standalone park', () => {
    const bigPark = record({
      id: 'land:pleasure-gardens',
      layerId: 'land',
      sourceId: 'pleasure-gardens',
      name: 'Harbour Pleasure Gardens',
      sourceCategory: 'theme_park',
      sourceCategoryPath: [],
      bounds: {
        southWest: { lat: 40.7, lng: -74.02 },
        northEast: { lat: 40.708, lng: -74.01 },
      },
      coordinates: { lat: 40.704, lng: -74.015 },
    });
    const ride = record({
      id: 'places:comet',
      sourceId: 'comet',
      name: 'Silver Comet Coaster',
      sourceCategory: 'amusement_park',
      sourceCategoryPath: ['arts_and_entertainment', 'amusement_attraction', 'amusement_park'],
      bounds: {
        southWest: { lat: 40.7041, lng: -74.0151 },
        northEast: { lat: 40.70412, lng: -74.01508 },
      },
      coordinates: { lat: 40.7041, lng: -74.0151 },
    });
    const standalone = record({
      id: 'places:little-wheel',
      sourceId: 'little-wheel',
      name: 'Little Wheel Funfair',
      sourceCategory: 'amusement_park',
      sourceCategoryPath: ['arts_and_entertainment', 'amusement_attraction', 'amusement_park'],
      bounds: {
        southWest: { lat: 40.75, lng: -74.06 },
        northEast: { lat: 40.7512, lng: -74.0585 },
      },
      coordinates: { lat: 40.7506, lng: -74.0592 },
    });
    const inventory = inventoryOf([bigPark, ride, standalone]);
    const names = inventory.candidates.map((candidate) => candidate.place.name);
    expect(names).toContain('Harbour Pleasure Gardens');
    expect(names).toContain('Little Wheel Funfair');
    expect(names).not.toContain('Silver Comet Coaster');
    expect(
      inventory.portfolio.rejected.find((entry) => entry.reason === 'inside_paid_enclosure')
        ?.examples,
    ).toContain('Silver Comet Coaster');
  });

  /**
   * The observation kinds, through the whole inventory.
   *
   * The word a catalogue publishes for an observation deck is `observatory`,
   * under a science branch — and before the leaf existed, the branch rule
   * refused it as `insufficient_travel_value`. A destination's canonical tower
   * publishes under exactly this word, so the kind dying at eligibility means
   * the tower dies the moment acquisition finally delivers it.
   */
  it('keeps an observation deck published under an entertainment branch', () => {
    const deck = record({
      id: 'places:sky-deck',
      sourceId: 'sky-deck',
      name: 'Meridian Sky Deck',
      sourceCategory: 'observatory',
      sourceCategoryPath: ['arts_and_entertainment', 'science_attraction', 'observatory'],
      coordinates: { lat: 40.71, lng: -74.03 },
    });
    const inventory = inventoryOf([deck]);
    expect(inventory.candidates.map((candidate) => candidate.place.name)).toContain(
      'Meridian Sky Deck',
    );
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
        /*
         * The ground the designation was conferred on. Without an outline the
         * status word is only how a catalogue filed the row — the sentence
         * below was printed for a brewery and a park bench on that reading —
         * and the card correctly says so instead. See `hasConferredDesignation`.
         */
        bounds: {
          southWest: { lat: 40.696, lng: -74.004 },
          northEast: { lat: 40.704, lng: -73.996 },
        },
      }),
    );
    expect(designated.place.shortDescription).toContain('protected or heritage designation');

    /**
     * A RECORD WITH NOTHING TO SAY SAYS LESS, AND THE THINNESS IS THE SIGNAL.
     *
     * This asserted the opposite for a while: that the bare noun is §8.7's
     * banned form, so a provenance sentence had to be appended to escape it.
     * The escape was not one. Measured on the three stored journeys of
     * 2026-08-26, 45 of 72 compiled places carried one of the four witness
     * sentences and on every one of them it was the *only* thing said after the
     * noun — the banned form with a clause about our database bolted on, which
     * answers §8.7's question ("what is interesting about this, and why might I
     * care?") no better than the noun did, and which the fit model then spliced
     * into "that is what this delivers: …" as though it were the offer.
     *
     * So the card says the true short thing, and the emptiness becomes a
     * *ranking* signal — which is what §8.7 asks for. The bar below is that
     * bar: under forty characters is under the quality assessor's description
     * mark, so this record no longer buys an evidence mark with a sentence
     * about how little is known.
     */
    const bare = asCandidate(record({ name: 'Quiet Corner', sourceCategory: 'garden', sourceCategoryPath: [] }));
    expect(bare.place.shortDescription).toBe('An easy walk in Testville.');
    expect(bare.place.shortDescription.trim().length).toBeLessThan(40);
    /* And nothing was invented to get there: every clause traces to a field. */
    for (const invented of ['Recorded in', 'Named in the', 'Published by', 'Nothing beyond']) {
      expect(bare.place.shortDescription).not.toContain(invented);
    }
  });

  /**
   * A WITNESS IS A RANKING FACT, NOT A SENTENCE ON A CARD.
   *
   * This used to assert which of four witness sentences a record printed, and
   * the sentences are gone: whichever one was chosen, what reached the
   * traveller was a statement about where our record came from in place of a
   * statement about the place. What the test still has to hold is the half that
   * was never copy — a bare government host attests *the operator*, so it may
   * not raise the ranking field — plus the new bar: no description makes a
   * provenance claim at all, whichever witness spoke.
   */
  it('does not credit the region’s geography for a government URL', () => {
    const operatorPublished = asCandidate(
      record({
        name: 'Riverside Estate',
        sourceCategory: 'park',
        sourceCategoryPath: [],
        websiteCandidates: ['https://www.housing.example.gov/estates/riverside'],
      }),
    );
    /*
     * The *ranking field* stays absent: a bare government host attests the
     * operator, and the operator may not decide significance.
     */
    expect(operatorPublished.place.localSignificance).toBeUndefined();

    const namesake = toCandidate({
      record: record({ name: 'Testville', sourceCategory: 'park', sourceCategoryPath: [] }),
      scope,
      crossLayerCorroborated: false,
      role: 'attraction',
      inclusion: 'inside_scope',
      namedInRegionRecords: true,
    });

    /*
     * Two records whose witnesses differ — an authority page against a region
     * namesake — and neither card says so. The distinction survives where it
     * belongs, in the standing model the fields above are stamped from.
     */
    for (const candidate of [operatorPublished, namesake]) {
      for (const provenance of [
        'published geography',
        'Published by a public authority',
        'Recorded in an open knowledge base',
        'Nothing beyond its name and position',
      ]) {
        expect(candidate.place.shortDescription).not.toContain(provenance);
      }
    }
  });
});

/**
 * THE OPERATOR CHANNEL MAY NOT ORDER SEATS OR OPEN LABEL GATES.
 *
 * `authority_publication` attests the body that runs a place, never the place
 * (`attests: 'its_operator'`). The witness gates have always refused it; the
 * *ordering* still heard it at weight 0.5, and on the live Tokyo pack of
 * 2026-08-13 that one channel lifted 299 of 3,680 place records: a mint's
 * branch office and a ministry's registry row for a memorial stone outranked
 * every unevidenced temple in the city, and the memorial's stamped
 * `localSignificance` then defeated the fit layer's evidence-limited label cap
 * and wore "Top pick for you" on a real traveller's board.
 */
describe('a landlord page on a government domain neither orders seats nor stamps significance', () => {
  const scope = scopeFor();
  const asCandidate = (source: SourceRecord) =>
    toCandidate({
      record: source,
      scope,
      crossLayerCorroborated: false,
      role: 'attraction',
      inclusion: 'inside_scope',
    });

  /** A museum a government runs, published only at its landlord's front door. */
  const landlordPublished = record({
    id: 'places:z-landlord',
    sourceId: 'z-landlord',
    name: 'Ministry Annex Gallery',
    sourceCategory: 'museum',
    websiteCandidates: ['https://www.ministry.example.gov/'],
    coordinates: { lat: 40.71, lng: -74.01 },
  });
  /** The same kind of thing with nothing published about it at all. */
  const unevidenced = record({
    id: 'places:a-unevidenced',
    sourceId: 'a-unevidenced',
    name: 'Quiet Lane Gallery',
    sourceCategory: 'museum',
    coordinates: { lat: 40.72, lng: -74.02 },
  });
  /** The same kind of thing the world has actually vouched for. */
  const evidenced = record({
    id: 'places:m-evidenced',
    sourceId: 'm-evidenced',
    name: 'Old Port Museum',
    sourceCategory: 'museum',
    wikidataId: 'Q555',
    attributes: { wikipedia: 'en:Old Port Museum' },
    coordinates: { lat: 40.73, lng: -74.03 },
  });

  it('orders the seats by what is established about the place, and a landlord page establishes nothing', () => {
    const inventory = inventoryOf([landlordPublished, unevidenced, evidenced]);
    const byId = new Map(inventory.candidates.map((entry) => [entry.place.id, entry.place]));
    const landlord = byId.get('places:z-landlord')!;
    const quiet = byId.get('places:a-unevidenced')!;
    const vouched = byId.get('places:m-evidenced')!;

    /*
     * The operator page moves the ordering score not at all: the government-run
     * gallery and the gallery nobody published rank as the same amount of
     * established nothing, and the place the world vouched for sits above both.
     */
    expect(landlord.experienceSignificance).toBe(quiet.experienceSignificance);
    expect(vouched.experienceSignificance).toBeGreaterThan(landlord.experienceSignificance!);
  });

  it('stamps no significance from a bare operator page, so the evidence-limited label cap holds', () => {
    const candidate = asCandidate(landlordPublished);
    /*
     * These are the exact fields the fit scorer's evidence-limited cap reads to
     * decide whether a top label is reachable. A memorial stone whose one page
     * was a ministry registry row wore "Top pick for you" on a live board
     * because this stamp used to carry the operator channel's 0.5.
     */
    expect(candidate.place.localSignificance).toBeUndefined();
    expect(candidate.place.hiddenGemScore).toBe(0.2);
    /*
     * And the card says nothing about the page. Where a record names its
     * operator the description says so from the `operator` attribute — a fact
     * about the place — never from the host a link happens to sit on.
     */
    expect(candidate.place.shortDescription).not.toContain('Published by a public authority');
  });

  it('keeps the significance of an authority page addressed to the subject — through a romanised alternate too', () => {
    /* The path names the subject: a statement about the place, and it counts. */
    const addressed = asCandidate(
      record({
        name: 'Brooklyn Old Mill',
        sourceCategory: 'museum',
        websiteCandidates: ['https://www.parks.example.gov/things/brooklyn-old-mill.html'],
      }),
    );
    expect(addressed.place.localSignificance).toBeGreaterThan(0);

    /*
     * The primary name is CJK — which the URL test folds to nothing — and the
     * romanised alternate is the name the page carries. The packs this rule
     * matters for are exactly the ones whose primary names no URL can spell.
     */
    const romanised = asCandidate(
      record({
        name: '旧水車場',
        alternateNames: ['Brooklyn Old Mill'],
        sourceCategory: 'museum',
        websiteCandidates: ['https://www.parks.example.gov/things/brooklyn-old-mill.html'],
      }),
    );
    expect(romanised.place.localSignificance).toBeGreaterThan(0);
  });
});

describe('gate evidence is not seat evidence for witness-demanding kinds', () => {
  /**
   * The §4 regression class, pinned where the ranking fields are stamped. On a
   * stored dense-metro compile, six river crossings and a rail overpass — each
   * an infrastructure record carrying an open identifier and an encyclopaedic
   * article, because the mapping convention mints one for nearly every crossing
   * in a dense city — composed 0.66–0.71 as "viewpoints" and outranked the
   * destination's palace and both headline sanctuaries at every cut. The
   * witness rightly admitted them; the same statement then paid the full
   * established share of their rank. Fixtures are kinds of thing with kinds of
   * evidence, never places.
   */
  const articleCrossing = record({
    id: 'land:river-crossing',
    layerId: 'land',
    sourceId: 'river-crossing',
    name: 'Old River Crossing',
    sourceCategory: 'bridge',
    sourceCategoryPath: [],
    planningRole: 'outdoor',
    wikidataId: 'Q9001',
    attributes: { wikipedia: 'aa:Old River Crossing' },
    coordinates: { lat: 40.71, lng: -74.01 },
  });
  const operatedDeck = record({
    id: 'land:harbour-deck',
    layerId: 'land',
    sourceId: 'harbour-deck',
    name: 'Harbour Observation Deck',
    sourceCategory: 'communication_tower',
    sourceCategoryPath: ['communication'],
    planningRole: 'outdoor',
    wikidataId: 'Q9002',
    attributes: {
      wikipedia: 'aa:Harbour Observation Deck',
      fee: 'yes',
      opening_hours: 'Mo-Su 09:00-22:00',
    },
    coordinates: { lat: 40.72, lng: -74.02 },
  });
  const unevidencedRoyalHall = record({
    id: 'places:royal-hall',
    sourceId: 'royal-hall',
    name: 'Old Royal Hall',
    sourceCategory: 'palace',
    sourceCategoryPath: ['cultural_and_historic', 'historic_site', 'palace'],
    coordinates: { lat: 40.73, lng: -74.03 },
  });

  it('admits the witnessed crossing and ranks it as its kind, below the operated deck and never above an unevidenced named building', () => {
    const inventory = inventoryOf([articleCrossing, operatedDeck, unevidencedRoyalHall]);
    const significanceOf = (name: string) =>
      inventory.candidates.find((candidate) => candidate.place.name === name)!.place
        .experienceSignificance!;
    const names = inventory.candidates.map((candidate) => candidate.place.name);

    /* The gate is intact: the witnessed crossing is still a candidate. */
    expect(names).toContain('Old River Crossing');

    /* The bound: article-only credit for a witness-demanding kind stays at
     * the kind's own scale, so the operated deck — same encyclopaedic
     * evidence, plus a ticket and posted hours — ranks strictly above it. */
    expect(significanceOf('Harbour Observation Deck')).toBeGreaterThan(
      significanceOf('Old River Crossing'),
    );

    /* And the crossing can no longer outrank a named building the world has
     * said nothing about — the palace/crossing inversion, exactly. */
    expect(significanceOf('Old Royal Hall')).toBeGreaterThanOrEqual(
      significanceOf('Old River Crossing'),
    );
  });

  it('prices the bare historic assertion below a named worship building when both are witness-silent', () => {
    /**
     * The other half of the same inversion: eleven neighbourhood records filed
     * under the source's bare historic node — a class whose own documentation
     * says mis-tags are the norm — inherited the full historic archetype
     * weight and outranked both sanctuaries. The assertion's prior now sits in
     * the memorial band; a named worship building keeps its own.
     */
    const bareAssertion = record({
      id: 'places:some-block',
      sourceId: 'some-block',
      name: 'Riverside Block',
      sourceCategory: 'historic_site',
      sourceCategoryPath: ['cultural_and_historic', 'historic_site'],
      coordinates: { lat: 40.74, lng: -74.04 },
    });
    const worshipBuilding = record({
      id: 'places:great-sanctuary',
      sourceId: 'great-sanctuary',
      name: 'Great Sanctuary',
      sourceCategory: 'buddhist_place_of_worship',
      sourceCategoryPath: ['cultural_and_historic', 'place_of_worship', 'buddhist_place_of_worship'],
      coordinates: { lat: 40.75, lng: -74.05 },
    });
    /* The crossing makes one layer answer the knowledge-base question, so the
     * places layer's silence is a measured outage and both records reach the
     * degraded admission — exactly the stored pack's shape. */
    const inventory = inventoryOf([articleCrossing, bareAssertion, worshipBuilding]);
    const significanceOf = (name: string) =>
      inventory.candidates.find((candidate) => candidate.place.name === name)?.place
        .experienceSignificance;
    const sanctuary = significanceOf('Great Sanctuary');
    const block = significanceOf('Riverside Block');
    expect(sanctuary).toBeDefined();
    expect(block).toBeDefined();
    expect(sanctuary!).toBeGreaterThan(block!);
  });
});

describe('hydrography asks for a witness and notice alone does not buy its seat', () => {
  /**
   * The §4 class, one layer below the crossings: every named watercourse in a
   * dense hydrography carries a knowledge-base entry and an article, and on
   * live metro boards six canals held seats at a single significance band
   * (~0.68 each) over the destination's witnessed landmarks. Flowing and
   * artificial water is now witness-gated like the bridge, and the witness
   * bound keeps the gate's own key from also paying for the seat.
   */
  it('admits a noted canal, ranks it at its kind, and keeps it below an operated deck', () => {
    const canal = record({
      id: 'land:cut',
      layerId: 'land',
      sourceId: 'cut',
      name: 'Old Mill Cut',
      sourceCategory: 'canal',
      sourceCategoryPath: [],
      planningRole: 'outdoor',
      wikidataId: 'Q88001',
      attributes: { wikipedia: 'aa:Old Mill Cut' },
      coordinates: { lat: 40.71, lng: -74.01 },
    });
    const operatedDeck = record({
      id: 'land:deck',
      layerId: 'land',
      sourceId: 'deck',
      name: 'Harbour Deck',
      sourceCategory: 'observation_deck',
      sourceCategoryPath: [],
      planningRole: 'attraction',
      wikidataId: 'Q88002',
      attributes: { wikipedia: 'aa:Harbour Deck', opening_hours: 'Mo-Su 09:00-21:00', fee: 'yes' },
      coordinates: { lat: 40.72, lng: -74.02 },
    });
    const unwitnessedNamelessCut = record({
      id: 'land:ditch',
      layerId: 'land',
      sourceId: 'ditch',
      name: 'Back Field Drain',
      sourceCategory: 'canal',
      sourceCategoryPath: [],
      planningRole: 'outdoor',
      coordinates: { lat: 40.73, lng: -74.03 },
    });
    const inventory = inventoryOf([canal, operatedDeck, unwitnessedNamelessCut]);
    const names = inventory.candidates.map((candidate) => candidate.place.name);
    /* The witness gate: noted water admits, unnoted water does not. */
    expect(names).toContain('Old Mill Cut');
    expect(names).not.toContain('Back Field Drain');
    const significanceOf = (name: string) =>
      inventory.candidates.find((candidate) => candidate.place.name === name)!.place
        .experienceSignificance!;
    /* The bound: article-only credit stays at the kind's own scale. */
    expect(significanceOf('Old Mill Cut')).toBeLessThanOrEqual(0.35 * 0.3 * 2 + 0.01);
    expect(significanceOf('Harbour Deck')).toBeGreaterThan(significanceOf('Old Mill Cut'));
  });
});

describe('a hazardous approach needs somebody expecting visitors', () => {
  /**
   * A live road-region board stored a highland ice field and a locked lava
   * tube as easy, paved, open-all-year outings: encyclopaedic notice admitted
   * them and the archetype's defaults dressed them. Notice attests the
   * feature; the seat needs evidence that somebody operates the ground for
   * visitors — a fee or posted hours on the record, or a designation over
   * drawn boundaries — which a guided cave publishes and an unstaffed ice
   * field does not.
   */
  const iceField = (overrides: Partial<SourceRecord> = {}) =>
    record({
      id: 'land:icefield',
      layerId: 'land',
      sourceId: 'icefield',
      name: 'High Ice Field',
      sourceCategory: 'glacier',
      sourceCategoryPath: [],
      planningRole: 'outdoor',
      wikidataId: 'Q99001',
      attributes: { wikipedia: 'aa:High Ice Field' },
      bounds: {
        southWest: { lat: 40.7, lng: -74.0 },
        northEast: { lat: 40.73, lng: -73.97 },
      },
      coordinates: { lat: 40.715, lng: -73.985 },
      ...overrides,
    });

  it('refuses the noted-but-unstaffed ice field', () => {
    const inventory = inventoryOf([iceField()]);
    expect(inventory.candidates.map((candidate) => candidate.place.name)).not.toContain(
      'High Ice Field',
    );
    expect(
      inventory.portfolio.rejected.find(
        (entry) => entry.reason === 'insufficient_significance_evidence',
      )?.count,
    ).toBe(1);
  });

  it('admits the same ground once somebody operates it for visitors', () => {
    const operated = iceField({
      attributes: {
        wikipedia: 'aa:High Ice Field',
        opening_hours: 'Mo-Su 09:00-17:00',
        fee: 'yes',
      },
    });
    const inventory = inventoryOf([operated]);
    expect(inventory.candidates.map((candidate) => candidate.place.name)).toContain(
      'High Ice Field',
    );
    /* And the card no longer claims the archetype's free entry beside a fee. */
    const place = inventory.candidates.find((c) => c.place.name === 'High Ice Field')!.place;
    expect(place.costLevel).toBeGreaterThan(0);
    expect(place.estimatedDefaults).not.toContain('cost_level');
    expect(place.estimatedDefaults).toContain('access');
  });
});

describe('a tagged English name reaches the display resolver', () => {
  /**
   * The tag does not survive normalisation as a field, so a normaliser that
   * holds one stashes it under the vocabulary's own attribute key and the
   * inventory threads it into the resolver's brand-spelling tier — where a
   * name the source *tagged* as English outranks a romanised alternate. Only
   * the tagged value is passed: a first alternate is not evidence of English.
   */
  it('prefers the stashed name:en over a romanised alternate', () => {
    const branded = record({
      id: 'places:branded',
      sourceId: 'branded',
      name: '春風湯園',
      alternateNames: ['Harukaze Yuen'],
      sourceCategory: 'museum',
      sourceCategoryPath: ['arts_and_entertainment', 'museum'],
      attributes: { 'name:en': 'Springbreeze Gardens' },
      coordinates: { lat: 40.71, lng: -74.01 },
    });
    const inventory = inventoryOf([branded]);
    const candidate = inventory.candidates.find((entry) => entry.place.id === 'places:branded');
    expect(candidate).toBeDefined();
    expect(candidate!.place.names?.display).toBe('Springbreeze Gardens');
  });
});

describe('a collapse casualty’s ground still absorbs strangers and never its own survivor', () => {
  /**
   * The intersection that deleted a canonical itinerary anchor on a live
   * anti-overfit metro build: the linker says a theme park's gate POI and its
   * own grounds polygon are one entity and elects the POI as survivor; the
   * polygon is superseded; and the paid-enclosure fold then offered the
   * superseded polygon as an absorber, so the survivor was refused
   * `inside_paid_enclosure` against its own corpse and the entity vanished.
   * The first repair barred superseded absorbers entirely — and a ride
   * inside the park then escaped the fold and took a board seat, because the
   * polygon's *ground* is real whether or not its record won the collapse.
   * The rule is component-aware: a superseded enclosure absorbs strangers,
   * never the survivor of its own component.
   */
  it('admits the survivor and still folds the ride inside the grounds', () => {
    const gatePoi = record({
      id: 'places:funland-gate',
      sourceId: 'funland-gate',
      name: 'Funland',
      sourceCategory: 'amusement_park',
      sourceCategoryPath: ['arts_and_entertainment', 'amusement_park'],
      wikidataId: 'Q31001',
      coordinates: { lat: 40.705, lng: -74.005 },
      sources: [
        { dataset: 'primary', licenceId: 'CDLA-Permissive-2.0' },
        { dataset: 'secondary', licenceId: 'CDLA-Permissive-2.0' },
      ],
    });
    const groundsPolygon = record({
      id: 'land:funland-grounds',
      layerId: 'land',
      sourceId: 'funland-grounds',
      name: 'Funland',
      sourceCategory: 'theme_park',
      sourceCategoryPath: [],
      planningRole: 'attraction',
      wikidataId: 'Q31001',
      attributes: { wikipedia: 'aa:Funland' },
      bounds: {
        southWest: { lat: 40.7, lng: -74.01 },
        northEast: { lat: 40.71, lng: -74.0 },
      },
      coordinates: { lat: 40.705, lng: -74.005 },
    });
    const rideInside = record({
      id: 'places:funland-coaster',
      sourceId: 'funland-coaster',
      name: 'Great Coaster',
      sourceCategory: 'amusement_park',
      sourceCategoryPath: ['arts_and_entertainment', 'amusement_park'],
      coordinates: { lat: 40.704, lng: -74.004 },
    });
    const inventory = inventoryOf([gatePoi, groundsPolygon, rideInside]);
    const names = inventory.candidates.map((candidate) => candidate.place.name);
    /* The entity survives its own collapse… */
    expect(names).toContain('Funland');
    /* …and the ride inside the (superseded) grounds is still part of it. */
    expect(names).not.toContain('Great Coaster');
    expect(
      inventory.portfolio.rejected.find((entry) => entry.reason === 'inside_paid_enclosure')
        ?.count,
    ).toBeGreaterThanOrEqual(1);
  });
});

describe('named relief and bare monuments ask for a witness before taking seats', () => {
  it('caps an encyclopaedic-only named rise at its kind', () => {
    const mound = record({
      id: 'land:mound',
      layerId: 'land',
      sourceId: 'mound',
      name: 'Harbour Mound',
      sourceCategory: 'peak',
      sourceCategoryPath: [],
      planningRole: 'outdoor',
      wikidataId: 'Q32001',
      attributes: { wikipedia: 'aa:Harbour Mound' },
      bounds: {
        southWest: { lat: 40.7, lng: -74.0 },
        northEast: { lat: 40.703, lng: -73.997 },
      },
      coordinates: { lat: 40.7015, lng: -73.9985 },
    });
    const inventory = inventoryOf([mound]);
    const candidate = inventory.candidates.find((entry) => entry.place.name === 'Harbour Mound');
    expect(candidate).toBeDefined();
    /* Admitted — the witness gate heard the entry — but notice alone cannot
     * also buy the seat: capped at twice the kind contribution. */
    expect(candidate!.place.experienceSignificance!).toBeLessThanOrEqual(0.5 * 0.3 * 2 + 0.01);
  });

  it('witness-gates the bare monument leaf so roadside stones cannot flood a silent pool', () => {
    const stone = classifySourceCategory({
      category: 'monument',
      path: ['cultural_and_historic', 'monument'],
    });
    expect(stone.requiresSignificanceEvidence).toBe(true);
    /* The built, ticketed monument keeps its price once witnessed. */
    expect(stone.significanceWeight).toBeGreaterThanOrEqual(0.7);
  });
});

/**
 * §8.7 / GROUP H — A DESCRIPTION DESCRIBES THE PLACE, NOT OUR RECORD OF IT.
 *
 * ---
 *
 * **The live evidence class.** The three journeys of 2026-08-26 stored 72
 * compiled places between them. **45** of those carried one of four sentences —
 * "Recorded in an open knowledge base under this name.", "Named in the area's
 * own published geography.", "Published by a public authority as one of the
 * places it runs.", "Nothing beyond its name and position is published about
 * it." — and on **all 45** it was the only thing said after the category noun.
 * So a card read "A museum in <locality>. Recorded in an open knowledge base
 * under this name.": §8.7's banned bare-noun form with a clause about our
 * database attached, answering neither half of the question §8.7 asks a
 * description to answer. The fit model then spliced the whole string into "…
 * and that is what this delivers: …", so the provenance clause was rendered to
 * the traveller as the offer.
 *
 * **What this drives.** `buildInventory` over an assembled pack — the
 * production path that writes `Place.shortDescription`, which is the field the
 * board card, the itinerary stop and the fit sentence all read.
 */
describe('§8.7 — a description says what a place is, or says less', () => {
  /** The four sentences, so the guard cannot be satisfied by rewording one. */
  const PROVENANCE = [
    'Recorded in an open knowledge base',
    'Named in the area',
    'Published by a public authority',
    'Nothing beyond its name and position',
  ];

  it('makes no provenance claim on any record, whatever witness spoke for it', () => {
    const inventory = inventoryOf([
      /* Nothing at all: a name, a point and a category. */
      record({ id: 'places:bare', sourceId: 'bare', name: 'Little Copse', sourceCategory: 'garden', sourceCategoryPath: [] }),
      /* An authority page — the `authority_publication` witness. */
      record({
        id: 'places:authority',
        sourceId: 'authority',
        name: 'Marrowgate Hall',
        websiteCandidates: ['https://www.culture.example.gov/venues/marrowgate-hall'],
      }),
      /* A knowledge-base identifier — the `globalProminence` witness. */
      record({ id: 'places:noted', sourceId: 'noted', name: 'Fernwold Gallery', wikidataId: 'Q10000001' }),
      /* The region's own namesake — the `region_namesake` witness. */
      record({ id: 'places:namesake', sourceId: 'namesake', name: 'Testville', sourceCategory: 'park', sourceCategoryPath: [] }),
    ]);

    expect(inventory.candidates.length).toBeGreaterThan(0);
    for (const candidate of inventory.candidates) {
      for (const clause of PROVENANCE) {
        expect(candidate.place.shortDescription, candidate.place.name).not.toContain(clause);
      }
    }
  });

  it('still states every fact the record actually holds about the place', () => {
    const [described] = inventoryOf([
      record({
        id: 'places:described',
        sourceId: 'described',
        name: 'Marrowgate Water',
        sourceCategory: 'nature_reserve',
        sourceCategoryPath: [],
        attributes: { operator: 'Marrowgate Commons Trust', ele: '410', fee: 'yes' },
        bounds: {
          southWest: { lat: 40.696, lng: -74.004 },
          northEast: { lat: 40.704, lng: -73.996 },
        },
      }),
    ]).candidates;

    const description = described!.place.shortDescription;
    expect(description).toContain('protected or heritage designation');
    expect(description).toContain('Run by Marrowgate Commons Trust.');
    expect(description).toContain('Recorded at 410 m.');
    expect(description).toContain('charge to enter');
    expect(description).toContain('Mapped at roughly');
  });

  /**
   * THE THINNESS IS THE RANKING SIGNAL, WHICH IS WHAT §8.7 ASKS FOR.
   *
   * *"If there is not enough evidence to describe an obscure POI meaningfully,
   * that itself is a ranking/evidence signal."* The signal already exists — the
   * quality assessor counts a description over forty characters as one of its
   * evidence marks — and the removed fallback bought that mark for every record
   * in the catalogue with a sentence saying we knew nothing about it. A record
   * with nothing to say must now fall under the bar rather than clear it.
   */
  it('leaves a record with nothing to say under the evidence bar rather than buying the mark', () => {
    const [bare] = inventoryOf([
      record({ id: 'places:nothing', sourceId: 'nothing', name: 'Little Copse', sourceCategory: 'garden', sourceCategoryPath: [] }),
    ]).candidates;

    expect(bare!.place.shortDescription).toBe('An easy walk in Testville.');
    expect(bare!.place.shortDescription.trim().length).toBeLessThan(40);
  });
});
