import { z } from 'zod';
import type { Itinerary, ItineraryDay } from '../schemas/itinerary';
import type { TravelerProfile } from '../schemas/profile';

/**
 * FOOD INTELLIGENCE V2: THE MEAL KEEPS ITS INTENT.
 *
 * A meal is a role in the day before it is a restaurant. When the venue the
 * model named cannot be found, or no food data exists for a valley, the day
 * still says "packed lunch, buy it the evening before" or "a simple dinner near
 * the new base". No restaurant lookup is allowed to touch the day's activities.
 */
export const MEAL_ROLES = ['convenience', 'local_specialty', 'destination_meal', 'packed_lunch', 'grocery', 'market', 'quick_pre_activity', 'post_activity', 'special_occasion', 'dietary_safe', 'skip'] as const;
export const mealRoleSchema = z.enum(MEAL_ROLES);
export type MealRole = z.infer<typeof mealRoleSchema>;

export const MEAL_ROLE_LABELS: Record<MealRole, string> = {
  convenience: 'Convenient',
  local_specialty: 'Local specialty',
  destination_meal: 'Worth the trip',
  packed_lunch: 'Packed lunch',
  grocery: 'Groceries',
  market: 'Market',
  quick_pre_activity: 'Quick, before the activity',
  post_activity: 'Recovery meal',
  special_occasion: 'The special one',
  dietary_safe: 'Safe for your diet',
  skip: 'Not planned',
};

export const mealPlanSchema = z.object({
  slot: z.enum(['breakfast', 'lunch', 'dinner', 'snack']),
  role: mealRoleSchema,
  /** PRODUCT RECOVERY V1 — the plan's own meal intent in the traveller's terms ("Seafood dinner around Dingle harbour"); never a fabricated venue. */
  intent: z.string().min(1).optional(),
  venueName: z.string().min(1).optional(),
  venueStatus: z.enum(['named', 'unresolved', 'none']),
  reservation: z.enum(['required', 'recommended', 'not_needed', 'unknown']),
  note: z.string().min(1),
  /** Minutes from midnight when the plan places it, if it does. */
  aroundMinute: z.number().int().min(0).max(1440).optional(),
});
export type MealPlan = z.infer<typeof mealPlanSchema>;

export const dayMealStrategySchema = z.object({
  dayNumber: z.number().int().min(1),
  remote: z.boolean(),
  meals: z.array(mealPlanSchema),
  provisioning: z.array(z.string().min(1)).default([]),
  dietaryNote: z.string().min(1).optional(),
});
export type DayMealStrategy = z.infer<typeof dayMealStrategySchema>;

/**
 * PRODUCT RECOVERY V1 — FOOD V3: when food is the traveller's stated priority,
 * the trip visibly reflects it without inventing a restaurant. The highlights
 * are read off the plan's own meal intents and stops: the markets it visits,
 * the food towns it sleeps in, the specialities it names, the one dinner it
 * calls special, the days it provisions. A food provider, when present, adds
 * names around this geography; when absent, the intents stand as written.
 */
export const foodHighlightsSchema = z.object({
  markets: z.array(z.object({ name: z.string().min(1), dayNumber: z.number().int().min(1) })).default([]),
  foodTowns: z.array(z.object({ name: z.string().min(1), why: z.string().min(1) })).default([]),
  specialties: z.array(z.string().min(1)).default([]),
  specialDinner: z.object({ dayNumber: z.number().int().min(1), intent: z.string().min(1), baseName: z.string().min(1) }).optional(),
  provisionedDays: z.array(z.number().int().min(1)).default([]),
  destinationMeals: z.array(z.object({ dayNumber: z.number().int().min(1), slot: z.enum(['breakfast', 'lunch', 'dinner']), intent: z.string().min(1) })).default([]),
});
export type FoodHighlights = z.infer<typeof foodHighlightsSchema>;

