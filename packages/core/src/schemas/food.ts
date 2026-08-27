import { z } from 'zod';
import { haversineKm } from '@sidequest/geo';
import { monthDaySchema } from './calendar';
import { httpUrlSchema, minuteOfDaySchema } from './common';
import { operatingPeriodSchema } from './hours';
import { POI_BASE_FIELDS } from './poi';
import { sourceProvenanceSchema } from './provenance';

/**
 * WHERE THE TRAVELLER EATS — and the five different things that phrase means.
 *
 * The slice this file opens turns on keeping them apart, because collapsing any
 * two of them produces a specific, familiar failure:
 *
 *   1. food preferences     what they enjoy      → `TravelerProfile.food`
 *   2. dietary requirements what they must have  → also the profile, but *strict*
 *   3. venue facts          what a place is      → *this file*
 *   4. a meal need          what the day asks for→ `planner/food.ts`
 *   5. a scheduled food stop what was chosen     → `ItineraryItem.food`
 *
 * Collapse 1 and 2 and a vegan is offered a steakhouse with a salad on the menu.
 * Collapse 3 and 5 and traveller-specific state gets written onto a canonical
 * venue record, so the next trip inherits the last one's choices. Collapse 4 and
 * 5 and every day gets three restaurants whether it needed them or not.
 *
 * WHY A SEPARATE MODEL FROM `Place`
 *
 * Not squeamishness about reuse. `Place` carries `physicalIntensity`,
 * `hiddenGemScore`, `popularityScore`, `crowdLevel`, a nine-field weather
 * profile, `seasonalAccess.openMonths`, `relationship: base | satellite`, a
 * required non-empty `interests` list and `travelFromBase` — and every one of
 * them either has no meaning for a bakery or actively misfires. `interests`
 * would push every venue into `food_and_towns`, whose *frequency cap* the
 * planner enforces: eight meals across four days would be reported as
 * `frequency_exceeded`, and a day with two of them would be themed "Food &
 * mountain towns". `hiddenGemScore >= 0.6` routes a card into the board's hidden
 * gems. `poorWeatherBackup` would make cafés eligible as bad-weather backups for
 * a whole day. And the three dataset validators each demand complete coverage of
 * every place id, so twenty venues would need twenty access rules, twenty
 * operating calendars and twenty weather-zone memberships.
 *
 * What genuinely is shared — an id, a name, a locality, a position, a
 * description, tags and a provenance — is in `schemas/poi.ts`, and both models
 * spread it.
 *
 * Time model as everywhere else: minutes from *local* midnight, dates as
 * `YYYY-MM-DD` labels.
 */

/**
 * 1 — first release. Persisted alongside a plan so a stored itinerary can say
 * which generation of food data it was built from.
 */
export const FOOD_DATASET_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------

/**
 * What kind of food stop this is. Load-bearing rather than decorative: a market
 * can supply a packed lunch and a fine-dining room cannot, and a traveller who
 * asked for a quick breakfast should not be sent to a seated restaurant.
 */
export const FOOD_SERVICE_TYPES = [
  'restaurant',
  'cafe',
  'bakery',
  'market',
  'grocery',
  'food_hall',
  'takeaway',
] as const;
export const foodServiceTypeSchema = z.enum(FOOD_SERVICE_TYPES);
export type FoodServiceType = z.infer<typeof foodServiceTypeSchema>;

export const FOOD_SERVICE_TYPE_LABELS: Record<FoodServiceType, string> = {
  restaurant: 'Restaurant',
  cafe: 'Café',
  bakery: 'Bakery',
  market: 'Market',
  grocery: 'Grocery',
  food_hall: 'Food hall',
  takeaway: 'Takeaway',
};

/** What a venue serves. A venue may serve several; a day needs particular ones. */
export const MEAL_PERIODS = [
  'breakfast',
  'coffee',
  'lunch',
  'snack',
  'dinner',
  'groceries',
] as const;
export const mealPeriodSchema = z.enum(MEAL_PERIODS);
export type MealPeriod = z.infer<typeof mealPeriodSchema>;

/**
 * Whether you can walk out with food for later.
 *
 * `packed_meals` is the field the whole remote-day feature rests on: it means
 * you can buy the makings of a lunch to carry, which is the only honest answer
 * on a day whose stops have no food anywhere near them.
 */
export const FOOD_PROVISIONING = ['none', 'snacks', 'packed_meals'] as const;
export const foodProvisioningSchema = z.enum(FOOD_PROVISIONING);
export type FoodProvisioning = z.infer<typeof foodProvisioningSchema>;

/**
 * A coarse band, never a number.
 *
 * Only four venues in the current fixture publish prices at all. A "$18–24 per
 * head" on a record whose evidence is "it looked like a diner" is a guess with a
 * decimal point on it, which is why `priceEvidence` sits beside this and is
 * rendered wherever the band is.
 */
