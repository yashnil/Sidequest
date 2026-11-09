/**
 * THE GLOBAL BENCHMARK: WHAT REAL TRAVELLERS TYPE, AND WHAT MUST BE TRUE OF THE ANSWER.
 *
 * One request is a sentence somebody might type into "Help me choose", plus
 * properties of a good answer that can be **measured against the world**, not
 * against a list of expected places: where the picks are, whether the activity
 * asked for is feasible there in those months according to climate normals,
 * what the country's price level is, how far it is. No request names the
 * destination it hopes to see — a benchmark that did would be tuning the
 * recommender to the test — but a request that names a geography ("the
 * Karakoram", "Indonesia") is checked against that geography's own bounds.
 *
 * The same file is run against the frozen 234-destination recommender
 * (`docs/global-destinations/baseline/`) and against the global one, so every
 * before/after number comes from identical inputs.
 */

/** [minLat, minLng, maxLat, maxLng]; a box may cross the antimeridian (minLng > maxLng). */
export type Box = [number, number, number, number];

/** What a traveller is there to do, in the vocabulary of the activity-season model. */
export type BenchActivity =
  | 'hike'
  | 'trek_high'
  | 'beach'
  | 'dive'
  | 'ski'
  | 'safari'
  | 'city'
  | 'rainforest'
  | 'desert'
  | 'road_trip'
  | 'lakes';

export interface BenchChecks {
  /** Every primary pick lies in one of these countries (ISO 3166-1 alpha-2). */
  countries?: string[];
  /** Every primary pick's centre lies in one of these boxes. */
  boxes?: Box[];
  /** The months the traveller can go; activity and warmth checks read these. */
  months?: number[];
  /** The activity must be feasible at every primary pick in at least one of `months`, by measured climate. */
  feasible?: BenchActivity[];
  /** Every primary pick is in a country whose price level (US = 1) is at most this. */
  maxPriceLevel?: number;
  /** Measured mean daily high in the best of `months` is at least / at most this (°C). */
  minHighC?: number;
  maxHighC?: number;
  /** Every primary pick is within this many km of the named origin. */
  within?: { origin: string; km: number };
  /** Every primary pick is one of these kinds. */
  kinds?: string[];
  /** Every primary pick scores at least 1.5 of 3 on one of these experiences. */
  offers?: string[];
  /** At least this many primary picks are little known (familiarity ≤ 1). */
  littleKnown?: number;
  /** No primary pick is the place the traveller compared against. */
  notNamed?: string[];
  /** Every primary pick is doable without a car. */
  carFree?: boolean;
  /** Every primary pick suits children (family ≥ 2 where known). */
  family?: boolean;
}

export interface BenchRequest {
  id: string;
  /** The trip type this request represents, for coverage tables. */
  category: string;
  text: string;
  checks: BenchChecks;
  /** True when the request is deliberately vague, contradictory or hard. */
  hard?: boolean;
}

