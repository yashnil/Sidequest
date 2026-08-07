import { describe, expect, it } from 'vitest';
import type { SourceRecord } from '@sidequest/core';
import {
  assessRecordEligibility,
  assessRoleEligibility,
  ATTRACTION_ROLES,
  CANDIDATE_ROLES,
  ELIGIBILITY_SLOTS,
  isAttractionRole,
  isFoodRole,
  isRejectedRole,
  planningRoleOf,
  ROLE_PERMISSIONS,
  type CandidateRole,
} from './eligibility';
import { knownCategoryKeys } from './taxonomy';

/**
 * THE COMPLETE VOCABULARY, ASSERTED ROW BY ROW.
 *
 * Every leaf and every branch `taxonomy.ts` knows, with the role it resolves to.
 * Written out rather than derived, because a test that recomputes the answer the
 * same way the code does asserts only that the code is deterministic — which was
 * never in doubt and was never the defect.
 *
 * A new category cannot be added to the taxonomy without a row here: the totality
 * check below fails on an unlisted key, and a role change fails on the value. The
 * point is that a well-meaning edit that quietly makes an airport visitable is a
 * red test rather than a live compilation.
 *
 * This table walks one axis — *which role does each published word land on*. The
 * other axis, *what is each role allowed to do*, is `role-coverage.test.ts`: a
 * table total over `CANDIDATE_ROLES` rather than over the vocabulary, because six
 * roles are reachable from no word at all and a category-driven table cannot see
 * them.
 */
