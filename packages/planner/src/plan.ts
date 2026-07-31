import {
  DAYLIGHT_END_BUFFER_MINUTES,
  FOOD_ISSUE_CODES,
  ITINERARY_VERSION,
  itinerarySchema,
  tripDates,
  WEATHER_DATASET_VERSION,
  type DayBackup,
  type Itinerary,
  type ItineraryDay,
  type MinuteInterval,
  type Place,
  type UnscheduledPlace,
  type WeatherEvidenceKind,
} from '@sidequest/core';
import { MatrixError, tryLeg, validateMatrix } from '@sidequest/geo';
import {
  accessKey,
  buildAccessUnits,
  resolveAccess,
  summariseDayTransport,
  type AccessOption,
  type AccessUnit,
} from './access';
import { assignToDays } from './assign';
import { resolveCandidates } from './candidates';
import {
  couldVisitOnDate,
  hoursKey,
  resolveOperatingHours,
  type PlaceDayHours,
} from './hours';
import {
  chooseBackups,
  summariseDayWeather,
  type BackupCandidate,
} from './backups';
import { resolveFood, type FoodContext } from './food';
import { buildFoodPlan } from './food-plan';
import { reviseDayPlans, type DayPlan } from './revise';
import {
  buildDay,
  isOpenOnDate,
  layoutBestOrder,
  packDay,
  type DayLayout,
  type LayoutContext,
  type PackOptions,
} from './schedule';
import { buildTransportStrategy } from './strategy';
import { statusFor, validateItinerary, validateStrategy } from './validate';
import {
  narrowByDaylight,
  resolveWeather,
  weatherKeyFor,
  weatherPreference,
  type PlaceDayWeather,
} from './weather';
import { buildDailyWindows } from './windows';
import {
  PLANNER_VERSION,
  resolveConfig,
  type PlannerInput,
  type PlanningCandidate,
  type PlanResult,
} from './types';

/**
 * The whole pipeline, in order:
 *
 *    1. validate the matrix                 11. assign groups to days
 *    2. build real daily windows            12. choose a legal way in for each group
 *    3. resolve selections and exclusions   13. order the groups, then their stops
 *    4. drop infeasible places              14. insert access legs, meals, rest, slack
 *    5. rank by planning priority           15. time-block inside every open window
 *    6. resolve date-aware access           16. validate the finished plan
 *    7. drop what cannot be reached         17. revise, bounded, deterministically
 *    8. resolve date-aware opening hours    18. derive the transport strategy
 *    9. resolve weather and daylight        19. return plan, diagnostics, conflicts
 *   10. drop what no day can legally hold
 *   11. group geographically and by access
 *
 * Steps 6, 8 and 9 answer different questions and all have to pass. Access asks
 * whether the traveller can legally get there and back; hours ask whether anyone
 * will let them in when they arrive; daylight asks whether there is any light
 * left to do it in. A place can be reachable and shut, or open and unreachable,
 * and collapsing them is how a plan drives eighty minutes to a locked gate.
 *
 * Weather is the odd one out and is treated as such. It never promotes and it
 * never grants: it chooses between days the first three have already allowed,
 * and it cautions about the one that gets picked. The only part of step 9 that
 * constrains is daylight, which is arithmetic rather than a prediction.
 *
 * Pure: no I/O, no clock, no randomness. Same inputs in, byte-identical plan out.
 * Both the travel-time matrix and the access dataset arrive as data rather than
 * being fetched here, which is what makes that possible — and what will let a
 * real routing or transit provider slot in without this file changing at all.
 */
