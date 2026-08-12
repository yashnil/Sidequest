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

/** Re-exported from the import-free switch module. See `providers/switches.ts`. */
export { isRoutesProviderEnabled } from './switches';

export type ValhallaCosting = 'auto' | 'pedestrian' | 'bicycle' | 'bus' | 'motor_scooter';

/**
 * ONE QUEUE FOR ONE HOST.
 *
 * Exported because the transit adapter talks to the *same* routing service on
 * the same endpoint, and it had a second gate of its own — so two schedulers
 * each politely waited 1.1 seconds while between them issuing requests at twice
 * the rate either believed it was enforcing. A rate limit split across two
 * modules is not a rate limit.
 */
let gate: Promise<void> = Promise.resolve();

export function nextRoutingSlot(intervalMs: number = MIN_INTERVAL_MS): Promise<void> {
  const wait = gate.then(() => new Promise<void>((resolve) => setTimeout(resolve, intervalMs)));
  gate = wait.catch(() => undefined);
  return wait;
}

function nextSlot(): Promise<void> {
  return nextRoutingSlot();
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
  /** Ordered pairs this run needed. Counted whether bought or read back. */
  pairs: number;
  /** Ordered pairs answered from the store rather than from the router. */
  cacheHits: number;
}

/**
 * ONE CACHE ENTRY PER ORDERED PAIR OF COORDINATES.
 *
 * The entry used to be a whole 20×20 block, keyed on the ordered coordinate
 * lists of both its axes. Every pair in it was genuinely cached and none of it
 * was ever reusable, because a key naming forty points only matches a request
 * that assembles the same forty in the same two orders. Two Tokyo builds three
 * days apart both reported `routeCacheHits=0` against `routePairs=676` — the
 * second re-bought all 676 pairs and spent 57 seconds doing it, 73% of its
 * machine time, for a matrix that had changed by one place.
 *
 * A pair is the unit the router is actually asked about and the unit whose
 * answer is stable, so it is the unit stored. Any block composition then
 * assembles from what is held and only the genuinely new pairs are requested —
 * which is also what makes an itinerary edit cheap, since adding one stop to a
 * region asks for one row and one column rather than the square.
 */
export interface MatrixPairCache {
  read: (key: string) => { minutes: number; km: number } | null;
  write: (key: string, value: { minutes: number; km: number }) => void;
}

export interface MatrixOptions {
  maxPairs: number;
  fetchImpl?: typeof fetch;
  cache?: MatrixPairCache;
}

/**
 * Five decimal places, which is about a metre.
 *
 * Coordinates rather than ids, deliberately: the same trailhead arrives with a
 * different synthetic id from one compilation to the next, and a key built from
 * ids would miss on every rebuild while describing the same journey. What the
 * router answered about is two points on the ground.
 */
export function matrixPairCacheKey(
  from: RoutePoint,
  to: RoutePoint,
  costing: ValhallaCosting,
): string {
  const point = (entry: RoutePoint): string => `${entry.lat.toFixed(5)},${entry.lng.toFixed(5)}`;
  return ['valhalla', 'pair', 'v1', routingEndpoint(), costing, point(from), '->', point(to)].join(
    '|',
  );
}

/**
 * How many consecutive failures close the circuit.
 *
 * A public demo endpoint is not a production service, and the honest posture is
 * that it will sometimes stop answering. Without a breaker, a country-scale plan
 * with forty blocks meets forty timeouts one after another and spends twenty
 * minutes discovering what the third one already knew.
 *
 * Reset by any success, so a single blip does not disable routing for the rest
 * of a build.
 */
const CIRCUIT_THRESHOLD = 4;

/**
 * Retries per block, and the backoff between them.
 *
 * Two, because the failures worth retrying are transient — a rate limit or a
 * dropped connection — and a third attempt against a service that has said no
 * twice is spending somebody's quota to learn nothing. Capped, so a retry storm
 * cannot multiply spend without a ceiling.
 */
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [0, 1_500, 4_000];

/** Reset per matrix run rather than per process: a build should start hopeful. */
export interface CircuitState {
  consecutiveFailures: number;
  open: boolean;
}

export function newCircuit(): CircuitState {
  return { consecutiveFailures: 0, open: false };
}

