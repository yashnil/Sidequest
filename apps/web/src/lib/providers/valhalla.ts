import 'server-only';
import { z } from 'zod';
import { USER_AGENT } from './nominatim';
import { requestSignal } from '../net/generation-deadline';

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

/**
 * THE INTERACTIVE ROUTING SLO.
 *
 * A traveller waiting on an itinerary is not a batch job. The live Iceland
 * validation this bounds against measured *individual* matrix requests
 * running 140s and 198s — not because any one HTTP call hung that long
 * (`REQUEST_TIMEOUT_MS` alone bounds that), but because a degraded top-level
 * block subdivides into quadrants, then rows or columns, then single pairs
 * (`resolveRectangle`'s own ladder, `MAX_SUBDIVISION_DEPTH` deep), and every
 * one of those *sequential*, awaited children paid its own timeout with no
 * ceiling on the sum. Isolating which specific pairs a degraded provider can
 * and cannot answer — the actual reason subdivision exists — is worth
 * keeping; letting the isolation itself run unbounded is not, and the two
 * are separable: `MAX_TOTAL_MATRIX_MS` bounds the sum without changing what
 * subdivision does.
 *
 * Every number below is a *reduction* from what shipped through the live
 * validation, chosen from the shape of the actual failure, not invented:
 *
 * - `REQUEST_TIMEOUT_MS` 30s → 8s. A real, healthy routing service answers a
 *   ≤400-pair block in well under a second; 8s is generous headroom for one
 *   attempt, not a promise about how long a traveller should wait.
 * - `MAX_ATTEMPTS` 3 → 2, `BACKOFF_MS` `[0,1500,4000]` → `[0,1000]`. A second
 *   attempt catches a genuine transient blip; a third spends a traveller's
 *   patience relearning what the second attempt already established.
 * - `CIRCUIT_THRESHOLD` 4 → 3. An outage should stop costing new requests
 *   sooner, and every consecutive failure through this ladder is now cheaper
 *   to accumulate than it was.
 * - `MAX_TOTAL_MATRIX_MS` (new) — a hard wall-clock ceiling on one
 *   `computeMatrix()` call, covering every block and every subdivided child
 *   together. **60s, not the tighter number the timeout/attempt/circuit
 *   arithmetic alone would suggest** — genuinely isolating one poisoned
 *   point among several others can legitimately need a couple of dozen
 *   *sequential* single-pair requests (`resolveRectangle`'s per-point
 *   probing ladder), each still paced by `MIN_INTERVAL_MS` even when every
 *   attempt succeeds instantly — see this file's own
 *   `isolates a poisoned point down to its own pairs, past the quadrant
 *   depth` test, which needs the greater part of a minute under perfectly
 *   healthy conditions. 60s is chosen as the smallest ceiling that still
 *   comfortably fits that legitimate case, not the smallest one arithmetic
 *   alone would justify — and it is still a real, more-than-3× reduction
 *   from the worst wall-clock (198s) this round's live Iceland run actually
 *   measured, for the realistic production shape (Phase A ≤5 points, Phase
 *   B ≤4 points per skeleton hydration round) this ceiling exists to
 *   protect, which needs nowhere near this many sequential probes. Once
 *   passed, every cell `computeMatrix` has not yet resolved is reported
 *   `'provider_error'` — the same honest "no trustworthy measurement",
 *   never a fabricated value — and no further requests are attempted.
 *
 * None of this widens what a caller must know: `computeMatrix`'s signature
 * is unchanged, and every existing caller (the compiler's own matrix
 * building included) gets the same, safer defaults for free.
 */
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_TOTAL_MATRIX_MS = 60_000;
const MIN_INTERVAL_MS = 1_100;
const MAX_RESPONSE_BYTES = 4_000_000;

/** Valhalla's own guidance for the demo server; also a sane batch anywhere. */
export const MAX_MATRIX_PAIRS_PER_REQUEST = 400;

