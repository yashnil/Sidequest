import { z } from 'zod';
import { SAFE_PROSE_PATTERN, SAFE_SLUG_PATTERN } from './safe-text';

/**
 * THE TRIP DRAFT — THE CANONICAL TRAVELLER-FACING CONTENT SIDEQUEST VERIFIES.
 *
 * "The model composes. Sidequest verifies, corrects, enriches and presents."
 * This schema is what the one composition call returns and it is the
 * *content draft* of the finished itinerary, not planner internals: bases and
 * nights, a sequence of experiences per day with the reason each is there,
 * meal intent, lodging guidance, food and transport strategy, preparation,
 * packing, backups and the omissions the model made on purpose.
 *
 * Deliberately absent, because the model is never authoritative for them:
 * provider ids, coordinates, measured durations, opening hours, permit
 * availability, prices, legal/visa facts. Every anchor is a *name* plus a
 * locality hint; identity, routing, hours and access are resolved afterwards
 * by `reconcile.ts` against Sidequest's own evidence, and anything that
 * cannot be verified stays in the trip marked as unverified rather than being
 * deleted (`unknown != false`).
 *
 * Every prose field reuses the baseline composer's `SAFE_PROSE_PATTERN` (no
 * URLs, no markup), and every array is bounded, so the wire size is
 * predictable — see `trip-draft-budget.test.ts` for the measured ceiling.
 */
export const TRIP_DRAFT_SCHEMA_VERSION = 1 as const;

export function prose(max: number): z.ZodString {
  return z.string().max(max).regex(SAFE_PROSE_PATTERN);
}
const slug = () => z.string().max(40).regex(SAFE_SLUG_PATTERN);

/**
 * The trip shapes the model may choose. Named after how a trip actually
 * moves — never after a destination — so the same vocabulary covers a city
 * break, a safari circuit and an archipelago. The three legacy values are
 * still accepted so a stored draft from an earlier prompt keeps parsing.
 */
export const TRIP_ARCHETYPES = [
  'single_base_urban',
  'hub_and_spoke',
  'road_trip',
  'rail_route',
  'island_hopping',
  'fly_drive',
  'multi_region',
  'wilderness_gateway',
  'guided_remote',
  'lodge_circuit',
  'mixed',
  'single_base',
  'moving_route',
  'loop',
] as const;
export type TripArchetype = (typeof TRIP_ARCHETYPES)[number];

/**
 * The archetypes the model is asked to choose from — the same list without the
 * three legacy names.
 *
 * `single_base`, `moving_route` and `loop` are accepted by the canonical schema
 * so a draft stored under an earlier prompt keeps parsing, and by the wire
 * normaliser's aliases so a model that says one is understood. Neither reason
 * requires *offering* them: a prompt that lists fourteen names where eleven are
 * meant costs bytes in the wire schema and invites the vaguest three to be
 * chosen. `wire-vocabulary.test.ts` holds the two lists to each other.
 */
export const CURRENT_TRIP_ARCHETYPES = TRIP_ARCHETYPES.filter(
  (archetype) => archetype !== 'single_base' && archetype !== 'moving_route' && archetype !== 'loop',
) as readonly TripArchetype[];

/** How the trip moves, in the three-way vocabulary the relocation machinery reasons in. */
export function movementShapeOf(archetype: TripArchetype): 'single_base' | 'moving_route' | 'loop' {
  switch (archetype) {
    case 'single_base':
    case 'single_base_urban':
    case 'hub_and_spoke':
    case 'wilderness_gateway':
      return 'single_base';
    case 'loop':
      return 'loop';
    default:
      return 'moving_route';
  }
}

/** A small closed vocabulary so the reconciler can pick sensible default durations and the UI a plate colour. */
export const ANCHOR_CATEGORIES = [
  'landmark',
  'nature',
  'hike',
  'viewpoint',
  'water',
  'wildlife',
  'geothermal',
  'museum',
  'historic',
  'neighbourhood',
  'market',
  'food',
  'activity',
  'scenic_drive',
  'beach',
  'town',
  'relaxation',
  'other',
] as const;
export type AnchorCategory = (typeof ANCHOR_CATEGORIES)[number];

/** `core` is what the day is for; `secondary` fits around it; `optional`/`flex` are the first to give way when a hard constraint bites. */
export const ANCHOR_ROLES = ['core', 'secondary', 'optional', 'flex'] as const;
export type AnchorRole = (typeof ANCHOR_ROLES)[number];

/**
 * How the traveller reaches this experience, as the model expects it — a
 * hint the reconciler carries into `travel.mode` where Sidequest can measure
 * the leg, and reports honestly ("local arrangement, not measured") where it
 * cannot. Deliberately wider than the road/rail set the routing provider
 * measures: a boat leg into a delta or a lodge transfer is a real, plannable
 * movement that no road router will ever answer for.
 */