export const PRICE_BANDS = ['budget', 'moderate', 'upscale', 'special'] as const;
export const priceBandSchema = z.enum(PRICE_BANDS);
export type PriceBand = z.infer<typeof priceBandSchema>;

export const PRICE_BAND_LABELS: Record<PriceBand, string> = {
  budget: '£',
  moderate: '££',
  upscale: '£££',
  special: '££££',
};

export const PRICE_BAND_WORDS: Record<PriceBand, string> = {
  budget: 'Cheap',
  moderate: 'Mid-range',
  upscale: 'Pricier',
  special: 'Special occasion',
};

export const PRICE_BAND_ORDER: Record<PriceBand, number> = {
  budget: 0,
  moderate: 1,
  upscale: 2,
  special: 3,
};

/** How the band above was arrived at. Rendered, never hidden. */
export const PRICE_EVIDENCE_KINDS = ['published_menu', 'directory_band', 'format_inferred'] as const;
export const priceEvidenceSchema = z.enum(PRICE_EVIDENCE_KINDS);
export type PriceEvidence = z.infer<typeof priceEvidenceSchema>;

export const PRICE_EVIDENCE_COPY: Record<PriceEvidence, string> = {
  published_menu: 'from their own published menu',
  directory_band: 'from a tourism-board listing, not the venue',
  format_inferred: 'inferred from the kind of place it is, not from prices we read',
};

/**
 * Reservations. Modelled and handed back, never resolved — Sidequest books
 * nothing, and a plan that implies otherwise is the single most damaging thing
 * this feature could say.
 */
export const RESERVATION_REQUIREMENTS = [
  'required',
  'recommended',
  'walk_in_only',
  'unknown',
] as const;
export const reservationRequirementSchema = z.enum(RESERVATION_REQUIREMENTS);
export type ReservationRequirement = z.infer<typeof reservationRequirementSchema>;

export const RESERVATION_LABELS: Record<ReservationRequirement, string> = {
  required: 'Booking required',
  recommended: 'Book ahead',
  walk_in_only: 'Walk in',
  unknown: 'Booking unknown',
};

export const foodReservationSchema = z
  .object({
    requirement: reservationRequirementSchema,
    /** The venue's own words, or ours describing what they publish. */
    note: z.string().min(1).optional(),
    bookingUrl: httpUrlSchema.optional(),
  })
  .refine(
    (value) =>
      (value.requirement !== 'required' && value.requirement !== 'recommended') ||
      value.note !== undefined ||
      value.bookingUrl !== undefined,
    {
      // Telling someone to book without telling them where or how is a dead end
      // dressed as guidance. Same rule the attraction side already enforces.
      message: 'A venue that needs booking must carry a note or an official link',
      path: ['note'],
    },
  );
export type FoodReservation = z.infer<typeof foodReservationSchema>;

// ---------------------------------------------------------------------------
// Dietary evidence — the part that must never overstate
// ---------------------------------------------------------------------------

export const DIETARY_NEEDS = [
  'vegetarian',
  'vegan',
  'gluten_free',
  'dairy_free',
  'nut_allergy',
  'halal',
  'kosher',
] as const;
export const dietaryNeedSchema = z.enum(DIETARY_NEEDS);
export type DietaryNeed = z.infer<typeof dietaryNeedSchema>;

export const DIETARY_NEED_LABELS: Record<DietaryNeed, string> = {
  vegetarian: 'Vegetarian',
  vegan: 'Vegan',
  gluten_free: 'Gluten-free',
  dairy_free: 'Dairy-free',
  nut_allergy: 'Nut allergy',
  halal: 'Halal',
  kosher: 'Kosher',
};

/**
 * What we actually know about a venue and a dietary need.
 *
 * There is no `safe`. There is no value here that a strict allergy sufferer may
 * read as a guarantee, because Sidequest has no way to establish one: a kitchen
 * that lists a gluten-free bun has told you about a bun, not about a fryer, a
 * prep surface or a shared toaster. `venue_states_support` is the strongest
 * claim available and it means precisely "the venue itself published this".
 *
 * `unknown` is the default and is a real answer, for the same reason
 * `hours: unknown` is: silence that reads as accommodation is how somebody ends
 * up somewhere they cannot eat.
 */
export const DIETARY_EVIDENCE_LEVELS = [
  'venue_states_support',
  'menu_lists_options',
  'unknown',
  'venue_states_unsuitable',
] as const;
export const dietaryEvidenceSchema = z.enum(DIETARY_EVIDENCE_LEVELS);
export type DietaryEvidence = z.infer<typeof dietaryEvidenceSchema>;

