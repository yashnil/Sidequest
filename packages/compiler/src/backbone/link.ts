import type { CandidateLink, LinkEvidence, SourceRecord } from '@sidequest/core';
import { normalizeName } from '../dedupe';
import { isEventVenue, isLandscapeScale, isProtectedAreaKind } from './taxonomy';

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
 * Pack-wide context a pairwise comparison cannot see.
 *
 * `canonicalPageCount` is how many records in the whole pack publish each
 * canonical page URL. The no-name website identity below needs it: a page two
 * records share describes one place, and a page *thirteen* records share is an
 * operator's section page stamped onto everything inside — a real pack put a
 * theme park's URL on every one of its rides, and without the count the linker
 * merged the park, its polygon and three rides into one entity whose survivor
 * was a canoe ride. Absent (a bare pairwise call), the pair itself is all that
 * is known and the count is honestly two.
 */
export interface CompareContext {
  canonicalPageCount?: ReadonlyMap<string, number>;
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
  const canonicalPageCount = new Map<string, number>();
  for (const record of records) {
    const key = bucketKey(record.coordinates);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(record);
    else buckets.set(key, [record]);
    for (const url of websitesOf(record)) {
      canonicalPageCount.set(url, (canonicalPageCount.get(url) ?? 0) + 1);
    }
  }
  const context: CompareContext = { canonicalPageCount };

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

