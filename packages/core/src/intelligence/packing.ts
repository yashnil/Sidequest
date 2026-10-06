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
  /**
   * V1 convergence — the scheduled stops themselves, so an item can name the
   * stop that put it on the list and so a kind that only a stop's own words
   * carry (a temple, a stargazing site, an after-dark walk) can be read.
   */
  activities?: readonly PackingActivity[];
}

export interface PackingActivity {
  title: string;
  category: string;
  dayNumber: number;
  startMinute: number;
  endMinute: number;
}

/*
 * A KIND OF PLACE, READ FROM ITS OWN NAME — never a destination. The words a
 * religious site calls itself in English, and the words an after-dark sky
 * experience does. Read only on stops whose category already allows it, so a
 * "Temple Bar" pub (category food) is not a temple.
 */
const RELIGIOUS_SITE = /\b(temple|shrine|mosque|masjid|church|cathedral|basilica|chapel|monastery|abbey|convent|pagoda|stupa|synagogue|gurdwara|wat|mandir|minster|kirk)\b/i;
const RELIGIOUS_CATEGORIES = new Set(['historic', 'landmark', 'other', 'town', 'neighbourhood', 'activity', 'museum']);
const NIGHT_SKY = /\b(stargaz\w*|star ?party|night sky|dark sky|dark-sky|astronom\w*|observatory|aurora|northern lights|milky way|night walk|night safari|night tour|moonlit)\b/i;
const OUTDOOR_CATEGORIES = new Set(['nature', 'hike', 'viewpoint', 'water', 'wildlife', 'scenic_drive', 'beach', 'geothermal']);
/** After this minute of the day an outdoor stop is an after-dark stop whatever the season's sunset. */
const AFTER_DARK_START = 21 * 60;