const EXPECTED_ROLE: Record<string, CandidateRole> = {
  viewpoint: 'scenic',
  scenic_lookout: 'scenic',
  observation_deck: 'scenic',
  scenic_point_of_interest: 'scenic',
  peak: 'scenic',
  summit: 'scenic',
  saddle: 'scenic',
  ridge: 'scenic',
  cliff: 'scenic',
  volcano: 'scenic',
  park: 'outdoor',
  national_park: 'outdoor',
  state_park: 'outdoor',
  nature_reserve: 'outdoor',
  nature_preserve: 'outdoor',
  protected_area: 'outdoor',
  botanical_garden: 'outdoor',
  garden: 'outdoor',
  hiking_trail: 'outdoor',
  trail: 'outdoor',
  trailhead: 'support_stop',
  forest: 'outdoor',
  valley: 'scenic',
  hill: 'scenic',
  mountain_range: 'scenic',
  dune: 'outdoor',
  cave: 'outdoor',
  cave_entrance: 'outdoor',
  lake: 'outdoor',
  reservoir: 'outdoor',
  river: 'outdoor',
  pond: 'outdoor',
  lagoon: 'outdoor',
  bay: 'outdoor',
  fjord: 'outdoor',
  waterfall: 'outdoor',
  beach: 'outdoor',
  glacier: 'scenic',
  spring: 'outdoor',
  hot_spring: 'outdoor',
  geyser: 'outdoor',
  fumarole: 'outdoor',
  museum: 'itinerary_anchor',
  art_museum: 'itinerary_anchor',
  history_museum: 'itinerary_anchor',
  science_museum: 'itinerary_anchor',
  art_gallery: 'cultural',
  gallery: 'cultural',
  aquarium: 'itinerary_anchor',
  zoo: 'outdoor',
  planetarium: 'itinerary_anchor',
  library: 'cultural',
  theatre: 'itinerary_anchor',
  concert_hall: 'itinerary_anchor',
  historic_site: 'cultural',
  historical_landmark: 'cultural',
  archaeological_site: 'cultural',
  castle: 'itinerary_anchor',
  fort: 'cultural',
  ruins: 'cultural',
  monument: 'cultural',
  memorial: 'side_quest',
  landmark_and_historical_building: 'cultural',
  place_of_worship: 'support_stop',
  church: 'cultural',
  cathedral: 'cultural',
  basilica: 'cultural',
  abbey: 'cultural',
  monastery: 'cultural',
  temple: 'cultural',
  hindu_temple: 'cultural',
  buddhist_temple: 'cultural',
  taoist_temple: 'cultural',
  sikh_temple: 'cultural',
  mosque: 'cultural',
  shrine: 'cultural',
  shinto_shrine: 'cultural',
  synagogue: 'cultural',
  cable_car: 'scenic',
  aerial_lift: 'scenic',
  gondola: 'scenic',
  funicular: 'scenic',
  ski_resort: 'itinerary_anchor',
  market: 'market',
  marketplace: 'market',
  farmers_market: 'market',
  public_market: 'market',
  bazaar: 'market',
  night_market: 'market',
  flea_market: 'market',
  neighborhood: 'itinerary_anchor',
  plaza: 'side_quest',
  pedestrian: 'insufficient_travel_value',
  scenic_drive: 'scenic',
  scenic_byway: 'scenic',
  bridge: 'scenic',
  pier: 'scenic',
  restaurant: 'food',
  cafe: 'food',
  coffee_shop: 'food',
  bakery: 'food',
  fast_food: 'food',
  food_court: 'food',
  food_hall: 'market',
  bar: 'food',
  pub: 'food',
  ice_cream_shop: 'food',
  deli: 'food_support',
  hotel: 'lodging_support',
  hostel: 'lodging_support',
  motel: 'lodging_support',
  guest_house: 'lodging_support',
  resort: 'lodging_support',
  bed_and_breakfast: 'lodging_support',
  visitor_center: 'support_stop',
  information: 'support_stop',
  ferry_terminal: 'gateway',
  ferry: 'gateway',
  harbor: 'gateway',
  marina: 'gateway',
  train_station: 'gateway',
  railway_station: 'gateway',
  bus_station: 'gateway',
  airport: 'gateway',
  international_airport: 'gateway',
  parking: 'infrastructure',
  campground: 'support_stop',
  supermarket: 'food_support',
  grocery_store: 'food_support',
  convenience_store: 'food_support',
  pharmacy: 'support_stop',
  gas_station: 'support_stop',
  taxi: 'transport',
  taxi_service: 'transport',
  taxi_stand: 'transport',
  rideshare: 'transport',
  chauffeur_service: 'transport',
  limousine_service: 'transport',
  limo_service: 'transport',
  shuttle_service: 'transport',
  airport_shuttle_service: 'transport',
  car_rental: 'transport',
  car_rental_agency: 'transport',
  rental_car_agency: 'transport',
  motorcycle_rental: 'transport',
  scooter_rental: 'transport',
  bicycle_rental: 'transport',
  travel_agency: 'transport',
  travel_agent: 'transport',
  travel_services: 'transport',
  tour_agency: 'transport',
  tour_operator: 'transport',
  tour_provider: 'transport',
  transportation_service: 'transport',
  private_transfer_service: 'transport',
  driving_service: 'transport',
  atm: 'insufficient_travel_value',
  bank: 'insufficient_travel_value',
  bench: 'insufficient_travel_value',
  crossing: 'insufficient_travel_value',
  traffic_signals: 'insufficient_travel_value',
  bicycle_parking: 'insufficient_travel_value',
  waste_basket: 'insufficient_travel_value',
  drinking_water: 'insufficient_travel_value',
  toilets: 'insufficient_travel_value',
  post_box: 'insufficient_travel_value',
  telephone: 'insufficient_travel_value',
  bus_stop: 'insufficient_travel_value',
  street_lamp: 'insufficient_travel_value',
  fire_hydrant: 'insufficient_travel_value',
  utility: 'infrastructure',
  power: 'infrastructure',
  communication: 'infrastructure',
  barrier: 'infrastructure',
  manhole: 'infrastructure',
  pipeline: 'infrastructure',
  storage_tank: 'infrastructure',
  wastewater_plant: 'infrastructure',
  substation: 'infrastructure',
  attractions_and_activities: 'insufficient_travel_value',
  arts_and_entertainment: 'insufficient_travel_value',
  cultural_and_historic: 'insufficient_travel_value',
  geographic_entities: 'insufficient_travel_value',
  sports_and_recreation: 'insufficient_travel_value',
  active_life: 'insufficient_travel_value',
  natural_features: 'insufficient_travel_value',
  gym: 'generic_commercial',
  fitness_center: 'generic_commercial',
  fitness_centre: 'generic_commercial',
  amusement_arcade: 'generic_commercial',
  arcade: 'generic_commercial',
  nightlife_venue: 'generic_commercial',
  gaming_venue: 'generic_commercial',
  music_venue: 'generic_commercial',
  religious_organization: 'support_stop',
  food_and_drink: 'food',
  eat_and_drink: 'food',
  restaurants: 'food',
  lodging: 'lodging_support',
  accommodation: 'lodging_support',
  travel_and_transportation: 'transport',
  shopping: 'generic_commercial',
  community_and_government: 'support_stop',
  services_and_business: 'generic_commercial',
  business_to_business: 'generic_commercial',
  professional_services: 'generic_commercial',
  lifestyle_services: 'generic_commercial',
  health_care: 'generic_commercial',
  health_and_medical: 'generic_commercial',
  education: 'insufficient_travel_value',
  financial_service: 'generic_commercial',
  automotive: 'generic_commercial',
  real_estate: 'generic_commercial',
  mass_media: 'generic_commercial',
};


