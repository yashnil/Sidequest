import 'server-only';
import {
  SCAN_KIND_PROFILES,
  haversineKm,
  normalizeScanProposal,
  type CostLevel,
  type Interest,
  type PhysicalIntensity,
  type ResolvedPosition,
  type ScanExposure,
  type ScanKind,
  type ScanProposal,
  type ScanProposalNormalization,
} from '@sidequest/core';
import { MAX_BBOX_DEGREES, clampBoundingBox, elementCoordinates, elementId, fetchNotablePois, type BoundingBox, type OverpassElement, type OverpassResult } from '../providers/overpass';
import { fetchWikidataSitelinkCounts } from '../providers/wikidata';
import { fetchWikidataAround, type WikidataAroundResult } from '../providers/wikidata-around';
import { fetchWikidataDetails, type WikidataPlaceDetails } from '../providers/wikidata-details';
import { describePool } from './open-data-description';
import { cacheFor, TTL } from '../providers/open-verification';
import { scanCandidateTarget } from './prompt';
import recorded from './fixtures/open-data.json';

/**
 * DISCOVERY SCAN FALLBACK — AN OPEN-DATA PROPOSAL WHEN THE MODEL CANNOT ANSWER.
 *
 * The scan's one model call *proposes* candidates; everything after it is
 * Sidequest's deterministic work. When that call cannot happen at all — no
 * credential, a credential the vendor rejected, the day's allowance spent, a
 * timeout, the vendor down — the traveller used to get "Sidequest can't reach
 * its research right now" and no board. This module writes the same
 * `ScanProposal` the model would have, from open data alone:
 *
 * - **OpenStreetMap (Overpass)** for *what is there*: things somebody mapped as
 *   a museum, a waterfall, a castle, a viewpoint, a market — and only those
 *   that carry a `wikidata` tag, because a link to a knowledge-base item is the
 *   cheapest honest significance signal the open map has (it turns a city's
 *   answer from every named park bench into the places a guidebook mentions).
 * - **Wikidata** for *how much attention a place gets*: the number of
 *   Wikimedia sitelinks on its item, used only to order and to tier, never
 *   shown as a rating.
 *
 * Every soft attribute is a category default from the map tag (a museum is
 * indoor and about two hours), never a claim about this particular place. The
 * `why` — which becomes the place's description — is what the sources state
 * about the place itself (`open-data-description.ts`: Wikidata's description,
 * inception, heritage, architect, style; a few OSM fact tags), or its bare
 * category label when nothing is stated. Fit is the scorer's to say. Positions come straight
 * from the map objects, so `placeScanProposal` is skipped on this path.
 *
 * It is a fallback, never an addition: `run.ts` reaches it only when the model
 * was unavailable, never after a successful call and never for a malformed
 * answer (that is the model's fault and is reported as one). It never calls a
 * model. A failure here — the map service down, fewer than four usable places —
 * is returned typed, and the caller then fails with the *original* model cause
 * so the traveller's copy stays honest about what went wrong first.
 *
 * Bounded: one box around the destination sized by its scale (never wider than
 * `MAX_BBOX_DEGREES`), one Overpass request per selector group through the
 * provider's own spacing gate, endpoint rotation and cache, a stage deadline,
 * at most 100 Wikidata ids in two requests for attention, and one batched
 * details request for the final pool (at most 40 ids, cached). Known gaps, said plainly:
 * relations are never queried (a national park mapped only as a boundary
 * relation is missed), ways are left out above `NOTABLE_WAY_AREA_LIMIT_DEG2`,
 * and a group that returns its full element limit is truncated in quadtile
 * order, not by significance.
 */

/** One selector group, the same shape `POI_SELECTORS` uses. */
type Selector = { key: string; values: string[]; intent: string };

/** What the fallback asks the map for: notable things a traveller would go out of their way for. */
export const NOTABLE_SELECTORS: readonly Selector[] = [
  { key: 'tourism', values: ['attraction', 'viewpoint', 'museum', 'gallery', 'zoo', 'aquarium', 'theme_park'], intent: 'landmark' },
  { key: 'historic', values: ['castle', 'monument', 'archaeological_site', 'ruins', 'fort', 'memorial'], intent: 'culture' },
  { key: 'natural', values: ['peak', 'waterfall', 'hot_spring', 'beach', 'cave_entrance', 'volcano', 'glacier', 'water'], intent: 'nature' },
  { key: 'leisure', values: ['park', 'garden', 'nature_reserve'], intent: 'nature' },
  { key: 'waterway', values: ['waterfall'], intent: 'nature' },
  { key: 'amenity', values: ['marketplace', 'place_of_worship'], intent: 'culture' },
];

/** Towns and villages: small-town candidates and, on a broad trip, somewhere else to sleep. Never asked for a city-scale trip, where they would be suburbs. */
export const NOTABLE_SETTLEMENTS: Selector = { key: 'place', values: ['city', 'town', 'village'], intent: 'settlement' };

/**
 * Ways are affordable over a much wider box when the query also requires
 * `wikidata`: the filter is applied from the tag index before any geometry is
 * resolved. Above this area the sweep is nodes only, as the unfiltered one is
 * above `WAY_QUERY_AREA_LIMIT_DEG2`.
 */
export const NOTABLE_WAY_AREA_LIMIT_DEG2 = 1.5;
const GROUP_LIMIT = 400;
const MAX_SITELINK_IDS = 100;
const MAX_POOL = 40;
/** Below this the scan has nothing to plan from and says so with the model's own cause. */
export const MIN_OPEN_DATA_PLACES = 4;
const STAGE_BUDGET_MS = 75_000;

interface KindSpec {
  kind: ScanKind;
  /** The plain noun the map's tag means, for the `why` line. */
  noun: string;
  durationMinutes: number;
  intensity: PhysicalIntensity;
  exposure: ScanExposure;
  rainyDayOk: boolean;
  costLevel?: CostLevel;
  interests?: Interest[];
  caution?: string;
}

/**
 * The one table from an OpenStreetMap tag to a scan kind and its category
 * defaults. Durations are the same order of magnitude the model is asked for
 * and are labelled estimates downstream (`durationBasis: category_estimate`).
 */
