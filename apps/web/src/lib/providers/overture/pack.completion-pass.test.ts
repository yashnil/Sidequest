import { describe, expect, it, vi } from 'vitest';
import { geographicScopeSchema, type RegionPack } from '@sidequest/core';

import { createOverturePackProvider } from './pack';
import { ScanError, type ScanCounters, type scanFile } from './scan';

/*
 * ONE MORE PASS FOR THE LAYERS THE CLOCK LEFT EMPTY.
 *
 * The layers run in a fixed order against one shared deadline, so a slow link
 * lands the whole cost on whichever layers had not started — and those are the
 * ground layers whose nearby records attest a landmark's identity. A live
 * metropolitan build shipped four of six layers empty this way (4,368 records
 * where the previous build held 7,114; canonical acquisition 1.00 → 0.63)
 * while its job had six unspent minutes. These tests hold the repair in place:
 * a layer that ended with every cell failed for a time-class reason is read
 * once more, and an ordinary build pays for each file exactly once.
 */

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const ROOT = {
  type: 'Catalog',
  id: 'Overture Releases',
  latest: '2026-07-22.0',
  links: [
    { rel: 'root', href: './catalog.json' },
    { rel: 'child', href: './2026-07-22.0/catalog.json', latest: true },
  ],
};

const RELEASE = {
  id: '2026-07-22.0',
  'release:version': '2026-07-22.0',
  'schema:version': null,
  links: [{ rel: 'child', href: './places/catalog.json' }],
};

const scope = geographicScopeSchema.parse({
  schemaVersion: 1,
  revision: 1,
  destinationCandidateId: 'relation/1',
  destinationName: 'Testville',
  destinationEntityType: 'city',
  breadth: 'city',
  center: { lat: 40.7, lng: -74 },
  bounds: { southWest: { lat: 40.6, lng: -74.1 }, northEast: { lat: 40.8, lng: -73.9 } },
  timeZones: ['UTC'],
  shape: {
    kind: 'bounds',
    bounds: { southWest: { lat: 40.6, lng: -74.1 }, northEast: { lat: 40.8, lng: -73.9 } },
  },
  transport: {
    primaryMode: 'drive',
    allowedModes: ['drive', 'walk'],
    carAvailable: true,
    acceptsWaterOrAirTransfers: true,
    basis: 'default',
    note: 'Test transport.',
  },
  maxBaseChanges: 0,
  nights: 4,
  rationale: 'A test scope.',
  confidence: { level: 'high', signals: [], note: 'Test.' },
  confirmedByUser: true,
});

const catalogueFetch = vi.fn(async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url.endsWith('/catalog.json') && url.includes('2026-07-22.0')) return jsonResponse(RELEASE);
  if (url.endsWith('/catalog.json')) return jsonResponse(ROOT);
  if (url.endsWith('collection.json')) {
    return jsonResponse({ links: [{ rel: 'item', href: './00000/00000.json' }] });
  }
  return jsonResponse({
    bbox: [-74.2, 40.5, -73.8, 40.9],
    properties: { 'table:row_count': 1_000 },
    assets: {
      data: {
        href: 'https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com/r/x/part-0.zstd.parquet',
        type: 'application/vnd.apache.parquet',
      },
    },
  });
});

/** Rows only the places definition normalises; other layers read them as noise. */
function emitPlaceRows<T>(accept: (row: Record<string, unknown>) => T | null): T[] {
  const rows: T[] = [];
  for (let index = 0; index < 12; index += 1) {
    const accepted = accept({
      id: `retry-r${index}`,
      names: { primary: `Recovered Museum ${index}` },
      taxonomy: { primary: 'museum', hierarchy: ['arts_and_entertainment', 'museum'] },
      operating_status: 'open',
      sources: [{ dataset: 'meta', license: 'CDLA-Permissive-2.0', record_id: `retry-r${index}` }],
      subtype: 'museum',
      class: 'museum',
      bbox: { xmin: -74.0 + index * 0.002, xmax: -74.0 + index * 0.002, ymin: 40.7, ymax: 40.7 },
    });
    if (accepted !== null) rows.push(accepted);
  }
  return rows;
}

