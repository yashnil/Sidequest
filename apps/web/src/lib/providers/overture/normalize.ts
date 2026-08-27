import 'server-only';
import { classifySourceCategory, type TaxonomyClassification } from '@sidequest/compiler';
import { typedEvidenceFrom } from '@sidequest/core';
import type {
  LicenceId,
  PlanningRole,
  RecordContainment,
  SourceLayerKind,
  SourceRecord,
  SourceRecordProvenance,
} from '@sidequest/core';
import { boundsOf, pointOf } from './scan';

/**
 * FROM A CATALOGUE ROW TO A NORMALISED RECORD.
 *
 * The Phase-7 rule holds unchanged and is worth restating, because this file is
 * where it would be easiest to break: **what is kept is the minimum a plan
 * needs**, not a copy of the source's columns. A table mirroring somebody's
 * schema is a redistribution wearing our column names, it bloats every artifact
 * with keys nothing reads, and it retains data we have no purpose for.
 *
 * So contact details do not survive normalisation. Phone numbers, e-mail
 * addresses, social handles and brand records are all in the upstream catalogue
 * and none of them changes a plan.
 *
 * What does survive: identity, position, name and alternates, the source's own
 * category, operating status, website candidates, an open identifier, the
 * planning attributes, containment, and one provenance row per contributor with
 * that contributor's licence attached.
 */

// ---------------------------------------------------------------------------
// Layer definitions
// ---------------------------------------------------------------------------

export interface LayerDefinition {
  id: string;
  kind: SourceLayerKind;
  theme: string;
  type: string;
  /** The licence the catalogue declares for this theme, as a fallback. */
  defaultLicenceId: LicenceId;
  columns: readonly string[];
  requiredColumns: readonly string[];
  normalize: (row: Record<string, unknown>, context: NormalizeContext) => SourceRecord | null;
}

export interface NormalizeContext {
  layerId: string;
  cellId: string;
  defaultLicenceId: LicenceId;
  /** Resolved from the divisions layer where it ran. Never invented. */
  containmentFor: (point: { lat: number; lng: number }) => RecordContainment;
}

