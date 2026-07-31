import { venueHoursOn } from './availability';
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

  const scored = dataset.venues
    .map((venue) => ({ venue, ...reasonFor(venue, profile, everyday) }))
    .filter((entry) => entry.weight > 0)
    .sort(
      (a, b) => b.weight - a.weight || a.venue.name.localeCompare(b.venue.name),
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

  return { weight: 0, why: '' };
}