/** Rendered beside every claim, so a menu listing never reads as a kitchen's word. */
export const DIETARY_EVIDENCE_COPY: Record<DietaryEvidence, string> = {
  venue_states_support: 'the venue states this on its own site',
  menu_lists_options: 'their published menu lists options',
  unknown: 'nobody has confirmed this either way',
  venue_states_unsuitable: 'the venue says this is not something they can do',
};

export const dietaryClaimSchema = z
  .object({
    need: dietaryNeedSchema,
    evidence: dietaryEvidenceSchema,
    /** What the source actually said. Quoted or closely paraphrased. */
    note: z.string().min(1),
    sourceUrl: httpUrlSchema.optional(),
  })
  .refine((claim) => claim.evidence !== 'venue_states_support' || claim.sourceUrl !== undefined, {
    // The strongest claim in the vocabulary is the one that steers a traveller
    // with a medical requirement. It is unrepresentable without naming where it
    // came from, exactly as a hard weather block is.
    message: 'A venue-stated dietary claim must carry the page it was read from',
    path: ['sourceUrl'],
  });
export type DietaryClaim = z.infer<typeof dietaryClaimSchema>;

/**
 * The needs for which "we could not confirm" must never be softened into a
 * preference. Everything here can put somebody in hospital or break a religious
 * obligation; the other needs are strong preferences that a good menu satisfies.
 */
export const MEDICAL_OR_OBSERVANT_NEEDS: readonly DietaryNeed[] = [
  'gluten_free',
  'dairy_free',
  'nut_allergy',
  'halal',
  'kosher',
];

// ---------------------------------------------------------------------------
// What the traveller wants — the preference vocabularies
// ---------------------------------------------------------------------------

/**
 * Breakfast is the one meal people genuinely disagree about, and the
 * disagreement changes the shape of a morning rather than just its contents.
 * `skip` does not mean "no food before noon": on a day that leaves at seven for
 * a four-hour walk, a coffee and something in a pocket is logistics, and the
 * copy says so rather than calling it the breakfast they told us not to book.
 */
export const BREAKFAST_STYLES = ['skip', 'coffee_light', 'full', 'depends'] as const;
export const breakfastStyleSchema = z.enum(BREAKFAST_STYLES);
export type BreakfastStyle = z.infer<typeof breakfastStyleSchema>;

/** How they want to eat across the trip, not how much money they have. */
export const FOOD_STYLES = ['budget', 'local_casual', 'balanced', 'destination'] as const;
export const foodStyleSchema = z.enum(FOOD_STYLES);
export type FoodStyle = z.infer<typeof foodStyleSchema>;

/**
 * How many meals are meant to be an event.
 *
 * The question the whole budget layer turns on. Liking fine dining is not the
 * same as wanting it four nights running, and a product that cannot tell the
 * difference books the four nights.
 */
export const SPECIAL_MEAL_APPETITES = ['none', 'one', 'a_few', 'often'] as const;
export const specialMealAppetiteSchema = z.enum(SPECIAL_MEAL_APPETITES);
export type SpecialMealAppetite = z.infer<typeof specialMealAppetiteSchema>;

/**
 * The traveller's food position, in the shape the planner reads. Four stated
 * answers and three derived ones, derived once here rather than three times in
 * the planner.
 */
export const foodPreferencesSchema = z.object({
  breakfastStyle: breakfastStyleSchema,
  style: foodStyleSchema,
  specialMealAppetite: specialMealAppetiteSchema,
  willPackLunch: z.boolean(),
  dietaryNeeds: z.array(dietaryNeedSchema),
  dietaryStrict: z.boolean(),
  /** How many meals across this whole trip may be an event. Scales with length. */
  specialMealBudget: z.number().int().min(0).max(10),
  /** The band an ordinary meal should stay at or below. */
  everydayPriceBand: priceBandSchema,
  /** Whether a named breakfast venue is something they asked for at all. */
  wantsBreakfastVenue: z.boolean(),
});
export type FoodPreferences = z.infer<typeof foodPreferencesSchema>;

// ---------------------------------------------------------------------------
// Opening hours
// ---------------------------------------------------------------------------

/**
 * How much of the schedule below the venue actually published.
 *
 * Almost no restaurant in this region publishes a closing time — the pattern is
 * "daily from 11am" and then "until close". Encoding an invented 21:00 and
 * calling it official would be a fabrication that looks exactly like a fact, so
 * a conservative close is recorded and *labelled*, and the copy says a call is
 * worth making before a day depends on it.
 */
export const FOOD_HOURS_CONFIDENCE = ['published', 'closing_time_estimated', 'unverified'] as const;
export const foodHoursConfidenceSchema = z.enum(FOOD_HOURS_CONFIDENCE);
export type FoodHoursConfidence = z.infer<typeof foodHoursConfidenceSchema>;

