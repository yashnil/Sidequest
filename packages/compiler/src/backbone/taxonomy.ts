import type {
  Interest,
  PhysicalIntensity,
  PlaceCategory,
  PlanningRole,
  WeatherExposure,
} from '@sidequest/core';

/**
 * FROM A SOURCE'S CATEGORY VOCABULARY TO OURS, WITHOUT A MODEL.
 *
 * Phase 8 sent every discovered candidate to a language model to be told what
 * kind of thing it was. That call was the single largest fixed cost in a
 * compilation — a batched request over ninety-six subjects, retried, timing out
 * on the dense city it was most needed for — and it was buying an answer the
 * source already publishes.
 *
 * A global place catalogue's taxonomy is a controlled vocabulary. `historic_site`
 * means the same thing in Reykjavik and Osaka, which is exactly the property
 * that makes a lookup table honest here and dishonest for, say, "is this worth a
 * detour". So the mapping is a table, it is deterministic, it is free, and it is
 * checked by tests rather than by a temperature setting.
 *
 * Two rules keep it generic:
 *
 * - **Nothing names a destination.** Every key is a category, a branch or a
 *   feature class from somebody else's global vocabulary.
 * - **The fallback is a real answer, not a guess.** A category we do not
 *   recognise resolves through its *branch*, and a branch we do not recognise
 *   resolves to `excluded` — which keeps the record in the pack, out of the
 *   attraction inventory, and available to anything that wants it later. It does
 *   not invent a museum.
 */

export interface TaxonomyClassification {
  role: PlanningRole;
  category: PlaceCategory;
  interests: Interest[];
  typicalDurationMinutes: number;
  physicalIntensity: PhysicalIntensity;
  exposure: WeatherExposure;
  visibilityDependent: boolean;
  poorWeatherBackup: boolean;
  /** 0 free … 3 expensive. What the *kind* of thing usually costs, not a price. */
  costLevel: 0 | 1 | 2 | 3;
  /** True when a place of this kind normally has opening hours worth finding. */
  plausiblyGated: boolean;
}

type Rule = Omit<TaxonomyClassification, 'role'> & { role?: PlanningRole };

const OUTDOOR_VIEW: Rule = {
  category: 'viewpoint',
  interests: ['scenic_viewpoints', 'photography_golden_hour'],
  typicalDurationMinutes: 45,
  physicalIntensity: 'easy',
  exposure: 'exposed_outdoor',
  visibilityDependent: true,
  poorWeatherBackup: false,
  costLevel: 0,
  plausiblyGated: false,
};

const WALK: Rule = {
  category: 'easy_walk',
  interests: ['easy_nature_walks', 'scenic_viewpoints'],
  typicalDurationMinutes: 75,
  physicalIntensity: 'easy',
  exposure: 'sheltered_outdoor',
  visibilityDependent: false,
  poorWeatherBackup: false,
  costLevel: 0,
  plausiblyGated: false,
};

const HIKE: Rule = {
  category: 'day_hike',
  interests: ['hiking', 'scenic_viewpoints'],
  typicalDurationMinutes: 180,
  physicalIntensity: 'moderate',
  exposure: 'exposed_outdoor',
  visibilityDependent: true,
  poorWeatherBackup: false,
  costLevel: 0,
  plausiblyGated: false,
};

const WATER: Rule = {
  category: 'lake',
  interests: ['lakes_and_rivers', 'scenic_viewpoints'],
  typicalDurationMinutes: 90,
  physicalIntensity: 'easy',
  exposure: 'exposed_outdoor',
  visibilityDependent: false,
  poorWeatherBackup: false,
  costLevel: 0,
  plausiblyGated: false,
};

const MUSEUM: Rule = {
  category: 'museum',
  interests: ['history_and_culture'],
  typicalDurationMinutes: 120,
  physicalIntensity: 'none',
  exposure: 'indoor',
  visibilityDependent: false,
  poorWeatherBackup: true,
  costLevel: 2,
  plausiblyGated: true,
};

const HISTORIC: Rule = {
  category: 'historic_site',
  interests: ['history_and_culture'],
  typicalDurationMinutes: 75,
  physicalIntensity: 'easy',
  exposure: 'mixed',
  visibilityDependent: false,
  poorWeatherBackup: false,
  costLevel: 1,
  plausiblyGated: true,
};