export function planTrip(input: PlannerInput): PlanResult {
  const config = resolveConfig(input.config);
  const generatedAt = input.generatedAt ?? new Date().toISOString();

  try {
    validateMatrix(input.matrix);
  } catch (error) {
    const message =
      error instanceof MatrixError
        ? error.message
        : 'The travel-time data for this region is unusable.';
    return { ok: false, code: 'matrix_unusable', message };
  }

  const { eligible, rejected } = resolveCandidates(
    input.candidates,
    input.selections,
    input.matrix,
  );
  const unscheduled: UnscheduledPlace[] = [...rejected];

  const days = buildDailyWindows(input.basics, input.profile, config);
  if (days.length === 0) {
    return { ok: false, code: 'no_usable_days', message: 'That date range does not contain a day.' };
  }
  if (eligible.length === 0 && rejected.length === 0) {
    return {
      ok: false,
      code: 'no_candidates',
      message: 'Nothing on the Discovery Board is marked to include yet.',
    };
  }

  const placesById = new Map<string, Place>(
    input.candidates.map((candidate) => [candidate.place.id, candidate.place]),
  );
  const baseName = input.region.baseName;
  const dates = tripDates(input.basics.startDate, input.basics.endDate);

  // --- Access: which units can be reached, on which dates -----------------
  const units = buildAccessUnits(eligible, input.access, baseName);
  const unitByPlaceId = new Map<string, AccessUnit>();
  for (const unit of units) {
    for (const member of unit.members) unitByPlaceId.set(member.place.id, unit);
  }
  const accessByUnitDate = resolveAccess({
    units,
    dates,
    dataset: input.access,
    profile: input.profile,
    matrix: input.matrix,
  });

  /** The legal ways in available on one specific day, keyed by unit. */
  const accessFor = (date: string): Map<string, AccessOption> => {
    const map = new Map<string, AccessOption>();
    for (const unit of units) {
      const resolved = accessByUnitDate.get(accessKey(unit.key, date));
      if (resolved?.available) map.set(unit.key, resolved.option);
    }
    return map;
  };

  /** A unit is plannable at all only if some day of the trip can take it. */
  const feasibleDates = new Map<string, ReadonlySet<string>>(
    units.map((unit) => [
      unit.key,
      new Set(dates.filter((date) => accessByUnitDate.get(accessKey(unit.key, date))?.available)),
    ]),
  );
  const reachableUnitKeys = new Set(
    units.filter((unit) => (feasibleDates.get(unit.key)?.size ?? 0) > 0).map((unit) => unit.key),
  );

  const reachable: PlanningCandidate[] = [];
  for (const candidate of eligible) {
    const unit = unitByPlaceId.get(candidate.place.id);
    if (unit && reachableUnitKeys.has(unit.key)) {
      reachable.push(candidate);
      continue;
    }
    unscheduled.push(accessBlocked(candidate, unit, accessByUnitDate, dates));
  }

  // --- Hours: which places are open, on which dates, within reach ----------
  const hoursByPlaceDate = resolveOperatingHours({
    placeIds: reachable.map((candidate) => candidate.place.id),
    dates,
    dataset: input.hours,
  });
  const dayByDate = new Map(days.map((day) => [day.date, day]));

  // --- Weather and daylight ----------------------------------------------
  const weatherByPlaceDate = resolveWeather({
    places: reachable.map((candidate) => ({
      place: candidate.place,
      durationMinutes: candidate.durationMinutes,
      daylightOnly:
        hoursByPlaceDate.get(hoursKey(candidate.place.id, dates[0]!))?.daylightOnly ?? false,
    })),
    dates,
    dataset: input.weather,
    avoidances: input.profile.avoidances,
  });

  const daylightOnlyFor = (placeId: string, date: string): boolean =>
    hoursByPlaceDate.get(hoursKey(placeId, date))?.daylightOnly ?? false;

  /**
   * The intersection that decides everything downstream: the day's usable
   * hours, narrowed by the window the way in allows, then tested against the
   * place's own opening hours and the time the visit takes.
   *
   * Computed once, here, for every place against every date — because day
   * assignment has to know that Bodie is shut on a Wednesday *before* it hands
   * the cluster containing Bodie to Wednesday. Discovering it later means the
   * packer rejects it and it spills into an overflow pass by which time the days
   * that would have worked are full.
   */
  const boundsFor = (candidate: PlanningCandidate, date: string): MinuteInterval | null => {
    const day = dayByDate.get(date);
    if (!day) return null;
    const unit = unitByPlaceId.get(candidate.place.id);
    const resolved = unit ? accessByUnitDate.get(accessKey(unit.key, date)) : undefined;
    if (!resolved?.available) return null;
    // Daylight folded in here as well as in the layout, so a signed
    // sunrise-to-sunset site with no long-enough day is reported as impossible
    // up front rather than silently failing to fit later.
    return narrowByDaylight(
      {
      startMinute: Math.max(
        // You cannot be standing at a place before you have travelled to it.
        // Without this the filter is optimistic enough to call a stop feasible
        // that no day can actually reach in time, and the traveller then gets
        // "there was no room" instead of "you cannot get there before it stops
        // letting people in" — the second of which names something they can act on.
        day.window.startMinute + candidate.driveMinutesFromBase,
        resolved.option.earliestActivityStart ?? Number.NEGATIVE_INFINITY,
      ),
      endMinute: Math.min(
        day.window.endMinute,
        resolved.option.latestActivityEnd ?? Number.POSITIVE_INFINITY,
      ),
      },
      weatherByPlaceDate.get(weatherKeyFor(candidate.place.id, date)),
      daylightOnlyFor(candidate.place.id, date),
    );
  };

  const openDates = new Map<string, ReadonlySet<string>>(
    reachable.map((candidate) => [
      candidate.place.id,
      new Set(
        dates.filter((date) => {
          const hours = hoursByPlaceDate.get(hoursKey(candidate.place.id, date));
          const bounds = boundsFor(candidate, date);
          if (!hours || !bounds) return false;
          return couldVisitOnDate({
            hours,
            placeName: candidate.place.name,
            durationMinutes: candidate.durationMinutes,
            bounds,
          });
        }),
      ),
    ]),
  );

  const plannable: PlanningCandidate[] = [];
  for (const candidate of reachable) {
    if ((openDates.get(candidate.place.id)?.size ?? 0) > 0) {
      /**
       * Reachable, open, and ruled out by the weather on every single day.
       *
       * Only the two hard cases can land here — an unsurfaced approach that
       * needs dry ground, and a signed daylight-only site with no long enough
       * day. A merely poor forecast never does: that stays on the plan with a
       * caution, because refusing to show somebody a trip on the strength of a
       * precipitation figure would be overreach.
       *
       * The distinction matters most for a manual pick. Told "there was no
       * room", a traveller changes the wrong thing; told "the track in needs
       * dry ground and every day of your trip is wet", they can decide.
       */
      const dayOptions = dates.filter((date) => openDates.get(candidate.place.id)?.has(date));
      const blocked = dayOptions.every(
        (date) =>
          weatherByPlaceDate.get(weatherKeyFor(candidate.place.id, date))?.assessment
            .suitability === 'incompatible',
      );
      if (dayOptions.length > 0 && blocked) {
        unscheduled.push(weatherBlocked(candidate, weatherByPlaceDate, dayOptions));
        continue;
      }
      plannable.push(candidate);
      continue;
    }
    // Daylight is folded into `boundsFor`, so a signed sunrise-to-sunset site
    // that no day is long enough for arrives here looking like an hours
    // problem. Telling somebody their visit "does not fit inside its opening
    // hours" when the real answer is "there is not enough light in December"
    // sends them to change the wrong thing.
    if (
      daylightOnlyFor(candidate.place.id, dates[0]!) &&
      dates.every((date) => {
        const weather = weatherByPlaceDate.get(weatherKeyFor(candidate.place.id, date));
        const daylight = weather?.solar;
        return (
          daylight !== undefined &&
          daylight.sunsetMinute - DAYLIGHT_END_BUFFER_MINUTES - daylight.sunriseMinute <
            candidate.durationMinutes
        );
      })
    ) {
      unscheduled.push(weatherBlocked(candidate, weatherByPlaceDate, dates));
      continue;
    }
    unscheduled.push(hoursBlocked(candidate, hoursByPlaceDate, dates));
  }

  /** Hours for one day, keyed by place — everything the layout needs. */
  const hoursFor = (date: string): Map<string, PlaceDayHours> => {
    const map = new Map<string, PlaceDayHours>();
    for (const candidate of reachable) {
      const hours = hoursByPlaceDate.get(hoursKey(candidate.place.id, date));
      if (hours) map.set(candidate.place.id, hours);
    }
    return map;
  };

  /**
   * The zone the base town sits in. A day with nothing scheduled is still a day
   * somewhere, and that somewhere is where the traveller is sleeping.
   */
  const baseLocationId = input.weather.locations.find((location) =>
    location.placeIds.some((placeId) =>
      input.candidates.some(
        (candidate) =>
          candidate.place.id === placeId && candidate.place.relationship === 'base',
      ),
    ),
  )?.id;

  /** Weather for one day, keyed by place — everything the layout needs. */
  const weatherFor = (date: string): Map<string, PlaceDayWeather> => {
    const map = new Map<string, PlaceDayWeather>();
    for (const candidate of reachable) {
      const entry = weatherByPlaceDate.get(weatherKeyFor(candidate.place.id, date));
      if (entry) map.set(candidate.place.id, entry);
    }
    return map;
  };

  /**
   * Resolved once, from the day assignment, and then held still.
   *
   * The packer re-lays every day out repeatedly while deciding what fits, and
   * the reviser can take a stop off a day and force the whole thing to be built
   * again. If the food plan were recomputed against each of those it would
   * oscillate — a day loses its last stop, stops being remote, gains a
   * restaurant, and now fits again. Resolving against the geographic assignment
   * once means the shortlists are stable for the whole run, which is what makes
   * two identical inputs produce two identical plans.
   */
  let foodContext: FoodContext | null = null;

  const contextFor = (day: DayPlan['day']): LayoutContext => ({
    day,
    baseId: input.baseId,
    baseName,
    matrix: input.matrix,
    config,
    profile: input.profile,
    hours: hoursFor(day.date),
    weather: weatherFor(day.date),
    food: foodContext,
  });

  /**
   * Deciding what fits is done without food, always.
   *
   * A restaurant is a preference; a lake is what the traveller asked for. The
   * packer measures each candidate against the day's driving and transport caps,
   * and with a coffee stop and a dinner detour already on the clock those caps
   * are reached sooner — so the first thing the food layer did, before this
   * existed, was push Rainbow Falls, Bishop and the Sherwin Lakes trail off the
   * plan entirely to make room for lunch. Food is added to the day the packer
   * settled on, and if it will not fit inside it, the food goes rather than the
   * stop.
   */
  const packingContextFor = (day: DayPlan['day']): LayoutContext => ({
    ...contextFor(day),
    food: null,
  });


  const maxStrenuousPerDay =
    input.profile.derived.preferredPhysicalIntensity === 'strenuous' ? 2 : 1;

  const maxActivitiesFor = (day: DayPlan['day']) => {
    const slots = input.profile.derived.activitySlotsPerDay;
    const base = day.isEdgeDay ? slots * config.edgeDayCapacityShare : slots;
    return Math.max(1, Math.round(base));
  };

  const packOptionsFor = (day: DayPlan['day']): PackOptions => ({
    maxActivities: maxActivitiesFor(day),
    maxDailyDriveMinutes: input.profile.transport.maxDailyDriveMinutes,
    maxDailyTransportMinutes: input.profile.transport.maxDailyTransportMinutes,
    maxStrenuous: maxStrenuousPerDay,
    accessByUnit: accessFor(day.date),
    unitByPlaceId,
  });

  // --- First pass: geographic and access groups onto days -----------------
  const assignments = assignToDays(
    plannable,
    days,
    input.matrix,
    input.baseId,
    unitByPlaceId,
    feasibleDates,
    openDates,
    (placeIds, date) => weatherPreference(placeIds, date, weatherByPlaceDate),
  );

  /**
   * What geography alone would have done, kept so the finished plan can say
   * which stops the weather actually moved. Recomputed rather than inferred:
   * asserting "we moved this for the forecast" is only honest if the
   * counterfactual was really run.
   */
  const geographicOnly = new Map<string, number>();
  for (const assignment of assignToDays(
    plannable,
    days,
    input.matrix,
    input.baseId,
    unitByPlaceId,
    feasibleDates,
    openDates,
  )) {
    for (const candidate of assignment.candidates) {
      geographicOnly.set(candidate.place.id, assignment.day.dayNumber);
    }
  }
  let dayPlans: DayPlan[] = [];
  const overflow: PlanningCandidate[] = [];

  for (const assignment of assignments) {
    const packed = packDay(
      packingContextFor(assignment.day),
      assignment.candidates,
      packOptionsFor(assignment.day),
    );
    dayPlans.push({ day: assignment.day, accepted: packed.accepted });
    overflow.push(...packed.overflow);
  }

  // --- Second pass: overflow into whatever room is left -------------------
  const placed = new Set(dayPlans.flatMap((plan) => plan.accepted.map((c) => c.place.id)));
  const stillHomeless: PlanningCandidate[] = [];

  for (const candidate of [...overflow].sort(
    (a, b) => b.priority - a.priority || a.place.id.localeCompare(b.place.id),
  )) {
    if (placed.has(candidate.place.id)) continue;

    let landed = false;
    // Prefer the day already going nearest to it, so a spill does not invent a
    // second long drive on a day that was not heading that way.
    const detourCost = (plan: DayPlan) => {
      if (plan.accepted.length === 0) {
        return tryLeg(input.matrix, input.baseId, candidate.place.id)?.minutes ?? Infinity;
      }
      return Math.min(
        ...plan.accepted.map(
          (entry) => tryLeg(input.matrix, entry.place.id, candidate.place.id)?.minutes ?? Infinity,
        ),
      );
    };
    const ordered = [...dayPlans].sort(
      (a, b) => detourCost(a) - detourCost(b) || a.day.dayNumber - b.day.dayNumber,
    );
    for (const plan of ordered) {
      if (!isOpenOnDate(candidate.place, plan.day.date)) continue;
      // Never onto a day that separates it from the rest of its access group.
      //
      // `accessGroup` means "one road, one fee, one long drive out and back" —
      // Devils Postpile and Rainbow Falls are behind one shuttle boarding, and
      // splitting them across two days means paying for the valley twice and
      // driving to it twice. Clustering guarantees they start life on one day;
      // this is the pass that could quietly undo it, and it did: with the
      // weather layer choosing a different day for the cluster, one member
      // overflowed and landed on a day of its own.
      //
      // Leaving it unscheduled with a reason is the honest outcome. A stop that
      // costs a second round trip up a shuttle-only valley is not the same stop.
      if (splitsAccessGroup(candidate, plan, dayPlans)) continue;
      // The deterministic reassignment the spill pass has always been: a stop
      // that lost its first choice of day gets offered every other legal one,
      // nearest-detour first. Hours narrow "legal" without changing the search.
      if (!openDates.get(candidate.place.id)?.has(plan.day.date)) continue;
      const trial = packDay(
        packingContextFor(plan.day),
        [...plan.accepted, candidate],
        packOptionsFor(plan.day),
      );
      if (trial.accepted.some((entry) => entry.place.id === candidate.place.id)) {
        plan.accepted = trial.accepted;
        placed.add(candidate.place.id);
        landed = true;
        break;
      }
    }
    if (!landed) stillHomeless.push(candidate);
  }

  for (const candidate of stillHomeless) {
    unscheduled.push(unscheduledFor(candidate, days.length, accessByUnitDate, unitByPlaceId, dates));
  }

  /**
   * Food is resolved from the days as the packer actually settled them.
   *
   * Not from the geographic assignment, which is what it read at first: that set
   * is a superset the packer then trims, so a day that was *offered* the Reds
   * Meadow valley and did not take it was still shopping for a packed lunch at
   * half seven and then eating in a restaurant at noon. What each day needs is a
   * property of what is on it.
   *
   * Resolved once, here, and then held still. The reviser can take a stop off a
   * day and force the whole thing to be rebuilt, and recomputing against each of
   * those would let the food plan oscillate — a day loses its last stop, stops
   * being remote, gains a restaurant, and now fits again.
   */
  if (input.food) {
    foodContext = resolveFood({
      dataset: input.food,
      profile: input.profile,
      selections: input.foodSelections ?? [],
      days: dayPlans.map((plan) => ({ day: plan.day, candidates: plan.accepted })),
      matrix: input.matrix,
      baseId: input.baseId,
      windows: config.mealWindows,
    });
  }

  // --- Build, validate, revise -------------------------------------------
  /**
   * Builds every day, and records anything the layout could not actually place.
   *
   * The packer only ever offers a day it has proved legal, so in the ordinary
   * case nothing is dropped here. The gap is the rebuild after a revision: the
   * reviser removes a stop, which changes the route the remaining ones are
   * ordered on, and the day is re-laid without being re-packed. A stop lost that
   * way used to disappear from the timeline while still counting as accepted —
   * neither scheduled nor reported. `dropped` closes that: `buildDay` is handed
   * only what is really on the day, and the caller turns the rest into
   * conflicts. Nothing the traveller chose can go missing without a reason.
   */
  /** Days where the meals gave way so the stops could stay. Reported, not hidden. */
  let foodYielded: number[] = [];
  /**
   * Days whose food the validator rejected, and which are therefore rebuilt
   * without it.
   *
   * The one bounded revision the food layer gets. It runs once, before the stop
   * reviser, and always in the same direction: the meals go, the stops stay. A
   * reviser that could swap one restaurant for another would need somewhere to
   * remember what it had already tried, and an itinerary planner that sometimes
   * fails to terminate is worse than one that occasionally serves a plain lunch.
   */
  const foodSuppressed = new Set<number>();

  /**
   * Whether the food-bearing layout costs the day anything it should not.
   *
   * Deliberately blunt and one-directional. Food may lengthen the day and it may
   * add driving — a coffee two minutes off the route is two minutes of driving,
   * and pretending otherwise would put the layout and the validator's own re-sum
   * of the totals into disagreement, which is how a day once emptied itself one
   * stop at a time. What food may not do is cost a stop, break a cap, or invent
   * a new violation.
   */
  const foodFits = (plain: DayLayout, withFood: DayLayout): boolean => {
    if (withFood.violations.length > plain.violations.length) return false;
    /**
     * The same stops, in the same order.
     *
     * Not merely the same count. `layoutBestOrder` tries a second ordering when
     * the first has violations, so a day that only just fits can come back
     * rearranged once the meals are on it — and it did: an Owens Valley day
     * flipped Bishop in front of Manzanar, which is a different trip presented
     * as a two-minute coffee detour. Food decides where you eat on the route.
     * It does not get a vote on the route.
     */
    const sequence = (layout: DayLayout) =>
      layout.items
        .filter((item) => item.kind === 'activity')
        .map((item) => item.placeId ?? '')
        .join('>');
    if (sequence(withFood) !== sequence(plain)) return false;
    if (withFood.driveMinutes > input.profile.transport.maxDailyDriveMinutes) return false;
    if (withFood.travelMinutes > input.profile.transport.maxDailyTransportMinutes) return false;
    /**
     * Every extra minute at the wheel has to be accounted for by a detour the
     * plan owns up to.
     *
     * Both layouts choose their own stop order, and a food-bearing one is free
     * to pick a different one. That is fine when it is the detours doing it and
     * a lie when it is not: a day that quietly re-routes to suit a bakery and
     * adds forty minutes of driving would be shown as a two-minute detour.
     */
    const claimed = withFood.items.reduce(
      (sum, item) => sum + (item.food?.detourMinutes ?? 0),
      0,
    );
    if (withFood.driveMinutes > plain.driveMinutes + claimed) return false;
    return true;
  };

  const buildAll = (plans: readonly DayPlan[]) => {
    foodYielded = [];
    const dropped = new Map<string, { candidate: PlanningCandidate; message: string }>();
    const days = plans.map((plan) => {
      const options = packOptionsFor(plan.day);
      /**
       * The day, laid out twice: as the packer settled it, and again with the
       * food on. The food version is kept only if it costs nothing that matters.
       *
       * "Nothing that matters" is exact: the same stops, no new way for the day
       * to be illegal, and both travel budgets still respected. Anything else
       * and the meals fall back to blocks of held time, which is what a
       * version-5 plan had and is a great deal better than a plan that quietly
       * traded Rainbow Falls for lunch.
       */
      const plain = layoutBestOrder(packingContextFor(plan.day), plan.accepted, options);
      const withFood =
        foodContext && !foodSuppressed.has(plan.day.dayNumber)
          ? layoutBestOrder(contextFor(plan.day), plan.accepted, options)
          : plain;
      const keepFood = withFood !== plain && foodFits(plain.layout, withFood.layout);
      const context = keepFood ? contextFor(plan.day) : packingContextFor(plan.day);
      const { scheduled, layout } = keepFood ? withFood : plain;
      // A day whose food was suppressed by the validator is already reported,
      // with the right reason. Counting it here as well printed two revision
      // notes for one decision, the second of them naming a limit nothing hit.
      if (foodContext && !keepFood && !foodSuppressed.has(plan.day.dayNumber)) {
        foodYielded.push(plan.day.dayNumber);
      }

      const placed = new Set(
        layout.items
          .filter((item) => item.kind === 'activity' && item.placeId)
          .map((item) => item.placeId!),
      );
      for (const candidate of plan.accepted) {
        if (placed.has(candidate.place.id)) continue;
        const violation = layout.violations.find((entry) => entry.placeId === candidate.place.id);
        dropped.set(candidate.place.id, {
          candidate,
          message:
            violation?.message ??
            `${candidate.place.name} could not be fitted into day ${plan.day.dayNumber} once the rest of it was laid out.`,
        });
      }

      const onDay = plan.accepted
        .filter((candidate) => placed.has(candidate.place.id))
        .map((candidate) => ({
          candidate,
          weather: weatherByPlaceDate.get(weatherKeyFor(candidate.place.id, plan.day.date)),
        }))
        .filter(
          (entry): entry is { candidate: PlanningCandidate; weather: PlaceDayWeather } =>
            entry.weather !== undefined,
        );

      return buildDay(
        context,
        plan.accepted.filter((candidate) => placed.has(candidate.place.id)),
        layout,
        summariseDayTransport(scheduled, layout, input.access),
        weatherForDay(plan, onDay, scheduledEverywhere(plans)),
      );
    });
    return { days, dropped };
  };

  /** Every place on the plan, so a fallback is never something already booked. */
  const scheduledEverywhere = (plans: readonly DayPlan[]): Set<string> =>
    new Set(plans.flatMap((plan) => plan.accepted.map((candidate) => candidate.place.id)));

  /**
   * The day's weather block: what it rested on, what the weather changed, and
   * where else to go if it turns.
   */
  const weatherForDay = (
    plan: DayPlan,
    onDay: readonly { candidate: PlanningCandidate; weather: PlaceDayWeather }[],
    scheduledPlaceIds: ReadonlySet<string>,
  ) => {
    /**
     * At risk on suitability alone, not on whether the evidence can rank days.
     *
     * Gating this on `rankable` looked right — patterns cannot move a stop, so
     * why look for a fallback? — and produced exactly the silence this feature
     * exists to prevent: a far-future July day at Manzanar showed "typically
     * 38 °C" as a caution, offered nothing, and said nothing about why. The
     * caution list has never been gated on `rankable`, so the two disagreed and
     * the validator reported a day with a problem and no answer.
     *
     * A seasonal pattern is a perfectly good reason to have somewhere else in
     * mind. It is only a bad reason to *reorder the week*, and that restriction
     * lives in `weatherPreference`, where it belongs.
     */
    const atRisk = onDay.filter(
      (entry) =>
        entry.weather.assessment.suitability === 'poor' ||
        entry.weather.assessment.suitability === 'incompatible',
    );

    // Only stops the weather genuinely moved, measured against the assignment
    // geography alone would have produced.
    const decisions: string[] = [];
    for (const { candidate, weather } of onDay) {
      const would = geographicOnly.get(candidate.place.id);
      if (would === undefined || would === plan.day.dayNumber || !weather.assessment.rankable) {
        continue;
      }
      /**
       * Two different sentences, because "moved here because the forecast is
       * better" printed above "thunderstorms forecast" reads as nonsense — and
       * it is the *true* case that reads worst. A stop can be moved onto a poor
       * day because every other day was worse still, and saying that plainly is
       * both more honest and more useful than a cheerful sentence the next line
       * contradicts.
       */
      const poor =
        weather.assessment.suitability === 'poor' ||
        weather.assessment.suitability === 'incompatible';
      decisions.push(
        poor
          ? `${candidate.place.name} moved off day ${would} — this was the least bad day for it in the forecast, not a good one. ${weather.assessment.summary}`
          : `${candidate.place.name} is on this day rather than day ${would} because the forecast suits it better here. ${weather.assessment.summary}`,
      );
    }

    const pool: BackupCandidate[] = reachable
      .filter((candidate) => !scheduledPlaceIds.has(candidate.place.id))
      .map((candidate) => ({
        place: candidate.place,
        driveMinutesFromBase: candidate.driveMinutesFromBase,
        selectionStatus: candidate.selectionStatus,
        reachable: feasibleDates.get(unitByPlaceId.get(candidate.place.id)?.key ?? '')?.has(plan.day.date) ?? false,
        hours: hoursByPlaceDate.get(hoursKey(candidate.place.id, plan.day.date)),
        weather: weatherByPlaceDate.get(weatherKeyFor(candidate.place.id, plan.day.date)),
      }));

    const backups: DayBackup[] = chooseBackups({
      date: plan.day.date,
      scheduledPlaceIds,
      atRisk,
      pool,
      maxDriveMinutes: input.profile.transport.maxDailyDriveMinutes,
    });

    return summariseDayWeather({
      date: plan.day.date,
      onDay,
      representative: representativeWeather(onDay, plan.day.date),
      decisions,
      backups,
      ...(atRisk.length > 0 && backups.length === 0
        ? {
            noBackupReason:
              'Nothing else on your board is both reachable that day and genuinely less exposed to this, so we are not going to invent a fallback.',
          }
        : {}),
    });
  };

  /**
   * Which weather point speaks for the day as a whole.
   *
   * The zone most of the day's stops sit under, and the base town's when a day
   * has no stops at all. Picking the most extreme one instead would make an
   * afternoon at the gondola summit describe a morning in the village.
   */
  const representativeWeather = (
    onDay: readonly { weather: PlaceDayWeather }[],
    date: string,
  ): PlaceDayWeather | undefined => {
    if (onDay.length === 0) {
      // The base's own zone. `reachable[0]` was the first version and it is
      // whichever candidate happened to sort first — so a rest day in Mammoth
      // could be headlined with the Owens Valley's 38 °C, four thousand feet
      // below and seventy miles away. That is the one-point-for-a-region failure
      // this whole layer exists to prevent, reintroduced in a fallback.
      const atBase = reachable.find(
        (candidate) =>
          weatherByPlaceDate.get(weatherKeyFor(candidate.place.id, date))?.locationId ===
          baseLocationId,
      );
      return atBase
        ? weatherByPlaceDate.get(weatherKeyFor(atBase.place.id, date))
        : undefined;
    }
    const counts = new Map<string, number>();
    for (const entry of onDay) {
      counts.set(entry.weather.locationId, (counts.get(entry.weather.locationId) ?? 0) + 1);
    }
    const winner = [...counts.entries()].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
    )[0]?.[0];
    return onDay.find((entry) => entry.weather.locationId === winner)?.weather;
  };

  let build = buildAll(dayPlans);
  let built = build.days;
  /**
   * Derived from whatever the days currently hold, and rebuilt each time the
   * reviser changes them, so the validator is never reading a food plan for a
   * trip that no longer exists.
   */
  const currentFoodPlan = () =>
    buildFoodPlan({
      days: built,
      profile: input.profile,
      food: foodContext,
      dataset: input.food ?? null,
    });
  const validationInput = () => ({
    days: built,
    unscheduled,
    profile: input.profile,
    config,
    matrix: input.matrix,
    placesById,
    baseId: input.baseId,
    access: input.access,
    hours: input.hours,
    weather: input.weather,
    foodPlan: currentFoodPlan(),
    hadFoodDataset: input.food !== undefined,
    ...(input.now ? { now: input.now } : {}),
  });
  let issues = validateItinerary(validationInput());

  const revisions = [];
  let passes = 0;

  const foodErrorDays = [
    ...new Set(
      issues
        .filter(
          (issue) =>
            issue.severity === 'error' &&
            FOOD_ISSUE_CODES.has(issue.code) &&
            issue.dayNumber !== undefined,
        )
        .map((issue) => issue.dayNumber!),
    ),
  ].sort((a, b) => a - b);

  if (foodErrorDays.length > 0) {
    for (const dayNumber of foodErrorDays) {
      foodSuppressed.add(dayNumber);
      revisions.push({
        code: 'changed_meal' as const,
        description: `Took the meals off day ${dayNumber} rather than the stops: what we had picked did not hold up.`,
        dayNumber,
      });
    }
    build = buildAll(dayPlans);
    built = build.days;
    issues = validateItinerary(validationInput());
  }

  while (passes < config.maxRevisionPasses && issues.some((issue) => issue.severity === 'error')) {
    const outcome = reviseDayPlans(dayPlans, issues);
    revisions.push(...outcome.actions);
    if (!outcome.changed) break;

    dayPlans = outcome.dayPlans;
    for (const { candidate, reason, code } of outcome.removed) {
      unscheduled.push({
        placeId: candidate.place.id,
        name: candidate.place.name,
        wasManual: candidate.manual,
        reasonCode: code,
        reason: `Taken out because ${reason}`,
        suggestedRemedy: 'Free up room by dropping another stop, or give the trip more days.',
      });
    }

    build = buildAll(dayPlans);
    built = build.days;
    issues = validateItinerary(validationInput());
    passes += 1;
  }

  /**
   * The last thing that could quietly lose a stop.
   *
   * Everything the final layout could not place comes back with the reason the
   * layout gave, whatever produced it. Appended after the revision loop so it
   * describes the plan actually being returned rather than an intermediate one.
   */
  for (const { candidate, message } of build.dropped.values()) {
    unscheduled.push({
      placeId: candidate.place.id,
      name: candidate.place.name,
      wasManual: candidate.manual,
      reasonCode: 'hours_do_not_fit',
      reason: message,
      suggestedRemedy: 'Drop something else from that day, or give the trip another day.',
    });
  }
  if (build.dropped.size > 0) issues = validateItinerary(validationInput());

  const scheduledCount = built.reduce(
    (sum, day) => sum + day.items.filter((item) => item.kind === 'activity').length,
    0,
  );
  const totals = built.reduce(
    (acc, day) => ({
      usable: acc.usable + day.window.usableMinutes,
      activity: acc.activity + day.totals.activityMinutes,
      travel: acc.travel + day.totals.travelMinutes,
      free: acc.free + day.totals.freeMinutes,
    }),
    { usable: 0, activity: 0, travel: 0, free: 0 },
  );

  /**
   * Days that kept their stops and lost their meals. Said out loud, because a
   * plan that quietly stops naming restaurants on one day of four looks like a
   * gap in the data rather than a decision.
   */
  for (const dayNumber of [...foodYielded].sort((a, b) => a - b)) {
    revisions.push({
      code: 'changed_meal' as const,
      description: `Day ${dayNumber} holds time for its meals rather than naming places: getting to and from them would have taken the day past a limit you set.`,
      dayNumber,
    });
  }

  const transportStrategy = buildTransportStrategy({
    days: built,
    profile: input.profile,
    region: input.region,
    dataset: input.access,
    unscheduled,
    matrixNote: input.matrix.provenance.note,
    matrixProvenance: input.matrix.provenance.kind,
  });
  issues = [...issues, ...validateStrategy(transportStrategy, built)];

  const itinerary: Itinerary = {
    version: ITINERARY_VERSION,
    tripId: input.tripId,
    regionId: input.region.id,
    baseId: input.baseId,
    baseName,
    startDate: input.basics.startDate,
    endDate: input.basics.endDate,
    status: statusFor(issues),
    summary: summarise(built, scheduledCount, unscheduled.length),
    transportStrategy,
    foodPlan: currentFoodPlan(),
    days: built,
    unscheduled: dedupeUnscheduled(unscheduled),
    issues,
    diagnostics: {
      plannerVersion: PLANNER_VERSION,
      generatedAt,
      matrixProvenance: input.matrix.provenance.kind,
      matrixNote: input.matrix.provenance.note,
      operatingHoursVersion: input.hours.version,
      weatherDatasetVersion: WEATHER_DATASET_VERSION,
      weatherProvider: input.weather.providerName,
      weatherEvidence: evidenceKinds(built),
      weatherGeneratedAt: input.weather.generatedAt,
      foodDatasetVersion: input.food?.version ?? 0,
      foodVenuesConsidered: input.food?.venues.length ?? 0,
      revisionPasses: passes,
      revisions,
      capacity: {
        usableMinutes: totals.usable,
        activityMinutes: totals.activity,
        travelMinutes: totals.travel,
        freeMinutes: totals.free,
      },
      counts: {
        considered: input.candidates.length,
        scheduled: scheduledCount,
        unscheduled: dedupeUnscheduled(unscheduled).length,
      },
    },
  };

  try {
    return { ok: true, itinerary: itinerarySchema.parse(itinerary) };
  } catch (error) {
    return {
      ok: false,
      code: 'internal_error',
      message: error instanceof Error ? error.message : 'The planner produced an invalid itinerary.',
    };
  }
}

