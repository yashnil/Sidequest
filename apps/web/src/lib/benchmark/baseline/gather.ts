import 'server-only';
import { parseOsmOpeningHours, solarEventsFor, utcOffsetMinutesOn } from '@sidequest/core';
import type { OperatingPeriod } from '@sidequest/core';
import type { BenchmarkTripRequest } from '@sidequest/bench';
import { USER_AGENT } from '../../providers/nominatim';
import {
  buildQuery,
  clampBoundingBox,
  fetchFoodPois,
  fetchPois,
  normalizeElement,
  overpassEndpoints,
  type BoundingBox,
  type NormalizedOsmPlace,
} from '../../providers/overpass';
import { MAX_MATRIX_PAIRS_PER_REQUEST, computeMatrix, costingFor } from '../../providers/valhalla';
import { resolveTripWeather } from '../../weather';
import {
  PACKET_CAPS,
  type PacketAccess,
  type PacketDaylight,
  type PacketDestination,
  type PacketFood,
  type PacketGap,
  type PacketHours,
  type PacketPlace,
  type PacketSeasonal,
  type PacketWeather,
  type ResearchPacket,
} from './packet-types';
import {
  buildResearchPacket,
  straightLineKm,
  type PacketInputs,
  type RawBaseCandidate,
  type RawDay,
  type RawPlace,
  type RawRouteLeg,
} from './packet';

/**
 * BUYING THE WORLD, ONCE, WITH A CEILING ON EVERYTHING.
 *
 * The only module in this arm that opens a socket. Everything downstream — the
 * packet, the scan, the questions, the conversion — is a pure function over what
 * this returns, which is what lets the offline suite exercise the whole flow
 * with no network and no key.
 *
 * Two deliberate limitations, each of which makes the baseline weaker than it
 * could be and each of which is preferable to the alternative.
 *
 * **Opening hours are read by a parser that refuses what it cannot model.**
 * OpenStreetMap's `opening_hours` is a small grammar and a half-correct parser is
 * worse than none — a place wrongly believed open at nine is a traveller standing
 * at a locked gate. The shared parser is exactly that: it reads the shapes that
 * make up the bulk of real values and returns nothing at all for anything else,
 * which becomes `unknown` here. It is a grammar rather than a planner, and "hours
 * and access" is a provider boundary this arm is permitted to use; what it may
 * not use is the candidate selector, the scheduler, the route clusterer and the
 * revision engine. Reading `24/7` and nothing else was a self-imposed
 * disadvantage on the most visible axis a reviewer looks at.
 *
 * **The route matrix covers a bounded subset.** A full matrix over a hundred and
 * forty places is nineteen thousand pairs, which is minutes of somebody else's
 * routing service for a benchmark that is supposed to answer in under a minute.
 * A bounded subset is measured, and every unmeasured pair is honestly unknown
 * rather than estimated from a straight line. The subset is drawn from the
 * places that *survive the packet's cap*, in a round robin across the proximity
 * clusters — see `matrixSample`. Sampling the raw pre-cap list instead measured
 * mostly places the packet then dropped, and a leg whose endpoints are not in
 * the inventory is discarded on the way in: the run paid a routing service for a
 * matrix the plan could not address, and nearly every journey it scheduled came
 * out `minutes: null`.
 *
 * Seasonal reachability and somewhere to sleep are read from the map rather than
 * left blank, because both were reported as unknown for every place in every
 * region — which made a whole class of feasibility check, and a follow-up
 * question the traveller can only answer once, permanently unreachable. Both are
 * still evidence rather than judgement: `seasonal=*` is what the source says,
 * `place=town` is the map's own classification, and neither ranks anything or
 * decides where a night is spent. That decision is one of the things under test.
 */

export interface GatherCounters {
  providerCalls: number;
  routeCalls: number;
  routePairs: number;
  weatherCalls: number;
}

export interface GatherResult {
  inputs: PacketInputs;
  counters: GatherCounters;
}

/**
 * How many places the routing engine is asked about.
 *
 * Raised from 24. At twelve proximity clusters, twenty-four points is two places
 * per cluster — one intra-cluster pair each — so a day of four stops inside one
 * cluster had at most one of its three legs measured, and the rest converted to
 * an honest but useless `unknown`. The other arm routes *after* choosing its
 * stops, so nearly every leg it schedules is measured; this one has to route
 * before the model chooses, and the gap showed up as one plan rendering times
 * throughout and the other saying "unknown" on most legs.
 *
 * 40² is 1,560 ordered pairs, which the packet's own leg cap is raised to match.
 * Still one bounded request batch, still every unmeasured pair honestly unknown.
 */
export const MATRIX_POINT_LIMIT = 40;