/**
 * THE PLACE PROJECTION, AND THE THREE COLUMNS THAT ARE NOT READ FROM IT.
 *
 * ## `wikidata` — because there is none
 *
 * This theme publishes **no place-level `wikidata` leaf and no `source_tags`
 * map**. Verified against the real catalogue (release 2026-07-22.0, anonymous
 * range reads of the footer schema): the places file's 52 column paths contain
 * `brand.wikidata` and nothing else matching. So `normalizePlace` below cannot
 * set `wikidataId`, cannot set `attributes.wikipedia`, and no widening of this
 * list would let it — the columns are absent from the source, not from us.
 *
 * That is worth stating here because everything downstream reads the absence as
 * a measurement. Counted over every in-box row of three real metro boxes:
 *
 * | box    | place rows | with a knowledge-base id | with an encyclopaedia article |
 * |--------|-----------:|-------------------------:|------------------------------:|
 * | Tokyo  |    272,018 |                        0 |                             0 |
 * | Osaka  |     92,042 |                        0 |                             0 |
 * | Lisbon |     43,228 |                        0 |                             0 |
 *
 * The supplemental geography layers below **do** publish it — see
 * `FEATURE_COLUMNS` — and the compiler carries a twin's evidence across where a
 * name, a kind and a position all agree. See `resolveKnowledgeBaseEvidence`.
 *
 * ## `brand` — because it is evidence about a company, not about a place
 *
 * `brand.wikidata` is the one knowledge-base identifier this theme does publish,
 * and it is deliberately not read. A Starbucks is not significant because
 * Starbucks has an encyclopaedia entry; the entry is about the chain, and the
 * thing in front of the traveller is one of thirty thousand outlets.
 *
 * The measurement is what settles it rather than the argument. `brand.wikidata`
 * is present on **4.74%** of Tokyo's in-box rows (13,201), 5.57% of Osaka's and
 * 0.71% of Lisbon's, while genuine place-level knowledge-base evidence reaches
 * single digits per pack. Admitting it — even as a separate, weaker channel —
 * would make a corporate identifier outnumber every real signal by three orders
 * of magnitude and *become* the knowledge-base channel, which is precisely §8.3's
 * "do not let one source become global truth" and §4's café-outranking-a-temple.
 *
 * If a future slice wants brand identity for another purpose — deduplicating
 * chains, say — it must arrive under its own name and must not reach
 * `assessPlaceStanding`.
 *
 * ## `categories.alternate` — because it is a search facet, not a designation
 *
 * `categories` is projected for its `primary` leaf, and the `alternate` list
 * beside it is deliberately never read. It is the most tempting column in the
 * file: it is present on **63.8%** of Tokyo's in-box rows and **74.7%** of
 * Lisbon's, and routing it into the classifying values would raise the
 * conferred-designation channel roughly sevenfold on one and fourteenfold on the
 * other (Tokyo 24 designated rows → 187, Lisbon 3 → 42).
 *
 * Each of the 163 new rows was traced back to the value that fired it and the
 * category the source itself gives it, and the channel would be firing on the
 * wrong thing. The list is what a *search* would match this row under, not what
 * an authority conferred on it, and the two diverge exactly where a name happens
 * to contain a word:
 *
 * | value fired        | Tokyo | what is actually in it                                     |
 * |--------------------|------:|------------------------------------------------------------|
 * | `wildlife_sanctuary` |  69 | 42 companies, clubs and shops — a condominium management association, a chamber of commerce, a camera society, a nightclub |
 * | `national_park`      |  67 | 56 municipal parks including a children's playground; a newspaper's head office; travel agencies selling trips to national parks |
 * | `nature_reserve`     |  28 | 23 municipal parks, a bridge, a riverbank |
 *
 * Lisbon says the same thing in another language: `national_park` fires on a
 * dental clinic, a hospital, a restaurant and the parish office of *Parque das
 * Nações*; `wildlife_sanctuary` fires on two kindergartens (*Jardim de
 * Infância*), a convent, a food company and the National Pensions Centre.
 *
 * A designation is a decision somebody published — a boundary drawn, a listing
 * entered — which is the whole reason `hasDesignatedStatus` treats it as local
 * significance. Feeding this column into it would put a preschool and a
 * playground into the same evidence channel a national park uses, and a channel
 * that fires on the wrong thing is worse than one that does not fire. Narrowing
 * it does not rescue it either: restricting to rows whose primary category is
 * already an area keeps the systematic error — 56 neighbourhood parks reading as
 * national parks — and only removes the absurd ones.
 *
 * `taxonomy.alternates`, the modern column beside it, is published empty: 0 of
 * 342,536 Tokyo in-box rows and 0 of 44,386 Lisbon ones.
 */
const PLACE_COLUMNS = [
  'id',
  'names',
  'confidence',
  'operating_status',
  'basic_category',
  'taxonomy',
  'categories',
  'websites',
  'addresses',
  'sources',
  'bbox',
] as const;

const FEATURE_COLUMNS = [
  'id',
  'names',
  'subtype',
  'class',
  'sources',
  'source_tags',
  'wikidata',
  'elevation',
  'surface',
  'bbox',
] as const;

const DIVISION_COLUMNS = [
  'id',
  'names',
  'subtype',
  'class',
  'country',
  'region',
  'hierarchies',
  'local_type',
  'sources',
  'bbox',
] as const;

/**
 * The layers, in the order they are extracted.
 *
 * Divisions first, because everything after it wants containment and a record
 * whose locality is known reads better on a card and links better across
 * sources. Places second, because it is the primary inventory. The geographic
 * layers last, because they are the supplement and because a budget that runs
 * out should cost the supplement rather than the inventory.
 *
 * Splitting the geography into four small layers rather than one large one is
 * the same decision that split an Overpass union into six requests, and it is
 * here for the same observed reason: a layer that fails should take only itself
 * down. A national park whose water layer answers and whose land layer does not
 * is a thin region, and a thin region is not an empty one.
 */