      const link = compare(record, neighbour, context);
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
export function compare(
  a: SourceRecord,
  b: SourceRecord,
  context: CompareContext = {},
): CandidateLink | null {
  const separation = effectiveSeparation(a, b);
  const evidence: LinkEvidence[] = [];

  if (a.wikidataId && b.wikidataId && a.wikidataId === b.wikidataId) {
    evidence.push('shared_wikidata_id');
  }
  if (sharesUpstreamRecord(a, b)) evidence.push('shared_upstream_record_id');
  if (sharesCanonicalWebsite(a, b)) evidence.push('shared_canonical_website');

  const namesMatch = namesEqual(a, b);
  const rolesCompatible = a.planningRole === b.planningRole;
  const proximity = proximityFor(a, b);

  /*
   * A name that matches only once the word boundaries are ignored.
   *
   * The cross-script pair this exists for: a catalogue publishes a place under
   * its local script with the Latin name among the alternates, and a second
   * catalogue publishes the same place under its Latin name alone — so the one
   * comparable pair is Latin against Latin, and on a real pack it failed on a
   * *space*: `Disney Land` against `Disneyland`, two segmentations of one name.
   * Both sides' full name sets (primaries and alternates) are already compared;
   * the folding is what lets the comparison see through segmentation.
   *
   * Bounded on purpose, unlike the exact match: it counts only between records
   * that plan the same way and stand within the identity radius, and it never
   * produces `name_only` — a segmentation-folded match at a distance is not
   * evidence of anything, where an exact name at a distance still marks a
   * namesake worth flagging.
   */
  const foldedMatch =
    !namesMatch &&
    rolesCompatible &&
    separation <= proximity &&
    (foldedNamesEqual(a, b) || protectedAreaDescriptorNamesEqual(a, b));

  if ((namesMatch || foldedMatch) && rolesCompatible && separation <= proximity) {
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
   *
   * One narrow case needs no name at all, because no name can exist for it: a
   * catalogue records the same place once per language, and two records whose
   * scripts never overlap cannot agree on a string however many alternates they
   * carry — a real pack held one palace at the same point under a Vietnamese
   * primary and a Cyrillic primary, both pointing at the same *page*, and the
   * pair sailed through as `possible_duplicate` onto the board twice. So a
   * shared canonical URL that names a page rather than a bare domain, between
   * records that plan the same way and stand within the identity radius, is
   * identity: a chain points its branches at its homepage, not at one page, and
   * two branches inside one identity radius are not two addresses.
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
    if (
      rolesCompatible &&
      separation <= proximity / 3 &&
      (sharesExclusivePage(a, b, context) ||
        /*
         * A page shared beyond the pair usually means an operator's section
         * page — but two records standing on **one published point** with one
         * page are one catalogue row recorded once per language, whatever a
         * third building on the same grounds happens to link to. Measured on a
         * real pack: the palace's Vietnamese and Cyrillic rows coincide to the
         * metre while the garden 650 m away wears the same guide URL; the
         * coincidence separates them exactly.
         */
        (sharesCanonicalPage(a, b) &&
          metresBetween(a.coordinates, b.coordinates) < 1))
    ) {
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
 *
 * THE SET OF LINKS IS NOT THE SET OF PAIRS, AND THAT IS THE WHOLE PROBLEM.
 *
 * This used to walk the links one at a time and drop the weaker side, skipping
 * any link whose partner had already gone. The skip was there for a real reason
 * — without it a three-record cycle can drop all three and delete the place
 * outright — but it makes the answer depend on the order the links happen to be
 * in, and it leaves a record standing whenever its *only* link points at
 * something already dropped.
 *
 * Identity is transitive and the evidence is not complete, so those two facts
 * meet constantly. Measured on the live catalogue (release 2026-07-22.0) over a
 * Tokyo bay box compiled with the production retention budget — 3,210 records,
 * 1,412 collapsing links, 125 groups of records asserted to be one thing — 12
 * of those groups kept more than one survivor, and the shapes are all the same:
 *
 * - A park published once in the place catalogue in Japanese, once in the place
 *   catalogue in English, and once in the land-use layer. The land-use record
 *   linked to *both* names at nine and fourteen metres; the two place records
 *   never linked to each other, because neither carries the other's language.
 *   The land-use record was dropped, its second link was then skipped, and the
 *   same park went to the board twice — once in each language.
 * - A canal published in three segments, where two of the three pairs were close
 *   enough to be `probable_same_entity` and the third pair was 330 m apart and
 *   only `name_only`. One segment was dropped; the link that would have dropped
 *   the second was skipped because its partner was already gone.
 *
 * So the collapse is over **connected components** of the collapsing links, and
 * every component keeps exactly one record: the strongest, ties to the lower id.
 * A component can no longer be annihilated, the result no longer depends on link
 * order — which also matters because the pack's content hash covers what
 * survives — and a group of records the linker said are one thing is one thing.
 * For a component of two this is the old behaviour exactly.
 */
/**
 * Which collapse component each collapsing record belongs to, by root id.
 *
 * Exported for the one consumer that must ask "are these two records the same
 * entity" *after* the collapse has already removed one of them: the paid-
 * enclosure fold. A superseded grounds polygon still describes real ground and
 * must go on absorbing the rides inside it — but it must never absorb the
 * survivor of its own component, which is the same record under another id.
 * Records outside every component are absent from the map.
 */
export function collapseComponentIds(
  records: readonly SourceRecord[],
  links: readonly CandidateLink[],
): Map<string, string> {
  const componentOf = new Map<string, string>();
  for (const component of collapsingComponents(records, links)) {
    const root = component[0]!.id;
    for (const record of component) componentOf.set(record.id, root);
  }
  return componentOf;
}

export function supersededRecordIds(
  records: readonly SourceRecord[],
  links: readonly CandidateLink[],
): Set<string> {
  const superseded = new Set<string>();
  for (const component of collapsingComponents(records, links)) {
    for (const record of component) if (record.id !== survivorOf(component).id) {
      superseded.add(record.id);
    }
  }
  return superseded;
}

/**
 * THE NAMES A COLLAPSE WOULD OTHERWISE THROW AWAY.
 *
 * `supersededRecordIds` keeps one record out of a group the linker said is one
 * thing, and everything the others carried goes with them — including, on a
 * dense non-Latin pack, **the only name a traveller can read**.
 *
 * Measured on the stored Tokyo pack of 2026-08-12: 71 of 123 shortlisted cards
 * lead in a script an English-interface reader cannot read, and not one of the
 * surviving records holds a Latin alternate. The names are in the pack. For a
 * central city park the land-use layer publishes the local-script name with
 * three romanised and translated alternates beside it; the primary place
 * catalogue publishes the same park with no alternates at all, two provenance
 * rows against one, and therefore wins `strength` by 95 points. A famous theme
 * park loses its English name the same way.
 *
 * The survivor is not the wrong choice — it carries the website and the
 * containment the other one lacks — so this does not change *which* record
 * survives. It restores the one thing the loser held that the winner cannot
 * reconstruct. Names are already treated as shared evidence by this very file:
 * `namesEqual` reads a twin's alternates to establish that the two are the same
 * entity in the first place, and a name is the one field where "the other
 * record for this same place calls it that" is simply true.
 *
 * Deliberately names only. No attribute, no site, no geometry crosses, because
 * the licence argument at the top of this file applies to those and a record
 * whose licence nobody chose is exactly what it forbids.
 */
export function namesFromCollapsedTwins(
  records: readonly SourceRecord[],
  links: readonly CandidateLink[],
): Map<string, string[]> {
  const inherited = new Map<string, string[]>();
  for (const component of collapsingComponents(records, links)) {
    const survivor = survivorOf(component);
    const known = new Set([survivor.name, ...survivor.alternateNames].map(normalizeName));
    const gained: string[] = [];
    for (const record of component) {
      if (record.id === survivor.id) continue;
      for (const name of [record.name, ...record.alternateNames]) {
        const key = normalizeName(name);
        if (key.length === 0 || known.has(key)) continue;
        known.add(key);
        gained.push(name);
      }
    }
    if (gained.length > 0) inherited.set(survivor.id, gained);
  }
  return inherited;
}

/**
 * The record a component collapses to: the strongest, ties to the lower id —
 * with one class preference ahead of raw strength. A record filed under an
 * event-venue kind is a listing for something that *happens at* the place, and
 * an exhibition listing routinely out-describes the institution it points at
 * (its own page, its own hours, a second provenance row). Before the
 * preference, a collapse could keep a season's exhibition as the surviving
 * name of a permanent museum. So where a component holds both, the
 * institution's identity survives, whatever the field counts say.
 */
function survivorOf(component: readonly SourceRecord[]): SourceRecord {
  let survivor = component[0]!;
  for (const record of component.slice(1)) {
    const better =
      Number(eventVenueRecord(survivor)) - Number(eventVenueRecord(record)) ||
      strength(record) - strength(survivor) ||
      survivor.id.localeCompare(record.id);
    if (better > 0) survivor = record;
  }
  return survivor;
}

function eventVenueRecord(record: SourceRecord): boolean {
  return isEventVenue({ category: record.sourceCategory, path: record.sourceCategoryPath });
}

/**
 * Groups of records the collapsing links say are one thing.
 *
 * Connected components rather than pairs, for the reason `supersededRecordIds`
 * documents above, and shared with `namesFromCollapsedTwins` so the two cannot
 * disagree about which record survives — a disagreement there would attach a
 * name to a record that is not on the board.
 */
function collapsingComponents(
  records: readonly SourceRecord[],
  links: readonly CandidateLink[],
): SourceRecord[][] {
  const byId = new Map(records.map((record) => [record.id, record]));

  /**
   * Union-find, keyed by record id.
   *
   * A plain map from id to component root, with path compression, because the
   * alternative — repeatedly re-scanning the links until nothing changes — is
   * quadratic in the size of the largest component and this runs on every pack
   * build.
   */
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let root = id;
    for (;;) {
      const next = parent.get(root);
      if (next === undefined || next === root) break;
      root = next;
    }
    let cursor = id;
    while (cursor !== root) {
      const next = parent.get(cursor) ?? root;
      parent.set(cursor, root);
      cursor = next;
    }
    return root;
  };

  for (const link of links) {
    if (link.kind !== 'same_entity' && link.kind !== 'probable_same_entity') continue;
    const [first, second] = link.recordIds;
    if (!first || !second) continue;
    // A link may reference a record this caller did not hand us. It says nothing
    // about the records that are here.
    if (!byId.has(first) || !byId.has(second)) continue;
    // Seeded on entry, so `parent` doubles as "this record is in some group" and
    // a record nothing collapses is never walked below.
    if (!parent.has(first)) parent.set(first, first);
    if (!parent.has(second)) parent.set(second, second);
    const rootA = find(first);
    const rootB = find(second);
    if (rootA !== rootB) parent.set(rootA, rootB);
  }

  const components = new Map<string, SourceRecord[]>();
  for (const record of records) {
    if (!parent.has(record.id)) continue;
    const root = find(record.id);
    const component = components.get(root);
    if (component) component.push(record);
    else components.set(root, [record]);
  }

  return [...components.values()].filter((component) => component.length >= 2);
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
 * A shared canonical URL that names a *page* these two records alone publish.
 *
 * The discriminator the no-name identity branch stands on, in two halves. A
 * chain points every branch at its homepage, so a bare shared domain says "same
 * operator" and a shared *path* says "the same page describes both records". And
 * the path is not enough on its own: an operator stamps a section page onto
 * everything inside its grounds — a real pack carried a theme park's `/tdl`
 * page on the park, its polygon and every ride — so the page must also be
 * exclusive to the pair, which the pack-wide count answers. Where no count was
 * supplied the pair is all that is known, and two is the honest reading.
 */
function sharesExclusivePage(a: SourceRecord, b: SourceRecord, context: CompareContext): boolean {
  const left = websitesOf(a);
  if (left.size === 0) return false;
  for (const url of websitesOf(b)) {
    if (!left.has(url) || !url.includes('/')) continue;
    if ((context.canonicalPageCount?.get(url) ?? 2) <= 2) return true;
  }
  return false;
}

/** A shared canonical URL that names a page, exclusive or not. */
function sharesCanonicalPage(a: SourceRecord, b: SourceRecord): boolean {
  const left = websitesOf(a);
  if (left.size === 0) return false;
  for (const url of websitesOf(b)) {
    if (left.has(url) && url.includes('/')) return true;
  }
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
      .flatMap(nameVariants)
      .map(normalizeName)
      .filter((name) => name.length > 0),
  );
  nameCache.set(record, names);
  return names;
}

/**
 * A name a source wrote as two names in one string.
 *
 * Catalogues routinely publish a gloss inside the primary field — a local-script
 * name with its English translation in brackets, or the reverse — and a
 * whole-string comparison sees a record that has *no* name in common with the
 * twin filed under the bare form. On the stored 2026-08-12 Tokyo pack that is
 * why one walled palace garden reached the shortlist several times over: the
 * place catalogue's parenthesised row and the land-use polygon 89 m away were
 * never matched, and §8.8 forbids exactly that.
 *
 * The bracketed half and the half outside it are both names the source
 * published; splitting them adds match keys and removes none. It cannot merge
 * two different places on its own — `compare` still requires a compatible role
 * and a distance — so two towns sharing a base name and disambiguated in
 * brackets stay `name_only`, which is what they were before.
 */
function nameVariants(value: string): string[] {
  const inside = [...value.matchAll(/[([]([^)\]]{2,})[)\]]/g)].map((match) => match[1]!.trim());
  if (inside.length === 0) return [value];
  const outside = value.replace(/[([][^)\]]*[)\]]/g, ' ').trim();
  return [value, ...(outside.length > 0 ? [outside] : []), ...inside];
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
 * would make two records pointing at the same page look like two pages. So is a
 * directory index: `nps.gov/stli` and `nps.gov/stli/index.htm` are one page,
 * and on the stored New York pack they are what two of the four Statue of
 * Liberty rows point at.
 */
