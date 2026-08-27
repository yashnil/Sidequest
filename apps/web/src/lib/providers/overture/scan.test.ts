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

import { ScanError, scanFile, type ScanBudget, type ScanCounters } from './scan';

/**
 * Bytes a single row group's projected columns cost, in the fixtures below.
 *
 * Split across the four `bbox` leaves and `id` so the sum the scan computes has
 * to come from the leaves the projection names rather than from a group total —
 * a projection that priced `total_byte_size` would agree with this by accident
 * on a file where nothing else is stored, and disagree on every real one.
 */
const BYTES_PER_GROUP = 1_000_000;
/** A column the fixtures publish and the projection never asks for. */
const UNPROJECTED_BYTES_PER_GROUP = 9_000_000;

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

/**
 * The same spread of row groups, priced.
 *
 * Every group publishes both statistics and compressed sizes, which is what a
 * real writer does and what makes the read affordable to compute in advance.
 * The groups march diagonally across the box so the stratified order and file
 * order are different sequences — without that, a test of "we read the
 * affordable prefix of the *stratified* order" would pass on file order too.
 */
function metadataWithCosts(groupCount: number): FileMetaData {
  return {
    row_groups: Array.from({ length: groupCount }, (_, index) => ({
      num_rows: 4n,
      total_byte_size: BigInt(BYTES_PER_GROUP + UNPROJECTED_BYTES_PER_GROUP),
      columns: [
        ...(
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
            total_compressed_size: BigInt(BYTES_PER_GROUP / 8),
          },
        })),
        {
          meta_data: {
            path_in_schema: ['id'],
            total_compressed_size: BigInt(BYTES_PER_GROUP / 2),
          },
        },
        /* Published, expensive, and never asked for. Must not be paid for. */
        {
          meta_data: {
            path_in_schema: ['geometry'],
            total_compressed_size: BigInt(UNPROJECTED_BYTES_PER_GROUP),
          },
        },
      ],
    })),
    schema: [{ name: 'bbox' }, { name: 'id' }, { name: 'geometry' }],
  } as unknown as FileMetaData;
}

/**
 * THE SAME PRICED WORLD, AT THE SCALE A REAL DESTINATION HAS.
 *
 * `metadataWithCosts` marches its groups 0.1° apart, so past the tenth they
 * leave a 1° box and stop overlapping. That is fine for the ordering questions
 * it was written for and useless for the one this file exists to answer, and the
 * gap is not academic: **a fixture of eight overlapping groups can only catch a
 * cap smaller than eight.** The cap that was live was twenty-two, and the cap a
 * refactor would most naturally reintroduce is whatever number somebody once
 * measured — nine, sixteen, twenty. Every one of those passes an eight-group
 * world while reading a fraction of a city, which is the defect verbatim.
 *
 * So this spreads `groupCount` priced groups across the whole box, in both axes,
 * and the tests below run at 30 — above the 27–30 a live metropolitan box prunes
 * to in the densest file of sixteen.
 */
function metadataAtScale(groupCount: number): FileMetaData {
  const step = 0.9 / groupCount;
  return {
    row_groups: Array.from({ length: groupCount }, (_, index) => {
      const lng = 139.05 + index * step;
      const lat = 35.05 + index * step;
      return {
        num_rows: BigInt(ROWS_PER_GROUP),
        total_byte_size: BigInt(BYTES_PER_GROUP + UNPROJECTED_BYTES_PER_GROUP),
        columns: [
          ...(
            [
              ['bbox.xmin', lng, lng + 0.01],
              ['bbox.xmax', lng, lng + 0.01],
              ['bbox.ymin', lat, lat + 0.01],
              ['bbox.ymax', lat, lat + 0.01],
            ] as const
          ).map(([path, min, max]) => ({
            meta_data: {
              path_in_schema: path.split('.'),
              statistics: { min_value: min, max_value: max },
              total_compressed_size: BigInt(BYTES_PER_GROUP / 8),
            },
          })),
          {
            meta_data: {
              path_in_schema: ['id'],
              total_compressed_size: BigInt(BYTES_PER_GROUP / 2),
            },
          },
          {
            meta_data: {
              path_in_schema: ['geometry'],
              total_compressed_size: BigInt(UNPROJECTED_BYTES_PER_GROUP),
            },
          },
        ],
      };
    }),
    schema: [{ name: 'bbox' }, { name: 'id' }, { name: 'geometry' }],
  } as unknown as FileMetaData;
}

