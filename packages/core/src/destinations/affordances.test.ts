import { describe, expect, it } from 'vitest';
import type { DestinationTrait } from '../interview/traits';
import type { TravelReality } from '../reality/schema';
import { affords, deriveAffordances } from './affordances';

const profile = (traits: DestinationTrait[], reality?: TravelReality | null) =>
  deriveAffordances({ destination: { traits, basis: Object.fromEntries(traits.map((t) => [t, `screened as ${t}`])) }, ...(reality !== undefined ? { reality } : {}) });

describe('V12 §4 — what a place affords, from what was screened about it', () => {
  it('reads styles off the traits, and carries the basis that produced each one', () => {
    const city = profile(['dense_urban', 'walk_heavy', 'food_dense']);
    expect(affords(city, 'urban_culture')).toBe('strong');
    expect(affords(city, 'neighbourhood_immersion')).toBe('strong');
    expect(affords(city, 'urban_food')).toBe('strong');
    for (const affordance of city.affordances) expect(affordance.basis).not.toBe('');
  });

  it('says a style is weak where the ground says so, which is not the same as absent', () => {
    const wilderness = profile(['wilderness', 'remote']);
    expect(affords(wilderness, 'urban_nightlife')).toBe('weak');
    expect(affords(wilderness, 'remote_wilderness')).toBe('strong');
    /* A style nothing spoke to is unknown, and unknown is its own answer. */
    expect(affords(wilderness, 'rail_journey')).toBe('unknown');
  });

  it('treats an unscreenable destination as unknown, never as a place that affords nothing', () => {
    const nothing = profile([]);
    expect(nothing.unknown).toBe(true);
    expect(affords(nothing, 'urban_culture')).toBe('unknown');
    expect(nothing.affordances).toHaveLength(0);
  });

  it('withdraws a style whose mode the country says is unavailable, and only then', () => {
    const islands: DestinationTrait[] = ['beach', 'island', 'archipelago'];
    expect(affords(profile(islands), 'island_hopping')).toBe('strong');

    const noFerries = {
      version: 1,
      countryCode: 'XX',
      modes: [{ mode: 'ferry', scope: 'all', status: 'unavailable', reason: 'No ferry network here.', authority: 'reference', freshness: 'stable', asOf: '2026-01-01' }],
      facts: [],
      recommendation: undefined,
    } as unknown as TravelReality;
    expect(affords(profile(islands, noFerries), 'island_hopping')).toBe('unknown');

    /* `unknown` is not `unavailable`: a country that says nothing removes nothing. */
    const silent = { version: 1, countryCode: 'XX', modes: [], facts: [] } as unknown as TravelReality;
    expect(affords(profile(islands, silent), 'island_hopping')).toBe('strong');
  });

  it('reports how a place works, separately from what it is good for', () => {
    const mountains = profile(['mountain', 'road_trip_region', 'car_dependent', 'weather_exposed', 'high_altitude']);
    const traits = mountains.operationalTraits.map((entry) => entry.trait);
    expect(traits).toContain('car_or_shuttle_dependence');
    expect(traits).toContain('weather_exposed_access');
    expect(traits).toContain('altitude_exposure');
    /* Operational traits are planning facts, not dated claims: none of them asserts anything is open. */
    for (const entry of mountains.operationalTraits) expect(entry.basis).not.toMatch(/open|closed|running/i);
  });

  it('names no destination anywhere in its own source', async () => {
    /*
     * §5's rule, enforced rather than trusted. The file may describe ground and
     * modes; the moment it mentions a place it has started answering "what trip
     * is this?" with "where is it?".
     */
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('./affordances.ts', import.meta.url), 'utf8');
    /*
     * The *code*, not the prose. The doc comment names places deliberately — it
     * is explaining which shortcut is forbidden, using the brief's own examples —
     * and a rule that could not be explained with an example would be a worse
     * rule. What may never contain a place is a table, a condition or a literal.
     */
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    for (const place of ['Paris', 'Rwanda', 'Maldives', 'Iceland', 'Japan', 'Peru', 'Kyrgyzstan', 'Rockies', 'Tokyo', 'Morocco', 'Okavango']) {
      expect(code, `${place} must not appear in the affordance derivation`).not.toContain(place);
    }
  });
});
