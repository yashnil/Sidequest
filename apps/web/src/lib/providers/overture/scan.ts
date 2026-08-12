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
 *    Over a metro-sized box that is 38 of 512 row groups; over a national park
 *    it is one of 512.
 * 4. **Column projection.** Only the columns the normaliser reads are fetched.
 *
 * Every step is capped, and every cap is reported rather than absorbed. A scan
 * that stops because it hit a budget is a normal outcome with a number attached,
 * which is the difference between "we looked at the middle of this" and an empty
 * region that reads as "there is nothing here".
 *
 * Zstandard comes from Node's own `zlib`, which has shipped it since 22.15.
 * Bringing a compression dependency in for something the runtime already does
 * would be a supply-chain surface for no gain.
 */

const RANGE_TIMEOUT_MS = 25_000;

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

export interface ScanBudget {
  maxRowGroups: number;
  maxBytes: number;
  maxFeaturesRead: number;
  maxFeaturesRetained: number;
  deadlineMs: number;
}

export interface ScanCounters {
  bytesTransferred: number;
  rowGroupsInspected: number;
  rowGroupsRead: number;
  featuresRead: number;
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

export interface ScanResult<T> {
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

      const response = await fetch(url, {
        headers: {
          'user-agent': USER_AGENT,
          range: `bytes=${from}-${to - 1}`,
        },
        signal: AbortSignal.timeout(RANGE_TIMEOUT_MS),
        redirect: 'error',
      });
      if (!response.ok && response.status !== 206) {
        throw new ScanError('unreachable', 'The place data files did not answer.');
      }
      const buffer = await response.arrayBuffer();
      counters.bytesTransferred += buffer.byteLength;
      return buffer;
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
  signal?: AbortSignal;
}

/**
 * Scan one file for one box.
 *
 * Row groups are read in *stratified* order — spread across the requested box —
 * never in file order. File order was tried first, on the argument that the
 * format's spatial coherence makes a truncated read a contiguous gap; the live
 * consequence was that "contiguous" meant one corner of a metropolis, with
 * every famous anchor outside it unread. See `stratifyRowGroups`.
 */
export async function scanFile<T>(request: ScanRequest<T>): Promise<ScanResult<T>> {
  const { budget, counters } = request;
  const rows: T[] = [];

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
  const groups = stratifyRowGroups(metadata, overlapping, request.box);
  counters.rowGroupsInspected += metadata.row_groups.length;

  const columns = request.columns.filter((column) => present.has(column));

  let stoppedBecause: ScanStop = 'complete';
  for (const group of groups) {
    if (request.signal?.aborted) {
      stoppedBecause = 'time_budget';
      break;
    }
    if (counters.rowGroupsRead >= budget.maxRowGroups) {
      stoppedBecause = 'row_group_budget';
      break;
    }
    if (counters.featuresRead >= budget.maxFeaturesRead) {
      stoppedBecause = 'feature_budget';
      break;
    }
    if (rows.length >= budget.maxFeaturesRetained) {
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
      if (error instanceof ScanError) {
        // A budget refusal inside the byte source stops the scan honestly rather
        // than propagating as a read failure that would discard what we have.
        stoppedBecause = error.code === 'timeout' ? 'time_budget' : 'byte_budget';
        break;
      }
      throw new ScanError('malformed', 'A block of the place data could not be decoded.');
    }

    counters.rowGroupsRead += 1;
    counters.featuresRead += batch.length;

    for (const row of batch) {
      if (rows.length >= budget.maxFeaturesRetained) {
        stoppedBecause = 'retained_budget';
        break;
      }
      const accepted = request.accept(row);
      if (accepted !== null) rows.push(accepted);
    }
  }

  return { rows, counters, stoppedBecause, stratification };
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
