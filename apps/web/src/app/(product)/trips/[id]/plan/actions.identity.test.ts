import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DestinationIndexEntry } from '@sidequest/core';

/**
 * THE WIRE BETWEEN THE PLACE INDEX AND THE COMPILED REGION, DRIVEN END TO END.
 *
 * `deriveScope` reads the identifier a candidate was minted from, and the
 * destination index resolves the *other* publication of the same place. Both are
 * unit-tested. Neither is worth anything if the action that builds the scope
 * never asks — and that is not a hypothetical: `actions.guards.test.ts` exists
 * because two cost controls were module-tested and wiring-untested, and the body
 * of one could be replaced with `return null` while the suite stayed green.
 *
 * So this drives `proposeScopeAction` itself, over a seeded index holding the
 * shape that broke Tokyo: one place published twice, at two administrative
 * levels, where the row the traveller is handed is not the row every record in
 * the destination refers to.
 *
 * Nothing here reaches a network. The destination is picked from the local index
 * exactly as the dropdown picks one, so no geocoder is consulted.
 */

vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('next/headers', () => ({
  headers: async () => ({ get: () => null }),
  cookies: async () => ({
    // One stable browser identity: the ownership boundary refuses a request
    // that presents no cookie, and this file is about scope identity.
    get: (name: string) =>
      name === 'sidequest_session' ? { name, value: 'session-under-test' } : undefined,
    set: () => undefined,
  }),
}));

let dir: string;

function releaseDatabase(): void {
  const holder = globalThis as unknown as { sidequestDb?: { close(): void } };
  holder.sidequestDb?.close();
  delete holder.sidequestDb;
}

beforeEach(() => {
  releaseDatabase();
  dir = mkdtempSync(join(tmpdir(), 'sidequest-scope-identity-'));
  process.env.SIDEQUEST_DB_PATH = join(dir, 'test.db');
  process.env.SIDEQUEST_COMPILER_PROVIDER = 'fixture';
});

afterEach(() => {
  releaseDatabase();
  delete process.env.SIDEQUEST_DB_PATH;
  delete process.env.SIDEQUEST_COMPILER_PROVIDER;
  rmSync(dir, { recursive: true, force: true });
});

/** Tokyo as the catalogue publishes it: a locality under a ward, and a region. */
const LOCALITY: DestinationIndexEntry = {
  id: 'overture:798895d4',
  catalog: 'overture',
  sourceId: '798895d4',
  featureType: 'city',
  displayName: 'Tokyo',
  localName: '東京都',
  aliases: ['Tokio'],
  countryCode: 'JP',
  regionCode: 'JP-13',
  wikidataId: 'Q1490',
  hierarchy: ['Japan', 'Tokyo', 'Chiyoda'],
  center: { lat: 35.6768589, lng: 139.7638931 },
  population: 13_613_660,
};

const REGION: DestinationIndexEntry = {
  id: 'overture:689e36ca',
  catalog: 'overture',
  sourceId: '689e36ca',
  featureType: 'region',
  displayName: 'Tokyo',
  localName: '東京都',
  aliases: ['Tokio'],
  countryCode: 'JP',
  regionCode: 'JP-13',
  wikidataId: 'Q1490',
  hierarchy: ['Japan'],
  center: { lat: 34.2255783, lng: 139.2947769 },
  bounds: {
    southWest: { lat: 24.7797374, lng: 139.0730667 },
    northEast: { lat: 35.8182029, lng: 141.3199386 },
  },
};

async function tripPickedFromTheIndex(): Promise<string> {
  const { createTrip } = await import('@/lib/db/repository');
  const repo = await import('@/lib/db/compiler-repository');
  const index = await import('@/lib/db/destination-index-repository');

  index.replaceDestinationIndex({
    entries: [LOCALITY, REGION],
    release: {
      schemaVersion: 1,
      catalog: 'overture',
      releaseId: 'test-release',
      entryCount: 2,
      builtAt: '2026-08-01T00:00:00.000Z',
    },
  });

  const trip = createTrip(
    {
      mode: 'known_destination',
      destinationInput: 'Tokyo',
      regionId: 'open-world',
      startDate: '2026-09-01',
      endDate: '2026-09-06',
      arrivalTime: '10:00',
      departureTime: '18:00',
      adults: 2,
      children: 0,
      travelerNeeds: [],
  },
    'session-under-test',
  );
  repo.saveDestinationQuery(trip.id, 'known_destination', 'Tokyo');
  /* Exactly what `trips/new` writes when a suggestion is chosen from the list. */
  repo.saveSelectedDestination(trip.id, {
    entryId: LOCALITY.id,
    catalog: LOCALITY.catalog,
    sourceId: LOCALITY.sourceId,
    releaseId: 'test-release',
    displayName: LOCALITY.displayName,
    qualifiedName: 'Tokyo, Chiyoda',
    featureType: LOCALITY.featureType,
    center: LOCALITY.center,
    countryCode: LOCALITY.countryCode,
    regionCode: LOCALITY.regionCode,
    aliases: [...LOCALITY.aliases],
    hierarchy: [...LOCALITY.hierarchy],
    selectedAt: '2026-08-01T00:00:00.000Z',
  });
  /* Nothing left to ask: the traveller pointed at a row, so there is no reading
   * to disambiguate and the action's own "still a couple of questions" guard is
   * satisfied without inventing answers. */
  repo.saveClarifications(trip.id, { schemaVersion: 1, questions: [], answers: [] });
  return trip.id;
}

describe('proposing a region for a destination picked from the place index', () => {
  it('puts both of the catalogue’s publications of it on the scope', async () => {
    const tripId = await tripPickedFromTheIndex();
    const { proposeScopeAction } = await import('./actions');
    const repo = await import('@/lib/db/compiler-repository');

    const result = await proposeScopeAction(tripId);
    expect(result.ok).toBe(true);

    const scope = repo.getIntent(tripId)?.scope;
    /**
     * The row the traveller pointed at leads, and the first-level division the
     * same place is also published as follows it. On the stored Tokyo pack, the
     * second of these is the identifier all 319 chain-carrying records name and
     * the first is named by none — so a scope carrying only what the traveller
     * clicked places nothing inside its own destination.
     */
    expect(scope?.administrative.divisionIds).toEqual(['798895d4', '689e36ca']);
  });
});
