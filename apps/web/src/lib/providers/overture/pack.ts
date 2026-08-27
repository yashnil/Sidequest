import 'server-only';
import {
  assemblePack,
  classifySourceCategory,
  failedPack,
  partitionScope,
  scopeBounds,
  subjectAddressedSites,
  type ExtractionBudget,
  type RegionPackOutcome,
  type RegionPackProvider,
} from '@sidequest/compiler';
import {
  assessPlaceStanding,
  experienceSignificanceOf,
  foldForMatch,
  type GeoBounds,
  type GeographicScope,
  type PackCell,
  type PackLayer,
  type PlanningRole,
  type RecordContainment,
  type SourceRecord,
  type SourceRelease,
} from '@sidequest/core';
import { CatalogError, fileIntersects, latestRelease, themeFiles, type FetchOptions } from './catalog';
import { LAYERS, type LayerDefinition, type NormalizeContext } from './normalize';
import {
  ScanError,
  pointOf,
  rowPointInBox,
  scanFile,
  type BoundingBox,
  type RowSink,
  type ScanBudget,
  type ScanCounters,
} from './scan';

/**
 * BUILDING A REGION PACK.
 *
 * The orchestration is deliberately dull, because the interesting decisions were
 * all made elsewhere: the catalogue prunes files, the format prunes row groups,
 * the taxonomy table classifies, the linker relates. What is left here is
 * ordering, budgeting and honesty.
 *
 * **Ordering.** Divisions first, so every later record can be told which
 * neighbourhood it is in. Places second, because it is the inventory. The
 * geographic layers last, because when a budget runs out it should cost the
 * supplement rather than the primary source.
 *
 * **Budgeting, which is two questions and used to be one.** *How much may we
 * read* is answered in bytes, because that is what a read costs and because the
 * footer prices the whole of a destination exactly before anything is spent —
 * measured over a metropolitan box, all six layers together are 94 MB against a
 * 260 MB budget, so the ordinary answer is "all of it". *How much may we keep*
 * is a separate policy, spent afterwards on ranked records: distributed per cell
 * before it is distributed by rank, so a dense corner cannot consume a whole
 * region's allowance and leave the quiet half of a national park unread, with
 * unspent quota redistributed so a sparse region reads more of itself rather
 * than stopping at an even share of nothing.
 *
 * Collapsing those two into one number is the failure this file was rewritten
 * for. The read was bounded by counts derived from the retention cap, which for
 * a metropolis meant stopping two-thirds of the way through the destination —
 * and no ranking, significance or balancing downstream can recover a record that
 * was never decoded.
 *
 * **Honesty.** Every layer records the cells it could not read. A pack with a
 * failed layer is `partial`, is labelled, and is still usable — which is the
 * whole difference between this and the previous discovery path, where one
 * refusal produced a region that read as though the destination were empty.
 *
 * **Membership.** The box a scan is paid for over is not the destination. It is
 * the union of partition cells drawn around whatever shape the scope has, and
 * for every city, town, county and district in the index that shape is a reach
 * circle rather than a boundary. So a record that comes back is asked, once, on
 * the evidence it now carries, whether it belongs — and one that does not is
 * left out here rather than being handed on as though somebody had checked.
 * Administrative geography is exempt, because it is the evidence the question is
 * answered *from*: a division from the next area along is how a record near the
 * edge gets a locality at all.
 */

export interface PackProviderOptions {
  budget?: Partial<ExtractionBudget>;
  fetchOptions?: FetchOptions;
  /** Injected so a test can build a pack without a clock or a network. */
  now?: () => Date;
  idFor?: (scope: GeographicScope, release: SourceRelease) => string;
  /**
   * The columnar reader, injected.
   *
   * The catalogue side of this provider has always been drivable offline
   * through `fetchOptions.fetchImpl`, and the *acquisition* side never was — so
   * the budgeting and retention decisions that turned a metropolis into one
   * corner of itself had no test that could see them, and the unit tests around
   * the pure helpers stayed green while the wiring between them was the defect.
   * A seam here costs one parameter and makes the whole path assertable with no
   * network and no parquet.
   */
  scanImpl?: typeof scanFile;
  /**
   * Where the acquisition figures go, for whoever is running the job.
   *
   * The pack's own diagnostics carry totals — bytes, row groups, duration — and
   * totals were exactly what made this phase's failure invisible for as long as
   * it was. "1,840 records, 20 row groups read, eleven seconds" describes a
   * healthy build and a build that never opened two-thirds of a city equally
   * well. What separates them is the funnel: how much ground the area *has*, how
   * much was paid for, how many rows that yielded, and where the rest went.
   *
   * A callback rather than a field on the artifact, because these are facts
   * about one run rather than about the ground, and the pack is cached and
   * shared between everybody going there.
   */
  onAcquisition?: (report: AcquisitionReport) => void;
}

/** What one build's acquisition did, layer by layer. See `onAcquisition`. */
export interface AcquisitionReport {
  packId: string;
  releaseId: string;
  /** Whether this build read the source or was served from something warm. */
  cacheState: 'built';
  cells: number;
  layers: readonly LayerAcquisition[];
  bytesTransferred: number;
  ms: number;
}

/**
 * THE BUILD'S BOUNDS, AND WHICH ONE OF THEM IS SUPPOSED TO BITE.
 *
 * `maxBytes` and `maxMs` are the real budget: they are what a build costs and
 * what a traveller waits. Everything else is a backstop.
 *
 * `maxRowGroups` was the policy dial and is now a catastrophic ceiling. Forty
 * was chosen when a row group was the only unit the reader could count in, and
 * it is a nonsense unit for a cost: a metropolis's place inventory prunes to 27
 * groups costing 50 MB, while the same 27 groups of a divisions file cost a
 * fraction of that. Sizing one number for both meant starving whichever layer
 * was cheaper. 512 is not a tuned figure — it is far above anything a real box
 * reaches, and exists so a pathological file cannot spin.
 *
 * `maxFeaturesRead` is likewise a backstop rather than a share. As a *global*
 * count it was the quiet half of the same failure: 500,000 decoded rows shared
 * by six layers, against a places layer with 478,000 rows inside a single
 * metropolitan box, left every later layer reading nothing. The per-layer bound
 * is now derived from what the footer says the planned groups actually hold.
 *
 * `maxFeaturesRetained` was 4,000, and the raise to 8,000 is not a tuning guess
 * — it is the measured diversity floor of a dense metropolis. Counted over the
 * real ground of one §29-A city (release 2026-07-22.0, all place rows of three
 * central partition cells): a single cell's visitable family spans 97–138
 * distinct source kinds, its practical family 200–243, against a per-cell
 * allowance of 205 seats for *all four* families together. No ordering of any
 * kind can keep one exemplar of each kind of experience the ground offers when
 * the seats number fewer than the kinds — the losses land on exactly the
 * records a traveller would name first, because those are one-of-three-per-kind
 * while the commodity kinds are hundreds deep. At 8,000 (409 seats per cell for
 * nine cells) a cell can seat every kind's best representative and still spread
 * the remainder across its quadrants.
 */
const DEFAULT_BUDGET: ExtractionBudget = {
  maxFiles: 14,
  maxRowGroups: 512,
  maxBytes: 260_000_000,
  maxFeaturesRead: 5_000_000,
  maxFeaturesRetained: 8_000,
  maxMs: 100_000,
};

/**
 * WHO GIVES WAY WHEN THE GROUND COSTS MORE THAN THE BUILD CAN SPEND.
 *
 * A statement of priority, not an estimate of demand — and the distinction is
 * the repair. These weights used to be read as though they predicted how much
 * each layer would need, and were then applied to a *fixed global* row-group
 * count, so a layer that stopped early left its share unspendable and a layer
 * that ran last was rationed against ground nobody had looked at. The
 * infrastructure layer, which is where a ferry terminal and a trailhead car park
 * come from, was reserved eight per cent of a number the layers before it had
 * usually already exhausted.
 *
 * Two things changed. Demand is now *known* rather than guessed — the footer
 * prices the whole pruned set exactly, so a layer that can afford its area reads
 * all of it and the weights never enter the arithmetic. And when they do enter
 * it, they are applied to what is **still unspent** and renormalised over the
 * layers still to come, so an underspending layer's leftovers flow forward and
 * the last layer is entitled to everything that is left rather than to a
 * fraction of everything that once was.
 *
 * The same weights divide retention, where they are a policy about what a pack
 * should be made of rather than a cost at all: places is the inventory, the
 * geographic layers together carry a national park's, and a few hundred division
 * polygons answer every containment question a region has.
 */
const LAYER_SHARE: Record<string, number> = {
  divisions: 0.08,
  places: 0.46,
  land: 0.14,
  water: 0.12,
  land_use: 0.12,
  infrastructure: 0.08,
};

/**
 * WHAT A CELL'S RETENTION IS SPENT ON, BY WHAT THE RECORD IS FOR.
 *
 * A cell's share used to be spent first-come: whichever records the reader
 * happened to decode first filled it, in parquet row order. On a dense city
 * that is a lottery weighted by commercial mapping density, and the live
 * result was a metropolitan pack of 1,840 places holding 726 records the
 * planner can never use — cash machines, dental clinics, package lockers — and
 * 103 attractions, none of which was one of the city's landmarks.
 *
 * §12.2 says the raw search may be broad and the kept set must be *deliberately
 * bounded*, so the boundary is drawn here, by purpose. Every family is
 * represented because a pack is ground rather than a board — a day still needs
 * a meal, a station and a shop — and unspent share flows to whoever can use it,
 * so a coast with no restaurants reads more coast rather than holding empty
 * seats for restaurants that do not exist.
 *
 * The residual family is the one that matters most and is easiest to miss.
 * A record whose role is `excluded` can never become a candidate — the
 * inventory's `roleOfRecord` honours a stored refusal permanently — so every
 * seat it takes is a seat no traveller will ever see. It keeps a small share
 * rather than none because the linker reads across layers and a pack is
 * evidence as well as inventory.
 */
const RECALL_FAMILY_SHARE: Record<RecallFamily, number> = {
  visitable: 0.5,
  food: 0.2,
  practical: 0.2,
  residual: 0.1,
};

type RecallFamily = 'visitable' | 'food' | 'practical' | 'residual';

function recallFamilyOf(role: PlanningRole): RecallFamily {
  switch (role) {
    case 'attraction':
    case 'outdoor':
    case 'side_quest':
    case 'market':
      return 'visitable';
    case 'food':
      return 'food';
    case 'support':
    case 'gateway':
    case 'lodging':
      return 'practical';
    default:
      return 'residual';
  }
}

/**
 * HOW MUCH A RECORD WOULD COST US TO LOSE, FROM WHAT THE ROW ITSELF CARRIES.
 *
 * The ordering the retention pass never had. Records were kept first-N-per-cell
 * in parquet row order, and the overflow backfill was `overflow.slice(0, n)`
 * under a comment claiming "whatever is left over by rank" while doing no
 * ranking at all — so a condominium that happened to sit in an earlier row
 * group evicted whatever came later, which in a dense city is most of the city.
 *
 * This is deliberately the *same* model the compiler ranks candidates with —
 * `experienceSignificanceOf` over `assessPlaceStanding` — restricted to the
 * channels a single normalised row can answer for itself: what kind of thing
 * the source says it is, and whether a knowledge base or a public authority has
 * taken note of it. The pack-wide channels (cross-layer corroboration, the
 * region's own namesakes) genuinely cannot be known here, and an absent channel
 * is absent rather than guessed.
 *
 * Sharing the model matters more than the numbers. A separate hand-rolled score
 * here would be a second opinion about significance that nothing holds to the
 * first, which is precisely how "significance" became a count of alternate
 * names one layer down. Note in particular what is *not* read: the number of
 * attributes, websites or translated names a mapper filled in. §8.3 names
 * metadata completeness as the thing significance must never be, and a
 * retention pass that ranked on it would re-import the whole defect at the one
 * layer no downstream fix can reach.
 *
 * Three evidence channels the earlier form of this function got wrong, each
 * measured on a live dense-metro build:
 *
 * **Operator URLs order nothing.** `publishedSites` used to be passed raw, so
 * a bare government-operator URL fired `authority_publication` (weight 0.5,
 * `attests: 'its_operator'`) and lifted 399 of 255,915 records of one measured
 * four-cell read by +0.35 — a ministry's registry row of a memorial stone
 * outranked every unevidenced temple in the city, and the seat layer above has
 * already banned the same channel from ordering (see `subjectAddressedSites`).
 * The sites are now filtered the same way the inventory filters them: an
 * authority page counts only when it is *addressed to this subject by name*,
 * which is a statement about the place rather than about its landlord.
 *
 * **The ground's own namesakes are now audible.** The second parameter is the
 * region-namesake channel, computed by the caller over the whole layer (see
 * `GroundNamesakeLedger`) because one row cannot know it about itself. It is
 * false wherever nobody measured it, which keeps every earlier caller exact.
 *
 * **A knowledge-base row is evidence even when its kind is not an experience.**
 * A layer's retention used to score a wikidata-bearing utility row exactly 0 —
 * indistinguishable from a cash machine — and drop it in any dense cell. But
 * the linker reads across layers: that row is the knowledge-base *twin* of a
 * places record that publishes no identifier of its own (this catalogue's
 * places theme publishes none — see `PLACE_COLUMNS`), and discarding the donor
 * starves the seat layer of the only place-attesting evidence the subject
 * could ever carry. Such records now rank at `KNOWLEDGE_DONOR_RETENTION_PRIORITY`:
 * above the zeros they used to drown among, below every rated experience, so
 * a substation with an entry still cannot displace an attraction.
 *
 * The classifying values and the mapped extent mirror what the inventory
 * itself feeds `assessPlaceStanding`, so a conferred designation (a status
 * word *and* a drawn boundary) ranks at retention exactly as it ranks at
 * eligibility, instead of being audible only after retention already lost it.
 */
