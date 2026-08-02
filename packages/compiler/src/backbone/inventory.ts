import {
  licence,
  parseOsmOpeningHours,
  PLACE_CATEGORY_LABELS,
  type CandidateLink,
  type ConfidenceSignal,
  type DataLicence,
  type FoodVenue,
  type GeographicScope,
  type LicenceId,
  type Place,
  type PlanningRole,
  type ProviderRef,
  type RegionPack,
  type SourceRecord,
} from '@sidequest/core';
import type { DiscoveredCandidate } from '../providers';
import { supersededRecordIds } from './link';
import { classifySourceCategory } from './taxonomy';

/**
 * FROM A REGION PACK TO THINGS THE COMPILER CAN PLAN AROUND.
 *
 * This is where a normalised source record becomes a `Place`, and it is
 * deliberately the only place that conversion happens. Two consequences follow,
 * and both are the point:
 *
 * **No model call.** Category, interests, duration, intensity, exposure and cost
 * band all come from the source's own taxonomy through a lookup table. The
 * previous version asked a language model to classify every candidate in a
 * batched request that was the largest fixed cost in a compilation and that
 * timed out on the dense city it mattered most for. A controlled global
 * vocabulary does not need a model to be read.
 *
 * **No invented evidence.** Everything a `Place` requires and a source did not
 * supply resolves to the conservative value — `unknown` hours, `none` closure
 * risk, `moderate` parking — and the honest ones are visible to the quality
 * assessor as an absence rather than as a default it cannot tell from a fact.
 *
 * The corroboration rule from the research note is enforced here: several
 * upstream contributors *inside one conflated record* are not several sources.
 * `multiple_providers_agree` is emitted only when two records **from different
 * layers** were linked, because that is two catalogues finding the same thing.
 */

export interface InventoryLimits {
  /** Hard ceiling on attractions handed to the compiler. */
  maxAttractions: number;
  /** Hard ceiling on support stops — the grocery, the terminal, the trailhead. */
  maxSupport: number;
  maxFoodVenues: number;
  /**
   * How many attractions any one category may contribute before the rest are
   * held back.
   *
   * Density control, not taste. A dense scope returns four hundred historic
   * plaques and eleven museums, and a board built from the top of that list by
   * score alone is a board of plaques. Held-back candidates are counted, not
   * discarded silently.
   */
  maxPerCategory: number;
}

export const DEFAULT_INVENTORY_LIMITS: InventoryLimits = {
  maxAttractions: 140,
  maxSupport: 25,
  maxFoodVenues: 60,
  maxPerCategory: 22,
};

export interface InventoryResult {
  candidates: DiscoveredCandidate[];
  /** Records the food layer should turn into venues. Never `Place`s. */
  foodRecords: SourceRecord[];
  licences: DataLicence[];
  diagnostics: {
    recordsConsidered: number;
    superseded: number;
    excludedByRole: number;
    heldBackByCategoryCap: number;
    attractions: number;
    support: number;
    food: number;
    /** How many attractions came from each layer, so thinness can be located. */
    byLayer: { layerId: string; kept: number }[];
  };
}