export function canonicalUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    const path = url.pathname
      .replace(/\/(index|default)\.(html?|php|aspx?)$/i, '')
      .replace(/\/+$/, '')
      .toLowerCase();
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
 * The same names with the word boundaries removed.
 *
 * `normalizeName` keeps spaces, and it should: `name_only` links between exact
 * names at a distance are how namesakes get flagged, and folding spaces there
 * would flag more of them on weaker grounds. But segmentation is not a fact
 * about a place — one catalogue writes a compound name as one word and another
 * as two, and on a real pack that single space kept a theme park's POI record
 * and its polygon apart. `compare` reads this only inside the bounded branch:
 * same planning role, within the identity radius.
 */
const foldedNameCache = new WeakMap<SourceRecord, Set<string>>();

function foldedNamesOf(record: SourceRecord): Set<string> {
  const cached = foldedNameCache.get(record);
  if (cached) return cached;
  const names = new Set(
    [...namesOf(record)].map((name) => name.replace(/\s+/g, '')).filter((name) => name.length > 0),
  );
  foldedNameCache.set(record, names);
  return names;
}

function foldedNamesEqual(a: SourceRecord, b: SourceRecord): boolean {
  const left = foldedNamesOf(a);
  for (const name of foldedNamesOf(b)) if (left.has(name)) return true;
  return false;
}

