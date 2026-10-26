import type { Interest } from '@sidequest/core';
import type { PlanState, PlannerCandidate, PlannerKernel } from './structure-planner';

/**
 * THE PLANNER'S IMPROVEMENT PHASE — ITERATED LOCAL SEARCH OVER ONE STATED OBJECTIVE.
 *
 * Sidequest's build is a Tourist Trip Design Problem, and the standard model
 * for it is the Team Orienteering Problem with Time Windows: every place has a
 * value and a visit length, each day is a route with a time budget, and the
 * aim is the most value the days can hold. Greedy construction
 * (`structure-planner.ts`, steps 1–3b) places candidates once, in priority
 * order, each on the best day *at that moment*, and nothing ever moves again —
 * so a high-fit day trip is lost because nearby stops already spread over
 * every day, a first strenuous hike blocks the days either side of it, and the
 * first stop placed decides a day's district. This file is the step that was
 * missing: an iterated local search in the spirit of Vansteenwegen, Souffriau,
 * Vanden Berghe & Van Oudheusden (2009, "Iterated local search for the team
 * orienteering problem with time windows"), the method built for a mobile
 * tourist guide that must answer in well under a second.
 *
 * Construction stays the seed (it is a good one, and it is where the
 * explanations come from); the search only keeps a change that makes the
 * whole trip score strictly better, and every change passes the same day
 * validator construction uses (`PlannerKernel.checkDay`), so the improved
 * plan is always one construction could in principle have built.
 *
 * ---------------------------------------------------------------------------------------------
 * THE OBJECTIVE (lexicographic — a higher tier is never traded for a lower one)
 * ---------------------------------------------------------------------------------------------
 *
 *   Z = ( mustsPlaced,                         tier 1a — the traveller's own includes on the trip
 *         pinnedHeld,                          tier 1b — their locked stops on the locked day
 *         score )                              tier 2
 *
 *   score =  Σ value(c, k)                     experience, with diminishing returns
 *          − α · travelMinutes                 daytime loops + evening and sunrise round trips
 *          − β · zoneSwitches                  each extra district/locality a day opens
 *          − α · Σ weatherPenalty(c, day)      the forecast, in the planner's minute-scale units
 *          − γ · imbalance                     Σ over days with capacity (load − mean load)²
 *          − δ · overpack                      Σ max(0, load − (fill target + 0.15))²
 *          − ζ · overflowMinutes               minutes past a day's capacity — only a lone
 *                                              traveller include is ever allowed to overflow a
 *                                              day, and the search should not choose that day
 *          − ε · emptyOrdinaryDays             a day between arrival and departure left empty
 *
 *   value(c, k) = (fit + max(0, significance − 0.5)·50) · (1.15 unless a plain candidate) · ρ^(k−1)
 *
 * where k is c's rank by value among the scheduled stops sharing its primary
 * interest (or, with none, its kind): the first museum is worth its full
 * value, the second 75 % of it, the third 56 %. The hard frequency caps stay
 * hard — a cap of zero is still "avoid", and the search never takes an
 * interest further past its cap than construction did — and ρ adds the
 * diminishing return *below* the cap that a count alone cannot express.
 * `load` is (visit + loop minutes) ÷ the day's capacity.
 *
 * The weights are calibrated so one fit point is about seven minutes of
 * driving (α = 0.15), a district switch costs about half a fit point's worth
 * of a typical stop (β = 4), and the forecast's own thresholds (240 for an
 * outdoor stop in rain) stay meaningful without ever making a wet day's
 * outdoor stop worth less than nothing. Weather is a cost, never a deletion:
 * when every day is wet the stop stays and gets its backup.
 *
 * ---------------------------------------------------------------------------------------------
 * THE MOVES (cheapest first; best improvement within each; restart from the top after any)
 * ---------------------------------------------------------------------------------------------
 *
 *  1. insert   — an unplaced candidate, ranked by value² ÷ added minutes (the
 *                Vansteenwegen ratio), into the day that takes it.
 *  2. relocate — one stop to another day.
 *  3. swap     — two stops on different days trade places (strenuous spacing,
 *                district seeding).
 *  4. replace  — a lower-value stop gives its place to a higher-value unplaced one.
 *  5. make room — an ejection chain of depth one for a valuable place no day
 *                takes: clear an ordinary day for a day trip, move one
 *                strenuous outing off the neighbouring days, or move one stop
 *                off a full day — then re-place what moved where it fits best.
 *  6. intra-day order is exact for up to seven daytime stops (`tourMinutes`)
 *                and 2-opt + Or-opt above that.
 *
 * and between local searches the deterministic **shake**: from every day,
 * remove R consecutive removable stops starting at position S; when that does
 * not lead to a better trip, S advances by R and R grows (wrapping at the
 * longest day); when it does, R resets to one.
 *
 * Never moved, never removed: a locked stop (it is only ever on its day). Never
 * removed: a traveller include — the shake leaves them, and a move may only
 * carry one to another day. Bounded by iteration counts, never by a clock, so
 * the same board gives the same trip on a laptop and on a loaded container:
 * every loop runs in a fixed order over ids and day indices, and there is no
 * randomness anywhere.
 */

