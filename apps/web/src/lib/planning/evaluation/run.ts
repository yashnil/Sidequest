import {
  assembleScanRegion,
  stayTravellerFor,
  buildTravelerProfile,
  compileSpatialOrder,
  defaultAnswers,
  estimatedScanMatrix,
  normalizeScanProposal,
  planScanPoints,
  tripSchema,
  unavailableWeatherDataset,
  validateCompiledRegion,
  type CompiledRegion,
  type DiscoverySelection,
  type QuestionnaireAnswers,
  type ResolvedPosition,
  type TravelTimeMatrixData,
  type TravelerProfile,
  type Trip,
} from '@sidequest/core';
import { buildDailyWindows, resolveConfig } from '@sidequest/planner';
import { boardFor, type RegionContext } from '../../region';
import { buildCanonicalTripBuildInput } from '../canonical-input';
import { plannerAutoPick } from '../planner-autopick';
import { composeWithPlanner, planningRecordOf, type PlannerComposition } from '../planner-composer';
import { createPlannerKernel, planStructure, scoreStructure, slotOf, tourMinutes, UNKNOWN_LEG_MINUTES, type PlannedDay, type StructurePlan, type StructurePlannerInput } from '../structure-planner';
import type { BoardFixture } from './boards';
import type { ProfileCase } from './profiles';

/**
 * RELEASE CANDIDATE — ONE BOARD, ONE TRAVELLER, THE REAL PLANNER, MEASURED.
 *
 * `runCase` does what the product does between a located scan proposal and the
 * trip draft, with nothing stubbed: the production assembler chooses the bases
 * and writes the `CompiledRegion`, the region is validated as a stored one is,
 * the Discovery Board is built from it, the planner is asked for its picks
 * (`plannerAutoPick`) and then for the trip (`composeWithPlanner`) with the
 * traveller's own includes fixed. No model, no provider, no database, no clock:
 * the same board and traveller always give the same numbers.
 *
 * What is measured is what the planner decided — the structure — before
 * verification. Every figure comes from the planner's own minutes function, so
 * "minutes saved by a move" is read off the matrix the plan was built on.
 *
 * What this cannot see, said here so nobody reads a zero as a pass: travel
 * times are the estimator's (no router is recorded for these boards), opening
 * hours are unknown on every scan-built region until verification asks a
 * provider, and meal *venues* are chosen downstream of the planner.
 */

export const EVALUATION_NOW = new Date('2027-04-01T09:00:00.000Z');
const START_DATE = '2027-05-10';

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export interface CaseSetup {
  trip: Trip;
  profile: TravelerProfile;
  region: CompiledRegion;
  context: RegionContext;
  carAvailable: boolean;
  maxBaseChanges: number;
}

export interface MoveMetric {
  from: string;
  to: string;
  nights: number;
  transferMinutes: number;
  /** Minutes of day travel the stay saves against commuting to the same stops from the previous base. */
  grossSavedMinutes: number;
  /** Gross saving less the transfer that bought it. */
  netSavedMinutes: number;
  /** Gross saving per day spent at the new base. */
  savedPerDay: number;
}

