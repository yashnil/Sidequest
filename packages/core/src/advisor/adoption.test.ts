import { describe, expect, it } from 'vitest';
import { parseDestinationIntent } from '../destinations/intent-graph';
import { destinationCatalog } from './catalog';
import { adoptionPhrase } from './adoption';

describe('a chosen region is planned as its own places, never as one of its towns', () => {
  it('a region that resolved as one of its own bases lists its bases inside the country', () => {
    expect(adoptionPhrase({ kind: 'travel_region', resolveAs: 'Fes, Morocco', bases: ['Fes', 'Chefchaouen', 'Meknes'] }, 10)).toBe('Fes, Chefchaouen and Meknes, Morocco');
    expect(adoptionPhrase({ kind: 'travel_region', resolveAs: 'Fes, Morocco', bases: ['Fes', 'Chefchaouen', 'Meknes'] }, 4)).toBe('Fes and Chefchaouen, Morocco');
    /* The resolved town leads, a base's note is not its name, and the region's own country closes it. */
    expect(adoptionPhrase({ kind: 'travel_region', resolveAs: 'La Fortuna, Alajuela, Costa Rica', bases: ['La Fortuna', 'Santa Elena (Monteverde)'] }, 7)).toBe('La Fortuna and Santa Elena, Costa Rica');
    expect(adoptionPhrase({ kind: 'travel_region', resolveAs: 'Ella, Sri Lanka', bases: ['Kandy', 'Nuwara Eliya', 'Ella'] }, 8)).toBe('Ella, Kandy and Nuwara Eliya, Sri Lanka');
  });

  it('a region that resolves as itself, a city, a single base, or a country the reference does not know is left exactly as it was', () => {
    expect(adoptionPhrase({ kind: 'island_group', resolveAs: 'Caye Caulker, Belize', bases: ['San Pedro (Ambergris Caye)', 'Caye Caulker'] }, 7)).toBe('Caye Caulker, Belize');
    expect(adoptionPhrase({ kind: 'island_group', resolveAs: 'Lofoten, Norway', bases: ['Reine', 'Svolvær', 'Henningsvær'] }, 7)).toBe('Lofoten, Norway');
    expect(adoptionPhrase({ kind: 'city', resolveAs: 'Lisbon, Portugal', bases: ['Lisbon', 'Sintra'] }, 7)).toBe('Lisbon, Portugal');
    expect(adoptionPhrase({ kind: 'national_park', resolveAs: 'Stepantsminda, Georgia', bases: ['Stepantsminda'] }, 5)).toBe('Stepantsminda, Georgia');
  });

  it('every phrase it makes from the curated catalog parses into the listed towns inside one country', () => {
    let changed = 0;
    for (const entry of destinationCatalog()) {
      const phrase = adoptionPhrase(entry, 10);
      if (phrase === entry.resolveAs) continue;
      changed += 1;
      const graph = parseDestinationIntent(phrase);
      const towns = graph.children.filter((c) => c.kind !== 'country');
      expect(towns.length, phrase).toBeGreaterThanOrEqual(2);
      expect(towns.every((c) => c.within !== undefined), phrase).toBe(true);
      expect(graph.crossBorder, phrase).toBe(false);
    }
    expect(changed).toBeGreaterThan(30);
  });
});
