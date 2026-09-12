import { describe, expect, it } from 'vitest';
import { decideInterpretation, diagonalKm, screenDestination, type DestinationSemantics, type GeographicSemanticType } from '@sidequest/core';
import { resolveDestinationPhrase } from './intent-resolution';
import { fixtureInterpreter } from './interpretation';
import { recordedResolver } from './fixtures/recorded-resolver';
import { screeningSignalsFor } from '../interview/screening';
import type { TripIntentRecord } from '../db/compiler-repository';
import type { Trip } from '@sidequest/core';

/**
 * V8.1 — THE REGRESSION CORPUS: REAL GEOCODER ROWS, THE GATE, THE INTERVIEW.
 *
 * Every phrase below is resolved exactly as the two production doors resolve
 * it, against the public geocoder's recorded answers of 2026-09-11
 * (`fixtures/nominatim/`) and the recorded interpreter (`fixtures/
 * interpretations.json`), and then screened for the interview. What is
 * asserted, for each: the traveller's words survive as the label; whatever
 * was accepted is semantically compatible with them; the extent is sensible
 * for the kind of thing; no unrelated locality stood in for a region; and the
 * questionnaire traits fit the kind of trip.
 *
 * "the Canadian Rockies" is the production defect: it must never resolve to
 * central Calgary or to any business, road or neighbourhood. Calgary may
 * appear only as a gateway.
 */

const NOW = new Date('2026-09-11T12:00:00Z');

interface Expectation {
  type: GeographicSemanticType | GeographicSemanticType[];
  /** Corner-to-corner kilometres the extent must fall inside, when an extent is expected. */
  extentKm?: [number, number];
  countries?: string[];
  /** Words that must never appear in the accepted label or the accepted row. */
  never: RegExp;
  traits: { has: string[]; lacks: string[] };
  /** Whether the interpreter should have been consulted. */
  interpreted: boolean;
}

const CORPUS: Record<string, Expectation> = {
  'the Canadian Rockies': { type: 'mountain_region', extentKm: [150, 1400], countries: ['CA'], never: /calgary|avenue|resort|airport|school|rafting|chalet/i, traits: { has: ['mountain', 'weather_exposed'], lacks: ['dense_urban', 'transit_rich', 'walk_heavy'] }, interpreted: true },
  Patagonia: { type: ['informal_region', 'natural_region'], extentKm: [800, 3500], countries: ['AR', 'CL'], never: /arizona|colombia|bahía blanca|río gallegos|santa cruz county/i, traits: { has: ['road_trip_region'], lacks: ['dense_urban'] }, interpreted: true },
  'the Scottish Highlands': { type: 'mountain_region', extentKm: [100, 600], countries: ['GB'], never: /tennessee|wisconsin|hendersonville/i, traits: { has: ['mountain', 'weather_exposed'], lacks: ['dense_urban'] }, interpreted: true },
  'the Alps': { type: 'mountain_region', extentKm: [700, 1400], never: /auvergne/i, traits: { has: ['mountain', 'weather_exposed'], lacks: ['dense_urban'] }, interpreted: false },
  'the Dolomites': { type: 'mountain_region', extentKm: [100, 400], countries: ['IT'], never: /veneto region only/i, traits: { has: ['mountain'], lacks: ['dense_urban'] }, interpreted: false },
  'the Lake District': { type: 'natural_region', extentKm: [60, 200], countries: ['GB'], never: /edmonton|alberta/i, traits: { has: ['weather_exposed'], lacks: ['dense_urban'] }, interpreted: false },
  'the Amalfi Coast': { type: 'coast', extentKm: [15, 120], countries: ['IT'], never: /broken hill|australia|new south wales/i, traits: { has: ['beach', 'weather_exposed'], lacks: ['dense_urban'] }, interpreted: true },
  'the Sahara': { type: 'natural_region', extentKm: [1500, 6000], never: /new york/i, traits: { has: ['wilderness', 'remote', 'broad_geography'], lacks: ['dense_urban'] }, interpreted: true },
  'the Pacific Northwest': { type: 'informal_region', extentKm: [200, 1200], countries: ['US', 'CA'], never: /san diego|pacific beach|residential/i, traits: { has: ['road_trip_region'], lacks: ['dense_urban'] }, interpreted: true },
  'the Okavango Delta': { type: 'natural_region', extentKm: [150, 400], countries: ['BW'], never: /gaborone/i, traits: { has: ['wilderness', 'remote', 'weather_exposed'], lacks: ['dense_urban'] }, interpreted: false },
  'rural Japan': { type: 'informal_region', countries: ['JP'], never: /tokyo/i, traits: { has: [], lacks: ['dense_urban'] }, interpreted: false },
  'Kenya and Tanzania': { type: 'multi_country', extentKm: [1500, 2500], countries: ['KE', 'TZ'], never: /nairobi as the destination/i, traits: { has: ['cross_border', 'multi_area'], lacks: ['dense_urban'] }, interpreted: false },
  Chongqing: { type: 'city_region', extentKm: [300, 700], countries: ['CN'], never: /chongqing road/i, traits: { has: ['city_region'], lacks: ['mountain', 'wilderness'] }, interpreted: false },
  'New York City': { type: 'settlement', extentKm: [30, 90], countries: ['US'], never: /new york state only/i, traits: { has: ['dense_urban', 'walk_heavy'], lacks: ['mountain', 'road_trip_region', 'wilderness'] }, interpreted: false },
};

