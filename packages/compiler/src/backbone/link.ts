import type { CandidateLink, LinkEvidence, SourceRecord } from '@sidequest/core';
import { normalizeName } from '../dedupe';
import { isLandscapeScale } from './taxonomy';

/**
 * WORKING OUT WHICH RECORDS ARE THE SAME THING, WITHOUT ASKING ANYONE.
 *
 * Records arrive from several layers under several licences. A famous park
 * appears in the primary place catalogue as a business-style record and in the
 * geographic layer as a polygon; a ferry terminal appears in both; a museum
 * appears twice in the primary catalogue because two upstream providers
 * contributed it and the conflation missed.
 *
 * The instinct is to merge them. The instinct is wrong, twice over:
 *
 * - **Licences.** Blending a share-alike record into a permissive one produces a
 *   record whose licence nobody chose. Layers stay separate; links reference
 *   across them.
 * - **Precision.** Merging is irreversible and identity here is often only
 *   probable. A park and its trailhead sit ninety metres apart with similar
 *   names, and they are not the same thing.
 *
 * So this produces *relationships*, not merges, and only from evidence anyone
 * could check: an id both sources published, a domain both sources published, a
 * name plus a compatible category plus a distance. A model is never asked.
 *
 * Anything weaker than `probable_same_entity` keeps both records. The
 * candidate-quality layer already refuses to schedule a duplicate and a parent
 * on the same day; guessing here would delete a real place instead.
 */

/**
 * How close two records have to be before a name match means anything, by how
 * big the thing is.
 *
 * A named valley's recorded point and a named viewpoint inside it can be a
 * kilometre apart and be the same feature; two cafés forty metres apart on the
 * same street are two cafés. So the radius scales with what kind of thing it is
 * rather than being one number that is wrong at both ends.
 */
const PROXIMITY_METRES: Record<string, number> = {
  attraction: 260,
  support: 160,
  food: 60,
  lodging: 90,
  administrative: 2_000,
  excluded: 120,
};

/** Metres inside which a point may be treated as sitting *within* a named area. */
const CONTAINMENT_METRES = 1_200;

/**
 * How far apart two records may be and still be one thing, given how big they
 * are.
 *
 * The role radius alone is wrong for large features, and a live Bali run showed
 * exactly how: a volcano appears in the place catalogue at its visitor entrance
 * and in the terrain layer at its summit, four kilometres apart and under the
 * same name, so the two never linked and the board offered *Gunung Agung* twice.
 * A feature that covers ten kilometres of ground can have its representative
 * point anywhere inside it, so the radius grows with the published boundary —
 * and only with a *published* one, never with an assumed radius.
 *
 * Capped, because "both records are enormous" must not become "everything near
 * both is the same thing".
 */
const MAX_FEATURE_PROXIMITY_METRES = 12_000;

/**
 * The radius a landscape-scale feature gets when nobody published its boundary.
 *
 * A peak mapped as a single node has no extent to read, and the whole point is
 * that its recorded point is arbitrary within the mountain. Five kilometres is
 * the honest scale of that arbitrariness, and it applies only when the *names
 * match exactly* — this widens the search for a twin, it does not widen what
 * counts as a match.
 */
const LANDSCAPE_PROXIMITY_METRES = 5_000;

function proximityFor(a: SourceRecord, b: SourceRecord): number {
  const base = Math.min(
    PROXIMITY_METRES[a.planningRole] ?? 200,
    PROXIMITY_METRES[b.planningRole] ?? 200,
  );
  const landscape =
    isLandscapeScale({ category: a.sourceCategory, path: a.sourceCategoryPath }) &&
    isLandscapeScale({ category: b.sourceCategory, path: b.sourceCategoryPath })
      ? LANDSCAPE_PROXIMITY_METRES
      : 0;
  const extent = Math.max(extentMetres(a), extentMetres(b)) / 2;
  return Math.min(MAX_FEATURE_PROXIMITY_METRES, Math.max(base, extent, landscape));
}

/** The diagonal of a record's own published boundary, or zero when it has none. */
function extentMetres(record: SourceRecord): number {
  if (!record.bounds) return 0;
  return metresBetween(record.bounds.southWest, record.bounds.northEast);
}

export interface LinkOptions {
  /** Hard cap on pairs examined, so a dense pack cannot become quadratic. */
  maxComparisons?: number;
}

/**
 * The ceiling on pairs examined, and why it is this high.
 *
 * A live Bali build hit the previous 400,000 and stopped linking part-way
 * through, which showed up as the same volcano on the board twice — the pair had
 * simply never been compared. Comparison is cheap now that names are normalised
 * once per record rather than once per pair, so the ceiling can sit where it is
 * a runaway guard rather than a working limit.
 */
