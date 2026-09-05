import {
  assessSeason,
  describeTransitBlindWalk,
  displayNameOf,
  formatMinuteOfDay,
  INTEREST_LABELS,
  MEAL_SLOT_LABELS,
  PLACE_CATEGORY_LABELS,
  TRANSPORT_MODE_LABELS,
  type BookingRequirement,
  type DayAvailability,
  type Interest,
  type ItineraryDay,
  type ItineraryItem,
  type MinuteInterval,
  type OpeningWindowOnDate,
  type Place,
  type DayWeatherSummary,
  type ScheduledHours,
  type ScheduledWeather,
  type TransportMode,
  type TravelerProfile,
} from '@sidequest/core';
import { leg, orderStops, resolveSubMatrix, type TravelTimeMatrix } from '@sidequest/geo';
import { matrixCoversMode, type AccessLegPlan, type AccessOption, type AccessUnit } from './access';
import {
  latestStartOn,
  placeVisit,
  type HoursBlockCode,
  type PlaceDayHours,
} from './hours';
import {
  isWeatherWorthFlagging,
  narrowByDaylight,
  type PlaceDayWeather,
} from './weather';
import {
  weatherPenaltyAt,
  type FoodDataset,
  type MealSlot,
  type ScheduledFood,
} from '@sidequest/core';
import {
  alternativesFor,
  chooseFoodStop,
  chooseProvisioningStop,
  foodAreaAt,
  PACKED_MEAL_MINUTES,
  type FoodArea,
  type FoodChoice,
  type FoodContext,
  type FoodDayPlan,
} from './food';
import type { PlannedDay } from './windows';
import type { PlannerConfig, PlanningCandidate } from './types';
import {
  countsTowardRoadDistance,
  travelBucketFor,
  type TravelKnowledge,
} from './travel';
import {
  formatSpan,
  isUnverifiedScheduledJourney,
  plannerLegBounds,
  resolvePlannerLeg,
  type PlannerResolvedLeg,
} from './modelled-walk';

/**
 * THE NAME A TRAVELLER READS, WHEREVER THIS FILE WRITES ONE DOWN.
 *
 * `displayNameOf` was added as a presentation seam and wired into the board's
 * components — but the planner materialises its titles as plain strings at plan
 * time, and every one of them read `place.name`. So a traveller who picked
 * "Sumida River" off the board was handed a day headed 隅田川, and the exported
 * artifacts that reuse those titles — the calendar file, the print sheet, the
 * Google and Apple Maps stop lists — inherited the unresolved half. A name
 * resolved on one of the two screens that show it is not resolved.
 *
 * Every title, every leg endpoint, every sentence naming a place goes through
 * here. The stop's `placeId` is untouched, so nothing that keys off identity
 * cares which name was chosen.
 */
function nameOf(place: Place): string {
  return displayNameOf(place);
}

/**
 * A place's season resolved against one specific date rather than the whole
 * trip. The board only knows "open on some month of your trip", which is not
 * good enough once days are real: a trip spanning late October into November
 * must not put Tioga Pass on a November day just because October qualified.
 */
export function isOpenOnDate(place: Place, date: string): boolean {
  const month = Number(date.slice(5, 7));
  if (!Number.isInteger(month) || month < 1 || month > 12) return false;
  return assessSeason(place, [month]).status === 'open';
}

/** A day's stops, grouped into the gateway sequences that actually serve them. */
export interface ScheduledUnit {
  unit: AccessUnit;
  option: AccessOption;
  members: PlanningCandidate[];
}

/**
 * A way the day cannot legally be executed. Distinct from a validation issue:
 * these are found while building, and a day that has one is never offered.
 *
 * `kind` keeps the two failures apart on purpose. "The last bus left" and "the
 * gate was shut" are different problems with different remedies, and a traveller
 * told only that a stop "did not work" has been told nothing.
 */
export interface LayoutViolation {
  kind: 'access' | 'hours';
  code:
    | 'missed_last_return'
    | 'missed_last_outbound'
    | 'access_window_too_short'
    | 'missing_travel_data'
    /**
     * Somebody measured this journey and the traveller has ruled that mode out.
     *
     * Distinct from `missing_travel_data`, which is an absence of evidence with a
     * data remedy. This one is a conflict inside the trip itself — no car, no
     * timetables here, and a pair too far to walk — and the only honest response
     * is to say so. The alternative, which is what happened before this code
     * existed, is to answer a car-free traveller off the road matrix.
     */
    | 'no_permitted_mode'
    | HoursBlockCode;
  message: string;
  placeId?: string;
}

export interface DayLayout {
  items: ItineraryItem[];
  endMinute: number;
  activityMinutes: number;
  /** Total transportation: driving, riding, walking to reach things and waiting. */
  travelMinutes: number;
  driveMinutes: number;
  transitMinutes: number;
  walkMinutes: number;
  waitMinutes: number;
  /** Held for journeys nobody could price. Never a claim about a mode. */
  unverifiedMinutes: number;
  travelKm: number;
  freeMinutes: number;
  strenuousCount: number;
  violations: LayoutViolation[];
  /** Modes actually used, in first-use order. */
  modes: TransportMode[];
}

export interface LayoutContext {
  day: PlannedDay;
  baseId: string;
  baseName: string;
  matrix: TravelTimeMatrix;
  /**
   * Every way this traveller could actually make a given journey, as data.
   *
   * Beside the matrix rather than replacing it, because the matrix is still the
   * source for the mode it measures and is still what orders a day's stops. What
   * this adds is the second and third answers — the measured train, and the
   * refusal to charge a road duration to somebody with no car — which a single
   * matrix cannot hold and which the scheduler previously had no way to ask for.
   */
  travel: TravelKnowledge;
  config: PlannerConfig;
  profile: TravelerProfile;
  /**
   * Opening hours for this day only, by place id. Already resolved against
   * `day.date`, so nothing downstream has to know a calendar exists.
   */
  hours: ReadonlyMap<string, PlaceDayHours>;
  /**
   * Weather and daylight for every stop on this date, resolved at the same
   * boundary as the hours. Weather only ever narrows or cautions here; the one
   * thing in it that constrains legality is daylight, which is a fact rather
   * than a prediction.
   */
  weather: ReadonlyMap<string, PlaceDayWeather>;
  /**
   * What this day may eat, and where from. Null when no food data reached the
   * planner at all — in which case meals fall back to the bare blocks that
   * every version-5 plan had, which is the honest output rather than a silent
   * absence.
   */
  food: FoodContext | null;
  /**
   * The region's food records, independent of what this day may eat.
   *
   * Two different questions were riding on one field. `food` is *this day's
   * plan* — which venues it may name, in which slots — and a day whose named
   * venues would cost it a stop legitimately loses it. But "where is the
   * traveller standing when this meal falls, and what do we hold near there" is
   * a question about the region and the route, and it has an answer on every
   * day of every trip in a region with any food data at all. Reading it off the
   * plan meant a yielded day printed bare blocks headed "Lunch" and "Dinner"
   * with "Back at base, nothing booked" under them, in a metropolis whose own
   * index held fourteen venues.
   *
   * Null only where the region really has none, which is the case that must go
   * on saying so plainly.
   */
  foodDataset: FoodDataset | null;
}

/**
 * Whether an item is something the day actually asks of the traveller.
 *
 * Free time is not, and a held meal block with no venue behind it is not — both
 * are the day saying the hours are theirs, in more words. A *named* meal is,
 * and so is any leg laid to reach one.
 */
function isSomethingOnTheDay(item: ItineraryItem): boolean {
  if (item.kind === 'activity') return true;
  if (item.kind === 'travel') return true;
  return item.kind === 'meal' && item.food?.stopKind === 'venue';
}

/**
 * Lays a day out on the clock from an ordered set of access units.
 *
 * The plan is *built* and then measured, rather than estimated and then built —
 * so "does this fit?" is answered by the same code that produces the timeline.
 * An estimate that drifts from the layout is how itineraries end up overlapping
 * their own items, or scheduling a hike that ends after the last bus.
 *
 * The unit is the reason a shared shuttle is paid for once. Everything between
 * boarding and getting off again belongs to one sequence: drive to the gateway,
 * wait, ride, walk, do the things, walk, ride back.
 */