/**
 * The absolute ceiling on how far the packet looks, whatever anybody stated.
 *
 * Two hundred and twenty kilometres, which is the reach the deterministic arm
 * plans regions at — so a traveller willing to drive all day is shown a region
 * of comparable size in both arms rather than a third of one in this one. The
 * provider clamps the bounding box again on its own terms; this is the point
 * past which asking for more buys a refusal rather than more places.
 */
export const MAX_RADIUS_KM = 220;

const OSM_HOST = 'openstreetmap.org';

/**
 * How wide to look, derived from what the traveller said rather than from the
 * destination's name.
 *
 * A traveller who will drive two hours a day is shown a wider region than one
 * who will walk, and the same destination string therefore produces different
 * packets for different people — which is correct, and is the opposite of a
 * lookup table keyed by place.
 *
 * The geocoder's own extent may only *widen* this. It used to cap it, and that
 * inverted the whole point: the shared identity the harness hands both arms
 * carries no bounding box at all, so `radiusKm` is null on every benchmarked
 * run, the fallback stood in for it, and a traveller who said they would drive
 * ten hours a day was shown a forty-kilometre region regardless. A geocoder box
 * is evidence that a *named* place is at least that big — a country, a national
 * park — and is no evidence at all that a traveller's stated reach is smaller.
 */
export function searchRadiusKm(
  request: BenchmarkTripRequest,
  destination: PacketDestination,
): number {
  const perDayMinutes = request.movement.carAvailable
    ? request.movement.maxDailyDriveMinutes
    : request.movement.maxDailyTravelMinutes;
  // Half the daily allowance out and half back, at speeds that are deliberately
  // conservative: a radius that is too small loses places, and one that is too
  // large buys a bounding box the provider will refuse.
  const kmPerMinute = request.movement.carAvailable ? 0.8 : 0.25;
  const fromTraveller = (perDayMinutes / 2) * kmPerMinute;
  const fromGeocoder = destination.radiusKm ?? 0;
  return Math.min(MAX_RADIUS_KM, Math.max(5, fromTraveller, fromGeocoder));
}

export function boundingBoxFor(
  destination: PacketDestination,
  radiusKm: number,
): BoundingBox {
  const latDelta = radiusKm / 111;
  const lngDelta =
    radiusKm / (111 * Math.max(0.1, Math.cos((destination.latitude * Math.PI) / 180)));
  return {
    south: destination.latitude - latDelta,
    north: destination.latitude + latDelta,
    west: destination.longitude - lngDelta,
    east: destination.longitude + lngDelta,
  };
}

export interface GatherInput {
  request: BenchmarkTripRequest;
  destination: PacketDestination;
  dates: readonly string[];
  now: Date;
  sessionId: string;
}

export async function gatherPacketInputs(input: GatherInput): Promise<GatherResult> {
  const counters: GatherCounters = {
    providerCalls: 0,
    routeCalls: 0,
    routePairs: 0,
    weatherCalls: 0,
  };
  const gaps: PacketGap[] = [];
  const unknowns: string[] = [];

  const radiusKm = searchRadiusKm(input.request, input.destination);
  const box = boundingBoxFor(input.destination, radiusKm);

  const timeZone = await resolveTimeZone(input.destination, counters);
  if (timeZone === null) {
    gaps.push({
      kind: 'provider_unavailable',
      subject: 'time zone',
      detail: 'Nothing could establish the local time zone, so no sunrise or sunset was computed.',
    });
    unknowns.push('The local time zone could not be established, so daylight is unknown.');
  }

  const tripMonths = tripMonthsOf(input.dates);
  const places = await gatherPlaces(box, tripMonths, input.dates, gaps, counters);
  const baseCandidates = await gatherBaseCandidates(box, input.destination, gaps, counters);
  const days = await gatherDays({
    destination: input.destination,
    dates: input.dates,
    timeZone,
    now: input.now,
    sessionId: input.sessionId,
    gaps,
    unknowns,
    counters,
  });

  /*
   * The packet is assembled once before the routing engine is asked anything.
   *
   * It is the only way to know which places survive the cap and which proximity
   * cluster each of them lands in, and both facts decide what is worth
   * measuring: a leg between two places the packet will not hold is discarded
   * on the way back in, and a leg between two places in different clusters is
   * one no day is likely to make. The build is pure and deterministic, so doing
   * it twice costs arithmetic and changes nothing.
   */
  const provisional = buildResearchPacket({
    destination: input.destination,
    days,
    places,
    baseCandidates,
    routeLegs: [],
    gaps: [],
    unknowns: [],
  });
  const routeLegs = await gatherRoutes(input.request, provisional, gaps, counters);

  return {
    counters,
    inputs: {
      destination: input.destination,
      days,
      places,
      baseCandidates,
      routeLegs,
      gaps: [
        ...gaps,
        {
          kind: 'not_requested',
          subject: 'region width',
          detail: `Places were sought within about ${Math.round(radiusKm)} km of the destination, sized from the traveller's own daily travel limit.`,
        },
      ],
      unknowns,
    },
  };
}

