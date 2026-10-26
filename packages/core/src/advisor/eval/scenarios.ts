import type { CatalogDestination, WorldRegion } from '../catalog/schema';
import type { FocusKey } from '../answers';
import type { QuestionId } from '../questions';
import { REGION_GROUPS } from '../questions';

/**
 * THE ADVISOR'S EVALUATION SCENARIOS.
 *
 * Each scenario is something a real traveller might type, plus how they would
 * answer the questions the interview chooses to ask (`persona`; a question the
 * persona has no answer for is skipped, which is honest — a skip carries no
 * information). The checks are **objective**: every one is a property of the
 * shortlist that can be read off the catalog, never a list of "right answers".
 * No scenario names a destination it expects; a scenario that did would be
 * tuning the catalog to the test.
 */

export interface Scenario {
  id: string;
  title: string;
  text: string;
  persona: Partial<Record<QuestionId, string | string[]>>;
  /** The questions this text already answers; asking one is a redundancy. */
  alreadyAnswered: QuestionId[];
  checks: Check[];
}

export type Check =
  /** Every primary pick is strong (≥ 2) on at least one of these experiences. */
  | { kind: 'primaries_offer'; experiences: string[]; label: string }
  /** Every primary pick sits in these regions. */
  | { kind: 'in_regions'; regions: WorldRegion[] }
  /** Every primary pick lies in one of these countries. */
  | { kind: 'in_countries'; countries: string[] }
  /** Every primary pick has season ≥ 2 in at least one of these months. */
  | { kind: 'in_season'; months: number[] }
  /** Every primary pick's typical daytime high in one of these months is ≥ / ≤ a bound. */
  | { kind: 'warmth'; months: number[]; min?: number; max?: number }
  /** Every primary pick costs at most this on the 1–4 scale. */
  | { kind: 'max_cost'; cost: number }
  | { kind: 'low_mobility'; min: number }
  | { kind: 'family'; min: number }
  | { kind: 'no_car' }
  /** Every primary pick can be done in this many nights. */
  | { kind: 'fits_nights'; nights: number }
  /** Every primary pick lies within this many km of the origin. */
  | { kind: 'within_km'; km: number }
  /** Primary picks span at least this many world regions. */
  | { kind: 'spread'; regions: number }
  /** At least this many primary picks are little known (familiarity ≤ 1). */
  | { kind: 'unusual'; atLeast: number }
  /** At least this many primary picks are well known (familiarity ≥ 2). */
  | { kind: 'classic'; atLeast: number }
  | { kind: 'max_challenge_easiest'; level: number }
  | { kind: 'min_challenge_typical'; level: number }
  /** The interview asks no more than this many questions in total. */
  | { kind: 'max_questions'; count: number };

const EUROPE = REGION_GROUPS.europe!;
const ASIA = REGION_GROUPS.asia!;
const AMERICAS = REGION_GROUPS.americas!;

const ORIGINAL =
  "Find me somewhere outdoors for the summer. I love hiking, wildlife, mountains, lakes, coast and swimming. I'm flexible on duration.";

