import { describe, expect, it } from 'vitest';
import { countriesInText } from '../reference/countries';
import { attachIntentResolutions, describeIntentGraph, envelopeOf, parseDestinationIntent, splitIntentPhrase } from './intent-graph';
import { buildDestinationIntent, interpretationTypeOf } from './intent';

/**
 * V7 §2 — THE DESTINATION-INTENT REGRESSION CORPUS.
 *
 * Every phrase below is one a traveller actually types. Nothing in the parser
 * knows any of these names except the bundled country reference; the
 * assertions are about SHAPE — how many parts, which kinds, which countries,
 * whether a border is crossed — never about a coordinate.
 */
const NOW = new Date('2026-09-10T12:00:00Z');

describe('countriesInText', () => {
  it('finds every country in a phrase, longest window first, without overlap', () => {
    expect(countriesInText('Kenya and Tanzania').map((h) => h.facts.code)).toEqual(['KE', 'TZ']);
    expect(countriesInText('Japan and South Korea').map((h) => h.facts.code)).toEqual(['JP', 'KR']);
    expect(countriesInText('rural Japan').map((h) => [h.facts.code, h.how])).toEqual([['JP', 'phrase']]);
    expect(countriesInText('the steppes')).toEqual([]);
  });
});

describe('splitIntentPhrase', () => {
  it('splits on conjunctions and separators and keeps qualifiers with their noun', () => {
    expect(splitIntentPhrase('Kenya and Tanzania')).toEqual(['Kenya', 'Tanzania']);
    expect(splitIntentPhrase('Japan + Korea')).toEqual(['Japan', 'Korea']);
    expect(splitIntentPhrase('Paris, Provence')).toEqual(['Paris', 'Provence']);
    expect(splitIntentPhrase('Provence + Côte d’Azur')).toEqual(['Provence', 'Côte d’Azur']);
    expect(splitIntentPhrase('Scottish Highlands and Edinburgh')).toEqual(['Scottish Highlands', 'Edinburgh']);
    expect(splitIntentPhrase('rural Japan')).toEqual(['rural Japan']);
    expect(splitIntentPhrase('Lisbon to Porto')).toEqual(['Lisbon', 'Porto']);
  });
});