export interface CaseMetrics {
  board: string;
  boardLabel: string;
  source: BoardFixture['source'];
  profile: string;
  ok: boolean;
  error?: string;
  days: number;
  nights: number;
  mode: 'car' | 'no_car';
  structure: {
    basesProposed: number;
    stays: { base: string; nights: number; transferMinutesFromPrevious: number }[];
    distinctBases: number;
    hotelMoves: number;
    oneNightStays: number;
    maxBaseChangesAllowed: number;
    /** The assembler's own record of the choice, when it writes one. */
    decision: unknown;
  };
  travel: {
    limitMinutes: number;
    totalMinutes: number;
    sightseeingMinutes: number;
    transferMinutes: number;
    perDay: number[];
    meanPerDay: number;
    maxDay: number;
    /** Legs the plan timed with the unknown-leg allowance because nobody measured or could estimate them. */
    unknownLegs: number;
    matrixBasis: string;
  };
  moves: MoveMetric[];
  /** The same board planned from one base only (the stay with the most nights), for comparison. Null when the trip already has one base. */
  stayPut: { base: string; totalTravelMinutes: number; stops: number; score: number; mustsPlaced: number } | null;
  plan: {
    poolSize: number;
    stops: number;
    score: number;
    mustsAsked: number;
    mustsPlaced: number;
    /** Days the repair pass changed before anyone saw the plan. */
    repairs: number;
  };
  defects: {
    /** Days whose loop, evening run, sunrise run and transfer together pass the traveller's daily limit. */
    daysOverTravelLimit: number;
    /** The same, by the planner's own narrower rule (loop + evening run only). */
    daysOverTravelLimitPlannerRule: number;
    overTravelMinutes: number;
    /** Of the days over the limit: the transfer between stays (or to/from the gateway) is over it on its own. */
    overLimitTransferAlone: number;
    /** …a moving day whose transfer is within the limit but whose transfer and stops together are not. */
    overLimitMovingDay: number;
    /** …no transfer, and the day holds the traveller's own include (which the limit never removes). */
    overLimitOwnPick: number;
    /** …anything else: Sidequest's own picks, or a sunrise run nobody counted. */
    overLimitOther: number;
    /** Days whose transfer, legs, visits and lunch run past the day's window. */
    overfullDays: number;
    overfullMinutes: number;
    /** Of the overfull days: those holding the traveller's own include. */
    overfullOwnPick: number;
    emptyInteriorDays: number;
    /** Of those, days whose transfer spent the traveller's travel limit: the journey is the day. */
    emptyInteriorMovingDays: number;
    oneStopDays: number;
    /** One-stop days using under half their capacity while an unscheduled place within reach would pass the planner's own day rules. */
    oneStopDaysWithCompatibleNeighbour: number;
    backtrackingDays: number;
    backtrackExcessKm: number;
    strenuousBackToBack: number;
    heavyArrivalDay: number;
    heavyDepartureDay: number;
    arrivalLoad: number;
    departureLoad: number;
    missingLunch: number;
    missingDinner: number;
    /** Scheduled stops on a date their published calendar says is closed. */
    hoursConflicts: number;
    stopsWithKnownHours: number;
    stopsWithUnknownHours: number;
    droppedMusts: number;
    /** Defect days (over limit, overfull, heavy edge, back-to-back hard) that the plan does not state anywhere. */
    unstatedDefectDays: number;
  };
  /** Day-level notes the planner recorded, when it records any. */
  notes: string[];
}

const INTERESTS_FOR_EVERYONE: Partial<QuestionnaireAnswers['interests']> = {
  scenic_viewpoints: 'frequent',
  easy_nature_walks: 'frequent',
  history_and_culture: 'frequent',
  hiking: 'occasional',
  food_and_towns: 'occasional',
  museums_and_galleries: 'occasional',
  neighbourhoods_and_local_life: 'occasional',
  architecture_and_landmarks: 'occasional',
  beaches_and_swimming: 'occasional',
  markets_and_street_food: 'occasional',
  lakes_and_rivers: 'occasional',
};