/** The calendar months the trip touches, which is what `seasonal` is read against. */
export function tripMonthsOf(dates: readonly string[]): Set<number> {
  const months = new Set<number>();
  for (const date of dates) {
    const month = Number(date.slice(5, 7));
    if (Number.isInteger(month) && month >= 1 && month <= 12) months.add(month);
  }
  return months;
}

/* ------------------------------------------------------------------ *
 * Places
 * ------------------------------------------------------------------ */

async function gatherPlaces(
  box: BoundingBox,
  tripMonths: ReadonlySet<number>,
  dates: readonly string[],
  gaps: PacketGap[],
  counters: GatherCounters,
): Promise<RawPlace[]> {
  const places: RawPlace[] = [];

  try {
    const result = await fetchPois(box, { limit: 300 });
    counters.providerCalls += result.calls;
    for (const element of result.elements) {
      const normalized = normalizeElement(element);
      if (normalized) places.push(toRawPlace(normalized, null, tripMonths, dates));
    }
    for (const group of result.failedGroups) {
      gaps.push({
        kind: 'provider_unavailable',
        subject: 'places',
        detail: `The place service refused the "${group}" group, so those places are missing.`,
      });
    }
  } catch {
    gaps.push({
      kind: 'provider_unavailable',
      subject: 'places',
      detail: 'The place service did not answer, so no attractions could be listed.',
    });
  }

  try {
    const result = await fetchFoodPois(box, { limit: 200 });
    counters.providerCalls += result.calls;
    for (const element of result.elements) {
      const normalized = normalizeElement(element);
      if (normalized) places.push(toRawPlace(normalized, foodFacts(normalized), tripMonths, dates));
    }
  } catch {
    gaps.push({
      kind: 'provider_unavailable',
      subject: 'food venues',
      detail: 'The place service did not answer for eating places, so none could be listed.',
    });
  }

  return places;
}

function toRawPlace(
  place: NormalizedOsmPlace,
  food: PacketFood | null,
  tripMonths: ReadonlySet<number>,
  dates: readonly string[],
): RawPlace {
  return {
    entityId: place.elementId,
    name: place.name,
    latitude: place.coordinates.lat,
    longitude: place.coordinates.lng,
    kind: place.primaryTag,
    tags: tagsFor(place),
    /*
     * Nobody publishes how long a visit takes, and this arm is not allowed to
     * borrow the classifier that guesses it. So it is null — and the plan is
     * told to schedule from judgement rather than from a duration it was handed.
     */
    typicalDurationMinutes: null,
    daylightOnly: null,
    hours: hoursFor(place, dates),
    seasonal: seasonalFor(place, tripMonths),
    access: accessFor(place),
    food,
    source: {
      host: OSM_HOST,
      title: place.name,
      url: place.url,
      retrievedAt: place.sourceTimestamp ?? null,
    },
  };
}

/**
 * WHAT THE SOURCE SAYS, READ BY THE PARSER THAT REFUSES WHAT IT CANNOT MODEL.
 *
 * This was `24/7` and nothing else, on the argument that a half-correct parser
 * is worse than none and that hours handling is one of the things being
 * compared. The first half is right and the second was wrong twice over.
 *
 * The repository already holds a *conservative, refusing* parser — its own header
 * says it reads the shapes that make up the overwhelming majority of real values
 * and refuses everything else, returning `null` for anything it cannot fully
 * model. That is exactly the artifact this comment said it wanted and could not
 * have. And "hours and access" is named in the goal as a provider boundary this
 * arm may use: what it may not use is the candidate selector, the scheduler, the
 * route clusterer and the revision engine, none of which this is. It is a
 * grammar, not a planner.
 *
 * The cost of leaving it out was one-sided and landed on the most visible axis a
 * reviewer looks at. On any European city the other arm parses `Tu-Su 10:00-18:00;
 * Mo off` and schedules around the Monday closure; this arm saw `unknown` for
 * every place, was forbidden by its own honesty rules from stating an hour, and
 * rendered "hours unknown" on every block. Neither was penalised by the checker,
 * because the checker reads the same record — so the whole difference reached the
 * human, as a straw man.
 *
 * Anything the parser declines is still `unknown`. Nothing here guesses.
 */
