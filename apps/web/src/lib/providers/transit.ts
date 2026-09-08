import 'server-only';
import { z } from 'zod';
import type { TransitJourney, TransitLeg, TransitLegMode } from '@sidequest/compiler';
import { nextRoutingSlot, routingEndpoint } from './valhalla';
import { USER_AGENT } from './nominatim';
import { requestSignal } from '../net/generation-deadline';

/**
 * PUBLIC TRANSPORT, MEASURED — AND THE ONE CHECK THAT MAKES IT HONEST.
 *
 * Valhalla routes multimodal journeys when the instance was built with GTFS
 * data, which makes it the right adapter for this product for the same reason
 * it is the right router: the durations are ODbL and are **ours to keep**. The
 * obvious alternative, Google Routes, genuinely supports transit and even
 * supports a transit *matrix* — and this repository's own re-checked terms note
 * records that Routes results may not be persisted at all beyond coordinates.
 * A compiled region outlives its request by weeks, so a duration we may not
 * store is a duration we cannot use.
 *
 * ── THE TRAP, AND WHY THE POST-FLIGHT CHECK IS NOT OPTIONAL ────────────────
 *
 * A Valhalla server with no transit tiles does not reject a multimodal request.
 * Under its default configuration it throws 170; with connectivity checking
 * disabled, or — far more importantly — on a server that *does* hold tiles for
 * one metro area but not for the pair being asked about, it returns **HTTP 200
 * and a pure walking route**. No error, no warning field, nothing in the
 * envelope that says the transit graph was not consulted. That is normal
 * operation for any real single-city deployment rather than an edge case.
 *
 * A walking duration returned under the name "multimodal" and stored as transit
 * evidence is precisely the substitution this whole capability exists to
 * prevent — the forty-kilometre bus journey rendering as a short walk, one
 * network standing in for another because the label said so.
 *
 * So every reply is checked *structurally*: a journey counts as measured only
 * if at least one maneuver reports `travel_mode: "transit"`. That check reads
 * the shape of the answer rather than the absence of an error, which is the only
 * form of detection a configuration change cannot defeat. Everything else — the
 * pre-flight, the error-code mapping — is an optimisation on top of it.
 *
 * Verified against Valhalla's own source and current documentation:
 * - the time-distance matrix **rejects** multimodal (error 140), so this asks
 *   for one journey at a time, which is also what the sparse contract wants;
 * - `date_time` is *not* required and silently defaults to departing now, so it
 *   is always set explicitly — a trip in October priced at today's timetable is
 *   wrong in a way nothing would report;
 * - fares are never returned, so no journey from here ever carries one.
 */

const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 2_000_000;
/** Valhalla's own guidance for the demo server. Also politeness anywhere. */
const MIN_INTERVAL_MS = 1_100;

/**
 * How far a traveller will walk to reach the network, and between changes.
 *
 * Valhalla's real defaults, read from its source rather than from its docs,
 * which transpose the first: 2415 m to and from the network, 805 m between
 * transfers. Restated here because both key spellings must be sent — the engine
 * parses them into two different fields and reads the deprecated one for the
 * actual cap.
 */
const START_END_MAX_METRES = 2_415;
const TRANSFER_MAX_METRES = 805;

/**
 * The matrix adapter's queue, not a second one.
 *
 * Both files talk to the same routing endpoint, and a private gate here meant
 * two schedulers each waiting their 1.1 seconds while between them doubling the
 * rate at which the host was being asked. Sharing the queue is the only way the
 * interval means what it says.
 */
const nextSlot = (): Promise<void> => nextRoutingSlot(MIN_INTERVAL_MS);

/**
 * WHAT EACH REFUSAL IS A STATEMENT ABOUT.
 *
 * The distinction this whole capability rests on is between a fact about the
 * *destination* ("no service runs between these two") and a fact about *us*
 * ("we could not measure it"), and the error code is the only thing that can
 * tell them apart. So each one is classified by what it actually means, read
 * from Valhalla's own published table rather than from its plausibility:
 *
 * - **170** — no transit tiles, or no connectivity between the two at the
 *   transit level. A fact about our instrument, and the definite one: this is
 *   what a server built without GTFS data always answers.
 * - **440** — "cannot reach destination, too far from a transit stop". A fact
 *   about the *place*: there is no stop within walking distance of it. That is
 *   a real answer a traveller can act on, and the only code here that is.
 * - **154** (max distance exceeded, a limit on our own instance), **171** (no
 *   suitable edges near the location — a snapping failure), **441**, **442**
 *   (generic no-path), and **155** and **156** (outside the walking allowance
 *   we ourselves configured) — all statements about our instrument or our
 *   configuration. None of them says anything about a timetable.
 *
 * An earlier version mapped 171 and 154 to `no_route`, which put the sentence
 * "No public transport runs between these two" on the artifact because a
 * viewpoint's coordinate sat four hundred metres from a routable way. Worse, it
 * was cached — so one snapping failure became a durable claim about somebody's
 * city.
 */