function stopList(stops: readonly PackingActivity[]): string {
  const names = [...new Set(stops.map((s) => s.title))];
  const shown = names.slice(0, 3).join(', ');
  return names.length > 3 ? `${shown} and ${names.length - 3} more` : shown;
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

  /*
   * V11 §37 — A MULTI-DAY TREK IS ITS OWN WEATHER SIGNAL.
   *
   * The founder's Kyrgyzstan trip crossed a pass around 3,900 m and slept two
   * nights at altitude, and its entire clothing list was "Light, breathable
   * clothing and a sun hat". Not a bug in the rules below: every day's recorded
   * weather is the *base town's* weather, and the base towns sit near 1,700 m at
   * 12–22 °C. A trek day is not at the base's altitude, so a base-town
   * temperature says nothing about it.
   *
   * A multi-day trek or hut-to-hut with overnights is exposure by definition, so
   * the layers are stated from the shape of the trip rather than from a
   * thermometer that was somewhere else. Never from a place name.
   */
  const mountainOvernights = trek && camps;

  // Clothing / weather ------------------------------------------------------
  if (minC !== null && minC <= 8) add('clothing', 'Warm layers: fleece or wool mid-layer, warm hat', `Mornings near ${Math.round(minC)} °C on the ${input.weatherBasis === 'forecast' ? 'forecast' : 'climate record'}.`);
  else if (mountainOvernights) add('clothing', 'Warm layers: fleece or wool mid-layer, warm hat', 'Nights out on a multi-day trek; the temperatures on this plan are the valley’s, not the pass’s.');
  if (minC !== null && minC <= 0) add('clothing', 'Insulated jacket and gloves', `Below freezing on at least one day (${input.weatherBasis}).`);
  else if (mountainOvernights) add('clothing', 'Insulating layer and gloves', 'A high crossing with camp nights either side; it is cold up there whatever the valley does.');
  if (mountainOvernights) add('weather', 'Waterproof shell', 'Multi-day trek: weather changes on a pass faster than a forecast can follow it.');
  if (maxC !== null && maxC >= 27) add('clothing', 'Light, breathable clothing and a sun hat', `Afternoons around ${Math.round(maxC)} °C (${input.weatherBasis}).`);
  if (maxC !== null && maxC >= 22) add('weather', 'Sunscreen and sunglasses', 'Warm days on the record, and outdoor time on most of them.');
  if (wet || (input.weatherBasis === 'climate' && hikes)) add('weather', 'Waterproof shell', wet ? 'Wet days on the record.' : 'Hiking days on a climate basis: rain cannot be ruled out.');
  if (windy) add('weather', 'Windproof layer', 'Gusts above 50 km/h on at least one day.');
  if (snowy) add('weather', 'Traction and waterproof boots', 'Snow on the record.');
  if (input.weatherBasis === 'unknown') add('weather', 'Layers for a range of conditions', 'No weather data reached this plan; pack for a range.');

  // Footwear / outdoor ------------------------------------------------------
  const activities = input.activities ?? [];
  const hikeStops = activities.filter((a) => a.category === 'hike');
  if (hikes) {
    add('footwear', 'Broken-in hiking boots or trail shoes', cats.has('hike') ? `${input.categories.filter((c) => c === 'hike').length} hiking stop${input.categories.filter((c) => c === 'hike').length === 1 ? '' : 's'} on the plan${hikeStops.length > 0 ? `: ${stopList(hikeStops)}` : ''}.` : 'Intense outdoor days on the plan.');
    add('outdoor', 'Daypack, water bottle, blister care', 'Half-day and longer walks.');
    add('outdoor', 'Trail snacks', 'Remote sections have nothing on the route.');
    /* §37 — optional on a day hike, not on a multi-day crossing with a descent. */
    if (trek) add('outdoor', 'Trekking poles', 'A multi-day crossing with a long descent; poles save the knees.');
    else if (profileHikesLong(input.profile)) add('outdoor', 'Trekking poles', 'Full-day hikes and real elevation.', true);
  } else if (cats.has('nature') || cats.has('viewpoint') || cats.has('scenic_drive')) add('footwear', 'Comfortable walking shoes with grip', 'Viewpoints and short walks on uneven ground.');
  /* V1 convergence — "comfortable shoes" is every trip on earth; it earns a line only when the trip moves on foot. */
  else if (legs.has('walk') || legs.has('metro')) add('footwear', 'Comfortable walking shoes', 'This plan moves between stops on foot.');
  const swimStops = activities.filter((a) => a.category === 'beach' || a.category === 'geothermal');
  if (water) add('activity_specific', 'Swimwear and a quick-dry towel', `${cats.has('geothermal') ? 'Hot springs or geothermal pools on the plan' : 'Water and beach stops on the plan'}${swimStops.length > 0 ? `: ${stopList(swimStops)}` : ''}.`);
  /*
   * V1 convergence — WHAT A STOP'S KIND ASKS OF CLOTHING. A temple, mosque or
   * cathedral on the plan is a covered-shoulders-and-knees visit at many of
   * them; the line names the stops so the traveller can check each one.
   */
  const religious = activities.filter((a) => RELIGIOUS_CATEGORIES.has(a.category) && RELIGIOUS_SITE.test(a.title));
  if (religious.length > 0) add('clothing', 'Clothes that cover shoulders and knees, or a light scarf to cover up', `Places of worship on the plan (${stopList(religious)}); many ask visitors to cover up — check each before you go.`);
  /* An outdoor stop after dark — stargazing, an aurora watch, a night walk — needs light and warmth whatever the afternoon did. */
  const afterDark = activities.filter((a) => NIGHT_SKY.test(a.title) || (OUTDOOR_CATEGORIES.has(a.category) && (a.startMinute >= AFTER_DARK_START || a.endMinute >= AFTER_DARK_START + 30)));
  if (afterDark.length > 0) {
    add('activity_specific', 'Headtorch, ideally with a red-light mode', `After-dark stops on the plan: ${stopList(afterDark)}.`);
    add('clothing', 'A warm layer for after dark', `Outdoors after dark on day ${[...new Set(afterDark.map((a) => a.dayNumber))].join(', ')}; it cools fast once the sun is down.`);
  }
  if (wildlife) add('activity_specific', 'Binoculars', 'Wildlife stops on the plan.', true);
  if (cats.has('museum') || cats.has('historic')) add('clothing', 'One smarter layer', 'Museums, historic sites and the dinner worth booking.', true);
  if (interestOn(input.profile, 'photography_golden_hour')) add('activity_specific', 'Camera, spare battery, lens cloth', 'You marked photography as an interest.', true);
  /* Stargazing as an interest is not stargazing on the plan; the stop-based line above is the one that says so. */

  // Electronics -------------------------------------------------------------
  /* V1 convergence — a charger is every trip on earth. A power bank earns its line when the phone is the map or the ticket all day. */
  if (trailDays || transitPlanFor(input) || legs.has('walk')) add('electronics', 'Power bank', trailDays ? 'Long trail days with the phone as map and camera.' : 'The phone is the map and the ticket on days spent out between stops.');
  if (input.international === 'yes') add('electronics', 'Plug adapter for the destination', 'Plug type not verified by Sidequest — check before you go.');
  if (input.drives) add('electronics', 'Car charger', 'You are driving; the phone is the map.');
  else if (remoteOutdoors) add('electronics', 'A second power bank', 'Long days away from a socket.');

  // Health ------------------------------------------------------------------
  /* Only where a border makes it a rule to follow: restrictions on carried medicines are the destination's. */
  if (input.international === 'yes') add('health_toiletries', 'Prescription medicines in original packaging, plus a few days extra', 'Sidequest never infers what you take; some countries restrict carried medicines — check before you go.');
  if (hikes) add('health_toiletries', 'Small first-aid kit with blister care', 'Blisters and scrapes on trail days.');
  if (cats.has('geothermal') || cats.has('wildlife') || remoteOutdoors) add('health_toiletries', 'Insect repellent', 'Outdoor evenings on the plan.', true);

  // Transport ---------------------------------------------------------------
  if (legs.has('ferry') || legs.has('boat')) add('transport', 'Motion-sickness remedy and a dry bag', 'Ferry or boat legs on the plan.', true);
  if (legs.has('flight')) add('transport', 'Cabin-size bag that fits the internal flights', 'Internal flights on the plan; small carriers have small allowances.');
  if (input.drives) add('transport', 'Offline maps for the whole route', 'Driving through areas with no signal.');
  /*
   * V11 §37 — A TRANSIT PASS NEEDS THE TRIP TO USE TRANSIT.
   *
   * The founder's Kyrgyzstan trip packed one for eleven days of private driver
   * and guided treks, because a single leg had been *corrected* to a bus by the
   * V11 §10 defect. The correction is fixed; this is the second lock. Public
   * transport has to be how the trip moves, not something one leg fell back to.
   */
  if (transitPlanFor(input)) add('transport', 'Transit pass or contactless card', 'Local transport is how this trip moves.');

  // Remote ------------------------------------------------------------------
  if (remoteOutdoors && trailDays) add('remote_travel', 'Two litres of water per person on trail days', 'Trail sections with no services.');
  if (input.remote) add('remote_travel', 'Downloaded plan, maps and emergency numbers', 'No signal is the assumption out there.');
  /* §37 — a torch is equipment on a trek and a convenience on a lodge night. */
  if (trek) add('remote_travel', 'Headtorch and spare batteries', 'Trek days that can end in the dark, and camp nights with no light.');
  else if (camps) add('remote_travel', 'Headtorch', 'Camp nights on the plan.', true);
  if (camps || trek) add('remote_travel', 'Sleeping bag liner, earplugs, quick-dry towel', 'Hut or camp nights on the plan.');
  if (episodes.has('cruise') || episodes.has('expedition_boat')) add('activity_specific', 'A layer for the deck and a small day bag for shore stops', 'Nights on board; excursions leave the ship with what you carry.', true);
  if (input.lodgingKinds.includes('hostel')) add('optional', 'Padlock and earplugs', 'Hostel nights.', true);

  const modelSuggestions = mergeModelPacking(items, input.modelPacking);

  return packingIntelligenceSchema.parse({
    items,
    basis: input.weatherBasis,
    basisNote: input.weatherBasis === 'forecast' ? 'Weather items come from the forecast for your dates.' : input.weatherBasis === 'climate' ? 'Weather items come from the climate record, not a forecast. Re-check the week before.' : 'No weather data; pack for a range and re-check before you go.',
    modelSuggestions,
  });
}

