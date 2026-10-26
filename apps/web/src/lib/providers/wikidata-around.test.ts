import { describe, expect, it } from 'vitest';
import { elementsFromBindings, sparqlAround } from './wikidata-around';

const row = (id: string, label: string | null, classes: string[], sitelinks: number, point = 'Point(139.79 35.71)', population?: number) => ({
  item: { value: `http://www.wikidata.org/entity/${id}` },
  coord: { value: point },
  sitelinks: { value: String(sitelinks) },
  classes: { value: classes.map((c) => `http://www.wikidata.org/entity/${c}`).join(',') },
  ...(label ? { label: { value: label } } : {}),
  ...(population ? { population: { value: String(population) } } : {}),
});

describe('elementsFromBindings', () => {
  it('carries the countries Wikidata states, and nothing when it states none', () => {
    const { elements } = elementsFromBindings([
      { ...row('Q1', 'Lake Lugano', ['Q23397'], 40), countries: { value: 'ch,IT' } },
      row('Q2', 'Somewhere Lake', ['Q23397'], 40),
    ]);
    expect(elements[0]!.tags?.['sidequest:countries']).toBe('CH,IT');
    expect(elements[1]!.tags?.['sidequest:countries']).toBeUndefined();
    expect(sparqlAround({ lat: 46, lng: 9 }, 50, 6)).toContain('wdt:P17');
  });

  it('turns typed items into map-shaped elements the kind table reads', () => {
    const { elements, sitelinks } = elementsFromBindings([
      row('Q1', 'Senso-ji', ['Q5393308'], 70),
      row('Q2', 'Tokyo National Museum', ['Q33506', 'Q207694'], 60),
      row('Q3', 'Kamakura', ['Q515'], 90, 'Point(139.55 35.32)', 170000),
    ]);
    expect(elements.map((e) => e.tags)).toEqual([
      expect.objectContaining({ amenity: 'place_of_worship', religion: 'buddhist', name: 'Senso-ji', wikidata: 'Q1', 'source:sidequest': 'wikidata' }),
      expect.objectContaining({ tourism: 'museum', name: 'Tokyo National Museum' }),
      expect.objectContaining({ place: 'city', population: '170000' }),
    ]);
    expect(elements[0]).toMatchObject({ lat: 35.71, lon: 139.79 });
    expect(sitelinks.get('Q2')).toBe(60);
  });

  it('leaves out what it cannot read: no English label, no known type, a bad point, a repeat', () => {
    const { elements } = elementsFromBindings([
      row('Q1', null, ['Q33506'], 20),
      row('Q2', 'Special ward', ['Q5327704'], 40),
      row('Q3', 'Nowhere', ['Q33506'], 20, 'not a point'),
      row('Q4', 'Museum', ['Q33506'], 20),
      row('Q4', 'Museum again', ['Q33506'], 20),
    ]);
    expect(elements.map((e) => e.tags?.name)).toEqual(['Museum']);
  });

  it('asks for the place, a radius and a notability floor', () => {
    const q = sparqlAround({ lat: 64.1466, lng: -21.9426 }, 42.4, 8);
    expect(q).toContain('Point(-21.94260 64.14660)');
    expect(q).toContain('wikibase:radius "42"');
    expect(q).toContain('?sitelinks >= 8');
  });
});
