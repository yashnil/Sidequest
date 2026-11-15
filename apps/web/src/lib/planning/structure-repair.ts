import { haversineKm } from '@sidequest/geo';
import type { PlanState, PlannerCandidate, PlannerKernel } from './structure-planner';

/**
 * RELEASE CANDIDATE — A BAD DAY IS REPAIRED OR STATED, NEVER SHOWN AS IF IT WERE FINE.
 *
 * The day validator (`PlannerKernel.checkDay`) keeps Sidequest's own picks
 * inside the traveller's limits. The traveller's own includes are exempt, and
 * must stay exempt: an include is never silently lost. But "exempt" used to
 * mean "left wherever it landed", and the evaluation found every overfull day
 * and every heavy arrival day was a lone include parked on a day too short for
 * it while an ordinary day held Sidequest's own, lesser picks.
 *
 * So, after the improvement phase and through the same validator:
 *
 *  1. a day an include has made overfull, over the travel limit or too heavy
 *     for an arrival or departure moves that include to the day that takes it
 *     at the least cost, giving up as few of Sidequest's picks there as it can
 *     (never another include, never a locked stop);
 *  2. what was given up goes to any day that will have it, and a day emptied
 *     by the move takes the best place that fits;
 *  3. whatever cannot be repaired is written on the day, in words, with its
 *     figures (`describeDays`). An unmeasured leg is timed with the allowance,
 *     and the sentence says "about".
 *
 * Pure and deterministic: fixed orders over days and ids, no clock.
 */

export type DayNoteCode = 'transfer_over_limit' | 'travel_over_limit' | 'day_overfull' | 'edge_day_heavy' | 'hard_days_together' | 'open_day' | 'walk_return' | 'walk_luggage' | 'trail_stage' | 'trail_alternative' | 'trail_unresolved' | 'trail_rest' | 'trail_return' | 'trail_gap';

export interface DayNote {
  dayNumber: number;
  code: DayNoteCode;
  note: string;
}

export interface DayRepair {
  dayNumber: number;
  code: 'moved_own_pick';
  note: string;
}

/** Above this share of what an arrival or departure day has, the day is heavy. */
const HEAVY_EDGE_LOAD = 0.8;
/** The most of Sidequest's picks one repair may give up on the day that takes an include. */
const MAX_EJECTIONS = 2;

function clock(minutes: number): string {
  const rounded = Math.max(0, Math.round(minutes / 5) * 5);
  if (rounded < 60) return `${rounded} minutes`;
  const h = Math.floor(rounded / 60);
  const m = rounded % 60;
  return m === 0 ? `${h} h` : `${h} h ${String(m).padStart(2, '0')}`;
}

interface DayLoad {
  used: number;
  travel: number;
  overflow: number;
  overTravel: number;
  heavyEdge: boolean;
}

function loadOf(kernel: PlannerKernel, index: number, stops: readonly PlannerCandidate[]): DayLoad {
  const day = kernel.days[index]!;
  const metrics = kernel.dayMetrics(index, stops);
  const used = metrics.activityMinutes + metrics.tourMinutes;
  const travel = metrics.tourMinutes + metrics.eveningMinutes + metrics.sunriseMinutes;
  const edge = day.isFirst || day.isLast;
  const span = Math.max(1, day.windowMinutes - day.transferMinutes);
  return {
    used,
    travel,
    overflow: stops.length > 0 ? Math.max(0, used - day.capacityMinutes) : 0,
    overTravel: Math.max(0, travel - day.travelBudgetMinutes),
    heavyEdge: edge && stops.length > 0 && (used / span > HEAVY_EDGE_LOAD || stops.some((s) => s.intensity === 'strenuous')),
  };
}

const defective = (load: DayLoad): boolean => load.overflow > 0 || load.overTravel > 0 || load.heavyEdge;

