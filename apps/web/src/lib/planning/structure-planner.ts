import type { Interest, PhysicalIntensity, TimeOfDay } from '@sidequest/core';
import type { AnchorCategory, DraftAnchor, DraftDay, DraftTransport, TripArchetype } from './trip-draft';
import { evaluateObjective, improveStructure, type ImproveOptions, type StructureObjective } from './structure-improve';

/**
 * V1 CONVERGENCE — THE DETERMINISTIC STRUCTURE PLANNER.
 *
 * Master prompt §17/§27: the LLM is not the optimizer. Given the traveller's
 * Discovery Board decisions over a scanned candidate pool, this decides which
 * places make the trip, which day each lands on, in what order, where lunch
 * falls, what the bad-weather swap is, and what was left out and why — from
 * fit scores, travel minutes, day capacity, effort, frequency, time of day and
 * the forecast. No model, no provider, no clock: a pure function, so the same
 * board always yields the same structure and every decision can be explained.
 *
 * Why not `@sidequest/planner#planTrip`: on live scanned pools it scheduled a
 * night show at 13:20, left a car-free city's days empty because it reads every
 * untimetabled leg as a walk, and refuses stops for missing evidence (the
 * Phase 17 failure). The sound parts are reused — the board's fit scores, the
 * base portfolio, the arrival/departure-aware daily windows and the leg
 * estimators — and the rest is this file, small enough to read.
 *
 * Unknown ≠ false: a leg nobody measured is an estimate here, never a reason to
 * drop a stop. Only the traveller's own exclusions remove anything outright.
 */

export type PlannerStatus = 'must' | 'recommended' | 'maybe' | 'candidate';

export interface PlannerCandidate {
  id: string;
  name: string;
  locality: string;
  coordinates: { lat: number; lng: number };
  durationMinutes: number;
  intensity: PhysicalIntensity;
  bestTime: TimeOfDay;
  exposure: 'indoor' | 'mixed' | 'outdoor';
  visibilityDependent: boolean;
  /** Good on a wet day: indoors, or marked as a poor-weather option. */
  rainyDayOk: boolean;
  interests: readonly Interest[];
  primaryInterest: Interest | null;
  category: AnchorCategory;
  kindLabel: string;
  /** 0–100, from the board's fit scorer. */
  fit: number;
  /** 0–1: how defining this is for the destination (a classic ~0.8). Lifts priority, never overrides the traveller. */
  significance: number;
  /** A whole-day outing to another town: may use a day of its own beyond the usual reach. */
  dayTrip: boolean;
  why: string;
  booking: 'none' | 'recommended' | 'required';
  /** False when the candidate is closed in every month the trip touches. */
  openOnTripDates: boolean;
  status: PlannerStatus;
  /** The area the candidate belongs to, when the scan grouped it; a soft grouping hint only. */
  zone?: string;
  /** The day the traveller locked this stop to. Held there or reported as a conflict, never silently moved. */
  pinnedDay?: number;
  /** Trip dates a published calendar says it is shut. Unknown hours are never here: unknown ≠ closed. */
  closedDates?: readonly string[];
  /** Why the board says this cannot work on this trip (e.g. needs a car the traveller does not have). */
  blocked?: string;
  /** The board's code for that blocker (`scoring/fit.ts#BlockerCode`), so the plan can say which change would fix it. */
  blockedCode?: string;
}

export interface PlannerBase {
  id: string;
  name: string;
  why: string;
  lodgingArea?: string;
  coordinates: { lat: number; lng: number };
  /** Calendar date of the first night here and the morning you leave. */
  fromDate: string;
  toDate: string;
  nights: number;
  transferMinutesFromPrevious: number;
}

export interface PlannerDayWindow {
  date: string;
  startMinute: number;
  endMinute: number;
}

/** A day's weather, reduced to what planning acts on. Absent means unknown, which never moves anything. */
export interface PlannerDayWeather {
  date: string;
  /** 0 fine … 3 severe. */
  severity: 0 | 1 | 2 | 3;
  wet: boolean;
  windy: boolean;
  poorVisibility: boolean;
  label: string;
}

export interface PlannerFoodArea {
  name: string;
  locality: string;
  specialty: string;
  coordinates?: { lat: number; lng: number };
}

export interface StructurePlannerInput {
  destinationName: string;
  windows: readonly PlannerDayWindow[];
  bases: readonly PlannerBase[];
  candidates: readonly PlannerCandidate[];
  /** Door-to-door minutes between two ids (bases and candidates) in the trip's mode, measured or estimated; null when unknown. */
  minutes: (fromId: string, toId: string) => number | null;
  pace: 'slow' | 'balanced' | 'fast';
  /** Most daytime stops a day may hold — the traveller's own pace, from the profile. Evening and sunrise stops are extra. */
  maxStopsPerDay: number;
  carAvailable: boolean;
  maxDailyTravelMinutes: number;
  maxPhysicalIntensity: PhysicalIntensity;
  /** Times each interest may appear for Sidequest's own additions (traveller picks are never capped). */
  frequencyCaps: Partial<Record<Interest, number>>;
  weather: readonly PlannerDayWeather[];
  foodAreas: readonly PlannerFoodArea[];
  /**
   * V1 — minutes from where the traveller lands to the first base, and from the
   * last base to where they leave, estimated. They come off the arrival and
   * departure days like any transfer; absent means the trip starts and ends at
   * its bases.
   */
  edgeTransfers?: { arrivalMinutes: number; departureMinutes: number };
  /**
   * The improvement phase (`structure-improve.ts`) that runs after greedy
   * construction. Absent or `true` means on, with the default iteration
   * budget; `false` returns the greedy plan exactly as constructed, which is
   * what `SIDEQUEST_PLANNER_IMPROVE=off` asks for so the two can be compared.
   */
  improve?: boolean | ImproveOptions;
}

export type DropReason = 'excluded' | 'out_of_season' | 'too_strenuous' | 'too_far' | 'frequency' | 'capacity' | 'weather' | 'closed' | 'not_workable';

export interface PlannedStop {
  candidate: PlannerCandidate;
  slot: 'sunrise' | 'day' | 'sunset' | 'night';
}

export interface PlannedDay {
  dayNumber: number;
  date: string;
  baseId: string;
  relocation: boolean;
  stops: PlannedStop[];
  travelMinutes: number;
  /** Round trips out to sunset/night stops, counted against the same daily travel limit. */
  eveningTravelMinutes: number;
  activityMinutes: number;
  capacityMinutes: number;
  weather: PlannerDayWeather | null;
  lunchNear: string | null;
  lunchFoodArea: PlannerFoodArea | null;
  backup: PlannerCandidate | null;
  intensity: 'light' | 'moderate' | 'intense';
}

