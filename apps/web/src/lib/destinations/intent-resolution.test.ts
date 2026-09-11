import { describe, expect, it } from 'vitest';
import { DESTINATION_RESOLUTION_VERSION, assessConfidence, decideInterpretation, type DestinationCandidate, type DestinationResolution } from '@sidequest/core';
import type { DestinationResolver } from '@sidequest/compiler';
import { resolveDestinationPhrase, resolverQueryFor } from './intent-resolution';
import { parseDestinationIntent } from '@sidequest/core';

/**
 * V7 §2 — THE TWO PRODUCTION DOORS, WITH A FAKE GEOCODER.
 *
 * The fake answers only what a real one would: a country by its name, a town
 * by its name; nothing for a phrase. "Kenya and Tanzania" must come out as one
 * composite candidate the rest of the product can adopt without a screen;
 * "the steppes" must come out empty but never refused.
 */
const NOW = new Date('2026-09-10T12:00:00Z');

function candidate(input: Partial<DestinationCandidate> & { id: string; displayName: string; center: { lat: number; lng: number } }): DestinationCandidate {
  return {
    qualifiedName: input.displayName,
    entityType: 'city',
    breadth: 'city',
    aliases: [],
    administrativeAreas: [],
    timeZones: [],
    providerRefs: [{ provider: 'openstreetmap', externalId: input.id }],
    confidence: assessConfidence(['exact_name_match', 'administrative_hierarchy_match', 'boundary_available']),
    ...input,
  };
}

const KNOWN: Record<string, DestinationCandidate> = {
  kenya: candidate({ id: 'r192798', displayName: 'Kenya', entityType: 'country', breadth: 'country', center: { lat: 1.44, lng: 38.43 }, bounds: { southWest: { lat: -4.7, lng: 33.9 }, northEast: { lat: 5.5, lng: 41.9 } }, countryCode: 'KE' }),
  tanzania: candidate({ id: 'r195270', displayName: 'Tanzania', entityType: 'country', breadth: 'country', center: { lat: -6.5, lng: 35.7 }, bounds: { southWest: { lat: -11.8, lng: 29.3 }, northEast: { lat: -0.98, lng: 40.4 } }, countryCode: 'TZ' }),
  edinburgh: candidate({ id: 'r1920901', displayName: 'Edinburgh', center: { lat: 55.95, lng: -3.19 }, countryCode: 'GB' }),
  'scottish highlands, united kingdom': candidate({ id: 'r-highlands', displayName: 'Highland', entityType: 'subregion', breadth: 'subregion', center: { lat: 57.5, lng: -4.7 }, bounds: { southWest: { lat: 56.5, lng: -7 }, northEast: { lat: 58.7, lng: -2.9 } }, countryCode: 'GB' }),
  chongqing: candidate({ id: 'r913069', displayName: 'Chongqing', entityType: 'municipality', breadth: 'region', center: { lat: 29.56, lng: 106.55 }, bounds: { southWest: { lat: 28.2, lng: 105.3 }, northEast: { lat: 32.2, lng: 110.2 } }, countryCode: 'CN' }),
};

function fakeResolver(log: string[] = []): DestinationResolver {
  return {
    name: 'fake-geocoder',
    async resolve({ query }): Promise<DestinationResolution> {
      log.push(query);
      const hit = KNOWN[query.toLowerCase()];
      return {
        schemaVersion: DESTINATION_RESOLUTION_VERSION,
        query,
        normalizedQuery: query.toLowerCase(),
        candidates: hit ? [hit] : [],
        ambiguityReasons: hit ? [] : ['no_match'],
        ...(hit ? { unambiguousCandidateId: hit.id } : {}),
        providersConsulted: ['fake-geocoder'],
        resolvedAt: NOW.toISOString(),
      };
    },
  };
}