export const DRAFT_TRANSPORTS = [
  'walk',
  'metro',
  'rail',
  'bus',
  'car',
  'ferry',
  'boat',
  'flight',
  'private_transfer',
  'four_wheel_drive',
  'guide_or_lodge_transfer',
  /*
   * A horse is transport in the places this product plans for.
   *
   * Added by the latency closure's Kyrgyzstan work, and not for Kyrgyzstan: a
   * summer pasture reached on horseback, a Patagonian estancia ride and a
   * Mongolian steppe crossing are all movement between two points that no road
   * router will ever answer, and the vocabulary's only honest alternative was
   * to call them a guided transfer. Everything downstream treats it as what it
   * is — a real leg nobody can measure — so it lowers confidence instead of
   * inventing a duration.
   */
  'horse',
  /*
   * V7 §7 — separate concepts, never collapsed into "car". A taxi or
   * ride-hailing hop is not self-drive and not a hired driver for the day; a
   * high-speed train is the regional backbone in the countries that have one
   * and is timetabled, bookable and never a road leg.
   */
  'taxi',
  'high_speed_rail',
  'unknown',
] as const;
export type DraftTransport = (typeof DRAFT_TRANSPORTS)[number];

export const DRAFT_SOFT_PROSE_CAPS = {
  purpose: 240,
  routeRationale: 240,
  assumption: 120,
  tradeoff: 120,
  baseWhy: 140,
  lodgingArea: 80,
  lodgingStyle: 60,
  dayTheme: 100,
  dayNote: 160,
  whyItFits: 160,
  meal: 100,
  anchorWhy: 140,
  omissionReason: 140,
  unresolvedItem: 160,
  bookingPriority: 120,
  foodStrategy: 140,
  transportSummary: 200,
  transportNote: 140,
  beforeYouGo: 140,
  packing: 80,
  backupTrigger: 100,
  backupAlternative: 140,
} as const;

/**
 * WHEN IN THE DAY THIS EXPERIENCE BELONGS.
 *
 * PRODUCTION LOCK V5 §13. A night market, a sunrise viewpoint, a sunset ridge
 * and an evening show are not interchangeable with a museum, and before this
 * the draft had no way to say so: the scheduler placed activities by their
 * order alone, and the quality audit had nothing to check a sunset viewpoint at
 * eleven in the morning against. `any` is the honest default and the vast
 * majority of activities keep it, which is why the field is optional — an
 * absent value costs nothing on the wire and means "whenever the day suits".
 */
export const DRAFT_TIME_OF_DAY = ['sunrise', 'morning', 'midday', 'afternoon', 'sunset', 'evening', 'night', 'any'] as const;
export type DraftTimeOfDay = (typeof DRAFT_TIME_OF_DAY)[number];

/** True for a time intent that pins an experience to a part of the day the scheduler must respect. */
export function timeOfDayIsBinding(value: DraftTimeOfDay | undefined): boolean {
  return value !== undefined && value !== 'any';
}

/**
 * V10 §7 — WHICH STATED HOURS GEOGRAPHY MAY NOT OVERRIDE.
 *
 * `sunrise`, `sunset` and `night` are facts about the sky: a stop written for
 * sunset cannot be visited at eleven in the morning whatever the driving says,
 * and a reordering that moves one is a reordering that destroys the reason it is
 * on the plan. Those are hard.
 *
 * `morning`, `midday`, `afternoon` and `evening` are preferences about *where in
 * the day* a stop sits, and they were being enforced as though they were hard.
 * The founder's day 3 is exactly what that costs: the model composed three
 * roadside stops correctly, west to east along one road; the *second* of them
 * carried `morning` and the first carried nothing, so the hour sort (PRODUCTION
 * LOCK V5 §13) moved it in front and the day drove 30 km past the first stop,
 * doubled back 28 minutes for it, and went east again. A 49 km detour bought by a
 * word that only ever meant "earlier rather than later".
 *
 * So a soft hint still orders a day that geography has nothing to say about, and
 * yields when it does — and the yielding is recorded, never silent.
 */
export function timeOfDayIsHard(value: DraftTimeOfDay | undefined): boolean {
  return value === 'sunrise' || value === 'sunset' || value === 'night';
}

/**
 * The values the model is offered. `any` is absent from it deliberately: an
 * omitted field already means "whenever the day suits", so offering a word for
 * it buys nothing and invites it to be written on every activity. The canonical
 * schema and the normaliser's aliases still accept `any` from a stored draft.
 */
export const WIRE_TIME_OF_DAY = DRAFT_TIME_OF_DAY.filter((value) => value !== 'any') as readonly DraftTimeOfDay[];

/**
 * HOW THE DRIVING IS ARRANGED — SEPARATE FROM WHETHER A CAR IS INVOLVED.
 *
 * PRODUCTION LOCK V5 §14 and §15. `car` in `DRAFT_TRANSPORTS` says a road
 * vehicle moves the traveller. It does not say who is at the wheel, and
 * everything downstream that reasons about rental desks, an International
 * Driving Permit, parking, fuel and excess insurance was keying off `car`
 * alone. A trip with a private driver therefore produced rental advice.
 *
 * One trip-level field rather than an arrangement on every leg, deliberately:
 * the arrangement is a property of how the trip was *booked*, it is the same
 * for almost every road leg in a trip, and repeating it two dozen times is
 * exactly the wire waste the compact schema exists to remove. Where a single
 * leg differs — a taxi to the airport on a self-drive trip — that is a
 * transport note, not a new vocabulary.
 */
