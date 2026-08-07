import { describe, expect, it } from 'vitest';
import type { PlanningRole } from '@sidequest/core';
import {
  classifySourceCategory,
  isLandscapeScale,
  knownCategoryKeys,
  type TaxonomySubrole,
} from './taxonomy';

/**
 * THE TAXONOMY, EVERY KEY, ROLE AND ARCHETYPE.
 *
 * The role column is a regression guard and is the more important half. Phase 12
 * added a subrole to every rule in this table, and the whole value of doing that
 * additively is that no record changes what it *is* — so the roles below are the
 * ones the table produced before the archetype existed, written down so that a
 * future annotation cannot quietly reclassify a museum while tidying a comment.
 *
 * The archetype column is the new information: one level finer than the pack's
 * eleven roles, derived rather than persisted, and the input `eligibility.ts`
 * needs to tell a grocery from a chauffeur when the pack calls both `support`.
 */
const EXPECTED: Record<string, readonly [PlanningRole, TaxonomySubrole]> = {
  viewpoint: ['outdoor', 'scenic'],
  scenic_lookout: ['outdoor', 'scenic'],
  observation_deck: ['outdoor', 'scenic'],
  scenic_point_of_interest: ['outdoor', 'scenic'],
  peak: ['outdoor', 'scenic'],
  summit: ['outdoor', 'scenic'],
  saddle: ['outdoor', 'scenic'],
  ridge: ['outdoor', 'scenic'],
  cliff: ['outdoor', 'scenic'],
  volcano: ['outdoor', 'scenic'],
  park: ['outdoor', 'outdoor_nature'],
  national_park: ['outdoor', 'outdoor_nature'],
  state_park: ['outdoor', 'outdoor_nature'],
  nature_reserve: ['outdoor', 'outdoor_nature'],
  nature_preserve: ['outdoor', 'outdoor_nature'],
  protected_area: ['outdoor', 'outdoor_nature'],
  botanical_garden: ['outdoor', 'outdoor_nature'],
  garden: ['outdoor', 'outdoor_nature'],
  hiking_trail: ['outdoor', 'outdoor_nature'],
  trail: ['outdoor', 'outdoor_nature'],
  trailhead: ['support', 'visitor_information'],
  forest: ['outdoor', 'outdoor_nature'],
  valley: ['outdoor', 'scenic'],
  hill: ['outdoor', 'scenic'],
  mountain_range: ['outdoor', 'scenic'],
  dune: ['outdoor', 'outdoor_nature'],
  cave: ['outdoor', 'outdoor_nature'],
  cave_entrance: ['outdoor', 'outdoor_nature'],
  lake: ['outdoor', 'outdoor_nature'],
  reservoir: ['outdoor', 'outdoor_nature'],
  river: ['outdoor', 'outdoor_nature'],
  pond: ['outdoor', 'outdoor_nature'],
  lagoon: ['outdoor', 'outdoor_nature'],
  bay: ['outdoor', 'outdoor_nature'],
  fjord: ['outdoor', 'outdoor_nature'],
  waterfall: ['outdoor', 'outdoor_nature'],
  beach: ['outdoor', 'outdoor_nature'],
  glacier: ['outdoor', 'scenic'],
  spring: ['outdoor', 'outdoor_nature'],
  hot_spring: ['outdoor', 'outdoor_nature'],
  geyser: ['outdoor', 'outdoor_nature'],
  fumarole: ['outdoor', 'outdoor_nature'],
  museum: ['attraction', 'cultural'],
  art_museum: ['attraction', 'cultural'],
  history_museum: ['attraction', 'cultural'],
  science_museum: ['attraction', 'cultural'],
  art_gallery: ['attraction', 'cultural'],
  gallery: ['attraction', 'cultural'],
  aquarium: ['attraction', 'cultural'],
  zoo: ['outdoor', 'outdoor_nature'],
  planetarium: ['attraction', 'cultural'],
  library: ['attraction', 'cultural'],
  theatre: ['attraction', 'cultural'],
  concert_hall: ['attraction', 'cultural'],
  historic_site: ['attraction', 'cultural'],
  historical_landmark: ['attraction', 'cultural'],
  archaeological_site: ['attraction', 'cultural'],
  castle: ['attraction', 'cultural'],
  fort: ['attraction', 'cultural'],
  ruins: ['attraction', 'cultural'],
  monument: ['attraction', 'cultural'],
  memorial: ['side_quest', 'cultural'],
  landmark_and_historical_building: ['attraction', 'cultural'],
  place_of_worship: ['support', 'civic'],
  church: ['attraction', 'cultural'],
  cathedral: ['attraction', 'cultural'],
  basilica: ['attraction', 'cultural'],
  abbey: ['attraction', 'cultural'],
  monastery: ['attraction', 'cultural'],
  temple: ['attraction', 'cultural'],
  hindu_temple: ['attraction', 'cultural'],
  buddhist_temple: ['attraction', 'cultural'],
  taoist_temple: ['attraction', 'cultural'],
  sikh_temple: ['attraction', 'cultural'],
  mosque: ['attraction', 'cultural'],
  shrine: ['attraction', 'cultural'],
  shinto_shrine: ['attraction', 'cultural'],
  synagogue: ['attraction', 'cultural'],
  cable_car: ['attraction', 'scenic'],
  aerial_lift: ['attraction', 'scenic'],
  gondola: ['attraction', 'scenic'],
  funicular: ['attraction', 'scenic'],
  ski_resort: ['attraction', 'scenic'],
  market: ['market', 'market'],
  marketplace: ['market', 'market'],
  farmers_market: ['market', 'market'],
  public_market: ['market', 'market'],
  bazaar: ['market', 'market'],
  night_market: ['market', 'market'],
  flea_market: ['market', 'market'],
  neighborhood: ['attraction', 'urban_place'],
  plaza: ['side_quest', 'urban_place'],
  pedestrian: ['excluded', 'street_furniture'],
  scenic_drive: ['outdoor', 'scenic'],
  scenic_byway: ['outdoor', 'scenic'],
  bridge: ['outdoor', 'scenic'],
  pier: ['outdoor', 'scenic'],
  restaurant: ['food', 'food_service'],
  cafe: ['food', 'food_service'],
  coffee_shop: ['food', 'food_service'],
  bakery: ['food', 'food_service'],
  fast_food: ['food', 'food_service'],
  food_court: ['food', 'food_service'],
  food_hall: ['market', 'market'],
  bar: ['food', 'food_service'],
  pub: ['food', 'food_service'],
  ice_cream_shop: ['food', 'food_service'],
  deli: ['support', 'provisioning'],
  hotel: ['lodging', 'lodging'],
  hostel: ['lodging', 'lodging'],
  motel: ['lodging', 'lodging'],
  guest_house: ['lodging', 'lodging'],
  resort: ['lodging', 'lodging'],
  bed_and_breakfast: ['lodging', 'lodging'],
  visitor_center: ['support', 'visitor_information'],
  information: ['support', 'visitor_information'],
  ferry_terminal: ['gateway', 'gateway_water'],
  ferry: ['gateway', 'gateway_water'],
  harbor: ['gateway', 'gateway_water'],
  marina: ['gateway', 'gateway_water'],
  train_station: ['gateway', 'gateway_rail'],
  railway_station: ['gateway', 'gateway_rail'],
  bus_station: ['gateway', 'gateway_road'],
  airport: ['gateway', 'gateway_air'],
  international_airport: ['gateway', 'gateway_air'],
  parking: ['support', 'parking'],
  campground: ['support', 'support_service'],
  supermarket: ['support', 'provisioning'],
  grocery_store: ['support', 'provisioning'],
  convenience_store: ['support', 'provisioning'],
  pharmacy: ['support', 'support_service'],
  gas_station: ['support', 'support_service'],
  taxi: ['support', 'ground_transport'],
  taxi_service: ['support', 'ground_transport'],
  taxi_stand: ['support', 'ground_transport'],
  rideshare: ['support', 'ground_transport'],
  chauffeur_service: ['support', 'ground_transport'],
  limousine_service: ['support', 'ground_transport'],
  limo_service: ['support', 'ground_transport'],
  shuttle_service: ['support', 'ground_transport'],
  airport_shuttle_service: ['support', 'ground_transport'],
  car_rental: ['support', 'ground_transport'],
  car_rental_agency: ['support', 'ground_transport'],
  rental_car_agency: ['support', 'ground_transport'],
  motorcycle_rental: ['support', 'ground_transport'],
  scooter_rental: ['support', 'ground_transport'],
  bicycle_rental: ['support', 'ground_transport'],
  travel_agency: ['support', 'ground_transport'],
  travel_agent: ['support', 'ground_transport'],
  travel_services: ['support', 'ground_transport'],
  tour_agency: ['support', 'ground_transport'],
  tour_operator: ['support', 'ground_transport'],
  tour_provider: ['support', 'ground_transport'],
  transportation_service: ['support', 'ground_transport'],
  private_transfer_service: ['support', 'ground_transport'],
  driving_service: ['support', 'ground_transport'],
  atm: ['excluded', 'street_furniture'],
  bank: ['excluded', 'street_furniture'],
  bench: ['excluded', 'street_furniture'],
  crossing: ['excluded', 'street_furniture'],
  traffic_signals: ['excluded', 'street_furniture'],
  bicycle_parking: ['excluded', 'street_furniture'],
  waste_basket: ['excluded', 'street_furniture'],
  drinking_water: ['excluded', 'street_furniture'],
  toilets: ['excluded', 'street_furniture'],
  post_box: ['excluded', 'street_furniture'],
  telephone: ['excluded', 'street_furniture'],
  bus_stop: ['excluded', 'street_furniture'],
  street_lamp: ['excluded', 'street_furniture'],
  fire_hydrant: ['excluded', 'street_furniture'],
  utility: ['infrastructure', 'utility'],
  power: ['infrastructure', 'utility'],
  communication: ['infrastructure', 'utility'],
  barrier: ['infrastructure', 'utility'],
  manhole: ['infrastructure', 'utility'],
  pipeline: ['infrastructure', 'utility'],
  storage_tank: ['infrastructure', 'utility'],
  wastewater_plant: ['infrastructure', 'utility'],
  substation: ['infrastructure', 'utility'],
  attractions_and_activities: ['attraction', 'cultural'],
  arts_and_entertainment: ['attraction', 'cultural'],
  cultural_and_historic: ['attraction', 'cultural'],
  geographic_entities: ['attraction', 'scenic'],
  sports_and_recreation: ['attraction', 'outdoor_nature'],
  active_life: ['attraction', 'outdoor_nature'],
  natural_features: ['attraction', 'scenic'],
  // Local amenities: used because somebody lives there, not because they travelled.
  gym: ['excluded', 'commerce'],
  fitness_center: ['excluded', 'commerce'],
  fitness_centre: ['excluded', 'commerce'],
  amusement_arcade: ['excluded', 'commerce'],
  arcade: ['excluded', 'commerce'],
  nightlife_venue: ['excluded', 'commerce'],
  gaming_venue: ['excluded', 'commerce'],
  music_venue: ['excluded', 'commerce'],
  religious_organization: ['support', 'civic'],
  food_and_drink: ['food', 'food_service'],
  eat_and_drink: ['food', 'food_service'],
  restaurants: ['food', 'food_service'],
  lodging: ['lodging', 'lodging'],
  accommodation: ['lodging', 'lodging'],
  travel_and_transportation: ['support', 'ground_transport'],
  shopping: ['support', 'commerce'],
  community_and_government: ['support', 'civic'],
  services_and_business: ['excluded', 'commerce'],
  business_to_business: ['excluded', 'commerce'],
  professional_services: ['excluded', 'commerce'],
  lifestyle_services: ['excluded', 'commerce'],
  health_care: ['excluded', 'commerce'],
  health_and_medical: ['excluded', 'commerce'],
  education: ['excluded', 'civic'],
  financial_service: ['excluded', 'commerce'],
  automotive: ['excluded', 'commerce'],
  real_estate: ['excluded', 'commerce'],
  mass_media: ['excluded', 'commerce'],
};