export const LAYERS: readonly LayerDefinition[] = [
  {
    id: 'divisions',
    kind: 'administrative_divisions',
    theme: 'divisions',
    type: 'division',
    defaultLicenceId: 'ODbL-1.0',
    columns: DIVISION_COLUMNS,
    requiredColumns: ['id', 'names', 'bbox'],
    normalize: withScopeVerdict(normalizeDivision),
  },
  {
    id: 'places',
    kind: 'primary_places',
    theme: 'places',
    type: 'place',
    defaultLicenceId: 'CDLA-Permissive-2.0',
    columns: PLACE_COLUMNS,
    requiredColumns: ['id', 'names', 'bbox', 'sources'],
    normalize: withScopeVerdict(normalizePlace),
  },
  {
    id: 'land',
    kind: 'supplemental_geography',
    theme: 'base',
    type: 'land',
    defaultLicenceId: 'ODbL-1.0',
    columns: FEATURE_COLUMNS,
    requiredColumns: ['id', 'names', 'bbox'],
    normalize: withScopeVerdict(normalizeFeature),
  },
  {
    id: 'water',
    kind: 'supplemental_geography',
    theme: 'base',
    type: 'water',
    defaultLicenceId: 'ODbL-1.0',
    columns: FEATURE_COLUMNS,
    requiredColumns: ['id', 'names', 'bbox'],
    normalize: withScopeVerdict(normalizeFeature),
  },
  {
    id: 'land_use',
    kind: 'supplemental_geography',
    theme: 'base',
    type: 'land_use',
    defaultLicenceId: 'ODbL-1.0',
    columns: FEATURE_COLUMNS,
    requiredColumns: ['id', 'names', 'bbox'],
    normalize: withScopeVerdict(normalizeFeature),
  },
  {
    id: 'infrastructure',
    kind: 'supplemental_geography',
    theme: 'base',
    type: 'infrastructure',
    defaultLicenceId: 'ODbL-1.0',
    columns: FEATURE_COLUMNS,
    requiredColumns: ['id', 'names', 'bbox'],
    normalize: withScopeVerdict(normalizeFeature),
  },
];

export function layerById(id: string): LayerDefinition | undefined {
  return LAYERS.find((layer) => layer.id === id);
}

/**
 * Every normalised record leaves here carrying **typed geographic evidence**,
 * and none of them leaves carrying a verdict.
 *
 * That is the pack/overlay split at the adapter boundary. This file used to
 * attach a containment relationship here, on the finished record, and the
 * reasoning was sound as far as it went: this is the first moment the record's
 * own administrative containment exists. What it missed is that a verdict also
 * needs the *other* side of the comparison — the traveller's chosen scope, the
 * regional expansion, the base strategy — and none of those exist at pack build.
 * A pack is keyed on ground and shared between travellers, so a verdict baked
 * into one was a verdict computed for whoever happened to build it first.
 *
 * What is attached instead is traveller-independent and genuinely cacheable:
 * country, region, county, locality, neighbourhood and division identifiers,
 * each kept at its own level, with ISO 3166-2 codes routed to a code field
 * rather than left in a name set. The trip-scope overlay decides from it.
 *
 * Wrapped once around each layer's normaliser rather than repeated inside three
 * of them, because the property that matters is that there is **no** path out of
 * this file that produces a record without evidence. A per-normaliser call is a
 * thing somebody adds a fourth layer and forgets.
 */
function withScopeVerdict(
  normalize: (row: Record<string, unknown>, context: NormalizeContext) => SourceRecord | null,
): (row: Record<string, unknown>, context: NormalizeContext) => SourceRecord | null {
  return (row, context) => {
    const record = normalize(row, context);
    if (!record) return null;
    return {
      ...record,
      geography: typedEvidenceFrom({
        ...(record.containment.countryCode ? { countryCode: record.containment.countryCode } : {}),
        ...(record.containment.regionName ? { regionName: record.containment.regionName } : {}),
        ...(record.containment.localityName ? { localityName: record.containment.localityName } : {}),
        ...(record.containment.neighbourhoodName
          ? { neighbourhoodName: record.containment.neighbourhoodName }
          : {}),
        divisionIds: record.containment.divisionIds,
        /*
         * `aliases` is deliberately **not** filled from `record.alternateNames`.
         *
         * The field means "other spellings of the entity this evidence
         * describes", and it is compared at that entity's own level — which for
         * a city-breadth destination is `locality`. Feeding a *place's* other
         * names into a *locality's* slot made any venue named after its city
         * satisfy the locality comparison on no geographic evidence at all, and
         * venues named after their city are common enough to matter.
         */
      }),
    };
  };
}

// ---------------------------------------------------------------------------
// Shared field readers
// ---------------------------------------------------------------------------

interface NamesValue {
  primary?: unknown;
  common?: unknown;
  rules?: unknown;
}