export const DRAFT_DRIVING_ARRANGEMENTS = [
  /** The traveller hires a car and drives it themselves. The only value that implies a rental desk. */
  'rental_self_drive',
  /** The traveller drives a vehicle they already have. */
  'owned_self_drive',
  /** A hired driver, with or without a guide. No rental, no permit, no parking advice. */
  'private_driver',
  /** Taxis and rideshare, leg by leg. */
  'taxi_rideshare',
  /** Transfers arranged by an operator, lodge or guide as part of the trip. */
  'operator_transfer',
  /** No road vehicle the traveller is responsible for: transit, walking, rail, boat, flight. */
  'none',
] as const;
export type DraftDrivingArrangement = (typeof DRAFT_DRIVING_ARRANGEMENTS)[number];

/** True only when the itinerary genuinely implies hiring and driving a car. */
export function impliesRentalCar(arrangement: DraftDrivingArrangement | undefined): boolean {
  return arrangement === 'rental_self_drive';
}

/** True when the traveller is at the wheel at all — the test parking and permit advice should use. */
export function impliesSelfDriving(arrangement: DraftDrivingArrangement | undefined): boolean {
  return arrangement === 'rental_self_drive' || arrangement === 'owned_self_drive';
}

/**
 * WHERE THE TRAVELLER SLEEPS, AS A KIND OF PLACE.
 *
 * PRODUCTION LOCK V5 §10 and §11. A hut-to-hut traverse, a yurt route, a
 * safari camp, a river boat and an overnight train are all real overnights that
 * the previous schema could only express as a hotel-shaped base with a free-text
 * `lodgingStyle`. Everything downstream — check-in advice, packing, the "stays"
 * section, the booking list — then treated a mountain refuge like a hotel.
 *
 * `overnight_transfer` is the one that carries the most information: the night
 * IS the movement, so there is no bed to book at a place and no check-in time.
 */
export const OVERNIGHT_KINDS = [
  'hotel',
  'hostel',
  'guesthouse',
  'homestay',
  'apartment',
  'camp',
  'tent',
  'hut',
  'refuge',
  'yurt',
  'lodge',
  'boat',
  'train',
  /** A night spent moving: a sleeper bus, a red-eye, a ferry crossing. */
  'overnight_transfer',
  'other',
] as const;
export type OvernightKind = (typeof OVERNIGHT_KINDS)[number];

/** True when this overnight is a place with a bed somebody checks into. */
export function overnightHasCheckIn(kind: OvernightKind | undefined): boolean {
  return kind !== 'overnight_transfer';
}

/** True when the overnight is itself part of the experience rather than accommodation near it. */
export function overnightIsExperiential(kind: OvernightKind | undefined): boolean {
  return kind === 'camp' || kind === 'tent' || kind === 'hut' || kind === 'refuge' || kind === 'yurt' || kind === 'lodge' || kind === 'boat' || kind === 'homestay';
}

export const draftAnchorSchema = z.object({
  /** The place's own real name. Identity is resolved by Sidequest afterwards. */
  name: prose(60),
  /** A town, region or landmark to disambiguate the name — "near Vík", "Westfjords". */
  locality: prose(40).optional(),
  category: z.enum(ANCHOR_CATEGORIES),
  role: z.enum(ANCHOR_ROLES),
  /** The model's rough sense of time on site, minutes. Only used until Sidequest has a better figure; never presented as more than an estimate. */
  estimatedDurationMinutes: z.number().int().min(10).max(600).optional(),
  transport: z.enum(DRAFT_TRANSPORTS).optional(),
  /** §13 — the part of the day this belongs to. Absent means "whenever the day suits". */
  timeOfDay: z.enum(DRAFT_TIME_OF_DAY).optional(),
  why: prose(DRAFT_SOFT_PROSE_CAPS.anchorWhy),
});
export type DraftAnchor = z.infer<typeof draftAnchorSchema>;

export const draftBaseSchema = z.object({
  id: slug(),
  name: prose(100),
  locality: prose(40).optional(),
  nights: z.number().int().min(0).max(60),
  why: prose(DRAFT_SOFT_PROSE_CAPS.baseWhy),
  /** The neighbourhood or part of town to sleep in, when the model has a real opinion. */
  lodgingArea: prose(DRAFT_SOFT_PROSE_CAPS.lodgingArea).optional(),
  /** "guesthouse", "mid-range hotel near the harbour", "mountain lodge" — style, never a named hotel as a promise. */
  lodgingStyle: prose(DRAFT_SOFT_PROSE_CAPS.lodgingStyle).optional(),
  /** §10 — the kind of place this is. Absent reads as `hotel` for a base written before this existed. */
  overnight: z.enum(OVERNIGHT_KINDS).optional(),
});
export type DraftBase = z.infer<typeof draftBaseSchema>;