/** One fit point ≈ seven minutes of driving. */
export const OBJECTIVE_WEIGHTS = {
  /** Points per travel minute (and per minute-scale weather penalty unit). */
  alpha: 0.15,
  /** Points per extra district a day opens. */
  beta: 4,
  /** Points per unit of squared load deviation across the days (an arrival afternoon is used in proportion, not abandoned to even out the middle). */
  gamma: 20,
  /** Points per unit of squared load above the comfortable share of a day. */
  delta: 40,
  /**
   * Points per minute a day is asked to hold beyond its capacity. Only a lone
   * traveller include may overflow a day (it is exempt from reach and the
   * travel ceiling so it is never silently lost), and a full point a minute is
   * what stops the search parking one on a departure morning to free a day
   * for three of Sidequest's picks.
   */
  zeta: 1,
  /** Points per ordinary day left empty. */
  epsilon: 40,
  /** Diminishing return for each repeat of the same interest or kind. */
  rho: 0.75,
  /** A pick, include or maybe counts for this much more than a plain candidate of the same fit. */
  chosenLift: 1.15,
} as const;

export interface StructureObjective {
  mustsPlaced: number;
  pinnedHeld: number;
  score: number;
  /** The parts of `score`, for the bench and for anyone asking why one plan beat another. */
  parts: {
    value: number;
    travelMinutes: number;
    zoneSwitches: number;
    weatherPenalty: number;
    imbalance: number;
    overpack: number;
    overflowMinutes: number;
    emptyDays: number;
  };
  stops: number;
}

export interface ImproveOptions {
  /** Iterated-local-search rounds (shake + local search). */
  maxIterations?: number;
  /** Stop after this many rounds without a better trip. */
  maxNoImprove?: number;
}

const DEFAULT_OPTIONS: Required<ImproveOptions> = { maxIterations: 30, maxNoImprove: 4 };
/** A local search applies at most this many moves before it stops — a guard, never reached in practice. */
const LOCAL_SEARCH_GUARD = 400;
/** How many of the most valuable unplaced candidates the make-room move tries per pass. */
const MAKE_ROOM_CANDIDATES = 6;
const EPSILON = 1e-9;

const kindKey = (c: PlannerCandidate): string => (c.primaryInterest ? `i:${c.primaryInterest}` : `k:${c.category}`);

export function experienceValue(kernel: PlannerKernel, c: PlannerCandidate): number {
  return kernel.experienceValue(c) * (c.status === 'candidate' ? 1 : OBJECTIVE_WEIGHTS.chosenLift);
}

/** What one day contributes to the objective — cached per row, since a move changes one or two days and the rest are the same arrays. */
interface RowFacts {
  index: number;
  travelMinutes: number;
  zoneSwitches: number;
  weather: number;
  mustsPlaced: number;
  pinnedHeld: number;
  stops: number;
  empty: boolean;
  load: number | null;
  overpack: number;
  overflowMinutes: number;
  kinds: [string, number][];
  strenuous: boolean;
}

/*
 * Two levels: by row array (the untouched days of a neighbour are the same
 * arrays), then by the kernel's memoised metrics object, which is shared by
 * every row holding the same set of stops on the same base — so a set probed
 * again from a different move costs one lookup.
 */
const rowFactsCache = new WeakMap<PlannerKernel, WeakMap<readonly PlannerCandidate[], RowFacts>>();
const setFactsCache = new WeakMap<object, Map<number, RowFacts>>();