export function recallPriorityOf(record: SourceRecord, groundAttested = false): number {
  const taxonomy = classifySourceCategory({
    category: record.sourceCategory,
    path: record.sourceCategoryPath,
  });
  const inKnowledgeBase =
    record.wikidataId !== undefined || record.attributes.wikipedia !== undefined;
  const extent = mappedExtentMetresOf(record);
  const standing = assessPlaceStanding({
    inKnowledgeBase,
    publishedSites: subjectAddressedSites(record),
    subjectName: record.name,
    classifyingValues: retentionClassifyingValuesOf(record),
    ...(extent !== undefined ? { mappedExtentMetres: extent } : {}),
    ...(groundAttested ? { namedInRegionRecords: true } : {}),
  });
  const score = experienceSignificanceOf({ standing, categoryWeight: taxonomy.significanceWeight });
  if (score > 0) return score;
  return inKnowledgeBase || groundAttested ? KNOWLEDGE_DONOR_RETENTION_PRIORITY : 0;
}

/**
 * What an evidence-bearing row is worth to *retention* when its kind carries
 * no experience weight at all.
 *
 * Strictly below `SCORE_STEP` (0.01), the smallest score the significance
 * model can give any rated experience, so a donor can never displace a rated
 * record — and strictly above 0, so it seats before the zeros. A pack is
 * evidence as well as inventory: the linker carries a twin's knowledge-base
 * entry across layers, and it can only do that for rows retention kept.
 *
 * Two donor classes ride this floor, and the second is the newer lesson. A
 * knowledge-base row (wikidata/wikipedia) is the cross-layer twin channel. A
 * *ground-attested name-giver* is the within-layer equivalent: a metropolis's
 * most recognisable building arrives as a weight-zero service kind, nine of
 * the eleven records embedding its name stand inside it, and it is the only
 * record in the entire source wearing the name a traveller would search for —
 * dropping it makes the subject unmatchable for every layer downstream, while
 * keeping it costs one seat in a family whose alternative occupants are
 * interchangeable zeros. Neither class can displace a rated experience; the
 * substation rule stands.
 */
export const KNOWLEDGE_DONOR_RETENTION_PRIORITY = 0.005;

/**
 * The attribute keys that say what *class* of thing a record is — a drawn
 * boundary, a heritage listing, a protection title — mirrored from the
 * inventory's own classifying-value list so the two layers read one
 * vocabulary. Values reach `assessPlaceStanding` as `key=value` and fire only
 * through `hasConferredDesignation`, which also demands a mapped extent: a
 * status word without a boundary stays inert here exactly as it does there.
 */
const RETENTION_CLASSIFYING_ATTRIBUTE_KEYS = [
  'boundary',
  'heritage',
  'historic',
  'landuse',
  'leisure',
  'natural',
  'protect_class',
  'protection_title',
  'site_type',
  'tourism',
] as const;

function retentionClassifyingValuesOf(record: SourceRecord): string[] {
  return [
    record.sourceCategory,
    ...record.sourceCategoryPath,
    ...RETENTION_CLASSIFYING_ATTRIBUTE_KEYS.flatMap((key) => {
      const value = record.attributes[key];
      return value === undefined ? [] : [`${key}=${value}`];
    }),
  ];
}

/**
 * The longer side of the record's own outline, in metres, when it is big
 * enough to be worth stating — the same two-significant-figure read the
 * inventory computes, duplicated here only because the two live in different
 * packages and this one may not depend on that private helper. It exists so a
 * designation can be a boundary somebody drew rather than a word somebody
 * filed under, at retention as everywhere else.
 */
function mappedExtentMetresOf(record: SourceRecord): number | undefined {
  const bounds = record.bounds;
  if (!bounds) return undefined;
  const latMetres = (bounds.northEast.lat - bounds.southWest.lat) * METRES_PER_DEGREE_LAT;
  const midLat = ((bounds.northEast.lat + bounds.southWest.lat) / 2) * (Math.PI / 180);
  const lngMetres =
    (bounds.northEast.lng - bounds.southWest.lng) * METRES_PER_DEGREE_LAT * Math.cos(midLat);
  const longest = Math.max(latMetres, lngMetres);
  if (!Number.isFinite(longest) || longest < 100) return undefined;
  return longest >= 1000 ? Math.round(longest / 100) * 100 : Math.round(longest / 10) * 10;
}

const METRES_PER_DEGREE_LAT = 111_320;

// ---------------------------------------------------------------------------
// Ground attestation — the namesake channel, computed from the layer itself
// ---------------------------------------------------------------------------

/**
 * THE ONE SIGNAL THAT SEPARATES A LANDMARK FROM ITS TIE TIER, AND WHERE IT
 * COMES FROM.
 *
 * The measured failure this exists for: in a dense cell, the significance
 * model scores a city's most famous temple and six hundred neighbourhood
 * temples identically — same kind, same absent evidence — and the tie broke on
 * the source's own existence confidence, which for a sprawling landmark
 * complex reads *lower* than for a storefront (0.87 against 0.99 on the
 * measured rows). The landmark ranked 431st of 632 in its own kind, was
 * evicted before retention ever saw it, and no downstream layer can recover a
 * record a pack never kept.
 *
 * What the ground itself publishes, though, is not a tie: ten other records of
 * the same read carry the temple's name inside their own — its gate, its
 * kindergarten, a rental shop at its door — and none carries the name of any
 * of the six hundred others. People name things after the landmark next to
 * them. That is `region_namesake` evidence (`SIGNIFICANCE_CHANNELS`), a
 * statement made by somebody outside the record; a mapper cannot manufacture
 * it by filling their own listing in more completely, which is what keeps it
 * on the right side of §8.3.
 *
 * Three guards, each closing a measured false-positive class:
 *
 * - **Distance.** A namesake must stand within `GROUND_NAMESAKE_RADIUS_METRES`
 *   of its name-giver. Measured without it, a museum four characters long was
 *   "witnessed" by two unrelated museums eighty kilometres away, and a tower
 *   by a similarly-named apartment complex across the bay.
 * - **Generic names.** A record named with a bare common noun of its ground —
 *   "park", "gallery", the city's own name — embeds in hundreds of unrelated
 *   names. A name-giver's namesakes cluster around it; a common word is
 *   uniform over the city. So a key whose embeddings exceed
 *   `GENERIC_NAME_EMBEDDING_CEILING` attests only when at least
 *   `GROUND_NAMESAKE_NEAR_SHARE` of them stand inside the radius. Measured on
 *   the same rows this passes every canonical landmark (11/9, 51/8, 19/11
 *   total/near) and blocks every generic-word record (a "park"-named record at
 *   1,582 embeddings, the city's name at 6,948).
 * - **The geography's own names.** A record that merely carries the name of
 *   the neighbourhood or locality it stands in took that name *from* the
 *   geography — the seat layer's public-housing lesson — so keys equal to the
 *   record's own containment names never attest.
 *
 * Key eligibility is script-aware for the same reason the authority-page test
 * has a minimum: a short Latin run collides by accident (`park`, a two-letter
 * code), while an ideographic script carries a word per character — and the
 * measured ground's own palace is exactly two characters long. ASCII keys need
 * eight characters; anything else needs two.
 */
export const GROUND_NAMESAKE_RADIUS_METRES = 500;

/** Distinct nearby namesakes required before the channel fires. */
export const GROUND_NAMESAKE_MIN_WITNESSES = 2;

/** Embeddings beyond this are a common word unless they cluster. See above. */
export const GENERIC_NAME_EMBEDDING_CEILING = 64;

/** The share of a busy key's embeddings that must stand inside the radius. */
export const GROUND_NAMESAKE_NEAR_SHARE = 0.5;

const ATTESTATION_KEY_MIN_CHARS = 2;
const ATTESTATION_ASCII_KEY_MIN_CHARS = 8;
const WITNESS_NAME_MIN_CHARS = 3;
/** Names are scanned for embedded keys up to this many folded characters. */
const WITNESS_SCAN_MAX_CHARS = 40;

/** A name as the attestation index reads it: folded, no separators at all. */
export function groundNameKeyOf(name: string): string {
  return foldForMatch(name).replace(/[^\p{L}\p{N}]+/gu, '');
}

function attestationKeyEligible(key: string): boolean {
  if (/^[\x20-\x7e]*$/.test(key)) return key.length >= ATTESTATION_ASCII_KEY_MIN_CHARS;
  return key.length >= ATTESTATION_KEY_MIN_CHARS;
}

/**
 * The keys under which a record may be recognised as a name-giver.
 *
 * The primary name, its joined renderings, and the published alternates. The
 * rendering split is not a nicety: the measured ground's tallest landmark
 * publishes its primary as two scripts joined by ` / `, a key no namesake's
 * name can embed whole — while either half alone is embedded by a dozen shops
 * at its base. A second dense metropolis showed the same shape with the second
 * rendering *parenthesised* instead of slash-joined: the destination's most
 * famous complex publishes its own record as `<CJK name> (<Latin name>)`, a
 * single key neither the seventeen namesakes inside its walls nor the guard's
 * arithmetic can ever embed, so the one record every traveller would name
 * first was the one record the channel could not hear. Both joiners now yield
 * their segments. Containment names are excluded per the third guard above.
 */
export function groundAttestationKeysOf(record: {
  name: string;
  alternateNames: readonly string[];
  containment: RecordContainment;
}): string[] {
  const banned = new Set(
    [record.containment.neighbourhoodName, record.containment.localityName]
      .filter((name): name is string => typeof name === 'string')
      .map((name) => groundNameKeyOf(name)),
  );
  const keys = new Set<string>();
  const consider = (text: string): void => {
    const key = groundNameKeyOf(text);
    if (attestationKeyEligible(key) && !banned.has(key)) keys.add(key);
  };
  consider(record.name);
  for (const segment of renderingSegmentsOf(record.name)) consider(segment);
  for (const alternate of record.alternateNames) consider(alternate);
  return [...keys];
}

/**
 * The renderings a joined primary carries, or nothing for a plain name.
 *
 * Two joiner shapes, both measured on live ground: ` / ` between scripts, and
 * a parenthesised second rendering. Each parenthesised group is a segment, the
 * text outside the groups is a segment, and every segment is further split at
 * the slash joiners. The eligibility guards downstream are unchanged — a short
 * or containment-named segment still attests nothing — so this widens what can
 * be *heard*, never what is believed.
 */
function renderingSegmentsOf(name: string): string[] {
  const segments: string[] = [];
  const groups = [...name.matchAll(/[(（]([^)）]+)[)）]/gu)];
  if (groups.length > 0) {
    for (const group of groups) segments.push(group[1]!);
    segments.push(name.replace(/[(（][^)）]*[)）]/gu, ' '));
  } else {
    segments.push(name);
  }
  const rendered = segments.flatMap((segment) => segment.split(/[/／]/));
  return rendered.length > 1 ? rendered : [];
}

/**
 * Every name the layer's read decoded, held light — key and position only —
 * so the namesake channel can be computed over the *whole* ground at drain
 * time, including the hundreds of thousands of rows the pens rightly declined
 * to hold. A witness does not need to be keepable to be a witness: the
 * kindergarten that names the temple is commodity ground, and its name is
 * still a statement about the temple.
 *
 * Cost, measured on a real four-cell metropolitan read (255,915 rows,
 * 16,050 candidate name-givers): the full scan runs in under one second and
 * the ledger holds roughly 50 bytes a row. Deterministic by construction —
 * counting distinct entries is independent of arrival order.
 */
export class GroundNamesakeLedger {
  private readonly entries: {
    id: string;
    key: string;
    lat: number;
    lng: number;
    /** Whether this entry's own whole name may act as a name-giver site. */
    siteEligible: boolean;
  }[] = [];

  note(record: SourceRecord): void {
    const key = groundNameKeyOf(record.name);
    if (key.length < WITNESS_NAME_MIN_CHARS) return;
    const containmentKeys = [
      record.containment.neighbourhoodName,
      record.containment.localityName,
    ]
      .filter((name): name is string => typeof name === 'string')
      .map((name) => groundNameKeyOf(name));
    /*
     * Only a record that could itself be the thing a traveller goes to may
     * found a complex: visitable, or residual (the weight-zero venue kinds the
     * complex rule exists for). A station, a mall or a hotel is a name-giver
     * too — the ground writes their names into everything around them — but a
     * way to reach somewhere and a place to buy things are not complexes whose
     * seat-claim belongs on an attraction standing nearby. Measured without
     * this line: 423 qualifying sites in two cells of a dense metropolis, led
     * by the central station (129 witnesses) and a department store (67).
     */
    const family = recallFamilyOf(record.planningRole);
    this.entries.push({
      id: record.id,
      key,
      lat: record.coordinates.lat,
      lng: record.coordinates.lng,
      siteEligible:
        attestationKeyEligible(key) &&
        !containmentKeys.includes(key) &&
        (family === 'visitable' || family === 'residual'),
    });
  }