export function hoursFor(place: NormalizedOsmPlace, dates: readonly string[]): PacketHours {
  const stated = place.planningTags.opening_hours?.trim();
  if (!stated) return { state: 'unknown' };
  if (stated === '24/7') return { state: 'always_open' };

  const parsed = parseOsmOpeningHours(stated);
  if (parsed === null) return { state: 'unknown' };
  if (parsed.kind === 'always_open') return { state: 'always_open' };

  /*
   * Resolved onto the trip's own dates, because that is the shape the packet and
   * the shared checker both speak: a window per date, and the dates it is shut.
   */
  const windows: { date: string; openMinute: number; closeMinute: number }[] = [];
  const closedDates: string[] = [];
  for (const date of dates) {
    const day = openOn(parsed.periods, date);
    if (day.length === 0) {
      closedDates.push(date);
      continue;
    }
    for (const window of day) {
      windows.push({ date, openMinute: window.openMinute, closeMinute: window.closeMinute });
    }
  }

  // Every date shut is a refusal to state hours rather than a claim the place is
  // permanently closed: the expression may simply not cover these months.
  if (windows.length === 0) return { state: 'unknown' };
  return { state: 'known', windows, closedDates, sourceIndex: null };
}

/** The windows an expression gives one date, or none when it is shut that day. */
function openOn(
  periods: readonly OperatingPeriod[],
  date: string,
): readonly { openMinute: number; closeMinute: number }[] {
  const parsedDate = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsedDate.getTime())) return [];
  const month = parsedDate.getUTCMonth() + 1;
  const weekday = parsedDate.getUTCDay();

  for (const period of periods) {
    if (!period.months.includes(month as (typeof period.months)[number])) continue;
    if (period.daysOfWeek && !period.daysOfWeek.includes(weekday as (typeof period.daysOfWeek)[number])) {
      continue;
    }
    return period.windows;
  }
  return [];
}

/* ------------------------------------------------------------------ *
 * Season
 * ------------------------------------------------------------------ */

const MONTH_NAMES = [
  'jan',
  'feb',
  'mar',
  'apr',
  'may',
  'jun',
  'jul',
  'aug',
  'sep',
  'oct',
  'nov',
  'dec',
] as const;

/**
 * Which months a season word covers, on the hemisphere the place sits in.
 *
 * The hemisphere is read off the latitude rather than assumed, because a hut
 * tagged `seasonal=summer` in Patagonia is shut in July and open in January, and
 * a table that quietly meant "the northern summer" would have told a traveller
 * the opposite of the truth for half the world.
 */
function monthsOfSeason(season: string, latitude: number): Set<number> | null {
  const northern: Record<string, readonly number[]> = {
    spring: [3, 4, 5],
    summer: [6, 7, 8],
    autumn: [9, 10, 11],
    fall: [9, 10, 11],
    winter: [12, 1, 2],
  };
  const months = northern[season];
  if (!months) return null;
  const shift = latitude < 0 ? 6 : 0;
  return new Set(months.map((month) => ((month - 1 + shift) % 12) + 1));
}

/**
 * A month range, read only when the whole string is one.
 *
 * `Apr-Oct` is a complete statement about a season. `Apr-Oct 09:00-17:00` is an
 * opening-hours expression that happens to begin with one, and reading half of
 * it would be the partial parser this module refuses to write elsewhere — so
 * anything with a digit, a weekday or a second clause is left alone.
 */
function monthsOfRange(value: string): Set<number> | null {
  const match = /^([a-z]{3})\s*-\s*([a-z]{3})$/.exec(value.trim());
  if (!match) return null;
  const from = MONTH_NAMES.indexOf((match[1] ?? '') as (typeof MONTH_NAMES)[number]);
  const to = MONTH_NAMES.indexOf((match[2] ?? '') as (typeof MONTH_NAMES)[number]);
  if (from < 0 || to < 0) return null;
  const months = new Set<number>();
  // Inclusive and wrapping, so `Nov-Mar` is the winter it says it is rather
  // than an empty set.
  for (let step = 0; step < 12; step += 1) {
    const month = ((from + step) % 12) + 1;
    months.add(month);
    if ((from + step) % 12 === to) break;
  }
  return months;
}

/**
 * Whether the map says this place is reachable in the trip's own months.
 *
 * Populated from what the source states and from nothing else. `seasonal=no` is
 * a positive claim that a place is there all year and is recorded as one;
 * `seasonal=yes` says a place is seasonal without saying which season, which is
 * not enough to place the trip inside or outside it and therefore stays
 * unknown. A range that covers every month of the trip is open, one that covers
 * none of them is closed with the reason written out, and a range covering some
 * of them stays unknown because the packet cannot say which days.
 *
 * Left `unknown` for everything else, which is still most places. The point is
 * not coverage: it is that `closed_in_season` became reachable at all, and with
 * it the seasonal feasibility risk, the follow-up question about shifting the
 * dates, and the shared checker's own seasonal ground truth — none of which
 * could ever fire while every place in every region was recorded as unknown.
 */