describe('the completion pass', () => {
  it('reads a time-starved layer again instead of shipping it empty', async () => {
    /*
     * The places file dies on the first pass exactly the way the live build
     * died — a stalled transfer surfaced as `unreachable` — and answers on the
     * second. The pack must carry the recovered records, no failed cells for
     * that layer, and no stale first-pass reason in the diagnostics.
     */
    let placesAttempts = 0;
    const scanImpl = (async <T,>(request: {
      columns: readonly string[];
      counters: ScanCounters;
      accept: (row: Record<string, unknown>) => T | null;
    }) => {
      const isPlaces = request.columns.includes('categories');
      if (isPlaces) {
        placesAttempts += 1;
        if (placesAttempts === 1) {
          throw new ScanError('unreachable', 'The place data transfer stalled.');
        }
      }
      const rows = isPlaces ? emitPlaceRows(request.accept) : [];
      return { rows, counters: request.counters, stoppedBecause: 'complete' };
    }) as unknown as typeof scanFile;

    const provider = createOverturePackProvider({
      fetchOptions: { fetchImpl: catalogueFetch as unknown as typeof fetch },
      scanImpl,
      now: () => new Date('2026-01-01T00:00:00Z'),
    });
    const outcome = await provider.getPack({ scope, now: new Date('2026-01-01T00:00:00Z') });

    expect(outcome.kind === 'ready' || outcome.kind === 'partial').toBe(true);
    const pack = (outcome as { pack: RegionPack }).pack;
    const places = pack.layers.find((layer) => layer.id === 'places')!;

    expect(placesAttempts).toBe(2);
    expect(places.records.length).toBeGreaterThan(0);
    expect(places.records.some((record) => record.name?.includes('Recovered Museum'))).toBe(true);
    expect(places.failedCellIds).toHaveLength(0);
    /* The first pass's verdict must not survive the second pass's success. */
    expect(pack.diagnostics.budgetsExhausted).not.toContain('places:unreachable');
  });

  it('never re-reads a layer that was merely empty or deliberately bounded', async () => {
    /*
     * Wholesale failure for a time-class reason is the only trigger. A layer
     * that read the ground and found nothing, or that a policy bound stopped,
     * was not starved — paying for it twice would double the cost of every
     * ordinary build.
     */
    let scans = 0;
    const scanImpl = (async <T,>(request: {
      columns: readonly string[];
      counters: ScanCounters;
      accept: (row: Record<string, unknown>) => T | null;
    }) => {
      scans += 1;
      const rows = request.columns.includes('categories') ? emitPlaceRows(request.accept) : [];
      return { rows, counters: request.counters, stoppedBecause: 'complete' };
    }) as unknown as typeof scanFile;

    const provider = createOverturePackProvider({
      fetchOptions: { fetchImpl: catalogueFetch as unknown as typeof fetch },
      scanImpl,
      now: () => new Date('2026-01-01T00:00:00Z'),
    });
    await provider.getPack({ scope, now: new Date('2026-01-01T00:00:00Z') });

    /* Six layers, one file each, one read each: an ordinary build pays once. */
    expect(scans).toBe(6);
  });
});

describe('the completion pass under a caller deadline', () => {
  /*
   * Twelve consecutive live rebuild rounds on a ~0.4 MB/s link ended partial
   * because the pass owned exactly one extra window while ten job-minutes sat
   * unspent. With the caller's own deadline threaded in, the pass keeps buying
   * windows for starved ground until the ground is read or the caller's clock
   * runs out; without one, it takes a single window exactly as before.
   */
  it('keeps taking windows for starved ground while the caller clock allows', async () => {
    let placesAttempts = 0;
    const scanImpl = (async <T,>(request: {
      columns: readonly string[];
      counters: ScanCounters;
      accept: (row: Record<string, unknown>) => T | null;
    }) => {
      const isPlaces = request.columns.includes('categories');
      if (isPlaces) {
        placesAttempts += 1;
        if (placesAttempts <= 3) {
          throw new ScanError('unreachable', 'The place data transfer stalled.');
        }
      }
      const rows = isPlaces ? emitPlaceRows(request.accept) : [];
      return { rows, counters: request.counters, stoppedBecause: 'complete' };
    }) as unknown as typeof scanFile;

    const provider = createOverturePackProvider({
      fetchOptions: { fetchImpl: catalogueFetch as unknown as typeof fetch },
      scanImpl,
      now: () => new Date('2026-01-01T00:00:00Z'),
    });
    const outcome = await provider.getPack({
      scope,
      now: new Date('2026-01-01T00:00:00Z'),
      deadlineMs: Date.now() + 10 * 60_000,
    });

    const pack = (outcome as { pack: RegionPack }).pack;
    const places = pack.layers.find((layer) => layer.id === 'places')!;
    expect(placesAttempts).toBe(4);
    expect(places.records.length).toBeGreaterThan(0);
    expect(places.failedCellIds).toHaveLength(0);
  });

  it('still takes exactly one extra window when no caller deadline exists', async () => {
    let placesAttempts = 0;
    const scanImpl = (async <T,>(request: {
      columns: readonly string[];
      counters: ScanCounters;
      accept: (row: Record<string, unknown>) => T | null;
    }) => {
      const isPlaces = request.columns.includes('categories');
      if (isPlaces) {
        placesAttempts += 1;
        throw new ScanError('unreachable', 'The place data transfer stalled.');
      }
      return { rows: [], counters: request.counters, stoppedBecause: 'complete' };
    }) as unknown as typeof scanFile;

    const provider = createOverturePackProvider({
      fetchOptions: { fetchImpl: catalogueFetch as unknown as typeof fetch },
      scanImpl,
      now: () => new Date('2026-01-01T00:00:00Z'),
    });
    await provider.getPack({ scope, now: new Date('2026-01-01T00:00:00Z') });

    expect(placesAttempts).toBe(2);
  });
});