const foodCalendarBase = {
  hoursConfidence: foodHoursConfidenceSchema.default('published'),
  note: z.string().min(1).optional(),
  provenance: sourceProvenanceSchema,
};

/**
 * The same three honest answers the attraction side gives, minus the two fields
 * that only make sense for a gate: there is no admission requirement (that is
 * `reservation`) and no daylight-only flag (a restaurant is lit).
 *
 * `operatingPeriodSchema` is reused verbatim — split lunch and dinner service is
 * exactly the multi-window case it was written for.
 */
export const foodOpeningCalendarSchema = z.discriminatedUnion('kind', [
  z.object({
    /** Genuinely round the clock. One 24-hour grocery in the current fixture. */
    kind: z.literal('always_open'),
    ...foodCalendarBase,
  }),
  z.object({
    kind: z.literal('scheduled'),
    ...foodCalendarBase,
    periods: z.array(operatingPeriodSchema).min(1).max(6),
    closedAnnualDates: z.array(monthDaySchema).max(12).default([]),
  }),
  z.object({
    /**
     * We could not read hours from any source we trust. The planner will not
     * schedule a meal here — unlike an attraction, where an unknown-hours
     * roadside stop is usually still visitable, a restaurant whose hours nobody
     * has confirmed is a fifty-fifty chance of a locked door at dinnertime.
     */
    kind: z.literal('unknown'),
    ...foodCalendarBase,
  }),
]);
export type FoodOpeningCalendar = z.infer<typeof foodOpeningCalendarSchema>;

// ---------------------------------------------------------------------------
// The venue
// ---------------------------------------------------------------------------

/**
 * THE DOOR WALK IS THE WHOLE OF WHAT SHARING A ROUTING NODE MEANS.
 *
 * `walkMinutesFromRouting` below is bounded at twenty minutes because the node
 * and the door are meant to be two points on one main street — "authored, and
 * small by construction". That bound is also, read the other way, the *only*
 * statement this schema makes about how far a venue may be from the node it is
 * priced against, so it is named once here and both readings use it.
 *
 * The reading was missing, and four of four named-restaurant legs in the founder
 * journeys were wrong because of it. One compiled venue was snapped onto a park
 * 4.80 km away — the nearest thing already in the matrix — and the day rendered
 * "8 min on foot, in the model" against it with `provenance: 'measured'`: the
 * park's travel time, printed under the venue's name. A second venue 3.27 km
 * from the same park carried the identical minutes and kilometres.
 */
export const FOOD_DOOR_WALK_MAX_MINUTES = 20;

/**
 * The same contract in kilometres, at whatever pace the caller models walks
 * with — `MODELLED_WALK_KMH` for every caller in this repository.
 *
 * Taken as an argument rather than imported so the schema layer keeps stating
 * the contract and nothing else: the pace belongs to the travel layer, and a
 * second copy of it here is how two answers to one question start.
 */
export function foodRoutingSnapKm(walkKmh: number): number {
  return (FOOD_DOOR_WALK_MAX_MINUTES * walkKmh) / 60;
}

/**
 * The walk from the node to the door, from the distance actually between them.
 *
 * Both live food paths hard-coded this to zero, which is what let a leg to a
 * venue kilometres from its node read as a door-to-door measurement. Rounded up,
 * like every other modelled walk: a number that understates a walk puts a
 * traveller at a door after it shut.
 *
 * Clamped at the contract's own maximum only to absorb float error exactly at
 * the ceiling — `1.5 km` at `4.5 km/h` evaluates to `20.000000000000004`
 * minutes. A venue past the ceiling is refused by `snapFoodRouting`, never
 * clamped into range.
 */
export function foodDoorWalkMinutes(km: number, walkKmh: number): number {
  return Math.min(FOOD_DOOR_WALK_MAX_MINUTES, Math.ceil((km * 60) / walkKmh));
}

/**
 * THE NODE A VENUE MAY SHARE, OR NOTHING.
 *
 * Nearest rather than first: a two-base trip would otherwise price every
 * restaurant against the first base, including the ones across a fjord from it.
 * But nearest is not on its own a licence to snap — the anchors are the bases
 * plus the couple of dozen compiled places, so in a metropolis the nearest one
 * is routinely three to sixteen kilometres away, and snapping there prices the
 * meal at the anchor's travel time under the venue's name.
 *
 * So the ceiling is the door-walk contract above, converted to distance. Past
 * it there is no honest node for this venue and the caller is handed `null`
 * rather than a plausible-looking one; inventing a matrix row for the venue
 * would grow the matrix by one row per restaurant, which is the cost this whole
 * mechanism exists to avoid.
 */
