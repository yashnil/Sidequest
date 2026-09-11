import { describe, expect, it } from 'vitest';
import type { Trip } from '@sidequest/core';
import { buildDestinationIntent, defaultAnswers, interviewCatalog, parseDestinationIntent, questionById, withScreening } from '@sidequest/core';
import type { TripIntentRecord } from '@/lib/db/compiler-repository';
import { interviewContextFor, realityForTrip } from './screening';

/**
 * V7 §2, §3, §5 — THE TWO PRODUCTION TRIPS, AS ONE OFFLINE CORPUS.
 *
 * "Kenya and Tanzania" was refused as not a place; "Chongqing" was labelled a
 * state, a moving route and a car, and an American was told to hire one. These
 * cases run the same path the questionnaire page runs — intent graph → reality
 * → interview context → catalog — and pin that the two trips are interviewed
 * differently, from data keyed by country, with no location named in code.
 */

const NOW = new Date('2026-06-01T00:00:00Z');

function tripFor(destination: string, adults = 4): Trip {
  return {
    id: 't',
    basics: { mode: 'known_destination', destinationInput: destination, regionId: 'dynamic', startDate: '2026-10-10', endDate: '2026-10-19', arrivalTime: '15:00', departureTime: '11:00', adults, children: 0, travelerNeeds: [] },
    status: 'draft',
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  };
}

function intentFor(destination: string, candidate: { entityType: string; countryCode: string; center: { lat: number; lng: number } } | null): TripIntentRecord {
  const graph = parseDestinationIntent(destination);
  return {
    tripId: 't',
    mode: 'known_destination',
    destinationQuery: destination,
    resolution: candidate
      ? ({
          schemaVersion: 1,
          query: destination,
          candidates: [{ id: 'c1', displayName: destination, qualifiedName: destination, breadth: 'city', aliases: [], administrativeAreas: [], timeZones: [], providerRefs: [], confidence: { level: 'high', signals: [], note: 'fixture' }, ...candidate }],
          unambiguousCandidateId: 'c1',
          ambiguityReasons: [],
          providersConsulted: ['fixture'],
          resolvedAt: NOW.toISOString(),
        } as unknown as TripIntentRecord['resolution'])
      : null,
    selectedCandidateId: candidate ? 'c1' : null,
    clarifications: { schemaVersion: 1, questions: [], answers: [] },
    scope: null,
    scopeRevision: 1,
    selectedCompiledRegionId: null,
    destinationIntent: buildDestinationIntent({ rawText: destination, now: NOW, graph }),
    discoveryPreferences: null,
    composer: null,
    selectedDestination: null,
    preflight: null,
  };
}

const KENYA_TANZANIA = 'Kenya and Tanzania';
const CHONGQING = 'Chongqing';

