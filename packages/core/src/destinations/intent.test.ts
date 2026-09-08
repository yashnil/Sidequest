import { describe, expect, it } from 'vitest';
import { buildDestinationIntent, labelAnswersPhrase, phraseNamesSeveralPlaces } from './intent';
import { clarificationWarranted, type DestinationResolution } from '../schemas/resolution';
import type { SelectedDestination } from '../schemas/destination-index';

const NOW = new Date('2026-09-08T09:00:00.000Z');

function candidate(overrides: Partial<DestinationResolution['candidates'][number]> = {}) {
  return {
    id: overrides.id ?? 'c1',
    displayName: overrides.displayName ?? 'Somewhere',
    qualifiedName: overrides.qualifiedName ?? 'Somewhere, Someland',
    entityType: 'city' as const,
    breadth: overrides.breadth ?? ('city' as const),
    center: overrides.center ?? { lat: 10, lng: 20 },
    aliases: [],
    administrativeAreas: [],
    timeZones: [],
    providerRefs: [],
    confidence: { level: overrides.confidence?.level ?? ('high' as const), signals: [], note: 'test' },
    ...(overrides.countryCode ? { countryCode: overrides.countryCode } : {}),
    ...(overrides.bounds ? { bounds: overrides.bounds } : {}),
  };
}

function resolution(overrides: Partial<DestinationResolution>): DestinationResolution {
  return {
    schemaVersion: 1,
    query: overrides.query ?? 'somewhere',
    normalizedQuery: overrides.normalizedQuery ?? 'somewhere',
    candidates: overrides.candidates ?? [],
    ambiguityReasons: overrides.ambiguityReasons ?? [],
    providersConsulted: overrides.providersConsulted ?? [],
    resolvedAt: NOW.toISOString(),
    ...(overrides.unambiguousCandidateId ? { unambiguousCandidateId: overrides.unambiguousCandidateId } : {}),
  } as DestinationResolution;
}

describe('the traveller keeps their own words', () => {
  it('records a phrase nobody resolved as a usable intent', () => {
    const intent = buildDestinationIntent({ rawText: 'the steppes', now: NOW });
    expect(intent.rawText).toBe('the steppes');
    expect(intent.interpretedLabel).toBe('the steppes');
    expect(intent.interpretationType).toBe('unresolved');
    expect(intent.confidence).toBe('low');
    expect(intent.countries).toEqual([]);
  });

  it('never narrows a broad phrase to the town a resolver happened to match', () => {
    const intent = buildDestinationIntent({
      rawText: 'inland Alaska',
      resolution: resolution({
        query: 'inland Alaska',
        normalizedQuery: 'inland alaska',
        unambiguousCandidateId: 'c1',
        candidates: [candidate({ displayName: 'Nenana', qualifiedName: 'Nenana, Alaska, United States', countryCode: 'US' })],
      }),
      now: NOW,
    });
    // Their words are the destination; the match is a centre to plan around.
    expect(intent.interpretedLabel).toBe('inland Alaska');
    expect(intent.interpretationType).toBe('descriptive_area');
    expect(intent.anchor?.label).toBe('Nenana');
    expect(intent.center).toEqual({ lat: 10, lng: 20 });
    expect(intent.countries).toEqual(['US']);
  });

  it('lets a resolution name the destination when it answers the phrase', () => {
    const intent = buildDestinationIntent({
      rawText: 'hong kong',
      resolution: resolution({
        query: 'hong kong',
        normalizedQuery: 'hong kong',
        unambiguousCandidateId: 'c1',
        candidates: [candidate({ displayName: 'Hong Kong', qualifiedName: 'Hong Kong', breadth: 'region', countryCode: 'HK' })],
      }),
      now: NOW,
    });
    expect(intent.interpretedLabel).toBe('Hong Kong');
    expect(intent.interpretationType).toBe('administrative_area');
    expect(intent.confidence).toBe('high');
  });

  it('takes a picked row at its word', () => {
    const selected: SelectedDestination = {
      entryId: 'e1',
      catalog: 'overture',
      sourceId: 's1',
      releaseId: 'r1',
      displayName: 'Kyoto',
      qualifiedName: 'Kyoto, Japan',
      featureType: 'city',
      center: { lat: 35, lng: 135 },
      countryCode: 'JP',
      aliases: [],
      hierarchy: [],
      selectedAt: NOW.toISOString(),
    };
    const intent = buildDestinationIntent({ rawText: 'kyo', selected, now: NOW });
    expect(intent.rawText).toBe('kyo');
    // The name, not the disambiguation: "Kyoto, Japan" is how a dropdown row
    // tells two Kyotos apart, and it is not what anybody calls the place.
    expect(intent.interpretedLabel).toBe('Kyoto');
    expect(intent.interpretationType).toBe('locality');
    expect(intent.confidence).toBe('high');
    expect(intent.sources).toContain('traveller_selection');
  });

  it('keeps the countries several candidates agree on without choosing between them', () => {
    const intent = buildDestinationIntent({
      rawText: 'springfield',
      resolution: resolution({
        query: 'springfield',
        normalizedQuery: 'springfield',
        ambiguityReasons: ['multiple_matching_places'],
        candidates: [
          candidate({ id: 'a', displayName: 'Springfield', qualifiedName: 'Springfield, Illinois', countryCode: 'US', center: { lat: 39.8, lng: -89.6 } }),
          candidate({ id: 'b', displayName: 'Springfield', qualifiedName: 'Springfield, Missouri', countryCode: 'US', center: { lat: 37.2, lng: -93.3 } }),
        ],
      }),
      now: NOW,
    });
    expect(intent.interpretedLabel).toBe('springfield');
    expect(intent.anchor).toBeUndefined();
    expect(intent.countries).toEqual(['US']);
  });
});

