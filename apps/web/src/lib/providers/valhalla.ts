import 'server-only';
import { z } from 'zod';
import { USER_AGENT } from './nominatim';

/**
 * VALHALLA — ROUTING AND ROUTE MATRICES.
 *
 * Chosen because its results are ours to keep. Valhalla is open source routing
 * over OpenStreetMap data, so a duration stored in a compiled region carries an
 * ODbL obligation we can meet — attribution — rather than a prohibition we
 * cannot. That is the whole reason this file exists instead of a Google one.
 *
 * The public demo endpoint is for **bounded development smoke tests only**. It
 * is rate-limited, unversioned and offered as a courtesy; `SIDEQUEST_ROUTES_URL`
 * moves this to a hosted or self-managed instance without an application change.
 *
 * Two properties matter more than the batching:
 *
 * - **A pair that could not be routed is recorded, never zeroed.** A missing leg
 *   read as zero teleports a traveller, and the compiler drops the place instead.
 * - **Nothing here falls back to straight-line distance.** A haversine number
 *   labelled as a drive time is the most confidently wrong thing this system
 *   could produce.
 */

const DEFAULT_ENDPOINT = 'https://valhalla1.openstreetmap.de';
const REQUEST_TIMEOUT_MS = 30_000;
const MIN_INTERVAL_MS = 1_100;
const MAX_RESPONSE_BYTES = 4_000_000;

/** Valhalla's own guidance for the demo server; also a sane batch anywhere. */
export const MAX_MATRIX_PAIRS_PER_REQUEST = 400;

export class RoutingError extends Error {
  readonly code: 'not_configured' | 'rate_limited' | 'request_failed' | 'malformed_response';

  constructor(code: RoutingError['code'], message: string) {
    super(message);
    this.name = 'RoutingError';
    this.code = code;
  }
}

export function routingEndpoint(): string {
  return (process.env.SIDEQUEST_ROUTES_URL?.trim() || DEFAULT_ENDPOINT).replace(/\/+$/, '');
}

export function isRoutesProviderEnabled(): boolean {
  return process.env.SIDEQUEST_ROUTES_PROVIDER?.trim().toLowerCase() === 'valhalla';
}

export type ValhallaCosting = 'auto' | 'pedestrian' | 'bicycle' | 'bus' | 'motor_scooter';

let gate: Promise<void> = Promise.resolve();

function nextSlot(): Promise<void> {
  const wait = gate.then(() => new Promise<void>((resolve) => setTimeout(resolve, MIN_INTERVAL_MS)));
  gate = wait.catch(() => undefined);
  return wait;
}

const matrixCellSchema = z.object({
  /** Seconds. Valhalla omits or nulls both when no route exists. */
  time: z.number().nullable().optional(),
  /** Kilometres, because we ask for them. */
  distance: z.number().nullable().optional(),
  from_index: z.number(),
  to_index: z.number(),
});

const matrixResponseSchema = z.object({
  sources_to_targets: z.union([
    z.array(z.array(matrixCellSchema)),
    z.array(matrixCellSchema),
  ]),
});

export interface RoutePoint {
  id: string;
  lat: number;
  lng: number;
}

export interface MatrixOutcome {
  ids: string[];
  /** minutes[from][to]; NaN where no route was found. Never silently zero. */
  minutes: number[][];
  km: number[][];
  failedPairs: { from: string; to: string }[];
  calls: number;
  pairs: number;
  cacheHits: number;
}

export interface MatrixOptions {
  maxPairs: number;
  fetchImpl?: typeof fetch;
  cache?: {
    read: (key: string) => { minutes: number[][]; km: number[][] } | null;
    write: (key: string, value: { minutes: number[][]; km: number[][] }) => void;
  };
}

export function matrixCacheKey(
  sources: readonly RoutePoint[],
  targets: readonly RoutePoint[],
  costing: ValhallaCosting,
): string {
  const point = (entry: RoutePoint): string => `${entry.lat.toFixed(5)},${entry.lng.toFixed(5)}`;
  return [
    'valhalla',
    'v1',
    routingEndpoint(),
    costing,
    sources.map(point).join(';'),
    '->',
    targets.map(point).join(';'),
  ].join('|');
}