export interface StructurePlan {
  days: PlannedDay[];
  dropped: { candidate: PlannerCandidate; reason: DropReason; detail: string }[];
  /** Outdoor stops placed on a better-weather day than the one geography alone would have chosen. */
  weatherMoves: { candidateId: string; name: string; avoidedDate: string; chosenDate: string }[];
  /** Traveller must-includes that could not be placed: a stated conflict, never silent. */
  mustConflicts: { candidateId: string; name: string; reason: DropReason; detail: string }[];
}

export const INTENSITY_RANK: Record<PhysicalIntensity, number> = { none: 0, easy: 1, moderate: 2, strenuous: 3 };
const BUFFER_BY_PACE = { slow: 90, balanced: 45, fast: 20 } as const;
/** Status lifts priority without letting a weak pick outrank a defining place; the traveller's own includes always come first. */
export const STATUS_BONUS: Record<PlannerStatus, number> = { must: 1000, recommended: 12, maybe: 8, candidate: 0 };
export function plannerPriority(c: Pick<PlannerCandidate, 'status' | 'fit' | 'significance'>): number {
  return STATUS_BONUS[c.status] + c.fit + Math.max(0, c.significance - 0.5) * 50;
}
/** A filler is only worth adding when it fits this well. */
export const FILLER_MIN_FIT = 60;
/** Fill a day back up to this share of its capacity from high-fit fillers. */
export const FILL_TARGET = { slow: 0.55, balanced: 0.7, fast: 0.85 } as const;
const LUNCH_MINUTES = 60;
/** The longest hop between two stops that still reads as one day's outing. */
const COHERENT_HOP_MINUTES = 50;
/**
 * Unknown travel time is never zero (Product Recovery V1) and never a verdict.
 * One policy for the whole planner, where there used to be three (60 in the
 * tour, 30 for an evening run, 999 in the "day hangs together" rule):
 *
 *  - on the **clock** — tour totals, evening round trips, where lunch falls — an
 *    unmeasured leg costs this allowance, so a day with unknown legs is never
 *    planned as if travel were free;
 *  - in a **distance rule** — reach from base, "too far to come back after
 *    dark", "too far from the rest of that day" — an unmeasured leg never
 *    triggers the rule. Only a figure somebody produced can call a place far.
 */
export const UNKNOWN_LEG_MINUTES = 60;

function dayWindowOf(input: StructurePlannerInput, date: string): PlannerDayWindow {
  return input.windows.find((w) => w.date === date) ?? { date, startMinute: 9 * 60, endMinute: 18 * 60 };
}

function baseForDate(bases: readonly PlannerBase[], date: string, isLast: boolean): PlannerBase {
  // The night of `date` is spent at the base whose stay covers it; the last day belongs to the last base.
  if (isLast) return bases[bases.length - 1]!;
  return bases.find((b) => date >= b.fromDate && date < b.toDate) ?? bases[bases.length - 1]!;
}

/**
 * Minimum round-trip minutes from a base through a set of stops: exhaustive
 * order up to 7 stops (exact), and above that nearest-neighbour construction
 * improved by 2-opt and Or-opt until neither finds a shorter loop — the
 * intra-day reorder of the improvement phase, so a long city day is not left
 * on a greedy zig-zag.
 */
export function tourMinutes(baseId: string, ids: readonly string[], minutes: StructurePlannerInput['minutes']): { order: string[]; total: number } {
  const m = (a: string, b: string) => minutes(a, b) ?? UNKNOWN_LEG_MINUTES;
  if (ids.length === 0) return { order: [], total: 0 };
  if (ids.length <= 7) {
    let best: { order: string[]; total: number } | null = null;
    const walk = (path: string[], rest: string[], cost: number) => {
      if (best && cost >= best.total) return;
      if (rest.length === 0) {
        const total = cost + m(path[path.length - 1]!, baseId);
        if (!best || total < best.total) best = { order: path, total };
        return;
      }
      for (const next of rest) walk([...path, next], rest.filter((r) => r !== next), cost + m(path.length === 0 ? baseId : path[path.length - 1]!, next));
    };
    walk([], [...ids], 0);
    return best!;
  }
  const order: string[] = [];
  const rest = new Set(ids);
  let at = baseId;
  while (rest.size > 0) {
    let next: string | null = null;
    for (const id of rest) if (next === null || m(at, id) < m(at, next)) next = id;
    order.push(next!);
    rest.delete(next!);
    at = next!;
  }
  return refineTour(baseId, order, m);
}

/** The length of a loop base → order → base. */
function loopMinutes(baseId: string, order: readonly string[], m: (a: string, b: string) => number): number {
  let total = 0;
  let at = baseId;
  for (const id of order) {
    total += m(at, id);
    at = id;
  }
  return total + (order.length > 0 ? m(at, baseId) : 0);
}

/**
 * 2-opt (reverse a segment) and Or-opt (move a run of one to three stops
 * elsewhere), first improvement in index order, until neither shortens the
 * loop. Recomputes the whole loop per probe, which is plenty at the eight to a
 * dozen stops a day can hold, and stays correct for an asymmetric matrix.
 */
function refineTour(baseId: string, start: readonly string[], m: (a: string, b: string) => number): { order: string[]; total: number } {
  let order = [...start];
  let total = loopMinutes(baseId, order, m);
  let improved = true;
  let guard = 0;
  while (improved && guard < 200) {
    improved = false;
    guard += 1;
    for (let i = 0; i < order.length - 1 && !improved; i += 1) {
      for (let j = i + 1; j < order.length && !improved; j += 1) {
        const next = [...order.slice(0, i), ...order.slice(i, j + 1).reverse(), ...order.slice(j + 1)];
        const cost = loopMinutes(baseId, next, m);
        if (cost < total) {
          order = next;
          total = cost;
          improved = true;
        }
      }
    }
    for (let len = 1; len <= 3 && !improved; len += 1) {
      for (let i = 0; i + len <= order.length && !improved; i += 1) {
        const run = order.slice(i, i + len);
        const rest = [...order.slice(0, i), ...order.slice(i + len)];
        for (let k = 0; k <= rest.length && !improved; k += 1) {
          if (k === i) continue;
          const next = [...rest.slice(0, k), ...run, ...rest.slice(k)];
          const cost = loopMinutes(baseId, next, m);
          if (cost < total) {
            order = next;
            total = cost;
            improved = true;
          }
        }
      }
    }
  }
  return { order, total };
}

export function slotOf(candidate: PlannerCandidate): PlannedStop['slot'] {
  if (candidate.bestTime === 'sunrise') return 'sunrise';
  if (candidate.bestTime === 'sunset') return 'sunset';
  if (candidate.bestTime === 'night') return 'night';
  return 'day';
}

