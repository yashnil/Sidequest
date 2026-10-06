import type { Interest, PhysicalIntensity, TimeOfDay } from '@sidequest/core';
import type { AnchorCategory, DraftAnchor, DraftDay, DraftTransport, TripArchetype } from './trip-draft';

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

const INTENSITY_RANK: Record<PhysicalIntensity, number> = { none: 0, easy: 1, moderate: 2, strenuous: 3 };
const BUFFER_BY_PACE = { slow: 90, balanced: 45, fast: 20 } as const;
/** Status lifts priority without letting a weak pick outrank a defining place; the traveller's own includes always come first. */
const STATUS_BONUS: Record<PlannerStatus, number> = { must: 1000, recommended: 12, maybe: 8, candidate: 0 };
export function plannerPriority(c: Pick<PlannerCandidate, 'status' | 'fit' | 'significance'>): number {
  return STATUS_BONUS[c.status] + c.fit + Math.max(0, c.significance - 0.5) * 50;
}
/** A filler is only worth adding when it fits this well. */
const FILLER_MIN_FIT = 60;
/** Fill a day back up to this share of its capacity from high-fit fillers. */
const FILL_TARGET = { slow: 0.55, balanced: 0.7, fast: 0.85 } as const;
const LUNCH_MINUTES = 60;
/** The longest hop between two stops that still reads as one day's outing. */
const COHERENT_HOP_MINUTES = 50;

function dayWindowOf(input: StructurePlannerInput, date: string): PlannerDayWindow {
  return input.windows.find((w) => w.date === date) ?? { date, startMinute: 9 * 60, endMinute: 18 * 60 };
}

function baseForDate(bases: readonly PlannerBase[], date: string, isLast: boolean): PlannerBase {
  // The night of `date` is spent at the base whose stay covers it; the last day belongs to the last base.
  if (isLast) return bases[bases.length - 1]!;
  return bases.find((b) => date >= b.fromDate && date < b.toDate) ?? bases[bases.length - 1]!;
}

/** Minimum round-trip minutes from a base through a set of stops, by exhaustive order up to 7 stops, nearest-neighbour beyond. */
export function tourMinutes(baseId: string, ids: readonly string[], minutes: StructurePlannerInput['minutes']): { order: string[]; total: number } {
  const m = (a: string, b: string) => minutes(a, b) ?? 60;
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
  let total = 0;
  while (rest.size > 0) {
    let next: string | null = null;
    for (const id of rest) if (next === null || m(at, id) < m(at, next)) next = id;
    total += m(at, next!);
    order.push(next!);
    rest.delete(next!);
    at = next!;
  }
  return { order, total: total + m(at, baseId) };
}

function slotOf(candidate: PlannerCandidate): PlannedStop['slot'] {
  if (candidate.bestTime === 'sunrise') return 'sunrise';
  if (candidate.bestTime === 'sunset') return 'sunset';
  if (candidate.bestTime === 'night') return 'night';
  return 'day';
}

