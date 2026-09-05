import {
  DAYLIGHT_END_BUFFER_MINUTES,
  displayNameOf,
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
  type ValidationIssue,
  type WeatherEvidenceKind,
} from '@sidequest/core';
import { MatrixError, tryLeg, validateMatrix } from '@sidequest/geo';
import type { PlannerReadiness } from '@sidequest/core';
import {
  accessKey,
  buildAccessUnits,
  resolveAccess,
  summariseDayTransport,
  type AccessOption,
  type AccessUnit,
} from './access';
import { assignToDays, MIN_PLANNABLE_MINUTES, wantsStrenuousDaysApart } from './assign';
import {
  bindingInterestOf,
  chargeFrequencyCost,
  withinFrequencyCaps,
} from './frequency';
import { assessMustDoFeasibility } from './feasibility';
import { pinnedPriority, resolveCandidates } from './candidates';
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
import { foodContextWithoutVenues, resolveFood, type FoodContext } from './food';
import { buildFoodPlan } from './food-plan';
import { reviseDayPlans, type DayPlan } from './revise';
import {
  buildDay,
  isOpenOnDate,
  latestFinishFor,
  layoutBestOrder,
  packDay,
  type DayLayout,
  type LayoutContext,
  type PackOptions,
} from './schedule';
import { buildTransportStrategy } from './strategy';
import { plannerLegBounds, plannerReachResolves } from './modelled-walk';
import { reachFromBase, travelKnowledgeFor } from './travel';

/**
 * What one stop costs to reach and return from, split by which budget bounds it.
 */