  /**
   * Which of `records` the ground itself attests, by the rule in the module
   * comment above: at least `GROUND_NAMESAKE_MIN_WITNESSES` distinct other
   * records embedding one of the record's keys within
   * `GROUND_NAMESAKE_RADIUS_METRES`, with the generic-name guard applied.
   */
  attestedAmong(records: readonly SourceRecord[]): Set<string> {
    return this.attestations(records).attested;
  }

  /**
   * The full verdict: the attested targets, every name-giver *site* the
   * whole ground supports — including the ones whose own record no pen could
   * afford to hold — and, per target, **how many** nearby records name it.
   *
   * The count is the newer lesson, and it was measured before it was added.
   * The channel used to be one bit: two near witnesses and above all read as
   * the same "attested", and the ordering inside the lifted tier fell back to
   * source confidence. On a live dense-metro cell the bit fired for 212 of one
   * cell's visitable records — mostly through the complex seat-lift below, one
   * beneficiary per site — so the city's headline temple (eight distinct
   * records embedding its name within the radius) tied with two-witness
   * neighbourhood shrines and lost the tie on a per-provider confidence figure
   * that reads *lower* for sprawling landmarks than for storefronts. The same
   * flattening cost the national museum: its one guard-passing witness rounded
   * down to "not attested", indistinguishable from the thirty-seven galleries
   * around it with none. The ground publishes a graded signal; flattening it
   * to a bit at 2 was where the information died.
   *
   * So the verdict now carries the measured near-witness count per target —
   * every guard (radius, generic-name clustering, containment names, key
   * eligibility) still applied, no minimum — for the retention pass to order
   * ties with. The *attested* set is unchanged: the significance channel still
   * demands `GROUND_NAMESAKE_MIN_WITNESSES`, because a single embedding can be
   * coincidence and a score lift needs more than coincidence. A count used
   * only to order records the model already ties is a strictly weaker claim,
   * and it is a claim made by other records' names — not something a mapper
   * can manufacture by completing their own listing, which keeps it on the
   * right side of §8.3 exactly as the binary channel is.
   *
   * The second list exists for a measured failure the first cannot express. A
   * dense metropolis's most recognisable building arrives as a weight-zero
   * service kind at source confidence 0.599, prices 0.000, and is evicted by
   * the sink's residual pen (top 3,680 of ~10,000 zeros, ordered by the only
   * thing zeros have — confidence) before the drain ever runs. Nine of the
   * eleven records embedding its name stand inside it: the ground attests the
   * *complex* loudly, and the verdict had nowhere to be written because the
   * record was gone. The ledger, which holds every accepted row's name and
   * position precisely because "a witness does not need to be keepable", is
   * the one place the site survives — so it reports the site, and the caller
   * decides which surviving record of the complex the seat-claim lands on.
   *
   * One refusal the target path never needed: a key worn by several entries
   * standing apart is a *brand*, not a place — a convenience-store chain's
   * name is embedded by two of its own branch stores inside any 500 m of a
   * dense city, and each store would otherwise become a "complex". Entries
   * sharing a key qualify as a site only when they all stand within the
   * namesake radius of the first, which is one physical complex mapped more
   * than once.
   */
  attestations(records: readonly SourceRecord[]): {
    attested: Set<string>;
    namesakeSites: NamesakeSite[];
    /** Guard-passing near-witness count per target id. Absent means zero. */
    witnessesByTarget: Map<string, number>;
  } {
    const targetsByKey = new Map<string, { id: string; lat: number; lng: number }[]>();
    for (const record of records) {
      for (const key of groundAttestationKeysOf(record)) {
        const sites = targetsByKey.get(key) ?? [];
        sites.push({ id: record.id, lat: record.coordinates.lat, lng: record.coordinates.lng });
        targetsByKey.set(key, sites);
      }
    }
    /* Entry-sites: one per key, brands refused per the header. */
    const entrySitesByKey = new Map<string, { id: string; lat: number; lng: number } | null>();
    for (const entry of this.entries) {
      if (!entry.siteEligible) continue;
      const existing = entrySitesByKey.get(entry.key);
      if (existing === undefined) {
        entrySitesByKey.set(entry.key, { id: entry.id, lat: entry.lat, lng: entry.lng });
        continue;
      }
      if (existing === null) continue;
      const dLat = (entry.lat - existing.lat) * METRES_PER_DEGREE_LAT;
      const dLng =
        (entry.lng - existing.lng) *
        METRES_PER_DEGREE_LAT *
        Math.cos(((entry.lat + existing.lat) / 2) * (Math.PI / 180));
      if (Math.hypot(dLat, dLng) > GROUND_NAMESAKE_RADIUS_METRES) {
        entrySitesByKey.set(entry.key, null);
      }
    }
    /*
     * The index that keeps the ledger pass linear whatever the names look
     * like: for each leading two characters, the *distinct key lengths* that
     * occur under them. Each position of each name then probes one substring
     * per length against the key map directly — so a hundred thousand keys
     * sharing one prefix cost the same as three sharing it, where a per-prefix
     * candidate list would have made this scan quadratic in exactly the
     * uniformly-named case the huge-layer regression test builds.
     */
    const gramLengths = new Map<string, number[]>();
    const noteKey = (key: string): void => {
      const gram = key.slice(0, 2);
      const lengths = gramLengths.get(gram) ?? [];
      if (!lengths.includes(key.length)) lengths.push(key.length);
      gramLengths.set(gram, lengths);
    };
    for (const key of targetsByKey.keys()) noteKey(key);
    for (const [key, site] of entrySitesByKey) if (site) noteKey(key);
    for (const lengths of gramLengths.values()) lengths.sort((a, b) => a - b);
    const near = new Map<string, number>();
    const total = new Map<string, number>();
    const entryNear = new Map<string, number>();
    const entryTotal = new Map<string, number>();
    const metresApart = (
      a: { lat: number; lng: number },
      b: { lat: number; lng: number },
    ): number => {
      const dLat = (a.lat - b.lat) * METRES_PER_DEGREE_LAT;
      const dLng =
        (a.lng - b.lng) * METRES_PER_DEGREE_LAT * Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180));
      return Math.hypot(dLat, dLng);
    };
    for (const entry of this.entries) {
      const matched = new Set<string>();
      const limit = Math.min(entry.key.length - 1, WITNESS_SCAN_MAX_CHARS);
      for (let index = 0; index < limit; index += 1) {
        const lengths = gramLengths.get(entry.key.slice(index, index + 2));
        if (!lengths) continue;
        for (const length of lengths) {
          /* Strict embedding only: an equal name is a duplicate, not a namesake. */
          if (length >= entry.key.length || index + length > entry.key.length) break;
          const key = entry.key.slice(index, index + length);
          if (matched.has(key)) continue;
          const sites = targetsByKey.get(key);
          const entrySite = entrySitesByKey.get(key);
          if (!sites && !entrySite) continue;
          matched.add(key);
          for (const site of sites ?? []) {
            if (site.id === entry.id) continue;
            const label = `${site.id} ${key}`;
            total.set(label, (total.get(label) ?? 0) + 1);
            if (metresApart(entry, site) <= GROUND_NAMESAKE_RADIUS_METRES) {
              near.set(label, (near.get(label) ?? 0) + 1);
            }
          }
          if (entrySite && entrySite.id !== entry.id) {
            entryTotal.set(key, (entryTotal.get(key) ?? 0) + 1);
            const apart = metresApart(entry, entrySite);
            if (apart <= GROUND_NAMESAKE_RADIUS_METRES) {
              entryNear.set(key, (entryNear.get(key) ?? 0) + 1);
            }
          }
        }
      }
    }
    /* One clustering rule for both site shapes; see the module comment above. */
    const genuine = (nearCount: number, totalCount: number): boolean =>
      totalCount <= GENERIC_NAME_EMBEDDING_CEILING ||
      nearCount / totalCount >= GROUND_NAMESAKE_NEAR_SHARE;
    const clusters = (nearCount: number, totalCount: number): boolean =>
      nearCount >= GROUND_NAMESAKE_MIN_WITNESSES && genuine(nearCount, totalCount);
    const attested = new Set<string>();
    const witnessesByTarget = new Map<string, number>();
    for (const [label, nearCount] of near) {
      const totalCount = total.get(label) ?? nearCount;
      const id = label.slice(0, label.indexOf(' '));
      if (genuine(nearCount, totalCount)) {
        /* The graded read: the target's loudest guard-passing key. */
        witnessesByTarget.set(id, Math.max(witnessesByTarget.get(id) ?? 0, nearCount));
      }
      if (clusters(nearCount, totalCount)) {
        attested.add(id);
      }
    }
    const namesakeSites: NamesakeSite[] = [];
    for (const [key, nearCount] of entryNear) {
      if (!clusters(nearCount, entryTotal.get(key) ?? nearCount)) continue;
      const site = entrySitesByKey.get(key);
      if (!site) continue;
      namesakeSites.push({ ...site, key, nearWitnesses: nearCount });
    }
    namesakeSites.sort((a, b) => b.nearWitnesses - a.nearWitnesses || a.id.localeCompare(b.id));
    return { attested, namesakeSites, witnessesByTarget };
  }
}

/**
 * A name-giver position the whole ground supports, whether or not the record
 * that wears the name could be kept. See `GroundNamesakeLedger.attestations`.
 */
export interface NamesakeSite {
  id: string;
  key: string;
  lat: number;
  lng: number;
  nearWitnesses: number;
}

/**
 * How far from a name-giver site a record may stand and still be a record *of*
 * that complex. A city block, deliberately far under the namesake radius: the
 * measured complex's own observation deck stands 15 m from the building the
 * ground names, while the nearest record of a *different* attraction is
 * hundreds of metres out — a wider bound would let one complex's witnesses
 * crown a stranger across the street.
 */
export const COMPLEX_MEMBER_RADIUS_METRES = 150;

/**
 * WHERE A COMPLEX'S SEAT-CLAIM LANDS: THE NAMED SUBJECT, OR ITS STRONGEST
 * SURVIVING RECORD.
 *
 * The measured failure, on the second §29-A metropolis: a canonical landmark's
 * own record is absent from the pack while its moat, its reservoir and a patch
 * of scrub inside its walls all hold seats — the knowledge-base identity and
 * the ground's namesakes attach to the *complex*, and nothing carried that
 * claim to a record retention could still see. Two shapes of the same loss:
 *
 * - The complex's named subject survives to the drain but sits in an
 *   evidence-blind tie tier (`attested`, the existing channel, now reaches it
 *   through joined-rendering keys).
 * - The named subject's own record could never be held at all — a weight-zero
 *   kind evicted by the sink's residual pen on confidence, or a row the source
 *   simply does not publish. The site still exists in the ledger, and its
 *   claim lands here: on the subject's own surviving record when one survives
 *   (as donor evidence, never as a synthetic experience), else on the
 *   strongest rated visitable record standing *inside* the complex — the
 *   traveller-visitable face of the thing the ground keeps naming.
 *
 * Geometry and naming only: a site is a position plus a key the ground embeds,
 * a member is a record within `COMPLEX_MEMBER_RADIUS_METRES` of it, and no
 * place name appears anywhere in the rule.
 *
 * The result is a map rather than a set, and the values are the repair for a
 * measured dilution. Lifting is common in a dense cell — one beneficiary per
 * qualifying site, 212 of one live cell's visitable records — so "lifted" alone
 * stopped separating anything and the order inside the lifted tier fell to the
 * source-confidence lottery this file already distrusts. Each lifted id now
 * carries the *strength* of the claim behind it: a target's own measured
 * near-witness count, or the site's count for a lift the ground made about the
 * complex rather than about the beneficiary. Retention orders ties on it.
 */