export function seasonalFor(
  place: NormalizedOsmPlace,
  tripMonths: ReadonlySet<number>,
): PacketSeasonal {
  const stated = place.planningTags.seasonal?.trim().toLowerCase();
  if (stated === 'no') return { state: 'open_in_season' };

  /*
   * A bare month range in `opening_hours` is a statement about the season
   * rather than about the clock, and is the other way this fact is published.
   * Only the bare form is read; see `monthsOfRange`.
   */
  const fromHours = monthsOfRange((place.planningTags.opening_hours ?? '').toLowerCase());
  const openMonths =
    stated === undefined
      ? fromHours
      : monthsOfRange(stated) ?? monthsOfSeason(stated, place.coordinates.lat) ?? fromHours;

  if (!openMonths || tripMonths.size === 0) return { state: 'unknown' };

  const inside = [...tripMonths].filter((month) => openMonths.has(month));
  if (inside.length === tripMonths.size) return { state: 'open_in_season' };
  if (inside.length > 0) return { state: 'unknown' };
  return {
    state: 'closed_in_season',
    note: 'The map data records this as seasonal, and the season it names does not include the months of this trip.',
  };
}

function accessFor(place: NormalizedOsmPlace): PacketAccess {
  const wheelchairTag = place.planningTags.wheelchair;
  const wheelchair: PacketAccess['wheelchair'] =
    wheelchairTag === 'yes'
      ? 'yes'
      : wheelchairTag === 'limited'
        ? 'limited'
        : wheelchairTag === 'no'
          ? 'no'
          : 'unknown';
  const fee = place.planningTags.fee;
  return {
    // Every one of these is `null` rather than `false`, because "no source says
    // this needs a car" and "a source says it does not" are different claims and
    // only one of them is true here.
    requiresCar: null,
    unpavedApproach: null,
    remoteNoServices: null,
    strenuous: null,
    wheelchair,
    feeStated: fee === undefined ? null : fee !== 'no',
  };
}

function foodFacts(place: NormalizedOsmPlace): PacketFood {
  const dietaryTags: string[] = [];
  for (const [key, value] of Object.entries(place.planningTags)) {
    if (key.startsWith('diet:') && (value === 'yes' || value === 'only')) {
      dietaryTags.push(key.slice('diet:'.length));
    }
  }
  return {
    /*
     * Empty, and deliberately so. A venue tagged `amenity=restaurant` has not
     * told anybody which meals it serves, and inferring "lunch and dinner" from
     * the word restaurant is exactly the class of confident guess the plan is
     * forbidden from making elsewhere.
     */
    servesSlots: [],
    dietaryTags: dietaryTags.sort(),
    cuisine: place.planningTags.cuisine ?? null,
    cannotAccommodate: [],
  };
}

function tagsFor(place: NormalizedOsmPlace): string[] {
  const tags = new Set<string>([place.primaryTag]);
  const [key, value] = place.primaryTag.split('=');
  if (key) tags.add(key);
  if (value) tags.add(value);
  return [...tags].sort();
}

/* ------------------------------------------------------------------ *
 * Somewhere to sleep
 * ------------------------------------------------------------------ */

/**
 * The settlement classes worth offering as somewhere to spend a night.
 *
 * A hamlet is the smallest thing worth naming as a base, so `isolated_dwelling`
 * and `farm` are left out — and `suburb` and `neighbourhood` with them, because
 * they would fill a city's list with other names for the city.
 */
const SETTLEMENT_SELECTOR: { key: string; values: string[]; intent: string } = {
  key: 'place',
  values: ['city', 'town', 'village', 'hamlet'],
  intent: 'settlement',
};

/** How many settlements the query asks for before anything is cut. */
const SETTLEMENT_QUERY_LIMIT = 60;

/**
 * Names of places a traveller could sleep in, which the packet used to hold
 * exactly one of.
 *
 * The destination itself was the whole list, while the traveller's own request
 * may ask for as many as eight bases and a follow-up rule asks whether they
 * would move to a second one — so the plan was being asked to name somewhere the
 * packet could not. The model may still propose a town of its own and the
 * conversion records that honestly with `entityId: null`; what changed is that
 * it no longer has to.
 *
 * One extra request to the same map service, on the same bounding box, counted
 * in the same provider budget. A failure here is a gap rather than a run
 * failure: a trip with one base candidate is a poorer trip and is still a trip.
 */
