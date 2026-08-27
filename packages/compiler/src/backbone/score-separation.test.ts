import { describe, expect, it } from 'vitest';
import { geographicScopeSchema, type GeographicScope, type SourceRecord } from '@sidequest/core';
import { buildInventory, toCandidate } from './inventory';
import { syntheticPack } from '../testing/pack-fakes';
import { SYNTHETIC_WORLDS } from '../testing/fakes';

/**
 * FOUR SCORES THAT USED TO BE ONE NUMBER, AND ARE NOW ALLOWED TO DISAGREE.
 *
 * The defect these tests were written against, in the shape the audit found it:
 *
 * - `popularity` came from metadata richness — a Wikidata id, names in two
 *   languages, a second catalogue — and in the live fallback from `tagCount / 5`
 * - `hiddenGemScore = 1 − popularity`, an affine inverse
 * - `crowdLevel = popularity > 0.7`, a threshold on the same figure
 * - `source.confidence = 0.7`, a constant
 *
 * The consequence is the one the board makes visible: "must-see classics" and
 * "personalised hidden gems" were the top and the bottom of a single metadata
 * count, so no place could ever be in the wrong one, and no place could ever
 * surprise you by being in both halves' worth of evidence.
 *
 * The suite that existed could not tell the old behaviour from the new, because
 * every assertion in it was about the *ordering* of one number and one number
 * still exists. What follows is about the parts that only the separated model
 * can express.
 */

const SCOPE_BASE = {
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
};

const SCOPE: GeographicScope = geographicScopeSchema.parse(SCOPE_BASE);

