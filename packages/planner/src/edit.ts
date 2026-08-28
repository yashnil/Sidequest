import {
  displayNameOf,
  INTEREST_LABELS,
  itinerarySchema,
  type DiscoverySelection,
  type Itinerary,
  type ItineraryDay,
  type Place,
  type UnscheduledPlace,
  type ValidationIssue,
} from '@sidequest/core';
import {
  buildAccessUnits,
  resolveAccess,
  accessKey,
  summariseDayTransport,
  type AccessOption,
  type AccessUnit,
} from './access';
import { chooseBackups, summariseDayWeather, type BackupCandidate } from './backups';
import { pinnedPriority, resolveCandidates } from './candidates';
import { buildFoodPlan } from './food-plan';
import { resolveFood, type FoodContext } from './food';
import { couldVisitOnDate, hoursKey, resolveOperatingHours, type PlaceDayHours } from './hours';
import { summarise } from './plan';
import {
  admissionRefusal,
  buildDay,
  isOpenOnDate,
  latestFinishFor,
  layoutBestOrder,
  packDay,
  type DayLayout,
  type LayoutContext,
  type PackOptions,
  type ScheduledUnit,
} from './schedule';
import { buildTransportStrategy } from './strategy';
import { travelKnowledgeFor } from './travel';
import { resolveConfig, type PlannerInput, type PlanningCandidate } from './types';
import { blockingIssues, statusFor, validateItinerary, validateStrategy } from './validate';
import { resolveWeather, weatherKeyFor, type PlaceDayWeather } from './weather';
import { buildDailyWindows, type PlannedDay } from './windows';

/**
 * SMART EDITING, THE §11.1 WAY: STRUCTURED INTENT → DETERMINISTIC REPLAN.
 *
 * A traveller who wants one stop off day three must not be sent back to the
 * start, and must not have days one, two and four re-decided underneath them —
 * a full replan is free to reshuffle everything, and "I removed a museum and my
 * hike moved to Thursday" is a betrayal wearing an optimisation.
 *
 * So every edit here rebuilds exactly one day, from the same pure functions
 * `planTrip` builds it with, and splices it into the stored plan. The other
 * days are the same objects byte for byte — asserted by test, not by
 * intention. Trip-level derivations (the transport strategy, the food plan,
 * the validation record, the summary) are recomputed from the new days,
 * because those are *descriptions* of the days and must never disagree with
 * them.
 *
 * No LLM is anywhere near this. The intent arrives as data, the replan is the
 * scheduler, and the validation is the validator.
 */

/**
 * Effort as an ordering. `none` sits below `easy`: a place with no physical
 * demand at all is the easiest thing a day can hold.
 */
const INTENSITY_RANK: Record<Place['physicalIntensity'], number> = {
  none: 0,
  easy: 1,
  moderate: 2,
  strenuous: 3,
};

export type ItineraryEditResult =
  | { ok: true; itinerary: Itinerary; changed: string }
  | { ok: false; message: string };

/** A context-aware replacement offer, never a generic recommendation list. */
export interface SwapAlternative {
  placeId: string;
  name: string;
  fitScore: number;
  reason: string;
}

/**
 * Everything a one-day rebuild needs, resolved once from the planner input.
 *
 * The same resolutions `planTrip` performs, narrowed to one date where a date
 * is involved. Kept in one place so the three edits cannot drift from each
 * other in what they consider reachable or open.
 */
interface EditWorld {
  config: ReturnType<typeof resolveConfig>;
  knowledge: ReturnType<typeof travelKnowledgeFor>;
  plannedDays: PlannedDay[];
  eligible: PlanningCandidate[];
  eligibleById: Map<string, PlanningCandidate>;
  /** The whole board as plannable supply, for swap offers. */
  supplyById: Map<string, PlanningCandidate>;
  placesById: Map<string, Place>;
}

function editWorld(input: PlannerInput): EditWorld {
  const config = resolveConfig(input.config);
  const knowledge = travelKnowledgeFor(input.matrix, input.profile, input.transit);
  const plannedDays = buildDailyWindows(input.basics, input.profile, config);
  const { eligible } = resolveCandidates(
    input.candidates,
    input.selections,
    input.matrix,
    { knowledge, baseId: input.baseId },
    input.profile,
  );

  /**
   * The board's unused supply, as plannable candidates.
   *
   * `eligible` holds only what the traveller selected; a swap draws on the
   * compiled region's *whole* board minus what they excluded. Resolved through
   * the same `resolveCandidates` as everything else — with a synthetic "maybe"
   * per candidate — so a supply candidate carries the same fields, the same
   * travel resolution and the same feasibility judgement as a selected one.
   */
  const excluded = new Set(
    input.selections
      .filter((selection) => selection.status === 'excluded')
      .map((selection) => selection.placeId),
  );
  const synthetic: DiscoverySelection[] = input.candidates
    .filter((candidate) => !excluded.has(candidate.place.id))
    .map((candidate) => ({
      placeId: candidate.place.id,
      status: 'maybe',
      source: 'auto',
      updatedAt: '1970-01-01T00:00:00.000Z',
    }));
  const { eligible: supply } = resolveCandidates(
    input.candidates,
    synthetic,
    input.matrix,
    { knowledge, baseId: input.baseId },
    input.profile,
  );

  /**
   * Locks, applied here for the same reason `planTrip` applies them: a pinned
   * stop is planned as if hand-picked.
   *
   * `editWorld` was written before locks existed and never learned about them,
   * so every candidate reached the edits with `manual: false` — which is how
   * "make this day easier" came to sort a pinned stop by burden like any other,
   * take it off the day, and leave the pin sitting in the database pointing at a
   * day that no longer holds it. The next rebuild read the pin and undid the
   * ease.
   *
   * The lift itself is `pinnedPriority`, shared with `planTrip`, because this
   * line was a hand-written `10_000 + fitScore` and that is the board's *old*
   * order: an edit that pinned a stop re-ranked it by match alone while every
   * unpinned stop around it kept the composed key, so the plan and the board
   * disagreed about exactly the place the traveller had just insisted on.
   */
  const lockedPlaceIds = new Set((input.locks ?? []).map((lock) => lock.placeId));
  const promote = (candidate: PlanningCandidate): PlanningCandidate =>
    lockedPlaceIds.has(candidate.place.id)
      ? { ...candidate, manual: true, priority: pinnedPriority(candidate) }
      : candidate;
  const eligibleLocked = eligible.map(promote);
  const supplyLocked = supply.map(promote);

  return {
    config,
    knowledge,
    plannedDays,
    eligible: eligibleLocked,
    eligibleById: new Map(eligibleLocked.map((candidate) => [candidate.place.id, candidate])),
    supplyById: new Map(supplyLocked.map((candidate) => [candidate.place.id, candidate])),
    placesById: new Map(input.candidates.map((candidate) => [candidate.place.id, candidate.place])),
  };
}