export function snapFoodRouting(input: {
  coordinates: { lat: number; lng: number };
  anchors: readonly { id: string; coordinates: { lat: number; lng: number } }[];
  walkKmh: number;
}): { routingId: string; walkMinutesFromRouting: number; km: number } | null {
  const door = { id: 'door', ...input.coordinates };
  let best: { id: string; km: number } | undefined;
  for (const anchor of input.anchors) {
    const km = haversineKm({ id: anchor.id, ...anchor.coordinates }, door);
    if (!best || km < best.km) best = { id: anchor.id, km };
  }
  if (!best) return null;
  if (best.km > foodRoutingSnapKm(input.walkKmh)) return null;
  return {
    routingId: best.id,
    walkMinutesFromRouting: foodDoorWalkMinutes(best.km, input.walkKmh),
    km: best.km,
  };
}

/**
 * The same contract, enforced where a region's food is assembled.
 *
 * A venue may only carry a routing id it is within one door walk of. `snapFoodRouting`
 * is the only sanctioned way to choose one, and this is the assertion that says
 * so at the boundary: a venue built some other way — a second provider path, a
 * fixture, a later edit that reaches for `nearestAnchor` again — cannot be
 * stored with a node kilometres from its door without failing here first.
 *
 * Throws rather than filters. A stored region carrying this defect renders a
 * measured travel time to the wrong place, which is worse than a compilation
 * that stops and says why.
 */
export function assertFoodRoutingWithinDoorWalk(input: {
  venues: readonly {
    id: string;
    coordinates: { lat: number; lng: number };
    routingId: string;
    walkMinutesFromRouting?: number;
  }[];
  anchors: readonly { id: string; coordinates: { lat: number; lng: number } }[];
  walkKmh: number;
}): void {
  const ceilingKm = foodRoutingSnapKm(input.walkKmh);
  const byId = new Map(input.anchors.map((anchor) => [anchor.id, anchor.coordinates]));
  const offenders: string[] = [];
  for (const venue of input.venues) {
    const node = byId.get(venue.routingId);
    if (!node) {
      offenders.push(`"${venue.id}" is priced against "${venue.routingId}", which is not a node`);
      continue;
    }
    const km = haversineKm({ id: venue.routingId, ...node }, { id: venue.id, ...venue.coordinates });
    if (km > ceilingKm) {
      offenders.push(
        `"${venue.id}" is ${km.toFixed(2)} km from "${venue.routingId}", past the ${ceilingKm.toFixed(2)} km a ${FOOD_DOOR_WALK_MAX_MINUTES}-minute door walk allows`,
      );
      continue;
    }
    const walk = venue.walkMinutesFromRouting ?? 0;
    if (walk !== foodDoorWalkMinutes(km, input.walkKmh)) {
      offenders.push(
        `"${venue.id}" is ${km.toFixed(2)} km from its node but records a ${walk}-minute walk to the door`,
      );
    }
  }
  if (offenders.length > 0) {
    throw new Error(`Food venues are priced against nodes they are not beside:\n- ${offenders.join('\n- ')}`);
  }
}

export const foodVenueSchema = z
  .object({
    ...POI_BASE_FIELDS,
    serviceType: foodServiceTypeSchema,
    /** Which meals this venue can actually serve. Never inferred from its type. */
    mealPeriods: z.array(mealPeriodSchema).min(1),
    cuisines: z.array(z.string().min(1)).default([]),
    priceBand: priceBandSchema,
    priceEvidence: priceEvidenceSchema,
    /** Typical time on site, door to door. A bakery is not a tasting menu. */
    serviceMinutes: z.number().int().min(10).max(180),
    reservation: foodReservationSchema,
    /** Only ever `confirmed` when the venue's own page says so. */
    takeaway: z.enum(['confirmed', 'unknown']).default('unknown'),
    provisioning: foodProvisioningSchema.default('none'),
    dietary: z.array(dietaryClaimSchema).default([]),
    /**
     * A regionally significant thing you can only really eat here. Rare on
     * purpose: four of twenty venues, not a marketing line on every card.
     */
    localSpecialty: z
      .object({
        label: z.string().min(1),
        note: z.string().min(1),
        sourceUrl: httpUrlSchema.optional(),
      })
      .optional(),
    hours: foodOpeningCalendarSchema,
    /**
     * The venue's key in the travel-time matrix.
     *
     * Same mechanism `AccessPoint.routingId` uses: a food stop is priced by
     * exactly the same machinery as a drive to a lake, rather than by a
     * straight-line distance dressed up as a road time. Several venues share one
     * routing node, which is honest at this model's resolution — a corridor
     * model cannot tell one end of a main street from the other. It is not
     * honest at any distance: `snapFoodRouting` is the only sanctioned way to
     * choose one, and it refuses beyond `FOOD_DOOR_WALK_MAX_MINUTES` on foot.
     */
    routingId: z.string().min(1),
    /**
     * From the routing node to the door. Small by construction — and the bound
     * is `FOOD_DOOR_WALK_MAX_MINUTES` rather than a literal because
     * `snapFoodRouting` reads the same number as a distance ceiling on which
     * node a venue may share at all. One contract, one place it is stated.
     */
    walkMinutesFromRouting: z.number().int().min(0).max(FOOD_DOOR_WALK_MAX_MINUTES).default(0),
  })
  .superRefine((venue, ctx) => {
    if (venue.provisioning !== 'none' && venue.hours.kind === 'unknown') {
      ctx.addIssue({
        code: 'custom',
        // A provisioning stop is scheduled *before* the food is needed, so a
        // wrong guess about its hours strands the whole of the next day.
        message: `"${venue.id}" is relied on for provisioning but has no confirmed hours`,
        path: ['hours'],
      });
    }
    if (venue.mealPeriods.includes('groceries') && venue.provisioning === 'none') {
      ctx.addIssue({
        code: 'custom',
        message: `"${venue.id}" serves groceries but says you cannot take anything away`,
        path: ['provisioning'],
      });
    }
  });