function weatherPenalty(candidate: PlannerCandidate, weather: PlannerDayWeather | null): number {
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

export function planStructure(input: StructurePlannerInput): StructurePlan {
  const dates = input.windows.map((w) => w.date);
  const buffer = BUFFER_BY_PACE[input.pace];
  const weatherByDate = new Map(input.weather.map((w) => [w.date, w]));

  const days: PlannedDay[] = dates.map((date, i) => {
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
    return {
      dayNumber: i + 1,
      date,
      baseId: base.id,
      relocation,
      stops: [],
      travelMinutes: 0,
      eveningTravelMinutes: 0,
      activityMinutes: 0,
      capacityMinutes: capacity,
      weather: weatherByDate.get(date) ?? null,
      lunchNear: null,
      lunchFoodArea: null,
      backup: null,
      intensity: 'light',
    };
  });

  const dropped: StructurePlan['dropped'] = [];
  const mustConflicts: StructurePlan['mustConflicts'] = [];
  const weatherMoves: StructurePlan['weatherMoves'] = [];
  const interestCount = new Map<Interest, number>();
  const maxIntensity = INTENSITY_RANK[input.maxPhysicalIntensity];

  const daytimeIds = (day: PlannedDay) => day.stops.filter((s) => s.slot === 'day').map((s) => s.candidate.id);
  const dayCost = (day: PlannedDay, ids: readonly string[]) => tourMinutes(day.baseId, ids, input.minutes).total;
  const hasStrenuous = (day: PlannedDay | undefined) => Boolean(day?.stops.some((s) => s.candidate.intensity === 'strenuous'));

  function feasibility(candidate: PlannerCandidate, day: PlannedDay, index: number): { ok: true; cost: number; travelAfter: number } | { ok: false; reason: DropReason; detail: string } {
    if (candidate.pinnedDay !== undefined && candidate.pinnedDay !== day.dayNumber) return { ok: false, reason: 'capacity', detail: `You locked this to day ${candidate.pinnedDay}, and it no longer fits that day.` };
    if (candidate.closedDates?.includes(day.date)) return { ok: false, reason: 'closed', detail: 'Its published hours say it is shut that day.' };
    const isFirst = index === 0;
    const isLast = index === days.length - 1;
    const slot = slotOf(candidate);
    const user = candidate.status === 'must';
    if (candidate.intensity === 'strenuous' && !user) {
      if (isFirst || isLast) return { ok: false, reason: 'too_strenuous', detail: 'A strenuous outing does not belong on an arrival or departure day.' };
      if (hasStrenuous(day)) return { ok: false, reason: 'too_strenuous', detail: 'One strenuous outing a day is enough.' };
      if (input.pace !== 'fast' && (hasStrenuous(days[index - 1]) || hasStrenuous(days[index + 1]))) return { ok: false, reason: 'too_strenuous', detail: 'Two hard days back to back is more than you asked for.' };
    }
    const fromBase = input.minutes(day.baseId, candidate.id);
    const reach = Math.max(45, Math.floor(input.maxDailyTravelMinutes / 2));
    const dayTripReach = Math.floor(input.maxDailyTravelMinutes * 0.6);
    const soloDayTrip = candidate.dayTrip && slotOf(candidate) === 'day' && fromBase !== null && fromBase <= dayTripReach && day.stops.length === 0 && !isFirst && !isLast && !day.relocation;
    if (fromBase !== null && fromBase > reach && !user && !soloDayTrip) return { ok: false, reason: 'too_far', detail: `About ${Math.round(fromBase)} minutes each way from where you sleep that night.` };
    if (day.stops.some((s) => s.candidate.dayTrip && (input.minutes(day.baseId, s.candidate.id) ?? 0) > reach) && !user) return { ok: false, reason: 'capacity', detail: 'That day is a day trip elsewhere.' };
    if (slot === 'sunrise') {
      if (isFirst || day.relocation || day.stops.some((s) => s.slot === 'sunrise')) return { ok: false, reason: 'capacity', detail: 'No free sunrise.' };
      return { ok: true, cost: (fromBase ?? 30) * 2, travelAfter: day.travelMinutes };
    }
    if (slot === 'sunset' || slot === 'night') {
      if (isLast || day.stops.some((s) => s.slot === 'sunset' || s.slot === 'night')) return { ok: false, reason: 'capacity', detail: 'No free evening.' };
      if (fromBase !== null && fromBase > 75 && !user) return { ok: false, reason: 'too_far', detail: 'Too far from base to come back from after dark.' };
      const roundTrip = (fromBase ?? 30) * 2;
      if (day.travelMinutes + day.eveningTravelMinutes + roundTrip > input.maxDailyTravelMinutes && !user) return { ok: false, reason: 'too_far', detail: `It would take the day's travel past the ${input.maxDailyTravelMinutes} minutes you set.` };
      return { ok: true, cost: roundTrip, travelAfter: day.travelMinutes };
    }
    const ids = daytimeIds(day);
    /*
     * A day hangs together: a stop joins a day only if it is a reasonable hop
     * from something already on it. A place an hour or more beyond the rest of
     * the day (a day trip, the far side of a region) waits for a day of its own
     * instead of being stitched between two neighbourhoods.
     */
    if (ids.length > 0 && !user) {
      const nearest = Math.min(...ids.map((id) => input.minutes(id, candidate.id) ?? 999));
      if (nearest > COHERENT_HOP_MINUTES) return { ok: false, reason: 'too_far', detail: 'Too far from the rest of that day.' };
    }
    const extras = day.stops.filter((s) => s.slot !== 'day').length;
    if (ids.length >= input.maxStopsPerDay - Math.max(0, extras - 1) && !user) return { ok: false, reason: 'capacity', detail: 'The day already holds as many stops as your pace allows.' };
    const before = dayCost(day, ids);
    const after = dayCost(day, [...ids, candidate.id]);
    const travelAfter = after;
    const used = day.activityMinutes + travelAfter + candidate.durationMinutes;
    if (used > day.capacityMinutes && !(user && day.stops.length === 0)) return { ok: false, reason: 'capacity', detail: 'The day is already full.' };
    if (travelAfter + day.eveningTravelMinutes > input.maxDailyTravelMinutes && !user) return { ok: false, reason: 'too_far', detail: `It would take the day's travel past the ${input.maxDailyTravelMinutes} minutes you set.` };
    return { ok: true, cost: after - before, travelAfter };
  }

  function place(candidate: PlannerCandidate): { ok: true } | { ok: false; reason: DropReason; detail: string } {
    let best: { day: PlannedDay; score: number; travelAfter: number; penalty: number } | null = null;
    let firstFailure: { reason: DropReason; detail: string } | null = null;
    let firstFailureEdge = true;
    let geographyOnly: { day: PlannedDay; score: number } | null = null;
    days.forEach((day, index) => {
      const verdict = feasibility(candidate, day, index);
      if (!verdict.ok) {
        const edge = index === 0 || index === days.length - 1;
        if (!firstFailure || (!edge && firstFailureEdge)) {
          firstFailure = { reason: verdict.reason, detail: verdict.detail };
          firstFailureEdge = edge;
        }
        return;
      }
      const load = day.activityMinutes / Math.max(1, day.capacityMinutes);
      const penalty = weatherPenalty(candidate, day.weather);
      // A soft pull towards days already working in the same area, so a city day stays in one or two districts.
      const zones = day.stops.map((s) => s.candidate.zone ?? s.candidate.locality);
      const zonePenalty = zones.length > 0 && !zones.includes(candidate.zone ?? candidate.locality) ? 25 : 0;
      const geo = verdict.cost + load * 40 + zonePenalty;
      const score = geo + penalty;
      if (!geographyOnly || geo < geographyOnly.score) geographyOnly = { day, score: geo };
      if (!best || score < best.score) best = { day, score, travelAfter: verdict.travelAfter, penalty };
    });
    if (!best) return { ok: false, ...(firstFailure ?? { reason: 'capacity' as DropReason, detail: 'There was no day it fitted.' }) };
    const chosen = best as { day: PlannedDay; score: number; travelAfter: number; penalty: number };
    const geo = geographyOnly as { day: PlannedDay; score: number } | null;
    // Recorded (and told to the traveller) only when the forecast genuinely moved it: rain or worse avoided, not a tie broken by a chance of showers.
    if (geo && geo.day !== chosen.day && (geo.day.weather?.severity ?? 0) >= 2 && weatherPenalty(candidate, geo.day.weather) - chosen.penalty >= 60) {
      weatherMoves.push({ candidateId: candidate.id, name: candidate.name, avoidedDate: geo.day.date, chosenDate: chosen.day.date });
    }
    const slot = slotOf(candidate);
    chosen.day.stops.push({ candidate, slot });
    chosen.day.activityMinutes += slot === 'day' ? candidate.durationMinutes : 0;
    if (slot === 'day') chosen.day.travelMinutes = chosen.travelAfter;
    else if (slot !== 'sunrise') chosen.day.eveningTravelMinutes += (input.minutes(chosen.day.baseId, candidate.id) ?? 30) * 2;
    return { ok: true };
  }

  // --- 1. what may be planned at all -------------------------------------------------
  const plannable: PlannerCandidate[] = [];
  for (const candidate of input.candidates) {
    if (!candidate.openOnTripDates && candidate.status !== 'must') {
      dropped.push({ candidate, reason: 'out_of_season', detail: 'Closed or impractical in the months you are travelling.' });
      continue;
    }
    if (candidate.blocked) {
      dropped.push({ candidate, reason: 'not_workable', detail: candidate.blocked });
      if (candidate.status === 'must') mustConflicts.push({ candidateId: candidate.id, name: candidate.name, reason: 'not_workable', detail: candidate.blocked });
      continue;
    }
    if (INTENSITY_RANK[candidate.intensity] > maxIntensity && candidate.status !== 'must') {
      dropped.push({ candidate, reason: 'too_strenuous', detail: 'More effort than you said you want.' });
      continue;
    }
    plannable.push(candidate);
  }

  // --- 2. place in priority order: yours, then Sidequest's picks, then maybes -----------
  const ordered = [...plannable].sort((a, b) => plannerPriority(b) - plannerPriority(a) || a.id.localeCompare(b.id));
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
      const day = days.find((d, i) => d.stops.length > before[i]!)!;
      if (day.activityMinutes - (slotOf(candidate) === 'day' ? candidate.durationMinutes : 0) >= day.capacityMinutes * FILL_TARGET[input.pace]) {
        day.stops = day.stops.filter((s) => s.candidate.id !== candidate.id);
        day.activityMinutes -= slotOf(candidate) === 'day' ? candidate.durationMinutes : 0;
        day.travelMinutes = dayCost(day, daytimeIds(day));
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
      const slot = slotOf(candidate);
      day.stops.push({ candidate, slot });
      if (slot === 'day') {
        day.activityMinutes += candidate.durationMinutes;
        day.travelMinutes = verdict.travelAfter;
      }
      const at = dropped.findIndex((d) => d.candidate.id === candidate.id);
      if (at >= 0) dropped.splice(at, 1);
      break;
    }
  }
  const usedIds = new Set(days.flatMap((d) => d.stops.map((s) => s.candidate.id)));
  for (const candidate of input.candidates) {
    if (candidate.status === 'candidate' && !usedIds.has(candidate.id) && !dropped.some((d) => d.candidate.id === candidate.id) && candidate.fit >= FILLER_MIN_FIT) {
      dropped.push({ candidate, reason: 'capacity', detail: 'A good fit with no room left for it.' });
    }
  }

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
        total += input.minutes(at, id) ?? 60;
        at = id;
      }
      total += input.minutes(at, day.baseId) ?? 60;
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
      clock += (input.minutes(previous, id) ?? 30) + stop.candidate.durationMinutes;
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
      const near = backupPool
        .filter((c) => (input.minutes(day.baseId, c.id) ?? 999) <= 60)
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