export function weatherPenalty(candidate: PlannerCandidate, weather: PlannerDayWeather | null): number {
  if (!weather) return 0;
  let penalty = 0;
  /*
   * Thresholds, not gradients: a day with rain or worse (severity ≥ 2) is worth
   * moving an exposed stop away from; a chance of showers (severity 1) only
   * breaks a tie, so the plan does not churn for a small difference.
   */
  if (candidate.exposure === 'outdoor') penalty += weather.severity >= 2 ? 120 * weather.severity : weather.severity === 1 ? 5 : 0;
  if (candidate.exposure === 'mixed' && weather.severity >= 2) penalty += 30 * weather.severity;
  if (candidate.visibilityDependent && weather.poorVisibility) penalty += 60;
  if (weather.windy && candidate.exposure === 'outdoor' && candidate.visibilityDependent) penalty += 40;
  if (candidate.rainyDayOk && weather.wet) penalty -= 40;
  return penalty;
}

/* ============================================================================================
 * THE PLANNING KERNEL — one set of day rules, shared by construction and improvement.
 * ============================================================================================ */

/** The fixed facts of a day, independent of what is on it. */
export interface DaySkeleton {
  index: number;
  dayNumber: number;
  date: string;
  baseId: string;
  relocation: boolean;
  capacityMinutes: number;
  weather: PlannerDayWeather | null;
  isFirst: boolean;
  isLast: boolean;
}

/** What a set of stops costs on a day, from the memoised tour. */
export interface DayMetrics {
  /** Daytime stops in the shortest loop order from the base. */
  order: string[];
  /** Minutes of the daytime loop. */
  tourMinutes: number;
  /** Round trips out to sunset/night stops. */
  eveningMinutes: number;
  /** Round trips out to sunrise stops — real driving, though no daily limit has ever counted it. */
  sunriseMinutes: number;
  /** Visit minutes of the daytime stops. */
  activityMinutes: number;
}

export type DayVerdict = { ok: true } | { ok: false; reason: DropReason; detail: string };

/** A solution as the improvement phase holds it: the candidates on each day, by day index. */
export type PlanState = PlannerCandidate[][];

export interface PlannerKernel {
  input: StructurePlannerInput;
  days: readonly DaySkeleton[];
  /** Everything that survived the traveller's exclusions, season, workability and the effort ceiling. */
  plannable: readonly PlannerCandidate[];
  fillTarget: number;
  /** Construction's filler floor: below it, a candidate is only ever an otherwise-empty day's answer. */
  fillerMinFit: number;
  slotOf(candidate: PlannerCandidate): PlannedStop['slot'];
  weatherPenalty(candidate: PlannerCandidate, weather: PlannerDayWeather | null): number;
  /** The planner priority without the status bonus: fit plus how defining the place is. */
  experienceValue(candidate: Pick<PlannerCandidate, 'status' | 'fit' | 'significance'>): number;
  dayMetrics(index: number, stops: readonly PlannerCandidate[]): DayMetrics;
  /**
   * THE DAY VALIDATOR. Whether `stops` may stand as day `index`, given the
   * other days (`stopsOf`, for the strenuous-spacing rule). Every rule a stop
   * was ever refused for is here, evaluated on the whole day rather than on one
   * insertion, so construction and every improvement move pass the same oracle
   * and the improvement phase can never produce a day construction would have
   * refused. `focusId` names the stop being added, so the refusal it gets is
   * about that stop first.
   */
  checkDay(index: number, stops: readonly PlannerCandidate[], stopsOf: (index: number) => readonly PlannerCandidate[], focusId?: string): DayVerdict;
  /**
   * Whether `candidate` could stand on day `index` at all — the per-stop rules
   * alone (lock, closure, effort on an edge day, reach, the hard time-of-day
   * slots), with nothing else on the day. A necessary condition for any day
   * holding it, so the search can skip a day without building the neighbour.
   */
  standsAlone(candidate: PlannerCandidate, index: number): boolean;
}