export type FoodVenue = z.infer<typeof foodVenueSchema>;
/**
 * The shape a fixture author writes, before defaults are applied. Annotating the
 * seed data with this rather than with `FoodVenue` is what makes a mistyped
 * field a compile error instead of a runtime parse failure, without forcing
 * every record to restate `takeaway: 'unknown'`.
 */
export type FoodVenueInput = z.input<typeof foodVenueSchema>;

/**
 * Somewhere we looked and found nothing.
 *
 * A first-class record rather than an absence, for the same reason
 * `weather: unavailable` is: a planner that reads "no venues near here" as "we
 * have not indexed this area yet" behaves differently from one that reads it as
 * "the managing agency states there is no food here", and only the second can
 * confidently tell a traveller to pack a lunch.
 */
export const foodGapSchema = z.object({
  /** Free text the copy can use — "the Reds Meadow valley". */
  area: z.string().min(1),
  /** Which places this gap covers, so the planner can match a day against it. */
  placeIds: z.array(z.string().min(1)).min(1),
  /** What the source said, close to verbatim. */
  note: z.string().min(1),
  provenance: sourceProvenanceSchema,
});
export type FoodGap = z.infer<typeof foodGapSchema>;

export const foodDatasetSchema = z
  .object({
    version: z.literal(FOOD_DATASET_VERSION),
    regionId: z.string().min(1),
    venues: z.array(foodVenueSchema),
    /** Places we know have nothing, with the source that says so. */
    gaps: z.array(foodGapSchema).default([]),
  })
  .superRefine((dataset, ctx) => {
    const seen = new Set<string>();
    for (const venue of dataset.venues) {
      if (seen.has(venue.id)) {
        ctx.addIssue({
          code: 'custom',
          message: `Two food venues claim the id "${venue.id}"`,
          path: ['venues'],
        });
      }
      seen.add(venue.id);

      if (venue.regionId !== dataset.regionId) {
        ctx.addIssue({
          code: 'custom',
          message: `"${venue.id}" belongs to region "${venue.regionId}", not "${dataset.regionId}"`,
          path: ['venues'],
        });
      }

      if (venue.hours.provenance.volatility === 'dynamic' && !venue.hours.provenance.recheckNote) {
        ctx.addIssue({
          code: 'custom',
          message: `"${venue.id}" has hours that change without notice and no recheck note`,
          path: ['venues'],
        });
      }

      if (venue.hours.kind === 'unknown' && venue.hours.provenance.kind === 'official') {
        ctx.addIssue({
          code: 'custom',
          message: `"${venue.id}" cannot have official provenance for hours we do not know`,
          path: ['venues'],
        });
      }

      if (venue.hours.hoursConfidence !== 'published' && !venue.hours.provenance.recheckNote) {
        ctx.addIssue({
          code: 'custom',
          // An estimated closing time with nothing telling the traveller to
          // check it is the worst of both worlds: it reads as published.
          message: `"${venue.id}" has hours we did not fully read and no recheck note`,
          path: ['venues'],
        });
      }
    }
  });
export type FoodDataset = z.infer<typeof foodDatasetSchema>;

// ---------------------------------------------------------------------------
// What ends up on the timeline
// ---------------------------------------------------------------------------

/** The slot a food stop fills on a day. Distinct from what a venue *serves*. */
export const MEAL_SLOTS = ['breakfast', 'lunch', 'dinner', 'snack'] as const;
export const mealSlotSchema = z.enum(MEAL_SLOTS);
export type MealSlot = z.infer<typeof mealSlotSchema>;