export function setupCase(fixture: BoardFixture, profileCase: ProfileCase): CaseSetup {
  const days = profileCase.days ?? fixture.nights + 1;
  const dates = Array.from({ length: days }, (_, i) => addDays(START_DATE, i));
  const regionId = `eval-${fixture.key.replace(/[^a-z0-9]+/gi, '-')}`;
  const trip = tripSchema.parse({
    id: `trip-${regionId}-${profileCase.key}`,
    basics: {
      mode: 'known_destination',
      destinationInput: fixture.destinationName,
      regionId,
      startDate: dates[0]!,
      endDate: dates[dates.length - 1]!,
      /* The allowance a trip row holds when nobody has stated a flight. */
      arrivalTime: '15:00',
      departureTime: '11:00',
      adults: 2,
      children: profileCase.children,
      travelerNeeds: profileCase.needs,
    },
    status: 'discovering',
    createdAt: EVALUATION_NOW.toISOString(),
    updatedAt: EVALUATION_NOW.toISOString(),
  });
  const context = { travelerNeeds: trip.basics.travelerNeeds, tripDays: days };
  const defaults = defaultAnswers(context);
  const answers: QuestionnaireAnswers = {
    ...defaults,
    interests: { ...defaults.interests, ...INTERESTS_FOR_EVERYONE },
    pace: profileCase.pace,
    baseMoveTolerance: profileCase.hotelMoves,
    willDrive: profileCase.car,
    ...(profileCase.maxDailyTravelMinutes !== undefined ? { maxDailyTravelMinutes: profileCase.maxDailyTravelMinutes } : {}),
  };
  const profile = buildTravelerProfile(answers, context);
  const canonical = buildCanonicalTripBuildInput({ trip, composer: null, profile, now: EVALUATION_NOW });
  const carAvailable = canonical.movement.carAvailable !== false;
  const maxBaseChanges = canonical.movement.maxBaseChanges.value ?? 1;

  // --- the proposal, as the scan's own normaliser reads it ---------------------------------
  const normalized = normalizeScanProposal({
    bases: fixture.bases.map((b) => ({ name: b.name, locality: b.name, nightsHint: b.nightsHint, why: 'A practical place to sleep.' })),
    candidates: fixture.places.map((p) => ({
      name: p.name,
      locality: p.locality,
      kind: p.kind,
      tier: p.tier,
      durationMinutes: p.durationMinutes,
      intensity: p.intensity,
      costLevel: 1,
      exposure: p.exposure,
      bestTime: p.bestTime,
      crowd: p.tier === 'classic' ? 'busy' : 'moderate',
      booking: p.booking,
      rainyDayOk: p.rainyDayOk,
      ...(p.interests ? { interests: p.interests } : {}),
      ...(p.zone ? { zone: p.zone } : {}),
      why: `${p.name} is worth the time.`,
    })),
    foodAreas: [],
    skipped: [],
    package: { transportSummary: '', transportNotes: [], beforeYouGo: [], packing: [], foodStrategy: [], bookingPriorities: [] },
  });
  if (!normalized.ok) throw new Error(normalized.reason);
  const proposal = normalized.proposal;
  const positions = new Map<string, ResolvedPosition | null>();
  proposal.bases.forEach((b, i) => positions.set(b.key, { coordinates: fixture.bases[i]!.coordinates, method: 'geocoder', provider: 'recorded', approximate: false }));
  const placeByName = new Map(fixture.places.map((p) => [`${p.name}|${p.locality}`, p] as const));
  for (const c of proposal.candidates) {
    const place = placeByName.get(`${c.name}|${c.locality}`);
    positions.set(c.key, place ? { coordinates: place.coordinates, method: 'geocoder', provider: 'recorded', approximate: false } : null);
  }
  const plan = planScanPoints(proposal, positions);
  const mode: 'car' | 'foot' = carAvailable ? 'car' : 'foot';
  const estimated = estimatedScanMatrix(plan.points, mode);
  const matrix: TravelTimeMatrixData = fixture.crossing
    ? { ...estimated, minutes: estimated.minutes.map((row, i) => row.map((m, j) => (i === j ? 0 : m + (fixture.crossing!(plan.points[i]!.coordinates, plan.points[j]!.coordinates) ?? 0)))) }
    : estimated;

  const windows = buildDailyWindows(trip.basics, profile, resolveConfig());
  const usable = (w: (typeof windows)[number] | undefined) => (w ? Math.max(0, w.window.endMinute - w.window.startMinute) : 0);
  const assembled = assembleScanRegion({
    regionId,
    destinationName: fixture.destinationName,
    entityType: fixture.entityType,
    breadth: fixture.entityType === 'city' ? 'city' : fixture.entityType === 'island' ? 'subregion' : fixture.entityType === 'country' ? 'country' : 'region',
    center: fixture.center,
    timeZone: 'UTC',
    dates,
    carAvailable: canonical.movement.carAvailable,
    maxBaseChanges,
    ...(fixture.gateway ? { edges: { arrival: fixture.gateway, departure: fixture.gateway, arrivalUsableMinutes: usable(windows[0]), departureUsableMinutes: usable(windows[windows.length - 1]) } } : {}),
    traveller: stayTravellerFor({ trip, profile, carAvailable, maxDailyTravelMinutes: canonical.movement.maxDailyTravelMinutes.value ?? profile.transport.maxDailyTransportMinutes, maxDailyDriveMinutes: canonical.movement.maxDailyDriveMinutes.value ?? null }),
    dayMinutes: windows.map((w) => usable(w)),
    ...(fixture.namedParts ? { namedParts: fixture.namedParts } : {}),
    mustSeeKeys: proposal.candidates.filter((c) => placeByName.get(`${c.name}|${c.locality}`)?.must).map((c) => c.key),
    proposal,
    positions,
    plan,
    matrix,
    createdAt: EVALUATION_NOW.toISOString(),
    providers: { proposal: 'evaluation-fixture', placement: ['recorded'], routing: 'distance estimates' },
  });
  const region = validateCompiledRegion(assembled.region);

  const primaryBase = region.bases.find((b) => b.id === region.primaryBaseId)!;
  const months = [...new Set(dates.map((d) => Number(d.slice(5, 7))))];
  const weather = unavailableWeatherDataset({ regionId: region.region.id, locations: region.weatherLocations, dates, now: EVALUATION_NOW, reason: 'not_configured', message: 'No forecast in the evaluation.' });
  const regionContext = {
    region: region.region,
    places: region.places,
    access: region.access,
    hours: region.operatingHours,
    weather,
    weatherAvailability: { kind: 'absent' },
    weatherScopeKey: 'evaluation',
    food: region.food ?? null,
    matrix: region.travelTimes,
    transit: region.transitEvidence,
    scheduledNetwork: null,
    baseId: primaryBase.routingId,
    basePortfolio: region.basePortfolio,
    months,
    dates,
    compiled: region,
  } as unknown as RegionContext;
  return { trip, profile, region, context: regionContext, carAvailable, maxBaseChanges };
}