/**
 * A record shaped the way the Overture places normaliser actually emits one.
 *
 * The *shape* is what matters and is what is reproduced: the catalogue's leaf in
 * `sourceCategory`, its published hierarchy outermost-first in
 * `sourceCategoryPath`, the pack role the normaliser wrote, and the provenance
 * row every record carries. No real name appears — the names in the live defect
 * were an airport, a driver-for-hire and a tour agency, and naming any of them
 * here would make this a test about Bali instead of a test about categories.
 */
function placeRecord(overrides: Partial<SourceRecord> & Pick<SourceRecord, 'sourceCategory'>): SourceRecord {
  return {
    id: `places:${overrides.sourceId ?? 'x1'}`,
    layerId: 'places',
    sourceId: 'x1',
    name: 'A Named Thing',
    alternateNames: [],
    coordinates: { lat: -8.7, lng: 115.17 },
    sourceCategoryPath: [],
    planningRole: 'attraction',
    websiteCandidates: [],
    containment: { divisionIds: [] },
    attributes: {},
    sources: [{ dataset: 'meta', licenceId: 'CDLA-Permissive-2.0' }],
    cellId: 'cell-0',
    ...overrides,
  } as SourceRecord;
}

/**
 * The two live-defect records, by structure.
 *
 * An international airport as a place catalogue emits one: a leaf under the
 * travel branch, `open`, and — this is the part that mattered — richer than any
 * museum in the region. A site, posted hours, a named operator, an open
 * identifier and several contributors, every one of which the inventory's
 * `knownness` ordering rewards.
 */
const INTERNATIONAL_AIRPORT = placeRecord({
  sourceId: 'gers-airport',
  name: 'A Named Airport',
  sourceCategory: 'international_airport',
  sourceCategoryPath: ['travel_and_transportation', 'transportation', 'international_airport'],
  planningRole: 'gateway',
  operatingStatus: 'open',
  websiteCandidates: ['https://example.org/airport'],
  wikidataId: 'Q123456',
  attributes: {
    opening_hours: '24/7',
    operator: 'An Airport Authority',
    website: 'https://example.org/airport',
    wheelchair: 'yes',
  },
  sources: [
    { dataset: 'meta', licenceId: 'CDLA-Permissive-2.0', existenceConfidence: 0.98 },
    { dataset: 'OpenStreetMap', licenceId: 'ODbL-1.0', recordId: 'w1@1' },
  ],
});

/**
 * A driver-for-hire, as the same catalogue emits one.
 *
 * A leaf the branch table would otherwise have swept into `support` alongside
 * the groceries, a website, and nothing else. It is a real business and a
 * traveller without a car may genuinely want it; it is not somewhere to go.
 */
const DRIVER_FOR_HIRE = placeRecord({
  sourceId: 'gers-driver',
  name: 'A Named Driver Service',
  sourceCategory: 'chauffeur_service',
  sourceCategoryPath: ['travel_and_transportation', 'transportation_service', 'chauffeur_service'],
  planningRole: 'support',
  operatingStatus: 'open',
  websiteCandidates: ['https://example.org/driver'],
});

/** A tour agency: the same class, a different leaf, and the same answer. */
const TOUR_OPERATOR = placeRecord({
  sourceId: 'gers-tours',
  name: 'A Named Tours Company',
  sourceCategory: 'tour_operator',
  sourceCategoryPath: ['travel_and_transportation', 'travel_services', 'tour_operator'],
  planningRole: 'support',
  operatingStatus: 'open',
});