/**
 * THE SAME PROTECTED GROUND, NAMED WITH AND WITHOUT ITS DESIGNATION.
 *
 * Catalogues split on this by construction: one source writes a protected
 * area's proper name alone and another writes the proper name plus the
 * designation's generic noun, so the one comparable pair of names differs by
 * exactly the words the category field already declares. Measured on a live
 * country pack: the national park at the heart of the standard day-trip
 * circuit was published as a `park` record under "<name> National Park" and as
 * `national_park` records under "<name>" alone, the linker's exact and
 * segmentation folds both refused the pair, two collapse components formed for
 * one canonical place, and the served board seated the same park twice.
 *
 * So, between two records that are both protected-area kinds, a name equal to
 * the other's name once a generic protected-area designator is removed from
 * its edge is treated as the same name. Three bounds keep it from becoming a
 * fuzzy match:
 *
 * - **family-gated**: both records must be protected-area kinds
 *   (`isProtectedAreaKind`), where a designator beside a proper name is a
 *   naming convention rather than a distinction — a museum named "<town>
 *   National Museum" must never fold onto a record named "<town>";
 * - **edge-anchored, whole-phrase**: only a designator at the start or end of
 *   the name is stripped, once, and the remainder must be a real name (three
 *   characters or more) that equals one of the twin's names *exactly* — no
 *   token-subset matching;
 * - **bounded like the segmentation fold**: read only inside `compare`'s
 *   identity branch — compatible planning roles, within the identity radius —
 *   and it never produces `name_only`, so a namesake park two towns over
 *   still refuses exactly as it did.
 */