export function layoutDay(
  context: LayoutContext,
  units: readonly ScheduledUnit[],
): DayLayout {
  const { day, baseId, baseName, matrix, config } = context;
  const items: ItineraryItem[] = [];
  const violations: LayoutViolation[] = [];
  const modes: TransportMode[] = [];

  let cursor = day.window.startMinute;
  let activityMinutes = 0;
  let driveMinutes = 0;
  let transitMinutes = 0;
  let walkMinutes = 0;
  let waitMinutes = 0;
  let unverifiedMinutes = 0;
  let travelKm = 0;
  let strenuousCount = 0;
  let lunchInserted = false;
  let sequence = 0;
  /**
   * Whether the day has set off yet.
   *
   * Not `items.length === 0`, which is what it was: breakfast and the shopping
   * are committed before the first unit, so on any day with a coffee stop the
   * "leave later rather than queue at the stop" rule silently stopped applying
   * and the traveller waited at the boarding point instead.
   */
  let hasLeftBase = false;

  const dayIsLongEnough = day.window.usableMinutes >= config.minDayMinutesForLunch;
  const useMode = (mode: TransportMode) => {
    if (!modes.includes(mode)) modes.push(mode);
  };

  /**
   * Every leg this day resolves goes through one door.
   *
   * The planner-level resolver, not core's, so a car-free day handed a road
   * matrix can still walk its short legs — as a derived, `modelled`-labelled
   * estimate bounded by the traveller's own walking radius — instead of every
   * leg failing and the day refusing itself. See `modelled-walk.ts` for the
   * invariants; nothing at this call site chooses a mode.
   *
   * The day's own travel knowledge decides which of the traveller's answers the
   * *journey* bound is: where a scheduled network went unmeasured, a walking
   * figure is standing in for a ride and is bounded like one, which is the same
   * fact the board's detour class was decided on. The walking bound beside it is
   * never widened by that, because it is what any leg laid on foot below is held
   * to.
   *
   * `config.bufferMinutes` goes in as the drive overhead. It is not a bound: it
   * is the parking-and-getting-going time this very function books on a driving
   * leg twenty lines down, handed to the resolver so a leg short enough that
   * walking beats the parking is walked. Reading it from the config rather than
   * restating it is what keeps the two numbers the same number.
   */
  const legBounds = plannerLegBounds(context.profile, context.travel, config.bufferMinutes);
  const resolveDayLeg = (
    fromId: string,
    toId: string,
    allowed: TransportMode | readonly TransportMode[],
    spent?: { driveMinutes: number },
  ): PlannerResolvedLeg =>
    resolvePlannerLeg(context.travel, fromId, toId, allowed, {
      bounds: legBounds,
      ...(spent ? { spent } : {}),
    });

  /**
   * The one place a leg's minutes are added to a day.
   *
   * There were ten, and they did not agree. Six classified with "walk, else
   * riding"; four with "drive, else walking". A leg the access dataset declared
   * a `drive` with its own stated allowance — legal on any pedestrian matrix —
   * went to `transitMinutes` here and to `driveMinutes` in the validator, so the
   * day failed its own totals check and, until it did, the traveller's driving
   * cap was being enforced against a zero.
   *
   * `travelBucketFor` is the rule, imported from the module the validator
   * imports it from, so "the layout and the validator agree" is true by
   * construction rather than by inspection. `useMode` is folded in because every
   * one of those ten sites called it and two of them forgot.
   *
   * `unverifiedScheduled` is the leg saying that its mode is a stand-in. It has
   * to be told, because nothing in `(mode, role)` can tell: a proxy leg and a
   * genuine walk are both `('walk', 'approach')`, and classifying by the pair
   * booked a whole day of unpriceable journeys to `walkMinutes`. It also keeps
   * the mode out of `modes` — the day did not walk, and a day whose only travel
   * is a proxy must not go on to announce walking as how it is got through.
   */
  const charge = (
    mode: TransportMode,
    role: string,
    minutes: number,
    km = 0,
    unverifiedScheduled = false,
  ): void => {
    if (minutes > 0) {
      switch (travelBucketFor(mode, role, unverifiedScheduled)) {
        case 'drive':
          driveMinutes += minutes;
          break;
        case 'wait':
          waitMinutes += minutes;
          break;
        case 'walk':
          walkMinutes += minutes;
          break;
        case 'transit':
          transitMinutes += minutes;
          break;
        case 'unverified':
          unverifiedMinutes += minutes;
          break;
      }
    }
    // Road distance only, which is what the day's `travelKm` claims to be and
    // what the itinerary renders under "Road distance". A ride adds minutes to a
    // day, not kilometres to a car.
    if (km > 0 && countsTowardRoadDistance(mode)) travelKm += km;
    if (!unverifiedScheduled) useMode(mode);
  };

  let atRoutingId = baseId;
  let atName = baseName;
  /**
   * How the traveller gets home at the end.
   *
   * Null means "drive, measured from the matrix" — right for a car trip, and
   * catastrophic for a car-free one, where an unconditional drive home is a leg
   * the traveller cannot perform and silently blows their zero-minute driving
   * budget. When the way out was on foot or on a service, the way back mirrors
   * it, because that is what actually happens.
   */
  let homeward: { mode: TransportMode; minutes: number } | null = null;
  /**
   * Where the car is.
   *
   * Without this the vehicle teleports: a traveller who walks to a bus stop, rides
   * to the Lakes Basin and rides back can be scheduled to "drive" onward from the
   * bus stop, and the drive out to fetch the car never appears in the day or in
   * its driving total. Tracking the car means a later drive first has to go back
   * to where it was left.
   */
  let vehicleAt = baseId;

  const foodPlan: FoodDayPlan | null = context.food?.byDay.get(day.dayNumber) ?? null;
  const wantsSlot = (slot: MealSlot) =>
    foodPlan?.slots.some((entry) => entry.slot === slot) ?? slot !== 'breakfast';

  /**
   * A food stop, committed to the timeline.
   *
   * Everything it touches — the clock, the travel buckets, where the car is,
   * where the traveller is standing — is the same state the rest of the layout
   * reads, which is the point: a drive to a restaurant is a drive, counted in
   * the same bucket as a drive to a lake, so the validator's independent re-sum
   * of the day's totals cannot disagree with the layout about what happened.
   * The last time those two disagreed the reviser emptied a day one stop at a
   * time.
   */
  const commitFood = (
    choice: FoodChoice,
    options: {
      title: string;
      reason: string;
      returnAfter: boolean;
      food: ScheduledFood;
      /** Where the leg to the venue starts, which is not always where the unit is. */
      fromId: string;
      fromName: string;
    },
  ): void => {
    /**
     * Wait first, then travel.
     *
     * The other way round put the walk to a bakery at eight in the morning and
     * then stood the traveller outside it until half eleven, because lunch is
     * not lunch before half eleven. Nobody does that. The gap belongs before the
     * journey, and what it is called depends on what is actually holding things
     * up: a shut door, or the clock.
     */
    const departAt = choice.startMinute - choice.approachMinutes;
    if (departAt > cursor) {
      cursor =
        choice.opensAtMinute !== null && departAt >= cursor + FOOD_WAIT_BLOCK_MINUTES
          ? pushWaitForOpening(
              items,
              day.dayNumber,
              cursor,
              departAt,
              choice.venue.name,
              choice.opensAtMinute,
            )
          : pushFreeTime(items, day, config, cursor, departAt);
      cursor = Math.max(cursor, departAt);
    }

    /**
     * On foot, the traveller always comes back.
     *
     * A car can be left at the cafe and driven on from there; feet cannot. This
     * used to be left to the caller, and a car-free traveller who walked four
     * minutes to a coffee shop was then driven one minute home by a fallback
     * that assumed anyone away from base had a vehicle.
     */
    const returnAfter = options.returnAfter || choice.approachMode === 'walk';

    if (choice.approachMinutes > 0) {
      items.push({
        id: `travel-${day.dayNumber}-${sequence++}`,
        kind: 'travel',
        title: `${TRANSPORT_MODE_LABELS[choice.approachMode]} to ${choice.venue.name}`,
        startMinute: cursor,
        endMinute: cursor + choice.approachMinutes,
        durationMinutes: choice.approachMinutes,
        // Says what the leg is. What it *costs* is the meal row's business, and
        // printing the same figure twice a centimetre apart is how a reader
        // learns to skip both.
        reason: `${choice.approachMinutes} min ${
          choice.approachMode === 'walk' ? 'on foot' : 'on the road'
        }, in the model.`,
        weatherSensitive: false,
        travel: {
          fromId: options.fromId,
          toId: choice.venue.routingId,
          fromName: options.fromName,
          toName: choice.venue.name,
          minutes: choice.approachMinutes,
          km: choice.approachKm,
          mode: choice.approachMode,
          role: 'approach',
          provenance: foodLegProvenance(matrix, choice.approachMode),
        },
      });
      cursor += choice.approachMinutes;
      charge(choice.approachMode, 'approach', choice.approachMinutes, choice.approachKm);
      if (choice.approachMode === 'drive') vehicleAt = choice.venue.routingId;
    }

    cursor = Math.max(cursor, choice.startMinute);

    items.push({
      id: `meal-${day.dayNumber}-${options.food.slot}-${cursor}`,
      kind: 'meal',
      title: options.title,
      startMinute: cursor,
      endMinute: cursor + choice.stopMinutes,
      durationMinutes: choice.stopMinutes,
      reason: options.reason,
      weatherSensitive: false,
      food: options.food,
    });
    cursor += choice.stopMinutes;

    if (returnAfter && choice.approachMinutes > 0) {
      items.push({
        id: `travel-${day.dayNumber}-${sequence++}`,
        kind: 'travel',
        title: `${TRANSPORT_MODE_LABELS[choice.approachMode]} back to ${options.fromName}`,
        startMinute: cursor,
        endMinute: cursor + choice.approachMinutes,
        durationMinutes: choice.approachMinutes,
        reason: 'Back the way you came.',
        weatherSensitive: false,
        travel: {
          fromId: choice.venue.routingId,
          toId: options.fromId,
          fromName: choice.venue.name,
          toName: options.fromName,
          minutes: choice.approachMinutes,
          km: choice.approachKm,
          mode: choice.approachMode,
          role: 'return',
          provenance: foodLegProvenance(matrix, choice.approachMode),
        },
      });
      cursor += choice.approachMinutes;
      charge(choice.approachMode, 'return', choice.approachMinutes, choice.approachKm);
      // The car came back too. Without this the vehicle stays parked at the
      // restaurant and the next drive of the day is measured from a car park
      // the traveller has already left.
      if (choice.approachMode === 'drive') vehicleAt = options.fromId;
    } else if (choice.approachMinutes > 0) {
      atRoutingId = choice.venue.routingId;
      atName = choice.venue.name;
    }
  };

  /**
   * WHAT A SLOT LOOKS LIKE WHEN NO VENUE COULD BE NAMED. NEVER A FABRICATED ONE.
   *
   * Two outcomes, and which one is reached is a statement about the evidence
   * rather than a choice of wording.
   *
   * An **area** is the product's own fallback: the locality the day's own
   * cluster sits in, taken off records that published one, with a count of what
   * our index holds there. It is what turns a meal from an hour with a name on
   * it into somewhere to go, and it is the outcome this exists to reach.
   *
   * A **bare** block is what is left when there is no area to read — no venue in
   * reach of the day and no locality on its stops — and it keeps saying so
   * plainly. Inventing a neighbourhood there would be the same overreach as
   * inventing a restaurant, in a larger unit.
   *
   * `reason` is the caller's, because only the caller knows which of the several
   * ways a slot can end up here it actually took.
   */
  const pushUnnamedMeal = (
    slot: MealSlot,
    start: number,
    input: {
      title: string;
      reason: string;
      areaReason: (area: FoodArea) => string;
      /**
       * WHERE THE TRAVELLER IS WHEN THIS BLOCK IS LAID, FROM THE CALLER.
       *
       * The layout's `atRoutingId` and `atName` are two witnesses to one fact
       * and they are not written together: the unit loop advances the *name* on
       * arrival at a gateway and leaves the *id* on the previous unit's exit
       * until the whole unit is done. So a meal laid in between was titled
       * after one place and measured at another — a delivered day counted
       * "3 places we hold within reach of <the museum>" from a square four
       * kilometres away — and a meal laid before the day's first stop ended
       * read `atBase: true`, which turns "near X" into "around X" and quotes
       * the base's own venue count over a stop a hundred kilometres out.
       *
       * That is the shape of the defect this fallback was rewritten to end, so
       * the anchor is an argument rather than a global. Absent only where the
       * caller genuinely means "wherever the layout has got to" — the base-side
       * branches at the top and tail of the day, where the two witnesses agree
       * by construction.
       */
      at?: { routingId: string; name: string };
    },
  ): number => {
    const anchorId = input.at?.routingId ?? atRoutingId;
    const anchorName = input.at?.name ?? atName;
    const minutes = config.unplannedMealMinutes[slot];
    /*
     * WHERE THIS MEAL IS, ASKED OF WHERE THE TRAVELLER IS STANDING.
     *
     * It used to read `foodPlan.area`, a single value computed once for the
     * whole day — and computed from a node set the base is always in, so it was
     * always the base's own municipality. A live journey printed "Lunch around
     * Reykjavík" for a traveller at a reserve sixty kilometres up the coast,
     * directly above the sentence saying none of our venues "worked from where
     * the day actually is at this hour". The layout has tracked `atRoutingId`
     * and `atName` since it was written; nothing asked them.
     */
    const area =
      context.foodDataset !== null
        ? foodAreaAt({
            routingId: anchorId,
            name: anchorName,
            atBase: anchorId === baseId,
            venues: context.foodDataset.venues,
            matrix,
          })
        : null;
    items.push({
      ...mealItem(
        day.dayNumber,
        area ? `${input.title} ${area.atBase ? 'around' : 'near'} ${area.name}` : input.title,
        start,
        minutes,
        area ? input.areaReason(area) : input.reason,
      ),
      food: {
        slot,
        stopKind: 'unplanned',
        dietary: [],
        dietaryUnverified: [],
        hoursUnknown: false,
        ...(area ? { areaName: area.name } : {}),
        /*
         * Where this block sits on the day's route, said truthfully. Hard-coded
         * `at_base` claimed the traveller was at their hotel for every held
         * meal, including the ones laid at a stop an hour away.
         */
        routeContext: anchorId === baseId ? 'at_base' : 'on_route',
        detourMinutes: 0,
        isSpecialMeal: false,
        fromUserChoice: false,
        alternatives: [],
      },
    });
    return start + minutes;
  };

  /**
   * The area sentence, written once so all four slots say the same true thing.
   *
   * It states what the count is a count *of* — what we hold, not what is there —
   * because "several options" over an index that has read four venues in a city
   * of thousands is a claim about our coverage dressed as a claim about the
   * neighbourhood. Zero is a different sentence rather than a suppressed one.
   */
  const areaReasonFor = (slot: MealSlot) => (area: FoodArea) => {
    const count = area.countBySlot[slot];
    const label = MEAL_SLOT_LABELS[slot].toLowerCase();
    const where = `${area.atBase ? 'around' : 'near'} ${area.name}`;
    if (count === 0) {
      return `We hold nothing serving ${label} within reach of ${area.name}, so this is time held ${where} and the choice of where is yours.`;
    }
    return `${count} ${count === 1 ? 'place' : 'places'} we hold within reach of ${area.name} ${count === 1 ? 'serves' : 'serve'} ${label}, and none of them could be fitted at this hour — so this is time held ${where} rather than somewhere named.`;
  };

  const foodRequest = (
    slot: MealSlot,
    fromRoutingId: string,
    toRoutingId: string | null,
    at: number,
    returnsToOrigin: boolean,
  ) => ({
    windows: config.mealWindows,
    returnsToOrigin,
    slot,
    plan: foodPlan!,
    profile: context.profile,
    dataset: context.food!.dataset,
    namedOnSettledDays: context.food!.namedOnSettledDays,
    matrix,
    fromRoutingId,
    toRoutingId,
    cursor: at,
    // The final meal of the day may finish a little past the window; the
    // validator allows exactly the same margin, and the two constants are the
    // same constant so they cannot drift apart.
    // The last meal of the day, and the leg home from it, may run a little past
    // the window. The validator allows exactly the same margin, off the same
    // config field, so the two cannot drift apart.
    latest: day.window.endMinute + (slot === 'dinner' ? config.mealOverrunAllowanceMinutes : 0),
    canDrive: context.profile.transport.willDrive,
  });

  const attachAlternatives = (
    choice: FoodChoice,
    slot: MealSlot,
    fromRoutingId: string,
  ): ScheduledFood => ({
    ...choice.food,
    alternatives: alternativesFor({
      plan: foodPlan!,
      dataset: context.food!.dataset,
      slot,
      chosenVenueId: choice.venue.id,
      matrix,
      fromRoutingId,
    }),
  });

  const hasFood = () => foodPlan !== null && context.food !== null;

  /**
   * Lunch is split into "is it due?" and "put it there" because a stop's
   * legality now depends on when the traveller actually arrives, and lunch is
   * forty-five minutes of that. Deciding whether to eat before knowing whether
   * the next stop is still open would be how a plan eats its way past a last
   * admission. With a real venue behind it the same split does more work still:
   * the venue's own travel to the door, the wait if it has not opened, and its
   * service time are all inside the number the next stop is then tested against.
   */
  /**
   * WHETHER LUNCH IS STILL LUNCH AT THIS MINUTE.
   *
   * Both ends of the window, which it was not: the clamp read
   * `minute >= earliest` and nothing at the top, so a day whose route ran
   * straight through the middle of itself came out with a forty-five minute
   * block headed "Lunch" starting at four in the afternoon — the latest
   * observed was 16:02, on 41% of the plans in a 135-cell sweep, and 42 of
   * those days had no dinner on them either, so "Lunch" was the whole of the
   * traveller's afternoon meal and it was named wrong.
   *
   * The window is the product's own definition of when lunch is lunch. Past
   * it, nothing is emitted rather than something mislabelled: `missing_meal_break`
   * and `long_day_without_food` are the validator's existing sentences for a
   * day left with a hole in it, and they say the true thing where a block called
   * "Lunch" at 16:02 said a false one.
   */
  const withinLunchWindow = (minute: number) => minute <= config.mealWindows.lunch.latest;

  const lunchDueAt = (minute: number) =>
    !lunchInserted &&
    dayIsLongEnough &&
    wantsSlot('lunch') &&
    minute >= config.mealWindows.lunch.earliest &&
    withinLunchWindow(minute);

  const lunchIsPacked = () =>
    foodPlan?.slots.some((entry) => entry.slot === 'lunch' && entry.fallback === 'packed') ?? false;

  /**
   * What lunch looks like from here, measured and not yet committed.
   *
   * `minutes` is everything the day loses to it, including the leg to the door
   * and any wait for it to open. `resumeAt` is where the traveller ends up
   * standing afterwards, which is the venue on a route detour and where they
   * already were otherwise — the next leg is measured from that, not from the
   * stop they left.
   */
  type LunchPlanned =
    | { kind: 'none'; minutes: 0 }
    | { kind: 'packed'; minutes: number }
    | { kind: 'bare'; minutes: number }
    | { kind: 'venue'; minutes: number; choice: FoodChoice; resumeAt: string };

  const planLunch = (
    at: number,
    fromId: string,
    toId: string | null,
    drivesOn: boolean,
  ): LunchPlanned => {
    if (!lunchDueAt(at)) return { kind: 'none', minutes: 0 };
    /**
     * On a day the source says has no food, the rucksack wins.
     *
     * The other order was tried and is worse: a venue lunch would sometimes be
     * legal on such a day because the route happens to pass town at midday, and
     * the traveller would then be carrying a bought lunch *and* sitting in a
     * diner — the shopping having been done at half seven, before anything knew
     * how the afternoon would go.
     */
    if (lunchIsPacked()) return { kind: 'packed', minutes: PACKED_MEAL_MINUTES };
    const choice = hasFood() ? chooseFoodStop(foodRequest('lunch', fromId, toId, at, !drivesOn)) : null;
    if (choice) {
      return {
        kind: 'venue',
        minutes: choice.startMinute - at + choice.stopMinutes,
        choice,
        resumeAt: choice.venue.routingId,
      };
    }
    if (lunchIsPacked()) return { kind: 'packed', minutes: PACKED_MEAL_MINUTES };
    return { kind: 'bare', minutes: config.unplannedMealMinutes.lunch };
  };

  /** Lunch where the traveller already is, because there is no detour to take. */
  const planLunchInPlace = (at: number): LunchPlanned => {
    if (!lunchDueAt(at)) return { kind: 'none', minutes: 0 };
    if (lunchIsPacked()) return { kind: 'packed', minutes: PACKED_MEAL_MINUTES };
    return { kind: 'bare', minutes: config.unplannedMealMinutes.lunch };
  };

  const commitPackedLunch = (): void => {
    const supplied = foodPlan?.provisionedOnDay ?? null;
    items.push({
      ...mealItem(
        day.dayNumber,
        'Packed lunch',
        cursor,
        PACKED_MEAL_MINUTES,
        supplied === null
          ? 'Nothing verified is open near where this day goes, so this is the lunch you brought.'
          : supplied === day.dayNumber
            ? 'What you picked up this morning. There is nothing to buy once you are out here.'
            : 'What you picked up the evening before. There is nothing to buy once you are out here.',
      ),
      food: {
        slot: 'lunch',
        stopKind: 'packed',
        dietary: [],
        dietaryUnverified: [],
        hoursUnknown: false,
        routeContext: 'on_route',
        detourMinutes: 0,
        ...(supplied !== null ? { preparedOnDayNumber: supplied } : {}),
        isSpecialMeal: false,
        fromUserChoice: false,
        alternatives: [],
      },
    });
    cursor += PACKED_MEAL_MINUTES;
    lunchInserted = true;
  };

  const commitLunch = (
    planned: LunchPlanned,
    fromId: string,
    fromName: string,
    /** True when the traveller drives on from the venue rather than back. */
    drivesOn: boolean,
  ): void => {
    if (planned.kind === 'none') return;
    if (planned.kind === 'packed') {
      commitPackedLunch();
      return;
    }
    if (planned.kind === 'bare') {
      cursor = pushUnnamedMeal('lunch', cursor, {
        title: 'Lunch',
        reason: hasFood()
          ? 'Nothing open near this stretch of the day fitted, so this is time set aside rather than somewhere named.'
          : 'Slotted in before the next stop rather than skipped.',
        areaReason: areaReasonFor('lunch'),
        /*
         * The anchor this call already carries, which it used to discard. It is
         * the stop the lunch is actually beside; the layout's own globals are
         * mid-flight here and disagree with each other.
         */
        at: { routingId: fromId, name: fromName },
      });
      lunchInserted = true;
      return;
    }
    commitFood(planned.choice, {
      title: planned.choice.venue.name,
      reason: foodReason(planned.choice, 'lunch'),
      returnAfter: !drivesOn,
      food: attachAlternatives(planned.choice, 'lunch', fromId),
      fromId,
      fromName,
    });
    lunchInserted = true;
  };

  /**
   * Lunch before setting off, when the clock has already got there.
   *
   * `drivesOn` is not cosmetic. A stop reached by car that the traveller then
   * walks away from leaves the car outside it, and the day carries on as though
   * it were at base — which is how one of these ended up "driving" to dinner
   * from a car park it had ridden a trolley away from.
   */
  const maybeLunch = (toRoutingId: string | null, drivesOn: boolean) => {
    const planned = planLunch(cursor, atRoutingId, toRoutingId, drivesOn);
    commitLunch(planned, atRoutingId, atName, drivesOn);
  };

  /**
   * The start of the day, before a single wheel turns.
   *
   * Breakfast and the shopping both belong here and nowhere else. A grocery run
   * has to happen *before* the walk it is meant to feed, and a coffee has to be
   * on the way out rather than a reason to come back into town — so both are
   * measured from base, towards wherever the day is actually going first, and
   * the leg to the door is charged for.
   */
  const firstHeading = units[0]?.option.gatewayRoutingId ?? null;
  /**
   * Whether the day leaves base at the wheel.
   *
   * If it does not — the first move is a walk to a trolley stop — then a food
   * stop reached by driving has to bring the car back, or it is left outside a
   * diner while the traveller rides away and walks home from the Village. The
   * day then "drove" to dinner from a base the car was not at, and the drive out
   * to fetch it appeared nowhere.
   */
  // Read off the mode rather than off "is this measured": a walking approach is
  // measured too now, and a day that walks out of town does not leave by car.
  const leavesByCar = units[0] ? units[0].option.approachMode === 'drive' : true;
  if (hasFood() && foodPlan!.provisionForDay !== null) {
    // Filed as a snack slot rather than a meal: it is not one, the day summary
    // filters it out of the meal list, and the window checks are bypassed for a
    // provisioning stop anyway — a shop at half seven is the point of it.
    const stop = chooseProvisioningStop(foodRequest('snack', atRoutingId, firstHeading, cursor, !leavesByCar));
    if (stop) {
      const forDay = foodPlan!.provisionForDay!;
      commitFood(stop, {
        title: `${stop.venue.name} — supplies`,
        reason:
          forDay === day.dayNumber
            ? 'Lunch and something for the walk, before you head out. There is nothing to buy where this day goes.'
            : `Lunch and trail food for day ${forDay}, which has nowhere to buy any.`,
        returnAfter: !leavesByCar,
        food: {
          ...stop.food,
          stopKind: 'grocery',
          suppliesDayNumber: forDay,
        },
        fromId: atRoutingId,
        fromName: atName,
      });
    }
  }

  /**
   * BREAKFAST, INCLUDING THE MORNINGS WHERE NOBODY COULD BE NAMED.
   *
   * `wantsSlot` has already decided this day asks for one — an arrival at noon
   * does not, and a breakfast-skipper only does when the morning is long, early
   * and physical enough that setting off with nothing is a logistics problem.
   * Once it has decided, the day owes the traveller an answer either way.
   *
   * The `if (stop)` used to be the whole of it, with no else: on every day where
   * no venue could be named the slot simply vanished, and because a day's food
   * summary is read back off the timeline, nothing anywhere reported the
   * absence. Every venue a live compilation stores has unknown hours, so that
   * was every day of every trip — three delivered plans, not one breakfast row,
   * and no warning saying so. Lunch and dinner have always fallen back to a
   * block that says what it is; this one now does the same.
   */
  if (hasFood() && wantsSlot('breakfast')) {
    const stop = chooseFoodStop(foodRequest('breakfast', atRoutingId, firstHeading, cursor, !leavesByCar));
    if (stop) {
      commitFood(stop, {
        title: stop.venue.name,
        reason: foodReason(stop, 'breakfast', context.profile.food.breakfastStyle === 'skip'),
        returnAfter: !leavesByCar,
        food: attachAlternatives(stop, 'breakfast', atRoutingId),
        fromId: atRoutingId,
        fromName: atName,
      });
    } else if (
      cursor + config.unplannedMealMinutes.breakfast <= day.window.endMinute &&
      cursor <= config.mealWindows.breakfast.latest
    ) {
      cursor = pushUnnamedMeal('breakfast', cursor, {
        title: 'Breakfast',
        reason:
          context.profile.food.breakfastStyle === 'skip'
            ? 'You said you skip breakfast, and nothing we can vouch for sits on the way out, so this is only time before you go.'
            : 'Nothing we can vouch for was open and on the way out at this hour, so this is time held before the day starts.',
        areaReason: areaReasonFor('breakfast'),
      });
    }
  }

  for (const scheduled of units) {
    const { option } = scheduled;

    /**
     * The bounds a visit inside this unit has to sit between, before its own
     * opening hours are even consulted: the day's usable hours, narrowed by the
     * way in. On a shuttle-served unit `latestActivityEnd` is the moment after
     * which you cannot get back out — the constraint that has been computed
     * since the transport slice and, until now, never read.
     */
    const bounds: MinuteInterval = {
      startMinute: Math.max(
        day.window.startMinute,
        option.earliestActivityStart ?? Number.NEGATIVE_INFINITY,
      ),
      endMinute: Math.min(
        day.window.endMinute,
        option.latestActivityEnd ?? Number.POSITIVE_INFINITY,
      ),
    };

    /**
     * Which of this unit's stops are worth going out for, decided *before* a
     * single leg is pushed.
     *
     * Sound because a later arrival can only make a visit less legal, never
     * more: testing against the clock as it stands now — before the drive, the
     * boarding and the walk in, all of which only advance it — cannot reject
     * anything that would have worked later. Anything it does reject is
     * genuinely impossible.
     *
     * Doing it here rather than inside the loop is what stops a day from
     * driving out, boarding a shuttle and walking to a gate that is shut. The
     * walk legs are named after these members, so with the filter in front of
     * them the timeline can never point at a stop it does not visit.
     */
    const members: PlanningCandidate[] = [];
    for (const candidate of scheduled.members) {
      const placement = visitFor(context, candidate, cursor, bounds);
      if (placement.ok) members.push(candidate);
      else violations.push(placement.violation);
    }
    // Nothing here can be done: do not pay for the journey out to it.
    if (members.length === 0) continue;

    // --- Approach: get to the gateway --------------------------------------
    if (option.approachMode === 'drive' && atRoutingId !== vehicleAt && homeward) {
      // The next leg is a drive and the traveller is not standing where the car
      // is. Get back to it the way they left it, before driving anywhere.
      /*
       * Measured from where the traveller is, like every other leg.
       *
       * `homeward` was recorded on the way out — base to the first gateway — and
       * reusing it here labels a walk back to the car with a duration taken
       * between two different points. The return-leg block further down was
       * fixed for exactly this and this one was left; both now re-measure when
       * the matrix covers the mode, and fall back to the stated allowance only
       * when it does not.
       */
      /*
       * The matrix's own mode, not the mode the traveller left in.
       *
       * `allowed` is the mode the *matrix* is permitted to answer for, and
       * passing `homeward.mode` made that a transit mode on any day that set off
       * by train — which locked the pedestrian matrix out of the return entirely.
       * The consequence was the module's own headline defect reached through its
       * own API: with no journey bought for this exact pair the code fell back to
       * `homeward.minutes`, the duration of the journey *out*, and stamped it on
       * a different pair of points.
       */
      /*
       * The mode the traveller left in, and only that one.
       *
       * This leg is a *retrace*: they walked away from the car, so they walk back
       * to it. Admitting the matrix's own mode here — which a road matrix answers
       * as `drive` — turned the walk back to a parked car into a drive away from
       * it, and the vehicle-position test says so by name. The end-of-day leg
       * below is a different question and takes a different answer.
       */
      const resolvedBack = resolveDayLeg(atRoutingId, vehicleAt, homeward.mode);
      const measuredBack = resolvedBack.ok ? resolvedBack : null;
      const backMinutes = measuredBack ? measuredBack.minutes : homeward.minutes;
      const backProvenance = measuredBack ? measuredBack.provenance : ('estimated' as const);
      const backMode = measuredBack ? measuredBack.mode : homeward.mode;
      const retraceUnverified = measuredBack !== null && isUnverifiedScheduledJourney(measuredBack);
      items.push({
        id: `travel-${day.dayNumber}-${sequence++}`,
        kind: 'travel',
        title: retraceUnverified
          ? 'Travel back to the car'
          : `${TRANSPORT_MODE_LABELS[backMode]} back to the car`,
        startMinute: cursor,
        endMinute: cursor + backMinutes,
        durationMinutes: backMinutes,
        reason: retraceUnverified
          ? `${describeTransitBlindWalk(backMinutes, formatSpan)}, and that is what is held for getting back to the car.`
          : 'Back to where you left the car before driving on.',
        weatherSensitive: false,
        travel: {
          fromId: atRoutingId,
          toId: vehicleAt,
          fromName: atName,
          toName: vehicleAt === baseId ? baseName : atName,
          minutes: backMinutes,
          km: measuredBack ? measuredBack.km : null,
          mode: backMode,
          role: 'return',
          provenance: backProvenance,
          ...unverifiedScheduledMark(measuredBack),
        },
      });
      cursor += backMinutes;
      charge(backMode, 'return', backMinutes, measuredBack?.km ?? 0, retraceUnverified);
      atRoutingId = vehicleAt;
      atName = baseName;
      homeward = null;
    }

    if (option.approachMinutes === null) {
      /**
       * The approach, resolved rather than assumed.
       *
       * This branch used to read one number off the matrix and label it with the
       * matrix's own mode — driving from a road matrix, walking from a pedestrian
       * one. In a city where public transport is what people actually use, that
       * turned a twenty-minute metro journey into an hour-long walk and charged
       * it to the walking total, because the pedestrian network was the only
       * thing that had been measured.
       *
       * `resolveLeg` is asked instead. It may answer with the access rule's own
       * mode, or with a *measured* transit journey for this exact pair — and with
       * nothing at all, when the traveller has ruled out the only mode anybody
       * measured.
       */
      const resolved = resolveDayLeg(atRoutingId, option.gatewayRoutingId, option.approachMode, {
        driveMinutes,
      });
      if (!resolved.ok) {
        violations.push({
          kind: 'access',
          code: resolved.conflict ? 'no_permitted_mode' : 'missing_travel_data',
          message: resolved.conflict
            ? `${resolved.detail} (${atName} to ${option.gatewayName ?? option.gatewayRoutingId}.)`
            : `No travel time is recorded from ${atName} to ${option.gatewayName ?? option.gatewayRoutingId}.`,
          ...(members[0] ? { placeId: members[0].place.id } : {}),
        });
        continue;
      }
      const approachIsDrive = resolved.mode === 'drive';
      // Parking, boots and getting going. There is no car to park on a walk, and
      // nothing to park at all on a train.
      const approachBuffer = approachIsDrive ? config.bufferMinutes : 0;
      /**
       * Leaving later beats standing about: if the first thing this day does is
       * catch a service or wait for a gate, set off in time to meet it rather
       * than in time to queue for it. Restricted to the first move of the day
       * because that is the only point where delaying costs nothing — mid-route
       * the traveller is already somewhere, and pushing the clock forward there
       * would eat into a later stop's hours.
       */
      if (!hasLeftBase) {
        const driveIn = resolved.minutes + approachBuffer;
        if (option.service) {
          const leadIn = driveIn + option.service.transferBufferMinutes;
          cursor = Math.max(cursor, option.service.window.firstDeparture - leadIn);
        } else {
          const opensAt = openingMinuteFor(context, members[0]);
          if (opensAt !== null) cursor = Math.max(cursor, opensAt - driveIn);
        }
      }
      if (resolved.minutes > 0) {
        /* Where the traveller stands before lunch is given the chance to move them. */
        const approachFrom = atRoutingId;
        maybeLunch(option.gatewayRoutingId, true);
        /**
         * Resolved again, after lunch, because lunch may have moved the
         * traveller.
         *
         * It was measured once, before — and then labelled with the position
         * afterwards, so a leg read "from the bakery to Inyo Craters, 50 min"
         * when the bakery is 26 minutes from Inyo Craters and 50 is the distance
         * from the canyon they had already left. Twenty-four minutes of driving
         * that never happened, on a leg whose own endpoints disproved it. The
         * mode is re-resolved with it: a short hop on from a cafe is a walk even
         * on a day whose first move was a train.
         */
        /*
         * Only measured again if lunch actually moved anybody.
         *
         * And the fallback is only legitimate while it has not: `resolved` was
         * measured from where the traveller stood *before* lunch, so using it
         * after a venue has moved them ships the old number with the new
         * endpoints — "from the bakery to Inyo Craters, 50 min" when the bakery
         * is twenty-six minutes away. The comment above has claimed that defect
         * fixed since before this branch could fail at all; `resolveLeg` can
         * fail where `tryHop` could not, so the fallback needed the guard the
         * claim implied.
         */
        const movedByLunch = atRoutingId !== approachFrom;
        const after = movedByLunch
          ? resolveDayLeg(atRoutingId, option.gatewayRoutingId, option.approachMode, {
              driveMinutes,
            })
          : resolved;
        if (!after.ok) {
          violations.push({
            kind: 'access',
            code: after.conflict ? 'no_permitted_mode' : 'missing_travel_data',
            message: after.conflict
              ? `${after.detail} (${atName} to ${option.gatewayName ?? option.gatewayRoutingId}.)`
              : `No travel time is recorded from ${atName} to ${option.gatewayName ?? option.gatewayRoutingId}.`,
            ...(members[0] ? { placeId: members[0].place.id } : {}),
          });
          continue;
        }
        const hop = after;
        /**
         * A JOURNEY OF NOTHING IS NOT A JOURNEY, AND IT DOES NOT NEED PARKING.
         *
         * The traveller can already be standing on the next stop's routing node
         * — a venue snapped to it for lunch is the ordinary way — and the
         * matrix then answers zero for the hop. The layout still emitted a
         * travel row and, because the mode was `drive`, still booked the
         * parking allowance on top: a delivered day printed "Drive to <the
         * museum>" over fifteen minutes and no distance at all.
         *
         * Nothing is lost by leaving it out. The position is already right, and
         * a row saying a car was driven nowhere is worse than silence.
         *
         * Held by `closure-invariants.test.ts` as a property over every journey
         * it drives, and **not** by a §30 mutation: no synthetic world snaps a
         * venue onto a later stop's own routing node, so no fixture reaches this
         * branch. The defect was observed on a live compile, and claiming a
         * guarded mutation over a branch the fixtures cannot enter would be the
         * green-test-protecting-nothing failure this suite exists to refuse.
         */
        const hopIsNothing = hop.minutes <= 0 && (hop.km ?? 0) <= 0;
        const hopIsDrive = hop.mode === 'drive' && !hopIsNothing;
        const hopBuffer = hopIsDrive ? config.bufferMinutes : 0;
        // Transition slack rides on the travel block rather than sitting as an
        // invisible gap: parking, boots, and getting going are real minutes.
        const duration = hop.minutes + hopBuffer;
        const toName = gatewayLabel(option, members);
        if (hopIsNothing) {
          hasLeftBase = true;
        } else {
          items.push({
          id: `travel-${day.dayNumber}-${sequence++}`,
          kind: 'travel',
          title: hopTitle(hop, `to ${toName}`),
          startMinute: cursor,
          endMinute: cursor + duration,
          durationMinutes: duration,
          reason: approachReason(hop, hopBuffer),
          weatherSensitive: false,
          travel: {
            fromId: atRoutingId,
            toId: option.gatewayRoutingId,
            fromName: atName,
            toName,
            minutes: hop.minutes,
            km: hop.km,
            mode: hop.mode,
            role: 'approach',
            provenance: hop.provenance,
            ...unverifiedScheduledMark(hop),
          },
          });
          cursor += duration;
          charge(hop.mode, 'approach', hop.minutes, hop.km ?? 0, isUnverifiedScheduledJourney(hop));
          if (hopIsDrive) {
            homeward = null;
            vehicleAt = option.gatewayRoutingId;
          } else {
            /**
             * The way back, in the mode the way out was made in.
             *
             * A walk out of base has to be walked back and a metro ride out is
             * a metro ride back, and the return leg used to be a copy of a
             * constant. The duration here is only the allowance of last resort:
             * the return is re-resolved at the point it is actually scheduled,
             * from wherever the day has got to by then.
             */
            homeward = { mode: hop.mode, minutes: hop.minutes };
          }
          hasLeftBase = true;
        }
      }
    } else if (atRoutingId !== option.gatewayRoutingId && option.approachMinutes > 0) {
      if (option.service && !hasLeftBase) {
        cursor = Math.max(
          cursor,
          option.service.window.firstDeparture -
            option.approachMinutes -
            option.service.transferBufferMinutes,
        );
      }
      maybeLunch(option.gatewayRoutingId, false);
      const toName = gatewayLabel(option, members);
      items.push({
        id: `travel-${day.dayNumber}-${sequence++}`,
        kind: 'travel',
        title: `${TRANSPORT_MODE_LABELS[option.approachMode]} to ${toName}`,
        startMinute: cursor,
        endMinute: cursor + option.approachMinutes,
        durationMinutes: option.approachMinutes,
        reason: `${option.approachMinutes} min to get to ${toName}.`,
        weatherSensitive: false,
        travel: {
          fromId: atRoutingId,
          toId: option.gatewayRoutingId,
          fromName: atName,
          toName,
          minutes: option.approachMinutes,
          km: 0,
          mode: option.approachMode,
          role: 'approach',
          provenance: 'estimated',
        },
      });
      cursor += option.approachMinutes;
      /*
       * Through the shared classifier, which is the whole of the fix here. A
       * stated allowance for a `drive` approach — legal, and reachable whenever
       * the access rule names a mode the matrix does not cover — was charged to
       * `transitMinutes` by this line and to `driveMinutes` by the validator. The
       * day failed its own totals check, and until it did, a driving cap was
       * being enforced against a zero.
       */
      charge(option.approachMode, 'approach', option.approachMinutes);
      hasLeftBase = true;
      homeward = { mode: option.approachMode, minutes: option.approachMinutes };
    } else if (option.approachMinutes !== null && option.approachMinutes > 0) {
      // Already standing at this gateway, so nothing to travel — but the way
      // home is still the way we arrived at it.
      homeward ??= { mode: option.approachMode, minutes: option.approachMinutes };
    }
    // Only the name is carried forward here; the routing id is set from the
    // option's exit once the unit is done, which may not be the gateway.
    atName = gatewayLabel(option, members);

    // --- Entry legs: board, ride, walk in ----------------------------------
    for (const plan of option.entryLegs) {
      if (plan.role === 'wait' && option.service) {
        // You cannot board before the first departure. Waiting for it is real
        // time on the day, and pretending otherwise is how a 07:00 start turns
        // into a plan that leaves before the bus exists.
        const readyToBoard = cursor + plan.minutes;
        const boarding = Math.max(readyToBoard, option.service.window.firstDeparture);
        if (boarding > option.service.window.lastOutboundDeparture) {
          violations.push({
            kind: 'access',
            code: 'missed_last_outbound',
            message: `The last ${option.service.label} in leaves at ${formatMinuteOfDay(
              option.service.window.lastOutboundDeparture,
            )}, and this day does not reach the stop until ${formatMinuteOfDay(readyToBoard)}.`,
            ...(members[0] ? { placeId: members[0].place.id } : {}),
          });
        }
        const duration = boarding - cursor;
        if (duration > 0) {
          items.push({
            id: `travel-${day.dayNumber}-${sequence++}`,
            kind: 'travel',
            title: `Board the ${option.service.label}`,
            startMinute: cursor,
            endMinute: boarding,
            durationMinutes: duration,
            reason: plan.note ?? 'Ticket and wait for the next departure.',
            weatherSensitive: false,
            travel: {
              fromId: plan.fromId,
              toId: plan.toId,
              fromName: plan.fromName,
              toName: plan.toName,
              minutes: duration,
              km: 0,
              mode: plan.mode,
              role: 'wait',
              provenance: plan.provenance,
              serviceId: plan.serviceId,
            },
          });
          cursor = boarding;
          charge(plan.mode, 'wait', duration);
        }
        continue;
      }
      // The option was resolved for the whole unit, before the packer decided
      // which of its members the day could hold. Naming the walk after a stop
      // that then got dropped would put a place on the timeline the traveller
      // never visits, so the endpoint is taken from what is actually scheduled.
      cursor = pushLeg(
        items,
        plan.role === 'walk' && members[0]
          ? { ...plan, toId: members[0].place.id, toName: nameOf(members[0].place) }
          : plan,
        day.dayNumber,
        cursor,
        () => sequence++,
      );
      charge(plan.mode, plan.role, plan.minutes, plan.km);
    }

    // --- The reason you came -----------------------------------------------
    let previous: PlanningCandidate | null = null;
    for (const candidate of members) {
      /**
       * Everything is measured before anything is pushed.
       *
       * A stop that turns out to be shut must not leave a transfer leg pointing
       * at it, or a lunch eaten on the way to it, sitting on the timeline. So
       * the arrival time is computed through the transfer and through lunch, the
       * legality test runs against that, and only then is any of it committed.
       */
      /*
       * The mode follows the evidence for *this pair*, not the matrix's one mode.
       *
       * This branch hard-labelled every measured intra-unit hop `drive`, which
       * was true while only a road matrix ever reached the timeline. Then a
       * car-free trip began routing on the pedestrian network and the label
       * became `walk` — better, and still one mode for every hop of every day.
       * The consequence was never merely cosmetic: the minutes went to whichever
       * budget the label named, so a walking city day could spend a driving
       * budget the traveller does not have, and the terminal gate turns an
       * exceeded driving budget into a refusal.
       *
       * Now each hop is resolved on its own. Two stops a few minutes apart are a
       * walk; two stops across a city with a measured journey between them are
       * that journey. Both can happen on the same day, which is what a day in a
       * city actually looks like.
       */
      const matrixHopMode = matrixLegMode(matrix);
      const measured =
        previous && !option.service
          ? asHop(
              resolveDayLeg(previous.place.id, candidate.place.id, matrixHopMode, {
                driveMinutes,
              }),
            )
          : null;
      const transfer =
        measured !== null
          ? { mode: measured.mode, minutes: measured.minutes }
          : option.internalTransfer;
      const straightMinutes = previous && transfer.minutes > 0 ? transfer.minutes : 0;

      /**
       * Lunch, decided from where the traveller actually is and where they are
       * actually going next.
       *
       * A venue only gets to sit between two stops when the traveller is driving
       * themselves between them. Inside a shuttle-served unit there is no detour
       * to take: you are on somebody else's vehicle, and inventing a restaurant
       * stop on it would be inventing a road.
       */
      const canDetour = previous !== null && !option.service;
      const lunchFromId = previous?.place.id ?? atRoutingId;
      const lunchFromName = previous ? nameOf(previous.place) : atName;
      /**
       * Where the clock is when lunch becomes due depends on whether a venue is
       * going to sit between the two stops.
       *
       * With one, the traveller stops on the way and the question is asked from
       * where they are standing now. Without one, they drive straight there and
       * eat at the far end — which is what the planner has always done, and
       * asking too early would move every unvenued lunch forward by the length
       * of the transfer.
       */
      const viaVenue = canDetour ? planLunch(cursor, lunchFromId, candidate.place.id, true) : null;
      const planned: LunchPlanned =
        viaVenue?.kind === 'venue' ? viaVenue : planLunchInPlace(cursor + straightMinutes);

      // With a venue in the middle the onward leg starts from its door, so the
      // transfer that follows is a different journey from the one that would
      // have happened. Both the leg and its cost are recomputed, never assumed.
      const onward =
        planned.kind === 'venue' && canDetour
          ? asHop(
              resolveDayLeg(planned.resumeAt, candidate.place.id, matrixHopMode, {
                driveMinutes,
              }),
            )
          : null;
      /**
       * With no measured leg from the venue to the next stop there is no venue
       * lunch. Falling back to the straight-through minutes was worse than
       * useless: the leg was pushed *from the venue* carrying the distance and
       * the duration of a journey that started somewhere else.
       */
      const viaVenueUsable = planned.kind === 'venue' && canDetour && onward !== null;
      const finalPlan: LunchPlanned = viaVenueUsable
        ? planned
        : planned.kind === 'venue'
          ? planLunchInPlace(cursor + straightMinutes)
          : planned;
      const transferMinutes = viaVenueUsable ? onward!.minutes : straightMinutes;
      const arrival = viaVenueUsable
        ? cursor + finalPlan.minutes + transferMinutes
        : cursor + transferMinutes + finalPlan.minutes;

      // The real arrival, which is later than the one the pre-filter used and so
      // can still fail. Rare, and never leaves a leg pointing at nothing,
      // because the walk legs were named from the pre-filtered set — and never
      // leaves a lunch eaten on the way to somewhere the day never reaches.
      const placement = visitFor(context, candidate, arrival, bounds);
      if (!placement.ok) {
        violations.push(placement.violation);
        continue;
      }

      /**
       * The leg actually made, which is not always the leg that would have been
       * made without a stop for lunch in the middle of it.
       *
       * Its mode is its own. A hop straight on from the previous stop and a hop
       * on from a cafe are two different journeys between two different pairs of
       * points, and either one of them can be the walk while the other is the
       * train.
       */
      const pushTransfer = (
        fromId: string,
        fromName: string,
        minutes: number,
        hop: ResolvedHop | null,
      ): void => {
        if (minutes <= 0 || !previous) return;
        const mode = hop ? hop.mode : transfer.mode;
        const unverified = hop !== null && isUnverifiedScheduledJourney(hop);
        items.push({
          id: `travel-${day.dayNumber}-${sequence++}`,
          kind: 'travel',
          title: hop
            ? hopTitle(hop, `to ${nameOf(candidate.place)}`)
            : `${TRANSPORT_MODE_LABELS[mode]} to ${nameOf(candidate.place)}`,
          startMinute: cursor,
          endMinute: cursor + minutes,
          durationMinutes: minutes,
          /*
           * "A short hop" is a claim about a journey, and it is false about the
           * one leg here whose length nobody could establish. The unverified
           * sentence outranks both of the ordinary ones.
           */
          reason: unverified
            ? describeTransitBlindWalk(minutes, formatSpan)
            : fromId === previous.place.id
              ? 'Both sit inside the same access area, so this is a short hop.'
              : 'On from lunch to the next stop.',
          weatherSensitive: false,
          travel: {
            fromId,
            toId: candidate.place.id,
            fromName,
            toName: nameOf(candidate.place),
            minutes,
            /*
             * The distance of the journey that was actually made, or null when
             * there is not one. A ride carries null rather than zero: nobody
             * measured a road for it, and a zero here would render as "0 km"
             * beside a leg that plainly covered ground.
             */
            km: hop ? hop.km : null,
            mode,
            role: 'transfer',
            provenance: hop ? hop.provenance : 'estimated',
            ...unverifiedScheduledMark(hop),
          },
        });
        cursor += minutes;
        charge(mode, 'transfer', minutes, hop?.km ?? 0, unverified);
        if (mode === 'drive') vehicleAt = candidate.place.id;
      };

      if (viaVenueUsable && finalPlan.kind === 'venue') {
        // Reached by car and left by car: the transfer straight after it is the
        // same vehicle carrying on to the next stop.
        commitLunch(finalPlan, lunchFromId, lunchFromName, true);
        pushTransfer(finalPlan.resumeAt, finalPlan.choice.venue.name, transferMinutes, onward);
      } else {
        pushTransfer(lunchFromId, lunchFromName, transferMinutes, measured);
        commitLunch(finalPlan, candidate.place.id, nameOf(candidate.place), false);
      }

      // Turning up before the doors open does not get you in sooner. The gap is
      // shown rather than hidden, so nobody sets off at seven for a nine o'clock
      // opening believing the plan needed them to.
      if (placement.startMinute > cursor) {
        cursor = pushWaitForOpening(
          items,
          day.dayNumber,
          cursor,
          placement.startMinute,
          nameOf(candidate.place),
          placement.window?.openMinute ?? null,
        );
      }

      const place = candidate.place;
      const hours = context.hours.get(place.id);
      const evidence = scheduledHoursFrom(hours, placement.window);
      const booking = hours ? bookingFor(place, hours) : undefined;
      const weather = context.weather.get(place.id);
      const weatherEvidence = scheduledWeatherFrom(weather);
      items.push({
        id: `activity-${day.dayNumber}-${place.id}`,
        kind: 'activity',
        title: nameOf(place),
        startMinute: cursor,
        endMinute: cursor + candidate.durationMinutes,
        durationMinutes: candidate.durationMinutes,
        placeId: place.id,
        reason: reasonFor(candidate),
        // Was `weatherSensitivity === 'high'`, which fired on four places out of
        // twenty-three whatever the sky was doing. It now means what the badge
        // beside it says: the weather on *this* day works against *this* stop.
        weatherSensitive: isWeatherWorthFlagging(weather),
        physicalIntensity: place.physicalIntensity,
        ...(place.seasonalAccess.note ? { seasonalNote: place.seasonalAccess.note } : {}),
        ...(place.logisticsNote ? { accessWarning: place.logisticsNote } : {}),
        ...(evidence ? { hours: evidence } : {}),
        ...(booking ? { booking } : {}),
        ...(weatherEvidence ? { weather: weatherEvidence } : {}),
        ...(hours?.daylightOnly ? { daylightOnly: true } : {}),
        ...(hours?.daylightOnly && weather?.solar
          ? {
              daylight: {
                sunriseMinute: weather.solar.sunriseMinute,
                sunsetMinute: weather.solar.sunsetMinute,
                source: weather.solar.source,
              },
            }
          : {}),
        ...(hours?.requiresVerification && hours.verifyNote
          ? { verifyBeforeTravel: hours.verifyNote }
          : {}),
      });
      cursor += candidate.durationMinutes;
      activityMinutes += candidate.durationMinutes;
      previous = candidate;

      if (place.physicalIntensity === 'strenuous') {
        strenuousCount += 1;
        items.push({
          id: `rest-${day.dayNumber}-${place.id}`,
          kind: 'rest',
          title: 'Sit down for a bit',
          startMinute: cursor,
          endMinute: cursor + config.restAfterStrenuousMinutes,
          durationMinutes: config.restAfterStrenuousMinutes,
          reason: 'You will want it after that one.',
          weatherSensitive: false,
        });
        cursor += config.restAfterStrenuousMinutes;
      }
    }

    // --- Exit legs: walk out, wait, ride back -------------------------------
    for (const plan of option.exitLegs) {
      if (plan.role === 'return' && option.service) {
        // Waiting for the bus home is the same real time as waiting for it out,
        // and the entry side already charges for it. Charging it here too is
        // what stops the planner building a day that reaches the stop at exactly
        // the minute the last bus pulls away.
        const buffer = option.service.transferBufferMinutes;
        if (buffer > 0) {
          items.push({
            id: `travel-${day.dayNumber}-${sequence++}`,
            kind: 'travel',
            title: `Wait for the ${option.service.label}`,
            startMinute: cursor,
            endMinute: cursor + buffer,
            durationMinutes: buffer,
            reason: `Be at the stop before it leaves — the last one goes at ${formatMinuteOfDay(
              option.service.window.lastReturnDeparture,
            )}.`,
            weatherSensitive: false,
            travel: {
              fromId: plan.fromId,
              toId: plan.toId,
              fromName: plan.fromName,
              toName: plan.toName,
              minutes: buffer,
              km: 0,
              mode: plan.mode,
              role: 'wait',
              provenance: 'estimated',
              ...(plan.serviceId ? { serviceId: plan.serviceId } : {}),
            },
          });
          cursor += buffer;
          charge(plan.mode, 'wait', buffer);
        }

        // The one constraint that turns a pleasant afternoon into a night in the
        // woods. Checked against where the clock actually stands, not an estimate.
        if (cursor > option.service.window.lastReturnDeparture) {
          violations.push({
            kind: 'access',
            code: 'missed_last_return',
            message: `The last ${option.service.label} out leaves at ${formatMinuteOfDay(
              option.service.window.lastReturnDeparture,
            )} and this day does not reach the stop until ${formatMinuteOfDay(cursor)}.`,
            ...(previous ? { placeId: previous.place.id } : {}),
          });
        }
      }
      // The walk out starts from the last stop actually made, not from the last
      // stop the unit contains — the packer routinely takes a subset.
      cursor = pushLeg(
        items,
        plan.role === 'walk' && previous
          ? { ...plan, fromId: previous.place.id, fromName: nameOf(previous.place) }
          : plan,
        day.dayNumber,
        cursor,
        () => sequence++,
      );
      charge(plan.mode, plan.role, plan.minutes, plan.km);
    }

    /**
     * Where the traveller — and the car — actually stand now.
     *
     * `option.exitRoutingId` is computed over the *unit's* members, which is
     * right when you rode in and are back at the boarding point, and wrong when
     * you drove and the day took only some of the unit's stops: the onward drive
     * would then be measured from a place nobody went to, and the car recorded
     * as parked there. With a service the exit is the gateway either way.
     */
    const exitedFrom = option.service ? option.exitRoutingId : (previous?.place.id ?? option.exitRoutingId);
    atRoutingId = exitedFrom;
    atName = option.service ? option.gatewayName : previous ? nameOf(previous.place) : atName;
    /*
     * THE CAR MOVES WITH THE TRAVELLER ONLY IF IT CAME WITH THEM.
     *
     * This read `option.approachMode`, which is the mode the *access rule*
     * declares — not the mode the leg was actually laid in. The two part
     * whenever a shorter measured walk wins the approach (`resolvePlannerLeg`,
     * and the mode-switch policy beside it), and then the car was recorded as
     * having driven to a place the traveller walked to. A delivered road day
     * walked to two city squares and then "drove" from the second, with no leg
     * back to the vehicle anywhere in the day: not executable as printed, and
     * short by the walk nobody booked.
     *
     * `vehicleAt === option.gatewayRoutingId` is the fact itself rather than a
     * second opinion about it — the car is at the gateway only if a driven
     * approach put it there, which is exactly the branch above that writes it.
     */
    if (!option.service && vehicleAt === option.gatewayRoutingId) vehicleAt = exitedFrom;
  }

  /**
   * Dinner where the day actually ended, rather than back at base.
   *
   * Only when returning first would be a real backtrack — a stop forty minutes
   * south of town at six in the evening should eat in Bishop, not drive past
   * three restaurants to reach a fourth in Mammoth and then not drive back.
   * Below that threshold the traveller goes home first, which is what they would
   * do, and dinner is chosen from base a few lines further down.
   */
  /**
   * The car has to be where the traveller is standing before a meal out can be
   * a drive.
   *
   * A function rather than a value, and computed here rather than a hundred
   * lines further down, because both the route-end dinner and the dinner at
   * base need it and the first of them used to run without it: a day that rode
   * a trolley out and walked back had the traveller "driving" to a restaurant
   * from a stop the car was nowhere near, and then walking home from it on
   * minutes measured for a completely different journey.
   */
  const carIsToHand = () => !context.profile.transport.willDrive || vehicleAt === atRoutingId;

  /**
   * LUNCH AT THE END OF THE ROUTE, WHILE IT IS STILL LUNCHTIME.
   *
   * Lunch is offered before each unit and again once the traveller is back at
   * base, and between those two points sits a gap that a day with one long stop
   * on it falls straight into. The traveller is standing at their last stop at
   * 14:04, inside the lunch window, and nothing asks. The ride home then takes
   * thirty-four minutes, the fallback at base finds it is 14:38 — past
   * `lunch.latest` — and correctly refuses to put a block headed "Lunch" at that
   * hour. The day came back with no meal on it at all: six hours out,
   * `missing_meal_break` raised against it, and nothing able to answer, on a
   * traveller who had said food mattered to them.
   *
   * The refusal is right and stays. The missing question was the defect, and
   * asked here it can still be answered truthfully — lunch, at lunchtime, where
   * the traveller actually is.
   *
   * No onward id and `returnsToOrigin`, because the only journey left is the one
   * home: a venue here is a there-and-back from the last stop, which is what the
   * traveller would do, and it leaves the way home the leg it already was.
   */
  if (!lunchInserted && atRoutingId !== baseId && lunchDueAt(cursor)) {
    /**
     * Guarded by the way home, because this is the one meal decision with a
     * journey still to come after it.
     *
     * A lunch that pushed the return past the day's own end would not merely run
     * late: `foodFits` measures the whole food-bearing layout against
     * `latestFinishFor` and, when it overruns, drops *every* meal on the day. An
     * unguarded lunch here would therefore have cost a short departure day its
     * dinner as well. Bounded by both numbers the leg home can be charged at —
     * the allowance recorded on the way out and the leg re-resolved from where
     * the day has actually got to — because the home block below picks between
     * exactly those two and either can be the larger.
     */
    const homewardModes: readonly TransportMode[] = homeward
      ? matrix.mode === 'foot'
        ? [homeward.mode, 'walk']
        : [homeward.mode]
      : [matrixLegMode(matrix)];
    const wayHome = Math.max(
      homeward?.minutes ?? 0,
      asHop(resolveDayLeg(atRoutingId, baseId, homewardModes))?.minutes ?? 0,
    );
    const planned = carIsToHand()
      ? planLunch(cursor, atRoutingId, null, false)
      : planLunchInPlace(cursor);
    // The walk or drive back from a venue lands after the meal, so it is not in
    // the plan's own `minutes` and has to be added before the day is measured.
    const stopAndBack =
      planned.kind === 'venue' ? planned.minutes + planned.choice.approachMinutes : planned.minutes;
    if (planned.kind !== 'none' && cursor + stopAndBack + wayHome <= day.window.endMinute) {
      commitLunch(planned, atRoutingId, atName, false);
    }
  }

  let dinnerInserted = false;
  if (hasFood() && carIsToHand() && wantsSlot('dinner') && atRoutingId !== baseId) {
    const home = tryHop(matrix, atRoutingId, baseId);
    const wouldReachBase = cursor + (home?.minutes ?? 0) + config.bufferMinutes;
    if (
      home !== null &&
      home.minutes >= DINNER_AT_ROUTE_END_MINUTES &&
      wouldReachBase >= config.mealWindows.dinner.earliest
    ) {
      const stop = chooseFoodStop(foodRequest('dinner', atRoutingId, baseId, cursor, false));
      if (stop && stop.detourMinutes < home.minutes) {
        commitFood(stop, {
          title: stop.venue.name,
          reason: dinnerAtEndReason(stop, home.minutes),
          returnAfter: false,
          food: attachAlternatives(stop, 'dinner', atRoutingId),
          fromId: atRoutingId,
          fromName: atName,
        });
        dinnerInserted = true;
      }
    }
  }

  // --- Home ----------------------------------------------------------------
  if (atRoutingId !== baseId && homeward) {
    /**
     * Measured from where the traveller actually is, not from where they set off.
     *
     * `homeward` is the allowance recorded on the way out, and the way out
     * started at base and ended at the first gateway. By the time this runs the
     * day has moved: the return is a different pair of points, and reusing the
     * outbound number labels one journey with another journey's duration. That
     * is the same defect the driving branch fixed once already — "a leg read
     * 'from the bakery to Inyo Craters, 50 min' when the bakery is 26 minutes
     * away" — and it applies to a walk for exactly the same reason.
     *
     * So: re-resolve from where the traveller has actually got to, and fall back
     * to the stated allowance only when nothing can answer. The mode is resolved
     * with it rather than copied from the way out — a day that left base on a
     * train may be ending it three streets away.
     */
    /*
     * The mode out, plus the walk — never the road.
     *
     * `homeward` exists precisely because this day left base on something other
     * than a car, so admitting the matrix's mode wholesale would put a traveller
     * behind a wheel that is parked somewhere else, which is the defect the
     * vehicle-position rule exists to catch. A pedestrian matrix is different:
     * it measures this pair on foot, and a day that rode out and is now three
     * streets from base should walk. Adding it is also what keeps the fallback
     * below out of reach in the common case — that fallback is the *outbound*
     * journey's duration, and stamping it on the return is one pair answered
     * with another pair's number.
     */
    const homewardModes: TransportMode[] =
      matrix.mode === 'foot' ? [homeward.mode, 'walk'] : [homeward.mode];
    const measured = asHop(resolveDayLeg(atRoutingId, baseId, homewardModes));
    const back = measured
      ? {
          minutes: measured.minutes,
          km: measured.km,
          provenance: measured.provenance,
          mode: measured.mode,
        }
      : {
          minutes: homeward.minutes,
          km: null,
          provenance: 'estimated' as const,
          mode: homeward.mode,
        };
    items.push({
      id: `travel-${day.dayNumber}-${sequence++}`,
      kind: 'travel',
      title: measured
        ? hopTitle(measured, `back to ${baseName}`)
        : `${TRANSPORT_MODE_LABELS[back.mode]} back to ${baseName}`,
      startMinute: cursor,
      endMinute: cursor + back.minutes,
      durationMinutes: back.minutes,
      reason:
        measured && isUnverifiedScheduledJourney(measured)
          ? `${describeTransitBlindWalk(back.minutes, formatSpan)} — the longest the way back can take, and what the day holds for it.`
          : `${back.minutes} min back to ${baseName}.`,
      weatherSensitive: false,
      travel: {
        fromId: atRoutingId,
        toId: baseId,
        fromName: atName,
        toName: baseName,
        minutes: back.minutes,
        km: back.km,
        mode: back.mode,
        role: 'return',
        provenance: back.provenance,
        ...unverifiedScheduledMark(measured),
      },
    });
    cursor += back.minutes;
    charge(
      back.mode,
      'return',
      back.minutes,
      back.km ?? 0,
      measured !== null && isUnverifiedScheduledJourney(measured),
    );
  } else if (atRoutingId !== baseId) {
    const matrixHomeMode = matrixLegMode(matrix);
    const resolvedHome = resolveDayLeg(atRoutingId, baseId, matrixHomeMode);
    if (!resolvedHome.ok) {
      /**
       * NO LEG, AND A VIOLATION — WHICH IS WHAT KEEPS THE PACKER HONEST.
       *
       * An earlier version of this pushed an *unmeasured* leg here, so a day the
       * traveller could not be routed home from still showed the journey home
       * with "we could not time this" against it. That reads well and is
       * unreachable: `packDay` accepts a candidate set only when
       * `violations.length === 0`, so a set that cannot get home is rejected and
       * a smaller one is built instead. The leg could never appear in a plan,
       * and shipping a rendering path for it would have been a claim about
       * behaviour nothing could ever exercise.
       *
       * Worse, that version made the violation conditional on `conflict`, which
       * is false for the commonest case by far — a matrix with no cell for the
       * pair. The effect was not a missing warning but an inverted preference: a
       * stop was *accepted* precisely because the way back from it could not be
       * measured.
       *
       * So: no leg, and the violation unconditionally, with the two reasons kept
       * apart because they have different remedies. A conflict is the
       * traveller's to resolve; a missing measurement is ours.
       */
      violations.push(
        resolvedHome.conflict
          ? {
              kind: 'access',
              code: 'no_permitted_mode',
              message: `${resolvedHome.detail} (${atName} back to ${baseName}.)`,
            }
          : {
              kind: 'access',
              code: 'missing_travel_data',
              message: `No travel time is recorded from ${atName} back to ${baseName}.`,
            },
      );
    } else if (resolvedHome.minutes > 0) {
      /**
       * The way home is whatever this pair was measured at, in the mode the
       * traveller can actually use.
       *
       * This block asserted `mode: 'drive'` and charged the minutes to
       * `driveMinutes`. Then it asserted the matrix's mode, which was better and
       * still one mode for every day of every trip. It is now the resolved leg's
       * own mode, so a day that walked out and rides back says so.
       */
      const hop = resolvedHome;
      const isDrive = hop.mode === 'drive';
      const buffer = isDrive ? config.bufferMinutes : 0;
      const duration = hop.minutes + buffer;
      items.push({
        id: `travel-${day.dayNumber}-${sequence++}`,
        kind: 'travel',
        title: hopTitle(hop, `to ${baseName}`),
        startMinute: cursor,
        endMinute: cursor + duration,
        durationMinutes: duration,
        reason: approachReason(hop, buffer),
        weatherSensitive: false,
        travel: {
          fromId: atRoutingId,
          toId: baseId,
          fromName: atName,
          toName: baseName,
          minutes: hop.minutes,
          km: hop.km,
          mode: hop.mode,
          role: 'return',
          provenance: hop.provenance,
          ...unverifiedScheduledMark(hop),
        },
      });
      cursor += duration;
      charge(hop.mode, 'return', hop.minutes, hop.km ?? 0, isUnverifiedScheduledJourney(hop));
      if (isDrive) vehicleAt = baseId;
    }
  }

  /**
   * The traveller is home.
   *
   * This used to be left unsaid, and nothing read it — every leg after the last
   * unit was measured from the base id directly. The food layer is the first
   * thing to ask "where are you now?" after the homeward drive, and got the
   * trailhead: it picked a restaurant eighteen minutes from a car park the
   * traveller had left half an hour earlier, and then drove them back to it.
   */
  if (atRoutingId !== baseId) {
    atRoutingId = baseId;
    atName = baseName;
  }

  // Lunch never found a gap mid-route; give it one now if the clock allows —
  // and only while it is still lunchtime. `withinLunchWindow` guards this the
  // same way it guards the mid-route insertion, because this fallback is where
  // the 16:02 lunches were coming from: the route finished after the window and
  // the block was bolted on at whatever the cursor happened to be.
  if (
    !lunchInserted &&
    dayIsLongEnough &&
    wantsSlot('lunch') &&
    withinLunchWindow(cursor) &&
    cursor + config.unplannedMealMinutes.lunch <= day.window.endMinute
  ) {
    if (lunchIsPacked()) {
      /* The packed fallback is clamped for the same reason the bare one is. */
      const lunchStart = Math.max(cursor, config.mealWindows.lunch.earliest);
      if (lunchStart + PACKED_MEAL_MINUTES <= day.window.endMinute) {
        if (lunchStart > cursor) {
          cursor = pushFreeTime(items, day, config, cursor, lunchStart);
          cursor = Math.max(cursor, lunchStart);
        }
        commitPackedLunch();
      }
    } else {
      const late =
        hasFood() && carIsToHand()
          ? chooseFoodStop(foodRequest('lunch', atRoutingId, null, cursor, true))
          : null;
      if (late && late.startMinute + late.stopMinutes <= day.window.endMinute) {
        commitFood(late, {
          title: late.venue.name,
          reason: foodReason(late, 'lunch'),
          returnAfter: true,
          food: attachAlternatives(late, 'lunch', atRoutingId),
          fromId: atRoutingId,
          fromName: atName,
        });
      } else {
        /**
         * Clamped into the lunch window, never bolted on wherever the morning
         * happened to end. This branch used to push the block at the bare
         * cursor with "Late, but better than skipping it" — and on a light day
         * whose route was done by 09:20 that printed a *breakfast-hour* block
         * labelled lunch, apologising for a lateness that had not happened.
         * The window is the product's own definition of when lunch is lunch;
         * a block outside it is a different meal wearing the name.
         */
        const lunchStart = Math.max(cursor, config.mealWindows.lunch.earliest);
        if (lunchStart + config.unplannedMealMinutes.lunch <= day.window.endMinute) {
          if (lunchStart > cursor) {
            cursor = pushFreeTime(items, day, config, cursor, lunchStart);
            cursor = Math.max(cursor, lunchStart);
          }
          cursor = pushUnnamedMeal('lunch', cursor, {
            title: 'Lunch',
            reason:
              cursor > config.mealWindows.lunch.latest
                ? 'Late, but better than skipping it.'
                : 'Time held inside the lunch window rather than somewhere named.',
            areaReason: areaReasonFor('lunch'),
          });
        }
      }
    }
  }

  if (!dinnerInserted && wantsSlot('dinner') && day.window.endMinute >= config.mealWindows.dinner.earliest) {
    // The guard belongs on the venue, not on the whole block. It used to wrap
    // both, so a day whose car ended up elsewhere got no dinner row at all —
    // not even the held hour every version-5 plan gave it.
    const stop = hasFood() && carIsToHand()
      ? chooseFoodStop(
          foodRequest('dinner', atRoutingId, null, Math.max(cursor, config.mealWindows.dinner.earliest), true),
        )
      : null;
    if (
      stop &&
      stop.startMinute + stop.stopMinutes + stop.approachMinutes <=
        day.window.endMinute + config.mealOverrunAllowanceMinutes
    ) {
      if (stop.startMinute - stop.approachMinutes > cursor) {
        cursor = pushFreeTime(items, day, config, cursor, stop.startMinute - stop.approachMinutes);
      }
      commitFood(stop, {
        title: stop.venue.name,
        reason: foodReason(stop, 'dinner'),
        returnAfter: true,
        food: attachAlternatives(stop, 'dinner', atRoutingId),
        fromId: atRoutingId,
        fromName: atName,
      });
    } else if (
      /**
       * The overrun allowance the venue branch and the validator both grant,
       * granted here too. Without it an arrival day whose window closed at
       * seven could hold a named restaurant but not a bare hour for dinner —
       * so the traveller with a 19:00 evening and no verified venue got no
       * dinner row at all, while a day one street over kept one. An evening
       * meal is the one thing a traveller carries on past the window, and the
       * validator's ceiling has said so all along.
       */
      cursor + config.unplannedMealMinutes.dinner <=
      day.window.endMinute + config.mealOverrunAllowanceMinutes
    ) {
      const dinnerStart = Math.max(cursor, config.mealWindows.dinner.earliest);
      if (
        dinnerStart + config.unplannedMealMinutes.dinner <=
        day.window.endMinute + config.mealOverrunAllowanceMinutes
      ) {
        if (dinnerStart > cursor) {
          cursor = pushFreeTime(items, day, config, cursor, dinnerStart);
        }
        cursor = pushUnnamedMeal('dinner', cursor, {
          title: 'Dinner',
          reason: hasFood()
            ? 'Nothing verified was open and near enough at this hour, so this is time held for dinner rather than somewhere named.'
            : 'Back at base, nothing booked.',
          areaReason: areaReasonFor('dinner'),
        });
      }
    }
  }

  cursor = pushFreeTime(items, day, config, cursor, day.window.endMinute);

  const freeMinutes = items
    .filter((item) => item.kind === 'free_time')
    .reduce((sum, item) => sum + item.durationMinutes, 0);

  return {
    items,
    endMinute: cursor,
    activityMinutes,
    /*
     * Still every minute the day reserves for getting somewhere, unverified
     * legs included — they cost the traveller the same hours whether or not
     * anybody could price them, and a budget checked against a smaller number
     * would be checking a day that does not exist.
     */
    travelMinutes: driveMinutes + transitMinutes + walkMinutes + waitMinutes + unverifiedMinutes,
    driveMinutes,
    transitMinutes,
    walkMinutes,
    waitMinutes,
    unverifiedMinutes,
    travelKm: Math.round(travelKm * 10) / 10,
    freeMinutes,
    strenuousCount,
    violations,
    modes,
  };
}

