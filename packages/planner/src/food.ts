import {
  assessDietary,
  earliestMealStart,
  needsExplicitEvidence,
  PRICE_BAND_ORDER,
  venueCanProvision,
  venueHoursOn,
  venueServes,
  windowContaining,
  type DietaryClaim,
  type DietaryNeed,
  type FoodAlternative,
  type FoodDataset,
  type FoodRouteContext,
  type FoodSelection,
  type FoodVenue,
  type MealSlot,
  type ScheduledFood,
  type ScheduledFoodHours,
  type TravelerProfile,
  type VenueDayHours,
} from '@sidequest/core';
import { tryLeg, type TravelTimeMatrix } from '@sidequest/geo';
import type { PlannerConfig, PlanningCandidate } from './types';
import type { PlannedDay } from './windows';

/**
 * WHERE THE TRAVELLER EATS, DECIDED FROM THE DAY THEY ARE ACTUALLY HAVING.
 *
 * The thing that makes this different from the four layers before it: access,
 * opening hours, weather and daylight are all properties of a *place and a
 * date*, and can be resolved before a single stop is ordered. Where to eat
 * depends on the order the day was laid out in — on where the traveller is at
 * half twelve and where they are going next — which does not exist until the
 * layout has run.
 *
 * So this file is in two halves.
 *
 *   `resolveFood` runs *before* layout, over the settled day-to-stops
 *   assignment. It works out what each day needs (does it want a breakfast at
 *   all? is it remote enough that lunch has to be carried? may it hold the
 *   trip's one special meal?) and produces a ranked shortlist per slot. Nothing
 *   in it depends on stop order, and cross-day concerns — repetition, the
 *   special-meal quota, which day buys the supplies — are settled here, in day
 *   order, once.
 *
 *   `chooseFoodStop` runs *during* layout, at the moment the clock reaches a
 *   meal. It walks that day's shortlist and returns the first venue that is
 *   genuinely legal against the real position, the real minute and the real
 *   detour. It holds no state, so the packer may call it a hundred times while
 *   trying candidate orders and get the same answer every time.
 *
 * That split is what keeps the whole thing deterministic while still letting a
 * café be chosen because of where the traveller happened to be standing.
 */

// ---------------------------------------------------------------------------
// The one place the meal clock lives
// ---------------------------------------------------------------------------

/**
 * How long a day may run before having nothing to eat on it is worth saying.
 *
 * A product rule, deliberately generous, and phrased as one: the validator says
 * "this day runs nine hours with nothing to eat on it", not anything about what
 * that does to a person. Nine hours is roughly a dawn start to mid-afternoon,
 * which is the point at which a plan has stopped being helpful.
 */
export const LONG_DAY_WITHOUT_FOOD_MINUTES = 9 * 60;

/**
 * How far off the route a meal may pull the day.
 *
 * Deliberately *not* the traveller's own detour tolerance. That number answers
 * "would you drive an hour to see a lake?", and the answer to that has nothing
 * to do with lunch. Read as a food ceiling it produced a day that drove
 * twenty-six minutes north from a canyon to eat, then forty-six minutes back
 * south to the town it had been heading for — forty-two minutes of extra
 * driving for a sandwich, inside a stated tolerance of seventy-five.
 *
 * The special-meal ceiling is higher because that meal is the point of the
 * evening rather than a stop on the way to something else. It is still a
 * ceiling, and the traveller's own tolerance still caps it.
 */
export const MAX_FOOD_DETOUR_MINUTES = 20;
export const MAX_SPECIAL_MEAL_DETOUR_MINUTES = 35;

/**
 * The granularity at which two detours are the same detour.
 *
 * The corridor model rounds to whole minutes off an authored topology; treating
 * a two-minute difference in it as a real preference is reading precision into
 * a number that does not have any.
 */
export const DETOUR_BAND_MINUTES = 5;

/** Minutes at a shop, before the walk in from wherever the car is. */
export const PROVISIONING_MINUTES = 20;

/** What a packed meal takes, sitting on a rock. */
export const PACKED_MEAL_MINUTES = 30;

/**
 * A walk is roughly four times a drive over the same short distance in a
 * mountain town. Used only for a traveller with no car, only over the first few
 * minutes of the corridor model, and labelled `estimated` wherever it surfaces —
 * it is a conversion, not a measurement.
 */
const WALK_MINUTES_PER_DRIVE_MINUTE = 4;

/** Beyond this many drive-minutes from base, a car-free traveller cannot reach it. */
const CAR_FREE_REACH_DRIVE_MINUTES = 3;

// ---------------------------------------------------------------------------
// Pre-layout: what does each day need, and from what may it choose?
// ---------------------------------------------------------------------------

