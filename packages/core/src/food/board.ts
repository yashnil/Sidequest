import { venueHoursOn } from './availability';
import { foodDistinctiveness, foodNameCounts, type FoodDistinctiveness } from './quality';
import {
  FOOD_SERVICE_TYPE_LABELS,
  PRICE_BAND_ORDER,
  PRICE_BAND_WORDS,
  type FoodDataset,
  type FoodServiceType,
  type FoodVenue,
  type PriceBand,
} from '../schemas/food';
import type { TravelerProfile } from '../schemas/profile';

/**
 * A short, derived list of food stops worth having an opinion about — never a
 * second board.
 *
 * Twenty restaurant cards beside twenty-three attraction cards would double the
 * length of the page to let somebody express a preference the planner can mostly
 * work out for itself. What this surfaces is the handful where the traveller's
 * opinion genuinely changes the trip: the meal that is meant to be an event, the
 * thing a place is famous for, the shop a remote day depends on, the stop forty
 * minutes south that only makes sense if a day already goes that way.
 *
 * These consume no itinerary capacity and are counted against no frequency cap.
 * Saying yes to one is a preference the planner honours where it legally can and
 * reports as a conflict where it cannot; saying no removes it outright.
 */
export interface FoodBoardEntry {
  venueId: string;
  name: string;
  locality: string;
  serviceType: FoodServiceType;
  serviceTypeLabel: string;
  priceBand: PriceBand;
  priceWord: string;
  description: string;
  /** Why this one is on a list of six rather than a list of twenty. */
  why: string;
  /** True when it is shut on every date of the trip. Shown, never hidden. */
  closedThroughout: boolean;
  /** True when nobody published hours for it at all. A different sentence. */
  hoursUnknown: boolean;
  sourceName: string;
  sourceUrl?: string;
}

const MAX_ENTRIES = 6;

export function foodBoardFor(input: {
  dataset: FoodDataset;
  profile: TravelerProfile;
  dates: readonly string[];
}): FoodBoardEntry[] {
  const { dataset, profile, dates } = input;
  const everyday = PRICE_BAND_ORDER[profile.food.everydayPriceBand];

  /*
   * Distinctiveness is computed over the whole dataset once, because "is this an
   * outlet of something" is a fact about the region's venue list rather than
   * about the record. See `food/quality.ts`.
   */
  const counts = foodNameCounts(dataset.venues);
  const scored = dataset.venues
    .map((venue) => {
      const quality = foodDistinctiveness(venue, counts);
      return { venue, quality, ...reasonFor(venue, profile, everyday, quality) };
    })
    .filter((entry) => entry.weight > 0)
    .sort(
      (a, b) =>
        b.weight - a.weight ||
        b.quality.score - a.quality.score ||
        a.venue.name.localeCompare(b.venue.name),
    )
    .slice(0, MAX_ENTRIES);

  return scored.map(({ venue, why }) => ({
    venueId: venue.id,
    name: venue.name,
    locality: venue.locality,
    serviceType: venue.serviceType,
    serviceTypeLabel: FOOD_SERVICE_TYPE_LABELS[venue.serviceType],
    priceBand: venue.priceBand,
    priceWord: PRICE_BAND_WORDS[venue.priceBand],
    description: venue.shortDescription,
    why,
    // Two different statements, kept apart. "Shut on your dates" is a claim
    // about the venue; "nobody publishes its hours" is a claim about our data,
    // and saying the first when we mean the second states a fact the record
    // itself disclaims.
    closedThroughout: dates.every((date) => venueHoursOn(venue, date).status === 'closed'),
    hoursUnknown: dates.every((date) => venueHoursOn(venue, date).status === 'unknown'),
    sourceName: venue.source.name,
    ...(venue.source.url ? { sourceUrl: venue.source.url } : {}),
  }));
}

/**
 * Why a venue earns a place on the short list, and how strongly.
 *
 * Weight zero means it does not: an ordinary good restaurant in the town you are
 * staying in is something the planner can pick without being asked, and asking
 * anyway is how a board becomes a form.
 */
function reasonFor(
  venue: FoodVenue,
  profile: TravelerProfile,
  everyday: number,
  quality: FoodDistinctiveness,
): { weight: number; why: string } {
  const band = PRICE_BAND_ORDER[venue.priceBand];

  if (band > everyday) {
    return profile.food.specialMealBudget > 0
      ? {
          weight: 100,
          why: `A candidate for the ${
            profile.food.specialMealBudget === 1 ? 'one meal' : 'meals'
          } you said should be an event.`,
        }
      : { weight: 0, why: '' };
  }

  if (venue.localSpecialty) {
    return { weight: 80, why: `${venue.localSpecialty.label} — ${venue.localSpecialty.note}` };
  }

  if (venue.provisioning === 'packed_meals' && profile.food.willPackLunch) {
    return {
      weight: 60,
      why: 'Where a packed lunch comes from on a day with nothing to buy out there.',
    };
  }

  /**
   * THE COMPILED REGION'S ROWS, WHICH USED TO BE NONE.
   *
   * Every one of the four rules above reads a field that only an *authored*
   * region has ever filled in. A compiled venue arrives with `moderate`,
   * `format_inferred`, no local speciality and no provisioning, so every branch
   * above returned zero and a live six-day trip in a food-first destination
   * showed the traveller not one food card — while the plan quietly went ahead
   * and picked their meals for them.
   *
   * What is surfaced instead is the handful where an opinion genuinely changes
   * the trip, in the vocabulary §15 asks for: a market is a thing to do as well
   * as somewhere to eat, and a venue that is particular to this place is worth
   * asking about in a way an outlet of a chain is not. Everything else is still
   * left to the planner, because a board that lists every restaurant is a form.
   */
  if (venue.serviceType === 'market' || venue.serviceType === 'food_hall') {
    return {
      weight: 55,
      why: 'A market as much as a meal — worth an hour in its own right if you want one.',
    };
  }

  if (foodMattersTo(profile) && !quality.chainOutlet && quality.score >= 0.6) {
    return {
      weight: 40 + Math.round(quality.score * 10),
      why: venue.cuisines[0]
        ? `${venue.cuisines[0]} and particular to here rather than an outlet of something.`
        : 'Particular to here rather than an outlet of something.',
    };
  }

  return { weight: 0, why: '' };
}

/**
 * Whether this traveller's opinion about food is worth interrupting them for.
 *
 * Someone eating to keep going does not want six restaurant cards; someone who
 * came for the food does. `style` is the answer they gave, and `destination`
 * and `local_casual` are the two that mean the meals are part of the point.
 */
function foodMattersTo(profile: TravelerProfile): boolean {
  return (
    profile.food.style === 'destination' ||
    profile.food.style === 'local_casual' ||
    profile.interests.food_and_towns === 'frequent' ||
    profile.interests.food_and_towns === 'core'
  );
}