/** The stored day's activities, as the candidates that would rebuild them. */
function candidatesOnDay(
  world: EditWorld,
  day: ItineraryDay,
): { ok: true; candidates: PlanningCandidate[] } | { ok: false; message: string } {
  const candidates: PlanningCandidate[] = [];
  for (const item of day.items) {
    if (item.kind !== 'activity' || !item.placeId) continue;
    const candidate = world.eligibleById.get(item.placeId) ?? world.supplyById.get(item.placeId);
    if (!candidate) {
      return {
        ok: false,
        message: `The board has been rebuilt since this plan was made and no longer carries ${item.title}. Rebuild the trip to edit it.`,
      };
    }
    candidates.push(candidate);
  }
  return { ok: true, candidates };
}

/** Date-scoped resolutions for one rebuild: access, hours, weather, food. */
interface DayWorld {
  plannedDay: PlannedDay;
  unitByPlaceId: Map<string, AccessUnit>;
  accessOptions: Map<string, AccessOption>;
  hours: Map<string, PlaceDayHours>;
  weather: Map<string, PlaceDayWeather>;
  food: FoodContext | null;
}

function dayWorldFor(
  input: PlannerInput,
  world: EditWorld,
  dayNumber: number,
  dayCandidates: readonly PlanningCandidate[],
): DayWorld | null {
  const plannedDay = world.plannedDays.find((entry) => entry.dayNumber === dayNumber);
  if (!plannedDay) return null;
  const date = plannedDay.date;

  /*
   * Units over the whole supply, not only the day's stops, because the backup
   * pool and the swap offers both need to know what else is reachable on this
   * date — the same reason `planTrip` resolves access for everything up front.
   */
  const pool = [...new Map(
    [...world.eligible, ...world.supplyById.values()].map((candidate) => [
      candidate.place.id,
      candidate,
    ]),
  ).values()];
  const units = buildAccessUnits(pool, input.access, input.region.baseName);
  const unitByPlaceId = new Map<string, AccessUnit>();
  for (const unit of units) {
    for (const member of unit.members) unitByPlaceId.set(member.place.id, unit);
  }
  const resolved = resolveAccess({
    units,
    dates: [date],
    dataset: input.access,
    profile: input.profile,
    matrix: input.matrix,
    travel: { knowledge: world.knowledge, baseId: input.baseId },
  });
  const accessOptions = new Map<string, AccessOption>();
  for (const unit of units) {
    const entry = resolved.get(accessKey(unit.key, date));
    if (entry?.available) accessOptions.set(unit.key, entry.option);
  }

  const hoursByPlaceDate = resolveOperatingHours({
    placeIds: pool.map((candidate) => candidate.place.id),
    dates: [date],
    dataset: input.hours,
  });
  const hours = new Map<string, PlaceDayHours>();
  for (const candidate of pool) {
    const entry = hoursByPlaceDate.get(hoursKey(candidate.place.id, date));
    if (entry) hours.set(candidate.place.id, entry);
  }

  const weatherByPlaceDate = resolveWeather({
    places: pool.map((candidate) => ({
      place: candidate.place,
      durationMinutes: candidate.durationMinutes,
      daylightOnly: hours.get(candidate.place.id)?.daylightOnly ?? false,
    })),
    dates: [date],
    dataset: input.weather,
    avoidances: input.profile.avoidances,
  });
  const weather = new Map<string, PlaceDayWeather>();
  for (const candidate of pool) {
    const entry = weatherByPlaceDate.get(weatherKeyFor(candidate.place.id, date));
    if (entry) weather.set(candidate.place.id, entry);
  }

  const food = input.food
    ? resolveFood({
        dataset: input.food,
        profile: input.profile,
        selections: input.foodSelections ?? [],
        days: [{ day: plannedDay, candidates: [...dayCandidates] }],
        matrix: input.matrix,
        baseId: input.baseId,
        windows: world.config.mealWindows,
      })
    : null;

  return { plannedDay, unitByPlaceId, accessOptions, hours, weather, food };
}