export interface DaySlotPlan {
  slot: MealSlot;
  /** Ranked venue ids to try, best first. Empty is a real answer. */
  shortlist: readonly string[];
  /** When no venue works: carry food, or leave the block bare. */
  fallback: 'packed' | 'unplanned';
  /** This is the trip's special meal, if a venue that qualifies takes it. */
  isSpecial: boolean;
}

export interface FoodDayPlan {
  dayNumber: number;
  date: string;
  slots: readonly DaySlotPlan[];
  /** Venue hours resolved against this date, by venue id. */
  hours: ReadonlyMap<string, VenueDayHours>;
  /** Nothing verified sits near this day's stops. */
  remote: boolean;
  /** The agency's own words about there being no food out there, when we have them. */
  gapNote: string | null;
  /** Buy supplies today, for this day number. Null when there is nothing to buy. */
  provisionForDay: number | null;
  /** This day eats supplies bought on that day. */
  provisionedOnDay: number | null;
  /** Ranked provisioning venues for the stop above. */
  provisioningShortlist: readonly string[];
  /** Venues the traveller asked for on the board. Never silently overruled. */
  userChosen: ReadonlySet<string>;
  /**
   * Venues an earlier day already has its eye on.
   *
   * The ranking penalises repetition heavily, but the layout re-ranks by the
   * real detour and can overturn it — so the same cafe took breakfast on two
   * consecutive mornings while a second one two minutes further sat unused.
   * Fixed before any layout runs, so consulting it costs nothing in
   * determinism.
   */
  discouraged: ReadonlySet<string>;
}

export interface FoodContext {
  dataset: FoodDataset;
  profile: TravelerProfile;
  byDay: ReadonlyMap<number, FoodDayPlan>;
  /** Venues the traveller asked for, in a stable order. */
  userChosen: readonly string[];
  /**
   * Why a chosen venue could not be worked in.
   *
   * A function rather than a precomputed list, because whether a choice made it
   * is a fact about the *finished timeline* and this runs before any layout. The
   * list itself is derived in `buildFoodPlan`, where the days are real — the
   * earlier version guessed from the shortlist and got it wrong in both
   * directions, reporting a venue that had been scheduled and staying silent
   * about one that had not.
   */
  reasonForUnused(venueId: string): string;
  specialMealBudget: number;
}

export interface ResolveFoodInput {
  dataset: FoodDataset;
  profile: TravelerProfile;
  selections: readonly FoodSelection[];
  days: readonly { day: PlannedDay; candidates: readonly PlanningCandidate[] }[];
  matrix: TravelTimeMatrix;
  baseId: string;
  /** The one meal clock, so nothing here re-declares an hour. */
  windows: PlannerConfig['mealWindows'];
}

export function resolveFood(input: ResolveFoodInput): FoodContext {
  const { dataset, profile, matrix, baseId } = input;
  const wanted = new Set(
    input.selections.filter((entry) => entry.status === 'included').map((entry) => entry.venueId),
  );
  const refused = new Set(
    input.selections.filter((entry) => entry.status === 'excluded').map((entry) => entry.venueId),
  );

  const usable = dataset.venues.filter((venue) => !refused.has(venue.id));
  const byDay = new Map<number, FoodDayPlan>();

  /**
   * Cross-day state, settled here in day order and nowhere else.
   *
   * The packer re-lays a day out many times while deciding what fits, so
   * anything that remembers what an earlier attempt chose would make the plan
   * depend on how many attempts it took. Repetition and the special-meal quota
   * are therefore decided from the *assignment*, before any layout runs, and
   * `chooseFoodStop` is left with no memory at all.
   */
  const usedVenues = new Set<string>();
  let specialsLeft = profile.food.specialMealBudget;

  const ordered = [...input.days].sort((a, b) => a.day.dayNumber - b.day.dayNumber);

  // Which days cannot feed themselves, worked out first so the day before one
  // knows it has shopping to do.
  const remoteByDay = new Map<number, { remote: boolean; gapNote: string | null }>();
  for (const entry of ordered) {
    remoteByDay.set(entry.day.dayNumber, assessRemoteness(entry.candidates, dataset));
  }

  for (const entry of ordered) {
    const { day, candidates } = entry;
    const hours = new Map<string, VenueDayHours>();
    for (const venue of usable) hours.set(venue.id, venueHoursOn(venue, day.date));

    const remote = remoteByDay.get(day.dayNumber)?.remote ?? false;
    const gapNote = remoteByDay.get(day.dayNumber)?.gapNote ?? null;
    const nodes = routingNodesFor(candidates, baseId);

    const discouraged = new Set(usedVenues);
    const slots: DaySlotPlan[] = [];
    for (const slot of slotsForDay(day, candidates, profile, input.windows)) {
      const isSpecial =
        slot === 'dinner' &&
        specialsLeft > 0 &&
        !day.isEdgeDay &&
        profile.food.specialMealBudget > 0;

      const shortlist = rankVenues({
        slot,
        venues: usable,
        hours,
        profile,
        matrix,
        nodes,
        baseId,
        wanted,
        usedVenues,
        allowSpecial: isSpecial,
      });

      const tookSpecial = isSpecial && shortlist.some((id) => isSpecialGrade(usable, id));
      if (tookSpecial) specialsLeft -= 1;

      // Only the head of the list is treated as spoken for. Reserving the whole
      // shortlist would leave later days with nothing when the region has three
      // dinner options and the trip has four nights.
      const head = shortlist[0];
      if (head !== undefined) usedVenues.add(head);

      slots.push({
        slot,
        shortlist,
        fallback:
          slot === 'lunch' && remote && profile.food.willPackLunch ? 'packed' : 'unplanned',
        isSpecial: tookSpecial,
      });
    }

    byDay.set(day.dayNumber, {
      dayNumber: day.dayNumber,
      date: day.date,
      slots,
      hours,
      remote,
      gapNote,
      provisionForDay: null,
      provisionedOnDay: null,
      provisioningShortlist: [],
      userChosen: wanted,
      discouraged,
    });
  }

  attachProvisioning(byDay, ordered, usable, profile, matrix, baseId, input.windows);

  return {
    dataset,
    profile,
    byDay,
    userChosen: [...wanted].sort(),
    reasonForUnused: (venueId: string) => {
      const venue = dataset.venues.find((entry) => entry.id === venueId);
      return venue
        ? unusedChoiceReason(venue, byDay)
        : 'That venue is no longer in our food data for this region.';
    },
    specialMealBudget: profile.food.specialMealBudget,
  };
}

