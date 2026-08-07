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

/**
 * The archetype a category resolved to, one level finer than `PlanningRole`.
 *
 * `PlanningRole` is the *pack's* vocabulary: eleven values, persisted on every
 * record of every region pack ever built, and deliberately coarse because a pack
 * is immutable and a vocabulary you cannot revise is a vocabulary you keep
 * small. It answers "may this be planned around", and for that it is enough.
 *
 * It is not enough to answer "what kind of thing is this", and the gap is where
 * a live Bali compilation put an airport and a driver-for-hire on the Discovery
 * Board. Both classify correctly — `gateway` and `support` — and both are
 * correct *pack* answers: a gateway anchors a region and a support stop serves a
 * day, so neither may be thrown away. What was missing is that `support` covers
 * a grocery, a visitor centre, a shopping centre and a chauffeur service, and
 * only some of those are things a traveller should be offered.
 *
 * So the subrole is computed here, alongside the role, from the same table and
 * the same evidence — and it is **derived, never persisted**. It does not appear
 * in `sourceRecordSchema`, no pack has to be rebuilt to gain it, and revising it
 * costs a table edit rather than a migration. `eligibility.ts` reads it.
 *
 * Every value is a *kind of thing*, from somebody else's global vocabulary.
 * None is a name, a place or a destination.
 */
export type TaxonomySubrole =
  // Things to visit
  /** Museums, historic buildings, monuments: the indoor-and-built half. */
  | 'cultural'
  /** Viewpoints, scenic routes, ways up: worth it for what you can see. */
  | 'scenic'
  /** Trails, water, terrain, wildlife: weather-, season- and daylight-bound. */
  | 'outdoor_nature'
  /** A neighbourhood, a square, a town centre: somewhere rather than something. */
  | 'urban_place'
  /** Somewhere to eat *and* a thing to do. Deliberately both. */
  | 'market'
  // Things that make a day work
  /** A meal: restaurants, cafés, bakeries, bars, food halls. */
  | 'food_service'
  /** Somewhere to sleep. */
  | 'lodging'
  | 'gateway_air'
  | 'gateway_rail'
  | 'gateway_road'
  | 'gateway_water'
  /**
   * Sold movement, not a place: taxis, drivers for hire, transfers, car hire,
   * tour operators, travel agents.
   *
   * Its own subrole because this is the class the live defect came from. Under
   * the pack's vocabulary a chauffeur service and a grocery are both `support`,
   * and one of those is a stop.
   */
  | 'ground_transport'
  /** Where a vehicle waits. Infrastructure, not a stop. */
  | 'parking'
  /** Where a traveller stocks up: groceries, convenience, delis. */
  | 'provisioning'
  /** Visitor centres, information points, trailheads. */
  | 'visitor_information'
  /** Community and government premises, and congregations. */
  | 'civic'
  /** Practical and none of the above: pharmacy, fuel, campground. */
  | 'support_service'
  // Things that are not travel
  /** A business. Real, mapped, and not a reason to go anywhere. */
  | 'commerce'
  /** Built, real, never scheduled: pylons, pipelines, substations. */
  | 'utility'
  /** Benches, crossings, cash machines, bus stops. */
  | 'street_furniture'
  /** Nobody published a category we recognise. */
  | 'unclassified';

/**
 * How the source's own vocabulary was matched, so a caller can weigh it.
 *
 * A leaf match is the source naming exactly what this is. A branch match is the
 * source naming the family and us inferring the rest. The two deserve different
 * confidence and, until now, were indistinguishable in the output.
 */
export type TaxonomyMatch =
  | { kind: 'source_leaf_category'; key: string }
  | { kind: 'source_category_path'; key: string }
  | { kind: 'source_branch'; key: string }
  | { kind: 'no_recognised_category' };

