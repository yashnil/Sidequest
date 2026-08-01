import 'server-only';
import { z } from 'zod';
import { USER_AGENT } from './nominatim';

/**
 * OVERPASS — POI AND GEOGRAPHIC DISCOVERY.
 *
 * The public instance names "apps for non-mapper audiences relying on public
 * instances" as an abuse pattern, so it is used here for **bounded development
 * smoke tests only** and the endpoint is configurable so a hosted service,
 * regional extracts or a self-hosted instance can replace it without touching
 * the application.
 *
 * The bounds are not politeness, they are correctness: an unbounded Overpass
 * query against a country-sized bbox returns tens of megabytes and times out,
 * and the honest product answer to that is "we did not look that broadly"
 * rather than a hung page.
 *
 * **Availability is never a prerequisite for rendering an already compiled
 * trip.** Everything this returns is normalized into the compiled artifact,
 * which is stored under ODbL with attribution — so a trip renders from the
 * database, and Overpass being down affects only the next compilation.
 */

/**
 * Endpoints, tried in order.
 *
 * Plural because a live evaluation watched the primary public instance answer
 * 406, 429 and 504 within a few minutes of each other for the same query. That
 * is not a bug in either side — it is what a volunteer-run service under load
 * looks like — but a single-endpoint client turns it into "this destination has
 * no places in it", which is a lie about the world rather than about the server.
 */
const DEFAULT_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 8_000_000;
/** Server-side query timeout, so a heavy query is refused rather than queued. */
const QUERY_TIMEOUT_S = 25;
const MIN_INTERVAL_MS = 1_200;

export class OverpassError extends Error {
  readonly code: 'not_configured' | 'rate_limited' | 'request_failed' | 'too_large' | 'malformed_response';

  constructor(code: OverpassError['code'], message: string) {
    super(message);
    this.name = 'OverpassError';
    this.code = code;
  }
}