function tripFor(destination: string): Trip {
  return {
    id: 'trip-corpus',
    basics: { destinationInput: destination, mode: 'known_destination', regionId: 'dynamic', startDate: '2027-07-10', endDate: '2027-07-18', arrivalTime: '15:00', departureTime: '11:00', adults: 2, children: 0, travelerNeeds: [], timingLock: null },
    status: 'draft',
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  } as unknown as Trip;
}

function intentFor(destination: string, resolution: Awaited<ReturnType<typeof resolveDestinationPhrase>>['resolution'], semantics: DestinationSemantics, graph: Awaited<ReturnType<typeof resolveDestinationPhrase>>['outcome']['graph']): TripIntentRecord {
  return {
    tripId: 'trip-corpus',
    mode: 'known_destination',
    destinationQuery: destination,
    resolution,
    selectedCandidateId: resolution.unambiguousCandidateId ?? null,
    clarifications: { schemaVersion: 1, questions: [], answers: [] } as unknown as TripIntentRecord['clarifications'],
    scope: null,
    scopeRevision: 0,
    selectedCompiledRegionId: null,
    discoveryPreferences: null,
    composer: null,
    selectedDestination: null,
    preflight: null,
    destinationIntent: {
      schemaVersion: 1,
      rawText: destination,
      normalizedText: destination.toLowerCase(),
      interpretedLabel: semantics.label,
      interpretationType: 'natural_area',
      countries: semantics.countries,
      confidence: semantics.confidence,
      sources: ['traveller_text', 'resolution'],
      ambiguities: [],
      recordedAt: NOW.toISOString(),
      graph,
      semantics,
    },
  } as unknown as TripIntentRecord;
}