/** Every way to give up at most `MAX_EJECTIONS` of a day's non-includes, least given up first. */
function ejectionSets(kernel: PlannerKernel, stops: readonly PlannerCandidate[]): PlannerCandidate[][] {
  const removable = stops.filter((s) => s.status !== 'must' && s.pinnedDay === undefined).sort((a, b) => kernel.experienceValue(a) - kernel.experienceValue(b) || a.id.localeCompare(b.id));
  const sets: PlannerCandidate[][] = [[]];
  for (let i = 0; i < removable.length; i += 1) {
    sets.push([removable[i]!]);
    if (MAX_EJECTIONS >= 2) for (let j = i + 1; j < removable.length; j += 1) sets.push([removable[i]!, removable[j]!]);
  }
  const lost = (set: readonly PlannerCandidate[]) => set.reduce((n, s) => n + kernel.experienceValue(s), 0);
  return sets.sort((a, b) => lost(a) - lost(b) || a.length - b.length);
}

/** Puts `stop` on the first day (best value for the least travel) that will have it. */
function reinsert(kernel: PlannerKernel, state: PlanState, stop: PlannerCandidate, avoid: ReadonlySet<number>): boolean {
  let best: { index: number; added: number } | null = null;
  state.forEach((row, index) => {
    if (avoid.has(index)) return;
    const next = [...row, stop];
    if (!kernel.checkDay(index, next, (j) => state[j] ?? [], stop.id).ok) return;
    const added = kernel.dayMetrics(index, next).tourMinutes - kernel.dayMetrics(index, row).tourMinutes;
    if (!best || added < best.added) best = { index, added };
  });
  if (!best) return false;
  const chosen = (best as { index: number }).index;
  state[chosen] = [...state[chosen]!, stop];
  return true;
}

export function repairDays(kernel: PlannerKernel, seed: PlanState): { state: PlanState; repairs: DayRepair[] } {
  const state: PlanState = seed.map((row) => [...row]);
  const repairs: DayRepair[] = [];
  const stopsOf = (index: number) => state[index] ?? [];
  for (let index = 0; index < state.length; index += 1) {
    if (!defective(loadOf(kernel, index, stopsOf(index)))) continue;
    const includes = stopsOf(index)
      .filter((s) => s.status === 'must' && s.pinnedDay === undefined)
      .sort((a, b) => b.durationMinutes - a.durationMinutes || a.id.localeCompare(b.id));
    for (const include of includes) {
      const remaining = stopsOf(index).filter((s) => s.id !== include.id);
      /* The day it leaves must be better for it, and valid without it. */
      if (remaining.length > 0 && !kernel.checkDay(index, remaining, stopsOf).ok) continue;
      let best: { target: number; ejected: PlannerCandidate[]; lost: number; added: number } | null = null;
      for (let target = 0; target < state.length; target += 1) {
        if (target === index) continue;
        const row = stopsOf(target);
        if (defective(loadOf(kernel, target, row))) continue;
        for (const ejected of ejectionSets(kernel, row)) {
          const next = [...row.filter((s) => !ejected.includes(s)), include];
          const view = (j: number) => (j === target ? next : j === index ? remaining : stopsOf(j));
          if (!kernel.checkDay(target, next, view, include.id).ok) continue;
          if (defective(loadOf(kernel, target, next))) continue;
          const lost = ejected.reduce((n, s) => n + kernel.experienceValue(s), 0);
          const added = kernel.dayMetrics(target, next).tourMinutes;
          if (!best || lost < best.lost || (lost === best.lost && added < best.added)) best = { target, ejected, lost, added };
          break;
        }
      }
      if (!best) continue;
      const chosen = best as { target: number; ejected: PlannerCandidate[] };
      state[index] = remaining;
      state[chosen.target] = [...stopsOf(chosen.target).filter((s) => !chosen.ejected.includes(s)), include];
      const dayNumber = kernel.days[index]!.dayNumber;
      repairs.push({ dayNumber, code: 'moved_own_pick', note: `${include.name} moved from day ${dayNumber} to day ${kernel.days[chosen.target]!.dayNumber}, where there is time for it.` });
      for (const stop of chosen.ejected) reinsert(kernel, state, stop, new Set([chosen.target]));
      if (!defective(loadOf(kernel, index, stopsOf(index)))) break;
    }
    /* A day between arrival and departure the repair emptied takes the best place that will go there. */
    const day = kernel.days[index]!;
    if (stopsOf(index).length === 0 && !day.isFirst && !day.isLast) {
      const taken = new Set(state.flat().map((s) => s.id));
      const options = kernel.plannable.filter((c) => !taken.has(c.id) && kernel.input.frequencyCaps[c.primaryInterest ?? 'hiking'] !== 0).sort((a, b) => kernel.experienceValue(b) - kernel.experienceValue(a) || a.id.localeCompare(b.id));
      for (const candidate of options) {
        if (!kernel.checkDay(index, [candidate], stopsOf, candidate.id).ok) continue;
        state[index] = [candidate];
        break;
      }
    }
  }
  fillThinDays(kernel, state);
  return { state, repairs };
}