export const TAG_KINDS: Readonly<Record<string, KindSpec>> = {
  'tourism=attraction': { kind: 'landmark', noun: 'tourist attraction', durationMinutes: 75, intensity: 'easy', exposure: 'mixed', rainyDayOk: false },
  'tourism=viewpoint': { kind: 'viewpoint', noun: 'viewpoint', durationMinutes: 45, intensity: 'easy', exposure: 'outdoor', rainyDayOk: false },
  'tourism=museum': { kind: 'museum', noun: 'museum', durationMinutes: 120, intensity: 'none', exposure: 'indoor', rainyDayOk: true },
  'tourism=gallery': { kind: 'gallery', noun: 'gallery', durationMinutes: 90, intensity: 'none', exposure: 'indoor', rainyDayOk: true },
  'tourism=zoo': { kind: 'wildlife', noun: 'zoo', durationMinutes: 180, intensity: 'easy', exposure: 'outdoor', rainyDayOk: false, costLevel: 2 },
  'tourism=aquarium': { kind: 'wildlife', noun: 'aquarium', durationMinutes: 120, intensity: 'none', exposure: 'indoor', rainyDayOk: true, costLevel: 2 },
  'tourism=theme_park': { kind: 'theme_park', noun: 'theme park', durationMinutes: 300, intensity: 'easy', exposure: 'mixed', rainyDayOk: false, costLevel: 3 },
  'historic=castle': { kind: 'castle_or_palace', noun: 'castle', durationMinutes: 120, intensity: 'easy', exposure: 'mixed', rainyDayOk: false },
  'historic=fort': { kind: 'historic_site', noun: 'fort', durationMinutes: 90, intensity: 'easy', exposure: 'mixed', rainyDayOk: false },
  'historic=monument': { kind: 'landmark', noun: 'monument', durationMinutes: 30, intensity: 'none', exposure: 'outdoor', rainyDayOk: false, interests: ['architecture_and_landmarks', 'history_and_culture'] },
  'historic=memorial': { kind: 'landmark', noun: 'memorial', durationMinutes: 30, intensity: 'none', exposure: 'outdoor', rainyDayOk: false, interests: ['history_and_culture'] },
  'historic=archaeological_site': { kind: 'historic_site', noun: 'archaeological site', durationMinutes: 90, intensity: 'easy', exposure: 'outdoor', rainyDayOk: false },
  'historic=ruins': { kind: 'historic_site', noun: 'ruin', durationMinutes: 60, intensity: 'easy', exposure: 'outdoor', rainyDayOk: false },
  'natural=peak': {
    kind: 'day_hike',
    noun: 'mountain peak',
    durationMinutes: 300,
    intensity: 'strenuous',
    exposure: 'outdoor',
    rainyDayOk: false,
    interests: ['hiking', 'scenic_viewpoints'],
    caution: 'Mapped as a summit; whether there is a walkable route, and how hard it is, has not been checked.',
  },
  'natural=waterfall': { kind: 'waterfall', noun: 'waterfall', durationMinutes: 60, intensity: 'easy', exposure: 'outdoor', rainyDayOk: false },
  'waterway=waterfall': { kind: 'waterfall', noun: 'waterfall', durationMinutes: 60, intensity: 'easy', exposure: 'outdoor', rainyDayOk: false },
  'natural=hot_spring': { kind: 'hot_spring', noun: 'hot spring', durationMinutes: 120, intensity: 'none', exposure: 'outdoor', rainyDayOk: false },
  'natural=beach': { kind: 'beach', noun: 'beach', durationMinutes: 150, intensity: 'none', exposure: 'outdoor', rainyDayOk: false },
  'natural=cave_entrance': { kind: 'landmark', noun: 'cave', durationMinutes: 90, intensity: 'easy', exposure: 'mixed', rainyDayOk: false, interests: ['geology_and_geothermal'] },
  'natural=volcano': { kind: 'landmark', noun: 'volcano', durationMinutes: 120, intensity: 'moderate', exposure: 'outdoor', rainyDayOk: false, interests: ['geology_and_geothermal', 'scenic_viewpoints'] },
  'natural=glacier': { kind: 'viewpoint', noun: 'glacier', durationMinutes: 120, intensity: 'easy', exposure: 'outdoor', rainyDayOk: false, interests: ['scenic_viewpoints', 'geology_and_geothermal'] },
  'natural=water': { kind: 'lake_or_river', noun: 'lake', durationMinutes: 90, intensity: 'easy', exposure: 'outdoor', rainyDayOk: false },
  'leisure=park': { kind: 'park_or_garden', noun: 'park', durationMinutes: 75, intensity: 'easy', exposure: 'outdoor', rainyDayOk: false },
  'leisure=garden': { kind: 'park_or_garden', noun: 'garden', durationMinutes: 75, intensity: 'easy', exposure: 'outdoor', rainyDayOk: false },
  'leisure=nature_reserve': { kind: 'easy_walk', noun: 'nature reserve', durationMinutes: 120, intensity: 'easy', exposure: 'outdoor', rainyDayOk: false, interests: ['easy_nature_walks', 'wildlife'] },
  'amenity=marketplace': { kind: 'market', noun: 'market', durationMinutes: 75, intensity: 'easy', exposure: 'mixed', rainyDayOk: false },
  'amenity=place_of_worship': { kind: 'religious_site', noun: 'place of worship', durationMinutes: 45, intensity: 'none', exposure: 'indoor', rainyDayOk: true },
  'place=town': { kind: 'small_town', noun: 'town', durationMinutes: 150, intensity: 'easy', exposure: 'mixed', rainyDayOk: false },
  'place=village': { kind: 'small_town', noun: 'village', durationMinutes: 120, intensity: 'easy', exposure: 'mixed', rainyDayOk: false },
};

const SHRINE_RELIGIONS = new Set(['buddhist', 'shinto', 'hindu', 'jain', 'taoist', 'sikh']);

/** Memorial subtypes (OSM `memorial=*`, `artwork_type=*`) that are street furniture rather than somewhere to go. */
export const MINOR_MEMORIALS: ReadonlySet<string> = new Set(['statue', 'bust', 'plaque', 'blue_plaque', 'stolperstein', 'stone', 'stele', 'cross', 'ghost_bike', 'bench', 'tree', 'sculpture', 'relief', 'tablet']);