export function composeCase(fixture: BoardFixture, setup: CaseSetup): { composition: PlannerComposition; mustIds: string[] } {
  const { trip, profile, context } = setup;
  const board = boardFor(trip, profile, context);
  const canonical = buildCanonicalTripBuildInput({ trip, composer: null, profile, now: EVALUATION_NOW });
  const mustNames = new Set(fixture.places.filter((p) => p.must).map((p) => p.name));
  const mustIds = board.candidates.filter((c) => mustNames.has(c.place.name)).map((c) => c.place.id);
  const at = EVALUATION_NOW.toISOString();
  const userRows: DiscoverySelection[] = mustIds.map((placeId) => ({ placeId, status: 'included', source: 'user', updatedAt: at }));
  const picks = plannerAutoPick({ trip, profile, region: context, candidates: board.candidates, selections: userRows, extras: null, composer: null, now: EVALUATION_NOW });
  const autoRows: DiscoverySelection[] = picks.selectedIds.map((placeId) => ({ placeId, status: 'included', source: 'auto', updatedAt: at }));
  const composition = composeWithPlanner({
    trip,
    profile,
    region: context,
    candidates: board.candidates,
    selections: [...userRows, ...autoRows],
    extras: null,
    destinationName: fixture.destinationName,
    carAvailable: setup.carAvailable,
    maxDailyTravelMinutes: canonical.movement.maxDailyTravelMinutes.value ?? profile.transport.maxDailyTransportMinutes,
    ...(canonical.movement.maxDailyDriveMinutes.value ? { maxDailyDriveMinutes: canonical.movement.maxDailyDriveMinutes.value } : {}),
  });
  return { composition, mustIds };
}

/* ---------------------------------------------------------------------------------------------
 * Measurement
 * ------------------------------------------------------------------------------------------- */

function dayTravel(input: StructurePlannerInput, day: PlannedDay, index: number, total: number): { loop: number; evening: number; sunrise: number; transfer: number; unknown: number } {
  const base = input.bases.find((b) => b.id === day.baseId);
  let sunrise = 0;
  let unknown = 0;
  for (const s of day.stops) {
    if (s.slot === 'sunrise') sunrise += (input.minutes(day.baseId, s.candidate.id) ?? UNKNOWN_LEG_MINUTES) * 2;
    if (s.slot !== 'day' && input.minutes(day.baseId, s.candidate.id) === null) unknown += 1;
  }
  let previous = day.baseId;
  const daytime = day.stops.filter((s) => s.slot === 'day');
  for (const s of daytime) {
    if (input.minutes(previous, s.candidate.id) === null) unknown += 1;
    previous = s.candidate.id;
  }
  if (daytime.length > 0 && input.minutes(previous, day.baseId) === null) unknown += 1;
  const transfer = (day.relocation ? base?.transferMinutesFromPrevious ?? 0 : 0) + (index === 0 ? input.edgeTransfers?.arrivalMinutes ?? 0 : 0) + (index === total - 1 && total > 1 ? input.edgeTransfers?.departureMinutes ?? 0 : 0);
  return { loop: day.travelMinutes, evening: day.eveningTravelMinutes, sunrise, transfer, unknown };
}

/** When a day's stops, legs, transfer and lunch end, against its window. */
function dayOverrun(input: StructurePlannerInput, day: PlannedDay, index: number, total: number, previousBaseOf?: (index: number) => string | undefined): number {
  const window = input.windows.find((w) => w.date === day.date);
  if (!window) return 0;
  const daytime = day.stops.filter((s) => s.slot === 'day');
  if (daytime.length === 0) return 0;
  const base = input.bases.find((b) => b.id === day.baseId);
  /* A moving day runs last night's base → stops → tonight's base, so the transfer is inside its legs (`detourMinutes`). */
  const leftFrom = previousBaseOf?.(index);
  let clock = window.startMinute + (index === 0 ? input.edgeTransfers?.arrivalMinutes ?? 0 : 0) + (day.relocation && !leftFrom ? base?.transferMinutesFromPrevious ?? 0 : 0);
  let previous = leftFrom ?? day.baseId;
  let lunched = !(window.startMinute <= 13 * 60 && window.endMinute >= 13 * 60);
  for (const s of daytime) {
    clock += (input.minutes(previous, s.candidate.id) ?? UNKNOWN_LEG_MINUTES) + s.candidate.durationMinutes;
    previous = s.candidate.id;
    if (!lunched && clock >= 12 * 60 + 30) {
      clock += 60;
      lunched = true;
    }
  }
  clock += input.minutes(previous, day.baseId) ?? UNKNOWN_LEG_MINUTES;
  if (index === total - 1 && total > 1) clock += input.edgeTransfers?.departureMinutes ?? 0;
  return Math.max(0, Math.round(clock - window.endMinute));
}

