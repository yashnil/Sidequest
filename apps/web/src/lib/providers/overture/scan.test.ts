import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FileMetaData } from 'hyparquet';

/**
 * `scanFile`, RUN — WHICH NOTHING ELSE IN THE SUITE DOES.
 *
 * `overture.test.ts` tests the pure helpers (`overlappingRowGroups`,
 * `stratifyRowGroups`, `stratificationOf`, `rowInBox`) and drives the pack
 * provider through an injected `scanImpl`, so the real `scanFile` — the function
 * that decides the read order and reports what it did — has never executed in a
 * test. That is how a correct predicate can sit beside a result object that
 * never carries its answer, which is a green test protecting nothing.
 *
 * The columnar reader and the byte source are the only things here that need a
 * network, so both are replaced: `hyparquet` returns fixture metadata and
 * fixture rows, and `fetch` answers a HEAD and a range with empty bytes. No
 * network, no parquet file, and the function under test is the real one.
 */

const readObjects = vi.fn();
const readMetadata = vi.fn();

vi.mock('hyparquet', () => ({
  parquetMetadataAsync: (...args: unknown[]) => readMetadata(...args),
  parquetReadObjects: (...args: unknown[]) => readObjects(...args),
}));

import { scanFile, type ScanBudget, type ScanCounters } from './scan';

/** Row groups with no statistics at all — an older writer, or another producer. */
function metadataWithoutStatistics(groupCount: number): FileMetaData {
  return {
    row_groups: Array.from({ length: groupCount }, () => ({
      num_rows: 4n,
      total_byte_size: 1n,
      columns: [],
    })),
    schema: [{ name: 'bbox' }, { name: 'id' }],
  } as unknown as FileMetaData;
}

function metadataWithStatistics(groupCount: number): FileMetaData {
  return {
    row_groups: Array.from({ length: groupCount }, (_, index) => ({
      num_rows: 4n,
      total_byte_size: 1n,
      columns: (
        [
          ['bbox.xmin', 139 + index * 0.1, 139.05 + index * 0.1],
          ['bbox.xmax', 139 + index * 0.1, 139.05 + index * 0.1],
          ['bbox.ymin', 35 + index * 0.1, 35.05 + index * 0.1],
          ['bbox.ymax', 35 + index * 0.1, 35.05 + index * 0.1],
        ] as const
      ).map(([path, min, max]) => ({
        meta_data: {
          path_in_schema: path.split('.'),
          statistics: { min_value: min, max_value: max },
        },
      })),
    })),
    schema: [{ name: 'bbox' }, { name: 'id' }],
  } as unknown as FileMetaData;
}

function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: unknown, init?: { method?: string }) =>
      init?.method === 'HEAD'
        ? new Response(null, { status: 200, headers: { 'content-length': '4096' } })
        : new Response(new ArrayBuffer(8), { status: 206 }),
    ),
  );
}

function request(metadata: FileMetaData) {
  readMetadata.mockResolvedValue(metadata);
  readObjects.mockResolvedValue([{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]);
  const counters: ScanCounters = {
    bytesTransferred: 0,
    rowGroupsInspected: 0,
    rowGroupsRead: 0,
    featuresRead: 0,
  };
  const budget: ScanBudget = {
    maxRowGroups: 3,
    maxBytes: 10_000_000,
    maxFeaturesRead: 10_000,
    maxFeaturesRetained: 10_000,
    deadlineMs: Date.now() + 60_000,
  };
  return {
    url: 'https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com/x/part-0.zstd.parquet',
    box: { west: 139, south: 35, east: 140, north: 36 },
    columns: ['id', 'bbox'],
    requiredColumns: ['bbox'],
    budget,
    counters,
    accept: (row: Record<string, unknown>) => row,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  readMetadata.mockReset();
  readObjects.mockReset();
});

describe('what a scan reports about its own read order', () => {
  it('says stratification was unavailable when no row group published statistics', async () => {
    /*
     * THE SILENT REGRESSION, END TO END.
     *
     * Eight groups, none with statistics, and a budget for three: the ordering
     * cannot bin anything, so it emits file order and the three groups read are
     * whichever three the file happens to start with. That is the corner-biased
     * read the stratification exists to prevent, and before this the result
     * object was indistinguishable from a properly spread one.
     */
    stubFetch();
    const result = await scanFile(request(metadataWithoutStatistics(8)));
    expect(result.stratification).toBe('unavailable');
    expect(result.stoppedBecause).toBe('row_group_budget');
  });

  it('says stratification was applied when the writer published statistics', async () => {
    stubFetch();
    const result = await scanFile(request(metadataWithStatistics(8)));
    expect(result.stratification).toBe('applied');
  });
});