function record(overrides: Partial<SourceRecord>): SourceRecord {
  return {
    id: 'places:x',
    layerId: 'places',
    sourceId: 'x',
    name: 'Somewhere',
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

function placeFrom(entry: SourceRecord, options: { crossLayerCorroborated?: boolean } = {}) {
  return toCandidate({
    record: entry,
    scope: SCOPE,
    crossLayerCorroborated: options.crossLayerCorroborated ?? false,
    role: 'attraction',
    inclusion: 'inside_scope',
  }).place;
}

/**
 * The threshold the product itself uses for "this is a hidden gem".
 *
 * `discovery/board.ts` routes a candidate into the hidden-gems group at
 * `hiddenGemScore >= 0.6`, and `BoardFilters` filters on the same number. Stated
 * here so these tests assert the outcome a traveller sees rather than an
 * internal ordering.
 */
const HIDDEN_GEM_THRESHOLD = 0.6;

/** `discovery/board.ts` calls a place a must-see classic at this prominence. */
const CLASSICS_THRESHOLD = 0.7;

// ---------------------------------------------------------------------------
// 1. A hidden gem and a blank record are not the same thing
// ---------------------------------------------------------------------------

/**
 * Designated by an authority, and in no encyclopaedia: locally significant,
 * globally unnoticed. The definition of the thing the board is looking for.
 *
 * The outline is not decoration. A designation is a boundary somebody drew, and
 * `hasConferredDesignation` requires one — because the status word alone is a
 * category, and on two live packs the same word was carried by a brewery, an
 * anime shop and a bench. A kilometre and a half of traced ground is what
 * makes this fixture a reserve rather than a row filed under the reserve
 * heading — standing scale, since the designation channel is graded by the
 * extent it was conferred on and a pocket boundary no longer speaks at the
 * full designation weight.
 */
const LOCALLY_DESIGNATED = record({
  id: 'places:reserve',
  name: 'Back Valley Nature Reserve',
  sourceCategory: 'nature_reserve',
  sourceCategoryPath: ['geographic_entities', 'protected_area', 'nature_reserve'],
  bounds: {
    southWest: { lat: 40.696, lng: -74.005 },
    northEast: { lat: 40.71, lng: -73.995 },
  },
});

/** A name and a coordinate. Nobody has published anything about it, anywhere. */
const NO_EVIDENCE_AT_ALL = record({
  id: 'places:blank',
  name: 'Little Stone Garden',
  sourceCategory: 'garden',
  sourceCategoryPath: ['landmarks_and_outdoors', 'garden'],
});

describe('a hidden gem is not the same as a record nobody has written about', () => {
  it('calls the locally designated, globally unnoticed place a hidden gem', () => {
    const place = placeFrom(LOCALLY_DESIGNATED);
    expect(place.localSignificance).toBeGreaterThan(0);
    expect(place.globalProminence).toBeUndefined();
    expect(place.hiddenGemScore).toBeGreaterThanOrEqual(HIDDEN_GEM_THRESHOLD);
  });

  it('does not call a record with no evidence at all a hidden gem', () => {
    /**
     * Under `hiddenGemScore = 1 − popularity` both of these scored **0.75** and
     * both went into the hidden-gems group — the designated reserve because it
     * was untagged, and the blank record for exactly the same reason. Emptiness
     * was the qualification.
     */
    const blank = placeFrom(NO_EVIDENCE_AT_ALL);
    expect(blank.hiddenGemScore).toBeLessThan(HIDDEN_GEM_THRESHOLD);
    // And the absence is legible rather than encoded as a low number: nothing
    // established hiddenness here, so the field is not there.
    expect(blank.hiddenness).toBeUndefined();
    expect(blank.localSignificance).toBeUndefined();
  });

  it('separates the two, where the old model made them identical', () => {
    expect(placeFrom(LOCALLY_DESIGNATED).hiddenGemScore).toBeGreaterThan(
      placeFrom(NO_EVIDENCE_AT_ALL).hiddenGemScore,
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Prominence and hiddenness are two variables
// ---------------------------------------------------------------------------

/** Pearson's r. −1 is the affine inverse the old pair of scores always was. */
function correlation(pairs: readonly [number, number][]): number {
  const n = pairs.length;
  const meanX = pairs.reduce((sum, [x]) => sum + x, 0) / n;
  const meanY = pairs.reduce((sum, [, y]) => sum + y, 0) / n;
  let covariance = 0;
  let varianceX = 0;
  let varianceY = 0;
  for (const [x, y] of pairs) {
    covariance += (x - meanX) * (y - meanY);
    varianceX += (x - meanX) ** 2;
    varianceY += (y - meanY) ** 2;
  }
  return covariance / Math.sqrt(varianceX * varianceY);
}

describe('prominence and hiddenness are genuinely two variables', () => {
  /**
   * The world loaded here is `broad_country` — "Wide Republic", forty places —
   * named explicitly because which world it is decides what the assertion means.
   * Its pack rotates eight source categories, so one place in eight is a
   * `nature_reserve` inside a `protected_area` path, and puts a Wikidata id on
   * every fifth. Those two cycles are coprime, so the pack contains all four
   * combinations: designated and catalogued, designated and unknown, catalogued
   * and undesignated, and neither.
   */
  const spec = SYNTHETIC_WORLDS.broad_country!;

  it('loaded the world it says it loaded', () => {
    expect(spec.id).toBe('broad-country');
    expect(spec.name).toBe('Wide Republic');
    expect(spec.placeCount).toBe(40);
  });

  it('does not derive one from the other across a compiled world', () => {
    const scope = geographicScopeSchema.parse({
      ...SCOPE_BASE,
      destinationName: spec.name,
      center: spec.center,
      bounds: {
        southWest: { lat: spec.center.lat - 2, lng: spec.center.lng - 2 },
        northEast: { lat: spec.center.lat + 2, lng: spec.center.lng + 2 },
      },
      shape: {
        kind: 'bounds',
        bounds: {
          southWest: { lat: spec.center.lat - 2, lng: spec.center.lng - 2 },
          northEast: { lat: spec.center.lat + 2, lng: spec.center.lng + 2 },
        },
      },
    });
    const inventory = buildInventory({ pack: syntheticPack(spec, scope), scope });
    const places = inventory.candidates.map((candidate) => candidate.place);
    expect(places.length).toBeGreaterThan(10);

    /**
     * The two fields the product actually reads. Under the old derivation this
     * correlation was **exactly −1** for every possible world, because the second
     * field was `0.9 − ` the first; there was no data that could have produced
     * anything else.
     */
    const r = correlation(
      places.map((place) => [place.popularityScore, place.hiddenGemScore] as [number, number]),
    );
    // Measured at −0.56 over this world, against a structural −1.0 before.
    expect(r).toBeGreaterThan(-0.9);

    /**
     * And the case that inverse made unreachable: a place the wider world has
     * noted which is *still* more significant locally than that note accounts
     * for. One such place is enough — under `1 − popularity` there could never
     * be one, at any threshold.
     */
    const both = places.filter(
      (place) => place.globalProminence !== undefined && (place.hiddenness ?? 0) > 0,
    );
    expect(both.length).toBeGreaterThan(0);

    // The channels are separately populated rather than one being a view of the
    // other: some places have prominence and no local evidence, some the reverse.
    expect(
      places.some(
        (place) => place.globalProminence !== undefined && place.localSignificance === undefined,
      ),
    ).toBe(true);
    expect(
      places.some(
        (place) => place.localSignificance !== undefined && place.globalProminence === undefined,
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Metadata richness is not importance
// ---------------------------------------------------------------------------

/** Everything a franchise fills in as a matter of course, and nothing else. */
const METADATA_RICH_CHAIN = record({
  id: 'places:chain',
  name: 'Chain Coffee, Third Street',
  sourceCategory: 'cafe',
  sourceCategoryPath: ['eat_and_drink', 'cafe'],
  websiteCandidates: ['https://example.test/chain'],
  attributes: {
    opening_hours: 'Mo-Su 07:00-19:00',
    operator: 'Chain Coffee Ltd',
    brand: 'Chain Coffee',
    phone: '+1 555 0100',
    wheelchair: 'yes',
    takeaway: 'yes',
  },
});

describe('metadata richness never promotes a place', () => {
  it('cannot lift a thoroughly tagged record into the must-see classics', () => {
    /**
     * The original formula gave this record 3 of 6 on attribute count alone,
     * before anybody looked at what it was. It is a coffee shop.
     */
    const chain = placeFrom(METADATA_RICH_CHAIN);
    expect(chain.popularityScore).toBeLessThan(CLASSICS_THRESHOLD);
    expect(chain.globalProminence).toBeUndefined();
  });

  it('gives six filled-in attributes exactly the same prominence as none', () => {
    const chain = placeFrom(METADATA_RICH_CHAIN);
    const blank = placeFrom(NO_EVIDENCE_AT_ALL);
    expect(chain.popularityScore).toBe(blank.popularityScore);
    expect(chain.hiddenGemScore).toBe(blank.hiddenGemScore);
  });

  it('does not let tagging a quiet place turn it into a busy one', () => {
    // `crowdLevel` was `popularity > 0.7`, so describing a place more fully was
    // once the only way it could become crowded.
    expect(placeFrom(METADATA_RICH_CHAIN).crowdExpectation).toBeUndefined();
    expect(placeFrom(NO_EVIDENCE_AT_ALL).crowdExpectation).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 4. Source confidence is computed
// ---------------------------------------------------------------------------

describe('source confidence moves with the evidence', () => {
  it('is not the constant 0.7 it used to be', () => {
    const bare = placeFrom(NO_EVIDENCE_AT_ALL);
    const described = placeFrom(METADATA_RICH_CHAIN);
    const corroborated = placeFrom(METADATA_RICH_CHAIN, { crossLayerCorroborated: true });

    expect(bare.source.confidence).toBeLessThan(described.source.confidence);
    expect(described.source.confidence).toBeLessThan(corroborated.source.confidence);
    expect(new Set([bare, described, corroborated].map((place) => place.source.confidence)).size).toBe(3);
  });

  it('is the one place attribute count is allowed to matter', () => {
    /**
     * Richness is real and useful — it is why the hours are known and the site is
     * linkable — and this is its only consumer. It reaches no ranking score, and
     * a place that is thoroughly described stays exactly as prominent, as hidden
     * and as crowded as it was.
     */
    const described = placeFrom(METADATA_RICH_CHAIN);
    const blank = placeFrom(NO_EVIDENCE_AT_ALL);
    expect(described.evidenceRichness).toBeGreaterThan(blank.evidenceRichness ?? 0);
    expect(described.popularityScore).toBe(blank.popularityScore);
    expect(described.hiddenGemScore).toBe(blank.hiddenGemScore);
    expect(described.crowdLevel).toBe(blank.crowdLevel);
  });
});