function rowFacts(kernel: PlannerKernel, index: number, row: readonly PlannerCandidate[]): RowFacts {
  let cache = rowFactsCache.get(kernel);
  if (!cache) {
    cache = new WeakMap();
    rowFactsCache.set(kernel, cache);
  }
  const hit = cache.get(row);
  if (hit && hit.index === index) return hit;
  const day = kernel.days[index]!;
  const metrics = kernel.dayMetrics(index, row);
  let bySet = setFactsCache.get(metrics);
  if (!bySet) {
    bySet = new Map();
    setFactsCache.set(metrics, bySet);
  }
  const shared = bySet.get(index);
  if (shared) {
    cache.set(row, shared);
    return shared;
  }
  const zones = new Set<string>();
  let weather = 0;
  let mustsPlaced = 0;
  let pinnedHeld = 0;
  const kinds: [string, number][] = [];
  for (const s of row) {
    if (s.status === 'must') mustsPlaced += 1;
    if (s.pinnedDay === day.dayNumber) pinnedHeld += 1;
    zones.add(s.zone ?? s.locality);
    weather += kernel.weatherPenalty(s, day.weather);
    kinds.push([kindKey(s), experienceValue(kernel, s)]);
  }
  const used = metrics.activityMinutes + metrics.tourMinutes;
  const load = day.capacityMinutes > 0 ? used / day.capacityMinutes : null;
  const facts: RowFacts = {
    index,
    travelMinutes: metrics.tourMinutes + metrics.eveningMinutes + metrics.sunriseMinutes,
    zoneSwitches: Math.max(0, zones.size - 1),
    weather,
    mustsPlaced,
    pinnedHeld,
    stops: row.length,
    empty: row.length === 0 && !day.isFirst && !day.isLast,
    load,
    overpack: load === null ? 0 : Math.max(0, load - (kernel.fillTarget + 0.15)) ** 2,
    overflowMinutes: Math.max(0, used - day.capacityMinutes),
    kinds,
    strenuous: row.some((s) => s.intensity === 'strenuous'),
  };
  cache.set(row, facts);
  bySet.set(index, facts);
  return facts;
}

export function evaluateObjective(kernel: PlannerKernel, state: PlanState): StructureObjective {
  const W = OBJECTIVE_WEIGHTS;
  let mustsPlaced = 0;
  let pinnedHeld = 0;
  let stops = 0;
  let travelMinutes = 0;
  let zoneSwitches = 0;
  let weather = 0;
  let overpack = 0;
  let overflowMinutes = 0;
  let emptyDays = 0;
  const loads: number[] = [];
  const byKind = new Map<string, number[]>();
  state.forEach((row, index) => {
    const f = rowFacts(kernel, index, row);
    mustsPlaced += f.mustsPlaced;
    pinnedHeld += f.pinnedHeld;
    stops += f.stops;
    travelMinutes += f.travelMinutes;
    zoneSwitches += f.zoneSwitches;
    weather += f.weather;
    overpack += f.overpack;
    overflowMinutes += f.overflowMinutes;
    if (f.empty) emptyDays += 1;
    if (f.load !== null) loads.push(f.load);
    for (const [key, v] of f.kinds) {
      const list = byKind.get(key);
      if (list) list.push(v);
      else byKind.set(key, [v]);
    }
  });
  let value = 0;
  for (const list of byKind.values()) {
    list.sort((a, b) => b - a);
    value += contributionOfSorted(list);
  }
  const mean = loads.length > 0 ? loads.reduce((a, b) => a + b, 0) / loads.length : 0;
  const imbalance = loads.reduce((n, l) => n + (l - mean) ** 2, 0);
  const score = value - W.alpha * travelMinutes - W.beta * zoneSwitches - W.alpha * weather - W.gamma * imbalance - W.delta * overpack - W.zeta * overflowMinutes - W.epsilon * emptyDays;
  return { mustsPlaced, pinnedHeld, score, parts: { value, travelMinutes, zoneSwitches, weatherPenalty: weather, imbalance, overpack, overflowMinutes, emptyDays }, stops };
}

/**
 * The objective of a neighbour that differs from `state` in a few rows,
 * without re-adding the untouched days: the additive terms move by the changed
 * rows' difference, the diminishing-returns value is recomputed only for the
 * interests or kinds those rows touch, and the load spread from running sums.
 * Equal to `evaluateObjective` on the neighbour (up to floating-point noise
 * far below the comparison tolerance); the search re-scores an accepted
 * neighbour in full, so no error can accumulate.
 */