/**
 * Which meals this day actually asks for.
 *
 * Not three, every day. An arrival day that starts at noon has no breakfast to
 * miss; a departure day that ends at five has no dinner; a traveller who told
 * us they skip breakfast gets one only when the day is long and early enough
 * that setting off with nothing is a logistics problem rather than a preference.
 */
function slotsForDay(
  day: PlannedDay,
  candidates: readonly PlanningCandidate[],
  profile: TravelerProfile,
  windows: PlannerConfig['mealWindows'],
): MealSlot[] {
  const slots: MealSlot[] = [];
  const start = day.window.startMinute;
  const end = day.window.endMinute;

  const earlyStart = start <= windows.breakfast.latest;
  const longDay = day.window.usableMinutes >= 6 * 60;
  const wantsBreakfast = profile.food.wantsBreakfastVenue;
  const outdoorMorning = candidates.some(
    (candidate) =>
      candidate.place.physicalIntensity === 'moderate' ||
      candidate.place.physicalIntensity === 'strenuous',
  );

  // A breakfast skipper still gets offered fuel when the day is long, early and
  // physical — but the copy that goes with it never calls it the breakfast they
  // told us not to book.
  if (earlyStart && (wantsBreakfast || (longDay && outdoorMorning))) {
    slots.push('breakfast');
  }
  if (
    day.window.usableMinutes >= 5 * 60 &&
    start <= windows.lunch.latest &&
    end >= windows.lunch.earliest
  ) {
    slots.push('lunch');
  }
  if (end >= windows.dinner.earliest + 45) slots.push('dinner');
  return slots;
}

/** Every routing node this day is likely to pass, base included. */
function routingNodesFor(
  candidates: readonly PlanningCandidate[],
  baseId: string,
): readonly string[] {
  return [baseId, ...candidates.map((candidate) => candidate.place.id)];
}

/**
 * The distance from a set of route anchors to a venue, in the model's minutes.
 *
 * The *smallest* hop, not the average: a venue is on the way if it is near any
 * point of the day, and averaging would rule out the café beside the trailhead
 * because the day also went to Bishop.
 */
function nearestNodeMinutes(
  matrix: TravelTimeMatrix,
  nodes: readonly string[],
  routingId: string,
): number | null {
  let best: number | null = null;
  for (const node of nodes) {
    const hop = node === routingId ? { minutes: 0, km: 0 } : tryLeg(matrix, node, routingId);
    if (!hop) continue;
    if (best === null || hop.minutes < best) best = hop.minutes;
  }
  return best;
}

function isSpecialGrade(venues: readonly FoodVenue[], venueId: string): boolean {
  const venue = venues.find((entry) => entry.id === venueId);
  return venue !== undefined && PRICE_BAND_ORDER[venue.priceBand] >= PRICE_BAND_ORDER.upscale;
}