function contextFor(
  input: PlannerInput,
  world: EditWorld,
  dayWorld: DayWorld,
  food: FoodContext | null,
): LayoutContext {
  const date = dayWorld.plannedDay.date;
  const base = (input.basePortfolio?.bases ?? []).find(
    (entry) => date >= entry.fromDate && date <= entry.toDate,
  );
  return {
    day: dayWorld.plannedDay,
    baseId: base?.baseId ?? input.baseId,
    baseName: base?.baseName ?? input.region.baseName,
    matrix: input.matrix,
    travel: world.knowledge,
    config: world.config,
    profile: input.profile,
    hours: dayWorld.hours,
    weather: dayWorld.weather,
    food,
    foodDataset: input.food ?? null,
  };
}

function packOptionsFor(
  input: PlannerInput,
  world: EditWorld,
  dayWorld: DayWorld,
): PackOptions {
  const slots = input.profile.derived.activitySlotsPerDay;
  const base = dayWorld.plannedDay.isEdgeDay
    ? slots * world.config.edgeDayCapacityShare
    : slots;
  return {
    maxActivities: Math.max(1, Math.round(base)),
    maxDailyDriveMinutes: input.profile.transport.maxDailyDriveMinutes,
    maxDailyTransportMinutes: input.profile.transport.maxDailyTransportMinutes,
    maxStrenuous: input.profile.derived.preferredPhysicalIntensity === 'strenuous' ? 2 : 1,
    accessByUnit: dayWorld.accessOptions,
    unitByPlaceId: dayWorld.unitByPlaceId,
  };
}

/**
 * The same food-acceptance rule `planTrip` applies: meals may lengthen a day
 * and add accounted-for detours; they may not cost a stop, reorder the route,
 * break a cap, run the day past its own end, or invent a violation.
 */
function foodFits(
  input: PlannerInput,
  world: EditWorld,
  dayWorld: DayWorld,
  plain: DayLayout,
  withFood: DayLayout,
): boolean {
  if (withFood.violations.length > plain.violations.length) return false;
  const sequence = (layout: DayLayout) =>
    layout.items
      .filter((item) => item.kind === 'activity')
      .map((item) => item.placeId ?? '')
      .join('>');
  if (sequence(withFood) !== sequence(plain)) return false;
  if (withFood.driveMinutes > input.profile.transport.maxDailyDriveMinutes) return false;
  if (withFood.travelMinutes > input.profile.transport.maxDailyTransportMinutes) return false;
  /*
   * The clock, read the way the packer and the validator read it. Missing here
   * for the same reason it was missing from `planTrip`'s copy of this rule: the
   * food-bearing layout is the one layout nothing packs, so a breakfast that
   * pushed the drive home a minute past the window went unnoticed until the
   * validator refused the finished plan.
   */
  if (withFood.endMinute > latestFinishFor(dayWorld.plannedDay, world.config, withFood)) return false;
  const claimed = withFood.items.reduce((sum, item) => sum + (item.food?.detourMinutes ?? 0), 0);
  if (withFood.driveMinutes > plain.driveMinutes + claimed) return false;
  return true;
}

interface RebuiltDay {
  day: ItineraryDay;
  layout: DayLayout;
  scheduled: ScheduledUnit[];
  placed: PlanningCandidate[];
  droppedByLayout: { candidate: PlanningCandidate; message: string }[];
}

