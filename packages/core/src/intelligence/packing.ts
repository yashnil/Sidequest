import { z } from 'zod';
import type { Itinerary } from '../schemas/itinerary';
import type { TravelerProfile } from '../schemas/profile';
import type { LodgingKind } from './lodging';

/**
 * PACKING, DERIVED — NOT A GENERIC LIST.
 *
 * Every item names the reason it is on the list, and the reason is something
 * on this plan: a hike, a ferry, a hut, a cold morning, a border. A trip with
 * none of those gets a short list.
 */
export const PACKING_CATEGORIES = ['essential_documents', 'clothing', 'footwear', 'outdoor', 'weather', 'electronics', 'health_toiletries', 'transport', 'activity_specific', 'remote_travel', 'optional'] as const;
export const packingCategorySchema = z.enum(PACKING_CATEGORIES);
export type PackingCategory = z.infer<typeof packingCategorySchema>;

export const PACKING_CATEGORY_LABELS: Record<PackingCategory, string> = {
  essential_documents: 'Essential documents',
  clothing: 'Clothing',
  footwear: 'Footwear',
  outdoor: 'Outdoor',
  weather: 'Weather',
  electronics: 'Electronics',
  health_toiletries: 'Health and toiletries',
  transport: 'Transport',
  activity_specific: 'For the activities',
  remote_travel: 'Remote travel',
  optional: 'Optional',
};

export const packingItemSchema = z.object({
  id: z.string().min(1),
  category: packingCategorySchema,
  label: z.string().min(1),
  why: z.string().min(1),
  optional: z.boolean().default(false),
});
export type PackingItem = z.infer<typeof packingItemSchema>;

export const packingIntelligenceSchema = z.object({
  items: z.array(packingItemSchema),
  basis: z.enum(['forecast', 'climate', 'unknown']),
  basisNote: z.string().min(1),
  /** The model's own packing suggestions that did not map to a rule, kept as proposals. */
  modelSuggestions: z.array(z.string().min(1)).default([]),
});
export type PackingIntelligence = z.infer<typeof packingIntelligenceSchema>;

export interface PackingInput {
  itinerary: Itinerary;
  profile: TravelerProfile;
  categories: readonly string[];
  international: 'yes' | 'no' | 'unknown';
  drives: boolean;
  remote: boolean;
  lodgingKinds: readonly LodgingKind[];
  legModes: readonly string[];
  weatherBasis: 'forecast' | 'climate' | 'unknown';
  children: boolean;
  /** The plan carries intense days or trail-like stops even if no anchor is categorised as a hike. */
  strenuous?: boolean;
  modelPacking: readonly string[];
  /** V7 §13 — the episode kinds on the plan, so a cruise packs like a cruise and a trek like a trek. */
  episodeKinds?: readonly string[];
}

