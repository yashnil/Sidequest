import 'server-only';
import {
  foldForMatch,
  type DestinationEntityType,
  type DestinationFeatureType,
  type DestinationIndexEntry,
  type GeoBounds,
} from '@sidequest/core';
import {
  destinationEntryById,
  entriesByPrefix,
  entriesInCountry,
} from '../db/destination-index-repository';

/**
 * A DESTINATION PUBLISHED TWICE IS BOTH OF ITS PUBLICATIONS.
 *
 * Overture holds a metropolis under two division records: once as the
 * first-level division it *is*, and once as a locality sitting inside its own
 * historic core. Tokyo is `region 689e36ca` whose parent is Japan **and**
 * `locality 798895d4` whose parent is Chiyoda ward; Bangkok, Seoul, Mexico City,
 * Berlin and Singapore all publish the same pair. The index keeps both rows
 * because both are real, and the suggestion ranking then hands the traveller
 * whichever one is more prominent — which for a metropolis is the locality,
 * because that is the row carrying the population.
 *
 * That choice is invisible in the dropdown and decisive afterwards. Measured on
 * the Tokyo pack stored on this machine: of 3,787 records, 319 publish a parent
 * chain and **every one of them names the region**; not one names the locality.
 * So a scope carrying only the locality's identifier can never place a single
 * record inside its own destination, and §12.1's "a city being reduced to an
 * arbitrary suburb" arrives not as a clipped boundary but as an identity nobody
 * else refers to.
 *
 * Resolving it needs a rule that survives a catalogue full of homonyms, so the
 * rule here is deliberately not about names at all.
 */

/**
 * How coarse an administrative publication is, where the catalogue publishes one.
 *
 * Only administrative feature types appear. An island, a national park or a
 * landmark is not a rung of anybody's hierarchy, and pairing one with a division
 * would be asserting a containment the catalogue never published.
 *
 * `city` and `town` share a rung on purpose: the index separates them on a
 * population threshold rather than on anything the source declares, so treating
 * them as different levels would let two neighbouring villages pass the
 * different-rung test below.
 */
const ADMINISTRATIVE_RUNG: Partial<Record<DestinationFeatureType, number>> = {
  country: 0,
  dependency: 0,
  region: 1,
  county: 2,
  city: 3,
  town: 3,
  district: 4,
};

function contains(bounds: GeoBounds | undefined, point: { lat: number; lng: number }): boolean {
  if (!bounds) return false;
  return (
    point.lat >= bounds.southWest.lat &&
    point.lat <= bounds.northEast.lat &&
    point.lng >= bounds.southWest.lng &&
    point.lng <= bounds.northEast.lng
  );
}

/**
 * One published extent inside another, corner by corner.
 *
 * No antimeridian arithmetic, deliberately: a box spanning ±180° would fail this
 * and the pair would be refused. A refusal is the safe direction — the cost is a
 * destination that keeps the identity it has today, and the alternative is
 * wrap-around logic nobody here can test against a real row.
 */
function containsBounds(outer: GeoBounds | undefined, inner: GeoBounds | undefined): boolean {
  if (!outer || !inner) return false;
  return contains(outer, inner.southWest) && contains(outer, inner.northEast);
}

/**
 * The other publications of the same place, from the same catalogue.
 *
 * Three independent things have to agree before two rows are called one place,
 * and each of them removes a failure the index actually contains:
 *
 * 1. **The catalogue's own cross-level identity.** A shared Wikidata id is the
 *    source saying these rows are the same entity. It is the one signal that
 *    tells Tokyo-the-region and Tokyo-the-locality (both `Q1490`) apart from
 *    **New York City inside New York State** — same name, same country, one
 *    inside the other, and `Q60` against `Q1384`. A name-based rule would have
 *    unioned those two and made every record in upstate New York a member of the
 *    traveller's city.
 * 2. **Different rungs.** The index holds ten rows sharing `Q574593` — a cluster
 *    of neighbouring Nigerian towns a contributor tagged with one id — and six
 *    Cayman districts sharing `Q5589389`. All of them sit at the same rung, so a
 *    publisher's mistake cannot become a union of siblings.
 * 3. **Published containment.** The coarser row's *measured* extent has to hold
 *    the finer row's centre. The index computes country and region extents from
 *    the bounding box of their own indexed children, so this is a real
 *    measurement rather than a circle drawn around a centroid; where a row
 *    publishes no extent it cannot corroborate anything and the pair is refused.
 *
 * Pure and separate from the query below, so the rule can be held to the real
 * rows it has to survive without a database.
 */