describe('role eligibility over the complete category vocabulary', () => {
  const { leaves, branches } = knownCategoryKeys();
  const everyKey = [...leaves, ...branches];

  it('covers every key the taxonomy knows, and nothing it does not', () => {
    expect(everyKey.length).toBe(214);
    expect([...everyKey].sort()).toEqual(Object.keys(EXPECTED_ROLE).sort());
  });

  it.each(everyKey)('%s resolves to its expected role and permissions', (key) => {
    const assessment = assessRoleEligibility({ sourceCategory: key, name: 'A Named Thing' });
    expect(assessment.role).toBe(EXPECTED_ROLE[key]);
    expect(assessment.eligibility).toEqual(ROLE_PERMISSIONS[assessment.role]);
  });

  /**
   * The invariant CS-3 is about, stated once over the whole vocabulary.
   *
   * Not "the airport is not visitable" — that is a fact about one row and would
   * pass while a hundred other rows leaked. Every key whose archetype is a way of
   * getting somewhere, a business, a bed, a car park or a pipeline is checked in
   * one assertion.
   */
  it('never lets a utility or rejected archetype reach a traveller-facing slot', () => {
    const leaked: string[] = [];
    for (const key of everyKey) {
      const assessment = assessRoleEligibility({ sourceCategory: key, name: 'A Named Thing' });
      if (isAttractionRole(assessment.role)) continue;
      if (assessment.eligibility.provisionalBoard || assessment.eligibility.attractionPortfolio) {
        leaked.push(`${key} -> ${assessment.role}`);
      }
    }
    expect(leaked).toEqual([]);
  });

  it('gives every key a role that maps back onto a storable pack role', () => {
    for (const key of everyKey) {
      const assessment = assessRoleEligibility({ sourceCategory: key, name: 'A Named Thing' });
      expect(assessment.planningRole).toBe(planningRoleOf(assessment.role));
    }
  });

  it('reports leaf matches more confidently than branch matches', () => {
    const leaf = assessRoleEligibility({ sourceCategory: 'museum', name: 'A Named Museum' });
    const branch = assessRoleEligibility({
      sourceCategory: 'a_word_no_catalogue_publishes',
      sourceCategoryPath: ['cultural_and_historic'],
      name: 'A Named Thing',
    });
    const unknown = assessRoleEligibility({ sourceCategory: 'a_word_no_catalogue_publishes', name: 'A Named Thing' });

    expect(leaf.roleBasis.match).toEqual({ kind: 'source_leaf_category', key: 'museum' });
    expect(branch.roleBasis.match).toEqual({ kind: 'source_branch', key: 'cultural_and_historic' });
    expect(unknown.roleBasis.match).toEqual({ kind: 'no_recognised_category' });
    expect(leaf.roleConfidence).toBeGreaterThan(branch.roleConfidence);
    expect(branch.roleConfidence).toBeGreaterThan(unknown.roleConfidence);
  });
});

describe('the permission table itself', () => {
  it('has a row for every role, and every row answers every slot', () => {
    for (const role of CANDIDATE_ROLES) {
      const permissions = ROLE_PERMISSIONS[role];
      expect(permissions, role).toBeDefined();
      for (const slot of ELIGIBILITY_SLOTS) {
        expect(typeof permissions[slot], `${role}.${slot}`).toBe('boolean');
      }
    }
  });

  it('grants nothing at all to a rejected role', () => {
    for (const role of CANDIDATE_ROLES) {
      if (!isRejectedRole(role)) continue;
      expect(Object.values(ROLE_PERMISSIONS[role]), role).toEqual([false, false, false, false, false, false]);
    }
  });

  it('lets every attraction role reach the board and the finished itinerary', () => {
    for (const role of ATTRACTION_ROLES) {
      expect(ROLE_PERMISSIONS[role].provisionalBoard, role).toBe(true);
      expect(ROLE_PERMISSIONS[role].attractionPortfolio, role).toBe(true);
      expect(ROLE_PERMISSIONS[role].finalItinerary, role).toBe(true);
    }
  });

  it('keeps food out of the attraction portfolio so support cannot mask a shortage', () => {
    expect(ROLE_PERMISSIONS.food.attractionPortfolio).toBe(false);
    expect(ROLE_PERMISSIONS.food.provisionalBoard).toBe(false);
    expect(ROLE_PERMISSIONS.food_support.attractionPortfolio).toBe(false);
    expect(ROLE_PERMISSIONS.support_stop.attractionPortfolio).toBe(false);
    expect(ROLE_PERMISSIONS.gateway.attractionPortfolio).toBe(false);
  });
});