/** Which entry of `TAG_KINDS` an element answers, or null when it is none of them. */
export function kindForTags(tags: Readonly<Record<string, string>>): { tag: string; spec: KindSpec } | null {
  for (const selector of [...NOTABLE_SELECTORS, NOTABLE_SETTLEMENTS]) {
    const value = tags[selector.key];
    if (value === undefined || !selector.values.includes(value)) continue;
    const tag = `${selector.key}=${value}`;
    const spec = TAG_KINDS[tag];
    if (!spec) continue;
    /* A temple and a cathedral are both places of worship; the board has a word for each. */
    if (tag === 'amenity=place_of_worship' && SHRINE_RELIGIONS.has(tags.religion ?? '')) {
      return { tag, spec: { ...spec, kind: 'temple_or_shrine', noun: 'temple or shrine' } };
    }
    /*
     * A statue, a bust or a plaque is a memorial a traveller passes, not one
     * they set out for: a Wikidata link on it usually names the person it
     * commemorates. A live Zurich evaluation filled a museum lover's weekend
     * with six statues this way. The map's own subtype says which is which.
     */
    if ((tag === 'historic=memorial' || tag === 'historic=monument') && (MINOR_MEMORIALS.has(tags.memorial ?? '') || MINOR_MEMORIALS.has(tags.artwork_type ?? ''))) return null;
    /* `natural=water` is any water; only a lake, reservoir or river is something to visit. */
    if (tag === 'natural=water' && tags.water && !['lake', 'reservoir', 'river', 'lagoon', 'oxbow'].includes(tags.water)) return null;
    return { tag, spec };
  }
  return null;
}

/** Latin script (with Latin Extended and general punctuation): the same test `normalizeElement` uses. */
function isLatin(text: string): boolean {
  return !/[^\u0020-\u024F\u1E00-\u1EFF\u2000-\u206F]/.test(text);
}

/**
 * The name a traveller can read: the published name when it is Latin script,
 * else the map's English or Latin-script name when it has one, else the name as
 * published (never transliterated by us). `localName` is the published name
 * when it differs from what is shown.
 */
export function displayNameFor(tags: Readonly<Record<string, string>>): { name: string; localName?: string } | null {
  const primary = tags.name?.trim();
  if (!primary) return null;
  if (isLatin(primary)) return { name: primary };
  const readable = (tags['name:en'] ?? tags['name:latin'] ?? tags.int_name)?.trim();
  return readable ? { name: readable, localName: primary } : { name: primary };
}

/** Half the side of the box, in km, by the destination's scale; a car-free broad trip looks less far. */
export function boxHalfKmFor(scale: string | undefined, carAvailable: boolean | null, reachKm: number): number {
  const byScale =
    scale === 'local' ? 6 : scale === 'city' || scale === undefined ? 12 : scale === 'subregion' ? 50 : scale === 'region' ? 90 : 150;
  const broad = !(scale === 'local' || scale === 'city' || scale === undefined);
  /*
   * Without a car a region is explored from a base by local transport, so the
   * box is kept tight. A whole country is not: a car-free trip there is a rail
   * trip between bases, and a 40 km box around a country's centroid (a live
   * car-free Switzerland evaluation) offers nine villages and no sights.
   */
  const national = scale === 'country' || scale === 'multi_country' || scale === 'continental';
  const carCap = carAvailable === false && broad ? (national ? 120 : 40) : Infinity;
  return Math.max(4, Math.min(byScale, carCap, reachKm));
}

/** A box around a point, clamped to `MAX_BBOX_DEGREES` on each side. */
export function boxAround(center: { lat: number; lng: number }, halfKm: number): BoundingBox {
  const dLat = Math.min(MAX_BBOX_DEGREES / 2, halfKm / 111);
  const dLng = Math.min(MAX_BBOX_DEGREES / 2, halfKm / (111 * Math.max(0.2, Math.cos((center.lat * Math.PI) / 180))));
  return clampBoundingBox({ south: center.lat - dLat, north: center.lat + dLat, west: center.lng - dLng, east: center.lng + dLng });
}

export interface OpenDataProposalInput {
  envelope: { name: string; center: { lat: number; lng: number }; scale?: string };
  days: number;
  /** The traveller's core and frequent interests. */
  priorities: readonly Interest[];
  carAvailable: boolean | null;
  /** How far from the centre a place may be (`placementReachKm`). */
  reachKm: number;
  /**
   * The ISO 3166-1 codes of the countries the destination is in. A row whose
   * source states only other countries is not part of this trip; a row that
   * states none is kept (unknown, never "elsewhere").
   */
  countries?: readonly string[];
  /**
   * The destination's own parts ("Lisbon and the Azores"). When they lie apart,
   * each is searched around its own centre: the union's centre of a mainland
   * city and an archipelago is open ocean.
   */
  parts?: readonly { label: string; center: { lat: number; lng: number } }[];
}

export interface OpenDataDeps {
  /** One selector group over one box, `wikidata`-tagged elements only. Throws when the map service refused. */
  fetchGroup: (box: BoundingBox, selector: Selector, wayAreaLimitDeg2: number) => Promise<OverpassResult>;
  /** Sitelink counts by Wikidata id; an id absent from the answer is unknown. Never throws. */
  fetchSitelinks: (ids: readonly string[]) => Promise<Map<string, number>>;
  /**
   * What Wikidata states about each pooled item — description, inception,
   * heritage, architect, style — in one batched request. Optional: without it
   * every place is described by its category label alone. Never throws.
   */
  fetchDetails?: (ids: readonly string[]) => Promise<Map<string, WikidataPlaceDetails>>;
  /** What answered, for the diagnostics and the source manifest. */
  source: 'openstreetmap+wikidata' | 'fixture-open-data';
}