export const foodIntelligenceSchema = z.object({
  headline: z.string().min(1),
  days: z.array(dayMealStrategySchema),
  remoteDayNumbers: z.array(z.number().int().min(1)).default([]),
  reservations: z.array(z.object({ dayNumber: z.number().int().min(1), venueName: z.string().min(1), requirement: z.enum(['required', 'recommended']) })).default([]),
  specialOccasionDay: z.number().int().min(1).optional(),
  venueDataNote: z.string().min(1),
  /** PRODUCT RECOVERY V1 — how much food matters to this traveller, from the profile: core or frequent food interests make it high. */
  foodPriority: z.enum(['high', 'normal', 'low']).default('normal'),
  highlights: foodHighlightsSchema.optional(),
  strategy: z.array(z.string().min(1)).default([]),
});
export type FoodIntelligence = z.infer<typeof foodIntelligenceSchema>;

function isRemote(day: ItineraryDay, anchorCategories: readonly string[]): boolean {
  if (day.food.remote) return true;
  const outdoorHeavy = anchorCategories.filter((c) => c === 'hike' || c === 'wildlife' || c === 'nature' || c === 'scenic_drive').length >= 2;
  return outdoorHeavy || day.totals.travelKm > 180 || (day.intensity === 'intense' && anchorCategories.includes('hike'));
}

export interface FoodInput {
  itinerary: Itinerary;
  profile: TravelerProfile;
  /** Category per scheduled place id, from the package anchors. */
  categoryByPlace: ReadonlyMap<string, string>;
  /** Category per item id for model-authored stops with no place id. */
  categoryByItem: ReadonlyMap<string, string>;
  /** Days the transport or lodging already say are remote: lodge, camp, hut, boat or guide legs. */
  remoteDayHints?: ReadonlySet<number>;
}

const SPECIALTY_WORDS = /\b(chowder|seafood|oysters?|lobster|crab|mussels|fish and chips|stew|lamb|cheese|tapas|pintxos|ramen|sushi|kaiseki|pasta|pizza|gelato|paella|tagine|curry|barbecue|bbq|braai|nyama choma|pho|banh mi|dumplings|dim sum|soda bread|black pudding|brown bread|smoked salmon|salmon|langoustine|charcuterie|wine|whiskey|whisky|craft beer|cider|pastry|pastries|bakery)\b/gi;
const MARKET_WORDS = /\b(market|food hall|hawker|bazaar|mercado|marché|markt)\b/i;
const FOOD_TOWN_WORDS = /\b(food|gourmet|culinary|seafood|restaurants?|eating|gastro|foodie|pubs?|cuisine|dining)\b/i;

/** The draft's own meal intent behind a scheduled meal item ("Dinner — Seafood restaurant in Kinsale" → the part after the dash). */
function intentOf(title: string): string | undefined {
  const dash = title.indexOf('—');
  const intent = dash >= 0 ? title.slice(dash + 1).trim() : '';
  return intent.length > 0 ? intent : undefined;
}

function roleFromIntent(intent: string | undefined, slot: 'breakfast' | 'lunch' | 'dinner'): MealRole | null {
  if (!intent) return null;
  if (/\bpacked\b|\bpicnic\b/i.test(intent)) return 'packed_lunch';
  if (/\bgrocer|\bshop\b|\bsupermarket\b|\bprovision/i.test(intent)) return 'grocery';
  if (MARKET_WORDS.test(intent)) return 'market';
  if (/\bspecial\b|\btasting menu\b|\bfine dining\b|\bmichelin\b|\bcelebrat/i.test(intent)) return 'special_occasion';
  if (/\bworth (the|a) (drive|detour|trip)\b|\bdestination\b|\bfamous\b|\bbest\b/i.test(intent)) return 'destination_meal';
  if (slot === 'breakfast' && /\bcoffee\b|\bpastry\b|\bcafé\b|\bcafe\b/i.test(intent)) return 'convenience';
  if (SPECIALTY_WORDS.test(intent) || /\btraditional\b|\blocal\b|\bpub\b|\bregional\b|\bspecialit/i.test(intent)) return 'local_specialty';
  return null;
}