/**
 * A place the traveller chose that no day of this trip can legally reach.
 *
 * The reason has to name the actual constraint. "Low logistics fit" tells nobody
 * anything; "the shuttle is out of season on your dates, and it is the only way
 * past the gate" tells them exactly which of their choices to change.
 */
function accessBlocked(
  candidate: PlanningCandidate,
  unit: AccessUnit | undefined,
  resolved: ReadonlyMap<string, { available: boolean; blockers?: { code: string; message: string }[] }>,
  dates: readonly string[],
): UnscheduledPlace {
  const blockers = unit
    ? dates.flatMap((date) => {
        const entry = resolved.get(accessKey(unit.key, date));
        return entry && !entry.available ? (entry.blockers ?? []) : [];
      })
    : [];
  const first = blockers[0];

  return {
    placeId: candidate.place.id,
    name: candidate.place.name,
    wasManual: candidate.manual,
    reasonCode: reasonCodeForAccess(first?.code),
    reason:
      first?.message ??
      'We have no record of a way to reach this on your dates, so we will not put it on a day.',
    suggestedRemedy: remedyForAccess(first?.code),
  };
}

/**
 * A place the traveller can reach on some day of this trip and that will not
 * let them in on any of them.
 *
 * Two situations, and telling them apart is the whole value of the message.
 * "Shut for the season" means change your dates or drop it; "open, but never
 * long enough after you could get there" means change what else is on the day.
 * A single "does not fit your logistics" would leave the traveller guessing at
 * which of their own decisions to revisit.
 */