/*
 * V11 §37 — A TRANSIT PASS NEEDS THE TRIP TO USE TRANSIT. Public transport has
 * to be how the trip moves, not something one leg fell back to.
 */
function transitPlanFor(input: PackingInput): boolean {
  const primaryMode = input.itinerary.transportStrategy?.primaryMode;
  return primaryMode === 'public_bus' || primaryMode === 'rail' || (input.legModes.includes('metro') && !input.drives);
}

/*
 * V1 CONVERGENCE — THE MODEL'S LIST, MERGED RATHER THAN APPENDED.
 *
 * The composing model writes its own packing lines ("Rain jacket", "Phone
 * charger and adapter"). A line that names a need the derived list already
 * covers is the same advice twice in other words; it is dropped. Matching is by
 * the need a line is about, not by its first twelve characters, which is how
 * "Rain jacket" used to sit under "Waterproof shell".
 */
const PACKING_NEEDS: readonly [string, RegExp][] = [
  ['rain', /\b(rain|waterproof|shell|poncho|umbrella)\b/i],
  ['sun', /\b(sun ?screen|suncream|sun ?hat|sunglasses|spf)\b/i],
  ['footwear', /\b(shoes?|boots?|footwear|trainers|sneakers|sandals)\b/i],
  ['power', /\b(charger|power ?bank|battery pack|adapter|adaptor|plug)\b/i],
  ['documents', /\b(passport|documents?|insurance|licen[cs]e|permit|id card)\b/i],
  ['swim', /\b(swim\w*|bathing suit|towel)\b/i],
  ['warm', /\b(fleece|warm layers?|down jacket|insulat\w+|thermal|gloves|beanie|warm hat)\b/i],
  ['water', /\b(water bottle|hydration|litres of water|bottle)\b/i],
  ['light', /\b(head ?torch|head ?lamp|torch|flashlight)\b/i],
  ['insect', /\b(insect|repellent|mosquito|bug spray|deet)\b/i],
  ['health', /\b(first[- ]aid|medicines?|medication|meds|blister)\b/i],
  ['binoculars', /\bbinoculars\b/i],
  ['bag', /\b(day ?pack|backpack|day bag|dry bag)\b/i],
  ['cover', /\b(scarf|shoulders|modest)\b/i],
  ['transit', /\b(transit pass|travel card|contactless|metro card|oyster)\b/i],
];

