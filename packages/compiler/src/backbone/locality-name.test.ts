import { describe, expect, it } from 'vitest';
import { geographicScopeSchema, type GeographicScope, type SourceRecord } from '@sidequest/core';
import { assemblePack } from './assemble';
import { buildInventory } from './inventory';
import { partitionScope } from './partition';

/**
 * §8.6 REACHES THE LINE UNDER THE NAME, TOO.
 *
 * A card's name is resolved English-first. The line beneath it — where the place
 * is — was not: `localityOf` walked neighbourhood → locality → region →
 * destination and took the first entry that existed, whatever script it was in.
 * On a live Tokyo pack that is `世田谷区`, printed under an English heading
 * beside a name the resolution had already worked to make readable, and the
 * reader learns nothing from it at all.
 *
 * §8.6 also says not to *erase* native names, so the repair is a preference and
 * not a filter: the most specific entry the reader can read, and the original
 * answer when nothing in the chain qualifies. Both halves are asserted below,
 * because a fix that simply dropped local-script localities would satisfy the
 * first and break the second.
 */

function scopeFor(destinationName = 'Testville'): GeographicScope {
  return geographicScopeSchema.parse({
    schemaVersion: 1,
    revision: 1,
    destinationCandidateId: 'relation/1',
    destinationName,
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
}

function divisions(): SourceRecord[] {
  const wide = { southWest: { lat: 39.5, lng: -75 }, northEast: { lat: 41.9, lng: -72.9 } };
  return [
    {
      id: 'divisions:country',
      layerId: 'divisions',
      sourceId: 'country',
      name: 'Testland',
      alternateNames: [],
      coordinates: { lat: 40.7, lng: -74 },
      bounds: { southWest: { lat: 30, lng: -85 }, northEast: { lat: 50, lng: -65 } },
      sourceCategory: 'country',
      sourceCategoryPath: [],
      planningRole: 'administrative',
      websiteCandidates: [],
      containment: { countryCode: 'AA', divisionIds: ['div-country'] },
      attributes: { subtype: 'country' },
      sources: [{ dataset: 'divisions', licenceId: 'CDLA-Permissive-2.0' }],
      cellId: 'g-0-0',
    },
    {
      id: 'divisions:testville',
      layerId: 'divisions',
      sourceId: 'testville',
      name: 'Testville',
      alternateNames: [],
      coordinates: { lat: 40.7, lng: -74 },
      bounds: wide,
      sourceCategory: 'locality',
      sourceCategoryPath: [],
      planningRole: 'administrative',
      websiteCandidates: [],
      containment: {
        countryCode: 'AA',
        regionName: 'AA-1',
        localityName: 'Testville',
        divisionIds: ['div-country', 'div-testville'],
      },
      attributes: { subtype: 'locality' },
      sources: [{ dataset: 'divisions', licenceId: 'CDLA-Permissive-2.0' }],
      cellId: 'g-0-0',
    },
  ];
}

function museum(containment: SourceRecord['containment']): SourceRecord {
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
    containment,
    attributes: {},
    sources: [{ dataset: 'primary', licenceId: 'CDLA-Permissive-2.0' }],
    cellId: 'g-0-0',
  };
}

function localityFor(containment: SourceRecord['containment'], destinationName?: string): string {
  const scope = scopeFor(destinationName);
  const pack = assemblePack({
    id: 'pack-locality',
    scope,
    releases: [{ catalog: 'test', releaseId: '2026-01-01.0', resolvedAt: '2026-01-01T00:00:00Z' }],
    partition: partitionScope(scope),
    layers: [
      {
        id: 'divisions',
        kind: 'administrative_divisions',
        catalog: 'test',
        datasetPath: 'divisions/division',
        licenceId: 'CDLA-Permissive-2.0',
        records: divisions(),
        featuresRead: 2,
        featuresRetained: 2,
        failedCellIds: [],
      },
      {
        id: 'places',
        kind: 'primary_places',
        catalog: 'test',
        datasetPath: 'places/place',
        licenceId: 'CDLA-Permissive-2.0',
        records: [museum(containment)],
        featuresRead: 1,
        featuresRetained: 1,
        failedCellIds: [],
      },
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
    now: new Date('2026-01-01T00:00:00Z'),
  });
  const inventory = buildInventory({ pack, scope });
  const candidate = inventory.candidates[0];
  expect(candidate, 'the fixture record was not admitted, so this proves nothing').toBeDefined();
  return candidate!.place.locality;
}

describe('a card says where a place is in a script the reader can read', () => {
  it('skips a local-script neighbourhood for the readable locality behind it', () => {
    const locality = localityFor({
      countryCode: 'AA',
      neighbourhoodName: '世田谷区',
      localityName: 'Testville',
      divisionIds: [],
    });
    expect(locality).toBe('Testville');
  });

  it('still prefers the most specific entry when it is readable', () => {
    /*
     * The negative control: a fix that always fell back to the locality would
     * pass the test above and lose every neighbourhood the reader could read.
     */
    const locality = localityFor({
      countryCode: 'AA',
      neighbourhoodName: 'Harbourside',
      localityName: 'Testville',
      divisionIds: [],
    });
    expect(locality).toBe('Harbourside');
  });

  it('keeps a local-script locality rather than saying nothing', () => {
    /*
     * §8.6 forbids erasing native names. When the whole chain — including the
     * destination the traveller typed — is in one script, the most specific
     * answer stands: it is worse to print nothing than to print 世田谷区.
     */
    const locality = localityFor(
      { countryCode: 'AA', neighbourhoodName: '世田谷区', divisionIds: [] },
      '東京都',
    );
    expect(locality).toBe('世田谷区');
  });
});