/**
 * The record's name, and the other names it publishes.
 *
 * Alternates carry the multilingual cases, and those are not decoration: a place
 * recorded under its local script in one layer and its English name in another
 * is one place, and comparing only primaries would treat it as two.
 *
 * Values are length-capped and control characters are stripped. A name is
 * rendered into a page and is written by strangers; the schema's `httpUrlSchema`
 * lesson applies to text too.
 */
function readNames(
  value: unknown,
): { primary: string; alternates: string[]; english?: string } | null {
  if (!value || typeof value !== 'object') return null;
  const names = value as NamesValue;
  const primary = cleanText(names.primary);
  if (!primary) return null;

  const alternates = new Set<string>();
  let english: string | null = null;
  const common = names.common;
  if (common && typeof common === 'object') {
    for (const [language, entry] of Object.entries(common as Record<string, unknown>)) {
      const text = cleanText(entry);
      if (!text || text === primary) continue;
      /*
       * The `en` key is the one translation the interface language needs, and
       * `Object.values` used to throw it away with its tag — a four-alternate
       * cap then sliced off the only Latin alias of a CJK-named landmark, and
       * the board rendered the record in a script its traveller cannot read.
       */
      if (language === 'en' && english === null) english = text;
      alternates.add(text);
    }
  }
  if (Array.isArray(names.rules)) {
    for (const rule of names.rules.slice(0, 12)) {
      if (!rule || typeof rule !== 'object') continue;
      const text = cleanText((rule as { value?: unknown }).value);
      if (text && text !== primary) alternates.add(text);
    }
  }
  /**
   * Four alternates, not every translation the source publishes.
   *
   * Alternates exist so a record named in one script in one layer links to the
   * same record named in another script in a different layer. Four covers that;
   * forty is a translation table stored on every row of a dense city's pack.
   * Within the cap, the English name first and Latin-script names before the
   * rest — the cap must never be what erases the one alias a display layer can
   * use.
   */
  const hasLatin = (text: string): boolean => /[A-Za-z]/.test(text);
  const ordered = [
    ...(english ? [english] : []),
    ...[...alternates].filter((text) => text !== english && hasLatin(text)),
    ...[...alternates].filter((text) => text !== english && !hasLatin(text)),
  ];
  return { primary, alternates: ordered.slice(0, 4), ...(english ? { english } : {}) };
}

export function cleanText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value
    // Control characters and the bidirectional overrides, which are how a name
    // renders as something other than what it is.
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f-‎‏‪-‮⁦-⁩]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length === 0) return null;
  return cleaned.slice(0, 180);
}

/**
 * Provenance rows, one per contributor, each with its own licence.
 *
 * The licence string is read from the record rather than assumed from the theme,
 * because one theme genuinely carries several: a place layer holds permissive,
 * Apache and public-domain records side by side depending on which upstream
 * provider supplied each one, and attributing all of them to the first is
 * under-attributing two.
 */
function readSources(value: unknown, fallback: LicenceId): SourceRecordProvenance[] {
  const rows: SourceRecordProvenance[] = [];
  if (Array.isArray(value)) {
    for (const entry of value.slice(0, 12)) {
      if (!entry || typeof entry !== 'object') continue;
      const source = entry as {
        dataset?: unknown;
        license?: unknown;
        record_id?: unknown;
        update_time?: unknown;
        confidence?: unknown;
      };
      const dataset = cleanText(source.dataset);
      if (!dataset) continue;
      const recordId = cleanText(source.record_id);
      const updateTime = cleanText(source.update_time);
      const confidence =
        typeof source.confidence === 'number' && Number.isFinite(source.confidence)
          ? Math.max(0, Math.min(1, source.confidence))
          : undefined;
      rows.push({
        dataset,
        licenceId: mapLicence(source.license, fallback),
        ...(recordId ? { recordId } : {}),
        ...(updateTime ? { updateTime } : {}),
        ...(confidence !== undefined ? { existenceConfidence: confidence } : {}),
      });
    }
  }
  if (rows.length === 0) rows.push({ dataset: 'unattributed', licenceId: fallback });
  return rows;
}

/**
 * A licence string from the catalogue, mapped onto one we model.
 *
 * An unrecognised licence falls back to the theme's declared one rather than
 * being dropped, because a record whose licence we could not read is not a
 * record with no licence — and treating it as unencumbered is the mistake with
 * legal consequences.
 */