/** Under this share of its capacity, a day with one stop or none is thin enough to want company. */
const THIN_DAY_SHARE = 0.5;

/**
 * A DAY THAT COULD HOLD MORE, AND A PLACE THAT WOULD GO THERE.
 *
 * The search optimises a score, so it can stop with a thin day while a good
 * place sits unused because adding it did not pay. Only a place the day's own
 * validator accepts, inside the interest caps, and only until the day stops
 * being thin; a place already in the plan is never moved, so nothing the
 * traveller chose is disturbed.
 */
function fillThinDays(kernel: PlannerKernel, state: PlanState): void {
  const caps = kernel.input.frequencyCaps;
  const stopsOf = (index: number) => state[index] ?? [];
  const thin = (index: number) => {
    const day = kernel.days[index]!;
    if (day.isFirst || day.isLast) return false;
    const stops = stopsOf(index);
    const metrics = kernel.dayMetrics(index, stops);
    return stops.length <= 1 && metrics.activityMinutes + metrics.tourMinutes < day.capacityMinutes * THIN_DAY_SHARE;
  };
  for (let index = 0; index < state.length; index += 1) {
    for (let guard = 0; guard < 3 && thin(index); guard += 1) {
      const taken = new Set(state.flat().map((s) => s.id));
      const used = new Map<string, number>();
      for (const s of state.flat()) if (s.primaryInterest) used.set(s.primaryInterest, (used.get(s.primaryInterest) ?? 0) + 1);
      const underCap = (c: PlannerCandidate) => !c.primaryInterest || caps[c.primaryInterest] === undefined || (used.get(c.primaryInterest) ?? 0) < caps[c.primaryInterest]!;
      const next = kernel.plannable
        .filter((c) => !taken.has(c.id) && c.fit >= kernel.fillerMinFit && underCap(c))
        .sort((a, b) => kernel.experienceValue(b) - kernel.experienceValue(a) || a.id.localeCompare(b.id))
        .find((c) => kernel.checkDay(index, [...stopsOf(index), c], stopsOf, c.id).ok);
      if (!next) break;
      state[index] = [...stopsOf(index), next];
    }
  }
}

/** A night that would break a move over the limit into two legs inside it: a proposed place to sleep the stays do not use first, else a town on this trip's own board. */
function nightOnTheWay(kernel: PlannerKernel, index: number, state: PlanState): { where: string; out: number; on: number; proposedBed: boolean } | null {
  const day = kernel.days[index]!;
  const input = kernel.input;
  const from = day.previousBaseId;
  if (!from || !day.relocation) return null;
  const limit = input.maxDailyTravelMinutes;
  const basesByName = new Set(input.bases.map((b) => b.name.toLowerCase()));
  const fits = (out: number | null, on: number | null) => out !== null && on !== null && out <= limit && on <= limit && out >= 45 && on >= 45 && out + on <= day.transferMinutes + 45;
  const beds = (input.otherBases ?? [])
    .flatMap((b) => {
      const out = input.minutes(from, b.id);
      const on = input.minutes(b.id, day.baseId);
      return fits(out, on) && !basesByName.has(b.name.toLowerCase()) ? [{ where: b.name, out: out!, on: on!, proposedBed: true }] : [];
    })
    .sort((a, b) => Math.max(a.out, a.on) - Math.max(b.out, b.on) || a.where.localeCompare(b.where));
  if (beds[0]) return beds[0];
  const places = [...kernel.plannable, ...state.flat()];
  /* A locality half the board shares names a region, not somewhere to stay the night. */
  const sharedBy = new Map<string, number>();
  for (const c of input.candidates) if (c.locality) sharedBy.set(c.locality.trim().toLowerCase(), (sharedBy.get(c.locality.trim().toLowerCase()) ?? 0) + 1);
  const isTown = (where: string) => where.toLowerCase() !== input.destinationName.trim().toLowerCase() && (sharedBy.get(where.toLowerCase()) ?? 0) <= Math.max(3, Math.floor(input.candidates.length / 5));
  return (
    places
      .flatMap((c) => {
        const out = input.minutes(from, c.id);
        const on = input.minutes(c.id, day.baseId);
        const where = (c.locality || c.name).trim();
        if (!where || basesByName.has(where.toLowerCase()) || !isTown(where) || !fits(out, on)) return [];
        return [{ where, out: out!, on: on!, proposedBed: false }];
      })
      .sort((a, b) => Math.max(a.out, a.on) - Math.max(b.out, b.on) || a.where.localeCompare(b.where))[0] ?? null
  );
}