export function buildPackingIntelligence(input: PackingInput): PackingIntelligence {
  const items: PackingItem[] = [];
  const add = (category: PackingCategory, label: string, why: string, optional = false) => {
    const id = `${category}:${label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
    if (items.some((i) => i.id === id)) return;
    items.push(packingItemSchema.parse({ id, category, label, why, optional }));
  };
  const cats = new Set(input.categories);
  const temps = input.itinerary.days.map((d) => d.weather).filter((w) => w.temperatureMinC !== undefined || w.temperatureMaxC !== undefined);
  const minC = temps.length > 0 ? Math.min(...temps.map((w) => w.temperatureMinC ?? w.temperatureMaxC ?? 99)) : null;
  const maxC = temps.length > 0 ? Math.max(...temps.map((w) => w.temperatureMaxC ?? w.temperatureMinC ?? -99)) : null;
  const wet = input.itinerary.days.some((d) => (d.weather.precipitationProbabilityPercent ?? 0) >= 40 || (d.weather.precipitationMm ?? 0) >= 3);
  const windy = input.itinerary.days.some((d) => (d.weather.windGustMaxKph ?? 0) >= 50);
  const snowy = input.itinerary.days.some((d) => (d.weather.snowfallCm ?? 0) > 0);
  const hikes = cats.has('hike') || ((input.strenuous ?? false) && (cats.has('nature') || cats.has('viewpoint') || cats.has('water')) && input.profile.interview.hikeAppetite !== 'none');
  /*
   * PRODUCTION LOCK V5 §22/§26 — SWIMWEAR NEEDS A SWIMMING SIGNAL.
   *
   * `water` is the category for a lake, a river, a harbour and a ferry
   * crossing, and a live Hong Kong build packed "swimwear and a quick-dry
   * towel" for a food-and-markets city trip whose only `water` stop was the
   * Star Ferry. A harbour crossing is transport.
   *
   * A beach and a geothermal pool are places somebody gets into the water, so
   * they still stand on their own. A plain `water` stop counts only when the
   * traveller said swimming matters to them — which is the difference between
   * "there is water on this trip" and "you will be in it".
   */
  const water = cats.has('beach') || cats.has('geothermal') || (cats.has('water') && interestOn(input.profile, 'beaches_and_swimming'));
  const wildlife = cats.has('wildlife');
  const legs = new Set(input.legModes);
  const episodes = new Set(input.episodeKinds ?? []);
  /*
   * V7 §13 — EVERY ITEM EARNS ITS PLACE. "Remote" used to mean "any guided
   * transfer anywhere", which put two litres of water a day and a headtorch on
   * a river cruise. Water and a torch belong to trail days and camps; a car
   * charger belongs to a car the traveller drives; a sleeping-bag liner to a
   * hut. A cruise packs for a deck, not for a bivouac.
   */
  const trek = episodes.has('trek') || episodes.has('hut_to_hut');
  const camps = input.lodgingKinds.includes('hut') || input.lodgingKinds.includes('camp');
  const trailDays = hikes || trek;
  const remoteOutdoors = input.remote && (trailDays || camps || episodes.has('safari') || episodes.has('guided_overland'));

  // Documents ---------------------------------------------------------------
  add('essential_documents', 'Passport or ID, valid for the trip', input.international === 'no' ? 'Your carrier will ask for photo ID.' : 'Required at the border; validity rules are the destination’s.');
  if (input.international !== 'no') add('essential_documents', 'Printed and offline copies of bookings and documents', 'Borders and bad signal both happen.');
  else add('essential_documents', 'Offline copies of bookings', 'Signal is not guaranteed everywhere on the route.');
  if (input.international === 'yes') add('essential_documents', 'Travel insurance details and the emergency number', 'You confirmed cover in Before you go; keep the number reachable.');
  if (input.drives) add('essential_documents', 'Driving licence and rental confirmation', 'This plan is driven.');
  if (input.drives && input.international === 'yes') add('essential_documents', 'International Driving Permit if the destination requires one', 'Not verified by Sidequest — check Before you go.');
  if (input.children) add('essential_documents', 'Children’s documents and any consent letters', 'Some borders ask when a child travels without both parents.');

  // Clothing / weather ------------------------------------------------------
  if (minC !== null && minC <= 8) add('clothing', 'Warm layers: fleece or wool mid-layer, warm hat', `Mornings near ${Math.round(minC)} °C on the ${input.weatherBasis === 'forecast' ? 'forecast' : 'climate record'}.`);
  if (minC !== null && minC <= 0) add('clothing', 'Insulated jacket and gloves', `Below freezing on at least one day (${input.weatherBasis}).`);
  if (maxC !== null && maxC >= 27) add('clothing', 'Light, breathable clothing and a sun hat', `Afternoons around ${Math.round(maxC)} °C (${input.weatherBasis}).`);
  if (maxC !== null && maxC >= 22) add('weather', 'Sunscreen and sunglasses', 'Warm days on the record, and outdoor time on most of them.');
  if (wet || (input.weatherBasis === 'climate' && hikes)) add('weather', 'Waterproof shell', wet ? 'Wet days on the record.' : 'Hiking days on a climate basis: rain cannot be ruled out.');
  if (windy) add('weather', 'Windproof layer', 'Gusts above 50 km/h on at least one day.');
  if (snowy) add('weather', 'Traction and waterproof boots', 'Snow on the record.');
  if (input.weatherBasis === 'unknown') add('weather', 'Layers for a range of conditions', 'No weather data reached this plan; pack for a range.');

  // Footwear / outdoor ------------------------------------------------------
  if (hikes) {
    add('footwear', 'Broken-in hiking boots or trail shoes', cats.has('hike') ? `${input.categories.filter((c) => c === 'hike').length} hiking stop${input.categories.filter((c) => c === 'hike').length === 1 ? '' : 's'} on the plan.` : 'Intense outdoor days on the plan.');
    add('outdoor', 'Daypack, water bottle, blister care', 'Half-day and longer walks.');
    add('outdoor', 'Trail snacks', 'Remote sections have nothing on the route.');
    if (profileHikesLong(input.profile)) add('outdoor', 'Trekking poles', 'Full-day hikes and real elevation.', true);
  } else if (cats.has('nature') || cats.has('viewpoint') || cats.has('scenic_drive')) add('footwear', 'Comfortable walking shoes with grip', 'Viewpoints and short walks on uneven ground.');
  else add('footwear', 'Comfortable walking shoes', 'The days are on foot between stops.');
  if (water) add('activity_specific', 'Swimwear and a quick-dry towel', cats.has('geothermal') ? 'Hot springs or geothermal pools on the plan.' : 'Water and beach stops on the plan.');
  if (wildlife) add('activity_specific', 'Binoculars', 'Wildlife stops on the plan.', true);
  if (cats.has('museum') || cats.has('historic')) add('clothing', 'One smarter layer', 'Museums, historic sites and the dinner worth booking.', true);
  if (interestOn(input.profile, 'photography_golden_hour')) add('activity_specific', 'Camera, spare battery, lens cloth', 'You marked photography as an interest.', true);
  if (interestOn(input.profile, 'stargazing')) add('activity_specific', 'Red-light headtorch', 'Stargazing on the plan.', true);

  // Electronics -------------------------------------------------------------
  add('electronics', 'Phone charger and a power bank', 'Maps, tickets and photos all run the battery down.');
  if (input.international === 'yes') add('electronics', 'Plug adapter for the destination', 'Plug type not verified by Sidequest — check before you go.');
  if (input.drives) add('electronics', 'Car charger', 'You are driving; the phone is the map.');
  else if (remoteOutdoors) add('electronics', 'A second power bank', 'Long days away from a socket.');

  // Health ------------------------------------------------------------------
  add('health_toiletries', 'Prescription medicines in original packaging, plus a few days extra', 'Sidequest never infers what you take; bring what you need and check destination restrictions.');
  add('health_toiletries', 'Small first-aid kit', hikes ? 'Blisters and scrapes on trail days.' : 'For the small things.');
  if (cats.has('geothermal') || cats.has('wildlife') || remoteOutdoors) add('health_toiletries', 'Insect repellent', 'Outdoor evenings on the plan.', true);

  // Transport ---------------------------------------------------------------
  if (legs.has('ferry') || legs.has('boat')) add('transport', 'Motion-sickness remedy and a dry bag', 'Ferry or boat legs on the plan.', true);
  if (legs.has('flight')) add('transport', 'Cabin-size bag that fits the internal flights', 'Internal flights on the plan; small carriers have small allowances.');
  if (input.drives) add('transport', 'Offline maps for the whole route', 'Driving through areas with no signal.');
  if (legs.has('rail') || legs.has('metro') || legs.has('bus')) add('transport', 'Transit pass or contactless card', 'Local transport is the plan.');

  // Remote ------------------------------------------------------------------
  if (remoteOutdoors && trailDays) add('remote_travel', 'Two litres of water per person on trail days', 'Trail sections with no services.');
  if (input.remote) add('remote_travel', 'Downloaded plan, maps and emergency numbers', 'No signal is the assumption out there.');
  if (trek || camps) add('remote_travel', 'Headtorch', 'Trek days that can end in the dark, and camp nights.', true);
  if (camps || trek) add('remote_travel', 'Sleeping bag liner, earplugs, quick-dry towel', 'Hut or camp nights on the plan.');
  if (episodes.has('cruise') || episodes.has('expedition_boat')) add('activity_specific', 'A layer for the deck and a small day bag for shore stops', 'Nights on board; excursions leave the ship with what you carry.', true);
  if (input.lodgingKinds.includes('hostel')) add('optional', 'Padlock and earplugs', 'Hostel nights.', true);

  const mapped = new Set(items.map((i) => i.label.toLowerCase()));
  const modelSuggestions = input.modelPacking.filter((s) => ![...mapped].some((m) => m.includes(s.toLowerCase().slice(0, 12))));

  return packingIntelligenceSchema.parse({
    items,
    basis: input.weatherBasis,
    basisNote: input.weatherBasis === 'forecast' ? 'Weather items come from the forecast for your dates.' : input.weatherBasis === 'climate' ? 'Weather items come from the climate record, not a forecast. Re-check the week before.' : 'No weather data; pack for a range and re-check before you go.',
    modelSuggestions,
  });
}

function interestOn(profile: TravelerProfile, interest: string): boolean {
  const level = (profile.interests as Record<string, string | undefined>)[interest];
  return level === 'occasional' || level === 'frequent' || level === 'core';
}

function profileHikesLong(profile: TravelerProfile): boolean {
  return profile.interview.hikeAppetite === 'full_day' || profile.interview.hikeAppetite === 'half_day';
}