export function buildInventory(input: {
  pack: RegionPack;
  scope: GeographicScope;
  limits?: Partial<InventoryLimits>;
}): InventoryResult {
  const limits = { ...DEFAULT_INVENTORY_LIMITS, ...input.limits };
  const records = input.pack.layers.flatMap((layer) => layer.records);
  const superseded = supersededRecordIds(records, input.pack.links);
  const crossLayer = crossLayerCorroboration(records, input.pack.links);

  const byRole = new Map<PlanningRole, SourceRecord[]>();
  let excludedByRole = 0;
  for (const record of records) {
    if (superseded.has(record.id)) continue;
    if (record.planningRole === 'excluded' || record.planningRole === 'administrative') {
      excludedByRole += 1;
      continue;
    }
    const bucket = byRole.get(record.planningRole);
    if (bucket) bucket.push(record);
    else byRole.set(record.planningRole, [record]);
  }

  const attractionPool = rank(byRole.get('attraction') ?? []);
  const supportPool = rank(byRole.get('support') ?? []);
  const foodPool = rank(byRole.get('food') ?? []);

  const categoryCounts = new Map<string, number>();
  let heldBack = 0;
  const attractions: SourceRecord[] = [];
  for (const record of attractionPool) {
    if (attractions.length >= limits.maxAttractions) break;
    const category = classifySourceCategory({
      category: record.sourceCategory,
      path: record.sourceCategoryPath,
    }).category;
    const seen = categoryCounts.get(category) ?? 0;
    if (seen >= limits.maxPerCategory) {
      heldBack += 1;
      continue;
    }
    categoryCounts.set(category, seen + 1);
    attractions.push(record);
  }

  const support = supportPool.slice(0, limits.maxSupport);
  const food = foodPool.slice(0, limits.maxFoodVenues);

  const candidates = [...interleaveByCategory(attractions), ...support].map((record) =>
    toCandidate(record, input.scope, crossLayer.has(record.id)),
  );

  const keptByLayer = new Map<string, number>();
  for (const record of [...attractions, ...support]) {
    keptByLayer.set(record.layerId, (keptByLayer.get(record.layerId) ?? 0) + 1);
  }

  return {
    candidates,
    foodRecords: food,
    licences: packLicences(input.pack),
    diagnostics: {
      recordsConsidered: records.length,
      superseded: superseded.size,
      excludedByRole,
      heldBackByCategoryCap: heldBack,
      attractions: attractions.length,
      support: support.length,
      food: food.length,
      byLayer: [...keptByLayer.entries()]
        .map(([layerId, kept]) => ({ layerId, kept }))
        .sort((a, b) => a.layerId.localeCompare(b.layerId)),
    },
  };
}

/**
 * The order records are considered in, and it is not a fit score.
 *
 * Fit needs a traveller and this runs before one is applied; what this orders on
 * is *how much is known* — how many attributes the source recorded, whether
 * anyone published a site, whether an open identifier exists, whether the source
 * says it is open. A record's existence confidence is deliberately absent: it
 * says the thing probably exists, which every record here already claims.
 *
 * Deterministic to the last tiebreak, because the pack's content hash depends on
 * it and so does the reproducibility of a compilation.
 */
function rank(records: readonly SourceRecord[]): SourceRecord[] {
  return [...records]
    .map((record) => ({ record, score: knownness(record) }))
    .sort((a, b) => b.score - a.score || a.record.id.localeCompare(b.record.id))
    .map((entry) => entry.record);
}

/**
 * Scored by *kinds* of evidence, not by how many attributes a layer happens to
 * publish.
 *
 * The first version counted attributes, and that turned out to be a layer bias
 * rather than a quality signal: the geographic layers carry a bag of upstream
 * tags and the primary place catalogue carries none, so a live New York run
 * ranked fourteen small municipal parks above every museum in Manhattan. What is
 * counted now is present in both vocabularies — a published site, an open
 * identifier, posted hours, a named operator, a known address, a real taxonomy
 * path — so a record is ranked on what is known about it rather than on which
 * schema it arrived in.
 */
/**
 * The order candidates leave in, round-robin across categories.
 *
 * Rank order alone was correct and useless. A live New York build handed the
 * compiler a hundred candidates in pure rank order, the whole hundred were
 * municipal parks — the geographic layers tag them richly — and the traveller's
 * board came back with seventeen walks and two of everything else. Nothing had
 * gone wrong at any single step: the inventory was broad, and the *first
 * hundred* of it was not.
 *
 * So the order carries the breadth rather than only the list. Every downstream
 * truncation — the coarse-candidate budget, the shortlist, the board — now cuts
 * a representative slice instead of the top of one category. Within a category
 * the ranking is untouched.
 */