export function complexSeatLiftsFor(input: {
  collected: readonly SourceRecord[];
  attested: ReadonlySet<string>;
  namesakeSites: readonly NamesakeSite[];
  /** Guard-passing near-witness counts per target, from the same verdict. */
  witnessesByTarget?: ReadonlyMap<string, number>;
  /** The evidence-blind priority read, injectable for tests. */
  priorityOf?: (record: SourceRecord) => number;
  confidenceOf?: (record: SourceRecord) => number;
}): Map<string, number> {
  const priorityOf = input.priorityOf ?? ((record: SourceRecord): number => recallPriorityOf(record));
  const confidenceOf = input.confidenceOf ?? sourceConfidenceOf;
  const lifted = new Map<string, number>();
  for (const id of input.attested) {
    lifted.set(id, input.witnessesByTarget?.get(id) ?? GROUND_NAMESAKE_MIN_WITNESSES);
  }
  const strengthen = (id: string, strength: number): void => {
    lifted.set(id, Math.max(lifted.get(id) ?? 0, strength));
  };
  const byId = new Map(input.collected.map((record) => [record.id, record]));
  const priority = new Map<string, number>();
  const rankOf = (record: SourceRecord): number => {
    const known = priority.get(record.id);
    if (known !== undefined) return known;
    const rank = priorityOf(record);
    priority.set(record.id, rank);
    return rank;
  };
  for (const site of input.namesakeSites) {
    const own = byId.get(site.id);
    if (own) {
      /*
       * A rated named subject competes through the target channel above; the
       * donor floor is only for the record evidence cannot otherwise save.
       *
       * "Cannot otherwise save" includes the donor floor itself, and the
       * boundary used to be drawn one step too low. A name-giver whose kind
       * carries no experience weight but which holds a knowledge-base entry
       * ranks at `KNOWLEDGE_DONOR_RETENTION_PRIORITY` — above zero — so the
       * old `<= 0` test read it as "rated" and gave it nothing, while the
       * ledger held nine near witnesses for it. But a donor-floor rank is not
       * a rating: the significance model scored the record 0 (weight-zero
       * kind, `evidenceAdmission` 0) and the floor is retention's own
       * bookkeeping, invisible to the target channel that "already carries"
       * rated subjects. Measured on a live metropolis: the destination's
       * tallest structure arrived as a weight-zero communications kind with a
       * knowledge-base id and nine near witnesses, ranked (0.005, confidence
       * 0) in a residual queue of hundreds of identical donors, and lost an
       * id lottery. The lift's strength is the site's own witness count, so
       * the ordering below can hear what the ground says about it.
       */
      if (rankOf(own) <= KNOWLEDGE_DONOR_RETENTION_PRIORITY) {
        strengthen(own.id, site.nearWitnesses);
      }
      continue;
    }
    let best: SourceRecord | undefined;
    for (const record of input.collected) {
      if (recallFamilyOf(record.planningRole) !== 'visitable') continue;
      const dLat = (record.coordinates.lat - site.lat) * METRES_PER_DEGREE_LAT;
      if (Math.abs(dLat) > COMPLEX_MEMBER_RADIUS_METRES) continue;
      const dLng =
        (record.coordinates.lng - site.lng) *
        METRES_PER_DEGREE_LAT *
        Math.cos(((record.coordinates.lat + site.lat) / 2) * (Math.PI / 180));
      if (Math.hypot(dLat, dLng) > COMPLEX_MEMBER_RADIUS_METRES) continue;
      if (rankOf(record) <= 0) continue;
      if (
        !best ||
        rankOf(record) > rankOf(best) ||
        (rankOf(record) === rankOf(best) &&
          (confidenceOf(record) > confidenceOf(best) ||
            (confidenceOf(record) === confidenceOf(best) && record.id.localeCompare(best.id) < 0)))
      ) {
        best = record;
      }
    }
    if (best) strengthen(best.id, site.nearWitnesses);
  }
  return lifted;
}

/**
 * The source's own belief that this record describes a real, current place.
 *
 * Used as a **tie-break and nothing more**: it orders records the significance
 * model scores identically, and it can never lift a record over one the model
 * ranks higher. That restriction is what keeps it on the right side of §8.3 —
 * it is not a count of anything a mapper filled in, it is a statement the
 * source publishes *about the place's existence*, and among a hundred records
 * of the same kind with the same (usually empty) evidence it is the only
 * per-record statement the theme carries at all. Without it the order inside a
 * tie tier is the record id, which is a lottery drawn at catalogue build time —
 * and a live metropolis showed what the lottery costs: the seats inside the
 * museum-kind tier went to whichever galleries had the smallest UUIDs.
 *
 * Layers that publish no confidence (the OSM-derived geography) read 0
 * uniformly, so the tie-break is inert exactly where the evidence channels are
 * rich and active exactly where they are empty.
 */
export function sourceConfidenceOf(record: SourceRecord): number {
  let best = 0;
  for (const source of record.sources) {
    const value = source.existenceConfidence;
    if (typeof value === 'number' && value > best) best = value;
  }
  return best;
}

/**
 * The records a layer keeps: every cell served, every family represented, every
 * kind of experience the ground offers exemplified, and significance first
 * inside all of them.
 *
 * The passes, each repairing a measured live failure:
 *
 * 1. **Per family, per cell.** A cell's seats are divided by what the records
 *    are *for*, so a landmark cannot be evicted by a cash machine that decoded
 *    earlier and a pack still holds meals and stations.
 * 2. **Kind coverage inside the family.** Half of a family's share goes to the
 *    best representative of each *kind* the source publishes, best kinds first.
 *    Without this, seats inside a family go to whichever kind the city has most
 *    of: a real metropolitan cell held 945 art galleries against 3 public
 *    markets and 5 observation decks in one family, and rank-only filling spent
 *    31 seats on galleries while the city's only markets and decks lost — the
 *    generic kind's depth crowded out the ground's breadth.
 * 3. **Spatial spread inside the family.** The other half rotates across the
 *    cell's sixteen quadrants, each contributing its best remaining records —
 *    the per-cell distribution one level down, for the same reason it exists at
 *    cell level: a partition cell of a metropolis is 9 km across, and the dense
 *    quarter of it otherwise takes every seat. The city's newest island museum
 *    was the sixth-best record of an outlying quadrant and lost every seat to
 *    the gallery district before this pass existed.
 * 4. **Zero-priority records seat strictly last.** A record whose kind carries
 *    no experience weight and about which nothing is established scores exactly
 *    0 — `ratesAsExperience` is false, the inventory can never offer it — and a
 *    stored metropolitan pack spent 175 of 1,840 seats on such records (ATMs, a
 *    chiropractor, beauty salons) *while positive-priority records were refused
 *    in the same cells*. Zeros now seat only after every positive record of the
 *    cell has been offered a seat. They still seat when the ground is genuinely
 *    sparse, because a pack is evidence as well as inventory.
 * 5. **Backfill round-robin across cells, by rank.** Unchanged: a flat `slice`
 *    here once handed 78% of a metropolis to a single grid cell.
 *
 * Order inside every queue is (priority, source confidence, id) — the shared
 * significance model first, the source's own existence confidence to break its
 * ties, and the id only so two runs agree byte-for-byte.
 *
 * Exported so the property can be measured against real pack records rather
 * than only inferred from a live build nobody can afford to run in a test.
 */
export function retainAcrossCells(input: {
  records: readonly SourceRecord[];
  retentionCap: number;
  /**
   * The seats one cell's structured passes may fill.
   *
   * Omitted by the production caller, and the omission is the repair: it used
   * to be computed as `ceil(retentionCap / partitionCells)`, and a country
   * partition is mostly cells the source has nothing in — a measured country
   * grid was 45 cells with the populated coast a handful of them. Divided by
   * the partition count, a dense cell's structured share (family shares, kind
   * coverage, spatial spread) collapsed to a sliver and the rest of its seats
   * arrived through the rank-only backfill, which knows nothing about breadth
   * — the deepest commodity kind flooded the cell. When absent, the share is
   * derived below from the cells that actually hold records, so seats follow
   * data and empty ground holds none. Injectable for tests and for callers
   * that genuinely know better.
   */
  perCellCap?: number;
  priorityOf?: (record: SourceRecord) => number;
  /**
   * How many other records of the whole read embed this record's name nearby —
   * the graded ground-namesake count, guard-passed, from the layer's ledger.
   *
   * Ordered between priority and confidence, and the placement is the point.
   * The order inside a significance tie tier used to fall straight to source
   * confidence, and confidence is a statement about *existence* made by the
   * record's own provider — measured on a live metropolis it reads lower for a
   * sprawling landmark complex than for the storefronts around it, so the one
   * record of a tier the ground names eight times lost its seat to neighbours
   * it out-evidences. A namesake count is a statement about *standing* made by
   * other records; where it is zero everywhere — every caller that omits this,
   * and every quiet layer — the ordering is exactly what it was.
   */
  groundWitnessesOf?: (record: SourceRecord) => number;
  /** The confidence read for the tie-break. Injected for tests only. */
  confidenceOf?: (record: SourceRecord) => number;
  /**
   * Which quadrant of its cell a record sits in, for the spatial pass.
   *
   * Injected because only the caller knows the cell geometry. Defaulting to one
   * quadrant makes the spatial pass a plain rank fill, which is exactly what a
   * caller without geometry should get.
   */
  subcellFor?: (record: SourceRecord) => string;
  /**
   * Record ids that are kept before any budget applies.
   *
   * Not a priority boost — an exemption. Everything else in this function is
   * about which of many comparable records deserve a scarce seat, and the
   * destination's own administrative record is not one of many: it is the thing
   * the pack is *about*, and it is the only evidence from which "does this
   * record belong to the traveller's destination" can be answered at all. A
   * stored Tokyo build proved what ranking it costs — the scan read the division
   * record sitting at the exact scope centre, retention ranked it against 800
   * neighbourhood polygons on the same significance model every place is ranked
   * on, and dropped it. Nothing downstream could recover it, and 3,767 of 3,787
   * records came back with no membership verdict.
   *
   * Kept outside the cap rather than inside it, so admitting the destination
   * cannot silently evict a record somebody would have seen.
   */
  pinned?: ReadonlySet<string>;
}): { kept: SourceRecord[]; dropped: number } {
  const priorityOf = input.priorityOf ?? recallPriorityOf;
  const groundWitnessesOf = input.groundWitnessesOf ?? ((): number => 0);
  const confidenceOf = input.confidenceOf ?? sourceConfidenceOf;
  const subcellFor = input.subcellFor ?? ((): string => '0');
  const cap = Math.max(0, Math.trunc(input.retentionCap));

  const pinnedIds = input.pinned ?? new Set<string>();
  const pinnedRecords =
    pinnedIds.size === 0 ? [] : input.records.filter((record) => pinnedIds.has(record.id));
  const contested =
    pinnedIds.size === 0 ? input.records : input.records.filter((record) => !pinnedIds.has(record.id));

  /*
   * The per-cell seat share, derived from the cells that hold records — never
   * from a partition's cell count. See the field comment above: dividing by
   * cells that hold nothing starves the structured passes of the cells that
   * hold everything, and an uncapped country partition is mostly empty cells.
   */
  const populatedCells = new Set(contested.map((record) => record.cellId)).size;
  const perCellCap = Math.max(
    1,
    Math.trunc(input.perCellCap ?? Math.max(4, Math.ceil(cap / Math.max(1, populatedCells)))),
  );

  /* Ranked once. Ties broken by id so a pack's bytes do not depend on I/O order. */
  const ranked = new Map<string, number>();
  const witnesses = new Map<string, number>();
  const confidence = new Map<string, number>();
  for (const record of contested) {
    ranked.set(record.id, priorityOf(record));
    witnesses.set(record.id, groundWitnessesOf(record));
    confidence.set(record.id, confidenceOf(record));
  }
  const byRank = (a: SourceRecord, b: SourceRecord): number =>
    (ranked.get(b.id) ?? 0) - (ranked.get(a.id) ?? 0) ||
    (witnesses.get(b.id) ?? 0) - (witnesses.get(a.id) ?? 0) ||
    (confidence.get(b.id) ?? 0) - (confidence.get(a.id) ?? 0) ||
    a.id.localeCompare(b.id);

  const cells = new Map<string, Map<RecallFamily, SourceRecord[]>>();
  const zerosByCell = new Map<string, SourceRecord[]>();
  for (const record of contested) {
    /*
     * Invariant: a record scoring exactly zero never holds a seat any
     * positive-priority record of the same cell was refused. See pass 4 above.
     */
    if ((ranked.get(record.id) ?? 0) <= 0) {
      const queue = zerosByCell.get(record.cellId) ?? [];
      queue.push(record);
      zerosByCell.set(record.cellId, queue);
      continue;
    }
    const families = cells.get(record.cellId) ?? new Map<RecallFamily, SourceRecord[]>();
    const family = recallFamilyOf(record.planningRole);
    const queue = families.get(family) ?? [];
    queue.push(record);
    families.set(family, queue);
    cells.set(record.cellId, families);
  }
  for (const [cellId] of zerosByCell) {
    if (!cells.has(cellId)) cells.set(cellId, new Map());
  }

  const kept: SourceRecord[] = [];
  const spare: SourceRecord[] = [];
  const cellIds = [...cells.keys()].sort();
  for (const cellId of cellIds) {
    const families = cells.get(cellId)!;
    let takenInCell = 0;
    const leftover: SourceRecord[] = [];
    /* Fixed family order, so two runs over the same records agree exactly. */
    const order: RecallFamily[] = ['visitable', 'food', 'practical', 'residual'];
    for (const family of order) {
      const queue = families.get(family) ?? [];
      const share = Math.min(
        Math.max(1, Math.round(perCellCap * RECALL_FAMILY_SHARE[family])),
        Math.max(0, perCellCap - takenInCell),
      );
      const seated = new Set<string>();

      /* Pass 2: kind coverage — each kind's best, best kinds first. */
      const kinds = new Map<string, SourceRecord[]>();
      for (const record of queue) {
        const kindQueue = kinds.get(record.sourceCategory) ?? [];
        kindQueue.push(record);
        kinds.set(record.sourceCategory, kindQueue);
      }
      for (const kindQueue of kinds.values()) kindQueue.sort(byRank);
      const heads = [...kinds.values()].sort((a, b) => byRank(a[0]!, b[0]!));
      const coverageSeats = Math.min(share, Math.ceil(share * KIND_COVERAGE_SHARE), heads.length);
      for (let index = 0; index < coverageSeats; index += 1) {
        const head = heads[index]![0]!;
        kept.push(head);
        seated.add(head.id);
        takenInCell += 1;
      }

      /* Pass 3: spatial spread — quadrants rotate, best remaining first. */
      let spatialSeats = share - coverageSeats;
      if (spatialSeats > 0) {
        const subcells = new Map<string, SourceRecord[]>();
        for (const record of queue) {
          if (seated.has(record.id)) continue;
          const subcellQueue = subcells.get(subcellFor(record)) ?? [];
          subcellQueue.push(record);
          subcells.set(subcellFor(record), subcellQueue);
        }
        for (const subcellQueue of subcells.values()) subcellQueue.sort(byRank);
        const rotation = [...subcells.entries()]
          .sort((a, b) => byRank(a[1][0]!, b[1][0]!) || a[0].localeCompare(b[0]))
          .map(([, subcellQueue]) => subcellQueue);
        const cursors = rotation.map(() => 0);
        let progressed = true;
        while (spatialSeats > 0 && progressed) {
          progressed = false;
          for (let index = 0; index < rotation.length && spatialSeats > 0; index += 1) {
            const next = rotation[index]![cursors[index]!];
            if (!next) continue;
            cursors[index] = cursors[index]! + 1;
            kept.push(next);
            seated.add(next.id);
            takenInCell += 1;
            spatialSeats -= 1;
            progressed = true;
          }
        }
      }

      for (const record of queue) if (!seated.has(record.id)) leftover.push(record);
    }
    /*
     * Whatever the shares left unspent, to whoever is still queued, best first —
     * and only then to the zero-priority records, best first among themselves,
     * so a sparse cell still fills with evidence while a dense one never spends
     * a seat on a record the inventory can never offer.
     */
    leftover.sort(byRank);
    const zeros = (zerosByCell.get(cellId) ?? []).sort(byRank);
    const fillQueue = [...leftover, ...zeros];
    const remaining = Math.max(0, perCellCap - takenInCell);
    kept.push(...fillQueue.slice(0, remaining));
    spare.push(...fillQueue.slice(remaining));
  }

  /*
   * The backfill, one cell at a time. `spare` is grouped again rather than
   * sorted globally: a global sort by priority would hand the whole backfill to
   * whichever cell the reader happened to cover, which is the corner bias in a
   * more respectable coat.
   */
  const spareByCell = new Map<string, SourceRecord[]>();
  for (const record of spare) {
    const queue = spareByCell.get(record.cellId) ?? [];
    queue.push(record);
    spareByCell.set(record.cellId, queue);
  }
  for (const queue of spareByCell.values()) queue.sort(byRank);
  const rotation = [...spareByCell.keys()].sort();
  let backfilled = 0;
  for (let round = 0; kept.length < cap; round += 1) {
    let progressed = false;
    for (const cellId of rotation) {
      if (kept.length >= cap) break;
      const next = spareByCell.get(cellId)![round];
      if (!next) continue;
      kept.push(next);
      backfilled += 1;
      progressed = true;
    }
    if (!progressed) break;
  }

  return {
    kept: [...pinnedRecords, ...kept.slice(0, cap)],
    dropped: Math.max(0, spare.length - backfilled),
  };
}