const PROTECTED_AREA_DESCRIPTORS = [
  'national nature reserve',
  'national wildlife refuge',
  'national park',
  'nationalpark',
  'national monument',
  'natural monument',
  'national reserve',
  'nature reserve',
  'nature preserve',
  'nature park',
  'state park',
  'provincial park',
  'regional park',
  'country park',
  'protected area',
  'conservation area',
  'wilderness area',
].sort((a, b) => b.length - a.length);

const descriptorStrippedCache = new WeakMap<SourceRecord, Set<string>>();

function descriptorStrippedNamesOf(record: SourceRecord): Set<string> {
  const cached = descriptorStrippedCache.get(record);
  if (cached) return cached;
  const stripped = new Set<string>();
  for (const name of namesOf(record)) {
    for (const descriptor of PROTECTED_AREA_DESCRIPTORS) {
      let remainder: string | null = null;
      if (name.endsWith(` ${descriptor}`)) remainder = name.slice(0, -descriptor.length - 1);
      else if (name.startsWith(`${descriptor} `)) remainder = name.slice(descriptor.length + 1);
      if (remainder === null) continue;
      const trimmed = remainder.trim();
      if (trimmed.length >= 3) stripped.add(trimmed);
      break; // Longest designator wins; strip once, never iteratively.
    }
  }
  descriptorStrippedCache.set(record, stripped);
  return stripped;
}

function protectedAreaDescriptorNamesEqual(a: SourceRecord, b: SourceRecord): boolean {
  if (
    !isProtectedAreaKind({ category: a.sourceCategory, path: a.sourceCategoryPath }) ||
    !isProtectedAreaKind({ category: b.sourceCategory, path: b.sourceCategoryPath })
  ) {
    return false;
  }
  const aStripped = descriptorStrippedNamesOf(a);
  if (aStripped.size > 0) {
    for (const name of namesOf(b)) if (aStripped.has(name)) return true;
  }
  const bStripped = descriptorStrippedNamesOf(b);
  if (bStripped.size > 0) {
    for (const name of namesOf(a)) if (bStripped.has(name)) return true;
  }
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

/**
 * How far apart two records actually stand, reading published geometry.
 *
 * Point-to-point distance is wrong for a feature that covers ground: a polygon's
 * representative point can sit anywhere inside it — the linker's own volcano
 * precedent — so a POI at a park's gate measured 759 m "from" a park whose own
 * ground started 105 m away, and the pair fell outside every radius. Where a
 * record publishes a real boundary, the distance to the record is the distance
 * to that boundary, zero inside it. The 40-metre floor is the same one
 * `containedWithin` uses to tell a real boundary from a point dressed as a box.
 *
 * This can only shrink a separation, never grow one, and every identity branch
 * still requires its own evidence — a name, a page, an identifier — so what it
 * widens is which pairs get *considered*, not what counts as a match.
 */
function effectiveSeparation(a: SourceRecord, b: SourceRecord): number {
  let separation = metresBetween(a.coordinates, b.coordinates);
  for (const [point, extent] of [
    [a.coordinates, b.bounds],
    [b.coordinates, a.bounds],
  ] as const) {
    if (!extent) continue;
    if (metresBetween(extent.southWest, extent.northEast) < 40) continue;
    const clamped = {
      lat: Math.min(Math.max(point.lat, extent.southWest.lat), extent.northEast.lat),
      lng: Math.min(Math.max(point.lng, extent.southWest.lng), extent.northEast.lng),
    };
    separation = Math.min(separation, metresBetween(point, clamped));
  }
  return separation;
}

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