function pushLeg(
  items: ItineraryItem[],
  plan: AccessLegPlan,
  dayNumber: number,
  cursor: number,
  nextSequence: () => number,
): number {
  if (plan.minutes <= 0) return cursor;
  items.push({
    id: `travel-${dayNumber}-${nextSequence()}`,
    kind: 'travel',
    title: legTitle(plan),
    startMinute: cursor,
    endMinute: cursor + plan.minutes,
    durationMinutes: plan.minutes,
    reason: plan.note ?? `${plan.minutes} min ${TRANSPORT_MODE_LABELS[plan.mode].toLowerCase()}.`,
    weatherSensitive: false,
    travel: {
      fromId: plan.fromId,
      toId: plan.toId,
      fromName: plan.fromName,
      toName: plan.toName,
      minutes: plan.minutes,
      km: plan.km,
      mode: plan.mode,
      role: plan.role,
      provenance: plan.provenance,
      ...(plan.serviceId ? { serviceId: plan.serviceId } : {}),
    },
  });
  return cursor + plan.minutes;
}

function legTitle(plan: AccessLegPlan): string {
  switch (plan.role) {
    case 'walk':
      return `Walk to ${plan.toName}`;
    case 'ride':
      return `Ride to ${plan.toName}`;
    case 'return':
      return `Ride back to ${plan.toName}`;
    case 'transfer':
      return `Transfer to ${plan.toName}`;
    default:
      return `${TRANSPORT_MODE_LABELS[plan.mode]} to ${plan.toName}`;
  }
}