export const draftMealsSchema = z.object({
  breakfast: prose(DRAFT_SOFT_PROSE_CAPS.meal).optional(),
  lunch: prose(DRAFT_SOFT_PROSE_CAPS.meal).optional(),
  dinner: prose(DRAFT_SOFT_PROSE_CAPS.meal).optional(),
  /**
   * §22 — the neighbourhood, market or quarter the day's food sits in.
   *
   * One field per day rather than one per meal, because it is what downstream
   * enrichment actually needs to resolve a venue: "dim sum in Sheung Wan" is a
   * searchable intent and "lunch near base" is not. Optional, and only written
   * where the food has a geography of its own.
   */
  area: prose(DRAFT_SOFT_PROSE_CAPS.lodgingArea).optional(),
});

export const draftDaySchema = z.object({
  dayNumber: z.number().int().min(1).max(40),
  /** Which base the traveller sleeps at *that night* (the last day's base is where they leave from). */
  baseId: slug(),
  theme: prose(DRAFT_SOFT_PROSE_CAPS.dayTheme),
  intensity: z.enum(['light', 'moderate', 'intense']),
  /** True when this day moves from the previous base to a new one. */
  relocation: z.boolean().optional(),
  anchors: z.array(draftAnchorSchema).max(5),
  meals: draftMealsSchema.optional(),
  note: prose(DRAFT_SOFT_PROSE_CAPS.dayNote).optional(),
  whyItFits: prose(DRAFT_SOFT_PROSE_CAPS.whyItFits).optional(),
  /**
   * §10 — the multi-day experience this day is one day of, by name.
   *
   * A four-day trek, a safari circuit, a river descent and a hut-to-hut
   * traverse are single experiences that occupy several consecutive days.
   * Naming the experience on each of its days is what lets the rest of the
   * product treat them as one thing: one booking dependency, one packing
   * implication, one row in the stays section, and days that may not be
   * reordered independently of each other.
   */
  partOf: prose(60).optional(),
  /**
   * V6 §5 — A SPLIT EXPERIENCE: same base, different activities, a rejoin.
   *
   * A heterogeneous party is not averaged. When three people want the
   * seven-hour hike and one cannot do steep ground, the day says who does
   * what and where they meet again, rather than dropping the hike or
   * dragging the fourth up it. Optional; most days have none.
   */
  split: z
    .object({
      /** Who does something else: "Mum", "the two of you who are not hiking". */
      who: prose(60),
      /** What they do instead. */
      does: prose(DRAFT_SOFT_PROSE_CAPS.dayNote),
      /** Where and roughly when everyone is together again. */
      rejoin: prose(80).optional(),
    })
    .optional(),
  /** V7 §9 — the day's main movement (a relocation's flight, train, boat or driver), when it is not a road leg. */
  move: z.lazy(() => draftMoveSchema).optional(),
});
export type DraftDay = z.infer<typeof draftDaySchema>;

/**
 * V7 §8 — A MULTI-DAY EXPERIENCE IS ONE THING WITH ITS OWN TRANSPORT REGIME.
 *
 * A river cruise, a trek, a safari circuit, a sleeper train, an expedition
 * boat, a guided overland segment, a resort stay or a bike tour owns its days:
 * the overnights, the route progression, the operator's timings, the
 * included meals, the gateways at each end and the movement inside it. The
 * live Chongqing build flattened a three-night cruise into ordinary places and
 * road legs — a "6 h 10 drive to Qutang Gorge" from a ship — because the draft
 * could only say `partOf` and the reconciler could only build road legs.
 *
 * `partOf` on each day still links the day to the episode by name; the episode
 * itself says what kind of thing it is and how it moves, so the reconciler
 * never asks a road router about a gorge on a river, and the bookings, budget
 * and packing all read one object.
 */
export const EPISODE_KINDS = ['cruise', 'trek', 'safari', 'sleeper_train', 'expedition_boat', 'guided_overland', 'road_trip_segment', 'resort_stay', 'bike_tour', 'hut_to_hut'] as const;
export type EpisodeKind = (typeof EPISODE_KINDS)[number];

export const EPISODE_KIND_LABELS: Record<EpisodeKind, string> = {
  cruise: 'Cruise',
  trek: 'Trek',
  safari: 'Safari',
  sleeper_train: 'Sleeper train',
  expedition_boat: 'Expedition boat',
  guided_overland: 'Guided overland',
  road_trip_segment: 'Road trip',
  resort_stay: 'Resort stay',
  bike_tour: 'Bike tour',
  hut_to_hut: 'Hut to hut',
};

/** How the episode moves inside itself. Never `car` for a river, never a road for a trail. */
export const EPISODE_MODES = ['boat', 'walk', 'four_wheel_drive', 'rail', 'car', 'bicycle', 'guide_or_lodge_transfer', 'horse', 'none'] as const;
export type EpisodeMode = (typeof EPISODE_MODES)[number];

/** The movement an episode kind implies when the draft did not say. */
export const EPISODE_DEFAULT_MODE: Record<EpisodeKind, EpisodeMode> = {
  cruise: 'boat',
  trek: 'walk',
  safari: 'four_wheel_drive',
  sleeper_train: 'rail',
  expedition_boat: 'boat',
  guided_overland: 'guide_or_lodge_transfer',
  road_trip_segment: 'car',
  resort_stay: 'none',
  bike_tour: 'bicycle',
  hut_to_hut: 'walk',
};

