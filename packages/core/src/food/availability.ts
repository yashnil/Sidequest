import { operatingOn, type OpeningWindowOnDate, type RecurringCalendar } from '../hours/availability';
import {
  MEDICAL_OR_OBSERVANT_NEEDS,
  type DietaryClaim,
  type DietaryNeed,
  type FoodVenue,
  type MealPeriod,
  type MealSlot,
} from '../schemas/food';

/**
 * Resolving a venue's recurring calendar against a real date, and answering the
 * two questions the planner actually asks: is it open, and can it feed me *this*
 * meal?
 *
 * The date arithmetic is not reimplemented here — `operatingOn` already does it,
 * and having two answers to "is this a Tuesday it opens?" is how a timeline ends
 * up disagreeing with the badge printed beside it.
 */

export interface VenueDayHours {
  venueId: string;
  date: string;
  status: 'open' | 'closed' | 'always_open' | 'unknown';
  windows: OpeningWindowOnDate[];
  periodLabel: string | null;
}

export function venueHoursOn(venue: FoodVenue, date: string): VenueDayHours {
  const resolved = operatingOn(venue.hours as RecurringCalendar, date);
  return {
    venueId: venue.id,
    date,
    status: resolved.status,
    windows: resolved.windows,
    periodLabel: resolved.periodLabel,
  };
}

/**
 * Whether a meal of `minutes` can start and finish inside one of the day's
 * windows, no earlier than `earliest` and no later than `latest`.
 *
 * Returns the earliest legal start, or null. Deliberately not "is it open at
 * time T": a restaurant that opens at 17:30 will happily let you in at 21:25 and
 * then close at 21:30, and a plan that seats somebody for a ninety-minute dinner
 * five minutes before the doors shut has answered the wrong question.
 */
export function earliestMealStart(input: {
  hours: VenueDayHours;
  minutes: number;
  earliest: number;
  latest: number;
}): number | null {
  const { hours, minutes, earliest, latest } = input;
  if (hours.status === 'unknown' || hours.status === 'closed') return null;
  if (hours.status === 'always_open') {
    return earliest + minutes <= latest ? earliest : null;
  }

  let best: number | null = null;
  for (const window of hours.windows) {
    const start = Math.max(earliest, window.openMinute);
    const end = Math.min(latest, window.closeMinute);
    if (start + minutes > end) continue;
    if (best === null || start < best) best = start;
  }
  return best;
}

/** The window a chosen start actually sits inside, for the evidence on the item. */
export function windowContaining(
  hours: VenueDayHours,
  startMinute: number,
): OpeningWindowOnDate | null {
  return (
    hours.windows.find(
      (window) => startMinute >= window.openMinute && startMinute <= window.closeMinute,
    ) ?? null
  );
}

/**
 * Which venue meal periods satisfy a scheduled slot.
 *
 * Breakfast accepts a café because a coffee and a pastry is a breakfast; dinner
 * does not accept a bakery that shuts at four, whatever it sells. Groceries are
 * never a meal slot — provisioning is its own kind of stop.
 */
const SLOT_PERIODS: Record<MealSlot, readonly MealPeriod[]> = {
  breakfast: ['breakfast', 'coffee'],
  lunch: ['lunch'],
  dinner: ['dinner'],
  snack: ['snack', 'coffee', 'lunch'],
};

export function venueServes(venue: FoodVenue, slot: MealSlot): boolean {
  return SLOT_PERIODS[slot].some((period) => venue.mealPeriods.includes(period));
}

/** Somewhere you can buy food to carry. The whole remote-day plan rests on it. */
export function venueCanProvision(venue: FoodVenue): boolean {
  return venue.provisioning === 'packed_meals';
}

// ---------------------------------------------------------------------------
// Dietary
// ---------------------------------------------------------------------------

export interface DietaryVerdict {
  /** The venue itself says it cannot do this. A hard exclusion. */
  blocked: DietaryNeed[];
  /** Something is on record — the venue's own words or its published menu. */
  supported: DietaryClaim[];
  /** Nobody has confirmed it either way. Never rendered as "fine". */
  unverified: DietaryNeed[];
}

/**
 * What we can honestly say about this venue and this traveller's needs.
 *
 * There is no fourth bucket called "probably fine". A cuisine is not a dietary
 * claim: a vegetarian restaurant we have not read a page about is `unverified`,
 * and a steakhouse whose menu happens to list a salad is `unverified` too. The
 * planner may prefer a supported venue and must never present an unverified one
 * as safe.
 */
export function assessDietary(
  venue: FoodVenue,
  needs: readonly DietaryNeed[],
): DietaryVerdict {
  const blocked: DietaryNeed[] = [];
  const supported: DietaryClaim[] = [];
  const unverified: DietaryNeed[] = [];

  for (const need of needs) {
    const claim = venue.dietary.find((entry) => entry.need === need);
    if (!claim || claim.evidence === 'unknown') {
      unverified.push(need);
    } else if (claim.evidence === 'venue_states_unsuitable') {
      blocked.push(need);
    } else {
      supported.push(claim);
    }
  }

  return { blocked, supported, unverified };
}

/**
 * Whether an unconfirmed need is one a traveller can shrug at.
 *
 * A vegetarian who ends up somewhere without a marked vegetarian dish orders the
 * side dishes. Somebody with a nut allergy, or keeping halal or kosher, cannot,
 * and treating the two the same is the difference between a mild disappointment
 * and a plan that should not have been made. Strictness is the traveller's own
 * declaration; this is the floor beneath it.
 */
export function needsExplicitEvidence(need: DietaryNeed, travellerIsStrict: boolean): boolean {
  return travellerIsStrict || MEDICAL_OR_OBSERVANT_NEEDS.includes(need);
}

/**
 * The sentence shown beside a venue when a need could not be confirmed.
 *
 * Written once, here, so no surface can accidentally soften it. It never says
 * safe, never says suitable, and always ends with the action the traveller has
 * to take themselves.
 */
export function dietaryUncertaintyCopy(
  venueName: string,
  needs: readonly string[],
): string {
  const list = needs.length === 1 ? needs[0]! : `${needs.slice(0, -1).join(', ')} and ${needs.at(-1)}`;
  return `Nobody has confirmed how ${venueName} handles ${list}. We are not going to guess at it — ring them before you count on it.`;
}