export function createPlannerKernel(input: StructurePlannerInput): PlannerKernel & { preDropped: StructurePlan['dropped']; preConflicts: StructurePlan['mustConflicts'] } {
  const dates = input.windows.map((w) => w.date);
  const buffer = BUFFER_BY_PACE[input.pace];
  const weatherByDate = new Map(input.weather.map((w) => [w.date, w]));

  const days: DaySkeleton[] = dates.map((date, i) => {
    const isFirst = i === 0;
    const isLast = i === dates.length - 1;
    const base = baseForDate(input.bases, date, isLast);
    const previousBase = i === 0 ? base : baseForDate(input.bases, dates[i - 1]!, false);
    const relocation = i > 0 && previousBase.id !== base.id;
    const window = dayWindowOf(input, date);
    const span = Math.max(0, window.endMinute - window.startMinute);
    const lunch = window.startMinute <= 13 * 60 && window.endMinute >= 13 * 60 ? LUNCH_MINUTES : 0;
    const edgeTransfer = (isFirst ? input.edgeTransfers?.arrivalMinutes ?? 0 : 0) + (isLast && dates.length > 1 ? input.edgeTransfers?.departureMinutes ?? 0 : 0);
    const transfer = (relocation ? base.transferMinutesFromPrevious : 0) + edgeTransfer;
    const raw = span - lunch - buffer - transfer - (isFirst || isLast ? 30 : 0);
    /* What is left of an edge day after a long transfer is not a sightseeing window: under ninety minutes, the day is the journey. */
    const capacity = Math.max(0, (isFirst || isLast) && edgeTransfer > 0 && raw < 90 ? 0 : raw);
    return { index: i, dayNumber: i + 1, date, baseId: base.id, relocation, capacityMinutes: capacity, weather: weatherByDate.get(date) ?? null, isFirst, isLast };
  });

  // --- what may be planned at all -------------------------------------------------
  const preDropped: StructurePlan['dropped'] = [];
  const preConflicts: StructurePlan['mustConflicts'] = [];
  const plannable: PlannerCandidate[] = [];
  const maxIntensity = INTENSITY_RANK[input.maxPhysicalIntensity];
  for (const candidate of input.candidates) {
    if (!candidate.openOnTripDates && candidate.status !== 'must') {
      preDropped.push({ candidate, reason: 'out_of_season', detail: 'Closed or impractical in the months you are travelling.' });
      continue;
    }
    if (candidate.blocked) {
      preDropped.push({ candidate, reason: 'not_workable', detail: candidate.blocked });
      if (candidate.status === 'must') preConflicts.push({ candidateId: candidate.id, name: candidate.name, reason: 'not_workable', detail: candidate.blocked });
      continue;
    }
    if (INTENSITY_RANK[candidate.intensity] > maxIntensity && candidate.status !== 'must') {
      preDropped.push({ candidate, reason: 'too_strenuous', detail: 'More effort than you said you want.' });
      continue;
    }
    plannable.push(candidate);
  }

  const leg = (a: string, b: string) => input.minutes(a, b);
  const allowance = (a: string, b: string) => input.minutes(a, b) ?? UNKNOWN_LEG_MINUTES;
  const reach = Math.max(45, Math.floor(input.maxDailyTravelMinutes / 2));
  const dayTripReach = Math.floor(input.maxDailyTravelMinutes * 0.6);
  const fillTarget = FILL_TARGET[input.pace];

  /*
   * Memoised by base and the set of ids: the improvement phase probes the same
   * day sets thousands of times. The set is keyed as a bitmask over the
   * candidates' positions (30 bits a word), which is order-free without a sort.
   */
  const metricsMemo = new Map<string, DayMetrics>();
  const position = new Map(input.candidates.map((c, i) => [c.id, i] as const));
  const words = Math.max(1, Math.ceil(input.candidates.length / 30));
  function setKey(baseId: string, stops: readonly PlannerCandidate[]): string {
    const mask = new Array<number>(words).fill(0);
    let strays = '';
    for (const s of stops) {
      const at = position.get(s.id);
      if (at === undefined) strays += `\u0000${s.id}`;
      else mask[Math.floor(at / 30)]! |= 1 << at % 30;
    }
    return `${baseId}\u0000${mask.join(',')}${strays}`;
  }
  function dayMetrics(index: number, stops: readonly PlannerCandidate[]): DayMetrics {
    const day = days[index]!;
    const key = setKey(day.baseId, stops);
    const hit = metricsMemo.get(key);
    if (hit) return hit;
    const daytime = stops.filter((s) => slotOf(s) === 'day');
    const tour = tourMinutes(
      day.baseId,
      daytime.map((s) => s.id).sort(),
      input.minutes,
    );
    let evening = 0;
    let sunrise = 0;
    for (const s of stops) {
      const slot = slotOf(s);
      if (slot === 'sunset' || slot === 'night') evening += allowance(day.baseId, s.id) * 2;
      else if (slot === 'sunrise') sunrise += allowance(day.baseId, s.id) * 2;
    }
    const metrics: DayMetrics = { order: tour.order, tourMinutes: tour.total, eveningMinutes: evening, sunriseMinutes: sunrise, activityMinutes: daytime.reduce((n, s) => n + s.durationMinutes, 0) };
    metricsMemo.set(key, metrics);
    return metrics;
  }

  const fail = (reason: DropReason, detail: string): DayVerdict => ({ ok: false, reason, detail });

  /** The rules that belong to one stop on the day: locks, closures, effort, reach and the hard time-of-day slots. */
  function stopVerdict(day: DaySkeleton, s: PlannerCandidate, stops: readonly PlannerCandidate[], stopsOf: (index: number) => readonly PlannerCandidate[]): DayVerdict | null {
    const user = s.status === 'must';
    const edge = day.isFirst || day.isLast;
    if (s.pinnedDay !== undefined && s.pinnedDay !== day.dayNumber) return fail('capacity', `You locked this to day ${s.pinnedDay}, and it no longer fits that day.`);
    if (s.closedDates?.includes(day.date)) return fail('closed', 'Its published hours say it is shut that day.');
    const slot = slotOf(s);
    if (s.intensity === 'strenuous' && !user) {
      if (edge) return fail('too_strenuous', 'A strenuous outing does not belong on an arrival or departure day.');
      if (stops.some((o) => o !== s && o.intensity === 'strenuous')) return fail('too_strenuous', 'One strenuous outing a day is enough.');
      const hard = (i: number) => i >= 0 && i < days.length && stopsOf(i).some((o) => o.intensity === 'strenuous');
      if (input.pace !== 'fast' && (hard(day.index - 1) || hard(day.index + 1))) return fail('too_strenuous', 'Two hard days back to back is more than you asked for.');
    }
    const fromBase = leg(day.baseId, s.id);
    const alone = stops.length === 1;
    /* A whole-day outing to another town may use a day of its own beyond the usual reach — alone on an ordinary day, never on an arrival, departure or moving day. */
    const soloDayTrip = s.dayTrip && slot === 'day' && fromBase !== null && fromBase <= dayTripReach && alone && !edge && !day.relocation;
    if (fromBase !== null && fromBase > reach && !user && !soloDayTrip) return fail('too_far', `About ${Math.round(fromBase)} minutes each way from where you sleep that night.`);
    if (!user && stops.some((o) => o !== s && o.dayTrip && (leg(day.baseId, o.id) ?? 0) > reach)) return fail('capacity', 'That day is a day trip elsewhere.');
    if (slot === 'sunrise') {
      if (day.isFirst || day.relocation || stops.some((o) => o !== s && slotOf(o) === 'sunrise')) return fail('capacity', 'No free sunrise.');
    }
    if (slot === 'sunset' || slot === 'night') {
      if (day.isLast || stops.some((o) => o !== s && (slotOf(o) === 'sunset' || slotOf(o) === 'night'))) return fail('capacity', 'No free evening.');
      if (fromBase !== null && fromBase > 75 && !user) return fail('too_far', 'Too far from base to come back from after dark.');
    }
    return null;
  }

  function checkDay(index: number, stops: readonly PlannerCandidate[], stopsOf: (index: number) => readonly PlannerCandidate[], focusId?: string): DayVerdict {
    const day = days[index]!;
    const focus = focusId ? stops.find((s) => s.id === focusId) : undefined;
    const ordered = focus ? [focus, ...stops.filter((s) => s !== focus)] : stops;
    for (const s of ordered) {
      const verdict = stopVerdict(day, s, stops, stopsOf);
      if (verdict) return verdict;
    }
    const daytime = stops.filter((s) => slotOf(s) === 'day');
    const metrics = dayMetrics(index, stops);
    /*
     * The evening run comes first for an evening stop, as it always has: its
     * refusal is about the drive, not the daytime shape.
     */
    const travelOver = metrics.tourMinutes + metrics.eveningMinutes > input.maxDailyTravelMinutes && stops.some((s) => s.status !== 'must' && slotOf(s) !== 'sunrise');
    const travelFailure = fail('too_far', `It would take the day's travel past the ${input.maxDailyTravelMinutes} minutes you set.`);
    if (focus && slotOf(focus) !== 'day' && slotOf(focus) !== 'sunrise' && travelOver) return travelFailure;
    /*
     * A day hangs together: the daytime stops form one cluster of reasonable
     * hops (≤ 50 minutes either way). A place an hour or more beyond the rest
     * of the day (a day trip, the far side of a region) waits for a day of its
     * own instead of being stitched between two neighbourhoods. The traveller's
     * own includes may sit apart from each other — the rule is that nothing of
     * Sidequest's opens a district none of them is in — and an unmeasured hop
     * is never what splits a day (unknown ≠ far).
     */
    if (daytime.length >= 2 && daytime.some((s) => s.status !== 'must')) {
      const parent = daytime.map((_, i) => i);
      const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
      for (let i = 0; i < daytime.length; i += 1) {
        for (let j = i + 1; j < daytime.length; j += 1) {
          const ab = leg(daytime[i]!.id, daytime[j]!.id);
          const ba = leg(daytime[j]!.id, daytime[i]!.id);
          const near = (ab === null && ba === null) || (ab !== null && ab <= COHERENT_HOP_MINUTES) || (ba !== null && ba <= COHERENT_HOP_MINUTES);
          if (near) parent[find(i)] = find(j);
        }
      }
      const roots = new Set(daytime.map((_, i) => find(i)));
      const withMust = new Set(daytime.map((s, i) => (s.status === 'must' ? find(i) : -1)).filter((r) => r >= 0));
      const stray = withMust.size > 0 ? roots.size > withMust.size : roots.size > 1;
      if (stray) return fail('too_far', 'Too far from the rest of that day.');
    }
    const extras = stops.length - daytime.length;
    if (daytime.some((s) => s.status !== 'must') && daytime.length > input.maxStopsPerDay - Math.max(0, extras - 1)) return fail('capacity', 'The day already holds as many stops as your pace allows.');
    const used = metrics.activityMinutes + metrics.tourMinutes;
    const loneMust = daytime.length === 1 && daytime[0]!.status === 'must';
    if (daytime.length > 0 && used > day.capacityMinutes && !loneMust) return fail('capacity', 'The day is already full.');
    if (travelOver) return travelFailure;
    /*
     * Sidequest's own fillers only top a thin day up: with the largest filler
     * taken away, the day must still be under its pace's fill target — the
     * order-free form of construction's "only keep a filler that landed on a
     * thin day".
     */
    const fillers = stops.filter((s) => s.status === 'candidate');
    if (fillers.length > 0) {
      const largest = Math.max(0, ...fillers.filter((s) => slotOf(s) === 'day').map((s) => s.durationMinutes));
      if (metrics.activityMinutes - largest >= day.capacityMinutes * fillTarget) return fail('capacity', 'A good fit with no room left for it.');
      /*
       * Below the filler floor a place is only ever the "no abandoned day"
       * answer: alone, on an ordinary day that would otherwise be empty —
       * never company for stops that already make the day.
       */
      if (fillers.some((s) => s.fit < FILLER_MIN_FIT) && (stops.length > 1 || day.isFirst || day.isLast)) return fail('capacity', 'A weaker fit than the places already planned.');
    }
    return { ok: true };
  }

  const experienceValue = (c: Pick<PlannerCandidate, 'status' | 'fit' | 'significance'>) => plannerPriority(c) - STATUS_BONUS[c.status];
  const aloneMemo = new Map<string, boolean>();
  const standsAlone = (c: PlannerCandidate, index: number): boolean => {
    const key = `${index}\u0000${c.id}`;
    const hit = aloneMemo.get(key);
    if (hit !== undefined) return hit;
    const ok = stopVerdict(days[index]!, c, [c], () => []) === null;
    aloneMemo.set(key, ok);
    return ok;
  };
  return { input, days, plannable, fillTarget, fillerMinFit: FILLER_MIN_FIT, slotOf, weatherPenalty, experienceValue, dayMetrics, checkDay, standsAlone, preDropped, preConflicts };
}