function totalTravel(input: StructurePlannerInput, plan: StructurePlan): number {
  return plan.days.reduce((n, day, i) => {
    const t = dayTravel(input, day, i, plan.days.length);
    return n + t.loop + t.evening + t.sunrise + t.transfer;
  }, 0);
}

export function measureCase(fixture: BoardFixture, profileCase: ProfileCase, setup: CaseSetup, composed: { composition: PlannerComposition; mustIds: string[] }): CaseMetrics {
  const { composition, mustIds } = composed;
  const { plan, plannerInput: input, draft } = composition;
  const total = plan.days.length;
  const limit = input.maxDailyTravelMinutes;
  const baseName = new Map(input.bases.map((b) => [b.id, b.name] as const));
  const baseAt = new Map(input.bases.map((b) => [b.id, b.coordinates] as const));
  const kernel = createPlannerKernel(input);
  const state = plan.days.map((d) => d.stops.map((s) => s.candidate));
  const scheduled = new Set(state.flat().map((c) => c.id));
  const record = planningRecordOf(composition) as unknown as { dayNotes?: { dayNumber: number; code: string; note: string }[] };
  const statedDays = new Set((record.dayNotes ?? []).map((n) => n.dayNumber));
  const draftNotes = new Map(draft.days.map((d) => [d.dayNumber, d.note ?? ''] as const));

  const perDay: number[] = [];
  let sightseeing = 0;
  let transfers = 0;
  let unknownLegs = 0;
  let daysOverLimit = 0;
  let daysOverLimitPlannerRule = 0;
  let overTravelMinutes = 0;
  let overLimitTransferAlone = 0;
  let overLimitMovingDay = 0;
  let overLimitOwnPick = 0;
  let overLimitOther = 0;
  let overfullOwnPick = 0;
  let overfullDays = 0;
  let overfullMinutes = 0;
  let emptyInterior = 0;
  let emptyInteriorMoving = 0;
  let oneStop = 0;
  let oneStopWithNeighbour = 0;
  let backtrackingDays = 0;
  let backtrackExcessKm = 0;
  let strenuousBackToBack = 0;
  let missingLunch = 0;
  let missingDinner = 0;
  let unstated = 0;
  const loadOf = (day: PlannedDay, index: number) => {
    const window = input.windows.find((w) => w.date === day.date);
    const t = dayTravel(input, day, index, total);
    const span = Math.max(1, (window ? window.endMinute - window.startMinute : 540) - t.transfer);
    return Math.round(((day.activityMinutes + day.travelMinutes) / span) * 100) / 100;
  };

  plan.days.forEach((day, index) => {
    const t = dayTravel(input, day, index, total);
    const all = t.loop + t.evening + t.sunrise + t.transfer;
    perDay.push(Math.round(all));
    sightseeing += t.loop + t.evening + t.sunrise;
    transfers += t.transfer;
    unknownLegs += t.unknown;
    const interior = index > 0 && index < total - 1;
    let defect = false;
    const ownPick = day.stops.some((s) => s.candidate.status === 'must');
    if (all > limit) {
      daysOverLimit += 1;
      overTravelMinutes += Math.round(all - limit);
      if (t.transfer > limit) overLimitTransferAlone += 1;
      else if (t.transfer > 0) overLimitMovingDay += 1;
      else if (ownPick) overLimitOwnPick += 1;
      else overLimitOther += 1;
      defect = true;
    }
    if (t.loop + t.evening > limit) daysOverLimitPlannerRule += 1;
    const overrun = dayOverrun(input, day, index, total, (i) => kernel.days[i]?.previousBaseId);
    if (overrun > 0) {
      overfullDays += 1;
      overfullMinutes += overrun;
      if (ownPick) overfullOwnPick += 1;
      defect = true;
    }
    if (interior && day.stops.length === 0 && day.capacityMinutes >= 60) {
      emptyInterior += 1;
      if (day.relocation) emptyInteriorMoving += 1;
    }
    if (interior && day.stops.length === 1 && !day.relocation) {
      oneStop += 1;
      const used = day.activityMinutes + day.travelMinutes;
      if (used < day.capacityMinutes * 0.5) {
        const only = day.stops[0]!.candidate;
        const neighbour = kernel.plannable.some((c) => {
          if (scheduled.has(c.id) || c.fit < 55) return false;
          const hop = input.minutes(only.id, c.id);
          if (hop === null || hop > 30) return false;
          return kernel.checkDay(index, [only, { ...c, status: c.status === 'candidate' ? 'recommended' : c.status }], (j) => state[j] ?? []).ok;
        });
        if (neighbour) oneStopWithNeighbour += 1;
      }
    }
    const daytime = day.stops.filter((s) => s.slot === 'day');
    if (daytime.length >= 2) {
      const origin = index > 0 && day.relocation ? plan.days[index - 1]!.baseId : day.baseId;
      const report = compileSpatialOrder({
        origin: { id: origin, name: baseName.get(origin) ?? origin, coordinates: baseAt.get(origin) ?? null },
        destination: { id: day.baseId, name: baseName.get(day.baseId) ?? day.baseId, coordinates: baseAt.get(day.baseId) ?? null },
        stops: daytime.map((s) => ({ id: s.candidate.id, name: s.candidate.name, coordinates: s.candidate.coordinates })),
      });
      if (report.verdict === 'violation') {
        backtrackingDays += 1;
        backtrackExcessKm += Math.round(report.excessKm);
      }
    }
    const hard = (d: PlannedDay | undefined) => Boolean(d?.stops.some((s) => s.candidate.intensity === 'strenuous'));
    if (index > 0 && hard(day) && hard(plan.days[index - 1])) {
      strenuousBackToBack += 1;
      defect = true;
    }
    const meals = draft.days[index]?.meals;
    const window = input.windows.find((w) => w.date === day.date);
    if (daytime.length > 0 && window && window.startMinute <= 12 * 60 + 30 && window.endMinute >= 13 * 60 + 30 && !meals?.lunch) missingLunch += 1;
    if (index < total - 1 && !meals?.dinner) missingDinner += 1;
    const edge = index === 0 || index === total - 1;
    if (edge && (loadOf(day, index) > 0.8 || hard(day))) defect = true;
    if (defect && !statedDays.has(day.dayNumber) && !/limit|window|strenuous|hard|long|past|over/i.test(draftNotes.get(day.dayNumber) ?? '')) unstated += 1;
  });

  // --- moves: what each stay saves against commuting from the stay before it ------------------
  const moves: MoveMetric[] = [];
  for (let j = 1; j < input.bases.length; j += 1) {
    const stay = input.bases[j]!;
    const previous = input.bases[j - 1]!;
    if (stay.id === previous.id) continue;
    let gross = 0;
    let daysThere = 0;
    plan.days.forEach((day, index) => {
      const isLast = index === total - 1;
      const covers = isLast ? j === input.bases.length - 1 : day.date >= stay.fromDate && day.date < stay.toDate;
      if (!covers || day.baseId !== stay.id) return;
      daysThere += 1;
      const ids = day.stops.filter((s) => s.slot === 'day').map((s) => s.candidate.id);
      gross += tourMinutes(previous.id, ids, input.minutes).total - tourMinutes(stay.id, ids, input.minutes).total;
      for (const s of day.stops) if (s.slot !== 'day') gross += 2 * ((input.minutes(previous.id, s.candidate.id) ?? UNKNOWN_LEG_MINUTES) - (input.minutes(stay.id, s.candidate.id) ?? UNKNOWN_LEG_MINUTES));
    });
    moves.push({
      from: previous.name,
      to: stay.name,
      nights: stay.nights,
      transferMinutes: Math.round(stay.transferMinutesFromPrevious),
      grossSavedMinutes: Math.round(gross),
      netSavedMinutes: Math.round(gross - stay.transferMinutesFromPrevious),
      savedPerDay: daysThere > 0 ? Math.round(gross / daysThere) : 0,
    });
  }

  // --- the same board from one base ------------------------------------------------------------
  let stayPut: CaseMetrics['stayPut'] = null;
  if (new Set(input.bases.map((b) => b.id)).size > 1) {
    const anchor = [...input.bases].sort((a, b) => b.nights - a.nights)[0]!;
    const single: StructurePlannerInput = { ...input, bases: [{ ...anchor, fromDate: input.windows[0]!.date, toDate: input.windows[input.windows.length - 1]!.date, nights: Math.max(0, input.windows.length - 1), transferMinutesFromPrevious: 0 }] };
    const alternative = planStructure(single);
    const objective = scoreStructure(single, alternative);
    stayPut = { base: anchor.name, totalTravelMinutes: Math.round(totalTravel(single, alternative)), stops: alternative.days.reduce((n, d) => n + d.stops.length, 0), score: Math.round(objective.score), mustsPlaced: objective.mustsPlaced };
  }

  const objective = scoreStructure(input, plan);
  const board = boardFor(setup.trip, setup.profile, setup.context);
  const operatingOf = new Map(board.candidates.map((c) => [c.place.id, c.operating] as const));
  let hoursConflicts = 0;
  let knownHours = 0;
  let unknownHours = 0;
  plan.days.forEach((day) => {
    for (const s of day.stops) {
      const entry = operatingOf.get(s.candidate.id)?.byDate.find((d) => d.date === day.date);
      if (!entry || entry.status === 'unknown') unknownHours += 1;
      else {
        knownHours += 1;
        if (entry.status === 'closed') hoursConflicts += 1;
      }
    }
  });

  const stays = input.bases.map((b) => ({ base: b.name, nights: b.nights, transferMinutesFromPrevious: Math.round(b.transferMinutesFromPrevious) }));
  const first = plan.days[0]!;
  const last = plan.days[total - 1]!;
  const hardDay = (d: PlannedDay) => d.stops.some((s) => s.candidate.intensity === 'strenuous');
  const arrivalLoad = loadOf(first, 0);
  const departureLoad = total > 1 ? loadOf(last, total - 1) : 0;
  const mustsPlaced = mustIds.filter((id) => scheduled.has(id)).length;
  return {
    board: fixture.key,
    boardLabel: fixture.label,
    source: fixture.source,
    profile: profileCase.key,
    ok: true,
    days: total,
    nights: total - 1,
    mode: setup.carAvailable ? 'car' : 'no_car',
    structure: {
      basesProposed: fixture.bases.length,
      stays,
      distinctBases: new Set(stays.map((s) => s.base)).size,
      hotelMoves: Math.max(0, stays.length - 1),
      oneNightStays: stays.length > 1 ? stays.filter((s) => s.nights <= 1).length : 0,
      maxBaseChangesAllowed: setup.maxBaseChanges,
      decision: (setup.region.basePortfolio as unknown as { decision?: unknown } | undefined)?.decision ?? null,
    },
    travel: {
      limitMinutes: limit,
      totalMinutes: Math.round(sightseeing + transfers),
      sightseeingMinutes: Math.round(sightseeing),
      transferMinutes: Math.round(transfers),
      perDay,
      meanPerDay: Math.round((sightseeing + transfers) / Math.max(1, total)),
      maxDay: Math.max(0, ...perDay),
      unknownLegs,
      matrixBasis: setup.region.travelTimes.provenance.kind,
    },
    moves,
    stayPut,
    plan: { poolSize: composition.poolSize, stops: scheduled.size, score: Math.round(objective.score), mustsAsked: mustIds.length, mustsPlaced, repairs: plan.repairs.length },
    defects: {
      daysOverTravelLimit: daysOverLimit,
      daysOverTravelLimitPlannerRule: daysOverLimitPlannerRule,
      overTravelMinutes,
      overLimitTransferAlone,
      overLimitMovingDay,
      overLimitOwnPick,
      overLimitOther,
      overfullDays,
      overfullMinutes,
      overfullOwnPick,
      emptyInteriorDays: emptyInterior,
      emptyInteriorMovingDays: emptyInteriorMoving,
      oneStopDays: oneStop,
      oneStopDaysWithCompatibleNeighbour: oneStopWithNeighbour,
      backtrackingDays,
      backtrackExcessKm,
      strenuousBackToBack,
      heavyArrivalDay: arrivalLoad > 0.8 || hardDay(first) ? 1 : 0,
      heavyDepartureDay: total > 1 && (departureLoad > 0.8 || hardDay(last)) ? 1 : 0,
      arrivalLoad,
      departureLoad,
      missingLunch,
      missingDinner,
      hoursConflicts,
      stopsWithKnownHours: knownHours,
      stopsWithUnknownHours: unknownHours,
      droppedMusts: mustIds.length - mustsPlaced,
      unstatedDefectDays: unstated,
    },
    notes: (record.dayNotes ?? []).map((n) => `Day ${n.dayNumber} [${n.code}]: ${n.note}`),
  };
}