export function coPublicationsOf(
  selected: DestinationIndexEntry,
  pool: readonly DestinationIndexEntry[],
): DestinationIndexEntry[] {
  const wikidataId = selected.wikidataId;
  const rung = ADMINISTRATIVE_RUNG[selected.featureType];
  if (!wikidataId || rung === undefined) return [];

  return pool.filter((entry) => {
    if (entry.id === selected.id) return false;
    if (entry.catalog !== selected.catalog) return false;
    if (entry.wikidataId !== wikidataId) return false;
    if (entry.countryCode !== selected.countryCode) return false;
    const other = ADMINISTRATIVE_RUNG[entry.featureType];
    if (other === undefined || other === rung) return false;
    return other < rung
      ? contains(entry.bounds, selected.center)
      : contains(selected.bounds, entry.center);
  });
}

/**
 * How many index rows one name may pull back while looking for a co-publication.
 *
 * Smaller than the dropdown's own prune limit because this is not a search: the
 * rows being looked for are, by construction, major administrative units of the
 * country the traveller just named, and the index orders by catalogue prominence.
 */
const POOL_LIMIT = 250;

/** How many name variants are worth querying. A bound on work, not a judgement. */
const MAX_POOL_PREFIXES = 6;

/**
 * The prefixes worth asking the index for, given what this place is called.
 *
 * Whole names and their word tokens both, because two publications of one place
 * are not obliged to be spelled the same way: the index carries `Buenos Aires`
 * as a city and `Autonomous City of Buenos Aires` as a region, and a whole-name
 * prefix finds one of them. A token does.
 *
 * The names are only ever a *search key* here. Nothing is paired because it
 * shares a name — `coPublicationsOf` decides that, on identity and containment.
 */
function poolPrefixes(entry: DestinationIndexEntry): string[] {
  const prefixes = new Set<string>();
  for (const name of [entry.displayName, entry.localName ?? '']) {
    const folded = foldForMatch(name);
    if (folded.length === 0) continue;
    prefixes.add(folded);
    for (const token of folded.split(' ')) {
      if (token.length >= 3) prefixes.add(token);
    }
  }
  return [...prefixes].slice(0, MAX_POOL_PREFIXES);
}

/**
 * How many first-level divisions of one country are worth reading.
 *
 * Comfortably above the largest ISO 3166-2 set anybody publishes, so the lookup
 * below sees every candidate rather than the most prominent slice of them.
 */
const REGIONS_PER_COUNTRY = 400;

/**
 * THE SAME DIVISION, FOR A DESTINATION THAT NEVER CAME FROM THE INDEX.
 *
 * A destination typed as free text is resolved by a geocoder, so it carries an
 * OSM element id and no catalogue division record at all — and the failure is
 * identical. Measured on the second Tokyo pack stored on this machine, compiled
 * from a geocoded `relation/1543125`: 3,033 of 3,787 records `membership_unknown`
 * and zero anchors, from the same pack that answers completely once the division
 * is known.
 *
 * The bridge between the two catalogues is a **code**, never a name. ISO 3166-2
 * is unique within a country, both sides publish it, and it survives the scripts
 * and translations that make a name comparison worthless.
 *
 * The lookup is a lookup only. What the code *means* for this destination is
 * decided by the caller, because it means two different things: the row it finds
 * is the destination itself when the traveller named a first-level division, and
 * merely the province around it when they named a city inside one.
 */
function regionByCode(destination: {
  countryCode?: string | undefined;
  regionCode?: string | undefined;
}): DestinationIndexEntry | null {
  const { countryCode, regionCode } = destination;
  if (!countryCode || !regionCode) return null;
  return (
    entriesInCountry(countryCode, ['region'], REGIONS_PER_COUNTRY).find(
      (entry) => entry.regionCode === regionCode,
    ) ?? null
  );
}

/**
 * The feature types that are a settlement rather than a rung of administration.
 *
 * The two that share `ADMINISTRATIVE_RUNG` 3, named rather than looked up: the
 * table's values are optional, so a rung comparison against a feature type it
 * has no entry for is `undefined === undefined`, which is true and wrong.
 */
const SETTLEMENT_TYPES: readonly DestinationFeatureType[] = ['city', 'town'];

/**
 * One place published as a division, in the index, together with its other
 * publications.
 *
 * The pool is a *search key* pass and nothing more: rows are pulled by name
 * prefix and then paired — or not — by `coPublicationsOf`, on identity and
 * containment.
 */
function identityOf(selected: DestinationIndexEntry): {
  entry: DestinationIndexEntry;
  coPublications: DestinationIndexEntry[];
} {
  const pool = new Map<string, DestinationIndexEntry>();
  for (const prefix of poolPrefixes(selected)) {
    for (const entry of entriesByPrefix(prefix, POOL_LIMIT)) {
      if (!pool.has(entry.id)) pool.set(entry.id, entry);
    }
  }
  return { entry: selected, coPublications: coPublicationsOf(selected, [...pool.values()]) };
}

