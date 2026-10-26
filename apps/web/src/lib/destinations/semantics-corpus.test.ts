import { describe, expect, it } from 'vitest';
import { DESTINATION_RESOLUTION_VERSION, decideInterpretation, diagonalKm, normalizeDestinationQuery, screenDestination, type DestinationSemantics, type GeographicSemanticType } from '@sidequest/core';
import { resolveDestinationPhrase } from './intent-resolution';
import { fixtureInterpreter } from './interpretation';
import { recordedPlaces, recordedResolver } from './fixtures/recorded-resolver';
import { toCandidate } from '../providers/open-verification';
import type { DestinationResolver } from '@sidequest/compiler';
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

/**
 * Production pass — "Lisbon" asked "More than one place is called Lisbon" and
 * offered Lisboa twice (the city and its district) beside three small US
 * towns, with the capital marked "the name was only a partial match": its OSM
 * name is Portuguese and the English name was read only as an alias. The rows
 * are the public geocoder's answer of 2026-10-25 (`fixtures/nominatim/lisbon.json`).
 */
describe('a bare city name with small namesakes (production pass)', () => {
  it('Lisbon resolves straight to Lisbon, Portugal, without a question', async () => {
    const { resolution, semantics } = await resolveDestinationPhrase({ text: 'Lisbon', resolver: recordedResolver(), now: NOW });
    const decision = decideInterpretation(resolution);
    expect(decision.kind).toBe('single');
    expect(resolution.unambiguousCandidateId).toBe('relation/5400890');
    expect(resolution.ambiguityReasons).not.toContain('multiple_matching_places');
    expect(resolution.candidates[0]!.countryCode).toBe('PT');
    expect(semantics.countries).toEqual(['PT']);
    /* The English name is an exact match, not a partial one. */
    expect(resolution.candidates[0]!.confidence.signals).toContain('exact_name_match');
    expect(resolution.candidates[0]!.confidence.level).not.toBe('low');
    /* The district of Lisboa around the city is the same place, never a second reading. */
    expect(resolution.candidates.filter((c) => c.countryCode === 'PT')).toHaveLength(1);
    expect(resolution.candidates.map((c) => c.id)).not.toContain('relation/2897141');
  });

  it('Lisboa (the local name) reads the same rows the same way', async () => {
    /* The recorded Lisbon rows replayed for the Portuguese spelling: the primary-name path, which never regressed. */
    const resolver: DestinationResolver = {
      name: 'nominatim-recorded',
      async resolve({ query, now }) {
        const candidates = (recordedPlaces('Lisbon') ?? []).map((place) => toCandidate(place, query)).filter((c) => c !== null);
        return { schemaVersion: DESTINATION_RESOLUTION_VERSION, query, normalizedQuery: normalizeDestinationQuery(query), candidates, ambiguityReasons: candidates.length > 1 ? ['multiple_matching_places'] : [], providersConsulted: ['nominatim-recorded'], resolvedAt: now.toISOString() };
      },
    };
    const { resolution } = await resolveDestinationPhrase({ text: 'Lisboa', resolver, now: NOW });
    expect(decideInterpretation(resolution).kind).toBe('single');
    expect(resolution.candidates[0]!.countryCode).toBe('PT');
    expect(resolution.candidates).toHaveLength(1);
  });

  it('Portland is still a question: Oregon and Maine are comparable, not a tenfold namesake', async () => {
    const { resolution } = await resolveDestinationPhrase({ text: 'Portland', resolver: recordedResolver(), now: NOW });
    expect(decideInterpretation(resolution).kind).toBe('choose');
    expect(resolution.unambiguousCandidateId).toBeUndefined();
  });
});

/**
 * 2026-10 — THE NAMESAKE REGRESSION SET, ON THE PUBLIC GEOCODER'S OWN ROWS.
 *
 * Recorded once each on 2026-10-25 (`fixtures/nominatim/<name>.json`, the
 * adapter's own parameters). Every decision below follows from the rows: a
 * tenfold published population, or the international namesake rule
 * (`internationallyAbove`: the geocoder's importance ≥ 0.15 above every
 * rival, the rivals in another country, and none within a third of the
 * leader's size), or rows of one place folding together (one Wikidata item;
 * an island inside its same-named province). Anything else is a question.
 */