export interface OpenDataDiagnostics {
  boxHalfKm: number;
  groups: number;
  failedGroups: string[];
  elements: number;
  usable: number;
  sitelinksAsked: number;
  sitelinksAnswered: number;
  /** Pool items whose Wikidata details were asked for, and how many answered. */
  detailsAsked: number;
  detailsAnswered: number;
  settlements: number;
  kept: number;
  bases: number;
  /** Rows dropped because their source placed them only in other countries. */
  outsideCountries?: number;
  /** How many centres were searched: one, or one per part of a destination in parts. */
  searchCentres?: number;
}

export type OpenDataProposalResult =
  | {
      ok: true;
      proposal: ScanProposal;
      normalized: Extract<ScanProposalNormalization, { ok: true }>;
      positions: Map<string, ResolvedPosition | null>;
      /** How many candidates were offered to the normaliser. */
      offered: number;
      diagnostics: OpenDataDiagnostics;
    }
  | { ok: false; reason: 'map_data_unavailable' | 'too_few_places'; detail: string; diagnostics: OpenDataDiagnostics };

/** A mapped thing, read: what it is, where, and how much attention it gets. */
export interface OpenDataPlace {
  elementId: string;
  wikidata: string;
  name: string;
  localName?: string;
  tag: string;
  spec: KindSpec;
  coordinates: { lat: number; lng: number };
  distanceKm: number;
  tags: Readonly<Record<string, string>>;
  /** Wikimedia sitelinks, when Wikidata answered for this id. */
  sitelinks?: number;
  score: number;
  matched: Interest[];
}

/** An element as an `OpenDataPlace`, or null when it is unnamed, untagged, unplaceable or not something to visit. */
export function readElement(element: OverpassElement, center: { lat: number; lng: number }, priorities: readonly Interest[]): OpenDataPlace | null {
  const tags = element.tags ?? {};
  const wikidata = tags.wikidata?.trim();
  if (!wikidata || !/^Q\d+$/.test(wikidata)) return null;
  const named = displayNameFor(tags);
  const coordinates = elementCoordinates(element);
  const kind = kindForTags(tags);
  if (!named || !coordinates || !kind) return null;
  const interests = kind.spec.interests ?? [...SCAN_KIND_PROFILES[kind.spec.kind].interests];
  const matched = interests.filter((i) => priorities.includes(i));
  return {
    elementId: elementId(element),
    wikidata,
    name: named.name,
    ...(named.localName ? { localName: named.localName } : {}),
    tag: kind.tag,
    spec: { ...kind.spec, interests },
    coordinates,
    distanceKm: haversineKm(center, coordinates),
    tags,
    score: 0,
    matched,
  };
}

const normal = (name: string) => name.normalize('NFKD').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** Before Wikidata answers: interest match first, then the map's own hints of notability, then nearness. */
function preScore(p: OpenDataPlace, halfKm: number): number {
  return (p.matched.length > 0 ? 2 : 0) + (p.tags.wikipedia ? 1 : 0) + (p.tags.heritage ? 0.5 : 0) - Math.min(1, p.distanceKm / Math.max(1, halfKm)) * 0.5;
}

/**
 * The final order: attention (log sitelinks, scaled to the best in this pool)
 * weighted 0.65, a match with the traveller's priority interests 0.35. Where
 * Wikidata did not answer for an id, a `wikipedia` tag stands in at a modest
 * value — unknown is never read as "nobody wrote about it".
 */
export function rankPlaces(places: readonly OpenDataPlace[]): OpenDataPlace[] {
  const best = Math.max(1, ...places.map((p) => p.sitelinks ?? 0));
  return places
    .map((p) => {
      const attention = p.sitelinks !== undefined ? Math.log1p(p.sitelinks) / Math.log1p(best) : p.tags.wikipedia ? 0.3 : 0.1;
      return { ...p, score: attention * 0.65 + (p.matched.length > 0 ? 0.35 : 0) };
    })
    .sort((a, b) => b.score - a.score || (b.sitelinks ?? 0) - (a.sitelinks ?? 0) || a.distanceKm - b.distanceKm || a.elementId.localeCompare(b.elementId));
}

/** One identity per Wikidata item, then one per name within 1.5 km — the higher-ranked copy wins. Input must be ranked. */
export function dedupePlaces(ranked: readonly OpenDataPlace[]): OpenDataPlace[] {
  const kept: OpenDataPlace[] = [];
  const items = new Set<string>();
  for (const p of ranked) {
    if (items.has(p.wikidata)) continue;
    if (kept.some((k) => normal(k.name) === normal(p.name) && haversineKm(k.coordinates, p.coordinates) <= 1.5)) continue;
    items.add(p.wikidata);
    kept.push(p);
  }
  return kept;
}

/** The pool, in rank order, no kind taking more than a quarter of it (at least three), so a peak-dense range or a church-dense city still offers a mix. */
export function selectPool(ranked: readonly OpenDataPlace[], size: number): OpenDataPlace[] {
  const cap = Math.max(3, Math.ceil(size * 0.25));
  /*
   * Six scan kinds (landmark, historic site, castle, religious site, temple,
   * theme park) are one board category, `historic_site`. Capping only the kind
   * let a live Zurich pool hold eighteen historic sites of twenty-eight — ruins,
   * statues and castle sites — for a traveller whose core interest was museums.
   * The category the traveller sees is capped too, at two fifths.
   */
  const categoryCap = Math.max(4, Math.ceil(size * 0.4));
  const perKind = new Map<ScanKind, number>();
  const perCategory = new Map<string, number>();
  const pool: OpenDataPlace[] = [];
  for (const p of ranked) {
    if (pool.length >= size) break;
    const n = perKind.get(p.spec.kind) ?? 0;
    const category = SCAN_KIND_PROFILES[p.spec.kind].category;
    const c = perCategory.get(category) ?? 0;
    if (n >= cap || c >= categoryCap) continue;
    perKind.set(p.spec.kind, n + 1);
    perCategory.set(category, c + 1);
    pool.push(p);
  }
  return pool;
}

/** Further than this from the centre is a deliberate trip out: a side quest. */
export function sideQuestKmFor(scale: string | undefined): number {
  return scale === 'local' || scale === 'city' || scale === undefined ? 25 : 40;
}

/**
 * Classic, hidden gem or side quest. Far → side quest; otherwise the top third
 * of the pool by sitelinks (only places Wikidata actually counted) → classic;
 * the rest → hidden gem, which here means "mapped and linked, less written
 * about" — never a claim that a local would recommend it.
 */
