import 'server-only';
import { zstdDecompressSync } from 'node:zlib';
import { parquetMetadataAsync, parquetReadObjects, type AsyncBuffer, type FileMetaData } from 'hyparquet';
import { USER_AGENT } from '../nominatim';

/**
 * BOUNDED COLUMNAR READS OVER HTTP, AND NOTHING ELSE.
 *
 * The whole global place catalogue is about a hundred gigabytes across six
 * themes. This module never reads more than a few tens of megabytes of it, and
 * the mechanism is worth stating because it is what makes the whole backbone
 * affordable:
 *
 * 1. **File pruning** happens upstream, from the catalogue's own bounding boxes.
 * 2. **Footer read.** Roughly a megabyte of range requests yields every row
 *    group's statistics. A 790 MB file's footer resolves in about a second.
 * 3. **Row-group pruning** on the `bbox` covering columns the format declares.
 *    Measured against the live catalogue over a metropolitan box: 27 of the
 *    places file's 256 groups, in 1 of its 16 files. This step was never the
 *    problem and is not what any of the repairs below are about.
 * 4. **Column projection.** Only the columns the normaliser reads are fetched.
 * 5. **Pricing.** What steps 3 and 4 will cost is then *known exactly* from the
 *    footer, before a data byte is spent, and the read is bounded by that price
 *    rather than by a count of anything. See `projectedCostOf`.
 *
 * Every step is capped, and every cap is reported rather than absorbed. A scan
 * that stops because it hit a budget is a normal outcome with a number attached,
 * which is the difference between "we looked at the middle of this" and an empty
 * region that reads as "there is nothing here".
 *
 * The counts that used to do the capping — row groups, decoded rows, retained
 * rows — survive only as backstops against a file that is not what its footer
 * claims. They were the policy once, and the cost of that was measured: for a
 * metropolis-sized box the place layer prunes to 27 row groups costing 50 MB
 * against a 260 MB budget, and a retained-row ceiling stopped it at 11. Nothing
 * about bytes or time was ever the constraint.
 *
 * Zstandard comes from Node's own `zlib`, which has shipped it since 22.15.
 * Bringing a compression dependency in for something the runtime already does
 * would be a supply-chain surface for no gain.
 */

const RANGE_TIMEOUT_MS = 25_000;

/**
 * Read a response body chunk by chunk, refusing a *stalled* transfer rather
 * than a slow one.
 *
 * `AbortSignal.timeout` on the fetch covered the whole body download, which
 * makes the timeout a throughput floor in disguise: a 20.7 MB row group — the
 * largest overlapping a metropolitan box in the current catalogue release —
 * needs a sustained 0.83 MB/s to finish inside 25 s, and a live build on a
 * slower link watched that group die as `unreachable` after transferring real
 * bytes the whole time. The timeout exists to catch a connection that has
 * stopped answering, so it is applied to the gap between chunks; the layer's
 * own deadline still bounds the total, checked between chunks, so a slow read
 * cannot outspend the build either.
 */
export async function readBodyWithStallGuard(
  body: ReadableStream<Uint8Array>,
  bounds: { stallMs: number; deadlineMs: number; abort: () => void },
): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      if (Date.now() > bounds.deadlineMs) {
        bounds.abort();
        throw new ScanError('timeout', 'This region reached its time limit while reading place data.');
      }
      let stallTimer: ReturnType<typeof setTimeout> | undefined;
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        /*
         * Each read waits for the sooner of the stall bound and the layer
         * deadline. Bounding by the stall alone let a stream that went silent
         * hold the read for the full stall window past the deadline — the
         * between-chunk check above can only fire when a chunk arrives.
         */
        const waitMs = Math.min(bounds.stallMs, Math.max(0, bounds.deadlineMs - Date.now()));
        result = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => {
            stallTimer = setTimeout(() => {
              bounds.abort();
              reject(
                Date.now() >= bounds.deadlineMs
                  ? new ScanError('timeout', 'This region reached its time limit while reading place data.')
                  : new ScanError('unreachable', 'The place data transfer stalled.'),
              );
            }, waitMs);
          }),
        ]);
      } finally {
        clearTimeout(stallTimer);
      }
      if (result.done) break;
      chunks.push(result.value);
      total += result.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

/**
 * A hard ceiling on any single range request.
 *
 * A decompression bomb and a malformed footer both look like "a very large
 * length field" from here, so the length is checked before the request is made
 * rather than after the bytes arrive.
 */
const MAX_RANGE_BYTES = 64 * 1024 * 1024;

/** Refuse a file whose advertised size is implausible for a data part. */
const MAX_FILE_BYTES = 8 * 1024 * 1024 * 1024;

export class ScanError extends Error {
  readonly code: 'unreachable' | 'too_large' | 'malformed' | 'schema_incompatible' | 'timeout';