/**
 * THE DESTINATION'S OWN ADMINISTRATIVE RECORDS, AND THE ANCESTRY THEY NEED.
 *
 * Two kinds of record, and the second is the one that is easy to miss.
 *
 * The first is the destination itself: a record whose catalogue identifier is
 * one the scope declares. That is a division which *is* the destination rather
 * than one competing to describe it.
 *
 * The second is its published ancestry. A division is recognised through the
 * chain it publishes — the directory keys an entry by the last identifier in its
 * own chain — so a ward, a county or a first-level division named in the
 * destination's chain is the evidence by which a record near the edge is placed
 * inside it at all. Those are read from the destination's own published chain
 * rather than assumed from position, and only records the scan already returned
 * are pinned: nothing here manufactures a division the source did not hand us.
 */
export function destinationDivisionRecordIds(
  records: readonly SourceRecord[],
  identifiers: ReadonlySet<string>,
): Set<string> {
  if (identifiers.size === 0) return new Set();
  const own = records.filter(
    (record) => record.planningRole === 'administrative' && identifiers.has(record.sourceId),
  );
  if (own.length === 0) return new Set();

  const ancestry = new Set(own.flatMap((record) => record.containment.divisionIds));
  return new Set(
    records
      .filter(
        (record) =>
          record.planningRole === 'administrative' &&
          (identifiers.has(record.sourceId) || ancestry.has(record.sourceId)),
      )
      .map((record) => record.id),
  );
}

export function createOverturePackProvider(
  options: PackProviderOptions = {},
): RegionPackProvider {
  const budget: ExtractionBudget = { ...DEFAULT_BUDGET, ...options.budget };
  const now = options.now ?? ((): Date => new Date());

  return {
    name: 'overture-pack',
    async getPack(input): Promise<RegionPackOutcome> {
      const startedAt = Date.now();
      const deadlineMs = startedAt + budget.maxMs;
      const clock = input.now ?? now();

      let release: SourceRelease;
      try {
        release = await latestRelease(options.fetchOptions ?? {});
      } catch (error) {
        const message =
          error instanceof CatalogError
            ? error.message
            : 'We could not reach the place data catalogue.';
        return { kind: 'unavailable', code: 'provider_unavailable', message };
      }

      const partition = partitionScope(input.scope);
      input.onProgress?.({
        state: 'partitioning',
        detail: `${partition.cells.length} ${partition.cells.length === 1 ? 'area' : 'areas'} to read`,
      });

      const packId =
        options.idFor?.(input.scope, release) ??
        `pack-${input.scope.destinationCandidateId}-${release.releaseId}`;

      const counters: ScanCounters = {
        bytesTransferred: 0,
        rowGroupsInspected: 0,
        rowGroupsRead: 0,
        featuresRead: 0,
      };

      const layers: PackLayer[] = [];
      const acquisitions: LayerAcquisition[] = [];
      const layerTimings: { layerId: string; ms: number }[] = [];
      const budgetsExhausted = new Set<string>();
      let filesInspected = 0;
      const containment = new ContainmentIndex();

      /*
       * THE DESTINATION'S OWN IDENTITY IS NOT RESOLVED HERE ANY MORE.
       *
       * It used to be, mid-build, from the divisions layer, on a small share of
       * the extraction budget — and that made a *membership* answer depend on a
       * *budget*. Starve the divisions share and the destination's identity was
       * unresolvable, every candidate fell to the conservative rung, and the
       * consumer's escape hatch admitted the lot. One budget-starved build
       * reproduced the whole defect.
       *
       * The divisions the extraction *does* keep are stored in the pack like any
       * other layer, and the trip-scope overlay resolves both sides of the
       * comparison against them, per trip, with whatever coverage there is — and
       * reports the coverage rather than degrading into a promotion.
       */
      for (const definition of LAYERS) {
        if (input.signal?.aborted) {
          budgetsExhausted.add('cancelled');
          break;
        }
        const layerStart = Date.now();
        input.onProgress?.({ state: 'extracting', detail: labelFor(definition.id) });

        const result = await extractLayer({
          definition,
          release,
          cells: partition.cells,
          counters,
          budget,
          deadlineMs,
          fetchOptions: options.fetchOptions ?? {},
          containment,
          scan: options.scanImpl ?? scanFile,
          /*
           * What the traveller's own destination is, in catalogue identifiers.
           *
           * Carried into the extraction so retention can tell "the thing this
           * pack is about" from "another candidate for a seat". Empty for a
           * geocoded destination, which retains exactly as it did before.
           */
          destinationDivisionIds: new Set(input.scope.administrative?.divisionIds ?? []),
          ...(input.signal ? { signal: input.signal } : {}),
        });

        filesInspected += result.filesInspected;
        /*
         * Named by layer, because an unqualified reason cannot be acted on.
         *
         * A stored metropolitan build reported `retained, retained_budget` for
         * the whole pack; the first was ordinary policy on a dense layer and the
         * second was the inventory being abandoned two-thirds of the way through
         * the destination, and the diagnostic could not tell them apart. Two
         * words and a colon are the difference between a number somebody reads
         * and a number somebody acts on.
         */
        for (const reason of result.budgetsExhausted) {
          budgetsExhausted.add(`${definition.id}:${reason}`);
        }
        layers.push(result.layer);
        acquisitions.push(result.acquisition);
        layerTimings.push({ layerId: definition.id, ms: Date.now() - layerStart });
        input.onProgress?.({ state: 'extracting', detail: acquisitionLineFor(result.acquisition) });

        if (definition.id === 'divisions') {
          /*
           * Loaded so the *labels* on later layers' records are real: a place
           * inside a published neighbourhood box gets that neighbourhood's name
           * as evidence. That is a fact about the ground and belongs in a pack.
           * What does not belong is a verdict about a traveller's destination.
           */
          containment.load(result.layer.records);
        }
      }

      /*
       * ONE MORE PASS FOR THE LAYERS THE CLOCK LEFT EMPTY.
       *
       * The layers run in a fixed order against one shared deadline, so when a
       * slow link makes the early layers expensive, the cost lands wholesale on
       * whichever layers had not started yet — and those are exactly the ground
       * layers whose nearby records attest a landmark's identity. A live
       * metropolitan build on a ~1 MB/s link spent 86 of its 100 s on divisions
       * and places, then shipped water, land-use and infrastructure as empty:
       * 4,368 records where the previous build of the same ground held 7,114,
       * and canonical acquisition fell from 1.00 to 0.63 — while the job it ran
       * in still had six unspent minutes.
       *
       * So a layer that ended with every cell failed *for a time-class reason*
       * gets one more window. Never for policy stops — a layer bounded by
       * retention or bytes was read and deliberately bounded — and never when
       * the caller has cancelled. The ordinary build, which fits its window
       * comfortably, takes this branch zero times.
       */
      const RETRYABLE_REASONS = new Set(['time', 'time_budget', 'timeout', 'unreachable', 'transfer_holes']);
      let starved = layers
        .map((layer, index) => ({ layer, index, definition: LAYERS[index]! }))
        .filter(
          ({ layer, definition }) =>
            (layer.failedCellIds.length >= partition.cells.length ||
              budgetsExhausted.has(`${definition.id}:transfer_holes`)) &&
            [...budgetsExhausted].some(
              (reason) =>
                reason.startsWith(`${definition.id}:`) &&
                RETRYABLE_REASONS.has(reason.slice(definition.id.length + 1)),
            ),
        );
      /*
       * How long the completion passes may keep buying windows. Without a
       * caller deadline this is exactly one extra window, as before. With one
       * — the job's own ceiling less its reserve, threaded from the compile —
       * the passes continue while starved ground remains and the caller's
       * budget allows, because the measured alternative was worse: at
       * ~0.4 MB/s live throughput, two fixed windows left every layer starved
       * and twelve consecutive rebuild rounds could not produce a ready pack
       * while ten job-minutes went unspent. The window count is backstopped,
       * not budgeted — the caller's clock is the budget.
       */
      const completionCutoffMs = input.deadlineMs ?? Date.now() + budget.maxMs;
      let completionWindows = 0;
      while (starved.length > 0 && !input.signal?.aborted && completionWindows < 8) {
        completionWindows += 1;
        if (completionWindows > 1 && Date.now() + 30_000 > completionCutoffMs) break;
        const retryDeadline = Math.min(Date.now() + budget.maxMs, completionCutoffMs);
        for (const entry of starved) {
          if (input.signal?.aborted || Date.now() > retryDeadline) break;
          input.onProgress?.({
            state: 'extracting',
            detail: `${labelFor(entry.definition.id)}: reading again — the first pass ran out of time`,
          });
          const retryStart = Date.now();
          const retry = await extractLayer({
            definition: entry.definition,
            release,
            cells: partition.cells,
            counters,
            budget,
            deadlineMs: retryDeadline,
            fetchOptions: options.fetchOptions ?? {},
            containment,
            scan: options.scanImpl ?? scanFile,
            destinationDivisionIds: new Set(input.scope.administrative?.divisionIds ?? []),
            ...(input.signal ? { signal: input.signal } : {}),
          });
          const better =
            retry.layer.records.length > entry.layer.records.length ||
            (retry.layer.records.length === entry.layer.records.length &&
              retry.layer.failedCellIds.length < entry.layer.failedCellIds.length);
          if (better) {
            layers[entry.index] = retry.layer;
            acquisitions[entry.index] = retry.acquisition;
            for (const reason of [...budgetsExhausted]) {
              if (reason.startsWith(`${entry.definition.id}:`)) budgetsExhausted.delete(reason);
            }
            for (const reason of retry.budgetsExhausted) {
              budgetsExhausted.add(`${entry.definition.id}:${reason}`);
            }
          }
          const timing = layerTimings.find((row) => row.layerId === entry.definition.id);
          if (timing) timing.ms += Date.now() - retryStart;
          input.onProgress?.({ state: 'extracting', detail: acquisitionLineFor(retry.acquisition) });
        }
        starved = layers
          .map((layer, index) => ({ layer, index, definition: LAYERS[index]! }))
          .filter(
            ({ layer, definition }) =>
              (layer.failedCellIds.length >= partition.cells.length ||
                budgetsExhausted.has(`${definition.id}:transfer_holes`)) &&
              [...budgetsExhausted].some(
                (reason) =>
                  reason.startsWith(`${definition.id}:`) &&
                  RETRYABLE_REASONS.has(reason.slice(definition.id.length + 1)),
              ),
          );
        if (input.deadlineMs === undefined) break;
      }

      const totalRecords = layers.reduce((sum, layer) => sum + layer.records.length, 0);
      if (totalRecords === 0) {
        return {
          kind: 'unavailable',
          code: 'coverage_insufficient',
          message:
            'The place data catalogue returned nothing for this area. That is usually a data gap rather than an empty place.',
        };
      }

      options.onAcquisition?.({
        packId,
        releaseId: release.releaseId,
        cacheState: 'built',
        cells: partition.cells.length,
        layers: acquisitions,
        bytesTransferred: counters.bytesTransferred,
        ms: Date.now() - startedAt,
      });

      input.onProgress?.({ state: 'linking', detail: `${totalRecords} records` });

      /*
       * A hole the completion passes could not close is unread ground: the
       * pack must say `partial` so the cache treats it as a floor and a later
       * build on a healthier link completes it. Ready-with-holes was observed
       * live — a hole-punched layer carries no failed cells, so nothing else
       * marks the state — and the recall gate promptly failed acquisition
       * floors against packs whose own diagnostics recorded the unread blocks.
       */
      const unhealedHoles = [...budgetsExhausted].filter((reason) =>
        reason.endsWith(':transfer_holes'),
      );
      const pack = assemblePack({
        id: packId,
        scope: input.scope,
        releases: [release],
        partition,
        layers,
        ...(unhealedHoles.length > 0
          ? {
              incompleteBecause: `Blocks of ${unhealedHoles
                .map((reason) => reason.split(':')[0])
                .join(', ')} could not be transferred; that ground is not represented here.`,
            }
          : {}),
        diagnostics: {
          filesInspected,
          rowGroupsInspected: counters.rowGroupsInspected,
          rowGroupsRead: counters.rowGroupsRead,
          bytesTransferred: counters.bytesTransferred,
          durationMs: Date.now() - startedAt,
          budgetsExhausted: [...budgetsExhausted].sort(),
          layerTimings,
        },
        now: clock,
      });

      if (pack.state === 'partial') {
        return {
          kind: 'partial',
          pack,
          reason: pack.failure?.detail ?? 'Some areas or layers could not be read in full.',
        };
      }
      return { kind: 'ready', pack, source: 'built' };
    },
  };
}