interface RoundTrip {
  minutes: number | null;
  driveMinutes: number;
  driveCap: number;
  transportCap: number;
}
import { buildPlannerReadiness, coverageOf } from './readiness';
import { blockingIssues, statusFor, validateItinerary, validateStrategy } from './validate';
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

  /**
   * Every way this traveller could make a given journey, resolved once.
   *
   * Built here rather than inside the day loop because it is a property of the
   * trip — the matrix, the timetables that were bought, and what the traveller
   * said they would and would not do — and rebuilding it per day would be the
   * same answer computed five times.
   */
  const travelKnowledge = travelKnowledgeFor(
    input.matrix,
    input.profile,
    input.transit,
    input.scheduledNetwork,
    input.travelLegs,
  );

  const resolved = resolveCandidates(
    input.candidates,
    input.selections,
    input.matrix,
    { knowledge: travelKnowledge, baseId: input.baseId },
    input.profile,
  );
  const rejected = resolved.rejected;
  /**
   * Locks, applied where priority is decided.
   *
   * A locked stop is planned as if hand-picked — the traveller has said "keep
   * this" and a rebuild that quietly drops it for an auto-pick has broken a
   * promise. The day it is held to is enforced after assignment, below; here
   * it only outranks.
   *
   * `pinnedPriority` rather than an arithmetic expression written out here,
   * because this line used to be one — `10_000 + fitScore` — and that reverted
   * the pinned place, alone among the candidates, to the order the board
   * stopped using when it began composing significance into its key.
   */
  const lockedDayByPlace = new Map((input.locks ?? []).map((lock) => [lock.placeId, lock.dayNumber]));
  const eligible = resolved.eligible.map((candidate) =>
    lockedDayByPlace.has(candidate.place.id)
      ? { ...candidate, manual: true, priority: pinnedPriority(candidate) }
      : candidate,
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

  /**
   * BEFORE ANY PACKING: CAN THE TRAVELLER'S OWN PICKS EVEN FIT?
   *
   * Placed here — after the days are known and before a single stop is
   * assigned — because it is the only point at which the answer is still the
   * traveller's to give. Once the greedy packer runs, the set has been resolved
   * by dropping whichever picks it reached last, and the itinerary that comes
   * out is an answer to a question nobody asked.
   *
   * It stays quiet unless the set is *impossible*: the bound is conservative in
   * the traveller's favour on both sides, so anything short of impossible falls
   * through to the planner, which is where ambitious-but-doable belongs.
   */
  const conflict = assessMustDoFeasibility({
    candidates: eligible,
    matrix: input.matrix,
    travel: travelKnowledge,
    days: days.length,
  });
  if (conflict) {
    return {
      ok: false,
      code: 'must_do_conflict',
      message: conflict.summary,
      mustDoConflict: conflict,
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
    travel: { knowledge: travelKnowledge, baseId: input.baseId },
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
    unscheduled.push(
      accessBlocked(candidate, unit, accessByUnitDate, dates, input.profile.transport.willDrive),
    );
  }

  /**
   * THE FUNNEL'S "MEASURABLE" GATE, MADE MODE-AWARE.
   *
   * `eligible.length` was the old value, and eligibility only checks that the
   * matrix *has a row* — so on a car-free trip handed a road matrix the refusal
   * screen read "MEASURABLE 6" one line above "6 with no measured travel time".
   * Both sentences were derived honestly from two different definitions of
   * measurable, which is the defect: the funnel's definition now includes the
   * access layer's judgement, so a place counts as measurable when a permitted
   * journey (or an honest derived walk) resolves from the base, or when the
   * access data itself established a way in.
   */
  const reachBounds = plannerLegBounds(input.profile, travelKnowledge);
  const reachableIds = new Set(reachable.map((candidate) => candidate.place.id));
  const measurableCount = eligible.filter(
    (candidate) =>
      reachableIds.has(candidate.place.id) ||
      plannerReachResolves(travelKnowledge, input.baseId, candidate.place.id, reachBounds),
  ).length;

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
        day.window.startMinute + candidate.travelMinutesFromBase,
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
            placeName: displayNameOf(candidate.place),
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

  /**
   * Which base a date belongs to.
   *
   * The whole multi-base story in one function. Without it every day starts and
   * ends at `input.baseId` — so a traveller who moved to a second base on day
   * six has days seven onwards routed back to the first, which is both a wrong
   * plan and one that looks right because the numbers are internally consistent.
   *
   * Falls back to the single base whenever there is no portfolio, which is what
   * every region compiled before hierarchical routing has.
   */
  const baseAt = (date: string): { id: string; name: string } => {
    const assignment = input.basePortfolio?.bases.find(
      (base) => date >= base.fromDate && date <= base.toDate,
    );
    return assignment
      ? { id: assignment.baseId, name: assignment.baseName }
      : { id: input.baseId, name: baseName };
  };

  /** Whether this date is the one spent moving between two bases. */
  const isTransfer = (date: string): boolean =>
    (input.basePortfolio?.bases ?? []).some((base) => base.order > 0 && base.fromDate === date);

  /**
   * The measured transfer this date carries, in minutes at the wheel.
   *
   * A transfer day is not an ordinary day and pretending otherwise fails in one
   * of two ways: judged against the sightseeing limit, a four-hour move alone
   * exceeds it and the day comes back empty; ignored, the traveller is handed a
   * day with four hours of driving on top of a full itinerary.
   *
   * So the transfer gets its **own, separately disclosed allowance** — the
   * measured leg, and nothing more. The sightseeing limit is untouched: what a
   * transfer day may hold is the traveller's ordinary limit *plus the move they
   * already committed to by choosing a multi-base trip*, never a quietly raised
   * ceiling.
   */
  const transferMinutesOn = (date: string): number => {
    const arriving = (input.basePortfolio?.bases ?? []).find(
      (base) => base.order > 0 && base.fromDate === date,
    );
    return arriving?.transferMinutesFromPrevious ?? 0;
  };

  const driveCapOn = (date: string): number =>
    input.profile.transport.maxDailyDriveMinutes + transferMinutesOn(date);
  const travelCapOn = (date: string): number =>
    input.profile.transport.maxDailyTransportMinutes + transferMinutesOn(date);

  const contextFor = (day: DayPlan['day']): LayoutContext => ({
    day,
    baseId: baseAt(day.date).id,
    baseName: baseAt(day.date).name,
    matrix: input.matrix,
    travel: travelKnowledge,
    config,
    profile: input.profile,
    hours: hoursFor(day.date),
    weather: weatherFor(day.date),
    food: foodContext,
    /*
     * On every context, including the two that carry no plan: where somebody is
     * standing is a fact about the route, not about what the day may eat.
     */
    foodDataset: input.food ?? null,
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

  /**
   * THE THIRD LAYOUT: MEALS AS HELD TIME, WHEN NAMED ONES WILL NOT FIT.
   *
   * There were two, and the gap between them shipped. `contextFor` names
   * venues and routes to them; `packingContextFor` says the day has **no food
   * data at all** — which is a different and false statement about a region
   * that has plenty. So a day whose restaurants cost it a stop fell all the way
   * through to the version-5 behaviour: no breakfast slot (`wantsSlot` reads
   * the plan that is no longer there), and lunch and dinner as bare blocks
   * headed "Lunch" and "Dinner" with "Back at base, nothing booked" under them,
   * on a metropolitan trip whose own index held fourteen venues. A reviewer
   * found exactly that on a delivered board.
   *
   * The two things being conflated are *name a door and route to it*, which
   * genuinely may not fit, and *hold the hour in the right window, in a named
   * area*, which costs the day only the time it was always going to spend
   * eating. This context keeps the second and drops the first, by emptying
   * every shortlist rather than by removing the plan.
   *
   * Built lazily and once: the map is per-trip, not per-day.
   */
  const heldMealsFood: FoodContext | null = foodContextWithoutVenues(foodContext);
  const heldMealContextFor = (day: DayPlan['day']): LayoutContext => ({
    ...contextFor(day),
    food: heldMealsFood,
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

  /**
   * HOW MUCH OF A THING, APPLIED WHERE THE PLAN IS COMPOSED.
   *
   * `frequencyCaps` is the traveller's own answer to "how often do you want
   * this", and until this existed it was read in exactly two places: the board's
   * auto-pick, which chooses a set, and the validator, which afterwards notices
   * the set was too big and writes a caution. Nothing in between refused to
   * schedule anything — so `frequency_reached`, a reason code shipped with its
   * own remedies and its own traveller-facing sentence, had no producer
   * anywhere. §9.3's "personalization means composition, not just ranking" was
   * true of the ranking and not of the composition.
   *
   * What a stop *costs* is `frequency.ts` and nothing else — see that module for
   * why three layers charging three different ledgers is the defect it closes.
   * The packer, the validator and (once reconciled) the board's auto-pick must
   * all read the one function, or the product refuses a stop against one limit
   * and then warns about another.
   *
   * **A hand-picked stop is never refused.** A cap derived from an answer must
   * not overrule an instruction — somebody who ticked five viewpoints gets five
   * viewpoints and the validator's caution, which is the honest response to a
   * traveller contradicting their own questionnaire.
   */
  const interestSpend = new Map<string, number>();

  const withinFrequencyBudget = (
    candidate: PlanningCandidate,
    provisional: ReadonlyMap<string, number>,
  ): boolean => {
    if (candidate.manual) return true;
    const spent = new Map<string, number>(interestSpend);
    for (const [interest, count] of provisional) {
      spent.set(interest, (spent.get(interest) ?? 0) + count);
    }
    return withinFrequencyCaps(candidate.place, input.profile, spent);
  };

  /** Charged only once a stop is really on a day, so an overflow costs nothing. */
  const chargeFrequency = (candidates: readonly PlanningCandidate[]): void => {
    for (const candidate of candidates) {
      if (candidate.manual) continue;
      chargeFrequencyCost(candidate.place, input.profile, interestSpend);
    }
  };

  /** Stops left out because the traveller asked for fewer of their kind. */
  const overAllowance: PlanningCandidate[] = [];

  /** No day-local tally: the spill pass reads the trip's spend as it stands. */
  const EMPTY_SPEND: ReadonlyMap<string, number> = new Map();

  // --- First pass: geographic and access groups onto days -----------------
  const { assignments, funnel: assignmentFunnel } = assignToDays(
    plannable,
    days,
    input.matrix,
    (date) => baseAt(date).id,
    unitByPlaceId,
    feasibleDates,
    openDates,
    (placeIds, date) => weatherPreference(placeIds, date, weatherByPlaceDate),
    wantsStrenuousDaysApart(input.profile),
    input.travelLegs,
    lockedDayByPlace,
  );

  /**
   * LOCKS: PLACED FIRST INSIDE `assignToDays` ITSELF (STAGE B), THIS IS NOW A
   * SAFETY NET, NOT THE PRIMARY MECHANISM.
   *
   * `assignToDays` already puts a valid lock (real identity, a usable day,
   * real routing evidence to that day's base) directly onto its pinned day
   * before clustering runs at all — the guarantee a locked anchor used to
   * depend on *surviving* geographic clustering, which is exactly what let a
   * real, resolved, routable anchor vanish with no record at all (a live
   * Iceland run's own "Brúarfoss": never reported infeasible, never
   * scheduled, simply absent). This move loop still runs, for one legitimate
   * remaining reason: an unlocked candidate happened to already occupy the
   * pinned day's slot in a way clustering alone would not undo. It is a
   * no-op whenever Stage B already placed things correctly, which is the
   * normal case now.
   *
   * `unroutableLocks` — locks Stage B itself determined cannot legally reach
   * their pinned day's base — are excluded from this move on purpose: moving
   * one here regardless would silently reintroduce the exact "relocate
   * without checking" behaviour Stage B exists to prevent.
   */
  const unroutableLocks = new Set(
    assignmentFunnel.lockedRejections
      .filter((entry) => entry.reason === 'not_routable_to_target_base')
      .map((entry) => entry.placeId),
  );
  if (lockedDayByPlace.size > 0) {
    const byDayNumber = new Map(assignments.map((entry) => [entry.day.dayNumber, entry]));
    for (const [placeId, dayNumber] of lockedDayByPlace) {
      if (unroutableLocks.has(placeId)) continue;
      const target = byDayNumber.get(dayNumber);
      if (!target) continue;
      for (const assignment of assignments) {
        if (assignment.day.dayNumber === dayNumber) continue;
        const index = assignment.candidates.findIndex((entry) => entry.place.id === placeId);
        if (index >= 0) target.candidates.push(...assignment.candidates.splice(index, 1));
      }
      target.candidates.sort(
        (a, b) => b.priority - a.priority || a.place.id.localeCompare(b.place.id),
      );
    }

    /**
     * NO SILENT FOURTH STATE.
     *
     * Every lock now ends in exactly one observable state: scheduled on its
     * pinned day (Stage B, or the move above), or reported right here.
     * Nothing between "on the day" and "in `unscheduled` with a reason" is
     * left for a lock this pass was actually asked to honour.
     */
    for (const [placeId, dayNumber] of lockedDayByPlace) {
      const target = byDayNumber.get(dayNumber);
      const landedOnPinnedDay = target?.candidates.some((entry) => entry.place.id === placeId) ?? false;
      if (landedOnPinnedDay) continue;
      const candidate = eligible.find((entry) => entry.place.id === placeId);
      if (!candidate) continue; // never resolved to a real, eligible candidate at all — already reported upstream (rejected/access/hours/weather), not this function's story to tell twice
      unscheduled.push(lockConflict(candidate, unroutableLocks.has(placeId)));
    }
  }

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
    (date) => baseAt(date).id,
    unitByPlaceId,
    feasibleDates,
    openDates,
    undefined,
    undefined,
    input.travelLegs,
  ).assignments) {
    for (const candidate of assignment.candidates) {
      geographicOnly.set(candidate.place.id, assignment.day.dayNumber);
    }
  }
  let dayPlans: DayPlan[] = [];
  const overflow: PlanningCandidate[] = [];

  for (const assignment of assignments) {
    /*
     * The allowance is applied to what the day is *offered*, not to what it
     * accepts, and the two are different on purpose. Filtering here means the
     * packer never has to know about interests; charging below means a stop the
     * packer could not fit costs the traveller nothing.
     *
     * The day's own tally is provisional so that one day cannot spend the whole
     * trip's allowance on candidates it then rejects.
     */
    const provisional = new Map<string, number>();
    const offered: PlanningCandidate[] = [];
    for (const candidate of assignment.candidates) {
      if (withinFrequencyBudget(candidate, provisional)) {
        if (!candidate.manual) {
          chargeFrequencyCost(candidate.place, input.profile, provisional);
        }
        offered.push(candidate);
      } else {
        overAllowance.push(candidate);
      }
    }

    const packed = packDay(
      packingContextFor(assignment.day),
      offered,
      packOptionsFor(assignment.day),
    );
    chargeFrequency(packed.accepted);
    dayPlans.push({ day: assignment.day, accepted: packed.accepted });
    overflow.push(...packed.overflow);
  }

  // --- Second pass: overflow into whatever room is left -------------------
  const placed = new Set(dayPlans.flatMap((plan) => plan.accepted.map((c) => c.place.id)));
  const stillHomeless: PlanningCandidate[] = [];

  /*
   * The stops held back on their own day get one more look here, because an
   * allowance the packer never actually spent is still available. A day that was
   * offered three viewpoints and fitted none of them leaves the allowance
   * untouched, and refusing the other two on the strength of a spend that never
   * happened would be the cap misreporting itself.
   */
  for (const candidate of [...overflow, ...overAllowance.splice(0)].sort(
    (a, b) => b.priority - a.priority || a.place.id.localeCompare(b.place.id),
  )) {
    if (placed.has(candidate.place.id)) continue;
    if (!withinFrequencyBudget(candidate, EMPTY_SPEND)) {
      overAllowance.push(candidate);
      continue;
    }

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
      // A locked stop may only spill onto the day it is locked to — landing it
      // anywhere else would honour the pick while breaking the pin.
      const lockedTo = lockedDayByPlace.get(candidate.place.id);
      if (lockedTo !== undefined && plan.day.dayNumber !== lockedTo) continue;
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
        chargeFrequency([candidate]);
        landed = true;
        break;
      }
    }
    if (!landed) stillHomeless.push(candidate);
  }

  /**
   * The allowance refusals, reported by name and by the limit that caused them.
   *
   * Written here rather than left to `unscheduledFor`, which would call this
   * "there was no day with the hours for it" — sending somebody to add days when
   * the answer is that they asked for one of these and the board offered four.
   */
  for (const candidate of overAllowance) {
    if (placed.has(candidate.place.id)) continue;
    /*
     * The ceiling that actually bound, not the place's headline interest. With
     * a stop spending half a unit of everything else it delivers, the two come
     * apart: a lakeside hike can be refused by the *lakes* allowance while its
     * primary interest is hiking, and naming the wrong one sends the traveller
     * to raise a limit that was never the problem.
     */
    const interest =
      bindingInterestOf(candidate.place, input.profile, interestSpend) ??
      candidate.place.interests[0] ??
      'this kind of thing';
    unscheduled.push({
      placeId: candidate.place.id,
      name: displayNameOf(candidate.place),
      wasManual: candidate.manual,
      reasonCode: 'frequency_reached',
      reason: `You asked for ${input.profile.derived.frequencyCaps[interest as keyof typeof input.profile.derived.frequencyCaps] ?? 0} of these on this trip, and the board offered more ${interest.replace(/_/g, ' ')} than that.`,
      suggestedRemedy:
        'Say you want more of this kind of thing, or pick this one by hand on the board.',
    });
  }

  /**
   * The unavoidable travel for one stop: base out, and base back, in the mode
   * that would actually make the journey.
   *
   * This read the matrix directly and compared the answer against
   * `maxDailyDriveMinutes`. On a car-free trip the matrix is a pedestrian one
   * and that cap is **zero**, so every unplaced stop was reported as "about N
   * minutes of driving, and you said 0 was your limit" — to somebody with no
   * car, about a walk. The reason code fed the remedy ranking, so the whole
   * explanation downstream was built on it.
   *
   * `null` when either leg is unmeasured, which is a different failure with its
   * own code and must not be reported as a distance.
   */
  const roundTripFromBase = (placeId: string): RoundTrip => {
    const reached = reachFromBase(travelKnowledge, input.baseId, placeId);
    const driveCap = input.profile.transport.maxDailyDriveMinutes;
    const transportCap = input.profile.transport.maxDailyTransportMinutes;
    if (!reached.ok) {
      return { minutes: null, driveMinutes: 0, driveCap, transportCap };
    }
    return {
      minutes: reached.roundTripMinutes,
      driveMinutes: reached.driveMinutes,
      driveCap,
      transportCap,
    };
  };

  for (const candidate of stillHomeless) {
    unscheduled.push(
      unscheduledFor(
        candidate,
        days.length,
        accessByUnitDate,
        unitByPlaceId,
        dates,
        roundTripFromBase(candidate.place.id),
        openDates.get(candidate.place.id) ?? new Set(dates),
      ),
    );
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
  const foodFits = (plain: DayLayout, withFood: DayLayout, day: DayPlan['day']): boolean => {
    if (withFood.violations.length > plain.violations.length) return false;
    /**
     * And the day still has to end when the day ends.
     *
     * The plain layout was proved against this ceiling by the packer; the
     * food-bearing one is the only layout in the planner that is never packed,
     * so until this test existed nothing measured it against the clock at all.
     * A short departure day is where that showed: the packer settles a day that
     * finishes on the window, breakfast shifts everything after it by the length
     * of a coffee, and the return drive lands a minute past. `item_outside_window`
     * is an error, the reviser has no move that shortens a meal, and the refusal
     * gate throws the whole trip away — thirty-two of four hundred and five
     * ordinary questionnaires got no itinerary at all, over a minute.
     *
     * Measured with `latestFinishFor` rather than `day.window.endMinute` so this
     * agrees with the packer and the validator to the minute, including the
     * evening-meal overrun all three of them grant.
     */
    if (withFood.endMinute > latestFinishFor(day, config, withFood)) return false;
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
    if (withFood.driveMinutes > driveCapOn(day.date)) return false;
    if (withFood.travelMinutes > travelCapOn(day.date)) return false;
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
      const keepFood = withFood !== plain && foodFits(plain.layout, withFood.layout, plan.day);
      /*
       * Named venues first, held hours second, nothing third — and the second
       * rung is the one that was missing. Held meals are measured against the
       * same `foodFits` ceiling as named ones, so this can never buy back the
       * stop the named layout cost; where even an hour will not fit, the day
       * still falls through to `plain`, which is the honest end of the ladder.
       */
      const withHeld =
        !keepFood && heldMealsFood
          ? layoutBestOrder(heldMealContextFor(plan.day), plan.accepted, options)
          : null;
      const keepHeld =
        withHeld !== null &&
        withHeld !== plain &&
        foodFits(plain.layout, withHeld.layout, plan.day);
      const context = keepFood
        ? contextFor(plan.day)
        : keepHeld
          ? heldMealContextFor(plan.day)
          : packingContextFor(plan.day);
      const { scheduled, layout } = keepFood ? withFood : keepHeld ? withHeld! : plain;
      /**
       * THE DAY IS SETTLED, SO WHAT IT NAMED IS NOW A FACT.
       *
       * Recorded here and nowhere earlier. `chooseFoodStop` must stay blind to
       * what a *packing attempt* chose — the packer re-lays a day out many
       * times and a plan that remembered attempts would depend on how many it
       * took — but a finished day is the same finished day however it was
       * reached, so later days may read it. This is the ledger the variety cap
       * is enforced against; without it the cap counted heads of shortlists and
       * a plain seven-day trip named one deli three times.
       */
      if (foodContext) {
        for (const item of layout.items) {
          const venueId = item.kind === 'meal' ? item.food?.venueId : undefined;
          if (!venueId) continue;
          foodContext.namedOnSettledDays.set(
            venueId,
            (foodContext.namedOnSettledDays.get(venueId) ?? 0) + 1,
          );
        }
      }
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
            `${displayNameOf(candidate.place)} could not be fitted into day ${plan.day.dayNumber} once the rest of it was laid out.`,
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

      const built = buildDay(
        context,
        plan.accepted.filter((candidate) => placed.has(candidate.place.id)),
        layout,
        summariseDayTransport(scheduled, layout, input.access, travelKnowledge.permitted),
        weatherForDay(plan, onDay, scheduledEverywhere(plans)),
      );

      /*
       * A transfer day says so, on the day itself.
       *
       * Otherwise a traveller reads a day with two stops and no explanation for
       * why it is lighter than the others — and the two or three hours they will
       * actually spend moving are invisible until they are sitting in the car.
       * The theme is the one line every day already carries, so it is the honest
       * place for it.
       */
      if (!isTransfer(plan.day.date)) return built;
      const arriving = (input.basePortfolio?.bases ?? []).find(
        (base) => base.order > 0 && base.fromDate === plan.day.date,
      );
      return {
        ...built,
        theme: arriving
          ? `Moving to ${arriving.baseName} — about ${Math.round(arriving.transferMinutesFromPrevious)} minutes on the road`
          : built.theme,
      };
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
      // A locked stop sits on its day because the traveller pinned it there.
      // Attributing that to the forecast would be a claim about a decision
      // the weather never made.
      if (lockedDayByPlace.has(candidate.place.id)) continue;
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
          ? `${displayNameOf(candidate.place)} moved off day ${would} — this was the least bad day for it in the forecast, not a good one. ${weather.assessment.summary}`
          : `${displayNameOf(candidate.place)} is on this day rather than day ${would} because the forecast suits it better here. ${weather.assessment.summary}`,
      );
    }

    const pool: BackupCandidate[] = reachable
      .filter((candidate) => !scheduledPlaceIds.has(candidate.place.id))
      .map((candidate) => ({
        place: candidate.place,
        travelMinutesFromBase: candidate.travelMinutesFromBase,
        travelModeFromBase: candidate.travelModeFromBase,
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
      maxTransportMinutes: input.profile.transport.maxDailyTransportMinutes,
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
    ...(input.travelLegs ? { travelLegs: input.travelLegs } : {}),
    placesById,
    baseId: input.baseId,
    access: input.access,
    hours: input.hours,
    weather: input.weather,
    foodPlan: currentFoodPlan(),
    hadFoodDataset: input.food !== undefined,
    ...(input.now ? { now: input.now } : {}),
  });
  /**
   * Findings the planner resolved by removing their subject.
   *
   * Held apart from the live list and merged into every revalidation, because a
   * revalidation asks "what is wrong with the plan as it stands" and the answer
   * is legitimately "nothing" once the offending thing is gone. That is exactly
   * how a dietary conflict used to vanish: correct question, correct answer,
   * lost finding. These survive every subsequent pass by construction rather
   * than by each pass remembering to carry them.
   */
  const carriedIssues: ValidationIssue[] = [];
  const revalidate = () => [...carriedIssues, ...validateItinerary(validationInput())];

  let issues = revalidate();

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

  /**
   * Food errors are resolved by taking the food off — and the finding stays.
   *
   * The reassignment below (`issues = validateItinerary(...)`) is what made this
   * a silence: the meals come off, the plan re-validates, and the new list has no
   * dietary conflict in it because there is no longer a venue to conflict with.
   * A `strict_dietary_conflict` — a venue's own statement that it cannot meet a
   * requirement the traveller declared — disappeared with no trace anywhere, and
   * the revision note said only "what we had picked did not hold up".
   *
   * Carried forward instead: original code, original message, downgraded to a
   * warning because the plan no longer contains the hazard, and flagged so no
   * surface can mistake it for a live problem or for something nobody found.
   */
  if (foodErrorDays.length > 0) {
    const carried = issues
      .filter(
        (issue) =>
          issue.severity === 'error' &&
          FOOD_ISSUE_CODES.has(issue.code) &&
          issue.dayNumber !== undefined,
      )
      .map((issue) => ({ ...issue, severity: 'warning' as const, wasResolvedByRemoval: true }));
    carriedIssues.push(...carried);

    for (const dayNumber of foodErrorDays) {
      foodSuppressed.add(dayNumber);
      const why = carried
        .filter((issue) => issue.dayNumber === dayNumber)
        .map((issue) => issue.message)
        .join(' ');
      revisions.push({
        code: 'changed_meal' as const,
        description: `Took the meals off day ${dayNumber} rather than the stops. ${why}`,
        dayNumber,
      });
    }
    build = buildAll(dayPlans);
    built = build.days;
    issues = revalidate();
  }

  while (passes < config.maxRevisionPasses && issues.some((issue) => issue.severity === 'error')) {
    const outcome = reviseDayPlans(dayPlans, issues);
    revisions.push(...outcome.actions);
    if (!outcome.changed) break;

    dayPlans = outcome.dayPlans;
    for (const { candidate, reason, code } of outcome.removed) {
      unscheduled.push({
        placeId: candidate.place.id,
        name: displayNameOf(candidate.place),
        wasManual: candidate.manual,
        reasonCode: code,
        reason: `Taken out because ${reason}`,
        suggestedRemedy: 'Free up room by dropping another stop, or give the trip more days.',
      });
    }

    build = buildAll(dayPlans);
    built = build.days;
    issues = revalidate();
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
      name: displayNameOf(candidate.place),
      wasManual: candidate.manual,
      reasonCode: 'hours_do_not_fit',
      reason: message,
      suggestedRemedy: 'Drop something else from that day, or give the trip another day.',
    });
  }
  if (build.dropped.size > 0) issues = revalidate();

  const scheduledCount = built.reduce(
    (sum, day) => sum + day.items.filter((item) => item.kind === 'activity').length,
    0,
  );
  /**
   * How many days of the trip actually got something, counted once.
   *
   * The count of stops and the count of days holding them are different facts —
   * six stops on one day and six stops across six days are the same number and
   * not the same trip — and the readiness level, the itinerary's status and the
   * sentence a traveller reads must all be levelled from the same measurement of
   * the second. Live plans were failing on it: "1 stop across 1 of 6 days".
   */
  const daysWithActivity = built.filter((day) =>
    day.items.some((item) => item.kind === 'activity'),
  ).length;
  /**
   * The same count, restricted to the days that could hold anything.
   *
   * A departure morning with a nine o'clock flight has zero usable minutes and
   * an empty day on it is not a gap; an arrival evening has a couple of hours
   * and one stop on it is not a full day. Readiness was measuring distribution
   * by comparing a count over *all* days against a day figure the edges had
   * already been taken out of, so a stop on the arrival evening paid for one of
   * the inner days — and four inner days holding one activity apiece, each with
   * five empty daylight hours, cleared the test.
   *
   * Both numbers come from the planner's own windows, which are the thing that
   * decided the shape in the first place.
   */
  const fullDayCapacity = Math.max(1, ...days.map((day) => day.capacityMinutes));
  /*
   * Usable days in units of *this trip's own full day*, not in whole dates.
   *
   * `dayCount - 2` modelled the two edges as costing exactly one full day, which
   * is a guess about a shape the planner has already measured: an arrival at
   * four leaves two hours and a departure at nine leaves none. Counting dates
   * with any usable minutes at all is the opposite error and cost a road trip
   * its verdict — a two-hour arrival evening counted as a whole day of capacity
   * and the plan read `insufficient`.
   *
   * `capacityMinutes` is the planner's own answer to "how much of this day may
   * be filled" (`edgeDayCapacityShare` is what shapes an edge day lighter), so
   * the ratio is a reading of the model rather than a second opinion about it.
   */
  const usableDays =
    days.reduce((sum, day) => sum + day.capacityMinutes, 0) / fullDayCapacity;
  /*
   * Distribution is a different question and takes a different denominator: the
   * days the trip can actually *fill*. Two exclusions, and both are the
   * planner's own shaping rather than a judgement added here — a departure
   * morning with nothing on it is not a gap, and neither is an arrival evening.
   *
   * The edge exclusion was missing and it cost a plainly good trip its verdict:
   * an eight-day road journey holding nine stops across six inner days read
   * "not enough here to plan a trip around", because a two-hour arrival evening
   * cleared the ninety-minute floor, joined the denominator, and then failed to
   * be anchored — on a day `edgeDayCapacityShare` exists to keep light.
   */
  const anchorableDates = new Set(
    days
      .filter((day) => !day.isEdgeDay && day.capacityMinutes >= MIN_PLANNABLE_MINUTES)
      .map((day) => day.date),
  );
  const usableDaysWithActivity = built.filter(
    (day) => anchorableDates.has(day.date) && day.items.some((item) => item.kind === 'activity'),
  ).length;

  /**
   * A plan with no stops is not a plan, and must never be returned as one.
   *
   * It used to be. `empty_itinerary` was a *warning*, so five dated days with a
   * transport strategy, a food plan and nothing to do came back as
   * `ready_with_cautions` — and a live Bali compilation produced exactly that,
   * with the one sentence explaining it buried among seven food warnings. A
   * traveller would have been shown, and could have downloaded, five empty days.
   *
   * So it is a refusal, and the refusal carries the funnel: how many were
   * considered, chosen, measurable, reachable and placed, what blocked the rest,
   * and which changes would move it. That is strictly more than the itinerary
   * could ever have said, because an itinerary has nowhere to put it.
   */
  /**
   * The funnel, measured at every gate rather than derived from the ends.
   *
   * Each number answers a different question, and the whole value of the
   * breakdown is that "nothing has a travel time" and "everything is shut" both
   * end at zero and want completely different responses from the traveller.
   */
  const funnelFor = (scheduled: number) => ({
    considered: input.candidates.length,
    selected: input.selections.filter((selection) => selection.status !== 'excluded').length,
    eligible: measurableCount,
    accessFeasible: reachable.length,
    hoursFeasible: plannable.length,
    feasible: plannable.length,
    scheduled,
  });

  const readinessFor = (scheduled: number): PlannerReadiness =>
    buildPlannerReadiness({
      funnel: funnelFor(scheduled),
      unscheduled: dedupeUnscheduled(unscheduled),
      dayCount: days.length,
      /*
       * Both halves of the completeness invariant come from here, because this
       * is where the traveller and the built days are both in hand. A readiness
       * record without them can still say what was lost and cannot say whether
       * what is left is a trip — which is exactly the blindness that let a
       * six-day plan holding one stop read as ready.
       */
      profile: input.profile,
      daysWithActivity,
      usableDays,
      anchorableDays: anchorableDates.size,
      usableDaysWithActivity,
      daysWithFullMeals: built.filter(
        (day) => day.food.slots.length > 0 && day.food.reservations.length > 0,
      ).length,
      unresolved: {
        /**
         * Every count here is "we could not establish this", never "the answer
         * is no". The two look alike in a total and want opposite responses: a
         * missing travel time is something a rebuild might fix, and a closure is
         * not.
         */
        routePairs: unscheduled.filter((entry) => entry.reasonCode === 'missing_travel_data')
          .length,
        criticalHours: eligible.filter(
          (candidate) =>
            hoursByPlaceDate.get(hoursKey(candidate.place.id, dates[0]!))?.status === 'unknown',
        ).length,
        accessRequirements: eligible.length - reachable.length,
        blockingClosures: unscheduled.filter(
          (entry) => entry.reasonCode === 'closed_on_trip_dates',
        ).length,
      },
    });

  if (scheduledCount === 0) {
    return {
      ok: false,
      code: 'planner_coverage_insufficient',
      message:
        'We could not put a single stop into a day, so there is no plan to show you. What blocked it is below.',
      readiness: readinessFor(0),
    };
  }

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
    matrixMode: input.matrix.mode,
    ...(input.transit ? { transit: input.transit } : {}),
  });
  issues = [...issues, ...validateStrategy(transportStrategy, built)];

  /**
   * THE COVERAGE VERDICT, WHERE THE ITINERARY'S OWN STATUS CAN SEE IT.
   *
   * `statusFor` reads severities, and severities came only from conflicts — so a
   * plan holding one stop across six days had nothing wrong with it and was
   * headed "Ready, with cautions / The plan works". Readiness now knows better
   * (`coverageOf`), and the two surfaces must not disagree about one plan: the
   * shortfall is raised here as the issue it is, which carries it into
   * `itinerary.status` and into the issue list a traveller can read, from the
   * same single measurement the board's panel is levelled from.
   */
  const coverage = coverageOf({
    funnel: funnelFor(scheduledCount),
    unscheduled: dedupeUnscheduled(unscheduled),
    dayCount: days.length,
    profile: input.profile,
    daysWithActivity,
    usableDays,
    anchorableDays: anchorableDates.size,
    usableDaysWithActivity,
  });
  if (coverage?.short) {
    issues.push({
      code: 'coverage_below_pace',
      severity: 'error',
      message: `This plan holds ${scheduledCount} ${scheduledCount === 1 ? 'stop' : 'stops'} across ${coverage.daysWithActivity} of your ${days.length} days. At the pace you asked for these dates have room for around ${Math.round(coverage.pacedStops)}, so there is not yet enough here to plan a trip around.`,
    });
  } else if (coverage?.incomplete) {
    /*
     * Short of what this traveller asked for, and not so short that it stops
     * being a trip. A warning rather than an error for exactly that reason: the
     * days that were built are correct and the traveller can use them, and the
     * thing they must not be told is that the plan is finished.
     */
    issues.push({
      code: 'coverage_below_pace',
      severity: 'warning',
      /*
       * DELIBERATELY NOT "N STOPS ACROSS X OF Y DAYS".
       *
       * That is `summarise`'s sentence, and it counts a different set of days:
       * every day of the trip, against the days a stop can be built around.
       * Printed in the same shape on the same page the two read as a straight
       * contradiction — a live Osaka plan opened with "8 stops across 6 of 6
       * days" and closed with "8 stops across 4 of the 4 days it could fill",
       * and a traveller has no way to tell that both are true of different
       * denominators. So the spread is said as spread rather than as a second
       * fraction, and the number this warning is actually about — the volume
       * gap — is the one left in figures.
       */
      message: `This plan holds ${scheduledCount} ${scheduledCount === 1 ? 'stop' : 'stops'}, ${
        coverage.usableDaysWithActivity >= coverage.anchorableDays
          ? 'on every day it could build one around'
          : `on ${coverage.usableDaysWithActivity} of the ${coverage.anchorableDays} ${coverage.anchorableDays === 1 ? 'day' : 'days'} it could build one around`
      }. At the pace and the free time you asked for, these dates have room for around ${coverage.expected} — so there is more of this trip still to choose.`,
    });
  }

  /**
   * A successful plan has no unresolved errors in it. That was not true.
   *
   * `planTrip` returned `ok: true` after a bounded revision loop whatever the
   * loop had managed, and the only refusal was "nothing was scheduled at all".
   * So a plan that exceeded the traveller's driving cap, arrived somewhere
   * before it opened, and left a must-do out came back as a success with a
   * `needs_decision` badge on it — a complete, downloadable-looking itinerary
   * carrying errors nobody had resolved. Two contradictory claims about the same
   * artifact, and the confident one is the one a traveller reads.
   *
   * The loop is deliberately blunt and bounded and should stay that way; raising
   * `maxRevisionPasses` buys oscillation, not correctness. What changes is what
   * happens when it runs out: the plan is refused and the reasons are handed back
   * as readiness, rather than shipped with a badge.
   *
   * Errors carried forward from a resolved-by-removal finding are excluded by
   * construction — they are warnings, and the thing they described is gone.
   *
   * `REQUEST_NOT_MET_CODES` are excluded deliberately, and the distinction is
   * the difference between a broken plan and a disappointing one. "This day
   * exceeds the driving you agreed to" is a defect in the itinerary. "Devils
   * Postpile is shut on your dates and you asked for it" is not — the days that
   * were built are correct, the request is reported by name with the reason, and
   * refusing the whole trip over it would replace a good plan with no plan.
   */
  const unresolved = blockingIssues(issues);
  if (unresolved.length > 0) {
    /**
     * The readiness handed back has to describe *this* refusal.
     *
     * `readinessFor` derives its level and summary from the unscheduled funnel,
     * which for a gate failure is healthy — every stop was scheduled, the plan
     * is simply wrong — so it returned `level: 'ready'` with the summary "All 9
     * places you picked are in the plan", underneath a panel headed "We did not
     * build a plan". Two claims in one view, and no cause named.
     */
    const base = readinessFor(scheduledCount);
    return {
      ok: false,
      code: 'planner_coverage_insufficient',
      message:
        unresolved.length === 1
          ? `We could not build a day that works: ${unresolved[0]!.message}`
          : `We could not build days that work. ${unresolved.length} things are unresolved, starting with: ${unresolved[0]!.message}`,
      readiness: {
        ...base,
        level: 'partial',
        summary:
          unresolved.length === 1
            ? `Everything you picked fits, but one thing about the days themselves does not work yet: ${unresolved[0]!.message}`
            : `Everything you picked fits, but ${unresolved.length} things about the days themselves do not work yet. The first is: ${unresolved[0]!.message}`,
        /*
         * The unresolved errors, as the blockers they are. Without these the
         * remedy list has nothing to rank against and every remedy falls into
         * "what would not help" — a refusal that names no cause and offers no
         * action.
         */
        unresolvedIssues: unresolved.map((issue) => ({
          code: issue.code,
          message: issue.message,
          ...(issue.dayNumber === undefined ? {} : { dayNumber: issue.dayNumber }),
        })),
      },
    };
  }

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
    /**
     * Readiness on the success path too.
     *
     * A plan that holds four of the nine things somebody picked is a real plan
     * and an incomplete one, and saying so is better than letting them count the
     * cards. A readiness record that only existed on failure could also never be
     * compared across two builds of the same trip.
     */
    return {
      ok: true,
      itinerary: itinerarySchema.parse(itinerary),
      readiness: readinessFor(scheduledCount),
    };
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
  /** Whether a vehicle is on offer at all, so a remedy is never one they ruled out. */
  hasCar: boolean,
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
    name: displayNameOf(candidate.place),
    wasManual: candidate.manual,
    reasonCode: reasonCodeForAccess(first?.code),
    reason:
      first?.message ??
      'We have no record of a way to reach this on your dates, so we will not put it on a day.',
    suggestedRemedy: remedyForAccess(first?.code, hasCar),
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
      : displayNameOf(candidate.place);
    const reason = weekday
      ? `${displayNameOf(candidate.place)} is shut on every day of the week your trip covers — ${what} does not open on any of them.`
      : `${displayNameOf(candidate.place)} is closed for the season on your dates.`;
    return {
      placeId: candidate.place.id,
      name: displayNameOf(candidate.place),
      wasManual: candidate.manual,
      reasonCode: 'closed_on_trip_dates',
      reason,
      suggestedRemedy: 'Move your dates into a period it is open, or take it off the board.',
    };
  }

  return {
    placeId: candidate.place.id,
    name: displayNameOf(candidate.place),
    wasManual: candidate.manual,
    reasonCode: 'hours_do_not_fit',
    reason: `${displayNameOf(candidate.place)} is open on your dates, but never for long enough after you could get there — a ${candidate.durationMinutes} min visit does not fit inside its hours on any day of this trip.`,
    suggestedRemedy:
      'Start the day earlier, or free up a day by dropping something else from the board.',
  };
}