function neighbourEvaluator(kernel: PlannerKernel, state: PlanState): (rows: ReadonlyMap<number, readonly PlannerCandidate[]>, sameSet?: boolean) => StructureObjective {
  const W = OBJECTIVE_WEIGHTS;
  const facts = state.map((row, i) => rowFacts(kernel, i, row));
  let musts = 0;
  let pinned = 0;
  let stopCount = 0;
  let travel = 0;
  let zones = 0;
  let weather = 0;
  let overpack = 0;
  let overflow = 0;
  let empty = 0;
  let loadSum = 0;
  let loadSq = 0;
  let loadN = 0;
  const byKind = new Map<string, number[]>();
  for (const f of facts) {
    musts += f.mustsPlaced;
    pinned += f.pinnedHeld;
    stopCount += f.stops;
    travel += f.travelMinutes;
    zones += f.zoneSwitches;
    weather += f.weather;
    overpack += f.overpack;
    overflow += f.overflowMinutes;
    empty += f.empty ? 1 : 0;
    if (f.load !== null) {
      loadSum += f.load;
      loadSq += f.load * f.load;
      loadN += 1;
    }
    for (const [key, v] of f.kinds) {
      const list = byKind.get(key);
      if (list) list.push(v);
      else byKind.set(key, [v]);
    }
  }
  for (const list of byKind.values()) list.sort((x, y) => y - x);
  const kindValue = new Map([...byKind].map(([key, list]) => [key, contributionOfSorted(list)]));
  let baseValue = 0;
  for (const v of kindValue.values()) baseValue += v;
  return (rows, sameSet = false) => {
    let dMusts = 0;
    let dPinned = 0;
    let dStops = 0;
    let dTravel = 0;
    let dZones = 0;
    let dWeather = 0;
    let dOverpack = 0;
    let dOverflow = 0;
    let dEmpty = 0;
    let sum = loadSum;
    let sq = loadSq;
    const touched = new Map<string, number[]>();
    for (const [i, row] of rows) {
      const before = facts[i]!;
      const after = rowFacts(kernel, i, row);
      dMusts += after.mustsPlaced - before.mustsPlaced;
      dPinned += after.pinnedHeld - before.pinnedHeld;
      dStops += after.stops - before.stops;
      dTravel += after.travelMinutes - before.travelMinutes;
      dZones += after.zoneSwitches - before.zoneSwitches;
      dWeather += after.weather - before.weather;
      dOverpack += after.overpack - before.overpack;
      dOverflow += after.overflowMinutes - before.overflowMinutes;
      dEmpty += (after.empty ? 1 : 0) - (before.empty ? 1 : 0);
      if (before.load !== null && after.load !== null) {
        sum += after.load - before.load;
        sq += after.load * after.load - before.load * before.load;
      }
      /* A relocation or swap moves stops between days without changing which are on the trip: the value term cannot change. */
      if (sameSet) continue;
      for (const [key, v] of before.kinds) {
        let list = touched.get(key);
        if (!list) touched.set(key, (list = [...(byKind.get(key) ?? [])]));
        const at = list.indexOf(v);
        if (at >= 0) list.splice(at, 1);
      }
      for (const [key, v] of after.kinds) {
        let list = touched.get(key);
        if (!list) touched.set(key, (list = [...(byKind.get(key) ?? [])]));
        let at = 0;
        while (at < list.length && list[at]! >= v) at += 1;
        list.splice(at, 0, v);
      }
    }
    let value = baseValue;
    for (const [key, list] of touched) value += contributionOfSorted(list) - (kindValue.get(key) ?? 0);
    const t = { travel: travel + dTravel, zones: zones + dZones, weather: weather + dWeather, overpack: overpack + dOverpack, overflow: overflow + dOverflow, empty: empty + dEmpty };
    const imbalance = loadN > 0 ? Math.max(0, sq - (sum * sum) / loadN) : 0;
    const score = value - W.alpha * t.travel - W.beta * t.zones - W.alpha * t.weather - W.gamma * imbalance - W.delta * t.overpack - W.zeta * t.overflow - W.epsilon * t.empty;
    return { mustsPlaced: musts + dMusts, pinnedHeld: pinned + dPinned, score, parts: { value, travelMinutes: t.travel, zoneSwitches: t.zones, weatherPenalty: t.weather, imbalance, overpack: t.overpack, overflowMinutes: t.overflow, emptyDays: t.empty }, stops: stopCount + dStops };
  };
}