// ---------------------------------------------------------------------------
// One layer
// ---------------------------------------------------------------------------

interface LayerExtraction {
  layer: PackLayer;
  filesInspected: number;
  budgetsExhausted: string[];
  /** What this layer's acquisition actually did, for the job's diagnostics. */
  acquisition: LayerAcquisition;
}

/**
 * THE ACQUISITION FACTS A DIAGNOSTIC NEEDS TO TELL THE THREE STATES APART.
 *
 * "The board is thin" has three completely different causes and one number
 * cannot separate them: the ground was never read, the ground was read and
 * nothing there normalised, or the ground was read and a deliberate bound kept
 * the rest. A live metropolis spent a phase being diagnosed as the third when it
 * was the first, because the only figures recorded were retained counts.
 *
 * So each stage of the funnel is counted separately, and the two that used to be
 * conflated — how much ground the area *has* and how much of it was paid for —
 * are reported in bytes, which is what the difference is actually made of.
 */
interface LayerAcquisition {
  layerId: string;
  /** Row groups the pruning found overlapping the box, across every file. */
  rowGroupsOverlapping: number;
  /** Row groups the byte allowance paid for. */
  rowGroupsPlanned: number;
  /** Exact cost of the whole overlapping set, from the footers. */
  projectedBytes: number;
  /** What the allowance could not cover. Non-zero means the area was truncated. */
  shortfallBytes: number;
  /** Rows the reader decoded. Source rows considered. */
  rowsDecoded: number;
  /** Of those, the ones whose own position is inside the box. */
  rowsInBox: number;
  /** Of those, the ones that became a usable record. */
  rowsNormalised: number;
  /** Records dropped by the sink's memory bound before ranking ever ran. */
  rowsEvicted: number;
  /** Records the retention policy declined to keep. */
  rowsDroppedByPolicy: number;
  /** Records the pack keeps. */
  rowsRetained: number;
  bytesTransferred: number;
  ms: number;
}

/** The four purposes retention divides a cell's seats between. */
const RECALL_FAMILY_COUNT = 4;

/**
 * How much of a family's share the kind-coverage pass may spend.
 *
 * Half, so neither breadth wins outright: kind coverage alone hands every seat
 * to the head of a queue and loses the outlying quadrant's sixth-best museum;
 * spatial spread alone hands every seat to the dense quarter's galleries and
 * loses the cell's only market. Both were measured on real ground — see
 * `retainAcrossCells`.
 */
const KIND_COVERAGE_SHARE = 0.5;

/**
 * How many quadrants a partition cell is divided into per axis for the spatial
 * pass. Sixteen quadrants of a metropolitan cell are each about 2 km across —
 * fine enough that an outlying district is its own quadrant, coarse enough
 * that a quadrant still holds hundreds of records to choose from.
 */
export const RETENTION_SUBCELL_GRID = 4;

/** Records the sink holds per (cell, family, kind), so every kind's best survive. */
const SINK_KIND_KEEP = 8;

/** Records the sink holds per (cell, family, quadrant), for the spatial pass. */
const SINK_SUBCELL_KEEP = 64;

/**
 * Which quadrant of its cell a record sits in, from its own position.
 *
 * Deterministic and geometry-only. A record outside its declared cell bounds
 * (which cellFor should preclude) clamps to the nearest quadrant rather than
 * inventing one.
 */
export function subcellKeyFor(
  record: SourceRecord,
  bounds: GeoBounds | undefined,
  grid: number = RETENTION_SUBCELL_GRID,
): string {
  if (!bounds) return '0';
  const latSpan = bounds.northEast.lat - bounds.southWest.lat;
  const lngSpan = bounds.northEast.lng - bounds.southWest.lng;
  if (!(latSpan > 0) || !(lngSpan > 0)) return '0';
  const row = Math.min(
    grid - 1,
    Math.max(0, Math.floor(((record.coordinates.lat - bounds.southWest.lat) / latSpan) * grid)),
  );
  const column = Math.min(
    grid - 1,
    Math.max(0, Math.floor(((record.coordinates.lng - bounds.southWest.lng) / lngSpan) * grid)),
  );
  return `${row}-${column}`;
}

/**
 * A BOUNDED, RANKED HOLDING PEN — SO THE AREA CAN BE EXHAUSTED AT FIXED MEMORY.
 *
 * The problem this solves is the last of the counters that was in the wrong
 * unit. A dense metropolis has about 478,000 place rows inside one metropolitan
 * box; all of them are decoded, ranked, and reduced to under two thousand. The
 * previous answer to "we cannot hold 478,000 normalised records" was to **stop
 * reading at 120,000** — a heap guard that had quietly become the thing deciding
 * which two-thirds of a city the traveller was allowed to see.
 *
 * The right answer is not to raise it. It is to stop holding what is already
 * known to be unkeepable. Records arrive, are priced once by the same model
 * retention ranks on, and each (cell, family) queue keeps only its best.
 *
 * **Why that is lossless, which is the only reason it is allowed to exist.**
 * `retainAcrossCells` consumes every (cell, family) queue as a *rank-ordered
 * prefix* in all three of its passes — the family share takes `slice(0, take)`,
 * the leftover pass takes the best of what each queue has left, and the
 * cross-cell backfill walks each cell's sorted spare by index. And no queue can
 * ever contribute more records than the whole retention cap. So keeping each
 * queue's top `retentionCap` and discarding the rest changes nothing about the
 * result: everything discarded was, by construction, below every record that
 * could have been chosen from that queue.
 *
 * The bound is raised — never lowered — to whatever the memory ceiling permits,
 * so a small layer with a small cap does not evict at all and the exemption
 * below is not load-bearing in practice.
 */
class RankedRecallSink implements RowSink<SourceRecord> {
  /** (cell, family) → the comparator prefix retention's rank fills read. */
  private readonly buckets = new Map<string, SinkEntry[]>();
  /** (cell, family, kind) → each kind's best, for the coverage pass. */
  private readonly kindKeep = new Map<string, SinkEntry[]>();
  /** (cell, family, quadrant) → each quadrant's best, for the spatial pass. */
  private readonly subcellKeep = new Map<string, SinkEntry[]>();
  private readonly exempt: SourceRecord[] = [];
  private accepted = 0;
  private drainedEvicted = 0;
  /**
   * Every accepted row's name and position, held light, whatever the pens do
   * with the row itself. The namesake channel is computed over this at drain:
   * a witness does not need to be keepable to be a witness.
   */
  readonly ledger = new GroundNamesakeLedger();

  constructor(
    private readonly bucketBound: number,
    /**
     * The visitable family's own, wider bucket bound.
     *
     * The namesake channel is only computable at drain, over the whole ground —
     * so a visitable record evicted *before* drain on the evidence-blind
     * comparator is a landmark lost to a memory guard acting as a second,
     * invisible retention policy (this file's own named failure class). The
     * measured tie tier makes it concrete: a city's most famous temple ranked
     * 431st of 632 in its kind on (priority, source confidence) and was gone
     * before the pass that could have recognised it ever ran. The visitable
     * family is therefore held to this bound — the whole family on every
     * measured metropolis (7,602 rows in the densest measured cell against a
     * nine-cell bound of 13,333) — while the commodity families keep the
     * tighter bound; their depth is exactly what the pens exist to cut.
     */
    private readonly visitableBound: number,
    /**
     * Records that are never evicted.
     *
     * The destination's own division record, and nothing else. It is not one of
     * many comparable records competing for a seat — it is the only evidence
     * from which "does this belong to the traveller's destination" can be
     * answered at all, and a stored build proved what losing it costs: 3,767 of
     * 3,787 records came back with no membership verdict. Retention already pins
     * it outside its cap; a memory bound that evicted it before retention ever
     * saw it would have reintroduced the same failure one layer earlier.
     */
    private readonly isExempt: (record: SourceRecord) => boolean,
    /** The quadrant key the retention pass will also use. Same geometry, once. */
    private readonly subcellOf: (record: SourceRecord) => string,
  ) {}

  private bucketBoundFor(family: RecallFamily): number {
    return family === 'visitable' ? this.visitableBound : this.bucketBound;
  }

  add(record: SourceRecord): void {
    this.accepted += 1;
    this.ledger.note(record);
    if (this.isExempt(record)) {
      this.exempt.push(record);
      return;
    }
    const entry: SinkEntry = {
      record,
      priority: recallPriorityOf(record),
      confidence: sourceConfidenceOf(record),
    };
    const family = recallFamilyOf(record.planningRole);
    const cellFamily = `${record.cellId} ${family}`;
    this.hold(this.buckets, cellFamily, entry, this.bucketBoundFor(family));
    /*
     * The two group pens hold what the coverage and spatial passes will ask
     * for: a kind's or a quadrant's best records survive even when the whole
     * (cell, family) queue is thousands deep and they rank far down it. This is
     * what lets a city's only public market — priority 0.18 in a queue of
     * 6,754 — reach retention at all.
     */
    this.hold(this.kindKeep, `${cellFamily} ${record.sourceCategory}`, entry, SINK_KIND_KEEP);
    this.hold(this.subcellKeep, `${cellFamily} ${this.subcellOf(record)}`, entry, SINK_SUBCELL_KEEP);
  }

  private hold(pens: Map<string, SinkEntry[]>, key: string, entry: SinkEntry, bound: number): void {
    const pen = pens.get(key);
    if (!pen) {
      pens.set(key, [entry]);
      return;
    }
    pen.push(entry);
    /*
     * Trimmed in batches rather than at every insertion, so the sort is
     * amortised: each trim discards a run of records at once — `SINK_TRIM_SLACK`
     * for the main pens, a small fixed slack for the group pens — so a queue is
     * sorted once per that many arrivals rather than once per arrival.
     */
    const slack = bound >= SINK_TRIM_SLACK ? SINK_TRIM_SLACK : Math.max(8, bound);
    if (pen.length >= bound + slack) trimPen(pen, bound);
  }

  drain(): SourceRecord[] {
    const held = new Map<string, SourceRecord>();
    for (const record of this.exempt) held.set(record.id, record);
    const sweep = (pens: Map<string, SinkEntry[]>, boundFor: (key: string) => number): void => {
      for (const [key, pen] of pens) {
        const bound = boundFor(key);
        if (pen.length > bound) trimPen(pen, bound);
        for (const entry of pen) held.set(entry.record.id, entry.record);
      }
    };
    /* Bucket keys are `${cellId} ${family}`; the family names the bound. */
    sweep(this.buckets, (key) =>
      key.endsWith(' visitable') ? this.visitableBound : this.bucketBound,
    );
    sweep(this.kindKeep, () => SINK_KIND_KEEP);
    sweep(this.subcellKeep, () => SINK_SUBCELL_KEEP);
    this.drainedEvicted = Math.max(0, this.accepted - held.size);
    return [...held.values()];
  }

  get acceptedCount(): number {
    return this.accepted;
  }

  /** Records held by no pen. Meaningful after `drain()`. */
  get evictedCount(): number {
    return this.drainedEvicted;
  }
}

interface SinkEntry {
  record: SourceRecord;
  priority: number;
  confidence: number;
}

/** One ordering for every pen: the retention comparator exactly. */
function trimPen(pen: SinkEntry[], bound: number): void {
  pen.sort(
    (a, b) =>
      b.priority - a.priority ||
      b.confidence - a.confidence ||
      a.record.id.localeCompare(b.record.id),
  );
  pen.length = Math.min(pen.length, bound);
}