async function requestBlock(
  sources: readonly RoutePoint[],
  targets: readonly RoutePoint[],
  costing: ValhallaCosting,
  options: MatrixOptions,
): Promise<{ minutes: number[][]; km: number[][]; cached: boolean }> {
  const key = matrixCacheKey(sources, targets, costing);
  const cached = options.cache?.read(key);
  if (cached) return { ...cached, cached: true };

  const body = {
    sources: sources.map((point) => ({ lat: point.lat, lon: point.lng })),
    targets: targets.map((point) => ({ lat: point.lat, lon: point.lng })),
    costing,
    units: 'kilometers',
    id: 'sidequest-matrix',
  };

  await nextSlot();

  const doFetch = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await doFetch(`${routingEndpoint()}/sources_to_targets`, {
      method: 'POST',
      headers: {
        'user-agent': USER_AGENT,
        // Honoured by several hosted Valhalla deployments for attribution and
        // fair-use accounting. Harmless where it is not.
        'x-client-id': 'sidequest-dev',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new RoutingError('request_failed', 'The routing service did not answer.');
  }

  if (response.status === 429) {
    throw new RoutingError('rate_limited', 'The routing service asked us to slow down.');
  }
  if (!response.ok) {
    throw new RoutingError('request_failed', 'The routing service did not answer.');
  }

  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) {
    throw new RoutingError('malformed_response', 'The routing service returned more than we will read.');
  }

  const parsed = matrixResponseSchema.safeParse(JSON.parse(text));
  if (!parsed.success) {
    throw new RoutingError('malformed_response', 'The routing service returned a shape we cannot read.');
  }

  const minutes = sources.map(() => new Array<number>(targets.length).fill(Number.NaN));
  const km = sources.map(() => new Array<number>(targets.length).fill(Number.NaN));

  // Valhalla returns either a matrix of rows or one flat list, depending on
  // version. Both are keyed by from_index/to_index, so both are read the same way.
  const cells = Array.isArray(parsed.data.sources_to_targets[0])
    ? (parsed.data.sources_to_targets as z.infer<typeof matrixCellSchema>[][]).flat()
    : (parsed.data.sources_to_targets as z.infer<typeof matrixCellSchema>[]);

  for (const cell of cells) {
    const from = cell.from_index;
    const to = cell.to_index;
    if (minutes[from] === undefined || km[from] === undefined) continue;
    // A null time is Valhalla saying "no route", which is a real answer and a
    // different one from zero.
    if (cell.time === null || cell.time === undefined) continue;
    minutes[from]![to] = Math.round(cell.time / 60);
    km[from]![to] = cell.distance ?? Number.NaN;
  }

  const result = { minutes, km };
  options.cache?.write(key, result);
  return { ...result, cached: false };
}

/**
 * A full square matrix, batched to stay inside the pair budget.
 *
 * The budget is spent block by block, and a block that would exceed it is not
 * requested — every pair inside it is reported as failed instead. That is what
 * turns "we ran out of budget" into a visible coverage number rather than a
 * matrix that is quietly smaller than it looks.
 */
export async function computeMatrix(
  points: readonly RoutePoint[],
  costing: ValhallaCosting,
  options: MatrixOptions,
): Promise<MatrixOutcome> {
  const ids = points.map((point) => point.id);
  const size = points.length;
  const minutes = ids.map(() => new Array<number>(size).fill(Number.NaN));
  const km = ids.map(() => new Array<number>(size).fill(Number.NaN));
  const failedPairs: { from: string; to: string }[] = [];

  const blockSize = Math.max(1, Math.floor(Math.sqrt(MAX_MATRIX_PAIRS_PER_REQUEST)));
  let calls = 0;
  let pairs = 0;
  let cacheHits = 0;

  for (let rowStart = 0; rowStart < size; rowStart += blockSize) {
    for (let colStart = 0; colStart < size; colStart += blockSize) {
      const sources = points.slice(rowStart, rowStart + blockSize);
      const targets = points.slice(colStart, colStart + blockSize);
      const cells = sources.length * targets.length;

      const markFailed = (): void => {
        for (const source of sources) {
          for (const target of targets) {
            if (source.id !== target.id) failedPairs.push({ from: source.id, to: target.id });
          }
        }
      };

      if (pairs + cells > options.maxPairs) {
        markFailed();
        continue;
      }

      try {
        const block = await requestBlock(sources, targets, costing, options);
        if (block.cached) cacheHits += 1;
        else calls += 1;
        pairs += cells;

        for (let row = 0; row < sources.length; row += 1) {
          for (let col = 0; col < targets.length; col += 1) {
            const value = block.minutes[row]?.[col];
            const distance = block.km[row]?.[col];
            const from = rowStart + row;
            const to = colStart + col;
            const fromId = ids[from];
            const toId = ids[to];
            const fromPoint = points[from];
            const toPoint = points[to];
            const implausible =
              value !== undefined &&
              fromPoint !== undefined &&
              toPoint !== undefined &&
              !isPlausibleLeg({
                minutes: value,
                km: distance ?? Number.NaN,
                from: fromPoint,
                to: toPoint,
                costing,
              });

            if (value === undefined || Number.isNaN(value) || implausible) {
              if (fromId && toId && fromId !== toId) failedPairs.push({ from: fromId, to: toId });
              continue;
            }
            minutes[from]![to] = value;
            km[from]![to] = distance ?? Number.NaN;
          }
        }
      } catch {
        markFailed();
      }
    }
  }

  for (let index = 0; index < size; index += 1) {
    minutes[index]![index] = 0;
    km[index]![index] = 0;
  }

  return { ids, minutes, km, failedPairs, calls, pairs, cacheHits };
}

/**
 * Drop the points that could not be routed, and return a dense matrix.
 *
 * The planner refuses a matrix with a hole in it, correctly: it cannot lay out a
 * day around a leg nobody can measure. So the unroutable points leave here and
 * the caller learns which, which becomes a coverage number rather than a crash.
 */
export function densify(outcome: MatrixOutcome): {
  ids: string[];
  minutes: number[][];
  km: number[][];
  dropped: string[];
} {
  const keep: number[] = [];
  const dropped: string[] = [];

  for (let index = 0; index < outcome.ids.length; index += 1) {
    const row = outcome.minutes[index] ?? [];
    const outbound = row.every((value, other) => other === index || Number.isFinite(value));
    const inbound = outcome.minutes.every(
      (otherRow, other) => other === index || Number.isFinite(otherRow[index]),
    );
    if (outbound && inbound) keep.push(index);
    else dropped.push(outcome.ids[index]!);
  }

  return {
    ids: keep.map((index) => outcome.ids[index]!),
    minutes: keep.map((from) => keep.map((to) => outcome.minutes[from]![to]!)),
    // A routed pair with no distance is rare and not worth dropping a place
    // over; the distance is only ever shown, never planned against.
    km: keep.map((from) =>
      keep.map((to) => {
        const value = outcome.km[from]![to]!;
        return Number.isFinite(value) ? value : 0;
      }),
    ),
    dropped,
  };
}

/**
 * Speeds a mode can actually travel at, used to reject a cell that cannot be true.
 *
 * This exists because a live evaluation caught the routing engine returning a
 * 16.5 km pedestrian distance between two points 1.07 km apart, with a duration
 * that reconciled with neither. Whatever the cause — a snapped endpoint, a
 * unit inconsistency — the product consequence is the one thing this system is
 * built to prevent: a fabricated travel time presented as a measurement.
 *
 * So every cell is checked against physics before it is believed. A pair that
 * fails becomes a *failed pair*, which the compiler already knows how to handle
 * by dropping the place — rather than a number that quietly makes a day
 * undeliverable. Bands are deliberately wide: the job is to catch the absurd,
 * not to second-guess a routing engine that knows about hills.
 */
const SPEED_BANDS: Record<ValhallaCosting, { minKmh: number; maxKmh: number }> = {
  pedestrian: { minKmh: 1.5, maxKmh: 9 },
  bicycle: { minKmh: 4, maxKmh: 40 },
  auto: { minKmh: 5, maxKmh: 140 },
  bus: { minKmh: 3, maxKmh: 110 },
  motor_scooter: { minKmh: 5, maxKmh: 120 },
};

/** Straight-line km, to catch a road distance that cannot correspond to it. */
function straightLineKm(a: RoutePoint, b: RoutePoint): number {
  const toRad = (deg: number): number => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.sqrt(h));
}