export function runCase(fixture: BoardFixture, profileCase: ProfileCase): CaseMetrics {
  try {
    const setup = setupCase(fixture, profileCase);
    return measureCase(fixture, profileCase, setup, composeCase(fixture, setup));
  } catch (error) {
    return failedCase(fixture, profileCase, error instanceof Error ? error.message : String(error));
  }
}

function failedCase(fixture: BoardFixture, profileCase: ProfileCase, error: string): CaseMetrics {
  return {
    board: fixture.key,
    boardLabel: fixture.label,
    source: fixture.source,
    profile: profileCase.key,
    ok: false,
    error,
    days: 0,
    nights: 0,
    mode: profileCase.car ? 'car' : 'no_car',
    structure: { basesProposed: fixture.bases.length, stays: [], distinctBases: 0, hotelMoves: 0, oneNightStays: 0, maxBaseChangesAllowed: 0, decision: null },
    travel: { limitMinutes: 0, totalMinutes: 0, sightseeingMinutes: 0, transferMinutes: 0, perDay: [], meanPerDay: 0, maxDay: 0, unknownLegs: 0, matrixBasis: 'none' },
    moves: [],
    stayPut: null,
    plan: { poolSize: 0, stops: 0, score: 0, mustsAsked: 0, mustsPlaced: 0, repairs: 0 },
    defects: { daysOverTravelLimit: 0, daysOverTravelLimitPlannerRule: 0, overTravelMinutes: 0, overLimitTransferAlone: 0, overLimitMovingDay: 0, overLimitOwnPick: 0, overLimitOther: 0, overfullDays: 0, overfullMinutes: 0, overfullOwnPick: 0, emptyInteriorDays: 0, emptyInteriorMovingDays: 0, oneStopDays: 0, oneStopDaysWithCompatibleNeighbour: 0, backtrackingDays: 0, backtrackExcessKm: 0, strenuousBackToBack: 0, heavyArrivalDay: 0, heavyDepartureDay: 0, arrivalLoad: 0, departureLoad: 0, missingLunch: 0, missingDinner: 0, hoursConflicts: 0, stopsWithKnownHours: 0, stopsWithUnknownHours: 0, droppedMusts: 0, unstatedDefectDays: 0 },
    notes: [],
  };
}