export const SCENARIOS: readonly Scenario[] = [
  {
    id: 'original-summer-outdoors',
    title: 'The original failure: broad summer outdoors, no other detail',
    text: ORIGINAL,
    persona: {},
    alreadyAnswered: ['when', 'length', 'focus'],
    checks: [
      { kind: 'in_season', months: [6, 7, 8] },
      { kind: 'primaries_offer', experiences: ['day_hiking', 'high_mountains', 'multi_day_trekking'], label: 'hiking or mountains' },
      { kind: 'spread', regions: 2 },
      { kind: 'max_questions', count: 6 },
    ],
  },
  {
    id: 'original-wildlife-led',
    title: 'Original request, wildlife leads, moderate budget',
    text: ORIGINAL,
    persona: { lead: 'wildlife', wildlife_kind: 'any', budget: 'mid_range' },
    alreadyAnswered: ['when', 'length', 'focus'],
    checks: [
      { kind: 'in_season', months: [6, 7, 8] },
      { kind: 'primaries_offer', experiences: ['wildlife_general', 'big_game_safari', 'marine_wildlife', 'birding'], label: 'wildlife' },
    ],
  },
  {
    id: 'original-mountains-rugged',
    title: 'Original request, mountains lead, rugged hut-to-hut, from London',
    text: `${ORIGINAL} I'm based in London.`,
    persona: { lead: 'mountains', adventure: 'rugged', mountain_style: 'hut_to_hut' },
    alreadyAnswered: ['when', 'length', 'focus'],
    checks: [
      { kind: 'in_season', months: [6, 7, 8] },
      { kind: 'primaries_offer', experiences: ['high_mountains', 'multi_day_trekking'], label: 'mountains and trekking' },
      { kind: 'min_challenge_typical', level: 2 },
    ],
  },
  {
    id: 'original-beach-led-warm',
    title: 'Original request, swimming in a warm sea leads',
    text: ORIGINAL,
    persona: { lead: 'beaches', swim: 'warm_sea', climate: 'warm' },
    alreadyAnswered: ['when', 'length', 'focus'],
    checks: [
      { kind: 'primaries_offer', experiences: ['beaches_swimming'], label: 'swimming beaches' },
      { kind: 'warmth', months: [6, 7, 8], min: 24 },
    ],
  },
  {
    id: 'alpine-trekking-july',
    title: 'Two weeks trekking in July, anywhere, moderate budget',
    text: 'Two weeks of trekking in July, anywhere in the world, moderate budget.',
    persona: { adventure: 'rugged', mountain_style: 'hut_to_hut' },
    alreadyAnswered: ['when', 'length', 'budget', 'region', 'focus'],
    checks: [
      { kind: 'in_season', months: [7] },
      { kind: 'primaries_offer', experiences: ['multi_day_trekking'], label: 'multi-day trekking' },
      { kind: 'max_cost', cost: 3 },
      { kind: 'fits_nights', nights: 14 },
      { kind: 'max_questions', count: 5 },
    ],
  },
  {
    id: 'safari-first-timer',
    title: 'First safari, August, comfortable budget',
    text: 'I want to see lions and elephants on safari in August. Comfortable budget, about 10 days.',
    persona: {},
    alreadyAnswered: ['when', 'length', 'budget', 'focus'],
    checks: [
      { kind: 'primaries_offer', experiences: ['big_game_safari'], label: 'safari' },
      { kind: 'in_season', months: [8] },
    ],
  },
  {
    id: 'tropical-biodiversity',
    title: 'Rainforest and birds, flexible timing',
    text: 'Rainforest, monkeys and birds, a jungle lodge or two. Any time of year.',
    persona: { budget: 'mid_range' },
    alreadyAnswered: ['focus', 'when'],
    checks: [{ kind: 'primaries_offer', experiences: ['rainforest_biodiversity'], label: 'rainforest' }],
  },
  {
    id: 'coastal-adventure',
    title: 'Coastal adventure: sea kayaking and coastal hikes, September',
    text: 'Sea kayaking and coastal hikes in September, active but not extreme.',
    persona: {},
    alreadyAnswered: ['when', 'focus', 'adventure'],
    checks: [
      { kind: 'primaries_offer', experiences: ['coastal_scenery', 'paddling_boating'], label: 'coast or paddling' },
      { kind: 'in_season', months: [9] },
    ],
  },
  {
    id: 'family-nature',
    title: 'Family nature trip with young kids, summer, from Chicago',
    text: 'Family trip with two kids (6 and 9) in July from Chicago. Nature, lakes, easy hikes, wildlife.',
    persona: { adventure: 'comfortable' },
    alreadyAnswered: ['when', 'party', 'focus'],
    checks: [
      { kind: 'family', min: 2 },
      { kind: 'in_season', months: [7] },
      { kind: 'max_challenge_easiest', level: 1 },
    ],
  },
  {
    id: 'budget-hiking',
    title: 'Budget hiking, shoulder season, backpacker',
    text: 'Cheap backpacking trip with lots of hiking in September. Hostels are fine.',
    persona: {},
    alreadyAnswered: ['when', 'budget', 'focus'],
    checks: [
      { kind: 'max_cost', cost: 2 },
      { kind: 'primaries_offer', experiences: ['day_hiking', 'multi_day_trekking'], label: 'hiking' },
      { kind: 'in_season', months: [9] },
    ],
  },
  {
    id: 'winter-nature-escape',
    title: 'Winter nature escape: snow and northern lights',
    text: 'Snow, northern lights and a bit of wildlife in February.',
    persona: {},
    alreadyAnswered: ['when', 'focus'],
    checks: [
      { kind: 'primaries_offer', experiences: ['winter_snow', 'night_skies'], label: 'snow or night skies' },
      { kind: 'warmth', months: [2], max: 6 },
    ],
  },
  {
    id: 'warm-december',
    title: 'Warm-weather December escape from New York',
    text: 'Escape the cold in December from New York. Warm, beaches, some nature.',
    persona: {},
    alreadyAnswered: ['when', 'focus', 'climate'],
    checks: [
      { kind: 'warmth', months: [12], min: 25 },
      { kind: 'in_season', months: [12] },
    ],
  },
  {
    id: 'multi-generational',
    title: 'Multi-generational: grandparents and grandchildren, scenic and gentle',
    text: 'Trip with my parents (in their 70s) and our kids in June. Scenery, lakes, gentle walks, no long hikes.',
    persona: { adventure: 'comfortable' },
    alreadyAnswered: ['when', 'party', 'focus'],
    checks: [
      { kind: 'family', min: 2 },
      { kind: 'max_challenge_easiest', level: 1 },
      { kind: 'in_season', months: [6] },
    ],
  },
  {
    id: 'limited-mobility',
    title: 'Limited mobility, scenic nature',
    text: 'My husband uses a walking aid. We love scenery, wildlife and lakes. October.',
    persona: {},
    alreadyAnswered: ['when', 'party', 'focus'],
    checks: [
      { kind: 'low_mobility', min: 2 },
      { kind: 'in_season', months: [10] },
    ],
  },
  {
    id: 'no-car',
    title: 'No car: mountains by train',
    text: 'Mountains and hiking by train in August, no car.',
    persona: {},
    alreadyAnswered: ['when', 'getting_around', 'focus'],
    checks: [
      { kind: 'no_car' },
      { kind: 'primaries_offer', experiences: ['high_mountains', 'day_hiking'], label: 'mountains or hiking' },
    ],
  },
  {
    id: 'short-weekend-london',
    title: 'Long weekend from London, outdoors',
    text: 'A long weekend of hiking and coast from London in May.',
    persona: {},
    alreadyAnswered: ['when', 'length', 'focus'],
    checks: [
      { kind: 'fits_nights', nights: 3 },
      { kind: 'within_km', km: 2600 },
    ],
  },
  {
    id: 'short-weekend-sf',
    title: 'Long weekend from San Francisco, mountains and lakes',
    text: 'Long weekend from San Francisco in September: mountains and lakes.',
    persona: {},
    alreadyAnswered: ['when', 'length', 'focus'],
    checks: [
      { kind: 'fits_nights', nights: 3 },
      { kind: 'within_km', km: 2600 },
    ],
  },
  {
    id: 'long-international',
    title: 'Three weeks, international, mixed nature and culture',
    text: 'Three weeks in October, somewhere far away. Mountains, culture and food.',
    persona: { budget: 'mid_range' },
    alreadyAnswered: ['when', 'length', 'focus'],
    checks: [
      { kind: 'fits_nights', nights: 21 },
      { kind: 'in_season', months: [10] },
    ],
  },
  {
    id: 'flexible-worldwide',
    title: 'Fully flexible: anywhere, any time, surprise me',
    text: 'Anywhere in the world, any time. Surprise me with something outdoors and unusual.',
    persona: { focus: ['mountains', 'wildlife', 'desert'] },
    alreadyAnswered: ['region', 'when', 'novelty'],
    checks: [
      { kind: 'unusual', atLeast: 2 },
      { kind: 'spread', regions: 3 },
    ],
  },
  {
    id: 'region-balkans',
    title: 'Region restricted: the Balkans, hiking and lakes',
    text: 'Hiking and lakes in the Balkans in June.',
    persona: {},
    alreadyAnswered: ['when', 'region', 'focus'],
    checks: [{ kind: 'in_countries', countries: ['SI', 'HR', 'BA', 'RS', 'ME', 'MK', 'AL', 'XK', 'BG', 'GR', 'RO'] }],
  },
  {
    id: 'region-southeast-asia',
    title: 'Region restricted: Southeast Asia, beaches and jungle, February',
    text: 'Southeast Asia in February: beaches, snorkelling and some jungle.',
    persona: {},
    alreadyAnswered: ['when', 'region', 'focus'],
    checks: [
      { kind: 'in_regions', regions: ['southeast_asia'] },
      { kind: 'in_season', months: [2] },
    ],
  },
  {
    id: 'region-europe-classic',
    title: 'Europe, first time, classic mountains',
    text: 'First time in Europe, iconic mountains and lakes in July.',
    persona: {},
    alreadyAnswered: ['when', 'region', 'focus', 'novelty'],
    checks: [
      { kind: 'in_regions', regions: EUROPE },
      { kind: 'classic', atLeast: 2 },
    ],
  },
  {
    id: 'remote-adventure',
    title: 'Remote expedition-style adventure',
    text: 'Remote, expedition-style trekking far from anyone. August, about three weeks.',
    persona: {},
    alreadyAnswered: ['when', 'length', 'adventure', 'focus'],
    checks: [
      { kind: 'min_challenge_typical', level: 2 },
      { kind: 'in_season', months: [8] },
    ],
  },
  {
    id: 'relaxed-nature',
    title: 'Relaxed nature vacation: lakes and gentle walks',
    text: 'Something relaxing: lakes, gentle walks and good food, late September.',
    persona: {},
    alreadyAnswered: ['when', 'adventure', 'focus'],
    checks: [
      { kind: 'max_challenge_easiest', level: 1 },
      { kind: 'in_season', months: [9] },
    ],
  },
  {
    id: 'luxury-wildlife',
    title: 'Luxury wildlife trip',
    text: 'Luxury wildlife trip in September, five-star lodges.',
    persona: { wildlife_kind: 'safari' },
    alreadyAnswered: ['when', 'budget', 'focus'],
    checks: [{ kind: 'primaries_offer', experiences: ['big_game_safari', 'wildlife_general'], label: 'wildlife' }],
  },
  {
    id: 'budget-beach-winter',
    title: 'Budget beach trip in January from Europe',
    text: 'Cheap beach and snorkelling trip in January, from Berlin.',
    persona: {},
    alreadyAnswered: ['when', 'budget', 'focus'],
    checks: [
      { kind: 'max_cost', cost: 2 },
      { kind: 'warmth', months: [1], min: 25 },
    ],
  },
  {
    id: 'from-sydney-summer',
    title: 'Southern-hemisphere traveller: summer holiday from Sydney',
    text: 'Summer holidays from Sydney, hiking and beaches.',
    persona: {},
    alreadyAnswered: ['when', 'focus'],
    checks: [{ kind: 'in_season', months: [12, 1, 2] }],
  },
  {
    id: 'from-delhi-mountains',
    title: 'Mountains from Delhi, May, close to home',
    text: 'Mountains and hiking in May from Delhi, not too far.',
    persona: {},
    alreadyAnswered: ['when', 'focus', 'reach'],
    checks: [
      { kind: 'within_km', km: 3200 },
      { kind: 'in_season', months: [5] },
    ],
  },
  {
    id: 'desert-volcano',
    title: 'Deserts and volcanoes, November',
    text: 'Deserts, volcanoes and starry skies in November.',
    persona: {},
    alreadyAnswered: ['when', 'focus'],
    checks: [
      { kind: 'primaries_offer', experiences: ['desert_landscapes', 'volcanoes_geothermal', 'night_skies'], label: 'desert, volcanoes or stars' },
      { kind: 'in_season', months: [11] },
    ],
  },
  {
    id: 'road-trip-americas',
    title: 'Scenic road trip in the Americas, autumn',
    text: 'A scenic road trip in the Americas in October, happy to drive.',
    persona: {},
    alreadyAnswered: ['when', 'focus', 'getting_around', 'region'],
    checks: [
      { kind: 'in_regions', regions: AMERICAS },
      { kind: 'primaries_offer', experiences: ['scenic_driving'], label: 'scenic driving' },
    ],
  },
  {
    id: 'culture-food-asia',
    title: 'Culture and food in Asia with some nature, March',
    text: 'Food, culture and a bit of nature in Asia in March, mid-range budget.',
    persona: {},
    alreadyAnswered: ['when', 'focus', 'budget', 'region'],
    checks: [
      { kind: 'in_regions', regions: ASIA },
      { kind: 'primaries_offer', experiences: ['food', 'villages_culture', 'city_life'], label: 'food or culture' },
    ],
  },
  {
    id: 'marine-wildlife',
    title: 'Whales and marine life, June',
    text: 'Whale watching, seals and puffins in June.',
    persona: { wildlife_kind: 'marine' },
    alreadyAnswered: ['when', 'focus'],
    checks: [{ kind: 'primaries_offer', experiences: ['marine_wildlife', 'birding'], label: 'marine wildlife' }],
  },
  {
    id: 'avoid-crowds-hidden',
    title: 'Hidden gems, avoid crowds, mountains, September',
    text: 'Hidden gems with mountains and lakes in September, avoid crowds.',
    persona: {},
    alreadyAnswered: ['when', 'focus', 'crowds', 'novelty'],
    checks: [
      { kind: 'unusual', atLeast: 2 },
      { kind: 'in_season', months: [9] },
    ],
  },
  {
    id: 'domestic-us',
    title: 'Domestic only, from Denver, hiking in June',
    text: 'Hiking and lakes in June, domestic, from Denver.',
    persona: {},
    alreadyAnswered: ['when', 'focus', 'reach'],
    checks: [{ kind: 'in_regions', regions: ['north_america_west', 'north_america_east', 'north_america_north'] }],
  },
];

/** Reads a primary pick's catalog entry; scenarios check entries, never names. */
export type EntryLookup = (id: string) => CatalogDestination | null;

export const SCENARIO_COUNT = SCENARIOS.length;
export type { FocusKey };
