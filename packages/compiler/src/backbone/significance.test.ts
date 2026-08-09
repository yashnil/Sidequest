import { describe, expect, it } from 'vitest';
import type { SourceRecord } from '@sidequest/core';
import { geographicScopeSchema } from '@sidequest/core';
import { toCandidate } from './inventory';

/**
 * WHAT MAKES A PLACE WORTH RANKING ABOVE ANOTHER.
 *
 * `popularityScore` was computed from how many fields a source had filled in.
 * That reads as reasonable and is exactly backwards for the commonest case in
 * open data: a franchise fills in its website, its operator and its opening
 * hours because that is what a franchise does, while a significant temple that
 * nobody has tagged carries a name and a point. The board ranked the café above
 * the temple, and the "hidden gem" score — being one minus popularity — then
 * called the temple the find.
 *
 * The contrasting records below are the whole argument.
 */

const SCOPE = geographicScopeSchema.parse({
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
});

/** The place a record becomes, with the scoring this file is about. */
function toPlaceForTest(entry: SourceRecord) {
  return toCandidate({
    record: entry,
    scope: SCOPE,
    crossLayerCorroborated: false,
    role: entry.planningRole === 'food' ? 'food' : 'attraction',
    inclusion: 'inside_scope',
  }).place;
}

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

/** Everything a chain fills in as a matter of course, and nothing else. */
const METADATA_RICH_CHAIN = record({
  id: 'places:chain',
  name: 'Chain Coffee, Third Street',
  sourceCategory: 'cafe',
  sourceCategoryPath: ['eat_and_drink', 'cafe'],
  planningRole: 'food',
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

/** Named in three languages, in an encyclopaedia, and tagged by nobody. */
const SIGNIFICANT_SPARSE = record({
  id: 'places:shrine',
  name: 'Old Shrine',
  alternateNames: ['旧神社', 'Ancien sanctuaire'],
  sourceCategory: 'temple',
  sourceCategoryPath: ['religious', 'temple'],
  wikidataId: 'Q12345',
});

/** Neither noted nor catalogued: the genuine quiet find. */
const QUIET_FIND = record({
  id: 'places:quiet',
  name: 'Little Stone Garden',
  sourceCategory: 'garden',
  sourceCategoryPath: ['landmarks_and_outdoors', 'garden'],
});

/** Noted everywhere, and thoroughly catalogued too. */
const FAMOUS_ANCHOR = record({
  id: 'places:famous',
  name: 'Great Museum',
  alternateNames: ['Grand Musée', '大博物館'],
  wikidataId: 'Q999',
  websiteCandidates: ['https://example.test/museum'],
  attributes: { opening_hours: 'Tu-Su 10:00-18:00', operator: 'City' },
  sources: [
    { dataset: 'primary', licenceId: 'CDLA-Permissive-2.0' },
    { dataset: 'osm', licenceId: 'ODbL-1.0' },
  ],
});

describe('significance is not the same as metadata completeness', () => {
  it('does not rank a metadata-rich chain above a sparsely tagged significant place', () => {
    const chain = toPlaceForTest(METADATA_RICH_CHAIN);
    const shrine = toPlaceForTest(SIGNIFICANT_SPARSE);
    expect(shrine.popularityScore).toBeGreaterThan(chain.popularityScore);
  });

  it('gives the well-catalogued chain no more note than an untagged garden', () => {
    /**
     * The sharpest form of the property: six filled-in attributes and a website
     * must buy exactly nothing, because a business listing its own hours is not
     * evidence that anybody cares about it.
     */
    const chain = toPlaceForTest(METADATA_RICH_CHAIN);
    const quiet = toPlaceForTest(QUIET_FIND);
    expect(chain.popularityScore).toBe(quiet.popularityScore);
  });

  it('ranks the famous anchor highest of all', () => {
    const famous = toPlaceForTest(FAMOUS_ANCHOR);
    for (const other of [METADATA_RICH_CHAIN, SIGNIFICANT_SPARSE, QUIET_FIND]) {
      expect(famous.popularityScore).toBeGreaterThanOrEqual(toPlaceForTest(other).popularityScore);
    }
  });

  it('calls the untagged, unnoted garden a better hidden gem than the famous museum', () => {
    expect(toPlaceForTest(QUIET_FIND).hiddenGemScore).toBeGreaterThan(
      toPlaceForTest(FAMOUS_ANCHOR).hiddenGemScore,
    );
  });

  it('never turns a source’s own listing effort into a hidden-gem penalty', () => {
    /**
     * The inverse of the first defect, and it would have been the next one: if
     * completeness fed popularity, then a well-documented quiet place would stop
     * counting as a find the moment somebody tagged it properly.
     */
    const tagged = toPlaceForTest(
      record({ ...QUIET_FIND, attributes: { opening_hours: 'Mo-Su 09:00-17:00', operator: 'Parks' } }),
    );
    expect(tagged.hiddenGemScore).toBe(toPlaceForTest(QUIET_FIND).hiddenGemScore);
  });
});
