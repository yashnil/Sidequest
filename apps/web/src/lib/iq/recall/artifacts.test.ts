import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { placeRoleTag, type RegionPack } from '@sidequest/core';
import { openArtifactStore, type ArtifactStore } from './artifacts';
import { FIXTURE_METROPOLIS, buildFixturePack, fixtureScope } from './fixtures/fixture-world';
import { measureCanonicalRecall } from './stages';

/**
 * THE STORE MUST HAND THE FUNNEL THE CHAIN THE TRAVELLER GOT.
 *
 * Three ways the reality arm measured the wrong artifact, all from live
 * databases:
 *
 * 1. **The wrong pack.** Selection used to be pack-first: the newest pack for
 *    the destination was measured, and the compiled region was then chosen to
 *    match it. Two legitimate pack scopes can coexist for one destination — a
 *    road-trip radius compiled for a traveller with a car, and a tight
 *    walkable box compiled for one without — and when the road-scope pack was
 *    the newer row, the funnel graded the dense-metro floors against a
 *    region-wide retention budget that had evicted the city canon, while the
 *    newest compiled region, built from the tight pack, sat unmeasured.
 *    Selection is now region-first: the newest parseable compiled region wins
 *    and *its own embedded pack* is what acquisition is measured over, so the
 *    chain is same-build by construction. The old pack-first order and its
 *    cross-build fallback are gone on purpose; the tests below pin the new
 *    order.
 *
 * 2. **The wrong build.** The pack-first order's earlier symptom: the newest
 *    compiled region was a car-variant built from a since-deleted pack, and
 *    the funnel paired the walk pack with the car trip's board. Region-first,
 *    a region whose recorded pack no longer resolves is not a measurable
 *    chain, and the next older complete chain stands.
 *
 * 3. **Seats nobody renders.** The compiled artifact's `places` include
 *    records the discover page's own role gate (`partitionBoardPlaces`)
 *    refuses — gateways, utility roles. Counting a subject "on the board"
 *    through a seat the page never renders overstates the surface, so the
 *    store runs the product's own gate and hands the funnel the admitted seat
 *    list. Membership in that list is profile-independent — the profile moves
 *    grouping and fit bands, never who is on the board — which is what lets an
 *    instrument with no traveller measure the seats every traveller gets.
 *
 * A row whose places no longer parse under the full place schema (older
 * artifacts) still yields the ungated view, marked `renderedSeatList: false`,
 * so the funnel can say what its number rests on rather than measuring
 * nothing.
 */

const DESTINATION = 'overture:artifact-store-test';
const ORPHAN_DESTINATION = 'overture:artifact-store-orphan';
const PACK_ONLY_DESTINATION = 'overture:artifact-store-pack-only';
const LEGACY_DESTINATION = 'overture:artifact-store-legacy';

/** A full, schema-valid compiled place. The role arrives via `tags`. */
function place(id: string, name: string, tags: string[]): Record<string, unknown> {
  return {
    id,
    regionId: 'region-test',
    name,
    locality: 'Test Quarter',
    shortDescription: 'A seat in the artifact-store test world.',
    coordinates: { lat: 12, lng: -30 },
    tags,
    source: { name: 'fixture', kind: 'curated', confidence: 0.9, lastVerified: '2026-08-01' },
    relationship: 'satellite',
    category: 'museum',
    interests: ['museums_and_galleries'],
    typicalDurationMinutes: 60,
    costLevel: 1,
    physicalIntensity: 'easy',
    crowdLevel: 'moderate',
    popularityScore: 0.5,
    hiddenGemScore: 0.5,
    weather: {
      exposure: 'indoor',
      precipitation: 'low',
      wind: 'low',
      heat: 'low',
      cold: 'low',
      visibilityDependent: false,
      poorWeatherBackup: true,
      approachDegradesWhenWet: false,
    },
    seasonalAccess: { openMonths: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], closureRisk: 'none' },
    access: { roadSurface: 'paved', mountainRoad: false, parkingDifficulty: 'easy' },
    travelFromBase: { distanceKm: 1, driveMinutes: 5 },
  };
}