async function extractLayer(input: {
  definition: LayerDefinition;
  release: SourceRelease;
  cells: readonly PackCell[];
  counters: ScanCounters;
  budget: ExtractionBudget;
  deadlineMs: number;
  fetchOptions: FetchOptions;
  containment: ContainmentIndex;
  scan: typeof scanFile;
  /** Catalogue identifiers of the division(s) the destination is. See the pin below. */
  destinationDivisionIds: ReadonlySet<string>;
  signal?: AbortSignal;
}): Promise<LayerExtraction> {
  const { definition, cells, counters, budget } = input;
  const startedAt = Date.now();
  const bytesAtStart = counters.bytesTransferred;
  const rowsAtStart = counters.featuresRead;
  const failedCellIds: string[] = [];
  const budgetsExhausted: string[] = [];

  const retentionCap = Math.max(
    20,
    Math.floor(budget.maxFeaturesRetained * (LAYER_SHARE[definition.id] ?? 0.1)),
  );
  /*
   * No per-cell cap is computed here any more. It used to be
   * `ceil(retentionCap / cells.length)`, which made a *seat* share depend on
   * the *partition's* cell count — and with the partition no longer truncated
   * to a budget, a country grid is mostly cells the source has nothing in.
   * `retainAcrossCells` derives the share from the cells that actually hold
   * records, so seats follow data rather than geometry.
   */

  const acquisition: LayerAcquisition = {
    layerId: definition.id,
    rowGroupsOverlapping: 0,
    rowGroupsPlanned: 0,
    projectedBytes: 0,
    shortfallBytes: 0,
    rowsDecoded: 0,
    rowsInBox: 0,
    rowsNormalised: 0,
    rowsEvicted: 0,
    rowsDroppedByPolicy: 0,
    rowsRetained: 0,
    bytesTransferred: 0,
    ms: 0,
  };
  const finish = (extraction: Omit<LayerExtraction, 'acquisition'>): LayerExtraction => {
    acquisition.rowsDecoded = counters.featuresRead - rowsAtStart;
    acquisition.bytesTransferred = counters.bytesTransferred - bytesAtStart;
    acquisition.ms = Date.now() - startedAt;
    acquisition.rowsRetained = extraction.layer.records.length;
    return { ...extraction, acquisition };
  };

  let files;
  try {
    files = await themeFiles({
      release: input.release,
      theme: definition.theme,
      type: definition.type,
      options: input.fetchOptions,
    });
  } catch {
    return finish({
      layer: emptyLayer(definition, cells, 'The catalogue did not list this layer for this release.'),
      filesInspected: 0,
      budgetsExhausted: ['catalog'],
    });
  }

  const box = unionBox(cells);
  const matching = files.filter((file) => fileIntersects(file, box)).slice(0, budget.maxFiles);
  if (matching.length === 0) {
    return finish({
      layer: emptyLayer(definition, cells, 'This layer publishes nothing that covers that area.'),
      filesInspected: 0,
      budgetsExhausted: [],
    });
  }

  const seen = new Set<string>();
  let featuresRead = 0;
  let filesInspected = 0;

  /**
   * WHAT THIS LAYER MAY SPEND, IN THE UNIT THE SPENDING HAPPENS IN.
   *
   * Two numbers used to stand between a dense destination and its own inventory,
   * and both were counts.
   *
   * The read was bounded by row groups — a global forty, shared and rationed by
   * fixed shares — so the places layer of a metropolis got 18 to 22 of the 27
   * its box overlaps, and every landmark in the remaining third was never
   * decoded. The read is now bounded by what it costs: the footer prices the
   * whole pruned set exactly, and if the price fits, all of it is read.
   *
   * The holding was bounded by a retained-row ceiling of 120,000 against 478,000
   * in-box rows, which stopped the scan two-thirds of the way through the area
   * to protect a heap. That is now the sink's problem rather than the reader's —
   * it keeps a bounded ranked selection as the rows arrive, so the area is
   * exhausted at fixed memory and nothing is decided by where a budget ran out.
   *
   * §12.2 in one sentence: the raw search may be broad, and the kept set is
   * deliberately bounded — which are two different bounds, in two different
   * units, and collapsing them is the failure this whole slice is about.
   */
  const byteCeiling = Math.min(
    budget.maxBytes,
    counters.bytesTransferred +
      byteAllowanceFor(definition.id, Math.max(0, budget.maxBytes - counters.bytesTransferred)),
  );
  const scanBudget: ScanBudget = {
    maxRowGroups: budget.maxRowGroups,
    maxBytes: byteCeiling,
    maxFeaturesRead: budget.maxFeaturesRead,
    maxFeaturesRetained: RECALL_MEMORY_CEILING,
    deadlineMs: input.deadlineMs,
  };

  /*
   * The quadrant geometry, computed once and handed to both the sink and the
   * retention pass — two readers of one definition, so they cannot disagree
   * about which quarter of a cell a record is in.
   */
  const cellBounds = new Map<string, PackCell['bounds']>(
    cells.map((cell) => [cell.id, cell.bounds]),
  );
  const subcellOf = (record: SourceRecord): string =>
    subcellKeyFor(record, cellBounds.get(record.cellId));

  const sink = new RankedRecallSink(
    sinkBucketBoundFor(retentionCap, cells.length),
    sinkVisitableBoundFor(retentionCap, cells.length),
    (record) =>
      record.planningRole === 'administrative' &&
      input.destinationDivisionIds.has(record.sourceId),
    subcellOf,
  );

  for (const file of matching) {
    if (input.signal?.aborted) {
      budgetsExhausted.push('cancelled');
      break;
    }
    if (counters.rowGroupsRead >= budget.maxRowGroups) {
      budgetsExhausted.push('row_groups');
      break;
    }
    if (counters.bytesTransferred >= byteCeiling) {
      budgetsExhausted.push('bytes');
      break;
    }
    if (Date.now() > input.deadlineMs) {
      budgetsExhausted.push('time');
      break;
    }

    filesInspected += 1;
    try {
      const result = await input.scan<SourceRecord>({
        url: file.url,
        box,
        columns: definition.columns,
        requiredColumns: definition.requiredColumns,
        budget: scanBudget,
        counters,
        sink,
        ...(input.signal ? { signal: input.signal } : {}),
        accept: (row) => {
          /**
           * The record's own position, not its bounding box's overlap.
           *
           * An administrative record covering a whole first-level division
           * overlaps a metropolitan box by one corner while sitting hundreds of
           * kilometres from it. On overlap it was admitted and then filed under
           * whichever cell its south-west corner landed in — two compounding
           * approximations, neither of which anybody had asked for.
           */
          if (!rowPointInBox(row, box)) return null;
          featuresRead += 1;
          const cell = cellFor(cells, row);
          if (!cell) return null;
          const context: NormalizeContext = {
            layerId: definition.id,
            cellId: cell.id,
            defaultLicenceId: definition.defaultLicenceId,
            containmentFor: (point) => input.containment.lookup(point),
          };
          const record = definition.normalize(row, context);
          if (!record) return null;
          if (seen.has(record.id)) return null;
          /*
           * NOTHING IS REFUSED HERE FOR NOT BELONGING.
           *
           * This used to be the one place a record was dropped on a containment
           * verdict, and the reasoning was that normalisation is the first moment
           * the record's own address exists. True, and beside the point: a pack
           * is traveller-independent ground, cached on the destination and the
           * bounds and shared between everybody going there, while a verdict
           * needs the traveller's scope, their regional expansion and their base
           * strategy — none of which exist yet, and one of which
           * (`includedAreas`) is in the pack's own cache key, so writing it here
           * would give every traveller their own pack.
           *
           * Worse, a record dropped at pack build is a record nothing downstream
           * can recover. The trip-scope overlay decides, per trip, after
           * expansion, from the typed evidence the normaliser attached.
           */
          seen.add(record.id);
          return record;
        },
      });

      /*
       * A LOOP, NOT A SPREAD, AND THE DIFFERENCE IS THE WHOLE LAYER.
       *
       * `collected.push(...result.rows)` passed every row as a separate
       * *argument*, and V8 refuses past ~109,832 of them with a RangeError —
       * measured on this runtime by bisection: 109,831 pushes, 109,832 throws.
       * The retained ceiling was 120,000, so the scan was allowed to return a
       * quantity the very next statement could not accept, and the denser the
       * destination the more certainly it did.
       *
       * The failure was invisible offline because it needs a real metropolis to
       * reach the ceiling: the first live compilation of one read 122,627 place
       * features and retained **zero**, because the RangeError landed in the
       * catch below, which had no branch for it and filed every cell under the
       * generic `provider_error`. A board with no places, reported as a
       * provider being unreachable.
       *
       * The rule survives the sink and matters more with it, because the sink
       * exists precisely so that far *larger* result sets are normal: a
       * half-million-row area now flows through here. `result.rows` is empty
       * whenever the reader honoured the sink, and carries everything when an
       * injected reader predates it — so the loop is both the compatibility
       * path and the one shape that cannot be defeated by volume.
       */
      for (const row of result.rows) sink.add(row);

      const plan = result.plan;
      if (plan) {
        acquisition.rowGroupsOverlapping += plan.rowGroupsOverlapping;
        acquisition.rowGroupsPlanned += plan.rowGroupsPlanned;
        acquisition.projectedBytes += plan.projectedBytes;
        acquisition.shortfallBytes += plan.shortfallBytes;
      }

      if (result.stoppedBecause !== 'complete') {
        budgetsExhausted.push(result.stoppedBecause);
      }
      if ((result.transferFailedGroups ?? 0) > 0) {
        /*
         * Ground the plan paid for and the wire did not deliver. Named so the
         * completion pass can retry it, and never spelled as cell failure —
         * a hole in one block is not nine unread cells.
         */
        budgetsExhausted.push('transfer_holes');
      }
    } catch (error) {
      if (error instanceof ScanError && error.code === 'schema_incompatible') {
        return finish({
          layer: emptyLayer(definition, cells, error.message),
          filesInspected,
          budgetsExhausted: ['schema'],
        });
      }
      /**
       * One file's failure is one file's failure.
       *
       * The cells it covered are recorded as unread and the next file is tried,
       * because a layer that gives up on the first refusal is the single-point
       * failure this whole phase exists to remove.
       */
      for (const cell of cells) {
        if (!failedCellIds.includes(cell.id)) failedCellIds.push(cell.id);
      }
      /*
       * `provider_error` is a claim about somebody else's service, and it was
       * being made about our own arithmetic. The first live compilation of a
       * metropolis reported exactly that while the provider had answered
       * perfectly and handed us 122,627 features we then failed to append.
       *
       * A fault on this side is named as one, so the next person reading a
       * diagnostic is not sent to check a volunteer endpoint that was never
       * the problem.
       */
      const code =
        error instanceof ScanError
          ? error.code
          : error instanceof RangeError
            ? 'internal_limit'
            : 'provider_error';
      budgetsExhausted.push(code);
    }
  }

  /**
   * Per-cell shares first, then the backfill by rank across cells.
   *
   * The first pass is what stops a dense corner eating a region's allowance;
   * the second is what stops a sparse region being held to an even share of
   * nothing — and, unlike the flat `slice` it replaces, it cannot hand the
   * whole backfill back to that same dense corner. Sorted at the end so the
   * layer's record order — and therefore the pack's content hash — does not
   * depend on which file answered first.
   */
  /*
   * And before any of it, the destination itself.
   *
   * A division that *is* the destination is not competing for a seat: it is the
   * only record from which membership can be decided, so it is kept outside the
   * budget rather than ranked against the ground it defines.
   */
  const collected = sink.drain();
  acquisition.rowsInBox = featuresRead;
  acquisition.rowsNormalised = sink.acceptedCount;
  acquisition.rowsEvicted = sink.evictedCount;

  /*
   * The namesake channel, computed now because now is the first moment it is
   * computable: the ledger has seen the whole ground and the pens have kept
   * every visitable candidate (see `sinkVisitableBoundFor`). Retention then
   * ranks on the same shared significance model, with this one pack-wide
   * channel supplied instead of silently absent — and with a complex's
   * seat-claim landed on the record that can still carry it (see
   * `complexSeatLiftsFor`), because the ground's loudest attestations are for
   * feature complexes whose own record no pen could hold.
   */
  const verdict = sink.ledger.attestations(
    collected.filter((record) => recallFamilyOf(record.planningRole) === 'visitable'),
  );
  const attested = complexSeatLiftsFor({
    collected,
    attested: verdict.attested,
    namesakeSites: verdict.namesakeSites,
    witnessesByTarget: verdict.witnessesByTarget,
  });
  const retention = retainAcrossCells({
    records: collected,
    retentionCap,
    priorityOf: (record) => recallPriorityOf(record, attested.has(record.id)),
    /*
     * The graded read: a lift's strength where a lift landed, else the
     * target channel's own guard-passed count — which is real evidence below
     * the attestation gate too. One measured witness is what separates a
     * canon-grade museum from the thirty-seven galleries its cell ties it
     * with, and the gate exists to protect the *score*, not the ordering.
     */
    groundWitnessesOf: (record) =>
      Math.max(attested.get(record.id) ?? 0, verdict.witnessesByTarget.get(record.id) ?? 0),
    subcellFor: subcellOf,
    pinned: destinationDivisionRecordIds(collected, input.destinationDivisionIds),
  });
  const records = retention.kept;
  acquisition.rowsDroppedByPolicy = retention.dropped + sink.evictedCount;
  if (retention.dropped > 0) budgetsExhausted.push('retained');
  records.sort((a, b) => a.id.localeCompare(b.id));

  const failed = records.length === 0 ? cells.map((cell) => cell.id) : failedCellIds;

  return finish({
    layer: {
      id: definition.id,
      kind: definition.kind,
      catalog: input.release.catalog,
      datasetPath: `${definition.theme}/${definition.type}`,
      licenceId: definition.defaultLicenceId,
      records,
      featuresRead,
      featuresRetained: records.length,
      failedCellIds: [...new Set(failed)],
      ...noteFor(records.length, acquisition),
    },
    filesInspected,
    budgetsExhausted,
  });
}

