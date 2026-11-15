import { describe, expect, it } from 'vitest';
import { conceptCacheKeyFor, resolveDestinationPhrase, type ConceptCache } from './intent-resolution';
import { fixtureInterpreter } from './interpretation';
import { recordedResolver } from './fixtures/recorded-resolver';

/**
 * FINAL PASS — AN `UNKNOWN` READING IS NEVER KEPT OR SERVED.
 *
 * Staging served "Tanzania safari" from the thirty-day concept cache as an
 * unknown, settlement-scale reading; the placement reach that follows from a
 * settlement put the Serengeti and Ngorongoro outside the trip. A stale or
 * degraded reading is exactly what a retry might improve.
 */
const NOW = new Date('2026-11-14T00:00:00Z');

function memoryCache(): ConceptCache & { store: Map<string, unknown> } {
  const store = new Map<string, unknown>();
  return { store, read: (k) => (store.get(k) as never) ?? null, write: (k, v) => void store.set(k, v) };
}

describe('the thirty-day concept cache', () => {
  it('never serves a stored unknown reading: the phrase is resolved afresh', async () => {
    const cache = memoryCache();
    const fresh = await resolveDestinationPhrase({ text: 'Tanzania safari', resolver: recordedResolver([]), now: NOW, interpreter: fixtureInterpreter() });
    cache.store.set(conceptCacheKeyFor('Tanzania safari'), { concept: { ...fresh.semantics, type: 'unknown', scale: 'settlement' }, resolution: fresh.resolution });
    const again = await resolveDestinationPhrase({ text: 'Tanzania safari', resolver: recordedResolver([]), now: NOW, interpreter: fixtureInterpreter(), cache });
    expect(again.outcome.timings.cacheHit).toBe(false);
    expect(again.semantics.type).toBe('country');
  });

  it('a good reading is kept and served', async () => {
    const cache = memoryCache();
    await resolveDestinationPhrase({ text: 'Kenya and Tanzania', resolver: recordedResolver([]), now: NOW, interpreter: fixtureInterpreter(), cache });
    const hit = await resolveDestinationPhrase({ text: 'Kenya and Tanzania', resolver: recordedResolver([]), now: NOW, interpreter: fixtureInterpreter(), cache });
    expect(hit.outcome.timings.cacheHit).toBe(true);
    expect(hit.semantics.type).toBe('multi_country');
  });
});
