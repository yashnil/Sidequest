import { describe, expect, it } from 'vitest';
import { candidatesFrom, pickMatches, sameName, searchNames, sparqlFor } from './wikidata-link';

const here = { lat: 44.28, lng: -73.98 };
const near = { lat: 44.285, lng: -73.985 }; // ~0.7 km
const far = { lat: 44.6, lng: -73.5 }; // ~50 km

describe('wikidata link', () => {
  it('reads names as the same only when one is the other plus at most a type word', () => {
    expect(sameName('Mirror Lake', 'Mirror Lake')).toBe(true);
    expect(sameName('Mirror Lake', 'Mirror Lake Park')).toBe(true);
    expect(sameName('Lake', 'Lake Placid')).toBe(false);
    expect(sameName('Cascade Mountain', 'Cascade Mountain Ski Resort Area')).toBe(false);
  });

  it('searches the proposed name and the name without a generic tail', () => {
    expect(searchNames('Fort William Henry Museum')).toEqual(['Fort William Henry Museum', 'Fort William Henry']);
    expect(searchNames('Ausable Chasm')).toEqual(['Ausable Chasm']);
  });

  it('accepts the nearest same-named item inside the radius and never a same-named place elsewhere', () => {
    const subjects = [{ key: 'a', name: 'Mirror Lake', coordinates: here }];
    const matches = pickMatches(subjects, [
      { name: 'Mirror Lake', item: 'Q1', label: 'Mirror Lake', coordinates: far },
      { name: 'Mirror Lake', item: 'Q2', label: 'Mirror Lake', coordinates: near },
    ], 5);
    expect(matches.get('a')).toBe('Q2');
    expect(pickMatches(subjects, [{ name: 'Mirror Lake', item: 'Q1', label: 'Mirror Lake', coordinates: far }], 5).size).toBe(0);
  });

  it('holds a looser word match to a tight radius, and never takes one item for two stops', () => {
    const contained = [{ name: 'Robert Louis Stevenson Cottage', item: 'Q3', label: 'Stevenson Cottage', coordinates: { lat: 44.31, lng: -73.98 } }];
    expect(pickMatches([{ key: 'h', name: 'Robert Louis Stevenson Cottage', coordinates: here }], contained, 5).size).toBe(0);
    expect(pickMatches([{ key: 'h', name: 'Robert Louis Stevenson Cottage', coordinates: here }], [{ ...contained[0]!, coordinates: near }], 5).get('h')).toBe('Q3');
    const twice = pickMatches(
      [{ key: 'a', name: 'Mirror Lake', coordinates: here }, { key: 'b', name: 'Mirror Lake', coordinates: here }],
      [{ name: 'Mirror Lake', item: 'Q2', label: 'Mirror Lake', coordinates: near }],
      5,
    );
    expect([...twice.values()]).toEqual(['Q2']);
  });

  it('escapes names in the query and parses the answer', () => {
    expect(sparqlFor(['Owl "Head"'])).toContain('"Owl \\"Head\\""');
    expect(candidatesFrom([{ name: { value: 'X' }, item: { value: 'http://www.wikidata.org/entity/Q42' }, label: { value: 'X' }, coord: { value: 'Point(-73.98 44.28)' } }])).toEqual([
      { name: 'X', item: 'Q42', label: 'X', coordinates: { lat: 44.28, lng: -73.98 } },
    ]);
  });
});
