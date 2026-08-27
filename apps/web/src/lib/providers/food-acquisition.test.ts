import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CLARIFICATION_SET_VERSION, type ClarificationSet } from '@sidequest/core';
import { buildInventory, deriveScope } from '@sidequest/compiler';
import { SYNTHETIC_WORLDS, syntheticCandidate, syntheticPack } from '@sidequest/compiler/testing';
import {
  foodDoorWalkMinutes,
  foodRoutingSnapKm,
  MODELLED_WALK_KMH,
  type GeographicScope,
  type RegionPack,
  type SourceRecord,
} from '@sidequest/core';
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
  return { spec, scope, pack: withFoodInWalkingDistance(syntheticPack(spec, scope), scope) };
}

/**
 * THE FIXTURE'S FOOD, PUT WHERE FOOD IS.
 *
 * `syntheticPack` lays its venues on the same spiral as its places but eighty
 * turns further out, so every one of them lands between 60 and 115 km from the
 * region centre and 25 to 60 km from the nearest place — a "city" whose every
 * restaurant is an hour's drive outside it. That was invisible while a venue
 * could be snapped onto any node however far away; it is the exact geometry the
 * door-walk ceiling now refuses, so a pack in that shape holds no routable venue
 * at all and the two tests below would be asserting against an empty answer for
 * a reason that has nothing to do with what either of them is about.
 *
 * So the venues are moved into the centre they belong to — a food quarter, 0.2
 * to 1.4 km out, which is the shape `walkMinutesFromRouting` was written for.
 * Nothing else about the records changes; the venue that has to be *out* of
 * reach is placed deliberately, per test, rather than by fixture accident.
 */
