import type { OperatingPolicy, OperatingType } from './model';

/**
 * V12.1 §38–§43 — THE POLICY HAS TO CHANGE SOMETHING DETERMINISTIC.
 *
 * ── WHAT V12 LEFT ──────────────────────────────────────────────────────────
 *
 * `TripOperatingModel` reaches the composition envelope, the readiness gate and
 * the quality report, and V12's own final report is honest about the limit:
 * *"mode-specific policy is carried and read by composition, readiness and
 * quality — it does not yet reshape the day builder."* Carried is not the same
 * as consulted. The quality report judged every trip against the same
 * thresholds, so a resort week with three empty afternoons and a city week with
 * three empty afternoons scored identically, and one of them was the plan
 * working.
 *
 * ── WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT ──────────────────────────
 *
 * A set of **expectations**, read by the deterministic checks. It is not a
 * planner: §13's rule holds, and nothing here says lake → hike → scenic drive.
 * It says how many anchors a day of *this kind of trip* should hold before the
 * day reads as thin, how much a hotel change costs *here*, and what "food is
 * handled" means for a trip whose operator caters it.
 *
 * Every number is derived from a policy field that already exists and is
 * already justified (`activityDensity`, `hotelChangeCost`, `restExpectation`,
 * `foodPattern`, `lodgingPattern`). Nothing new is invented about the world.
 *
 * Pure.
 */

/* ────────────────────────────────────────────────────────────────────────────
 * §39 — ACTIVITY DENSITY
 * ──────────────────────────────────────────────────────────────────────────── */

export interface DensityExpectation {
  /** Below this, a day of this kind of trip reads as thin. */
  minAnchors: number;
  /** Above this, it reads as crammed. */
  maxAnchors: number;
  /**
   * Whether unscheduled time is **wanted** here.
   *
   * The field §39 turns on. A resort week and a trek both have days with one
   * thing on them, and only one of them is short of content: on a resort week
   * the empty afternoon is the product, and on a city week it is a gap.
   */
  freeTimeIsWanted: boolean;
  /** One sentence for the finding, so the report explains itself rather than printing a number. */
  note: string;
}

const DENSITY_BY_LEVEL: Record<OperatingPolicy['activityDensity'], { minAnchors: number; maxAnchors: number }> = {
  sparse: { minAnchors: 0, maxAnchors: 2 },
  light: { minAnchors: 1, maxAnchors: 3 },
  moderate: { minAnchors: 2, maxAnchors: 4 },
  full: { minAnchors: 1, maxAnchors: 3 },
};

/**
 * How full a day of this kind of trip should be.
 *
 * `full` is deliberately **not** the highest anchor count, and that is the §39
 * case most likely to be got wrong: a trek's day is full at *one* stage,
 * because the stage is eight hours of walking. Density is about how occupied
 * the day is, not about how many rows are on it, and a check that counted rows
 * would call the hardest day of the trip empty.
 */
export function densityExpectation(policy: Pick<OperatingPolicy, 'activityDensity' | 'restExpectation' | 'mobilityPattern'>): DensityExpectation {
  const band = DENSITY_BY_LEVEL[policy.activityDensity];
  const freeTimeIsWanted = policy.restExpectation >= 0.5;
  if (policy.mobilityPattern === 'trail') {
    return { minAnchors: 1, maxAnchors: 2, freeTimeIsWanted: false, note: 'One stage fills a day on a walking route; a second thing on the same day is usually too much.' };
  }
  if (policy.mobilityPattern === 'self_drive' || policy.mobilityPattern === 'driven') {
    return { minAnchors: 1, maxAnchors: band.maxAnchors, freeTimeIsWanted, note: 'On a driving trip the road is part of the day, so a day with fewer stops is not a thinner day.' };
  }
  if (freeTimeIsWanted) {
    return { ...band, freeTimeIsWanted, note: 'Unscheduled time is what this trip is for, so an open afternoon is the plan working rather than a gap in it.' };
  }
  return { ...band, freeTimeIsWanted, note: `Days on a trip like this usually hold ${band.minAnchors}–${band.maxAnchors} substantial things.` };
}

/* ────────────────────────────────────────────────────────────────────────────
 * §40 — WHAT A HOTEL CHANGE COSTS
 * ──────────────────────────────────────────────────────────────────────────── */

export interface HotelChangeThresholds {
  /** At or below this share of nights, the changes are unremarkable. */
  strong: number;
  /** Above this, they are the story of the trip. */
  adequate: number;
  note: string;
}

/**
 * How freely this trip may change where it sleeps.
 *
 * The fixed 0.25 / 0.45 thresholds were a road trip's, applied to everybody. A
 * backpacking route that moves every other night is working as intended; a
 * resort week that moves twice has spent two of its seven days in transit.
 *
 * `hotelChangeCost` already carries that difference (0.15 for backpacking, 0.95
 * for a resort), so the thresholds are simply read off it rather than being a
 * second table that could disagree with the first.
 */