interface RankInput {
  slot: MealSlot;
  venues: readonly FoodVenue[];
  hours: ReadonlyMap<string, VenueDayHours>;
  profile: TravelerProfile;
  matrix: TravelTimeMatrix;
  nodes: readonly string[];
  baseId: string;
  wanted: ReadonlySet<string>;
  usedVenues: ReadonlySet<string>;
  allowSpecial: boolean;
}

/**
 * The one place a food candidate is judged.
 *
 * Everything here is a *preference*: the hard gates — is it open at that minute,
 * does the detour break the next stop, can the traveller get there without a car
 * — are applied at layout time against the real clock, because that is the only
 * place they can be answered honestly. What this produces is an order to try
 * them in.
 *
 * The precedence the order encodes, strongest first: a requirement the venue
 * says it cannot meet removes it outright; a requirement nobody has confirmed
 * costs it heavily when the traveller called it strict; the traveller's own
 * pick from the board outranks everything else that is legal; then budget, then
 * fit, then route efficiency, then variety.
 */
function rankVenues(input: RankInput): string[] {
  const { slot, venues, hours, profile, matrix, nodes, wanted, usedVenues, allowSpecial } = input;
  const needs = profile.food.dietaryNeeds;
  const everyday = PRICE_BAND_ORDER[profile.food.everydayPriceBand];

  const scored: { id: string; score: number; detour: number }[] = [];

  for (const venue of venues) {
    if (!venueServes(venue, slot)) continue;
    const dayHours = hours.get(venue.id);
    // A restaurant whose hours nobody has confirmed is a coin toss at the door.
    // Unlike a roadside viewpoint, there is nothing to salvage from being wrong.
    if (!dayHours || dayHours.status === 'unknown' || dayHours.status === 'closed') continue;

    const dietary = assessDietary(venue, needs);
    if (dietary.blocked.length > 0) continue;

    const detour = nearestNodeMinutes(matrix, nodes, venue.routingId);
    if (detour === null) continue;
    /**
     * Nowhere near anywhere this day goes. Not a judgement about the venue.
     *
     * Generous on purpose: this is measured against the *geographic* day
     * assignment, which the packer then trims, so a venue beside a stop that
     * survives must not be cut here because a stop that did not survive was
     * nearer. The real ceiling is applied at layout time against the real
     * position, where it can be answered honestly.
     */
    if (detour > MAX_SPECIAL_MEAL_DETOUR_MINUTES + 20) continue;

    const band = PRICE_BAND_ORDER[venue.priceBand];
    // The budget rule, and the reason liking fine dining does not produce four
    // fine dinners: above the everyday band is only reachable on a slot the
    // special-meal quota has actually opened.
    if (band > everyday && !allowSpecial) continue;

    let score = 0;
    if (wanted.has(venue.id)) score += 1000;
    for (const need of dietary.unverified) {
      score -= needsExplicitEvidence(need, profile.food.dietaryStrict) ? 260 : 40;
    }
    score += dietary.supported.length * 60;
    // A slot the special-meal quota has opened wants something that is actually
    // an occasion. Weighted above everything except a venue the traveller asked
    // for by name, so the one evening they said should be different is not lost
    // to a taqueria two minutes nearer.
    if (allowSpecial && band >= PRICE_BAND_ORDER.upscale) score += 500;
    if (!allowSpecial && band === everyday) score += 30;
    if (!allowSpecial && band < everyday) score += 10;
    if (venue.localSpecialty) score += 45;
    if (usedVenues.has(venue.id)) score -= 400;
    if (venue.hours.hoursConfidence !== 'published') score -= 25;
    if (venue.reservation.requirement === 'required') score -= 60;
    score -= detour * 2;
    score += Math.round(venue.source.confidence * 20);

    scored.push({ id: venue.id, score, detour });
  }

  return scored
    .sort((a, b) => b.score - a.score || a.detour - b.detour || a.id.localeCompare(b.id))
    .slice(0, 6)
    .map((entry) => entry.id);
}

/**
 * Whether a day can feed itself at all.
 *
 * Only a source gets to answer this. The National Park Service stating that
 * there are no restaurants or concession facilities inside the monument, and
 * advising visitors to pack a lunch before entering the valley, is a fact about
 * the world; it is the thing that justifies telling somebody to go shopping
 * first thing on a morning they would rather not.
 *
 * A geometric test was tried here and thrown away. "No verified venue within
 * twenty minutes of any of this day's stops" reads as the same claim and is not:
 * it is a claim about our own index, it fires on a canyon whose *route back*
 * passes three restaurants, and on the standard four-day trip it turned a day
 * with a perfectly good two-minute lunch detour into a packed lunch. The
 * question the planner actually needs answered is "is there a legal venue on
 * this route?", and that has an exact answer at layout time — where it is asked.
 */