describe('V7 corpus — Kenya and Tanzania, Chongqing', () => {
  it('a two-country phrase is a composite intent, never "not a place"', () => {
    const graph = parseDestinationIntent(KENYA_TANZANIA);
    expect(graph.children.map((c) => c.kind)).toEqual(['country', 'country']);
    expect(graph.countries).toEqual(['KE', 'TZ']);
    expect(graph.crossBorder).toBe(true);
    expect(graph.relationship).toBe('multi_region_trip');
  });

  it('the two trips get different realities from country-keyed data, and neither is a car trip', () => {
    const africa = realityForTrip({ trip: tripFor(KENYA_TANZANIA), intent: intentFor(KENYA_TANZANIA, null), region: null, party: { members: 4, needs: [], drivers: 4, dietsRecorded: false, differences: false } });
    const china = realityForTrip({ trip: tripFor(CHONGQING), intent: intentFor(CHONGQING, { entityType: 'municipality', countryCode: 'CN', center: { lat: 29.56, lng: 106.55 } }), region: null, party: { members: 4, needs: [], drivers: 4, dietsRecorded: false, differences: false } });
    expect(africa.destination.countries).toEqual(['KE', 'TZ']);
    expect(china.destination.countries).toEqual(['CN']);
    expect(africa.recommendation!.regional).toContain('guided_transfer');
    expect(africa.recommendation!.regional).toContain('flight');
    expect(china.recommendation!.urban).toEqual(expect.arrayContaining(['walking', 'metro']));
    expect(china.recommendation!.regional).toContain('high_speed_rail');
    const chinaCar = china.modes.find((m) => m.mode === 'self_drive');
    expect(chinaCar?.status).not.toBe('recommended');
    expect(chinaCar?.status).not.toBe('viable');
    const africaCar = africa.modes.find((m) => m.mode === 'self_drive');
    expect(africaCar?.status).not.toBe('recommended');
    /* The facts that drive the two answers carry provenance and a date, never a bare assertion. */
    for (const reality of [africa, china]) for (const fact of reality.facts) expect(fact.asOf ?? fact.authority).toBeTruthy();
  });

  it('the interview asks the two trips different transport questions and never recommends a hire car for either', () => {
    const contexts = [
      { name: KENYA_TANZANIA, ctx: interviewContextFor({ trip: tripFor(KENYA_TANZANIA), intent: intentFor(KENYA_TANZANIA, null), region: null, offeredInterests: [], carried: [], party: { members: 4, needs: [], drivers: 4, dietsRecorded: false, differences: false } }) },
      { name: CHONGQING, ctx: interviewContextFor({ trip: tripFor(CHONGQING), intent: intentFor(CHONGQING, { entityType: 'municipality', countryCode: 'CN', center: { lat: 29.56, lng: 106.55 } }), region: null, offeredInterests: [], carried: [], party: { members: 4, needs: [], drivers: 4, dietsRecorded: false, differences: false } }) },
    ];
    const seen: string[][] = [];
    for (const { name, ctx } of contexts) {
      const answers = withScreening(defaultAnswers({ travelerNeeds: [], tripDays: ctx.traveller.tripDays, offeredInterests: [] }), ctx.destination);
      const transport = questionById(ctx, answers, 'transport_mode')!;
      const options = transport.options!(ctx, answers).map((o) => o.value as string);
      const smart = transport.smartDefault(ctx, answers);
      expect(options, name).not.toContain('rent_car');
      expect(smart.value, name).not.toBe('rent_car');
      expect(smart.reason, name).not.toMatch(/rent a car/i);
      seen.push(options);
      /* V7 §5 — the split question needs a difference to split over. Four friends with none recorded are not asked. */
      const split = questionById(ctx, answers, 'everyone_every_day')!;
      expect(split.relevance(ctx, answers), name).toBe(0);
    }
    expect(seen[0]).not.toEqual(seen[1]);
    expect(seen[0]).toContain('guided');
    expect(seen[1]).toContain('rail_transfers');
  });

  it('a city-region is labelled as one, and its interview is urban — not a state, a route or a car', () => {
    const ctx = interviewContextFor({ trip: tripFor(CHONGQING), intent: intentFor(CHONGQING, { entityType: 'municipality', countryCode: 'CN', center: { lat: 29.56, lng: 106.55 } }), region: null, offeredInterests: [], carried: [] });
    expect(ctx.destination.traits).toContain('city_region');
    expect(ctx.destination.traits).not.toContain('road_trip_region');
    expect(ctx.destination.assumption?.movement).not.toBe('car');
    const answers = withScreening(defaultAnswers({ travelerNeeds: [], tripDays: ctx.traveller.tripDays, offeredInterests: [] }), ctx.destination);
    const ids = new Set(interviewCatalog(ctx, answers).filter((q) => q.relevance(ctx, answers) > 0).map((q) => q.module));
    expect(ids.has('urban_mobility')).toBe(true);
    expect(ids.has('road_trip')).toBe(false);
  });

  it('a party with a recorded difference is asked whether everyone must enjoy every day', () => {
    const ctx = interviewContextFor({ trip: tripFor(KENYA_TANZANIA), intent: intentFor(KENYA_TANZANIA, null), region: null, offeredInterests: [], carried: [], party: { members: 4, needs: ['limited_walking'], drivers: 4, dietsRecorded: false, differences: true } });
    const answers = withScreening(defaultAnswers({ travelerNeeds: [], tripDays: ctx.traveller.tripDays, offeredInterests: [] }), ctx.destination);
    expect(questionById(ctx, answers, 'everyone_every_day')!.relevance(ctx, answers)).toBeGreaterThan(0);
  });
});