const TOWN: Rule = {
  category: 'town_and_food',
  interests: ['food_and_towns'],
  typicalDurationMinutes: 90,
  physicalIntensity: 'easy',
  exposure: 'mixed',
  visibilityDependent: false,
  poorWeatherBackup: true,
  costLevel: 2,
  plausiblyGated: true,
};

const GEOTHERMAL: Rule = {
  category: 'geothermal',
  interests: ['geology_and_geothermal'],
  typicalDurationMinutes: 60,
  physicalIntensity: 'easy',
  exposure: 'exposed_outdoor',
  visibilityDependent: false,
  poorWeatherBackup: false,
  costLevel: 0,
  plausiblyGated: false,
};

const WILDLIFE: Rule = {
  category: 'wildlife_area',
  interests: ['wildlife', 'easy_nature_walks'],
  typicalDurationMinutes: 120,
  physicalIntensity: 'easy',
  exposure: 'exposed_outdoor',
  visibilityDependent: false,
  poorWeatherBackup: false,
  costLevel: 1,
  plausiblyGated: true,
};

const TRAM: Rule = {
  category: 'gondola_or_tram',
  interests: ['scenic_viewpoints', 'photography_golden_hour'],
  typicalDurationMinutes: 105,
  physicalIntensity: 'none',
  exposure: 'mixed',
  visibilityDependent: true,
  poorWeatherBackup: false,
  costLevel: 3,
  plausiblyGated: true,
};

const MONUMENT: Rule = {
  category: 'national_monument',
  interests: ['history_and_culture', 'scenic_viewpoints'],
  typicalDurationMinutes: 90,
  physicalIntensity: 'easy',
  exposure: 'mixed',
  visibilityDependent: false,
  poorWeatherBackup: false,
  costLevel: 1,
  plausiblyGated: true,
};

const HOT_SPRING: Rule = {
  category: 'hot_spring',
  interests: ['hot_springs', 'geology_and_geothermal'],
  typicalDurationMinutes: 90,
  physicalIntensity: 'easy',
  exposure: 'exposed_outdoor',
  visibilityDependent: false,
  poorWeatherBackup: false,
  costLevel: 1,
  plausiblyGated: false,
};

const SCENIC_ROUTE: Rule = {
  category: 'scenic_drive',
  interests: ['scenic_drives', 'scenic_viewpoints'],
  typicalDurationMinutes: 120,
  physicalIntensity: 'none',
  exposure: 'mixed',
  visibilityDependent: true,
  poorWeatherBackup: false,
  costLevel: 0,
  plausiblyGated: false,
};

/** A real, mapped, useful thing that is not a reason to plan a day. */
const SUPPORT: Rule = {
  role: 'support',
  category: 'town_and_food',
  interests: ['food_and_towns'],
  typicalDurationMinutes: 30,
  physicalIntensity: 'none',
  exposure: 'mixed',
  visibilityDependent: false,
  poorWeatherBackup: true,
  costLevel: 1,
  plausiblyGated: true,
};

const FOOD: Rule = {
  role: 'food',
  category: 'town_and_food',
  interests: ['food_and_towns'],
  typicalDurationMinutes: 60,
  physicalIntensity: 'none',
  exposure: 'indoor',
  visibilityDependent: false,
  poorWeatherBackup: true,
  costLevel: 2,
  plausiblyGated: true,
};

const LODGING: Rule = {
  role: 'lodging',
  category: 'town_and_food',
  interests: ['food_and_towns'],
  typicalDurationMinutes: 30,
  physicalIntensity: 'none',
  exposure: 'indoor',
  visibilityDependent: false,
  poorWeatherBackup: true,
  costLevel: 3,
  plausiblyGated: true,
};

const EXCLUDED: Rule = {
  role: 'excluded',
  category: 'town_and_food',
  interests: ['food_and_towns'],
  typicalDurationMinutes: 30,
  physicalIntensity: 'none',
  exposure: 'indoor',
  visibilityDependent: false,
  poorWeatherBackup: false,
  costLevel: 1,
  plausiblyGated: false,
};

/**
 * Exact category matches, checked first.
 *
 * The keys are the leaf values a global place taxonomy and an OSM-derived
 * feature vocabulary actually publish. Where the two vocabularies agree on a
 * word — `park`, `beach`, `waterfall`, `museum` — one entry serves both.
 */