function interleaveByCategory(records: readonly SourceRecord[]): SourceRecord[] {
  const byCategory = new Map<string, SourceRecord[]>();
  for (const record of records) {
    const category = classifySourceCategory({
      category: record.sourceCategory,
      path: record.sourceCategoryPath,
    }).category;
    const bucket = byCategory.get(category);
    if (bucket) bucket.push(record);
    else byCategory.set(category, [record]);
  }

  /**
   * Categories ordered by how many they have, largest first, then by name.
   * Deterministic, and it puts the well-populated kinds at the front of each
   * round rather than letting insertion order decide.
   */
  const buckets = [...byCategory.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([, entries]) => entries);

  const ordered: SourceRecord[] = [];
  for (let round = 0; ordered.length < records.length; round += 1) {
    let progressed = false;
    for (const bucket of buckets) {
      const next = bucket[round];
      if (!next) continue;
      ordered.push(next);
      progressed = true;
    }
    if (!progressed) break;
  }
  return ordered;
}

function knownness(record: SourceRecord): number {
  const other = Object.keys(record.attributes).filter(
    (key) => key !== 'operator' && key !== 'opening_hours' && key !== 'website',
  ).length;
  return (
    (record.websiteCandidates.length > 0 ? 6 : 0) +
    (record.wikidataId ? 5 : 0) +
    (record.attributes.opening_hours ? 4 : 0) +
    (record.attributes.operator ? 3 : 0) +
    // Somebody put this in an addressable place: a real locality, not a bbox.
    (record.containment.localityName || record.containment.neighbourhoodName ? 2 : 0) +
    // A category path of any depth means a classified record rather than a blob.
    (record.sourceCategoryPath.length >= 2 ? 2 : 0) +
    (record.bounds ? 2 : 0) +
    (record.alternateNames.length > 0 ? 1 : 0) +
    Math.min(4, other) * 2 +
    (record.operatingStatus === 'closed' ? -50 : 0)
  );
}

/**
 * Records that two different layers independently found.
 *
 * The only thing in this pipeline that earns `multiple_providers_agree`. A
 * conflated catalogue listing four contributors inside one row does not, because
 * we did not watch it conflate them and cannot say they agreed.
 */
function crossLayerCorroboration(
  records: readonly SourceRecord[],
  links: readonly CandidateLink[],
): Set<string> {
  const layerOf = new Map(records.map((record) => [record.id, record.layerId]));
  const corroborated = new Set<string>();
  for (const link of links) {
    if (link.kind !== 'same_entity' && link.kind !== 'probable_same_entity') continue;
    const layers = new Set(link.recordIds.map((id) => layerOf.get(id)).filter(Boolean));
    if (layers.size < 2) continue;
    for (const id of link.recordIds) corroborated.add(id);
  }
  return corroborated;
}

// ---------------------------------------------------------------------------
// Record → Place
// ---------------------------------------------------------------------------

