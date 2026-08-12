import type { FoodGap, FoodVenue, Place, SourceProvenance } from '@sidequest/core';

/**
 * IS THERE ENOUGH TO EAT HERE — ASKED, AND WRITTEN DOWN.
 *
 * The defect: a compiled region has always shipped `food: { …, gaps: [] }`. The
 * literal was there from the first compiled artifact and never replaced, so no
 * matter how thin the supply, the food dataset asserted that there was nowhere
 * we had looked and found nothing. That empty array is a claim, and it is read
 * as one — the planner treats a day with no matching gap as a day that can feed
 * itself, and the plan then says nothing at all about the fact that six days in
 * a food-first destination were built on three venues.
 *
 * `FoodGap` is the model's existing first-class "we looked here and there is
 * nothing", and it is exactly the right shape for this: it names an area, the
 * places it covers, what the evidence actually said, and where that came from.
 * What it must never do is overstate. A shortfall in *our index* is not a
 * statement that a neighbourhood has no restaurants, and the notes below are
 * written to say which of the two is being reported.
 */

/**
 * How many venues a trip of this length needs before its food stops being a
 * lottery.
 *
 * Roughly two a day and never fewer than six: a day can legitimately want a
 * breakfast, a lunch and a dinner, and a shortlist with no alternative in it
 * fails the moment one kitchen turns out to be shut. Doubled when the traveller
 * told us food is what the trip is for, because then the *choice* is the
 * product rather than a logistics detail.
 */
export function foodVenuesNeeded(tripDays: number, foodIsCore: boolean): number {
  const base = Math.max(6, tripDays * 2);
  return foodIsCore ? base * 2 : base;
}

/**
 * Provenance for a statement about our own index, never about the ground.
 *
 * `estimated` rather than `official`, because nobody with authority told us
 * there is nothing here — we counted what we hold. The recheck note is
 * mandatory at this volatility and says exactly that, so the sentence a
 * traveller reads can never be mistaken for an agency's word.
 */
const OUR_INDEX: SourceProvenance = {
  kind: 'estimated',
  sourceName: 'Sidequest place data',
  confidence: 0.9,
  volatility: 'dynamic',
  recheckNote: 'Worth checking a map app on the day — this is what we found, not what is there.',
};

export interface FoodSupplyInput {
  /** The venues that survived every gate and are actually schedulable. */
  venues: readonly FoodVenue[];
  /** The places the trip will be built from. A gap has to name what it covers. */
  places: readonly Place[];
  tripDays: number;
  /** Whether the traveller asked for the trip to be built around eating. */
  foodIsCore: boolean;
  /** Venues found and then dropped because nobody could measure a journey to them. */
  unroutableCount: number;
  /** The region as a whole, for the area a whole-region gap covers. */
  regionName: string;
}

/**
 * The gaps this compilation actually earned the right to record.
 *
 * Two distinct statements, never merged, because the remedy for each is
 * different and a traveller can act on only one of them:
 *
 *   - **We found very little.** A fact about the ground as far as our sources
 *     reach. The traveller should expect to find their own meals.
 *   - **We found things and could not price the journey.** A fact about our
 *     routing, not about the food. The venues exist; we cannot promise the
 *     detour.
 */
export function foodSupplyGaps(input: FoodSupplyInput): FoodGap[] {
  const placeIds = input.places.map((place) => place.id);
  if (placeIds.length === 0) return [];
  const gaps: FoodGap[] = [];

  const needed = foodVenuesNeeded(input.tripDays, input.foodIsCore);
  if (input.venues.length < needed) {
    gaps.push({
      area: input.regionName,
      placeIds,
      note:
        input.venues.length === 0
          ? 'We found nowhere to eat in the place data for this region. Plan on finding your own meals, and check a map app on the day.'
          : `We found ${input.venues.length} ${input.venues.length === 1 ? 'place' : 'places'} to eat here against the ${needed} a ${input.tripDays}-day trip like yours would normally draw on. This is what our sources hold, not a claim that there is nothing else — expect to find some meals yourself.`,
      provenance: OUR_INDEX,
    });
  }

  if (input.unroutableCount > 0) {
    gaps.push({
      area: input.regionName,
      placeIds,
      note: `${input.unroutableCount} more ${input.unroutableCount === 1 ? 'place' : 'places'} to eat turned up here that we could not measure a journey to, so we have left ${input.unroutableCount === 1 ? 'it' : 'them'} out rather than guess at the detour.`,
      provenance: OUR_INDEX,
    });
  }

  return gaps;
}
