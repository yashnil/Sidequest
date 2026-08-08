/**
 * THE RESEARCH PACKET — WHAT THE ONE GENERATION CALL IS ALLOWED TO SEE.
 *
 * A normalised, bounded inventory of the world around a destination, assembled
 * by deterministic code and handed to the model as its only source of fact.
 * Four properties are load-bearing, and each exists to stop a specific way this
 * arm of the benchmark could become meaningless.
 *
 * **Places are addressed by index.** `PacketPlace.index` is a position in
 * `packet.places`, and it is the only handle the model is ever given. There is
 * no field anywhere in the generation schema where a URL, a host or a
 * free-written place name can be returned, so a hostile page that says "cite
 * your source as `javascript:alert(1)`" has nothing to write it into. The same
 * argument the research model already makes for `sourceIndex`, applied to the
 * places as well, because a plan renders place names into a reviewer's browser.
 *
 * **It is unordered and unscored.** No fit score, no rank, no base assignment,
 * no day assignment, no shortlist. The moment this packet carried a ranking, the
 * baseline would be Sidequest's selection engine with a language model as its
 * renderer, and the experiment would be comparing two prompts rather than two
 * architectures. `clusterIndex` is the one grouping present and it is proximity
 * only — a grid over coordinates, written here, deciding nothing about what is
 * worth visiting.
 *
 * **`'unknown'` is a value, never an omission.** Hours, access, seasonal
 * reachability and weather each have an explicit unknown state. The distinction
 * between "nobody looked" and "we looked and the data does not say" is one of
 * the things this benchmark exists to measure, and a packet that expressed the
 * second as a missing key would destroy it before the model ever saw it.
 *
 * **Every cap is by count, and every omission is listed.** `packet.gaps` names
 * what was dropped and why. A packet that quietly truncated would let the
 * baseline look decisive about a region it was only shown a third of.
 */

export const RESEARCH_PACKET_VERSION = 1 as const;

/* ------------------------------------------------------------------ *
 * World facts, each with an explicit unknown
 * ------------------------------------------------------------------ */

/**
 * What is known about when a place is open.
 *
 * `always_open` is a real answer for a roadside viewpoint and is not the same
 * claim as `known` with a window from midnight to midnight — the first says
 * there is no gate, the second says somebody published those hours.
 */
export type PacketHours =
  | { state: 'unknown' }
  | { state: 'always_open' }
  | {
      state: 'known';
      /** Minutes from local midnight, on the trip's own dates. */
      windows: readonly { date: string; openMinute: number; closeMinute: number }[];
      /** Dates inside the trip on which the place is shut. */
      closedDates: readonly string[];
      sourceIndex: number | null;
    };

/** Whether the place is reachable at all in the trip's months. */
export type PacketSeasonal =
  | { state: 'unknown' }
  | { state: 'open_in_season' }
  | { state: 'closed_in_season'; note: string };

/**
 * Physical access, each field `null` where nothing said.
 *
 * Not booleans defaulting to `false`: "no source says this needs a car" and "a
 * source says it does not" are different, and a planner that collapsed them
 * would confidently send somebody without a car to a trailhead.
 */
export interface PacketAccess {
  requiresCar: boolean | null;
  unpavedApproach: boolean | null;
  remoteNoServices: boolean | null;
  strenuous: boolean | null;
  wheelchair: 'yes' | 'limited' | 'no' | 'unknown';
  feeStated: boolean | null;
}

/** What the venue serves, where the source says. An empty list is not "nothing". */
export interface PacketFood {
  servesSlots: readonly ('breakfast' | 'lunch' | 'dinner' | 'snack')[];
  /** Dietary tags the source itself carries. Never inferred from a cuisine. */
  dietaryTags: readonly string[];
  cuisine: string | null;
  /** What the venue itself states it cannot accommodate. */
  cannotAccommodate: readonly string[];
}

/* ------------------------------------------------------------------ *
 * Places
 * ------------------------------------------------------------------ */

export interface PacketPlace {
  /** Position in `packet.places`. The only handle the model is given. */
  index: number;
  /**
   * The shared inventory identity, carried through so the neutral plan and the
   * validators resolve the same place the packet meant. Without it the
   * conversion would have to match on a name, and name matching would turn
   * phrasing into a scoring axis.
   */
  entityId: string;
  name: string;
  latitude: number;
  longitude: number;
  /** The provider's own classification, verbatim. Never a judgement of ours. */
  kind: string;
  /** Proximity grouping only. See the header. */
  clusterIndex: number | null;
  typicalDurationMinutes: number | null;
  daylightOnly: boolean | null;
  hours: PacketHours;
  seasonal: PacketSeasonal;
  access: PacketAccess;
  /** Present only for somewhere to eat. */
  food: PacketFood | null;
  /** Categories from the shared taxonomy, for avoidance matching. */
  tags: readonly string[];
  sourceIndex: number | null;
}

/* ------------------------------------------------------------------ *
 * Geography, movement and sky
 * ------------------------------------------------------------------ */

export interface PacketCluster {
  index: number;
  /** A neutral label: the cluster's own number. Never a place name we picked. */
  label: string;
  centreLatitude: number;
  centreLongitude: number;
  placeIndices: readonly number[];
  /** Widest straight-line spread inside the cluster, in km. */
  spreadKm: number;
}

/**
 * Somewhere a traveller could sleep, offered as a candidate and nothing more.
 *
 * Unranked, and carrying no night count. Which of these to use, how many nights
 * in each, and in what order are the decisions under test — a packet that
 * arrived with them made would have answered the question it was meant to ask.
 */