describe('the namesake regression set (2026-10)', () => {
  const decide = async (text: string) => {
    const { resolution, semantics } = await resolveDestinationPhrase({ text, resolver: recordedResolver(), now: NOW });
    const decision = decideInterpretation(resolution);
    return { resolution, semantics, decision, chosen: decision.kind === 'single' ? decision.candidate : null };
  };

  it('Florence is Firenze: a famous city abroad over small towns of one other country', async () => {
    const { decision, chosen, resolution } = await decide('Florence');
    expect(decision.kind).toBe('single');
    expect(chosen?.countryCode).toBe('IT');
    expect(resolution.unambiguousCandidateId).toBe('relation/42602');
    /* The namesakes are still listed — the reading is settled, not the evidence hidden. */
    expect(resolution.candidates.filter((c) => c.countryCode === 'US').length).toBeGreaterThanOrEqual(3);
  });

  it('Portland is still a question: the two Portlands are in one country and 0.11 apart in prominence', async () => {
    /*
     * Oregon 652,503 / importance 0.71; Maine 68,408 / 0.60. Under tenfold
     * (9.5×), and the international rule does not apply inside one country —
     * a traveller from that country plausibly means either.
     */
    const { decision } = await decide('Portland');
    expect(decision.kind).toBe('choose');
  });

  it('Rome and Lisbon still settle on the tenfold rule; Paris now does too (its two rows are one Wikidata item)', async () => {
    expect((await decide('Rome')).chosen?.countryCode).toBe('IT');
    expect((await decide('Lisbon')).chosen?.countryCode).toBe('PT');
    const paris = await decide('Paris');
    expect(paris.chosen?.countryCode).toBe('FR');
    expect(paris.resolution.candidates.filter((c) => c.countryCode === 'FR')).toHaveLength(1);
  });

  it('Bali is the Indonesian province: the island inside it is the same reading, and Paris is not an alias of it', async () => {
    const { chosen, resolution } = await decide('Bali');
    expect(chosen?.countryCode).toBe('ID');
    expect(resolution.candidates.filter((c) => c.countryCode === 'ID')).toHaveLength(1);
    expect(resolution.candidates.map((c) => c.countryCode)).not.toContain('FR');
  });

  it('Georgia keeps asking: the country and the US state are comparable, and neither is a namesake of the other', async () => {
    const { decision, resolution } = await decide('Georgia');
    expect(decision.kind).toBe('choose');
    expect(resolution.candidates.map((c) => c.countryCode).sort()).toEqual(['GE', 'US']);
  });

  it.each([
    /* Cambridge (UK) 0.70 against Cambridge, Massachusetts 0.67. */
    ['Cambridge'],
    /* Kingston, Jamaica 0.65 against Kingston, Ontario 0.60. */
    ['Kingston'],
    /* València (0.84 M) against Valencia, Venezuela (2.3 M): comparable across the border. */
    ['Valencia'],
    /* Santiago de Chile against Santiago de Cuba (0.58, 0.146 below): just inside the gap, so asked. */
    ['Santiago'],
    /* Alessandria and Alexandria, Virginia are 0.11 apart; Alexandria, Egypt is not in the geocoder's first five rows at all. */
    ['Alexandria'],
  ])('%s stays a question', async (text) => {
    expect((await decide(text)).decision.kind).toBe('choose');
  });

  it('Victoria keeps its current reading: the Australian state, ten times Victoria, British Columbia', async () => {
    expect((await decide('Victoria')).chosen?.countryCode).toBe('AU');
  });

  it('Patagonia is unchanged by the namesake rules (a region, not a bare city)', async () => {
    const { decision } = await decide('Patagonia');
    expect(decision.kind).toBe('choose');
  });
});