export const draftEpisodeSchema = z.object({
  name: prose(60),
  kind: z.enum(EPISODE_KINDS),
  /** First and last day numbers of the episode, inclusive. */
  fromDay: z.number().int().min(1).max(40),
  toDay: z.number().int().min(1).max(40),
  mode: z.enum(EPISODE_MODES),
  /** Who controls the timings inside it. An operator's timings are unknown to Sidequest until confirmed. */
  timing: z.enum(['operator', 'self', 'unknown']).optional(),
  /** Where it starts and ends, as places: a pier, a trailhead, a town, an airstrip. */
  startGateway: prose(60).optional(),
  endGateway: prose(60).optional(),
  meals: z.enum(['included', 'some', 'none']).optional(),
  why: prose(DRAFT_SOFT_PROSE_CAPS.baseWhy).optional(),
});
export type DraftEpisode = z.infer<typeof draftEpisodeSchema>;

/**
 * V7 §9 — THE DAY'S MAIN MOVEMENT, WHEN IT IS NOT A ROAD LEG THE ROUTER CAN GUESS.
 *
 * A relocation day says how it moves: a flight, a high-speed train, a boat, a
 * hired driver. Without this the reconciler built every base change as a road
 * leg and a promised "fly home via Chongqing" produced only breakfast. `when`
 * says whether the move opens the day (disembark, then explore) or closes it.
 */
export const draftMoveSchema = z.object({
  how: z.enum(DRAFT_TRANSPORTS),
  /** The gateway or town the move goes through or to, when it is not the stay itself. */
  via: prose(60).optional(),
  when: z.enum(['start', 'end']).optional(),
});
export type DraftMove = z.infer<typeof draftMoveSchema>;

/** The consecutive day runs that belong to one named multi-day experience. */
export function multiDayExperiences(days: readonly DraftDay[]): { name: string; dayNumbers: number[] }[] {
  const runs: { name: string; dayNumbers: number[] }[] = [];
  for (const day of days) {
    const name = day.partOf?.trim();
    if (!name) continue;
    const last = runs[runs.length - 1];
    if (last && last.name === name && last.dayNumbers[last.dayNumbers.length - 1] === day.dayNumber - 1) last.dayNumbers.push(day.dayNumber);
    else runs.push({ name, dayNumbers: [day.dayNumber] });
  }
  return runs;
}

export const draftPackageSchema = z.object({
  foodStrategy: z.array(prose(DRAFT_SOFT_PROSE_CAPS.foodStrategy)).max(8),
  transport: z.object({
    summary: prose(DRAFT_SOFT_PROSE_CAPS.transportSummary),
    notes: z.array(prose(DRAFT_SOFT_PROSE_CAPS.transportNote)).max(6),
  }),
  beforeYouGo: z.array(prose(DRAFT_SOFT_PROSE_CAPS.beforeYouGo)).max(10),
  packing: z.array(prose(DRAFT_SOFT_PROSE_CAPS.packing)).max(15),
  backups: z
    .array(
      z.object({
        trigger: prose(DRAFT_SOFT_PROSE_CAPS.backupTrigger),
        alternative: prose(DRAFT_SOFT_PROSE_CAPS.backupAlternative),
        /**
         * §25 — the day this backup is for.
         *
         * Before this, backups were a trip-level list and `reconcile.ts`
         * guessed which days each one applied to by matching words. That is how
         * a lake-closure fallback ended up attached to a day nowhere near the
         * lake, and a fallback for an island day ended up on the departure
         * morning. A backup that names its own day can be checked: the
         * alternative has to be reachable from where the traveller sleeps that
         * night, and the trigger has to be something that day is exposed to.
         */
        day: z.number().int().min(1).max(40).optional(),
      }),
    )
    .max(6),
});
export type DraftPackage = z.infer<typeof draftPackageSchema>;