export function mapLicence(value: unknown, fallback: LicenceId): LicenceId {
  const text = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (text.startsWith('CDLA-PERMISSIVE-2')) return 'CDLA-Permissive-2.0';
  if (text.startsWith('APACHE')) return 'Apache-2.0';
  if (text.startsWith('CC0')) return 'CC0-1.0';
  if (text.startsWith('ODBL')) return 'ODbL-1.0';
  if (text.startsWith('CC-BY-4') || text.startsWith('CC BY 4')) return 'CC-BY-4.0';
  return fallback;
}

/**
 * URLs the source associates with a record, validated before they are kept.
 *
 * A website value is attacker-controlled text in a public database. What survives
 * is `http(s)`, without embedded credentials, under a length cap — and even then
 * it is a *candidate*, handed to the same source-discovery and authority
 * classification path a search result goes through.
 */
export function readWebsites(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  const urls: string[] = [];
  for (const entry of raw.slice(0, 6)) {
    if (typeof entry !== 'string') continue;
    if (entry.length > 500) continue;
    try {
      const url = new URL(entry.trim());
      if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
      if (url.username || url.password) continue;
      if (!url.hostname.includes('.')) continue;
      urls.push(url.toString());
    } catch {
      continue;
    }
    if (urls.length >= 3) break;
  }
  return urls;
}

/**
 * Attributes worth keeping, by name.
 *
 * An allowlist rather than "everything the source recorded", for the reason at
 * the top of this file. Each entry earns its place by changing a plan or by
 * making research cheaper: `website` and `operator` say whose page to look for,
 * `opening_hours` is a published schedule, `fee` and `access` change whether you
 * can get in, `ele` and `seasonal` change when.
 *
 * The designation-bearing keys — `boundary`, `heritage`, `protect_class`,
 * `protection_title`, `site_type`, `landuse` — earn theirs differently: they
 * are the columns a *conferred status* arrives in. The significance model's
 * designation channel reads classifying values (`hasConferredDesignation`),
 * and the inventory's classifying-value list already names every one of these
 * keys — but a key this allowlist dropped could never reach it, so a reserve
 * whose boundary somebody surveyed normalised identically to an unremarkable
 * lawn. Measured on a real four-cell metropolitan read of the geography
 * themes: 170 rows carry at least one of them, and none survived. These are
 * status columns, not name lists — nothing here is destination-specific.
 */
const KEPT_TAGS = new Set([
  'opening_hours',
  'fee',
  'access',
  'wheelchair',
  'operator',
  'website',
  'contact:website',
  'wikidata',
  'wikipedia',
  'cuisine',
  'diet:vegetarian',
  'diet:vegan',
  'diet:gluten_free',
  'diet:halal',
  'takeaway',
  'ele',
  'seasonal',
  'tourism',
  'leisure',
  'historic',
  'natural',
  'amenity',
  'boundary',
  'heritage',
  'protect_class',
  'protection_title',
  'site_type',
  'landuse',
]);

function readTags(value: unknown): Record<string, string> {
  const attributes: Record<string, string> = {};
  if (!value || typeof value !== 'object') return attributes;
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!KEPT_TAGS.has(key)) continue;
    const text = cleanText(raw);
    if (text) attributes[key] = text.slice(0, 120);
  }
  return attributes;
}

// ---------------------------------------------------------------------------
// Layer normalisers
// ---------------------------------------------------------------------------