export const DEFAULT_MAX_COMPARISONS = 3_000_000;

/**
 * Link every record against every other record that could plausibly be it.
 *
 * Blocked by a coarse geographic key rather than compared pairwise across the
 * whole pack: at a few thousand records a full cross-product is a hundred
 * thousand string comparisons per pack build, and at Bali's density it is
 * millions. The blocking key is a hundredth of a degree — about a kilometre —
 * and every record is checked against its own cell and the eight around it, so a
 * pair straddling a key boundary is still compared.
 */
export function linkRecords(
  records: readonly SourceRecord[],
  options: LinkOptions = {},
): CandidateLink[] {
  const maxComparisons = options.maxComparisons ?? DEFAULT_MAX_COMPARISONS;

  const buckets = new Map<string, SourceRecord[]>();
  for (const record of records) {
    const key = bucketKey(record.coordinates);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(record);
    else buckets.set(key, [record]);
  }

  const seen = new Set<string>();
  const links: CandidateLink[] = [];
  let comparisons = 0;

  outer: for (const record of records) {
    for (const neighbour of neighbours(buckets, record.coordinates, searchRadiusCells(record))) {
      if (neighbour.id === record.id) continue;
      /**
       * Stop entirely rather than thinning.
       *
       * The previous version broke only the inner loop, so past the ceiling every
       * remaining record was "compared" against nothing and the run looked
       * complete. Stopping outright at least makes the truncation contiguous —
       * and the ceiling is now high enough that reaching it means something has
       * gone wrong rather than that a region is busy.
       */
      if (comparisons >= maxComparisons) break outer;
      comparisons += 1;

      const pairKey = [record.id, neighbour.id].sort().join('|');
      if (seen.has(pairKey)) continue;
      seen.add(pairKey);

      const link = compare(record, neighbour);
      if (link) links.push(link);
    }
  }

  /**
   * Sorted, because the pack's content hash includes them and a hash that
   * depends on iteration order cannot be compared between two runs.
   */
  return links.sort(
    (a, b) => a.recordIds[0]!.localeCompare(b.recordIds[0]!) || a.recordIds[1]!.localeCompare(b.recordIds[1]!),
  );
}

/**
 * One pair, and the strongest thing that can honestly be said about it.
 *
 * Exported so the adversarial cases — two branches of a chain, a museum and its
 * visitor centre, the same name in two adjacent towns, a permanently closed
 * twin — can be asserted directly rather than through a whole pack.
 */
export function compare(a: SourceRecord, b: SourceRecord): CandidateLink | null {
  const separation = metresBetween(a.coordinates, b.coordinates);
  const evidence: LinkEvidence[] = [];

  if (a.wikidataId && b.wikidataId && a.wikidataId === b.wikidataId) {
    evidence.push('shared_wikidata_id');
  }
  if (sharesUpstreamRecord(a, b)) evidence.push('shared_upstream_record_id');
  if (sharesCanonicalWebsite(a, b)) evidence.push('shared_canonical_website');

  const namesMatch = namesEqual(a, b);
  const rolesCompatible = a.planningRole === b.planningRole;
  const proximity = proximityFor(a, b);

  if (namesMatch && rolesCompatible && separation <= proximity) {
    evidence.push('name_and_category_and_proximity');
  } else if (namesMatch) {
    evidence.push('name_only');
  }

  if (evidence.length === 0) {
    /**
     * No name and no shared identifier, but one sits inside the other's
     * boundary.
     *
     * This is the park-and-its-trailhead case, and it is worth recording because
     * scheduling both as independent stops wastes a day. It is emphatically not
     * an identity claim.
     */
    const parent = containedWithin(a, b) ?? containedWithin(b, a);
    if (parent) {
      return {
        recordIds: [a.id, b.id].sort(),
        kind: 'parent_child',
        evidence: ['geometric_containment'],
        parentRecordId: parent.id,
        separationMetres: Math.round(separation),
      };
    }
    return null;
  }

  /**
   * A published identifier both sources carry is identity, full stop.
   *
   * A Wikidata id or a shared upstream element id is a claim somebody made about
   * the world, not an inference we drew from two strings looking alike.
   */
  if (evidence.includes('shared_wikidata_id') || evidence.includes('shared_upstream_record_id')) {
    return {
      recordIds: [a.id, b.id].sort(),
      kind: 'same_entity',
      evidence,
      separationMetres: Math.round(separation),
    };
  }

  /**
   * A shared domain **and** a shared name is identity. A shared domain alone is
   * a chain.
   *
   * Two branches of the same restaurant group publish the same website and are
   * two restaurants; merging them would delete one and put the traveller at the
   * wrong address. The distance check is what tells them apart, and it is why
   * this branch is not simply "same website, same place".
   */
  if (evidence.includes('shared_canonical_website')) {
    if (namesMatch && separation <= proximity) {
      return {
        recordIds: [a.id, b.id].sort(),
        kind: 'same_entity',
        evidence,
        separationMetres: Math.round(separation),
      };
    }
    if (separation > proximity) {
      return {
        recordIds: [a.id, b.id].sort(),
        kind: 'colocated_distinct',
        evidence,
        separationMetres: Math.round(separation),
      };
    }
  }

  if (evidence.includes('name_and_category_and_proximity')) {
    return {
      recordIds: [a.id, b.id].sort(),
      kind: separation <= proximity / 3 ? 'same_entity' : 'probable_same_entity',
      evidence,
      separationMetres: Math.round(separation),
    };
  }

  /**
   * Same name, and nothing else agrees.
   *
   * The same-name-in-adjacent-cities case lands here, and so does a museum and
   * the café inside it that shares its name. Both records survive; the label
   * says only that somebody should not schedule them blind.
   */
  const parent = containedWithin(a, b) ?? containedWithin(b, a);
  if (parent) {
    return {
      recordIds: [a.id, b.id].sort(),
      kind: 'parent_child',
      evidence: [...evidence, 'geometric_containment'],
      parentRecordId: parent.id,
      separationMetres: Math.round(separation),
    };
  }
  if (separation <= proximity * 4) {
    return {
      recordIds: [a.id, b.id].sort(),
      kind: 'possible_duplicate',
      evidence,
      separationMetres: Math.round(separation),
    };
  }
  return {
    recordIds: [a.id, b.id].sort(),
    kind: 'unresolved',
    evidence,
    separationMetres: Math.round(separation),
  };
}