function hoursBlocked(
  candidate: PlanningCandidate,
  hoursByPlaceDate: ReadonlyMap<string, PlaceDayHours>,
  dates: readonly string[],
): UnscheduledPlace {
  const resolved = dates
    .map((date) => hoursByPlaceDate.get(hoursKey(candidate.place.id, date)))
    .filter((entry): entry is PlaceDayHours => entry !== undefined);
  const shutEveryDay = resolved.length > 0 && resolved.every((entry) => entry.status === 'closed');

  if (shutEveryDay) {
    // Any weekday closure is the more specific answer, and it can appear on a
    // date other than the first when a trip straddles a season boundary.
    const weekday = resolved.find((entry) => entry.closedReason === 'closed_weekday');
    const what = weekday?.periodLabel
      ? `its ${weekday.periodLabel.toLowerCase()}`
      : candidate.place.name;
    const reason = weekday
      ? `${candidate.place.name} is shut on every day of the week your trip covers — ${what} does not open on any of them.`
      : `${candidate.place.name} is closed for the season on your dates.`;
    return {
      placeId: candidate.place.id,
      name: candidate.place.name,
      wasManual: candidate.manual,
      reasonCode: 'closed_on_trip_dates',
      reason,
      suggestedRemedy: 'Move your dates into a period it is open, or take it off the board.',
    };
  }

  return {
    placeId: candidate.place.id,
    name: candidate.place.name,
    wasManual: candidate.manual,
    reasonCode: 'hours_do_not_fit',
    reason: `${candidate.place.name} is open on your dates, but never for long enough after you could get there — a ${candidate.durationMinutes} min visit does not fit inside its hours on any day of this trip.`,
    suggestedRemedy:
      'Start the day earlier, or free up a day by dropping something else from the board.',
  };
}