  constructor(code: ScanError['code'], message: string) {
    super(message);
    this.name = 'ScanError';
    this.code = code;
  }
}

export interface BoundingBox {
  west: number;
  south: number;
  east: number;
  north: number;
}

/**
 * THE BOUNDS ON ONE SCAN, AND WHICH OF THEM IS THE POLICY.
 *
 * Exactly one of these is meant to decide how much of a destination is read:
 * `maxBytes`. The others are backstops against a file that is not what its own
 * footer says it is.
 *
 * That ordering is the repair of the phase's central defect. Every bound here
 * used to be a *count* — 40 row groups, 500,000 decoded rows, 120,000 retained
 * ones — and a count is a proxy for cost that is wrong by an order of magnitude
 * between one layer and another. A metropolis's whole pruned place inventory is
 * about 50 MB against a 260 MB budget; it was being cut off at 40% of itself by
 * a row limit nobody had ever converted into bytes, and the missing 60% held
 * most of the city's landmarks. Nothing downstream could tell, because a budget
 * expressed in the wrong unit does not report a shortfall — it reports a number
 * that looks fine.
 *
 * Every field is a ceiling on the **shared running counter**, not a fresh
 * per-scan allowance, so a caller reading several files for one layer expresses
 * "this layer may reach here in total" by passing the same numbers each time.
 */
export interface ScanBudget {
  /**
   * A catastrophic backstop, not a policy knob.
   *
   * Row groups are not what a read costs — a group of a divisions file and a
   * group of a places file differ by more than a factor of ten — so this is set
   * large enough never to bind on a real destination and exists so a file with
   * a pathological group count cannot spin.
   */
  maxRowGroups: number;
  /** The policy bound. What this read may cost, in the unit it is paid in. */
  maxBytes: number;
  /** A backstop against a footer whose declared row counts are not the truth. */
  maxFeaturesRead: number;
  /**
   * A ceiling on the rows the scan itself holds.
   *
   * Inert when the caller supplies a `sink`: it has then taken the heap on
   * itself — the pack builder's sink evicts by rank rather than growing — and
   * stopping the scan on a count the caller deliberately holds constant would
   * abandon the rest of the area for nothing.
   */
  maxFeaturesRetained: number;
  deadlineMs: number;
}

export interface ScanCounters {
  bytesTransferred: number;
  rowGroupsInspected: number;
  rowGroupsRead: number;
  featuresRead: number;
}

/**
 * Where accepted rows go when the caller has somewhere better to put them.
 *
 * The scan's own array is fine for a layer of a few thousand rows and is the
 * wrong shape for the one that matters: a dense metropolis's places layer has
 * about half a million rows inside the box, all of which are decoded, ranked and
 * then reduced to a couple of thousand. Holding all of them first is a heap
 * problem, and the previous answer to that heap problem was to *stop reading* —
 * which is how a budget meant to protect memory became the thing that decided
 * which half of a city the traveller could see.
 *
 * A sink lets the caller keep a bounded, ranked selection as the rows arrive, so
 * the area can be exhausted at constant memory.
 */
export interface RowSink<T> {
  add: (row: T) => void;
}

export type ScanStop =
  | 'complete'
  | 'row_group_budget'
  | 'byte_budget'
  | 'feature_budget'
  | 'retained_budget'
  | 'time_budget';

/**
 * Whether the read order was actually spread across the requested ground.
 *
 * Reported rather than assumed, because the one state that matters is the one
 * that used to be silent. `stratifyRowGroups` bins groups by the midpoint of
 * their own published bbox statistics; a writer that publishes none sends every
 * group to the unplaced bucket, and a rotation of one bucket is **file order** —
 * the exact behaviour the stratification was written to eliminate, restored
 * without a word. A budget-truncated read in that state is one corner of the
 * destination, which is how a metropolis came back as slopes and pocket parks.
 *
 * - `applied` — groups were binned and emitted round-robin across the box.
 * - `unavailable` — no group published statistics, so this read is in file
 *   order and a truncated one is a *biased sample*, not a thin one.
 * - `not_required` — two groups or fewer, or a box with no span: there was
 *   nothing an ordering could bias.
 */
export type ScanStratification = 'applied' | 'unavailable' | 'not_required';

/**
 * WHAT THE READ WAS GOING TO COST, DECIDED BEFORE A DATA BYTE WAS SPENT.
 *
 * Every number here comes from the footer, which is already in hand by the time
 * the first row group is opened. That is the whole point: the question "can we
 * afford the whole of this destination" is answerable *exactly*, in advance,
 * and answering it in advance is the difference between reading all of an area
 * and discovering half-way through that we cannot.
 *
 * `shortfallBytes` is the field that has to exist. A truncated read that
 * reports only "byte budget" tells a reader that something was cut without
 * saying how much, and a silent truncation of a place inventory is
 * indistinguishable from a place with nothing in it.
 */