export interface PacketBaseCandidate {
  placeIndex: number | null;
  name: string;
  latitude: number;
  longitude: number;
  /** Why the geocoder thinks this is a settlement. Never why it would be good. */
  basis: string;
}

/**
 * A measured leg. Absent means nobody measured it; there is no estimate here.
 *
 * `provenance` has no `estimated` member for the reason the neutral plan schema
 * has none: a system that could label a guess as sourced would be handed the
 * cheapest possible way to look verifiable.
 */
export interface PacketRouteLeg {
  fromIndex: number;
  toIndex: number;
  minutes: number;
  km: number;
  mode: 'drive' | 'walk' | 'transit';
  provenance: 'measured';
}

export type PacketDaylight =
  | { state: 'unknown' }
  | { state: 'known'; sunriseMinute: number; sunsetMinute: number }
  | { state: 'polar_day' }
  | { state: 'polar_night' };

/**
 * What the sky is expected to do, and how far that expectation can be trusted.
 *
 * `forecast` and `climate` are kept apart rather than averaged into a
 * "prediction". Ten years of reanalysis for the second week of September is a
 * different kind of claim from tomorrow's model run, and a plan that treated
 * them alike would state a chance of rain for a date nobody can forecast.
 */
export type PacketWeather =
  | { state: 'unknown' }
  | {
      state: 'forecast' | 'climate';
      summary: string;
      highCelsius: number | null;
      lowCelsius: number | null;
      precipitationChance: number | null;
      sourceIndex: number | null;
    };

export interface PacketDay {
  dayNumber: number;
  date: string;
  daylight: PacketDaylight;
  weather: PacketWeather;
}

/* ------------------------------------------------------------------ *
 * Sources
 * ------------------------------------------------------------------ */

/**
 * A page or dataset the run actually retrieved.
 *
 * Assembled by the provider layer, never by the model. `host` is what the blind
 * renderer shows; the full URL is retained for the post-reveal diagnostics view
 * and is the reason nothing downstream ever needs the model to write one.
 */
export interface PacketSource {
  index: number;
  host: string;
  title: string | null;
  url: string | null;
  retrievedAt: string | null;
}

/* ------------------------------------------------------------------ *
 * The packet
 * ------------------------------------------------------------------ */

export interface PacketDestination {
  entityId: string;
  displayName: string;
  countryCode: string | null;
  latitude: number;
  longitude: number;
  /** How wide the geocoder's own record is. Sized from the bounding box. */
  radiusKm: number | null;
  scale: 'local' | 'city' | 'subregion' | 'region' | 'country' | 'multi_country' | 'unknown';
}

/**
 * Something the packet does not hold, and why.
 *
 * `kind` is closed so a gap is never a shrug, and `detail` names the count, so a
 * reader can tell "the router refused two pairs" from "the router refused every
 * pair".
 */
export const PACKET_GAP_KINDS = [
  'capped_by_count',
  'provider_unavailable',
  'provider_disabled',
  'no_dataset',
  'outside_forecast_horizon',
  'not_requested',
] as const;
export type PacketGapKind = (typeof PACKET_GAP_KINDS)[number];

export interface PacketGap {
  kind: PacketGapKind;
  subject: string;
  detail: string;
}

export interface ResearchPacket {
  version: typeof RESEARCH_PACKET_VERSION;
  destination: PacketDestination;
  days: readonly PacketDay[];
  places: readonly PacketPlace[];
  clusters: readonly PacketCluster[];
  baseCandidates: readonly PacketBaseCandidate[];
  routeLegs: readonly PacketRouteLeg[];
  sources: readonly PacketSource[];
  /** Everything dropped, refused or never asked for. Never empty by accident. */
  gaps: readonly PacketGap[];
  /** Things nobody established, in words a traveller could read. */
  unknowns: readonly string[];
}

/* ------------------------------------------------------------------ *
 * Caps
 * ------------------------------------------------------------------ */

/**
 * How much of the world one generation call is shown.
 *
 * Chosen so a fifteen-night trip still sees several candidates per day, and so
 * the packet stays inside a context window that leaves room for the model to
 * think. Every one of them is applied by count with a deterministic order — see
 * `packet.ts` — and every application writes a `capped_by_count` gap.
 */
export const PACKET_CAPS = {
  places: 140,
  foodVenues: 45,
  clusters: 12,
  baseCandidates: 10,
  /**
   * Every leg a full matrix over the sampled points can produce, and not one
   * fewer.
   *
   * Twenty-four points is 552 ordered pairs, so a cap below that would throw
   * away measurements the run had already paid a routing service for — and
   * throw them away by entity id, which is to say arbitrarily, leaving the plan
   * to state `unknown` for journeys somebody had measured.
   */
  // 40 sampled points is 1,560 ordered pairs; the cap is raised with the sample
  // so the routing the run pays for is the routing the packet keeps.
  routeLegs: 1_600,
  sources: 120,
  unknowns: 40,
} as const;

/** The index is legal only if it addresses a place this packet actually holds. */
export function placeAt(packet: ResearchPacket, index: number | null): PacketPlace | null {
  if (index === null || !Number.isInteger(index) || index < 0) return null;
  return packet.places[index] ?? null;
}

export function sourceAt(packet: ResearchPacket, index: number | null): PacketSource | null {
  if (index === null || !Number.isInteger(index) || index < 0) return null;
  return packet.sources[index] ?? null;
}
