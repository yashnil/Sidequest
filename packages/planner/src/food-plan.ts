import {
  DIETARY_NEED_LABELS,
  MEDICAL_OR_OBSERVANT_NEEDS,
  type FoodDataset,
  type FoodPlan,
  type ItineraryDay,
  type TravelerProfile,
} from '@sidequest/core';
import type { FoodContext } from './food';

/**
 * The trip's food position, read back off the finished days.
 *
 * Derived rather than declared, like the transport strategy and the day weather
 * blocks, so it cannot claim a special meal the timeline does not contain or a
 * grocery run that never got scheduled. Everything here is either a fact from
 * the traveller's own answers or a count taken from the plan.
 *
 * There is no total food cost. Four venues in the whole region publish prices,
 * so a figure with a currency symbol on it would be a guess wearing a decimal
 * point — and the one number people would then plan around.
 */
export function buildFoodPlan(input: {
  days: readonly ItineraryDay[];
  profile: TravelerProfile;
  food: FoodContext | null;
  dataset: FoodDataset | null;
}): FoodPlan {
  const { days, profile } = input;
  const meals = days.flatMap((day) =>
    day.items.filter((item) => item.kind === 'meal').map((item) => ({ day, item })),
  );

  const specialMealsPlanned = meals.filter(({ item }) => item.food?.isSpecialMeal).length;
  const groceryDayNumbers = [
    ...new Set(
      meals
        .filter(({ item }) => item.food?.stopKind === 'grocery')
        .map(({ day }) => day.dayNumber),
    ),
  ].sort((a, b) => a - b);
  const packedDayNumbers = [
    ...new Set(
      meals.filter(({ item }) => item.food?.stopKind === 'packed').map(({ day }) => day.dayNumber),
    ),
  ].sort((a, b) => a - b);

  const daysWithoutVerifiedOption = days
    .filter(
      (day) =>
        day.items.some((item) => item.kind === 'meal') &&
        !day.items.some(
          (item) => item.food?.stopKind === 'venue' || item.food?.stopKind === 'packed',
        ),
    )
    .map((day) => day.dayNumber);

  const localSpecialties = [
    ...new Set(
      meals
        .map(({ item }) => item.food?.localSpecialty)
        .filter((label): label is string => label !== undefined),
    ),
  ].sort();

  const scheduledVenueIds = new Set(
    meals
      .map(({ item }) => item.food?.venueId)
      .filter((venueId): venueId is string => venueId !== undefined),
  );

  const needs = profile.food.dietaryNeeds;

  return {
    headline: headlineFor({
      named: meals.filter(({ item }) => item.food?.stopKind === 'venue').length,
      specialMealsPlanned,
      packedDays: packedDayNumbers.length,
      hasData: input.dataset !== null && input.dataset.venues.length > 0,
    }),
    style: styleCopy(profile),
    dietaryNeeds: [...needs],
    dietaryStrict: profile.food.dietaryStrict,
    ...(needs.length > 0 ? { dietaryDisclosure: dietaryDisclosure(profile) } : {}),
    specialMealsPlanned,
    specialMealBudget: profile.food.specialMealBudget,
    groceryDayNumbers,
    packedDayNumbers,
    daysWithoutVerifiedOption,
    localSpecialties,
    /**
     * Read off the finished days, never guessed at.
     *
     * Something the traveller asked for either appears on a timeline or appears
     * here with a reason. Deriving it from the shortlist instead — which is what
     * this did first — got it wrong in both directions at once.
     */
    unusedChoices: input.food
      ? input.food.userChosen
          .filter((venueId) => !scheduledVenueIds.has(venueId))
          .map((venueId) => ({
            venueId,
            name:
              input.dataset?.venues.find((venue) => venue.id === venueId)?.name ?? venueId,
            reason: input.food!.reasonForUnused(venueId),
          }))
      : [],
    dataDisclosure: disclosureFor(input.dataset),
  };
}

function headlineFor(input: {
  named: number;
  specialMealsPlanned: number;
  packedDays: number;
  hasData: boolean;
}): string {
  if (!input.hasData) {
    return 'We have no food data for this region, so every meal below is time held rather than somewhere named.';
  }
  if (input.named === 0) {
    return 'Nothing we can verify fitted the routes these days take, so the meals are time held rather than places.';
  }
  const parts = [`${input.named} named ${input.named === 1 ? 'meal' : 'meals'}`];
  if (input.specialMealsPlanned > 0) {
    parts.push(`${input.specialMealsPlanned} of them meant to be an event`);
  }
  if (input.packedDays > 0) {
    parts.push(`${input.packedDays} ${input.packedDays === 1 ? 'day' : 'days'} you carry lunch`);
  }
  return `${parts.join(', ')}.`;
}

function styleCopy(profile: TravelerProfile): string {
  switch (profile.food.style) {
    case 'budget':
      return 'Bakeries, groceries and counters, because that is how you said you wanted to eat.';
    case 'local_casual':
      return 'Where the town actually eats, rather than where the town sends visitors.';
    case 'balanced':
      return 'Casual most of the time, with the budget saved for the one that is worth it.';
    case 'destination':
      return 'The meal as the reason to be somewhere, where the route allows it.';
  }
}

/**
 * The one sentence about dietary needs, written once so no surface can soften
 * it. It never says safe, never says suitable, and always ends with the thing
 * the traveller has to do themselves.
 */
function dietaryDisclosure(profile: TravelerProfile): string {
  const labels = profile.food.dietaryNeeds.map((need) => DIETARY_NEED_LABELS[need].toLowerCase());
  const list = labels.length === 1 ? labels[0]! : `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}`;
  const medical = profile.food.dietaryNeeds.some((need) =>
    MEDICAL_OR_OBSERVANT_NEEDS.includes(need),
  );
  const base = `We only say a venue handles ${list} when the venue itself has published that it does, and we quote them.`;
  if (profile.food.dietaryStrict || medical) {
    return `${base} That is a menu claim, not a kitchen one — nothing here establishes how anything is prepared or what it is prepared beside, so confirm it with them directly before you rely on it.`;
  }
  return `${base} Where nobody has said either way, we say so rather than assume.`;
}

function disclosureFor(dataset: FoodDataset | null): string {
  if (!dataset || dataset.venues.length === 0) {
    return 'No food data reached this plan.';
  }
  return `Read from ${dataset.venues.length} venues in this region, mostly off their own pages, on the dates recorded against each one. Opening hours here change more than anything else we hold — several of these publish an opening time and nothing else — so treat a closing time as ours unless the venue is named as the source. We have not checked today.`;
}