/**
 * A place the weather rules out on every day this trip could have taken it.
 *
 * The reason names the specific typed requirement that failed, because that is
 * the only thing the traveller can act on. "Bad weather" would be true and
 * useless; "the dirt road in needs dry ground" tells them to look at the
 * forecast themselves and decide, which is theirs to decide.
 */
function weatherBlocked(
  candidate: PlanningCandidate,
  weatherByPlaceDate: ReadonlyMap<string, PlaceDayWeather>,
  dates: readonly string[],
): UnscheduledPlace {
  const first = dates
    .map((date) => weatherByPlaceDate.get(weatherKeyFor(candidate.place.id, date)))
    .find((entry) => entry?.assessment.suitability === 'incompatible');
  const reason = first?.assessment.reasons.find((entry) => entry.weight <= -0.5);

  return {
    placeId: candidate.place.id,
    name: candidate.place.name,
    wasManual: candidate.manual,
    reasonCode: 'weather_incompatible',
    reason: reason
      ? `${candidate.place.name} is out on every day of this trip: ${reason.text}.`
      : `${candidate.place.name} cannot be done in the weather forecast for any day of this trip.`,
    suggestedRemedy:
      'Move your dates, or keep it in mind and check the forecast again nearer the time.',
  };
}

function reasonCodeForAccess(code: string | undefined): UnscheduledPlace['reasonCode'] {
  switch (code) {
    case 'service_out_of_season':
    case 'service_not_operating':
      return 'service_not_operating';
    case 'needs_private_vehicle':
    case 'shuttle_declined':
    case 'unsupported_mode':
      return 'transport_mode_unavailable';
    case 'no_access_data':
      return 'missing_travel_data';
    default:
      return 'access_unavailable';
  }
}