function compiledRow(places: unknown[], packContentHash: string): string {
  return JSON.stringify({
    scope: fixtureScope(),
    places,
    regionPack: { contentHash: packContentHash },
  });
}

describe('the artifact store and the traveller-visible chain', () => {
  let dir: string;
  let store: ArtifactStore;
  let fixturePack: RegionPack;

  /** The fixture pack re-hashed, so one destination can hold two real builds. */
  const packWithHash = (contentHash: string): RegionPack => ({ ...fixturePack, contentHash });

  beforeAll(async () => {
    fixturePack = await buildFixturePack();
    dir = mkdtempSync(join(tmpdir(), 'sidequest-recall-artifacts-'));
    const path = join(dir, 'artifacts.db');
    const db = new Database(path);
    db.exec(
      'create table compiled_regions (scope_fingerprint text, payload_json text, created_at text)',
    );
    db.exec('create table region_packs (scope_hash text, payload_json text, created_at text)');
    const insertRegion = db.prepare(
      'insert into compiled_regions (scope_fingerprint, payload_json, created_at) values (?, ?, ?)',
    );
    const insertPack = db.prepare(
      'insert into region_packs (scope_hash, payload_json, created_at) values (?, ?, ?)',
    );

    /*
     * The live shape of the defect: two legitimate packs for one destination.
     * The wide-scope pack is the NEWER row, and the newest compiled region was
     * built from the older, tight-scope pack.
     */
    insertPack.run(
      `v8/${DESTINATION}/tight`,
      JSON.stringify(packWithHash('tight-build')),
      '2026-01-01T00:00:00.000Z',
    );
    insertPack.run(
      `v8/${DESTINATION}/wide`,
      JSON.stringify(packWithHash('wide-build')),
      '2026-01-02T00:00:00.000Z',
    );
    /* An older region from the wide pack: region recency governs, not pack recency. */
    insertRegion.run(
      `v1/r2/${DESTINATION}/wide`,
      compiledRow([place('places:wide-seat', 'Wide Build Hall', [placeRoleTag('attraction')])], 'wide-build'),
      '2026-01-01T12:00:00.000Z',
    );
    /* Newest region: built from the tight pack, gateway seat included. */
    insertRegion.run(
      `v1/r2/${DESTINATION}/tight`,
      compiledRow(
        [
          place('places:rendered-seat', 'Rendered Seat Hall', [placeRoleTag('attraction')]),
          place('places:gateway-seat', 'Harbour Gateway', [placeRoleTag('gateway')]),
        ],
        'tight-build',
      ),
      '2026-01-03T00:00:00.000Z',
    );

    /* A newest region whose recorded pack was deleted; an older complete chain exists. */
    insertPack.run(
      `v8/${ORPHAN_DESTINATION}/kept`,
      JSON.stringify(packWithHash('kept-build')),
      '2026-01-01T00:00:00.000Z',
    );
    insertRegion.run(
      `v1/r2/${ORPHAN_DESTINATION}/orphan`,
      compiledRow([place('places:orphan-seat', 'Orphan Hall', [placeRoleTag('attraction')])], 'deleted-build'),
      '2026-01-02T00:00:00.000Z',
    );
    insertRegion.run(
      `v1/r2/${ORPHAN_DESTINATION}/kept`,
      compiledRow([place('places:kept-seat', 'Kept Hall', [placeRoleTag('attraction')])], 'kept-build'),
      '2026-01-01T00:00:00.000Z',
    );

    /* Packs with nothing compiled: only an unparseable region row. */
    insertPack.run(
      `v8/${PACK_ONLY_DESTINATION}/older`,
      JSON.stringify(packWithHash('older-alone')),
      '2026-01-01T00:00:00.000Z',
    );
    insertPack.run(
      `v8/${PACK_ONLY_DESTINATION}/newest`,
      JSON.stringify(packWithHash('newest-alone')),
      '2026-01-02T00:00:00.000Z',
    );
    insertRegion.run(
      `v1/r2/${PACK_ONLY_DESTINATION}/broken`,
      'not json at all',
      '2026-01-03T00:00:00.000Z',
    );

    /* A destination whose places predate the full place schema. */
    insertPack.run(
      `v8/${LEGACY_DESTINATION}/only`,
      JSON.stringify(packWithHash('legacy-build')),
      '2026-01-01T00:00:00.000Z',
    );
    insertRegion.run(
      `v1/r2/${LEGACY_DESTINATION}/only`,
      JSON.stringify({
        scope: fixtureScope(),
        places: [{ id: 'places:legacy-seat', name: 'Legacy Hall', coordinates: { lat: 12, lng: -30 } }],
        regionPack: { contentHash: 'legacy-build' },
      }),
      '2026-01-01T00:00:00.000Z',
    );

    db.close();
    store = openArtifactStore(path)!;
    expect(store).not.toBeNull();
  }, 60_000);

  afterAll(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * THE REGRESSION THIS FILE EXISTS TO HOLD: region-first selection.
   *
   * Two packs for one destination, and the newer pack is NOT the one the
   * newest region embeds. Pack-first order graded the newer pack — a scope a
   * different traveller profile compiled — against a board that never used
   * it. The instrument must measure the region's own pack, and the report's
   * header must print that pack's hash.
   */
  it('measures the newest region’s own pack, not the newest pack for the destination', () => {
    const chain = store.chainFor(DESTINATION);
    expect(chain?.stored.pack.contentHash).toBe('tight-build');
    expect(chain?.compiled?.view.packContentHash).toBe('tight-build');

    const report = measureCanonicalRecall({
      destination: FIXTURE_METROPOLIS,
      pack: chain!.stored.pack,
      scope: chain!.compiled!.scope,
      compiled: chain!.compiled!.view,
      provenance: {
        storedSchemaVersion: chain!.stored.storedSchemaVersion,
        relabelled: chain!.stored.relabelled,
      },
    });
    /* The funnel header names the chain's own pack, and the chain is same-build. */
    expect(report.packContentHash).toBe('tight-build');
    expect(report.laterStagesFromSameBuild).toBe(true);
  }, 60_000);

  it('skips a region whose recorded pack is gone in favour of the next complete chain', () => {
    const chain = store.chainFor(ORPHAN_DESTINATION);
    expect(chain?.stored.pack.contentHash).toBe('kept-build');
    expect(chain?.compiled?.view.packContentHash).toBe('kept-build');
    expect(chain?.compiled?.view.places.map((entry) => entry.id)).toContain('places:kept-seat');
  });

  it('lets the newest parseable pack stand alone when no compiled region parses', () => {
    const chain = store.chainFor(PACK_ONLY_DESTINATION);
    expect(chain?.stored.pack.contentHash).toBe('newest-alone');
    /* Stages 5–6 stay unmeasured rather than borrowed from another build. */
    expect(chain?.compiled).toBeNull();
  });

  it('returns nothing for a destination with no artifacts at all', () => {
    expect(store.chainFor('overture:artifact-store-absent')).toBeNull();
  });

  it('hands the funnel the seat list the discover page renders, through the product’s own role gate', () => {
    const chain = store.chainFor(DESTINATION);
    expect(chain?.compiled?.view.renderedSeatList).toBe(true);
    const ids = chain?.compiled?.view.places.map((entry) => entry.id);
    expect(ids).toContain('places:rendered-seat');
    /* The gateway is real and stored, and the page never renders it as a card. */
    expect(ids).not.toContain('places:gateway-seat');
  });

  it('keeps the ungated view for artifacts the full place schema no longer reads, and says so', () => {
    const chain = store.chainFor(LEGACY_DESTINATION);
    expect(chain?.stored.pack.contentHash).toBe('legacy-build');
    expect(chain?.compiled?.view.renderedSeatList).toBe(false);
    expect(chain?.compiled?.view.places.map((entry) => entry.id)).toContain('places:legacy-seat');
  });
});