/** How many of the stops planned from tonight's base would be out of reach from last night's, were the move dropped. */
function outOfReachIfStaying(kernel: PlannerKernel, index: number, state: PlanState): number {
  const day = kernel.days[index]!;
  const from = day.previousBaseId;
  if (!from) return 0;
  const limit = kernel.input.maxDailyTravelMinutes;
  return state.flatMap((stops, i) => (kernel.days[i]!.baseId === day.baseId ? stops : [])).filter((c) => (kernel.input.minutes(from, c.id) ?? 0) > Math.max(45, limit / 2)).length;
}

/**
 * A MOVE OVER THE LIMIT, AND WHAT COULD BE DONE ABOUT IT.
 *
 * One concrete alternative, the most useful that is actually there: a night on
 * the way, named after a place on this trip's own board; a faster mode, named as
 * unmeasured because nothing here consulted a timetable; or the price of
 * dropping the move, counted from this plan.
 */
function moveAlternative(kernel: PlannerKernel, index: number, state: PlanState): string {
  const day = kernel.days[index]!;
  const input = kernel.input;
  const from = day.previousBaseId;
  if (!from || !day.relocation) return '';
  const onTheWay = nightOnTheWay(kernel, index, state);
  if (onTheWay) return ` A night around ${onTheWay.where} would break it into about ${clock(onTheWay.out)} and ${clock(onTheWay.on)}, each inside your limit.`;
  const fromBase = input.bases.find((b) => b.id === from);
  const toBase = input.bases.find((b) => b.id === day.baseId);
  const km = fromBase && toBase ? haversineKm({ id: fromBase.id, ...fromBase.coordinates }, { id: toBase.id, ...toBase.coordinates }) : 0;
  if (km >= 200) return ` ${input.carAvailable ? 'A train or a flight' : 'A flight'} between them may be quicker; Sidequest has not timed one, so check before you book.`;
  const out = outOfReachIfStaying(kernel, index, state);
  const name = fromBase?.name ?? 'the last base';
  return out > 0 ? ` Staying on in ${name} would save the move, but ${out} of the planned stops would then be out of reach.` : ` Staying on in ${name} would save the move and keep today's stops within reach.`;
}

export interface TravelLimitDay {
  dayNumber: number;
  travelMinutes: number;
  cause: 'transfer' | 'traveller_pick' | 'stops';
}

export interface TravelLimitChoice {
  dayNumber: number;
  kind: 'accept_long_day' | 'add_night' | 'stay_on' | 'drop_stop' | 'faster_mode';
  label: string;
  detail: string;
  subject?: string;
  travelMinutes?: number;
}

export interface TravelLimitRecord {
  version: 1;
  limitMinutes: number;
  hard: boolean;
  daysOver: number;
  days: TravelLimitDay[];
  choices: TravelLimitChoice[];
}