function remedyForAccess(code: string | undefined): string | undefined {
  switch (code) {
    case 'service_out_of_season':
      return 'Move your dates into the season the service runs, or drop this from the board.';
    case 'service_not_operating':
      return 'Shift a day so it lands on a day the service runs.';
    case 'needs_private_vehicle':
      return 'This needs a vehicle. Renting one would open up most of the region.';
    case 'shuttle_declined':
      return 'Say you are willing to use a shuttle, if you are — it is the only way in here.';
    case 'walk_too_long':
      return 'Raise how far you will walk to reach a stop, or pick something closer to the road.';
    default:
      return undefined;
  }
}

function unscheduledFor(
  candidate: PlanningCandidate,
  dayCount: number,
  resolved: ReadonlyMap<string, { available: boolean }>,
  unitByPlaceId: ReadonlyMap<string, AccessUnit>,
  dates: readonly string[],
): UnscheduledPlace {
  const unit = unitByPlaceId.get(candidate.place.id);
  const reachableDays = unit
    ? dates.filter((date) => resolved.get(accessKey(unit.key, date))?.available).length
    : dates.length;

  // Distinguishing "there was no room" from "there was room, but not on the days
  // it runs" is the difference between a useful remedy and a shrug.
  if (reachableDays > 0 && reachableDays < dayCount) {
    return {
      placeId: candidate.place.id,
      name: candidate.place.name,
      wasManual: candidate.manual,
      reasonCode: 'service_not_operating',
      reason: `Only ${reachableDays} of your ${dayCount} days can reach this, and those days were already full.`,
      suggestedRemedy: 'Free up one of those days by dropping something else from the board.',
    };
  }

  const optional = !candidate.manual && candidate.selectionStatus === 'maybe';
  return {
    placeId: candidate.place.id,
    name: candidate.place.name,
    wasManual: candidate.manual,
    reasonCode: optional ? 'lower_priority' : 'no_time_left',
    reason: optional
      ? 'A maybe that there was no room for once the things you actually chose were placed.'
      : `There was no day in these ${dayCount} with the hours and the travel budget left for it.`,
    ...(candidate.manual
      ? { suggestedRemedy: 'Drop something else from the board, or give the trip another day.' }
      : {}),
  };
}