export class RoutingError extends Error {
  readonly code: 'not_configured' | 'rate_limited' | 'request_failed' | 'malformed_response';
  /**
   * PRODUCTION LOCK V5 §18 — the service said the coordinates are outside the
   * road network it holds (`error_code` 170/171), not that the request was bad.
   *
   * Carried on the error rather than inferred from the message, because it is
   * the one rejection a caller should *act* on: a regional tile build will say
   * the same thing about every leg of a trip outside its tiles, and the only
   * useful response is to stop asking it and use a router that covers the place.
   */
  readonly outOfCoverage: boolean;
  /**
   * True when the service *rejected this request* rather than failing to
   * answer — a 4xx other than 429. The distinction is load-bearing twice: a
   * deterministic rejection is a fact about the request (its size, its
   * costing's limits) and must not count towards the circuit breaker that
   * exists for outages, and it is the failure shape worth subdividing — the
   * same pairs asked for in smaller rectangles can succeed where the covering
   * request could not.
   */
  readonly deterministic: boolean;

  constructor(
    code: RoutingError['code'],
    message: string,
    options: { deterministic?: boolean; outOfCoverage?: boolean } = {},
  ) {
    super(message);
    this.name = 'RoutingError';
    this.code = code;
    this.outOfCoverage = options.outOfCoverage ?? false;
    this.deterministic = options.deterministic ?? false;
  }
}

/**
 * WHY A PAIR HAS NO MEASURED VALUE — A FACT ABOUT THE ROAD NETWORK, OR ABOUT
 * WHETHER THE PROVIDER COULD ANSWER RIGHT NOW.
 *
 * String-literal-compatible with `@sidequest/compiler`'s `ProviderGapReason`
 * (a superset) without importing it here — this module stays a plain HTTP
 * client with no dependency on the compiler package; `live.ts`, which already
 * imports that type, is where the two meet.
 *
 * `'not_found'` is the only value that means the router *answered*: Valhalla
 * returned a real response with a null time for this pair, which is positive
 * evidence the pair has no route, not an absence of an answer. Every other
 * value means the opposite — no trustworthy measurement was obtained, for a
 * reason about the provider or the request, never about the ground.
 */
export type ValhallaFailureReason =
  | 'not_found'
  | 'provider_error'
  | 'rate_limited'
  | 'budget_exhausted'
  | 'insufficient_evidence'
  /**
   * PRODUCTION LOCK V5 §18 — THIS ROUTER DOES NOT HOLD THIS PLACE.
   *
   * Valhalla's `error_code: 171` is "No suitable edges near location": there is
   * no road network at that coordinate *in the tiles this instance was built
   * with*. It is not "no route exists" and it is not a provider malfunction — it
   * is a statement about coverage, and it is the single most informative thing a
   * regional router can say.
   *
   * It used to be classified `provider_error`, which is why a live Hong Kong
   * build measured 0 of N legs: the configured router holds Iceland tiles, every
   * Hong Kong leg came back 171, nothing anywhere learned that the answer would
   * be the same for leg 34 as for leg 1, and the whole verification budget went
   * on requests that were refused before they were sent. `routing-composite.ts`
   * now learns from this reason and falls through.
   */
  | 'out_of_coverage';