export function tierPlaces(pool: readonly OpenDataPlace[], scale: string | undefined): Map<string, 'classic' | 'hidden_gem' | 'side_quest'> {
  const far = sideQuestKmFor(scale);
  const counted = pool.filter((p) => (p.sitelinks ?? 0) > 0).sort((a, b) => (b.sitelinks ?? 0) - (a.sitelinks ?? 0));
  const classic = new Set(counted.slice(0, Math.ceil(pool.length / 3)).map((p) => p.elementId));
  return new Map(pool.map((p) => [p.elementId, p.distanceKm > far ? 'side_quest' : classic.has(p.elementId) ? 'classic' : 'hidden_gem']));
}

interface Settlement {
  elementId: string;
  wikidata?: string;
  fromWikidata: boolean;
  name: string;
  coordinates: { lat: number; lng: number };
  place: string;
  population: number;
  distanceKm: number;
}

function readSettlement(element: OverpassElement, center: { lat: number; lng: number }): Settlement | null {
  const tags = element.tags ?? {};
  const named = displayNameFor(tags);
  const coordinates = elementCoordinates(element);
  if (!named || !coordinates || !tags.place || !NOTABLE_SETTLEMENTS.values.includes(tags.place)) return null;
  const population = Number(String(tags.population ?? '').replace(/[ ,.]/g, ''));
  return { elementId: elementId(element), ...(tags.wikidata ? { wikidata: tags.wikidata } : {}), fromWikidata: tags['source:sidequest'] === 'wikidata', name: named.name, coordinates, place: tags.place, population: Number.isFinite(population) ? population : 0, distanceKm: haversineKm(center, coordinates) };
}

/** Where a place's position came from, named truthfully: an OpenStreetMap element, or a Wikidata item (`providers/wikidata-around.ts`). */
function sourceRef(p: OpenDataPlace): { provider: string; providerRef: string } {
  return p.tags['source:sidequest'] === 'wikidata' ? { provider: 'wikidata', providerRef: `wikidata:${p.wikidata}` } : { provider: 'openstreetmap', providerRef: `osm:${p.elementId}` };
}
function townSource(t: Settlement): { wikidata?: string; fromWikidata: boolean } {
  return { ...(t.wikidata ? { wikidata: t.wikidata } : {}), fromWikidata: t.fromWikidata };
}

/**
 * The open-data proposal. Never throws; a failure is typed and the caller
 * reports the model's original cause.
 */