const RHO_POWERS = Array.from({ length: 128 }, (_, k) => OBJECTIVE_WEIGHTS.rho ** k);
/** Σ v_k · ρ^k over a list already sorted from most to least valuable. */
function contributionOfSorted(list: readonly number[]): number {
  let total = 0;
  for (let k = 0; k < list.length; k += 1) total += list[k]! * (RHO_POWERS[k] ?? OBJECTIVE_WEIGHTS.rho ** k);
  return total;
}

/** Positive when `a` is the better trip. */
export function compareObjective(a: StructureObjective, b: StructureObjective): number {
  if (a.mustsPlaced !== b.mustsPlaced) return a.mustsPlaced - b.mustsPlaced;
  if (a.pinnedHeld !== b.pinnedHeld) return a.pinnedHeld - b.pinnedHeld;
  /*
   * Tier 1c — overflow is never traded for score. Only a lone traveller include
   * may overflow a day, so that it is never silently lost; the search used that
   * exemption to park a hand-picked stop on the departure morning (where
   * verification then trims it as running past the departure) and spend the
   * freed day on Sidequest's own picks. Less overflow always wins.
   */
  const overflow = b.parts.overflowMinutes - a.parts.overflowMinutes;
  if (Math.abs(overflow) > EPSILON) return overflow;
  const d = a.score - b.score;
  return Math.abs(d) <= EPSILON ? 0 : d;
}