describe('the rules, one assertion each', () => {
  const roleOf = (category: string, path?: string[]): CandidateRole =>
    assessRoleEligibility({
      sourceCategory: category,
      ...(path ? { sourceCategoryPath: path } : {}),
      name: 'A Named Thing',
    }).role;

  it('airports are gateways, never attractions', () => {
    for (const category of ['airport', 'international_airport']) {
      const assessment = assessRoleEligibility({ sourceCategory: category, name: 'A Named Airport' });
      expect(assessment.role).toBe('gateway');
      expect(assessment.roleBasis.kind).toBe('gateway_air');
      expect(assessment.eligibility.provisionalBoard).toBe(false);
      expect(assessment.eligibility.attractionPortfolio).toBe(false);
      expect(assessment.eligibility.finalItinerary).toBe(false);
    }
  });

  it('taxi services and drivers for hire are transport support, never attractions', () => {
    for (const category of ['taxi', 'taxi_service', 'chauffeur_service', 'limousine_service', 'private_transfer_service']) {
      const assessment = assessRoleEligibility({ sourceCategory: category, name: 'A Named Service' });
      expect(assessment.role, category).toBe('transport');
      expect(assessment.eligibility.provisionalBoard, category).toBe(false);
      expect(assessment.eligibility.routingSupport, category).toBe(true);
    }
  });

  it('car rentals are transport support and parking is infrastructure', () => {
    expect(roleOf('car_rental')).toBe('transport');
    expect(roleOf('car_rental_agency')).toBe('transport');
    expect(roleOf('parking')).toBe('infrastructure');
    expect(ROLE_PERMISSIONS.infrastructure.supportPortfolio).toBe(false);
    expect(ROLE_PERMISSIONS.infrastructure.routingSupport).toBe(true);
  });

  it('ferry terminals and rail stations are gateways or transport', () => {
    for (const category of ['ferry_terminal', 'ferry', 'harbor', 'marina', 'train_station', 'railway_station', 'bus_station']) {
      expect(roleOf(category), category).toBe('gateway');
    }
    // Anything else under the travel branch is transport rather than a stop.
    expect(roleOf('a_word_no_catalogue_publishes', ['travel_and_transportation'])).toBe('transport');
  });

  it('lodging is not an attraction however well catalogued', () => {
    for (const category of ['hotel', 'hostel', 'resort', 'guest_house']) {
      expect(roleOf(category), category).toBe('lodging_support');
    }
  });

  it('visitor centres are support unless a different category says otherwise', () => {
    expect(roleOf('visitor_center')).toBe('support_stop');
    expect(roleOf('information')).toBe('support_stop');
    expect(roleOf('trailhead')).toBe('support_stop');
    // "Distinct attraction evidence" is the source publishing a different leaf.
    expect(roleOf('museum')).toBe('itinerary_anchor');
  });

  it('groceries and pharmacies are support', () => {
    expect(roleOf('supermarket')).toBe('food_support');
    expect(roleOf('grocery_store')).toBe('food_support');
    expect(roleOf('convenience_store')).toBe('food_support');
    expect(roleOf('pharmacy')).toBe('support_stop');
    for (const category of ['supermarket', 'grocery_store', 'pharmacy']) {
      expect(assessRoleEligibility({ sourceCategory: category, name: 'A Named Shop' }).eligibility.provisionalBoard, category).toBe(false);
    }
  });

  it('generic commercial businesses do not become discoveries', () => {
    for (const branch of ['shopping', 'professional_services', 'services_and_business', 'financial_service', 'real_estate', 'nightlife_venue']) {
      const assessment = assessRoleEligibility({ sourceCategory: branch, name: 'A Named Business' });
      expect(assessment.role, branch).toBe('generic_commercial');
      expect(assessment.eligibility.provisionalBoard, branch).toBe(false);
      expect(assessment.eligibility.finalItinerary, branch).toBe(false);
    }
  });

  it('restaurants, cafés and bakeries enter food roles rather than cultural slots', () => {
    for (const category of ['restaurant', 'cafe', 'coffee_shop', 'bakery', 'bar', 'pub', 'fast_food', 'food_court']) {
      const assessment = assessRoleEligibility({ sourceCategory: category, name: 'A Named Kitchen' });
      expect(assessment.role, category).toBe('food');
      expect(isFoodRole(assessment.role), category).toBe(true);
      expect(assessment.eligibility.foodPortfolio, category).toBe(true);
      expect(assessment.eligibility.attractionPortfolio, category).toBe(false);
    }
  });

  it('a market holds both market and food relevance', () => {
    for (const category of ['market', 'night_market', 'farmers_market', 'food_hall']) {
      const assessment = assessRoleEligibility({ sourceCategory: category, name: 'A Named Market' });
      expect(assessment.role, category).toBe('market');
      expect(assessment.eligibility.provisionalBoard, category).toBe(true);
      expect(assessment.eligibility.attractionPortfolio, category).toBe(true);
      expect(assessment.eligibility.foodPortfolio, category).toBe(true);
      // And it is not rejected *for* food: the two relevances coexist.
      expect(assessment.rejectedRoles.some((entry) => entry.role === 'food')).toBe(false);
    }
  });

  it('never infers a scenic airport viewpoint from the airport category', () => {
    const assessment = assessRoleEligibility({
      sourceCategory: 'international_airport',
      sourceCategoryPath: ['travel_and_transportation', 'transportation', 'international_airport'],
      name: 'A Named Airport',
    });
    expect(assessment.role).toBe('gateway');
    expect(assessment.roleBasis.kind).not.toBe('scenic');
    const rejected = assessment.rejectedRoles.map((entry) => entry.role);
    expect(rejected).toContain('scenic');
    expect(rejected).toContain('itinerary_anchor');
    for (const entry of assessment.rejectedRoles) {
      expect(entry.reason).toBe('transport_category');
    }
  });

  it('does not treat an absent category as an attraction', () => {
    for (const category of ['a_word_no_catalogue_publishes', 'unknown', 'x']) {
      const assessment = assessRoleEligibility({ sourceCategory: category, name: 'A Named Thing' });
      expect(assessment.role, category).toBe('insufficient_travel_value');
      expect(assessment.eligibility.provisionalBoard, category).toBe(false);
    }
  });
});