/* ---------------------------------------------------------------------------------------------
 * The whole run, and its summary
 * ------------------------------------------------------------------------------------------- */

export interface EvaluationSummary {
  cases: number;
  failed: number;
  tripDays: number;
  hotelMoves: number;
  tripsWithMoves: number;
  oneNightStays: number;
  /** Moves whose stay saves less day travel than the transfer that bought it. */
  movesThatLoseTime: number;
  movesTotal: number;
  /** Multi-base trips that end up with more total travel than the same board from one base. */
  multiBaseTripsSlowerThanStayingPut: number;
  meanTravelPerDay: number;
  totals: Record<Exclude<keyof CaseMetrics['defects'], 'arrivalLoad' | 'departureLoad'>, number>;
  /** Share of trips with at least one of each defect. */
  tripsAffected: Record<string, number>;
  mustsAsked: number;
  mustsPlaced: number;
  stopsScheduled: number;
}

export function summarise(cases: readonly CaseMetrics[]): EvaluationSummary {
  const ok = cases.filter((c) => c.ok);
  const keys = ['daysOverTravelLimit', 'daysOverTravelLimitPlannerRule', 'overTravelMinutes', 'overLimitTransferAlone', 'overLimitMovingDay', 'overLimitOwnPick', 'overLimitOther', 'overfullDays', 'overfullMinutes', 'overfullOwnPick', 'emptyInteriorDays', 'emptyInteriorMovingDays', 'oneStopDays', 'oneStopDaysWithCompatibleNeighbour', 'backtrackingDays', 'backtrackExcessKm', 'strenuousBackToBack', 'heavyArrivalDay', 'heavyDepartureDay', 'missingLunch', 'missingDinner', 'hoursConflicts', 'stopsWithKnownHours', 'stopsWithUnknownHours', 'droppedMusts', 'unstatedDefectDays'] as const;
  const totals = Object.fromEntries(keys.map((k) => [k, ok.reduce((n, c) => n + c.defects[k], 0)])) as EvaluationSummary['totals'];
  const tripsAffected = Object.fromEntries(keys.map((k) => [k, ok.filter((c) => c.defects[k] > 0).length]));
  const moves = ok.flatMap((c) => c.moves);
  const tripDays = ok.reduce((n, c) => n + c.days, 0);
  return {
    cases: cases.length,
    failed: cases.length - ok.length,
    tripDays,
    hotelMoves: ok.reduce((n, c) => n + c.structure.hotelMoves, 0),
    tripsWithMoves: ok.filter((c) => c.structure.hotelMoves > 0).length,
    oneNightStays: ok.reduce((n, c) => n + c.structure.oneNightStays, 0),
    movesThatLoseTime: moves.filter((m) => m.netSavedMinutes < 0).length,
    movesTotal: moves.length,
    multiBaseTripsSlowerThanStayingPut: ok.filter((c) => c.stayPut && c.travel.totalMinutes > c.stayPut.totalTravelMinutes && c.plan.stops <= c.stayPut.stops).length,
    meanTravelPerDay: Math.round(ok.reduce((n, c) => n + c.travel.totalMinutes, 0) / Math.max(1, tripDays)),
    totals,
    tripsAffected,
    mustsAsked: ok.reduce((n, c) => n + c.plan.mustsAsked, 0),
    mustsPlaced: ok.reduce((n, c) => n + c.plan.mustsPlaced, 0),
    stopsScheduled: ok.reduce((n, c) => n + c.plan.stops, 0),
  };
}

export { slotOf };