const KARAKORAM: Box = [34.0, 72.5, 37.2, 78.5];
const HAWAII: Box = [18.5, -161, 22.6, -154.5];
const PATAGONIA: Box = [-56, -76, -38.5, -62];
const ALPS: Box = [43.5, 5, 48.5, 16.5];
const CENTRAL_ASIA = ['KZ', 'KG', 'TJ', 'UZ', 'TM'];
const SUB_SAHARAN_SAFARI = ['KE', 'TZ', 'UG', 'RW', 'ZA', 'BW', 'NA', 'ZM', 'ZW', 'MW', 'MZ', 'ET', 'SZ', 'AO', 'CG', 'GA', 'CM', 'SN', 'GH', 'BJ', 'TD', 'CF', 'CD', 'SS', 'LS'];
const EUROPE = ['AL', 'AD', 'AT', 'BY', 'BE', 'BA', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IS', 'IE', 'IT', 'XK', 'LV', 'LI', 'LT', 'LU', 'MT', 'MD', 'MC', 'ME', 'NL', 'MK', 'NO', 'PL', 'PT', 'RO', 'SM', 'RS', 'SK', 'SI', 'ES', 'SE', 'CH', 'UA', 'GB', 'VA', 'FO', 'GI', 'IM', 'JE', 'GG', 'TR', 'GE', 'AM', 'AZ', 'RU', 'AX', 'SJ'];
const SOUTHEAST_ASIA = ['ID', 'TH', 'VN', 'MY', 'PH', 'KH', 'LA', 'MM', 'SG', 'BN', 'TL'];
const BALKANS = ['AL', 'BA', 'BG', 'HR', 'XK', 'ME', 'MK', 'RO', 'RS', 'SI', 'GR'];
const ANDES = ['PE', 'BO', 'EC', 'CO', 'CL', 'AR', 'VE'];
const CARIBBEAN_BOX: Box = [9.5, -90, 27.5, -59];

export const BENCH_REQUESTS: readonly BenchRequest[] = [
  /* ── The brief's own examples, one or more phrasings each ──────────────── */
  { id: 'karakoram-budget-trek', category: 'trekking', text: 'Budget trekking in the Karakoram in July, two weeks, happy with basic guesthouses.', checks: { boxes: [KARAKORAM], months: [7], feasible: ['trek_high'], maxPriceLevel: 0.5 } },
  { id: 'karakoram-pakistan-mountains', category: 'trekking', text: 'I want big mountain scenery in northern Pakistan in August without spending much.', checks: { countries: ['PK'], months: [8], feasible: ['hike'], maxPriceLevel: 0.5 } },
  { id: 'hawaii-volcano-beach', category: 'islands', text: 'Volcanoes and beaches in Hawaii for ten days in February.', checks: { boxes: [HAWAII], months: [2], feasible: ['beach'] } },
  { id: 'hawaii-family', category: 'islands', text: 'A week in Hawaii with two kids in April, snorkelling and easy hikes, we will rent a car.', checks: { boxes: [HAWAII], months: [4], feasible: ['beach', 'hike'] } },
  { id: 'japan-spring-culture', category: 'culture', text: 'A spring cultural trip in Japan, temples, gardens and food, about 12 days in early April.', checks: { countries: ['JP'], months: [4], feasible: ['city'], offers: ['villages_culture', 'food', 'city_life'] } },
  { id: 'japan-autumn-quiet', category: 'culture', text: 'Japan in November for autumn colours and old towns, somewhere less crowded than Kyoto.', checks: { countries: ['JP'], months: [11], feasible: ['city'], notNamed: ['Kyoto'] } },
  { id: 'central-asia-remote-hiking', category: 'trekking', text: 'Remote hiking in Central Asia in August, I want to be far from crowds and I am fit.', checks: { countries: CENTRAL_ASIA, months: [8], feasible: ['hike'], offers: ['day_hiking', 'multi_day_trekking', 'high_mountains'] } },
  { id: 'central-asia-silk-road', category: 'culture', text: 'Silk Road cities and mountain lakes in Central Asia, two weeks in September, moderate budget.', checks: { countries: CENTRAL_ASIA, months: [9], feasible: ['city'] } },
  { id: 'indonesia-islands', category: 'islands', text: 'Tropical islands in Indonesia in July, snorkelling and quiet beaches, not Bali.', checks: { countries: ['ID'], months: [7], feasible: ['beach', 'dive'], notNamed: ['Bali'] } },
  { id: 'indonesia-diving', category: 'diving', text: 'World-class diving in Indonesia in October, two weeks, happy to take small boats.', checks: { countries: ['ID'], months: [10], feasible: ['dive'], offers: ['snorkel_dive'] } },
  { id: 'europe-city-break-spring', category: 'city_break', text: 'A long weekend city break in Europe in May, good food and museums, flying from London.', checks: { countries: EUROPE, months: [5], feasible: ['city'], within: { origin: 'London', km: 3200 }, offers: ['city_life', 'food'], carFree: true } },
  { id: 'europe-city-break-winter', category: 'city_break', text: 'Four nights in a European city in December for Christmas markets and cosy cafes.', checks: { countries: EUROPE, months: [12], offers: ['city_life', 'villages_culture'], carFree: true } },
  { id: 'europe-city-break-underrated', category: 'city_break', text: 'An underrated European city for three nights in October, not the usual capitals, cheap and walkable.', checks: { countries: EUROPE, months: [10], feasible: ['city'], maxPriceLevel: 0.75, carFree: true } },
  { id: 'africa-safari-august', category: 'safari', text: 'A safari in Africa in August, we want to see the big cats, 10 nights, comfortable lodges.', checks: { countries: SUB_SAHARAN_SAFARI, months: [8], feasible: ['safari'], offers: ['big_game_safari'] } },
  { id: 'africa-safari-february', category: 'safari', text: 'Safari in February with a moderate budget, where is good that time of year?', checks: { countries: SUB_SAHARAN_SAFARI, months: [2], feasible: ['safari'], offers: ['big_game_safari'] } },
  { id: 'africa-safari-budget', category: 'safari', text: 'Affordable self-drive safari in southern Africa in June for two weeks.', checks: { countries: ['ZA', 'NA', 'BW', 'ZW', 'ZM', 'SZ', 'MZ', 'LS', 'MW'], months: [6], feasible: ['safari'], offers: ['big_game_safari'] } },
  { id: 'patagonia-summer', category: 'trekking', text: 'Patagonia in January: glaciers, granite towers and long day hikes, about 12 nights.', checks: { boxes: [PATAGONIA], months: [1], feasible: ['hike'], offers: ['day_hiking', 'multi_day_trekking', 'glaciers_ice'] } },
  { id: 'patagonia-roadtrip', category: 'road_trip', text: 'A road trip through Patagonia in December with some hiking and wildlife.', checks: { boxes: [PATAGONIA], months: [12], feasible: ['hike', 'road_trip'] } },
  { id: 'alpine-hiking-september', category: 'hiking', text: 'Alpine hiking in September, hut to hut for a week, high trails and big views.', checks: { months: [9], feasible: ['trek_high'], offers: ['multi_day_trekking', 'high_mountains', 'day_hiking'] } },
  { id: 'alps-september-quiet', category: 'hiking', text: 'Hiking in the Alps in late September, somewhere quieter than Chamonix and Zermatt.', checks: { boxes: [ALPS], months: [9], feasible: ['hike'], notNamed: ['Chamonix', 'Zermatt'] } },
  { id: 'winter-sports-february', category: 'winter', text: 'Winter sports in February: reliable snow, good skiing and a lively village, one week.', checks: { months: [2], feasible: ['ski'], offers: ['winter_snow'] } },
  { id: 'winter-sports-budget', category: 'winter', text: 'Cheap skiing in February, we do not need a famous resort, just good snow and low prices.', checks: { months: [2], feasible: ['ski'], offers: ['winter_snow'], maxPriceLevel: 0.7 } },
  { id: 'winter-sports-japan', category: 'winter', text: 'Powder skiing in Japan in January and hot springs afterwards.', checks: { countries: ['JP'], months: [1], feasible: ['ski'], offers: ['winter_snow'] } },
  { id: 'rainforest-wildlife', category: 'rainforest', text: 'Rainforest and wildlife: monkeys, birds, sloths. Two weeks in March, moderate budget.', checks: { months: [3], feasible: ['rainforest'], offers: ['rainforest_biodiversity', 'wildlife_general'] } },
  { id: 'rainforest-borneo-like', category: 'rainforest', text: 'Jungle trekking and orangutans in July, we are fine with basic lodges and humidity.', checks: { months: [7], feasible: ['rainforest'], offers: ['rainforest_biodiversity'] } },
  { id: 'amazon-august', category: 'rainforest', text: 'The Amazon in August for ten days, river lodges and wildlife.', checks: { countries: ['BR', 'PE', 'EC', 'CO', 'BO', 'GY', 'SR', 'VE', 'GF'], months: [8], feasible: ['rainforest'] } },
  { id: 'family-limited-driving', category: 'family', text: 'A family trip in July with two children aged 6 and 9, beaches and easy walks, we do not want to drive much.', checks: { months: [7], feasible: ['beach'], family: true } },
  { id: 'family-no-car-europe', category: 'family', text: 'Family holiday in Europe in August with kids, no car, trains and lakes and easy mountain walks.', checks: { countries: EUROPE, months: [8], feasible: ['hike'], carFree: true, family: true } },
  { id: 'rail-multi-country', category: 'rail', text: 'A multi-country rail journey in Europe in June, two weeks, scenic trains and old towns.', checks: { countries: EUROPE, months: [6], feasible: ['city'], offers: ['rail_journeys'], carFree: true } },
  { id: 'rail-asia', category: 'rail', text: 'A scenic train trip somewhere in Asia in November, 10 days, culture and food along the way.', checks: { months: [11], offers: ['rail_journeys'], carFree: true } },
  { id: 'like-dolomites-cheaper', category: 'similar', text: 'I want somewhere like the Dolomites, but less crowded and cheaper, in early September.', checks: { months: [9], feasible: ['hike'], offers: ['high_mountains', 'day_hiking'], maxPriceLevel: 0.75, notNamed: ['Dolomites'] } },
  { id: 'like-amalfi-quieter', category: 'similar', text: 'Somewhere like the Amalfi Coast but quieter and less expensive, in June.', checks: { months: [6], feasible: ['beach'], offers: ['coastal_scenery', 'beaches_swimming'], notNamed: ['Amalfi'] } },
  { id: 'like-iceland-cheaper', category: 'similar', text: 'Landscapes like Iceland but cheaper and less touristy, in July.', checks: { months: [7], feasible: ['hike'], maxPriceLevel: 0.9, notNamed: ['Iceland'] } },
  { id: 'like-santorini-uncrowded', category: 'similar', text: 'An island like Santorini without the cruise crowds, in September.', checks: { months: [9], feasible: ['beach'], notNamed: ['Santorini'] } },
  { id: 'like-banff-quiet', category: 'similar', text: 'An underrated alternative to Banff: turquoise lakes and mountains with fewer people, in August.', checks: { months: [8], feasible: ['hike'], offers: ['lakes', 'high_mountains'], notNamed: ['Banff'] } },
  { id: 'remote-mountains-september', category: 'hiking', text: 'Remote mountains, incredible hiking, beautiful lakes, inexpensive, September, not too cold.', checks: { months: [9], feasible: ['hike'], offers: ['high_mountains', 'day_hiking', 'lakes'], maxPriceLevel: 0.65, minHighC: 12 } },

  /* ── Mountains and walking ──────────────────────────────────────────────── */
  { id: 'himalaya-october', category: 'trekking', text: 'A classic Himalayan trek in October, teahouses, about 14 days.', checks: { countries: ['NP', 'IN', 'BT', 'PK', 'CN'], months: [10], feasible: ['trek_high'], offers: ['multi_day_trekking'] } },
  { id: 'andes-trek-june', category: 'trekking', text: 'High-altitude trekking in the Andes in June, I have done Kilimanjaro and want something wilder.', checks: { countries: ANDES, months: [6], feasible: ['trek_high'], offers: ['multi_day_trekking', 'high_mountains'] } },
  { id: 'caucasus-hiking', category: 'hiking', text: 'Hiking in the Caucasus in July, village to village, cheap guesthouses and big peaks.', checks: { countries: ['GE', 'AM', 'AZ', 'RU'], months: [7], feasible: ['hike'], maxPriceLevel: 0.6 } },
  { id: 'spring-hiking-no-snow', category: 'hiking', text: 'Hiking in April without snow on the trails, warm days, somewhere in Europe.', checks: { countries: EUROPE, months: [4], feasible: ['hike'], minHighC: 14 } },
  { id: 'march-mountains-budget', category: 'hiking', text: 'March 19-27, mountains and hiking, on a budget.', checks: { months: [3], feasible: ['hike'], maxPriceLevel: 0.7 } },
  { id: 'winter-sun-walking', category: 'hiking', text: 'Winter sun and good walking in January, flying from Manchester, one week.', checks: { months: [1], feasible: ['hike'], minHighC: 15, within: { origin: 'Manchester', km: 5000 } } },
  { id: 'usa-national-parks-autumn', category: 'hiking', text: 'US national parks in October: red rock, canyons and day hikes, ten days with a car.', checks: { countries: ['US'], months: [10], feasible: ['hike'], offers: ['day_hiking', 'desert_landscapes'] } },
  { id: 'scandinavia-summer-hiking', category: 'hiking', text: 'Hiking and fjords in Scandinavia in July, wild camping, I do not mind rain.', checks: { countries: ['NO', 'SE', 'FI', 'IS', 'DK', 'FO'], months: [7], feasible: ['hike'] } },
  { id: 'new-zealand-february', category: 'hiking', text: 'New Zealand in February for great walks, lakes and scenic drives, three weeks.', checks: { countries: ['NZ'], months: [2], feasible: ['hike'] } },
  { id: 'africa-mountains', category: 'trekking', text: 'Mountain trekking in Africa in January or February, something other than Kilimanjaro.', checks: { months: [1, 2], feasible: ['hike'], offers: ['high_mountains', 'multi_day_trekking'], notNamed: ['Kilimanjaro'] } },
  { id: 'balkans-hiking-cheap', category: 'hiking', text: 'Cheap mountain hiking in the Balkans in June, wild and not touristy.', checks: { countries: BALKANS, months: [6], feasible: ['hike'], maxPriceLevel: 0.7 } },
  { id: 'japan-alps-hike', category: 'hiking', text: 'Hiking in the Japanese mountains in early October with hot springs.', checks: { countries: ['JP'], months: [10], feasible: ['hike'], offers: ['day_hiking', 'high_mountains', 'hot_springs_wellness'] } },
  { id: 'volcano-hikes', category: 'volcanoes', text: 'I want to climb active volcanoes and see lava or crater lakes, in May, two weeks.', checks: { months: [5], offers: ['volcanoes_geothermal'] } },
  { id: 'glaciers-easy', category: 'hiking', text: 'Glaciers and icebergs I can see without serious hiking, in July, with my parents in their seventies.', checks: { months: [7], offers: ['glaciers_ice'] } },

  /* ── Sea, islands, diving ──────────────────────────────────────────────── */
  { id: 'caribbean-january', category: 'beach', text: 'Caribbean beach week in January, snorkelling off the beach, not a giant resort island.', checks: { boxes: [CARIBBEAN_BOX], months: [1], feasible: ['beach'] } },
  { id: 'caribbean-hurricane-season', category: 'beach', text: 'A beach holiday in the Caribbean in September, is anywhere sensible?', checks: { boxes: [CARIBBEAN_BOX], months: [9], feasible: ['beach'] }, hard: true },
  { id: 'med-islands-june', category: 'beach', text: 'A quiet Mediterranean island in June, swimming coves, good food, no car needed.', checks: { months: [6], feasible: ['beach'], carFree: true, boxes: [[30, -6, 46, 37]] } },
  { id: 'warm-sea-november', category: 'beach', text: 'Somewhere with a warm sea to swim in during November, within a short flight of Berlin.', checks: { months: [11], feasible: ['beach'], within: { origin: 'Berlin', km: 4500 } } },
  { id: 'thailand-islands-august', category: 'beach', text: 'Thai islands in August, which side has good weather? Beaches and snorkelling.', checks: { countries: ['TH'], months: [8], feasible: ['beach'] }, hard: true },
  { id: 'thailand-islands-january', category: 'beach', text: 'Thailand beaches in January, island hopping for two weeks.', checks: { countries: ['TH'], months: [1], feasible: ['beach'] } },
  { id: 'philippines-islands', category: 'islands', text: 'Island hopping in the Philippines in March, lagoons, snorkelling, budget friendly.', checks: { countries: ['PH'], months: [3], feasible: ['beach', 'dive'], maxPriceLevel: 0.6 } },
  { id: 'pacific-islands', category: 'islands', text: 'A South Pacific island escape in June, lagoons and snorkelling, somewhere less developed than Bora Bora.', checks: { months: [6], feasible: ['beach'], boxes: [[-30, 140, 5, -120]], notNamed: ['Bora Bora'] } },
  { id: 'indian-ocean-honeymoon', category: 'beach', text: 'Honeymoon in the Indian Ocean in May, luxury, turquoise water and privacy.', checks: { months: [5], feasible: ['beach'], boxes: [[-27, 38, 22, 100]] } },
  { id: 'red-sea-diving', category: 'diving', text: 'Diving in the Red Sea in April, liveaboard or shore diving.', checks: { months: [4], feasible: ['dive'], countries: ['EG', 'JO', 'SA', 'SD', 'IL', 'ER', 'DJ'] } },
  { id: 'surf-winter', category: 'beach', text: 'Somewhere to surf in December with warm water and a relaxed town.', checks: { months: [12], feasible: ['beach'] } },
  { id: 'cold-water-coast', category: 'coast', text: 'Wild Atlantic coastline, cliffs, seabirds and seafood in June. I do not need to swim.', checks: { months: [6], feasible: ['hike'], offers: ['coastal_scenery'] } },
  { id: 'whales', category: 'wildlife', text: 'Where can I see whales in August and also do some hiking?', checks: { months: [8], offers: ['marine_wildlife'] } },
  { id: 'greek-islands-october', category: 'islands', text: 'Greek islands in mid October, still warm enough to swim, quiet villages.', checks: { countries: ['GR'], months: [10], feasible: ['beach'] } },
  { id: 'atlantic-islands-winter', category: 'islands', text: 'Atlantic islands for hiking in February, mild weather, flying from Madrid.', checks: { months: [2], feasible: ['hike'], within: { origin: 'Madrid', km: 4500 }, minHighC: 14 } },

  /* ── Wildlife ──────────────────────────────────────────────────────────── */
  { id: 'gorillas', category: 'wildlife', text: 'Gorilla trekking in July, plus a few days somewhere else nearby.', checks: { countries: ['UG', 'RW', 'CD', 'CG', 'GA'], months: [7] } },
  { id: 'india-tigers', category: 'wildlife', text: 'Tigers in India in March, and some palaces.', checks: { countries: ['IN'], months: [3], feasible: ['safari'] } },
  { id: 'bears-north-america', category: 'wildlife', text: 'Bears, salmon and glaciers in July, ten days in North America.', checks: { countries: ['US', 'CA'], months: [7], offers: ['wildlife_general', 'glaciers_ice'] } },
  { id: 'birding-neotropics', category: 'wildlife', text: 'A birding trip to the Neotropics in February, cloud forest and hummingbirds, two weeks.', checks: { months: [2], offers: ['birding', 'rainforest_biodiversity'], boxes: [[-25, -110, 24, -34]] } },
  { id: 'penguins', category: 'wildlife', text: 'I want to see penguins in the wild in December without going to Antarctica.', checks: { months: [12], offers: ['marine_wildlife', 'wildlife_general', 'birding'], boxes: [[-60, -180, -20, 180]] } },
  { id: 'madagascar-like', category: 'wildlife', text: 'Unusual wildlife you cannot see anywhere else, September, three weeks, adventurous.', checks: { months: [9], offers: ['wildlife_general', 'rainforest_biodiversity'] } },
  { id: 'arctic-wildlife', category: 'wildlife', text: 'Arctic wildlife and midnight sun in June, expedition style.', checks: { months: [6], boxes: [[60, -180, 90, 180]] } },

  /* ── Cities, culture, food ─────────────────────────────────────────────── */
  { id: 'food-city-asia', category: 'city_break', text: 'A food-obsessed week in an Asian city in November, street food and markets.', checks: { months: [11], feasible: ['city'], offers: ['food', 'city_life'], carFree: true } },
  { id: 'latin-america-colonial', category: 'culture', text: 'Colonial cities and ruins in Latin America in February, two weeks, mid budget.', checks: { months: [2], feasible: ['city'], offers: ['villages_culture'], boxes: [[-56, -118, 33, -34]] } },
  { id: 'ancient-ruins-spring', category: 'culture', text: 'Ancient ruins and archaeology in April, not too hot, about ten days.', checks: { months: [4], feasible: ['city'], offers: ['villages_culture'], maxHighC: 32 } },
  { id: 'wine-region', category: 'culture', text: 'A wine region with good restaurants and pretty villages in late September.', checks: { months: [9], feasible: ['city'], offers: ['food', 'villages_culture'] } },
  { id: 'middle-east-culture-winter', category: 'culture', text: 'Culture and deserts in the Middle East in December, one week, we like history.', checks: { months: [12], feasible: ['city', 'desert'], countries: ['JO', 'OM', 'AE', 'SA', 'EG', 'IL', 'QA', 'BH', 'KW', 'LB', 'TR', 'IR', 'IQ', 'PS'] } },
  { id: 'india-first-time', category: 'culture', text: 'First time in India, December, two weeks: palaces, food, a bit of nature, not too hectic.', checks: { countries: ['IN'], months: [12], feasible: ['city'] } },
  { id: 'china-off-beaten', category: 'culture', text: 'China beyond Beijing and Shanghai in May: old towns, karst landscapes, good food.', checks: { countries: ['CN'], months: [5], feasible: ['city'], notNamed: ['Beijing', 'Shanghai'] } },
  { id: 'south-america-cities', category: 'city_break', text: 'A lively South American city for a week in March, nightlife, food and day trips.', checks: { months: [3], offers: ['city_life'], countries: ['AR', 'BR', 'CL', 'CO', 'PE', 'UY', 'EC', 'BO', 'PY', 'VE'] } },
  { id: 'north-africa-medinas', category: 'culture', text: 'Medinas, mountains and desert in North Africa in October, ten days.', checks: { months: [10], countries: ['MA', 'TN', 'DZ', 'EG', 'LY'], feasible: ['city'] } },
  { id: 'usa-city-weekend', category: 'city_break', text: 'A long weekend in a US city in October, live music and food, flying from Chicago.', checks: { countries: ['US'], months: [10], feasible: ['city'], offers: ['city_life', 'food'] } },
  { id: 'southeast-asia-first', category: 'culture', text: 'Three weeks in Southeast Asia in January for a first-timer: temples, beaches and street food.', checks: { countries: SOUTHEAST_ASIA, months: [1] } },
  { id: 'eastern-europe-winter-city', category: 'city_break', text: 'A cheap, atmospheric Eastern European city in February with thermal baths.', checks: { months: [2], maxPriceLevel: 0.7, countries: EUROPE, offers: ['city_life', 'hot_springs_wellness'] } },
  { id: 'small-towns-italy', category: 'culture', text: 'Small hill towns and food in Italy in May, away from Tuscany crowds.', checks: { countries: ['IT'], months: [5], feasible: ['city'], offers: ['villages_culture', 'food'] } },
  { id: 'spain-winter', category: 'culture', text: 'Southern Spain in January: Moorish cities, tapas, mild weather, by train.', checks: { countries: ['ES'], months: [1], feasible: ['city'], carFree: true } },

  /* ── Road trips, deserts, landscapes ───────────────────────────────────── */
  { id: 'road-trip-western-us', category: 'road_trip', text: 'A two-week road trip in the American West in May, national parks and empty highways.', checks: { countries: ['US'], months: [5], feasible: ['road_trip'], offers: ['scenic_driving'] } },
  { id: 'road-trip-europe-coast', category: 'road_trip', text: 'A coastal road trip in Europe in September, 10 days, swimming stops and seafood.', checks: { countries: EUROPE, months: [9], feasible: ['road_trip', 'beach'], offers: ['scenic_driving', 'coastal_scenery'] } },
  { id: 'iceland-ring-road', category: 'road_trip', text: 'Is the Iceland ring road worth it in March? We want waterfalls and maybe northern lights.', checks: { countries: ['IS'], months: [3] }, hard: true },
  { id: 'desert-stargazing', category: 'desert', text: 'Desert landscapes and stargazing in November, camping under the stars, one week.', checks: { months: [11], feasible: ['desert'], offers: ['desert_landscapes', 'night_skies'] } },
  { id: 'namibia-like', category: 'road_trip', text: 'A self-drive trip with huge empty landscapes, dunes and wildlife, in July.', checks: { months: [7], feasible: ['road_trip'], offers: ['desert_landscapes', 'scenic_driving'] } },
  { id: 'australia-outback', category: 'road_trip', text: 'Australia in July: outback, red rock and a reef if possible, three weeks.', checks: { countries: ['AU'], months: [7] } },
  { id: 'scotland-like-drive', category: 'road_trip', text: 'A scenic driving loop with lochs, castles and short walks in May, 8 days.', checks: { months: [5], feasible: ['road_trip'], offers: ['scenic_driving'] } },
  { id: 'northern-lights', category: 'winter', text: 'Northern lights in February, plus dog sledding, five nights.', checks: { months: [2], offers: ['night_skies', 'winter_snow'], boxes: [[58, -180, 90, 180]] } },
  { id: 'fall-colours', category: 'road_trip', text: 'Autumn foliage road trip in early October, small towns and short hikes.', checks: { months: [10], feasible: ['road_trip', 'hike'] } },
  { id: 'lakes-swimming-summer', category: 'lakes', text: 'Warm lakes to swim in, with mountains behind, in July, by train if possible.', checks: { months: [7], feasible: ['lakes'], offers: ['lakes'] } },
  { id: 'canada-lakes-canoe', category: 'lakes', text: 'A canoe trip on wilderness lakes in August, portaging and camping.', checks: { months: [8], feasible: ['lakes'], offers: ['paddling_boating', 'lakes'] } },

  /* ── Money, distance, party, access ────────────────────────────────────── */
  { id: 'cheap-anywhere-warm-feb', category: 'budget', text: 'Somewhere warm and really cheap in February for three weeks, beaches and good food.', checks: { months: [2], feasible: ['beach'], maxPriceLevel: 0.5, minHighC: 24 } },
  { id: 'luxury-safari-beach', category: 'luxury', text: 'Luxury safari followed by a beach, in September, money is not a concern.', checks: { months: [9], feasible: ['safari'], offers: ['big_game_safari'] } },
  { id: 'backpacking-south-america', category: 'budget', text: 'Backpacking in South America for a month from June, mountains, ruins and cheap hostels.', checks: { months: [6, 7], maxPriceLevel: 0.6, countries: ['PE', 'BO', 'EC', 'CO', 'AR', 'CL', 'BR', 'PY', 'UY', 'VE'] } },
  { id: 'short-haul-from-nyc', category: 'reach', text: 'Five nights in March, warm, beach and some hiking, short flight from New York.', checks: { months: [3], feasible: ['beach'], within: { origin: 'New York', km: 4200 } } },
  { id: 'short-haul-from-singapore', category: 'reach', text: 'A long weekend from Singapore in June: nature, waterfalls, not a big city.', checks: { months: [6], within: { origin: 'Singapore', km: 3000 } } },
  { id: 'from-sydney-winter-escape', category: 'reach', text: 'From Sydney in July, we want warmth, snorkelling and a short flight.', checks: { months: [7], feasible: ['beach'], within: { origin: 'Sydney', km: 5500 }, minHighC: 24 } },
  { id: 'from-delhi-mountains', category: 'reach', text: 'Mountains not too far from Delhi for a week in May, to escape the heat.', checks: { months: [5], feasible: ['hike'], within: { origin: 'Delhi', km: 2500 }, maxHighC: 28 } },
  { id: 'from-sao-paulo', category: 'reach', text: 'From São Paulo, a week in July with waterfalls, hiking and wildlife, not too far.', checks: { months: [7], within: { origin: 'São Paulo', km: 4000 } } },
  { id: 'from-nairobi-beach', category: 'reach', text: 'A beach break in East Africa in January, short flight from Nairobi.', checks: { months: [1], feasible: ['beach'], within: { origin: 'Nairobi', km: 2500 } } },
  { id: 'wheelchair-scenery', category: 'access', text: 'Spectacular scenery that works for a wheelchair user, in June, with good hotels.', checks: { months: [6] } },
  { id: 'seniors-gentle', category: 'access', text: 'A gentle trip for my parents in their seventies in May: gardens, lakes, short walks, good trains.', checks: { months: [5], feasible: ['city'], carFree: true } },
  { id: 'toddler-beach', category: 'family', text: 'Beach holiday with a toddler in June, shallow calm water, short transfers.', checks: { months: [6], feasible: ['beach'], family: true } },
  { id: 'teenagers-adventure', category: 'family', text: 'An adventurous trip with teenagers in August: rafting, hiking, wildlife, two weeks.', checks: { months: [8], feasible: ['hike'] } },
  { id: 'solo-female-first', category: 'safety', text: 'First solo trip as a woman, two weeks in October, safe, easy to meet people, nature and culture.', checks: { months: [10] } },
  { id: 'honeymoon-quiet', category: 'couple', text: 'A quiet honeymoon in October, mountains or coast, romantic and not crowded, 10 nights.', checks: { months: [10] } },
  { id: 'friends-group-cheap-summer', category: 'budget', text: 'Six friends, cheap week in July, beaches, hiking and nightlife in Europe.', checks: { countries: EUROPE, months: [7], feasible: ['beach'], maxPriceLevel: 0.7 } },
  { id: 'digital-detox', category: 'remote', text: 'Somewhere truly remote to disconnect for two weeks in August, cabins, hiking, no crowds.', checks: { months: [8], feasible: ['hike'], littleKnown: 1 } },
  { id: 'hidden-gems-europe', category: 'hidden', text: 'Hidden gems in Europe in June, places my friends have never heard of, nature and villages.', checks: { countries: EUROPE, months: [6], littleKnown: 2 } },
  { id: 'hidden-gems-asia', category: 'hidden', text: 'Off-the-beaten-path mountains and culture in Asia in October, I have done Nepal and Japan.', checks: { months: [10], littleKnown: 2, notNamed: ['Nepal', 'Japan'] } },
  { id: 'hidden-gems-americas', category: 'hidden', text: 'Underrated nature in the Americas in March, somewhere most tourists skip.', checks: { months: [3], littleKnown: 2, boxes: [[-56, -170, 72, -34]] } },

  /* ── Seasons that bite ─────────────────────────────────────────────────── */
  { id: 'monsoon-avoid-july', category: 'seasonality', text: 'Asia in July but I want to avoid the monsoon, beaches or mountains either is fine.', checks: { months: [7], feasible: ['beach', 'hike'], boxes: [[-11, 60, 55, 150]] }, hard: true },
  { id: 'ski-april', category: 'seasonality', text: 'Late-season skiing in mid April, where is the snow still good?', checks: { months: [4], feasible: ['ski'], offers: ['winter_snow'] }, hard: true },
  { id: 'hike-may-alps', category: 'seasonality', text: 'Hiking in the Alps in early May, what is realistic?', checks: { boxes: [ALPS], months: [5], feasible: ['hike'] }, hard: true },
  { id: 'southern-hemisphere-ski', category: 'seasonality', text: 'Skiing in August.', checks: { months: [8], feasible: ['ski'], offers: ['winter_snow'] }, hard: true },
  { id: 'beach-europe-april', category: 'seasonality', text: 'Beach holiday in Europe in April with swimming.', checks: { countries: EUROPE, months: [4], feasible: ['beach'] }, hard: true },
  { id: 'safari-april-rains', category: 'seasonality', text: 'Safari in April, where does the rain not ruin it?', checks: { months: [4], feasible: ['safari'], countries: SUB_SAHARAN_SAFARI }, hard: true },
  { id: 'desert-summer', category: 'seasonality', text: 'Desert trip in July that is not dangerously hot.', checks: { months: [7], feasible: ['desert'], maxHighC: 34 }, hard: true },
  { id: 'himalaya-monsoon', category: 'seasonality', text: 'Himalayan trekking in July or August, is there anywhere in the rain shadow?', checks: { months: [7, 8], feasible: ['trek_high'], countries: ['IN', 'NP', 'PK', 'CN', 'BT'] }, hard: true },
  { id: 'patagonia-winter', category: 'seasonality', text: 'Patagonia in July.', checks: { boxes: [PATAGONIA], months: [7] }, hard: true },
  { id: 'japan-summer-cool', category: 'seasonality', text: 'Japan in August but somewhere cool, hiking and nature rather than cities.', checks: { countries: ['JP'], months: [8], feasible: ['hike'], maxHighC: 29 } },
  { id: 'christmas-snow-not-ski', category: 'seasonality', text: 'A snowy Christmas week without skiing: saunas, reindeer, cosy cabins.', checks: { months: [12], offers: ['winter_snow'] } },
  { id: 'shoulder-season-med', category: 'seasonality', text: 'Mediterranean in late October, culture first, a swim would be a bonus.', checks: { months: [10], feasible: ['city'], boxes: [[30, -6, 46, 37]] } },

  /* ── Ambiguous, contradictory, thin ────────────────────────────────────── */
  { id: 'vague-somewhere-nice', category: 'ambiguous', text: 'Somewhere nice.', checks: {}, hard: true },
  { id: 'vague-surprise', category: 'ambiguous', text: 'Surprise me. Two weeks in May.', checks: { months: [5] }, hard: true },
  { id: 'vague-nature', category: 'ambiguous', text: 'I just want nature and quiet.', checks: {}, hard: true },
  { id: 'contradiction-cheap-luxury', category: 'ambiguous', text: 'Luxury resorts but on a tight budget, in August.', checks: { months: [8] }, hard: true },
  { id: 'contradiction-remote-easy', category: 'ambiguous', text: 'Completely remote and wild but easy to get to with no long transfers, in September.', checks: { months: [9] }, hard: true },
  { id: 'everything', category: 'ambiguous', text: 'Beaches, mountains, cities, wildlife, food, skiing and deserts, in one week.', checks: {}, hard: true },
  { id: 'negation', category: 'ambiguous', text: 'Not Europe, no beaches, no long hikes, in November.', checks: { months: [11] }, hard: true },
  { id: 'typos', category: 'ambiguous', text: 'hikng and beachs in septmber somwhere cheap', checks: { months: [9] }, hard: true },
  { id: 'one-word-diving', category: 'ambiguous', text: 'Diving.', checks: { offers: ['snorkel_dive'] }, hard: true },
  { id: 'specific-niche-tea', category: 'niche', text: 'Tea plantations, misty hills and train rides, in February.', checks: { months: [2] }, hard: true },
  { id: 'specific-niche-fjords', category: 'niche', text: 'Fjords I can kayak in, with few cruise ships, in August.', checks: { months: [8], offers: ['paddling_boating', 'coastal_scenery'] }, hard: true },
  { id: 'specific-niche-hot-springs', category: 'niche', text: 'Natural hot springs in the mountains in winter, away from big resorts.', checks: { offers: ['hot_springs_wellness'] }, hard: true },
  { id: 'specific-niche-caves', category: 'niche', text: 'Caves, karst and underground rivers, in April.', checks: { months: [4] }, hard: true },
  { id: 'specific-niche-monasteries', category: 'niche', text: 'Remote monasteries and high passes in October.', checks: { months: [10] }, hard: true },
  { id: 'specific-niche-waterfalls', category: 'niche', text: 'The best waterfalls in the world, in the season when they are in full flow.', checks: {}, hard: true },
  { id: 'specific-niche-cycling', category: 'niche', text: 'A week of road cycling on quiet mountain passes in June.', checks: { months: [6] }, hard: true },
  { id: 'long-trip-sabbatical', category: 'long', text: 'A three-month sabbatical starting in January, slow travel, hiking, culture and cheap living.', checks: { months: [1, 2, 3], maxPriceLevel: 0.6 }, hard: true },
  { id: 'two-nights', category: 'short', text: 'Two nights away next month from Paris, countryside and good food.', checks: { within: { origin: 'Paris', km: 1500 } }, hard: true },
];