/**
 * Every day of a plan against the day validator. Empty when the plan is one
 * the planner could have produced; otherwise one row per refused day. The
 * improvement phase's tests hold every output to this.
 */
export function validateStructure(input: StructurePlannerInput, plan: StructurePlan): { dayNumber: number; reason: DropReason; detail: string }[] {
  const kernel = createPlannerKernel(input);
  const state = plan.days.map((d) => d.stops.map((s) => s.candidate));
  const problems: { dayNumber: number; reason: DropReason; detail: string }[] = [];
  state.forEach((stops, i) => {
    const verdict = kernel.checkDay(i, stops, (j) => state[j] ?? []);
    if (!verdict.ok) problems.push({ dayNumber: i + 1, reason: verdict.reason, detail: verdict.detail });
  });
  return problems;
}

/** The improvement phase's objective for a finished plan — for the planner bench and for tests comparing the greedy and improved plans. */
export function scoreStructure(input: StructurePlannerInput, plan: StructurePlan): StructureObjective {
  const kernel = createPlannerKernel(input);
  return evaluateObjective(kernel, plan.days.map((d) => d.stops.map((s) => s.candidate)));
}

/* ============================================================================================
 * PLANNING — greedy construction, then the improvement phase, then ordering and explanation.
 * ============================================================================================ */