const BY_CATEGORY: Record<string, Rule> = {
  // Viewpoints and lookouts
  viewpoint: OUTDOOR_VIEW,
  scenic_lookout: OUTDOOR_VIEW,
  observation_deck: { ...OUTDOOR_VIEW, exposure: 'mixed', costLevel: 2, plausiblyGated: true },
  scenic_point_of_interest: OUTDOOR_VIEW,
  peak: { ...OUTDOOR_VIEW, typicalDurationMinutes: 60 },
  summit: { ...OUTDOOR_VIEW, typicalDurationMinutes: 60 },
  saddle: OUTDOOR_VIEW,
  ridge: OUTDOOR_VIEW,
  cliff: OUTDOOR_VIEW,
  volcano: { ...OUTDOOR_VIEW, typicalDurationMinutes: 120 },

  // Walking, hiking, parks
  park: { ...WALK, category: 'easy_walk', typicalDurationMinutes: 90 },
  national_park: { ...HIKE, typicalDurationMinutes: 240, plausiblyGated: true, costLevel: 1 },
  state_park: { ...WALK, typicalDurationMinutes: 150, plausiblyGated: true, costLevel: 1 },
  nature_reserve: { ...WILDLIFE },
  nature_preserve: { ...WILDLIFE },
  protected_area: { ...WILDLIFE },
  botanical_garden: { ...WALK, costLevel: 2, plausiblyGated: true },
  garden: WALK,
  hiking_trail: HIKE,
  trail: HIKE,
  trailhead: { ...SUPPORT, category: 'day_hike', interests: ['hiking'], typicalDurationMinutes: 20 },
  forest: WALK,
  valley: { ...OUTDOOR_VIEW, typicalDurationMinutes: 60 },
  hill: OUTDOOR_VIEW,
  mountain_range: OUTDOOR_VIEW,
  dune: WALK,
  cave: { ...HIKE, exposure: 'sheltered_outdoor', visibilityDependent: false, plausiblyGated: true, costLevel: 2 },
  cave_entrance: { ...HIKE, exposure: 'sheltered_outdoor', visibilityDependent: false },

  // Water
  lake: WATER,
  reservoir: WATER,
  river: WATER,
  pond: WATER,
  lagoon: WATER,
  bay: WATER,
  fjord: { ...WATER, visibilityDependent: true },
  waterfall: { ...WATER, category: 'lake', typicalDurationMinutes: 60 },
  beach: { ...WATER, category: 'lake', typicalDurationMinutes: 150, interests: ['lakes_and_rivers', 'scenic_viewpoints'] },
  glacier: { ...OUTDOOR_VIEW, typicalDurationMinutes: 120, interests: ['geology_and_geothermal', 'scenic_viewpoints'] },
  spring: GEOTHERMAL,
  hot_spring: HOT_SPRING,
  geyser: GEOTHERMAL,
  fumarole: GEOTHERMAL,

  // Culture
  museum: MUSEUM,
  art_museum: MUSEUM,
  history_museum: MUSEUM,
  science_museum: MUSEUM,
  art_gallery: { ...MUSEUM, typicalDurationMinutes: 75, costLevel: 1 },
  gallery: { ...MUSEUM, typicalDurationMinutes: 75, costLevel: 1 },
  aquarium: { ...MUSEUM, interests: ['wildlife'], costLevel: 3 },
  zoo: { ...WILDLIFE, exposure: 'mixed', costLevel: 3, typicalDurationMinutes: 180 },
  planetarium: MUSEUM,
  library: { ...MUSEUM, costLevel: 0, typicalDurationMinutes: 45 },
  theatre: { ...MUSEUM, typicalDurationMinutes: 150, costLevel: 3 },
  concert_hall: { ...MUSEUM, typicalDurationMinutes: 150, costLevel: 3 },
  historic_site: HISTORIC,
  historical_landmark: HISTORIC,
  archaeological_site: { ...HISTORIC, typicalDurationMinutes: 90, exposure: 'exposed_outdoor' },
  castle: { ...HISTORIC, typicalDurationMinutes: 120, costLevel: 2 },
  fort: HISTORIC,
  ruins: { ...HISTORIC, exposure: 'exposed_outdoor', costLevel: 0, plausiblyGated: false },
  monument: MONUMENT,
  memorial: { ...MONUMENT, typicalDurationMinutes: 40 },
  landmark_and_historical_building: HISTORIC,

  /**
   * Somewhere to worship, and the distinction the live evaluation forced.
   *
   * A cathedral, a temple and a shrine are destinations. A storefront
   * congregation is not, and a live New York run put nine neighbourhood churches
   * on the board as historic sites because the catalogue files every
   * denomination under a cultural-and-historic branch.
   *
   * So the *building* words are attractions and the *congregation* words are
   * support stops — see `religious_organization` in the branch table below. The
   * split is on the source's vocabulary, not on any judgement about which faiths
   * make good sightseeing, and it holds in Bali and Bavaria alike.
   */
  place_of_worship: { ...SUPPORT, typicalDurationMinutes: 40, exposure: 'indoor' },
  church: { ...HISTORIC, typicalDurationMinutes: 45, exposure: 'indoor', poorWeatherBackup: true },
  cathedral: { ...HISTORIC, typicalDurationMinutes: 60, exposure: 'indoor', poorWeatherBackup: true },
  basilica: { ...HISTORIC, typicalDurationMinutes: 60, exposure: 'indoor', poorWeatherBackup: true },
  abbey: { ...HISTORIC, typicalDurationMinutes: 60 },
  monastery: { ...HISTORIC, typicalDurationMinutes: 60 },
  temple: { ...HISTORIC, typicalDurationMinutes: 45, exposure: 'mixed' },
  hindu_temple: { ...HISTORIC, typicalDurationMinutes: 45, exposure: 'mixed' },
  buddhist_temple: { ...HISTORIC, typicalDurationMinutes: 45, exposure: 'mixed' },
  taoist_temple: { ...HISTORIC, typicalDurationMinutes: 45, exposure: 'mixed' },
  sikh_temple: { ...HISTORIC, typicalDurationMinutes: 45, exposure: 'mixed' },
  mosque: { ...HISTORIC, typicalDurationMinutes: 45, exposure: 'indoor', poorWeatherBackup: true },
  shrine: { ...HISTORIC, typicalDurationMinutes: 40 },
  shinto_shrine: { ...HISTORIC, typicalDurationMinutes: 40 },
  synagogue: { ...HISTORIC, typicalDurationMinutes: 45, exposure: 'indoor', poorWeatherBackup: true },

  // Ways up
  cable_car: TRAM,
  aerial_lift: TRAM,
  gondola: TRAM,
  funicular: TRAM,
  ski_resort: { ...TRAM, typicalDurationMinutes: 240, physicalIntensity: 'moderate' },

  // Markets and neighbourhoods
  market: { ...TOWN, typicalDurationMinutes: 75 },
  marketplace: { ...TOWN, typicalDurationMinutes: 75 },
  farmers_market: { ...TOWN, typicalDurationMinutes: 60 },
  public_market: { ...TOWN, typicalDurationMinutes: 75 },
  neighborhood: { ...TOWN, typicalDurationMinutes: 120 },
  plaza: { ...TOWN, typicalDurationMinutes: 45, exposure: 'exposed_outdoor', poorWeatherBackup: false },
  /**
   * `pedestrian` is a container, not a destination.
   *
   * It was mapped to a town-and-food stop, and in the infrastructure layer it is
   * the *subtype* every cash machine, bench and crossing sits under — so a live
   * Bali run put eleven bank ATMs on the board. The word means "reached on
   * foot", not "worth walking to".
   */
  pedestrian: EXCLUDED,

  // Scenic routes
  scenic_drive: SCENIC_ROUTE,
  scenic_byway: SCENIC_ROUTE,
  bridge: { ...OUTDOOR_VIEW, typicalDurationMinutes: 30 },
  pier: { ...OUTDOOR_VIEW, typicalDurationMinutes: 45, visibilityDependent: false },

  /**
   * Somewhere to eat, by leaf.
   *
   * The branch table catches most of these, but a feature layer publishes a bare
   * `restaurant` or `cafe` class with no path at all — and without these entries
   * that record would fall through to the unknown-category rule and be excluded,
   * taking a region's food with it.
   */
  restaurant: FOOD,
  cafe: { ...FOOD, typicalDurationMinutes: 30 },
  coffee_shop: { ...FOOD, typicalDurationMinutes: 30 },
  bakery: { ...FOOD, typicalDurationMinutes: 20 },
  fast_food: { ...FOOD, typicalDurationMinutes: 25 },
  food_court: FOOD,
  food_hall: FOOD,
  bar: FOOD,
  pub: FOOD,
  ice_cream_shop: { ...FOOD, typicalDurationMinutes: 20 },
  deli: { ...SUPPORT, typicalDurationMinutes: 20 },

  // Lodging, by leaf, for the same reason.
  hotel: LODGING,
  hostel: LODGING,
  motel: LODGING,
  guest_house: LODGING,
  resort: LODGING,
  bed_and_breakfast: LODGING,

  // Support: real, useful, and not a day's plan
  visitor_center: { ...SUPPORT, typicalDurationMinutes: 30 },
  information: { ...SUPPORT, typicalDurationMinutes: 20 },
  ferry_terminal: { ...SUPPORT, typicalDurationMinutes: 20 },
  ferry: { ...SUPPORT, typicalDurationMinutes: 20 },
  harbor: { ...SUPPORT, typicalDurationMinutes: 30 },
  marina: { ...SUPPORT, typicalDurationMinutes: 30 },
  train_station: { ...SUPPORT, typicalDurationMinutes: 20 },
  bus_station: { ...SUPPORT, typicalDurationMinutes: 20 },
  airport: { ...SUPPORT, typicalDurationMinutes: 20 },
  parking: { ...SUPPORT, typicalDurationMinutes: 15 },
  campground: { ...SUPPORT, typicalDurationMinutes: 30 },
  supermarket: { ...SUPPORT, typicalDurationMinutes: 25 },
  grocery_store: { ...SUPPORT, typicalDurationMinutes: 25 },
  convenience_store: { ...SUPPORT, typicalDurationMinutes: 15 },
  pharmacy: { ...SUPPORT, typicalDurationMinutes: 15 },
  gas_station: { ...SUPPORT, typicalDurationMinutes: 15 },

  /**
   * Mapped street furniture. Real, useful to somebody, and never a stop.
   *
   * Named rather than left to the unknown-category fallback because each of
   * these arrives under a *known* container subtype, so the fallback would never
   * see them. Every entry is a word from an open geographic vocabulary; none is
   * a place.
   */
  atm: EXCLUDED,
  bank: EXCLUDED,
  bench: EXCLUDED,
  crossing: EXCLUDED,
  traffic_signals: EXCLUDED,
  bicycle_parking: EXCLUDED,
  waste_basket: EXCLUDED,
  drinking_water: EXCLUDED,
  toilets: EXCLUDED,
  post_box: EXCLUDED,
  telephone: EXCLUDED,
  bus_stop: EXCLUDED,
  street_lamp: EXCLUDED,
  fire_hydrant: EXCLUDED,
  utility: EXCLUDED,
  power: EXCLUDED,
  communication: EXCLUDED,
  barrier: EXCLUDED,
  manhole: EXCLUDED,
  pipeline: EXCLUDED,
  storage_tank: EXCLUDED,
  wastewater_plant: EXCLUDED,
  substation: EXCLUDED,
};