/** Rows every fixture group declares, so a `rowStart` identifies its group. */
const ROWS_PER_GROUP = 4;

/** Where each group of a scale fixture begins, in file row order. */
function everyGroupStart(groupCount: number): number[] {
  return Array.from({ length: groupCount }, (_, index) => index * ROWS_PER_GROUP);
}

/** The `rowStart` of every group the reader was actually asked to open. */
function groupsOpened(): number[] {
  return readObjects.mock.calls.map((call) => (call[0] as { rowStart: number }).rowStart);
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

describe('what a scan is willing to pay for', () => {
  /**
   * THE REGRESSION THIS FILE EXISTS FOR, STATED AS A TEST.
   *
   * A metropolis's whole pruned place inventory prices at about 50 MB against a
   * 260 MB budget. It was read to 40% of itself, because every bound on the read
   * was a *count* — 22 row groups, 120,000 retained rows — set from a guess
   * about a different destination and never converted into what a read costs.
   * The landmarks lived in the unread 60% and no ranking, significance or
   * balancing downstream could have recovered them, because they were never
   * decoded.
   *
   * So: when the area fits, all of it is read.
   */
  it('reads every overlapping row group when the area fits the byte allowance', async () => {
    stubFetch();
    const input = request(metadataWithCosts(8));
    /* Room for all eight groups' projected columns, twice over. */
    input.budget.maxBytes = BYTES_PER_GROUP * 16;
    input.budget.maxRowGroups = 512;

    const result = await scanFile(input);

    expect(result.plan?.rowGroupsOverlapping).toBe(8);
    expect(result.plan?.rowGroupsPlanned).toBe(8);
    expect(result.plan?.shortfallBytes).toBe(0);
    expect(result.counters.rowGroupsRead).toBe(8);
    expect(result.stoppedBecause).toBe('complete');
  });

  it('prices only the columns the projection asks for', async () => {
    /*
     * Nine of every ten bytes in the fixture belong to a column nothing reads.
     * Pricing the row group rather than the projection would make the whole area
     * look ten times more expensive than it is, and a budget would then truncate
     * a destination that was always affordable — which is this defect wearing a
     * different hat.
     */
    stubFetch();
    const input = request(metadataWithCosts(8));
    input.budget.maxBytes = BYTES_PER_GROUP * 16;
    input.budget.maxRowGroups = 512;

    const result = await scanFile(input);

    expect(result.plan?.projectedBytes).toBe(BYTES_PER_GROUP * 8);
    expect(result.plan?.rowGroupsPlanned).toBe(8);
  });

  it('truncates in stratified order when the area costs more than the allowance, and says by how much', async () => {
    /*
     * The exceptional path, and the two things that must both be true of it.
     *
     * It has to be *loud*: a truncated inventory that reports only "budget" is
     * indistinguishable from a place with little in it, and a stored pack of one
     * corner of a metropolis carried exactly that non-statement for a phase.
     *
     * And it has to degrade *across the destination* rather than into whichever
     * corner the file happens to start with. The fixture's groups march
     * diagonally, so file order would take three neighbouring groups and the
     * stratified order takes one from each latitude band — the difference
     * between a thin sample of a city and one district of it.
     */
    stubFetch();
    const input = request(metadataWithCosts(8));
    input.budget.maxBytes = BYTES_PER_GROUP * 3;
    input.budget.maxRowGroups = 512;

    const result = await scanFile(input);

    expect(result.plan?.rowGroupsOverlapping).toBe(8);
    expect(result.plan?.rowGroupsPlanned).toBe(3);
    expect(result.plan?.shortfallBytes).toBe(BYTES_PER_GROUP * 5);
    expect(result.stoppedBecause).toBe('byte_budget');
    expect(result.stratification).toBe('applied');

    /* Spread, not the first three of the file. */
    const readStarts = readObjects.mock.calls.map((call) => (call[0] as { rowStart: number }).rowStart);
    expect(readStarts).toHaveLength(3);
    expect(readStarts).not.toEqual([0, 4, 8]);
    expect(new Set(readStarts).size).toBe(3);
  });

  it('holds nothing itself when the caller supplies a sink', async () => {
    /*
     * The memory bound moved out of the reader, and this is what says so. While
     * the reader held the rows, the only way to bound the heap was to stop
     * reading — 120,000 rows against a metropolis's 478,000, which is where two
     * thirds of a city went. A caller that holds its own bounded, ranked
     * selection must not also be stopped by a ceiling on rows it deliberately
     * never lets grow.
     */
    stubFetch();
    const collected: Record<string, unknown>[] = [];
    const input = request(metadataWithCosts(8));
    input.budget.maxBytes = BYTES_PER_GROUP * 16;
    input.budget.maxRowGroups = 512;
    /* A ceiling the scan would hit at the first row group if it were holding. */
    input.budget.maxFeaturesRetained = 2;

    const result = await scanFile({ ...input, sink: { add: (row) => collected.push(row) } });

    expect(result.rows).toEqual([]);
    expect(collected.length).toBe(32);
    expect(result.stoppedBecause).toBe('complete');
    expect(result.counters.rowGroupsRead).toBe(8);
  });
});

/**
 * ===========================================================================
 * THE HEADLINE GUARANTEE, GUARDED AT THE SCALE IT FAILED AT
 * ===========================================================================
 *
 * The phase's sentence is "reads every spatially pruned row group when it fits
 * the byte allowance". Everything above tests that sentence over **eight**
 * groups, and eight is smaller than every cap this codebase has ever shipped —
 * forty, twenty-two, twenty. A per-file ceiling of nine reinstates the exact
 * regression the phase exists to close and leaves every assertion above green,
 * because nine is more than eight.
 *
 * Worse, it leaves the *report* green too. `shortfallBytes` is computed from
 * what the plan could afford, so a cap applied anywhere after the plan produces
 * a scan that opened a third of a destination and stated, in bytes, that nothing
 * was left behind. A number that cannot say "I stopped early" is how a
 * metropolis was read as slopes and pocket parks for a whole phase.
 *
 * So these run at thirty — above the 27–30 groups a live metropolitan box prunes
 * to in its densest file — and they assert on *which* groups were opened rather
 * than only on how the read described itself.
 */
describe('reading the whole of a destination that fits', () => {
  const SCALE = 30;

  it('opens every one of thirty pruned row groups, not merely a fixture-sized handful', async () => {
    stubFetch();
    const input = request(metadataAtScale(SCALE));
    /* Room for every group's projected columns, twice over. */
    input.budget.maxBytes = BYTES_PER_GROUP * SCALE * 2;
    input.budget.maxRowGroups = 512;

    const result = await scanFile(input);

    /* The area, priced and planned in full. */
    expect(result.plan?.rowGroupsInFile).toBe(SCALE);
    expect(result.plan?.rowGroupsOverlapping).toBe(SCALE);
    expect(result.plan?.rowGroupsPlanned).toBe(SCALE);
    expect(result.plan?.shortfallBytes).toBe(0);
    expect(result.stoppedBecause).toBe('complete');

    /*
     * And *opened* in full. This is the assertion the eight-group tests cannot
     * make: not "the plan said thirty" but "the reader was asked for all thirty
     * of them", named individually, so a cap between nine and twenty-nine
     * applied anywhere between the plan and the read lands here.
     */
    expect(result.counters.rowGroupsRead).toBe(SCALE);
    expect(groupsOpened().sort((a, b) => a - b)).toEqual(everyGroupStart(SCALE));
  });

  /**
   * WHAT THE SCAN IS ALLOWED TO CLAIM ABOUT ITS OWN COVERAGE.
   *
   * One invariant across all three regimes: **a scan says `complete` only when
   * it opened every group the pruning found.** Truncation is allowed — a
   * destination can genuinely cost more than a build may spend — and silence
   * about it is not, because a silently truncated inventory is indistinguishable
   * from a place with nothing in it, and that indistinguishability is the whole
   * failure this phase was opened to repair.
   *
   * The byte regime and the count regime are listed together deliberately. The
   * byte bound is policy and reports itself in `shortfallBytes`; the count bound
   * is a backstop that does *not* touch the plan, so the only thing separating
   * it from a lie is that it refuses to call the read complete.
   */
  it('never calls a read complete when it left pruned ground unopened', async () => {
    const regimes = [
      {
        name: 'affordable: the whole area',
        maxBytes: BYTES_PER_GROUP * SCALE * 2,
        maxRowGroups: 512,
        maxFeaturesRead: 10_000,
        expected: { stopped: 'complete', planned: SCALE, read: SCALE, shortfall: 0 },
      },
      {
        name: 'byte-bound: the affordable prefix, priced in bytes',
        maxBytes: BYTES_PER_GROUP * 12,
        maxRowGroups: 512,
        maxFeaturesRead: 10_000,
        expected: {
          stopped: 'byte_budget',
          planned: 12,
          read: 12,
          shortfall: BYTES_PER_GROUP * (SCALE - 12),
        },
      },
      {
        /*
         * The catastrophic backstop biting. It is not supposed to happen on a
         * real destination — 512 against a metropolis's 55 — but if it ever
         * does, the read must not describe itself as having covered the area.
         */
        name: 'count-bound: the backstop, which the plan does not know about',
        maxBytes: BYTES_PER_GROUP * SCALE * 2,
        maxRowGroups: 9,
        maxFeaturesRead: 10_000,
        expected: { stopped: 'row_group_budget', planned: SCALE, read: 9, shortfall: 0 },
      },
      {
        /*
         * The other count, and the one that is easiest to forget: a ceiling on
         * decoded rows truncates a dense layer exactly as a row-group cap does,
         * and leaves the same zeroed byte report behind it.
         */
        name: 'row-bound: the decoded-row backstop',
        maxBytes: BYTES_PER_GROUP * SCALE * 2,
        maxRowGroups: 512,
        maxFeaturesRead: ROWS_PER_GROUP * 10,
        expected: { stopped: 'feature_budget', planned: SCALE, read: 10, shortfall: 0 },
      },
    ] as const;

    for (const regime of regimes) {
      stubFetch();
      const input = request(metadataAtScale(SCALE));
      input.budget.maxBytes = regime.maxBytes;
      input.budget.maxRowGroups = regime.maxRowGroups;
      input.budget.maxFeaturesRead = regime.maxFeaturesRead;

      const result = await scanFile(input);

      expect(result.stoppedBecause, regime.name).toBe(regime.expected.stopped);
      expect(result.plan?.rowGroupsPlanned, regime.name).toBe(regime.expected.planned);
      expect(result.counters.rowGroupsRead, regime.name).toBe(regime.expected.read);
      expect(result.plan?.shortfallBytes, regime.name).toBe(regime.expected.shortfall);

      /* The invariant itself, stated once and checked in every regime. */
      const opened = result.counters.rowGroupsRead;
      const pruned = result.plan?.rowGroupsOverlapping ?? -1;
      if (result.stoppedBecause === 'complete') {
        expect(opened, `${regime.name}: claimed complete`).toBe(pruned);
      } else {
        expect(opened, `${regime.name}: claimed truncated`).toBeLessThan(pruned);
      }

      readObjects.mockReset();
      readMetadata.mockReset();
      vi.unstubAllGlobals();
    }
  });

  /**
   * PER-FILE ACCOUNTING INSIDE ONE LAYER.
   *
   * A layer reads up to fourteen files against **one** allowance, and the
   * allowance is a ceiling on the shared running counter rather than a fresh
   * per-file purse. Price each file against the whole ceiling instead and a
   * six-file layer may plan six times its budget — every file's plan claiming
   * `shortfallBytes: 0` while the byte source refuses the reads that follow, so
   * the layer both overspends and reports full coverage of ground it never
   * opened.
   *
   * Nothing tested this: every scan test starts from a zeroed counter, which is
   * the one state where the subtraction cannot be observed.
   */
  it('prices a file against what earlier files of the same layer already spent', async () => {
    stubFetch();
    const input = request(metadataWithCosts(8));
    input.budget.maxBytes = BYTES_PER_GROUP * 12;
    input.budget.maxRowGroups = 512;
    /* As though an earlier file of this layer had already spent eight. */
    input.counters.bytesTransferred = BYTES_PER_GROUP * 8;

    const result = await scanFile(input);

    expect(result.plan?.rowGroupsOverlapping).toBe(8);
    expect(result.plan?.rowGroupsPlanned).toBe(4);
    expect(result.plan?.plannedBytes).toBe(BYTES_PER_GROUP * 4);
    expect(result.plan?.shortfallBytes).toBe(BYTES_PER_GROUP * 4);
    expect(result.stoppedBecause).toBe('byte_budget');
  });

  it('still says what it left behind when the layer’s allowance is already gone', async () => {
    /*
     * The last file of an exhausted layer. One group is planned rather than none
     * — a thin budget must not read as an empty destination — and the remainder
     * is reported, because "we could not afford this" and "there was nothing
     * here" are the two states the whole funnel exists to separate.
     */
    stubFetch();
    const input = request(metadataWithCosts(8));
    input.budget.maxBytes = BYTES_PER_GROUP * 8;
    input.budget.maxRowGroups = 512;
    input.counters.bytesTransferred = BYTES_PER_GROUP * 8;

    const result = await scanFile(input);

    expect(result.plan?.rowGroupsPlanned).toBe(1);
    expect(result.plan?.shortfallBytes).toBe(BYTES_PER_GROUP * 7);
    expect(result.stoppedBecause).toBe('byte_budget');
  });
});

describe('the stall guard on a range transfer', () => {
  /*
   * The 25 s bound used to cover the whole body download, which made it a
   * throughput floor in disguise: the largest row group overlapping a
   * metropolitan box in the current catalogue release is 20.7 MB, so any link
   * under 0.83 MB/s watched that group die as `unreachable` while transferring
   * real bytes the whole time — measured on a live build that lost an entire
   * ground layer to it. The bound now applies to *silence*: a slow transfer
   * that keeps flowing completes, a stalled one is refused, and the layer's own
   * deadline still caps the total.
   */
  function flowingStream(chunks: number, gapMs: number, thenStall = false): ReadableStream<Uint8Array> {
    let sent = 0;
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= chunks) {
          if (!thenStall) controller.close();
          /* On stall: never enqueue, never close — the connection went silent. */
          return thenStall ? new Promise<void>(() => {}) : undefined;
        }
        sent += 1;
        return new Promise<void>((resolve) => {
          setTimeout(() => {
            controller.enqueue(new Uint8Array([sent]));
            resolve();
          }, gapMs);
        });
      },
    });
  }

  it('lets a slow but flowing transfer run past the stall bound', async () => {
    const { readBodyWithStallGuard } = await import('./scan');
    const aborted = vi.fn();
    /* Ten chunks at 15 ms gaps: 150 ms total against a 60 ms stall bound. */
    const bytes = await readBodyWithStallGuard(flowingStream(10, 15), {
      stallMs: 60,
      deadlineMs: Date.now() + 10_000,
      abort: aborted,
    });
    expect(bytes.byteLength).toBe(10);
    expect(aborted).not.toHaveBeenCalled();
  });

  it('refuses a transfer that goes silent, and cancels the connection', async () => {
    const { readBodyWithStallGuard } = await import('./scan');
    const aborted = vi.fn();
    await expect(
      readBodyWithStallGuard(flowingStream(2, 5, true), {
        stallMs: 60,
        deadlineMs: Date.now() + 10_000,
        abort: aborted,
      }),
    ).rejects.toMatchObject({ code: 'unreachable' });
    expect(aborted).toHaveBeenCalled();
  });

  it('still honours the layer deadline mid-transfer', async () => {
    /*
     * The margins are wide on purpose. The claim is that the deadline is
     * checked *between chunks* while a stream is still flowing happily, and
     * that claim needs a stream long enough to be interrupted and a deadline
     * comfortably inside it — not tight numbers. Measured at 30 ms against a
     * 500 ms stream this failed under whole-suite contention (solo: 16/16 in
     * ~730 ms, three runs), because on a loaded machine the scheduler can spend
     * the entire budget before the first chunk is even delivered, which tests
     * the wrong thing. Ten seconds of stream against a 300 ms deadline proves
     * the same interruption with an order of magnitude of headroom either side.
     */
    const { readBodyWithStallGuard } = await import('./scan');
    const aborted = vi.fn();
    await expect(
      readBodyWithStallGuard(flowingStream(200, 50), {
        stallMs: 5_000,
        deadlineMs: Date.now() + 300,
        abort: aborted,
      }),
    ).rejects.toMatchObject({ code: 'timeout' });
    expect(aborted).toHaveBeenCalled();
  });
});

