import { describe, expect, it } from 'vitest';
import { catalogDestinationSchema, CONTINENT_OF, EXPERIENCES, WORLD_REGIONS } from './schema';
import { AFRICA_MIDDLE_EAST } from './regions/africa-middle-east';
import { ASIA } from './regions/asia';
import { EUROPE } from './regions/europe';
import { NORTH_AMERICA } from './regions/north-america';
import { SOUTH_AMERICA_OCEANIA } from './regions/south-america-oceania';
import { EXAMPLE } from './regions/example';

const FILES = { EUROPE, NORTH_AMERICA, SOUTH_AMERICA_OCEANIA, AFRICA_MIDDLE_EAST, ASIA };
const ALL = Object.values(FILES).flat();

describe('destination catalog', () => {
  it('the template parses', () => {
    for (const entry of EXAMPLE) expect(() => catalogDestinationSchema.parse(entry)).not.toThrow();
  });

  for (const [name, entries] of Object.entries(FILES)) {
    it(`${name}: every entry parses and is internally consistent`, () => {
      for (const entry of entries) {
        const result = catalogDestinationSchema.safeParse(entry);
        expect(result.success, `${entry.id}: ${result.success ? '' : JSON.stringify(result.error.issues.slice(0, 3))}`).toBe(true);
        const e = result.data!;
        expect(e.nights.min <= e.nights.ideal && e.nights.ideal <= e.nights.max, `${e.id} nights order`).toBe(true);
        expect(e.challenge.easiest <= e.challenge.typical, `${e.id} challenge order`).toBe(true);
        expect(Math.max(...e.season), `${e.id} has no good month at all`).toBeGreaterThanOrEqual(2);
        expect(Object.values(e.experiences).some((value) => value === 3), `${e.id} has no signature experience`).toBe(true);
        expect(e.lodging.simple || e.lodging.comfortable || e.lodging.luxury, `${e.id} has nowhere to sleep`).toBe(true);
        /* A whole-country circuit resolves as the country's own name; anything smaller names its country after a comma. */
        if (e.kind !== 'country_circuit') expect(e.resolveAs.includes(','), `${e.id} resolveAs should name the country`).toBe(true);
        /* "Montenegro, Montenegro" names a country twice and becomes the trip's title that way. */
        const parts = e.resolveAs.split(',').map((part) => part.trim().toLowerCase());
        if (parts.length > 1) expect(parts[0], `${e.id} resolveAs repeats its country`).not.toBe(parts[parts.length - 1]);
      }
    });
  }

  it('ids are unique across the whole catalog', () => {
    const ids = ALL.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('wikidata ids are unique (one item cannot be two destinations)', () => {
    const qids = ALL.map((entry) => entry.wikidataId).filter(Boolean);
    expect(new Set(qids).size).toBe(qids.length);
  });

  it('covers the world rather than one corner of it', () => {
    if (ALL.length < 150) return; // still being authored
    const regions = new Set(ALL.map((entry) => entry.worldRegion));
    expect(regions.size).toBeGreaterThanOrEqual(WORLD_REGIONS.length - 2);
    const continents = new Map<string, number>();
    for (const entry of ALL) continents.set(CONTINENT_OF[entry.worldRegion], (continents.get(CONTINENT_OF[entry.worldRegion]) ?? 0) + 1);
    for (const continent of ['europe', 'asia', 'africa', 'americas', 'oceania']) {
      expect(continents.get(continent) ?? 0, continent).toBeGreaterThanOrEqual(15);
    }
    // No single region holds more than a fifth of the catalog.
    const largest = Math.max(...[...regions].map((region) => ALL.filter((entry) => entry.worldRegion === region).length));
    expect(largest / ALL.length).toBeLessThan(0.2);
  });

  it('is not a list of famous places: little-known destinations are well represented', () => {
    if (ALL.length < 150) return;
    const lesserKnown = ALL.filter((entry) => entry.familiarity <= 1).length;
    expect(lesserKnown / ALL.length).toBeGreaterThan(0.3);
  });

  it('every experience is offered strongly somewhere', () => {
    if (ALL.length < 150) return;
    for (const experience of EXPERIENCES) {
      expect(ALL.filter((entry) => (entry.experiences[experience] ?? 0) >= 2).length, experience).toBeGreaterThanOrEqual(3);
    }
  });

  it('southern-hemisphere entries do not copy the northern season', () => {
    for (const entry of ALL) {
      if (entry.center.lat < -30) {
        const julyHigh = entry.highC[6]!;
        const januaryHigh = entry.highC[0]!;
        expect(januaryHigh, `${entry.id} January should be warmer than July`).toBeGreaterThanOrEqual(julyHigh);
      }
      if (entry.center.lat > 30) {
        expect(entry.highC[6]!, `${entry.id} July should be warmer than January`).toBeGreaterThanOrEqual(entry.highC[0]!);
      }
    }
  });
});
