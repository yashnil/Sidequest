import { describe, expect, it } from 'vitest';
import type { Trip } from '@sidequest/core';
import type { TripIntentRecord } from '@/lib/db/compiler-repository';
import { carriedFieldsFor, destinationContextFor, screeningSignalsFor } from './screening';

/**
 * The web-side screening reads stored intake state — and only stored state.
 * These cases pin what each source contributes and that an empty intent
 * still yields a usable (traitless) context.
 */

const trip: Trip = {
  id: 't',
  basics: { mode: 'known_destination', destinationInput: 'Wide Republic', regionId: 'dynamic', startDate: '2026-07-01', endDate: '2026-07-12', arrivalTime: '15:00', departureTime: '11:00', adults: 2, children: 1, travelerNeeds: ['kids_under_12'] },
  status: 'draft',
  createdAt: '2026-06-01T00:00:00Z',
  updatedAt: '2026-06-01T00:00:00Z',
};

function intentWith(overrides: Partial<TripIntentRecord>): TripIntentRecord {
  return {
    tripId: 't',
    mode: 'known_destination',
    destinationQuery: 'Wide Republic',
    resolution: null,
    selectedCandidateId: null,
    clarifications: { schemaVersion: 1, questions: [], answers: [] },
    scope: null,
    scopeRevision: 1,
    selectedCompiledRegionId: null,
    discoveryPreferences: null,
    composer: null,
    selectedDestination: null,
    preflight: null,
    ...overrides,
  };
}

describe('screening signals from stored intake state', () => {
  it('with no intent at all, screens to an honest empty context and never throws', () => {
    const context = destinationContextFor({ trip, intent: null, region: null });
    expect(context.traits).not.toContain('dense_urban');
    expect(context.evidence).not.toBe('screened');
    expect(context.tripDays).toBe(12);
    expect(context.traits).toContain('family_logistics_sensitive');
  });

  it('reads entity type, breadth and bounds from the resolver candidate', () => {
    const intent = intentWith({
      resolution: {
        schemaVersion: 1,
        query: 'Wide Republic',
        candidates: [
          {
            id: 'c1',
            displayName: 'Wide Republic',
            qualifiedName: 'Wide Republic',
            entityType: 'country',
            breadth: 'country',
            center: { lat: 39, lng: 35 },
            bounds: { southWest: { lat: 36, lng: 26 }, northEast: { lat: 42, lng: 45 } },
            countryCode: 'WR',
            aliases: [],
            administrativeAreas: [],
            timeZones: [],
            providerRefs: [],
            confidence: { level: 'high', signals: [], note: 'fixture' },
          },
        ],
        unambiguousCandidateId: 'c1',
        ambiguityReasons: [],
        providersConsulted: ['fixture'],
        resolvedAt: '2026-06-01T00:00:00Z',
      } as unknown as TripIntentRecord['resolution'],
    });
    const signals = screeningSignalsFor({ trip, intent, region: null });
    expect(signals.entityType).toBe('country');
    expect(signals.breadth).toBe('country');
    expect(signals.bounds).toBeTruthy();
    const context = destinationContextFor({ trip, intent, region: null });
    expect(context.traits).toContain('broad_geography');
    expect(context.traits).toContain('multi_base_likely');
  });

  it('reads the scope\'s transport assumption, gateways and base changes', () => {
    const intent = intentWith({
      scope: {
        schemaVersion: 1,
        revision: 1,
        destinationCandidateId: 'c1',
        destinationName: 'Outer Isles',
        destinationEntityType: 'archipelago',
        breadth: 'subregion',
        center: { lat: 62, lng: -6.8 },
        boundaryEvidence: 'reach_circle',
        administrative: { hierarchy: [], divisionIds: [], aliases: [] },
        timeZones: ['Atlantic/Faroe'],
        shape: { kind: 'radius', center: { lat: 62, lng: -6.8 }, radiusKm: 80 },
        includedAreas: [],
        excludedAreas: [],
        gateways: [{ id: 'g', name: 'Harbour', kind: 'ferry_port', role: 'both', fixed: false }],
        transport: { primaryMode: 'ferry', allowedModes: ['ferry', 'drive'], carAvailable: null, acceptsWaterOrAirTransfers: true, basis: 'region_evidence', note: 'boats' },
        maxBaseChanges: 2,
        nights: 11,
        rationale: 'fixture',
        confidence: { level: 'high', signals: [], note: 'fixture' },
        decidedBy: [],
        confirmedByUser: true,
      } as unknown as TripIntentRecord['scope'],
    });
    const context = destinationContextFor({ trip, intent, region: null });
    expect(context.traits).toEqual(expect.arrayContaining(['archipelago', 'water_transfer', 'internal_flight_likely']));
    expect(context.basis.water_transfer).toBeTruthy();
  });

  it('carries the composer fields the interview treats as answered', () => {
    expect(carriedFieldsFor(null, ['budgetStyle'])).toEqual(['budgetStyle']);
    const composer = { shape: 'two_bases', foodImportance: 'central', freeTime: 'lots' } as unknown as NonNullable<TripIntentRecord['composer']>;
    expect(carriedFieldsFor(composer, ['pace'])).toEqual(expect.arrayContaining(['pace', 'shape', 'foodImportance', 'freeTime']));
    const undecided = { shape: 'undecided' } as unknown as NonNullable<TripIntentRecord['composer']>;
    expect(carriedFieldsFor(undecided, [])).not.toContain('shape');
  });
});

