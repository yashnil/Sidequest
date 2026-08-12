import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CLARIFICATION_SET_VERSION, type ClarificationSet } from '@sidequest/core';
import { deriveScope } from '@sidequest/compiler';
import { SYNTHETIC_WORLDS, syntheticCandidate, syntheticPack } from '@sidequest/compiler/testing';
import { createOpenProviders } from './live';

/**
 * THE TWO PLACES A COMPILATION USED TO GIVE UP EARLY, EXERCISED OFFLINE.
 *
 * No network: no POI service is configured in this environment, which is
 * exactly the deployment these tests are about. `SIDEQUEST_POI_PROVIDER` being
 * unset is the *normal* state — the public endpoint is policy-forbidden for
 * production — and both defects below only appear in it:
 *
 *   1. The food stage returned the pack's answer and stopped, so a region whose
 *      pack held three restaurants got a three-restaurant trip with no gap
 *      recorded and no attempt to look further.
 *   2. A deficit-directed acquisition returned "there is no map service" and the
 *      traveller was told we had found nothing for the thing they said the trip
 *      was for — while a fetched pack sat in memory with the answer in it,
 *      behind a density ceiling meant for a general-purpose read.
 */

/**
 * A placeholder credential, and nothing here can spend it.
 *
 * `createOpenProviders` builds a research model eagerly and that constructor
 * refuses to exist without a key. Every path exercised below is pack-backed and
 * reaches no model at all — `maxModelCalls: 0` makes that a hard ceiling as
 * well as an intention — so the string only has to be non-empty. Stubbed rather
 * than read, so the suite never touches a real environment file.
 */
beforeAll(() => {
  vi.stubEnv('ANTHROPIC_API_KEY', 'offline-test-placeholder');
});
afterAll(() => {
  vi.unstubAllEnvs();
});

function emptyClarifications(): ClarificationSet {
  return { schemaVersion: CLARIFICATION_SET_VERSION, questions: [], answers: [] };
}

function worldFixture(key: keyof typeof SYNTHETIC_WORLDS) {
  const spec = SYNTHETIC_WORLDS[key]!;
  const candidate = syntheticCandidate(spec);
  const scope = {
    ...deriveScope({
      candidate,
      clarifications: emptyClarifications(),
      nights: 5,
      revision: 1,
    }),
    confirmedByUser: true,
  };
  return { spec, scope, pack: syntheticPack(spec, scope) };
}

describe('food does not stop at whatever the pack happened to hold', () => {
  it('ranks the pool before applying the ceiling, not the other way round', async () => {
    const { scope, pack } = worldFixture('transit_city');
    const { providers } = createOpenProviders({ maxModelCalls: 0 });

    const generous = await providers.food.discover({
      scope,
      places: [],
      bases: [{ id: 'base-1', coordinates: scope.center }],
      maxVenues: 50,
      pack,
    });
    const tight = await providers.food.discover({
      scope,
      places: [],
      bases: [{ id: 'base-1', coordinates: scope.center }],
      maxVenues: 2,
      pack,
    });

    expect(generous.venues.length).toBeGreaterThan(0);
    expect(tight.venues.length).toBeLessThanOrEqual(2);
    /*
     * The cut is applied to a *ranked* pool, so the two venues a tight budget
     * keeps are the two the generous budget rates highest — not the two that
     * happened to be read off disk first. This is the property that stopped a
     * franchise pizza counter displacing a distinctive local kitchen.
     */
    const topOfGenerous = generous.venues.slice(0, tight.venues.length).map((v) => v.id).sort();
    expect(tight.venues.map((v) => v.id).sort()).toEqual(topOfGenerous);
  });

  it('records a limitation when the pack is all there is and it is thin', async () => {
    const { scope, pack } = worldFixture('transit_city');
    const { providers } = createOpenProviders({ maxModelCalls: 0 });

    const result = await providers.food.discover({
      scope,
      places: [],
      bases: [{ id: 'base-1', coordinates: scope.center }],
      // Far more than the pack can supply, and no second service configured.
      maxVenues: 500,
      pack,
    });

    expect(result.venues.length).toBeGreaterThan(0);
    /*
     * §8.2: if bounded targeted acquisition genuinely cannot run, explain the
     * limitation succinctly rather than shipping a thin answer that reads as a
     * complete one. Before this the shortfall was silent.
     */
    const shortfall = result.gaps.find((gap) => gap.subjectId === 'food');
    expect(shortfall).toBeDefined();
    expect(shortfall!.detail).toMatch(/no second map service/i);
  });
});