function gatewayLabel(option: AccessOption, members: readonly PlanningCandidate[]): string {
  if (option.service) return option.gatewayName;
  return members[0] ? nameOf(members[0].place) : option.gatewayName;
}

/**
 * Where a food leg's duration came from.
 *
 * `food.ts` reads the leg straight off the matrix and no longer converts between
 * modes, so the answer is simply whether the matrix covers the way the traveller
 * is getting there. The old expression tested `=== 'drive'` and called everything
 * else estimated — which mislabelled a genuinely measured walk in a pedestrian
 * region as a guess, in the one place a traveller is most likely to check.
 */
function foodLegProvenance(
  matrix: TravelTimeMatrix,
  mode: 'drive' | 'walk',
): 'measured' | 'modelled' | 'estimated' {
  return matrixCoversMode(matrix, mode) ? matrix.provenance.kind : 'estimated';
}

/**
 * Which mode the matrix in hand is entitled to answer for.
 *
 * One statement of it rather than the four copies of `matrix.mode === 'foot' ? …`
 * this file grew, because the four were not always passed the same thing and one
 * of them was passing the traveller's outbound mode instead.
 */
function matrixLegMode(matrix: TravelTimeMatrix): TransportMode {
  return matrix.mode === 'foot' ? 'walk' : 'drive';
}

