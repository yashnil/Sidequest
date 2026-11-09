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

export type DayNoteCode = 'transfer_over_limit' | 'travel_over_limit' | 'day_overfull' | 'edge_day_heavy' | 'hard_days_together';

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
  return { state, repairs };
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
      notes.push({ dayNumber: day.dayNumber, code: 'transfer_over_limit', note: `${where} is about ${clock(day.transferMinutes)}, past your ${clock(limit)} a day: a travel day.` });
    } else if (total > limit) {
      notes.push({ dayNumber: day.dayNumber, code: 'travel_over_limit', note: `About ${clock(total)} of travel today, over the ${clock(limit)} a day you set.${because}` });
    }
    if (load.overflow > 0) notes.push({ dayNumber: day.dayNumber, code: 'day_overfull', note: `This day has about ${clock(load.overflow)} less time than its plan needs.${because} Expect to cut a visit short.` });
    else if (load.heavyEdge) notes.push({ dayNumber: day.dayNumber, code: 'edge_day_heavy', note: `A full plan for ${day.isFirst ? 'an arrival' : 'a departure'} day.${because} Leave yourself room if ${day.isFirst ? 'you land late' : 'your departure is early'}.` });
    if (index > 0 && hard(index) && hard(index - 1)) notes.push({ dayNumber: day.dayNumber, code: 'hard_days_together', note: 'A second strenuous day in a row; you asked for a fast pace, and the legs may disagree.' });
  });
  return notes;
}