/**
 * Whether a routed cell is worth believing.
 *
 * Two independent checks, because they catch different lies. The speed band
 * catches a duration that does not match its own distance. The detour ratio
 * catches a distance that cannot correspond to the two points it claims to
 * connect — no real route is fifteen times the straight line, and a router that
 * says so has snapped an endpoint somewhere else entirely.
 */
export function isPlausibleLeg(input: {
  minutes: number;
  km: number;
  from: RoutePoint;
  to: RoutePoint;
  costing: ValhallaCosting;
}): boolean {
  if (!Number.isFinite(input.minutes) || input.minutes < 0) return false;
  if (input.minutes === 0) return true;
  if (!Number.isFinite(input.km) || input.km < 0) return true; // distance is display-only

  const direct = straightLineKm(input.from, input.to);
  // Under 300 m, snapping noise dominates and every ratio looks wrong.
  if (direct > 0.3 && input.km / direct > 15) return false;

  const band = SPEED_BANDS[input.costing];
  const impliedKmh = input.km / (input.minutes / 60);
  if (impliedKmh > band.maxKmh) return false;
  // A very short leg can legitimately imply a slow speed through crossings and
  // waiting, so the floor only applies once there is real distance in it.
  if (input.km > 1 && impliedKmh < band.minKmh) return false;
  return true;
}

export function costingFor(mode: 'car' | 'foot' | 'transit'): ValhallaCosting {
  if (mode === 'car') return 'auto';
  if (mode === 'foot') return 'pedestrian';
  // Valhalla has no general transit costing on the demo deployment. Bus is the
  // closest honest answer, and the provenance says what was actually measured.
  return 'bus';
}