/**
 * What this layer has to say about itself, written onto the artifact.
 *
 * A truncated area is stated in *bytes of ground not read*, and it is stated on
 * the pack rather than only in a log, because a pack outlives the run that built
 * it and is read months later by somebody asking why a destination looked thin.
 * The stored metropolitan pack that started this phase carried no such sentence:
 * it recorded 1,840 retained records and a stop reason, and nothing anywhere in
 * the artifact distinguished "this is what is there" from "this is the third of
 * it we paid for".
 */
function noteFor(retained: number, acquisition: LayerAcquisition): { note?: string } {
  if (retained === 0) {
    return { note: 'Nothing in this layer covered that area, or it could not be read.' };
  }
  if (acquisition.shortfallBytes > 0) {
    const read = acquisition.rowGroupsPlanned;
    const available = acquisition.rowGroupsOverlapping;
    return {
      note:
        `Read ${read} of ${available} blocks covering this area; ` +
        `${megabytes(acquisition.shortfallBytes)} MB of it was beyond this build's data allowance, ` +
        'so part of the area is not represented here.',
    };
  }
  return {};
}

function megabytes(bytes: number): string {
  return (bytes / 1_000_000).toFixed(1);
}

/**
 * One line per layer, for whoever is watching the build happen.
 *
 * The funnel rather than the total, for the reason the whole slice exists: a
 * total cannot distinguish ground that was never read from ground that was read
 * and had little on it, and those call for opposite responses.
 */
function acquisitionLineFor(acquisition: LayerAcquisition): string {
  const parts = [
    `${labelFor(acquisition.layerId)}:`,
    `${acquisition.rowGroupsPlanned}/${acquisition.rowGroupsOverlapping} blocks`,
    `· ${megabytes(acquisition.bytesTransferred)} MB`,
    `· ${acquisition.rowsInBox} in area`,
    `· ${acquisition.rowsRetained} kept`,
  ];
  if (acquisition.shortfallBytes > 0) {
    parts.push(`· ${megabytes(acquisition.shortfallBytes)} MB unread`);
  }
  return parts.join(' ');
}

/**
 * A ceiling on how many normalised rows one *scan* holds before it ranks them.
 *
 * A memory guard, not a policy — and it no longer decides anything about a real
 * destination, which is the change. It used to be handed to the reader as its
 * retained ceiling and, at 120,000 against a metropolis's 478,000 in-box place
 * rows, it stopped the scan at eleven of twenty-seven row groups: a heap guard
 * quietly acting as the recall policy, in a unit that had nothing to do with
 * either memory pressure or coverage.
 *
 * The reader now writes into a sink that evicts by rank instead of growing, so
 * the guard is inert on that path and the number survives as what it always
 * claimed to be: the total this build is willing to hold at once, from which the
 * sink's per-queue bound is derived.
 */
const RECALL_MEMORY_CEILING = 120_000;

/** How far past its bound a queue may grow before it is sorted and cut. */
const SINK_TRIM_SLACK = 1_024;

/**
 * How deep each (cell, family) queue may be held before the worst are dropped.
 *
 * `retentionCap` is the floor because it is the *lossless* bound: no queue can
 * ever contribute more than the whole cap to the kept set, and every pass of
 * `retainAcrossCells` consumes a queue as a rank-ordered prefix, so holding the
 * top `retentionCap` of each is provably the same answer as holding all of them.
 * Losslessness is not traded for memory here — a bound below it would make the
 * sink a second, invisible retention policy, which is exactly the class of
 * hidden decision this slice exists to remove.
 *
 * It is then raised — never lowered — to whatever the memory ceiling allows once
 * spread over the queues in play and the trim slack is paid for, so a small
 * layer with a small cap does not evict at all. Peak holding is
 * `cells × 4 × (bound + slack)` for the main pens — the ceiling for a
 * metropolis's nine cells, the lossless bound plus slack for a very large
 * partition — plus the two group pens, which hold a bounded handful per
 * (kind, quadrant) group and are scaled by the source's controlled category
 * vocabulary rather than by row volume. All of it deliberately allowed past
 * the ceiling, because dropping a keepable record to save memory would be the
 * wrong trade.
 */
export function sinkBucketBoundFor(retentionCap: number, cells: number): number {
  const queues = Math.max(1, cells) * RECALL_FAMILY_COUNT;
  return Math.max(retentionCap, Math.floor(RECALL_MEMORY_CEILING / queues) - SINK_TRIM_SLACK);
}

/**
 * The visitable family's bucket bound: each cell's visitable queue may hold
 * the cell's whole share of the memory ceiling, never less than the shared
 * bound. Derived, not tuned — `RECALL_MEMORY_CEILING / cells` is 13,333 for a
 * nine-cell metropolis against a measured densest-cell visitable family of
 * 7,602 rows, so in practice the family is held completely and the namesake
 * channel (computable only at drain, over the whole ground) can still lift a
 * record the evidence-blind comparator ranked hundreds deep. A pathological
 * ground denser than the ceiling still trims, because the guard is a memory
 * guard and must remain one. See the `RankedRecallSink` constructor for the
 * measured failure this exists to close.
 */
export function sinkVisitableBoundFor(retentionCap: number, cells: number): number {
  return Math.max(
    sinkBucketBoundFor(retentionCap, cells),
    Math.floor(RECALL_MEMORY_CEILING / Math.max(1, cells)),
  );
}

/**
 * WHAT THIS LAYER MAY SPEND OF WHAT IS LEFT.
 *
 * Not a demand estimate — the footer supplies demand exactly, and when demand
 * fits, this number never binds. It is the answer to the only question left:
 * when a destination genuinely costs more than one build may spend, who gives
 * way. Places is the inventory and gives way last among the readers; the
 * geographic layers between them carry an outdoor region's whole inventory.
 *
 * Two properties, and both were broken before.
 *
 * It is computed against **what is still unspent** and renormalised over the
 * layers still to come, so a quiet layer's leftovers flow forward instead of
 * expiring, and the final layer is entitled to everything that remains rather
 * than to a fixed fraction of everything that once was. The old form reserved
 * the infrastructure layer eight per cent of a global figure the layers ahead of
 * it had usually already spent — a share of nothing, which is how a ferry
 * terminal stopped being findable.
 *
 * And it is in bytes. The same arithmetic over row groups was rationing layers
 * whose groups differ in cost by more than a factor of ten, which is not
 * budgeting at all.
 */
export function byteAllowanceFor(layerId: string, remainingBytes: number): number {
  const remaining = Math.max(0, remainingBytes);
  const order = LAYERS.map((layer) => layer.id);
  const index = order.indexOf(layerId);
  if (index < 0) return remaining;
  const shareOf = (id: string): number => LAYER_SHARE[id] ?? 0.1;
  const stillToCome = order.slice(index).reduce((sum, id) => sum + shareOf(id), 0);
  if (!(stillToCome > 0)) return remaining;
  return Math.floor(remaining * (shareOf(layerId) / stillToCome));
}

function emptyLayer(
  definition: LayerDefinition,
  cells: readonly PackCell[],
  note: string,
): PackLayer {
  return {
    id: definition.id,
    kind: definition.kind,
    catalog: 'overture',
    datasetPath: `${definition.theme}/${definition.type}`,
    licenceId: definition.defaultLicenceId,
    records: [],
    featuresRead: 0,
    featuresRetained: 0,
    failedCellIds: cells.map((cell) => cell.id),
    note,
  };
}

function unionBox(cells: readonly PackCell[]): BoundingBox {
  const first = cells[0]!;
  let box: BoundingBox = {
    west: first.bounds.southWest.lng,
    south: first.bounds.southWest.lat,
    east: first.bounds.northEast.lng,
    north: first.bounds.northEast.lat,
  };
  for (const cell of cells.slice(1)) {
    box = {
      west: Math.min(box.west, cell.bounds.southWest.lng),
      south: Math.min(box.south, cell.bounds.southWest.lat),
      east: Math.max(box.east, cell.bounds.northEast.lng),
      north: Math.max(box.north, cell.bounds.northEast.lat),
    };
  }
  return box;
}

/**
 * Which cell a record is counted against, from the record's own position.
 *
 * The south-west corner of a bounding box was used here, and for a point feature
 * that is exact and for anything with real extent it is not: a park spanning two
 * cells was filed under the cell its lowest, westernmost corner fell in, which
 * for a large feature is a different place from where it is. Retention is
 * distributed per cell, so mis-filing skews the distribution that exists to stop
 * one dense corner eating a region's allowance.
 */
function cellFor(cells: readonly PackCell[], row: Record<string, unknown>): PackCell | null {
  const point = pointOf(row);
  if (!point) return null;
  for (const cell of cells) {
    if (
      point.lat >= cell.bounds.southWest.lat &&
      point.lat <= cell.bounds.northEast.lat &&
      point.lng >= cell.bounds.southWest.lng &&
      point.lng <= cell.bounds.northEast.lng
    ) {
      return cell;
    }
  }
  return null;
}

function labelFor(layerId: string): string {
  switch (layerId) {
    case 'divisions':
      return 'working out the neighbourhoods';
    case 'places':
      return 'reading the place catalogue';
    case 'land':
      return 'reading the terrain';
    case 'water':
      return 'reading the lakes and coast';
    case 'land_use':
      return 'reading the parks';
    default:
      return 'reading the local infrastructure';
  }
}

// ---------------------------------------------------------------------------
// Containment
// ---------------------------------------------------------------------------

/**
 * Which administrative area a point falls in, from published boundaries only.
 *
 * Smallest containing area wins, which is why the index is sorted by area: a
 * point inside a neighbourhood is also inside its city and its country, and the
 * useful answer is the innermost one.
 *
 * Coverage is not uniform worldwide and the API says so by returning an empty
 * containment rather than a guess. A missing neighbourhood degrades a label; it
 * never invalidates a place whose coordinates are known.
 */
class ContainmentIndex {
  private entries: { bounds: GeoBounds; area: number; containment: RecordContainment }[] = [];

  load(records: readonly SourceRecord[]): void {
    this.entries = records
      .filter((record): record is SourceRecord & { bounds: GeoBounds } => record.bounds !== undefined)
      .map((record) => ({
        bounds: record.bounds,
        area:
          Math.abs(record.bounds.northEast.lat - record.bounds.southWest.lat) *
          Math.abs(record.bounds.northEast.lng - record.bounds.southWest.lng),
        containment: {
          ...record.containment,
          ...(record.attributes.subtype === 'locality' ? { localityName: record.name } : {}),
          ...(record.attributes.subtype === 'neighborhood' ||
          record.attributes.subtype === 'neighbourhood'
            ? { neighbourhoodName: record.name }
            : {}),
        },
      }))
      .sort((a, b) => a.area - b.area);
  }

  lookup(point: { lat: number; lng: number }): RecordContainment {
    const found: RecordContainment = { divisionIds: [] };
    for (const entry of this.entries) {
      if (
        point.lat < entry.bounds.southWest.lat ||
        point.lat > entry.bounds.northEast.lat ||
        point.lng < entry.bounds.southWest.lng ||
        point.lng > entry.bounds.northEast.lng
      ) {
        continue;
      }
      // Innermost first, and each field is filled only once, so a larger area
      // never overwrites a smaller one's answer.
      if (!found.neighbourhoodName && entry.containment.neighbourhoodName) {
        found.neighbourhoodName = entry.containment.neighbourhoodName;
      }
      if (!found.localityName && entry.containment.localityName) {
        found.localityName = entry.containment.localityName;
      }
      if (!found.regionName && entry.containment.regionName) {
        found.regionName = entry.containment.regionName;
      }
      if (!found.countryCode && entry.containment.countryCode) {
        found.countryCode = entry.containment.countryCode;
      }
      /**
       * The **whole** parent chain, and the truncation that used to be here was
       * a real defect.
       *
       * It kept the two innermost identifiers, on a size argument — six ids of
       * about forty characters on every record is nearly a megabyte for a dense
       * city — and a claim that "two is enough to group satellites by their
       * parent area, which is what anything downstream actually reads them for".
       * That consumer no longer exists. This field is now the input to the
       * strongest membership test there is: a candidate's chain against the
       * identity of the division the destination *is*. A record inside a
       * neighbourhood inside a borough inside the selected city carried
       * `[borough, neighbourhood]`, the city's id was gone, and the rung
       * silently returned false. For a region- or country-breadth destination it
       * could essentially never fire.
       */
      if (found.divisionIds.length === 0 && entry.containment.divisionIds.length > 0) {
        found.divisionIds = [...entry.containment.divisionIds];
      }
      if (found.neighbourhoodName && found.localityName && found.countryCode) break;
    }
    return found;
  }
}

/** The ground a scope covers, as the scanner's box. Exported for diagnostics. */
export function scanBoxFor(scope: GeographicScope): BoundingBox {
  const bounds = scopeBounds(scope);
  return {
    west: bounds.southWest.lng,
    south: bounds.southWest.lat,
    east: bounds.northEast.lng,
    north: bounds.northEast.lat,
  };
}

export { failedPack };
