import { evidencedInterests } from '@sidequest/core';
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
  /**
   * The type-truthful noun a card may print, where the archetype's is a lie.
   *
   * `category` is the *planning* vocabulary — thirteen persisted values that
   * decide duration, weather exposure and scheduling — and a river genuinely
   * plans like a lake. It does not *read* like one: a live board captioned the
   * Sumida River "Lake" and a railway "Viewpoint", which tells the traveller
   * the machine does not know what things are. So the display noun is carried
   * separately, from the source's own leaf, and the archetype keeps doing the
   * planning. Absent means the category label is already truthful.
   */
  displayKind?: string;
  /**
   * What a traveller can do here, and **not** simply what the rule wrote down.
   *
   * The rule's own list leads — it is the archetype's primary character, and
   * `interests[0]` is read downstream as exactly that — and everything
   * `INTEREST_EVIDENCE` recognises in the same three channels follows it. See
   * `interestsFor`: this field is a *read* of the intake's table, because the
   * alternative was two tables that disagreed.
   */
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
  /**
   * How much a thing of this kind tends to matter as an *experience*, 0–1.
   *
   * A class weight, not a claim about any particular place: a museum, a temple
   * or a major park is the reason somebody crosses a city; a pocket park or a
   * named slope is not, however completely a mapper described it. This is one
   * input to the significance model in `quality/significance.ts` — evidence
   * about the *kind* — and it deliberately cannot be moved by metadata volume,
   * which is the §8.3 failure it replaces.
   */
  significanceWeight: number;
  /**
   * True for kinds that are only travel candidates when something beyond the
   * category vouches for them: a bridge, a cemetery. Most bridges are how a
   * road crosses water; a few are why people visit a city. The category alone
   * cannot tell them apart, so the inventory demands significance evidence —
   * an open identifier, corroboration, a designation — before offering one.
   */
  requiresSignificanceEvidence: boolean;
  /**
   * True for kinds that enclose other mapped features behind one paid gate: a
   * theme park, a zoo, an aquarium. A record *inside* such an enclosure is part
   * of the attraction, not a free stop of its own — a live board offered an
   * island inside a theme park as a free easy walk to a traveller who had
   * excluded theme parks entirely.
   */
  paidEnclosure: boolean;
  /**
   * True for kinds whose claim is a large natural feature: a peak, a glacier.
   * A point record claiming to be a mountain, with no extent and no identity
   * evidence, is far more often a business named after one — the inventory
   * checks the claim before believing the coordinates.
   */
  landscapeClaim: boolean;
}

type Rule = Omit<
  TaxonomyClassification,
  | 'role'
  | 'subrole'
  | 'match'
  | 'displayKind'
  | 'significanceWeight'
  | 'requiresSignificanceEvidence'
  | 'paidEnclosure'
  | 'landscapeClaim'