describe('what may not override a role', () => {
  /**
   * Prominence, completeness and interest, checked against the record that
   * actually beat every museum in Bali.
   *
   * The airport fixture carries a website, an open identifier, posted hours, an
   * operator, an accessibility tag and two contributing datasets — the maximum
   * of every signal the inventory's ordering rewards. If completeness could
   * promote anything, it would promote this.
   */
  it('high prominence and full source completeness cannot promote a gateway', () => {
    const rich = assessRecordEligibility(INTERNATIONAL_AIRPORT);
    const bare = assessRoleEligibility({
      sourceCategory: 'international_airport',
      name: 'A Named Airport',
    });
    expect(rich.role).toBe('gateway');
    expect(rich.role).toBe(bare.role);
    expect(rich.eligibility).toEqual(bare.eligibility);
    expect(rich.eligibility.provisionalBoard).toBe(false);
  });

  /**
   * Traveller interest is structurally unable to reach this decision.
   *
   * The point is not that a profile is ignored — it is that there is nowhere to
   * put one. `assessRoleEligibility` takes six fields and none of them is a
   * traveller, so "the user loves transport hubs" has no path into the answer.
   * This asserts the shape rather than a behaviour, because the shape is the
   * guarantee.
   */
  it('has no traveller input at all, so interest cannot transform infrastructure', () => {
    const airport = assessRecordEligibility(INTERNATIONAL_AIRPORT);
    const parking = assessRoleEligibility({ sourceCategory: 'parking', name: 'A Named Car Park' });
    expect(airport.eligibility.attractionPortfolio).toBe(false);
    expect(parking.eligibility.attractionPortfolio).toBe(false);
    // The only fields the assessment reads, spelled out so adding a seventh is a
    // deliberate act rather than a convenience.
    const accepted = ['sourceCategory', 'sourceCategoryPath', 'name', 'operatingStatus', 'packRole', 'superseded'];
    expect(accepted).not.toContain('profile');
    expect(accepted).not.toContain('fitScore');
    expect(accepted).not.toContain('popularity');
  });

  it('classifies the live-defect records as utility, not as travel candidates', () => {
    for (const record of [INTERNATIONAL_AIRPORT, DRIVER_FOR_HIRE, TOUR_OPERATOR]) {
      const assessment = assessRecordEligibility(record);
      expect(isAttractionRole(assessment.role), record.sourceCategory).toBe(false);
      expect(assessment.eligibility.provisionalBoard, record.sourceCategory).toBe(false);
      expect(assessment.eligibility.attractionPortfolio, record.sourceCategory).toBe(false);
      expect(assessment.eligibility.finalItinerary, record.sourceCategory).toBe(false);
    }
    expect(assessRecordEligibility(INTERNATIONAL_AIRPORT).role).toBe('gateway');
    expect(assessRecordEligibility(DRIVER_FOR_HIRE).role).toBe('transport');
    expect(assessRecordEligibility(TOUR_OPERATOR).role).toBe('transport');
  });

  /**
   * The branch fallback catches the ones the leaf table has never heard of.
   *
   * A catalogue publishes hundreds of transport-service words and this table
   * lists twenty-five. The one that matters is that the twenty-sixth lands on
   * `transport` through its branch rather than on the board through `support`.
   */
  it('sends an unlisted transport service to transport through its branch', () => {
    const assessment = assessRoleEligibility({
      sourceCategory: 'a_transport_word_this_table_has_never_seen',
      sourceCategoryPath: ['travel_and_transportation', 'transportation_service'],
      name: 'A Named Service',
    });
    expect(assessment.role).toBe('transport');
    expect(assessment.eligibility.provisionalBoard).toBe(false);
  });
});

