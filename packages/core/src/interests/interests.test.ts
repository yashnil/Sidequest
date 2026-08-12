import { describe, expect, it } from 'vitest';
import { EASTERN_SIERRA_PLACES } from '../data/places';
import { INTERESTS, interestLevelsSchema } from '../schemas/common';
import {
  destinationClassesFrom,
  interestOffer,
  interestOfferFromEntityType,
  interestOfferFromRegion,
  interestSupport,
  MAX_OFFERED_INTERESTS,
  placeEvidences,
  type InterestEvidenceSubject,
} from './offer';
import { UNIVERSAL_INTERESTS } from './vocabulary';

/**
 * A compiled place, at the resolution the offer actually reads it.
 *
 * Compiled places carry the source's own leaf category as their first tag —
 * `places=shinto_shrine` — and that is the only channel with the resolution to
 * tell a shrine from a castle, because the thirteen-value planning vocabulary
 * cannot. The fixtures below therefore look exactly like compiler output and
 * nothing here hand-writes an interest tag except where a real classifier would.
 */
function subject(
  category: InterestEvidenceSubject['category'],
  sourceCategory: string,
  overrides: Partial<InterestEvidenceSubject> = {},
): InterestEvidenceSubject {
  return {
    category,
    interests: [],
    tags: [`places=${sourceCategory}`, 'attr:website', 'role:attraction'],
    ...overrides,
  };
}

/** A dense city: museums, shrines, neighbourhoods, markets, a park, a river. */
const URBAN_REGION: InterestEvidenceSubject[] = [
  subject('museum', 'art_museum'),
  subject('museum', 'history_museum'),
  subject('museum', 'science_museum'),
  subject('historic_site', 'shinto_shrine'),
  subject('historic_site', 'buddhist_temple'),
  subject('historic_site', 'imperial_palace'),
  subject('town_and_food', 'neighborhood', { displayKind: 'Neighbourhood' }),
  subject('town_and_food', 'neighborhood', { displayKind: 'Neighbourhood' }),
  subject('town_and_food', 'public_market'),
  subject('town_and_food', 'night_market'),
  subject('easy_walk', 'park'),
  subject('easy_walk', 'botanical_garden'),
  subject('viewpoint', 'observation_deck'),
  subject('lake', 'river', { displayKind: 'River' }),
];

/** A mountain valley: trails, a pass, thermal ground, lakes, a viewpoint. */
const MOUNTAIN_REGION: InterestEvidenceSubject[] = [
  subject('day_hike', 'hiking_trail'),
  subject('day_hike', 'hiking_trail'),
  subject('day_hike', 'summit_trail'),
  subject('lake', 'lake'),
  subject('lake', 'lake'),
  subject('lake', 'waterfall', { displayKind: 'Waterfall' }),
  subject('viewpoint', 'scenic_viewpoint'),
  subject('viewpoint', 'scenic_viewpoint'),
  subject('scenic_drive', 'mountain_pass'),
  subject('scenic_drive', 'scenic_byway'),
  subject('geothermal', 'geyser'),
  subject('hot_spring', 'hot_spring'),
  subject('easy_walk', 'nature_trail'),
  subject('town_and_food', 'restaurant'),
];