describe('a deficit-directed look reads the pack again rather than giving up', () => {
  it('returns records the broad read held back, without a network call', async () => {
    const { scope, pack } = worldFixture('broad_country');
    /*
     * A pack dense in one category, which is the state the density ceiling
     * exists for and the state a directed look has to be able to see past. The
     * broad read is *right* to hold most of these back — a board of fifty-nine
     * museums is not a trip — and it is the reason a traveller who came for
     * museums was told we had found nothing for them.
     */
    const denseInCulture = {
      ...pack,
      layers: pack.layers.map((layer) => ({
        ...layer,
        records: layer.records.map((record) => ({
          ...record,
          sourceCategory: 'museum',
          sourceCategoryPath: ['arts_and_entertainment', 'museum'],
        })),
      })),
    };
    const { providers } = createOpenProviders({ maxModelCalls: 0 });

    // The broad read first, which is what establishes the cached inventory the
    // acquisition must be additive against.
    const broad = await providers.places.discover({
      scope,
      queries: [],
      pack: denseInCulture,
    });
    expect(broad.candidates.length).toBeGreaterThan(0);

    const acquired = await providers.places.discover({
      scope,
      queries: [],
      pack: denseInCulture,
      acquire: { intents: ['culture'], maxRecords: 40, scopeClass: 'category_in_scope_bbox' },
    });

    // The whole point: the second look finds something the first one did not.
    expect(acquired.candidates.length).toBeGreaterThan(0);
    // Never a network call, and never reported as one.
    expect(acquired.calls).toBe(0);

    const broadIds = new Set(broad.candidates.map((candidate) => candidate.place.id));
    for (const candidate of acquired.candidates) {
      // Additive only: a directed look must never return a narrower version of
      // the inventory it is topping up.
      expect(broadIds.has(candidate.place.id)).toBe(false);
      // And only the kind of thing that was asked for.
      expect(['museum', 'historic_site', 'national_monument']).toContain(
        candidate.place.category,
      );
    }
  });

  it('says so honestly when the pack really has nothing more of that kind', async () => {
    const { scope, pack } = worldFixture('transit_city');
    const { providers } = createOpenProviders({ maxModelCalls: 0 });
    await providers.places.discover({ scope, queries: [], pack });

    const acquired = await providers.places.discover({
      scope,
      queries: [],
      pack,
      // An intent this fixture's records cannot satisfy at all.
      acquire: { intents: ['provisioning'], maxRecords: 10, scopeClass: 'category_in_scope_bbox' },
    });

    expect(acquired.candidates).toEqual([]);
    expect(acquired.gaps[0]?.reason).toBe('not_found');
    expect(acquired.gaps[0]?.detail).toMatch(/second time/i);
  });

  it('still refuses when there is no pack and no service', async () => {
    const { scope } = worldFixture('transit_city');
    const { providers } = createOpenProviders({ maxModelCalls: 0 });

    const acquired = await providers.places.discover({
      scope,
      queries: [],
      acquire: { intents: ['culture'], maxRecords: 10, scopeClass: 'category_in_scope_bbox' },
    });

    expect(acquired.candidates).toEqual([]);
    expect(acquired.gaps[0]?.reason).toBe('provider_error');
  });
});