/**
 * 2026-11 — EVERY DAY OVER THE TRAVELLER'S DAILY LIMIT, COUNTED, AND — WHERE
 * THE LIMIT IS THEIR OWN — WHAT THEY CAN CHOOSE INSTEAD.
 *
 * By the time this runs the planner has already looked for a compliant
 * structure: the stays prefer a sequence with no move over a hard limit
 * (`stay-objective.ts`), and the day validator adds no detour to a move a hard
 * limit cannot afford. What is left over is one of three things, and the record
 * says which: the move itself (or the arrival or departure leg) is longer than
 * the limit; a place the traveller picked takes the day over; or, under
 * Sidequest's default limit only, its own stops do. Under a hard limit each day
 * carries explicit choices — accept the long day, add a night on the way
 * (named, from the proposed beds or the trip's own board), stay on and skip the
 * move (with what that costs), a faster mode (unmeasured, said so), or drop the
 * pick that takes the day over — which the feasibility report turns into a
 * decision the traveller owns. Pure: the planner's own figures, no provider.
 */
export function travelLimitRecord(kernel: PlannerKernel, state: PlanState): TravelLimitRecord {
  const limit = kernel.input.maxDailyTravelMinutes;
  const hard = kernel.input.travelLimitHard === true;
  const nameOf = new Map(kernel.input.bases.map((b) => [b.id, b.name] as const));
  const days: TravelLimitDay[] = [];
  const choices: TravelLimitChoice[] = [];
  state.forEach((stops, index) => {
    const day = kernel.days[index]!;
    /* A trail stage's day is judged on the party's walking limits, not the travel limit (`trail-stages.ts`). */
    if (stops.some((s) => s.trailStage)) return;
    const load = loadOf(kernel, index, stops);
    const total = load.travel + day.transferMinutes;
    if (total <= limit) return;
    const picks = stops.filter((s) => s.status === 'must');
    const cause: TravelLimitDay['cause'] = day.transferMinutes > limit ? 'transfer' : picks.length > 0 ? 'traveller_pick' : 'stops';
    days.push({ dayNumber: day.dayNumber, travelMinutes: Math.round(total), cause });
    if (!hard) return;
    const n = day.dayNumber;
    choices.push({ dayNumber: n, kind: 'accept_long_day', label: `Accept about ${clock(total)} of travel on day ${n}`, detail: `Keep day ${n} as planned: about ${clock(total)} of travel, ${clock(total - limit)} past your ${clock(limit)} a day.`, travelMinutes: Math.round(total) });
    if (cause === 'transfer' && day.relocation && day.previousBaseId) {
      const night = nightOnTheWay(kernel, index, state);
      if (night) choices.push({ dayNumber: n, kind: 'add_night', label: `Add a night in ${night.where}`, detail: `Break the move to ${nameOf.get(day.baseId) ?? 'the next base'} with a night in ${night.where}: about ${clock(night.out)} then ${clock(night.on)}, each inside your limit. It takes a night from another stay.`, subject: night.where, travelMinutes: Math.round(Math.max(night.out, night.on)) });
      const from = kernel.input.bases.find((b) => b.id === day.previousBaseId);
      const to = kernel.input.bases.find((b) => b.id === day.baseId);
      const lost = outOfReachIfStaying(kernel, index, state);
      if (from) choices.push({ dayNumber: n, kind: 'stay_on', label: `Stay on in ${from.name} and skip the move`, detail: lost > 0 ? `No move on day ${n}; ${lost} of the stops planned from ${to?.name ?? 'the next base'} would then be out of reach.` : `No move on day ${n}; the stops planned after it stay within reach.`, subject: from.name });
      const km = from && to ? haversineKm({ id: from.id, ...from.coordinates }, { id: to.id, ...to.coordinates }) : 0;
      if (km >= 200) choices.push({ dayNumber: n, kind: 'faster_mode', label: kernel.input.carAvailable ? 'Take a train or a flight for the move' : 'Take a flight for the move', detail: 'Possibly quicker; Sidequest has not timed one, so check before you book.' });
    } else if (cause === 'traveller_pick') {
      for (const pick of picks) {
        const without = stops.filter((s) => s !== pick);
        const travel = loadOf(kernel, index, without).travel + day.transferMinutes;
        if (travel >= total) continue;
        choices.push({ dayNumber: n, kind: 'drop_stop', label: `Drop ${pick.name} from day ${n}`, detail: `Without it day ${n} has about ${clock(travel)} of travel${travel <= limit ? ', inside your limit' : ''}.`, subject: pick.name, travelMinutes: Math.round(travel) });
      }
    }
  });
  return { version: 1, limitMinutes: limit, hard, daysOver: days.length, days, choices };
}