export interface TaxonomyClassification {
  role: PlanningRole;
  /** The finer archetype. Derived, never persisted. See `TaxonomySubrole`. */
  subrole: TaxonomySubrole;
  /** Which key matched, and how. Never a name. */
  match: TaxonomyMatch;
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

type Rule = Omit<TaxonomyClassification, 'role' | 'subrole' | 'match'> & {
  role?: PlanningRole;
  /** Omitted where `subroleFor` derives the obvious answer from role + category. */
  subrole?: TaxonomySubrole;
};

const OUTDOOR_VIEW: Rule = {
  subrole: 'scenic',
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
  subrole: 'outdoor_nature',
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
  subrole: 'outdoor_nature',
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
  subrole: 'outdoor_nature',
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
  subrole: 'cultural',
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
  subrole: 'cultural',
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
  subrole: 'urban_place',
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
  subrole: 'outdoor_nature',
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
  subrole: 'outdoor_nature',
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
  subrole: 'scenic',
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
  subrole: 'cultural',
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
  subrole: 'outdoor_nature',
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
  subrole: 'scenic',
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

/**
 * A market: somewhere to eat and a thing to do, and neither on its own.
 *
 * Its own archetype because the two obvious homes both lose it. Filed under
 * food it never reaches the Discovery Board, so a traveller who came for
 * markets is never offered one. Filed under attractions it never reaches a
 * meal, so the food planner walks them past it to a restaurant. The role split
 * is the only representation that lets both layers see it.
 */
const MARKET: Rule = {
  role: 'market',
  subrole: 'market',
  category: 'town_and_food',
  interests: ['food_and_towns', 'history_and_culture'],
  typicalDurationMinutes: 75,
  physicalIntensity: 'easy',
  exposure: 'mixed',
  visibilityDependent: false,
  poorWeatherBackup: true,
  costLevel: 1,
  plausiblyGated: true,
};

/**
 * How you arrive, and where a base goes.
 *
 * Split from `support` because a gateway anchors a *region* while a support
 * stop serves a *day*. The base portfolio reads these to decide where a trip
 * can start; a day plan must never schedule one.
 */
const GATEWAY: Rule = {
  role: 'gateway',
  subrole: 'gateway_road',
  category: 'town_and_food',
  interests: ['food_and_towns'],
  typicalDurationMinutes: 20,
  physicalIntensity: 'none',
  exposure: 'mixed',
  visibilityDependent: false,
  poorWeatherBackup: true,
  costLevel: 1,
  plausiblyGated: true,
};

/**
 * Mapped, real, and never scheduled.
 *
 * Distinguished from `excluded` because the two answer different questions.
 * `excluded` means "this is not a place a traveller plans around" — a bank, a
 * bench, a crossing. `infrastructure` means "this is real built geography that
 * something later may legitimately want" — a substation, a pipeline, a
 * wastewater plant. Keeping them apart costs one enum value and means a future
 * layer that needs to know where the power lines are does not have to re-read
 * the catalogue to find out.
 */
const INFRASTRUCTURE: Rule = {
  role: 'infrastructure',
  subrole: 'utility',
  category: 'town_and_food',
  interests: ['food_and_towns'],
  typicalDurationMinutes: 15,
  physicalIntensity: 'none',
  exposure: 'mixed',
  visibilityDependent: false,
  poorWeatherBackup: false,
  costLevel: 0,
  plausiblyGated: false,
};

/**
 * Movement sold as a service: a driver, a transfer, a hire car, a tour desk.
 *
 * `support` at the pack level, deliberately, so nothing about how existing packs
 * are read changes — but a subrole of its own, because "grocery" and "chauffeur"
 * being the same word is precisely what put a driver-for-hire on a Discovery
 * Board. A traveller without a car may need one of these; none of them is a
 * place to go.
 */
const TRANSPORT_SERVICE: Rule = {
  role: 'support',
  subrole: 'ground_transport',
  category: 'town_and_food',
  interests: ['food_and_towns'],
  typicalDurationMinutes: 20,
  physicalIntensity: 'none',
  exposure: 'mixed',
  visibilityDependent: false,
  poorWeatherBackup: false,
  costLevel: 2,
  plausiblyGated: true,
};

/** A real, mapped, useful thing that is not a reason to plan a day. */
const SUPPORT: Rule = {
  role: 'support',
  subrole: 'support_service',
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
  subrole: 'food_service',
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
  subrole: 'lodging',
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
  subrole: 'unclassified',
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
 * Mapped street furniture: real, useful to somebody, never a stop.
 *
 * Split from `EXCLUDED` only by subrole. `excluded` now covers two genuinely
 * different refusals — "this is a bench" and "nobody published a category we
 * recognise" — and telling them apart is what lets a coverage report say whether
 * a thin region is thin or merely badly catalogued.
 */
const STREET_FURNITURE: Rule = { ...EXCLUDED, subrole: 'street_furniture' };

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
  trailhead: { ...SUPPORT, subrole: 'visitor_information', category: 'day_hike', interests: ['hiking'], typicalDurationMinutes: 20 },
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
  memorial: { ...MONUMENT, typicalDurationMinutes: 40, plausiblyGated: false },
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
  place_of_worship: { ...SUPPORT, subrole: 'civic', typicalDurationMinutes: 40, exposure: 'indoor' },
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
  market: MARKET,
  marketplace: MARKET,
  farmers_market: { ...MARKET, typicalDurationMinutes: 60 },
  public_market: MARKET,
  bazaar: MARKET,
  night_market: MARKET,
  flea_market: { ...MARKET, typicalDurationMinutes: 60 },
  neighborhood: { ...TOWN, typicalDurationMinutes: 120 },
  plaza: { ...TOWN, typicalDurationMinutes: 45, exposure: 'exposed_outdoor', poorWeatherBackup: false, plausiblyGated: false },
  /**
   * `pedestrian` is a container, not a destination.
   *
   * It was mapped to a town-and-food stop, and in the infrastructure layer it is
   * the *subtype* every cash machine, bench and crossing sits under — so a live
   * Bali run put eleven bank ATMs on the board. The word means "reached on
   * foot", not "worth walking to".
   */
  pedestrian: STREET_FURNITURE,

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
  food_hall: { ...MARKET, typicalDurationMinutes: 60 },
  bar: FOOD,
  pub: FOOD,
  ice_cream_shop: { ...FOOD, typicalDurationMinutes: 20 },
  deli: { ...SUPPORT, subrole: 'provisioning', typicalDurationMinutes: 20 },

  // Lodging, by leaf, for the same reason.
  hotel: LODGING,
  hostel: LODGING,
  motel: LODGING,
  guest_house: LODGING,
  resort: LODGING,
  bed_and_breakfast: LODGING,

  // Support: real, useful, and not a day's plan
  /**
   * A visitor centre is where you ask about the thing, not the thing.
   *
   * Support, and it stays support however completely somebody catalogued it —
   * a national park's visitor centre carries a site, posted hours, an operator
   * and an open identifier, which is more published evidence than most museums
   * have. `eligibility.ts` is where that promotion is refused; here it is only
   * named accurately. A visitor centre that is *also* an attraction says so by
   * publishing a different category, and then a different leaf matches.
   */
  visitor_center: { ...SUPPORT, subrole: 'visitor_information', typicalDurationMinutes: 30 },
  information: { ...SUPPORT, subrole: 'visitor_information', typicalDurationMinutes: 20 },
  ferry_terminal: { ...GATEWAY, subrole: 'gateway_water' },
  ferry: { ...GATEWAY, subrole: 'gateway_water' },
  harbor: { ...GATEWAY, subrole: 'gateway_water', typicalDurationMinutes: 30 },
  marina: { ...GATEWAY, subrole: 'gateway_water', typicalDurationMinutes: 30 },
  train_station: { ...GATEWAY, subrole: 'gateway_rail' },
  railway_station: { ...GATEWAY, subrole: 'gateway_rail' },
  bus_station: { ...GATEWAY, subrole: 'gateway_road' },
  /**
   * An airport is how you arrive. It is never a viewpoint.
   *
   * A live Bali compilation ranked an international airport as a travel
   * candidate, and the reason it outranked real ones is instructive: an airport
   * is the single most completely catalogued record in most regions — site,
   * hours, operator, open identifier, several contributors — and the inventory's
   * ordering is a measure of how much is known. So the defence cannot be a
   * score. It is that `gateway_air` is not eligible for the board at all, no
   * matter what is known about it and no matter what the traveller likes.
   */
  airport: { ...GATEWAY, subrole: 'gateway_air' },
  international_airport: { ...GATEWAY, subrole: 'gateway_air' },
  parking: { ...SUPPORT, subrole: 'parking', typicalDurationMinutes: 15 },
  campground: { ...SUPPORT, subrole: 'support_service', typicalDurationMinutes: 30 },
  supermarket: { ...SUPPORT, subrole: 'provisioning', typicalDurationMinutes: 25 },
  grocery_store: { ...SUPPORT, subrole: 'provisioning', typicalDurationMinutes: 25 },
  convenience_store: { ...SUPPORT, subrole: 'provisioning', typicalDurationMinutes: 15 },
  pharmacy: { ...SUPPORT, subrole: 'support_service', typicalDurationMinutes: 15 },
  gas_station: { ...SUPPORT, subrole: 'support_service', typicalDurationMinutes: 15 },

  /**
   * Movement somebody sells you, filed by leaf so it is never a support stop.
   *
   * These are the records behind the second half of the live Bali defect: a
   * driver-for-hire and a tour agency, both ranked as travel candidates. They
   * are real, they are useful, and a traveller without a car may genuinely need
   * one — which is why they stay in the inventory as transport rather than being
   * excluded. What they are not is somewhere to go.
   *
   * `TRANSPORT_SERVICE` keeps the pack role `support` so no pack's stored role
   * changes meaning; the subrole is what `eligibility.ts` reads to keep them off
   * the board. Every key is a service word from a global business vocabulary.
   */
  taxi: TRANSPORT_SERVICE,
  taxi_service: TRANSPORT_SERVICE,
  taxi_stand: TRANSPORT_SERVICE,
  rideshare: TRANSPORT_SERVICE,
  chauffeur_service: TRANSPORT_SERVICE,
  limousine_service: TRANSPORT_SERVICE,
  limo_service: TRANSPORT_SERVICE,
  shuttle_service: TRANSPORT_SERVICE,
  airport_shuttle_service: TRANSPORT_SERVICE,
  car_rental: TRANSPORT_SERVICE,
  car_rental_agency: TRANSPORT_SERVICE,
  rental_car_agency: TRANSPORT_SERVICE,
  motorcycle_rental: TRANSPORT_SERVICE,
  scooter_rental: TRANSPORT_SERVICE,
  bicycle_rental: TRANSPORT_SERVICE,
  travel_agency: TRANSPORT_SERVICE,
  travel_agent: TRANSPORT_SERVICE,
  travel_services: TRANSPORT_SERVICE,
  tour_agency: TRANSPORT_SERVICE,
  tour_operator: TRANSPORT_SERVICE,
  tour_provider: TRANSPORT_SERVICE,
  transportation_service: TRANSPORT_SERVICE,
  private_transfer_service: TRANSPORT_SERVICE,
  driving_service: TRANSPORT_SERVICE,

  /**
   * Mapped street furniture. Real, useful to somebody, and never a stop.
   *
   * Named rather than left to the unknown-category fallback because each of
   * these arrives under a *known* container subtype, so the fallback would never
   * see them. Every entry is a word from an open geographic vocabulary; none is
   * a place.
   */
  atm: STREET_FURNITURE,
  bank: STREET_FURNITURE,
  bench: STREET_FURNITURE,
  crossing: STREET_FURNITURE,
  traffic_signals: STREET_FURNITURE,
  bicycle_parking: STREET_FURNITURE,
  waste_basket: STREET_FURNITURE,
  drinking_water: STREET_FURNITURE,
  toilets: STREET_FURNITURE,
  post_box: STREET_FURNITURE,
  telephone: STREET_FURNITURE,
  bus_stop: STREET_FURNITURE,
  street_lamp: STREET_FURNITURE,
  fire_hydrant: STREET_FURNITURE,
  utility: INFRASTRUCTURE,
  power: INFRASTRUCTURE,
  communication: INFRASTRUCTURE,
  barrier: INFRASTRUCTURE,
  manhole: INFRASTRUCTURE,
  pipeline: INFRASTRUCTURE,
  storage_tank: INFRASTRUCTURE,
  wastewater_plant: INFRASTRUCTURE,
  substation: INFRASTRUCTURE,
  /*
   * Places somebody uses because they *live* there, not because they travelled.
   *
   * A live Bali board carried a gym and an arcade chain as attractions, both
   * inherited from the `active_life` / `arts_and_entertainment` branches, which
   * are otherwise correct — a climbing crag and a concert hall belong there. The
   * leaves below are the ones whose whole purpose is a local amenity, and the
   * distinction is not how well catalogued they are: a gym with a website, hours
   * and an operator is still a gym.
   *
   * Leaves rather than a branch, so nothing legitimate underneath those branches
   * is caught with them.
   */
  gym: { ...EXCLUDED, subrole: 'commerce' },
  fitness_center: { ...EXCLUDED, subrole: 'commerce' },
  fitness_centre: { ...EXCLUDED, subrole: 'commerce' },
  amusement_arcade: { ...EXCLUDED, subrole: 'commerce' },
  arcade: { ...EXCLUDED, subrole: 'commerce' },
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
  nightlife_venue: { ...EXCLUDED, subrole: 'commerce' },
  gaming_venue: { ...EXCLUDED, subrole: 'commerce' },
  music_venue: { ...EXCLUDED, subrole: 'commerce' },
  religious_organization: { ...SUPPORT, subrole: 'civic', typicalDurationMinutes: 40, exposure: 'indoor' },

  food_and_drink: FOOD,
  eat_and_drink: FOOD,
  restaurants: FOOD,

  lodging: LODGING,
  accommodation: LODGING,

  /**
   * The travel branch defaults to *transport*, not to a support stop.
   *
   * Its named leaves — airports, terminals, stations — match above and become
   * gateways. What is left under it is overwhelmingly somebody selling movement:
   * drivers, transfers, agencies, hire desks. A live Bali compilation is the
   * evidence; the branch was `support`, `support` reached the board, and a
   * driver-for-hire was offered as a thing to do.
   *
   * The pack role is unchanged — this is still `support` — so no stored record
   * changes meaning. The subrole is what stops it being a card.
   */
  travel_and_transportation: TRANSPORT_SERVICE,
  /**
   * Shops are commerce, however useful. A shopping centre is not a side quest,
   * and the reason it kept looking like one is that a mall is richly catalogued.
   */
  shopping: { ...SUPPORT, subrole: 'commerce' },
  community_and_government: { ...SUPPORT, subrole: 'civic' },

  services_and_business: { ...EXCLUDED, subrole: 'commerce' },
  business_to_business: { ...EXCLUDED, subrole: 'commerce' },
  professional_services: { ...EXCLUDED, subrole: 'commerce' },
  lifestyle_services: { ...EXCLUDED, subrole: 'commerce' },
  health_care: { ...EXCLUDED, subrole: 'commerce' },
  health_and_medical: { ...EXCLUDED, subrole: 'commerce' },
  education: { ...EXCLUDED, subrole: 'civic' },
  financial_service: { ...EXCLUDED, subrole: 'commerce' },
  automotive: { ...EXCLUDED, subrole: 'commerce' },
  real_estate: { ...EXCLUDED, subrole: 'commerce' },
  mass_media: { ...EXCLUDED, subrole: 'commerce' },
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
  if (direct) return finalise(direct, { kind: 'source_leaf_category', key: leaf });

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
    if (bySegment) return finalise(bySegment, { kind: 'source_category_path', key: segment });
    const byBranch = BY_BRANCH[segment];
    if (byBranch) return finalise(byBranch, { kind: 'source_branch', key: segment });
  }

  const branch = BY_BRANCH[leaf];
  if (branch) return finalise(branch, { kind: 'source_branch', key: leaf });

  /**
   * Unknown, and therefore excluded rather than promoted.
   *
   * The record stays in the pack — it may be linked to, contained by, or wanted
   * later — but it does not enter the attraction inventory on the strength of
   * nobody knowing what it is.
   */
  return finalise(EXCLUDED, { kind: 'no_recognised_category' });
}

/**
 * Categories whose enjoyment turns on the weather, the season and the light.
 *
 * The list is the *whole* outdoor half of `PLACE_CATEGORIES`, so it is total by
 * construction rather than by curation: adding a category to that enum and
 * forgetting it here is a type error, not a silent misclassification.
 */
const OUTDOOR_CATEGORIES: readonly PlaceCategory[] = [
  'viewpoint',
  'day_hike',
  'easy_walk',
  'lake',
  'scenic_drive',
  'geothermal',
  'hot_spring',
  'wildlife_area',
];

/**
 * Under this, a stop is a stop rather than a morning.
 *
 * Forty-five minutes is where a thing stops being able to anchor a day. Paired
 * with "nobody sells a ticket for it", because the two together are what
 * separate a memorial from a museum without anybody naming either — a gated
 * forty-minute place still needs a slot, an opening time and a plan, and a
 * plaza does not.
 */
const SIDE_QUEST_MINUTES = 45;

/**
 * The role, when the rule did not name one.
 *
 * This used to be `rule.role ?? 'attraction'`, and that single fallback is
 * what made the whole inventory one bucket: every outdoor archetype, every
 * museum and every historic building arrived as the same kind of thing, so the
 * only way to rank them was by how richly somebody had catalogued them — which
 * is a measurement of commercial mapping density and was being read as a
 * measurement of what there is to do.
 *
 * Outdoor wins over side-quest when both would fire, because weather- and
 * season-boundness is the property the rest of the pipeline actually acts on: a
 * viewpoint is a short stop *and* it is worthless in cloud, and only the second
 * of those changes a plan.
 */
function roleFor(rule: Rule): PlanningRole {
  if (rule.role) return rule.role;
  if (OUTDOOR_CATEGORIES.includes(rule.category)) return 'outdoor';
  if (rule.typicalDurationMinutes <= SIDE_QUEST_MINUTES && !rule.plausiblyGated) {
    return 'side_quest';
  }
  return 'attraction';
}

/**
 * The archetype, when the rule did not name one.
 *
 * Derived from the role and the category rather than defaulted to a single
 * value, because a default would put a museum, a plaza and a substation in one
 * bucket — which is the exact shape of the mistake `roleFor` used to make one
 * level up. Every branch here is reachable from the table above; the final
 * `unclassified` is the honest answer for a rule we did not annotate and whose
 * role tells us nothing finer.
 */
function subroleFor(rule: Rule, role: PlanningRole): TaxonomySubrole {
  if (rule.subrole) return rule.subrole;
  switch (role) {
    case 'market':
      return 'market';
    case 'food':
      return 'food_service';
    case 'lodging':
      return 'lodging';
    case 'gateway':
      return 'gateway_road';
    case 'support':
      return 'support_service';
    case 'infrastructure':
      return 'utility';
    case 'administrative':
      return 'civic';
    case 'excluded':
      return 'unclassified';
    default:
      break;
  }
  if (SCENIC_CATEGORIES.includes(rule.category)) return 'scenic';
  if (OUTDOOR_CATEGORIES.includes(rule.category)) return 'outdoor_nature';
  if (rule.category === 'town_and_food') return 'urban_place';
  return 'cultural';
}

/**
 * The outdoor categories whose point is the view rather than the ground.
 *
 * Separate from `OUTDOOR_CATEGORIES` because the two answer different
 * questions and only one of them is about the weather. A viewpoint and a trail
 * are both weather-bound — that is what `OUTDOOR_CATEGORIES` is for — but a
 * viewpoint is a fifteen-minute stop for a horizon and a trail is a morning of
 * walking, and a traveller choosing between them is not choosing between two of
 * the same thing.
 */
const SCENIC_CATEGORIES: readonly PlaceCategory[] = [
  'viewpoint',
  'scenic_drive',
  'gondola_or_tram',
];

function finalise(rule: Rule, match: TaxonomyMatch): TaxonomyClassification {
  const role = roleFor(rule);
  return {
    role,
    subrole: subroleFor(rule, role),
    match,
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