describe('the stall guard is wired into the range reader', () => {
  /*
   * The three tests above prove `readBodyWithStallGuard` in isolation; this
   * one proves `rangeBuffer` actually routes bodies through it — the wiring an
   * adversary showed could be deleted with the suite green. The anchor is the
   * mid-body deadline: the guard checks the layer deadline between chunks, so
   * a stalled stream dies as soon as the deadline passes. The whole-body
   * `arrayBuffer()` it replaced could not be interrupted and hung until the
   * 25-second transport timeout — far past this test's own budget, so a
   * neutered wiring fails here by timeout.
   */
  it('interrupts a stalled range read at the layer deadline, mid-body', { timeout: 4_000 }, async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        /* Then silence: never enqueue again, never close. */
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: { method?: string }) =>
        init?.method === 'HEAD'
          ? new Response(null, { status: 200, headers: { 'content-length': '4096' } })
          : new Response(body, { status: 206 }),
      ),
    );
    const counters: ScanCounters = {
      bytesTransferred: 0,
      rowGroupsInspected: 0,
      rowGroupsRead: 0,
      featuresRead: 0,
    };
    const { rangeBuffer } = await import('./scan');
    const buffer = await rangeBuffer('https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com/x/part-0.zstd.parquet', counters, {
      maxRowGroups: 3,
      maxBytes: 10_000_000,
      maxFeaturesRead: 10_000,
      maxFeaturesRetained: 10_000,
      deadlineMs: Date.now() + 250,
    });
    const started = Date.now();
    await expect(buffer.slice(0, 4096)).rejects.toMatchObject({ code: 'timeout' });
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});

