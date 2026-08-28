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
  observatory: ['outdoor', 'scenic'],
  communication_tower: ['outdoor', 'scenic'],
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
  natural_monument: ['outdoor', 'scenic'],
  wildlife_sanctuary: ['outdoor', 'outdoor_nature'],
  botanical_garden: ['outdoor', 'outdoor_nature'],
  garden: ['outdoor', 'outdoor_nature'],
  hiking_trail: ['outdoor', 'outdoor_nature'],
  trail: ['outdoor', 'outdoor_nature'],
  trailhead: ['support', 'visitor_information'],
  forest: ['outdoor', 'outdoor_nature'],
  wood: ['outdoor', 'outdoor_nature'],
  valley: ['outdoor', 'scenic'],
  hill: ['outdoor', 'scenic'],
  mountain_range: ['outdoor', 'scenic'],
  dune: ['outdoor', 'outdoor_nature'],
  cave: ['outdoor', 'outdoor_nature'],
  cave_entrance: ['outdoor', 'outdoor_nature'],
  lake: ['outdoor', 'outdoor_nature'],
  reservoir: ['outdoor', 'outdoor_nature'],
  river: ['outdoor', 'outdoor_nature'],
  stream: ['outdoor', 'outdoor_nature'],
  canal: ['outdoor', 'outdoor_nature'],
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
  theatre_venue: ['attraction', 'cultural'],
  concert_hall: ['attraction', 'cultural'],
  exhibition_and_trade_fair_venue: ['attraction', 'cultural'],
  historic_site: ['attraction', 'cultural'],
  historical_landmark: ['attraction', 'cultural'],
  archaeological_site: ['attraction', 'cultural'],
  castle: ['attraction', 'cultural'],
  palace: ['attraction', 'cultural'],
  fort: ['attraction', 'cultural'],
  ruins: ['attraction', 'cultural'],
  monument: ['attraction', 'cultural'],
  memorial: ['side_quest', 'cultural'],
  memorial_site: ['side_quest', 'cultural'],
  memorial_park: ['side_quest', 'cultural'],
  sculpture_statue: ['side_quest', 'cultural'],
  landmark_and_historical_building: ['attraction', 'cultural'],
  place_of_worship: ['attraction', 'cultural'],
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
  // A health-food shop wearing the market node's clothes: provisions, not a visit.
  health_market: ['support', 'provisioning'],
  neighborhood: ['attraction', 'urban_place'],
  plaza: ['side_quest', 'urban_place'],
  pedestrian: ['excluded', 'street_furniture'],
  scenic_drive: ['outdoor', 'scenic'],
  scenic_byway: ['outdoor', 'scenic'],
  bridge: ['outdoor', 'scenic'],
  viaduct: ['outdoor', 'scenic'],
  railway: ['infrastructure', 'utility'],
  railway_line: ['infrastructure', 'utility'],
  rail_line: ['infrastructure', 'utility'],
  rail: ['infrastructure', 'utility'],
  subway_line: ['infrastructure', 'utility'],
  tram_line: ['infrastructure', 'utility'],
  level_crossing: ['infrastructure', 'utility'],
  railway_yard: ['infrastructure', 'utility'],
  // A place of rest first, a sight second; the significance gate decides which.
  cemetery: ['side_quest', 'cultural'],
  graveyard: ['side_quest', 'cultural'],
  // Paid enclosures: one gate, one ticket, everything inside is the attraction.
  theme_park: ['attraction', 'urban_place'],
  amusement_park: ['attraction', 'urban_place'],
  water_park: ['attraction', 'urban_place'],
  // Entities, not places: a person and a company both reached a live board.
  person: ['excluded', 'commerce'],
  company: ['excluded', 'commerce'],
  corporation: ['excluded', 'commerce'],
  office: ['excluded', 'commerce'],
  corporate_office: ['excluded', 'commerce'],
  headquarters: ['excluded', 'commerce'],
  corporate_headquarters: ['excluded', 'commerce'],
  coworking_space: ['excluded', 'commerce'],
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
  geographic_entities: ['attraction', 'outdoor_nature'],
  sports_and_recreation: ['attraction', 'outdoor_nature'],
  active_life: ['attraction', 'outdoor_nature'],
  natural_features: ['attraction', 'outdoor_nature'],
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

  it('has 220 leaves and 30 branches, and the expectation table covers all of them', () => {
    expect(leaves.length).toBe(220);
    expect(branches.length).toBe(30);
    expect([...everyKey].sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it.each(everyKey)('%s keeps its role and resolves to its archetype', (key) => {
    const classification = classifySourceCategory({ category: key });
    expect([classification.role, classification.subrole]).toEqual(EXPECTED[key]);
  });

  /**
   * A BRANCH WE DO NOT RECOGNISE MUST NOT INVENT A VIEW.
   *
   * The file's own stated rule is that an unrecognised branch resolves to
   * something honest rather than to an invention. These two resolved to the
   * *viewpoint* archetype, which stamped `scenic_viewpoints` and
   * `photography_golden_hour` on everything underneath them and handed it the
   * viewpoint's class weight — so a landfill, a drainage channel and a spoil
   * mound all arrived as scenic highlights that satisfied a photography
   * interest, and on a live metropolitan run the highest-ordered card on the
   * whole board was a refuse-disposal site.
   */
  it('never claims a view for a geographic feature whose kind it does not know', () => {
    for (const branch of ['geographic_entities', 'natural_features']) {
      const classification = classifySourceCategory({
        category: 'a_feature_class_nobody_has_seen',
        path: [branch],
      });
      expect(classification.interests, branch).not.toContain('scenic_viewpoints');
      expect(classification.interests, branch).not.toContain('photography_golden_hour');
      expect(classification.category, branch).not.toBe('viewpoint');
      /* And nothing outside the record vouching for it means it is not offered. */
      expect(classification.requiresSignificanceEvidence, branch).toBe(true);
    }

    /* The recognised leaves underneath are untouched: they matched first. */
    const realViewpoint = classifySourceCategory({
      category: 'viewpoint',
      path: ['geographic_entities', 'viewpoint'],
    });
    expect(realViewpoint.category).toBe('viewpoint');
    expect(realViewpoint.interests).toContain('scenic_viewpoints');
  });

  /**
   * A spring is where water comes out of the ground, and nothing about it is
   * hot. Mapped to the geothermal archetype it inherited
   * `geology_and_geothermal`, so a traveller who asked for geysers and lava was
   * offered a suburban water spring as a match, on a card reading
   * "A geothermal."
   */
  it('does not offer plain water as geology', () => {
    const spring = classifySourceCategory({ category: 'spring' });
    expect(spring.interests).not.toContain('geology_and_geothermal');
    expect(spring.category).not.toBe('geothermal');
    /* The heated kinds keep the geothermal archetype and say so themselves. */
    expect(classifySourceCategory({ category: 'geyser' }).category).toBe('geothermal');
    expect(classifySourceCategory({ category: 'hot_spring' }).interests).toContain('hot_springs');
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

  it('tells a purpose-built broadcast tower apart from the masts that share its branch', () => {
    /*
     * Both arrive under the `communication` path. The tower is a structure
     * class — a deck, a ticket, a view — and a destination's tallest building
     * can publish under it with a knowledge-base id and dozens of ground
     * namesakes; flattened into the branch it classified identically to a
     * cell mast and could never enter the inventory however loud the evidence
     * was. The mast classes stay infrastructure, and the tower still needs
     * somebody to vouch for the visit.
     */
    const tower = classifySourceCategory({
      category: 'communication_tower',
      path: ['communication'],
    });
    expect(tower.match).toEqual({ kind: 'source_leaf_category', key: 'communication_tower' });
    expect([tower.role, tower.subrole]).toEqual(['outdoor', 'scenic']);
    expect(tower.displayKind).toBe('Observation tower');
    expect(tower.significanceWeight).toBeGreaterThan(0);
    expect(tower.requiresSignificanceEvidence).toBe(true);

    const mast = classifySourceCategory({
      category: 'mobile_phone_tower',
      path: ['communication'],
    });
    expect(mast.role).toBe('infrastructure');
    expect(mast.significanceWeight).toBe(0);
  });

  it('keeps a market both a thing to do and somewhere to eat', () => {
    for (const key of ['market', 'night_market', 'food_hall', 'bazaar']) {
      const classification = classifySourceCategory({ category: key });
      expect(classification.role, key).toBe('market');
      expect(classification.subrole, key).toBe('market');
    }
  });
});

describe('a leaf that inherits the wrong offer from its archetype', () => {
  /**
   * A SQUARE IS SOMETHING YOU STAND IN, NOT SOMEWHERE YOU EAT.
   *
   * `plaza` took `TOWN`'s whole rule, `interests: ['food_and_towns']` included —
   * right for a market street or a neighbourhood, and false of a paved public
   * space. A delivered plan spent a whole day on three adjoining squares five
   * hundred metres apart and headed it "Food & local eating", because the only
   * interest the three of them offered was the one none of them serves. The
   * theme a traveller reads is composed from what the day's stops offer, so an
   * archetype's convenience became a claim about the day.
   */
  it('offers a public square for its look and its history, not for its food', () => {
    const plaza = classifySourceCategory({ category: 'plaza' });
    expect(plaza.interests).not.toContain('food_and_towns');
    expect(plaza.interests).toContain('scenic_viewpoints');
    /* The archetype it borrows the rest from is unchanged, and still means food. */
    expect(classifySourceCategory({ category: 'neighborhood' }).interests).toContain(
      'food_and_towns',
    );
  });

  /**
   * A cave is geology and it is not a day hike. `HIKE` gave it the hiking
   * interest and a three-hour default, so a lava tube read as a day's walking
   * to a traveller who had asked for neither — and the three hours were an
   * archetype constant rendered as a fact about the visit.
   */
  it('offers a cave as geology, at a duration a cave takes — under either spelling', () => {
    /*
     * Both leaves, because the first repair changed one of them and the
     * delivered journey carried the other: `cave_entrance` sat on the line
     * below `cave` still spreading the day-hike archetype, so a lava tube
     * shipped as "Hiking around Iceland", three hours, "Matches your interest
     * in hiking". A test that named one spelling could not have seen it.
     */
    for (const key of ['cave', 'cave_entrance']) {
      const cave = classifySourceCategory({ category: key });
      expect(cave.interests, key).toContain('geology_and_geothermal');
      expect(cave.interests, key).not.toContain('hiking');
      expect(cave.category, key).not.toBe('day_hike');
      expect(cave.typicalDurationMinutes, key).toBeLessThan(180);
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

describe('type-truthful display and the significance annotations', () => {
  it('gives a river a river’s name, not a lake’s', () => {
    /*
     * The archetype stays `lake` — a river plans like one — but the display
     * noun is the source's own word. A live board captioned the Sumida River
     * "Lake" and a railway "Viewpoint"; both are now unrepresentable.
     */
    const river = classifySourceCategory({ category: 'river' });
    expect(river.category).toBe('lake');
    expect(river.displayKind).toBe('River');
    expect(classifySourceCategory({ category: 'canal' }).displayKind).toBe('Canal');
    expect(classifySourceCategory({ category: 'bay' }).displayKind).toBe('Bay');
    expect(classifySourceCategory({ category: 'cemetery' }).displayKind).toBe('Cemetery');
  });

  it('leaves displayKind absent where the category label is already truthful', () => {
    expect(classifySourceCategory({ category: 'lake' }).displayKind).toBeUndefined();
    expect(classifySourceCategory({ category: 'museum' }).displayKind).toBeUndefined();
  });

  it('weights kinds, not metadata: a museum outweighs a pocket park and a hill', () => {
    const museum = classifySourceCategory({ category: 'museum' }).significanceWeight;
    const temple = classifySourceCategory({ category: 'buddhist_temple' }).significanceWeight;
    const park = classifySourceCategory({ category: 'park' }).significanceWeight;
    const hill = classifySourceCategory({ category: 'hill' }).significanceWeight;
    const nationalPark = classifySourceCategory({ category: 'national_park' }).significanceWeight;
    expect(museum).toBeGreaterThan(park);
    expect(temple).toBeGreaterThan(park);
    expect(park).toBeGreaterThan(hill);
    expect(nationalPark).toBeGreaterThan(park);
  });

  /**
   * THE DESIGNATED NATURAL LANDMARK IS RATED GROUND, NOT UNRECOGNISED GROUND.
   *
   * The protected-area vocabulary's word for a boundary drawn to protect one
   * specific natural feature had no leaf, so it classified as nothing at all —
   * and on a live road/outdoor country pack the geographic layer published the
   * destination's two most famous waterfalls under exactly this word, with a
   * protection class and a drawn boundary, and both were refused as
   * `insufficient_travel_value` while townsquare lawns held board seats. The
   * kind is admitted with a witness demand (the designation itself is the
   * witness the channels read) and a weight between a state park's and a
   * national park's, and it counts as landscape scale so its polygon's twin —
   * the feature it protects — can be found kilometres from its representative
   * point.
   */
  it('rates a designated natural landmark as witnessed outdoor ground, not as nothing', () => {
    const monument = classifySourceCategory({ category: 'natural_monument' });
    expect(monument.role).toBe('outdoor');
    expect(monument.requiresSignificanceEvidence).toBe(true);
    expect(monument.significanceWeight).toBeGreaterThanOrEqual(
      classifySourceCategory({ category: 'state_park' }).significanceWeight,
    );
    expect(monument.significanceWeight).toBeLessThan(
      classifySourceCategory({ category: 'national_park' }).significanceWeight,
    );
    expect(isLandscapeScale({ category: 'natural_monument' })).toBe(true);
  });

  it('does not weight a way across above a place to be', () => {
    /**
     * §16B's sixth guard, in the table rather than in the model: a low-value map
     * feature must not out-prior a destination on the strength of the word it is
     * filed under.
     *
     * Both leaves below arrived at their weight by inheriting an archetype
     * rather than by anybody deciding what the kind is worth, and both decided a
     * live board. `river` kept the lake's 0.45 while every other flowing-water
     * leaf had already been overridden downward, and on the compiled Osaka pack
     * twenty-seven anonymous urban creeks outranked Osaka Castle Park on that
     * difference alone — their evidence was identical to its own. `bridge` sat
     * at 0.5, above a park and a walk, while its own comment in the table reads
     * "most bridges are how a road crosses water"; the highest-ordered visitable
     * record in the compiled Tokyo pack was a motorway bridge.
     *
     * The rule the assertions encode: a corridor is worth what a corridor is
     * worth, and the ones that are destinations say so through evidence.
     */
    const weight = (category: string) =>
      classifySourceCategory({ category }).significanceWeight;
    for (const corridor of ['river', 'canal', 'bridge', 'viaduct', 'stream']) {
      expect(weight(corridor), corridor).toBeLessThan(weight('park'));
      expect(weight(corridor), corridor).toBeLessThan(weight('lake'));
      expect(weight(corridor), corridor).toBeLessThan(weight('museum'));
    }
    /* And the flowing-water leaves stay ordered among themselves. */
    expect(weight('stream')).toBeLessThan(weight('canal'));
    expect(weight('canal')).toBe(weight('river'));
  });

  it('gives every utility kind zero experience weight', () => {
    for (const key of ['railway', 'substation', 'bench', 'person', 'office']) {
      expect(classifySourceCategory({ category: key }).significanceWeight, key).toBe(0);
    }
    // Support stops carry a token weight — real, useful, never an experience.
    expect(classifySourceCategory({ category: 'parking' }).significanceWeight).toBeLessThanOrEqual(0.1);
  });

  it('marks bridges, viaducts, cemeteries and flowing water as evidence-gated', () => {
    /*
     * Flowing and artificial water joined the gated set for the bridge's own
     * reason: every named watercourse in a dense hydrography carries an
     * encyclopaedic entry, and on live metro boards six canals held seats at
     * one significance band over the destination's witnessed landmarks. A
     * lake — standing water people stand at — is the ungated control.
     */
    for (const key of ['bridge', 'viaduct', 'cemetery', 'graveyard', 'river', 'canal', 'stream', 'reservoir', 'pond']) {
      expect(classifySourceCategory({ category: key }).requiresSignificanceEvidence, key).toBe(true);
    }
    for (const key of ['museum', 'park', 'lake']) {
      expect(classifySourceCategory({ category: key }).requiresSignificanceEvidence, key).toBe(false);
    }
  });

  /**
   * A MEMORIAL IS AN ASSERTION OF REMEMBRANCE, NOT A KIND OF BUILDING.
   *
   * The three memorial leaves inherited the monument archetype whole — weight
   * 0.75, no witness — and everybody believed the family was gated because its
   * statuary sibling was. On a live dense-metro board the top-ordered card of
   * the worth-the-detour group, badged as the top pick, was a ward's
   * war-damage stone whose only page is the ministry registry that catalogues
   * such stones: an operator's asset list, the channel that may never decide
   * significance. So the family carries the cemetery's whole answer: a
   * witness before a traveller is sent, and the remembrance class priced at
   * the cemetery's register — below the built, ticketed `monument`, above
   * anonymous statuary — so an undersubscribed side-quest pool cannot seat a
   * bare stone on the kind alone, while a national cenotaph with a
   * knowledge-base entry competes through its evidence.
   */
  it('witness-gates the memorial family and prices the stone class honestly', () => {
    const weight = (category: string) =>
      classifySourceCategory({ category }).significanceWeight;
    for (const key of ['memorial', 'memorial_site', 'memorial_park']) {
      const classification = classifySourceCategory({
        category: key,
        path: ['cultural_and_historic', 'memorial_site'],
      });
      expect(classification.requiresSignificanceEvidence, key).toBe(true);
      /* Still a real remembrance kind: admitted with a witness, never erased. */
      expect(classification.role, key).toBe('side_quest');
      expect(classification.subrole, key).toBe('cultural');
      /* Priced as remembrance, not as a castle. */
      expect(weight(key), key).toBeLessThan(weight('monument'));
      expect(weight(key), key).toBeLessThanOrEqual(weight('cemetery'));
      expect(weight(key), key).toBeGreaterThanOrEqual(weight('sculpture_statue'));
    }
    /*
     * The bare `monument` leaf is gated now too — its unconditional admission
     * rested on "a mis-tag there is rare", and the anti-overfit metro pack
     * falsified that: seventeen roadside steles and site markers filed under
     * this one word held anchor-pool seats at kind-only 0.22 while the
     * destination's castle lost the same band's id lottery. The weight stays
     * — a witnessed monument is a real anchor — but the class needs
     * somebody's statement before a stone competes for seats.
     */
    expect(classifySourceCategory({ category: 'monument' }).requiresSignificanceEvidence).toBe(true);
  });

  /**
   * THE PATH HOLE A TRADING COMPANY RODE THROUGH.
   *
   * The catalogue files health-food retailers under `shopping > market >
   * health_market`. With no leaf of its own the word fell to the `market`
   * *path segment* one level up and inherited the full market admission —
   * board card, attraction seat, rainy-day shelf — and on a live board the
   * record wearing it was a trading company's registry row. A health market
   * is a shop a traveller provisions at, so it gets the grocery's answer.
   */
  it('classifies a health market as a shop, not a market', () => {
    const viaPath = classifySourceCategory({
      category: 'health_market',
      path: ['shopping', 'market', 'health_market'],
    });
    expect(viaPath.match).toEqual({ kind: 'source_leaf_category', key: 'health_market' });
    expect(viaPath.role).toBe('support');
    expect(viaPath.subrole).toBe('provisioning');
    /* The genuine market words underneath the same node are untouched. */
    for (const key of ['public_market', 'farmers_market', 'night_market']) {
      expect(classifySourceCategory({ category: key, path: ['shopping', 'market', key] }).role, key).toBe('market');
    }
  });

  /**
   * AN OPEN-AIR MARKET IS THE FIRST THING A DOWNPOUR CLOSES.
   *
   * `MARKET` says poor-weather backup, which is right for the covered hall
   * kinds and wrong for a street of stalls — and the board's reserve shelf
   * collects exactly that bit. A live dense-metro board shelved a night-stall
   * eatery and a late-night shop as rainy-day backups on the strength of it.
   * The bit is the class's honest answer, never a gate: every kind here keeps
   * its full market role.
   */
  it('does not offer an open-air market as a rainy-day backup', () => {
    for (const key of ['farmers_market', 'night_market', 'flea_market']) {
      const classification = classifySourceCategory({ category: key });
      expect(classification.poorWeatherBackup, key).toBe(false);
      expect(classification.role, key).toBe('market');
    }
    /* The covered kinds are real rain reserves and stay ones. */
    for (const key of ['market', 'marketplace', 'public_market', 'bazaar', 'food_hall']) {
      expect(classifySourceCategory({ category: key }).poorWeatherBackup, key).toBe(true);
    }
  });

  /**
   * A KIND OF BUILDING IS NOT AN ASSERTION ABOUT ONE.
   *
   * Global catalogues publish `historic_site` as an *interior node*, not a leaf:
   * a live New York pack carries `cultural_and_historic > historic_site > fort`
   * and `> historic_mission`, a live Tokyo pack carries `> palace`. A named child
   * says what the thing is and is admitted on that; the bare node is where a
   * catalogue puts a building whose use it did not state, which is why it is the
   * one entry in this family that has to be vouched for.
   *
   * `castle` had a leaf and its obvious twin did not, so `palace` inherited the
   * parent's rule and had to argue its way past a gate meant for commemorative
   * plaques — with nothing but the household agency's `.go.jp` page to argue
   * with. The building an entire imperial capital is arranged around is a *kind
   * of building*, and this is the assertion that it is treated as one.
   */
  it('admits the named building kinds under the historic node without a witness', () => {
    for (const key of ['castle', 'palace', 'fort', 'ruins', 'archaeological_site']) {
      const named = classifySourceCategory({
        category: key,
        path: ['cultural_and_historic', 'historic_site', key],
      });
      expect(named.role, key).toBe('attraction');
      expect(named.subrole, key).toBe('cultural');
      expect(named.requiresSignificanceEvidence, key).toBe(false);
      expect(named.match, key).toEqual({ kind: 'source_leaf_category', key });
    }

    /* And the bare node keeps the witness it needs, whichever spelling arrives. */
    for (const key of ['historic_site', 'historical_landmark', 'landmark_and_historical_building']) {
      expect(
        classifySourceCategory({ category: key, path: ['cultural_and_historic', 'historic_site'] })
          .requiresSignificanceEvidence,
        key,
      ).toBe(true);
    }
  });

  it('never routes a rail line to a scenic archetype, whatever the evidence', () => {
    for (const key of ['railway', 'railway_line', 'rail_line', 'subway_line', 'tram_line']) {
      const classification = classifySourceCategory({ category: key });
      expect(classification.subrole, key).toBe('utility');
      expect(classification.role, key).toBe('infrastructure');
    }
  });

  it('marks paid enclosures so interior features can be folded into them', () => {
    for (const key of ['theme_park', 'amusement_park', 'zoo', 'aquarium', 'water_park']) {
      expect(classifySourceCategory({ category: key }).paidEnclosure, key).toBe(true);
    }
    expect(classifySourceCategory({ category: 'national_park' }).paidEnclosure).toBe(false);
    expect(classifySourceCategory({ category: 'park' }).paidEnclosure).toBe(false);
  });

  it('marks large natural-feature claims for the plausibility gate', () => {
    for (const key of ['peak', 'summit', 'volcano', 'glacier', 'mountain_range']) {
      expect(classifySourceCategory({ category: key }).landscapeClaim, key).toBe(true);
    }
    expect(classifySourceCategory({ category: 'viewpoint' }).landscapeClaim).toBe(false);
  });

  /**
   * THE VOCABULARY GAP THE FRESH-PACK AUDIT FOUND, PINNED LEAF BY LEAF.
   *
   * A leaf the table does not know falls to its branch, and a branch match is
   * refused downstream ("a branch is not a permission"). That refusal is right
   * for gyms and fortune tellers — and it was silently eating whole *experience
   * kinds* whose only crime was arriving under the catalogue's own spelling: an
   * observation deck published as `observatory` under a science branch, a
   * wildlife sanctuary under `animal_attraction`, a Noh theatre as
   * `theatre_venue`, a war memorial park as `memorial_park`. Each key below is
   * a global-vocabulary word, none is a name, and each must resolve as a *leaf*
   * so the admission layer sees a named kind rather than an inferred family.
   */
  it('resolves the entertainment-branch experience kinds as leaves, not as branch guesses', () => {
    const cases: [string, string[], PlanningRole][] = [
      ['observatory', ['arts_and_entertainment', 'science_attraction', 'observatory'], 'outdoor'],
      ['wildlife_sanctuary', ['arts_and_entertainment', 'animal_attraction', 'wildlife_sanctuary'], 'outdoor'],
      ['theatre_venue', ['arts_and_entertainment', 'performing_arts_venue', 'theatre_venue'], 'attraction'],
      ['memorial_site', ['cultural_and_historic', 'memorial_site'], 'side_quest'],
      ['memorial_park', ['cultural_and_historic', 'memorial_site', 'memorial_park'], 'side_quest'],
      ['sculpture_statue', ['arts_and_entertainment', 'arts_and_crafts_space', 'sculpture_statue'], 'side_quest'],
    ];
    for (const [leaf, path, role] of cases) {
      const classification = classifySourceCategory({ category: leaf, path });
      expect(classification.match, leaf).toEqual({ kind: 'source_leaf_category', key: leaf });
      expect(classification.role, leaf).toBe(role);
    }
    /* An observation deck needs no witness — the kind is the offer... */
    expect(classifySourceCategory({ category: 'observatory' }).requiresSignificanceEvidence).toBe(false);
    /* ...while anonymous statuary does: most bronzes are garden ornament. */
    expect(classifySourceCategory({ category: 'sculpture_statue' }).requiresSignificanceEvidence).toBe(true);
    /*
     * And so do the two words a catalogue stretches furthest: measured on a
     * fresh pack, `wildlife_sanctuary` covered a company and a street of cats,
     * and `theatre_venue` covered ballet studios and a restaurant chain.
     */
    expect(classifySourceCategory({ category: 'wildlife_sanctuary' }).requiresSignificanceEvidence).toBe(true);
    expect(classifySourceCategory({ category: 'theatre_venue' }).requiresSignificanceEvidence).toBe(true);
    /* And the deliberately unlisted siblings still refuse through the branch. */
    const cabaret = classifySourceCategory({
      category: 'cabaret',
      path: ['arts_and_entertainment', 'performing_arts_venue', 'cabaret'],
    });
    expect(cabaret.match.kind).toBe('source_branch');

    /*
     * The venue precedent's newest member: an exhibition hall is an event
     * venue first and an occasional landmark second, so the kind resolves as
     * a leaf (honest noun, honest weight) and asks for a witness.
     */
    const expo = classifySourceCategory({
      category: 'exhibition_and_trade_fair_venue',
      path: ['arts_and_entertainment', 'exhibition_and_trade_fair_venue'],
    });
    expect(expo.match).toEqual({ kind: 'source_leaf_category', key: 'exhibition_and_trade_fair_venue' });
    expect(expo.requiresSignificanceEvidence).toBe(true);
    expect(expo.displayKind).toBe('Exhibition venue');
    expect(expo.significanceWeight).toBeLessThan(
      classifySourceCategory({ category: 'museum' }).significanceWeight,
    );
  });

  /**
   * A CITY'S MOST FAMOUS TEMPLE IS NOT PLUMBING.
   *
   * The vocabulary a global catalogue actually publishes for a worship
   * *building* is `*_place_of_worship` under a `place_of_worship` node — the
   * `temple` and `shrine` leaves never fire, because the source does not use
   * those tokens. This node was filed as a support stop, so on a fresh
   * dense-metro pack the destination's canonical temples normalised to the
   * same retention priority as a cash machine and were evicted before
   * eligibility ever ran.
   *
   * Both directions are asserted, because both are the guarantee. The kind is
   * an *experience*: attraction role, cultural archetype, a class weight the
   * retention layer prices as an experience rather than as plumbing. And the
   * kind is *gated*: a metropolis holds thousands of neighbourhood chapels and
   * congregation halls under exactly this word, so nothing under it reaches a
   * traveller without a witness — the same argument `historic_site` carries,
   * for the same reason.
   */
  it('types a worship building as a witness-gated experience, never as plumbing', () => {
    for (const leaf of [
      'buddhist_place_of_worship',
      'christian_place_of_worship',
      'shinto_place_of_worship',
    ]) {
      const worship = classifySourceCategory({
        category: leaf,
        path: ['cultural_and_historic', 'religious_organization', 'place_of_worship'],
      });
      expect(worship.role, leaf).toBe('attraction');
      expect(worship.subrole, leaf).toBe('cultural');
      expect(worship.match, leaf).toEqual({ kind: 'source_category_path', key: 'place_of_worship' });
      expect(worship.requiresSignificanceEvidence, leaf).toBe(true);
      /* Experience-weighted: above every support kind, below the named temple leaves. */
      expect(worship.significanceWeight, leaf).toBeGreaterThanOrEqual(0.5);
      expect(worship.significanceWeight, leaf).toBeLessThanOrEqual(
        classifySourceCategory({ category: 'buddhist_temple' }).significanceWeight,
      );
      expect(worship.displayKind, leaf).toBe('Place of worship');
    }

    /* The named building words stay unconditional — they say what the thing is. */
    for (const named of ['temple', 'shinto_shrine', 'cathedral', 'mosque']) {
      expect(classifySourceCategory({ category: named }).requiresSignificanceEvidence, named).toBe(false);
    }

    /* And a congregation filed under the bare organisation branch stays support. */
    const congregationBranch = classifySourceCategory({
      category: 'a_word_no_catalogue_publishes',
      path: ['community_and_government', 'religious_organization'],
    });
    expect(congregationBranch.role).toBe('support');
    expect(congregationBranch.subrole).toBe('civic');
  });

  it('excludes persons and companies however they arrive in the path', () => {
    const viaPath = classifySourceCategory({
      category: 'a_word_no_catalogue_publishes',
      path: ['person'],
    });
    expect(viaPath.role).toBe('excluded');
    expect(classifySourceCategory({ category: 'company' }).role).toBe('excluded');
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

describe('the denomination in a worship leaf is a claim, never a classifier', () => {
  /**
   * A live catalogue filed a country's most famous Shinto shrine under
   * `christian_place_of_worship`. The denomination half of these leaves is an
   * assertion no pack attribute can witness, and the one time it was checked
   * against ground truth it was simply wrong — so classification must never
   * read it: every `*_place_of_worship` spelling resolves to the same
   * denomination-neutral, witness-gated worship node, and none may inherit a
   * denominational building rule (a church's indoor, ungated admission) from
   * the word alone.
   */
  it('classifies every denominational spelling identically to the neutral node', () => {
    const neutral = classifySourceCategory({
      category: 'place_of_worship',
      path: ['cultural_and_historic', 'place_of_worship'],
    });
    for (const leaf of [
      'christian_place_of_worship',
      'shinto_place_of_worship',
      'jehovahs_witness_place_of_worship',
      'roman_catholic_place_of_worship',
    ]) {
      const denominational = classifySourceCategory({
        category: leaf,
        path: ['cultural_and_historic', 'place_of_worship', leaf],
      });
      expect(denominational.role, leaf).toBe(neutral.role);
      expect(denominational.subrole, leaf).toBe(neutral.subrole);
      expect(denominational.displayKind, leaf).toBe('Place of worship');
      expect(denominational.requiresSignificanceEvidence, leaf).toBe(true);
      expect(denominational.exposure, leaf).toBe(neutral.exposure);
      expect(denominational.significanceWeight, leaf).toBe(neutral.significanceWeight);
    }
  });

  it('recognises a bare denominational leaf with no path at all', () => {
    /*
     * A feature layer publishes the leaf without its branch chain. Before the
     * suffix rule that record fell through to the unknown-category refusal —
     * a worship building excluded because its catalogue omitted the path.
     */
    const bare = classifySourceCategory({ category: 'christian_place_of_worship' });
    expect(bare.role).toBe('attraction');
    expect(bare.subrole).toBe('cultural');
    expect(bare.displayKind).toBe('Place of worship');
    expect(bare.requiresSignificanceEvidence).toBe(true);
  });
});

describe('a historic claim contradicted by the record\'s own opening date', () => {
  /**
   * A tower that opened this century arrived as `historic_site` — the
   * catalogue's bare structural assertion — and was typed as historic ground.
   * Where the record itself states a modern opening, the assertion is
   * contradicted by the source's own evidence: the thing is a modern landmark,
   * and the card must not call it historic. The witness gate stays — a bare
   * assertion still needs somebody else to vouch for the visit.
   */
  it('retypes a this-century historic_site as a modern landmark, gate intact', () => {
    const modern = classifySourceCategory({
      category: 'historic_site',
      path: ['cultural_and_historic', 'historic_site'],
      attributes: { start_date: '2012' },
    });
    expect(modern.displayKind).toBe('Landmark');
    expect(modern.requiresSignificanceEvidence).toBe(true);
    /* The planning archetype is unchanged — only the claim is corrected. */
    expect(modern.category).toBe(
      classifySourceCategory({ category: 'historic_site' }).category,
    );
  });

  it('leaves a genuinely historic date and an undated record exactly alone', () => {
    const dated = classifySourceCategory({
      category: 'historic_site',
      path: ['cultural_and_historic', 'historic_site'],
      attributes: { start_date: '1877' },
    });
    expect(dated.displayKind).toBeUndefined();
    const undated = classifySourceCategory({
      category: 'historic_site',
      path: ['cultural_and_historic', 'historic_site'],
    });
    expect(undated.displayKind).toBeUndefined();
  });

  it('never reads the date into any other kind', () => {
    const modernMuseum = classifySourceCategory({
      category: 'museum',
      path: ['arts_and_entertainment', 'museum'],
      attributes: { start_date: '2015' },
    });
    expect(modernMuseum.displayKind).toBeUndefined();
    expect(modernMuseum.category).toBe('museum');
  });
});

describe('the vocabulary absorbs grammatical number, never meaning', () => {
  /**
   * Measured against the live release's own rows: seven leaves are published
   * only in the plural while the table keys the singular, and one of those
   * misses sent a destination's single most-visited paid attraction to
   * `insufficient_travel_value` — an unrecognised leaf falls to its branch,
   * and the branch is refused without a witness. The lookup, not the table,
   * absorbs number: a de-pluralised form is accepted only where the stem is
   * already a key, so the fallback can re-spell a known kind and can never
   * invent one.
   */
  it('resolves a plural leaf to the singular rule, as a leaf match', () => {
    const plural = classifySourceCategory({ category: 'hot_springs' });
    const singular = classifySourceCategory({ category: 'hot_spring' });
    expect(plural.category).toBe(singular.category);
    expect(plural.role).toBe(singular.role);
    expect(plural.significanceWeight).toBe(singular.significanceWeight);
    expect(plural.match).toEqual({ kind: 'source_leaf_category', key: 'hot_spring' });

    /* And an excluded kind's plural resolves to the same refusal, not a
     * branch guess: a cash machine is a cash machine in any number. */
    expect(classifySourceCategory({ category: 'atms' }).role).toBe(
      classifySourceCategory({ category: 'atm' }).role,
    );
    expect(classifySourceCategory({ category: 'cemeteries' }).requiresSignificanceEvidence).toBe(
      true,
    );
  });

  it('does not conjure a rule for a plural whose stem is not in the table', () => {
    const unknown = classifySourceCategory({ category: 'zzz_unknown_things' });
    expect(unknown.match.kind).toBe('no_recognised_category');
  });
});

describe('a peak claim the record’s own elevation contradicts', () => {
  /**
   * Terrain layers file every named rise under `peak`, and live metro boards
   * seated 26–45 m artificial mounds at the summit archetype's weight — each
   * carrying the encyclopaedic entry every named rise in a dense mapping
   * does. Where the record itself states a metres-scale elevation, the rule
   * drops to the low-relief grade with a witness requirement; a stated high
   * elevation, or no stated elevation at all, leaves the archetype alone.
   */
  it('demotes a metres-scale peak to the hill grade and asks for a witness', () => {
    const mound = classifySourceCategory({ category: 'peak', attributes: { ele: '39' } });
    expect(mound.displayKind).toBe('Hill');
    expect(mound.significanceWeight).toBe(0.2);
    expect(mound.requiresSignificanceEvidence).toBe(true);
    /* The claim stays visible to the extent plausibility gate. */
    expect(mound.landscapeClaim).toBe(true);
  });

  it('leaves a real summit and an elevation-silent peak alone', () => {
    const summit = classifySourceCategory({ category: 'peak', attributes: { ele: '1009' } });
    const silent = classifySourceCategory({ category: 'peak' });
    expect(summit.significanceWeight).toBe(0.5);
    expect(summit.requiresSignificanceEvidence).toBe(false);
    expect(silent.significanceWeight).toBe(0.5);
  });
});

/**
 * THE INTEREST A KIND CLAIMS IS THE ONE ITS OWN WORD SUPPORTS.
 *
 * ---
 *
 * **The live evidence class.** Three delivered boards of 2026-08-26. Every
 * record filed under the catalogue's `observatory` word carried `stargazing`,
 * and a destination's principal observation tower was sold to the traveller as
 * that interest delivered; every record filed under `amusement_park` carried
 * `easy_nature_walks`, and two of them — one per destination — were sold as
 * easy nature walks. Neither interest is anywhere in the archetype those leaves
 * classify to; both arrived through the core's keyword channel, which matched
 * `observatory` (a word this catalogue publishes for an observation *deck* —
 * see the leaf's own rule) and matched `park` inside `amusement_park`.
 *
 * **What this drives.** `classifySourceCategory` is the production stamper:
 * `interestsFor` reads the intake's `INTEREST_EVIDENCE` table through
 * `evidencedInterests` and writes the result onto every compiled place, and
 * `place.interests` is what the board's `matchedInterests` chips and the fit
 * model's "that is what this delivers" sentence are both built from. Asserting
 * here is asserting on the field the traveller reads.
 */
describe('a stamped interest traces to the record’s own kind', () => {
  it('does not read a night-sky interest out of an observation deck', () => {
    const deck = classifySourceCategory({
      category: 'observatory',
      path: ['arts_and_entertainment', 'science_attraction', 'observatory'],
    });
    /* The deck is a viewpoint, and its viewpoint interests are untouched. */
    expect(deck.category).toBe('viewpoint');
    expect(deck.interests).toContain('scenic_viewpoints');
    expect(deck.interests).toContain('photography_golden_hour');
    /* And it makes no claim about the night sky. */
    expect(deck.interests).not.toContain('stargazing');
  });

  it('does not read a green-space interest out of a ticketed enclosure', () => {
    for (const leaf of ['amusement_park', 'theme_park', 'water_park']) {
      const enclosure = classifySourceCategory({ category: leaf });
      expect(enclosure.paidEnclosure, leaf).toBe(true);
      expect(enclosure.interests, leaf).not.toContain('easy_nature_walks');
    }
    /* While actual green space keeps it, through the same table. */
    expect(classifySourceCategory({ category: 'park' }).interests).toContain('easy_nature_walks');
    expect(classifySourceCategory({ category: 'botanical_garden' }).interests).toContain(
      'easy_nature_walks',
    );
    expect(classifySourceCategory({ category: 'national_park' }).interests).toContain(
      'easy_nature_walks',
    );
  });

  /**
   * WHERE THE CATALOGUE'S WORD SUPPORTS NOTHING, NOTHING IS STAMPED.
   *
   * The other half of the invariant, and the one a keyword table makes easy to
   * lose: with `observatory` removed from the night-sky row, no leaf in the
   * whole vocabulary evidences `stargazing` any more except the two that name a
   * night-sky facility outright. The correct output for every other record is
   * *no claim*, not a weaker claim and not a nearby one.
   */
  it('says nothing about the night sky for any kind that cannot support it', () => {
    for (const leaf of knownCategoryKeys().leaves) {
      const stamped = classifySourceCategory({ category: leaf }).interests;
      if (leaf === 'planetarium') {
        expect(stamped, leaf).toContain('stargazing');
        continue;
      }
      expect(stamped, leaf).not.toContain('stargazing');
    }
  });

  /**
   * A keyword may not be read out of the middle of a word.
   *
   * The generic form of both defects above, measured across the whole table:
   * `market` sat inside `supermarket`, `quarter` inside
   * `corporate_headquarters`, `park` inside `bicycle_parking`. Each one is a
   * different kind of place claiming an interest on a spelling coincidence.
   */
  it('reads keywords as whole tokens, not as substrings of a longer word', () => {
    expect(classifySourceCategory({ category: 'supermarket' }).interests).not.toContain(
      'markets_and_street_food',
    );
    expect(classifySourceCategory({ category: 'corporate_headquarters' }).interests).not.toContain(
      'neighbourhoods_and_local_life',
    );
    expect(classifySourceCategory({ category: 'bicycle_parking' }).interests).not.toContain(
      'easy_nature_walks',
    );
    /* And the compounds the keywords are actually for still resolve. */
    expect(classifySourceCategory({ category: 'night_market' }).interests).toContain(
      'markets_and_street_food',
    );
    expect(classifySourceCategory({ category: 'marketplace' }).interests).toContain(
      'markets_and_street_food',
    );
    expect(classifySourceCategory({ category: 'shinto_shrine' }).interests).toContain(
      'architecture_and_landmarks',
    );
    expect(classifySourceCategory({ category: 'hot_springs' }).interests).toContain('hot_springs');
  });
});