> & {
  role?: PlanningRole;
  /** Omitted where `subroleFor` derives the obvious answer from role + category. */
  subrole?: TaxonomySubrole;
  displayKind?: string;
  /** Omitted where the archetype default below is right. */
  significanceWeight?: number;
  requiresSignificanceEvidence?: boolean;
  paidEnclosure?: boolean;
  landscapeClaim?: boolean;
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
  significanceWeight: 0.45,
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
  significanceWeight: 0.35,
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
  significanceWeight: 0.6,
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
  significanceWeight: 0.45,
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
  significanceWeight: 0.85,
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
  significanceWeight: 0.75,
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
  significanceWeight: 0.55,
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
  significanceWeight: 0.55,
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
  significanceWeight: 0.6,
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
  significanceWeight: 0.7,
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
  significanceWeight: 0.75,
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
  significanceWeight: 0.6,
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
  significanceWeight: 0.5,
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
  significanceWeight: 0.6,
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
  significanceWeight: 0.1,
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
  significanceWeight: 0,
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
  significanceWeight: 0,
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
  significanceWeight: 0.1,
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
  significanceWeight: 0.3,
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
  significanceWeight: 0.1,
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
  significanceWeight: 0,
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
  peak: { ...OUTDOOR_VIEW, typicalDurationMinutes: 60, displayKind: 'Peak', significanceWeight: 0.5, landscapeClaim: true },
  summit: { ...OUTDOOR_VIEW, typicalDurationMinutes: 60, displayKind: 'Peak', significanceWeight: 0.5, landscapeClaim: true },
  saddle: OUTDOOR_VIEW,
  ridge: OUTDOOR_VIEW,
  cliff: OUTDOOR_VIEW,
  volcano: { ...OUTDOOR_VIEW, typicalDurationMinutes: 120, displayKind: 'Volcano', significanceWeight: 0.7, landscapeClaim: true },

  // Walking, hiking, parks
  park: { ...WALK, category: 'easy_walk', typicalDurationMinutes: 90, significanceWeight: 0.4 },
  national_park: { ...HIKE, typicalDurationMinutes: 240, plausiblyGated: true, costLevel: 1, significanceWeight: 1 },
  state_park: { ...WALK, typicalDurationMinutes: 150, plausiblyGated: true, costLevel: 1, significanceWeight: 0.7 },
  nature_reserve: { ...WILDLIFE },
  nature_preserve: { ...WILDLIFE },
  protected_area: { ...WILDLIFE },
  botanical_garden: { ...WALK, costLevel: 2, plausiblyGated: true },
  garden: WALK,
  hiking_trail: HIKE,
  trail: HIKE,
  trailhead: { ...SUPPORT, subrole: 'visitor_information', category: 'day_hike', interests: ['hiking'], typicalDurationMinutes: 20 },
  forest: { ...WALK, displayKind: 'Forest', significanceWeight: 0.3 },
  /**
   * `wood` is a *land cover*, not a place somebody goes for a walk.
   *
   * It was folded into `forest`, and a live Tokyo board offered
   * 寛永寺墓地 — Kan'ei-ji Cemetery — as an easy nature walk on the strength of
   * it, which is §4's "a cemetery as an easy walk" verbatim. The cemetery leaf
   * below carries a significance gate for exactly this class, and the gate was
   * bypassed because the source published the land cover rather than the use.
   * Any patch of trees a mapper outlined arrives here: a verge, a screen
   * between two roads, the planting inside a burial ground. The ones worth
   * walking in are the ones something outside the record vouches for.
   */
  wood: { ...WALK, displayKind: 'Woodland', significanceWeight: 0.2, requiresSignificanceEvidence: true },
  valley: { ...OUTDOOR_VIEW, typicalDurationMinutes: 60, significanceWeight: 0.35 },
  hill: { ...OUTDOOR_VIEW, displayKind: 'Hill', significanceWeight: 0.2 },
  mountain_range: { ...OUTDOOR_VIEW, significanceWeight: 0.5, landscapeClaim: true },
  dune: WALK,
  cave: { ...HIKE, exposure: 'sheltered_outdoor', visibilityDependent: false, plausiblyGated: true, costLevel: 2 },
  cave_entrance: { ...HIKE, exposure: 'sheltered_outdoor', visibilityDependent: false },

  /**
   * Water, and every entry says what it is.
   *
   * The archetype is `WATER` throughout — a river plans exactly like a lake:
   * outdoor, free, weather-bound, an hour or two — but a card that captions the
   * Sumida River "Lake" has told the traveller the machine cannot see. The
   * display noun rides beside the archetype for every kind whose own name is
   * not "lake".
   */
  lake: WATER,
  reservoir: { ...WATER, displayKind: 'Reservoir', significanceWeight: 0.25 },
  river: { ...WATER, displayKind: 'River' },
  stream: { ...WATER, displayKind: 'Stream', significanceWeight: 0.15 },
  canal: { ...WATER, displayKind: 'Canal', significanceWeight: 0.35 },
  pond: { ...WATER, displayKind: 'Pond', significanceWeight: 0.2 },
  lagoon: { ...WATER, displayKind: 'Lagoon' },
  bay: { ...WATER, displayKind: 'Bay' },
  fjord: { ...WATER, visibilityDependent: true, displayKind: 'Fjord' },
  waterfall: { ...WATER, category: 'lake', typicalDurationMinutes: 60, displayKind: 'Waterfall', significanceWeight: 0.65 },
  beach: { ...WATER, category: 'lake', typicalDurationMinutes: 150, interests: ['lakes_and_rivers', 'scenic_viewpoints'], displayKind: 'Beach', significanceWeight: 0.6 },
  glacier: { ...OUTDOOR_VIEW, typicalDurationMinutes: 120, interests: ['geology_and_geothermal', 'scenic_viewpoints'], displayKind: 'Glacier', significanceWeight: 0.7, landscapeClaim: true },
  /**
   * A spring is where water comes out of the ground. Nothing about it is hot.
   *
   * It was mapped to the geothermal archetype, which stamped
   * `geology_and_geothermal` on it — so a traveller who asked for geysers and
   * lava fields was offered a suburban water spring as a match, and the card
   * read "A geothermal." The heated kinds keep the geothermal archetype and say
   * so in their own leaf; a plain spring is small water.
   */
  spring: { ...WATER, typicalDurationMinutes: 30, displayKind: 'Spring', significanceWeight: 0.25 },
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
  aquarium: { ...MUSEUM, interests: ['wildlife'], costLevel: 3, displayKind: 'Aquarium', paidEnclosure: true },
  zoo: { ...WILDLIFE, exposure: 'mixed', costLevel: 3, typicalDurationMinutes: 180, displayKind: 'Zoo', significanceWeight: 0.7, paidEnclosure: true },
  planetarium: MUSEUM,
  /**
   * A public library is a civic amenity that is *occasionally* a landmark.
   *
   * Filed as a museum it inherited "history and culture", two hours and a
   * ticket price, and a live Tokyo board offered two municipal library counters
   * — a returns desk inside a shopping centre — as things to do. The famous
   * ones are famous for their building or their collection, and something
   * outside the record always says so, which is what the gate reads.
   */
  library: { ...MUSEUM, costLevel: 0, typicalDurationMinutes: 45, displayKind: 'Library', significanceWeight: 0.4, requiresSignificanceEvidence: true },
  theatre: { ...MUSEUM, typicalDurationMinutes: 150, costLevel: 3 },
  concert_hall: { ...MUSEUM, typicalDurationMinutes: 150, costLevel: 3 },

  /**
   * THE STRUCTURAL CLAIM, AND WHY IT NEEDS A WITNESS.
   *
   * `historic_site` is not a kind of building. It is an *assertion about* a
   * building, and it is the assertion an open catalogue is least able to check
   * — every "former site of", every commemorative plaque, every named slope,
   * every block of flats standing where something used to be, arrives under it.
   * On a live Tokyo board the eighteen cards this leaf produced were six
   * condominiums (Aristage, Park Haim, Court House, Livest House, Corpo,
   * Crescent), a limited company's office, two roadside information signboards,
   * two road slopes and a demolished university campus, each offered as a
   * seventy-five-minute paid attraction.
   *
   * This is the same argument the bridge and the cemetery already carry, and it
   * is the *stronger* case of it: most records a source tags "historic site"
   * are a marker or a former use; a few are why people visit a city, and the
   * category alone cannot tell them apart. So the assertion needs a witness —
   * an encyclopaedic entry, a second catalogue, a public authority, a conferred
   * designation, or the region's own geography carrying the name.
   *
   * The named building kinds beneath it keep their unconditional admission,
   * because `castle`, `fort`, `ruins`, `monument` and `archaeological_site` all
   * say what the thing *is*. A mis-tag there is rare; here it is the norm.
   */
  historic_site: { ...HISTORIC, requiresSignificanceEvidence: true },
  historical_landmark: { ...HISTORIC, requiresSignificanceEvidence: true },
  archaeological_site: { ...HISTORIC, typicalDurationMinutes: 90, exposure: 'exposed_outdoor' },
  castle: { ...HISTORIC, typicalDurationMinutes: 120, costLevel: 2 },
  fort: HISTORIC,
  ruins: { ...HISTORIC, exposure: 'exposed_outdoor', costLevel: 0, plausiblyGated: false },
  monument: MONUMENT,
  memorial: { ...MONUMENT, typicalDurationMinutes: 40, plausiblyGated: false },
  landmark_and_historical_building: { ...HISTORIC, requiresSignificanceEvidence: true },

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
  church: { ...HISTORIC, typicalDurationMinutes: 45, exposure: 'indoor', poorWeatherBackup: true, significanceWeight: 0.5 },
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
  neighborhood: { ...TOWN, typicalDurationMinutes: 120, displayKind: 'Neighbourhood' },
  plaza: { ...TOWN, typicalDurationMinutes: 45, exposure: 'exposed_outdoor', poorWeatherBackup: false, plausiblyGated: false, displayKind: 'Plaza', significanceWeight: 0.3 },
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
  /**
   * Linear transport infrastructure is a way across, not a place to be — until
   * something vouches otherwise.
   *
   * A live board offered a working railway line as a "Viewpoint" because the
   * infrastructure layer files viaducts and rail under a branch this table read
   * as scenic. Most bridges are how a road crosses water; a few are why people
   * visit a city, and the *category* cannot tell them apart. So a bridge or
   * viaduct is a candidate only with significance evidence behind it — an open
   * identifier, cross-layer corroboration, a designation — and rail lines are
   * never candidates at all: a famous railway is a journey, not a stop.
   */
  bridge: { ...OUTDOOR_VIEW, typicalDurationMinutes: 30, displayKind: 'Bridge', significanceWeight: 0.5, requiresSignificanceEvidence: true },
  viaduct: { ...OUTDOOR_VIEW, typicalDurationMinutes: 30, displayKind: 'Viaduct', significanceWeight: 0.3, requiresSignificanceEvidence: true },
  railway: INFRASTRUCTURE,
  railway_line: INFRASTRUCTURE,
  rail_line: INFRASTRUCTURE,
  rail: INFRASTRUCTURE,
  subway_line: INFRASTRUCTURE,
  tram_line: INFRASTRUCTURE,
  level_crossing: INFRASTRUCTURE,
  railway_yard: INFRASTRUCTURE,
  pier: { ...OUTDOOR_VIEW, typicalDurationMinutes: 45, visibilityDependent: false, displayKind: 'Pier', significanceWeight: 0.4 },

  /**
   * A cemetery is a place of rest first and a sight second.
   *
   * A live board filed one under "Easy walk", which is both wrong in register
   * and wrong in kind. The famous ones — the resting places people genuinely
   * cross cities for — carry identity evidence, so the significance gate lets
   * exactly those through as cultural sites and keeps every neighbourhood
   * churchyard off the board.
   */
  cemetery: { ...HISTORIC, typicalDurationMinutes: 45, exposure: 'sheltered_outdoor', costLevel: 0, plausiblyGated: false, displayKind: 'Cemetery', significanceWeight: 0.45, requiresSignificanceEvidence: true },
  graveyard: { ...HISTORIC, typicalDurationMinutes: 45, exposure: 'sheltered_outdoor', costLevel: 0, plausiblyGated: false, displayKind: 'Cemetery', significanceWeight: 0.45, requiresSignificanceEvidence: true },

  /**
   * Paid enclosures: one gate, one ticket, everything inside is the attraction.
   *
   * A live board offered an island *inside* a theme park as a free easy walk —
   * to a traveller who had excluded theme parks. The enclosure kinds are named
   * so the inventory can fold their interior features into them.
   */
  theme_park: { ...TOWN, typicalDurationMinutes: 420, costLevel: 3, displayKind: 'Theme park', significanceWeight: 0.8, paidEnclosure: true },
  amusement_park: { ...TOWN, typicalDurationMinutes: 300, costLevel: 3, displayKind: 'Amusement park', significanceWeight: 0.7, paidEnclosure: true },
  water_park: { ...TOWN, typicalDurationMinutes: 300, costLevel: 3, displayKind: 'Water park', significanceWeight: 0.6, paidEnclosure: true },

  /**
   * Records that are not places at all: people, brands and the desks they work
   * from. A person and a private company both reached a live provisional board;
   * each is a database row about an entity, not somewhere a traveller can go.
   */
  person: { ...EXCLUDED, subrole: 'commerce' },
  company: { ...EXCLUDED, subrole: 'commerce' },
  corporation: { ...EXCLUDED, subrole: 'commerce' },
  office: { ...EXCLUDED, subrole: 'commerce' },
  corporate_office: { ...EXCLUDED, subrole: 'commerce' },
  headquarters: { ...EXCLUDED, subrole: 'commerce' },
  corporate_headquarters: { ...EXCLUDED, subrole: 'commerce' },
  coworking_space: { ...EXCLUDED, subrole: 'commerce' },

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

/**
 * A geographic feature whose own kind we do not recognise.
 *
 * The two geographic branches used to fall back to the *viewpoint* archetype,
 * which stamped `scenic_viewpoints` and `photography_golden_hour` on anything
 * underneath them and gave it the viewpoint's 0.45 class weight. A landfill
 * lookout, a drainage channel, a spoil mound and a road embankment therefore
 * all arrived as scenic highlights that satisfied a photography interest — and
 * on a live Tokyo run the highest-ordered card on the whole board was a
 * refuse-disposal site, because nothing had ever asked whether the view was a
 * claim anybody had made.
 *
 * The file's own stated rule is that an unrecognised branch resolves to
 * something honest rather than to an invention, and these two branches were
 * inventing a viewpoint. So an unrecognised geographic feature is outdoor
 * ground with no interest claim on it, a low class weight, and a requirement
 * that something outside the record vouch for it before it is offered. The
 * recognised leaves above — peak, lake, waterfall, beach, viewpoint — are
 * unaffected, because they matched before the branch was consulted.
 */
const UNRECOGNISED_GEOGRAPHY: Rule = {
  subrole: 'outdoor_nature',
  category: 'easy_walk',
  /*
   * Not empty: `interests[0]` is read downstream as the archetype's primary
   * character. `easy_nature_walks` is what "some outdoor ground" honestly
   * offers, and it is the one claim that does not depend on the view, the
   * geology or the water being anything in particular.
   */
  interests: ['easy_nature_walks'],
  typicalDurationMinutes: 45,
  physicalIntensity: 'easy',
  exposure: 'exposed_outdoor',
  visibilityDependent: false,
  poorWeatherBackup: false,
  costLevel: 0,
  significanceWeight: 0.15,
  plausiblyGated: false,
  requiresSignificanceEvidence: true,
};

const BY_BRANCH: Record<string, Rule> = {
  attractions_and_activities: { ...HISTORIC, role: 'attraction' },
  arts_and_entertainment: { ...MUSEUM, role: 'attraction' },
  cultural_and_historic: { ...HISTORIC, role: 'attraction' },
  geographic_entities: { ...UNRECOGNISED_GEOGRAPHY, role: 'attraction' },
  sports_and_recreation: { ...WALK, role: 'attraction' },
  active_life: { ...WALK, role: 'attraction' },
  natural_features: { ...UNRECOGNISED_GEOGRAPHY, role: 'attraction' },

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
  if (direct) return finalise(direct, { kind: 'source_leaf_category', key: leaf }, leaf);

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
    if (bySegment) return finalise(bySegment, { kind: 'source_category_path', key: segment }, leaf);
    const byBranch = BY_BRANCH[segment];
    if (byBranch) return finalise(byBranch, { kind: 'source_branch', key: segment }, leaf);
  }

  const branch = BY_BRANCH[leaf];
  if (branch) return finalise(branch, { kind: 'source_branch', key: leaf }, leaf);

  /**
   * Unknown, and therefore excluded rather than promoted.
   *
   * The record stays in the pack — it may be linked to, contained by, or wanted
   * later — but it does not enter the attraction inventory on the strength of
   * nobody knowing what it is.
   */
  return finalise(EXCLUDED, { kind: 'no_recognised_category' }, leaf);
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

/**
 * WHAT THIS KIND OF THING LETS A TRAVELLER DO — READ FROM THE INTAKE'S TABLE.
 *
 * This used to be `rule.interests` verbatim, and that is the §4 regression class
 * wearing new clothes. Two tables answered "which interest does this kind of
 * place serve": `INTEREST_EVIDENCE` in the core's intake decided which rows a
 * destination is *offered*, and the hand-written column above decided what a
 * place *claims*. Nothing held them together, and they came apart on the whole
 * built-and-inhabited half of the vocabulary — every compiled region offered
 * museums, architecture or markets as graded rows while not one of its places
 * carried them. A traveller who marked museums `core` in a city full of museums
 * had every museum scored as though they had answered "only if it is right
 * there", and their frequency allowance for the thing they came for went unspent.
 *
 * So the stamper reads the offer's own table rather than restating it, over the
 * same three channels a compiled place will later present to it: the planning
 * category, the display noun, and the source's own leaf category — which the
 * inventory writes as the place's first tag. Anything the intake would accept as
 * evidence from that place is therefore stamped on it, and the two halves cannot
 * drift apart again without `interest-parity.test.ts` failing.
 *
 * The rule's own list still leads. It is the archetype's primary character, and
 * `interests[0]` is read as that by the planner's frequency ledger and by the
 * board's fallback for a place whose fit named no interest.
 */
function interestsFor(rule: Rule, sourceCategory: string): Interest[] {
  const evidenced = evidencedInterests({
    category: rule.category,
    ...(rule.displayKind === undefined ? {} : { displayKind: rule.displayKind }),
    interests: rule.interests,
    sourceCategories: [sourceCategory],
  });
  return [
    ...rule.interests,
    ...evidenced.filter((interest) => !rule.interests.includes(interest)),
  ];
}

function finalise(
  rule: Rule,
  match: TaxonomyMatch,
  /** The source's own leaf, normalised — the word the place will carry as a tag. */
  sourceCategory: string,
): TaxonomyClassification {
  const role = roleFor(rule);
  const visitable = role === 'attraction' || role === 'outdoor' || role === 'side_quest' || role === 'market';
  return {
    role,
    subrole: subroleFor(rule, role),
    match,
    category: rule.category,
    ...(rule.displayKind ? { displayKind: rule.displayKind } : {}),
    interests: interestsFor(rule, sourceCategory),
    typicalDurationMinutes: rule.typicalDurationMinutes,
    physicalIntensity: rule.physicalIntensity,
    exposure: rule.exposure,
    visibilityDependent: rule.visibilityDependent,
    poorWeatherBackup: rule.poorWeatherBackup,
    costLevel: rule.costLevel,
    plausiblyGated: rule.plausiblyGated,
    /*
     * A visitable kind nobody weighted sits at 0.3 — real, minor. A utility
     * kind sits at zero, because "how significant is this pylon as an
     * experience" has one answer.
     */
    significanceWeight: rule.significanceWeight ?? (visitable ? 0.3 : 0),
    requiresSignificanceEvidence: rule.requiresSignificanceEvidence ?? false,
    paidEnclosure: rule.paidEnclosure ?? false,
    landscapeClaim: rule.landscapeClaim ?? false,
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