export interface ScanReadPlan {
  /** Row groups this file publishes, in total. */
  rowGroupsInFile: number;
  /** Those whose own statistics overlap the requested box. The area, in groups. */
  rowGroupsOverlapping: number;
  /** Those the byte allowance could actually pay for, in stratified order. */
  rowGroupsPlanned: number;
  /** Rows the planned groups declare they hold. */
  rowsPlanned: number;
  /** Exact compressed bytes the projection over the whole overlapping set costs. */
  projectedBytes: number;
  /** Exact compressed bytes the planned prefix costs. */
  plannedBytes: number;
  /** What the allowance could not cover. Zero when the whole area fit. */
  shortfallBytes: number;
}

export interface ScanResult<T> {
  /**
   * The rows this scan retained itself.
   *
   * Empty when the caller supplied a `sink`, which then holds them. A caller
   * that always drains this *and* supplies a sink therefore double-counts
   * nothing, which is what lets an injected reader that predates sinks keep
   * working unchanged.
   */
  rows: T[];
  counters: ScanCounters;
  stoppedBecause: ScanStop;
  /**
   * Whether the read order was spread, and never silently assumed to have been.
   *
   * A caller that records only `stoppedBecause` cannot tell "we read 320 of 800
   * spread across the city" from "we read the first 320 of 800 in one corner",
   * and those are different claims about the destination.
   */
  stratification: ScanStratification;
  /**
   * What this scan planned to read and what it cost.
   *
   * Optional because the reader is an injected seam: a test's columnar reader
   * models rows rather than footers and has no plan to report. Absent means
   * "not measured", never "nothing was skipped".
   */
  plan?: ScanReadPlan;
  /**
   * Planned blocks whose transfer or decode failed and were skipped.
   *
   * Absent from injected readers. Non-zero means ground the plan paid for was
   * not read — the layer's completion pass retries, and the pack says so.
   */
  transferFailedGroups?: number;
}

/**
 * A byte source that counts, caps and refuses.
 *
 * Wrapping rather than using the library's own URL helper, for three reasons
 * that are all load-bearing: bytes have to be counted against a budget, a range
 * larger than the cap has to be refused *before* it is requested, and the
 * request needs our user agent. A previous slice learnt what a placeholder user
 * agent costs when a public service started answering 406 to every request
 * carrying it.
 */