describe('the interest vocabulary stays readable for people who already answered', () => {
  it('keeps every interest id that has ever been offered', () => {
    /*
     * The one property a stored profile depends on. An id removed here is a
     * preference somebody stated that silently stops being read; a renamed one
     * is the same failure wearing a new name. Growth is fine, loss is not.
     */
    for (const legacy of [
      'hiking',
      'easy_nature_walks',
      'scenic_viewpoints',
      'lakes_and_rivers',
      'scenic_drives',
      'wildlife',
      'geology_and_geothermal',
      'hot_springs',
      'history_and_culture',
      'food_and_towns',
      'photography_golden_hour',
      'stargazing',
    ]) {
      expect(INTERESTS).toContain(legacy);
    }
  });

  it('reads an answer set written before the newer interests existed', () => {
    /*
     * The regression this schema change exists to prevent: `z.record` over an
     * enum is exhaustive, so growing the vocabulary used to make every stored
     * questionnaire unparseable. A traveller does not lose a completed intake
     * because we learned a new word.
     */
    const stored = {
      hiking: 'core',
      easy_nature_walks: 'occasional',
      scenic_viewpoints: 'frequent',
      lakes_and_rivers: 'frequent',
      scenic_drives: 'occasional',
      wildlife: 'low',
      geology_and_geothermal: 'occasional',
      hot_springs: 'low',
      history_and_culture: 'low',
      food_and_towns: 'occasional',
      photography_golden_hour: 'occasional',
      stargazing: 'low',
    };
    const parsed = interestLevelsSchema.safeParse(stored);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.hiking).toBe('core');
    expect(parsed.success && parsed.data.museums_and_galleries).toBeUndefined();
  });

  it('refuses a level that is not in the ladder', () => {
    expect(interestLevelsSchema.safeParse({ hiking: 'sometimes' }).success).toBe(false);
  });
});

describe('what a destination is asked about comes from what is in it', () => {
  it('offers a city its own vocabulary and withholds the mountain one', () => {
    const offer = interestOfferFromRegion({ places: URBAN_REGION });

    expect(offer.basis).toBe('region_evidence');
    expect(offer.classes).toContain('urban');
    for (const urban of [
      'museums_and_galleries',
      'architecture_and_landmarks',
      'neighbourhoods_and_local_life',
      'markets_and_street_food',
    ] as const) {
      expect(offer.interests).toContain(urban);
    }
    /*
     * The verbatim defect: a traveller planning a metropolis graded scenic
     * drives, geothermal ground, hot springs and stargazing, and those graded
     * answers then steered candidate acquisition — which is how the research
     * pipeline came to search a city for mountain-town material.
     */
    for (const absent of [
      'scenic_drives',
      'geology_and_geothermal',
      'hot_springs',
      'stargazing',
      'beaches_and_swimming',
    ] as const) {
      expect(offer.interests).not.toContain(absent);
    }
  });

  it('offers a mountain region its own vocabulary and withholds the urban one', () => {
    const offer = interestOfferFromRegion({ places: MOUNTAIN_REGION });

    expect(offer.classes).toContain('mountain');
    for (const mountain of [
      'hiking',
      'scenic_drives',
      'hot_springs',
      'geology_and_geothermal',
      'lakes_and_rivers',
    ] as const) {
      expect(offer.interests).toContain(mountain);
    }
    for (const absent of [
      'museums_and_galleries',
      'neighbourhoods_and_local_life',
      'markets_and_street_food',
      'beaches_and_swimming',
    ] as const) {
      expect(offer.interests).not.toContain(absent);
    }
  });

  it('reads the authored mountain region as a mountain region', () => {
    // Not a synthetic fixture: the seed places the product actually ships.
    const offer = interestOfferFromRegion({ places: EASTERN_SIERRA_PLACES });
    expect(offer.classes).toContain('mountain');
    expect(offer.interests).toContain('hiking');
    expect(offer.interests).toContain('hot_springs');
    expect(offer.interests).not.toContain('museums_and_galleries');
  });

  it('never offers a row longer than a screen', () => {
    const offer = interestOfferFromRegion({ places: [...URBAN_REGION, ...MOUNTAIN_REGION] });
    expect(offer.interests.length).toBeLessThanOrEqual(MAX_OFFERED_INTERESTS);
  });

  it('asks about eating when the food lives in the food dataset rather than the places', () => {
    /*
     * A region's restaurants are venues, not places, so a city whose only food
     * is in the food dataset would otherwise never be asked whether food
     * matters — and the answer is what decides how hard the food layer looks.
     */
    const noFoodPlaces = URBAN_REGION.filter((place) => place.category !== 'town_and_food');
    const withoutVenues = interestOfferFromRegion({ places: noFoodPlaces });
    const withVenues = interestOfferFromRegion({ places: noFoodPlaces, foodVenueCount: 24 });

    expect(withoutVenues.interests).not.toContain('food_and_towns');
    expect(withVenues.interests).toContain('food_and_towns');
  });

  it('falls back to the whole vocabulary rather than withholding from ignorance', () => {
    // Nothing known is not the same claim as nothing here.
    expect(interestOffer({}).basis).toBe('whole_vocabulary');
    expect(interestOffer({}).interests).toEqual([...INTERESTS]);
    expect(interestOfferFromRegion({ places: [] }).basis).toBe('whole_vocabulary');
  });

  it('uses the resolved entity type before anything has been researched', () => {
    /*
     * The path that matters most, because the questionnaire runs *before* the
     * compilation. `GeographicScope.destinationEntityType` is confirmed at scope
     * time and is therefore the only destination context the intake has when the
     * traveller is actually answering — which is the moment a city traveller was
     * being asked to grade scenic drives and hot springs.
     */
    const city = interestOfferFromEntityType('city');
    expect(city.basis).toBe('destination_class');
    expect(city.interests).toContain('museums_and_galleries');
    expect(city.interests).not.toContain('hot_springs');
    // Shorter than the whole vocabulary, which is the burden half of §6.1.
    expect(city.interests.length).toBeLessThan(INTERESTS.length);
    for (const absent of ['scenic_drives', 'geology_and_geothermal', 'stargazing'] as const) {
      expect(city.interests).not.toContain(absent);
    }

    const park = interestOfferFromEntityType('protected_area');
    expect(park.interests).toContain('hiking');
    expect(park.interests).not.toContain('museums_and_galleries');

    // An entity type with no class is answered honestly, not guessed at.
    expect(interestOfferFromEntityType('unknown').basis).toBe('whole_vocabulary');
  });

  it('always keeps the universal core when the region evidences it', () => {
    const offer = interestOfferFromRegion({ places: URBAN_REGION });
    for (const universal of UNIVERSAL_INTERESTS) {
      const supported = interestSupport(URBAN_REGION)[universal] > 0;
      if (supported) expect(offer.interests).toContain(universal);
    }
  });
});