export const MEAL_SLOT_LABELS: Record<MealSlot, string> = {
  breakfast: 'Breakfast',
  lunch: 'Lunch',
  dinner: 'Dinner',
  snack: 'Snack',
};

/**
 * What kind of food stop got scheduled.
 *
 * `packed` and `grocery` are first-class outcomes, not failures. On a day whose
 * stops are an hour up a shuttle-only valley with no concession in it, "buy
 * lunch in town before you leave" is the correct plan, and dressing it up as a
 * restaurant visit would be the failure.
 */
export const FOOD_STOP_KINDS = ['venue', 'grocery', 'packed', 'unplanned'] as const;
export const foodStopKindSchema = z.enum(FOOD_STOP_KINDS);
export type FoodStopKind = z.infer<typeof foodStopKindSchema>;

/** Where the chosen venue sits relative to the day the traveller was already having. */
export const FOOD_ROUTE_CONTEXTS = [
  'at_base',
  'on_route',
  'near_route',
  'at_day_end',
  'off_route',
] as const;
export const foodRouteContextSchema = z.enum(FOOD_ROUTE_CONTEXTS);
export type FoodRouteContext = z.infer<typeof foodRouteContextSchema>;

export const scheduledFoodHoursSchema = z
  .object({
    openMinute: minuteOfDaySchema,
    closeMinute: minuteOfDaySchema,
    periodLabel: z.string().min(1).optional(),
    confidence: foodHoursConfidenceSchema,
    sourceKind: z.enum(['official', 'authored', 'estimated']),
    sourceName: z.string().min(1),
    sourceUrl: httpUrlSchema.optional(),
    lastVerified: z.string().min(1).optional(),
  })
  .refine((hours) => hours.closeMinute > hours.openMinute, {
    message: 'A food opening window must close after it opens',
    path: ['closeMinute'],
  });
export type ScheduledFoodHours = z.infer<typeof scheduledFoodHoursSchema>;

/** An option that was legal and lost, kept so the traveller can see the runners-up. */
export const foodAlternativeSchema = z.object({
  venueId: z.string().min(1),
  name: z.string().min(1),
  serviceType: foodServiceTypeSchema,
  priceBand: priceBandSchema,
  /** The one clause that says what you would be trading. */
  tradeoff: z.string().min(1),
  /**
   * How far it is from where the traveller would be standing — not a detour.
   *
   * Named apart from `ScheduledFood.detourMinutes` on purpose: that one is the
   * round trip, or the approach plus the onward leg less the straight-through,
   * and using one word for both put two different quantities under one label on
   * the same row.
   */
  approachMinutes: z.number().int().min(0),
});
export type FoodAlternative = z.infer<typeof foodAlternativeSchema>;

/**
 * The food decision attached to a `meal` item.
 *
 * Absence means the meal is a bare block of time — which is what a version-5
 * plan's meals all were. Presence means a decision was made and here is every
 * input to it.
 */