function normalizePlace(
  row: Record<string, unknown>,
  context: NormalizeContext,
): SourceRecord | null {
  const id = cleanText(row.id);
  const names = readNames(row.names);
  const point = pointOf(row);
  if (!id || !names || !point) return null;

  const taxonomy = row.taxonomy as { primary?: unknown; hierarchy?: unknown } | undefined;
  const categories = row.categories as { primary?: unknown } | undefined;
  const category =
    cleanText(taxonomy?.primary) ??
    cleanText(row.basic_category) ??
    cleanText(categories?.primary);
  if (!category) return null;

  const hierarchy = Array.isArray(taxonomy?.hierarchy)
    ? (taxonomy.hierarchy as unknown[])
        .map((entry) => cleanText(entry))
        .filter((entry): entry is string => entry !== null)
        .slice(0, 6)
    : [];

  /**
   * A permanently closed record keeps its status and does not keep its role.
   *
   * The status travels so the compiler can say "this is shut" rather than
   * silently omitting it, and the planner's own rule — a closed place is never
   * scheduled — has something to read.
   */
  const statusText = cleanText(row.operating_status)?.toLowerCase();
  const operatingStatus =
    statusText === 'open' ? ('open' as const) : statusText?.includes('closed') ? ('closed' as const) : undefined;

  const classification = classifySourceCategory({ category, path: hierarchy });
  const websites = readWebsites(row.websites);

  const address = Array.isArray(row.addresses) ? (row.addresses[0] as Record<string, unknown>) : undefined;
  const containment = mergeContainment(context.containmentFor(point), {
    countryCode: cleanText(address?.country)?.toUpperCase().slice(0, 2),
    regionName: cleanText(address?.region) ?? undefined,
    localityName: cleanText(address?.locality) ?? undefined,
  });

  const attributes: Record<string, string> = {};
  if (websites.length > 0) attributes.website = websites[0]!;
  /*
   * The source's own `en` translation, kept with its tag. The alternates list
   * loses tags by design; the display layer's brand-spelling tier needs to know
   * WHICH alias the source asserts is English, not merely that a Latin string
   * exists. Stored as an attribute so no schema moves.
   */
  if (names.english) attributes['name:en'] = names.english;

  return {
    id: `${context.layerId}:${id}`,
    layerId: context.layerId,
    sourceId: id,
    name: names.primary,
    alternateNames: names.alternates,
    coordinates: point,
    ...(boundsOf(row) ? { bounds: boundsOf(row)! } : {}),
    sourceCategory: category,
    sourceCategoryPath: hierarchy,
    planningRole: roleFor(classification, operatingStatus),
    ...(operatingStatus ? { operatingStatus } : {}),
    websiteCandidates: websites,
    containment,
    attributes,
    sources: readSources(row.sources, context.defaultLicenceId),
    cellId: context.cellId,
  };
}

function normalizeFeature(
  row: Record<string, unknown>,
  context: NormalizeContext,
): SourceRecord | null {
  const id = cleanText(row.id);
  const names = readNames(row.names);
  const point = pointOf(row);
  if (!id || !names || !point) return null;

  const featureClass = cleanText(row.class);
  const subtype = cleanText(row.subtype);
  const category = featureClass ?? subtype;
  if (!category) return null;

  const attributes = readTags(row.source_tags);
  const elevation = row.elevation;
  if (typeof elevation === 'number' && Number.isFinite(elevation)) {
    attributes.ele = String(Math.round(elevation));
  }

  const websites = readWebsites([
    ...(attributes.website ? [attributes.website] : []),
    ...(attributes['contact:website'] ? [attributes['contact:website']] : []),
  ]);

  const wikidata = cleanText(row.wikidata) ?? attributes.wikidata;
  const classification = classifySourceCategory({
    category,
    path: subtype && subtype !== category ? [subtype] : [],
  });

  return {
    id: `${context.layerId}:${id}`,
    layerId: context.layerId,
    sourceId: id,
    name: names.primary,
    alternateNames: names.alternates,
    coordinates: point,
    ...(boundsOf(row) ? { bounds: boundsOf(row)! } : {}),
    sourceCategory: category,
    sourceCategoryPath: subtype && subtype !== category ? [subtype] : [],
    planningRole: roleFor(classification, undefined),
    websiteCandidates: websites,
    ...(wikidata && /^Q\d{1,12}$/.test(wikidata) ? { wikidataId: wikidata } : {}),
    containment: context.containmentFor(point),
    attributes,
    sources: readSources(row.sources, context.defaultLicenceId),
    ...(sourceElementUrl(row) ? { sourceUrl: sourceElementUrl(row)! } : {}),
    cellId: context.cellId,
  };
}