/**
 * The records a link says can be dropped in favour of another.
 *
 * Only `same_entity` and `probable_same_entity` collapse, and the survivor is
 * chosen by evidence rather than by layer: the record with more provenance rows,
 * then more attributes, then a website, then the lower id so the choice is
 * stable. A `possible_duplicate` collapses nothing — both go to the board and
 * the quality assessor marks the weaker one redundant, which is a decision the
 * traveller can see and undo.
 */
export function supersededRecordIds(
  records: readonly SourceRecord[],
  links: readonly CandidateLink[],
): Set<string> {
  const byId = new Map(records.map((record) => [record.id, record]));
  const superseded = new Set<string>();

  for (const link of links) {
    if (link.kind !== 'same_entity' && link.kind !== 'probable_same_entity') continue;
    const [first, second] = link.recordIds;
    const a = first ? byId.get(first) : undefined;
    const b = second ? byId.get(second) : undefined;
    if (!a || !b) continue;
    if (superseded.has(a.id) || superseded.has(b.id)) continue;
    superseded.add(strength(a) >= strength(b) ? b.id : a.id);
  }

  return superseded;
}

function strength(record: SourceRecord): number {
  return (
    record.sources.length * 100 +
    Object.keys(record.attributes).length * 10 +
    (record.websiteCandidates.length > 0 ? 5 : 0) +
    (record.wikidataId ? 5 : 0) +
    // A tie broken on the id, inverted so a lower id wins, keeping the choice
    // stable across runs without depending on iteration order.
    (record.id < 'm' ? 1 : 0)
  );
}

// ---------------------------------------------------------------------------
// Evidence tests
// ---------------------------------------------------------------------------

const upstreamCache = new WeakMap<SourceRecord, Set<string>>();

function upstreamOf(record: SourceRecord): Set<string> {
  const cached = upstreamCache.get(record);
  if (cached) return cached;
  const keys = new Set(
    record.sources
      .filter((source) => source.recordId !== undefined)
      .map((source) => `${source.dataset}:${source.recordId}`),
  );
  upstreamCache.set(record, keys);
  return keys;
}

function sharesUpstreamRecord(a: SourceRecord, b: SourceRecord): boolean {
  const left = upstreamOf(a);
  if (left.size === 0) return false;
  for (const key of upstreamOf(b)) if (left.has(key)) return true;
  return false;
}

function sharesCanonicalWebsite(a: SourceRecord, b: SourceRecord): boolean {
  const left = websitesOf(a);
  if (left.size === 0) return false;
  const right = websitesOf(b);
  for (const url of right) if (left.has(url)) return true;
  return false;
}