function withFoodInWalkingDistance(pack: RegionPack, scope: GeographicScope): RegionPack {
  /*
   * Which records this pack's *own* inventory will treat as food — not which
   * ones carry `planningRole: 'food'`. Three of the fifteen it returns here are
   * markets filed as attractions, and leaving those where they were is what a
   * first attempt at this helper did: three venues past the ceiling, an
   * unroutable gap ahead of the shortfall gap, and a test failing for a reason
   * it was not about.
   */
  const foodIds = new Set(buildInventory({ pack, scope }).foodRecords.map((record) => record.id));
  const center = scope.center;
  let index = 0;
  return {
    ...pack,
    layers: pack.layers.map((layer) => ({
      ...layer,
      records: layer.records.map((record) => {
        if (!foodIds.has(record.id)) return record;
        const angle = index * 2.399963229728653;
        const radius = 0.002 + index * 0.0008;
        index += 1;
        return {
          ...record,
          coordinates: {
            lat: center.lat + Math.cos(angle) * radius,
            lng: center.lng + Math.sin(angle) * radius,
          },
        };
      }),
    })),
  };
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

/**
 * ---- THE LEG THAT NAMED ONE PLACE AND TIMED ANOTHER -----------------------
 *
 * The evidence class, from the founder journeys: a metro day rendered
 * `Walk to <venue>` with `minutes: 8, km: 0.661, provenance: 'measured'` and a
 * `toId` belonging to a **park** 4.80 km from that venue's own record. Four of
 * four named-restaurant approach legs were wrong the same way, and a second row
 * carried the *identical* minutes and kilometres for a venue 3.27 km from the
 * same anchor.
 *
 * Two lines of code produced it. A compiled venue took `nearestAnchor(...)?.id`
 * with no distance ceiling — the anchors being the bases plus two dozen compiled
 * places, so in a metropolis the nearest is routinely kilometres off — and the
 * door walk was then hard-coded to `0`, which is what let the anchor's own
 * travel time render as a door-to-door measurement under the venue's name.
 *
 * These run the real provider, on a real pack, through the same
 * `providers.food.discover` the compiler calls.
 */

/** 0.005° of latitude — 0.56 km, and eight minutes on foot at the modelled pace. */
const NEAR_DEGREES = 0.005;
/** 0.0432° — 4.80 km, the distance the live venue sat from the park it was priced at. */
const FAR_DEGREES = 0.0432;

/**
 * One food record placed a stated number of degrees due north of the base, and
 * nothing else touched. Placed rather than nudged: the fixture has already moved
 * every venue into the centre, so an offset on top of that is a distance nobody
 * in the test can state.
 */
function relocated(
  pack: RegionPack,
  base: { lat: number; lng: number },
  moves: ReadonlyMap<string, number>,
): RegionPack {
  return {
    ...pack,
    layers: pack.layers.map((layer) => ({
      ...layer,
      records: layer.records.map((record: SourceRecord) => {
        const north = moves.get(record.id);
        return north === undefined
          ? record
          : { ...record, coordinates: { lat: base.lat + north, lng: base.lng } };
      }),
    })),
  };
}

/** Degrees of latitude to kilometres, at the earth radius `haversineKm` uses. */
const KM_PER_DEGREE = 111.19493;

/** How far a venue ended up from the only node in the test, in kilometres. */
function kmFromBase(point: { lat: number; lng: number }, base: { lat: number; lng: number }): number {
  return (
    Math.hypot(point.lat - base.lat, (point.lng - base.lng) * Math.cos((base.lat * Math.PI) / 180)) *
    KM_PER_DEGREE
  );
}

/**
 * The record ids that actually become venues on this path, read back off the
 * provider rather than guessed from the pack.
 *
 * The inventory's food records are not all venues: three of the fifteen here are
 * markets, and `foodVenueFromRecord` refuses a provisioning stop whose hours
 * nobody confirmed. Picking a record straight off the inventory picked one of
 * those first, so the "refused" venue was one the path would have dropped
 * anyway — a test that passes without the ceiling doing anything.
 */
async function routableRecordIds(): Promise<string[]> {
  const { scope, pack } = worldFixture('transit_city');
  const { providers } = createOpenProviders({ maxModelCalls: 0 });
  const result = await providers.food.discover({
    scope,
    places: [],
    bases: [{ id: 'base-1', coordinates: scope.center }],
    maxVenues: 50,
    pack,
  });
  return result.venues.map((venue) => venue.id.replace(/^food-/, ''));
}

describe('a venue is only priced against a node it is beside', () => {
  /**
   * The base is the only anchor, so "nearest" and "the base" are the same node
   * and the ceiling is the only thing that can separate them — which is the
   * shape the defect needs: with no ceiling, the far venue takes `base-1` and
   * renders the base's travel time as a walk to its door.
   */
  async function discoverWith(moves: ReadonlyMap<string, number>) {
    const { scope, pack } = worldFixture('transit_city');
    const { providers } = createOpenProviders({ maxModelCalls: 0 });
    const result = await providers.food.discover({
      scope,
      places: [],
      bases: [{ id: 'base-1', coordinates: scope.center }],
      maxVenues: 50,
      pack: relocated(pack, scope.center, moves),
    });
    return { scope, result };
  }

  it('refuses the nearest node when the nearest node is 4.8 km away', async () => {
    const farRecordId = (await routableRecordIds())[0]!;
    const { scope, result } = await discoverWith(new Map([[farRecordId, FAR_DEGREES]]));

    /*
     * Not carried with `base-1` on it, and not carried at all: `routingId` is
     * required by the schema and every consumer prices a leg to it, so a venue
     * we cannot price honestly leaves the routable pool. The planner's
     * area-level suggestion is what the traveller sees instead — a smaller
     * claim, and a true one.
     */
    expect(result.venues.map((venue) => venue.id)).not.toContain(`food-${farRecordId}`);
    /*
     * And nothing measured can be composed to it: the ids that survive are all
     * ids of venues within a door walk of the node they carry, so there is no
     * row anywhere that pairs this venue's name with another place's minutes.
     */
    for (const venue of result.venues) {
      expect(venue.routingId).toBe('base-1');
      expect(kmFromBase(venue.coordinates, scope.center)).toBeLessThanOrEqual(
        foodRoutingSnapKm(MODELLED_WALK_KMH),
      );
    }
    // The refusal is stated rather than silent.
    const gap = result.gaps.find((entry) => /further from anything this trip routes through/.test(entry.detail));
    expect(gap).toBeDefined();
  });

  it('keeps a venue that really is beside the node, and charges the walk it really is', async () => {
    const nearRecordId = (await routableRecordIds())[1]!;
    const { result } = await discoverWith(new Map([[nearRecordId, NEAR_DEGREES]]));

    const near = result.venues.find((venue) => venue.id === `food-${nearRecordId}`);
    expect(near).toBeDefined();
    expect(near!.routingId).toBe('base-1');
    /*
     * Eight minutes — the same number the broken leg printed for a venue 4.80 km
     * out, except this one is what 0.56 km actually costs on foot. The old code
     * wrote `walkMinutesFromRouting: 0` here regardless.
     */
    expect(near!.walkMinutesFromRouting).toBe(8);
    expect(near!.walkMinutesFromRouting).toBe(
      foodDoorWalkMinutes(NEAR_DEGREES * KM_PER_DEGREE, MODELLED_WALK_KMH),
    );
  });

  it('never writes a door walk of zero for a venue that is not at its node', async () => {
    const { scope, result } = await discoverWith(new Map());

    expect(result.venues.length).toBeGreaterThan(1);
    for (const venue of result.venues) {
      const km = kmFromBase(venue.coordinates, scope.center);
      /*
       * Every venue in this fixture sits 0.2–1.4 km from the base, so every one
       * of them owes a walk. A hard-coded zero — which is what both live food
       * paths wrote — fails here on the first venue.
       */
      expect(km).toBeGreaterThan(0);
      expect(venue.walkMinutesFromRouting).toBeGreaterThan(0);
      expect(venue.walkMinutesFromRouting).toBe(foodDoorWalkMinutes(km, MODELLED_WALK_KMH));
    }
  });
});