/**
 * Whether putting this candidate on this day would separate it from members of
 * its own access group already placed on a different one.
 */
function splitsAccessGroup(
  candidate: PlanningCandidate,
  target: DayPlan,
  plans: readonly DayPlan[],
): boolean {
  const group = candidate.place.accessGroup?.id;
  if (!group) return false;
  return plans.some(
    (plan) =>
      plan.day.dayNumber !== target.day.dayNumber &&
      plan.accepted.some((entry) => entry.place.accessGroup?.id === group),
  );
}

function dedupeUnscheduled(entries: readonly UnscheduledPlace[]): UnscheduledPlace[] {
  const byId = new Map<string, UnscheduledPlace>();
  for (const entry of entries) {
    // Keep the first reason recorded; it is the most specific.
    if (!byId.has(entry.placeId)) byId.set(entry.placeId, entry);
  }
  return [...byId.values()].sort(
    (a, b) => Number(b.wasManual) - Number(a.wasManual) || a.placeId.localeCompare(b.placeId),
  );
}

function summarise(
  days: readonly ItineraryDay[],
  scheduled: number,
  unscheduled: number,
): string {
  const activeDays = days.filter((day) => day.totals.activityMinutes > 0).length;
  const driveMinutes = days.reduce((sum, day) => sum + day.totals.driveMinutes, 0);
  const otherMinutes = days.reduce(
    (sum, day) => sum + day.totals.transitMinutes + day.totals.walkMinutes + day.totals.waitMinutes,
    0,
  );
  const parts = [
    `${scheduled} ${scheduled === 1 ? 'stop' : 'stops'} across ${activeDays} of ${days.length} days`,
  ];
  if (driveMinutes > 0) parts.push(`about ${hours(driveMinutes)} hours of driving`);
  if (otherMinutes > 0) parts.push(`${hours(otherMinutes)} hours riding and on foot to reach them`);
  if (unscheduled > 0) parts.push(`${unscheduled} left off, each with a reason`);
  return `${parts.join(', ')}.`;
}

function hours(minutes: number): number {
  return Math.round(minutes / 6) / 10;
}

export { validateItinerary, statusFor } from './validate';


/**
 * The mixture of evidence the finished plan actually rests on.
 *
 * A list rather than a single label, because a trip that starts inside the
 * forecast horizon and ends outside it genuinely holds two kinds at once, and
 * collapsing that to one word would either invent a forecast for the last day or
 * throw away a real one for the first.
 */
function evidenceKinds(days: readonly ItineraryDay[]): WeatherEvidenceKind[] {
  const kinds = new Set<WeatherEvidenceKind>(days.map((day) => day.weather.evidence));
  return kinds.size > 0 ? [...kinds].sort() : ['unavailable'];
}