/**
 * Normalised names and canonical URLs, computed once per record.
 *
 * `normalizeName` runs a Unicode decomposition and three regular expressions,
 * and the blocking loop calls it on both sides of every pair. Memoising turned a
 * comparison budget that a dense island exhausted into one that is a runaway
 * guard. A `WeakMap` rather than a field so the record stays a plain data
 * object that a schema can validate.
 */
const nameCache = new WeakMap<SourceRecord, Set<string>>();
const websiteCache = new WeakMap<SourceRecord, Set<string>>();

function namesOf(record: SourceRecord): Set<string> {
  const cached = nameCache.get(record);
  if (cached) return cached;
  const names = new Set(
    [record.name, ...record.alternateNames]
      .map(normalizeName)
      .filter((name) => name.length > 0),
  );
  nameCache.set(record, names);
  return names;
}

function websitesOf(record: SourceRecord): Set<string> {
  const cached = websiteCache.get(record);
  if (cached) return cached;
  const urls = new Set(
    record.websiteCandidates.map(canonicalUrl).filter((value) => value.length > 0),
  );
  websiteCache.set(record, urls);
  return urls;
}

/**
 * Host and path, lowercased, with the tracking and the decoration removed.
 *
 * `www.`, a trailing slash, a query string and a fragment are all noise that
 * would make two records pointing at the same page look like two pages.
 */
export function canonicalUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    const path = url.pathname.replace(/\/+$/, '').toLowerCase();
    return `${host}${path}`;
  } catch {
    return '';
  }
}

/**
 * Names equal after normalisation, in any of the names either record publishes.
 *
 * Alternate names carry the multilingual cases: a place recorded as
 * `國家自由紀念區` in the place catalogue and by its English name in the
 * geographic one is one place, and comparing only primaries would miss it.
 */
function namesEqual(a: SourceRecord, b: SourceRecord): boolean {
  const left = namesOf(a);
  for (const name of namesOf(b)) if (left.has(name)) return true;
  return false;
}

/**
 * Whether `child`'s point sits inside `parent`'s published boundary.
 *
 * Requires an actual boundary rather than inferring one from a radius: a
 * "containment" derived from two points and an assumption is proximity wearing a
 * better name.
 */
function containedWithin(parent: SourceRecord, child: SourceRecord): SourceRecord | null {
  if (!parent.bounds) return null;
  if (parent.id === child.id) return null;
  const { southWest, northEast } = parent.bounds;
  const inside =
    child.coordinates.lat >= southWest.lat &&
    child.coordinates.lat <= northEast.lat &&
    child.coordinates.lng >= southWest.lng &&
    child.coordinates.lng <= northEast.lng;
  if (!inside) return null;
  // A boundary that is really a point tells us nothing about containment.
  if (metresBetween(southWest, northEast) < 40) return null;
  if (metresBetween(parent.coordinates, child.coordinates) > CONTAINMENT_METRES) return null;
  return parent;
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

const EARTH_RADIUS_M = 6_371_000;

export function metresBetween(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const toRad = (value: number): number => (value * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** About a kilometre at the equator, and the blocking key for comparison. */
function bucketKey(point: { lat: number; lng: number }): string {
  return `${Math.round(point.lat * 100)}:${Math.round(point.lng * 100)}`;
}

/**
 * How far out to look for a record's possible twin, in blocking cells.
 *
 * One cell is roughly a kilometre and covers every ordinary pair. A record with
 * a large published boundary needs a wider net, or the volcano case above never
 * gets as far as being compared. Capped at six cells so a country-sized polygon
 * does not turn the blocking back into a cross-product.
 */
function searchRadiusCells(record: SourceRecord): number {
  const landscape = isLandscapeScale({
    category: record.sourceCategory,
    path: record.sourceCategoryPath,
  })
    ? Math.ceil(LANDSCAPE_PROXIMITY_METRES / 1_000)
    : 1;
  if (!record.bounds) return Math.min(6, landscape);
  const km = metresBetween(record.bounds.southWest, record.bounds.northEast) / 2_000;
  return Math.min(6, Math.max(landscape, Math.ceil(km)));
}

function* neighbours(
  buckets: Map<string, SourceRecord[]>,
  point: { lat: number; lng: number },
  radius: number,
): Generator<SourceRecord> {
  const lat = Math.round(point.lat * 100);
  const lng = Math.round(point.lng * 100);
  for (let dLat = -radius; dLat <= radius; dLat += 1) {
    for (let dLng = -radius; dLng <= radius; dLng += 1) {
      const bucket = buckets.get(`${lat + dLat}:${lng + dLng}`);
      if (bucket) yield* bucket;
    }
  }
}