/**
 * A resolved leg, once the "we could not answer" case has been handled.
 *
 * Narrowing rather than a second type, so there is no way to construct one that
 * did not come out of `resolveLeg`.
 */
type ResolvedHop = PlannerResolvedLeg & { ok: true };

function asHop(resolved: PlannerResolvedLeg): ResolvedHop | null {
  return resolved.ok ? resolved : null;
}

/**
 * WHAT A LEG IS CALLED, WHERE THE MEASURED MODE IS NOT THE MODE IT IS MADE IN.
 *
 * Every other leg is named by its mode, because its mode is the truth. One is
 * not: a journey through a served city whose scheduled network nobody could
 * time is priced on the only network anybody measured — the pedestrian one —
 * and naming it by that mode instructs a walk the traveller was never going to
 * take. Two live car-free itineraries shipped rows reading "Walk to X — 67 min
 * on foot" on exactly that arithmetic.
 *
 * So the one leg the resolver marks `transit_unverified` gets a mode-free
 * heading, and `approachReason` gives it the sentence this product already
 * mints for the state. Nothing here invents a train: the duration is still the
 * walk, and the sentence still says so.
 */
function hopTitle(hop: ResolvedHop, phrase: string): string {
  return isUnverifiedScheduledJourney(hop)
    ? `Travel ${phrase}`
    : `${TRANSPORT_MODE_LABELS[hop.mode]} ${phrase}`;
}

