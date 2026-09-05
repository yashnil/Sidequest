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

export const foodIntelligenceSchema = z.object({
  headline: z.string().min(1),
  days: z.array(dayMealStrategySchema),
  remoteDayNumbers: z.array(z.number().int().min(1)).default([]),
  reservations: z.array(z.object({ dayNumber: z.number().int().min(1), venueName: z.string().min(1), requirement: z.enum(['required', 'recommended']) })).default([]),
  specialOccasionDay: z.number().int().min(1).optional(),
  venueDataNote: z.string().min(1),
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

export function buildFoodIntelligence(input: FoodInput): FoodIntelligence {
  const { itinerary, profile } = input;
  const dietary = profile.food.dietaryNeeds;
  const strict = profile.food.dietaryStrict;
  const appetite = profile.food.specialMealAppetite;
  const totalDays = itinerary.days.length;
  const fullDays = itinerary.days.filter((d, i) => i !== 0 && i !== totalDays - 1);
  const specialDay = appetite === 'none' ? undefined : (fullDays.length > 0 ? [...fullDays].sort((a, b) => intensityRank(a) - intensityRank(b))[0]! : itinerary.days[itinerary.days.length - 1]!).dayNumber;
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
    const provisioning: string[] = [];
    const meals: MealPlan[] = [];

    for (const slot of ['breakfast', 'lunch', 'dinner'] as const) {
      const scheduled = foodItems.find((i) => i.food!.slot === slot);
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
      if (named) namedVenues += 1;
      else if (scheduled && stopKind === 'venue') unresolved += 1;
      meals.push({
        slot,
        role,
        ...(named ? { venueName: named } : {}),
        venueStatus: named ? 'named' : scheduled && stopKind === 'venue' ? 'unresolved' : 'none',
        reservation,
        note,
        ...(scheduled ? { aroundMinute: scheduled.startMinute } : {}),
      });
    }
    if (remote) provisioning.push('Carry water and snacks; refill where you can.');
    if (day.food.slots.includes('snack')) provisioning.push('A snack stop is already in the day.');
    const dietaryNote = dietary.length > 0 ? `${strict ? 'Strict' : 'Preferred'}: ${dietary.join(', ')}. Sidequest verified dietary claims only where a venue published them.` : undefined;
    return dayMealStrategySchema.parse({ dayNumber: day.dayNumber, remote, meals, provisioning: [...new Set(provisioning)], ...(dietaryNote ? { dietaryNote } : {}) });
  });

  return foodIntelligenceSchema.parse({
    headline: itinerary.foodPlan.headline,
    days,
    remoteDayNumbers,
    reservations,
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
