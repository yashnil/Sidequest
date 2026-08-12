import { describe, expect, it, vi } from 'vitest';
import {
  geographicScopeSchema,
  type GeographicEvidence,
  type RegionPack,
  type SourceRecord,
} from '@sidequest/core';
import { CatalogError, fileIntersects, latestRelease, themeFiles } from './catalog';
import { LAYERS, cleanText, layerById, mapLicence, readWebsites } from './normalize';
import {
  createOverturePackProvider,
  recallPriorityOf,
  retainAcrossCells,
  rowGroupAllowanceFor,
} from './pack';
import {
  boundsOf,
  overlappingRowGroups,
  pointOf,
  rowGroupStatBounds,
  rowInBox,
  rowPointInBox,
  stratificationOf,
  stratifyRowGroups,
  type ScanBudget,
  type ScanCounters,
  type scanFile,
} from './scan';
import type { FileMetaData } from 'hyparquet';

/**
 * THE PLACE-DATA ADAPTER, OFFLINE.
 *
 * Every catalogue document here is a fixture and every fetch is injected, so
 * these run with no network and assert the two things the adapter is actually
 * responsible for: reading somebody else's documents without trusting them, and
 * turning their rows into records without inventing anything.
 *
 * The security cases are not decoration. A STAC catalogue is a graph of links
 * written by somebody else; following one is a server-side request forgery with
 * extra steps, and a `websites` array is attacker-controlled text in a public
 * database.
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
    { rel: 'child', href: './2026-06-17.0/catalog.json' },
  ],
};

const RELEASE = {
  id: '2026-07-22.0',
  'release:version': '2026-07-22.0',
  'schema:version': null,
  links: [{ rel: 'child', href: './places/catalog.json' }],
};

describe('release discovery', () => {
  it('pins the release the catalogue calls latest', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/catalog.json') && url.includes('2026-07-22.0')) return jsonResponse(RELEASE);
      return jsonResponse(ROOT);
    });

    const release = await latestRelease({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(release.catalog).toBe('overture');
    expect(release.releaseId).toBe('2026-07-22.0');
    // A release that publishes no schema version does not get an invented one.
    expect(release.schemaVersion).toBeUndefined();
  });

  it('falls back to the flagged child when the root does not name a latest', async () => {
    const withoutLatest = { ...ROOT, latest: undefined };
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('2026-07-22.0')) return jsonResponse(RELEASE);
      return jsonResponse(withoutLatest);
    });
    const release = await latestRelease({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(release.releaseId).toBe('2026-07-22.0');
  });

  it('refuses a catalogue document that names no release', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ type: 'Catalog', links: [] }));
    await expect(
      latestRelease({ fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toBeInstanceOf(CatalogError);
  });

  it('reports an unreachable catalogue rather than throwing something opaque', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('socket hang up');
    });
    await expect(
      latestRelease({ fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toMatchObject({ code: 'unreachable' });
  });
});

describe('catalogue link handling', () => {
  const collection = {
    links: [
      { rel: 'item', href: './00000/00000.json' },
      { rel: 'item', href: './00001/00001.json' },
    ],
  };

  function itemWith(assets: Record<string, unknown>) {
    return {
      bbox: [-74.1, 40.6, -73.9, 40.8],
      assets,
      properties: { 'table:row_count': 1000 },
    };
  }

  it('reads only assets on hosts we know, and only parquet', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('collection.json')) return jsonResponse(collection);
      if (url.includes('00000')) {
        return jsonResponse(
          itemWith({
            // A hostile mirror, a non-parquet asset, then the real one.
            evil: { href: 'https://attacker.example/steal.parquet', type: 'application/vnd.apache.parquet' },
            tiles: {
              href: 'https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com/x/y.pmtiles',
              type: 'application/vnd.pmtiles',
            },
            data: {
              href: 'https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com/release/x/part-0.zstd.parquet',
              type: 'application/vnd.apache.parquet',
              alternate: { s3: { href: 's3://overturemaps-us-west-2/release/x/part-0.zstd.parquet' } },
            },
          }),
        );
      }
      return jsonResponse(itemWith({}));
    });

    const files = await themeFiles({
      release: {
        catalog: 'overture',
        releaseId: '2026-07-22.0',
        resolvedAt: '2026-08-01T00:00:00Z',
        catalogUrl: 'https://stac.overturemaps.org/catalog.json',
      },
      theme: 'places',
      type: 'place',
      options: { fetchImpl: fetchImpl as unknown as typeof fetch },
    });

    expect(files).toHaveLength(1);
    expect(files[0]!.url).toContain('overturemaps-us-west-2');
    expect(files[0]!.url.endsWith('.parquet')).toBe(true);
    // The `s3://` alternate is unreadable by an anonymous HTTP client and is
    // never chosen; the attacker host is never chosen at all.
    expect(files.some((file) => file.url.includes('attacker.example'))).toBe(false);
  });

  it('refuses to follow a link that leaves the allowlist', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ links: [{ rel: 'item', href: 'https://attacker.example/item.json' }] }),
    );
    await expect(
      themeFiles({
        release: {
          catalog: 'overture',
          releaseId: '2026-07-22.0',
          resolvedAt: '2026-08-01T00:00:00Z',
          catalogUrl: 'https://stac.overturemaps.org/catalog.json',
        },
        theme: 'places',
        type: 'place',
        options: { fetchImpl: fetchImpl as unknown as typeof fetch },
      }),
    ).rejects.toMatchObject({ code: 'rejected_host' });
  });

  it('prunes files by their published bounding box', () => {
    const file = { url: 'https://x/y.parquet', bbox: [-180, -85, -75, 27] as [number, number, number, number] };
    expect(fileIntersects(file, { west: -74.1, south: 40.6, east: -73.9, north: 40.8 })).toBe(false);
    expect(fileIntersects(file, { west: -100, south: 10, east: -95, north: 15 })).toBe(true);
  });
});

describe('row-group pruning', () => {
  function metadata(groups: { xmin: number; xmax: number; ymin: number; ymax: number; rows: number }[]): FileMetaData {
    return {
      row_groups: groups.map((group) => ({
        num_rows: BigInt(group.rows),
        total_byte_size: BigInt(1),
        columns: (
          [
            ['bbox.xmin', group.xmin, group.xmax],
            ['bbox.xmax', group.xmin, group.xmax],
            ['bbox.ymin', group.ymin, group.ymax],
            ['bbox.ymax', group.ymin, group.ymax],
          ] as const
        ).map(([path, min, max]) => ({
          meta_data: {
            path_in_schema: path.split('.'),
            statistics: { min_value: min, max_value: max },
          },
        })),
      })),
      schema: [],
    } as unknown as FileMetaData;
  }

  it('keeps only the groups whose statistics overlap the box', () => {
    const meta = metadata([
      { xmin: -180, xmax: -100, ymin: -80, ymax: 20, rows: 100 },
      { xmin: -75, xmax: -73, ymin: 40, ymax: 41, rows: 200 },
      { xmin: 100, xmax: 120, ymin: -10, ymax: 0, rows: 300 },
    ]);
    const ranges = overlappingRowGroups(meta, { west: -74.1, south: 40.6, east: -73.9, north: 40.8 });
    expect(ranges).toHaveLength(1);
    expect(ranges[0]).toEqual({ index: 1, start: 100, end: 300 });
  });

  it('considers every group when the statistics are missing, rather than none', () => {
    const meta = {
      row_groups: [{ num_rows: 10n, total_byte_size: 1n, columns: [] }],
      schema: [],
    } as unknown as FileMetaData;
    expect(overlappingRowGroups(meta, { west: 0, south: 0, east: 1, north: 1 })).toHaveLength(1);
  });

  /**
   * THE ONE-CORNER SCAN, PINNED.
   *
   * The live failure: a metro box overlapped 1,920 row groups, the retained
   * budget stopped the scan after ~20, and because groups were read in file
   * order — which for this format is spatially coherent, south-west first —
   * every record acquired sat in one corner. Nothing north of the city centre
   * was ever read, so the canonical anchors there could not lose a ranking
   * argument; they were never in the room.
   *
   * The fixture reproduces the shape: groups laid south-to-north in file
   * order over a box divided into four latitude bands. The assertions are the
   * contract — a budget-truncated prefix of the read order must span the box —
   * and the file-order counterexample is asserted too, so the defect cannot
   * come back wearing a refactor.
   */
  describe('spatial stratification of the read order', () => {
    const box = { west: 139, south: 35, east: 140, north: 36 };
    /** 16 groups in south-to-north file order, 4 per quarter-degree band. */
    const southToNorth = Array.from({ length: 16 }, (_, index) => {
      const band = Math.floor(index / 4); // 0 = southernmost, 3 = northernmost
      const ymin = 35 + band * 0.25 + 0.05;
      return { xmin: 139.1 + (index % 4) * 0.2, xmax: 139.15 + (index % 4) * 0.2, ymin, ymax: ymin + 0.1, rows: 10 };
    });

    const bandOf = (meta: FileMetaData, group: { index: number }): number => {
      const raw = meta.row_groups[group.index]!;
      const bounds = rowGroupStatBounds(raw)!;
      return Math.floor(((bounds.south + bounds.north) / 2 - 35) / 0.25);
    };

    it('spreads a budget-truncated read across the whole box', () => {
      const meta = metadata(southToNorth);
      const ordered = stratifyRowGroups(meta, overlappingRowGroups(meta, box), box);
      expect(ordered).toHaveLength(16);

      /* The first four reads — a tight budget — must span several bands… */
      const firstFourBands = new Set(ordered.slice(0, 4).map((group) => bandOf(meta, group)));
      expect(firstFourBands.size).toBeGreaterThanOrEqual(3);

      /* …where the old file order provably did not. This is the defect. */
      const fileOrder = overlappingRowGroups(meta, box);
      const fileOrderBands = new Set(fileOrder.slice(0, 4).map((group) => bandOf(meta, group)));
      expect(fileOrderBands.size).toBe(1);
    });

    it('is deterministic and loses nothing', () => {
      const meta = metadata(southToNorth);
      const groups = overlappingRowGroups(meta, box);
      const once = stratifyRowGroups(meta, groups, box);
      const twice = stratifyRowGroups(meta, groups, box);
      expect(once).toEqual(twice);
      expect([...once].sort((a, b) => a.index - b.index)).toEqual(groups);
    });

    it('keeps groups without statistics in the rotation rather than dropping them', () => {
      const meta = metadata(southToNorth.slice(0, 4)) as unknown as {
        row_groups: unknown[];
        schema: unknown[];
      };
      meta.row_groups.push({ num_rows: 10n, total_byte_size: 1n, columns: [] });
      const typed = meta as unknown as FileMetaData;
      const groups = overlappingRowGroups(typed, box);
      expect(groups).toHaveLength(5);
      const ordered = stratifyRowGroups(typed, groups, box);
      expect(ordered).toHaveLength(5);
      expect(ordered.some((group) => group.index === 4)).toBe(true);
    });

    it('leaves a degenerate box in the caller’s order', () => {
      const meta = metadata(southToNorth);
      const groups = overlappingRowGroups(meta, box);
      const degenerate = { west: 139, south: 35, east: 139, north: 35 };
      expect(stratifyRowGroups(meta, groups, degenerate)).toEqual(groups);
    });

    /**
     * THE CASE WHERE THE FIX TURNS ITSELF OFF.
     *
     * Every assertion above hands `stratifyRowGroups` sixteen groups that
     * publish statistics, and one that does not. When **none** does — an older
     * writer, a different producer — every group goes to `unplaced`, `buckets`
     * is empty, the rotation is a single bucket, and the round-robin emits file
     * order: the exact defect this function exists to eliminate, restored with
     * nothing said. It is a no-op wearing a fix's name, and a truncated read in
     * that state is one corner of the destination.
     *
     * The order cannot be improved — there is nothing to bin on — so what has to
     * change is that the caller is told, and `stratificationOf` is what tells it.
     */
    it('reports that it could not stratify when no writer published statistics', () => {
      const raw = { row_groups: [] as unknown[], schema: [] as unknown[] };
      for (let index = 0; index < 8; index += 1) {
        raw.row_groups.push({ num_rows: 10n, total_byte_size: 1n, columns: [] });
      }
      const meta = raw as unknown as FileMetaData;
      const groups = overlappingRowGroups(meta, box);
      expect(groups).toHaveLength(8);
      /* File order, and honest about it rather than silent about it. */
      expect(stratifyRowGroups(meta, groups, box)).toEqual(groups);
      expect(stratificationOf(meta, groups, box)).toBe('unavailable');
    });

    it('reports stratification as applied when any group carries statistics', () => {
      const meta = metadata(southToNorth);
      expect(stratificationOf(meta, overlappingRowGroups(meta, box), box)).toBe('applied');
    });

    it('reports nothing to stratify when there is no ordering to bias', () => {
      const meta = metadata(southToNorth.slice(0, 2));
      expect(stratificationOf(meta, overlappingRowGroups(meta, box), box)).toBe('not_required');
      const wide = metadata(southToNorth);
      const degenerate = { west: 139, south: 35, east: 139, north: 35 };
      expect(stratificationOf(wide, overlappingRowGroups(wide, box), degenerate)).toBe(
        'not_required',
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Acquisition: how far we read, and what we keep
// ---------------------------------------------------------------------------

/**
 * THE TWO HALVES OF "A REAL TOKYO TRIP HAS NO TOKYO IN IT".
 *
 * A live metropolitan pack held 1,840 places of which the nearest to the
 * traveller's own base was 10.7 km away, 1,635 sat in one corner cell of nine,
 * and not one was a landmark of the city. Three separate mechanisms produced
 * that, and each is pinned below because each on its own is enough to restore
 * the whole failure:
 *
 * 1. the read budget was shaped like a retention budget, so the scan stopped
 *    after two row groups of a city with 1,920;
 * 2. retention was first-N-per-cell in parquet row order, so whatever decoded
 *    first won regardless of what it was;
 * 3. the backfill was a flat `slice` under a comment claiming it ranked, so the
 *    dense corner took 78 % of the pack after the per-cell caps had carefully
 *    stopped it taking 11 %.
 */
describe('acquisition reads broadly and keeps deliberately', () => {
  function packRecord(overrides: Partial<SourceRecord> & { id: string }): SourceRecord {
    return {
      layerId: 'places',
      sourceId: overrides.id,
      name: overrides.id,
      alternateNames: [],
      coordinates: { lat: 35.6, lng: 139.7 },
      sourceCategory: 'museum',
      sourceCategoryPath: ['arts_and_entertainment', 'museum'],
      planningRole: 'attraction',
      websiteCandidates: [],
      containment: { divisionIds: [] },
      attributes: {},
      sources: [{ dataset: 'meta', licenceId: 'CDLA-Permissive-2.0' }],
      cellId: 'g-0-0',
      ...overrides,
    };
  }

  describe('recall priority', () => {
    it('ranks by what the kind is and who has taken note, never by how much was filled in', () => {
      const temple = packRecord({
        id: 'temple',
        sourceCategory: 'temple',
        sourceCategoryPath: ['cultural_and_historic', 'temple'],
      });
      const cashMachine = packRecord({
        id: 'atm',
        sourceCategory: 'atm',
        sourceCategoryPath: ['financial_service', 'atm'],
        planningRole: 'excluded',
      });
      expect(recallPriorityOf(temple)).toBeGreaterThan(recallPriorityOf(cashMachine));

      /*
       * §8.3 at the one layer no downstream fix can reach. The same temple
       * against a *thoroughly catalogued* cash machine — six attributes, three
       * translated names, its own website — must still win, because every one
       * of those is a measurement of mapping effort and none is a measurement
       * of significance. A recall pass that ranked on them would put the
       * franchise ahead of the shrine before anybody could object.
       */
      const wellCatalogued = packRecord({
        id: 'atm-rich',
        sourceCategory: 'atm',
        sourceCategoryPath: ['financial_service', 'atm'],
        planningRole: 'excluded',
        alternateNames: ['Geldautomat', 'Cajero', 'Bancomat', 'ATM'],
        websiteCandidates: ['https://bank.example/atm'],
        attributes: {
          operator: 'A Bank',
          opening_hours: 'Mo-Su 00:00-24:00',
          access: 'yes',
          wheelchair: 'yes',
          fee: 'yes',
          website: 'https://bank.example/atm',
        },
      });
      expect(recallPriorityOf(wellCatalogued)).toBe(recallPriorityOf(cashMachine));
      expect(recallPriorityOf(temple)).toBeGreaterThan(recallPriorityOf(wellCatalogued));

      /* A knowledge base having heard of it does move the number. */
      const known = packRecord({ ...temple, id: 'temple-known', wikidataId: 'Q123' });
      expect(recallPriorityOf(known)).toBeGreaterThan(recallPriorityOf(temple));
    });
  });

  describe('retention', () => {
    it('keeps the significant record that decoded late over the ordinary ones that decoded first', () => {
      /*
       * The shape of the live failure in miniature, and deliberately *within*
       * one purpose family so that only the ranking can decide it: one cell, a
       * cap of three, ten pocket parks, and the city's great temple arriving
       * after the cap is already full. File order says the parks. The live
       * metropolitan pack is what file order produced — 1,840 records, not one
       * of them a landmark of the city.
       */
      const pocketParks = Array.from({ length: 10 }, (_, index) =>
        packRecord({
          id: `park-${index}`,
          sourceCategory: 'park',
          sourceCategoryPath: ['landmarks_and_outdoors', 'park'],
          planningRole: 'outdoor',
        }),
      );
      const landmark = packRecord({
        id: 'grand-temple',
        sourceCategory: 'temple',
        sourceCategoryPath: ['cultural_and_historic', 'temple'],
        wikidataId: 'Q9001',
      });
      /*
       * The cell also holds meals and shops, so its seats are fully spoken for
       * by the purpose shares. That is deliberate: with capacity to spare the
       * redistribution pass could rescue the temple on its own, and the
       * assertion would hold whether or not the queue inside the family was
       * ever ranked. Here the ranking is the only thing that can decide it.
       */
      const meals = Array.from({ length: 3 }, (_, index) =>
        packRecord({
          id: `cafe-${index}`,
          sourceCategory: 'cafe',
          sourceCategoryPath: ['eat_and_drink', 'cafe'],
          planningRole: 'food',
        }),
      );
      const shops = Array.from({ length: 3 }, (_, index) =>
        packRecord({
          id: `shop-${index}`,
          sourceCategory: 'supermarket',
          sourceCategoryPath: ['shopping', 'supermarket'],
          planningRole: 'support',
        }),
      );
      const records = [...pocketParks, ...meals, ...shops, landmark];
      const { kept } = retainAcrossCells({ records, retentionCap: 4, perCellCap: 4 });
      expect(kept).toHaveLength(4);
      expect(kept.map((record) => record.id)).toContain('grand-temple');

      /*
       * The negative control, so this cannot pass by accident of the fixture:
       * swap the temple for one more pocket park, identical in kind and in
       * evidence to the ten before it, and the late arrival is correctly *not*
       * kept. The first assertion is therefore about significance and not about
       * being last in the array.
       */
      const anotherPark = packRecord({
        id: 'zz-late-park',
        sourceCategory: 'park',
        sourceCategoryPath: ['landmarks_and_outdoors', 'park'],
        planningRole: 'outdoor',
      });
      const control = retainAcrossCells({
        records: [...pocketParks, ...meals, ...shops, anotherPark],
        retentionCap: 4,
        perCellCap: 4,
      });
      expect(control.kept.map((record) => record.id)).not.toContain('zz-late-park');
    });

    it('never lets one cell take the backfill while another cell still has records', () => {
      /*
       * The measured defect: `perCellCap` correctly held the dense cell to 205
       * of 1,840, and then `overflow.slice(0, remaining)` handed it 1,430 more
       * because the overflow queue was in file order and the file was one
       * corner. Seven of nine cells — including the one holding the traveller's
       * base — ended with nothing.
       */
      const dense = Array.from({ length: 200 }, (_, index) =>
        packRecord({ id: `dense-${index}`, cellId: 'g-0-0' }),
      );
      const sparse = Array.from({ length: 40 }, (_, index) =>
        packRecord({ id: `sparse-${index}`, cellId: 'g-1-1' }),
      );
      const { kept } = retainAcrossCells({
        records: [...dense, ...sparse],
        retentionCap: 100,
        perCellCap: 12,
      });
      const byCell = new Map<string, number>();
      for (const record of kept) byCell.set(record.cellId, (byCell.get(record.cellId) ?? 0) + 1);
      expect(kept).toHaveLength(100);
      /* Both cells present, and the sparse one drained rather than ignored. */
      expect(byCell.get('g-1-1')).toBe(40);
      expect(byCell.get('g-0-0')).toBe(60);
    });

    it('keeps every purpose represented, so a pack is still ground rather than a board', () => {
      /*
       * A pure significance sort would be the mirror-image defect: a day needs
       * a meal and a station, and a dense city has ten times more of them than
       * it has landmarks. The shares are what stop "significance first" turning
       * into "attractions only".
       */
      const make = (prefix: string, category: string, path: string[], role: SourceRecord['planningRole']) =>
        Array.from({ length: 60 }, (_, index) =>
          packRecord({
            id: `${prefix}-${index}`,
            sourceCategory: category,
            sourceCategoryPath: path,
            planningRole: role,
          }),
        );
      const { kept } = retainAcrossCells({
        records: [
          ...make('museum', 'museum', ['arts_and_entertainment', 'museum'], 'attraction'),
          ...make('cafe', 'cafe', ['eat_and_drink', 'cafe'], 'food'),
          ...make('shop', 'supermarket', ['shopping', 'supermarket'], 'support'),
        ],
        retentionCap: 40,
        perCellCap: 40,
      });
      const prefixes = new Set(kept.map((record) => record.id.split('-')[0]));
      expect(prefixes).toEqual(new Set(['museum', 'cafe', 'shop']));
      /* And the visitable half leads, because that is what a board is made of. */
      expect(kept.filter((record) => record.id.startsWith('museum')).length).toBeGreaterThan(
        kept.filter((record) => record.id.startsWith('shop')).length,
      );
    });

    it('is deterministic, so a pack’s content hash does not depend on I/O order', () => {
      const records = Array.from({ length: 30 }, (_, index) =>
        packRecord({ id: `r-${index}`, cellId: `g-${index % 3}-0` }),
      );
      const once = retainAcrossCells({ records, retentionCap: 12, perCellCap: 5 });
      const reversed = retainAcrossCells({
        records: [...records].reverse(),
        retentionCap: 12,
        perCellCap: 5,
      });
      expect(once.kept.map((r) => r.id).sort()).toEqual(reversed.kept.map((r) => r.id).sort());
    });
  });

  /**
   * THE WIRING, WHICH IS WHERE THE DEFECT ACTUALLY LIVED.
   *
   * Every helper above was already correct in isolation before this wave, and
   * the live pack was still one corner of a city — because the decisions that
   * matter are made where they are *composed*: what budget the scan is handed,
   * and what the layer does with what comes back. So the provider is driven end
   * to end here with the catalogue and the columnar reader both injected, which
   * costs no network and no parquet and is the only test in this file that
   * could have failed on the shipped defect.
   */
  describe('the built pack', () => {
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

    /** The catalogue, answered from fixtures: one release, one file per theme. */
    const catalogueFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/catalog.json') && url.includes('2026-07-22.0')) return jsonResponse(RELEASE);
      if (url.endsWith('/catalog.json') && !url.includes('2026-07-22.0')) return jsonResponse(ROOT);
      if (url.endsWith('collection.json')) {
        return jsonResponse({ links: [{ rel: 'item', href: './00000/00000.json' }] });
      }
      return jsonResponse({
        bbox: [-74.2, 40.5, -73.8, 40.9],
        properties: { 'table:row_count': 1_000_000 },
        assets: {
          data: {
            href: 'https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com/r/x/part-0.zstd.parquet',
            type: 'application/vnd.apache.parquet',
          },
        },
      });
    });

    /**
     * A metropolis in miniature, and the shape is the point.
     *
     * Row groups are laid out so that the *first* ones read are in the
     * south-west corner and hold nothing but chain commerce, and the city's
     * landmarks live in groups the reader only reaches if it keeps going. That
     * is the live file: 1,920 overlapping groups, the anchors spread across
     * them, and a budget that stopped after two.
     */
    function denseCityScan(seen: { budgets: ScanBudget[] }): typeof scanFile {
      const GROUPS = 40;
      const ROWS_PER_GROUP = 300;
      return (async <T,>(request: {
        budget: ScanBudget;
        counters: ScanCounters;
        accept: (row: Record<string, unknown>) => T | null;
      }) => {
        seen.budgets.push(request.budget);
        const rows: T[] = [];
        let stoppedBecause = 'complete';
        for (let group = 0; group < GROUPS; group += 1) {
          if (request.counters.rowGroupsRead >= request.budget.maxRowGroups) {
            stoppedBecause = 'row_group_budget';
            break;
          }
          if (rows.length >= request.budget.maxFeaturesRetained) {
            stoppedBecause = 'retained_budget';
            break;
          }
          request.counters.rowGroupsRead += 1;
          request.counters.featuresRead += ROWS_PER_GROUP;
          /* Groups march north across the box, four to a latitude band. */
          const lat = 40.61 + Math.floor(group / 4) * 0.02;
          for (let index = 0; index < ROWS_PER_GROUP; index += 1) {
            const landmark = group >= 8 && index === 0;
            const accepted = request.accept({
              id: `g${group}-r${index}`,
              names: { primary: landmark ? `Great Temple ${group}` : `Chain Outlet ${group}-${index}` },
              taxonomy: landmark
                ? { primary: 'temple', hierarchy: ['cultural_and_historic', 'temple'] }
                : { primary: 'atm', hierarchy: ['financial_service', 'atm'] },
              operating_status: 'open',
              sources: [{ dataset: 'meta', license: 'CDLA-Permissive-2.0', record_id: `g${group}-r${index}` }],
              subtype: landmark ? 'temple' : 'atm',
              class: landmark ? 'temple' : 'atm',
              bbox: {
                xmin: -74.05 + (index % 20) * 0.004,
                xmax: -74.05 + (index % 20) * 0.004,
                ymin: lat,
                ymax: lat,
              },
            });
            if (accepted !== null) rows.push(accepted);
          }
        }
        return { rows, counters: request.counters, stoppedBecause };
      }) as unknown as typeof scanFile;
    }

    it('reads past the first corner and keeps the landmarks it finds there', async () => {
      const seen = { budgets: [] as ScanBudget[] };
      const provider = createOverturePackProvider({
        fetchOptions: { fetchImpl: catalogueFetch as unknown as typeof fetch },
        scanImpl: denseCityScan(seen),
        now: () => new Date('2026-01-01T00:00:00Z'),
      });
      const outcome = await provider.getPack({ scope, now: new Date('2026-01-01T00:00:00Z') });
      expect(outcome.kind === 'ready' || outcome.kind === 'partial').toBe(true);
      const pack = (outcome as { pack: RegionPack }).pack;
      const places = pack.layers.find((layer) => layer.id === 'places')!;

      /*
       * 1. THE READ. The scan's own retained ceiling must not be the retention
       *    cap in disguise: 1,840 × 2.5 is two row groups of a real city, which
       *    is where the corner came from.
       */
      const placesBudget = seen.budgets[1]!;
      expect(placesBudget.maxFeaturesRetained).toBeGreaterThan(50_000);
      expect(placesBudget.maxRowGroups).toBeLessThan(40);
      expect(placesBudget.maxRowGroups).toBeGreaterThan(10);

      /*
       * 2. THE LANDMARKS. Every one of them sits in a row group beyond the
       *    first two, and every one of them is retained — where the shipped
       *    code both stopped before reaching them and, had it reached them,
       *    would have let the chain outlets that decoded first evict them.
       */
      const temples = places.records.filter((record) => record.name.startsWith('Great Temple'));
      expect(temples.length).toBeGreaterThan(4);

      /*
       * 3. THE SPREAD. The corner bias, measured the way the audit measured it:
       *    the densest partition cell must not hold nearly all of the layer.
       */
      const byCell = new Map<string, number>();
      for (const record of places.records) {
        byCell.set(record.cellId, (byCell.get(record.cellId) ?? 0) + 1);
      }
      const densest = Math.max(...byCell.values());
      expect(byCell.size).toBeGreaterThan(2);
      expect(densest / places.records.length).toBeLessThan(0.6);
    });

    /**
     * THE ROW COUNT THAT BROKE THE ONLY LIVE COMPILATION THIS PHASE RAN.
     *
     * Everything above this test passed while a real metropolis compiled to a
     * places layer of **zero records**, because the defect needs a *quantity*
     * no fixture had ever produced. `collected.push(...result.rows)` passes
     * each row as its own argument, and V8 refuses past roughly 109,832 of
     * them; `RECALL_MEMORY_CEILING` lets the scan return 120,000. So the scan
     * succeeded, the normaliser succeeded, and the statement that appends the
     * result threw `RangeError` — into a catch with no branch for it, which
     * recorded every cell as failed under `provider_error` and blamed a
     * volunteer endpoint that had answered perfectly.
     *
     * The test is therefore about volume and nothing else: a single file whose
     * rows exceed the spread limit must land in the pack. It is slow-ish by the
     * standards of this file and that is inherent — a smaller number cannot
     * reproduce a limit defined by the size of an argument list.
     */
    it('appends a layer larger than the engine will accept as an argument list', async () => {
      const HUGE = 115_000;
      const hugeScan = (async (request: Parameters<typeof scanFile>[0]) => {
        const rows: SourceRecord[] = [];
        for (let index = 0; index < HUGE; index += 1) {
          rows.push({
            id: `places:huge-${index}`,
            layerId: 'places',
            sourceId: `huge-${index}`,
            name: `Place ${index}`,
            alternateNames: [],
            coordinates: { lat: 40.7 + (index % 100) * 0.0001, lng: -74 + (index % 100) * 0.0001 },
            sourceCategory: 'attraction',
            sourceCategoryPath: [],
            planningRole: 'attraction',
            websiteCandidates: [],
            containment: { countryCode: 'US', divisionIds: [] },
            attributes: {},
            sources: [{ dataset: 'meta', licenceId: 'CDLA-Permissive-2.0' }],
            cellId: `g-${index % 9}`,
          } as SourceRecord);
        }
        return { rows, counters: request.counters, stoppedBecause: 'retained_budget' as const };
      }) as unknown as typeof scanFile;

      const provider = createOverturePackProvider({
        fetchOptions: { fetchImpl: catalogueFetch as unknown as typeof fetch },
        scanImpl: hugeScan,
        now: () => new Date('2026-01-01T00:00:00Z'),
      });
      const outcome = await provider.getPack({ scope, now: new Date('2026-01-01T00:00:00Z') });
      const pack = (outcome as { pack: RegionPack }).pack;
      const places = pack.layers.find((layer) => layer.id === 'places')!;

      /* The layer exists at all — this was 0 against a live metropolis. */
      expect(places.records.length).toBeGreaterThan(0);
      /* And the failure was never attributed to the provider. */
      expect(places.failedCellIds ?? []).toHaveLength(0);
      expect(pack.diagnostics.budgetsExhausted ?? []).not.toContain('provider_error');
    }, 30_000);
  });

  describe('read allowance', () => {
    const budget = { maxRowGroups: 40 };

    it('gives the inventory layer a real read, not two row groups', () => {
      /*
       * The number that matters. The scan used to stop at
       * `retentionCap * 2.5` *rows*, which for a metropolis is two row groups
       * of the ~1,920 its box overlaps — one corner, and the reason no landmark
       * was ever in the room. The allowance is now expressed in the unit the
       * read is actually paid for, and the retention cap is not one of its
       * inputs: `rowGroupAllowanceFor` cannot see it.
       */
      const allowance = rowGroupAllowanceFor('places', budget);
      expect(allowance).toBeGreaterThan(12);
      expect(allowance).toBeLessThanOrEqual(budget.maxRowGroups);
    });

    it('cannot starve the layers that come after it', () => {
      /*
       * The geographic layers are where a national park's whole inventory
       * lives, and they run last. A first-come global budget lets the places
       * layer take all of it, so each layer is held to what is left once the
       * ones behind it are paid — a ceiling on the shared running count, which
       * is why every layer still gets a turn while the total stays bounded by
       * the one figure a deployment reasons about.
       */
      let read = 0;
      for (const layer of LAYERS) {
        const allowance = rowGroupAllowanceFor(layer.id, budget);
        expect(allowance, layer.id).toBeGreaterThan(read);
        read = allowance;
      }
      expect(read).toBeLessThanOrEqual(budget.maxRowGroups);
      /* The last layer may spend whatever the earlier ones left, and no more. */
      expect(rowGroupAllowanceFor(LAYERS[LAYERS.length - 1]!.id, budget)).toBe(
        budget.maxRowGroups,
      );
    });
  });
});

describe('row geometry', () => {
  it('refuses NaN and out-of-range coordinates', () => {
    expect(pointOf({ bbox: { xmin: Number.NaN, xmax: 1, ymin: 1, ymax: 1 } })).toBeNull();
    expect(pointOf({ bbox: { xmin: 1, xmax: 1, ymin: 200, ymax: 200 } })).toBeNull();
    expect(pointOf({ bbox: { xmin: Infinity, xmax: 1, ymin: 1, ymax: 1 } })).toBeNull();
    expect(pointOf({})).toBeNull();
  });

  it('returns the centre of the box the record itself publishes', () => {
    expect(pointOf({ bbox: { xmin: -74, xmax: -73, ymin: 40, ymax: 42 } })).toEqual({
      lat: 41,
      lng: -73.5,
    });
  });

  it('only reports bounds for a real area, never a degenerate point', () => {
    expect(boundsOf({ bbox: { xmin: -74, xmax: -74, ymin: 40, ymax: 40 } })).toBeUndefined();
    expect(boundsOf({ bbox: { xmin: -74, xmax: -73, ymin: 40, ymax: 41 } })).toEqual({
      southWest: { lat: 40, lng: -74 },
      northEast: { lat: 41, lng: -73 },
    });
  });

  it('keeps the per-row check, because row-group pruning is coarse', () => {
    const box = { west: -74.1, south: 40.6, east: -73.9, north: 40.8 };
    expect(rowInBox({ bbox: { xmin: -74, xmax: -74, ymin: 40.7, ymax: 40.7 } }, box)).toBe(true);
    expect(rowInBox({ bbox: { xmin: -120, xmax: -120, ymin: 35, ymax: 35 } }, box)).toBe(false);
  });
});

describe('normalisation', () => {
  it('maps each declared licence, and falls back to the theme rather than to none', () => {
    expect(mapLicence('CDLA-Permissive-2.0', 'ODbL-1.0')).toBe('CDLA-Permissive-2.0');
    expect(mapLicence('Apache-2.0', 'ODbL-1.0')).toBe('Apache-2.0');
    expect(mapLicence('CC0-1.0', 'ODbL-1.0')).toBe('CC0-1.0');
    expect(mapLicence('ODbL-1.0', 'CDLA-Permissive-2.0')).toBe('ODbL-1.0');
    // Unreadable is not unencumbered.
    expect(mapLicence('something-new-2.0', 'ODbL-1.0')).toBe('ODbL-1.0');
    expect(mapLicence(undefined, 'ODbL-1.0')).toBe('ODbL-1.0');
  });

  it('keeps only http(s) website candidates with no embedded credentials', () => {
    expect(
      readWebsites([
        'javascript:alert(1)',
        'data:text/html,<script>x</script>',
        'http://user:pass@10.0.0.1/',
        'file:///etc/passwd',
        'not a url',
        'https://museum.example/visit',
      ]),
    ).toEqual(['https://museum.example/visit']);
  });

  it('strips control characters and bidirectional overrides from names', () => {
    const hostile = cleanText('Museum\u0000 of‮ gnitniaP');
    expect(hostile).not.toContain('‮');
    expect(hostile).not.toContain('\u0000');
    expect(cleanText('   ')).toBeNull();
    expect(cleanText('x'.repeat(500))?.length).toBe(180);
  });

  it('declares one layer per dataset, each with a licence and required columns', () => {
    expect(LAYERS.length).toBeGreaterThanOrEqual(5);
    for (const layer of LAYERS) {
      expect(layer.requiredColumns.length).toBeGreaterThan(0);
      expect(layer.columns).toContain('bbox');
      expect(layerById(layer.id)).toBe(layer);
    }
    // Exactly one primary place layer, and the geography kept separate from it —
    // which is what keeps a share-alike source out of a permissive one.
    expect(LAYERS.filter((layer) => layer.kind === 'primary_places')).toHaveLength(1);
    expect(LAYERS.find((layer) => layer.id === 'places')?.defaultLicenceId).toBe(
      'CDLA-Permissive-2.0',
    );
    for (const layer of LAYERS.filter((entry) => entry.kind !== 'primary_places')) {
      expect(layer.defaultLicenceId).toBe('ODbL-1.0');
    }
  });

  it('normalises a place row into a record without inventing anything', () => {
    const layer = layerById('places')!;
    const record = layer.normalize(
      {
        id: 'gers-1',
        names: { primary: 'Harbour Museum', common: { es: 'Museo del Puerto' } },
        taxonomy: { primary: 'museum', hierarchy: ['arts_and_entertainment', 'museum'] },
        operating_status: 'open',
        websites: ['https://harbourmuseum.example/'],
        addresses: [{ locality: 'Harbour City', region: 'HC', country: 'tl' }],
        sources: [
          {
            dataset: 'meta',
            license: 'CDLA-Permissive-2.0',
            record_id: '123',
            update_time: '2026-07-02T00:00:00.000Z',
            confidence: 0.87,
          },
        ],
        bbox: { xmin: -74, xmax: -74, ymin: 40.7, ymax: 40.7 },
      },
      {
        layerId: 'places',
        cellId: 'g-0-0',
        defaultLicenceId: 'CDLA-Permissive-2.0',
        containmentFor: () => ({ divisionIds: [] }),
      },
    );

    expect(record).not.toBeNull();
    expect(record!.id).toBe('places:gers-1');
    expect(record!.name).toBe('Harbour Museum');
    expect(record!.alternateNames).toContain('Museo del Puerto');
    expect(record!.planningRole).toBe('attraction');
    expect(record!.operatingStatus).toBe('open');
    expect(record!.containment.countryCode).toBe('TL');
    expect(record!.sources[0]?.existenceConfidence).toBe(0.87);
    // Contact details are not planning facts and are not retained.
    expect(Object.keys(record!.attributes)).not.toContain('phone');
  });

  it('marks a permanently closed record excluded rather than dropping it silently', () => {
    const layer = layerById('places')!;
    const record = layer.normalize(
      {
        id: 'gers-2',
        names: { primary: 'Former Gallery' },
        taxonomy: { primary: 'art_gallery', hierarchy: ['arts_and_entertainment', 'art_gallery'] },
        operating_status: 'permanently_closed',
        sources: [{ dataset: 'meta', license: 'CDLA-Permissive-2.0' }],
        bbox: { xmin: -74, xmax: -74, ymin: 40.7, ymax: 40.7 },
      },
      {
        layerId: 'places',
        cellId: 'g-0-0',
        defaultLicenceId: 'CDLA-Permissive-2.0',
        containmentFor: () => ({ divisionIds: [] }),
      },
    );
    expect(record?.operatingStatus).toBe('closed');
    expect(record?.planningRole).toBe('excluded');
  });

  it('builds an upstream link from the record id, never from a supplied URL', () => {
    const layer = layerById('land')!;
    const record = layer.normalize(
      {
        id: 'gers-3',
        names: { primary: 'Test Peak' },
        subtype: 'physical',
        class: 'peak',
        elevation: 1832,
        source_tags: { website: 'https://park.example/peak', operator: 'Park Service', ele: '1832' },
        sources: [
          {
            dataset: 'OpenStreetMap',
            license: 'ODbL-1.0',
            record_id: 'w652289958@1',
            update_time: '2018-12-04T11:56:32.000Z',
          },
        ],
        bbox: { xmin: -151.2, xmax: -151.1, ymin: 63.44, ymax: 63.46 },
      },
      {
        layerId: 'land',
        cellId: 'g-0-0',
        defaultLicenceId: 'ODbL-1.0',
        containmentFor: () => ({ countryCode: 'US', divisionIds: [] }),
      },
    );

    expect(record?.sourceUrl).toBe('https://www.openstreetmap.org/way/652289958');
    expect(record?.attributes.operator).toBe('Park Service');
    expect(record?.attributes.ele).toBe('1832');
    expect(record?.websiteCandidates).toEqual(['https://park.example/peak']);
    expect(record?.bounds).toBeDefined();
  });

  it('drops a row with no name, no id or no position rather than defaulting one', () => {
    const layer = layerById('places')!;
    const context = {
      layerId: 'places',
      cellId: 'g-0-0',
      defaultLicenceId: 'CDLA-Permissive-2.0' as const,
      containmentFor: () => ({ divisionIds: [] }),
    };
    expect(layer.normalize({ id: 'x', bbox: { xmin: 0, xmax: 0, ymin: 0, ymax: 0 } }, context)).toBeNull();
    expect(
      layer.normalize({ names: { primary: 'Anonymous' }, bbox: { xmin: 0, xmax: 0, ymin: 0, ymax: 0 } }, context),
    ).toBeNull();
    expect(layer.normalize({ id: 'x', names: { primary: 'No position' } }, context)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Scope membership
// ---------------------------------------------------------------------------

/**
 * THE ADAPTER'S HALF OF "DOES THIS BELONG HERE".
 *
 * The compiler owns the decision; this file owns the two places it has to be
 * applied. The regression: a metropolitan build returned twenty-three places and
 * every one of them was in a first-level division the destination is not in. The
 * read was correct, the pruning was correct, the normalisation was correct, and
 * no layer had ever been given the job of asking whether the thing belonged.
 *
 * The scope below carries no boundary, because no city in the index has one.
 */
function placeRow(input: {
  id: string;
  name: string;
  lat: number;
  region: string;
  locality: string;
  country?: string;
  category?: string;
}): Record<string, unknown> {
  return {
    id: input.id,
    names: { primary: input.name },
    taxonomy: {
      primary: input.category ?? 'museum',
      hierarchy: ['arts_and_entertainment', input.category ?? 'museum'],
    },
    operating_status: 'open',
    addresses: [{ locality: input.locality, region: input.region, country: input.country ?? 'AA' }],
    sources: [{ dataset: 'meta', license: 'CDLA-Permissive-2.0', record_id: input.id }],
    bbox: { xmin: 20, xmax: 20, ymin: input.lat, ymax: input.lat },
  };
}

describe('geographic evidence at the adapter boundary', () => {
  /*
   * WHAT THIS BOUNDARY IS RESPONSIBLE FOR, AFTER THE PACK/OVERLAY SPLIT.
   *
   * It used to decide membership here, and these tests asserted the verdicts. The
   * verdicts were right; the *layer* was wrong. A pack is cached on the
   * destination and the bounds and shared between every traveller going there,
   * and a membership verdict needs the traveller's scope, their regional
   * expansion and their base strategy — one of which (`includedAreas`) is in the
   * pack's own cache key. So the adapter now produces **evidence**, which is
   * traveller-independent and genuinely cacheable, and the trip-scope overlay
   * produces verdicts.
   *
   * These tests were re-reasoned rather than renamed, per the migration record:
   * each one keeps the invariant it actually protected — an address is read at
   * its own level, an ISO code is not a name, and no record leaves without
   * evidence — and drops the assertion that a *verdict* is attached, because that
   * assertion pinned the layering the closure removes.
   */

  function normalisePlace(row: Record<string, unknown>) {
    return layerById('places')!.normalize(row, {
      layerId: 'places',
      cellId: 'g-0-0',
      defaultLicenceId: 'CDLA-Permissive-2.0',
      containmentFor: () => ({ divisionIds: [] }),
    });
  }

  it('filters on the record’s own position, not on a bounding box that merely overlaps', () => {
    const box = { west: 19.9, south: 9.9, east: 20.1, north: 10.1 };
    // A first-level division's own record: it clips the box by a corner and sits
    // hundreds of kilometres away. Overlap admits it; position does not.
    const sprawling = { bbox: { xmin: 15, xmax: 20, ymin: 5, ymax: 10 } };
    expect(rowInBox(sprawling, box)).toBe(true);
    expect(rowPointInBox(sprawling, box)).toBe(false);
    // And a real record inside the box is still kept by both.
    const inside = { bbox: { xmin: 20, xmax: 20, ymin: 10, ymax: 10 } };
    expect(rowInBox(inside, box)).toBe(true);
    expect(rowPointInBox(inside, box)).toBe(true);
  });

  it('attaches typed geographic evidence to every normalised record', () => {
    const record = normalisePlace(
      placeRow({
        id: 'in-1',
        name: 'Harbour Museum',
        lat: 10.05,
        region: 'Selected Region',
        locality: 'Selected City',
      }),
    );
    const evidence = geographyOf(record!);
    expect(evidence).toBeDefined();
    expect(evidence!.countryCode).toBe('AA');
    expect(evidence!.regionNames).toEqual(['Selected Region']);
    expect(evidence!.localityNames).toEqual(['Selected City']);
    /* A printed subdivision name is a name, and is not put in the code field. */
    expect(evidence!.regionCode).toBeUndefined();
  });

  it('routes an ISO 3166-2 subdivision code to the code field, not the name set', () => {
    /*
     * The bridge CS-11 turns on. The divisions layer publishes `AA-AR` into the
     * same field the address path publishes `Adjacent Region` into, and comparing
     * one against the other was reported as a border rather than as two
     * vocabularies that do not meet.
     */
    const record = normalisePlace(
      placeRow({
        id: 'coded',
        name: 'Coded Museum',
        lat: 10.05,
        region: 'AA-AR',
        locality: 'Adjacent Township',
      }),
    );
    const evidence = geographyOf(record!)!;
    expect(evidence.regionCode).toBe('AA-AR');
    expect(evidence.regionNames).toEqual([]);
  });

  it('keeps a record whose address files it somewhere else, and says where', () => {
    /*
     * The adapter no longer refuses anything for not belonging, and that is the
     * correction: a record dropped at pack build is a record nothing downstream
     * can recover, and the same ground is read again for the next traveller. What
     * it does is record the address faithfully — which is what the overlay then
     * excludes it on, per trip.
     */
    const record = normalisePlace(
      placeRow({
        id: 'out-1',
        name: 'Township Auto Parts',
        lat: 11.44,
        region: 'Adjacent Region',
        locality: 'Adjacent Township',
        category: 'automotive_parts',
      }),
    );
    expect(record).not.toBeNull();
    expect(geographyOf(record!)!.regionNames).toEqual(['Adjacent Region']);
  });

  it('keeps an administrative record with its parent chain, because it is the evidence', () => {
    const division = layerById('divisions')!.normalize(
      {
        id: 'div-adjacent',
        names: { primary: 'Adjacent Region' },
        subtype: 'region',
        country: 'AA',
        region: 'AA-AR',
        sources: [{ dataset: 'OpenStreetMap', license: 'ODbL-1.0' }],
        bbox: { xmin: 19.5, xmax: 20.5, ymin: 11, ymax: 12 },
      },
      {
        layerId: 'divisions',
        cellId: 'g-0-0',
        defaultLicenceId: 'ODbL-1.0',
        containmentFor: () => ({ divisionIds: [] }),
      },
    );
    expect(division).not.toBeNull();
    expect(division!.planningRole).toBe('administrative');
    expect(geographyOf(division!)!.regionCode).toBe('AA-AR');
  });

  it('leaves evidence empty rather than inventing it when the source published none', () => {
    const record = layerById('places')!.normalize(
      {
        id: 'bare',
        names: { primary: 'Unplaced Viewpoint' },
        taxonomy: { primary: 'viewpoint', hierarchy: ['geographic_entities', 'viewpoint'] },
        sources: [{ dataset: 'meta', license: 'CDLA-Permissive-2.0', record_id: 'bare' }],
        bbox: { xmin: 20, xmax: 20, ymin: 10.05, ymax: 10.05 },
      },
      {
        layerId: 'places',
        cellId: 'g-0-0',
        defaultLicenceId: 'CDLA-Permissive-2.0',
        containmentFor: () => ({ divisionIds: [] }),
      },
    );
    const evidence = geographyOf(record!)!;
    expect(evidence.countryCode).toBeUndefined();
    expect(evidence.localityNames).toEqual([]);
    expect(evidence.divisionIds).toEqual([]);
  });
});

function geographyOf(record: SourceRecord): GeographicEvidence | undefined {
  return (record as SourceRecord & { geography?: GeographicEvidence }).geography;
}