/**
 * Branch fallbacks, checked when no leaf matches.
 *
 * Keys are the top-level branches of a place taxonomy, and the list is what
 * turns a hundred thousand records into an inventory: most of a commercial place
 * catalogue is commerce, and commerce is `excluded` unless a leaf above says
 * otherwise. Over lower Manhattan this branch alone removes four thousand
 * professional-services records without naming one of them.
 */
const BY_BRANCH: Record<string, Rule> = {
  attractions_and_activities: { ...HISTORIC, role: 'attraction' },
  arts_and_entertainment: { ...MUSEUM, role: 'attraction' },
  cultural_and_historic: { ...HISTORIC, role: 'attraction' },
  geographic_entities: { ...OUTDOOR_VIEW, role: 'attraction' },
  sports_and_recreation: { ...WALK, role: 'attraction' },
  active_life: { ...WALK, role: 'attraction' },
  natural_features: { ...OUTDOOR_VIEW, role: 'attraction' },

  /**
   * Sub-branches that would otherwise inherit the wrong parent.
   *
   * These sit *under* branches this table treats as attractions, and a live New
   * York run showed what that inherits: a recording studio and a nightclub both
   * arrived as museums, because `arts_and_entertainment` is their grandparent.
   * Sidequest models no nightlife interest, so a venue whose whole purpose is an
   * evening out has nothing here that could rank it honestly.
   *
   * `religious_organization` is the congregation branch — see `place_of_worship`
   * in the leaf table for the other half of that split.
   */
  nightlife_venue: EXCLUDED,
  gaming_venue: EXCLUDED,
  music_venue: EXCLUDED,
  religious_organization: { ...SUPPORT, typicalDurationMinutes: 40, exposure: 'indoor' },

  food_and_drink: FOOD,
  eat_and_drink: FOOD,
  restaurants: FOOD,

  lodging: LODGING,
  accommodation: LODGING,

  travel_and_transportation: SUPPORT,
  shopping: SUPPORT,
  community_and_government: SUPPORT,

  services_and_business: EXCLUDED,
  business_to_business: EXCLUDED,
  professional_services: EXCLUDED,
  lifestyle_services: EXCLUDED,
  health_care: EXCLUDED,
  health_and_medical: EXCLUDED,
  education: EXCLUDED,
  financial_service: EXCLUDED,
  automotive: EXCLUDED,
  real_estate: EXCLUDED,
  mass_media: EXCLUDED,
};