function toCandidate(
  record: SourceRecord,
  scope: GeographicScope,
  crossLayerCorroborated: boolean,
): DiscoveredCandidate {
  const taxonomy = classifySourceCategory({
    category: record.sourceCategory,
    path: record.sourceCategoryPath,
  });

  /**
   * How completely the source describes this, as a weak proxy and labelled one.
   *
   * There is no rating and no review count anywhere in the open stack, which is
   * a feature: there is no popularity number to mistake for quality. What there
   * is, is how much somebody bothered to record — a place many people care about
   * carries a site, an operator, posted hours. It never outranks what the
   * traveller said they came for.
   */
  const richness = Math.min(
    1,
    (Object.keys(record.attributes).length + record.websiteCandidates.length + (record.wikidataId ? 1 : 0)) / 6,
  );
  const popularity = Math.min(0.9, 0.2 + richness * 0.6);

  const place: Place = {
    id: record.id,
    regionId: `compiled-${scope.destinationCandidateId}`,
    name: record.name,
    locality: localityOf(record, scope),
    shortDescription: describe(record, taxonomy.category),
    coordinates: record.coordinates,
    /**
     * The classifying category, plus the *names* of the attributes the source
     * recorded. Names, never values: which attributes exist is a quality signal
     * the assessor already reads, while a table of somebody's attribute values
     * would be a redistribution of their database.
     */
    tags: [
      `${record.layerId}=${record.sourceCategory}`,
      ...Object.keys(record.attributes).map((key) => `attr:${key}`),
      ...(record.websiteCandidates.length > 0 ? ['attr:website'] : []),
      ...(record.wikidataId ? ['attr:wikidata'] : []),
    ],
    source: {
      name: sourceNameOf(record),
      kind: 'osm',
      ...(officialUrlOf(record) ? { url: officialUrlOf(record)! } : {}),
      confidence: 0.7,
      lastVerified: (record.sources[0]?.updateTime ?? '').slice(0, 10) || '2026-01-01',
      element: {
        elementId: record.sourceId,
        database: record.layerId,
        licenceId: record.sources[0]?.licenceId ?? 'ODbL-1.0',
        ...(record.sources[0]?.updateTime ? { sourceTimestamp: record.sources[0].updateTime } : {}),
        ...(record.sourceUrl ? { url: record.sourceUrl } : {}),
      },
    },
    relationship: 'satellite',
    category: taxonomy.category,
    interests: taxonomy.interests.length > 0 ? taxonomy.interests : ['scenic_viewpoints'],
    typicalDurationMinutes: taxonomy.typicalDurationMinutes,
    costLevel: taxonomy.costLevel,
    physicalIntensity: taxonomy.physicalIntensity,
    crowdLevel: popularity > 0.7 ? 'busy' : 'quiet',
    popularityScore: popularity,
    hiddenGemScore: Math.max(0.1, 1 - popularity - 0.1),
    weather: {
      exposure: taxonomy.exposure,
      precipitation: taxonomy.exposure === 'indoor' ? 'low' : 'high',
      wind: taxonomy.exposure === 'exposed_outdoor' ? 'moderate' : 'low',
      heat: taxonomy.exposure === 'indoor' ? 'low' : 'moderate',
      cold: taxonomy.exposure === 'indoor' ? 'low' : 'moderate',
      visibilityDependent: taxonomy.visibilityDependent,
      poorWeatherBackup: taxonomy.poorWeatherBackup,
      approachDegradesWhenWet: false,
    },
    bestTimeOfDay: 'any',
    /**
     * Open all year unless a source said otherwise.
     *
     * `seasonal` on a record is the mapper's own tag and is honoured; anything
     * else would be us inventing a snow gate. A real closure arrives later,
     * from an official page, with a date and a citation.
     */
    seasonalAccess: {
      openMonths: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
      closureRisk: record.attributes.seasonal ? 'seasonal' : 'none',
    },
    access: {
      roadSurface: 'paved',
      mountainRoad: false,
      parkingDifficulty: scope.transport.carAvailable ? 'moderate' : 'hard',
      remoteNoServices: false,
    },
    travelFromBase: { distanceKm: 0, driveMinutes: 0, driveIsScenic: false },
  };

  const signals: ConfidenceSignal[] = crossLayerCorroborated
    ? ['multiple_providers_agree']
    : ['single_provider_only'];

  return {
    place,
    providerRefs: providerRefsOf(record),
    facts: [],
    confidenceSignals: signals,
  };
}

/**
 * One provider reference per distinct upstream dataset.
 *
 * Distinct, because a conflated record can list the same dataset twice — once
 * for the record and once for a derived property — and counting that as two
 * sources would make conflation look like corroboration.
 */
function providerRefsOf(record: SourceRecord): ProviderRef[] {
  const seen = new Set<string>();
  const refs: ProviderRef[] = [];
  for (const source of record.sources) {
    if (seen.has(source.dataset)) continue;
    seen.add(source.dataset);
    refs.push({
      provider: source.dataset,
      externalId: source.recordId ?? record.sourceId,
      ...(record.sourceUrl ? { url: record.sourceUrl } : {}),
    });
  }
  if (refs.length === 0) {
    refs.push({ provider: record.layerId, externalId: record.sourceId });
  }
  return refs;
}

/**
 * The operator's own domain where the source carried one.
 *
 * A link back into the source database is not an official site, and treating it
 * as one is how a research funnel spends its budget reading a map viewer.
 */
function officialUrlOf(record: SourceRecord): string | undefined {
  const candidate = record.websiteCandidates[0];
  if (!candidate) return undefined;
  if (/openstreetmap\.org|wikidata\.org|wikipedia\.org/i.test(candidate)) return undefined;
  return candidate;
}