function rebuildDay(
  input: PlannerInput,
  world: EditWorld,
  dayNumber: number,
  dayCandidates: readonly PlanningCandidate[],
  scheduledElsewhere: ReadonlySet<string>,
): RebuiltDay | { error: string } {
  const dayWorld = dayWorldFor(input, world, dayNumber, dayCandidates);
  if (!dayWorld) return { error: `This trip has no day ${dayNumber}.` };

  const options = packOptionsFor(input, world, dayWorld);
  const packingContext = contextFor(input, world, dayWorld, null);
  /**
   * PACKED, NOT MERELY LAID OUT.
   *
   * `layoutBestOrder` answers "in what order, and at what times"; it is
   * deliberately limit-free, because `packDay` is the thing that owns the
   * traveller's limits. This function used to call the layout alone and then
   * describe whatever came back, so an edit was the one path into a stored plan
   * that no limit bound: eight of the thirty-three replacements the swap menu
   * itself offered produced and saved a day the builder would have refused —
   * one forty minutes over the driving cap the traveller set, one whose drive
   * home landed at 16:09 for a 17:00 flight.
   *
   * Packing first makes an edit answer to exactly what a build answers to. The
   * traveller's stops keep their order in the queue, so anything that has to
   * give is the last thing asked for rather than something they already had.
   */
  const packed = packDay(packingContext, dayCandidates, options);
  const foodContext = dayWorld.food;
  const plain = layoutBestOrder(packingContext, packed.accepted, options);
  const withFood = foodContext
    ? layoutBestOrder(contextFor(input, world, dayWorld, foodContext), packed.accepted, options)
    : plain;
  const keepFood = withFood !== plain && foodFits(input, world, dayWorld, plain.layout, withFood.layout);
  const { scheduled, layout } = keepFood ? withFood : plain;
  const context = keepFood
    ? contextFor(input, world, dayWorld, foodContext)
    : packingContext;

  const placedIds = new Set(
    layout.items
      .filter((item) => item.kind === 'activity' && item.placeId)
      .map((item) => item.placeId!),
  );
  const placed = dayCandidates.filter((candidate) => placedIds.has(candidate.place.id));
  const droppedByLayout = dayCandidates
    .filter((candidate) => !placedIds.has(candidate.place.id))
    .map((candidate) => ({
      candidate,
      /*
       * The named limit, asked of the same function that refused it. Re-asked
       * against the stops that did make the day rather than remembered from the
       * moment of refusal: the accepted set only ever grew after that point, so
       * the answer is the same limit or a stricter one, and never a limit the
       * candidate does not actually break.
       */
      message:
        layout.violations.find((violation) => violation.placeId === candidate.place.id)?.message ??
        admissionRefusal(
          packingContext,
          packed.accepted.filter((entry) => entry.place.id !== candidate.place.id),
          candidate,
          options,
        ) ??
        `${displayNameOf(candidate.place)} could not be fitted into day ${dayNumber} once the rest of it was laid out.`,
    }));

  /* The weather block, rebuilt the way `planTrip` builds it for a day. */
  const onDay = placed
    .map((candidate) => ({ candidate, weather: dayWorld.weather.get(candidate.place.id) }))
    .filter(
      (entry): entry is { candidate: PlanningCandidate; weather: PlaceDayWeather } =>
        entry.weather !== undefined,
    );
  const atRisk = onDay.filter(
    (entry) =>
      entry.weather.assessment.suitability === 'poor' ||
      entry.weather.assessment.suitability === 'incompatible',
  );
  const taken = new Set([...scheduledElsewhere, ...placedIds]);
  const pool: BackupCandidate[] = [...world.eligible, ...world.supplyById.values()]
    .filter(
      (candidate, index, all) =>
        all.findIndex((entry) => entry.place.id === candidate.place.id) === index,
    )
    .filter((candidate) => !taken.has(candidate.place.id))
    .map((candidate) => ({
      place: candidate.place,
      travelMinutesFromBase: candidate.travelMinutesFromBase,
      travelModeFromBase: candidate.travelModeFromBase,
      selectionStatus: candidate.selectionStatus,
      reachable:
        dayWorld.accessOptions.has(dayWorld.unitByPlaceId.get(candidate.place.id)?.key ?? '') ??
        false,
      hours: dayWorld.hours.get(candidate.place.id),
      weather: dayWorld.weather.get(candidate.place.id),
    }));
  const backups = chooseBackups({
    date: dayWorld.plannedDay.date,
    scheduledPlaceIds: taken,
    atRisk,
    pool,
    maxDriveMinutes: input.profile.transport.maxDailyDriveMinutes,
    maxTransportMinutes: input.profile.transport.maxDailyTransportMinutes,
  });
  const weatherSummary = summariseDayWeather({
    date: dayWorld.plannedDay.date,
    onDay,
    representative: onDay[0]?.weather,
    /*
     * No weather-move sentences on an edited day: the counterfactual "where
     * geography alone would have put this" was computed for the original
     * build, and repeating it against a hand-edited day would attribute the
     * traveller's own change to the forecast.
     */
    decisions: [],
    backups,
    ...(atRisk.length > 0 && backups.length === 0
      ? {
          noBackupReason:
            'Nothing else on your board is both reachable that day and genuinely less exposed to this, so we are not going to invent a fallback.',
        }
      : {}),
  });

  const day = buildDay(
    context,
    placed,
    layout,
    summariseDayTransport(scheduled, layout, input.access, world.knowledge.permitted),
    weatherSummary,
  );
  return { day, layout, scheduled, placed, droppedByLayout };
}

/** Everything trip-level, re-derived from the days it now describes. */
function assemble(
  input: PlannerInput,
  world: EditWorld,
  previous: Itinerary,
  newDays: ItineraryDay[],
  unscheduled: UnscheduledPlace[],
  editDescription: string,
  editedDayNumber: number,
): ItineraryEditResult {
  const scheduledCount = newDays.reduce(
    (sum, day) => sum + day.items.filter((item) => item.kind === 'activity').length,
    0,
  );
  if (scheduledCount === 0) {
    return {
      ok: false,
      message:
        'That change would leave the plan with nothing scheduled at all. Remove the plan and rebuild instead.',
    };
  }

  /* The food plan, re-derived trip-wide so `unusedChoices` stays honest. */
  const tripFood = input.food
    ? resolveFood({
        dataset: input.food,
        profile: input.profile,
        selections: input.foodSelections ?? [],
        days: world.plannedDays.map((plannedDay) => ({
          day: plannedDay,
          candidates: (newDays.find((day) => day.dayNumber === plannedDay.dayNumber)?.items ?? [])
            .filter((item) => item.kind === 'activity' && item.placeId)
            .map((item) => world.eligibleById.get(item.placeId!) ?? world.supplyById.get(item.placeId!))
            .filter((candidate): candidate is PlanningCandidate => candidate !== undefined),
        })),
        matrix: input.matrix,
        baseId: input.baseId,
        windows: world.config.mealWindows,
      })
    : null;
  const foodPlan = buildFoodPlan({
    days: newDays,
    profile: input.profile,
    food: tripFood,
    dataset: input.food ?? null,
  });

  const transportStrategy = buildTransportStrategy({
    days: newDays,
    profile: input.profile,
    region: input.region,
    dataset: input.access,
    unscheduled,
    matrixNote: input.matrix.provenance.note,
    matrixProvenance: input.matrix.provenance.kind,
    matrixMode: input.matrix.mode,
    ...(input.transit ? { transit: input.transit } : {}),
  });

  const issues: ValidationIssue[] = [
    ...validateItinerary({
      days: newDays,
      unscheduled,
      profile: input.profile,
      config: world.config,
      matrix: input.matrix,
      placesById: world.placesById,
      baseId: input.baseId,
      access: input.access,
      hours: input.hours,
      weather: input.weather,
      foodPlan,
      hadFoodDataset: input.food !== undefined,
      ...(input.now ? { now: input.now } : {}),
    }),
    ...validateStrategy(transportStrategy, newDays),
  ];

  /**
   * THE SAME GATE THE BUILDER CLOSES, CLOSED BEFORE AN EDIT IS SAVED.
   *
   * `planTrip` refuses to hand back a plan carrying an unresolved error: a day
   * over the traveller's driving cap, a stop scheduled outside its own day, an
   * arrival before opening. Until this existed the edit path had no such gate,
   * so the product's own "Swap for something similar…" menu could — and on the
   * golden Eastern Sierra trip did, in eight of the thirty-three replacements it
   * offered — produce a plan the builder would have refused, badge it
   * "needs decision", and save it over the good one.
   *
   * Refused rather than saved-with-a-badge for the reason `planTrip` gives: a
   * complete, downloadable-looking itinerary carrying errors nobody resolved
   * makes two contradictory claims about itself, and the confident one is the
   * one a traveller reads. Refusing costs them a swap. Saving costs them the
   * plan they already had.
   *
   * `blockingIssues` is shared with the builder's gate so the two cannot come to
   * different conclusions about the same day.
   */
  const blocking = blockingIssues(issues);
  if (blocking.length > 0) {
    return {
      ok: false,
      message:
        blocking.length === 1
          ? `That change does not work: ${blocking[0]!.message}`
          : `That change does not work. ${blocking.length} things about the days would be wrong, starting with: ${blocking[0]!.message}`,
    };
  }

  const itinerary: Itinerary = {
    ...previous,
    status: statusFor(issues),
    summary: summarise(newDays, scheduledCount, unscheduled.length),
    transportStrategy,
    foodPlan,
    days: newDays,
    unscheduled,
    issues,
    diagnostics: {
      ...previous.diagnostics,
      revisions: [
        ...previous.diagnostics.revisions,
        { code: 'traveller_edit', description: editDescription, dayNumber: editedDayNumber },
      ],
      counts: {
        ...previous.diagnostics.counts,
        scheduled: scheduledCount,
        unscheduled: unscheduled.length,
      },
    },
  };

  try {
    return { ok: true, itinerary: itinerarySchema.parse(itinerary), changed: editDescription };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'The edit produced an invalid itinerary.',
    };
  }
}