const NO_TILES_CODES = new Set([170]);
const NO_STOP_NEARBY_CODES = new Set([440]);

const maneuverSchema = z.object({
  travel_mode: z.string().optional(),
  time: z.number().optional(),
  length: z.number().optional(),
  transit_info: z
    .object({
      short_name: z.string().optional(),
      long_name: z.string().optional(),
      headsign: z.string().optional(),
      operator_name: z.string().optional(),
    })
    .optional(),
  travel_type: z.string().optional(),
});

const routeResponseSchema = z.object({
  trip: z
    .object({
      status: z.number().optional(),
      summary: z.object({ time: z.number().optional(), length: z.number().optional() }).optional(),
      units: z.string().optional(),
      legs: z.array(z.object({ maneuvers: z.array(maneuverSchema).optional() })).optional(),
    })
    .optional(),
  error_code: z.number().optional(),
  error: z.string().optional(),
});

const statusSchema = z.object({
  has_transit_tiles: z.boolean().optional(),
  version: z.string().optional(),
});

export interface TransitLookupOptions {
  fetchImpl?: typeof fetch;
  cache?: {
    read: (key: string) => TransitJourney | null;
    write: (key: string, value: TransitJourney) => void;
  };
  maxPairs: number;
  /**
   * An absolute instant, past which no further journey is asked for.
   *
   * Epoch milliseconds, never a duration — that unit confusion has already cost
   * this repository one non-functional acquisition path. What it buys is a
   * partial answer instead of no answer: the caller's outer race threw away
   * every journey already measured when the last one ran long, and billed the
   * calls behind them without recording the spend.
   */
  deadlineMs?: number;
}

/**
 * The cache key, bucketed by *when* rather than by an instant.
 *
 * A timetable answers the same for two requests a minute apart and differently
 * for a Sunday evening, so keying on an exact instant would never hit and
 * keying on nothing at all would serve a weekday number on a Sunday. The bucket
 * is a weekday class and an hour, taken **in the destination's own zone** — in
 * any other zone the boundary between Friday night and Saturday morning falls in
 * the wrong place, which is exactly where a timetable changes most.
 */
export function transitCacheKey(input: {
  from: { lat: number; lng: number };
  to: { lat: number; lng: number };
  departAt: Date;
  timeZone: string;
}): string {
  const point = (entry: { lat: number; lng: number }): string =>
    `${entry.lat.toFixed(4)},${entry.lng.toFixed(4)}`;
  return [
    'transit',
    'valhalla',
    'v1',
    routingEndpoint(),
    point(input.from),
    '->',
    point(input.to),
    departureBucket(input.departAt, input.timeZone),
  ].join('|');
}

export function departureBucket(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    hour12: false,
  }).formatToParts(instant);
  const weekday = parts.find((part) => part.type === 'weekday')?.value ?? 'Mon';
  const hour = parts.find((part) => part.type === 'hour')?.value ?? '12';
  /*
   * Three classes rather than seven days. A Tuesday and a Wednesday timetable
   * are the same timetable nearly everywhere; a Saturday and a Sunday are not,
   * and neither is either of them the same as a weekday.
   */
  const dayClass =
    weekday === 'Sat' ? 'saturday' : weekday === 'Sun' ? 'sunday' : 'weekday';
  return `${dayClass}-${hour}`;
}

/** Valhalla wants local wall-clock, not UTC. `YYYY-MM-DDTHH:MM` in the zone. */
export function localDateTimeValue(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(instant);
  const at = (type: string): string => parts.find((part) => part.type === type)?.value ?? '00';
  /*
   * `hourCycle` defaults can render midnight as `24`, which Valhalla rejects.
   * Normalised here rather than trusted to the formatter.
   */
  const hour = at('hour') === '24' ? '00' : at('hour');
  return `${at('year')}-${at('month')}-${at('day')}T${hour}:${at('minute')}`;
}

/**
 * Whether this deployment's router holds any transit data at all.
 *
 * A pre-flight rather than a guarantee. It reliably predicts the "no tiles"
 * refusal, and it cannot tell us whether tiles exist for the *particular* pair
 * being asked about — which is why it never replaces the per-journey check
 * below. Treated as unknown-and-therefore-unavailable when the field is absent,
 * because verbose status is itself a configuration option.
 */