export function foodPriorityOf(profile: TravelerProfile): 'high' | 'normal' | 'low' {
  const levels = [profile.interests.food_and_towns, profile.interests.markets_and_street_food].filter(Boolean);
  if (levels.some((l) => l === 'core')) return 'high';
  if (levels.some((l) => l === 'frequent') || profile.food.style === 'destination') return 'high';
  if (profile.food.style === 'budget' && levels.every((l) => l === 'low' || l === 'avoid')) return 'low';
  return 'normal';
}

export function buildFoodIntelligence(input: FoodInput): FoodIntelligence {
  const { itinerary, profile } = input;
  const dietary = profile.food.dietaryNeeds;
  const strict = profile.food.dietaryStrict;
  const appetite = profile.food.specialMealAppetite;
  const totalDays = itinerary.days.length;
  const fullDays = itinerary.days.filter((d, i) => i !== 0 && i !== totalDays - 1);
  const foodPriority = foodPriorityOf(profile);
  // The plan's own "special" dinner wins over the lightest-day heuristic.
  const declaredSpecial = itinerary.days.find((d) => d.items.some((i) => i.kind === 'meal' && /^dinner/i.test(i.title) && /\bspecial\b|\btasting menu\b|\bfine dining\b/i.test(i.title)));
  const specialDay = appetite === 'none' ? undefined : (declaredSpecial ?? (fullDays.length > 0 ? [...fullDays].sort((a, b) => intensityRank(a) - intensityRank(b))[0]! : itinerary.days[itinerary.days.length - 1]!)).dayNumber;
  const highlights: FoodHighlights = { markets: [], foodTowns: [], specialties: [], provisionedDays: [], destinationMeals: [] };
  const specialtySet = new Set<string>();
  const reservations: FoodIntelligence['reservations'] = [];
  const remoteDayNumbers: number[] = [];
  let namedVenues = 0;
  let unresolved = 0;

  const days = itinerary.days.map((day) => {
    const categories = day.items.filter((i) => i.kind === 'activity').map((i) => (i.placeId ? input.categoryByPlace.get(i.placeId) : undefined) ?? input.categoryByItem.get(i.id) ?? 'other');
    const remote = isRemote(day, categories) || (input.remoteDayHints?.has(day.dayNumber) ?? false);
    if (remote) remoteDayNumbers.push(day.dayNumber);
    const relocation = day.totals.driveMinutes >= 120 || day.totals.transitMinutes >= 120;
    const isFirst = day.dayNumber === itinerary.days[0]!.dayNumber;
    const isLast = day.dayNumber === itinerary.days[totalDays - 1]!.dayNumber;
    const foodItems = day.items.filter((i) => i.food);
    const mealItems = day.items.filter((i) => i.kind === 'meal');
    const provisioning: string[] = [];
    const meals: MealPlan[] = [];
    for (const item of day.items) {
      if (item.kind === 'activity' && (input.categoryByItem.get(item.id) === 'market' || (item.placeId && input.categoryByPlace.get(item.placeId) === 'market') || MARKET_WORDS.test(item.title))) {
        if (!highlights.markets.some((m) => m.name === item.title)) highlights.markets.push({ name: item.title, dayNumber: day.dayNumber });
      }
    }

    for (const slot of ['breakfast', 'lunch', 'dinner'] as const) {
      const scheduled = foodItems.find((i) => i.food!.slot === slot);
      const mealItem = scheduled ?? mealItems.find((i) => i.id.endsWith(`-${slot}`) || new RegExp(`^${slot}`, 'i').test(i.title));
      const intent = mealItem ? intentOf(mealItem.title) : undefined;
      for (const match of intent?.match(SPECIALTY_WORDS) ?? []) specialtySet.add(match.toLowerCase());
      const intentRole = roleFromIntent(intent, slot);
      const named = scheduled?.food?.venueName;
      const stopKind = scheduled?.food?.stopKind;
      const reservationReq = scheduled?.food?.reservation?.requirement;
      const reservation: MealPlan['reservation'] = reservationReq === 'required' ? 'required' : reservationReq === 'recommended' ? 'recommended' : reservationReq === 'walk_in_only' ? 'not_needed' : 'unknown';
      if (reservation === 'required' || reservation === 'recommended') reservations.push({ dayNumber: day.dayNumber, venueName: named ?? `${slot} venue`, requirement: reservation });

      let role: MealRole;
      let note: string;
      if (slot === 'breakfast') {
        if (isFirst && day.window.startMinute > 11 * 60) {
          role = 'skip';
          note = 'You arrive after breakfast.';
        } else if (remote || day.window.startMinute <= 7 * 60 + 30) {
          role = 'quick_pre_activity';
          note = 'Eat before you set off; there may be nothing on the route.';
        } else {
          role = 'convenience';
          note = 'At or near where you sleep.';
        }
      } else if (slot === 'lunch') {
        if (stopKind === 'packed' || (remote && stopKind !== 'venue')) {
          role = 'packed_lunch';
          note = 'Carry it. Nothing on this stretch is counted on.';
          provisioning.push('Buy lunch and snacks the evening before or at the first shop of the day.');
        } else if (stopKind === 'grocery') {
          role = 'grocery';
          note = 'A shop on the way replaces a sit-down lunch.';
        } else if (relocation) {
          role = 'convenience';
          note = 'On the way between bases; keep it quick.';
        } else if (categories.includes('market')) {
          role = 'market';
          note = 'The day already passes a market.';
        } else if (day.intensity === 'intense') {
          role = 'post_activity';
          note = 'After the big effort of the day.';
        } else {
          role = named ? 'local_specialty' : 'convenience';
          note = named ? 'Near the day’s stops.' : 'Somewhere near the day’s stops; Sidequest has not named a venue.';
        }
      } else {
        if (isLast && day.window.endMinute < 18 * 60) {
          role = 'skip';
          note = 'You leave before dinner.';
        } else if (specialDay === day.dayNumber) {
          role = 'special_occasion';
          note = named ? 'This is the one worth booking.' : 'The evening to book something good; Sidequest has not named the venue.';
        } else if (relocation) {
          role = 'convenience';
          note = 'Near the new base; do not add a drive after a transfer.';
        } else if (remote) {
          role = 'convenience';
          note = 'At or near the lodging; options are thin out here.';
        } else if (dietary.length > 0 && strict) {
          role = 'dietary_safe';
          note = 'Choose somewhere that can cater strictly; confirm on the day.';
        } else {
          role = named ? 'local_specialty' : 'convenience';
          note = named ? 'Near base.' : 'Near base; Sidequest has not named a venue.';
        }
      }
      /*
       * PRODUCT RECOVERY V1 — the plan's own intent refines the role: a market
       * lunch is a market, a packed lunch is provisioning, "special seafood
       * dinner in Dingle" is the special one, "chowder in Dingle" is a local
       * speciality. Skips and remote/relocation constraints still win.
       */
      // A slot the plan never scheduled (lunch on a 16:00 arrival day) is not a meal the traveller is owed; say so instead of inventing a role.
      if (!mealItem && role !== 'skip') {
        role = 'skip';
        note = slot === 'lunch' && isFirst ? 'Not planned: you arrive after lunch.' : 'Not planned for this day.';
      }
      if (role !== 'skip' && intentRole && !(intentRole === 'special_occasion' && specialDay !== day.dayNumber)) {
        if (intentRole === 'packed_lunch' && role !== 'packed_lunch') provisioning.push('Buy lunch and snacks the evening before or at the first shop of the day.');
        role = intentRole;
        if (intentRole === 'packed_lunch') note = 'Carry it, as the plan says. Nothing on this stretch is counted on.';
        else if (intentRole === 'market') note = 'The plan eats at a market here — a food highlight, not a fallback.';
        else if (intentRole === 'special_occasion') note = 'The plan’s own special meal. Book it once you know the base.';
        else if (intentRole === 'destination_meal') note = 'Worth the trip in the plan’s judgement; a venue still needs choosing.';
        else if (intentRole === 'local_specialty') note = named ? 'Near the day’s stops.' : 'A local speciality the plan calls for; choose the venue on the day or with a food provider.';
      }
      if (role === 'packed_lunch' && !highlights.provisionedDays.includes(day.dayNumber)) highlights.provisionedDays.push(day.dayNumber);
      if (role === 'destination_meal' && intent) highlights.destinationMeals.push({ dayNumber: day.dayNumber, slot, intent });
      if (role === 'special_occasion' && intent && !highlights.specialDinner) highlights.specialDinner = { dayNumber: day.dayNumber, intent, baseName: day.baseName };
      if (named) namedVenues += 1;
      else if (scheduled && stopKind === 'venue') unresolved += 1;
      meals.push({
        slot,
        role,
        ...(intent ? { intent } : {}),
        ...(named ? { venueName: named } : {}),
        venueStatus: named ? 'named' : scheduled && stopKind === 'venue' ? 'unresolved' : 'none',
        reservation,
        note,
        ...(mealItem ? { aroundMinute: mealItem.startMinute } : {}),
      });
    }
    if (remote) provisioning.push('Carry water and snacks; refill where you can.');
    if (day.food.slots.includes('snack')) provisioning.push('A snack stop is already in the day.');
    const dietaryNote = dietary.length > 0 ? `${strict ? 'Strict' : 'Preferred'}: ${dietary.join(', ')}. Sidequest verified dietary claims only where a venue published them.` : undefined;
    return dayMealStrategySchema.parse({ dayNumber: day.dayNumber, remote, meals, provisioning: [...new Set(provisioning)], ...(dietaryNote ? { dietaryNote } : {}) });
  });

  // Food towns: bases whose own rationale names food.
  for (const base of itinerary.package?.bases ?? []) {
    if (FOOD_TOWN_WORDS.test(base.why) && !highlights.foodTowns.some((t) => t.name === base.name)) highlights.foodTowns.push({ name: base.name, why: base.why });
  }
  highlights.specialties = [...specialtySet].slice(0, 8);
  const strategy: string[] = [];
  if (foodPriority === 'high') {
    if (highlights.markets.length > 0) strategy.push(`${highlights.markets.map((m) => m.name).join(', ')} on the route, eaten at rather than passed.`);
    if (highlights.foodTowns.length > 0) strategy.push(`Bases chosen partly for the table: ${highlights.foodTowns.map((t) => t.name).join(', ')}.`);
    if (highlights.specialDinner) strategy.push(`One dinner worth booking: ${highlights.specialDinner.intent} (day ${highlights.specialDinner.dayNumber}, ${highlights.specialDinner.baseName}).`);
    if (highlights.specialties.length > 0) strategy.push(`Specialities the plan names: ${highlights.specialties.join(', ')}.`);
    if (highlights.provisionedDays.length > 0) strategy.push(`Packed lunches on day${highlights.provisionedDays.length === 1 ? '' : 's'} ${highlights.provisionedDays.join(', ')} — the remote or long-drive days; buy the evening before.`);
    if (strategy.length === 0) strategy.push('Food is a priority for you; the plan keeps meals near the day’s stops and one evening open for something good.');
  }

  return foodIntelligenceSchema.parse({
    headline: itinerary.foodPlan.headline,
    days,
    remoteDayNumbers,
    reservations,
    foodPriority,
    highlights,
    strategy,
    ...(specialDay ? { specialOccasionDay: specialDay } : {}),
    venueDataNote:
      namedVenues === 0
        ? 'No venue could be named from the region’s food data, so every meal keeps its role rather than a restaurant. Nothing in the days depends on this.'
        : unresolved > 0
          ? `${namedVenues} meals name a venue from the region’s food data; ${unresolved} keep their role without one.`
          : `${namedVenues} meals name a venue from the region’s food data.`,
  });
}

function intensityRank(day: ItineraryDay): number {
  return day.intensity === 'light' ? 0 : day.intensity === 'moderate' ? 1 : 2;
}