async function gatherBaseCandidates(
  box: BoundingBox,
  destination: PacketDestination,
  gaps: PacketGap[],
  counters: GatherCounters,
): Promise<RawBaseCandidate[]> {
  const here: RawBaseCandidate = {
    entityId: null,
    name: destination.displayName,
    latitude: destination.latitude,
    longitude: destination.longitude,
    basis: 'The destination the traveller named, as resolved by the geocoder.',
  };

  let settlements: RawBaseCandidate[];
  try {
    settlements = await fetchSettlements(box, destination, counters);
  } catch {
    gaps.push({
      kind: 'provider_unavailable',
      subject: 'settlements to sleep in',
      detail:
        'The map service did not answer for settlements, so the packet vouches for the destination alone.',
    });
    return [here];
  }

  if (settlements.length === 0) {
    gaps.push({
      kind: 'no_dataset',
      subject: 'settlements to sleep in',
      detail: 'The map data lists no settlement in this region beyond the destination itself.',
    });
    return [here];
  }

  /*
   * Cut to the packet's cap here rather than leaving it to the alphabetical
   * slice downstream, which would keep whichever names begin with an A.
   *
   * The order is the map's own settlement class first and then distance from
   * the destination — the provider's classification and plain geometry, neither
   * of which is a judgement about where is nice to stay. That judgement is one
   * of the things under test and is left to the plan.
   */
  const keep = PACKET_CAPS.baseCandidates - 1;
  const chosen = settlements.slice(0, keep);
  if (settlements.length > chosen.length) {
    gaps.push({
      kind: 'capped_by_count',
      subject: 'settlements to sleep in',
      detail: `Kept ${chosen.length} of ${settlements.length} settlements, the larger and nearer ones first.`,
    });
  }
  return [here, ...chosen];
}

const SETTLEMENT_RANK: Record<string, number> = { city: 0, town: 1, village: 2, hamlet: 3 };

/**
 * One Overpass query for settlements, read without the shared normaliser.
 *
 * `normalizeElement` only recognises the attraction and food selectors, so a
 * `place=town` element comes back as null from it. The query itself is built by
 * the provider's own builder, so the bounding-box clamp, the element choice and
 * the exact-value clauses are the ones the rest of the product uses.
 */
async function fetchSettlements(
  box: BoundingBox,
  destination: PacketDestination,
  counters: GatherCounters,
): Promise<RawBaseCandidate[]> {
  const bounded = clampBoundingBox(box);
  const query = buildQuery(bounded, SETTLEMENT_QUERY_LIMIT, [SETTLEMENT_SELECTOR]);

  /*
   * Each endpoint in turn, first answer wins.
   *
   * The provider module keeps a list of these for a reason its own header
   * records: one public instance answering 406, 429 and 504 within a few
   * minutes of each other is what a volunteer-run service under load looks
   * like, and a single-endpoint client turns that into "this region has nowhere
   * to stay in it". Two attempts only — a base list is worth a retry and is not
   * worth a minute of somebody waiting.
   */
  let lastError: unknown = new Error('No map endpoint was configured.');
  for (const endpoint of overpassEndpoints().slice(0, 2)) {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'user-agent': USER_AGENT,
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: new URLSearchParams({ data: query }).toString(),
        signal: AbortSignal.timeout(25_000),
      });
      counters.providerCalls += 1;
      if (!response.ok) {
        lastError = new Error('The map service refused the settlement query.');
        continue;
      }
      const body = (await response.json()) as { elements?: unknown };
      return readSettlements(Array.isArray(body.elements) ? body.elements : [], destination);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

/**
 * Settlement records from whatever the service returned, ordered and deduped.
 *
 * Separated from the request so the offline suite can drive it, and total: an
 * element with no name, no position or no class this arm asked for is skipped
 * rather than defaulted into existence.
 */