function classifyRoutingFailure(error: unknown): ValhallaFailureReason {
  if (error instanceof RoutingError && error.code === 'rate_limited') return 'rate_limited';
  if (error instanceof RoutingError && error.outOfCoverage) return 'out_of_coverage';
  return 'provider_error';
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
  failedPairs: { from: string; to: string; reason: ValhallaFailureReason }[];
  /** `failedPairs` tallied by reason — the same breakdown a caller would otherwise recompute from the array every time it wants to observe one. */
  reasonCounts: Record<ValhallaFailureReason, number>;
  /** Whether the shared circuit breaker tripped during this run — a coarse "the provider stopped answering" signal, not per-pair. */
  circuitOpened: boolean;
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
 * minutes discovering what the third one already knew. Lowered from 4 to 3 as
 * part of the interactive SLO (see `MAX_TOTAL_MATRIX_MS`'s own comment) — an
 * outage should stop costing new requests sooner for a traveller waiting live.
 *
 * Reset by any success, so a single blip does not disable routing for the rest
 * of a build.
 */
const CIRCUIT_THRESHOLD = 3;

/**
 * Attempts per block, and the backoff between them.
 *
 * Two total — one retry — because the failures worth retrying are transient —
 * a rate limit or a dropped connection — and a second attempt against a
 * service that has already failed once is spending a traveller's patience
 * relearning what the first attempt established. Lowered from 3 (see
 * `MAX_TOTAL_MATRIX_MS`'s own comment); capped, so a retry storm cannot
 * multiply spend without a ceiling, and 429 never gets the *full* ladder
 * either — the circuit breaker, not repeated retrying, is what stops a
 * sustained rate limit.
 */
const MAX_ATTEMPTS = 2;
const BACKOFF_MS = [0, 1_000];

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
  /**
   * Attempts for *this* request. Subdivided children pass 1: their parent has
   * just established what the service does with a request of this shape, and a
   * smaller request is cheaper for the server, so re-running the full backoff
   * ladder per child would multiply wall-clock for nothing.
   */
  maxAttempts: number = MAX_ATTEMPTS,
): Promise<{ minutes: number[][]; km: number[][]; noRoute: boolean[][] }> {
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

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
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
        signal: requestSignal(REQUEST_TIMEOUT_MS),
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
       * worth another attempt. The rejection is marked deterministic: it is a
       * fact about this request, not about the service's health.
       */
      const deterministic = response.status < 500;
      /*
       * §18 — read the body of a deterministic rejection far enough to tell
       * "outside my tiles" from "bad request". Both are 400s and they call for
       * opposite responses: a malformed request is worth subdividing, and a
       * coverage refusal is worth abandoning this router for. Bounded by the
       * same response ceiling as a success, and failures to read it fall back
       * to the previous behaviour.
       */
      let outOfCoverage = false;
      if (deterministic) {
        try {
          const body = await response.text();
          if (body.length <= MAX_RESPONSE_BYTES) {
            const shape = routeResponseSchema.safeParse(JSON.parse(body));
            outOfCoverage = shape.success && shape.data.error_code !== undefined && OUT_OF_COVERAGE_ERROR_CODES.has(shape.data.error_code);
          }
        } catch {
          /* An unreadable rejection stays an ordinary deterministic rejection. */
        }
      }
      lastError = new RoutingError('request_failed', outOfCoverage ? 'The routing service does not cover these coordinates.' : 'The routing service did not answer.', {
        deterministic,
        outOfCoverage,
      });
      if (deterministic) break;
      continue;
    }

    text = await response.text();
    lastError = null;
    break;
  }

  if (lastError) {
    /*
     * Only an *unanswered* request is evidence the service has stopped
     * answering. A deterministic rejection used to count here, and the
     * consequence was wholesale: one request the service will never accept —
     * a pedestrian matrix with a beyond-limit pair in it — was retried across
     * consecutive blocks, tripped the breaker, and every block after it was
     * discarded unasked. The breaker exists for outages; a 400 is an answer.
     */
    if (circuit && !lastError.deterministic) {
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
  const noRoute = sources.map(() => new Array<boolean>(targets.length).fill(false));

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
    // different one from zero — and, unlike every other gap this function can
    // produce, positive evidence rather than an absence of one. Recorded so
    // the caller can tell "the router said no" from "the router never said".
    if (cell.time === null || cell.time === undefined) {
      noRoute[from]![to] = true;
      continue;
    }
    minutes[from]![to] = Math.round(cell.time / 60);
    km[from]![to] = cell.distance ?? Number.NaN;
  }

  return { minutes, km, noRoute };
}

const routeTripSchema = z.object({
  status: z.number(),
  status_message: z.string().optional(),
  summary: z.object({ time: z.number(), length: z.number() }).optional(),
  /**
   * `shape` is Valhalla's own polyline6-encoded geometry for one leg of the
   * trip — already present in every `/route` response by default (no extra
   * request parameter needed), previously parsed and discarded entirely.
   * `legs` rather than a single top-level shape because Valhalla's response
   * is per-leg even for the simple two-point, no-via-points request this
   * file ever makes (exactly one leg in that case).
   */
  legs: z.array(z.object({ shape: z.string().optional() })).optional(),
});

/**
 * DECODES VALHALLA'S POLYLINE6 SHAPE STRING INTO REAL COORDINATES.
 *
 * The standard polyline algorithm (delta-encoded, zigzag, base64-ish
 * character stream), at Valhalla's own precision: six decimal places
 * (`1e6`), not the five-decimal-place (`1e5`) precision the more common
 * Google polyline variant uses — using the wrong factor silently produces
 * coordinates off by roughly 10x, which is why this is its own function
 * rather than a borrowed one.
 */