function normalizeDivision(
  row: Record<string, unknown>,
  context: NormalizeContext,
): SourceRecord | null {
  const id = cleanText(row.id);
  const names = readNames(row.names);
  const point = pointOf(row);
  if (!id || !names || !point) return null;

  const subtype = cleanText(row.subtype) ?? 'division';
  const country = cleanText(row.country)?.toUpperCase().slice(0, 2);
  const region = cleanText(row.region);

  /**
   * The published parent chain, taken verbatim from the source.
   *
   * Never reconstructed from proximity: which country a point is in near a
   * border is a question with a political answer, and inferring one from
   * distance is exactly the kind of assertion this product does not make. Where
   * the source publishes a perspective we keep its answer; where it publishes
   * nothing we hold nothing.
   */
  const chain = firstHierarchy(row.hierarchies);

  return {
    id: `${context.layerId}:${id}`,
    layerId: context.layerId,
    sourceId: id,
    name: names.primary,
    alternateNames: names.alternates,
    coordinates: point,
    ...(boundsOf(row) ? { bounds: boundsOf(row)! } : {}),
    sourceCategory: subtype,
    sourceCategoryPath: [],
    planningRole: 'administrative',
    websiteCandidates: [],
    containment: {
      ...(country ? { countryCode: country } : {}),
      ...(region ? { regionName: region } : {}),
      ...(chain.locality ? { localityName: chain.locality } : {}),
      ...(chain.neighbourhood ? { neighbourhoodName: chain.neighbourhood } : {}),
      divisionIds: chain.ids,
    },
    attributes: { subtype },
    sources: readSources(row.sources, context.defaultLicenceId),
    cellId: context.cellId,
  };
}

function firstHierarchy(value: unknown): {
  locality?: string;
  neighbourhood?: string;
  ids: string[];
} {
  if (!Array.isArray(value) || value.length === 0) return { ids: [] };
  const chain = value[0];
  if (!Array.isArray(chain)) return { ids: [] };
  const ids: string[] = [];
  let locality: string | undefined;
  let neighbourhood: string | undefined;
  for (const entry of chain.slice(0, 8)) {
    if (!entry || typeof entry !== 'object') continue;
    const node = entry as { division_id?: unknown; subtype?: unknown; name?: unknown };
    const divisionId = cleanText(node.division_id);
    if (divisionId) ids.push(divisionId);
    const name = cleanText(node.name);
    const subtype = cleanText(node.subtype);
    if (!name) continue;
    if (subtype === 'locality') locality = name;
    if (subtype === 'neighborhood' || subtype === 'neighbourhood') neighbourhood = name;
  }
  return {
    ...(locality ? { locality } : {}),
    ...(neighbourhood ? { neighbourhood } : {}),
    ids,
  };
}

/**
 * A link back to the upstream element, where the record names one.
 *
 * Built from the record id rather than from anything the source hands us as a
 * URL, so this cannot become a redirect somebody else controls. ODbL attribution
 * is only meaningful if a reader can reach the original and correct it.
 */
function sourceElementUrl(row: Record<string, unknown>): string | undefined {
  const sources = Array.isArray(row.sources) ? row.sources : [];
  for (const entry of sources) {
    if (!entry || typeof entry !== 'object') continue;
    const source = entry as { dataset?: unknown; record_id?: unknown };
    if (cleanText(source.dataset) !== 'OpenStreetMap') continue;
    const recordId = cleanText(source.record_id);
    const match = /^([nwr])(\d{1,19})@\d+$/.exec(recordId ?? '');
    if (!match) continue;
    const kind = match[1] === 'n' ? 'node' : match[1] === 'w' ? 'way' : 'relation';
    return `https://www.openstreetmap.org/${kind}/${match[2]}`;
  }
  return undefined;
}

function roleFor(
  classification: TaxonomyClassification,
  operatingStatus: 'open' | 'closed' | undefined,
): PlanningRole {
  if (operatingStatus === 'closed') return 'excluded';
  return classification.role;
}

/**
 * The record's own address wins; the containing division fills the gaps.
 *
 * The order was the other way round, and it is the wrong way round. An address
 * is a statement a source made **about this record**; a containing division's
 * bounding box is an over-approximation of a boundary, and two adjacent
 * first-level divisions have heavily overlapping boxes almost everywhere. With
 * the box winning, a record near a border was assigned its neighbour's region
 * and later deleted as belonging elsewhere — on the strength of a rectangle.
 *
 * Latent today, because the divisions layer publishes points rather than
 * extents and the box pass therefore returns almost nothing. It becomes live the
 * day a catalogue publishes real extents, which is a change the design plans
 * for. Fixing it while it is latent costs nothing.
 */
function mergeContainment(
  base: RecordContainment,
  extra: {
    countryCode?: string | undefined;
    regionName?: string | undefined;
    localityName?: string | undefined;
  },
): RecordContainment {
  return {
    ...base,
    ...(extra.countryCode ? { countryCode: extra.countryCode } : {}),
    ...(extra.regionName ? { regionName: extra.regionName } : {}),
    ...(extra.localityName ? { localityName: extra.localityName } : {}),
  };
}