function assessRemoteness(
  candidates: readonly PlanningCandidate[],
  dataset: FoodDataset,
): { remote: boolean; gapNote: string | null } {
  if (candidates.length === 0) return { remote: false, gapNote: null };
  const gap = dataset.gaps.find((entry) =>
    candidates.some((candidate) => entry.placeIds.includes(candidate.place.id)),
  );
  return { remote: gap !== undefined, gapNote: gap?.note ?? null };
}

/**
 * Who buys the food, and when.
 *
 * The invariant this exists to keep: supplies are bought *before* the day that
 * needs them. A remote day shops for itself first thing when something is open
 * early enough — which in this region usually means the 24-hour supermarket a
 * minute from base — and otherwise the evening before does it. A grocery stop
 * scheduled after the walk it was meant to feed is worse than no grocery stop,
 * because the traveller is then carrying a plan that reads as solved.
 */
function attachProvisioning(
  byDay: Map<number, FoodDayPlan>,
  ordered: readonly { day: PlannedDay; candidates: readonly PlanningCandidate[] }[],
  venues: readonly FoodVenue[],
  profile: TravelerProfile,
  matrix: TravelTimeMatrix,
  baseId: string,
  windows: PlannerConfig['mealWindows'],
): void {
  if (!profile.food.willPackLunch) return;
  const shops = venues.filter(venueCanProvision);
  if (shops.length === 0) return;

  for (const entry of ordered) {
    const plan = byDay.get(entry.day.dayNumber);
    if (!plan || !plan.remote) continue;
    if (!plan.slots.some((slot) => slot.slot === 'lunch' && slot.fallback === 'packed')) continue;

    const openEarly = rankProvisioning(shops, plan, entry.day.window.startMinute, matrix, baseId);
    if (openEarly.length > 0) {
      byDay.set(entry.day.dayNumber, {
        ...plan,
        provisionForDay: entry.day.dayNumber,
        provisionedOnDay: entry.day.dayNumber,
        provisioningShortlist: openEarly,
      });
      continue;
    }

    // Nothing is open early enough. Shop the evening before, if there is one.
    const previous = byDay.get(entry.day.dayNumber - 1);
    if (!previous) continue;
    const evening = rankProvisioning(shops, previous, windows.dinner.earliest, matrix, baseId);
    if (evening.length === 0) continue;
    byDay.set(entry.day.dayNumber - 1, {
      ...previous,
      provisionForDay: entry.day.dayNumber,
      provisioningShortlist: evening,
    });
    byDay.set(entry.day.dayNumber, { ...plan, provisionedOnDay: entry.day.dayNumber - 1 });
  }
}

function rankProvisioning(
  shops: readonly FoodVenue[],
  plan: FoodDayPlan,
  fromMinute: number,
  matrix: TravelTimeMatrix,
  baseId: string,
): string[] {
  return shops
    .map((shop) => {
      const dayHours = plan.hours.get(shop.id);
      if (!dayHours) return null;
      const start = earliestMealStart({
        hours: dayHours,
        minutes: PROVISIONING_MINUTES,
        earliest: fromMinute,
        latest: fromMinute + 120,
      });
      if (start === null) return null;
      const hop =
        shop.routingId === baseId ? { minutes: 0, km: 0 } : tryLeg(matrix, baseId, shop.routingId);
      if (!hop) return null;
      return { id: shop.id, minutes: hop.minutes };
    })
    .filter((entry): entry is { id: string; minutes: number } => entry !== null)
    .sort((a, b) => a.minutes - b.minutes || a.id.localeCompare(b.id))
    .slice(0, 3)
    .map((entry) => entry.id);
}

function unusedChoiceReason(venue: FoodVenue, byDay: ReadonlyMap<number, FoodDayPlan>): string {
  const everOpen = [...byDay.values()].some((plan) => {
    const status = plan.hours.get(venue.id)?.status;
    return status === 'open' || status === 'always_open';
  });
  if (!everOpen) {
    const anyUnknown = [...byDay.values()].some(
      (plan) => plan.hours.get(venue.id)?.status === 'unknown',
    );
    return anyUnknown
      ? `Nobody publishes hours for ${venue.name}, and we will not build a day around a door we cannot confirm is open.`
      : `${venue.name} is shut on every day of this trip.`;
  }
  return `${venue.name} did not fit any day's route inside the detour we hold meals to.`;
}

// ---------------------------------------------------------------------------
// During layout: pick one, against the real clock and the real position
// ---------------------------------------------------------------------------