/**
 * DESTINATION-AWARE INTERVIEW GLOBALITY — the founder's own stored shape.
 *
 * `fixtures/dense-city-pick.json` is a real trip intent recorded on 2026-09-06:
 * a dense city picked from the destination index, with no resolver run, no
 * scope and no preflight. Before this pass the pick reached the screening as
 * a bare name; the index row's population and the pick's feature type now do.
 */
import densePick from './fixtures/dense-city-pick.json';

describe('a composer pick from the destination index', () => {
  const pick = densePick as unknown as { trip: Trip; intent: TripIntentRecord; indexEntry: Parameters<typeof screeningSignalsFor>[0]['indexEntry'] };

  it('reads the feature type and the index row as identity signals', () => {
    const signals = screeningSignalsFor({ trip: pick.trip, intent: pick.intent, region: null, indexEntry: pick.indexEntry });
    expect(signals.entityType).toBe('city');
    expect(signals.breadth).toBe('city');
    expect(signals.featureType).toBe('city');
    expect(signals.population).toBe(7_534_200);
    expect(signals.prominence).toBe(99);
  });

  it('screens as a dense, transit-rich city with a confident transit read — never a car or a driving radius', () => {
    const context = destinationContextFor({ trip: pick.trip, intent: pick.intent, region: null, indexEntry: pick.indexEntry });
    expect(context.traits).toEqual(expect.arrayContaining(['dense_urban', 'transit_rich', 'walk_heavy', 'food_dense']));
    expect(context.traits).not.toContain('road_trip_region');
    expect(context.traits).not.toContain('car_dependent');
    expect(context.assumption).toMatchObject({ movement: 'transit_walk', bases: 'one', confidence: 'high' });
    expect(context.evidence).toBe('screened');
  });

  it('without the index row the feature type still carries the city reading, at lower evidence', () => {
    const context = destinationContextFor({ trip: pick.trip, intent: pick.intent, region: null });
    expect(context.traits).toContain('dense_urban');
    expect(context.assumption?.movement).toBe('transit_walk');
  });

  it('an index row for a different pick is ignored rather than trusted', () => {
    const other = { ...pick.indexEntry!, id: 'overture:somewhere-else' };
    const signals = screeningSignalsFor({ trip: pick.trip, intent: pick.intent, region: null, indexEntry: other });
    expect(signals.population).toBeUndefined();
  });
});