export const scheduledFoodSchema = z.object({
  slot: mealSlotSchema,
  stopKind: foodStopKindSchema,
  venueId: z.string().min(1).optional(),
  venueName: z.string().min(1).optional(),
  serviceType: foodServiceTypeSchema.optional(),
  cuisineLabel: z.string().min(1).optional(),
  priceBand: priceBandSchema.optional(),
  priceEvidence: priceEvidenceSchema.optional(),
  localSpecialty: z.string().min(1).optional(),
  reservation: foodReservationSchema.optional(),
  /** Every need the traveller declared, answered honestly for this venue. */
  dietary: z.array(dietaryClaimSchema).default([]),
  /** Set when the traveller declared a need this venue has nothing on record for. */
  dietaryUnverified: z.array(dietaryNeedSchema).default([]),
  hours: scheduledFoodHoursSchema.optional(),
  /**
   * Nobody published an opening time for this venue that anybody could read.
   *
   * Not the same statement as `hours` being absent, and the difference is the
   * whole of the naming rule. An absent `hours` on a named venue is a name with
   * nothing behind it, which the validator refuses. This says the venue's own
   * record answered "unknown" — which is a caution to state, never a reason to
   * withhold who they are. Every venue a live compilation stores carries
   * `hours: { kind: 'unknown' }`, so treating that as a refusal produced
   * thirty-one time-held meals across three trips and not one named place.
   *
   * Carried on the item rather than re-derived, because a stored plan has no
   * way back to the venue record it was built from.
   */
  hoursUnknown: z.boolean().default(false),
  /**
   * An area named instead of a venue, when naming one would have outrun the
   * evidence.
   *
   * Read off the region's own localities and the day's own cluster — never
   * invented — so a meal that cannot be a place is still somewhere to go rather
   * than a bare hour with a meal's name on it.
   */
  areaName: z.string().min(1).optional(),
  routeContext: foodRouteContextSchema,
  /**
   * The walk between the routing node and the door, one way.
   *
   * The meal *block* on the timeline starts when the traveller leaves the
   * routing node, because that minute is spent on this meal and hiding it would
   * put a walk inside somebody's lunch. The *service* starts `walk` minutes
   * later, and it is the service that has to happen while the door is open.
   *
   * Recorded because the validator cannot otherwise tell the two apart: it read
   * the block start against the opening minute and reported a venue opening at
   * 11:30 as closed for a meal whose block began at 11:29 — a one-minute walk
   * quoted back as a shut door. Optional because a plan stored before this
   * existed genuinely does not know its walk, and assuming zero there would
   * silently revive the same off-by-one in the other direction.
   */
  walkMinutesFromRouting: z.number().int().min(0).max(FOOD_DOOR_WALK_MAX_MINUTES).optional(),
  /** Extra minutes on the road this stop cost, over going straight on. */
  detourMinutes: z.number().int().min(0).default(0),
  /** On a grocery stop: which day the supplies are for. */
  suppliesDayNumber: z.number().int().min(1).optional(),
  /** On a packed meal: which day's stop the food was bought at. */
  preparedOnDayNumber: z.number().int().min(1).optional(),
  /** This trip's one special meal, when it is. */
  isSpecialMeal: z.boolean().default(false),
  /**
   * Which of §15's seven kinds of food stop this turned out to be.
   *
   * Derived from every field above it — see `food/quality.ts#mealCharacterOf` —
   * and stored rather than recomputed so a rendered plan and the plan that was
   * validated cannot disagree. Optional because a stored itinerary written
   * before the distinction existed genuinely does not have one, and reading a
   * default in would be inventing an answer for a decision nobody made.
   *
   * Typed as a plain enum here rather than importing the derivation, because
   * schemas must not depend on the logic that fills them.
   */
  mealCharacter: z
    .enum([
      'special_occasion',
      'destination_meal',
      'local_speciality',
      'route_convenient',
      'quick_fuel',
      'breakfast_coffee',
      'grocery_snack',
    ])
    .optional(),
  /** The traveller asked for this venue on the board. */
  fromUserChoice: z.boolean().default(false),
  alternatives: z.array(foodAlternativeSchema).default([]),
});
export type ScheduledFood = z.infer<typeof scheduledFoodSchema>;

/**
 * What the day's food plan is, derived from the finished timeline rather than
 * declared alongside it, so the two cannot drift.
 */
export const dayFoodSummarySchema = z.object({
  summary: z.string().min(1),
  /** Slots this day genuinely needed, whether or not they were filled. */
  slots: z.array(mealSlotSchema).default([]),
  /** True when the day's stops have no verified food within reach. */
  remote: z.boolean().default(false),
  /** Things worth reading before the day. Never restates what a meal row says. */
  notes: z.array(z.string().min(1)).default([]),
  /** Bookings the traveller has to make. Never made by Sidequest. */
  reservations: z
    .array(
      z.object({
        venueName: z.string().min(1),
        requirement: reservationRequirementSchema,
        note: z.string().min(1).optional(),
        bookingUrl: httpUrlSchema.optional(),
      }),
    )
    .default([]),
});
export type DayFoodSummary = z.infer<typeof dayFoodSummarySchema>;

/** The trip-level position, again derived from what was actually scheduled. */
export const foodPlanSchema = z.object({
  headline: z.string().min(1),
  /** How the traveller said they wanted to eat, echoed back in their words. */
  style: z.string().min(1),
  dietaryNeeds: z.array(dietaryNeedSchema).default([]),
  /** True when the traveller said these are requirements rather than leanings. */
  dietaryStrict: z.boolean().default(false),
  /** One line that never claims a venue is safe. Omitted when nothing declared. */
  dietaryDisclosure: z.string().min(1).optional(),
  specialMealsPlanned: z.number().int().min(0),
  specialMealBudget: z.number().int().min(0),
  /** Days on which supplies are bought, and days that eat them. */
  groceryDayNumbers: z.array(z.number().int().min(1)).default([]),
  packedDayNumbers: z.array(z.number().int().min(1)).default([]),
  /** Days where nothing verified fitted, so the plan says so instead. */
  daysWithoutVerifiedOption: z.array(z.number().int().min(1)).default([]),
  localSpecialties: z.array(z.string().min(1)).default([]),
  /** Venues the traveller asked for that could not be worked in, with reasons. */
  unusedChoices: z
    .array(z.object({ venueId: z.string().min(1), name: z.string().min(1), reason: z.string().min(1) }))
    .default([]),
  /** Says in one line where the food facts came from. Never omitted. */
  dataDisclosure: z.string().min(1),
});
export type FoodPlan = z.infer<typeof foodPlanSchema>;