async function fetchBlock(
  sources: readonly RoutePoint[],
  targets: readonly RoutePoint[],
  costing: ValhallaCosting,
  options: MatrixOptions,
  circuit?: CircuitState,
): Promise<{ minutes: number[][]; km: number[][] }> {
  if (circuit?.open) {
    throw new RoutingError('request_failed', 'The routing service stopped answering.');
  }

  const body = {
    sources: sources.map((point) => ({ lat: point.lat, lon: point.lng })),
    targets: targets.map((point) => ({ lat: point.lat, lon: point.lng })),
    costing,
    units: 'kilometers',
    id: 'sidequest-matrix',
  };

  const doFetch = options.fetchImpl ?? fetch;
  let text = '';
  let lastError: RoutingError | null = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await sleep(BACKOFF_MS[attempt] ?? 4_000);
    await nextSlot();

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
      lastError = new RoutingError('request_failed', 'The routing service did not answer.');
      continue;
    }

    if (response.status === 429) {
      lastError = new RoutingError('rate_limited', 'The routing service asked us to slow down.');
      continue;
    }
    if (!response.ok) {
      /*
       * A 4xx other than 429 is us, not them — a malformed request retried three
       * times is three identical rejections. Only 5xx and transport failures are
       * worth another attempt.
       */
      lastError = new RoutingError('request_failed', 'The routing service did not answer.');
      if (response.status < 500) break;
      continue;
    }

    text = await response.text();
    lastError = null;
    break;
  }

  if (lastError) {
    if (circuit) {
      circuit.consecutiveFailures += 1;
      if (circuit.consecutiveFailures >= CIRCUIT_THRESHOLD) circuit.open = true;
    }
    throw lastError;
  }
  if (circuit) circuit.consecutiveFailures = 0;

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

  return { minutes, km };
}

/**
 * One block, assembled from what is held and bought only where it is not.
 *
 * The three counters it returns are the whole point of the rewrite, so they are
 * exact rather than approximate: `served` is pairs answered from the store,
 * `bought` is pairs the router was asked for, and `calls` is the number of
 * requests that took (zero when everything was held).
 *
 * Only a *routed* pair is written back. A pair the router could not answer is
 * left unstored, because "no route today" is frequently a snapped endpoint or a
 * closed road rather than a fact about the ground, and a cache that made it
 * permanent would keep a place out of every future plan for a month.
 */