/** Comma-separated, so a self-hosted instance can be listed first. */
export function overpassEndpoints(): string[] {
  const configured = process.env.SIDEQUEST_POI_URL?.trim();
  if (!configured) return [...DEFAULT_ENDPOINTS];
  return configured
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function overpassEndpoint(): string {
  return overpassEndpoints()[0] ?? DEFAULT_ENDPOINTS[0]!;
}

export function isPoiProviderEnabled(): boolean {
  return process.env.SIDEQUEST_POI_PROVIDER?.trim().toLowerCase() === 'overpass';
}

let gate: Promise<void> = Promise.resolve();

function nextSlot(): Promise<void> {
  const wait = gate.then(() => new Promise<void>((resolve) => setTimeout(resolve, MIN_INTERVAL_MS)));
  gate = wait.catch(() => undefined);
  return wait;
}

const elementSchema = z.object({
  type: z.enum(['node', 'way', 'relation']),
  id: z.number(),
  lat: z.number().optional(),
  lon: z.number().optional(),
  center: z.object({ lat: z.number(), lon: z.number() }).optional(),
  tags: z.record(z.string(), z.string()).optional(),
  timestamp: z.string().optional(),
});
export type OverpassElement = z.infer<typeof elementSchema>;

const responseSchema = z.object({
  elements: z.array(elementSchema).default([]),
  osm3s: z.object({ timestamp_osm_base: z.string().optional() }).optional(),
});

export interface BoundingBox {
  south: number;
  west: number;
  north: number;
  east: number;
}

/**
 * The tags Sidequest actually plans against.
 *
 * Deliberately a short list rather than "everything with a name". Overpass will
 * happily return every bench and post box inside a bbox; a trip planner needs
 * the things somebody would go out of their way for, and asking for less is the
 * difference between a 200 KB response and a 40 MB one.
 */
export const POI_SELECTORS: readonly { key: string; values: string[]; intent: string }[] = [
  { key: 'tourism', values: ['attraction', 'viewpoint', 'museum', 'artwork', 'gallery', 'zoo', 'aquarium', 'theme_park'], intent: 'landmark' },
  { key: 'historic', values: ['castle', 'ruins', 'monument', 'memorial', 'archaeological_site', 'fort'], intent: 'culture' },
  { key: 'natural', values: ['peak', 'beach', 'waterfall', 'hot_spring', 'cave_entrance', 'glacier', 'volcano'], intent: 'nature' },
  { key: 'leisure', values: ['park', 'nature_reserve', 'garden'], intent: 'nature' },
  { key: 'waterway', values: ['waterfall'], intent: 'nature' },
  { key: 'amenity', values: ['place_of_worship', 'marketplace'], intent: 'culture' },
];

/** A bbox big enough to matter is refused rather than silently truncated. */
export const MAX_BBOX_DEGREES = 3;

/**
 * Above this area, ask for nodes only.
 *
 * A live evaluation isolated this precisely: over New York's bounding box,
 * `node[...]` answers in under a second with a full page of results, and the
 * same query with `way[...]` added is refused with a flat 406 — every time, for
 * every tag group. `out center` has to resolve each way's member geometry
 * before it can place it, and across a metro-sized box that is more work than
 * the public service will accept from an anonymous client.
 *
 * The cost is real and worth naming: a museum mapped as a building outline, or
 * a park mapped as an area, is a way and will be missed at this scale. What is
 * gained is a query that answers at all. A self-hosted instance can afford ways
 * everywhere, and raising this constant is the only change that needs.
 */
export const WAY_QUERY_AREA_LIMIT_DEG2 = 0.05;

export function boxAreaDeg2(box: BoundingBox): number {
  return Math.abs(box.north - box.south) * Math.abs(box.east - box.west);
}

export function clampBoundingBox(box: BoundingBox): BoundingBox {
  const midLat = (box.north + box.south) / 2;
  const midLng = (box.east + box.west) / 2;
  const halfLat = Math.min(MAX_BBOX_DEGREES / 2, (box.north - box.south) / 2);
  const halfLng = Math.min(MAX_BBOX_DEGREES / 2, (box.east - box.west) / 2);
  return {
    south: midLat - halfLat,
    north: midLat + halfLat,
    west: midLng - halfLng,
    east: midLng + halfLng,
  };
}

/**
 * One query for every selector, rather than one query per selector.
 *
 * Overpass charges by work done, and a union is a single pass over the same
 * bbox. `out center` gives a representative point for ways and relations
 * without the geometry, which is the difference between a usable response and a
 * refusal. `qt` sorts by quadtile, which is cheaper than sorting by id.
 */
export function buildQuery(
  box: BoundingBox,
  limit: number,
  only?: readonly (typeof POI_SELECTORS)[number][],
): string {
  const bbox = `${box.south.toFixed(5)},${box.west.toFixed(5)},${box.north.toFixed(5)},${box.east.toFixed(5)}`;
  /**
   * Nodes always; ways only where the box is small enough to afford them.
   * Relations never — the same geometry cost, an order of magnitude worse.
   * See `WAY_QUERY_AREA_LIMIT_DEG2`.
   */
  const elements = boxAreaDeg2(box) <= WAY_QUERY_AREA_LIMIT_DEG2 ? ['node', 'way'] : ['node'];
  const clauses = (only ?? POI_SELECTORS)
    .flatMap((selector) =>
      elements.map(
        (element) => `${element}["${selector.key}"~"^(${selector.values.join('|')})$"]["name"](${bbox});`,
      ),
    )
    .join('\n  ');

  return `[out:json][timeout:${QUERY_TIMEOUT_S}];\n(\n  ${clauses}\n);\nout center tags qt ${Math.max(1, limit)};`;
}

export interface OverpassResult {
  elements: OverpassElement[];
  /** The OSM database timestamp the answer was generated from. */
  dataTimestamp: string | null;
  calls: number;
  cacheHit: boolean;
  bytes: number;
  /** Selector groups the service refused. Some refused is a gap, not a failure. */
  failedGroups: string[];
}

export interface OverpassOptions {
  limit?: number;
  fetchImpl?: typeof fetch;
  /** Extra attempts per endpoint. Default 0 — two endpoints is already a retry. */
  retries?: number;
  /**
   * Absolute epoch-ms deadline for the whole discovery stage.
   *
   * Without one, six selector groups times two endpoints times a request
   * timeout is several minutes of a traveller watching a spinner — which a live
   * evaluation duly produced. Past the deadline no further group is started and
   * the remainder are reported as refused, so the region is thin and honest
   * rather than late.
   */
  deadlineMs?: number;
  cache?: {
    read: (key: string) => OverpassResult | null;
    write: (key: string, value: OverpassResult) => void;
  };
}

export function overpassCacheKey(box: BoundingBox, limit: number): string {
  const bbox = [box.south, box.west, box.north, box.east].map((value) => value.toFixed(3)).join(',');
  return ['overpass', 'v1', overpassEndpoint(), bbox, String(limit)].join('|');
}

export async function fetchPois(
  box: BoundingBox,
  options: OverpassOptions = {},
): Promise<OverpassResult> {
  const limit = Math.min(400, Math.max(1, options.limit ?? 200));
  const bounded = clampBoundingBox(box);
  const key = overpassCacheKey(bounded, limit);

  const cached = options.cache?.read(key);
  if (cached) return { ...cached, calls: 0, cacheHit: true };

  /**
   * One request per selector group, not one union of all of them.
   *
   * A live evaluation against New York found the combined union rejected with a
   * flat 406 while the same query for a single tag group answered in under a
   * second. `way[leisure=park]` across a metro-sized box is tens of thousands of
   * ways whose geometry has to be resolved before `out center` can place them;
   * unioned with five more groups it exceeds what the public service will take
   * from an anonymous client at all.
   *
   * Splitting costs more round trips and buys two things worth more than they
   * cost: each request is individually cheap enough to be accepted, and a group
   * that fails takes only itself down. Six groups where one is refused is a
   * region with a gap, which the coverage report can describe — rather than a
   * region with nothing in it, which reads as "there is nothing here".
   */
  const perGroup = Math.max(20, Math.ceil(limit / POI_SELECTORS.length));
  const elements: OverpassElement[] = [];
  const seen = new Set<string>();
  let dataTimestamp: string | null = null;
  let calls = 0;
  let bytes = 0;
  const failedGroups: string[] = [];

  for (const selector of POI_SELECTORS) {
    if (elements.length >= limit) break;
    if (options.deadlineMs !== undefined && Date.now() > options.deadlineMs) {
      failedGroups.push(selector.key);
      continue;
    }
    try {
      const group = await fetchGroup(bounded, perGroup, selector, options);
      calls += group.calls;
      bytes += group.bytes;
      dataTimestamp ??= group.dataTimestamp;
      for (const element of group.elements) {
        const id = `${element.type}/${element.id}`;
        if (seen.has(id)) continue;
        seen.add(id);
        elements.push(element);
      }
    } catch {
      failedGroups.push(selector.key);
    }
  }

  // Everything refused is a provider failure; some refused is a gap the caller
  // reports. The distinction is what stops a busy server reading as an empty map.
  if (failedGroups.length === POI_SELECTORS.length) {
    throw new OverpassError('rate_limited', 'The map data service is busy.');
  }

  const result: OverpassResult = {
    elements: elements.slice(0, limit),
    dataTimestamp,
    calls,
    cacheHit: false,
    bytes,
    failedGroups,
  };
  options.cache?.write(key, result);
  return result;
}

async function fetchGroup(
  box: BoundingBox,
  limit: number,
  selector: (typeof POI_SELECTORS)[number],
  options: OverpassOptions,
): Promise<OverpassResult> {
  const query = buildQuery(box, limit, [selector]);
  const endpoints = overpassEndpoints();
  const maxAttempts = Math.max(1, (options.retries ?? 0) + 1) * endpoints.length;
  const doFetch = options.fetchImpl ?? fetch;

  let lastError: OverpassError | null = null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const endpoint = endpoints[attempt % endpoints.length]!;
    await nextSlot();
    try {
      const response = await doFetch(endpoint, {
        method: 'POST',
        headers: {
          'user-agent': USER_AGENT,
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: new URLSearchParams({ data: query }).toString(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      /**
       * Every way this service says "not now", in one branch.
       *
       * 429 and 504 are the documented ones. 406 is not documented anywhere as a
       * rate-limit response, and a live evaluation caught it returned for a
       * query that a smaller one answered fine — so it belongs here rather than
       * being reported as a permanent failure.
       */
      if ([406, 429, 502, 503, 504].includes(response.status)) {
        lastError = new OverpassError('rate_limited', 'The map data service is busy.');
        await new Promise((resolve) => setTimeout(resolve, 2_000 * (attempt + 1)));
        continue;
      }
      if (!response.ok) {
        lastError = new OverpassError('request_failed', 'The map data service did not answer.');
        continue;
      }

      const text = await response.text();
      if (text.length > MAX_RESPONSE_BYTES) {
        throw new OverpassError('too_large', 'That area returns more data than we will read.');
      }

      const parsed = responseSchema.safeParse(JSON.parse(text));
      if (!parsed.success) {
        throw new OverpassError(
          'malformed_response',
          'The map data service returned a shape we cannot read.',
        );
      }

      return {
        elements: parsed.data.elements,
        dataTimestamp: parsed.data.osm3s?.timestamp_osm_base ?? null,
        calls: 1,
        cacheHit: false,
        bytes: text.length,
        failedGroups: [],
      };
    } catch (error) {
      if (error instanceof OverpassError) {
        if (error.code === 'too_large' || error.code === 'malformed_response') throw error;
        lastError = error;
        continue;
      }
      lastError = new OverpassError('request_failed', 'The map data service did not answer.');
    }
  }

  throw lastError ?? new OverpassError('request_failed', 'The map data service did not answer.');
}

export function elementId(element: OverpassElement): string {
  return `${element.type}/${element.id}`;
}

export function elementUrl(element: OverpassElement): string {
  return `https://www.openstreetmap.org/${elementId(element)}`;
}

export function elementCoordinates(element: OverpassElement): { lat: number; lng: number } | null {
  if (element.lat !== undefined && element.lon !== undefined) {
    return { lat: element.lat, lng: element.lon };
  }
  if (element.center) return { lat: element.center.lat, lng: element.center.lon };
  return null;
}

/**
 * The minimum set of fields Sidequest needs, normalized.
 *
 * Deliberately **not** a copy of the tag dictionary. An OSM element can carry
 * two hundred tags; blindly persisting them would make our database a
 * redistribution of theirs rather than a derived work built from the parts we
 * use, and would bloat every artifact with keys nothing reads. What is kept is
 * the identity, the position, the handful of tags that change a plan, and the
 * provenance needed to attribute and to re-check upstream.
 */
export interface NormalizedOsmPlace {
  elementId: string;
  name: string;
  coordinates: { lat: number; lng: number };
  /** The one tag that classified it: `tourism=viewpoint`. */
  primaryTag: string;
  /** Wheelchair, fee, opening_hours — only the ones that change a plan. */
  planningTags: Record<string, string>;
  sourceTimestamp: string | undefined;
  url: string;
}

const PLANNING_TAG_KEYS = [
  'opening_hours',
  'fee',
  'access',
  'wheelchair',
  'website',
  'operator',
  'ele',
  'seasonal',
] as const;

export function normalizeElement(element: OverpassElement): NormalizedOsmPlace | null {
  const coordinates = elementCoordinates(element);
  const tags = element.tags ?? {};
  const name = tags.name;
  if (!coordinates || !name) return null;

  const selector = POI_SELECTORS.find((entry) => {
    const value = tags[entry.key];
    return value !== undefined && entry.values.includes(value);
  });
  if (!selector) return null;

  const planningTags: Record<string, string> = {};
  for (const key of PLANNING_TAG_KEYS) {
    const value = tags[key];
    if (value !== undefined) planningTags[key] = value;
  }

  return {
    elementId: elementId(element),
    name,
    coordinates,
    primaryTag: `${selector.key}=${tags[selector.key] ?? ''}`,
    planningTags,
    sourceTimestamp: element.timestamp,
    url: elementUrl(element),
  };
}