describe('one dead block costs one block', () => {
  /*
   * A stalled or undecodable transfer of a single row group used to abandon
   * every remaining planned group of the file, mislabelled `byte_budget` — a
   * night of live builds on a flaky link left every layer at a third of its
   * plan and every pack permanently partial. Each range is its own request on
   * its own connection: the group after a dead one is unaffected, so the scan
   * skips the hole, counts it, and finishes the plan.
   */
  it('skips a group whose transfer dies and reads the rest of the plan', async () => {
    stubFetch();
    const input = request(metadataWithCosts(4));
    input.budget.maxRowGroups = 512;
    let call = 0;
    readObjects.mockReset();
    readObjects.mockImplementation(async () => {
      call += 1;
      if (call === 2) throw new ScanError('unreachable', 'The place data transfer stalled.');
      return [{ id: 'a' }, { id: 'b' }];
    });

    const result = await scanFile(input);

    expect(result.transferFailedGroups).toBe(1);
    expect(result.counters.rowGroupsRead).toBe(3);
    expect(result.stoppedBecause).toBe('complete');
  });

  it('still stops honestly on the genuine transfer-budget refusal', async () => {
    stubFetch();
    const input = request(metadataWithCosts(4));
    input.budget.maxRowGroups = 512;
    readObjects.mockReset();
    readObjects.mockImplementation(async () => {
      throw new ScanError('too_large', 'This region reached its data-transfer limit.');
    });

    const result = await scanFile(input);

    expect(result.stoppedBecause).toBe('byte_budget');
    expect(result.transferFailedGroups ?? 0).toBe(0);
  });
});