describe('parseDestinationIntent — the corpus', () => {
  it('Kenya and Tanzania is a two-country trip, never a refusal', () => {
    const graph = parseDestinationIntent('Kenya and Tanzania');
    expect(graph.children.map((c) => [c.kind, c.countryCode])).toEqual([
      ['country', 'KE'],
      ['country', 'TZ'],
    ]);
    expect(graph.relationship).toBe('multi_region_trip');
    expect(graph.crossBorder).toBe(true);
    expect(graph.countries).toEqual(['KE', 'TZ']);
    expect(graph.confidence).toBe('high');
    expect(graph.travellerLabel).toBe('Kenya and Tanzania');
    expect(describeIntentGraph(graph, (c) => ({ KE: 'Kenya', TZ: 'Tanzania' })[c] ?? null)).toMatch(/Several countries in one trip \(Kenya, Tanzania\)/);
  });

  it('Japan and South Korea keeps South Korea whole', () => {
    const graph = parseDestinationIntent('Japan and South Korea');
    expect(graph.children.map((c) => c.countryCode)).toEqual(['JP', 'KR']);
    expect(graph.crossBorder).toBe(true);
  });

  it('Patagonia is one named place with no country claimed', () => {
    const graph = parseDestinationIntent('Patagonia');
    expect(graph.children).toHaveLength(1);
    expect(graph.children[0]!.kind).toBe('named_place');
    expect(graph.countries).toEqual([]);
    expect(graph.relationship).toBe('single');
    expect(graph.confidence).toBe('low');
  });

  it('Chilean and Argentine Patagonia is the same landscape in two countries', () => {
    const graph = parseDestinationIntent('Chilean and Argentine Patagonia');
    expect(graph.children.map((c) => [c.label, c.countryCode])).toEqual([
      ['Chilean Patagonia', 'CL'],
      ['Argentine Patagonia', 'AR'],
    ]);
    expect(graph.crossBorder).toBe(true);
    expect(graph.relationship).toBe('multi_region_trip');
  });

  it('rural Japan is a described part of one country', () => {
    const graph = parseDestinationIntent('rural Japan');
    expect(graph.children[0]!.kind).toBe('vague_region');
    expect(graph.children[0]!.qualifiers).toEqual(['rural']);
    expect(graph.children[0]!.countryCode).toBe('JP');
    expect(graph.relationship).toBe('country_subset');
    expect(interpretationTypeOf(graph)).toBe('descriptive_area');
  });

  it('New York City and NYC are cities', () => {
    expect(parseDestinationIntent('New York City').children[0]!.kind).toBe('city');
    expect(parseDestinationIntent('NYC').children[0]!.kind).toBe('city');
  });

  it('Hokkaido, Chongqing and Scotland are single named places the resolver will type', () => {
    for (const phrase of ['Hokkaido', 'Chongqing']) {
      const graph = parseDestinationIntent(phrase);
      expect(graph.children).toHaveLength(1);
      expect(graph.children[0]!.kind).toBe('named_place');
      expect(graph.relationship).toBe('single');
    }
    /* Scotland is not in the bundled country table (it is part of GB), so it is a named place too. */
    expect(parseDestinationIntent('Scotland').children[0]!.kind).toBe('named_place');
  });

  it('Scottish Highlands and Edinburgh is a region plus a city in one country', () => {
    const graph = parseDestinationIntent('Scottish Highlands and Edinburgh');
    expect(graph.children.map((c) => [c.kind, c.countryCode])).toEqual([
      ['mountain_range', 'GB'],
      ['named_place', undefined],
    ]);
    expect(graph.crossBorder).toBe(false);
    expect(graph.relationship).toBe('city_plus_region');
  });

  it('Okavango Delta is a natural region because of the word delta', () => {
    const graph = parseDestinationIntent('Okavango Delta');
    expect(graph.children[0]!.kind).toBe('natural_region');
    expect(graph.children[0]!.landscape).toBe('delta');
    expect(interpretationTypeOf(graph)).toBe('natural_area');
  });

  it('Provence + Côte d’Azur is two areas in one trip', () => {
    const graph = parseDestinationIntent('Provence + Côte d’Azur');
    expect(graph.children.map((c) => c.label)).toEqual(['Provence', 'Côte d’Azur']);
    expect(graph.relationship).toBe('multi_region_trip');
  });

  it('the Alps, the Balkans, the Dalmatian Coast, the Eastern Sierra read as landscapes', () => {
    expect(parseDestinationIntent('the Alps').children[0]!.kind).toBe('mountain_range');
    expect(parseDestinationIntent('the Dalmatian Coast').children[0]!.kind).toBe('coast');
    expect(parseDestinationIntent('the Eastern Sierra').children[0]!.kind).toBe('mountain_range');
    expect(parseDestinationIntent('the Balkans').children[0]!.kind).toBe('named_place');
  });

  it('Paris and Provence, Lisbon to Porto', () => {
    expect(parseDestinationIntent('Paris and Provence').relationship).toBe('multi_region_trip');
    const corridor = parseDestinationIntent('Lisbon to Porto');
    expect(corridor.relationship).toBe('corridor');
    expect(corridor.children.map((c) => c.label)).toEqual(['Lisbon', 'Porto']);
  });

  it('a bare country is shown in its reference spelling and is high confidence', () => {
    const graph = parseDestinationIntent('japan');
    expect(graph.travellerLabel).toBe('Japan');
    expect(graph.children[0]!.kind).toBe('country');
    expect(graph.confidence).toBe('high');
  });

  it('never rewrites the traveller’s words on a composite', () => {
    expect(parseDestinationIntent('  Kenya   and Tanzania ').rawText).toBe('Kenya and Tanzania');
  });
});