describe('the category table', () => {
  const { leaves, branches } = knownCategoryKeys();
  const everyKey = [...leaves, ...branches];

  it('has 184 leaves and 30 branches, and the expectation table covers all of them', () => {
    expect(leaves.length).toBe(184);
    expect(branches.length).toBe(30);
    expect([...everyKey].sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it.each(everyKey)('%s keeps its role and resolves to its archetype', (key) => {
    const classification = classifySourceCategory({ category: key });
    expect([classification.role, classification.subrole]).toEqual(EXPECTED[key]);
  });

  it('gives every key an archetype, so nothing falls through to a default', () => {
    for (const key of everyKey) {
      expect(classifySourceCategory({ category: key }).subrole, key).toBeTruthy();
    }
  });

  /**
   * The archetype refines the role; it never contradicts it.
   *
   * A subrole that could disagree with its own role would be a second
   * classification rather than a finer one, and two classifications is how the
   * inventory once lost twenty-two parks. Checked over the whole vocabulary
   * rather than by inspection.
   */
  it('never pairs a visitable archetype with a non-visitable role', () => {
    const visitableArchetypes = new Set(['cultural', 'scenic', 'outdoor_nature', 'urban_place', 'market']);
    const visitableRoles = new Set(['attraction', 'side_quest', 'outdoor', 'market']);
    const contradictions: string[] = [];
    for (const key of everyKey) {
      const { role, subrole } = classifySourceCategory({ category: key });
      if (visitableArchetypes.has(subrole) !== visitableRoles.has(role)) {
        contradictions.push(`${key}: role=${role} archetype=${subrole}`);
      }
    }
    expect(contradictions).toEqual([]);
  });
});

describe('how a category is matched', () => {
  it('reports a leaf match with the key that matched', () => {
    expect(classifySourceCategory({ category: 'museum' }).match).toEqual({
      kind: 'source_leaf_category',
      key: 'museum',
    });
  });

  it('reports the innermost path segment that matched, not the outermost', () => {
    const classification = classifySourceCategory({
      category: 'a_word_no_catalogue_publishes',
      path: ['travel_and_transportation', 'museum'],
    });
    expect(classification.match).toEqual({ kind: 'source_category_path', key: 'museum' });
    expect(classification.role).toBe('attraction');
  });

  it('reports a branch match when only the family is recognised', () => {
    const classification = classifySourceCategory({
      category: 'a_word_no_catalogue_publishes',
      path: ['cultural_and_historic', 'another_word_no_catalogue_publishes'],
    });
    expect(classification.match).toEqual({ kind: 'source_branch', key: 'cultural_and_historic' });
  });

  it('reports no match rather than inventing one, and excludes rather than promotes', () => {
    const classification = classifySourceCategory({ category: 'a_word_no_catalogue_publishes' });
    expect(classification.match).toEqual({ kind: 'no_recognised_category' });
    expect(classification.role).toBe('excluded');
    expect(classification.subrole).toBe('unclassified');
  });

  it('normalises spacing, case and hyphens the same way for every lookup', () => {
    for (const spelling of ['Historic Site', 'historic-site', ' HISTORIC_SITE ']) {
      const classification = classifySourceCategory({ category: spelling });
      expect(classification.match, spelling).toEqual({ kind: 'source_leaf_category', key: 'historic_site' });
    }
  });
});

describe('the archetypes the live Bali defect turned on', () => {
  it('files air, rail, road and water gateways under distinct archetypes', () => {
    expect(classifySourceCategory({ category: 'international_airport' }).subrole).toBe('gateway_air');
    expect(classifySourceCategory({ category: 'airport' }).subrole).toBe('gateway_air');
    expect(classifySourceCategory({ category: 'train_station' }).subrole).toBe('gateway_rail');
    expect(classifySourceCategory({ category: 'bus_station' }).subrole).toBe('gateway_road');
    expect(classifySourceCategory({ category: 'ferry_terminal' }).subrole).toBe('gateway_water');
    for (const key of ['international_airport', 'airport', 'train_station', 'bus_station', 'ferry_terminal']) {
      expect(classifySourceCategory({ category: key }).role, key).toBe('gateway');
    }
  });

  /**
   * The distinction the pack's vocabulary cannot make.
   *
   * A grocery, a visitor centre, a shopping centre and a chauffeur service are
   * all `support`, and that is the right pack answer for all four — none of them
   * is a reason to plan a day and all four are worth keeping. It is also why a
   * driver-for-hire reached a Discovery Board: `support` reached the board, and
   * `support` was the only thing anybody could read.
   */
  it('separates sold movement from the other support stops', () => {
    const transport = ['taxi_service', 'chauffeur_service', 'car_rental', 'tour_operator', 'travel_agency'];
    const stops = ['supermarket', 'visitor_center', 'pharmacy', 'campground'];
    for (const key of transport) {
      expect(classifySourceCategory({ category: key }).subrole, key).toBe('ground_transport');
      expect(classifySourceCategory({ category: key }).role, key).toBe('support');
    }
    for (const key of stops) {
      expect(classifySourceCategory({ category: key }).subrole, key).not.toBe('ground_transport');
    }
  });

  it('sends an unlisted travel-branch word to ground transport rather than to a stop', () => {
    const classification = classifySourceCategory({
      category: 'a_transport_word_this_table_has_never_seen',
      path: ['travel_and_transportation'],
    });
    expect(classification.role).toBe('support');
    expect(classification.subrole).toBe('ground_transport');
  });

  it('keeps a car park as infrastructure rather than as somewhere to stop', () => {
    expect(classifySourceCategory({ category: 'parking' }).subrole).toBe('parking');
  });

  it('files provisioning apart from other practical stops', () => {
    for (const key of ['supermarket', 'grocery_store', 'convenience_store', 'deli']) {
      expect(classifySourceCategory({ category: key }).subrole, key).toBe('provisioning');
    }
    for (const key of ['pharmacy', 'gas_station', 'campground']) {
      expect(classifySourceCategory({ category: key }).subrole, key).toBe('support_service');
    }
  });

  it('files visitor information apart from both', () => {
    for (const key of ['visitor_center', 'information', 'trailhead']) {
      expect(classifySourceCategory({ category: key }).subrole, key).toBe('visitor_information');
    }
  });

  it('keeps street furniture distinguishable from an unrecognised category', () => {
    expect(classifySourceCategory({ category: 'bench' }).subrole).toBe('street_furniture');
    expect(classifySourceCategory({ category: 'atm' }).subrole).toBe('street_furniture');
    expect(classifySourceCategory({ category: 'a_word_no_catalogue_publishes' }).subrole).toBe('unclassified');
    expect(classifySourceCategory({ category: 'bench' }).role).toBe('excluded');
  });

  it('keeps a market both a thing to do and somewhere to eat', () => {
    for (const key of ['market', 'night_market', 'food_hall', 'bazaar']) {
      const classification = classifySourceCategory({ category: key });
      expect(classification.role, key).toBe('market');
      expect(classification.subrole, key).toBe('market');
    }
  });
});

describe('nothing in the table names a destination', () => {
  /**
   * The rule that makes this the same table everywhere on earth.
   *
   * Checked mechanically rather than by review: every key must look like a
   * vocabulary word — lower case, underscore-separated, no digits, no spaces.
   * A place name would fail on the first of those the moment somebody wrote one
   * in with a capital letter, and would fail this project's licence position
   * long before it failed a test.
   */
  it('uses only lower-case vocabulary words as keys', () => {
    const { leaves, branches } = knownCategoryKeys();
    for (const key of [...leaves, ...branches]) {
      expect(key, key).toMatch(/^[a-z][a-z_]*[a-z]$/);
    }
  });
});

describe('landscape scale is unchanged by the archetype work', () => {
  it('widens identity matching for categories recorded at a representative point', () => {
    expect(isLandscapeScale({ category: 'volcano' })).toBe(true);
    expect(isLandscapeScale({ category: 'national_park' })).toBe(true);
    expect(isLandscapeScale({ category: 'bridge' })).toBe(true);
    expect(isLandscapeScale({ category: 'cafe' })).toBe(false);
    expect(isLandscapeScale({ category: 'museum' })).toBe(false);
  });

  it('reads the path as well as the leaf', () => {
    expect(isLandscapeScale({ category: 'unknown', path: ['geographic_entities', 'volcano'] })).toBe(true);
  });
});