export function hotelChangeThresholds(policy: Pick<OperatingPolicy, 'hotelChangeCost'>): HotelChangeThresholds {
  const cost = Math.min(1, Math.max(0, policy.hotelChangeCost));
  /* 0.45 down to 0.10 as the cost rises; the adequate band is always a little wider. */
  const strong = Math.round((0.45 - cost * 0.35) * 100) / 100;
  const adequate = Math.round((strong + 0.2) * 100) / 100;
  return {
    strong,
    adequate,
    note:
      cost >= 0.8
        ? 'Moving is expensive on a trip like this: a change of property costs most of a day and most of the reason for being there.'
        : cost <= 0.25
          ? 'Moving often is normal on a trip like this, so frequent changes are not a fault.'
          : 'A change of base costs about half a day here.',
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * §41 — FOOD
 * ──────────────────────────────────────────────────────────────────────────── */

export interface FoodExpectation {
  /** Whether a named restaurant is an anchor of the day rather than fuel. */
  mealsAreAnchors: boolean;
  /** Whether somebody else is feeding the traveller, so a plan that names no restaurant is complete. */
  cateredByOperator: boolean;
  /** Whether the plan should be arranging supplies rather than tables. */
  selfSupplied: boolean;
  note: string;
}

export function foodExpectation(policy: Pick<OperatingPolicy, 'foodPattern'>): FoodExpectation {
  switch (policy.foodPattern) {
    case 'named_meals_matter':
      return { mealsAreAnchors: true, cateredByOperator: false, selfSupplied: false, note: 'Where you eat is part of the plan here, and the good tables are booked.' };
    case 'operator_provided':
      return { mealsAreAnchors: false, cateredByOperator: true, selfSupplied: false, note: 'Meals come with the trip, so a day that names no restaurant is not a day missing one.' };
    case 'meal_plan':
      return { mealsAreAnchors: false, cateredByOperator: true, selfSupplied: false, note: 'The property feeds you, so the plan names a restaurant only where you would leave it.' };
    case 'self_supplied':
      return { mealsAreAnchors: false, cateredByOperator: false, selfSupplied: true, note: 'Out here the useful thing is where to buy food, not where to book a table.' };
    case 'convenient_fuel':
    default:
      return { mealsAreAnchors: false, cateredByOperator: false, selfSupplied: false, note: 'Meals go where they fit the day rather than deciding it.' };
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * §42 — LODGING
 * ──────────────────────────────────────────────────────────────────────────── */

export interface LodgingExpectation {
  /** What actually decides where to sleep on this trip, in one phrase. */
  decidedBy: 'neighbourhood' | 'access' | 'the property itself' | 'the experience' | 'price and company' | 'practicalities';
  /** Whether the traveller books it at all, or whether it comes with the trip. */
  bookedBy: 'traveler' | 'operator';
  note: string;
}

export function lodgingExpectation(policy: Pick<OperatingPolicy, 'lodgingPattern'>): LodgingExpectation {
  switch (policy.lodgingPattern) {
    case 'neighbourhood_matters':
      return { decidedBy: 'neighbourhood', bookedBy: 'traveler', note: 'Which part of the city you sleep in decides most of what the evenings can be.' };
    case 'social_lodging':
      return { decidedBy: 'price and company', bookedBy: 'traveler', note: 'Where you stay is also who you meet; cost and location matter more than the room.' };
    case 'property_is_the_trip':
      return { decidedBy: 'the property itself', bookedBy: 'traveler', note: 'The property is most of the trip, so it is the first booking and the one worth the time.' };
    case 'access_defines_it':
      return { decidedBy: 'access', bookedBy: 'traveler', note: 'Where you sleep decides what you can reach at dawn, which is the whole point on a trip like this.' };
    case 'experience_owned':
      return { decidedBy: 'the experience', bookedBy: 'operator', note: 'The nights on the route come with it; there is nothing separate to book.' };
    case 'practical':
    default:
      return { decidedBy: 'practicalities', bookedBy: 'traveler', note: 'A bed in the right place, with somewhere to leave the car.' };
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * §43 — WHAT ACTUALLY COSTS MONEY ON THIS KIND OF TRIP
 *
 * §43 is explicit: *"Do not seek fake exact prices."* This is a **structure**,
 * not a price list — the ordered set of things that dominate the budget for
 * each family, so the destination recommender's budget fit and the Book view
 * can talk about the right costs rather than about a generic hotel-and-food
 * split. The `share` values are the shape of a budget, stated as such, and are
 * never rendered as a figure.
 * ──────────────────────────────────────────────────────────────────────────── */

export interface CostDriver {
  key: string;
  label: string;
  /** Roughly what share of the trip's spend this accounts for. A shape, never a quote. */
  share: number;
}

const COST_DRIVERS: Record<OperatingType, CostDriver[]> = {
  urban_culture: [
    { key: 'lodging', label: 'The hotel', share: 0.45 },
    { key: 'food', label: 'Eating out', share: 0.3 },
    { key: 'admissions', label: 'Entries and tickets', share: 0.15 },
    { key: 'transit', label: 'Getting around', share: 0.1 },
  ],
  urban_food_nightlife: [
    { key: 'food', label: 'Eating and drinking', share: 0.45 },
    { key: 'lodging', label: 'The hotel', share: 0.35 },
    { key: 'transit', label: 'Getting around', share: 0.1 },
    { key: 'admissions', label: 'Entries and tickets', share: 0.1 },
  ],
  urban_family: [
    { key: 'lodging', label: 'Somewhere that fits everyone', share: 0.45 },
    { key: 'food', label: 'Feeding everyone', share: 0.3 },
    { key: 'admissions', label: 'Entries and tickets', share: 0.15 },
    { key: 'transit', label: 'Getting around', share: 0.1 },
  ],
  overland_backpacking: [
    { key: 'intercity_transport', label: 'Getting between places', share: 0.35 },
    { key: 'lodging', label: 'Hostels and guesthouses', share: 0.3 },
    { key: 'tours', label: 'The one or two big things', share: 0.2 },
    { key: 'food', label: 'Eating', share: 0.15 },
  ],
  mountain_road_trip: [
    { key: 'vehicle', label: 'The car and the fuel', share: 0.3 },
    { key: 'lodging', label: 'Beds along the route', share: 0.35 },
    { key: 'park_fees', label: 'Park and parking fees', share: 0.15 },
    { key: 'food', label: 'Food and supplies', share: 0.2 },
  ],
  multi_day_trek: [
    { key: 'operator', label: 'The guide or operator', share: 0.45 },
    { key: 'permits', label: 'Permits and fees', share: 0.2 },
    { key: 'transport', label: 'Getting to and from the trailhead', share: 0.2 },
    { key: 'equipment', label: 'Gear and hire', share: 0.15 },
  ],
  guided_wildlife: [
    { key: 'lodge', label: 'The lodge or camp', share: 0.45 },
    { key: 'park_fees', label: 'Park and conservation fees', share: 0.2 },
    { key: 'guide', label: 'The guide and the vehicle', share: 0.25 },
    { key: 'transfers', label: 'Transfers', share: 0.1 },
  ],
  resort_stay: [
    { key: 'property', label: 'The property', share: 0.55 },
    { key: 'meal_plan', label: 'The meal plan', share: 0.2 },
    { key: 'transfer', label: 'The transfer in and out', share: 0.15 },
    { key: 'water_activities', label: 'Diving, boats and excursions', share: 0.1 },
  ],
  island_hopping: [
    { key: 'crossings', label: 'Ferries and flights between islands', share: 0.3 },
    { key: 'lodging', label: 'Beds on each island', share: 0.4 },
    { key: 'food', label: 'Eating', share: 0.2 },
    { key: 'activities', label: 'Boats and water', share: 0.1 },
  ],
  rail_journey: [
    { key: 'rail', label: 'Tickets, passes and reservations', share: 0.35 },
    { key: 'lodging', label: 'The hotels', share: 0.4 },
    { key: 'food', label: 'Eating', share: 0.2 },
    { key: 'admissions', label: 'Entries and tickets', share: 0.05 },
  ],
  self_drive_road_trip: [
    { key: 'vehicle', label: 'The car and the fuel', share: 0.3 },
    { key: 'lodging', label: 'Beds along the route', share: 0.4 },
    { key: 'food', label: 'Food and supplies', share: 0.2 },
    { key: 'parking', label: 'Parking and tolls', share: 0.1 },
  ],
  remote_overland: [
    { key: 'vehicle_or_driver', label: 'The vehicle and the driver', share: 0.4 },
    { key: 'lodging', label: 'What there is to sleep in', share: 0.25 },
    { key: 'permits', label: 'Permits and fees', share: 0.2 },
    { key: 'supplies', label: 'Fuel and supplies', share: 0.15 },
  ],
  mixed_regional: [
    { key: 'lodging', label: 'Where you sleep', share: 0.4 },
    { key: 'transport', label: 'Getting around', share: 0.25 },
    { key: 'food', label: 'Eating', share: 0.2 },
    { key: 'activities', label: 'The things you do', share: 0.15 },
  ],
};

/** What dominates the budget on this kind of trip, heaviest first. A shape, never a quote. */
export function costDriversFor(type: OperatingType): readonly CostDriver[] {
  return COST_DRIVERS[type];
}
