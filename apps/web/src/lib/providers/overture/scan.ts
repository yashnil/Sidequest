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

export interface ScanResult<T> {
  rows: T[];
  counters: ScanCounters;
  stoppedBecause: ScanStop;
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
export function overlappingRowGroups(metadata: FileMetaData, box: BoundingBox): RowGroupRange[] {
  const ranges: RowGroupRange[] = [];
  let offset = 0;
  for (const [index, group] of metadata.row_groups.entries()) {
    const rows = Number(group.num_rows);
    const start = offset;
    offset += rows;

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
      ranges.push({ index, start, end: offset });
      continue;
    }

    const disjoint =
      xmin.min > box.east || xmax.max < box.west || ymin.min > box.north || ymax.max < box.south;
    if (!disjoint) ranges.push({ index, start, end: offset });
  }
  return ranges;
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
 * Row groups are read in file order rather than in relevance order, which is
 * deliberate: the format's own ordering is spatially coherent, so consecutive
 * groups cover adjacent ground and a budget that runs out leaves a contiguous
 * gap rather than a shredded one. A shredded coverage map cannot be described to
 * a traveller; a contiguous one can.
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

  const groups = overlappingRowGroups(metadata, request.box);
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

  return { rows, counters, stoppedBecause };
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