export function planStructure(input: StructurePlannerInput): StructurePlan {
  const kernel = createPlannerKernel(input);
  const { plannable } = kernel;
  const days: PlannedDay[] = kernel.days.map((d) => ({
    dayNumber: d.dayNumber,
    date: d.date,
    baseId: d.baseId,
    relocation: d.relocation,
    stops: [],
    travelMinutes: 0,
    eveningTravelMinutes: 0,
    activityMinutes: 0,
    capacityMinutes: d.capacityMinutes,
    weather: d.weather,
    lunchNear: null,
    lunchFoodArea: null,
    backup: null,
    intensity: 'light',
  }));

  const dropped: StructurePlan['dropped'] = [...kernel.preDropped];
  const mustConflicts: StructurePlan['mustConflicts'] = [...kernel.preConflicts];
  let weatherMoves: StructurePlan['weatherMoves'] = [];
  const interestCount = new Map<Interest, number>();

  const candidatesOf = (day: PlannedDay) => day.stops.map((s) => s.candidate);
  const stopsOf = (index: number) => (days[index] ? candidatesOf(days[index]!) : []);
  const daytimeIds = (day: PlannedDay) => day.stops.filter((s) => s.slot === 'day').map((s) => s.candidate.id);
  /** Re-derive a day's minutes from what is on it, so they can never drift from the stops. */
  const refresh = (index: number) => {
    const day = days[index]!;
    const metrics = kernel.dayMetrics(index, candidatesOf(day));
    day.activityMinutes = metrics.activityMinutes;
    day.travelMinutes = metrics.tourMinutes;
    day.eveningTravelMinutes = metrics.eveningMinutes;
  };

  function feasibility(candidate: PlannerCandidate, day: PlannedDay, index: number): { ok: true; cost: number } | { ok: false; reason: DropReason; detail: string } {
    const current = candidatesOf(day);
    const next = [...current, candidate];
    const verdict = kernel.checkDay(index, next, stopsOf, candidate.id);
    if (!verdict.ok) return verdict;
    const slot = slotOf(candidate);
    const fromBase = input.minutes(day.baseId, candidate.id) ?? UNKNOWN_LEG_MINUTES;
    if (slot !== 'day') return { ok: true, cost: fromBase * 2 };
    return { ok: true, cost: kernel.dayMetrics(index, next).tourMinutes - kernel.dayMetrics(index, current).tourMinutes };
  }

  function place(candidate: PlannerCandidate): { ok: true } | { ok: false; reason: DropReason; detail: string } {
    let best: { index: number; score: number; penalty: number } | null = null;
    let geographyOnly: { index: number; score: number } | null = null;
    const failure = firstFailure(candidate, (day, index) => {
      const verdict = feasibility(candidate, day, index);
      if (!verdict.ok) return verdict;
      const load = day.activityMinutes / Math.max(1, day.capacityMinutes);
      const penalty = weatherPenalty(candidate, day.weather);
      // A soft pull towards days already working in the same area, so a city day stays in one or two districts.
      const zones = day.stops.map((s) => s.candidate.zone ?? s.candidate.locality);
      const zonePenalty = zones.length > 0 && !zones.includes(candidate.zone ?? candidate.locality) ? 25 : 0;
      const geo = verdict.cost + load * 40 + zonePenalty;
      const score = geo + penalty;
      if (!geographyOnly || geo < geographyOnly.score) geographyOnly = { index, score: geo };
      if (!best || score < best.score) best = { index, score, penalty };
      return null;
    });
    if (!best) return { ok: false, ...failure };
    const chosen = best as { index: number; score: number; penalty: number };
    const geo = geographyOnly as { index: number; score: number } | null;
    const chosenDay = days[chosen.index]!;
    // Recorded (and told to the traveller) only when the forecast genuinely moved it: rain or worse avoided, not a tie broken by a chance of showers.
    if (geo && geo.index !== chosen.index && (days[geo.index]!.weather?.severity ?? 0) >= 2 && weatherPenalty(candidate, days[geo.index]!.weather) - chosen.penalty >= 60) {
      weatherMoves.push({ candidateId: candidate.id, name: candidate.name, avoidedDate: days[geo.index]!.date, chosenDate: chosenDay.date });
    }
    chosenDay.stops.push({ candidate, slot: slotOf(candidate) });
    refresh(chosen.index);
    return { ok: true };
  }

  /**
   * Probe every day; the refusal reported is the first one, preferring an
   * ordinary day's over an arrival or departure day's (an edge day says less
   * about why a place cannot fit the trip).
   */
  function firstFailure(candidate: PlannerCandidate, probe: (day: PlannedDay, index: number) => { ok: false; reason: DropReason; detail: string } | null): { reason: DropReason; detail: string } {
    const held: { first: { reason: DropReason; detail: string } | null; edge: boolean } = { first: null, edge: true };
    days.forEach((day, index) => {
      const verdict = probe(day, index);
      if (!verdict) return;
      const edge = index === 0 || index === days.length - 1;
      if (!held.first || (!edge && held.edge)) {
        held.first = { reason: verdict.reason, detail: verdict.detail };
        held.edge = edge;
      }
    });
    return held.first ?? { reason: 'capacity', detail: 'There was no day it fitted.' };
  }

  // --- 2. place in priority order: yours (locked ones first), then Sidequest's picks, then maybes -----------
  /*
   * A locked stop goes in before every other include: placed in fit order, an
   * unlocked include could fill the locked day first and turn the traveller's
   * own lock into a conflict.
   */
  const lockedFirst = (c: PlannerCandidate) => (c.status === 'must' && c.pinnedDay !== undefined ? 1 : 0);
  const ordered = [...plannable].sort((a, b) => lockedFirst(b) - lockedFirst(a) || plannerPriority(b) - plannerPriority(a) || a.id.localeCompare(b.id));
  const primaries = ordered.filter((c) => c.status !== 'candidate');
  const fillers = ordered.filter((c) => c.status === 'candidate' && c.fit >= FILLER_MIN_FIT);
  const take = (candidate: PlannerCandidate, capped: boolean | 'avoid_only'): boolean => {
    const interest = candidate.primaryInterest;
    if (capped && interest) {
      const cap = input.frequencyCaps[interest];
      const limit = capped === 'avoid_only' ? (cap === 0 ? 0 : undefined) : cap;
      if (limit !== undefined && (interestCount.get(interest) ?? 0) >= limit) {
        dropped.push({ candidate, reason: 'frequency', detail: 'You already have as much of this kind of thing as you asked for.' });
        return false;
      }
    }
    const placed = place(candidate);
    if (!placed.ok) {
      if (candidate.status === 'must') mustConflicts.push({ candidateId: candidate.id, name: candidate.name, reason: placed.reason, detail: placed.detail });
      dropped.push({ candidate, reason: placed.reason, detail: placed.detail });
      return false;
    }
    if (interest) interestCount.set(interest, (interestCount.get(interest) ?? 0) + 1);
    return true;
  };
  for (const candidate of primaries) take(candidate, candidate.status !== 'must');

  // --- 3. fill thin days from high-fit candidates nobody decided on --------------------------
  /*
   * Frequency is a preference about the mix, not a reason to leave a day
   * empty. A candidate the caps held back in the first pass comes back here as
   * a filler — only onto a thin day, and never if its interest is one the
   * traveller asked to avoid (a cap of zero).
   */
  const heldBack = dropped.filter((d) => d.reason === 'frequency' && (d.candidate.status === 'recommended' || d.candidate.status === 'maybe' || d.candidate.fit >= FILLER_MIN_FIT)).map((d) => d.candidate);
  for (const candidate of heldBack) {
    const at = dropped.findIndex((d) => d.candidate.id === candidate.id && d.reason === 'frequency');
    if (at >= 0) dropped.splice(at, 1);
  }
  const fillQueue = [...fillers, ...heldBack].sort((a, b) => plannerPriority(b) - plannerPriority(a) || a.id.localeCompare(b.id));
  const isThin = (d: PlannedDay) => d.activityMinutes < d.capacityMinutes * FILL_TARGET[input.pace] && daytimeIds(d).length < input.maxStopsPerDay;
  for (const candidate of fillQueue) {
    const thin = days.some(isThin);
    if (!thin) break;
    const before = days.map((d) => d.stops.length);
    if (take(candidate, 'avoid_only')) {
      // Only keep a filler that landed on a thin day; on a full day it is undone.
      const index = days.findIndex((d, i) => d.stops.length > before[i]!);
      const day = days[index]!;
      if (day.activityMinutes - (slotOf(candidate) === 'day' ? candidate.durationMinutes : 0) >= day.capacityMinutes * FILL_TARGET[input.pace]) {
        day.stops = day.stops.filter((s) => s.candidate.id !== candidate.id);
        refresh(index);
        if (candidate.primaryInterest) interestCount.set(candidate.primaryInterest, (interestCount.get(candidate.primaryInterest) ?? 1) - 1);
      }
    }
  }
  /*
   * --- 3b. no abandoned day ----------------------------------------------------------------
   * A day between arrival and departure with nothing in it is not a rest day the
   * traveller chose; it is the planner running out of strict matches. Each one
   * gets the best remaining place that can legally go there — the fit floor and
   * the frequency preference are relaxed here, never the traveller's own skips,
   * an interest they asked to avoid, or the effort ceiling.
   */
  for (const [index, day] of days.entries()) {
    if (index === 0 || index === days.length - 1 || day.stops.length > 0) continue;
    const taken = new Set(days.flatMap((d) => d.stops.map((s) => s.candidate.id)));
    const options = plannable
      .filter((c) => !taken.has(c.id) && !(c.primaryInterest && input.frequencyCaps[c.primaryInterest] === 0))
      .sort((a, b) => plannerPriority(b) - plannerPriority(a) || a.id.localeCompare(b.id));
    for (const candidate of options) {
      const verdict = feasibility(candidate, day, index);
      if (!verdict.ok) continue;
      day.stops.push({ candidate, slot: slotOf(candidate) });
      refresh(index);
      const at = dropped.findIndex((d) => d.candidate.id === candidate.id);
      if (at >= 0) dropped.splice(at, 1);
      break;
    }
  }

  const improve = input.improve ?? true;
  if (improve !== false) {
    /*
     * --- 3c. the improvement phase ------------------------------------------------------------
     * Construction is a good seed and the source of every explanation; the
     * iterated local search in `structure-improve.ts` then moves, swaps,
     * replaces and re-inserts against one stated objective, through the same
     * day validator, and keeps a change only when the whole trip scores
     * strictly better. What it settles on is then explained afresh, below,
     * so every reason describes the plan the traveller actually gets.
     */
    const seed: PlanState = days.map((d) => d.stops.map((s) => s.candidate));
    const best = improveStructure(kernel, seed, improve === true ? {} : improve);
    best.forEach((stops, index) => {
      days[index]!.stops = stops.map((candidate) => ({ candidate, slot: slotOf(candidate) }));
      refresh(index);
    });
    const forecastMatters = kernel.days.some((d) => (d.weather?.severity ?? 0) >= 2);
    const blindDayOf = forecastMatters ? new Map(planStructure({ ...input, weather: [] }).days.flatMap((d, i) => d.stops.map((s) => [s.candidate.id, i] as const))) : null;
    const explained = reexplain(kernel, best, blindDayOf);
    dropped.splice(0, dropped.length, ...kernel.preDropped, ...explained.dropped);
    mustConflicts.splice(0, mustConflicts.length, ...kernel.preConflicts, ...explained.mustConflicts);
    weatherMoves = explained.weatherMoves;
  } else {
    const usedIds = new Set(days.flatMap((d) => d.stops.map((s) => s.candidate.id)));
    for (const candidate of input.candidates) {
      if (candidate.status === 'candidate' && !usedIds.has(candidate.id) && !dropped.some((d) => d.candidate.id === candidate.id) && candidate.fit >= FILLER_MIN_FIT) {
        dropped.push({ candidate, reason: 'capacity', detail: 'A good fit with no room left for it.' });
      }
    }
  }
  const usedIds = new Set(days.flatMap((d) => d.stops.map((s) => s.candidate.id)));

  // --- 4. order each day, place lunch, choose a backup, rate the effort -------------------------
  const backupPool = plannable.filter((c) => c.rainyDayOk && !usedIds.has(c.id) && slotOf(c) === 'day' && c.exposure !== 'outdoor' && c.booking !== 'required');
  const usedBackups = new Set<string>();
  for (const day of days) {
    const window = dayWindowOf(input, day.date);
    const byId = new Map(day.stops.map((s) => [s.candidate.id, s]));
    let tour = tourMinutes(day.baseId, daytimeIds(day), input.minutes);
    // "Morning" is soft (V10): it leads the day when that costs under half an hour of extra travel.
    const morning = daytimeIds(day).filter((id) => byId.get(id)!.candidate.bestTime === 'morning');
    if (morning.length > 0 && !morning.every((id, i) => tour.order[i] === id)) {
      const rest = daytimeIds(day).filter((id) => !morning.includes(id));
      const head = tourMinutes(day.baseId, morning, input.minutes).order;
      const tailStart = head[head.length - 1]!;
      const tail = tourMinutes(tailStart, rest, input.minutes).order;
      const order = [...head, ...tail];
      let total = 0;
      let at = day.baseId;
      for (const id of order) {
        total += input.minutes(at, id) ?? UNKNOWN_LEG_MINUTES;
        at = id;
      }
      total += input.minutes(at, day.baseId) ?? UNKNOWN_LEG_MINUTES;
      if (total <= tour.total + 30) tour = { order, total };
    }
    const sunrise = day.stops.filter((s) => s.slot === 'sunrise');
    const evening = day.stops.filter((s) => s.slot === 'sunset').concat(day.stops.filter((s) => s.slot === 'night'));
    day.stops = [...sunrise, ...tour.order.map((id) => byId.get(id)!), ...evening];
    day.travelMinutes = tour.total;
    // Lunch falls after whichever daytime stop carries the clock past about 12:30.
    let clock = window.startMinute;
    let previous = day.baseId;
    for (const id of tour.order) {
      const stop = byId.get(id)!;
      clock += (input.minutes(previous, id) ?? UNKNOWN_LEG_MINUTES) + stop.candidate.durationMinutes;
      previous = id;
      if (clock >= 12 * 60 + 30 && !day.lunchNear) {
        day.lunchNear = stop.candidate.locality;
        day.lunchFoodArea =
          input.foodAreas.find((f) => f.coordinates && haversine(f.coordinates, stop.candidate.coordinates) <= 6) ??
          input.foodAreas.find((f) => f.locality.toLowerCase() === stop.candidate.locality.toLowerCase()) ??
          null;
      }
    }
    if (!day.lunchNear && tour.order.length > 0) day.lunchNear = byId.get(tour.order[tour.order.length - 1]!)!.candidate.locality;
    const outdoorMinutes = day.stops.filter((s) => s.candidate.exposure === 'outdoor').reduce((n, s) => n + s.candidate.durationMinutes, 0);
    const exposed = outdoorMinutes > 0 && (outdoorMinutes * 2 >= day.activityMinutes || (day.weather?.wet ?? false));
    if (exposed) {
      /* "Close by" is a claim: a backup whose distance nobody measured is not offered as one. */
      const near = backupPool
        .filter((c) => {
          const m = input.minutes(day.baseId, c.id);
          return m !== null && m <= 60;
        })
        .sort((a, b) => Number(usedBackups.has(a.id)) - Number(usedBackups.has(b.id)) || (a.exposure === 'indoor' ? 0 : 1) - (b.exposure === 'indoor' ? 0 : 1) || b.fit - a.fit || a.id.localeCompare(b.id));
      day.backup = near[0] ?? null;
      if (day.backup) usedBackups.add(day.backup.id);
    }
    const peak = Math.max(0, ...day.stops.map((s) => INTENSITY_RANK[s.candidate.intensity]));
    const load = (day.activityMinutes + day.travelMinutes) / Math.max(1, day.capacityMinutes);
    const edge = day.dayNumber === 1 || day.dayNumber === days.length;
    // An arrival or departure day is short by design; its load says nothing about effort.
    day.intensity = peak >= 3 || (!edge && load > 0.95) ? 'intense' : peak >= 2 || (!edge && load > 0.6) ? 'moderate' : 'light';
  }

  return { days, dropped, weatherMoves, mustConflicts };
}