describe('refusals that have nothing to do with the category', () => {
  it('refuses a record the source says has permanently closed, whatever it is', () => {
    const assessment = assessRecordEligibility(
      placeRecord({ sourceCategory: 'museum', name: 'A Named Museum', operatingStatus: 'closed' }),
    );
    expect(assessment.role).toBe('permanently_closed');
    expect(assessment.roleBasis.decidedBy).toBe('record_operating_status');
    // The category's own verdict survives alongside the refusal.
    expect(assessment.roleBasis.kind).toBe('cultural');
    expect(assessment.eligibility.finalItinerary).toBe(false);
  });

  it('refuses a record another record already carries', () => {
    const assessment = assessRecordEligibility(
      placeRecord({ sourceCategory: 'waterfall', name: 'A Named Waterfall' }),
      { superseded: true },
    );
    expect(assessment.role).toBe('duplicate');
    expect(assessment.roleBasis.decidedBy).toBe('link_resolution');
    expect(assessment.eligibility.provisionalBoard).toBe(false);
  });

  it('refuses a record with no name a traveller could be shown', () => {
    expect(assessRoleEligibility({ sourceCategory: 'museum', name: '' }).role).toBe('insufficient_identity');
    expect(assessRoleEligibility({ sourceCategory: 'museum' }).role).toBe('insufficient_identity');
    // A listing named after its own category is a database row, not a place.
    expect(assessRoleEligibility({ sourceCategory: 'restaurant', name: 'Restaurant' }).role).toBe('insufficient_identity');
    expect(assessRoleEligibility({ sourceCategory: 'coffee_shop', name: 'Coffee Shop' }).role).toBe('insufficient_identity');
  });

  it('refuses an administrative object on the pack role alone', () => {
    const assessment = assessRecordEligibility(
      placeRecord({ sourceCategory: 'locality', name: 'A Named Division', planningRole: 'administrative' }),
    );
    expect(assessment.role).toBe('administrative_object');
    expect(assessment.roleBasis.decidedBy).toBe('stored_pack_role');
    expect(Object.values(assessment.eligibility)).toEqual([false, false, false, false, false, false]);
  });

  /**
   * A stored role is honoured as a refusal and never as a promotion.
   *
   * The same asymmetry `buildInventory` uses. A pack built before the role split
   * stored every positive record as `attraction`; trusting that would freeze an
   * old vocabulary into every future compilation, so a stored `attraction` on an
   * airport changes nothing.
   */
  it('ignores a stored pack role that claims more than the category supports', () => {
    const assessment = assessRecordEligibility(
      placeRecord({
        sourceCategory: 'international_airport',
        name: 'A Named Airport',
        planningRole: 'attraction',
      }),
    );
    expect(assessment.role).toBe('gateway');
    expect(assessment.eligibility.provisionalBoard).toBe(false);
  });
});

describe('determinism', () => {
  it('returns byte-identical assessments for identical inputs', () => {
    const once = assessRecordEligibility(INTERNATIONAL_AIRPORT);
    const twice = assessRecordEligibility(INTERNATIONAL_AIRPORT);
    expect(JSON.stringify(once)).toBe(JSON.stringify(twice));
  });

  it('normalises the source vocabulary the same way the taxonomy does', () => {
    for (const spelling of ['International Airport', 'international-airport', ' INTERNATIONAL_AIRPORT ']) {
      expect(assessRoleEligibility({ sourceCategory: spelling, name: 'A Named Airport' }).role, spelling).toBe('gateway');
    }
  });
});