/**
 * THE SAME FACT, CARRIED ON THE LEG RATHER THAN LEFT IN THE TITLE.
 *
 * A mode-free heading was the whole of the previous repair, and a heading is
 * one string on one row. The chip beside it still read WALK, the accumulator
 * still charged `walkMinutes`, and the validator — which re-derives the totals
 * off the stored timeline — had nothing to re-derive them from. Every one of
 * those reads the stored leg, so the stored leg is where the fact belongs.
 *
 * Spread into the segment at each site rather than set by a wrapper, because
 * the sites build their segments from different sources and a wrapper that
 * accepted all of them would be a second constructor for the same object.
 */
function unverifiedScheduledMark(hop: ResolvedHop | null): { unverifiedScheduled?: true } {
  return hop !== null && isUnverifiedScheduledJourney(hop) ? { unverifiedScheduled: true } : {};
}

/**
 * What the traveller is told a leg is, in the mode it is actually made in.
 *
 * One sentence per family rather than per mode, because "on the road" and "on
 * foot" are the two the traveller has to tell apart to know whether to park, and
 * a ride is a ride whether it is a bus or a train — the mode chip beside it
 * already says which. The departure basis is named on a scheduled leg because a
 * timetabled duration is only an answer to a particular time of day.
 */
function approachReason(hop: PlannerResolvedLeg & { ok: true }, buffer: number): string {
  /*
   * Asked before the mode, because on this one leg the mode is the stand-in and
   * not the story. `describeTransitBlindWalk` is core's own sentence for it —
   * reused rather than restated, so the board and the timeline cannot come to
   * describe the same gap two different ways.
   */
  if (isUnverifiedScheduledJourney(hop)) {
    /*
     * Named as the bound it is, because the figure is the only real number on
     * the row and a reader has to know which question it answers. It is not how
     * long the journey takes and it is not an instruction to walk it: it is the
     * longest this can cost, and the day reserves exactly that.
     */
    return `${describeTransitBlindWalk(hop.minutes, formatSpan)} — the longest this journey can take, and what the day holds for it.`;
  }
  if (hop.mode === 'drive') {
    return `${hop.minutes} min on the road, plus ${buffer} min to park and get going.`;
  }
  if (hop.mode === 'walk') {
    /*
     * A derived walk says it is one. "Measured between the two points" over a
     * figure computed from a road distance would be the exact provenance lie
     * the leg's own `modelled` label exists to prevent — and the reason string
     * is the copy a traveller actually reads.
     */
    if (hop.provenance === 'modelled') {
      return `About ${hop.minutes} min on foot — estimated from the road distance, since nobody has measured this walk.`;
    }
    return `${hop.minutes} min on foot, measured between the two points.`;
  }
  if (hop.provenance === 'official') {
    const transfers =
      hop.transfers === undefined || hop.transfers === 0
        ? 'direct'
        : `${hop.transfers} change${hop.transfers === 1 ? '' : 's'}`;
    return `${hop.minutes} min on public transport, ${transfers}, off the published timetable for a mid-morning departure.`;
  }
  return `${hop.minutes} min to get there.`;
}

function tryHop(
  matrix: TravelTimeMatrix,
  fromId: string,
  toId: string,
): { minutes: number; km: number } | null {
  try {
    return leg(matrix, fromId, toId);
  } catch {
    return null;
  }
}

function pushFreeTime(
  items: ItineraryItem[],
  day: PlannedDay,
  config: PlannerConfig,
  from: number,
  to: number,
): number {
  const span = to - from;
  if (span < config.minFreeTimeBlockMinutes) return from;
  items.push({
    id: `free-${day.dayNumber}-${from}`,
    kind: 'free_time',
    title: 'Free time',
    startMinute: from,
    endMinute: to,
    durationMinutes: span,
    /**
     * A very long block owes a different sentence. "Deliberately unbooked"
     * over eight open hours reads as a shrug — a stored plan actually carried
     * a 7 h 55 m block wearing it. By the time this runs, the overflow pass
     * has already offered every unplaced pick to every day with room, so a
     * stretch this long means the board's remaining supply genuinely could
     * not be reached or fitted here — and saying that is the honest version.
     */
    reason:
      span > 180
        ? 'A long open stretch. Everything else you picked is already placed, out of reach on this day, or would not fit — so the time stays yours rather than being filled for the sake of it.'
        : 'Deliberately unbooked. A plan with no slack in it is a plan that breaks.',
    weatherSensitive: false,
  });
  return to;
}

/**
 * The gap between getting there and being let in.
 *
 * Shown rather than swallowed: a hole in the timeline reads as a mistake, and
 * hiding the wait would leave the traveller unable to see that leaving half an
 * hour later costs them nothing. Not subject to the free-time minimum, because
 * this block exists to explain an adjacency rather than to offer a rest.
 */
function pushWaitForOpening(
  items: ItineraryItem[],
  dayNumber: number,
  from: number,
  to: number,
  placeName: string,
  openMinute: number | null,
): number {
  const span = to - from;
  if (span <= 0) return from;
  items.push({
    id: `open-wait-${dayNumber}-${from}`,
    kind: 'free_time',
    title: `Time before ${placeName} opens`,
    startMinute: from,
    endMinute: to,
    durationMinutes: span,
    reason:
      openMinute === null
        ? 'A gap before the next stop can start.'
        : `${placeName} opens at ${formatMinuteOfDay(openMinute)}. Getting there earlier does not get you in sooner.`,
    weatherSensitive: false,
  });
  return to;
}

/**
 * The evidence a visit was placed against, carried onto the item so a stored
 * plan can explain itself and a validator can check it. Absent for a place with
 * no hours to respect — an empty badge on a roadside viewpoint is noise.
 */
function scheduledHoursFrom(
  hours: PlaceDayHours | undefined,
  window: { openMinute: number; closeMinute: number; lastAdmissionMinute: number | null } | null,
): ScheduledHours | undefined {
  if (!hours || !window) return undefined;
  return {
    openMinute: window.openMinute,
    closeMinute: window.closeMinute,
    ...(window.lastAdmissionMinute !== null
      ? { lastAdmissionMinute: window.lastAdmissionMinute }
      : {}),
    ...(hours.periodLabel ? { periodLabel: hours.periodLabel } : {}),
    sourceKind: hours.provenance.kind,
    sourceName: hours.provenance.sourceName,
    ...(hours.provenance.sourceUrl ? { sourceUrl: hours.provenance.sourceUrl } : {}),
    ...(hours.provenance.lastVerified ? { lastVerified: hours.provenance.lastVerified } : {}),
    confidence: hours.provenance.confidence,
  };
}

/**
 * A booking the traveller has to make themselves. Never resolved here: the plan
 * hands back the requirement and the official link, and says nothing that could
 * be read as "this is arranged".
 */
function bookingFor(place: Place, hours: PlaceDayHours): BookingRequirement | undefined {
  const { admission } = hours;
  const kind = admission.timedEntry
    ? 'timed_entry'
    : admission.reservationRequired
      ? 'reservation'
      : admission.permitRequired
        ? 'permit'
        : null;
  if (!kind) return undefined;
  return {
    placeId: place.id,
    name: nameOf(place),
    kind,
    ...(admission.note ? { note: admission.note } : {}),
    ...(admission.bookingUrl ? { url: admission.bookingUrl } : {}),
  };
}

function mealItem(
  dayNumber: number,
  title: string,
  start: number,
  minutes: number,
  reason: string,
): ItineraryItem {
  return {
    id: `meal-${dayNumber}-${title.toLowerCase()}-${start}`,
    kind: 'meal',
    title,
    startMinute: start,
    endMinute: start + minutes,
    durationMinutes: minutes,
    reason,
    weatherSensitive: false,
  };
}

/**
 * Below this, going home first is what anybody would do, so dinner waits until
 * they are back rather than being taken on the way. Twenty-five minutes is the
 * point where the return leg stops being incidental and starts being a decision.
 */
const DINNER_AT_ROUTE_END_MINUTES = 25;

/**
 * Below this, a wait outside a closed door is not worth a row of its own.
 *
 * Lower than the free-time threshold on purpose: half an hour of unbooked
 * afternoon is a gift and worth naming, whereas ten minutes outside a brewery
 * that opens at noon is an explanation for why the next row does not start
 * immediately, and leaving that unexplained reads as a hole in the timeline.
 */
const FOOD_WAIT_BLOCK_MINUTES = 10;

/**
 * Why this meal, here.
 *
 * One clause per branch, and each branch ends where its clause ends — the rule
 * the backup copy already lives by, because anything that appends further words
 * to one of these produces half a sentence. Never prints a score.
 */
function foodReason(choice: FoodChoice, slot: MealSlot, unrequested = false): string {
  /**
   * The uncertainty travels with the name, on the row that carries the name.
   *
   * Said once and here, rather than in a second block under the row: the day
   * summary already refuses to reprint what a meal row says, and a reader who
   * meets the same sentence twice a centimetre apart learns to skip both. What
   * this cannot say is an opening time, because there is not one — the sentence
   * is the venue's own record verbatim, and the instruction after it is the
   * recheck note that record carries.
   */
  const caution = choice.food.hoursUnknown
    ? ' Nobody publishes hours for it that we could read, so check before you go.'
    : '';
  return `${namedFoodReason(choice, slot, unrequested)}${caution}`;
}

function namedFoodReason(choice: FoodChoice, slot: MealSlot, unrequested: boolean): string {
  const venue = choice.venue;
  if (choice.food.isSpecialMeal) {
    return `Your one meal on this trip that is meant to be an event, and the route already comes this way.`;
  }
  if (slot === 'breakfast') {
    if (unrequested) {
      return choice.detourMinutes === 0
        ? `You said you skip breakfast, so this is a stop rather than a meal — it is on the way out and adds nothing to the drive.`
        : `You said you skip breakfast, so take this or leave it. It is ${choice.detourMinutes} min out of the way in the model, before a long day.`;
    }
    return choice.detourMinutes === 0
      ? `On the way out, so it costs the morning nothing.`
      : `${choice.detourMinutes} min out of the way in the model, on the way to the first stop.`;
  }
  if (venue.localSpecialty) {
    return choice.detourMinutes === 0
      ? `${venue.localSpecialty.label} — what this place is actually known for, and it is right on the route.`
      : `${venue.localSpecialty.label} — what this place is actually known for, for ${choice.detourMinutes} min off the route.`;
  }
  if (choice.routeContext === 'on_route') {
    return `Where the day already is, so this costs no extra driving.`;
  }
  if (choice.routeContext === 'at_base') {
    return `A short hop from where you are staying, after the day is done.`;
  }
  return choice.food.hoursUnknown
    ? `${choice.detourMinutes} min off the route in the model, and the closest thing that fits how you said you wanted to eat.`
    : `${choice.detourMinutes} min off the route in the model, which is the closest thing that was open and fits how you said you wanted to eat.`;
}

function dinnerAtEndReason(choice: FoodChoice, homeMinutes: number): string {
  return `Eaten where the day ended rather than driving the ${homeMinutes} min back to base first and coming out again.`;
}

function reasonFor(candidate: PlanningCandidate): string {
  if (candidate.manual) return 'You picked this one yourself, so it was placed first.';
  if (candidate.selectionStatus === 'maybe') return 'A maybe from your board that fitted the day.';
  const interest = candidate.primaryInterest;
  return interest
    ? `Matches your interest in ${INTEREST_LABELS[interest].toLowerCase()}.`
    : 'A strong fit for how you said you travel.';
}

/**
 * Greedy packing by priority, over access units rather than loose places.
 *
 * Each candidate is added, the whole day is re-ordered and re-laid-out, and it
 * is kept only if the result still fits every constraint — including the access
 * ones, which is the part an estimate cannot answer. Expensive in theory,
 * trivial at a handful of stops a day, and it means a day can never be declared
 * valid on an arithmetic that the timeline then contradicts.
 */
export interface PackResult {
  accepted: PlanningCandidate[];
  overflow: PlanningCandidate[];
}

export interface PackOptions {
  maxActivities: number;
  maxDailyDriveMinutes: number;
  maxDailyTransportMinutes: number;
  maxStrenuous: number;
  /** Unit key → the legal way in on this day, if any. */
  accessByUnit: ReadonlyMap<string, AccessOption>;
  /** Which unit each place belongs to. */
  unitByPlaceId: ReadonlyMap<string, AccessUnit>;
}

/**
 * HOW LATE THE DAY THIS LAYOUT DESCRIBES IS ALLOWED TO FINISH.
 *
 * The window bounds what the planner *schedules*; the evening meal, and getting
 * home from it, is the one thing carried past that line. `layoutDay` grants that
 * overrun when it places the meal, and `validateItinerary` grants it again when
 * it checks the finished day — the packer granted it to neither, and measured
 * every layout against the bare window.
 *
 * That went unnoticed while only a *named* restaurant could use the allowance,
 * because packing runs with `food: null` and never sees one. The moment the held
 * dinner hour was allowed the same overrun, the packer started charging it to
 * the traveller's stop: a day whose only minute past the window was a block of
 * held dinner time was declared not to fit, and the candidate that led to it
 * went into overflow. It then spilled onto whatever day would take it, which is
 * how a viewpoint fifteen minutes up a spur road ended up on the day that drives
 * ninety-five minutes down the valley, lengthening the approach by the spur.
 *
 * Read the same way the validator reads it — last meal of the evening onward,
 * meals and travel only — so the packer can never offer a day the validator will
 * reject, nor refuse one it would have passed.
 *
 * Exported because the food layer needs the same ceiling. `planTrip` lays each
 * day out twice, plain and with the meals on, and the second layout is the one
 * thing in the planner that is never packed — so nothing measured it against the
 * clock, and a breakfast that shifted a departure-day return drive one minute
 * past the window produced a plan the validator then refused outright. Three
 * readers of one definition; a fourth would be a fourth chance to disagree.
 */
export function latestFinishFor(
  day: PlannedDay,
  config: PlannerConfig,
  layout: DayLayout,
): number {
  const last = layout.items.at(-1);
  if (!last || (last.kind !== 'meal' && last.kind !== 'travel')) return day.window.endMinute;
  const lastMealStart = layout.items
    .filter(
      (item) => item.kind === 'meal' && item.startMinute >= config.mealWindows.dinner.earliest,
    )
    .at(-1)?.startMinute;
  return lastMealStart !== undefined && last.startMinute >= lastMealStart
    ? day.window.endMinute + config.mealOverrunAllowanceMinutes
    : day.window.endMinute;
}

// The slack floor exists to stop a day being crammed, so it only guards the
// third stop onward. Applying it from the first would do the opposite of what
// it is for: it would veto pairing two stops that sit on the same road and
// leave the traveller driving an hour each way for a single afternoon.
const SLACK_APPLIES_FROM_STOP = 3;

/**
 * WHY THIS STOP CANNOT JOIN THIS DAY — or `null` when it can.
 *
 * The whole of a day's acceptance, in one place: the four things a stop can be
 * wrong about before the day is even laid out (no slot left, shut that day, no
 * confirmed way in, one strenuous walk too many) and the six the layout decides
 * (the clock, the day's capacity, the driving cap, the transport cap, an
 * outright illegality, and the free time the traveller's pace asks for).
 *
 * Extracted from `packDay`, unchanged, because `packDay` was not the only thing
 * that needed it and was the only thing that had it. The editing surface lays a
 * day out with `layoutBestOrder` — which is deliberately limit-free, since
 * packing is what owns the limits — and so every one of these tests was skipped
 * on an edit: a swap could put a day forty minutes over the traveller's own
 * driving cap, or land the drive home an hour after the day was supposed to
 * end, and the plan was saved. Two callers, one definition, one answer.
 *
 * Returns the reason rather than a boolean so a refusal can say which limit it
 * is: "that will not fit" is not an answer a traveller can act on.
 */