/**
 * A stop the traveller pinned to a specific day that did not end up there.
 *
 * Every lock now resolves to exactly one observable state: scheduled on its
 * pinned day (directly, by `assignToDays`'s own Stage B, or via the
 * post-assignment move that follows it), or reported here — never silently
 * absent. That third, previously-real possibility is exactly what let a
 * real, resolved, routable locked anchor disappear from a live Iceland run
 * with no record anywhere of what happened to it.
 */
function lockConflict(candidate: PlanningCandidate, notRoutableToTargetBase: boolean): UnscheduledPlace {
  return {
    placeId: candidate.place.id,
    name: displayNameOf(candidate.place),
    wasManual: candidate.manual,
    reasonCode: notRoutableToTargetBase ? 'missing_travel_data' : 'not_feasible',
    reason: notRoutableToTargetBase
      ? `${displayNameOf(candidate.place)} was pinned to a specific day, but no measured route exists from that day's own base to it, so it could not be scheduled there.`
      : `${displayNameOf(candidate.place)} was pinned to a specific day, but could not be placed on it.`,
    suggestedRemedy: notRoutableToTargetBase
      ? 'Move the pin to a day based somewhere closer, or unpin it and let the plan place it where it can be reached.'
      : 'Unpin it and let the plan choose a day for it, or check that the day it was pinned to is part of this trip.',
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
    name: displayNameOf(candidate.place),
    wasManual: candidate.manual,
    reasonCode: 'weather_incompatible',
    reason: reason
      ? `${displayNameOf(candidate.place)} is out on every day of this trip: ${reason.text}.`
      : `${displayNameOf(candidate.place)} cannot be done in the weather forecast for any day of this trip.`,
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
    case 'walk_too_long':
      /*
       * A walk past the traveller's own limit is a transport conflict, not an
       * absence of data — the road was measured, the derived walk was computed,
       * and the traveller's answers are what rule both out. Filing it under the
       * default `access_unavailable` hid the one remedy that would actually
       * change the outcome.
       *
       * The comment sits below the labels rather than between them: eslint's
       * `no-fallthrough` reads anything between two case clauses as a statement
       * and calls the grouping accidental.
       */
      return 'transport_mode_unavailable';
    case 'no_access_data':
      return 'missing_travel_data';
    default:
      return 'access_unavailable';
  }
}