export async function proposeFromOpenData(input: OpenDataProposalInput, deps: OpenDataDeps): Promise<OpenDataProposalResult> {
  const { envelope, priorities } = input;
  const center = envelope.center;
  const halfKm = boxHalfKmFor(envelope.scale, input.carAvailable, input.reachKm);
  /*
   * WHERE TO LOOK. One box around the centre, unless the destination's parts
   * lie outside it — then one box around each part (parts within a box of one
   * another share it). Distances are measured from the nearest of those centres.
   */
  const anchors: { label: string; center: { lat: number; lng: number } }[] = [];
  const parts = input.parts ?? [];
  if (parts.length >= 2 && parts.some((part) => haversineKm(center, part.center) > halfKm)) {
    for (const part of parts) if (!anchors.some((a) => haversineKm(a.center, part.center) < halfKm)) anchors.push(part);
  }
  const spread = anchors.length >= 2;
  const searchCentres = spread ? anchors.map((a) => a.center) : [center];
  const boxes = searchCentres.map((c) => boxAround(c, halfKm));
  const nearestKm = (point: { lat: number; lng: number }) => Math.min(...searchCentres.map((c) => haversineKm(c, point)));
  const countries = new Set((input.countries ?? []).map((c) => c.toUpperCase()));
  /* A row its source places only in other countries is not this trip ("Switzerland" once slept in Como). */
  const inTheseCountries = (element: OverpassElement): boolean => {
    const stated = element.tags?.['sidequest:countries'];
    if (countries.size === 0 || !stated) return true;
    return stated.split(',').some((code) => countries.has(code));
  };
  const broad = !(envelope.scale === 'local' || envelope.scale === 'city' || envelope.scale === undefined);
  /*
   * On a broad trip the towns are asked for first. They are where the traveller
   * sleeps, and the groups share one stage deadline: asked last, they were the
   * group a slow public endpoint starved, and a live Switzerland evaluation
   * slept ten nights at the country's centroid ("Switzerland", 10 nights) with
   * the geographic-centre marker scheduled as a sight.
   */
  const groups = broad ? [NOTABLE_SETTLEMENTS, ...NOTABLE_SELECTORS] : [...NOTABLE_SELECTORS];
  const diagnostics: OpenDataDiagnostics = { boxHalfKm: halfKm, groups: groups.length, failedGroups: [], elements: 0, usable: 0, sitelinksAsked: 0, sitelinksAnswered: 0, detailsAsked: 0, detailsAnswered: 0, settlements: 0, kept: 0, bases: 0 };

  // --- 1. what is mapped here ------------------------------------------------------
  const elements: OverpassElement[] = [];
  const settlementElements: OverpassElement[] = [];
  let outsideCountries = 0;
  for (const selector of groups) {
    let answered = 0;
    for (const box of boxes) {
      try {
        const result = await deps.fetchGroup(box, selector, NOTABLE_WAY_AREA_LIMIT_DEG2);
        const kept = result.elements.filter(inTheseCountries);
        outsideCountries += result.elements.length - kept.length;
        (selector === NOTABLE_SETTLEMENTS ? settlementElements : elements).push(...kept);
        answered += 1;
      } catch {
        /* one box refused; the group failed only if every box did */
      }
    }
    if (answered === 0) diagnostics.failedGroups.push(selector.key);
  }
  diagnostics.outsideCountries = outsideCountries;
  diagnostics.searchCentres = searchCentres.length;
  diagnostics.elements = elements.length + settlementElements.length;
  if (diagnostics.failedGroups.length === groups.length) {
    return { ok: false, reason: 'map_data_unavailable', detail: 'every map data request was refused', diagnostics };
  }
  /*
   * Towns are where to sleep, not what to do. When every group of things to
   * see was refused and only the settlements answered, the proposal would be a
   * board of suburbs: a live car-free Tokyo evaluation got five days of
   * "Matsubushi 150 min", "Hatoyama 150 min" and a base moved to Sakado. That
   * is the map service failing, said as such.
   */
  if (NOTABLE_SELECTORS.every((selector) => diagnostics.failedGroups.includes(selector.key))) {
    return { ok: false, reason: 'map_data_unavailable', detail: 'every request for things to see was refused; only towns answered', diagnostics };
  }

  const settlements = settlementElements
    .map((e) => readSettlement(e, center))
    .map((s) => (s && spread ? { ...s, distanceKm: nearestKm(s.coordinates) } : s))
    .filter((s, i, all): s is Settlement => s !== null && s.distanceKm <= input.reachKm && all.findIndex((o) => o?.elementId === s.elementId) === i);
  diagnostics.settlements = settlements.length;

  // --- 2. read, filter, first order -------------------------------------------------
  const destination = normal(envelope.name);
  const seenElements = new Set<string>();
  const usable = [...elements, ...settlementElements.filter((e) => e.tags?.place === 'town' || e.tags?.place === 'village')]
    .map((e) => readElement(e, center, priorities))
    .map((p) => (p && spread ? { ...p, distanceKm: nearestKm(p.coordinates) } : p))
    .filter((p): p is OpenDataPlace => {
      if (!p || seenElements.has(p.elementId)) return false;
      seenElements.add(p.elementId);
      /* The destination itself is where the trip is, not a thing to do in it; a town at the very centre is the same. */
      if (normal(p.name) === destination) return false;
      if (p.spec.kind === 'small_town' && p.distanceKm < 5) return false;
      return p.distanceKm <= input.reachKm;
    });
  diagnostics.usable = usable.length;

  // --- 3. how much attention each gets (Wikidata), then the final order -----------------
  /*
   * A destination in parts gets each part's share of every cut: ranked by
   * attention alone, a capital's monuments took every slot and the islands the
   * traveller named arrived on the board as nothing at all.
   */
  const partOf = (point: { lat: number; lng: number }) => searchCentres.reduce((best, c, i) => (haversineKm(c, point) < haversineKm(searchCentres[best]!, point) ? i : best), 0);
  const cut = (ordered: readonly OpenDataPlace[], size: number): OpenDataPlace[] => {
    if (!spread) return selectPool(ordered, size);
    const share = Math.ceil(size / anchors.length);
    const picked = anchors.flatMap((_, i) => selectPool(ordered.filter((p) => partOf(p.coordinates) === i), share));
    return selectPool([...picked, ...ordered.filter((p) => !picked.includes(p))], size);
  };
  const preRanked = cut(
    [...usable].sort((a, b) => preScore(b, halfKm) - preScore(a, halfKm) || a.elementId.localeCompare(b.elementId)),
    MAX_SITELINK_IDS,
  );
  const ids = [...new Set(preRanked.map((p) => p.wikidata))];
  diagnostics.sitelinksAsked = ids.length;
  let counts = new Map<string, number>();
  try {
    counts = await deps.fetchSitelinks(ids);
  } catch {
    /* unknown, never zero */
  }
  diagnostics.sitelinksAnswered = counts.size;
  const ranked = dedupePlaces(rankPlaces(preRanked.map((p) => (counts.has(p.wikidata) ? { ...p, sitelinks: counts.get(p.wikidata)! } : p))));
  const pool = cut(ranked, Math.min(MAX_POOL, scanCandidateTarget(input.days).max));
  const tiers = tierPlaces(pool, envelope.scale);

  // --- 4. where to sleep ----------------------------------------------------------------
  const positions = new Map<string, ResolvedPosition | null>();
  const nights = Math.max(1, input.days - 1);
  const towns = settlements.filter((s) => s.place === 'city' || s.place === 'town').sort((a, b) => b.population - a.population || a.distanceKm - b.distanceKm);
  const primaryTown = broad ? towns.find((t) => t.distanceKm <= Math.max(15, halfKm * 0.35)) : undefined;
  const bases: { name: string; coordinates: { lat: number; lng: number }; elementId?: string; wikidata?: string; fromWikidata?: boolean; nightsHint: number; why: string; near?: number }[] = [
    primaryTown
      ? { name: primaryTown.name, coordinates: primaryTown.coordinates, elementId: primaryTown.elementId, ...townSource(primaryTown), nightsHint: nights, why: `The largest mapped town near the middle of ${envelope.name}, so most of the places below are within reach of it.` }
      : spread
        ? { name: anchors[0]!.label, coordinates: anchors[0]!.center, nightsHint: nights, why: `${anchors[0]!.label} itself; the places near it are measured from here.` }
        : { name: envelope.name, coordinates: center, nightsHint: nights, why: `${envelope.name} itself; the places below are measured from here.` },
  ];
  if (broad && input.days >= 5) {
    const extra = input.days >= 9 ? 2 : 1;
    const spacing = Math.max(40, halfKm * 0.5);
    for (const town of towns) {
      if (bases.length > extra) break;
      if (bases.some((b) => haversineKm(b.coordinates, town.coordinates) < spacing)) continue;
      const near = pool.filter((p) => haversineKm(p.coordinates, town.coordinates) <= 45).length;
      if (near < 3) continue;
      bases.push({ name: town.name, coordinates: town.coordinates, elementId: town.elementId, ...townSource(town), nightsHint: 2, near, why: `A mapped town with ${near} of the places below within about 45 km.` });
    }
    if (bases.length > 1) bases[0]!.nightsHint = Math.max(1, nights - 2 * (bases.length - 1));
  }
  /* A destination in parts sleeps in each part: nobody commutes from Lisbon to the Azores. */
  if (spread) {
    for (const anchor of anchors) {
      if (bases.some((b) => haversineKm(b.coordinates, anchor.center) <= halfKm)) continue;
      const town = towns.find((t) => haversineKm(t.coordinates, anchor.center) <= halfKm);
      bases.push(
        town
          ? { name: town.name, coordinates: town.coordinates, elementId: town.elementId, ...townSource(town), nightsHint: 2, why: `The largest mapped town in ${anchor.label}, one of the parts of this trip.` }
          : { name: anchor.label, coordinates: anchor.center, nightsHint: 2, why: `${anchor.label} itself, one of the parts of this trip.` },
      );
    }
    if (bases.length > 1) {
      const each = Math.max(1, Math.floor(nights / bases.length));
      bases.forEach((b, i) => (b.nightsHint = i === 0 ? Math.max(1, nights - each * (bases.length - 1)) : each));
    }
  }
  diagnostics.bases = bases.length;

  // --- 5. what each place is, from what its sources state (one batched request) -------------
  const detailIds = [...new Set(pool.map((p) => p.wikidata))];
  diagnostics.detailsAsked = deps.fetchDetails ? detailIds.length : 0;
  let details = new Map<string, WikidataPlaceDetails>();
  if (deps.fetchDetails && detailIds.length > 0) {
    try {
      details = await deps.fetchDetails(detailIds);
    } catch {
      /* unknown, never false: the label stands */
    }
  }
  diagnostics.detailsAnswered = detailIds.filter((id) => details.has(id)).length;
  const descriptions = describePool(pool.map((p) => ({ key: p.elementId, noun: p.spec.noun, kind: p.spec.kind, tags: p.tags, details: details.get(p.wikidata) })));

  // --- 6. the proposal, through the same normaliser the model's answer goes through ----------
  const localityFor = (p: OpenDataPlace): string => {
    const city = p.tags['addr:city']?.trim();
    if (city) return city;
    if (p.spec.kind === 'small_town') return p.name;
    const nearest = settlements
      .map((s) => ({ s, km: haversineKm(s.coordinates, p.coordinates) }))
      .filter((x) => x.km <= 12)
      .sort((a, b) => a.km - b.km)[0];
    if (nearest && broad) return nearest.s.name;
    /* In a destination in parts a place is in its part ("Azores"), never in the whole phrase ("Lisbon and the Azores"). */
    return spread ? anchors[partOf(p.coordinates)]!.label : envelope.name;
  };
  const sources = new Map<string, OpenDataPlace>();
  /* A town chosen to sleep in is a base, not also a thing to do. */
  const baseNames = new Set(bases.map((b) => normal(b.name)));
  const candidates = pool.filter((p) => !baseNames.has(normal(p.name))).map((p) => {
    const locality = localityFor(p);
    sources.set(`${p.name.toLowerCase()}|${locality.toLowerCase()}`, p);
    return {
      name: p.name,
      ...(p.localName ? { localName: p.localName } : {}),
      locality,
      kind: p.spec.kind,
      tier: tiers.get(p.elementId) ?? 'hidden_gem',
      durationMinutes: p.spec.durationMinutes,
      intensity: p.spec.intensity,
      costLevel: p.spec.costLevel ?? (p.tags.fee === 'no' ? 0 : 1),
      exposure: p.spec.exposure,
      bestTime: 'any',
      crowd: 'moderate',
      booking: 'none',
      rainyDayOk: p.spec.rainyDayOk,
      interests: p.spec.interests ?? [],
      why: descriptions.get(p.elementId) ?? p.spec.noun,
      ...(p.spec.caution ? { caution: p.spec.caution } : {}),
    };
  });
  const raw = {
    bases: bases.map((b) => ({ name: b.name, locality: b.name, nightsHint: b.nightsHint, why: b.why })),
    candidates,
    foodAreas: [],
    skipped: [],
    package: {
      transportSummary: '',
      transportNotes: [],
      beforeYouGo: ['These places come from open map data: check opening hours, access and any tickets before you go.'],
      packing: [],
      foodStrategy: [],
      bookingPriorities: [],
    },
  };
  const normalized = normalizeScanProposal(raw);
  if (!normalized.ok || normalized.proposal.candidates.length < MIN_OPEN_DATA_PLACES) {
    diagnostics.kept = normalized.ok ? normalized.proposal.candidates.length : 0;
    return { ok: false, reason: 'too_few_places', detail: `only ${diagnostics.kept} notable mapped places near ${envelope.name}`, diagnostics };
  }
  normalized.proposal.bases.forEach((base, i) => {
    const b = bases[i]!;
    positions.set(
      base.key,
      b.elementId
        ? { coordinates: b.coordinates, method: 'places', ...(b.fromWikidata ? { provider: 'wikidata', providerRef: `wikidata:${b.wikidata}` } : { provider: 'openstreetmap', providerRef: `osm:${b.elementId}` }), approximate: false, locality: b.name }
        : { coordinates: b.coordinates, method: 'geocoder', provider: 'destination-centre', approximate: false },
    );
  });
  for (const c of normalized.proposal.candidates) {
    const p = sources.get(`${c.name.toLowerCase()}|${c.locality.toLowerCase()}`);
    positions.set(c.key, p ? { coordinates: p.coordinates, method: 'places', ...sourceRef(p), wikidataId: p.wikidata, approximate: false, locality: c.locality } : null);
  }
  diagnostics.kept = normalized.proposal.candidates.length;
  return { ok: true, proposal: normalized.proposal, normalized, positions, offered: candidates.length, diagnostics };
}