describe('attachIntentResolutions + envelope', () => {
  it('unions the children into one envelope and raises confidence', () => {
    const graph = parseDestinationIntent('Kenya and Tanzania');
    const resolved = attachIntentResolutions(
      graph,
      new Map([
        [graph.children[0]!.id, { label: 'Kenya', center: { lat: -1.29, lng: 36.82 }, source: 'reference' as const, countryCode: 'KE' }],
        [graph.children[1]!.id, { label: 'Tanzania', center: { lat: -6.79, lng: 39.28 }, bounds: { southWest: { lat: -11.7, lng: 29.3 }, northEast: { lat: -1, lng: 40.4 } }, source: 'reference' as const, countryCode: 'TZ' }],
      ]),
    );
    expect(resolved.envelope?.bounds).toEqual({ southWest: { lat: -11.7, lng: 29.3 }, northEast: { lat: -1, lng: 40.4 } });
    expect(resolved.envelope?.center.lat).toBeCloseTo((-1.29 + -6.79) / 2, 5);
    expect(resolved.confidence).toBe('high');
  });

  it('a single point resolves to a centre with no box', () => {
    expect(envelopeOf([{ center: { lat: 1, lng: 2 } }])).toEqual({ center: { lat: 1, lng: 2 } });
  });
});

describe('buildDestinationIntent reads the graph', () => {
  it('a two-country phrase with no resolution is multi_area with both countries and never unresolved', () => {
    const intent = buildDestinationIntent({ rawText: 'Kenya and Tanzania', now: NOW });
    expect(intent.interpretationType).toBe('multi_area');
    expect(intent.countries).toEqual(['KE', 'TZ']);
    expect(intent.graph?.crossBorder).toBe(true);
    expect(intent.interpretedLabel).toBe('Kenya and Tanzania');
  });

  it('a resolved graph lends its envelope to the intent', () => {
    const graph = attachIntentResolutions(parseDestinationIntent('Kenya and Tanzania'), new Map([[parseDestinationIntent('Kenya and Tanzania').children[0]!.id, { label: 'Kenya', center: { lat: -1.29, lng: 36.82 }, source: 'reference' as const }]]));
    const intent = buildDestinationIntent({ rawText: 'Kenya and Tanzania', graph, now: NOW });
    expect(intent.center).toEqual({ lat: -1.29, lng: 36.82 });
  });

  it('a phrase nobody can place is still a valid intent', () => {
    const intent = buildDestinationIntent({ rawText: 'the steppes', now: NOW });
    expect(intent.interpretationType).toBe('natural_area');
    expect(intent.interpretedLabel).toBe('the steppes');
  });
});

describe('V1 — a list closed by a comma names its container', () => {
  it('reads "A, B and C, D" as parts inside D, and leaves D a part of the trip', () => {
    const graph = parseDestinationIntent('Moab, Arches, Canyonlands and Capitol Reef, Utah');
    const labels = graph.children.map((c) => c.label);
    expect(labels[labels.length - 1]).toBe('Utah');
    for (const child of graph.children.slice(0, -1)) expect(child.within).toBe('Utah');
    expect(graph.children[graph.children.length - 1]!.within).toBeUndefined();
  });

  it('leaves a plain list alone', () => {
    for (const phrase of ['Kyoto, Osaka and Nara', 'Lisbon and Porto', 'Moab, Utah']) {
      expect(parseDestinationIntent(phrase).children.every((c) => c.within === undefined), phrase).toBe(true);
    }
  });
});

describe('a place and the country it is in', () => {
  it('"City, Country" is one place qualified by its country, never the country as a second destination', () => {
    for (const [text, code] of [['Zurich, Switzerland', 'CH'], ['Hanoi, Vietnam', 'VN'], ['Cusco, Peru', 'PE']] as const) {
      const graph = parseDestinationIntent(text);
      expect(graph.relationship).toBe('single');
      expect(graph.children).toHaveLength(1);
      expect(graph.children[0]!.countryCode).toBe(code);
      expect(graph.children[0]!.kind).not.toBe('country');
      expect(graph.children[0]!.label).toBe(text.split(',')[0]);
    }
  });

  it('a list of places still splits, and two countries stay two countries', () => {
    expect(parseDestinationIntent('Tokyo, Kyoto').children).toHaveLength(2);
    expect(parseDestinationIntent('France, Italy').children.map((c) => c.kind)).toEqual(['country', 'country']);
  });
});