export function admissionRefusal(
  context: LayoutContext,
  accepted: readonly PlanningCandidate[],
  candidate: PlanningCandidate,
  options: PackOptions,
): string | null {
  const { day } = context;
  const slackFloor = day.isEdgeDay ? 0 : context.config.minFreeMinutesByPace[context.profile.pace];

  if (accepted.length >= options.maxActivities) {
    return `Day ${day.dayNumber} already holds the ${options.maxActivities} stop${options.maxActivities === 1 ? '' : 's'} a day gets at the pace you chose.`;
  }
  if (!isOpenOnDate(candidate.place, day.date)) {
    return `${nameOf(candidate.place)} is not open on day ${day.dayNumber}.`;
  }
  const unit = options.unitByPlaceId.get(candidate.place.id);
  if (!unit || !options.accessByUnit.has(unit.key)) {
    return `We have no way we can confirm of getting to ${nameOf(candidate.place)} on day ${day.dayNumber}.`;
  }
  const strenuousSoFar = accepted.filter(
    (item) => item.place.physicalIntensity === 'strenuous',
  ).length;
  if (candidate.place.physicalIntensity === 'strenuous' && strenuousSoFar >= options.maxStrenuous) {
    return `Day ${day.dayNumber} already has as much hard walking on it as you asked for.`;
  }

  const tentative = [...accepted, candidate];
  const { layout } = layoutBestOrder(context, tentative, options);

  const latestFinish = latestFinishFor(day, context.config, layout);
  if (layout.endMinute > latestFinish) {
    return `With ${nameOf(candidate.place)} on it, day ${day.dayNumber} does not end until ${formatMinuteOfDay(layout.endMinute)}, past the ${formatMinuteOfDay(latestFinish)} the day allows.`;
  }
  if (layout.activityMinutes + layout.travelMinutes > day.capacityMinutes) {
    return `Day ${day.dayNumber} does not have the hours for ${nameOf(candidate.place)} as well as what is already on it.`;
  }
  if (layout.driveMinutes > options.maxDailyDriveMinutes) {
    return `With ${nameOf(candidate.place)} on it, day ${day.dayNumber} has ${layout.driveMinutes} min at the wheel, past the ${options.maxDailyDriveMinutes} min you set.`;
  }
  if (layout.travelMinutes > options.maxDailyTransportMinutes) {
    return `With ${nameOf(candidate.place)} on it, day ${day.dayNumber} spends ${layout.travelMinutes} min getting about, past the ${options.maxDailyTransportMinutes} min you set.`;
  }
  // Covers both kinds of illegality: no way out, and no way in through the
  // door. A day with either is never offered.
  if (layout.violations.length > 0) return layout.violations[0]!.message;
  const requiredFree = tentative.length >= SLACK_APPLIES_FROM_STOP ? slackFloor : 0;
  if (layout.freeMinutes < requiredFree) {
    return `Adding ${nameOf(candidate.place)} would leave day ${day.dayNumber} ${layout.freeMinutes} min of free time, under the ${requiredFree} min your pace asks for.`;
  }
  return null;
}

export function packDay(
  context: LayoutContext,
  available: readonly PlanningCandidate[],
  options: PackOptions,
): PackResult {
  const accepted: PlanningCandidate[] = [];
  const overflow: PlanningCandidate[] = [];

  for (const candidate of available) {
    if (admissionRefusal(context, accepted, candidate, options) === null) {
      accepted.push(candidate);
    } else {
      overflow.push(candidate);
    }
  }

  return { accepted, overflow };
}

/**
 * Comparing deadlines, including the `Infinity` most places have.
 *
 * `Infinity - Infinity` is `NaN`, and a comparator that returns `NaN` produces
 * an implementation-defined order — which in a planner that promises byte-identical
 * output for identical input is not a style problem.
 */
function byDeadline(a: number, b: number): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** When this stop must have started by, on this day. `Infinity` if it never shuts. */
function latestStartFor(context: LayoutContext, candidate: PlanningCandidate): number {
  return latestStartOn(context.hours.get(candidate.place.id), candidate.durationMinutes);
}

/**
 * One legality test for a stop, used by both the pre-filter and the real
 * placement so the two can never come to different conclusions.
 *
 * The missing-record branch is unreachable through the provider boundary, which
 * refuses a dataset that leaves a place out. It exists because refusing is the
 * safe way to be wrong: the alternative is scheduling on hours nobody holds.
 */
function visitFor(
  context: LayoutContext,
  candidate: PlanningCandidate,
  arrivalMinute: number,
  bounds: MinuteInterval,
): { ok: true; startMinute: number; window: OpeningWindowOnDate | null } | { ok: false; violation: LayoutViolation } {
  const hours = context.hours.get(candidate.place.id);
  if (!hours) {
    return {
      ok: false,
      violation: {
        kind: 'hours',
        code: 'no_window_in_reach',
        message: `We hold no opening-hours record for ${nameOf(candidate.place)}, so we will not put it on a day.`,
        placeId: candidate.place.id,
      },
    };
  }

  /**
   * Daylight, folded in before the opening hours are consulted.
   *
   * A place signed sunrise-to-sunset has a closing time like any other; the
   * only difference is that nobody prints it, so it has to be computed. Doing
   * it here rather than at one of the two call sites means the pre-filter and
   * the real placement cannot disagree — which is the same reason `visitFor`
   * exists at all.
   *
   * `narrowByDaylight` returns the original bounds untouched when there is no
   * solar record: an uncomputed sunset must not shrink anything, because "we
   * did not work out the light" is not "the light runs out".
   */
  const daylit = narrowByDaylight(
    bounds,
    context.weather.get(candidate.place.id),
    hours.daylightOnly,
  );
  if (!daylit) {
    return {
      ok: false,
      violation: {
        kind: 'hours',
        code: 'no_window_in_reach',
        message: `${nameOf(candidate.place)} is signed for daylight use only, and there is no daylight left inside what the rest of this day allows.`,
        placeId: candidate.place.id,
      },
    };
  }

  const placement = placeVisit({
    hours,
    placeName: nameOf(candidate.place),
    arrivalMinute,
    durationMinutes: candidate.durationMinutes,
    bounds: daylit,
  });
  return placement.ok
    ? { ok: true, startMinute: placement.startMinute, window: placement.window }
    : {
        ok: false,
        violation: {
          kind: 'hours',
          code: placement.code,
          message: placement.message,
          placeId: candidate.place.id,
        },
      };
}

/** The earliest this stop opens today, or null when it has no opening time. */
function openingMinuteFor(
  context: LayoutContext,
  candidate: PlanningCandidate | undefined,
): number | null {
  if (!candidate) return null;
  const hours = context.hours.get(candidate.place.id);
  if (!hours || hours.status !== 'open' || hours.windows.length === 0) return null;
  return Math.min(...hours.windows.map((window) => window.openMinute));
}

/**
 * Lays the day out and, if the road order breaks somebody's opening hours,
 * tries the one alternative worth trying.
 *
 * The shortest route is not the right route when it arrives after closing. But
 * a general constrained-ordering search is both slow and a good way to produce a
 * day that zig-zags across a valley to save four minutes at a gate, so the
 * choice is deliberately between exactly two candidate orders:
 *
 *   1. **road order** — the existing behaviour, and what nearly every day uses.
 *   2. **deadline order** — earliest closing time first, road order breaking
 *      ties. Only reached when the first produced a violation.
 *
 * The first legal one wins; if neither is legal the first is returned, so the
 * violations that get reported are the ones from the plan the traveller would
 * otherwise have been handed. Two fixed orders, evaluated in a fixed sequence:
 * the result is deterministic and there is no search to oscillate.
 */
export function layoutBestOrder(
  context: LayoutContext,
  candidates: readonly PlanningCandidate[],
  options: Pick<PackOptions, 'accessByUnit' | 'unitByPlaceId'>,
): { scheduled: ScheduledUnit[]; layout: DayLayout } {
  const byRoad = scheduleUnits(context, candidates, options);
  const first = layoutDay(context, byRoad);
  if (first.violations.length === 0) {
    return preferByHourlyWeather(context, byRoad, first);
  }

  const byClosing = orderByDeadline(context, byRoad);
  if (sameOrder(byRoad, byClosing)) return { scheduled: byRoad, layout: first };

  const second = layoutDay(context, byClosing);
  return second.violations.length === 0
    ? preferByHourlyWeather(context, byClosing, second)
    : { scheduled: byRoad, layout: first };
}

/**
 * The third fixed order, and the only one weather is allowed to propose.
 *
 * On a summer afternoon in the Sierra the difference between starting an exposed
 * walk at nine and at two is the difference between a hike and a thunderstorm,
 * and the provider does return hour-by-hour values that can say which. So when
 * — and only when — there is genuine hourly evidence, one alternative order is
 * tried: the stops the weather most disfavours placed earliest.
 *
 * Three things keep this from being an optimiser:
 *
 * 1. It is one extra candidate order, not a search. There is nothing to
 *    oscillate and the result is a pure function of the inputs.
 * 2. The alternative has to be *legal on its own terms* — it goes through the
 *    same `layoutDay`, so access windows, opening hours, last admissions and
 *    daylight all still apply. Weather cannot buy a relaxation of any of them.
 * 3. It has to be meaningfully better, not merely different, or the day stays
 *    as the road left it. Reordering somebody's morning to move a 12% chance of
 *    rain to a 9% one is churn dressed up as intelligence.
 *
 * With no hourly data — every date past the forecast horizon, and every provider
 * that returns daily values only — this returns the road order untouched, which
 * is the honest behaviour rather than a degraded one.
 */
function preferByHourlyWeather(
  context: LayoutContext,
  scheduled: ScheduledUnit[],
  layout: DayLayout,
): { scheduled: ScheduledUnit[]; layout: DayLayout } {
  const incumbent = weatherPenaltyOf(context, layout);
  if (incumbent === null) return { scheduled, layout };

  const byWeather = orderByWeather(context, scheduled);
  if (sameOrder(scheduled, byWeather)) return { scheduled, layout };

  const alternative = layoutDay(context, byWeather);
  if (alternative.violations.length > 0) return { scheduled, layout };

  const challenger = weatherPenaltyOf(context, alternative);
  if (challenger === null) return { scheduled, layout };

  return challenger <= incumbent - HOURLY_WEATHER_MARGIN
    ? { scheduled: byWeather, layout: alternative }
    : { scheduled, layout };
}

/**
 * How much better an alternative order has to be before a day is rearranged.
 *
 * The penalty scale runs roughly 0 for a settled hour to 2 or so for a
 * thunderstorm at an exposed stop, so a quarter of a point is about the width of
 * one category — showers appearing, or a gust threshold being crossed. Anything
 * finer than that is noise the forecast cannot support.
 */
const HOURLY_WEATHER_MARGIN = 0.25;

/** Mean hourly weather cost of the activities on a laid-out day, or null. */
function weatherPenaltyOf(context: LayoutContext, layout: DayLayout): number | null {
  const scores: number[] = [];
  for (const item of layout.items) {
    if (item.kind !== 'activity' || !item.placeId) continue;
    const weather = context.weather.get(item.placeId);
    if (!weather) continue;
    const penalty = weatherPenaltyAt({
      day: weather.evidence,
      profile: weather.profile,
      startMinute: item.startMinute,
      durationMinutes: item.durationMinutes,
    });
    if (penalty !== null) scores.push(penalty);
  }
  if (scores.length === 0) return null;
  return scores.reduce((sum, value) => sum + value, 0) / scores.length;
}

/**
 * Units ordered so the stops the weather most disfavours come first.
 *
 * Ranked on the worst hour anywhere in the day rather than on the stop's current
 * slot, so the ordering is a property of the day rather than of the layout it
 * came from — which is what stops it depending on its own output. Ties fall back
 * to the incoming order, so an ordinary day is unchanged.
 */
function orderByWeather(
  context: LayoutContext,
  units: readonly ScheduledUnit[],
): ScheduledUnit[] {
  const position = new Map(units.map((unit, index) => [unit.unit.key, index]));
  const exposure = (unit: ScheduledUnit): number => {
    const scores = unit.members
      .map((member) => context.weather.get(member.place.id))
      .filter((entry): entry is PlaceDayWeather => entry !== undefined)
      .map((entry) => entry.assessment.score);
    return scores.length === 0 ? 1 : Math.min(...scores);
  };
  return [...units].sort(
    (a, b) =>
      exposure(a) - exposure(b) ||
      (position.get(a.unit.key) ?? 0) - (position.get(b.unit.key) ?? 0),
  );
}

function orderByDeadline(
  context: LayoutContext,
  scheduled: readonly ScheduledUnit[],
): ScheduledUnit[] {
  const roadPosition = new Map(scheduled.map((entry, index) => [entry.unit.key, index]));
  const unitDeadline = (entry: ScheduledUnit) =>
    Math.min(...entry.members.map((member) => latestStartFor(context, member)));

  return [...scheduled].sort(
    (a, b) =>
      byDeadline(unitDeadline(a), unitDeadline(b)) ||
      (roadPosition.get(a.unit.key) ?? 0) - (roadPosition.get(b.unit.key) ?? 0) ||
      a.unit.key.localeCompare(b.unit.key),
  );
}

function sameOrder(a: readonly ScheduledUnit[], b: readonly ScheduledUnit[]): boolean {
  return a.length === b.length && a.every((entry, index) => entry.unit.key === b[index]!.unit.key);
}

/**
 * Groups a day's accepted candidates into units and puts the units in road
 * order.
 *
 * Ordering runs over each unit's gateway rather than over its members, which is
 * what stops the optimiser from "visiting" Rainbow Falls between two roadside
 * stops it cannot reach it from.
 */
export function scheduleUnits(
  context: LayoutContext,
  candidates: readonly PlanningCandidate[],
  options: Pick<PackOptions, 'accessByUnit' | 'unitByPlaceId'>,
): ScheduledUnit[] {
  const byUnit = new Map<string, PlanningCandidate[]>();
  for (const candidate of candidates) {
    const unit = options.unitByPlaceId.get(candidate.place.id);
    if (!unit) continue;
    const bucket = byUnit.get(unit.key);
    if (bucket) bucket.push(candidate);
    else byUnit.set(unit.key, [candidate]);
  }

  const pending = [...byUnit.entries()].flatMap(([key, members]) => {
    const unit = options.unitByPlaceId.get(members[0]!.place.id);
    const option = options.accessByUnit.get(key);
    if (!unit || !option) return [];
    return [{ unit, option, members }];
  });
  if (pending.length === 0) return [];

  /*
   * `orderStops` assumes every id it is given has a row in the matrix it is
   * handed, and throws if one does not — correct for the matrix alone, wrong
   * for a base or a stop resolved on demand (`PlannerInput.travelLegs`; see
   * `TravelKnowledge.travelLegs`'s own note). `resolveSubMatrix` builds a
   * small, complete matrix over exactly this day's own points first, backed
   * by the primary matrix and that supplementary one, so `orderStops` is
   * never hand ed a gap to throw on.
   *
   * A unit `resolveSubMatrix` genuinely cannot place — neither matrix
   * measures it — is dropped from *this day's* ordering rather than failing
   * the whole day; upstream eligibility (`resolveCandidates`, `assignToDays`)
   * is what is supposed to keep this from happening for anything actually
   * locked, so reaching this branch is the defensive case, not the normal
   * one, and is worth being conservative about rather than throwing anyway.
   */
  let orderable = pending;
  let anchors = orderable.map((entry) => entry.option.gatewayRoutingId);
  let resolved = resolveSubMatrix(context.matrix, [context.baseId, ...anchors], context.travel.travelLegs);
  if (!resolved.ok) {
    const unresolved = new Set(resolved.unresolved);
    orderable = orderable.filter((entry) => !unresolved.has(entry.option.gatewayRoutingId));
    if (orderable.length === 0) return [];
    anchors = orderable.map((entry) => entry.option.gatewayRoutingId);
    resolved = resolveSubMatrix(context.matrix, [context.baseId, ...anchors], context.travel.travelLegs);
    if (!resolved.ok) return [];
  }
  const pendingResolved = orderable;

  const route = orderStops(resolved.matrix, {
    startId: context.baseId,
    endId: context.baseId,
    stopIds: [...new Set(anchors)],
  });

  const position = new Map<string, number>();
  route.path.forEach((id, index) => {
    if (!position.has(id)) position.set(id, index);
  });

  return pendingResolved
    .map((entry) => ({
      ...entry,
      /**
       * Inside a unit, whatever shuts first goes first — and since almost
       * nothing in this region shuts at all, that is `Infinity` for both sides
       * and the tie-break does the work: the order the unit was built in,
       * nearest the base first, so a shuttle run reads as a route rather than a
       * shuffle. It only reorders when two stops behind one gate genuinely keep
       * different hours, which is exactly when it should.
       */
      members: [...entry.members].sort(
        (a, b) =>
          byDeadline(latestStartFor(context, a), latestStartFor(context, b)) ||
          entry.unit.members.findIndex((member) => member.place.id === a.place.id) -
            entry.unit.members.findIndex((member) => member.place.id === b.place.id),
      ),
    }))
    .sort(
      (a, b) =>
        (position.get(a.option.gatewayRoutingId) ?? Number.MAX_SAFE_INTEGER) -
          (position.get(b.option.gatewayRoutingId) ?? Number.MAX_SAFE_INTEGER) ||
        a.unit.key.localeCompare(b.unit.key),
    );
}