describe('evidence is read from the record, not from the destination name', () => {
  it('recognises a shrine, a market and a beach from the source category alone', () => {
    expect(
      placeEvidences(subject('historic_site', 'shinto_shrine'), 'architecture_and_landmarks'),
    ).toBe(true);
    expect(placeEvidences(subject('town_and_food', 'night_market'), 'markets_and_street_food')).toBe(
      true,
    );
    expect(
      placeEvidences(
        subject('lake', 'beach', { displayKind: 'Beach' }),
        'beaches_and_swimming',
      ),
    ).toBe(true);
  });

  it('does not manufacture evidence out of an attribute name', () => {
    /*
     * Compiled places tag the *names* of the attributes a source recorded. A
     * naive substring search across the whole tag list would read
     * `attr:marketing_name` as proof of a market, which is a field label rather
     * than a place.
     */
    const withAttribute: InterestEvidenceSubject = {
      category: 'viewpoint',
      interests: [],
      tags: ['places=scenic_viewpoint', 'attr:marketing_name', 'attr:beach_access'],
    };
    expect(placeEvidences(withAttribute, 'markets_and_street_food')).toBe(false);
    expect(placeEvidences(withAttribute, 'beaches_and_swimming')).toBe(false);
  });

  it('trusts the classifier when the place already claims the interest', () => {
    const tagged: InterestEvidenceSubject = {
      category: 'easy_walk',
      interests: ['stargazing'],
      tags: [],
    };
    expect(placeEvidences(tagged, 'stargazing')).toBe(true);
  });

  it('calls a region with nothing distinctive countryside rather than nothing', () => {
    const bland = [subject('easy_walk', 'park'), subject('town_and_food', 'restaurant')];
    expect(destinationClassesFrom(interestSupport(bland), bland.length)).toEqual(['countryside']);
  });
});