/**
 * The live sources, Wikidata first.
 *
 * Production pass — one Wikidata Query Service request (`fetchWikidataAround`)
 * answers "what notable, coordinate-bearing things are near here, and how much
 * has been written about each" in about a second, from an operator other than
 * the volunteer Overpass instances that a 30-trip evaluation found throttling
 * every scan after the third. Its items arrive as map-shaped elements with tags
 * derived from their own type, so everything downstream is unchanged.
 *
 * Overpass (or `SIDEQUEST_POI_URL`) is still asked — it knows mapped detail
 * Wikidata does not — but only while the Wikidata answer is thin for a group,
 * and never again in this scan once it has refused (the provider also cools a
 * failing endpoint down for every caller). Its elements are merged; the same
 * place from both sources is one place, by its Wikidata id.
 */
const ENOUGH_FROM_WIKIDATA = 25;
export function liveOpenDataDeps(now: number = Date.now()): OpenDataDeps {
  const deadlineMs = now + STAGE_BUDGET_MS;
  const overpassCache = cacheFor<OverpassResult>('overpass-notable', TTL.poi);
  const sitelinkCache = cacheFor<Record<string, number>>('wikidata-sitelinks', TTL.poi);
  const aroundCache = cacheFor<{ elements: OverpassElement[]; sitelinks: Record<string, number> }>('wikidata-around', TTL.poi);
  const detailsCache = cacheFor<Record<string, WikidataPlaceDetails>>('wikidata-details', TTL.poi);
  /* One Wikidata answer per box asked: a destination in parts asks around each part, and must not be handed the first part's answer for the second. */
  const arounds = new Map<string, Promise<WikidataAroundResult | null>>();
  let overpassRefused = false;
  const wikidataFor = (box: BoundingBox): Promise<WikidataAroundResult | null> => {
    const boxKey = [box.south, box.west, box.north, box.east].map((v) => v.toFixed(3)).join(',');
    const known = arounds.get(boxKey);
    if (known) return known;
    const around = (async () => {
      const center = { lat: (box.north + box.south) / 2, lng: (box.east + box.west) / 2 };
      const radiusKm = Math.min(150, haversineKm(center, { lat: box.north, lng: box.east }));
      const minSitelinks = radiusKm > 40 ? 6 : 10;
      /* Cached like every provider answer, so a destination already looked up never asks the shared query service again. */
      const key = `wikidata-around|v2|${center.lat.toFixed(2)},${center.lng.toFixed(2)}|${Math.round(radiusKm)}|${minSitelinks}`;
      const cached = aroundCache.read(key);
      if (cached) return { elements: cached.elements, sitelinks: new Map(Object.entries(cached.sitelinks)) };
      try {
        const fresh = await fetchWikidataAround(center, radiusKm, { minSitelinks, deadlineMs });
        if (fresh.elements.length > 0) aroundCache.write(key, { elements: fresh.elements, sitelinks: Object.fromEntries(fresh.sitelinks) });
        return fresh;
      } catch (error) {
        console.warn('Open-data scan: the Wikidata query service did not answer', error instanceof Error ? error.message : error);
        return null;
      }
    })();
    arounds.set(boxKey, around);
    return around;
  };
  const matches = (element: OverpassElement, selector: Selector) => selector.values.includes(element.tags?.[selector.key] ?? '');
  return {
    source: 'openstreetmap+wikidata',
    fetchGroup: async (box, selector, wayAreaLimitDeg2) => {
      const wikidata = await wikidataFor(box);
      const fromWikidata = (wikidata?.elements ?? []).filter((e) => matches(e, selector));
      const thingsToSee = (wikidata?.elements ?? []).filter((e) => !e.tags?.place).length;
      const answer = (elements: OverpassElement[], calls: number): OverpassResult => ({ elements, dataTimestamp: null, calls, cacheHit: false, bytes: 0, failedGroups: [] });
      if (overpassRefused || (thingsToSee >= ENOUGH_FROM_WIKIDATA && selector !== NOTABLE_SETTLEMENTS)) {
        if (fromWikidata.length > 0 || wikidata) return answer(fromWikidata, 0);
        throw new Error('no open map data source answered');
      }
      try {
        const overpass = await fetchNotablePois(box, selector, { limit: GROUP_LIMIT, cache: overpassCache, deadlineMs }, wayAreaLimitDeg2);
        const known = new Set(overpass.elements.map((e) => e.tags?.wikidata).filter(Boolean));
        return { ...overpass, elements: [...overpass.elements, ...fromWikidata.filter((e) => !known.has(e.tags?.wikidata))] };
      } catch (error) {
        overpassRefused = true;
        if (wikidata) return answer(fromWikidata, 0);
        throw error;
      }
    },
    fetchDetails: (ids) => fetchWikidataDetails(ids, { cache: detailsCache, deadlineMs }),
    fetchSitelinks: async (ids) => {
      const answers = await Promise.all(arounds.values());
      const counts = new Map<string, number>();
      const missing: string[] = [];
      for (const id of ids) {
        const n = answers.map((a) => a?.sitelinks.get(id)).find((v) => v !== undefined);
        if (n === undefined) missing.push(id);
        else counts.set(id, n);
      }
      if (missing.length > 0) {
        for (const [id, n] of (await fetchWikidataSitelinkCounts(missing, { maxIds: MAX_SITELINK_IDS, cache: sitelinkCache })).counts) counts.set(id, n);
      }
      return counts;
    },
  };
}