/**
 * EXPLAIN THE PLAN THE TRAVELLER GETS (after the improvement phase).
 *
 * Construction's reasons were true when they were written, but a place left
 * out at step 2 may have been placed by a later move, and a place construction
 * kept may have been replaced. So every reason is recomputed from the final
 * plan with the same validator, in the same words:
 *
 *  - an interest at its cap (or one the traveller asked to avoid) → `frequency`;
 *  - no day would take it → the first day's refusal (an ordinary day's
 *    preferred over an arrival or departure day's), exactly as construction
 *    reported it;
 *  - some day would take it, but adding it lowered the trip's objective →
 *    `capacity`, said plainly: there was room, but not room worth using.
 *
 * Membership is construction's: every unplaced pick, include or maybe, and
 * every unplaced candidate good enough to have been a filler (fit ≥ 60). A
 * traveller include left out is also a `mustConflict` — never silent.
 *
 * Weather moves are recomputed against the plan the same board makes with no
 * forecast (below).
 */
function reexplain(kernel: ReturnType<typeof createPlannerKernel>, state: PlanState, blindDayOf: ReadonlyMap<string, number> | null): Pick<StructurePlan, 'dropped' | 'mustConflicts' | 'weatherMoves'> {
  const { input, days } = kernel;
  const dayOf = new Map<string, number>();
  state.forEach((stops, i) => stops.forEach((s) => dayOf.set(s.id, i)));
  const counts = new Map<Interest, number>();
  for (const stops of state) for (const s of stops) if (s.primaryInterest) counts.set(s.primaryInterest, (counts.get(s.primaryInterest) ?? 0) + 1);
  const dropped: StructurePlan['dropped'] = [];
  const mustConflicts: StructurePlan['mustConflicts'] = [];
  for (const candidate of kernel.plannable) {
    if (dayOf.has(candidate.id)) continue;
    if (candidate.status === 'candidate' && candidate.fit < FILLER_MIN_FIT) continue;
    const interest = candidate.primaryInterest;
    const cap = interest ? input.frequencyCaps[interest] : undefined;
    if (candidate.status !== 'must' && interest && cap !== undefined && (cap === 0 || (counts.get(interest) ?? 0) >= cap)) {
      dropped.push({ candidate, reason: 'frequency', detail: 'You already have as much of this kind of thing as you asked for.' });
      continue;
    }
    const held: { first: { reason: DropReason; detail: string } | null; edge: boolean; fits: boolean } = { first: null, edge: true, fits: false };
    state.forEach((stops, index) => {
      const verdict = kernel.checkDay(index, [...stops, candidate], (j) => state[j] ?? [], candidate.id);
      if (verdict.ok) {
        held.fits = true;
        return;
      }
      const edge = days[index]!.isFirst || days[index]!.isLast;
      if (!held.first || (!edge && held.edge)) {
        held.first = { reason: verdict.reason, detail: verdict.detail };
        held.edge = edge;
      }
    });
    const first = held.first;
    const reason: { reason: DropReason; detail: string } = held.fits
      ? { reason: 'capacity', detail: candidate.status === 'must' ? 'There was room, but placing it would have meant giving up more of what you chose.' : 'There was room, but adding it made the days more crowded or more driven than it was worth.' }
      : first ?? { reason: 'capacity', detail: 'There was no day it fitted.' };
    dropped.push({ candidate, ...reason });
    if (candidate.status === 'must') mustConflicts.push({ candidateId: candidate.id, name: candidate.name, ...reason });
  }

  /*
   * "Geography alone would have chosen" is a whole plan, not one stop's best
   * day: once the search can move everything, the counterfactual is the same
   * construction and search with the forecast taken away. A stop is a weather
   * move when that plan puts it on a rain-or-worse day and the real plan puts
   * it on a materially drier one. No forecast at that severity, no second run.
   */
  const weatherMoves: StructurePlan['weatherMoves'] = [];
  if (blindDayOf) {
    for (const [id, at] of dayOf) {
      const blind = blindDayOf.get(id);
      if (blind === undefined || blind === at) continue;
      const candidate = state[at]!.find((s) => s.id === id)!;
      const avoided = days[blind]!;
      if ((avoided.weather?.severity ?? 0) >= 2 && weatherPenalty(candidate, avoided.weather) - weatherPenalty(candidate, days[at]!.weather) >= 60) {
        weatherMoves.push({ candidateId: id, name: candidate.name, avoidedDate: avoided.date, chosenDate: days[at]!.date });
      }
    }
  }
  return { dropped, mustConflicts, weatherMoves };
}

function haversine(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** The transport the draft states for reaching a stop, from the trip's mode and the leg's size. */
export function transportFor(carAvailable: boolean, minutesFromPrevious: number | null, kmFromPrevious: number | null, category?: AnchorCategory): DraftTransport {
  if (carAvailable) return category === 'scenic_drive' || (kmFromPrevious ?? 99) > 1.2 ? 'car' : 'walk';
  if ((kmFromPrevious ?? 99) <= 1.5) return 'walk';
  if ((kmFromPrevious ?? 0) > 40 || (minutesFromPrevious ?? 0) > 70) return 'rail';
  return 'metro';
}

export function archetypeFor(input: { bases: number; carAvailable: boolean; urban: boolean }): TripArchetype {
  if (input.bases > 1) return input.carAvailable ? 'road_trip' : 'rail_route';
  return input.urban ? 'single_base_urban' : 'hub_and_spoke';
}

export type { DraftAnchor, DraftDay };