/** A day nothing could fill, said on the day. An empty day is never left to explain itself. */
function openDayNote(kernel: PlannerKernel, index: number, state: PlanState): string | null {
  const day = kernel.days[index]!;
  if (day.isFirst || day.isLast || (state[index] ?? []).length > 0 || day.capacityMinutes < 60) return null;
  const input = kernel.input;
  const name = input.bases.find((b) => b.id === day.baseId)?.name ?? 'where you are staying';
  if (day.relocation) return day.transferMinutes > input.maxDailyTravelMinutes ? null : `The move to ${name} is the day: nothing left on your list sits on the way, inside your ${clock(input.maxDailyTravelMinutes)} of travel.`;
  const taken = new Set(state.flat().map((s) => s.id));
  const nearest = kernel.plannable
    .flatMap((c) => {
      const minutes = input.minutes(day.baseId, c.id);
      return !taken.has(c.id) && minutes !== null ? [{ name: c.name, minutes }] : [];
    })
    .sort((a, b) => a.minutes - b.minutes || a.name.localeCompare(b.name))[0];
  return nearest
    ? `This day is free: nothing left on your list is within reach of ${name} under your ${clock(input.maxDailyTravelMinutes)} of travel. The nearest is ${nearest.name}, about ${clock(nearest.minutes)} each way; add it from the board and it goes here, or sleep nearer it if you want it.`
    : `This day is free: everything on your list is already in the plan. Add a place from the board and it goes here.`;
}

/** What is still wrong with each day, in words. Called on the plan the traveller gets. */
export function describeDays(kernel: PlannerKernel, state: PlanState): DayNote[] {
  const notes: DayNote[] = [];
  const limit = kernel.input.maxDailyTravelMinutes;
  const nameOf = new Map(kernel.input.bases.map((b) => [b.id, b.name] as const));
  const includesOn = (stops: readonly PlannerCandidate[]) => stops.filter((s) => s.status === 'must').map((s) => s.name);
  const hard = (index: number) => (state[index] ?? []).some((s) => s.intensity === 'strenuous');
  state.forEach((stops, index) => {
    const day = kernel.days[index]!;
    const load = loadOf(kernel, index, stops);
    const yours = includesOn(stops);
    const because = yours.length > 0 ? ` ${yours.join(' and ')} ${yours.length === 1 ? 'is' : 'are'} on your list, so ${yours.length === 1 ? 'it stays' : 'they stay'}.` : '';
    const total = load.travel + day.transferMinutes;
    if (day.transferMinutes > limit) {
      const where = day.relocation ? `The move to ${nameOf.get(day.baseId) ?? 'the next base'}` : 'Getting between the airport or station and where you sleep';
      notes.push({ dayNumber: day.dayNumber, code: 'transfer_over_limit', note: `${where} is about ${clock(day.transferMinutes)}, past your ${clock(limit)} a day: a travel day.${moveAlternative(kernel, index, state)}` });
    } else if (total > limit) {
      notes.push({ dayNumber: day.dayNumber, code: 'travel_over_limit', note: `About ${clock(total)} of travel today, over the ${clock(limit)} a day you set.${because}` });
    }
    if (load.overflow > 0) notes.push({ dayNumber: day.dayNumber, code: 'day_overfull', note: `This day has about ${clock(load.overflow)} less time than its plan needs.${because} Expect to cut a visit short.` });
    else if (load.heavyEdge) notes.push({ dayNumber: day.dayNumber, code: 'edge_day_heavy', note: `A full plan for ${day.isFirst ? 'an arrival' : 'a departure'} day.${because} Leave yourself room if ${day.isFirst ? 'you land late' : 'your departure is early'}.` });
    const open = openDayNote(kernel, index, state);
    if (open) notes.push({ dayNumber: day.dayNumber, code: 'open_day', note: open });
    if (index > 0 && hard(index) && hard(index - 1)) notes.push({ dayNumber: day.dayNumber, code: 'hard_days_together', note: 'A second strenuous day in a row; you asked for a fast pace, and the legs may disagree.' });
  });
  return notes;
}