describe('resolveDestinationPhrase', () => {
  it('Kenya and Tanzania becomes one composite candidate spanning both countries, adopted without a screen', async () => {
    const log: string[] = [];
    const { outcome, resolution } = await resolveDestinationPhrase({ text: 'Kenya and Tanzania', resolver: fakeResolver(log), now: NOW });
    expect(outcome.graph.children.every((c) => c.resolution)).toBe(true);
    expect(resolution.candidates).toHaveLength(1);
    const composite = resolution.candidates[0]!;
    expect(composite.id).toBe('composite:kenya-and-tanzania');
    expect(composite.displayName).toBe('Kenya and Tanzania');
    expect(composite.entityType).toBe('multi_country');
    expect(composite.breadth).toBe('multi_country');
    expect(composite.bounds).toEqual({ southWest: { lat: -11.8, lng: 29.3 }, northEast: { lat: 5.5, lng: 41.9 } });
    expect(composite.countryCode).toBeUndefined();
    expect(composite.administrativeAreas).toEqual(['Kenya', 'Tanzania']);
    expect(composite.note).toMatch(/Several countries in one trip/);
    expect(resolution.ambiguityReasons).not.toContain('query_is_not_a_place');
    expect(resolution.ambiguityReasons).not.toContain('no_match');
    expect(decideInterpretation(resolution).kind).toBe('single');
  });

  it('a phrase nobody can place is empty, never refused', async () => {
    const { resolution, outcome } = await resolveDestinationPhrase({ text: 'the steppes', resolver: fakeResolver(), now: NOW });
    expect(resolution.candidates).toEqual([]);
    expect(resolution.ambiguityReasons).toEqual([]);
    expect(outcome.graph.children[0]!.kind).toBe('natural_region');
    expect(decideInterpretation(resolution).kind).toBe('no_match');
  });

  it('rural Japan anchors on the country without asking the geocoder about a phrase that has no row', async () => {
    const log: string[] = [];
    const { resolution } = await resolveDestinationPhrase({ text: 'rural Japan', resolver: fakeResolver(log), now: NOW });
    expect(log).toEqual([]);
    expect(resolution.candidates).toHaveLength(1);
    expect(resolution.candidates[0]!.displayName).toBe('rural Japan');
    expect(resolution.candidates[0]!.countryCode).toBe('JP');
    expect(resolution.candidates[0]!.entityType).toBe('state_or_province');
    expect(resolution.candidates[0]!.center.lat).toBeCloseTo(35.68, 1);
  });

  it('Scottish Highlands and Edinburgh asks the geocoder for each part, with the country as a qualifier', async () => {
    const log: string[] = [];
    const { resolution } = await resolveDestinationPhrase({ text: 'Scottish Highlands and Edinburgh', resolver: fakeResolver(log), now: NOW });
    expect(log).toEqual(['Scottish Highlands, United Kingdom', 'Edinburgh']);
    expect(resolution.candidates[0]!.entityType).toBe('subregion');
    expect(resolution.candidates[0]!.countryCode).toBe('GB');
    expect(resolution.candidates[0]!.bounds!.southWest.lng).toBeLessThan(-6);
  });

  it('a single place passes the geocoder’s own answer through untouched', async () => {
    const { resolution } = await resolveDestinationPhrase({ text: 'Chongqing', resolver: fakeResolver(), now: NOW });
    expect(resolution.candidates[0]!.id).toBe('r913069');
    expect(resolution.candidates[0]!.entityType).toBe('municipality');
  });

  it('a single place with no resolver stays empty and honest', async () => {
    const { resolution } = await resolveDestinationPhrase({ text: 'Patagonia', resolver: null, now: NOW });
    expect(resolution.candidates).toEqual([]);
  });

  it('never spends more than the call budget', async () => {
    const log: string[] = [];
    await resolveDestinationPhrase({ text: 'Paris, Lyon, Nice, Marseille, Bordeaux', resolver: fakeResolver(log), now: NOW, maxGeocoderCalls: 2 });
    expect(log).toHaveLength(2);
  });

  it('resolverQueryFor qualifies a landscape by its country and leaves a bare country alone', () => {
    const graph = parseDestinationIntent('the steppes of Kyrgyzstan and Kyrgyzstan');
    expect(resolverQueryFor(graph.children[0]!)).toBe('steppes of Kyrgyzstan');
    expect(resolverQueryFor(graph.children[1]!)).toBe('Kyrgyzstan');
  });
});