export function decodePolyline6(encoded: string): { lat: number; lng: number }[] {
  const points: { lat: number; lng: number }[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  const factor = 1e6;

  while (index < encoded.length) {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = encoded.charCodeAt(index) - 63;
      index += 1;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += (result & 1) !== 0 ? ~(result >> 1) : result >> 1;

    result = 0;
    shift = 0;
    do {
      byte = encoded.charCodeAt(index) - 63;
      index += 1;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lng += (result & 1) !== 0 ? ~(result >> 1) : result >> 1;

    points.push({ lat: lat / factor, lng: lng / factor });
  }
  return points;
}

/** Every leg's shape, decoded and concatenated in order — real geometry for the whole trip, not just its first leg. `undefined` when nothing usable was present, never an empty-but-claimed array. */
function decodeTripGeometry(trip: z.infer<typeof routeTripSchema>): readonly { lat: number; lng: number }[] | undefined {
  const legs = trip.legs;
  if (!legs || legs.length === 0) return undefined;
  const points: { lat: number; lng: number }[] = [];
  for (const leg of legs) {
    if (!leg.shape) continue;
    points.push(...decodePolyline6(leg.shape));
  }
  return points.length > 0 ? points : undefined;
}

const routeResponseSchema = z.object({
  trip: routeTripSchema.optional(),
  error_code: z.number().optional(),
  error: z.string().optional(),
});

/** Valhalla's own documented error code for "no path could be found for input" — the one 4xx shape that is positive evidence, not merely a rejection. */
const NO_PATH_ERROR_CODE = 442;

/**
 * "No suitable edges near location" — the coordinate is outside this instance's
 * tiles. Positive evidence about the router's reach, not about the ground.
 *
 * 171 is the location-snapping failure; 170 ("Location is unreachable") is the
 * neighbouring case where a point snapped to an island of network the costing
 * cannot leave, which for a regional tile build means the same thing in practice.
 */
const OUT_OF_COVERAGE_ERROR_CODES = new Set([170, 171]);

export interface RouteResult {
  found: boolean;
  minutes: number | null;
  km: number | null;
  reason?: ValhallaFailureReason;
  /** The route's own real shape, decoded from Valhalla's polyline6 response — see `RouteConfirmationResult.geometry`'s own header (`packages/compiler/src/providers.ts`) for what this is for and why it costs no extra request. */
  geometry?: readonly { lat: number; lng: number }[];
}

/**
 * ONE POINT-TO-POINT ROUTE, DIRECTLY — THE BOUNDED FALLBACK A MATRIX RESULT
 * CANNOT BE TRUSTED ALONE FOR, ON A LEG A HARD FEASIBILITY DECISION DEPENDS ON.
 *
 * A live Iceland validation proved this is necessary: `/sources_to_targets`'s
 * `costmatrix` algorithm (what `computeMatrix` above uses) returned `null`
 * for two legs this exact `/route` endpoint measured successfully seconds
 * later, against the same healthy instance — a known characteristic of
 * matrix-style search on a small regional (non-planet) tile build, not a
 * flaw in the road data or evidence the leg is impossible.
 *
 * One request, one attempt, no retry ladder — this is a bounded fallback for
 * the rare leg that matters enough to ask again a different way, not a
 * second acquisition strategy, so it does not carry `fetchBlock`'s own
 * multi-attempt backoff. Still paced by the same shared `nextSlot()` gate,
 * so it never competes with a concurrent matrix build for the host's own
 * rate limit.
 */
export async function computeRoute(
  from: RoutePoint,
  to: RoutePoint,
  costing: ValhallaCosting,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<RouteResult> {
  await nextSlot();
  const doFetch = options.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await doFetch(`${routingEndpoint()}/route`, {
      method: 'POST',
      headers: {
        'user-agent': USER_AGENT,
        'x-client-id': 'sidequest-dev',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        locations: [
          { lat: from.lat, lon: from.lng },
          { lat: to.lat, lon: to.lng },
        ],
        costing,
        units: 'kilometers',
      }),
      signal: requestSignal(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return { found: false, minutes: null, km: null, reason: 'provider_error' };
  }

  if (response.status === 429) return { found: false, minutes: null, km: null, reason: 'rate_limited' };

  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) return { found: false, minutes: null, km: null, reason: 'provider_error' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { found: false, minutes: null, km: null, reason: 'provider_error' };
  }

  const result = routeResponseSchema.safeParse(parsed);
  if (!result.success) return { found: false, minutes: null, km: null, reason: 'provider_error' };

  if (!response.ok) {
    if (response.status === 400 && result.data.error_code === NO_PATH_ERROR_CODE) {
      return { found: false, minutes: null, km: null, reason: 'not_found' };
    }
    if (response.status === 400 && result.data.error_code !== undefined && OUT_OF_COVERAGE_ERROR_CODES.has(result.data.error_code)) {
      return { found: false, minutes: null, km: null, reason: 'out_of_coverage' };
    }
    return { found: false, minutes: null, km: null, reason: 'provider_error' };
  }

  const trip = result.data.trip;
  if (!trip || trip.status !== 0 || !trip.summary) {
    return { found: false, minutes: null, km: null, reason: 'provider_error' };
  }
  const geometry = decodeTripGeometry(trip);
  return {
    found: true,
    minutes: Math.round(trip.summary.time / 60),
    km: trip.summary.length,
    ...(geometry ? { geometry } : {}),
  };
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
  circuit: CircuitState | undefined,
  /** Epoch ms — see `MAX_TOTAL_MATRIX_MS`'s own comment. Checked, never extended, by every recursive step. */
  deadlineAt: number,
): Promise<{
  minutes: number[][];
  km: number[][];
  /** Per cell, why it has no measured value — `null` where it does, or where nothing has tried yet. */
  reason: (ValhallaFailureReason | null)[][];
  served: number;
  bought: number;
  calls: number;
  /** True when the block was skipped whole because its missing pairs cost too much. */
  overBudget: boolean;
}> {
  const minutes = sources.map(() => new Array<number>(targets.length).fill(Number.NaN));
  const km = sources.map(() => new Array<number>(targets.length).fill(Number.NaN));
  const reason: (ValhallaFailureReason | null)[][] = sources.map(() => new Array(targets.length).fill(null));

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
    return { minutes, km, reason, served, bought: 0, calls: 0, overBudget: false };
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
    return { minutes, km, reason, served, bought: 0, calls: 0, overBudget: true };
  }

  /**
   * A FAILED RECTANGLE DEGRADES BY SUBDIVISION, NEVER WHOLESALE.
   *
   * The API takes rectangles and answers or refuses them whole, and both of
   * its refusal shapes are about the *request*, not about every pair in it: a
   * costing's service limits reject a matrix containing one beyond-range pair
   * with a 4xx, and a pedestrian expansion over one far-out point can outgrow
   * the timeout that a smaller request sits comfortably inside. Treating
   * either as "these 400 pairs cannot be routed" is how one distant seat
   * poisoned a whole walkable metropolis: the foot matrix came back with
   * fewer than two points, the car retry succeeded, and a car-free traveller
   * was handed a driving matrix their planner rightly refused stop by stop —
   * eleven refusals, zero plan.
   *
   * So a failed rectangle is split into quadrants and each is asked for on
   * its own, recursively, to a bounded depth. The poisoned pairs isolate into
   * the smallest rectangles that still contain them — where they stay
   * honestly unmeasured (`NaN`, reported as failed pairs) for the transit
   * seam or the planner's per-stop refusal machinery — and every well-formed
   * sub-rectangle is measured and kept. Children spend real budget and are
   * counted; a child the remaining budget cannot cover is left unmeasured
   * rather than bought, so degradation never widens the spend ceiling. An
   * open circuit stops the recursion: an outage is not a shape subdivision
   * can fix.
   */
  const MAX_SUBDIVISION_DEPTH = 2;
  /**
   * How many *failed* requests one block may absorb before subdivision stops.
   *
   * The bound a pathological world needs: a request set the service rejects
   * entirely would otherwise walk all the way down to per-point probes for
   * every pair — hundreds of rate-limited calls to learn one fact many times.
   * Generous enough that a single poisoned point among twenty-five isolates
   * fully (its block, its quadrants, its rows and its own singletons come to a
   * few dozen failures at worst); once exceeded, the remaining rectangles stay
   * honestly unmeasured.
   */
  const MAX_FAILED_REQUESTS_PER_BLOCK = 48;
  let calls = 0;
  let spent = 0;
  let failedRequests = 0;

  const resolveRectangle = async (
    rowIndexes: readonly number[],
    colIndexes: readonly number[],
    depth: number,
  ): Promise<void> => {
    const cells = rowIndexes.length * colIndexes.length;
    if (cells === 0) return;
    if (circuit?.open) return; // an outage is not a shape subdivision can fix
    // The interactive SLO: once the whole matrix call's wall-clock budget is
    // spent, no further request is attempted, however few cells remain. This
    // is what actually bounds a degraded run — the pair budget alone did
    // not, since a request that keeps failing spends no pairs at all.
    if (Date.now() >= deadlineAt) return;
    if (spent + cells > budgetRemaining) return; // stays unmeasured, never overspends
    calls += 1;
    try {
      const fetched = await fetchBlock(
        rowIndexes.map((row) => sources[row]!),
        colIndexes.map((col) => targets[col]!),
        costing,
        options,
        circuit,
        depth === 0 ? MAX_ATTEMPTS : 1,
      );
      /*
       * Charged for what was *answered*. A failed request spends a call and a
       * rate-limit slot but no pair budget — charging failures was tried, and
       * one dead 400-pair request then starved the budget the subdivided
       * successes needed: a live build measured one quadrant, ran out of
       * ledger, and stored a ten-point matrix for a twenty-five point board.
       */
      spent += cells;
      for (let r = 0; r < rowIndexes.length; r += 1) {
        for (let c = 0; c < colIndexes.length; c += 1) {
          const row = rowIndexes[r]!;
          const col = colIndexes[c]!;
          if (fetched.noRoute[r]?.[c]) reason[row]![col] = 'not_found';
          const value = fetched.minutes[r]?.[c];
          const distance = fetched.km[r]?.[c];
          if (value === undefined || !Number.isFinite(value)) continue;
          minutes[row]![col] = value;
          km[row]![col] = distance ?? Number.NaN;
          options.cache?.write(matrixPairCacheKey(sources[row]!, targets[col]!, costing), {
            minutes: value,
            km: Number.isFinite(distance) ? (distance as number) : Number.NaN,
          });
        }
      }
    } catch (error) {
      failedRequests += 1;
      /*
       * A leaf's own reason is recorded before anything checks whether the
       * circuit is now open — including a circuit this very failure just
       * tripped. The classification is a fact about the attempt that was
       * just spent and already known; discarding it in favour of the
       * now-open circuit was reclassifying a real, specific `rate_limited`
       * (or any other) reason as the generic `'provider_error'` fallback
       * for no reason but ordering.
       */
      if (rowIndexes.length <= 1 && colIndexes.length <= 1) {
        reason[rowIndexes[0]!]![colIndexes[0]!] = classifyRoutingFailure(error);
        return;
      }
      if (circuit?.open) return;
      if (failedRequests > MAX_FAILED_REQUESTS_PER_BLOCK) return;
      /**
       * SUBDIVISION ISOLATES POINTS, NOT RECTANGLES.
       *
       * Quadrant halving to `MAX_SUBDIVISION_DEPTH`, then per-row probes, then
       * per-point probes — because a rectangle abandoned whole at max depth
       * kills its innocent pairs with it, and on a live build the far seat sat
       * at the head of the point order, so the abandoned rectangles covered
       * exactly the mutual legs of the board's top seats: the walkable anchors
       * lost their rows to a routing *shape* and were peeled as unroutable. At
       * the end of this ladder the only unmeasured pairs are the ones the
       * service genuinely refused one by one.
       */
      let parts: [readonly number[], readonly number[]][];
      if (depth < MAX_SUBDIVISION_DEPTH) {
        const rowHalf = Math.ceil(rowIndexes.length / 2);
        const colHalf = Math.ceil(colIndexes.length / 2);
        const rowHalves =
          rowIndexes.length > 1
            ? [rowIndexes.slice(0, rowHalf), rowIndexes.slice(rowHalf)]
            : [rowIndexes];
        const colHalves =
          colIndexes.length > 1
            ? [colIndexes.slice(0, colHalf), colIndexes.slice(colHalf)]
            : [colIndexes];
        parts = rowHalves.flatMap((rowsPart) =>
          colHalves.map((colsPart): [readonly number[], readonly number[]] => [rowsPart, colsPart]),
        );
      } else if (rowIndexes.length > 1) {
        parts = rowIndexes.map((row): [readonly number[], readonly number[]] => [
          [row],
          colIndexes,
        ]);
      } else {
        parts = colIndexes.map((col): [readonly number[], readonly number[]] => [
          rowIndexes,
          [col],
        ]);
      }
      for (const [rowsPart, colsPart] of parts) {
        await resolveRectangle(rowsPart, colsPart, depth + 1);
      }
    }
  };

  for (const group of groups) {
    await resolveRectangle(group.rows, group.cols, 0);
  }

  return { minutes, km, reason, served, bought: spent, calls, overBudget: false };
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
  const failedPairs: { from: string; to: string; reason: ValhallaFailureReason }[] = [];

  const blockSize = Math.max(1, Math.floor(Math.sqrt(MAX_MATRIX_PAIRS_PER_REQUEST)));
  const circuit = newCircuit();
  let calls = 0;
  let pairs = 0;
  let cacheHits = 0;
  /** Pairs actually charged to the router, which is what the budget bounds. */
  let bought = 0;
  /** The interactive SLO — see `MAX_TOTAL_MATRIX_MS`'s own comment. Fixed once, never extended by a slow block. */
  const deadlineAt = Date.now() + MAX_TOTAL_MATRIX_MS;

  for (let rowStart = 0; rowStart < size; rowStart += blockSize) {
    for (let colStart = 0; colStart < size; colStart += blockSize) {
      const sources = points.slice(rowStart, rowStart + blockSize);
      const targets = points.slice(colStart, colStart + blockSize);
      const cells = sources.length * targets.length;

      const markFailed = (reason: ValhallaFailureReason): void => {
        for (const source of sources) {
          for (const target of targets) {
            if (source.id !== target.id) failedPairs.push({ from: source.id, to: target.id, reason });
          }
        }
      };

      if (Date.now() >= deadlineAt) {
        // The whole matrix call's wall-clock budget is spent — every
        // remaining block stays honestly unmeasured, never attempted.
        markFailed('provider_error');
        continue;
      }

      try {
        const block = await resolveBlock(
          sources,
          targets,
          costing,
          options,
          options.maxPairs - bought,
          circuit,
          deadlineAt,
        );
        if (block.overBudget) {
          // Never attempted — the budget ran out before this block was asked
          // for, not evidence the provider said no. `'budget_exhausted'`, not
          // `'not_found'`.
          markFailed('budget_exhausted');
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
            // Plausibility is only a question for a *real* number — running
            // it over `NaN` (no answer at all) used to always fail it, which
            // is how a plain "no answer" nearly got mislabelled below as a
            // value we distrusted rather than one we never received.
            const implausible =
              value !== undefined &&
              Number.isFinite(value) &&
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
              if (fromId && toId && fromId !== toId) {
                // `block.reason` is the per-cell classification threaded up
                // from `resolveBlock`/`resolveRectangle`: `'not_found'` only
                // where Valhalla itself answered with a null time — checked
                // first, since it is positive evidence and must win even
                // though a `NaN` value also fails the finiteness check above.
                // A real value that failed the plausibility check is
                // evidence we chose not to trust, not an authoritative
                // no-route, hence `'insufficient_evidence'`. Anything left
                // unclassified (a rectangle abandoned after
                // `MAX_FAILED_REQUESTS_PER_BLOCK`) defaults to the generic,
                // conservative `'provider_error'` — a fact about this
                // attempt, never dressed up as a fact about the road network.
                const classified =
                  block.reason[row]?.[col] === 'not_found'
                    ? 'not_found'
                    : implausible
                      ? 'insufficient_evidence'
                      : (block.reason[row]?.[col] ?? 'provider_error');
                failedPairs.push({ from: fromId, to: toId, reason: classified });
              }
              continue;
            }
            minutes[from]![to] = value;
            km[from]![to] = distance ?? Number.NaN;
          }
        }
      } catch {
        markFailed('provider_error');
      }
    }
  }

  for (let index = 0; index < size; index += 1) {
    minutes[index]![index] = 0;
    km[index]![index] = 0;
  }

  const reasonCounts: Record<ValhallaFailureReason, number> = {
    not_found: 0,
    out_of_coverage: 0,
    provider_error: 0,
    rate_limited: 0,
    budget_exhausted: 0,
    insufficient_evidence: 0,
  };
  for (const pair of failedPairs) reasonCounts[pair.reason] += 1;

  return { ids, minutes, km, failedPairs, reasonCounts, circuitOpened: circuit.open, calls, pairs, cacheHits };
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