interface RecordedElement {
  type: 'node' | 'way';
  id: number;
  dLat: number;
  dLng: number;
  tags: Record<string, string>;
  sitelinks?: number;
}

/**
 * The recorded open-data answer for the fixture switches: map elements written
 * as offsets from the box's centre (so a fixture destination anywhere gets
 * places around it) and names templated on the destination (`{d}`), plainly
 * synthetic so a fixture can never pass for real research. No network.
 */
export function fixtureOpenDataDeps(destinationName: string): OpenDataDeps {
  const d = destinationName.trim() || 'Destination';
  const rows = (recorded as unknown as { elements: RecordedElement[] }).elements;
  const tagsOf = (row: RecordedElement) => Object.fromEntries(Object.entries(row.tags).map(([k, v]) => [k, v.replace(/\{d\}/g, d)]));
  return {
    source: 'fixture-open-data',
    fetchGroup: async (box, selector) => {
      const lat = (box.north + box.south) / 2;
      const lng = (box.east + box.west) / 2;
      const elements: OverpassElement[] = rows
        .filter((row) => selector.values.includes(row.tags[selector.key] ?? ''))
        .map((row) => ({ type: row.type, id: row.id, ...(row.type === 'node' ? { lat: lat + row.dLat, lon: lng + row.dLng } : { center: { lat: lat + row.dLat, lon: lng + row.dLng } }), tags: tagsOf(row) }));
      return { elements, dataTimestamp: null, calls: 0, cacheHit: false, bytes: 0, failedGroups: [] };
    },
    fetchSitelinks: async (ids) => new Map(rows.filter((r) => r.tags.wikidata && ids.includes(r.tags.wikidata) && r.sitelinks !== undefined).map((r) => [r.tags.wikidata!, r.sitelinks!])),
  };
}