/** Unscheduled rows minus anything now scheduled or deliberately removed. */
function reconcileUnscheduled(
  previous: Itinerary,
  newDays: readonly ItineraryDay[],
  removedPlaceIds: ReadonlySet<string>,
  additions: readonly UnscheduledPlace[],
): UnscheduledPlace[] {
  const scheduled = new Set(
    newDays.flatMap((day) =>
      day.items
        .filter((item) => item.kind === 'activity' && item.placeId)
        .map((item) => item.placeId!),
    ),
  );
  const kept = previous.unscheduled.filter(
    (entry) => !scheduled.has(entry.placeId) && !removedPlaceIds.has(entry.placeId),
  );
  const byId = new Map<string, UnscheduledPlace>();
  for (const entry of [...kept, ...additions]) {
    if (!scheduled.has(entry.placeId) && !byId.has(entry.placeId)) byId.set(entry.placeId, entry);
  }
  return [...byId.values()].sort(
    (a, b) => Number(b.wasManual) - Number(a.wasManual) || a.placeId.localeCompare(b.placeId),
  );
}

function splice(days: readonly ItineraryDay[], replacement: ItineraryDay): ItineraryDay[] {
  return days.map((day) => (day.dayNumber === replacement.dayNumber ? replacement : day));
}

function scheduledOutside(itinerary: Itinerary, dayNumber: number): Set<string> {
  return new Set(
    itinerary.days
      .filter((day) => day.dayNumber !== dayNumber)
      .flatMap((day) =>
        day.items
          .filter((item) => item.kind === 'activity' && item.placeId)
          .map((item) => item.placeId!),
      ),
  );
}

// ---------------------------------------------------------------------------
// The edits
// ---------------------------------------------------------------------------

export function removeStopFromDay(
  input: PlannerInput,
  itinerary: Itinerary,
  dayNumber: number,
  placeId: string,
): ItineraryEditResult {
  const day = itinerary.days.find((entry) => entry.dayNumber === dayNumber);
  if (!day) return { ok: false, message: `This trip has no day ${dayNumber}.` };
  const removedItem = day.items.find(
    (item) => item.kind === 'activity' && item.placeId === placeId,
  );
  if (!removedItem) {
    return { ok: false, message: `Day ${dayNumber} does not visit that place.` };
  }

  const world = editWorld(input);
  const current = candidatesOnDay(world, day);
  if (!current.ok) return current;
  const remaining = current.candidates.filter((candidate) => candidate.place.id !== placeId);

  const rebuilt = rebuildDay(
    input,
    world,
    dayNumber,
    remaining,
    scheduledOutside(itinerary, dayNumber),
  );
  if ('error' in rebuilt) return { ok: false, message: rebuilt.error };

  const newDays = splice(itinerary.days, rebuilt.day);
  const unscheduled = reconcileUnscheduled(
    itinerary,
    newDays,
    new Set([placeId]),
    rebuilt.droppedByLayout.map(({ candidate, message }) => ({
      placeId: candidate.place.id,
      name: displayNameOf(candidate.place),
      wasManual: candidate.manual,
      reasonCode: 'hours_do_not_fit' as const,
      reason: message,
      suggestedRemedy: 'Drop something else from that day, or give the trip another day.',
    })),
  );
  return assemble(
    input,
    world,
    itinerary,
    newDays,
    unscheduled,
    `You took ${removedItem.title} off day ${dayNumber}; the rest of the day was re-timed around it.`,
    dayNumber,
  );
}