export interface FoodChoiceRequest {
  slot: MealSlot;
  plan: FoodDayPlan;
  profile: TravelerProfile;
  dataset: FoodDataset;
  matrix: TravelTimeMatrix;
  /** Where the traveller is standing. */
  fromRoutingId: string;
  /** Where they are going next. Null when the day ends here. */
  toRoutingId: string | null;
  /** The clock, now. */
  cursor: number;
  /** The last minute the meal may finish by. */
  latest: number;
  /** Whether a car is available for a detour at all. */
  canDrive: boolean;
  /**
   * True when the traveller comes back to where they set off from rather than
   * carrying on from the venue.
   *
   * It changes the number, not just the shape: there and back is twice the leg,
   * and reporting the one-way figure understated a two-minute dinner run as
   * two minutes when it cost four. The day's own driving total then disagreed
   * with the detour the plan claimed, which is the arithmetic that has emptied
   * a day one stop at a time before now.
   */
  returnsToOrigin: boolean;
  /** The one meal clock, handed in rather than re-declared here. */
  windows: PlannerConfig['mealWindows'];
}

export interface FoodChoice {
  venue: FoodVenue;
  /**
   * Minute the food block starts — the walk from where the car is parked, not
   * the moment the food arrives. The block covers the walk in, the meal and the
   * walk out, so this is what the timeline row is drawn from.
   */
  startMinute: number;
  /** Travel from `fromRoutingId` to the venue's node. Zero when already there. */
  approachMinutes: number;
  approachKm: number;
  approachMode: 'drive' | 'walk';
  /** Time at the venue: the walk in and out, plus the service itself. */
  stopMinutes: number;
  /** Over and above going straight on. The number the traveller is shown. */
  detourMinutes: number;
  /**
   * The opening time, when it is what held the meal back. Null when the venue
   * was already open and the wait was the meal window's doing — which is a
   * different sentence, and printing "time before the bakery opens" in front of
   * a bakery that opened at six is how a plan loses somebody's trust in one row.
   */
  opensAtMinute: number | null;
  routeContext: FoodRouteContext;
  food: ScheduledFood;
}

/**
 * The first venue on this day's shortlist that genuinely works from here.
 *
 * "Genuinely" is the whole function: open at this minute for long enough to eat,
 * reachable by a mode the traveller has, and not so far off the route that
 * getting there and back costs more than they said they would accept. Returns
 * null rather than a compromise — an empty meal block that says why is a better
 * output than a restaurant twenty-five minutes behind them.
 */
export function chooseFoodStop(request: FoodChoiceRequest): FoodChoice | null {
  const slotPlan = request.plan.slots.find((entry) => entry.slot === request.slot);
  if (!slotPlan) return null;

  /**
   * Every shortlisted venue is evaluated, not just the first that works.
   *
   * The shortlist was ranked before the day had an order, against the whole
   * set of stops geography put on it. By the time the clock gets here the
   * traveller is standing somewhere specific, and the venue that is genuinely
   * on the way is often not the one that looked best from the day as a whole —
   * a Bishop bakery is a nil detour from a canyon on the way to Bishop and a
   * forty-minute round trip from anywhere else. So fit decided who is in the
   * running, and the route decides which of them wins.
   */
  const legal = slotPlan.shortlist
    .map((venueId, index) => ({ index, choice: evaluate(request, venueId, slotPlan.isSpecial) }))
    .filter((entry): entry is { index: number; choice: FoodChoice } => entry.choice !== null);
  if (legal.length === 0) return null;

  // A venue the traveller asked for is never quietly passed over for a closer
  // one. If it is legal from here, it is what they get.
  const chosen = legal.find((entry) => entry.choice.food.fromUserChoice);
  if (chosen) return chosen.choice;

  /**
   * Detour in five-minute bands, then the shortlist's own order.
   *
   * Comparing raw minutes let a one-minute difference overturn everything the
   * ranking had decided — including the repetition penalty, so the same bakery
   * took lunch on two days of the same trip, and including the special-meal
   * preference, so an ordinary dinner two minutes nearer beat the one meal the
   * traveller had asked to be an event. Banding says what is actually true of a
   * modelled corridor: two and four minutes off the route are the same answer.
   */
  const band = (minutes: number) => Math.floor(minutes / DETOUR_BAND_MINUTES);
  legal.sort(
    (a, b) =>
      // On a special slot the occasion outranks the route entirely, within the
      // ceiling the ceiling already imposed.
      Number(b.choice.food.isSpecialMeal) - Number(a.choice.food.isSpecialMeal) ||
      // Somewhere new, when two options are otherwise the same answer.
      Number(request.plan.discouraged.has(a.choice.venue.id)) -
        Number(request.plan.discouraged.has(b.choice.venue.id)) ||
      band(a.choice.detourMinutes) - band(b.choice.detourMinutes) ||
      a.index - b.index,
  );
  return legal[0]!.choice;
}