export async function transitTilesAvailable(options: {
  fetchImpl?: typeof fetch;
}): Promise<boolean> {
  const doFetch = options.fetchImpl ?? fetch;
  try {
    const url = new URL(`${routingEndpoint()}/status`);
    url.searchParams.set('json', JSON.stringify({ verbose: true }));
    const response = await doFetch(url, {
      headers: { 'user-agent': USER_AGENT },
      signal: requestSignal(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return false;
    const parsed = statusSchema.safeParse(await response.json());
    return parsed.success && parsed.data.has_transit_tiles === true;
  } catch {
    return false;
  }
}

const LEG_MODE_BY_TRAVEL_TYPE: Record<string, TransitLegMode> = {
  tram: 'tram',
  metro: 'subway',
  rail: 'rail',
  bus: 'bus',
  ferry: 'ferry',
  cable_car: 'cable',
  gondola: 'cable',
  funicular: 'cable',
};

/**
 * Measure one journey per pair, cache first.
 *
 * Sequential rather than concurrent, deliberately: this talks to a rate-limited
 * routing service, and a burst of parallel requests is the behaviour those
 * services' policies name as abuse. The pair count is small by construction —
 * the whole point of sparse acquisition — so the wall-clock cost of politeness
 * is a few seconds rather than a design constraint.
 */
export async function measureTransitJourneys(
  pairs: readonly {
    fromId: string;
    toId: string;
    from: { lat: number; lng: number };
    to: { lat: number; lng: number };
  }[],
  context: { departAt: Date; timeZone: string },
  options: TransitLookupOptions,
): Promise<{
  journeys: TransitJourney[];
  calls: number;
  cacheHits: number;
  /** Whether the deadline stopped this short of the pairs it was given. */
  timedOut: boolean;
}> {
  const journeys: TransitJourney[] = [];
  let calls = 0;
  let cacheHits = 0;
  let timedOut = false;

  const requestBasis = {
    kind: 'depart_at' as const,
    instant: context.departAt.toISOString(),
    timeZone: context.timeZone,
  };

  for (const pair of pairs.slice(0, Math.max(0, options.maxPairs))) {
    const key = transitCacheKey({ from: pair.from, to: pair.to, ...context });
    const cached = options.cache?.read(key);
    if (cached) {
      cacheHits += 1;
      journeys.push({ ...cached, fromId: pair.fromId, toId: pair.toId });
      continue;
    }

    /*
     * Stop asking, and report what we have. Checked before the call rather than
     * after it so the deadline bounds the work rather than describing it.
     */
    if (options.deadlineMs !== undefined && Date.now() >= options.deadlineMs) {
      timedOut = true;
      break;
    }

    calls += 1;
    const journey = await measureOne(pair, context, requestBasis, options.fetchImpl ?? fetch);
    /*
     * ONLY AN ANSWER IS REMEMBERED.
     *
     * A provider error is a statement about a moment, and remembering it for a
     * fortnight would turn one bad afternoon into a durable claim. The same
     * argument applies to `out_of_coverage`, which is what a briefly tile-less
     * or misconfigured instance answers for *everything* — caching it would make
     * one bad deployment into two weeks of "this city has no trains". Only a
     * measured journey and a genuine no-stop-nearby answer are durable facts.
     */
    if (journey.status === 'measured' || journey.status === 'no_route') {
      options.cache?.write(key, journey);
    }
    journeys.push(journey);
  }

  return { journeys, calls, cacheHits, timedOut };
}

async function measureOne(
  pair: {
    fromId: string;
    toId: string;
    from: { lat: number; lng: number };
    to: { lat: number; lng: number };
  },
  context: { departAt: Date; timeZone: string },
  requestBasis: TransitJourney['requestBasis'],
  doFetch: typeof fetch,
): Promise<TransitJourney> {
  const base = {
    fromId: pair.fromId,
    toId: pair.toId,
    requestBasis,
    source: 'valhalla-multimodal',
    retrievedAt: new Date().toISOString(),
  };

  const body = {
    locations: [
      { lat: pair.from.lat, lon: pair.from.lng },
      { lat: pair.to.lat, lon: pair.to.lng },
    ],
    costing: 'multimodal',
    costing_options: {
      pedestrian: {
        /*
         * Both spellings, same value. The engine parses them into two different
         * fields and reads the deprecated one for the cap that actually applies,
         * so sending only the current name silently leaves the default in place.
         */
        transit_start_end_max_distance: START_END_MAX_METRES,
        multimodal_start_end_max_distance: START_END_MAX_METRES,
        transit_transfer_max_distance: TRANSFER_MAX_METRES,
      },
    },
    /*
     * Type 1 is "depart at". Omitting this block is not an error — the engine
     * quietly substitutes *now*, which would price an October trip against
     * today's timetable and report nothing unusual.
     */
    date_time: { type: 1, value: localDateTimeValue(context.departAt, context.timeZone) },
    units: 'kilometers',
    id: 'sidequest-transit',
  };

  await nextSlot();
  let response: Response;
  try {
    response = await doFetch(`${routingEndpoint()}/route`, {
      method: 'POST',
      headers: {
        'user-agent': USER_AGENT,
        'x-client-id': 'sidequest-dev',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: requestSignal(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return {
      ...base,
      status: 'provider_error',
      detail: 'The journey planner did not answer.',
    };
  }

  /*
   * The declared length first, so an oversized body is refused before it is read
   * into memory. The check after `text()` is kept as the backstop for a response
   * that declares nothing, which is the case a streaming server produces.
   */
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    return {
      ...base,
      status: 'provider_error',
      detail: 'The journey planner returned more than we will read.',
    };
  }
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) {
    return {
      ...base,
      status: 'provider_error',
      detail: 'The journey planner returned more than we will read.',
    };
  }

  let parsed: z.infer<typeof routeResponseSchema>;
  try {
    parsed = routeResponseSchema.parse(JSON.parse(text));
  } catch {
    return {
      ...base,
      status: 'provider_error',
      detail: 'The journey planner returned a shape we cannot read.',
    };
  }

  if (!response.ok || parsed.error_code !== undefined) {
    const code = parsed.error_code ?? 0;
    if (NO_TILES_CODES.has(code)) {
      return {
        ...base,
        status: 'out_of_coverage',
        detail: 'We hold no public-transport timetables for this area.',
      };
    }
    if (NO_STOP_NEARBY_CODES.has(code)) {
      return {
        ...base,
        status: 'no_route',
        detail: 'There is no public-transport stop within walking distance of this one.',
      };
    }
    /*
     * Everything else is our instrument, not their timetable. That includes the
     * generic no-path refusal: with transit data present it *might* mean no
     * service connects the two, and it might equally mean a coordinate could not
     * be snapped or one of our own distance limits bit. We cannot tell, so we do
     * not claim.
     */
    return {
      ...base,
      status: 'provider_error',
      detail: 'The journey planner could not answer for this one.',
    };
  }

  const maneuvers = (parsed.trip?.legs ?? []).flatMap((leg) => leg.maneuvers ?? []);
  const transitManeuvers = maneuvers.filter(
    (maneuver) => maneuver.travel_mode === 'transit' && maneuver.transit_info !== undefined,
  );

  /**
   * THE CHECK THE WHOLE FILE EXISTS FOR.
   *
   * A 200 with no transit maneuver in it is a walking route wearing the word
   * "multimodal". It happens on any server whose tiles do not cover this pair,
   * which on a real deployment is most of the world, and there is nothing in the
   * envelope that says so — the duration looks like every other duration.
   *
   * Refused rather than downgraded to a walking answer, because the caller asked
   * "how long by public transport" and the honest reply to that is not "here is
   * how long on foot". The walking network is measured elsewhere and is already
   * on the artifact.
   */
  if (transitManeuvers.length === 0) {
    return {
      ...base,
      status: 'out_of_coverage',
      detail:
        'The journey planner could only offer a walk here, which means it holds no timetables for this route.',
    };
  }

  const totalSeconds = parsed.trip?.summary?.time;
  if (typeof totalSeconds !== 'number' || !Number.isFinite(totalSeconds) || totalSeconds < 0) {
    return {
      ...base,
      status: 'provider_error',
      detail: 'The journey planner answered without a usable duration.',
    };
  }

  const legs: TransitLeg[] = maneuvers
    .filter((maneuver) => typeof maneuver.time === 'number' && maneuver.time > 0)
    .map((maneuver) => {
      const isTransit = maneuver.travel_mode === 'transit';
      const mode: TransitLegMode = isTransit
        ? (LEG_MODE_BY_TRAVEL_TYPE[maneuver.travel_type ?? ''] ?? 'other')
        : 'walk';
      /*
       * The line's own name, verbatim or not at all. A plausible-sounding line
       * name is the easiest thing on this interface to invent and the most
       * damaging: somebody stands on a platform looking for it.
       */
      const line = isTransit
        ? (maneuver.transit_info?.short_name ?? maneuver.transit_info?.long_name)
        : undefined;
      return {
        mode,
        minutes: Math.round((maneuver.time ?? 0) / 60),
        ...(line ? { line } : {}),
      };
    });

  const walkingMinutes = legs
    .filter((leg) => leg.mode === 'walk')
    .reduce((total, leg) => total + leg.minutes, 0);

  const km = parsed.trip?.summary?.length;

  return {
    ...base,
    status: 'measured',
    minutes: Math.round(totalSeconds / 60),
    ...(typeof km === 'number' && Number.isFinite(km) && km >= 0 ? { km } : {}),
    /* One vehicle is zero changes. `transfers` counts changes, not rides. */
    transfers: Math.max(0, transitManeuvers.length - 1),
    walkingMinutes,
    legs,
    /*
     * No fare. Valhalla does not return one, and an estimate is not a fare —
     * a traveller budgets against this.
     */
    detail: 'Measured against published timetables.',
  };
}