/**
 * THE REPLACEMENTS THIS DAY CAN ACTUALLY HOLD, IN FIT ORDER.
 *
 * Shared by the offer list and by the mutation that applies one. It used to
 * exist only inside the offer generator, which made the *client* the thing that
 * decided a swap was legal: `swapStopOnDay` looked the id up in the supply map
 * and applied none of these rules, so a stale menu — or a hand-made request —
 * could put a place that is already on Thursday onto Tuesday as well, and the
 * plan was saved visiting it twice.
 *
 * Whatever decides what may be offered has to be the same thing that decides
 * what may be applied, or the offer list is documentation rather than a rule.
 */
function feasibleReplacements(
  input: PlannerInput,
  world: EditWorld,
  itinerary: Itinerary,
  day: ItineraryDay,
  dayWorld: DayWorld,
  placeId: string,
): PlanningCandidate[] {
  const outgoing = world.eligibleById.get(placeId) ?? world.supplyById.get(placeId);
  const maxIntensity = outgoing
    ? INTENSITY_RANK[outgoing.place.physicalIntensity]
    : INTENSITY_RANK.moderate;
  const interests = new Set(outgoing?.matchedInterests ?? []);
  if (outgoing?.primaryInterest) interests.add(outgoing.primaryInterest);

  const scheduled = new Set(
    itinerary.days.flatMap((entry) =>
      entry.items
        .filter((item) => item.kind === 'activity' && item.placeId)
        .map((item) => item.placeId!),
    ),
  );

  return [...world.supplyById.values()]
    .filter((candidate) => candidate.place.id !== placeId && !scheduled.has(candidate.place.id))
    .filter((candidate) => isOpenOnDate(candidate.place, day.date))
    .filter((candidate) => {
      /* Transport-feasible: a legal way in exists on this date. */
      const unit = dayWorld.unitByPlaceId.get(candidate.place.id);
      return unit !== undefined && dayWorld.accessOptions.has(unit.key);
    })
    .filter((candidate) => {
      /* Open long enough inside this day's own window. */
      const hours = dayWorld.hours.get(candidate.place.id);
      if (!hours) return false;
      return couldVisitOnDate({
        hours,
        placeName: displayNameOf(candidate.place),
        durationMinutes: candidate.durationMinutes,
        bounds: { startMinute: day.window.startMinute, endMinute: day.window.endMinute },
      });
    })
    .filter((candidate) => INTENSITY_RANK[candidate.place.physicalIntensity] <= maxIntensity)
    .filter(
      (candidate) =>
        interests.size === 0 ||
        (candidate.primaryInterest !== undefined && interests.has(candidate.primaryInterest)) ||
        candidate.matchedInterests.some((interest) => interests.has(interest)),
    )
    /*
     * The board's order, not a second one. This sorted on `fitScore`, so the
     * menu ranked the region's alternatives by match alone while every card the
     * traveller had just been reading was ranked by band and then by how much
     * each place matters — the §10 disagreement, in the one list whose whole
     * job is to say "here is what else your board holds".
     */
    .sort((a, b) => b.boardPriority - a.boardPriority || a.place.id.localeCompare(b.place.id));
}

/**
 * ONE SWAP, APPLIED, ALL THE WAY TO A PLAN THAT WOULD BE SAVED.
 *
 * Shared by the mutation and by the offer generator, and that sharing is the
 * point rather than a tidy-up. Everything that can refuse a swap lives past
 * this line: `packDay`'s caps, the day's own clock, and `assemble`'s gate on
 * the validator. `feasibleReplacements` above knows none of it — it judges each
 * candidate on its own against the *whole* day window, as though the day were
 * empty — so an offer list built from it alone is a list of places that would
 * fit a day the traveller does not have.
 */
function applyReplacement(
  input: PlannerInput,
  world: EditWorld,
  itinerary: Itinerary,
  day: ItineraryDay,
  dayCandidates: readonly PlanningCandidate[],
  outgoing: { placeId: string; title: string },
  replacement: PlanningCandidate,
): ItineraryEditResult {
  const dayNumber = day.dayNumber;
  const replacementId = replacement.place.id;
  const next = [
    ...dayCandidates.filter((candidate) => candidate.place.id !== outgoing.placeId),
    /* The traveller chose it by name; it packs like a hand-pick. */
    { ...replacement, manual: true, priority: pinnedPriority(replacement) },
  ];

  const rebuilt = rebuildDay(input, world, dayNumber, next, scheduledOutside(itinerary, dayNumber));
  if ('error' in rebuilt) return { ok: false, message: rebuilt.error };
  if (!rebuilt.placed.some((candidate) => candidate.place.id === replacementId)) {
    const why = rebuilt.droppedByLayout.find(
      (entry) => entry.candidate.place.id === replacementId,
    );
    return {
      ok: false,
      message:
        why?.message ??
        `${displayNameOf(replacement.place)} cannot be fitted into day ${dayNumber} as it stands.`,
    };
  }

  const newDays = splice(itinerary.days, rebuilt.day);
  const unscheduled = reconcileUnscheduled(
    itinerary,
    newDays,
    new Set([outgoing.placeId]),
    rebuilt.droppedByLayout
      .filter((entry) => entry.candidate.place.id !== replacementId)
      .map(({ candidate, message }) => ({
        placeId: candidate.place.id,
        name: displayNameOf(candidate.place),
        wasManual: candidate.manual,
        reasonCode: 'hours_do_not_fit' as const,
        reason: message,
        suggestedRemedy: 'Drop something else from that day, or give the trip another day.',
      })),
  );
  return assemble(
    input,
    world,
    itinerary,
    newDays,
    unscheduled,
    `You swapped ${outgoing.title} for ${displayNameOf(replacement.place)} on day ${dayNumber}.`,
    dayNumber,
  );
}

