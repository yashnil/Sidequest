import { describe, expect, it } from 'vitest';
import { capabilityRegistry } from './capabilities.mjs';

/**
 * THE CAPABILITY THAT FAILED IN PRODUCTION IS NOW ONE THE REGISTRY KNOWS ABOUT.
 *
 * A deployment placed nothing anybody typed, and neither `npm run doctor` nor the
 * readiness endpoint could have predicted it, because "can a typed name become a
 * place" was not a capability in the registry. An operator's report is only as
 * good as the list of things it reports on.
 */
describe('destination capabilities', () => {
  it('reports resolution as configured even with nothing set, because the reference is bundled', () => {
    const registry = capabilityRegistry({ ANTHROPIC_API_KEY: 'x' });
    const resolution = registry.byId['destinations.resolution'];
    expect(resolution?.configured).toBe(true);
    /* `sidequest` rather than a provider name: the reference is our own data, and `mode` is computed from that distinction. */
    expect(resolution?.provider).toBe('sidequest');
  });

  it('names the exact variable that would place a city, when no geocoder is set', () => {
    const registry = capabilityRegistry({ ANTHROPIC_API_KEY: 'x' });
    expect(registry.byId['destinations.resolution']?.limitations.join(' ')).toMatch(/SIDEQUEST_GEOCODER_PROVIDER=nominatim/);
  });

  /*
   * The registry's `mode` is computed from whether any capability names a real,
   * costed provider. Bundled data is not one — `lodging.area` set that precedent
   * — so an offline deployment must not become "mixed" merely by shipping a
   * country table. Every provider is pinned off here so that the only thing under
   * test is this capability's contribution.
   */
  it('does not make an offline deployment look live merely by holding bundled reference data', () => {
    const offline = capabilityRegistry({ SIDEQUEST_COMPOSER_PROVIDER: 'fixture', SIDEQUEST_WEATHER_PROVIDER: 'off', SIDEQUEST_IMAGERY_PROVIDER: 'off', SIDEQUEST_CLIMATE_PROVIDER: 'off', SIDEQUEST_FX_PROVIDER: 'off' });
    expect(offline.byId['destinations.resolution']?.provider).toBe('sidequest');
    expect(offline.byId['destinations.resolution']?.costClass).toBe('none');
    expect(offline.mode).toBe('fixture');
  });

  it('reports the geocoder once it is configured, and stops complaining', () => {
    const registry = capabilityRegistry({ ANTHROPIC_API_KEY: 'x', SIDEQUEST_GEOCODER_PROVIDER: 'nominatim' });
    expect(registry.byId['destinations.resolution']?.provider).toBe('nominatim');
    expect(registry.byId['destinations.resolution']?.limitations).toEqual([]);
  });

  it('reports the typeahead index separately, because an absent index is not an absent product', () => {
    const off = capabilityRegistry({ ANTHROPIC_API_KEY: 'x' });
    expect(off.byId['destinations.suggestions']?.configured).toBe(false);
    expect(off.byId['destinations.suggestions']?.limitations.join(' ')).toMatch(/free text/);
    const on = capabilityRegistry({ ANTHROPIC_API_KEY: 'x', SIDEQUEST_DESTINATION_INDEX_SEED: 'seed.ndjson' });
    expect(on.byId['destinations.suggestions']?.configured).toBe(true);
  });
});