/** The provisioning stop, evaluated the same way. */
export function chooseProvisioningStop(request: FoodChoiceRequest): FoodChoice | null {
  for (const venueId of request.plan.provisioningShortlist) {
    const choice = evaluate(request, venueId, false, 'grocery');
    if (choice) return choice;
  }
  return null;
}

function evaluate(
  request: FoodChoiceRequest,
  venueId: string,
  isSpecial: boolean,
  stopKind: 'venue' | 'grocery' = 'venue',
): FoodChoice | null {
  const venue = request.dataset.venues.find((entry) => entry.id === venueId);
  if (!venue) return null;
  const hours = request.plan.hours.get(venueId);
  if (!hours) return null;

  const approach = approachTo(request, venue);
  if (!approach) return null;

  const walk = venue.walkMinutesFromRouting;
  const service = stopKind === 'grocery' ? PROVISIONING_MINUTES : venue.serviceMinutes;
  const stopMinutes = walk * 2 + service;

  const window = request.windows[request.slot];
  const earliest = Math.max(
    request.cursor + approach.minutes + walk,
    stopKind === 'grocery' ? 0 : window.earliest,
  );
  const latestFinish = Math.min(
    request.latest,
    stopKind === 'grocery' ? request.latest : window.latest + service,
  );

  const start = earliestMealStart({
    hours,
    minutes: service,
    earliest,
    latest: latestFinish,
  });
  if (start === null) return null;

  // Going straight on would have cost this. Everything above it is the detour,
  // and it is what the traveller is shown — never the raw drive to the venue,
  // which on a day that was passing the door anyway is not a cost at all.
  const onward =
    request.toRoutingId === null
      ? { minutes: 0, km: 0 }
      : (hop(request.matrix, venue.routingId, request.toRoutingId) ?? null);
  if (onward === null) return null;
  const straight =
    request.toRoutingId === null
      ? { minutes: 0, km: 0 }
      : (hop(request.matrix, request.fromRoutingId, request.toRoutingId) ?? { minutes: 0, km: 0 });
  const returns = request.returnsToOrigin || !request.canDrive;
  const detour = returns
    ? approach.minutes * 2
    : Math.max(0, approach.minutes + onward.minutes - straight.minutes);
  const ceiling = Math.min(
    request.profile.derived.effectiveDetourMinutes,
    isSpecial ? MAX_SPECIAL_MEAL_DETOUR_MINUTES : MAX_FOOD_DETOUR_MINUTES,
  );
  if (stopKind !== 'grocery' && detour > ceiling) return null;

  const dietary = assessDietary(venue, request.profile.food.dietaryNeeds);
  if (dietary.blocked.length > 0) return null;

  const window0 = windowContaining(hours, start);
  const evidence = scheduledHours(venue, hours, window0);
  const opensAtMinute =
    window0 !== null && window0.openMinute > earliest ? window0.openMinute : null;

  const food: ScheduledFood = {
    slot: request.slot,
    stopKind,
    venueId: venue.id,
    venueName: venue.name,
    serviceType: venue.serviceType,
    ...(venue.cuisines.length > 0 ? { cuisineLabel: venue.cuisines.join(', ') } : {}),
    priceBand: venue.priceBand,
    priceEvidence: venue.priceEvidence,
    ...(venue.localSpecialty ? { localSpecialty: venue.localSpecialty.label } : {}),
    ...(venue.reservation.requirement === 'unknown' &&
    venue.reservation.note === undefined &&
    venue.reservation.bookingUrl === undefined
      ? {}
      : { reservation: venue.reservation }),
    dietary: dietary.supported as DietaryClaim[],
    dietaryUnverified: dietary.unverified as DietaryNeed[],
    ...(evidence ? { hours: evidence } : {}),
    routeContext: routeContextFor(request, venue, detour),
    detourMinutes: detour,
    isSpecialMeal: isSpecial && PRICE_BAND_ORDER[venue.priceBand] >= PRICE_BAND_ORDER.upscale,
    fromUserChoice: request.plan.userChosen.has(venue.id),
    alternatives: [],
  };

  return {
    venue,
    // Back off the walk in, so the block that lands on the timeline is the
    // whole stop rather than the meal with a hole in front of it. Counting the
    // walk once here and again inside `stopMinutes` was showing a one-minute
    // "time before it opens" gap in front of a cafe that had been open an hour.
    startMinute: start - walk,
    opensAtMinute,
    approachMinutes: approach.minutes,
    approachKm: approach.km,
    approachMode: approach.mode,
    stopMinutes,
    detourMinutes: detour,
    routeContext: food.routeContext,
    food,
  };
}

