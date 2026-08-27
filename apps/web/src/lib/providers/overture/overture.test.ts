import { describe, expect, it, vi } from 'vitest';
import {
  assessPlaceStanding,
  geographicScopeSchema,
  hasDesignatedStatus,
  type GeographicEvidence,
  type PlanningRole,
  type RegionPack,
  type SourceRecord,
} from '@sidequest/core';
import { CatalogError, fileIntersects, latestRelease, themeFiles } from './catalog';
import { LAYERS, cleanText, layerById, mapLicence, readWebsites } from './normalize';
import {
  GroundNamesakeLedger,
  KNOWLEDGE_DONOR_RETENTION_PRIORITY,
  byteAllowanceFor,
  createOverturePackProvider,
  recallPriorityOf,
  retainAcrossCells,
  sinkBucketBoundFor,
  sinkVisitableBoundFor,
  type AcquisitionReport,
} from './pack';
import {
  boundsOf,
  overlappingRowGroups,
  planRead,
  pointOf,
  projectedCostOf,
  rowGroupStatBounds,
  rowInBox,
  rowPointInBox,
  stratificationOf,
  stratifyRowGroups,
  type ScanBudget,
  type ScanCounters,
  type ScanReadPlan,
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

  /**
   * WHAT THE READ WILL COST, FROM THE FOOTER, BEFORE PAYING IT.
   *
   * The arithmetic the whole acquisition budget now rests on, tested where it is
   * cheapest to test: a pure function over metadata, no network and no parquet.
   * If this is wrong every bound above it is wrong, and wrong in the direction
   * that reads a destination in part while reporting a healthy number.
   */
  describe('projected cost', () => {
    /** Two groups; the projection covers `bbox` and `id` and not `geometry`. */
    function priced(): FileMetaData {
      const group = (offset: number) => ({
        num_rows: 100n,
        total_byte_size: 999_999_999n,
        columns: [
          {
            meta_data: {
              path_in_schema: ['bbox', 'xmin'],
              total_compressed_size: BigInt(1_000 + offset),
              statistics: { min_value: 139, max_value: 139.5 },
            },
          },
          {
            meta_data: {
              path_in_schema: ['bbox', 'ymin'],
              total_compressed_size: BigInt(2_000 + offset),
              statistics: { min_value: 35, max_value: 35.5 },
            },
          },
          { meta_data: { path_in_schema: ['id'], total_compressed_size: BigInt(4_000 + offset) } },
          {
            meta_data: {
              path_in_schema: ['geometry'],
              total_compressed_size: 50_000_000n,
            },
          },
        ],
      });
      return {
        row_groups: [group(0), group(1)],
        schema: [{ name: 'bbox' }, { name: 'id' }, { name: 'geometry' }],
      } as unknown as FileMetaData;
    }

    const ranges = [
      { index: 0, start: 0, end: 100 },
      { index: 1, start: 100, end: 200 },
    ];

    it('sums the leaves the projection names, and nothing else', () => {
      /*
       * `bbox` is stored as `bbox.xmin`, `bbox.ymin` and friends, so a projection
       * matched on the whole path would price the area at zero and read
       * everything; matched on the group total it would price it fifty times too
       * high and read almost nothing. Both are failures, in opposite directions,
       * and both look like a working budget from outside.
       */
      expect(projectedCostOf(priced(), ranges, ['bbox', 'id'])).toBe(
        1_000 + 2_000 + 4_000 + 1_001 + 2_001 + 4_001,
      );
      expect(projectedCostOf(priced(), ranges, ['bbox'])).toBe(1_000 + 2_000 + 1_001 + 2_001);
      expect(projectedCostOf(priced(), [], ['bbox', 'id'])).toBe(0);
    });

    it('plans the whole area when it fits, and a prefix that says what it left', () => {
      const metadata = priced();
      const whole = planRead({ metadata, ordered: ranges, columns: ['bbox', 'id'], byteAllowance: 1_000_000 });
      expect(whole.plan.rowGroupsPlanned).toBe(2);
      expect(whole.plan.rowsPlanned).toBe(200);
      expect(whole.plan.shortfallBytes).toBe(0);

      const partial = planRead({ metadata, ordered: ranges, columns: ['bbox', 'id'], byteAllowance: 8_000 });
      expect(partial.plan.rowGroupsPlanned).toBe(1);
      expect(partial.plan.rowsPlanned).toBe(100);
      expect(partial.plan.shortfallBytes).toBe(1_001 + 2_001 + 4_001);
    });

    it('prices empty ground at nothing, so scheduling more cells costs only what their ground holds', () => {
      /*
       * The property the uncapped partition stands on. The old cell cap was a
       * read-cost proxy: fewer cells, cheaper build. But the read is priced
       * here, from the footer, per overlapping row group — so a scope box that
       * grows across ground the source has nothing in overlaps no further
       * groups and costs not one byte more. Cell count is not the cost;
       * overlapping compressed bytes are, and a partition that dropped edge
       * cells to save money was saving nothing while losing the coast people
       * live on.
       */
      /* Two groups of real ground, and one very expensive group far away. */
      const group = (west: number, south: number, bytes: number) => ({
        num_rows: 100n,
        total_byte_size: 999_999_999n,
        columns: (
          [
            ['xmin', west, west + 0.5],
            ['xmax', west, west + 0.5],
            ['ymin', south, south + 0.5],
            ['ymax', south, south + 0.5],
          ] as const
        ).map(([leaf, min, max]) => ({
          meta_data: {
            path_in_schema: ['bbox', leaf],
            total_compressed_size: BigInt(bytes),
            statistics: { min_value: min, max_value: max },
          },
        })),
      });
      const metadata = {
        row_groups: [group(139, 35, 1_000), group(139.4, 35.4, 2_000), group(100, 5, 40_000_000)],
        schema: [{ name: 'bbox' }],
      } as unknown as FileMetaData;

      const dataBox = { west: 139, south: 35, east: 140, north: 36 };
      /* The same ground inside a country-sized request: 40× the area, all empty. */
      const countryBox = { west: 135, south: 32, east: 145, north: 40 };

      const dataGroups = overlappingRowGroups(metadata, dataBox);
      const countryGroups = overlappingRowGroups(metadata, countryBox);
      expect(dataGroups.map((entry) => entry.index)).toEqual([0, 1]);
      expect(countryGroups).toEqual(dataGroups);
      expect(projectedCostOf(metadata, countryGroups, ['bbox'])).toBe(
        projectedCostOf(metadata, dataGroups, ['bbox']),
      );

      const plan = planRead({
        metadata,
        ordered: countryGroups,
        columns: ['bbox'],
        byteAllowance: 1_000_000,
      });
      expect(plan.plan.shortfallBytes).toBe(0);
      /* The far group's forty megabytes appear in no number here. */
      expect(plan.plan.projectedBytes).toBe(4 * (1_000 + 2_000));
    });

    it('reads one group rather than none when nothing fits, so a thin budget is not an empty place', () => {
      /*
       * A destination that returns nothing reads to everybody downstream as a
       * destination with nothing in it. One group and a stated shortfall is a
       * worse answer than the whole area and a far better one than silence.
       */
      const partial = planRead({
        metadata: priced(),
        ordered: ranges,
        columns: ['bbox', 'id'],
        byteAllowance: 10,
      });
      expect(partial.plan.rowGroupsPlanned).toBe(1);
      expect(partial.plan.shortfallBytes).toBeGreaterThan(0);
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

    it('derives the per-cell seat share from the cells that hold records, never from empty ground', () => {
      /*
       * The dilution the uncapped partition would otherwise have introduced.
       * The caller used to compute `perCellCap = ceil(cap / partitionCells)`,
       * and a country partition is mostly cells the source has nothing in — a
       * live country grid was 45 cells of which the populated coast was a
       * handful. Divided by 45, a dense cell's *structured* share (family
       * shares, kind coverage, spatial spread) collapses to a sliver and the
       * rest of its seats arrive through the rank-only backfill, which knows
       * nothing about breadth — the commodity kind floods the cell and the
       * ground's one-of-a-kind experiences lose. Seats must follow data:
       * the share divides the cap across the cells that actually hold
       * records, and empty ground holds no seat at all.
       */
      const kindRecord = (cellId: string, kind: string, index: number): SourceRecord =>
        packRecord({
          id: `${cellId}-${kind}-${index}`,
          cellId,
          sourceCategory: kind,
          planningRole: 'attraction',
        });
      const cellOf = (cellId: string): SourceRecord[] => [
        /* One commodity kind, thirty deep and outranking everything. */
        ...Array.from({ length: 30 }, (_, index) => kindRecord(cellId, 'commodity', index)),
        /* Twelve kinds the ground offers once each, ranked below. */
        ...Array.from({ length: 12 }, (_, index) => kindRecord(cellId, `kind-${index}`, 0)),
      ];
      const records = [...cellOf('g-0-0'), ...cellOf('g-5-9')];
      const priorityOf = (record: SourceRecord): number =>
        record.sourceCategory === 'commodity' ? 0.9 : 0.5;

      /* No perCellCap: the share is the function's own to derive, from data. */
      const derived = retainAcrossCells({ records, retentionCap: 40, priorityOf });
      expect(derived.kept).toHaveLength(40);

      const byCell = new Map<string, SourceRecord[]>();
      for (const record of derived.kept) {
        const list = byCell.get(record.cellId) ?? [];
        list.push(record);
        byCell.set(record.cellId, list);
      }
      /* Two populated cells split the cap; no seat is reserved for empty ground. */
      expect(byCell.get('g-0-0')).toHaveLength(20);
      expect(byCell.get('g-5-9')).toHaveLength(20);

      /*
       * The structured passes ran at the populated-cell share: kind coverage
       * seats several distinct kinds per cell. Under a partition-cell-count
       * share the same records reach the cap through the rank-only backfill
       * and the commodity kind takes every seat.
       */
      for (const kept of byCell.values()) {
        const kinds = new Set(kept.map((record) => record.sourceCategory));
        expect(kinds.size).toBeGreaterThanOrEqual(5);
      }

      /* The derived share is exactly the data-driven arithmetic, stated. */
      const explicit = retainAcrossCells({
        records,
        retentionCap: 40,
        perCellCap: Math.max(4, Math.ceil(40 / 2)),
        priorityOf,
      });
      expect(derived.kept.map((record) => record.id)).toEqual(
        explicit.kept.map((record) => record.id),
      );
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

    /**
     * THE SHARES THEMSELVES, WHERE THEY ARE THE ONLY THING DECIDING ANYTHING.
     *
     * The test above proves every purpose is *represented*. It cannot prove the
     * shares are the size they claim to be, because in its fixture the visitable
     * records are also the highest-ranked ones: cut the visitable share tenfold
     * and the leftover pass hands them back every seat on significance alone. A
     * cell could be re-sliced from "half the ground a traveller can visit" to a
     * twentieth of it, and the whole suite would stay green.
     *
     * So this arranges the one condition under which the share is load-bearing,
     * and it is not a contrived one — it is a normal city. The food records here
     * are individually *more celebrated* than the visitable ones: a
     * knowledge-base entry moves `recallPriorityOf` from 0.09 to 0.44, well
     * above a park's 0.12 or a viewpoint's 0.14. Any dense city has more
     * catalogued restaurants than it has parks with Wikipedia articles. Rank
     * alone would therefore fill the cell with dinner, and the only thing
     * standing between a traveller and a pack made of restaurants is the
     * declared split of a cell's seats by purpose.
     *
     * The expected numbers are written out rather than read from the constant.
     * A test that imported `RECALL_FAMILY_SHARE` would agree with any value it
     * was given, which is a mirror rather than a guard.
     */
    it('spends half of every cell on what a traveller can visit, even when the meals rank higher', () => {
      const cell = (
        prefix: string,
        category: string,
        path: string[],
        role: SourceRecord['planningRole'],
        extra: Partial<SourceRecord> = {},
      ): SourceRecord[] =>
        Array.from({ length: 60 }, (_, index) =>
          packRecord({
            id: `${prefix}-${String(index).padStart(2, '0')}`,
            sourceCategory: category,
            sourceCategoryPath: path,
            planningRole: role,
            ...extra,
          }),
        );

      const parks = cell('park', 'park', ['landmarks_and_outdoors', 'park'], 'outdoor');
      /* Celebrated restaurants: every one outranks every park. */
      const dining = cell('dining', 'restaurant', ['eat_and_drink', 'restaurant'], 'food', {
        wikidataId: 'Q100',
      });
      const shops = cell('shop', 'supermarket', ['shopping', 'supermarket'], 'support');
      const excluded = cell('atm', 'atm', ['financial_service', 'atm'], 'excluded');
      expect(recallPriorityOf(dining[0]!)).toBeGreaterThan(recallPriorityOf(parks[0]!));

      const PER_CELL = 40;
      const { kept } = retainAcrossCells({
        records: [...parks, ...dining, ...shops, ...excluded],
        retentionCap: PER_CELL,
        perCellCap: PER_CELL,
      });

      const count = (prefix: string): number =>
        kept.filter((record) => record.id.startsWith(prefix)).length;

      /*
       * 50 / 20 / 20 of the cell to the purposes with positive-priority demand,
       * which is the policy §12.2 asks for: a pack is ground rather than a
       * board, so a day can still find a meal and a shop — and half of it is
       * still what the traveller came for.
       *
       * The residual share is zero here, and that is the point of the fixture:
       * every ATM scores exactly 0 — `ratesAsExperience` is false, the
       * inventory can never offer one — while forty positive-priority parks are
       * queueing for refused seats. A stored metropolitan pack spent 175 of
       * 1,840 seats on exactly such records, in the same cells where canonical
       * attractions were outranked, so a zero may seat only when no positive
       * record of the cell is refused. The freed seats flow to the best refused
       * positives, which here are the celebrated restaurants.
       */
      expect({
        visitable: count('park'),
        food: count('dining'),
        practical: count('shop'),
        residual: count('atm'),
      }).toEqual({ visitable: 20, food: 12, practical: 8, residual: 0 });

      /*
       * And the direction that matters: the ground beats the dinner, which is
       * true here *only* because of the share. Rank alone gives the opposite.
       */
      expect(count('park')).toBeGreaterThan(count('dining'));
    });

    it('never seats a zero-priority record while a positive one of the same cell is refused', () => {
      /*
       * Invariant (i) of the Phase 16B retention repair, in miniature. The
       * excluded records are deliberately *rich* — websites, hours, operators —
       * and the queueing positives deliberately poor, so the only thing that
       * can decide the seat is the priority itself: zero means the inventory
       * can never offer it, and a seat spent there is a seat no traveller sees.
       */
      const zeros = Array.from({ length: 30 }, (_, index) =>
        packRecord({
          id: `locker-${String(index).padStart(2, '0')}`,
          sourceCategory: 'parcel_locker',
          sourceCategoryPath: ['services_and_business', 'parcel_locker'],
          planningRole: 'excluded',
          websiteCandidates: ['https://parcel.example/locker'],
          attributes: { website: 'https://parcel.example/locker', opening_hours: '24/7' },
        }),
      );
      const positives = Array.from({ length: 30 }, (_, index) =>
        packRecord({
          id: `walk-${String(index).padStart(2, '0')}`,
          sourceCategory: 'hiking_trail',
          sourceCategoryPath: ['sports_and_recreation', 'hiking_trail'],
          planningRole: 'outdoor',
        }),
      );
      const { kept } = retainAcrossCells({
        records: [...zeros, ...positives],
        retentionCap: 20,
        perCellCap: 20,
      });
      expect(kept.filter((record) => record.id.startsWith('locker'))).toHaveLength(0);
      expect(kept.filter((record) => record.id.startsWith('walk'))).toHaveLength(20);

      /*
       * And the half that keeps the pack honest evidence: when the ground is
       * genuinely sparse, the zeros do seat — an empty seat teaches nobody
       * anything, and the linker reads across layers.
       */
      const sparse = retainAcrossCells({
        records: [...zeros.slice(0, 6), ...positives.slice(0, 4)],
        retentionCap: 10,
        perCellCap: 10,
      });
      expect(sparse.kept.filter((record) => record.id.startsWith('walk'))).toHaveLength(4);
      expect(sparse.kept.filter((record) => record.id.startsWith('locker'))).toHaveLength(6);
    });

    it('flows the seats of a family with no demand to the families that have it', () => {
      /*
       * Invariant (ii): a cell with no meals, no shops and nothing excluded
       * must still fill every seat — with what is actually there — rather than
       * holding empty chairs for records that do not exist.
       */
      const museums = Array.from({ length: 40 }, (_, index) =>
        packRecord({ id: `museum-${String(index).padStart(2, '0')}` }),
      );
      const { kept } = retainAcrossCells({
        records: museums,
        retentionCap: 24,
        perCellCap: 24,
      });
      expect(kept).toHaveLength(24);
      expect(kept.every((record) => record.id.startsWith('museum'))).toBe(true);
    });

    it('keeps a named archetype ahead of the generic crowd, whatever the crowd filled in', () => {
      /*
       * Invariant (iii), shaped like the measured Tokyo evidence: one partition
       * cell, hundreds of records, one dominant generic kind rich in metadata,
       * and the destination's singular archetypes — a market hall, an
       * observation deck — poor in it. Rank-only retention spends every seat on
       * the crowd (945 galleries against 3 public markets was the live count);
       * kind coverage is what seats the ground's breadth. Synthetic names only.
       */
      const crowd = Array.from({ length: 300 }, (_, index) =>
        packRecord({
          id: `gallery-${String(index).padStart(3, '0')}`,
          sourceCategory: 'art_gallery',
          sourceCategoryPath: ['arts_and_entertainment', 'art_gallery'],
          websiteCandidates: ['https://gallery.example/'],
          attributes: {
            website: 'https://gallery.example/',
            opening_hours: 'Tu-Su 10:00-18:00',
            operator: 'Gallery Group',
          },
          alternateNames: ['Galerie', 'Galleria', 'Galería'],
          sources: [
            { dataset: 'meta', licenceId: 'CDLA-Permissive-2.0', existenceConfidence: 0.99 },
          ],
        }),
      );
      const marketHall = packRecord({
        id: 'market-hall',
        sourceCategory: 'public_market',
        sourceCategoryPath: ['shopping', 'market', 'public_market'],
        planningRole: 'market',
      });
      const deck = packRecord({
        id: 'signal-deck',
        sourceCategory: 'observation_deck',
        sourceCategoryPath: ['arts_and_entertainment', 'observation_deck'],
        planningRole: 'outdoor',
      });
      /* The archetypes rank *below* every crowd record on priority alone. */
      expect(recallPriorityOf(marketHall)).toBeLessThan(recallPriorityOf(crowd[0]!));
      expect(recallPriorityOf(deck)).toBeLessThan(recallPriorityOf(crowd[0]!));

      const { kept } = retainAcrossCells({
        records: [...crowd, marketHall, deck],
        retentionCap: 40,
        perCellCap: 40,
      });
      const ids = new Set(kept.map((record) => record.id));
      expect(ids.has('market-hall')).toBe(true);
      expect(ids.has('signal-deck')).toBe(true);
    });

    it('breaks priority ties by the source’s own existence confidence, never by luck of the id', () => {
      /*
       * Within a tie tier the id is a lottery drawn at catalogue build time.
       * The source's published confidence is the one per-record statement the
       * place theme carries, so among equals it decides — and only among
       * equals: the assertion above this one proves it cannot lift a record
       * over a higher-priority one.
       */
      const doubtful = packRecord({
        id: 'aa-doubtful',
        sources: [{ dataset: 'meta', licenceId: 'CDLA-Permissive-2.0', existenceConfidence: 0.3 }],
      });
      const confident = packRecord({
        id: 'zz-confident',
        sources: [{ dataset: 'meta', licenceId: 'CDLA-Permissive-2.0', existenceConfidence: 0.97 }],
      });
      const { kept } = retainAcrossCells({
        records: [doubtful, confident],
        retentionCap: 1,
        perCellCap: 1,
      });
      /* Same kind, same priority; the id ordering alone would pick aa-doubtful. */
      expect(kept.map((record) => record.id)).toEqual(['zz-confident']);
    });

    it('spreads a family’s seats across the cell’s quadrants, so a dense quarter cannot take them all', () => {
      /*
       * The per-cell distribution one level down, for the same reason it exists
       * at cell level. The outlying quadrant's best record ranks below dozens
       * of the dense quarter's — a real metropolitan cell held a new island
       * museum at rank 933 of 6,754 — and without the spatial pass it loses
       * every seat to the dense quarter.
       */
      const denseQuarter = Array.from({ length: 60 }, (_, index) =>
        packRecord({
          id: `dense-${String(index).padStart(2, '0')}`,
          sources: [
            { dataset: 'meta', licenceId: 'CDLA-Permissive-2.0', existenceConfidence: 0.99 },
          ],
        }),
      );
      const outlier = packRecord({
        id: 'island-museum',
        sources: [{ dataset: 'meta', licenceId: 'CDLA-Permissive-2.0', existenceConfidence: 0.4 }],
      });
      const subcellFor = (record: SourceRecord): string =>
        record.id === 'island-museum' ? '0-1' : '0-0';
      const { kept } = retainAcrossCells({
        records: [...denseQuarter, outlier],
        retentionCap: 12,
        perCellCap: 12,
        subcellFor,
      });
      expect(kept.map((record) => record.id)).toContain('island-museum');

      /*
       * The control: with the whole cell one quadrant, the same record loses on
       * rank exactly as it should — the spatial pass is what seats it, not an
       * accident of the fixture.
       */
      const flat = retainAcrossCells({
        records: [...denseQuarter, outlier],
        retentionCap: 12,
        perCellCap: 12,
      });
      expect(flat.kept.map((record) => record.id)).not.toContain('island-museum');
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

  describe('retention hears the ground rather than the operator', () => {
    it('lets a bare government-operator URL order nothing, while a page addressed to the subject still counts', () => {
      /*
       * The measured degeneracy: 399 of 255,915 records of one real four-cell
       * read carried a +0.35 lift for a URL that says only who the landlord
       * is, and the whole top of the visitable pool was "things a government
       * runs". The seat layer has already banned the operator channel from
       * ordering; retention ranks on the same rule or the two layers disagree
       * about what the pack should even contain.
       */
      const plain = packRecord({ id: 'hall-plain' });
      const operatorRun = packRecord({
        id: 'hall-operator',
        websiteCandidates: ['https://ministry.example.gov/'],
      });
      expect(recallPriorityOf(operatorRun)).toBe(recallPriorityOf(plain));

      /* A page an authority publishes FOR this subject is about the subject. */
      const addressed = packRecord({
        id: 'hall-addressed',
        name: 'oldbridge crossing hall',
        websiteCandidates: ['https://city.example.gov/sites/oldbridge-crossing-hall.html'],
      });
      expect(recallPriorityOf(addressed)).toBeGreaterThan(recallPriorityOf(plain));
    });

    it('lifts the record the ground itself is named after over its evidence-blind tie tier', () => {
      /*
       * The measured failure in miniature: a dense cell scores a landmark and
       * its whole kind identically, the tie breaks on source confidence, and
       * the landmark's sprawling-complex confidence reads *lower* than a
       * storefront's — rank 431 of 632 on the real rows. What the ground
       * publishes, though, is not a tie: other records carry the landmark's
       * name inside their own. Nobody names their shop after the storefront.
       */
      const tieTier = Array.from({ length: 8 }, (_, index) =>
        packRecord({
          id: `chapel-${index}`,
          sourceCategory: 'temple',
          sourceCategoryPath: ['cultural_and_historic', 'temple'],
          sources: [
            { dataset: 'meta', licenceId: 'CDLA-Permissive-2.0', existenceConfidence: 0.99 },
          ],
        }),
      );
      const landmark = packRecord({
        id: 'zz-landmark',
        name: 'basalttemple',
        sourceCategory: 'temple',
        sourceCategoryPath: ['cultural_and_historic', 'temple'],
        sources: [{ dataset: 'meta', licenceId: 'CDLA-Permissive-2.0', existenceConfidence: 0.6 }],
      });
      const witnesses = [
        packRecord({ id: 'w-1', name: 'basalttemple north gate', planningRole: 'support' }),
        packRecord({ id: 'w-2', name: 'cafe at basalttemple', planningRole: 'food' }),
        packRecord({ id: 'w-3', name: 'basalttemple kindergarten', planningRole: 'excluded' }),
      ];
      const ledger = new GroundNamesakeLedger();
      for (const record of [...tieTier, landmark, ...witnesses]) ledger.note(record);
      const attested = ledger.attestedAmong([...tieTier, landmark]);
      expect(attested).toEqual(new Set(['zz-landmark']));

      /* The channel moves the shared model, and the seat follows. */
      expect(recallPriorityOf(landmark, true)).toBeGreaterThan(recallPriorityOf(tieTier[0]!));
      const { kept } = retainAcrossCells({
        records: [...tieTier, landmark],
        retentionCap: 2,
        perCellCap: 2,
        priorityOf: (record) => recallPriorityOf(record, attested.has(record.id)),
      });
      expect(kept.map((record) => record.id)).toContain('zz-landmark');

      /* Control: without the channel, the same record loses on confidence. */
      const blind = retainAcrossCells({
        records: [...tieTier, landmark],
        retentionCap: 2,
        perCellCap: 2,
      });
      expect(blind.kept.map((record) => record.id)).not.toContain('zz-landmark');
    });

    it('refuses a generic-word name: embeddings that do not cluster attest nothing', () => {
      /*
       * A record named with a bare common noun of its ground embeds in
       * hundreds of unrelated names — the measured rows held a "park"-worded
       * record at 1,582 embeddings and the city's own name at 6,948. A
       * name-giver's namesakes cluster around it; a common word is uniform.
       */
      const generic = packRecord({ id: 'generic', name: 'riverfront' });
      const nearby = Array.from({ length: 3 }, (_, index) =>
        packRecord({ id: `near-${index}`, name: `riverfront stall ${index}`, planningRole: 'food' }),
      );
      const scattered = Array.from({ length: 70 }, (_, index) =>
        packRecord({
          id: `far-${index}`,
          name: `riverfront terrace ${index}`,
          planningRole: 'food',
          coordinates: { lat: 35.6 + 0.02 + index * 0.0001, lng: 139.7 },
        }),
      );
      const ledger = new GroundNamesakeLedger();
      for (const record of [generic, ...nearby, ...scattered]) ledger.note(record);
      expect(ledger.attestedAmong([generic])).toEqual(new Set());

      /* Control: the same three nearby namesakes attest when the name is not
       * spread across the whole ground. */
      const proper = packRecord({ id: 'proper', name: 'ironspire tower / aguja de hierro' });
      const properNearby = Array.from({ length: 3 }, (_, index) =>
        packRecord({ id: `pn-${index}`, name: `ironspire tower kiosk ${index}`, planningRole: 'food' }),
      );
      const ledger2 = new GroundNamesakeLedger();
      for (const record of [proper, ...properNearby]) ledger2.note(record);
      /* Also the slash split: no namesake embeds the two-rendering primary
       * whole, and the real ground's tallest landmark publishes exactly that
       * shape — either rendering alone must be recognisable. */
      expect(ledger2.attestedAmong([proper])).toEqual(new Set(['proper']));
    });

    it('never lets a record attest through the name of its own neighbourhood', () => {
      /*
       * The seat layer's public-housing lesson, applied at retention: a venue
       * named after the district it stands in took that name FROM the
       * geography, and every other business of the district embeds the same
       * name. Which way the naming ran is not in the record — so the
       * containment names never attest.
       */
      const districtNamed = packRecord({
        id: 'district-venue',
        name: 'coppergate quarter',
        containment: { divisionIds: [], neighbourhoodName: 'Coppergate Quarter' },
      });
      const neighbours = Array.from({ length: 4 }, (_, index) =>
        packRecord({ id: `n-${index}`, name: `coppergate quarter tavern ${index}`, planningRole: 'food' }),
      );
      const ledger = new GroundNamesakeLedger();
      for (const record of [districtNamed, ...neighbours]) ledger.note(record);
      expect(ledger.attestedAmong([districtNamed])).toEqual(new Set());

      /* Control: identical shape without the containment name attests. */
      const freestanding = packRecord({
        id: 'free-venue',
        name: 'coppergate quarter',
        containment: { divisionIds: [] },
      });
      const ledger2 = new GroundNamesakeLedger();
      for (const record of [freestanding, ...neighbours]) ledger2.note(record);
      expect(ledger2.attestedAmong([freestanding])).toEqual(new Set(['free-venue']));
    });

    it('keeps a knowledge-base donor above the zeros and below every rated experience', () => {
      /*
       * The cross-layer twin channel: this catalogue's places theme publishes
       * no knowledge-base identifiers, so a subject's only place-attesting
       * evidence may live on a geography-layer row whose own kind rates 0 —
       * and a retention that scores that row 0 discards the donor and starves
       * the seat layer. Measured concretely: a canonical subject's twin can be
       * a utility-structure row carrying an open identifier, priority 0
       * before this rule, unseatable in its dense cell.
       */
      const donor = packRecord({
        id: 'donor',
        sourceCategory: 'substation',
        sourceCategoryPath: [],
        planningRole: 'excluded',
        wikidataId: 'Q9999',
      });
      const plainZero = packRecord({
        id: 'plain-zero',
        sourceCategory: 'substation',
        sourceCategoryPath: [],
        planningRole: 'excluded',
      });
      expect(recallPriorityOf(donor)).toBe(KNOWLEDGE_DONOR_RETENTION_PRIORITY);
      expect(recallPriorityOf(donor)).toBeGreaterThan(0);
      /* Below the smallest score the model gives any rated experience. */
      expect(recallPriorityOf(donor)).toBeLessThan(0.01);
      expect(recallPriorityOf(plainZero)).toBe(0);

      const rated = Array.from({ length: 2 }, (_, index) =>
        packRecord({ id: `rated-${index}` }),
      );
      const { kept } = retainAcrossCells({
        records: [plainZero, donor, ...rated],
        retentionCap: 3,
        perCellCap: 3,
      });
      expect(kept.map((record) => record.id)).toContain('donor');
      expect(kept.map((record) => record.id)).not.toContain('plain-zero');
    });

    it('ranks a conferred designation at retention exactly as the inventory would', () => {
      /*
       * A status word over ground somebody drew a boundary around is the
       * heaviest local-significance channel there is, and retention used to be
       * deaf to it: the classifying values stopped at the category path and no
       * extent was ever passed, so a surveyed reserve ranked identically to an
       * unremarkable lawn and could lose its seat before eligibility ever saw
       * it.
       */
      const lawn = packRecord({
        id: 'lawn',
        sourceCategory: 'park',
        sourceCategoryPath: [],
        planningRole: 'outdoor',
        bounds: {
          southWest: { lat: 35.6, lng: 139.7 },
          northEast: { lat: 35.605, lng: 139.705 },
        },
      });
      const reserve = packRecord({
        id: 'reserve',
        sourceCategory: 'park',
        sourceCategoryPath: [],
        planningRole: 'outdoor',
        attributes: { boundary: 'protected_area' },
        bounds: {
          southWest: { lat: 35.6, lng: 139.7 },
          northEast: { lat: 35.605, lng: 139.705 },
        },
      });
      expect(recallPriorityOf(reserve)).toBeGreaterThan(recallPriorityOf(lawn));

      /* And the word without the boundary stays inert, here as everywhere. */
      const pointClaim = packRecord({
        id: 'point-claim',
        sourceCategory: 'park',
        sourceCategoryPath: [],
        planningRole: 'outdoor',
        attributes: { boundary: 'protected_area' },
      });
      expect(recallPriorityOf(pointClaim)).toBe(recallPriorityOf(packRecord({
        id: 'point-plain',
        sourceCategory: 'park',
        sourceCategoryPath: [],
        planningRole: 'outdoor',
      })));
    });

    it('holds the visitable family to the memory ceiling’s own bound, not the shared one', () => {
      /*
       * The namesake channel is only computable at drain, over the whole
       * ground — so a visitable record evicted before drain on the
       * evidence-blind comparator is a landmark lost to a memory guard acting
       * as a second retention policy. The densest measured cell holds 7,602
       * visitable rows; the bound must hold all of them.
       */
      expect(sinkVisitableBoundFor(3_680, 9)).toBeGreaterThanOrEqual(13_333);
      expect(sinkVisitableBoundFor(3_680, 9)).toBeGreaterThanOrEqual(sinkBucketBoundFor(3_680, 9));
      /* And it is still a bound, because the guard must remain a memory guard. */
      expect(sinkVisitableBoundFor(20, 1)).toBeLessThanOrEqual(120_000);
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

    /** Row groups the fake file publishes, all overlapping the box. */
    const GROUPS_IN_FIXTURE_FILE = 40;

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
      const GROUPS = GROUPS_IN_FIXTURE_FILE;
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

    /*
     * The one test in this file that drives the full six-layer provider over
     * the 12,000-row fixture end to end. Solo it runs well inside a second;
     * under a whole-repo parallel run it shares cores with the compiler suite
     * and the 5 s default has flaked twice. The allowance states the test's
     * real weight — it does not paper over a product change.
     */
    it('reads past the first corner and keeps the landmarks it finds there', { timeout: 20_000 }, async () => {
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
       * 1. THE READ. Not one of the budgets the inventory layer is handed may be
       *    small enough to stop it inside the first corner. The row-group figure
       *    used to be 22 of the 27 a metropolis overlaps and is now a
       *    catastrophic backstop; the retained ceiling used to be the retention
       *    cap in disguise (1,840 × 2.5 is two row groups of a real city).
       */
      const placesBudget = seen.budgets[1]!;
      expect(placesBudget.maxFeaturesRetained).toBeGreaterThan(50_000);
      expect(placesBudget.maxRowGroups).toBeGreaterThan(GROUPS_IN_FIXTURE_FILE);
      /*
       * And the third count, which was unasserted and is the same defect in a
       * different unit. `maxFeaturesRead` bounds *decoded rows*, globally across
       * every layer and file; a metropolitan box holds 590,500 rows inside it in
       * the places layer alone. Sized below that, this stops the inventory
       * part-way through the destination and leaves `shortfallBytes` at zero,
       * because the plan never hears about it — the row-group cap wearing its
       * third hat.
       */
      expect(placesBudget.maxFeaturesRead).toBeGreaterThan(1_000_000);
      /* And the layer may spend a real share of the byte budget, not a token. */
      expect(placesBudget.maxBytes).toBeGreaterThan(100_000_000);

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

    it('acquires the edge of a country-shaped scope, not only the ground near its centroid', async () => {
      /*
       * The live failure, in synthetic geography. A country-breadth scope
       * partitions to a grid far beyond the old cell cap of 24; the cap kept
       * the cells nearest the centroid — a coastal country's empty interior —
       * and dropped the edges, which is where its biggest city stands. Every
       * record there was refused before ranking, retention or any budget had a
       * say: its position fell in no scheduled cell, and the scan's box (the
       * union of scheduled cells) did not even cover it.
       *
       * With the cap demoted to a memory backstop the full trimmed grid is
       * scheduled, the byte-priced scan decides affordability, and the seat
       * arithmetic divides across the cells that hold records — so the empty
       * interior neither costs bytes nor holds seats.
       */
      const countryBounds = {
        southWest: { lat: -55, lng: -40 },
        northEast: { lat: -51, lng: -30.6 },
      };
      const countryScope = geographicScopeSchema.parse({
        ...scope,
        destinationCandidateId: 'relation/2',
        breadth: 'country',
        center: { lat: -53, lng: -35.3 },
        bounds: countryBounds,
        shape: { kind: 'bounds', bounds: countryBounds },
      });
      const countryCatalogue = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/catalog.json') && url.includes('2026-07-22.0')) return jsonResponse(RELEASE);
        if (url.endsWith('/catalog.json') && !url.includes('2026-07-22.0')) return jsonResponse(ROOT);
        if (url.endsWith('collection.json')) {
          return jsonResponse({ links: [{ rel: 'item', href: './00000/00000.json' }] });
        }
        return jsonResponse({
          bbox: [-40.2, -55.2, -30.4, -50.8],
          properties: { 'table:row_count': 1_000_000 },
          assets: {
            data: {
              href: 'https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com/r/x/part-0.zstd.parquet',
              type: 'application/vnd.apache.parquet',
            },
          },
        });
      });

      /* The coastal city on the west edge, and lone subjects on the others. */
      const edgePoints = [
        ...Array.from({ length: 12 }, (_, index) => ({
          name: `Edge Cathedral ${index}`,
          lat: -54.9 + index * 0.01,
          lng: -39.9,
        })),
        { name: 'Edge Lighthouse South', lat: -54.95, lng: -35.2 },
        { name: 'Edge Lighthouse East', lat: -53, lng: -30.7 },
        { name: 'Edge Lighthouse North', lat: -51.05, lng: -35.3 },
      ];
      const countryScan = (async <T,>(request: {
        counters: ScanCounters;
        requiredColumns: readonly string[];
        accept: (row: Record<string, unknown>) => T | null;
      }) => {
        const rows: T[] = [];
        /* Only the place inventory is populated; the geography layers are empty. */
        if (!request.requiredColumns.includes('sources')) {
          return { rows, counters: request.counters, stoppedBecause: 'complete' };
        }
        request.counters.rowGroupsRead += 1;
        const publish = (row: Record<string, unknown>): void => {
          request.counters.featuresRead += 1;
          const accepted = request.accept(row);
          if (accepted !== null) rows.push(accepted);
        };
        for (const [index, point] of edgePoints.entries()) {
          publish({
            id: `edge-${index}`,
            names: { primary: point.name },
            taxonomy: { primary: 'temple', hierarchy: ['cultural_and_historic', 'temple'] },
            operating_status: 'open',
            sources: [{ dataset: 'meta', license: 'CDLA-Permissive-2.0', record_id: `edge-${index}` }],
            subtype: 'temple',
            class: 'temple',
            bbox: { xmin: point.lng, xmax: point.lng, ymin: point.lat, ymax: point.lat },
          });
        }
        /* The interior the centroid priority used to spend the whole cap on. */
        for (let index = 0; index < 200; index += 1) {
          publish({
            id: `inland-${index}`,
            names: { primary: `Chain Outlet ${index}` },
            taxonomy: { primary: 'atm', hierarchy: ['financial_service', 'atm'] },
            operating_status: 'open',
            sources: [{ dataset: 'meta', license: 'CDLA-Permissive-2.0', record_id: `inland-${index}` }],
            subtype: 'atm',
            class: 'atm',
            bbox: {
              xmin: -35.3 + (index % 10) * 0.01,
              xmax: -35.3 + (index % 10) * 0.01,
              ymin: -53.05 + Math.floor(index / 10) * 0.01,
              ymax: -53.05 + Math.floor(index / 10) * 0.01,
            },
          });
        }
        return { rows, counters: request.counters, stoppedBecause: 'complete' };
      }) as unknown as typeof scanFile;

      const provider = createOverturePackProvider({
        fetchOptions: { fetchImpl: countryCatalogue as unknown as typeof fetch },
        scanImpl: countryScan,
        now: () => new Date('2026-01-01T00:00:00Z'),
      });
      const outcome = await provider.getPack({ scope: countryScope, now: new Date('2026-01-01T00:00:00Z') });
      expect(outcome.kind === 'ready' || outcome.kind === 'partial').toBe(true);
      const pack = (outcome as { pack: RegionPack }).pack;

      /* The whole trimmed grid is scheduled; nothing was dropped to a budget. */
      expect(pack.partition.cells.length).toBeGreaterThan(24);
      expect(pack.partition.droppedCells).toBe(0);
      for (const point of edgePoints) {
        const scheduled = pack.partition.cells.some(
          (cell) =>
            point.lat >= cell.bounds.southWest.lat &&
            point.lat <= cell.bounds.northEast.lat &&
            point.lng >= cell.bounds.southWest.lng &&
            point.lng <= cell.bounds.northEast.lng,
        );
        expect(scheduled).toBe(true);
      }

      /* And acquired: every edge subject is in the pack, not only the interior. */
      const places = pack.layers.find((layer) => layer.id === 'places')!;
      const edgeNames = places.records
        .map((record) => record.name)
        .filter((name) => name.startsWith('Edge '));
      expect(new Set(edgeNames).size).toBe(edgePoints.length);
    });

    /**
     * THE HOLDING PEN MUST HOLD WHAT THE COVERAGE PASS WILL ASK FOR.
     *
     * Measured on the real Tokyo ground: the city's only public-market records
     * ranked 3,795th of 6,754 in their (cell, family) queue — beyond any
     * affordable comparator prefix — and a sink that keeps only the global
     * prefix evicts them before retention can run its kind-coverage pass at
     * all. The per-kind pen is what carries them across, and this drives the
     * whole provider so the pen and the pass are proven *together*: remove
     * either and the market vanishes from the pack.
     */
    it('carries a rare kind through the pen even when one crowd overflows it', async () => {
      const CROWD = 5_200; // beyond the (cell, family) pen bound of 3,680
      const crowdedScan = (async (request: Parameters<typeof scanFile>[0]) => {
        for (let index = 0; index < CROWD; index += 1) {
          const accepted = request.accept({
            id: `crowd-${String(index).padStart(5, '0')}`,
            names: { primary: `Gallery ${index}` },
            taxonomy: { primary: 'art_gallery', hierarchy: ['arts_and_entertainment', 'art_gallery'] },
            operating_status: 'open',
            sources: [
              { dataset: 'meta', license: 'CDLA-Permissive-2.0', record_id: `c-${index}`, confidence: 0.99 },
            ],
            bbox: { xmin: -74.02, xmax: -74.02, ymin: 40.7, ymax: 40.7 },
          });
          if (accepted !== null) request.sink?.add(accepted as SourceRecord);
        }
        const market = request.accept({
          id: 'market-hall',
          names: { primary: 'Covered Market Hall' },
          taxonomy: { primary: 'public_market', hierarchy: ['shopping', 'market', 'public_market'] },
          operating_status: 'open',
          sources: [
            { dataset: 'meta', license: 'CDLA-Permissive-2.0', record_id: 'm-1', confidence: 0.6 },
          ],
          bbox: { xmin: -74.021, xmax: -74.021, ymin: 40.701, ymax: 40.701 },
        });
        if (market !== null) request.sink?.add(market as SourceRecord);
        return { rows: [], counters: request.counters, stoppedBecause: 'complete' as const };
      }) as unknown as typeof scanFile;

      const provider = createOverturePackProvider({
        fetchOptions: { fetchImpl: catalogueFetch as unknown as typeof fetch },
        scanImpl: crowdedScan,
        now: () => new Date('2026-01-01T00:00:00Z'),
      });
      const outcome = await provider.getPack({ scope, now: new Date('2026-01-01T00:00:00Z') });
      const pack = (outcome as { pack: RegionPack }).pack;
      const places = pack.layers.find((layer) => layer.id === 'places')!;

      /*
       * The market ranks below every gallery on priority (0.18 against 0.26)
       * and below every gallery on confidence, so nothing but the per-kind pen
       * and the kind-coverage seat can be keeping it here.
       */
      expect(places.records.some((record) => record.sourceCategory === 'public_market')).toBe(true);
    }, 30_000);

    /**
     * THE NAMESAKE CHANNEL, WIRED — the pen, the ledger and the retention pass
     * proven together through the whole provider.
     *
     * The shape of the measured live failure: one kind hundreds deep at one
     * flat priority, the tie broken by source confidence, and the record the
     * surrounding ground is *named after* carrying the lowest confidence of
     * its whole kind — a sprawling landmark complex reads less "confirmed"
     * than a storefront. Rank order alone puts it behind every one of them,
     * and the retention squeeze drops it. Only the drain-time attestation —
     * three other rows of the read carrying its name within walking distance —
     * can seat it, so this test fails if the ledger, the wider visitable pen,
     * or the priority handed to `retainAcrossCells` is unwired.
     */
    it('retains the record the surrounding ground is named after, through the whole provider', async () => {
      const CROWD = 300;
      const namesakeScan = (async (request: Parameters<typeof scanFile>[0]) => {
        const feed = (row: Record<string, unknown>): void => {
          const accepted = request.accept(row);
          if (accepted !== null) request.sink?.add(accepted as SourceRecord);
        };
        for (let index = 0; index < CROWD; index += 1) {
          feed({
            id: `crowd-${String(index).padStart(4, '0')}`,
            names: { primary: `Wayside Shrine ${index}` },
            taxonomy: { primary: 'temple', hierarchy: ['cultural_and_historic', 'temple'] },
            operating_status: 'open',
            sources: [
              { dataset: 'meta', license: 'CDLA-Permissive-2.0', record_id: `c-${index}`, confidence: 0.99 },
            ],
            bbox: { xmin: -74.02, xmax: -74.02, ymin: 40.7, ymax: 40.7 },
          });
        }
        feed({
          id: 'landmark-1',
          names: { primary: 'Basaltspire Sanctum' },
          taxonomy: { primary: 'temple', hierarchy: ['cultural_and_historic', 'temple'] },
          operating_status: 'open',
          sources: [
            { dataset: 'meta', license: 'CDLA-Permissive-2.0', record_id: 'l-1', confidence: 0.6 },
          ],
          bbox: { xmin: -74.021, xmax: -74.021, ymin: 40.701, ymax: 40.701 },
        });
        /* The ground's own testimony: commodity rows named after the landmark. */
        for (const [index, suffix] of ['North Gate', 'Kiosk', 'Tram Stop'].entries()) {
          feed({
            id: `witness-${index}`,
            names: { primary: `Basaltspire Sanctum ${suffix}` },
            taxonomy: { primary: 'atm', hierarchy: ['financial_service', 'atm'] },
            operating_status: 'open',
            sources: [
              { dataset: 'meta', license: 'CDLA-Permissive-2.0', record_id: `w-${index}`, confidence: 0.9 },
            ],
            bbox: { xmin: -74.0211, xmax: -74.0211, ymin: 40.7011, ymax: 40.7011 },
          });
        }
        return { rows: [], counters: request.counters, stoppedBecause: 'complete' as const };
      }) as unknown as typeof scanFile;

      const provider = createOverturePackProvider({
        fetchOptions: { fetchImpl: catalogueFetch as unknown as typeof fetch },
        scanImpl: namesakeScan,
        /* A squeeze, so a seat has to be won rather than left over. */
        budget: { maxFeaturesRetained: 200 },
        now: () => new Date('2026-01-01T00:00:00Z'),
      });
      const outcome = await provider.getPack({ scope, now: new Date('2026-01-01T00:00:00Z') });
      const pack = (outcome as { pack: RegionPack }).pack;
      const places = pack.layers.find((layer) => layer.id === 'places')!;
      /* The squeeze is real: most of the crowd is not kept... */
      expect(places.records.length).toBeLessThan(CROWD / 2);
      /* ...and the attested landmark is, from the bottom of its tie tier. */
      expect(places.records.some((record) => record.name === 'Basaltspire Sanctum')).toBe(true);
    }, 30_000);

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
     *
     * Which is why the volume is spent on one file and not on six, and why the
     * budget below is what it is. Being the heaviest test in the suite, its wall
     * time is whatever the machine has left, and a whole-repo run puts every
     * worker on the same cores: it measured 35,119 ms against a 30,000 ms budget
     * there while its own file passed 73/73 solo in seconds.
     *
     * Both halves of the answer are measured, on this machine, after the scan
     * below stopped handing the over-limit batch to five files that cannot carry
     * it:
     *
     *   - the test alone:                        11.1s before, 5.0/5.2/5.1s after
     *   - its own file, six consecutive runs:    73/73 every time
     *   - a whole-repo run:                      13,764 ms
     *   - a whole-repo run against four other
     *     concurrent whole-repo runs:            35,356 ms
     *
     * So the work is halved *and* the budget is set from the worst figure that
     * was actually observed rather than from the ordinary one — 90,000 ms is
     * ~6.5x the whole-repo measurement and ~2.5x the oversubscribed one. This is
     * one declared timeout on one test; the suite default is untouched, and a
     * budget that only clears the good day is the thing this test kept failing
     * on.
     */
    it('appends a layer larger than the engine will accept as an argument list', async () => {
      const HUGE = 115_000;
      const hugeScan = (async (request: Parameters<typeof scanFile>[0]) => {
        /*
         * The over-limit batch belongs to the places file and to no other.
         *
         * A catalogue scan asks six files for this scope, and a fixture that
         * answered every one of them with the same 115,000 place rows pushed
         * 690,000 through the holding pen to assert something about 115,000:
         * the five geography files each took a copy of a batch labelled
         * `layerId: 'places'`, which cannot reach the places layer from there
         * and only ever cost time. Measured on this machine, solo: 11.1s of
         * test time before, 5.0/5.2/5.1s after, with the surviving batch still
         * 115,000 — above the ~109,832 the engine accepts as an argument list,
         * which is the whole point and is not reduced by a single row.
         *
         * `taxonomy` is the places dataset's column and appears in no other
         * request, so the one file under test is picked by what it asks for
         * rather than by the order the layers happen to be built in.
         */
        const isPlacesFile = request.columns.includes('taxonomy');
        if (!isPlacesFile) {
          return { rows: [], counters: request.counters, stoppedBecause: 'complete' as const };
        }
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
      const exhausted = pack.diagnostics.budgetsExhausted ?? [];
      expect(exhausted).not.toContain('places:provider_error');
      /*
       * Named explicitly, because this is the fault that was being reported as
       * somebody else's service failing. A spread reintroduced anywhere on the
       * path from the reader to the holding pen lands here.
       */
      expect(exhausted).not.toContain('places:internal_limit');
      /* 90,000 ms: see the measurements in the note above this test. */
    }, 90_000);

    /**
     * A TRUNCATED AREA HAS TO SAY SO, ON THE ARTIFACT.
     *
     * The stored metropolitan pack that opened this phase recorded 1,840 records
     * and a stop reason, and nothing anywhere in it distinguished "this is what
     * is there" from "this is the third of it we paid for". A pack outlives the
     * run that built it and is read months later by somebody asking why a
     * destination looked thin, so the shortfall belongs on the pack in bytes —
     * not only in a log, and never as a bare reason word.
     */
    it('writes the unread remainder onto the layer when the area cost more than the allowance', async () => {
      const truncatedScan = (async (request: Parameters<typeof scanFile>[0]) => {
        const rows: SourceRecord[] = [];
        for (let index = 0; index < 40; index += 1) {
          const accepted = request.accept({
            id: `t-${index}`,
            names: { primary: `Place ${index}` },
            taxonomy: { primary: 'museum', hierarchy: ['arts_and_entertainment', 'museum'] },
            operating_status: 'open',
            sources: [{ dataset: 'meta', license: 'CDLA-Permissive-2.0', record_id: `t-${index}` }],
            subtype: 'museum',
            class: 'museum',
            bbox: { xmin: -74 + index * 0.001, xmax: -74 + index * 0.001, ymin: 40.7, ymax: 40.7 },
          });
          if (accepted !== null) rows.push(accepted as SourceRecord);
        }
        const plan: ScanReadPlan = {
          rowGroupsInFile: 256,
          rowGroupsOverlapping: 27,
          rowGroupsPlanned: 9,
          rowsPlanned: 40,
          projectedBytes: 48_000_000,
          plannedBytes: 16_000_000,
          shortfallBytes: 32_000_000,
        };
        return { rows, counters: request.counters, stoppedBecause: 'byte_budget' as const, plan };
      }) as unknown as typeof scanFile;

      const reports: AcquisitionReport[] = [];
      const provider = createOverturePackProvider({
        fetchOptions: { fetchImpl: catalogueFetch as unknown as typeof fetch },
        scanImpl: truncatedScan,
        onAcquisition: (report) => reports.push(report),
        now: () => new Date('2026-01-01T00:00:00Z'),
      });
      const outcome = await provider.getPack({ scope, now: new Date('2026-01-01T00:00:00Z') });
      const pack = (outcome as { pack: RegionPack }).pack;
      const places = pack.layers.find((layer) => layer.id === 'places')!;

      /* On the artifact, in bytes, in a sentence a person can act on. */
      expect(places.note).toMatch(/9 of 27 blocks/);
      expect(places.note).toMatch(/32\.0 MB/);

      /* And in the diagnostics, attributed to the layer that was cut. */
      expect(pack.diagnostics.budgetsExhausted).toContain('places:byte_budget');

      /* And in the run report, as the funnel rather than as a total. */
      const placesAcquisition = reports[0]!.layers.find((layer) => layer.layerId === 'places')!;
      expect(placesAcquisition.shortfallBytes).toBe(32_000_000);
      expect(placesAcquisition.rowGroupsPlanned).toBe(9);
      expect(placesAcquisition.rowGroupsOverlapping).toBe(27);
      expect(placesAcquisition.rowsNormalised).toBeGreaterThan(0);
    });

    /**
     * ONE ALLOWANCE PER LAYER, NOT ONE PER FILE.
     *
     * A layer reads up to **fourteen** files, and what it may spend is a ceiling
     * on the *shared running counter* — computed once, before the first file, so
     * that "this layer may reach here in total" survives being handed to each
     * file in turn. Recompute it inside the loop and every file is priced
     * against the whole layer ceiling again: a six-file layer spends six times
     * its allowance, the layers behind it are starved of ground they were owed,
     * and the deployment-wide byte budget everybody reasons about means nothing.
     *
     * Nothing tested this, because every fixture in this file publishes exactly
     * one file per theme — the single arrangement in which a per-file purse and
     * a shared ceiling are indistinguishable.
     */
    it('gives a layer one byte ceiling to share across its files, not one each', async () => {
      const twoFileCatalogue = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/catalog.json') && url.includes('2026-07-22.0')) return jsonResponse(RELEASE);
        if (url.endsWith('/catalog.json')) return jsonResponse(ROOT);
        if (url.endsWith('collection.json')) {
          return jsonResponse({
            links: [
              { rel: 'item', href: './00000/00000.json' },
              { rel: 'item', href: './00001/00001.json' },
            ],
          });
        }
        const part = url.includes('00001') ? 'part-1' : 'part-0';
        return jsonResponse({
          bbox: [-74.2, 40.5, -73.8, 40.9],
          properties: { 'table:row_count': 1_000_000 },
          assets: {
            data: {
              href: `https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com/r/x/${part}.zstd.parquet`,
              type: 'application/vnd.apache.parquet',
            },
          },
        });
      });

      /**
       * What each file would like to spend, if nothing stopped it.
       *
       * Sized so the layer's allowance genuinely binds across the pair — two
       * files that comfortably fit would agree with a per-file purse and a
       * shared ceiling alike, and prove nothing.
       */
      const APPETITE = 70_000_000;
      interface Spend {
        url: string;
        places: boolean;
        ceiling: number;
        before: number;
        after: number;
      }
      const spends: Spend[] = [];

      /**
       * A reader that pays, and that obeys the ceiling the way the real one
       * does: `maxBytes` bounds the **shared counter**, not this file's own
       * appetite. Anything else here would be a fixture asserting the defect.
       */
      const payingScan = (async (request: Parameters<typeof scanFile>[0]) => {
        const before = request.counters.bytesTransferred;
        const affordable = Math.max(0, request.budget.maxBytes - before);
        const spent = Math.min(APPETITE, affordable);
        request.counters.bytesTransferred += spent;
        request.counters.rowGroupsRead += 1;
        request.counters.featuresRead += 4;
        spends.push({
          url: request.url,
          places: request.requiredColumns.includes('sources'),
          ceiling: request.budget.maxBytes,
          before,
          after: request.counters.bytesTransferred,
        });

        const rows: SourceRecord[] = [];
        for (let index = 0; index < 4; index += 1) {
          const accepted = request.accept({
            id: `${request.url.slice(-20)}-${index}`,
            names: { primary: `Place ${index}` },
            taxonomy: { primary: 'museum', hierarchy: ['arts_and_entertainment', 'museum'] },
            operating_status: 'open',
            sources: [{ dataset: 'meta', license: 'CDLA-Permissive-2.0', record_id: `x-${index}` }],
            subtype: 'museum',
            class: 'museum',
            bbox: { xmin: -74 + index * 0.01, xmax: -74 + index * 0.01, ymin: 40.7, ymax: 40.7 },
          });
          if (accepted !== null) rows.push(accepted as SourceRecord);
        }
        return {
          rows,
          counters: request.counters,
          stoppedBecause: spent < APPETITE ? ('byte_budget' as const) : ('complete' as const),
        };
      }) as unknown as typeof scanFile;

      const provider = createOverturePackProvider({
        fetchOptions: { fetchImpl: twoFileCatalogue as unknown as typeof fetch },
        scanImpl: payingScan,
        now: () => new Date('2026-01-01T00:00:00Z'),
      });
      await provider.getPack({ scope, now: new Date('2026-01-01T00:00:00Z') });

      const places = spends.filter((entry) => entry.places);
      /* Two files of one layer actually reached the reader. */
      expect(places).toHaveLength(2);
      expect(new Set(places.map((entry) => entry.url)).size).toBe(2);

      /* The same ceiling handed to both — an absolute figure, not a purse. */
      expect(places[1]!.ceiling).toBe(places[0]!.ceiling);

      /*
       * And the ceiling holds across the pair. Per-file pricing shows up here as
       * a layer that spent twice what it was allowed, which for a fourteen-file
       * layer is fourteen times.
       */
      const layerSpend = places[1]!.after - places[0]!.before;
      const allowance = places[0]!.ceiling - places[0]!.before;
      expect(places[1]!.after).toBeLessThanOrEqual(places[0]!.ceiling);
      expect(layerSpend).toBeLessThanOrEqual(allowance);
      /* The second file was rationed by what the first had already spent. */
      expect(places[1]!.after - places[1]!.before).toBeLessThan(APPETITE);
    });
  });

  describe('read allowance, in the unit the read is paid in', () => {
    const TOTAL = 260_000_000;

    it('gives the inventory layer a real share of the byte budget', () => {
      /*
       * The number that matters, and the unit it is in is the whole point. A
       * metropolis's entire pruned place inventory prices at about 50 MB; the
       * allowance has to be comfortably above that or the destination is read in
       * part and nobody can tell which part.
       */
      const allowance = byteAllowanceFor('places', TOTAL);
      expect(allowance).toBeGreaterThan(60_000_000);
      expect(allowance).toBeLessThanOrEqual(TOTAL);
    });

    it('cannot starve the layers that come after it', () => {
      /*
       * The geographic layers are where a national park's whole inventory lives,
       * and they run last. Each layer is priced against what is *still unspent*
       * and renormalised over the layers still to come, so no layer can claim
       * ground that is owed to a later one, and the six together never exceed
       * the one figure a deployment reasons about.
       */
      let remaining = TOTAL;
      let spent = 0;
      for (const layer of LAYERS) {
        const allowance = byteAllowanceFor(layer.id, remaining);
        expect(allowance, layer.id).toBeGreaterThan(0);
        spent += allowance;
        remaining -= allowance;
        expect(remaining, layer.id).toBeGreaterThanOrEqual(0);
      }
      expect(spent).toBeLessThanOrEqual(TOTAL);
    });

    it('lets an underspending layer’s leftovers flow to the ones behind it', () => {
      /*
       * The defect the fixed shares caused, in one comparison. The old form
       * reserved the last layer eight per cent of a *global* figure the layers
       * ahead of it had usually already spent — a share of nothing, which is how
       * a ferry terminal stopped being findable. Renormalising over what is left
       * means a quiet layer ahead makes the layers behind it richer, not poorer.
       */
      const lean = byteAllowanceFor('infrastructure', 40_000_000);
      const flush = byteAllowanceFor('infrastructure', 200_000_000);
      expect(flush).toBeGreaterThan(lean);
      /* And the last layer is entitled to everything still unspent. */
      expect(byteAllowanceFor(LAYERS[LAYERS.length - 1]!.id, 40_000_000)).toBe(40_000_000);
    });

    it('discards only records retention could never have kept', () => {
      /*
       * THE PROOF THE HOLDING PEN RESTS ON, RUN RATHER THAN ARGUED.
       *
       * The pen keeps the top `retentionCap` of every (cell, family) queue and
       * drops the rest as the rows arrive — which is what lets a half-million-row
       * area be read at fixed memory instead of the read being stopped to protect
       * a heap. That is only safe because `retainAcrossCells` consumes each queue
       * as a rank-ordered prefix and no queue can contribute more than the whole
       * cap, so everything dropped was already below everything choosable.
       *
       * An argument is not evidence. This runs the real retention over the whole
       * set and over the pruned set and demands the same answer, so a future
       * change to any of the three passes that broke the prefix property would
       * fail here rather than quietly costing a landmark.
       */
      const cap = 40;
      const families: PlanningRole[] = ['attraction', 'food', 'support', 'excluded'];
      const all: SourceRecord[] = [];
      for (let cell = 0; cell < 3; cell += 1) {
        for (const [familyIndex, role] of families.entries()) {
          for (let index = 0; index < 200; index += 1) {
            all.push(
              packRecord({
                id: `c${cell}-f${familyIndex}-r${String(index).padStart(3, '0')}`,
                cellId: `g-${cell}`,
                planningRole: role,
              }),
            );
          }
        }
      }
      /* Priorities that vary within every queue, so a prefix is a real choice. */
      const priorityOf = (record: SourceRecord): number =>
        (Number.parseInt(record.id.slice(-3), 10) * 7919) % 1000;

      const pruned = new Map<string, SourceRecord[]>();
      for (const record of all) {
        const key = `${record.cellId}/${record.planningRole}`;
        const queue = pruned.get(key) ?? [];
        queue.push(record);
        pruned.set(key, queue);
      }
      const bounded = [...pruned.values()].flatMap((queue) =>
        [...queue]
          .sort((a, b) => priorityOf(b) - priorityOf(a) || a.id.localeCompare(b.id))
          .slice(0, cap),
      );

      const whole = retainAcrossCells({ records: all, retentionCap: cap, perCellCap: 16, priorityOf });
      const trimmed = retainAcrossCells({
        records: bounded,
        retentionCap: cap,
        perCellCap: 16,
        priorityOf,
      });
      expect(trimmed.kept.map((record) => record.id).sort()).toEqual(
        whole.kept.map((record) => record.id).sort(),
      );
      expect(whole.kept.length).toBe(cap);
    });

    it('bounds the holding pen without ever letting it lose a keepable record', () => {
      /*
       * The sink may only drop records that could never have been kept. The
       * lossless bound is the retention cap — no cell-and-family queue can
       * contribute more than the whole cap — so the bound may be raised by spare
       * memory and must never fall below it.
       */
      for (const cells of [1, 3, 9, 24]) {
        for (const cap of [20, 320, 1_840, 4_000]) {
          expect(sinkBucketBoundFor(cap, cells), `${cap}/${cells}`).toBeGreaterThanOrEqual(cap);
        }
      }
      /* A small layer with room to spare does not evict at all. */
      expect(sinkBucketBoundFor(72, 9)).toBeGreaterThan(1_000);
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

  it('keeps the designation-bearing columns a conferred status arrives in', () => {
    /*
     * A protected-area boundary, a heritage listing, a protection title: these
     * are the columns the significance model's designation channel reads, the
     * inventory's classifying-value list names every one of them, and an
     * allowlist that drops them makes a surveyed reserve normalise identically
     * to a lawn. Measured on a real four-cell metropolitan read: 170 geography
     * rows carry at least one, and none survived normalisation.
     */
    const definition = layerById('land_use')!;
    const record = definition.normalize(
      {
        id: 'lu-1',
        names: { primary: 'Basalt Fell Reserve' },
        subtype: 'park',
        class: 'park',
        source_tags: {
          boundary: 'protected_area',
          heritage: 'yes',
          protect_class: '5',
          protection_title: 'scenic reserve',
          site_type: 'megalith',
          landuse: 'meadow',
        },
        sources: [{ dataset: 'OpenStreetMap', license: 'ODbL-1.0' }],
        bbox: { xmin: -74.02, xmax: -74.01, ymin: 40.7, ymax: 40.71 },
      },
      {
        layerId: 'land_use',
        cellId: 'g-0-0',
        defaultLicenceId: 'ODbL-1.0',
        containmentFor: () => ({ divisionIds: [] }),
      },
    );
    expect(record?.attributes.boundary).toBe('protected_area');
    expect(record?.attributes.heritage).toBe('yes');
    expect(record?.attributes.protect_class).toBe('5');
    expect(record?.attributes.protection_title).toBe('scenic reserve');
    expect(record?.attributes.site_type).toBe('megalith');
    expect(record?.attributes.landuse).toBe('meadow');
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

  /**
   * THE KNOWLEDGE-BASE COLUMN THAT ISN'T, AND THE ONE THAT IS THE WRONG SUBJECT.
   *
   * Verified against the real catalogue (Overture release 2026-07-22.0,
   * anonymous range reads of the footer schema): the places theme publishes no
   * place-level `wikidata` leaf and no `source_tags` map. Its only knowledge-base
   * leaf is `brand.wikidata`, which identifies a *company*.
   *
   * Both halves are pinned here because both are the kind of thing somebody
   * repairs by widening a projection. Adding `brand` to `PLACE_COLUMNS` and
   * routing it to `wikidataId` looks like it fixes the silence and would in fact
   * hand a corporate identifier to 4.74% of a metropolis's rows — 13,201 of
   * Tokyo's 278,369 — against the single digits per pack that genuine
   * place-level evidence reaches, at which point the knowledge-base channel *is*
   * the brand column. That is §8.3's "one source becoming global truth" and §4's
   * café outranking a temple, arriving as a one-line improvement.
   */
  it('takes no knowledge-base identifier from a place row, including a brand’s', () => {
    const layer = layerById('places')!;
    expect(layer.columns).not.toContain('brand');
    expect(layer.columns).not.toContain('wikidata');
    expect(layer.columns).not.toContain('source_tags');

    const record = layer.normalize(
      {
        id: 'gers-brand',
        names: { primary: 'Chain Coffee, Third Street' },
        taxonomy: { primary: 'cafe', hierarchy: ['eat_and_drink', 'cafe'] },
        // Shaped as the real row is, including the leaves the projection omits,
        // so this fails the day the normaliser starts reading either of them.
        brand: { wikidata: 'Q37158', names: { primary: 'Chain Coffee' } },
        wikidata: 'Q37158',
        source_tags: { wikidata: 'Q37158', wikipedia: 'en:Chain Coffee' },
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

    expect(record).not.toBeNull();
    expect(record!.wikidataId).toBeUndefined();
    expect(record!.attributes.wikipedia).toBeUndefined();
    expect(record!.attributes.wikidata).toBeUndefined();
  });

  /**
   * THE ALTERNATE CATEGORY LIST IS A SEARCH FACET AND MAY NOT BECOME EVIDENCE.
   *
   * `categories.alternate` is published on 63.8% of a Tokyo box's in-box rows
   * and 74.7% of a Lisbon one's, and routing it into the classifying values
   * raises the conferred-designation channel from 24 rows to 187 on Tokyo and
   * from 3 to 42 on Lisbon. It is the single most inviting widening available in
   * this file, and the rows it would add are wrong: on Tokyo, `wildlife_sanctuary`
   * arrives on a condominium management association and a nightclub, and
   * `national_park` on a children's playground and a newspaper's head office. On
   * Lisbon the same two values arrive on a dental clinic, a hospital, two
   * kindergartens and the National Pensions Centre.
   *
   * The fixture below is the shape of the real row: a shrine whose alternate list
   * carries a designation word it has no claim to. What the assertion protects is
   * that nothing the record hands on can satisfy `hasDesignatedStatus` — the
   * source category, its published hierarchy, and the planning attributes are the
   * only things the compiler builds classifying values from.
   */
  it('takes no conferred designation from a place row’s alternate category list', () => {
    const layer = layerById('places')!;
    const record = layer.normalize(
      {
        id: 'gers-alternate',
        names: { primary: '諏訪神社' },
        taxonomy: { primary: 'shinto_shrine', hierarchy: ['religious_site', 'shinto_shrine'] },
        // Both spellings the file carries, so this fails whichever one is read.
        categories: { primary: 'shinto_shrine', alternate: ['wildlife_sanctuary', 'national_park'] },
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

    expect(record).not.toBeNull();
    expect(record!.sourceCategory).toBe('shinto_shrine');
    expect(
      hasDesignatedStatus([
        record!.sourceCategory,
        ...record!.sourceCategoryPath,
        ...Object.values(record!.attributes),
      ]),
    ).toBe(false);
    expect(
      assessPlaceStanding({
        classifyingValues: [record!.sourceCategory, ...record!.sourceCategoryPath],
      }).localSignificance,
    ).toBeUndefined();
  });

  /**
   * The other side of the same fact: the supplemental geography layers *do*
   * publish it, which is the only reason a cross-layer transfer has anything to
   * carry. Q183536 sits at Tokyo Tower's coordinates in the infrastructure
   * layer while the place catalogue holds the observation deck two metres away.
   */
  it('keeps the knowledge-base identifier the geography layers do publish', () => {
    const record = layerById('infrastructure')!.normalize(
      {
        id: 'osm-tower',
        names: { primary: '東京タワー', common: { en: 'Tokyo Tower' } },
        class: 'communication_tower',
        subtype: 'tower',
        wikidata: 'Q183536',
        source_tags: { wikipedia: 'ja:東京タワー' },
        sources: [{ dataset: 'OpenStreetMap', license: 'ODbL-1.0' }],
        bbox: { xmin: 139.7454, xmax: 139.7454, ymin: 35.6586, ymax: 35.6586 },
      },
      {
        layerId: 'infrastructure',
        cellId: 'g-0-0',
        defaultLicenceId: 'ODbL-1.0',
        containmentFor: () => ({ divisionIds: [] }),
      },
    );

    expect(record?.wikidataId).toBe('Q183536');
    expect(record?.attributes.wikipedia).toBe('ja:東京タワー');
    expect(record?.alternateNames).toContain('Tokyo Tower');
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