export async function rangeBuffer(url: string, counters: ScanCounters, budget: ScanBudget): Promise<AsyncBuffer> {
  const head = await fetch(url, {
    method: 'HEAD',
    headers: { 'user-agent': USER_AGENT },
    signal: AbortSignal.timeout(RANGE_TIMEOUT_MS),
    redirect: 'error',
  }).catch(() => null);

  if (!head || !head.ok) {
    throw new ScanError('unreachable', 'The place data files did not answer.');
  }
  const length = Number(head.headers.get('content-length') ?? '0');
  if (!Number.isFinite(length) || length <= 0) {
    throw new ScanError('malformed', 'The place data file did not report a size.');
  }
  if (length > MAX_FILE_BYTES) {
    throw new ScanError('too_large', 'A place data file was larger than we will read.');
  }

  return {
    byteLength: length,
    async slice(start: number, end?: number): Promise<ArrayBuffer> {
      const from = Math.max(0, Math.floor(start));
      const to = end === undefined ? length : Math.min(length, Math.floor(end));
      const size = to - from;
      if (size <= 0) return new ArrayBuffer(0);
      if (size > MAX_RANGE_BYTES) {
        throw new ScanError('too_large', 'A single read from the place data was too large.');
      }
      if (counters.bytesTransferred + size > budget.maxBytes) {
        throw new ScanError('too_large', 'This region reached its data-transfer limit.');
      }
      if (Date.now() > budget.deadlineMs) {
        throw new ScanError('timeout', 'This region reached its time limit while reading place data.');
      }

      /*
       * The 25 s bound applies to reaching the server and to any silence after
       * that — never to the transfer as a whole. See `readBodyWithStallGuard`:
       * a whole-body timeout is a throughput floor, and a measured live build
       * lost an entire ground layer to it on a slow link.
       */
      const controller = new AbortController();
      const headerTimer = setTimeout(() => controller.abort(), RANGE_TIMEOUT_MS);
      let response: Response;
      try {
        response = await fetch(url, {
          headers: {
            'user-agent': USER_AGENT,
            range: `bytes=${from}-${to - 1}`,
          },
          signal: controller.signal,
          redirect: 'error',
        });
      } catch (error) {
        if (error instanceof ScanError) throw error;
        throw Date.now() > budget.deadlineMs
          ? new ScanError('timeout', 'This region reached its time limit while reading place data.')
          : new ScanError('unreachable', 'The place data files did not answer.');
      } finally {
        clearTimeout(headerTimer);
      }
      if (!response.ok && response.status !== 206) {
        throw new ScanError('unreachable', 'The place data files did not answer.');
      }
      const bytes = response.body
        ? await readBodyWithStallGuard(response.body, {
            stallMs: RANGE_TIMEOUT_MS,
            deadlineMs: budget.deadlineMs,
            abort: () => controller.abort(),
          })
        : new Uint8Array(await response.arrayBuffer());
      counters.bytesTransferred += bytes.byteLength;
      return bytes.byteLength === bytes.buffer.byteLength && bytes.byteOffset === 0
        ? (bytes.buffer as ArrayBuffer)
        : (bytes.buffer as ArrayBuffer).slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
  };
}

/** Node's own zstd, exposed in the shape the reader expects. */
const COMPRESSORS = {
  ZSTD: (input: Uint8Array): Uint8Array => new Uint8Array(zstdDecompressSync(input)),
};

export interface RowGroupRange {
  index: number;
  start: number;
  end: number;
}

/**
 * The row groups whose bounding-box statistics overlap the ground we want.
 *
 * The format publishes per-row-group min/max for the `bbox` covering columns, so
 * this is exact rather than heuristic: a row group whose maximum longitude is
 * west of our box cannot contain anything in it. Where the statistics are
 * missing — an older writer, a different producer — every group is considered,
 * which is slow and correct rather than fast and wrong.
 */
/**
 * The bounding box a row group's own statistics declare, or null where the
 * writer published none. Shared by the pruning below and the spatial
 * stratification, so the two cannot read the format differently.
 */
export function rowGroupStatBounds(
  group: FileMetaData['row_groups'][number],
): BoundingBox | null {
  const stat = (path: string): { min?: number; max?: number } | undefined => {
    const column = group.columns.find(
      (entry) => entry.meta_data?.path_in_schema.join('.') === path,
    );
    const statistics = column?.meta_data?.statistics;
    if (!statistics) return undefined;
    const min = statistics.min_value ?? statistics.min;
    const max = statistics.max_value ?? statistics.max;
    return {
      ...(typeof min === 'number' ? { min } : {}),
      ...(typeof max === 'number' ? { max } : {}),
    };
  };

  const xmin = stat('bbox.xmin');
  const xmax = stat('bbox.xmax');
  const ymin = stat('bbox.ymin');
  const ymax = stat('bbox.ymax');
  if (
    xmin?.min === undefined ||
    xmax?.max === undefined ||
    ymin?.min === undefined ||
    ymax?.max === undefined
  ) {
    return null;
  }
  return { west: xmin.min, east: xmax.max, south: ymin.min, north: ymax.max };
}

export function overlappingRowGroups(metadata: FileMetaData, box: BoundingBox): RowGroupRange[] {
  const ranges: RowGroupRange[] = [];
  let offset = 0;
  for (const [index, group] of metadata.row_groups.entries()) {
    const rows = Number(group.num_rows);
    const start = offset;
    offset += rows;

    const bounds = rowGroupStatBounds(group);
    if (bounds === null) {
      ranges.push({ index, start, end: offset });
      continue;
    }

    const disjoint =
      bounds.west > box.east ||
      bounds.east < box.west ||
      bounds.south > box.north ||
      bounds.north < box.south;
    if (!disjoint) ranges.push({ index, start, end: offset });
  }
  return ranges;
}

/**
 * How finely the requested box is divided for sampling. Four by four is enough
 * to tell a corner from a spread and coarse enough that a metro's worth of row
 * groups still lands several to a cell.
 */
const STRATIFY_GRID = 4;

/**
 * The order row groups are read in: spread across the requested ground, not
 * taken in file order.
 *
 * The file-order version of this loop carried a comment arguing that the
 * format's spatial coherence made a truncated read "a contiguous gap rather
 * than a shredded one". True, and it was the defect: contiguous in file order
 * means *one corner of the destination*. A live metro build with 1,920
 * overlapping groups and a budget for 20 read one percent of the ground — all
 * of it in the south-west — and every canonical anchor north of the centre was
 * never acquired. The board then honestly ranked what it had, which was slopes
 * and pocket parks.
 *
 * So the groups are binned by the midpoint of their own published statistics
 * into a coarse grid over the requested box and emitted round-robin across the
 * occupied cells. A budget that runs out after k reads has then sampled every
 * part of the box roughly evenly, which is the property the retention
 * distribution downstream (`perCellCap` in the pack builder) actually needs.
 * Groups whose writer published no statistics form one more bucket in the same
 * rotation — slow and fair rather than fast and wrong. Deterministic
 * throughout: cell order is row-major, order within a cell is file order.
 */
/**
 * Whether stratification could run at all, on this metadata and this box.
 *
 * Its own function because the answer has to be *reported*, and because a
 * predicate the ordering does not consult would drift from it. Both read
 * `rowGroupStatBounds`, and the three states here are exactly the three exits of
 * the ordering below.
 */
export function stratificationOf(
  metadata: FileMetaData,
  groups: readonly RowGroupRange[],
  box: BoundingBox,
): ScanStratification {
  if (groups.length <= 2) return 'not_required';
  if (!(box.east - box.west > 0) || !(box.north - box.south > 0)) return 'not_required';
  const placeable = groups.some((group) => {
    const raw = metadata.row_groups[group.index];
    return raw ? rowGroupStatBounds(raw) !== null : false;
  });
  /*
   * One placed group is enough for the rotation to be doing something: the
   * unplaced bucket becomes one cell among several rather than the whole of the
   * order. None is the silent regression — `buckets` is empty, the rotation is
   * `[unplaced]`, and the round-robin emits file order.
   */
  return placeable ? 'applied' : 'unavailable';
}

export function stratifyRowGroups(
  metadata: FileMetaData,
  groups: readonly RowGroupRange[],
  box: BoundingBox,
): RowGroupRange[] {
  if (groups.length <= 2) return [...groups];
  const lngSpan = box.east - box.west;
  const latSpan = box.north - box.south;
  if (!(lngSpan > 0) || !(latSpan > 0)) return [...groups];

  const buckets = new Map<number, RowGroupRange[]>();
  const unplaced: RowGroupRange[] = [];
  for (const group of groups) {
    const raw = metadata.row_groups[group.index];
    const bounds = raw ? rowGroupStatBounds(raw) : null;
    if (bounds === null) {
      unplaced.push(group);
      continue;
    }
    const midLng = (bounds.west + bounds.east) / 2;
    const midLat = (bounds.south + bounds.north) / 2;
    const column = Math.min(
      STRATIFY_GRID - 1,
      Math.max(0, Math.floor(((midLng - box.west) / lngSpan) * STRATIFY_GRID)),
    );
    const row = Math.min(
      STRATIFY_GRID - 1,
      Math.max(0, Math.floor(((midLat - box.south) / latSpan) * STRATIFY_GRID)),
    );
    const key = row * STRATIFY_GRID + column;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(group);
    else buckets.set(key, [group]);
  }

  /*
   * The cell rotation itself has to be spatially spread, not row-major.
   *
   * A row-major cell order re-creates the defect one level up: with a budget
   * smaller than the number of occupied cells, "one group per cell" still
   * visits every southern cell before any northern one. So cells are taken one
   * row of the grid at a time, cycling — the first N reads land in N different
   * latitude bands, and the columns spread as each row's cells are consumed in
   * turn. Deterministic: rows ascend, cells within a row ascend by column.
   */
  const byRow = new Map<number, RowGroupRange[][]>();
  for (const [key, bucket] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
    const row = Math.floor(key / STRATIFY_GRID);
    const cells = byRow.get(row);
    if (cells) cells.push(bucket);
    else byRow.set(row, [bucket]);
  }
  const rows = [...byRow.entries()].sort((a, b) => a[0] - b[0]).map(([, cells]) => cells);
  const rotation: RowGroupRange[][] = [];
  for (let turn = 0; rotation.length < buckets.size; turn += 1) {
    for (const cells of rows) {
      const next = cells[turn];
      if (next) rotation.push(next);
    }
  }
  if (unplaced.length > 0) rotation.push(unplaced);

  const ordered: RowGroupRange[] = [];
  for (let round = 0; ordered.length < groups.length; round += 1) {
    let progressed = false;
    for (const bucket of rotation) {
      const next = bucket[round];
      if (!next) continue;
      ordered.push(next);
      progressed = true;
    }
    if (!progressed) break;
  }
  return ordered;
}

// ---------------------------------------------------------------------------
// Cost, in the unit the read is actually paid in
// ---------------------------------------------------------------------------

/**
 * WHAT A PROJECTION OVER A SET OF ROW GROUPS COSTS, EXACTLY, BEFORE PAYING IT.
 *
 * The footer publishes `total_compressed_size` for every column chunk of every
 * row group. Summing the chunks the projection actually asks for gives the byte
 * cost of the read **to the byte** — not a sample, not an estimate, and not
 * something that has to be read to be discovered.
 *
 * It is exact rather than approximate for a mechanical reason worth writing
 * down, because it is the assumption that would silently rot: when a projection
 * is supplied, the reader fetches one range per included column chunk, spanning
 * exactly that chunk's compressed size, with no coalescing across the gaps. So
 * this sum is the same arithmetic the reader will do. Remove the projection and
 * the reader starts merging runs, at which point this becomes a lower bound —
 * which is why `scanFile` never calls it without one.
 *
 * Leaf paths are matched on their **first** element because a projection names
 * top-level columns and the format stores leaves: `bbox` is published as
 * `bbox.xmin`, `bbox.xmax`, … and `names` as `names.primary` and friends. That
 * is also precisely how the reader decides which chunks it needs, so the two
 * cannot disagree about what is being paid for.
 */
export function projectedCostOf(
  metadata: FileMetaData,
  groups: readonly RowGroupRange[],
  columns: readonly string[],
): number {
  const projection = new Set(columns);
  let bytes = 0;
  for (const group of groups) {
    bytes += groupCostOf(metadata, group, projection);
  }
  return bytes;
}

function groupCostOf(
  metadata: FileMetaData,
  group: RowGroupRange,
  projection: ReadonlySet<string>,
): number {
  const raw = metadata.row_groups[group.index];
  if (!raw) return 0;
  let bytes = 0;
  for (const column of raw.columns) {
    const path = column.meta_data?.path_in_schema;
    const head = path?.[0];
    if (head === undefined || !projection.has(head)) continue;
    bytes += Number(column.meta_data?.total_compressed_size ?? 0n);
  }
  return bytes;
}

/**
 * HOW MUCH OF THE AREA THIS READ CAN AFFORD, AND WHAT IT LEAVES BEHIND.
 *
 * The ordinary answer is "all of it", and that is the change. The pruned set for
 * a metropolis is tens of megabytes against a budget of hundreds, so the whole
 * area is read and the stratified order does not matter at all. It matters only
 * when the area genuinely costs more than the budget, and then it is what makes
 * the truncation a spread sample of the destination instead of one corner of it.
 *
 * That is the demotion stratification always deserved: the order in which an
 * exceptional truncation degrades, rather than the normal path.
 *
 * When not one group fits, the first is planned anyway. Returning nothing would
 * turn a thin budget into an empty destination, and the byte source's own hard
 * cap is still there to refuse the read — which reports a stop with a reason
 * rather than a layer that silently found nothing.
 */
export function planRead(input: {
  metadata: FileMetaData;
  /** The overlapping groups, already in stratified order. */
  ordered: readonly RowGroupRange[];
  columns: readonly string[];
  byteAllowance: number;
}): { groups: RowGroupRange[]; plan: ScanReadPlan } {
  const projection = new Set(input.columns);
  const costs = input.ordered.map((group) => groupCostOf(input.metadata, group, projection));
  const projectedBytes = costs.reduce((sum, cost) => sum + cost, 0);

  const planned: RowGroupRange[] = [];
  let plannedBytes = 0;
  if (projectedBytes <= input.byteAllowance) {
    planned.push(...input.ordered);
    plannedBytes = projectedBytes;
  } else {
    for (const [index, group] of input.ordered.entries()) {
      const cost = costs[index] ?? 0;
      if (plannedBytes + cost > input.byteAllowance) break;
      planned.push(group);
      plannedBytes += cost;
    }
    const first = input.ordered[0];
    if (planned.length === 0 && first) {
      planned.push(first);
      plannedBytes = costs[0] ?? 0;
    }
  }

  const rowsPlanned = planned.reduce((sum, group) => sum + (group.end - group.start), 0);
  return {
    groups: planned,
    plan: {
      rowGroupsInFile: input.metadata.row_groups.length,
      rowGroupsOverlapping: input.ordered.length,
      rowGroupsPlanned: planned.length,
      rowsPlanned,
      projectedBytes,
      plannedBytes,
      shortfallBytes: Math.max(0, projectedBytes - plannedBytes),
    },
  };
}

export interface ScanRequest<T> {
  url: string;
  box: BoundingBox;
  columns: readonly string[];
  /** Columns without which the layer cannot be normalised. Missing → refuse. */
  requiredColumns: readonly string[];
  budget: ScanBudget;
  counters: ScanCounters;
  /** Returns null to drop a row. Runs inside the budget, so keep it cheap. */
  accept: (row: Record<string, unknown>) => T | null;
  /** Where accepted rows go. Omit and the scan holds them itself. See `RowSink`. */
  sink?: RowSink<T>;
  signal?: AbortSignal;
}

/**
 * Scan one file for one box.
 *
 * The order of operations is the design, so it is worth stating plainly:
 *
 * 1. prune row groups on their own published statistics — exact, and free;
 * 2. put what survives into stratified order;
 * 3. **price the whole pruned set from the footer**, before spending a byte;
 * 4. read all of it when it fits the allowance, and the affordable prefix of
 *    the stratified order when it does not — saying, in bytes, what was left.
 *
 * Step 3 is the one that was missing, and its absence is the phase's central
 * defect. Without a price, the only way to bound a read is to count something —
 * row groups, decoded rows, retained rows — and every one of those counts was
 * set from a guess about a different destination. A metropolis's whole pruned
 * place inventory prices at about 50 MB against a 260 MB budget: affordable
 * several times over, and cut off at eleven of twenty-seven row groups by a
 * retained-row ceiling that had nothing to do with what the read cost.
 *
 * Row groups are read in *stratified* order — spread across the requested box —
 * never in file order. File order was tried first, on the argument that the
 * format's spatial coherence makes a truncated read a contiguous gap; the live
 * consequence was that "contiguous" meant one corner of a metropolis, with
 * every famous anchor outside it unread. See `stratifyRowGroups`. With the whole
 * area now normally affordable, that order decides nothing in the ordinary case
 * and everything in the exceptional one, which is where it belongs.
 */
export async function scanFile<T>(request: ScanRequest<T>): Promise<ScanResult<T>> {
  const { budget, counters } = request;
  const rows: T[] = [];
  /*
   * A caller with a sink holds the rows; this scan then holds none, and the
   * retained ceiling below is about *our* heap rather than theirs.
   */
  const hold = request.sink
    ? (row: T): void => request.sink!.add(row)
    : (row: T): void => {
        rows.push(row);
      };
  const held = request.sink ? (): number => 0 : (): number => rows.length;

  const buffer = await rangeBuffer(request.url, counters, budget);

  let metadata: FileMetaData;
  try {
    metadata = await parquetMetadataAsync(buffer);
  } catch (error) {
    if (error instanceof ScanError) throw error;
    throw new ScanError('malformed', 'The place data file could not be read.');
  }

  const present = new Set(metadata.schema.map((element) => element.name));
  const missing = request.requiredColumns.filter((column) => !present.has(column));
  if (missing.length > 0) {
    throw new ScanError(
      'schema_incompatible',
      `This release does not publish ${missing.join(', ')} for that layer.`,
    );
  }

  const overlapping = overlappingRowGroups(metadata, request.box);
  const stratification = stratificationOf(metadata, overlapping, request.box);
  const ordered = stratifyRowGroups(metadata, overlapping, request.box);
  counters.rowGroupsInspected += metadata.row_groups.length;

  const columns = request.columns.filter((column) => present.has(column));

  /*
   * The allowance is what is left of the ceiling *now*, after the footer, so a
   * second file in the same layer is priced against what the first actually
   * spent rather than against the ceiling both were handed.
   */
  const { groups, plan } = planRead({
    metadata,
    ordered,
    columns,
    byteAllowance: Math.max(0, budget.maxBytes - counters.bytesTransferred),
  });

  /*
   * A footer that lies is the only thing left to guard against, so the decoded
   * row limit is the plan's own declared row count rather than a global figure.
   * Global was the defect: one budget of 500,000 decoded rows shared by six
   * layers, spent entirely by the first dense one, leaving the layers that carry
   * a national park's whole inventory with nothing — starved by a number that
   * was never about them.
   */
  const featureCeiling = Math.min(
    budget.maxFeaturesRead,
    counters.featuresRead + plan.rowsPlanned,
  );

  /* Planned less than the area, and said so in bytes rather than in silence. */
  let stoppedBecause: ScanStop = plan.shortfallBytes > 0 ? 'byte_budget' : 'complete';
  /*
   * Blocks whose transfer or decode failed, skipped rather than fatal.
   *
   * One stalled range used to abandon every remaining planned group of the
   * file — measured across a night of live builds on a flaky link: layers
   * arrived at a third of their plan with the stop mislabelled `byte_budget`
   * (the catch below folded every non-timeout refusal into it), and the packs
   * never left `partial` across six rebuild rounds. Each range is its own
   * request on its own connection, so the next group is unaffected by this
   * one's death; the hole is counted, reported, and retried by the layer's
   * completion pass rather than silently widened.
   */
  let transferFailedGroups = 0;
  for (const group of groups) {
    if (request.signal?.aborted) {
      stoppedBecause = 'time_budget';
      break;
    }
    if (counters.rowGroupsRead >= budget.maxRowGroups) {
      stoppedBecause = 'row_group_budget';
      break;
    }
    if (counters.featuresRead >= featureCeiling) {
      stoppedBecause = 'feature_budget';
      break;
    }
    if (held() >= budget.maxFeaturesRetained) {
      stoppedBecause = 'retained_budget';
      break;
    }
    if (Date.now() > budget.deadlineMs) {
      stoppedBecause = 'time_budget';
      break;
    }

    let batch: Record<string, unknown>[];
    try {
      batch = (await parquetReadObjects({
        file: buffer,
        metadata,
        compressors: COMPRESSORS,
        rowStart: group.start,
        rowEnd: group.end,
        columns: [...columns],
      })) as Record<string, unknown>[];
    } catch (error) {
      if (error instanceof ScanError && error.code === 'timeout') {
        stoppedBecause = 'time_budget';
        break;
      }
      if (
        error instanceof ScanError &&
        error.code === 'too_large' &&
        /data-transfer limit/.test(error.message)
      ) {
        // The genuine budget refusal from the byte source: an honest stop.
        stoppedBecause = 'byte_budget';
        break;
      }
      /* A dead transfer or an undecodable block: one group's failure. */
      transferFailedGroups += 1;
      continue;
    }

    counters.rowGroupsRead += 1;
    counters.featuresRead += batch.length;

    for (const row of batch) {
      if (held() >= budget.maxFeaturesRetained) {
        stoppedBecause = 'retained_budget';
        break;
      }
      const accepted = request.accept(row);
      if (accepted !== null) hold(accepted);
    }
  }

  return { rows, counters, stoppedBecause, stratification, plan, transferFailedGroups };
}

/**
 * Whether a record's own bounding box *overlaps* the box we asked for.
 *
 * Pruning. Not membership, and it must never be read as membership.
 *
 * Row-group pruning is coarse by design — a group is kept when *any* of its rows
 * might match — so this per-row check is not redundant: without it a metro query
 * returns half a continent's worth of rows that merely shared a row group with
 * the ones we wanted. What it does not do, and cannot do, is say a row belongs
 * to the destination. The box it filters against is the union of partition cells
 * drawn around a *reach circle*, and a reach circle is a fact about how far the
 * traveller can get. A build that treated this function's `true` as acceptance
 * put an auto-parts store from an administrative region a hundred and sixty
 * kilometres away onto a city board, and every step in between was working
 * exactly as written.
 *
 * Belonging is decided in the compiler's containment layer, from the record's
 * own administrative evidence, after this has done its job.
 */
export function rowInBox(row: Record<string, unknown>, box: BoundingBox): boolean {
  const bbox = row.bbox as { xmin?: number; xmax?: number; ymin?: number; ymax?: number } | undefined;
  if (!bbox) return false;
  const { xmin, xmax, ymin, ymax } = bbox;
  if (
    typeof xmin !== 'number' ||
    typeof xmax !== 'number' ||
    typeof ymin !== 'number' ||
    typeof ymax !== 'number'
  ) {
    return false;
  }
  if (!Number.isFinite(xmin) || !Number.isFinite(xmax) || !Number.isFinite(ymin) || !Number.isFinite(ymax)) {
    return false;
  }
  return !(xmin > box.east || xmax < box.west || ymin > box.north || ymax < box.south);
}

/**
 * Whether the record's own position is inside the box we asked for.
 *
 * Still pruning, and still not membership — but a strictly better prune than
 * overlap, and the difference is not academic. An administrative record covering
 * a whole first-level division overlaps a metropolitan box by a corner while
 * sitting hundreds of kilometres from it; on overlap it is admitted and then
 * assigned to whichever cell its south-west corner happened to land in. Filtering
 * on the record's own point costs nothing and removes that entire class before
 * anything downstream has to reason about it.
 */
export function rowPointInBox(row: Record<string, unknown>, box: BoundingBox): boolean {
  const point = pointOf(row);
  if (!point) return false;
  return (
    point.lng >= box.west && point.lng <= box.east && point.lat >= box.south && point.lat <= box.north
  );
}

/**
 * A point for a record, from its bounding box.
 *
 * The centroid of the record's own covering box: for a point feature the box is
 * degenerate and this is exact, and for an area it is the middle rather than a
 * corner. Returns null on anything non-finite, because a NaN coordinate that
 * reaches the planner becomes a travel time nobody can explain.
 */
export function pointOf(row: Record<string, unknown>): { lat: number; lng: number } | null {
  const bbox = row.bbox as { xmin?: number; xmax?: number; ymin?: number; ymax?: number } | undefined;
  if (!bbox) return null;
  const { xmin, xmax, ymin, ymax } = bbox;
  if (
    typeof xmin !== 'number' ||
    typeof xmax !== 'number' ||
    typeof ymin !== 'number' ||
    typeof ymax !== 'number'
  ) {
    return null;
  }
  const lng = (xmin + xmax) / 2;
  const lat = (ymin + ymax) / 2;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

/** The record's own covering box, when it is a real area rather than a point. */
export function boundsOf(
  row: Record<string, unknown>,
): { southWest: { lat: number; lng: number }; northEast: { lat: number; lng: number } } | undefined {
  const bbox = row.bbox as { xmin?: number; xmax?: number; ymin?: number; ymax?: number } | undefined;
  if (!bbox) return undefined;
  const { xmin, xmax, ymin, ymax } = bbox;
  if (
    typeof xmin !== 'number' ||
    typeof xmax !== 'number' ||
    typeof ymin !== 'number' ||
    typeof ymax !== 'number'
  ) {
    return undefined;
  }
  if (!Number.isFinite(xmin) || !Number.isFinite(xmax) || !Number.isFinite(ymin) || !Number.isFinite(ymax)) {
    return undefined;
  }
  if (ymax <= ymin || xmax <= xmin) return undefined;
  if (ymin < -90 || ymax > 90 || xmin < -180 || xmax > 180) return undefined;
  return {
    southWest: { lat: ymin, lng: xmin },
    northEast: { lat: ymax, lng: xmax },
  };
}