export function readSettlements(
  elements: readonly unknown[],
  destination: PacketDestination,
): RawBaseCandidate[] {
  const seen = new Set<string>();
  const found: { candidate: RawBaseCandidate; rank: number; km: number }[] = [];

  for (const entry of elements) {
    const element = entry as {
      type?: unknown;
      id?: unknown;
      lat?: unknown;
      lon?: unknown;
      center?: { lat?: unknown; lon?: unknown };
      tags?: Record<string, unknown>;
    };
    const name = element.tags?.name;
    const kind = element.tags?.place;
    if (typeof name !== 'string' || typeof kind !== 'string') continue;
    const rank = SETTLEMENT_RANK[kind];
    if (rank === undefined) continue;

    const latitude = typeof element.lat === 'number' ? element.lat : element.center?.lat;
    const longitude = typeof element.lon === 'number' ? element.lon : element.center?.lon;
    if (typeof latitude !== 'number' || typeof longitude !== 'number') continue;

    const key = `${kind}|${name}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const km = straightLineKm(
      { latitude: destination.latitude, longitude: destination.longitude },
      { latitude, longitude },
    );
    found.push({
      rank,
      km,
      candidate: {
        entityId: null,
        name,
        latitude,
        longitude,
        basis: `The map data records this as a ${kind}, about ${Math.round(km)} km from the destination. Whether anybody can stay there is not stated.`,
      },
    });
  }

  return found
    .sort((a, b) => (a.rank !== b.rank ? a.rank - b.rank : a.km - b.km))
    .map((entry) => entry.candidate);
}

/* ------------------------------------------------------------------ *
 * Sky
 * ------------------------------------------------------------------ */

/**
 * The local zone, from the same free service the forecast comes from.
 *
 * Asked for rather than derived from longitude: a longitude-derived offset is
 * mean solar time, which is out by up to an hour and a half at a zone's edge and
 * by two in the summer — and every daylight decision in the plan would inherit
 * the error while looking precise.
 */
async function resolveTimeZone(
  destination: PacketDestination,
  counters: GatherCounters,
): Promise<string | null> {
  try {
    const url = new URL('https://api.open-meteo.com/v1/forecast');
    url.searchParams.set('latitude', String(destination.latitude));
    url.searchParams.set('longitude', String(destination.longitude));
    url.searchParams.set('timezone', 'auto');
    url.searchParams.set('forecast_days', '1');
    const response = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    counters.providerCalls += 1;
    if (!response.ok) return null;
    const body = (await response.json()) as { timezone?: unknown };
    return typeof body.timezone === 'string' && body.timezone.length > 0 ? body.timezone : null;
  } catch {
    return null;
  }
}

async function gatherDays(input: {
  destination: PacketDestination;
  dates: readonly string[];
  timeZone: string | null;
  now: Date;
  sessionId: string;
  gaps: PacketGap[];
  unknowns: string[];
  counters: GatherCounters;
}): Promise<RawDay[]> {
  const weatherByDate = await gatherWeather(input);

  return input.dates.map((date, index) => ({
    dayNumber: index + 1,
    date,
    daylight: daylightFor(input.destination, date, input.timeZone),
    weather: weatherByDate.get(date) ?? { state: 'unknown' },
    weatherSource:
      weatherByDate.get(date) === undefined
        ? null
        : { host: 'open-meteo.com', title: 'Open-Meteo', url: null, retrievedAt: input.now.toISOString() },
  }));
}

function daylightFor(
  destination: PacketDestination,
  date: string,
  timeZone: string | null,
): PacketDaylight {
  if (timeZone === null) return { state: 'unknown' };
  try {
    const offset = utcOffsetMinutesOn(date, timeZone);
    const events = solarEventsFor(
      { lat: destination.latitude, lng: destination.longitude },
      date,
      offset,
    );
    if (events.kind === 'polar_day') return { state: 'polar_day' };
    if (events.kind === 'polar_night') return { state: 'polar_night' };
    return {
      state: 'known',
      sunriseMinute: Math.round(events.sunriseMinute),
      sunsetMinute: Math.round(events.sunsetMinute),
    };
  } catch {
    return { state: 'unknown' };
  }
}

/**
 * Forecast where a forecast exists, climate where it does not, and the two are
 * never merged into a single word.
 *
 * The shared weather layer already resolves a trip that straddles the horizon in
 * two halves and labels each; all this does is read the label off and refuse to
 * flatten it. A plan that said "expect 22 degrees" for a date eight months out
 * would be stating a forecast nobody made.
 */
async function gatherWeather(input: {
  destination: PacketDestination;
  dates: readonly string[];
  timeZone: string | null;
  now: Date;
  sessionId: string;
  gaps: PacketGap[];
  counters: GatherCounters;
}): Promise<Map<string, PacketWeather>> {
  const out = new Map<string, PacketWeather>();
  if (input.dates.length === 0) return out;

  try {
    const dataset = await resolveTripWeather({
      regionId: `benchmark:${input.sessionId}`,
      dates: [...input.dates],
      now: input.now,
      locations: [
        {
          id: 'destination',
          label: input.destination.displayName,
          coordinates: { lat: input.destination.latitude, lng: input.destination.longitude },
          elevationMetres: 0,
          timeZone: input.timeZone ?? 'UTC',
          placeIds: [],
          limitation: 'One point speaks for the whole region in this arm.',
        },
      ],
    });
    input.counters.weatherCalls += 1;

    for (const day of dataset.days) {
      const existing = out.get(day.date);
      if (existing !== undefined && existing.state !== 'unknown') continue;
      out.set(day.date, translateWeatherDay(day));
    }
  } catch {
    input.gaps.push({
      kind: 'provider_unavailable',
      subject: 'weather',
      detail: 'The weather service did not answer, so no conditions are stated for any date.',
    });
  }

  return out;
}

/**
 * The shared dataset's day, read structurally.
 *
 * Structural rather than by discriminated import, because the weather schema
 * belongs to the product and this arm must not acquire a dependency on its
 * internal shape changing. What is needed is three numbers and which kind of
 * evidence they are; anything absent stays absent.
 */
function translateWeatherDay(day: unknown): PacketWeather {
  const record = day as Record<string, unknown>;
  const kind = record.kind;
  if (kind !== 'forecast' && kind !== 'pattern' && kind !== 'history') return { state: 'unknown' };

  const number = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null;

  const high = number(record.highCelsius ?? record.temperatureHighC ?? record.highC);
  const low = number(record.lowCelsius ?? record.temperatureLowC ?? record.lowC);
  const precipitation = number(record.precipitationChance ?? record.wetDayChance);
  const summary = typeof record.summary === 'string' ? record.summary : '';

  return {
    state: kind === 'forecast' ? 'forecast' : 'climate',
    summary:
      summary ||
      (kind === 'forecast'
        ? 'A forecast for this date.'
        : 'Typical conditions for this date in recent years, not a forecast.'),
    highCelsius: high,
    lowCelsius: low,
    precipitationChance: precipitation,
    sourceIndex: null,
  };
}

/* ------------------------------------------------------------------ *
 * Routes
 * ------------------------------------------------------------------ */

/**
 * The places worth paying a routing service for, taken from the packet.
 *
 * Two properties, and the second is the one that was missing. The sample comes
 * from the places that *survive the cap*, so every pair measured is a pair the
 * plan can actually address — the previous version sampled the raw provider
 * list, most of which the packet then dropped, and the legs went with them.
 *
 * And it is taken cluster by cluster rather than at a flat stride down the
 * identity order. A day is spent inside one proximity cluster, so the pairs a
 * plan needs times for are overwhelmingly pairs within a cluster; a stride over
 * an order that correlates with nothing spatial measured mostly the journeys
 * nobody would make. Clusters take their turn largest first, so every cluster is
 * represented before any cluster gets a third place and no region of the map is
 * left with no measured leg at all.
 */
export function matrixSample(
  packet: ResearchPacket,
  limit: number = MATRIX_POINT_LIMIT,
): PacketPlace[] {
  const buckets = new Map<number, PacketPlace[]>();
  for (const place of packet.places) {
    // Places outside every cluster share one bucket of their own rather than
    // being dropped: they are still somewhere a plan may send somebody.
    const key = place.clusterIndex ?? -1;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(place);
    else buckets.set(key, [place]);
  }

  const ordered = [...buckets.entries()].sort((a, b) => {
    if (a[1].length !== b[1].length) return b[1].length - a[1].length;
    return a[0] - b[0];
  });

  const sample: PacketPlace[] = [];
  for (let round = 0; sample.length < limit; round += 1) {
    let placedThisRound = false;
    for (const [, bucket] of ordered) {
      const place = bucket[round];
      if (!place) continue;
      placedThisRound = true;
      sample.push(place);
      if (sample.length >= limit) break;
    }
    if (!placedThisRound) break;
  }
  return sample;
}

/** Measured legs for a bounded subset of the packet's own places. */
async function gatherRoutes(
  request: BenchmarkTripRequest,
  packet: ResearchPacket,
  gaps: PacketGap[],
  counters: GatherCounters,
): Promise<RawRouteLeg[]> {
  if (packet.places.length < 2) return [];

  const sample = matrixSample(packet);
  if (sample.length < 2) return [];

  if (packet.places.length > sample.length) {
    gaps.push({
      kind: 'capped_by_count',
      subject: 'measured travel times',
      detail: `Travel times were measured between ${sample.length} of ${packet.places.length} places, taken across every area of the region; every other pair is unknown rather than estimated.`,
    });
  }

  const mode = request.movement.carAvailable ? 'car' : 'foot';
  let outcome: Awaited<ReturnType<typeof computeMatrix>>;
  try {
    outcome = await computeMatrix(
      sample.map((place) => ({ id: place.entityId, lat: place.latitude, lng: place.longitude })),
      costingFor(mode),
      { maxPairs: MAX_MATRIX_PAIRS_PER_REQUEST * 2 },
    );
  } catch {
    gaps.push({
      kind: 'provider_unavailable',
      subject: 'measured travel times',
      detail: 'The routing engine did not answer, so no travel time between any two places was measured.',
    });
    return [];
  }

  counters.routeCalls += outcome.calls;
  counters.routePairs += outcome.pairs;

  const legs: RawRouteLeg[] = [];
  for (let from = 0; from < outcome.ids.length; from += 1) {
    for (let to = 0; to < outcome.ids.length; to += 1) {
      if (from === to) continue;
      const minutes = outcome.minutes[from]?.[to];
      const km = outcome.km[from]?.[to];
      const fromId = outcome.ids[from];
      const toId = outcome.ids[to];
      if (
        fromId === undefined ||
        toId === undefined ||
        minutes === undefined ||
        km === undefined ||
        !Number.isFinite(minutes)
      ) {
        continue;
      }
      legs.push({
        fromEntityId: fromId,
        toEntityId: toId,
        minutes,
        km: Number.isFinite(km) ? km : 0,
        mode: mode === 'car' ? 'drive' : 'walk',
      });
    }
  }

  if (outcome.failedPairs.length > 0) {
    gaps.push({
      kind: 'provider_unavailable',
      subject: 'measured travel times',
      detail: `The routing engine could not answer for ${outcome.failedPairs.length} pair(s).`,
    });
  }

  return legs;
}