export const tripDraftSchema = z.object({
  archetype: z.enum(TRIP_ARCHETYPES),
  purpose: prose(DRAFT_SOFT_PROSE_CAPS.purpose),
  routeRationale: prose(DRAFT_SOFT_PROSE_CAPS.routeRationale),
  /**
   * MVP V3, Stage 30 — WHEN, answered.
   *
   * What this season means for this trip: what it opens, what it closes, what it
   * makes worth doing at a particular hour. Load-bearing now that Sidequest can
   * *choose* the dates ("tell me when it is best"): a traveller handed a window
   * is owed the reason it is the window, in the plan rather than only on the
   * screen that proposed it. Optional so a draft written before this field still
   * parses.
   */
  timingRationale: prose(DRAFT_SOFT_PROSE_CAPS.routeRationale).optional(),
  assumptions: z.array(prose(DRAFT_SOFT_PROSE_CAPS.assumption)).max(5),
  tradeoffs: z.array(prose(DRAFT_SOFT_PROSE_CAPS.tradeoff)).max(5),
  /*
   * No `min(1)` here: structured outputs accept no array constraints, and a
   * `minItems` on the wire made the provider refuse grammar mode (400) and
   * the transport fall back to prompt-enforced JSON. "At least one base and
   * one day" is checked by `draftStructureIssues` instead.
   */
  bases: z.array(draftBaseSchema).max(8),
  days: z.array(draftDaySchema).max(40),
  /** Destination-defining experiences weighed and left out, by name — never silently. */
  omissions: z.array(z.object({ name: prose(60), reason: prose(DRAFT_SOFT_PROSE_CAPS.omissionReason) })).max(8),
  unresolved: z.array(prose(DRAFT_SOFT_PROSE_CAPS.unresolvedItem)).max(8),
  /** What to book first and why, in the order it matters — lodges, internal flights, timed tickets. Optional for older drafts. */
  bookingPriorities: z.array(prose(DRAFT_SOFT_PROSE_CAPS.bookingPriority)).max(8).optional(),
  /**
   * §5 and §6 — the window the model chose, when the traveller asked it to.
   *
   * Present only for a trip whose timing was still open at composition time.
   * The dates are chosen together with the route and the experiences, because
   * the strongest month depends on which trip this is: a high-country traverse
   * and a food-and-neighbourhood trip in the same country do not share one.
   * Absent for a trip with fixed dates, which is the common case.
   */
  window: z.object({ startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).optional(),
  /**
   * §9 — the one to three experiences that make this destination worth
   * travelling to for THIS traveller, by name.
   *
   * Not decoration: this is the field that stops a trip becoming three
   * attractions a day. The audit checks that every name here appears in the
   * days, that the trip gives them the time they need — a single exceptional
   * traverse may deserve three days — and that a trip with no signature at all
   * is visible as the generic checklist it is.
   */
  signatures: z.array(prose(60)).max(3).optional(),
  /**
   * V10 §11 — ONE MEANINGFUL ROUTE ALTERNATIVE, IN A SENTENCE.
   *
   * Not a second itinerary — §11 is explicit that asking for several full plans
   * is the wrong shape and the wrong cost. What is asked for is the *decision*:
   * the other route this destination plausibly supports for this traveller, and
   * why this one was chosen over it. A trip that spends nine days on Iceland's
   * south and west instead of driving the whole Ring Road needs a defensible
   * reason, and this is where the reason lives.
   */
  routeAlternative: prose(DRAFT_SOFT_PROSE_CAPS.routeRationale).optional(),
  /** §14 — how the road travel is arranged. `none` for a trip with no vehicle the traveller is responsible for. */
  driving: z.enum(DRAFT_DRIVING_ARRANGEMENTS).optional(),
  /** V7 §8 — the multi-day experiences this trip contains, each owning its days and its transport regime. */
  episodes: z.array(draftEpisodeSchema).max(6).optional(),
  package: draftPackageSchema,
});
export type TripDraft = z.infer<typeof tripDraftSchema>;

/** Words that say what kind of episode a `partOf` name is, when the draft declared none. Generic words, never a place. */
const EPISODE_KIND_WORDS: readonly [RegExp, EpisodeKind][] = [
  [/\b(cruise|river boat|riverboat|liveaboard)\b/i, 'cruise'],
  [/\b(safari|game drive|game-drive|bush)\b/i, 'safari'],
  [/\b(sleeper|night train|overnight train)\b/i, 'sleeper_train'],
  [/\b(hut[- ]to[- ]hut|refuge to refuge)\b/i, 'hut_to_hut'],
  [/\b(trek|trekking|traverse|circuit walk|hike|hiking|pilgrimage|camino)\b/i, 'trek'],
  [/\b(expedition|zodiac|sailing|sail)\b/i, 'expedition_boat'],
  [/\b(overland|4x4 tour|jeep tour|convoy)\b/i, 'guided_overland'],
  [/\b(bike|cycling|cycle tour)\b/i, 'bike_tour'],
  [/\b(resort|all[- ]inclusive)\b/i, 'resort_stay'],
  [/\b(road trip|drive|driving loop)\b/i, 'road_trip_segment'],
];

/**
 * THE EPISODES A DRAFT HOLDS — DECLARED, OR READ FROM ITS OWN DAYS.
 *
 * A draft written before the episode field existed (or by a model that wrote
 * `partOf` and nothing more) still names the experience on each day and, for
 * a cruise, sleeps on a boat. Reading those words back is not inference about
 * a place; it is reading the model's own declaration of the day's shape. Only
 * an explicit word sets a kind; a `partOf` nothing matches stays a named run
 * with no regime, exactly as before.
 */
export function episodesOf(draft: Pick<TripDraft, 'days' | 'bases'> & { episodes?: readonly DraftEpisode[] | undefined }): DraftEpisode[] {
  if (draft.episodes && draft.episodes.length > 0) return draft.episodes.map((e) => ({ ...e }));
  const runs = multiDayExperiences(draft.days);
  const episodes: DraftEpisode[] = [];
  for (const run of runs) {
    const declared = EPISODE_KIND_WORDS.find(([re]) => re.test(run.name));
    const baseIds = new Set(draft.days.filter((d) => run.dayNumbers.includes(d.dayNumber)).map((d) => d.baseId));
    const overnights = draft.bases.filter((b) => baseIds.has(b.id)).map((b) => b.overnight);
    const kind: EpisodeKind | null = declared?.[1] ?? (overnights.includes('boat') ? 'cruise' : overnights.includes('train') ? 'sleeper_train' : overnights.includes('hut') || overnights.includes('refuge') ? 'hut_to_hut' : null);
    if (!kind) continue;
    episodes.push({ name: run.name, kind, fromDay: run.dayNumbers[0]!, toDay: run.dayNumbers[run.dayNumbers.length - 1]!, mode: EPISODE_DEFAULT_MODE[kind], timing: kind === 'road_trip_segment' ? 'self' : 'operator' });
  }
  /*
   * A SAFARI THE DRAFT DID NOT NAME AS ONE.
   *
   * Two or more nights at a camp or lodge whose days go back to the same
   * reserve is a safari, whatever the draft called it: the drives are the
   * lodge's vehicles on the lodge's timetable, the reserve appears every day
   * on purpose, and nothing about it is a walk from a hotel. The live Kenya
   * build drew four game-drive days as walks and flagged the reserve as a
   * repeated stop.
   */
  const covered = new Set(episodes.flatMap((e) => Array.from({ length: e.toDay - e.fromDay + 1 }, (_, i) => e.fromDay + i)));
  for (const base of draft.bases) {
    const stayed = draft.days.filter((d) => d.baseId === base.id && !covered.has(d.dayNumber)).map((d) => d.dayNumber).sort((a, b) => a - b);
    if (stayed.length < 2) continue;
    const campLike = base.overnight === 'camp' || /\b(camp|tented|safari|lodge)\b/i.test(`${base.name} ${base.lodgingStyle ?? ''}`);
    if (!campLike) continue;
    const days = draft.days.filter((d) => stayed.includes(d.dayNumber));
    const wildlifeDays = days.filter((d) => d.anchors.some((a) => a.category === 'wildlife' || /\b(game drive|reserve|national park|conservancy)\b/i.test(a.name)));
    if (wildlifeDays.length < 2) continue;
    const consecutive = stayed.every((n, i) => i === 0 || n === stayed[i - 1]! + 1);
    if (!consecutive) continue;
    episodes.push({ name: `${base.name} safari`, kind: 'safari', fromDay: stayed[0]!, toDay: stayed[stayed.length - 1]!, mode: 'four_wheel_drive', timing: 'operator' });
  }
  return episodes.sort((a, b) => a.fromDay - b.fromDay);
}

/** The episode a day belongs to, if any. */
export function episodeForDay(episodes: readonly DraftEpisode[], dayNumber: number): DraftEpisode | null {
  return episodes.find((e) => dayNumber >= e.fromDay && dayNumber <= e.toDay) ?? null;
}

/** True when the movement inside this episode is something a road router must never be asked about. */
export function episodeIsOffRoad(episode: DraftEpisode | null): boolean {
  return episode !== null && (episode.mode === 'boat' || episode.mode === 'walk' || episode.mode === 'rail' || episode.mode === 'horse' || episode.mode === 'none');
}

/** Stable within one draft and independent of provider identity. */
export function draftAnchorId(dayNumber: number, anchorIndex: number, name: string): string {
  const slugPart = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  return `d${dayNumber}-a${anchorIndex}-${slugPart || 'anchor'}`;
}

/**
 * Cosmetic-only rescue before strict validation — the same hard/soft split
 * `normalizeTripSkeleton` drew: enums, slugs, names, numbers and array
 * lengths are hard; free explanatory prose is trimmed and clipped to its cap
 * when the trimmed text already passes `SAFE_PROSE_PATTERN`. Nothing is ever
 * dropped from an array here — dropping an entry is a content decision.
 */
export function normalizeTripDraft(raw: unknown): { value: unknown; normalizedFields: readonly string[] } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { value: raw, normalizedFields: [] };
  const touched: string[] = [];
  const clip = (path: string, value: unknown, max: number): unknown => {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    if (trimmed.length <= max) {
      if (trimmed !== value) touched.push(`${path} (trim)`);
      return trimmed;
    }
    if (!SAFE_PROSE_PATTERN.test(trimmed)) return value;
    touched.push(`${path} (clip)`);
    return trimmed.slice(0, max);
  };
  const clipArray = (path: string, value: unknown, max: number): unknown =>
    Array.isArray(value) ? value.map((item, i) => clip(`${path}[${i}]`, item, max)) : value;
  const record = (value: unknown): Record<string, unknown> | null =>
    value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

  const root: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  root.purpose = clip('purpose', root.purpose, DRAFT_SOFT_PROSE_CAPS.purpose);
  root.routeRationale = clip('routeRationale', root.routeRationale, DRAFT_SOFT_PROSE_CAPS.routeRationale);
  root.assumptions = clipArray('assumptions', root.assumptions, DRAFT_SOFT_PROSE_CAPS.assumption);
  root.tradeoffs = clipArray('tradeoffs', root.tradeoffs, DRAFT_SOFT_PROSE_CAPS.tradeoff);
  root.unresolved = clipArray('unresolved', root.unresolved, DRAFT_SOFT_PROSE_CAPS.unresolvedItem);
  root.bookingPriorities = clipArray('bookingPriorities', root.bookingPriorities, DRAFT_SOFT_PROSE_CAPS.bookingPriority);

  if (Array.isArray(root.bases)) {
    root.bases = root.bases.map((entry, i) => {
      const base = record(entry);
      if (!base) return entry;
      return {
        ...base,
        why: clip(`bases[${i}].why`, base.why, DRAFT_SOFT_PROSE_CAPS.baseWhy),
        lodgingArea: clip(`bases[${i}].lodgingArea`, base.lodgingArea, DRAFT_SOFT_PROSE_CAPS.lodgingArea),
        lodgingStyle: clip(`bases[${i}].lodgingStyle`, base.lodgingStyle, DRAFT_SOFT_PROSE_CAPS.lodgingStyle),
      };
    });
  }
  if (Array.isArray(root.omissions)) {
    root.omissions = root.omissions.map((entry, i) => {
      const omission = record(entry);
      if (!omission) return entry;
      return { ...omission, reason: clip(`omissions[${i}].reason`, omission.reason, DRAFT_SOFT_PROSE_CAPS.omissionReason) };
    });
  }
  if (Array.isArray(root.days)) {
    root.days = root.days.map((entry, d) => {
      const day = record(entry);
      if (!day) return entry;
      const out: Record<string, unknown> = {
        ...day,
        theme: clip(`days[${d}].theme`, day.theme, DRAFT_SOFT_PROSE_CAPS.dayTheme),
        note: clip(`days[${d}].note`, day.note, DRAFT_SOFT_PROSE_CAPS.dayNote),
        whyItFits: clip(`days[${d}].whyItFits`, day.whyItFits, DRAFT_SOFT_PROSE_CAPS.whyItFits),
      };
      const meals = record(day.meals);
      if (meals) {
        out.meals = {
          ...meals,
          breakfast: clip(`days[${d}].meals.breakfast`, meals.breakfast, DRAFT_SOFT_PROSE_CAPS.meal),
          lunch: clip(`days[${d}].meals.lunch`, meals.lunch, DRAFT_SOFT_PROSE_CAPS.meal),
          dinner: clip(`days[${d}].meals.dinner`, meals.dinner, DRAFT_SOFT_PROSE_CAPS.meal),
        };
      }
      if (Array.isArray(day.anchors)) {
        out.anchors = day.anchors.map((anchorEntry, a) => {
          const anchor = record(anchorEntry);
          if (!anchor) return anchorEntry;
          return { ...anchor, why: clip(`days[${d}].anchors[${a}].why`, anchor.why, DRAFT_SOFT_PROSE_CAPS.anchorWhy) };
        });
      }
      return out;
    });
  }
  const pkg = record(root.package);
  if (pkg) {
    const transport = record(pkg.transport);
    root.package = {
      ...pkg,
      foodStrategy: clipArray('package.foodStrategy', pkg.foodStrategy, DRAFT_SOFT_PROSE_CAPS.foodStrategy),
      ...(transport
        ? {
            transport: {
              ...transport,
              summary: clip('package.transport.summary', transport.summary, DRAFT_SOFT_PROSE_CAPS.transportSummary),
              notes: clipArray('package.transport.notes', transport.notes, DRAFT_SOFT_PROSE_CAPS.transportNote),
            },
          }
        : {}),
      beforeYouGo: clipArray('package.beforeYouGo', pkg.beforeYouGo, DRAFT_SOFT_PROSE_CAPS.beforeYouGo),
      packing: clipArray('package.packing', pkg.packing, DRAFT_SOFT_PROSE_CAPS.packing),
      backups: Array.isArray(pkg.backups)
        ? pkg.backups.map((entry, i) => {
            const backup = record(entry);
            if (!backup) return entry;
            return {
              ...backup,
              trigger: clip(`package.backups[${i}].trigger`, backup.trigger, DRAFT_SOFT_PROSE_CAPS.backupTrigger),
              alternative: clip(`package.backups[${i}].alternative`, backup.alternative, DRAFT_SOFT_PROSE_CAPS.backupAlternative),
            };
          })
        : pkg.backups,
    };
  }
  // Strip `undefined` produced by clipping absent optionals, so the shape the
  // schema sees is the shape the model sent.
  return { value: JSON.parse(JSON.stringify(root)), normalizedFields: touched };
}

/** Sanity checks the schema cannot express: every day names a base that exists, day numbers are 1..N in order, nights sum sanity is left to the reconciler. */
export function draftStructureIssues(draft: TripDraft): string[] {
  const issues: string[] = [];
  if (draft.bases.length === 0) issues.push('the draft names no base');
  if (draft.days.length === 0) issues.push('the draft has no days');
  const baseIds = new Set(draft.bases.map((b) => b.id));
  draft.days.forEach((day, i) => {
    if (day.dayNumber !== i + 1) issues.push(`days[${i}] is numbered ${day.dayNumber}, expected ${i + 1}`);
    if (!baseIds.has(day.baseId)) issues.push(`day ${day.dayNumber} names base "${day.baseId}" which the draft does not define`);
  });
  for (const episode of draft.episodes ?? []) {
    if (episode.toDay < episode.fromDay) issues.push(`episode "${episode.name}" ends on day ${episode.toDay} before it starts on day ${episode.fromDay}`);
    if (episode.toDay > draft.days.length) issues.push(`episode "${episode.name}" runs to day ${episode.toDay} but the trip has ${draft.days.length} days`);
  }
  return issues;
}