function hop(
  matrix: TravelTimeMatrix,
  fromId: string,
  toId: string,
): { minutes: number; km: number } | null {
  if (fromId === toId) return { minutes: 0, km: 0 };
  return tryLeg(matrix, fromId, toId);
}

/**
 * Getting there, by a mode the traveller actually has.
 *
 * A car-free traveller is not driven to a café. They walk, over a distance
 * converted from the corridor model and capped by what they said they would walk
 * — so the honest outcome for a venue four minutes' drive away is that they do
 * not get it, which is right, because in this region that is a mile of highway
 * verge.
 */
function approachTo(
  request: FoodChoiceRequest,
  venue: FoodVenue,
): { minutes: number; km: number; mode: 'drive' | 'walk' } | null {
  const leg = hop(request.matrix, request.fromRoutingId, venue.routingId);
  if (!leg) return null;
  if (request.canDrive) return { minutes: leg.minutes, km: leg.km, mode: 'drive' };

  if (leg.minutes > CAR_FREE_REACH_DRIVE_MINUTES) return null;
  const walkMinutes = leg.minutes * WALK_MINUTES_PER_DRIVE_MINUTE;
  if (walkMinutes > request.profile.transport.maxAccessWalkMinutes) return null;
  return { minutes: walkMinutes, km: 0, mode: 'walk' };
}

function routeContextFor(
  request: FoodChoiceRequest,
  venue: FoodVenue,
  detour: number,
): FoodRouteContext {
  if (venue.routingId === request.fromRoutingId) {
    return request.toRoutingId === null ? 'at_day_end' : 'on_route';
  }
  if (request.toRoutingId === null) return 'at_day_end';
  if (detour === 0) return 'on_route';
  return detour <= 10 ? 'near_route' : 'off_route';
}

function scheduledHours(
  venue: FoodVenue,
  hours: VenueDayHours,
  window: { openMinute: number; closeMinute: number } | null,
): ScheduledFoodHours | undefined {
  if (!window) return undefined;
  const { provenance } = venue.hours;
  return {
    openMinute: window.openMinute,
    closeMinute: window.closeMinute,
    ...(hours.periodLabel ? { periodLabel: hours.periodLabel } : {}),
    confidence: venue.hours.hoursConfidence,
    sourceKind: provenance.kind,
    sourceName: provenance.sourceName,
    ...(provenance.sourceUrl ? { sourceUrl: provenance.sourceUrl } : {}),
    ...(provenance.lastVerified ? { lastVerified: provenance.lastVerified } : {}),
  };
}

/**
 * The runners-up, for a traveller who wants to make their own mind up.
 *
 * Computed after the fact from the same shortlist, so what is offered can never
 * be something the planner would itself have refused. Each carries the one
 * clause that says what swapping would cost.
 */
export function alternativesFor(input: {
  plan: FoodDayPlan;
  dataset: FoodDataset;
  slot: MealSlot;
  chosenVenueId: string;
  matrix: TravelTimeMatrix;
  fromRoutingId: string;
}): FoodAlternative[] {
  const slotPlan = input.plan.slots.find((entry) => entry.slot === input.slot);
  if (!slotPlan) return [];

  const out: FoodAlternative[] = [];
  for (const venueId of slotPlan.shortlist) {
    if (venueId === input.chosenVenueId) continue;
    const venue = input.dataset.venues.find((entry) => entry.id === venueId);
    if (!venue) continue;
    const hours = input.plan.hours.get(venueId);
    if (!hours || hours.status === 'closed' || hours.status === 'unknown') continue;
    const leg = hop(input.matrix, input.fromRoutingId, venue.routingId);
    if (!leg) continue;
    out.push({
      venueId: venue.id,
      name: venue.name,
      serviceType: venue.serviceType,
      priceBand: venue.priceBand,
      tradeoff: tradeoffFor(venue, leg.minutes),
      approachMinutes: leg.minutes,
    });
    if (out.length === 2) break;
  }
  return out;
}

function tradeoffFor(venue: FoodVenue, minutes: number): string {
  if (venue.reservation.requirement === 'required') {
    return `${minutes} min away, and you would have to book it yourself.`;
  }
  if (venue.hours.hoursConfidence === 'closing_time_estimated') {
    return `${minutes} min away, and its closing time is not published.`;
  }
  if (venue.hours.hoursConfidence === 'unverified') {
    return `${minutes} min away, and its hours come from a listing rather than from them.`;
  }
  if (minutes === 0) return 'Same spot, different kind of meal.';
  return `${minutes} min away in the model, and a ${venue.serviceType} rather than what we picked.`;
}