/**
 * Classify one record from its source vocabulary.
 *
 * `category` is the source's leaf; `path` is its branch chain outermost first.
 * Both are the source's own words. Neither is a name, and nothing here reads
 * one — that is what makes this table the same table everywhere on earth.
 */
export function classifySourceCategory(input: {
  category: string;
  path?: readonly string[];
}): TaxonomyClassification {
  const leaf = normalise(input.category);
  const direct = BY_CATEGORY[leaf];
  if (direct) return finalise(direct);

  /**
   * Innermost branch first.
   *
   * A path is `["cultural_and_historic","historic_site"]`, and the more specific
   * end is the more informative one. Walking outwards means a leaf we do not
   * know still lands in the nearest branch we do, rather than in the broadest.
   */
  const path = (input.path ?? []).map(normalise);
  for (let index = path.length - 1; index >= 0; index -= 1) {
    const segment = path[index]!;
    const bySegment = BY_CATEGORY[segment];
    if (bySegment) return finalise(bySegment);
    const byBranch = BY_BRANCH[segment];
    if (byBranch) return finalise(byBranch);
  }

  const branch = BY_BRANCH[leaf];
  if (branch) return finalise(branch);

  /**
   * Unknown, and therefore excluded rather than promoted.
   *
   * The record stays in the pack — it may be linked to, contained by, or wanted
   * later — but it does not enter the attraction inventory on the strength of
   * nobody knowing what it is.
   */
  return finalise(EXCLUDED);
}