function needsOf(text: string): Set<string> {
  return new Set(PACKING_NEEDS.filter(([, pattern]) => pattern.test(text)).map(([need]) => need));
}

export function mergeModelPacking(items: readonly PackingItem[], modelPacking: readonly string[]): string[] {
  const covered = new Set<string>();
  for (const item of items) for (const need of needsOf(item.label)) covered.add(need);
  const labels = items.map((i) => i.label.toLowerCase());
  const kept: string[] = [];
  const keptNeeds = new Set<string>();
  for (const raw of modelPacking) {
    const line = raw.trim();
    if (!line) continue;
    const lower = line.toLowerCase();
    if (labels.some((l) => l.includes(lower) || lower.includes(l))) continue;
    const needs = needsOf(line);
    /* Every need the line names is already on the list (or already offered once): the line adds nothing. */
    if (needs.size > 0 && [...needs].every((n) => covered.has(n) || keptNeeds.has(n))) continue;
    if (kept.some((k) => k.toLowerCase() === lower)) continue;
    kept.push(line);
    for (const n of needs) keptNeeds.add(n);
  }
  return kept;
}

function interestOn(profile: TravelerProfile, interest: string): boolean {
  const level = (profile.interests as Record<string, string | undefined>)[interest];
  return level === 'occasional' || level === 'frequent' || level === 'core';
}

function profileHikesLong(profile: TravelerProfile): boolean {
  return profile.interview.hikeAppetite === 'full_day' || profile.interview.hikeAppetite === 'half_day';
}