export function buildDay(
  context: LayoutContext,
  accepted: readonly PlanningCandidate[],
  layout: DayLayout,
  transport: ItineraryDay['transport'],
  weather?: DayWeatherSummary,
): ItineraryDay {
  const { day, baseId, baseName, profile } = context;
  const intensity = classifyIntensity(layout, profile);
  const warnings: string[] = [];

  if (day.window.usableMinutes === 0) {
    warnings.push('There are no usable hours on this day once travel in or out is accounted for.');
  } else if (accepted.length === 0 && !layout.items.some(isSomethingOnTheDay)) {
    /**
     * An empty day with hours in it says why, once, in its own voice.
     *
     * Without this the trip summary counts "12 stops across 3 of 4 days" while
     * day 4 sits silent — two statements a reader has to reconcile themselves.
     * The warning and the totals now tell one story: the hours are real, the
     * stops are elsewhere, and the reason is the supply rather than the clock.
     *
     * "Empty" has to mean the timeline, not the *activity* count. It meant the
     * second, and meals and their travel are laid out after the activities are
     * counted — so a delivered arrival evening printed "Nothing is scheduled on
     * this day … the hours are yours" in an amber block immediately beneath a
     * booked drive and a ninety-five-minute named dinner. The hours were not
     * theirs between six and twenty to eight.
     */
    warnings.push(
      'Nothing is scheduled on this day. Everything you picked either fitted better on another day or could not be reached on this one — the hours are yours.',
    );
  }
  // The old warning here told the traveller to "have a fallback in mind", which
  // is the product handing back its own job. Weather cautions now live on the
  // day's weather block, next to the concrete fallback the planner found.
  for (const violation of layout.violations) warnings.push(violation.message);

  return {
    dayNumber: day.dayNumber,
    date: day.date,
    baseId,
    baseName,
    theme: themeFor(accepted, baseName, layout),
    window: day.window,
    items: layout.items,
    totals: {
      activityMinutes: layout.activityMinutes,
      travelMinutes: layout.travelMinutes,
      driveMinutes: layout.driveMinutes,
      transitMinutes: layout.transitMinutes,
      walkMinutes: layout.walkMinutes,
      waitMinutes: layout.waitMinutes,
      unverifiedMinutes: layout.unverifiedMinutes,
      travelKm: layout.travelKm,
      freeMinutes: layout.freeMinutes,
      strenuousCount: layout.strenuousCount,
      /**
       * Counted off the timeline rather than tracked through the layout, so it
       * cannot drift from what the day actually contains. Zero on every day the
       * planner builds today — an approach it cannot time is refused upstream —
       * and the count exists so that a future provider which legitimately cannot
       * measure a leg has somewhere honest to put it, and so the validator has
       * something to assert against rather than a convention.
       */
      unmeasuredLegCount: layout.items.filter(
        (item) => item.travel !== undefined && item.travel.minutes === null,
      ).length,
    },
    transport,
    availability: summariseAvailability(context, layout),
    weather: weather ?? unknownDayWeather(),
    food: summariseFood(context, layout),
    intensity,
    warnings: [...new Set(warnings)],
  };
}

/**
 * What the day's food plan actually is, read back off the timeline rather than
 * declared alongside it — so it cannot claim a restaurant the schedule does not
 * contain, and the validator can catch it if it ever tries.
 *
 * Deliberately says nothing a meal row already says. The day block is for what
 * a *day* can say that a stop cannot: that lunch has to be carried, that the
 * shopping happened this morning for tomorrow, that a booking is outstanding.
 * Repeating the venue's opening hours a centimetre below the row that prints
 * them is how a reader learns to skip both.
 */
function summariseFood(context: LayoutContext, layout: DayLayout): ItineraryDay['food'] {
  const meals = layout.items.filter((item) => item.kind === 'meal');
  const plan = context.food?.byDay.get(context.day.dayNumber) ?? null;
  const slots = meals
    .map((item) => item.food?.slot)
    .filter((slot): slot is MealSlot => slot !== undefined && slot !== 'snack');

  const notes: string[] = [];
  const reservations: ItineraryDay['food']['reservations'] = [];

  for (const item of meals) {
    const food = item.food;
    if (!food) continue;
    if (
      food.reservation &&
      (food.reservation.requirement === 'required' || food.reservation.requirement === 'recommended') &&
      food.venueName
    ) {
      reservations.push({
        venueName: food.venueName,
        requirement: food.reservation.requirement,
        ...(food.reservation.note ? { note: food.reservation.note } : {}),
        ...(food.reservation.bookingUrl ? { bookingUrl: food.reservation.bookingUrl } : {}),
      });
    }
    if (food.stopKind === 'grocery' && food.suppliesDayNumber !== undefined) {
      // Only the cross-day case: the row itself already says why you are in a
      // supermarket at half seven on the morning it feeds.
      if (food.suppliesDayNumber !== context.day.dayNumber) {
        notes.push(`The shopping is for day ${food.suppliesDayNumber}, which has nowhere to buy any.`);
      }
    }
  }

  const packed = meals.some((item) => item.food?.stopKind === 'packed');
  if (plan?.remote && plan.gapNote) notes.push(plan.gapNote);
  /*
   * A coverage shortfall is a caution about our index, never remoteness: the
   * compiler's own sentence says what was found, and the planner adds the one
   * instruction a traveller can act on. Only when the day names nothing — a
   * day that scheduled a venue has already answered the question.
   */
  if (plan && !plan.remote && plan.coverageNote && meals.every((item) => item.food?.stopKind !== 'venue')) {
    notes.push('We could not verify places to eat near where this day goes — check locally.');
    notes.push(plan.coverageNote);
  }
  // Deliberately nothing about held time. The row says it, and the validator
  // says it, and a third copy a centimetre below the second is how a reader
  // learns to skip all three.

  return {
    summary: foodDaySummary({ meals, packed, remote: plan?.remote ?? false }),
    slots: [...new Set(slots)],
    remote: plan?.remote ?? false,
    notes: [...new Set(notes)],
    reservations,
  };
}

function foodDaySummary(input: {
  meals: readonly ItineraryItem[];
  packed: boolean;
  remote: boolean;
}): string {
  const named = input.meals
    .map((item) => item.food)
    .filter((food) => food?.stopKind === 'venue' && food.venueName)
    .map((food) => food!.venueName!);

  if (named.length === 0 && input.packed) {
    return 'Carried food, because there is nothing verified to buy where this day goes.';
  }
  if (named.length === 0) {
    /*
     * Read off the rows rather than assumed, like everything else in this
     * block. A day whose meals point at an area is not a day of held time, and
     * a summary that says so while the rows below it name a neighbourhood is the
     * kind of disagreement between a plan and its own summary that this file is
     * arranged to make impossible.
     */
    const areas = [
      ...new Set(
        input.meals
          .map((item) => item.food?.areaName)
          .filter((name): name is string => name !== undefined),
      ),
    ];
    return areas.length > 0
      ? `Nowhere named today — the meals point at ${areas.join(' and ')}, and which place is yours to pick.`
      : 'No named places today — time is held for meals, but nothing we can vouch for fitted.';
  }
  const list =
    named.length === 1
      ? named[0]!
      : `${named.slice(0, -1).join(', ')} and ${named.at(-1)}`;
  return input.packed ? `${list}, plus a lunch you carry.` : list;
}

/**
 * What the day's opening hours did to its shape, read back off the timeline
 * rather than declared alongside it — so it cannot claim something the schedule
 * does not show.
 *
 * The anchor is the point of this. A day holding one place that shuts at four
 * and three that never shut is really "be at the one with a closing time by this
 * hour, and move the rest around it", and saying that is more use than four
 * rows of times for the traveller to compare themselves.
 */
function summariseAvailability(context: LayoutContext, layout: DayLayout): DayAvailability {
  const activities = layout.items.filter((item) => item.kind === 'activity' && item.placeId);

  /**
   * Having hours is not the same as being constrained by them. A day-use site
   * posted 06:00 to 22:00 on a day that runs 07:30 to 19:00 has no bearing on
   * anything, and calling it the day's anchor would bury the one stop that
   * genuinely does decide the shape.
   */
  const binds = (item: (typeof activities)[number]) =>
    item.hours !== undefined &&
    (item.hours.openMinute > context.day.window.startMinute ||
      item.hours.closeMinute < context.day.window.endMinute ||
      item.hours.lastAdmissionMinute !== undefined);

  const constrained = activities.filter(binds);
  const flexiblePlaceIds = activities
    .filter((item) => !binds(item))
    .map((item) => item.placeId!)
    .sort();

  // Tightest closing time wins: that is the one you can actually miss.
  const anchor = [...constrained].sort(
    (a, b) =>
      a.hours!.closeMinute - b.hours!.closeMinute || a.placeId!.localeCompare(b.placeId!),
  )[0];

  const cautions: string[] = [];
  const verifyBeforeTravel: string[] = [];
  const bookings: BookingRequirement[] = [];

  for (const item of activities) {
    if (item.verifyBeforeTravel) verifyBeforeTravel.push(item.verifyBeforeTravel);
    if (item.booking) bookings.push(item.booking);
    const hours = context.hours.get(item.placeId!);
    if (hours?.status === 'unknown') {
      cautions.push(
        `We could not confirm opening hours for ${item.title}. Check before you build the day around it.`,
      );
    }
  }
  for (const violation of layout.violations) {
    if (violation.kind === 'hours') cautions.push(violation.message);
  }

  return {
    ...(anchor?.placeId ? { anchorPlaceId: anchor.placeId } : {}),
    ...(anchor?.hours ? { anchorNote: anchorNoteFor(anchor.title, anchor.hours) } : {}),
    flexiblePlaceIds,
    cautions: [...new Set(cautions)],
    verifyBeforeTravel: [...new Set(verifyBeforeTravel)],
    bookings: [...new Map(bookings.map((entry) => [entry.placeId, entry])).values()].sort((a, b) =>
      a.placeId.localeCompare(b.placeId),
    ),
  };
}

/** Names the edge that actually binds, rather than reciting the whole window. */
function anchorNoteFor(title: string, hours: ScheduledHours): string {
  const opens = `opens at ${formatMinuteOfDay(hours.openMinute)}`;
  const closes = `closes at ${formatMinuteOfDay(hours.closeMinute)}`;
  if (hours.lastAdmissionMinute !== undefined) {
    return `${title} sets the shape of this day: it ${opens}, ${closes}, and stops letting people in at ${formatMinuteOfDay(hours.lastAdmissionMinute)}.`;
  }
  return `${title} sets the shape of this day: it ${opens} and ${closes}.`;
}

function classifyIntensity(
  layout: DayLayout,
  profile: TravelerProfile,
): ItineraryDay['intensity'] {
  const load = layout.activityMinutes + layout.travelMinutes;
  if (layout.strenuousCount >= 2 || load > 8 * 60) return 'intense';
  if (layout.strenuousCount === 0 && load <= 3 * 60) return 'light';
  if (profile.dailyIntensity === 'light' && layout.strenuousCount > 0) return 'intense';
  return 'moderate';
}

/** Deterministic: the dominant interest, plus where the day actually went. */
export function themeFor(
  accepted: readonly PlanningCandidate[],
  baseName: string,
  layout?: DayLayout,
): string {
  if (accepted.length === 0) return 'An open day';

  // Weighted by time on site, not by headcount. A day with a three-hour canyon
  // hike and a one-hour stop in town is a hiking day, and counting stops instead
  // of minutes would label it a food day on an alphabetical tie-break.
  const weights = new Map<Interest, number>();
  for (const candidate of accepted) {
    const interest = candidate.primaryInterest;
    if (interest) {
      weights.set(interest, (weights.get(interest) ?? 0) + candidate.durationMinutes);
    }
  }

  const dominant = [...weights.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  )[0]?.[0];

  const farthest = [...accepted].sort(
    (a, b) =>
      b.travelMinutesFromBase - a.travelMinutesFromBase || a.place.id.localeCompare(b.place.id),
  )[0];

  /*
   * The base is the fallback, and it has to be: `locality` is optional on a
   * place, and a stored four-day plan carried two day headings reading
   * "History & culture around undefined" — the literal word, in the largest
   * type on the day. Naming the base instead is the honest answer, because the
   * base is where that day starts and ends whatever the far stop is called.
   */
  const farAreaName = farthest?.place.locality?.trim();
  const area =
    farthest && farthest.travelMinutesFromBase > 20 && farAreaName ? farAreaName : baseName;
  /*
   * When no candidate carries a speakable interest — the kind gate in
   * `resolveCandidates` withholds one whose category contradicts it — the
   * theme falls back to what the scheduled places *are*, by their own planning
   * category, weighted by the same time-on-site rule as the interests. "Town &
   * food around X" over a theme park is a true sentence; "Easy nature walks"
   * over the same day was a stored plan's actual heading, and the interest
   * that produced it never described the place. 'Mixed' stays the last resort
   * for a day whose stops genuinely agree on nothing.
   */
  const categoryWeights = new Map<Place['category'], number>();
  for (const candidate of accepted) {
    categoryWeights.set(
      candidate.place.category,
      (categoryWeights.get(candidate.place.category) ?? 0) + candidate.durationMinutes,
    );
  }
  const dominantCategory = [...categoryWeights.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  )[0]?.[0];
  const lead = dominant
    ? INTEREST_LABELS[dominant]
    : dominantCategory
      ? PLACE_CATEGORY_LABELS[dominantCategory]
      : 'Mixed';
  /**
   * The one interest label that makes a claim about the clock. "Sunrise &
   * sunset photography" over a day whose stops run 07:40–11:00 is a heading
   * the timeline directly contradicts — a stored plan wore exactly that — so
   * the label is only used when the schedule actually touches an edge of the
   * day. Mid-day photography is still photography; the theme says so instead.
   */
  if (dominant === 'photography_golden_hour' && layout) {
    const activities = layout.items.filter((item) => item.kind === 'activity');
    const first = activities[0]?.startMinute ?? Number.POSITIVE_INFINITY;
    const last = activities.length > 0 ? activities[activities.length - 1]!.endMinute : 0;
    const touchesGoldenHours = first <= 8 * 60 || last >= 18 * 60;
    if (!touchesGoldenHours) return `Photography around ${area}`;
  }
  return `${lead} around ${area}`;
}

export { formatMinuteOfDay };


/**
 * The weather evidence carried onto a scheduled visit.
 *
 * Only where the weather actually bore on the stop. A clear Tuesday at a place
 * nothing about the weather touches carries nothing at all — the same rule the
 * opening-hours evidence follows, and for the same reason: a badge on every row
 * is a badge nobody reads.
 */
function scheduledWeatherFrom(weather: PlaceDayWeather | undefined): ScheduledWeather | undefined {
  if (!weather) return undefined;
  const { assessment } = weather;
  const worthSaying =
    assessment.suitability === 'poor' ||
    assessment.suitability === 'incompatible' ||
    assessment.suitability === 'favorable' ||
    assessment.suitability === 'unknown';
  if (!worthSaying) return undefined;

  return {
    evidence: assessment.evidence,
    suitability: assessment.suitability,
    summary: assessment.summary,
    reasonCodes: assessment.reasons.map((reason) => reason.code),
    locationId: weather.locationId,
    locationLabel: weather.locationLabel,
    ...(weather.evidence.kind === 'forecast' ? { fetchedAt: weather.evidence.fetchedAt } : {}),
    provider:
      weather.evidence.kind === 'unavailable'
        ? weather.evidence.attemptedProvider
        : weather.evidence.attribution.provider,
  };
}

/**
 * The day-weather block for a day nobody could resolve weather for.
 *
 * Reachable only when a caller builds a day without passing one, which the
 * planner never does. It exists so the shape is total and the honest answer —
 * "we do not know" — is the one that survives, rather than an empty object that
 * a reader would take for a clear day.
 */
function unknownDayWeather(): DayWeatherSummary {
  return {
    evidence: 'unavailable',
    summary: 'We have no weather for this day, so nothing here was placed against it.',
    precipitationProbabilityPercent: null,
    decisions: [],
    cautions: [],
    backups: [],
    provider: 'none',
    attribution: 'No weather source was reached for this trip.',
  };
}