function sourceNameOf(record: SourceRecord): string {
  const datasets = [...new Set(record.sources.map((source) => source.dataset))];
  return datasets.length > 0 ? datasets.join(', ') : record.layerId;
}

function localityOf(record: SourceRecord, scope: GeographicScope): string {
  return (
    record.containment.neighbourhoodName ??
    record.containment.localityName ??
    record.containment.regionName ??
    scope.destinationName
  );
}

/**
 * A description built from facts, and short when there are none.
 *
 * Deliberately not prose. The quality assessor treats a description over forty
 * characters as one of seven evidence marks, so a template that always produced
 * a flowing sentence would hand every candidate that mark and make the signal
 * meaningless. What this produces instead grows only when the source actually
 * recorded something — an operator, an elevation, a boundary — so its length
 * tracks evidence rather than style.
 */
function describe(record: SourceRecord, category: Place['category']): string {
  const label = PLACE_CATEGORY_LABELS[category].toLowerCase();
  const where =
    record.containment.localityName ?? record.containment.regionName ?? undefined;
  const parts = [where ? `A ${label} in ${where}.` : `A ${label}.`];

  const operator = record.attributes.operator;
  if (operator) parts.push(`Run by ${operator}.`);
  const elevation = record.attributes.ele;
  if (elevation && /^\d{2,5}$/.test(elevation)) parts.push(`Recorded at ${elevation} m.`);
  const fee = record.attributes.fee;
  if (fee === 'yes') parts.push('The map data records a charge to enter.');
  else if (fee === 'no') parts.push('The map data records no charge to enter.');

  return parts.join(' ').slice(0, 280);
}

// ---------------------------------------------------------------------------
// Licences
// ---------------------------------------------------------------------------

/**
 * Every licence the pack's records actually carry, unioned from the records
 * rather than from the layer.
 *
 * Layer-level would be a shortcut and a wrong one: a places layer holds records
 * under three different licences depending on which upstream contributor
 * supplied them, and a screen that shows one of them has under-attributed the
 * other two.
 */