function remedyForAccess(code: string | undefined, hasCar: boolean): string | undefined {
  switch (code) {
    case 'service_out_of_season':
      return 'Move your dates into the season the service runs, or drop this from the board.';
    case 'service_not_operating':
      return 'Shift a day so it lands on a day the service runs.';
    case 'needs_private_vehicle':
      /*
       * A REMEDY IS SOMETHING THIS TRAVELLER CAN ACTUALLY DO.
       *
       * "Renting one would open up most of the region" is useful to somebody
       * weighing a hire car and useless to somebody who has already said they
       * are not driving — for them it is the same class of answer as telling a
       * car-free trip to raise its daily driving limit. What is left for them
       * is the fact and the one decision that follows from it, which is the
       * honest half of the same sentence.
       */
      return hasCar
        ? 'This needs a vehicle. Renting one would open up most of the region.'
        : 'Nothing scheduled goes there and a vehicle is the only way in, so this is one to drop.';
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
  roundTrip: RoundTrip,
  /** The dates this place is open long enough for the visit, as the planner resolved them. */
  openOn: ReadonlySet<string>,
): UnscheduledPlace {
  const unit = unitByPlaceId.get(candidate.place.id);
  /**
   * THE DAYS THIS COULD ACTUALLY HAVE GONE ON — BOTH HALVES OF THAT.
   *
   * A day could have held this stop only if there was a way in *and* the venue
   * was open long enough for the visit. This counted the first and not the
   * second, so a place open two days a week fell straight past the branch below
   * and out of the generic bottom of the function as "there was no day in these
   * 5 with the hours and the travel budget left for it" — printed, on a real
   * plan, directly beside a completely empty mid-trip day with eight and a
   * quarter hours free on it. A traveller reads that and goes looking for room
   * they already have.
   *
   * `openOn` is the same per-date opening set the planner used to decide the
   * stop was plannable at all, so the explanation and the decision cannot come
   * to different conclusions about which days were ever available.
   */
  const reachableDates = unit
    ? dates.filter((date) => resolved.get(accessKey(unit.key, date))?.available)
    : [...dates];
  const usableDates = reachableDates.filter((date) => openOn.has(date));
  const reachableDays = usableDates.length;

  /**
   * Getting there and back, on its own, is further than they will drive in a day.
   *
   * Checked before "there was no room", because the two send a traveller to
   * change completely different things and the generic one was hiding the
   * specific one. A live Bali compilation reported nine places as
   * `no_time_left` — "no day with the hours and the travel budget left for it" —
   * when the truth was that the nearest of them was a 157-minute round trip
   * against a 150-minute daily limit, on an empty day. No amount of freeing up
   * room would ever have helped.
   */
  /**
   * TWO BUDGETS, TWO SENTENCES, AND NEITHER BORROWS THE OTHER'S QUANTITY.
   *
   * The driving cap bounds only the part spent at a wheel; the travelling cap
   * bounds the whole journey. Charging a round trip to the driving cap because
   * one of its two legs was a drive produced "about 70 minutes of driving, and
   * you said 60 was your limit" for a journey containing twenty-five minutes of
   * driving — a false quantity, and a remedy pointing at the wrong limit.
   */
  if (roundTrip.driveMinutes > roundTrip.driveCap) {
    return {
      placeId: candidate.place.id,
      name: displayNameOf(candidate.place),
      wasManual: candidate.manual,
      reasonCode: 'exceeds_daily_travel',
      reason: `Getting there and back is about ${Math.round(roundTrip.driveMinutes)} minutes of driving, and you said ${roundTrip.driveCap} was your limit for a day.`,
      suggestedRemedy: 'Raise your daily driving limit, or base the trip somewhere nearer to it.',
    };
  }
  if (roundTrip.minutes !== null && roundTrip.minutes > roundTrip.transportCap) {
    return {
      placeId: candidate.place.id,
      name: displayNameOf(candidate.place),
      wasManual: candidate.manual,
      reasonCode: 'exceeds_daily_travel',
      reason: `Getting there and back is about ${Math.round(roundTrip.minutes)} minutes of travelling, and you said ${roundTrip.transportCap} was your limit for a day.`,
      suggestedRemedy: 'Raise your daily travelling limit, or base the trip somewhere nearer to it.',
    };
  }

  // Distinguishing "there was no room" from "there was room, but not on the days
  // it runs" is the difference between a useful remedy and a shrug. The two
  // sentences below split that again, because "no way in on Tuesday" and "shut
  // on Tuesday" send a traveller to change entirely different things.
  if (reachableDays > 0 && reachableDays < dayCount) {
    const boundByHours = usableDates.length < reachableDates.length;
    return {
      placeId: candidate.place.id,
      name: displayNameOf(candidate.place),
      wasManual: candidate.manual,
      reasonCode: boundByHours ? 'hours_do_not_fit' : 'service_not_operating',
      reason: boundByHours
        ? `It is only open on ${reachableDays} of your ${dayCount} days, and those days were already full.`
        : `Only ${reachableDays} of your ${dayCount} days can reach this, and those days were already full.`,
      suggestedRemedy: boundByHours
        ? 'Free up one of the days it opens by dropping something else from the board — a free day it is shut on will not help.'
        : 'Free up one of those days by dropping something else from the board.',
    };
  }

  const optional = !candidate.manual && candidate.selectionStatus === 'maybe';
  return {
    placeId: candidate.place.id,
    name: displayNameOf(candidate.place),
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

export function summarise(
  days: readonly ItineraryDay[],
  scheduled: number,
  unscheduled: number,
): string {
  const activeDays = days.filter((day) => day.totals.activityMinutes > 0).length;
  const driveMinutes = days.reduce((sum, day) => sum + day.totals.driveMinutes, 0);
  /**
   * Named by what the minutes actually are. The old sentence pooled riding,
   * walking and waiting under "riding and on foot", so a trip whose transit
   * total was zero still claimed hours of riding — a mode split the plan's own
   * totals contradicted one screen further down.
   */
  const rideMinutes = days.reduce(
    (sum, day) => sum + day.totals.transitMinutes + day.totals.waitMinutes,
    0,
  );
  const walkMinutes = days.reduce((sum, day) => sum + day.totals.walkMinutes, 0);
  /**
   * Held for journeys nobody could price, and named as that rather than pooled.
   *
   * Pooling them into the walking figure is the sentence a live plan opened
   * with: "6 hr 46 min on foot to reach them", over a trip whose every long leg
   * was a proxy for a train. The minutes are real and belong in the summary;
   * what they are not is a mode.
   */
  const unverifiedMinutes = days.reduce((sum, day) => sum + day.totals.unverifiedMinutes, 0);
  const parts = [
    `${scheduled} ${scheduled === 1 ? 'stop' : 'stops'} across ${activeDays} of ${days.length} days`,
  ];
  if (driveMinutes > 0) parts.push(`about ${spanOf(driveMinutes)} of driving`);
  if (rideMinutes > 0 && walkMinutes > 0) {
    parts.push(`${spanOf(rideMinutes + walkMinutes)} riding and on foot to reach them`);
  } else if (rideMinutes > 0) {
    parts.push(`${spanOf(rideMinutes)} riding to reach them`);
  } else if (walkMinutes > 0) {
    parts.push(`${spanOf(walkMinutes)} on foot to reach them`);
  }
  if (unverifiedMinutes > 0) {
    parts.push(`${spanOf(unverifiedMinutes)} held for journeys we could not verify`);
  }
  if (unscheduled > 0) parts.push(`${unscheduled} left off, each with a reason`);
  return `${parts.join(', ')}.`;
}

/**
 * "3 hr 20 min", never "3.3 hours" — the one place on the plan that spoke in
 * decimal hours while every other surface says hours and minutes.
 *
 * Rounded up to five, and to the same five the itinerary prints. Every figure
 * this composes is travel, and the page renders the same quantities through
 * `roundedTravel` — so with exact minutes here the two disagreed in the reader's
 * eye on one screen: "2 hr 51 min on foot to reach them" in the summary, "On
 * foot to reach things 2 hr 55 min" in the panel five lines below. Neither
 * understated the journey, which is the property that matters, but a page
 * giving two answers for one quantity makes a reader wonder which to believe.
 * The step is stated here rather than imported because `@sidequest/planner` may
 * not depend on the web app.
 */
const TRAVEL_DISPLAY_STEP = 5;

function spanOf(minutes: number): string {
  const whole = Math.ceil(Math.round(minutes) / TRAVEL_DISPLAY_STEP) * TRAVEL_DISPLAY_STEP;
  if (whole < 60) return `${whole} min`;
  const hrs = Math.floor(whole / 60);
  const rest = whole % 60;
  return rest === 0 ? `${hrs} hr` : `${hrs} hr ${rest} min`;
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