/**
 * HOW MANY REPLACEMENTS ARE TRIED BEFORE THE MENU GIVES UP.
 *
 * A ceiling on work, not on honesty: the loop stops early the moment it has
 * enough offers, and this only bounds the case where a day is so full that
 * nothing fits. Twenty-four rebuilds of one day is a few tens of milliseconds
 * on the compiled regions the product ships, and the alternative — an unbounded
 * scan of a metropolitan board's supply — would make opening a menu the slowest
 * thing in the product.
 *
 * Stopping early can under-offer, and that is the direction to err in. A
 * replacement that exists past the budget and is never shown costs the
 * traveller one option they did not know about. One that is shown and always
 * fails costs them their trust in every other row of the menu.
 */
const MAX_SWAP_TRIALS = 24;

/**
 * Context-aware replacements: same day, same time-window, comparable effort,
 * overlapping interests, reachable and open on that date, drawn from the same
 * compiled region's unused board supply. §11.3: never a generic list.
 *
 * AND EVERY ONE OF THEM APPLIES.
 *
 * `feasibleReplacements` judges a candidate the way a board does — is this
 * place open that day, is there a way in, is it no harder than what it
 * replaces — and a day is not a board. It already holds three other stops, a
 * drive budget that is two thirds spent and a flight at five. Measured across a
 * twenty-four scenario sweep of the golden region, **228 of the 676
 * replacements this menu offered could not be applied**, and 26 menus were
 * dead in full: every row an error toast, including departure days where the
 * traveller got four options and four refusals.
 *
 * So the offer is now the *outcome* of the swap rather than a prediction about
 * it: each candidate is applied against the stored plan, in board order, and
 * only the ones that come back a plan we would save are offered. Refusals are
 * still worth having at the mutation — a menu can go stale in an open tab —
 * but no longer at the rate of one row in three.
 *
 * The cost is real and it is bounded: at most `MAX_SWAP_TRIALS` one-day
 * rebuilds, stopping at `limit` offers, on a path that runs when a traveller
 * opens one menu. An offer list nobody can act on is not cheaper, it is just
 * quicker to be wrong.
 */
export function swapAlternativesForStop(
  input: PlannerInput,
  itinerary: Itinerary,
  dayNumber: number,
  placeId: string,
  limit = 5,
): SwapAlternative[] {
  const day = itinerary.days.find((entry) => entry.dayNumber === dayNumber);
  if (!day) return [];
  const outgoing = day.items.find((item) => item.kind === 'activity' && item.placeId === placeId);
  if (!outgoing) return [];
  const world = editWorld(input);
  const dayWorld = dayWorldFor(input, world, dayNumber, []);
  if (!dayWorld) return [];
  const current = candidatesOnDay(world, day);
  if (!current.ok) return [];

  const offers: SwapAlternative[] = [];
  let tried = 0;
  for (const candidate of feasibleReplacements(input, world, itinerary, day, dayWorld, placeId)) {
    if (offers.length >= limit || tried >= MAX_SWAP_TRIALS) break;
    tried += 1;
    const outcome = applyReplacement(
      input,
      world,
      itinerary,
      day,
      current.candidates,
      { placeId, title: outgoing.title },
      candidate,
    );
    if (!outcome.ok) continue;
    offers.push({
      placeId: candidate.place.id,
      name: displayNameOf(candidate.place),
      fitScore: candidate.fitScore,
      reason: candidate.primaryInterest
        ? `Matches your interest in ${INTEREST_LABELS[candidate.primaryInterest].toLowerCase()}, and it works on this day.`
        : 'Reachable and open on this day, and fits how you said you travel.',
    });
  }
  return offers;
}

export function swapStopOnDay(
  input: PlannerInput,
  itinerary: Itinerary,
  dayNumber: number,
  placeId: string,
  replacementId: string,
): ItineraryEditResult {
  const day = itinerary.days.find((entry) => entry.dayNumber === dayNumber);
  if (!day) return { ok: false, message: `This trip has no day ${dayNumber}.` };
  const outgoing = day.items.find((item) => item.kind === 'activity' && item.placeId === placeId);
  if (!outgoing) return { ok: false, message: `Day ${dayNumber} does not visit that place.` };

  const world = editWorld(input);
  const replacement = world.supplyById.get(replacementId) ?? world.eligibleById.get(replacementId);
  if (!replacement) {
    return { ok: false, message: 'That replacement is not on this trip’s board any more.' };
  }

  /**
   * THE OFFER, RE-DERIVED. THE MUTATION IS THE TRUST BOUNDARY.
   *
   * The id arrives from a browser, out of a menu that may have been open for an
   * hour and across which two other edits may have landed. Trusting it meant a
   * replacement already scheduled on another day sailed through — the offer
   * generator filters those out and this function consulted no other day at all
   * — and the plan was saved visiting one place twice.
   *
   * Re-derived rather than merely checked against the other days, because every
   * rule the offer list applies is a rule about whether this swap is honest:
   * open that date, a way in that date, inside the day's own window, no harder
   * than the stop it replaces.
   */
  const offerDayWorld = dayWorldFor(input, world, dayNumber, []);
  if (!offerDayWorld) return { ok: false, message: `This trip has no day ${dayNumber}.` };
  const feasible = feasibleReplacements(input, world, itinerary, day, offerDayWorld, placeId);
  if (!feasible.some((candidate) => candidate.place.id === replacementId)) {
    const elsewhere = itinerary.days.find(
      (entry) =>
        entry.dayNumber !== dayNumber &&
        entry.items.some((item) => item.kind === 'activity' && item.placeId === replacementId),
    );
    return {
      ok: false,
      message: elsewhere
        ? `${displayNameOf(replacement.place)} is already on day ${elsewhere.dayNumber} of this trip.`
        : `${displayNameOf(replacement.place)} is not one of the replacements that work on day ${dayNumber}. Open the swap menu again for the current list.`,
    };
  }

  const current = candidatesOnDay(world, day);
  if (!current.ok) return current;
  return applyReplacement(
    input,
    world,
    itinerary,
    day,
    current.candidates,
    { placeId, title: outgoing.title },
    replacement,
  );
}

