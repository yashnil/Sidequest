import {
  PRICE_BAND_ORDER,
  type FoodVenue,
  type PriceBand,
  type ScheduledFood,
} from '../schemas/food';

/**
 * IS THIS SOMEWHERE, OR IS IT AN OUTLET?
 *
 * The defect this exists to fix, verbatim from a live compilation: six days in
 * a city of extraordinary food produced three venues, one of which was a
 * Domino's Pizza, and nothing anywhere in the product could tell it from the
 * other two. Every compiled venue arrives with the same `moderate` price band,
 * the same `format_inferred` evidence and the same unknown hours, so every
 * ranking that reads those fields scores a franchise pizza counter exactly as
 * it scores a place people queue for.
 *
 * WHAT THIS IS NOT
 *
 * It is not a brand list. A hard-coded list of chains is a maintenance burden
 * that is wrong in every country nobody wrote it for, and it is the sort of
 * thing that quietly becomes "American chains are chains and everyone else's
 * are local". It is also not a quality judgement: nothing here claims a place is
 * *good*, only that it is *particular to here*, which is the property a traveller
 * came for and the one a franchise by definition does not have.
 *
 * WHAT IT ACTUALLY READS
 *
 *   1. **Repetition inside the region.** A name that appears at several
 *      addresses in one region is an outlet of something, by construction and
 *      in any language. This is the strongest signal available and it needs no
 *      list, no key and no country knowledge.
 *   2. **An open-knowledge identifier.** A venue somebody wrote a Wikidata
 *      entry for is a venue somebody thought was worth recording.
 *   3. **What kind of operation it is.** A market or a food hall is a thing to
 *      do as well as somewhere to eat; a takeaway counter is fuel.
 *   4. **A named cuisine, and a local speciality.** Both are the source
 *      describing something specific rather than filing it under "food".
 *
 * Deliberately coarse and bounded to 0–1. It orders candidates; it never gates
 * one, because the honest answer for most venues is "we do not know" and a gate
 * on a weak signal removes real places.
 */
export interface FoodDistinctiveness {
  /** 0–1. Higher means more particular to this place. */
  score: number;
  /** True when this name appears at more than one address in the region. */
  chainOutlet: boolean;
  /** How many addresses share this name here. 1 means it is the only one. */
  outletsHere: number;
}

/** Folds a name to the form two outlets of one brand will agree on. */
export function foldVenueName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{Letter}\p{Number}]+/gu, ' ')
    .trim();
}

/**
 * How many venues in this region share each folded name.
 *
 * Computed over the whole dataset once rather than per venue, because "is this
 * a chain" is a fact about the region's venue list and not about the record.
 */
export function foodNameCounts(venues: readonly FoodVenue[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const venue of venues) {
    const key = foldVenueName(venue.name);
    if (key.length === 0) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

const DISTINCTIVE_SERVICE_TYPES: Partial<Record<FoodVenue['serviceType'], number>> = {
  market: 0.2,
  food_hall: 0.15,
  bakery: 0.05,
  takeaway: -0.1,
  grocery: -0.05,
};

export function foodDistinctiveness(
  venue: FoodVenue,
  nameCounts: ReadonlyMap<string, number>,
): FoodDistinctiveness {
  const outletsHere = nameCounts.get(foldVenueName(venue.name)) ?? 1;
  const chainOutlet = outletsHere > 1;

  let score = 0.5;
  /*
   * The penalty is steep and it is meant to be. Two outlets could be a
   * coincidence of naming; four is a franchise, and a franchise is the one
   * thing a traveller can eat at without leaving home.
   */
  if (chainOutlet) score -= Math.min(0.4, 0.15 * (outletsHere - 1));
  if (venue.localSpecialty) score += 0.2;
  // Somebody wrote an open-knowledge entry for this venue. The tag is written by
  // the backbone wherever a record carried an identifier, which is the same
  // evidence channel the attraction side reads for significance.
  if (venue.tags.includes('attr:wikidata')) score += 0.15;
  if (venue.cuisines.length > 0) score += 0.1;
  score += DISTINCTIVE_SERVICE_TYPES[venue.serviceType] ?? 0;
  /*
   * Published hours are a weak positive and weighted as one. Metadata
   * completeness is not significance — that is §8.3, and it is exactly how a
   * café with a website came to outrank a major temple on the attraction side.
   */
  if (venue.hours.kind !== 'unknown') score += 0.05;

  return { score: Math.max(0, Math.min(1, score)), chainOutlet, outletsHere };
}

/**
 * WHAT KIND OF FOOD STOP THIS IS — §15's seven, derived rather than declared.
 *
 * Derived, because every input already exists on the decision that was made:
 * the slot it fills, whether the special-meal quota opened for it, where it
 * sits relative to the day, and what the venue is. Declaring it separately
 * would create a second opinion that could disagree with the timeline, which is
 * the failure mode the whole food model is arranged to avoid.
 *
 * The distinction that earns its keep is `destination_meal` against
 * `quick_fuel`. A plan that cannot tell them apart writes "Lunch" over both a
 * sixty-minute sit-down that is the point of the afternoon and a fifteen-minute
 * bakery stop on the way to a trailhead, and the traveller has no way to know
 * which one they are allowed to skip.
 */
export const MEAL_CHARACTERS = [
  'special_occasion',
  'destination_meal',
  'local_speciality',
  'route_convenient',
  'quick_fuel',
  'breakfast_coffee',
  'grocery_snack',
] as const;
export type MealCharacter = (typeof MEAL_CHARACTERS)[number];

export const MEAL_CHARACTER_LABELS: Record<MealCharacter, string> = {
  special_occasion: 'The one meal that is an occasion',
  destination_meal: 'Worth going for its own sake',
  local_speciality: 'Something you can only really eat here',
  route_convenient: 'Convenient for where the day already goes',
  quick_fuel: 'A quick stop, not an event',
  breakfast_coffee: 'Breakfast or coffee before the day starts',
  grocery_snack: 'Supplies to carry',
};

export function mealCharacterOf(input: {
  slot: ScheduledFood['slot'];
  stopKind: ScheduledFood['stopKind'];
  routeContext: ScheduledFood['routeContext'];
  isSpecialMeal: boolean;
  serviceType?: FoodVenue['serviceType'] | undefined;
  priceBand?: PriceBand | undefined;
  hasLocalSpecialty: boolean;
  everydayPriceBand: PriceBand;
}): MealCharacter {
  if (input.stopKind === 'grocery' || input.stopKind === 'packed') return 'grocery_snack';
  if (input.isSpecialMeal) return 'special_occasion';
  if (input.hasLocalSpecialty) return 'local_speciality';
  if (input.slot === 'breakfast') return 'breakfast_coffee';
  if (input.slot === 'snack') return 'grocery_snack';
  if (input.serviceType === 'takeaway' || input.serviceType === 'bakery') return 'quick_fuel';
  /*
   * A meal is a destination when going to it is a decision rather than a
   * consequence of where you already were. Sitting above the traveller's
   * everyday band is one way to be that; being somewhere the day did not
   * otherwise pass is the other.
   */
  const dearer =
    input.priceBand !== undefined &&
    PRICE_BAND_ORDER[input.priceBand] > PRICE_BAND_ORDER[input.everydayPriceBand];
  if (dearer || input.routeContext === 'off_route') return 'destination_meal';
  return 'route_convenient';
}