export function packLicences(pack: RegionPack): DataLicence[] {
  const byId = new Map<LicenceId, Set<string>>();
  for (const layer of pack.layers) {
    for (const record of layer.records) {
      for (const source of record.sources) {
        const applies = byId.get(source.licenceId) ?? new Set<string>();
        applies.add(layer.kind === 'primary_places' ? 'places' : 'geography');
        byId.set(source.licenceId, applies);
      }
    }
  }
  const licences = [...byId.entries()].map(([id, applies]) => licence(id, [...applies].sort()));
  return licences.sort((a, b) => a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------------------
// Food
// ---------------------------------------------------------------------------

const FOOD_SERVICE_BY_CATEGORY: Record<string, FoodVenue['serviceType']> = {
  restaurant: 'restaurant',
  pizza_restaurant: 'restaurant',
  seafood_restaurant: 'restaurant',
  italian_restaurant: 'restaurant',
  japanese_restaurant: 'restaurant',
  chinese_restaurant: 'restaurant',
  mexican_restaurant: 'restaurant',
  indian_restaurant: 'restaurant',
  thai_restaurant: 'restaurant',
  french_restaurant: 'restaurant',
  bar: 'restaurant',
  pub: 'restaurant',
  brewery: 'restaurant',
  wine_bar: 'restaurant',
  cafe: 'cafe',
  coffee_shop: 'cafe',
  tea_room: 'cafe',
  bakery: 'bakery',
  patisserie: 'bakery',
  dessert_shop: 'bakery',
  ice_cream_shop: 'bakery',
  fast_food: 'takeaway',
  fast_food_restaurant: 'takeaway',
  sandwich_shop: 'takeaway',
  food_truck: 'takeaway',
  food_court: 'food_hall',
  food_hall: 'food_hall',
  market: 'market',
  marketplace: 'market',
  farmers_market: 'market',
  public_market: 'market',
  supermarket: 'grocery',
  grocery_store: 'grocery',
  convenience_store: 'grocery',
  greengrocer: 'grocery',
  deli: 'grocery',
  delicatessen: 'grocery',
  butcher: 'grocery',
  organic_grocery_store: 'grocery',
};

const FOOD_SERVICE_WORDS: Record<FoodVenue['serviceType'], string> = {
  restaurant: 'A restaurant',
  cafe: 'A café',
  bakery: 'A bakery',
  market: 'A market',
  grocery: 'A food shop',
  food_hall: 'A food hall',
  takeaway: 'A takeaway',
};

const FOOD_MEAL_PERIODS: Record<FoodVenue['serviceType'], FoodVenue['mealPeriods']> = {
  restaurant: ['lunch', 'dinner'],
  cafe: ['breakfast', 'lunch', 'coffee'],
  bakery: ['breakfast', 'coffee'],
  market: ['lunch', 'groceries'],
  grocery: ['groceries'],
  food_hall: ['lunch', 'dinner'],
  takeaway: ['lunch', 'dinner'],
};

const FOOD_SERVICE_MINUTES: Record<FoodVenue['serviceType'], number> = {
  restaurant: 75,
  cafe: 30,
  bakery: 15,
  market: 40,
  grocery: 20,
  food_hall: 45,
  takeaway: 20,
};

const DIET_ATTRIBUTES: readonly [string, FoodVenue['dietary'][number]['need']][] = [
  ['diet:vegetarian', 'vegetarian'],
  ['diet:vegan', 'vegan'],
  ['diet:gluten_free', 'gluten_free'],
  ['diet:halal', 'halal'],
];

/**
 * A pack record turned into a venue, and honest about what it does not know.
 *
 * Hours start `unknown`, which the food planner refuses to schedule; price is
 * inferred from the format and labelled as such; dietary claims come only from
 * an explicit attribute and never reach the level a traveller with an allergy
 * should act on. All three defaults are the cautious one, and all three are the
 * ones the research funnel may later improve.
 */
export function foodVenueFromRecord(input: {
  record: SourceRecord;
  scope: GeographicScope;
  routingId: string;
}): FoodVenue | null {
  const { record, scope, routingId } = input;
  const serviceType = resolveServiceType(record);
  if (!serviceType) return null;

  /**
   * A shop nobody has confirmed the hours of is not a provisioning stop.
   *
   * The food schema holds two rules that meet here: a venue that serves
   * groceries must be one you can actually take food away from, and a
   * provisioning stop must have confirmed hours — because it is scheduled
   * *before* the food is needed, so a wrong guess strands the whole of the next
   * day. Together they make an unconfirmed grocery unrepresentable, which is the
   * schema being right rather than the schema being awkward.
   *
   * Building one anyway produced a food dataset the region's own integrity gate
   * rejected, which is how this surfaced. So it is not built: the region has no
   * provisioning stop, the gap is reported, and a later run that confirms hours
   * can have one.
   */
  const posted = record.attributes.opening_hours
    ? parseOsmOpeningHours(record.attributes.opening_hours)
    : null;
  const hasSchedule = posted?.kind === 'scheduled';
  const provisioningType = serviceType === 'grocery' || serviceType === 'market';
  if (provisioningType && !hasSchedule) return null;

  const dietary: FoodVenue['dietary'] = [];
  for (const [key, need] of DIET_ATTRIBUTES) {
    const value = record.attributes[key];
    if (value === 'yes' || value === 'only') {
      dietary.push({
        need,
        evidence: 'menu_lists_options',
        note: 'The source database records this as available. Confirm with the venue if it matters.',
      });
    }
  }

  const website = record.websiteCandidates[0];

  return {
    id: `food-${record.id}`,
    regionId: `compiled-${scope.destinationCandidateId}`,
    name: record.name,
    locality: localityOf(record, scope),
    shortDescription: `${FOOD_SERVICE_WORDS[serviceType]} recorded in ${sourceNameOf(record)} for ${localityOf(record, scope)}.`.slice(0, 280),
    coordinates: record.coordinates,
    tags: [`${record.layerId}=${record.sourceCategory}`],
    source: {
      name: sourceNameOf(record),
      kind: 'osm',
      ...(website ? { url: website } : record.sourceUrl ? { url: record.sourceUrl } : {}),
      confidence: 0.6,
      lastVerified: (record.sources[0]?.updateTime ?? '').slice(0, 10) || '2026-01-01',
      element: {
        elementId: record.sourceId,
        database: record.layerId,
        licenceId: record.sources[0]?.licenceId ?? 'ODbL-1.0',
        ...(record.sources[0]?.updateTime ? { sourceTimestamp: record.sources[0].updateTime } : {}),
        ...(record.sourceUrl ? { url: record.sourceUrl } : {}),
      },
    },
    serviceType,
    mealPeriods: FOOD_MEAL_PERIODS[serviceType],
    cuisines: record.attributes.cuisine ? [record.attributes.cuisine.split(';')[0]!] : [],
    priceBand: 'moderate',
    priceEvidence: 'format_inferred',
    serviceMinutes: FOOD_SERVICE_MINUTES[serviceType],
    reservation: { requirement: 'unknown' },
    takeaway: record.attributes.takeaway === 'yes' ? 'confirmed' : 'unknown',
    /**
     * Provisioning stays `none` while hours are unknown — the food schema
     * refuses a provisioning stop without confirmed hours, and rightly: a packed
     * lunch nobody could buy strands the whole of the next day.
     */
    /**
     * You can only be relied on to buy food somewhere that is open.
     *
     * The schema enforces this and it is right to: a provisioning stop is
     * scheduled *before* the food is needed, so a wrong guess about its hours
     * strands the whole of the next day. Without confirmed hours the venue still
     * exists — it is simply somewhere to eat rather than somewhere to stock up.
     */
    provisioning: !hasSchedule
      ? ('none' as const)
      : provisioningType
        ? ('packed_meals' as const)
        : serviceType === 'bakery'
          ? ('snacks' as const)
          : ('none' as const),
    dietary,
    /**
     * Posted hours where a mapper wrote them, honestly unknown otherwise.
     *
     * `unverified` and `estimated`, never `published`: a tag on an open map is a
     * person writing down what they saw, which is real evidence and is not the
     * operator's own statement. The research funnel can still upgrade it, and
     * until it does the copy tells the traveller to check.
     */
    hours:
      posted && posted.kind === 'scheduled'
        ? {
            kind: 'scheduled' as const,
            hoursConfidence: 'unverified' as const,
            periods: posted.periods,
            closedAnnualDates: [],
            provenance: {
              kind: 'estimated' as const,
              sourceName: sourceNameOf(record),
              confidence: 0.5,
              volatility: 'dynamic' as const,
              recheckNote: 'These hours were recorded by a mapper, not the venue. Check before you go.',
            },
          }
        : {
            kind: 'unknown' as const,
            hoursConfidence: 'unverified' as const,
            note: 'Nobody publishes hours for this that we could read.',
            provenance: {
              kind: 'estimated' as const,
              sourceName: sourceNameOf(record),
              confidence: 0.3,
              volatility: 'dynamic' as const,
              recheckNote: 'We have no confirmed hours for this. Check before you go.',
            },
          },
    routingId,
    walkMinutesFromRouting: 0,
  };
}

function resolveServiceType(record: SourceRecord): FoodVenue['serviceType'] | null {
  const direct = FOOD_SERVICE_BY_CATEGORY[normalise(record.sourceCategory)];
  if (direct) return direct;
  for (let index = record.sourceCategoryPath.length - 1; index >= 0; index -= 1) {
    const segment = FOOD_SERVICE_BY_CATEGORY[normalise(record.sourceCategoryPath[index]!)];
    if (segment) return segment;
  }
  /**
   * A record the food branch claimed but whose leaf we do not recognise.
   *
   * `restaurant` is the safe landing: its meal periods are the narrowest, its
   * provisioning is `none`, and nothing downstream will rely on it for a packed
   * lunch. Returning null instead would silently drop somewhere to eat.
   */
  return record.planningRole === 'food' ? 'restaurant' : null;
}

function normalise(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, '_');
}