/**
 * "Make this day easier": an intensity cap for one day's replan.
 *
 * Deterministic and explained — the heaviest stops go first (strenuous before
 * long), each removal is a named unscheduled row, and the loop stops the
 * moment the rebuilt day's own intensity classification steps down.
 */
export function easeDay(
  input: PlannerInput,
  itinerary: Itinerary,
  dayNumber: number,
): ItineraryEditResult {
  const day = itinerary.days.find((entry) => entry.dayNumber === dayNumber);
  if (!day) return { ok: false, message: `This trip has no day ${dayNumber}.` };
  if (day.intensity === 'light') {
    return { ok: false, message: `Day ${dayNumber} is already light — there is nothing to ease.` };
  }

  const world = editWorld(input);
  const current = candidatesOnDay(world, day);
  if (!current.ok) return current;
  if (current.candidates.length <= 1) {
    return {
      ok: false,
      message: `Day ${dayNumber} holds a single stop; removing it would empty the day rather than ease it. Remove the stop directly if that is what you want.`,
    };
  }

  /**
   * A pinned stop is not a candidate for removal, however heavy it is.
   *
   * The traveller said "keep this here" and then said "make this day easier";
   * the second does not cancel the first. Before this, `easeDay` never read the
   * locks at all — it took the heaviest stop off, which on a day pinned to a
   * hike is exactly the pinned one, and left the lock in storage pointing at a
   * day that no longer visited it. The day came back easier, the next rebuild
   * read the pin and put the hike straight back.
   */
  const lockedHere = new Set(
    (input.locks ?? [])
      .filter((lock) => lock.dayNumber === dayNumber)
      .map((lock) => lock.placeId),
  );
  const removable = current.candidates.filter(
    (candidate) => !lockedHere.has(candidate.place.id),
  );
  if (removable.length === 0) {
    return {
      ok: false,
      message: `Every stop on day ${dayNumber} is locked, so there is nothing here we may take off. Unlock one and ask again if you want the day lighter.`,
    };
  }

  const target = day.intensity === 'intense' ? new Set(['moderate', 'light']) : new Set(['light']);
  /* Heaviest first: strenuous outranks long, duration breaks ties. */
  const byBurden = [...removable].sort(
    (a, b) =>
      INTENSITY_RANK[b.place.physicalIntensity] - INTENSITY_RANK[a.place.physicalIntensity] ||
      b.durationMinutes - a.durationMinutes ||
      a.place.id.localeCompare(b.place.id),
  );

  let remaining = [...current.candidates];
  const removed: PlanningCandidate[] = [];
  let rebuilt: RebuiltDay | null = null;
  for (const next of byBurden) {
    if (remaining.length <= 1) break;
    remaining = remaining.filter((candidate) => candidate.place.id !== next.place.id);
    removed.push(next);
    const attempt = rebuildDay(
      input,
      world,
      dayNumber,
      remaining,
      scheduledOutside(itinerary, dayNumber),
    );
    if ('error' in attempt) return { ok: false, message: attempt.error };
    rebuilt = attempt;
    if (target.has(attempt.day.intensity)) break;
  }
  if (!rebuilt) {
    return { ok: false, message: `Day ${dayNumber} could not be made easier without emptying it.` };
  }
  /**
   * "Easier" means a lighter band, not merely fewer stops. The loop above can
   * exhaust every removable stop and still hold a day whose remaining stop is
   * what makes it heavy — and returning `ok` with the same intensity is the
   * one answer this edit's contract does not allow: the traveller asked for an
   * easier day and would get a shorter equally-heavy one with no sentence
   * saying why. Say plainly that the day's weight is not in its removable
   * stops.
   */
  if (!target.has(rebuilt.day.intensity)) {
    return {
      ok: false,
      message:
        `Day ${dayNumber} stays ${rebuilt.day.intensity} even with its removable stops taken off — ` +
        'what remains is what makes it heavy. Remove or unlock a stop directly if you want it lighter.',
    };
  }

  const newDays = splice(itinerary.days, rebuilt.day);
  const additions: UnscheduledPlace[] = [
    ...removed.map((candidate) => ({
      placeId: candidate.place.id,
      name: displayNameOf(candidate.place),
      wasManual: candidate.manual,
      reasonCode: 'exceeds_intensity' as const,
      reason: `Taken off day ${dayNumber} to make it easier, at your request.`,
      suggestedRemedy: 'Put it back from the board if you change your mind.',
    })),
    ...rebuilt.droppedByLayout.map(({ candidate, message }) => ({
      placeId: candidate.place.id,
      name: displayNameOf(candidate.place),
      wasManual: candidate.manual,
      reasonCode: 'hours_do_not_fit' as const,
      reason: message,
    })),
  ];
  const unscheduled = reconcileUnscheduled(itinerary, newDays, new Set(), additions);
  const names = removed.map((candidate) => displayNameOf(candidate.place)).join(', ');
  return assemble(
    input,
    world,
    itinerary,
    newDays,
    unscheduled,
    `You asked for an easier day ${dayNumber}: ${names} came off and the rest was re-timed.`,
    dayNumber,
  );
}