async function resolveBlock(
  sources: readonly RoutePoint[],
  targets: readonly RoutePoint[],
  costing: ValhallaCosting,
  options: MatrixOptions,
  budgetRemaining: number,
  circuit?: CircuitState,
): Promise<{
  minutes: number[][];
  km: number[][];
  served: number;
  bought: number;
  calls: number;
  /** True when the block was skipped whole because its missing pairs cost too much. */
  overBudget: boolean;
}> {
  const minutes = sources.map(() => new Array<number>(targets.length).fill(Number.NaN));
  const km = sources.map(() => new Array<number>(targets.length).fill(Number.NaN));

  /** Which columns each row still needs, so a request covers only those. */
  const missingByRow = new Map<number, number[]>();
  let served = 0;

  for (let row = 0; row < sources.length; row += 1) {
    const wanted: number[] = [];
    for (let col = 0; col < targets.length; col += 1) {
      const source = sources[row]!;
      const target = targets[col]!;
      const held = options.cache?.read(matrixPairCacheKey(source, target, costing)) ?? null;
      if (held && Number.isFinite(held.minutes)) {
        minutes[row]![col] = held.minutes;
        km[row]![col] = held.km;
        served += 1;
        continue;
      }
      wanted.push(col);
    }
    if (wanted.length > 0) missingByRow.set(row, wanted);
  }

  if (missingByRow.size === 0) {
    return { minutes, km, served, bought: 0, calls: 0, overBudget: false };
  }

  /**
   * THE MISSING CELLS ARE A CROSS, NOT A RECTANGLE, AND THE API TAKES RECTANGLES.
   *
   * Adding one place to a held region leaves its whole row and its whole column
   * unanswered and everything else held. The smallest rectangle covering that
   * cross is the entire square — so a single covering request re-buys all 49
   * pairs of a 7×7 matrix to learn 13, which is most of the saving thrown away
   * at the last step.
   *
   * Rows that need the *same* columns are one rectangle, so grouping by that
   * signature decomposes the cross exactly: the new row against everything, and
   * everything against the new column. Two requests, thirteen pairs.
   *
   * Bounded, because calls and pairs are different resources: pairs are what a
   * router bills for and calls are what it rate-limits, at better than a second
   * apart. Past a handful of groups the wall-clock cost of the extra round trips
   * outweighs the pairs they save, and the single covering rectangle is the
   * better trade. Four covers every shape a rebuild actually produces.
   */
  const MAX_REQUESTS_PER_BLOCK = 4;
  const bySignature = new Map<string, { rows: number[]; cols: number[] }>();
  for (const [row, cols] of missingByRow) {
    const signature = cols.join(',');
    const group = bySignature.get(signature);
    if (group) group.rows.push(row);
    else bySignature.set(signature, { rows: [row], cols });
  }

  const groups =
    bySignature.size <= MAX_REQUESTS_PER_BLOCK
      ? [...bySignature.values()]
      : [
          {
            rows: [...missingByRow.keys()].sort((a, b) => a - b),
            cols: [...new Set([...missingByRow.values()].flat())].sort((a, b) => a - b),
          },
        ];

  const bought = groups.reduce((sum, group) => sum + group.rows.length * group.cols.length, 0);

  /*
   * The budget is charged for what is bought, never for what was held.
   *
   * Charging cached pairs was the old behaviour and it made a warm build
   * *smaller* than a cold one: the ceiling was reached on pairs that cost
   * nothing, and the blocks beyond it were reported as unroutable.
   */
  if (bought > budgetRemaining) {
    return { minutes, km, served, bought: 0, calls: 0, overBudget: true };
  }

  let calls = 0;
  for (const group of groups) {
    const fetched = await fetchBlock(
      group.rows.map((row) => sources[row]!),
      group.cols.map((col) => targets[col]!),
      costing,
      options,
      circuit,
    );
    calls += 1;

    for (let r = 0; r < group.rows.length; r += 1) {
      for (let c = 0; c < group.cols.length; c += 1) {
        const value = fetched.minutes[r]?.[c];
        const distance = fetched.km[r]?.[c];
        if (value === undefined || !Number.isFinite(value)) continue;
        const row = group.rows[r]!;
        const col = group.cols[c]!;
        minutes[row]![col] = value;
        km[row]![col] = distance ?? Number.NaN;
        options.cache?.write(matrixPairCacheKey(sources[row]!, targets[col]!, costing), {
          minutes: value,
          km: Number.isFinite(distance) ? (distance as number) : Number.NaN,
        });
      }
    }
  }

  return { minutes, km, served, bought, calls, overBudget: false };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A full square matrix, batched to stay inside the pair budget.
 *
 * The budget is spent block by block, and a block whose *unheld* pairs would
 * exceed it is not requested — every pair inside it is reported as failed
 * instead. That is what turns "we ran out of budget" into a visible coverage
 * number rather than a matrix that is quietly smaller than it looks.
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
  const circuit = newCircuit();
  let calls = 0;
  let pairs = 0;
  let cacheHits = 0;
  /** Pairs actually charged to the router, which is what the budget bounds. */
  let bought = 0;

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

      try {
        const block = await resolveBlock(
          sources,
          targets,
          costing,
          options,
          options.maxPairs - bought,
          circuit,
        );
        if (block.overBudget) {
          markFailed();
          continue;
        }
        calls += block.calls;
        bought += block.bought;
        cacheHits += block.served;
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
  /**
   * The largest mutually routable core, not "every point that reached everything".
   *
   * The first version kept a point only if all of its legs were measured, and
   * that is an all-or-nothing rule with a cascade in it: one summit nobody can
   * drive to has an unroutable leg to *every* other point, so every other point
   * also fails the test, and a live Denali build came back with a matrix of
   * **zero** points out of forty-one. The region was reported as having no usable
   * travel times when in fact most of it was perfectly routable.
   *
   * So instead: peel off the worst-connected point, repeatedly, until what is
   * left is complete. Each round removes the single point responsible for the
   * most missing legs, which is the cheapest way to the largest complete
   * submatrix — and every peeled point is still reported, so it becomes a
   * coverage number rather than a silent absence.
   */
  const size = outcome.ids.length;
  const alive = new Set<number>(Array.from({ length: size }, (_, index) => index));
  const dropped: string[] = [];

  const missingFor = (index: number): number => {
    let count = 0;
    for (const other of alive) {
      if (other === index) continue;
      if (!Number.isFinite(outcome.minutes[index]?.[other])) count += 1;
      if (!Number.isFinite(outcome.minutes[other]?.[index])) count += 1;
    }
    return count;
  };

  while (alive.size > 1) {
    let worst = -1;
    let worstCount = 0;
    for (const index of alive) {
      const count = missingFor(index);
      // Ties break on the lower index, so two runs peel identically.
      if (count > worstCount) {
        worstCount = count;
        worst = index;
      }
    }
    if (worstCount === 0 || worst < 0) break;
    alive.delete(worst);
    dropped.push(outcome.ids[worst]!);
  }

  /** A single surviving point cannot be a matrix; it is a point. */
  const keep = alive.size >= 2 ? [...alive].sort((a, b) => a - b) : [];
  if (keep.length === 0) {
    for (const index of alive) dropped.push(outcome.ids[index]!);
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

/**
 * THE TRANSIT MAPPING IS GONE, AND ITS ABSENCE IS THE POINT.
 *
 * This used to answer `'bus'` for `transit` — Valhalla's road-network *vehicle*
 * costing, a bus-shaped thing driving on roads with no timetable behind it — on
 * the reasoning that it was "the closest honest answer". It is not an honest
 * answer at all: it measures a road journey and returns it under the name of a
 * scheduled one, which is the precise substitution the capability registry, the
 * separate transit seam and the whole readiness deficit exist to prevent.
 *
 * It was unreachable, and unreachability is not a safety property. Removing the
 * case from the type means a caller that acquires a transit mode fails to
 * compile rather than quietly receiving a drive.
 *
 * Real multimodal routing lives in `providers/transit.ts`, against
 * `costing=multimodal`, and refuses any reply with no transit leg in it.
 */
export function costingFor(mode: 'car' | 'foot'): ValhallaCosting {
  return mode === 'car' ? 'auto' : 'pedestrian';
}