describe('the destination-semantics corpus', () => {
  for (const [phrase, want] of Object.entries(CORPUS)) {
    it(`${phrase}: words preserved, compatible evidence, sensible extent, no substitution, fitting traits`, async () => {
      const log: string[] = [];
      const { outcome, resolution, semantics } = await resolveDestinationPhrase({ text: phrase, resolver: recordedResolver(log), now: NOW, interpreter: fixtureInterpreter() });

      /* The traveller's words are the identity. */
      expect(semantics.rawText).toBe(phrase);
      expect(semantics.label.toLowerCase()).toContain(phrase.replace(/^the\s+/i, '').toLowerCase().split(' ')[0]!);
      expect(semantics.label).not.toMatch(want.never);

      /* Whatever was accepted is semantically compatible: the right kind of thing, never a business, road or neighbourhood. */
      const types = Array.isArray(want.type) ? want.type : [want.type];
      expect(types, `${phrase} read as ${semantics.type}`).toContain(semantics.type);
      const accepted = resolution.candidates;
      for (const c of accepted) {
        expect(c.displayName, `${phrase} accepted ${c.displayName}`).not.toMatch(want.never);
        expect(c.qualifiedName, `${phrase} accepted ${c.qualifiedName}`).not.toMatch(want.never);
        expect(['point_of_interest', 'route_or_corridor', 'neighbourhood']).not.toContain(c.entityType);
      }
      const decision = decideInterpretation(resolution);
      expect(decision.kind, `${phrase} decided ${decision.kind}`).toBe('single');

      /* The map extent is sensible for the kind of thing, and never a point dressed as a region. */
      if (want.extentKm) {
        expect(semantics.extent, `${phrase} has no extent`).toBeDefined();
        const km = diagonalKm(semantics.extent!.bounds);
        expect(km, `${phrase} extent ${Math.round(km)} km`).toBeGreaterThanOrEqual(want.extentKm[0]);
        expect(km, `${phrase} extent ${Math.round(km)} km`).toBeLessThanOrEqual(want.extentKm[1]);
      }
      expect(semantics.center).toBeDefined();
      if (want.countries) for (const code of want.countries) expect(semantics.countries, `${phrase} countries`).toContain(code);

      /* The interpreter is consulted only when the evidence was insufficient. */
      expect(Boolean(outcome.interpretation?.concept), `${phrase} interpreted=${Boolean(outcome.interpretation?.concept)}`).toBe(want.interpreted);

      /* Gateways are context, never the destination. */
      for (const g of semantics.gateways) expect(g.label.toLowerCase()).not.toBe(semantics.label.toLowerCase());

      /* The interview reads the kind of trip, not a matching string. */
      const signals = screeningSignalsFor({ trip: tripFor(phrase), intent: intentFor(phrase, resolution, semantics, outcome.graph), region: null });
      const screened = screenDestination(signals);
      for (const t of want.traits.has) expect(screened.traits, `${phrase} lacks trait ${t}: ${screened.traits.join(',')}`).toContain(t);
      for (const t of want.traits.lacks) expect(screened.traits, `${phrase} has trait ${t}`).not.toContain(t);
    });
  }

  it('the Canadian Rockies never resolves to central Calgary: the businesses are refused by name, Calgary is a gateway only', async () => {
    const { outcome, resolution, semantics } = await resolveDestinationPhrase({ text: 'the Canadian Rockies', resolver: recordedResolver(), now: NOW, interpreter: fixtureInterpreter() });
    expect(semantics.refused.map((r) => r.label)).toEqual(expect.arrayContaining(['Resorts of the Canadian Rockies']));
    expect(semantics.refused.find((r) => r.label === 'Resorts of the Canadian Rockies')?.reason).toBe('point_for_region');
    const only = resolution.candidates[0]!;
    expect(only.id).toMatch(/^concept:/);
    expect(only.displayName).toBe('the Canadian Rockies');
    expect(only.entityType).toBe('natural_region');
    /* The centre is in the mountains, not downtown Calgary (51.04, -114.07). */
    expect(Math.abs(only.center.lng - -114.07)).toBeGreaterThan(0.8);
    expect(only.bounds!.northEast.lng).toBeLessThan(-114.9);
    expect(semantics.gateways.map((g) => g.label)).toContain('Calgary');
    expect(semantics.parts.length).toBeGreaterThanOrEqual(3);
    expect(semantics.extent?.source).toBe('interpreted_parts');
    expect(outcome.graph.children[0]!.resolution?.source).toBe('interpretation');
  });

  it('the recorded corpus never spends more than the documented geocoder budget per door', async () => {
    const log: string[] = [];
    await resolveDestinationPhrase({ text: 'the Canadian Rockies', resolver: recordedResolver(log), now: NOW, interpreter: fixtureInterpreter() });
    expect(log.length).toBeLessThanOrEqual(3 + 6);
  });
});