export function improveStructure(kernel: PlannerKernel, seed: PlanState, options: ImproveOptions = {}): PlanState {
  const { maxIterations, maxNoImprove } = { ...DEFAULT_OPTIONS, ...options };
  const { input, days } = kernel;
  const plannableById = new Map(kernel.plannable.map((c) => [c.id, c]));
  /* Fixed iteration order everywhere: by value, then id. */
  const pool = [...kernel.plannable].sort((a, b) => experienceValue(kernel, b) - experienceValue(kernel, a) || a.id.localeCompare(b.id));
  const seedCounts = interestCounts(seed);
  /** How many of an interest the trip may hold: the traveller's cap, or what construction already settled on if it went past it to fill a day. */
  const interestLimit = (interest: Interest): number | undefined => {
    const cap = input.frequencyCaps[interest];
    if (cap === undefined) return undefined;
    return cap === 0 ? 0 : Math.max(cap, seedCounts.get(interest) ?? 0);
  };

  /*
   * A place below the filler floor is construction's answer to a day that
   * would otherwise be empty, nothing more. The search may use as many of them
   * as construction did, plus one for each ordinary day construction could not
   * fill at all — so it can never empty a day of good stops to make room for a
   * weak one.
   */
  const weak = (c: PlannerCandidate) => c.status === 'candidate' && c.fit < kernel.fillerMinFit;
  const weakAllowance = seed.flat().filter(weak).length + seed.filter((row, i) => row.length === 0 && !days[i]!.isFirst && !days[i]!.isLast).length;

  function interestCounts(state: PlanState): Map<Interest, number> {
    const counts = new Map<Interest, number>();
    for (const row of state) for (const s of row) if (s.primaryInterest) counts.set(s.primaryInterest, (counts.get(s.primaryInterest) ?? 0) + 1);
    return counts;
  }

  /** The interest counts and weak-filler count of a state, computed once per neighbourhood scan rather than per probe. */
  interface Tally {
    interests: Map<Interest, number>;
    weak: number;
  }
  function tally(state: PlanState): Tally {
    return { interests: interestCounts(state), weak: state.reduce((n, row) => n + row.filter(weak).length, 0) };
  }

  /**
   * May `c` stand on day `index`, given the tally of the state without it?
   * The per-stop rules with nothing else on the day (lock, closure, reach,
   * slots — a necessary condition, so nothing valid is ever skipped),
   * frequency for a new arrival and the weak-filler allowance; everything
   * that depends on the rest of the day is the day validator's.
   */
  function admissible(c: PlannerCandidate, counts: Tally, index: number, arriving: boolean): boolean {
    if (!kernel.standsAlone(c, index)) return false;
    if (c.status !== 'must' && c.primaryInterest) {
      const limit = interestLimit(c.primaryInterest);
      if (limit === 0) return false;
      if (arriving && limit !== undefined && (counts.interests.get(c.primaryInterest) ?? 0) + 1 > limit) return false;
    }
    if (arriving && weak(c) && counts.weak + 1 > weakAllowance) return false;
    return true;
  }

  const withRows = (state: PlanState, rows: ReadonlyMap<number, PlannerCandidate[]>): PlanState => state.map((row, i) => rows.get(i) ?? row);

  /** The changed days pass the validator, and so do the days either side when strenuous spacing applies. */
  function valid(state: PlanState, changed: readonly number[], focus?: ReadonlyMap<number, string>): boolean {
    const toCheck = new Set<number>();
    for (const i of changed) {
      toCheck.add(i);
      /* Strenuous spacing is the one rule that reads the neighbouring days, and only below a fast pace. */
      if (input.pace !== 'fast') {
        if (i > 0) toCheck.add(i - 1);
        if (i < days.length - 1) toCheck.add(i + 1);
      }
    }
    const stopsOf = (j: number) => state[j] ?? [];
    for (const i of [...toCheck].sort((a, b) => a - b)) {
      if (!dayOk(state, i, stopsOf, focus?.get(i))) return false;
    }
    return true;
  }

  /*
   * Whether a day passes depends only on its own row and — through strenuous
   * spacing — on whether the days either side hold a strenuous stop. The focus
   * changes which refusal is reported, never whether there is one, so the
   * answer is cached on the row and those two flags.
   */
  const okCache = new WeakMap<readonly PlannerCandidate[], Map<string, boolean>>();
  function dayOk(state: PlanState, i: number, stopsOf: (j: number) => readonly PlannerCandidate[], focus?: string): boolean {
    const row = state[i]!;
    const flag = (j: number) => (j >= 0 && j < state.length && rowFacts(kernel, j, state[j]!).strenuous ? '1' : '0');
    const key = `${i}:${flag(i - 1)}${flag(i + 1)}`;
    let entry = okCache.get(row);
    if (!entry) {
      entry = new Map();
      okCache.set(row, entry);
    }
    const hit = entry.get(key);
    if (hit !== undefined) return hit;
    const ok = kernel.checkDay(i, row, stopsOf, focus).ok;
    entry.set(key, ok);
    return ok;
  }

  const scheduledIds = (state: PlanState) => new Set(state.flatMap((row) => row.map((s) => s.id)));
  const movable = (s: PlannerCandidate) => s.pinnedDay === undefined;
  const travelOf = (index: number, row: readonly PlannerCandidate[]) => {
    const m = kernel.dayMetrics(index, row);
    return m.tourMinutes + m.eveningMinutes + m.sunriseMinutes;
  };

  type Step = { state: PlanState; z: StructureObjective };
  type Evaluator = (rows: ReadonlyMap<number, readonly PlannerCandidate[]>, sameSet?: boolean) => StructureObjective;

  /*
   * Every neighbourhood below scores a neighbour first and asks the validator
   * only about one that would be an improvement: scoring a row is cached and
   * cheap, and almost every neighbour is rejected on score, so the validator
   * runs on the few that matter. Within a neighbourhood the first improving
   * neighbour in the fixed scan order is taken (first improvement), and the
   * local search then restarts from the cheapest neighbourhood.
   */
  function improving(score: Evaluator, state: PlanState, z: StructureObjective, rows: ReadonlyMap<number, PlannerCandidate[]>, focus?: ReadonlyMap<number, string>, sameSet = false): Step | null {
    const nz = score(rows, sameSet);
    if (compareObjective(nz, z) <= 0) return null;
    const next = withRows(state, rows);
    return valid(next, [...rows.keys()], focus) ? { state: next, z: evaluateObjective(kernel, next) } : null;
  }

  // --- 1. insert -------------------------------------------------------------------------
  /*
   * Ranked once by the Vansteenwegen ratio, then taken in that order against
   * the state as it grows: each option is re-checked (still unplaced, still
   * admissible, still improving, still valid) before it is applied, so one
   * pass can re-fill several days after a shake without rescanning the
   * whole neighbourhood per insertion.
   */
  function insert(state: PlanState, z: StructureObjective): Step | null {
    const taken = scheduledIds(state);
    const counts = tally(state);
    const options: { c: PlannerCandidate; index: number; ratio: number }[] = [];
    for (const c of pool) {
      if (taken.has(c.id)) continue;
      const v = experienceValue(kernel, c);
      days.forEach((_, index) => {
        if (!admissible(c, counts, index, true)) return;
        const row = [...state[index]!, c];
        const added = (kernel.slotOf(c) === 'day' ? c.durationMinutes : 0) + Math.max(0, travelOf(index, row) - travelOf(index, state[index]!));
        options.push({ c, index, ratio: (v * v) / Math.max(1, added) + (c.status === 'must' ? 1e9 : 0) });
      });
    }
    options.sort((a, b) => b.ratio - a.ratio || a.c.id.localeCompare(b.c.id) || a.index - b.index);
    let cur: Step | null = null;
    let score = neighbourEvaluator(kernel, state);
    let placed = taken;
    let now = counts;
    for (const option of options) {
      const at = cur ?? { state, z };
      if (placed.has(option.c.id) || (cur && !admissible(option.c, now, option.index, true))) continue;
      const step = improving(score, at.state, at.z, new Map([[option.index, [...at.state[option.index]!, option.c]]]), new Map([[option.index, option.c.id]]));
      if (!step) continue;
      cur = step;
      score = neighbourEvaluator(kernel, cur.state);
      placed = scheduledIds(cur.state);
      now = tally(cur.state);
    }
    return cur;
  }

  // --- 2. relocate ------------------------------------------------------------------------
  function relocate(state: PlanState, z: StructureObjective): Step | null {
    const counts = tally(state);
    const score = neighbourEvaluator(kernel, state);
    for (let i = 0; i < days.length; i += 1) {
      const row = state[i]!;
      for (const s of row) {
        if (!movable(s)) continue;
        const without = row.filter((x) => x !== s);
        for (let j = 0; j < days.length; j += 1) {
          if (j === i || !admissible(s, counts, j, false)) continue;
          const step = improving(score, state, z, new Map([[i, without], [j, [...state[j]!, s]]]), new Map([[j, s.id]]), true);
          if (step) return step;
        }
      }
    }
    return null;
  }

  // --- 3. swap ----------------------------------------------------------------------------
  function swap(state: PlanState, z: StructureObjective): Step | null {
    const counts = tally(state);
    const score = neighbourEvaluator(kernel, state);
    for (let i = 0; i < days.length; i += 1) {
      for (let j = i + 1; j < days.length; j += 1) {
        for (const s of state[i]!) {
          if (!movable(s) || !admissible(s, counts, j, false)) continue;
          for (const t of state[j]!) {
            if (!movable(t) || !admissible(t, counts, i, false)) continue;
            const rowI = [...state[i]!.filter((x) => x !== s), t];
            const rowJ = [...state[j]!.filter((x) => x !== t), s];
            const step = improving(score, state, z, new Map([[i, rowI], [j, rowJ]]), undefined, true);
            if (step) return step;
          }
        }
      }
    }
    return null;
  }

  // --- 4. replace -------------------------------------------------------------------------
  function replace(state: PlanState, z: StructureObjective): Step | null {
    const taken = scheduledIds(state);
    const out = pool.filter((c) => !taken.has(c.id));
    const score = neighbourEvaluator(kernel, state);
    for (let i = 0; i < days.length; i += 1) {
      const row = state[i]!;
      for (const s of row) {
        if (!movable(s) || s.status === 'must') continue;
        const without = row.filter((x) => x !== s);
        const counts = tally(withRows(state, new Map([[i, without]])));
        for (const c of out) {
          if (!admissible(c, counts, i, true)) continue;
          const step = improving(score, state, z, new Map([[i, [...without, c]]]), new Map([[i, c.id]]));
          if (step) return step;
        }
      }
    }
    return null;
  }

  /** Re-place stops a move displaced, each on the day that scores best; a non-include with nowhere to go stays out. Null when an include cannot be re-placed. */
  function replaceDisplaced(state: PlanState, displaced: readonly PlannerCandidate[]): PlanState | null {
    let cur = state;
    const order = [...displaced].sort((a, b) => Number(b.status === 'must') - Number(a.status === 'must') || experienceValue(kernel, b) - experienceValue(kernel, a) || a.id.localeCompare(b.id));
    for (const s of order) {
      let best: { state: PlanState; z: StructureObjective } | null = null;
      const counts = tally(cur);
      const score = neighbourEvaluator(kernel, cur);
      for (let j = 0; j < days.length; j += 1) {
        if (!admissible(s, counts, j, false)) continue;
        const rows = new Map([[j, [...cur[j]!, s]]]);
        const nz = score(rows);
        if (best && compareObjective(nz, best.z) <= 0) continue;
        const next = withRows(cur, rows);
        if (!valid(next, [j], new Map([[j, s.id]]))) continue;
        best = { state: next, z: nz };
      }
      if (best) cur = best.state;
      else if (s.status === 'must') return null;
    }
    return cur;
  }

  // --- 5. make room (ejection chain, depth one) ----------------------------------------------
  function makeRoom(state: PlanState, z: StructureObjective): Step | null {
    const taken = scheduledIds(state);
    const targets = pool.filter((c) => !taken.has(c.id)).slice(0, MAKE_ROOM_CANDIDATES);
    for (const c of targets) {
      for (let d = 0; d < days.length; d += 1) {
        const day = days[d]!;
        const ordinary = !day.isFirst && !day.isLast;
        const ejections: { from: number; stop: PlannerCandidate }[][] = [];
        if (c.dayTrip && kernel.slotOf(c) === 'day') {
          /* A day trip needs a day of its own: move everything movable off one ordinary day. */
          if (!ordinary || day.relocation || state[d]!.length === 0 || !state[d]!.every(movable)) continue;
          ejections.push(state[d]!.map((stop) => ({ from: d, stop })));
        } else if (c.intensity === 'strenuous' && c.status !== 'must') {
          if (!ordinary) continue;
          for (const from of [d - 1, d, d + 1]) {
            if (from < 0 || from >= days.length) continue;
            for (const stop of state[from]!) if (stop.intensity === 'strenuous' && movable(stop)) ejections.push([{ from, stop }]);
          }
        } else {
          for (const stop of state[d]!) if (movable(stop)) ejections.push([{ from: d, stop }]);
        }
        for (const ejection of ejections) {
          const rows = new Map<number, PlannerCandidate[]>();
          for (const { from, stop } of ejection) rows.set(from, (rows.get(from) ?? state[from]!).filter((x) => x !== stop));
          const cleared = withRows(state, rows);
          if (!admissible(c, tally(cleared), d, true)) continue;
          const placed = withRows(cleared, new Map([[d, [...cleared[d]!, c]]]));
          if (!valid(placed, [...new Set([...rows.keys(), d])], new Map([[d, c.id]]))) continue;
          const settled = replaceDisplaced(placed, ejection.map((e) => e.stop));
          if (!settled) continue;
          const nz = evaluateObjective(kernel, settled);
          if (compareObjective(nz, z) > 0) return { state: settled, z: nz };
        }
      }
    }
    return null;
  }

  function localSearch(start: PlanState): Step {
    let cur: Step = { state: start, z: evaluateObjective(kernel, start) };
    for (let guard = 0; guard < LOCAL_SEARCH_GUARD; guard += 1) {
      const next = insert(cur.state, cur.z) ?? relocate(cur.state, cur.z) ?? swap(cur.state, cur.z) ?? replace(cur.state, cur.z) ?? makeRoom(cur.state, cur.z);
      if (!next) break;
      cur = next;
    }
    return cur;
  }

  /** Remove R consecutive removable stops from every day, starting at position S; a day the removal would leave invalid is left as it was. */
  function shake(state: PlanState, S: number, R: number): PlanState {
    let cur = state;
    state.forEach((row, i) => {
      const metrics = kernel.dayMetrics(i, row);
      const byId = new Map(row.map((s) => [s.id, s]));
      const ordered = [...metrics.order.map((id) => byId.get(id)!), ...row.filter((s) => kernel.slotOf(s) !== 'day').sort((a, b) => a.id.localeCompare(b.id))];
      const removable = ordered.filter((s) => movable(s) && s.status !== 'must');
      if (removable.length === 0) return;
      const start = S % removable.length;
      const gone = new Set(removable.slice(start, start + R).map((s) => s.id));
      const next = withRows(cur, new Map([[i, row.filter((s) => !gone.has(s.id))]]));
      if (valid(next, [i])) cur = next;
    });
    return cur;
  }

  let best = localSearch(seed.map((row) => [...row]));
  const seedZ = evaluateObjective(kernel, seed);
  if (compareObjective(best.z, seedZ) < 0) best = { state: seed, z: seedZ };
  const longest = () => Math.max(1, ...best.state.map((row) => row.filter((s) => movable(s) && s.status !== 'must').length));
  let S = 0;
  let R = 1;
  let quiet = 0;
  for (let iteration = 0; iteration < maxIterations && quiet < maxNoImprove; iteration += 1) {
    const candidate = localSearch(shake(best.state, S, R));
    if (compareObjective(candidate.z, best.z) > 0) {
      best = candidate;
      R = 1;
      quiet = 0;
    } else {
      quiet += 1;
      S += R;
      R = R + 1 > longest() ? 1 : R + 1;
    }
  }
  /* Ids only from the pool: every stop is the caller's own candidate object. */
  return best.state.map((row) => row.map((s) => plannableById.get(s.id) ?? s));
}