function finalise(rule: Rule): TaxonomyClassification {
  return {
    role: rule.role ?? 'attraction',
    category: rule.category,
    interests: [...rule.interests],
    typicalDurationMinutes: rule.typicalDurationMinutes,
    physicalIntensity: rule.physicalIntensity,
    exposure: rule.exposure,
    visibilityDependent: rule.visibilityDependent,
    poorWeatherBackup: rule.poorWeatherBackup,
    costLevel: rule.costLevel,
    plausiblyGated: rule.plausiblyGated,
  };
}

function normalise(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

/**
 * Categories whose recorded point is a *representative* point on something big.
 *
 * A mountain, a glacier, a national park and a lake all get one coordinate in a
 * database, and which coordinate depends entirely on who mapped it: a place
 * catalogue puts a volcano at its visitor entrance and a terrain layer puts it
 * at the summit. A live Bali run had exactly that — the same volcano, under the
 * same name, four kilometres apart in two layers, offered to the traveller
 * twice.
 *
 * So identity matching gets a wider radius for these, and only for these. A
 * category not in this list keeps the tight radius, because two cafés forty
 * metres apart really are two cafés.
 */
const LANDSCAPE_SCALE = new Set([
  'peak',
  'summit',
  'volcano',
  'glacier',
  'mountain_range',
  'mountain',
  'hill',
  'ridge',
  'saddle',
  'valley',
  'cliff',
  'fjord',
  'bay',
  'lagoon',
  'lake',
  'reservoir',
  'river',
  'beach',
  'dune',
  'forest',
  'national_park',
  'state_park',
  'nature_reserve',
  'nature_preserve',
  'protected_area',
  'park',
  'neighborhood',
  'scenic_drive',
  'scenic_byway',
  // A bridge and a pier are long: a live run had one bridge on the board twice,
  // recorded at each end by two layers.
  'bridge',
  'pier',
]);

export function isLandscapeScale(input: { category: string; path?: readonly string[] }): boolean {
  if (LANDSCAPE_SCALE.has(normalise(input.category))) return true;
  return (input.path ?? []).some((segment) => LANDSCAPE_SCALE.has(normalise(segment)));
}

/** Every leaf and branch the table knows. Used by tests, never by the pipeline. */
export function knownCategoryKeys(): { leaves: string[]; branches: string[] } {
  return { leaves: Object.keys(BY_CATEGORY), branches: Object.keys(BY_BRANCH) };
}