describe('a phrase naming several places is read as several', () => {
  it.each(['Tokyo and Kyoto', 'Lisbon, Porto', 'Bali / Lombok'])('%s', (phrase) => {
    expect(phraseNamesSeveralPlaces(phrase)).toBe(true);
  });
  it('a single name is not', () => {
    expect(phraseNamesSeveralPlaces('Mammoth Lakes')).toBe(false);
  });
});

describe('a label answers a phrase when one contains the other', () => {
  it('matches across case and qualification', () => {
    expect(labelAnswersPhrase('hong kong', 'Hong Kong Island')).toBe(true);
    expect(labelAnswersPhrase('Kyoto', 'Kyoto, Japan')).toBe(true);
  });
  it('does not match an unrelated town', () => {
    expect(labelAnswersPhrase('inland Alaska', 'Nenana')).toBe(false);
  });
});

describe('asking is worth a screen only when the answer changes the trip', () => {
  it('does not ask about breadth', () => {
    expect(
      clarificationWarranted(
        resolution({
          ambiguityReasons: ['administrative_area_needs_subset'],
          candidates: [candidate({ breadth: 'country', countryCode: 'KG' })],
        }),
      ),
    ).toBe(false);
  });

  it('does not ask when there is nothing to choose between', () => {
    expect(clarificationWarranted(resolution({ ambiguityReasons: ['no_match'], candidates: [] }))).toBe(false);
  });

  it('does not ask when the candidates describe one holiday', () => {
    expect(
      clarificationWarranted(
        resolution({
          ambiguityReasons: ['multiple_matching_places'],
          candidates: [
            candidate({ id: 'a', countryCode: 'JP', center: { lat: 35.0, lng: 135.0 } }),
            candidate({ id: 'b', countryCode: 'JP', center: { lat: 35.1, lng: 135.1 } }),
          ],
        }),
      ),
    ).toBe(false);
  });

  it('asks when the candidates are in different countries', () => {
    expect(
      clarificationWarranted(
        resolution({
          ambiguityReasons: ['multiple_matching_places'],
          candidates: [
            candidate({ id: 'a', countryCode: 'US', center: { lat: 39.8, lng: -89.6 } }),
            candidate({ id: 'b', countryCode: 'AU', center: { lat: -33.9, lng: 151.2 } }),
          ],
        }),
      ),
    ).toBe(true);
  });

  it('asks when one country holds two places a long way apart', () => {
    expect(
      clarificationWarranted(
        resolution({
          ambiguityReasons: ['multiple_matching_places'],
          candidates: [
            candidate({ id: 'a', countryCode: 'US', center: { lat: 39.8, lng: -89.6 } }),
            candidate({ id: 'b', countryCode: 'US', center: { lat: 37.2, lng: -93.3 } }),
          ],
        }),
      ),
    ).toBe(true);
  });
});