function identifiersOf(identity: ReturnType<typeof identityOf>): string[] {
  return [
    ...new Set([
      identity.entry.sourceId,
      ...identity.coPublications.map((entry) => entry.sourceId),
    ]),
  ];
}

/**
 * A CITY THAT **IS** A FIRST-LEVEL DIVISION.
 *
 * The ISO code a geocoder attaches to a city is a statement of containment: it
 * names the admin-level-4 area this place sits in. For Kyoto that area is Kyoto
 * Prefecture, and adopting its identity would hand a traveller who asked for one
 * city every record in the province. So the code alone is refused, and that is
 * the right refusal.
 *
 * But for a large class of destinations the containing first-level division and
 * the city *are the same place*. Confirmed in the index on this machine: Tokyo,
 * Berlin, Hamburg, Vienna, Moscow, Seoul, Bangkok, Mexico City, Buenos Aires,
 * Bishkek. A traveller typing one of those as free text got nothing, from a
 * catalogue that holds the answer twice over.
 *
 * Two published facts, both required, neither a name:
 *
 * 1. **The catalogue says this division is also a settlement.** Not "shares a
 *    name with one" — `coPublicationsOf` pairs rows on a shared Wikidata id at a
 *    different rung with containment, which is the source asserting one entity.
 *    Measured on the index on this machine: Bishkek City (`region`, `KG-GB`) and
 *    Bishkek (`city`) are both `Q9361`; Kyoto Prefecture is `Q120730` and Kyoto
 *    is `Q34600`, so Kyoto fails here and keeps failing.
 * 2. **The two extents are the same ground.** The code already says the
 *    destination is inside the division; this says the division is inside the
 *    destination, and two containments in opposite directions are equality
 *    rather than a guess. It is what separates Bishkek from Shinjuku, which is
 *    also a geocoded `city` carrying `JP-13`: Tokyo's measured extent reaches the
 *    Ogasawara Islands at 24.8°N, over a thousand kilometres south of the ward's
 *    published boundary.
 *
 * Neither condition is redundant. The index on this machine holds 129 first-level
 * divisions with a settlement co-publication, and **29 of them are provinces**,
 * not city-states — a province named after its capital, sharing the capital's
 * Wikidata id: Phetchabun Province (`TH-67`, `Q240520`, 170 km across) and the
 * town of Phetchabun (`Q240520`, population 23,823), and twenty-eight more like
 * it across Thailand, Turkey and Vietnam. Identity alone would hand a traveller
 * who typed that town an entire province. The extents refuse it, because a
 * province does not fit inside a town.
 *
 * Both sides are measured, not assumed — the division's extent is the bounding
 * box of its own indexed children, and the destination's is the boundary the
 * geocoder published. Where either is missing there is nothing to compare and
 * the pair is refused.
 */
function divisionIsTheDestination(
  region: ReturnType<typeof identityOf>,
  destination: { bounds?: GeoBounds | undefined },
): boolean {
  const publishedAsSettlement = region.coPublications.some((entry) =>
    SETTLEMENT_TYPES.includes(entry.featureType),
  );
  return publishedAsSettlement && containsBounds(destination.bounds, region.entry.bounds);
}

/**
 * Every catalogue identifier the chosen destination is published under.
 *
 * The chosen row's own identifier always leads — that is what the traveller
 * pointed at — followed by any co-publication of the same place. Handed to
 * `deriveScope`, which puts them on the scope where the trip-scope overlay's
 * guarded union can read them.
 *
 * Empty when nothing can be established, and that is a real outcome rather than
 * an oversight: an ordinary city inside a larger province, typed as free text,
 * has no identifier either catalogue publishes for it — the geocoder answers with
 * an OSM element id, the index with a Wikidata id, and neither appears on the
 * other side. It gets no identity rather than a guessed one, because a wrong
 * division identity is not a thinner board, it is somebody else's city presented
 * as this one. What that costs is visible downstream rather than silent: the
 * placement counts on the coverage report collapse, and `geographic_resolution`
 * cannot reach `high` without them.
 */
export function destinationDivisionIds(destination: {
  id: string;
  countryCode?: string | undefined;
  regionCode?: string | undefined;
  entityType?: DestinationEntityType | undefined;
  /** The geocoder's published boundary, where it published one. */
  bounds?: GeoBounds | undefined;
}): string[] {
  const chosen = destinationEntryById(destination.id);
  if (chosen) return identifiersOf(identityOf(chosen));

  const region = regionByCode(destination);
  if (!region) return [];
  const identity = identityOf(region);

  if (destination.entityType === 'state_or_province') return identifiersOf(identity);
  if (destination.entityType === 'city' && divisionIsTheDestination(identity, destination)) {
    return identifiersOf(identity);
  }
  return [];
}
