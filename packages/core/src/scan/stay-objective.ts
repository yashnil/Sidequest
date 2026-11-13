/**
 * RELEASE CANDIDATE — WHERE TO SLEEP, AS ONE OBJECTIVE.
 *
 * How many places to sleep, which ones, in what order and for how many nights
 * was decided by a ladder of thresholds: a cap on bases by trip length, half a
 * day of things "nearer" a base, sixty minutes as the edge of a day trip, two
 * far places before a move, two nights a stay on a trip of four nights or more.
 * Each was written after a real trip went wrong (a compact island with three
 * hotels, a move for one water park), and each is a rule about a shape rather
 * than a measurement of a trip: the same board gave a couple who like to move
 * and a family with two small children the same hotels, and a three-day trip
 * could spend six of its hours changing cities for one night.
 *
 * This file replaces the ladder with a cost, in minutes of the traveller's own
 * time, and chooses the structure that minimises it:
 *
 *   cost(structure) =  day travel                 the loops out from where you sleep to what you see
 *                    + transfers                  between the stays, and from/to where you arrive and leave
 *                    + Σ over moves (overhead + inconvenience)
 *                    + value of what is left unseen
 *                    + half of any day nothing within reach can fill
 *
 * Two things come before any cost is compared, because they are the traveller's
 * own words rather than Sidequest's arithmetic: the parts of the destination
 * they named, and the must-dos they named, kept within reach by as many as the
 * hotel-change cap allows.
 *
 * - **Day travel** is read off the matrix the scan measured (or estimated): for
 *   a structure, each place is seen from the stay whose base is nearest, the
 *   days at each stay are filled by cheapest insertion under the same limits
 *   the planner enforces (stops a day, the day's usable minutes, the traveller's
 *   daily travel ceiling, how far a stop may sit from where you sleep), and the
 *   loops are summed. It is a plan sketch, not the plan: it exists so two
 *   structures are compared on what they would cost, not on how they look.
 * - **A move** costs its transfer (already above), a clock *overhead* — packing,
 *   checking out, finding the next place, checking in — that grows with small
 *   children, reduced mobility, no car (bags on public transport) and a slow
 *   pace, and an *inconvenience* in minutes-equivalent that is the traveller's
 *   own answer about changing hotels: nothing for somebody happy to move with
 *   the route, an hour and a half for somebody who moves when it saves time,
 *   more for somebody who would move once at most. The moving day also loses
 *   the transfer and the overhead from its usable minutes, so "the lost part of
 *   a day" shows up as what could no longer be seen.
 * - **What is left unseen** is charged at its value — tier-weighted visit
 *   minutes, a minute of a place worth seeing being worth a minute of getting
 *   there — so a structure cannot look cheap by reaching less. A place beyond
 *   the traveller's daily travel from every stay is unseen from that structure,
 *   which is how a low daily limit legitimately earns another base.
 *
 * A route-shaped trip (a ring road, a road trip, "A to B") adds its proposed
 * bases as parts to cover: each is covered by any stay within the planner's
 * reach of it, so a ring road is slept along rather than priced as a list of
 * places a single town can leave unseen (a live Iceland trip, 2026-11, chose
 * eight nights in one town). A leg longer than the traveller's day weighs
 * double there, and the decision says which stretch the nights or the cap
 * could not follow.
 *
 * The traveller's stated cap is hard (`maxBaseChanges`): "one base" is never
 * overridden, and the record says what it cost. A stay has a minimum sensible
 * length from the trip's length and the traveller. A structure with more moves
 * must beat the best one with fewer by a margin, wider when the minutes are
 * estimates, so the answer does not flip on noise.
 *
 * Nothing here knows what an island is, or any place's name: a compact island
 * keeps one base because the transfers cost more than the loops they would
 * save, and stops keeping one when the traveller, the mode or the distances
 * change the arithmetic. Unknown ≠ far: an unmeasured leg is timed with an
 * allowance on the clock and never puts a place out of reach.
 *
 * Pure: no clock, no provider, no model.
 */

import type { MoveTolerance, StayDecision, StayOption } from '../schemas/stay';
import type { RouteShapeKind } from '../destinations/route-shape';


/** Who is travelling, as far as changing hotels and reaching things is concerned. */
export interface StayTraveller {
  moveTolerance: MoveTolerance;
  pace: 'slow' | 'balanced' | 'fast';
  /** The traveller's ceiling on travel in a day, in the trip's mode. */
  maxDailyTravelMinutes: number;
  /** Daytime stops a day holds at this pace. */
  stopsPerDay: number;
  children: number;
  youngChildren: boolean;
  reducedMobility: boolean;
  carAvailable: boolean;
}

export const DEFAULT_STAY_TRAVELLER: StayTraveller = {
  moveTolerance: 'move_if_it_saves_time',
  pace: 'balanced',
  maxDailyTravelMinutes: 180,
  stopsPerDay: 3,
  children: 0,
  youngChildren: false,
  reducedMobility: false,
  carAvailable: true,
};

export interface StayPlaceInput {
  id: string;
  /** Minutes a visit takes. */
  durationMinutes: number;
  /** 0–1: how much a minute here is worth against a minute of travel. A classic is 1. */
  weight: number;
  /** A whole-day outing to another town: may have an ordinary day to itself beyond the usual reach. The planner's own rule. */
  soloDayTrip?: boolean;
  /** The traveller named this. A structure that keeps more of these within reach is preferred before any cost is compared. */
  mustSee?: boolean;
}

export interface StayEdges {
  fromArrival: (baseId: string) => number | null;
  toDeparture: (baseId: string) => number | null;
}

export interface StayObjectiveInput {
  /** Proposed places to sleep, in the proposal's own order (its only orientation evidence when no gateway is known). */
  bases: readonly { id: string; name: string; nightsHint?: number }[];
  places: readonly StayPlaceInput[];
  /** Door-to-door minutes in the trip's mode; null when unknown. */
  minutes: (fromId: string, toId: string) => number | null;
  nights: number;
  /** The traveller's hard cap on hotel changes. */
  maxBaseChanges: number;
  traveller: StayTraveller;
  /** Usable minutes of each calendar day, first to last (nights + 1 entries). Absent: an ordinary day, with a shorter first and last. */
  dayMinutes?: readonly number[];
  edges?: StayEdges;
  /** Orders a set of stays; the assembler passes its arrival- and departure-aware ordering. Default: the proposal's order. */
  order?: (ids: readonly string[]) => { order: string[]; splitStay: boolean };
  /** Whether the minutes were measured by a router. Estimates widen the margin a move must win by. */
  basis?: 'measured' | 'estimated';
  /**
   * Parts of the destination the traveller named themselves ("Tokyo and
   * Kyoto"), each with the proposed bases that sleep in or beside it. A
   * structure that sleeps in more of them is preferred before any cost is
   * compared: what somebody asked for by name outranks what Sidequest infers
   * about their time. A part no proposed base covers constrains nothing.
   */
  mustCover?: readonly MustCoverPart[];
  /**
   * The trip is a route (`destinations/route-shape.ts`). Changes only what the
   * record says: which route parts the choice sleeps along and which it could
   * not, in the decision and its sentence. The parts themselves arrive as
   * `mustCover` entries with an `anchorId`.
   */
  route?: RouteShapeKind;
  /**
   * 2026-11 — trail stages that join two proposed beds: a point-to-point walk
   * that starts near `fromBaseId` and ends at `toBaseId`. Moving between those
   * two beds on foot, with bags sent ahead, is the day's experience rather than
   * a transfer: it costs no transfer minutes, only the walking time the day
   * spends. Without this a stage-based trek was costed as a car trip from one
   * base and lost to it every time.
   */
  trailLinks?: readonly TrailLink[];
  /**
   * 2026-11 (point-to-point trekking) — a trail the trip is for, as the beds
   * its stages join, in walking order (`trail-stages.ts#trailBedChain`). When
   * given, the stays follow it — one bed per stage end, every move that day's
   * walk — rather than the cheapest structure by the minutes, because a walk
   * from inn to inn is what was asked for, and a single base with day hikes by
   * road is a different trip. A traveller who asked to stay put keeps one base.
   * `restBaseIds` are beds with a hot spring at hand, where a spare night is a
   * rest day before anywhere else.
   */
  trail?: { chain: readonly string[]; restBaseIds?: readonly string[] };
}

export interface TrailLink {
  fromBaseId: string;
  toBaseId: string;
  /** The stage's walking time, from its distance and ascent. */
  walkMinutes: number;
  placeId: string;
}

/**
 * A part of the destination a structure should sleep in or beside. Covered when
 * a stay is one of `baseIds`, or — for a part with an `anchorId`, such as a
 * proposed base along a route — when a stay is within the planner's own reach
 * of the anchor, so two bases an hour apart do not both have to be slept in.
 */
export interface MustCoverPart {
  name: string;
  baseIds: readonly string[];
  anchorId?: string;
}


export interface StayChoice {
  stays: { baseId: string; nights: number }[];
  splitStay: boolean;
  /** For each place, the stay base it would be seen from. */
  homeBase: Map<string, string>;
  /** Proposed bases not slept at, with the reason in numbers. */
  leftOut: { baseId: string; reason: string }[];
  decision: StayDecision;
}

/* ---------------------------------------------------------------------------------------------
 * The numbers the model stands on
 * ------------------------------------------------------------------------------------------- */

/** An ordinary day's usable minutes when the caller gives none (09:00 to 18:00). */
const ORDINARY_DAY_MINUTES = 540;
const LUNCH_MINUTES = 60;
/** Slack a day keeps, by pace. The planner's own figures. */
const BUFFER_BY_PACE = { slow: 90, balanced: 45, fast: 20 } as const;
/** The longest hop between two stops that still reads as one day's outing. The planner's own figure. */
const COHERENT_HOP_MINUTES = 50;
/** Unknown travel time is never zero: the planner's own allowance. */
const UNKNOWN_LEG_MINUTES = 60;
/** After a long transfer there is still a short loop near the new base. */
const AFTER_TRANSFER_LOOP_MINUTES = 45;
/** Packing, checking out, finding the next place, checking in. */
const MOVE_OVERHEAD_MINUTES = 60;
/** What a move must save beyond its clock cost before this traveller thinks it worth it. */
const INCONVENIENCE_BY_TOLERANCE: Record<MoveTolerance, number> = { move_freely: 0, move_if_it_saves_time: 90, move_once: 150, stay_put: 150 };
/** A structure with more moves must win by this much; more when the minutes are estimates. */
const MARGIN_MINUTES = { measured: 30, estimated: 60 } as const;
/** Above this many night splits the split is climbed to rather than enumerated. */
const EXHAUSTIVE_SPLITS = 400;
/** Two structures within this many minutes cost the same as far as the sketch can tell. */
const TIE_MINUTES = 15;
/** …or within this share of the cost, whichever is more: a greedy sketch is not finer than that. */
const TIE_SHARE = 0.08;
/** Each further place seen in the same area is worth this much of the one before it. */
const AREA_RETURN = 0.9;
/** The share of a day each pace wants filled. The planner's own figures. */
const FILL_TARGET = { slow: 0.55, balanced: 0.7, fast: 0.85 } as const;
/** What a minute of a day nothing within reach can fill costs, against a minute of travel. */
const IDLE_WEIGHT = 0.5;
/** Under this much room a day holds no stop, so leaving it empty is no failing. The planner's own figure. */
const MIN_DAY_WORTH_FILLING = 60;
/** On a route-shaped trip, the part of a transfer beyond the traveller's daily ceiling counts this many times over (once on any other trip). */
const ROUTE_OVER_LIMIT_WEIGHT = 2;
/** Most stays a structure may have, whatever the cap: the proposal holds at most six bases. */
const MAX_STAYS = 5;

/** Carrying bags to and from stations on a car-free move. */
const CAR_FREE_MOVE_OVERHEAD = 30;

export function moveCostFor(traveller: StayTraveller): StayDecision['moveCost'] {
  const factors: string[] = [];
  let overhead = MOVE_OVERHEAD_MINUTES;
  if (!traveller.carAvailable) {
    overhead += CAR_FREE_MOVE_OVERHEAD;
    factors.push('no car: bags to and from stations');
  }
  if (traveller.youngChildren) {
    overhead += 30;
    factors.push('young children');
  } else if (traveller.children > 0) {
    overhead += 15;
    factors.push('children');
  }
  if (traveller.reducedMobility) {
    overhead += 30;
    factors.push('reduced mobility');
  }
  if (traveller.pace === 'slow') {
    overhead += 15;
    factors.push('a slow pace');
  }
  const scale = 1 + (traveller.youngChildren ? 0.5 : 0) + (traveller.reducedMobility ? 0.5 : 0);
  return { overheadMinutes: overhead, inconvenienceMinutes: Math.round(INCONVENIENCE_BY_TOLERANCE[traveller.moveTolerance] * scale), tolerance: traveller.moveTolerance, factors };
}

/**
 * The fewest nights a stay is worth. One on a short trip, where the only
 * alternative to a one-night stay is no second stay at all, and for somebody
 * happy to move with the route who is not slowed by children, mobility or
 * pace; otherwise two, so nobody unpacks for a single evening.
 */
export function minNightsPerStay(traveller: StayTraveller, nights: number): number {
  if (nights < 4) return 1;
  if (traveller.moveTolerance === 'move_freely' && !traveller.youngChildren && !traveller.reducedMobility && traveller.pace !== 'slow') return 1;
  return 2;
}

/* ---------------------------------------------------------------------------------------------
 * Evaluating one structure
 * ------------------------------------------------------------------------------------------- */

interface Evaluation {
  option: Omit<StayOption, 'stays'> & { stays: { baseId: string; nights: number }[] };
  home: Map<string, string>;
  /** Named parts of the destination this structure sleeps in. */
  covered: string[];
}

interface Model {
  input: StayObjectiveInput;
  nights: number;
  days: number;
  usable: number[];
  move: StayDecision['moveCost'];
  reach: number;
  dayTripReach: number;
  limit: number;
  leg: (a: string, b: string) => number;
  value: Map<string, number>;
  area: Map<string, string>;
  everything: number;
  hint: Map<string, number>;
}

function modelFor(input: StayObjectiveInput): Model {
  const nights = Math.max(0, Math.round(input.nights));
  const days = nights + 1;
  const usable = Array.from({ length: days }, (_, d) => {
    const given = input.dayMinutes?.[d];
    if (typeof given === 'number' && Number.isFinite(given)) return Math.max(0, given);
    if (days === 1) return ORDINARY_DAY_MINUTES;
    return d === 0 ? Math.round(ORDINARY_DAY_MINUTES * 0.4) : d === days - 1 ? Math.round(ORDINARY_DAY_MINUTES * 0.35) : ORDINARY_DAY_MINUTES;
  });
  const limit = Math.max(30, input.traveller.maxDailyTravelMinutes);
  const value = new Map(input.places.map((p) => [p.id, Math.max(0, p.weight) * Math.max(0, p.durationMinutes)] as const));
  /* An area is the catchment of a proposed base: the proposal's own grouping of the destination, the same for every structure. */
  const area = new Map<string, string>();
  for (const place of input.places) {
    let best: { id: string; m: number } | null = null;
    for (const base of input.bases) {
      const m = input.minutes(base.id, place.id);
      if (m !== null && (!best || m < best.m)) best = { id: base.id, m };
    }
    area.set(place.id, best?.id ?? '');
  }
  /* The value of seeing everything, best first in each area. */
  let everything = 0;
  for (const id of new Set(area.values())) {
    const values = input.places.filter((p) => area.get(p.id) === id).map((p) => value.get(p.id) ?? 0).sort((a, b) => b - a);
    values.forEach((v, rank) => {
      everything += v * AREA_RETURN ** rank;
    });
  }
  return {
    input,
    nights,
    days,
    usable,
    move: moveCostFor(input.traveller),
    /* The planner's own reach rule: a stop sits within half the daily ceiling of where you sleep. */
    reach: Math.max(45, Math.floor(limit / 2)),
    dayTripReach: Math.floor(limit * 0.6),
    limit,
    leg: (a, b) => (a === b ? 0 : input.minutes(a, b) ?? UNKNOWN_LEG_MINUTES),
    value,
    area,
    everything,
    hint: new Map(input.bases.map((b) => [b.id, Math.max(0, b.nightsHint ?? 0)] as const)),
  };
}

/** Whether a set of stays sleeps in or (for an anchored part) within a day's reach of a part. Unknown ≠ far: an untimed anchor is never out of reach. */
function partCovered(model: Model, part: MustCoverPart, baseIds: readonly string[]): boolean {
  if (part.baseIds.some((id) => baseIds.includes(id))) return true;
  if (!part.anchorId) return false;
  return baseIds.some((id) => id === part.anchorId || (model.input.minutes(id, part.anchorId!) ?? 0) <= model.reach);
}

/** The loop base → stops → base with `id` inserted where it adds least. */
function cheapestInsertion(model: Model, baseId: string, order: readonly string[], id: string): { order: string[]; added: number } {
  let best: { at: number; added: number } | null = null;
  for (let at = 0; at <= order.length; at += 1) {
    const before = at === 0 ? baseId : order[at - 1]!;
    const after = at === order.length ? baseId : order[at]!;
    const added = model.leg(before, id) + model.leg(id, after) - (order.length === 0 ? 0 : model.leg(before, after));
    if (!best || added < best.added) best = { at, added };
  }
  const at = best!.at;
  return { order: [...order.slice(0, at), id, ...order.slice(at)], added: best!.added };
}

function evaluate(model: Model, stays: readonly { baseId: string; nights: number }[]): Evaluation {
  const { input, days } = model;
  const stayOfDay: number[] = [];
  stays.forEach((stay, index) => {
    for (let n = 0; n < stay.nights; n += 1) stayOfDay.push(index);
  });
  while (stayOfDay.length < days) stayOfDay.push(stays.length - 1);
  stayOfDay.length = days;

  // --- transfers and what each day has left ---------------------------------------------
  const arrival = input.edges?.fromArrival(stays[0]!.baseId) ?? 0;
  const departure = days > 1 ? input.edges?.toDeparture(stays[stays.length - 1]!.baseId) ?? 0 : 0;
  let transferMinutes = arrival + departure;
  let overLimitTransfer = 0;
  const buffer = BUFFER_BY_PACE[input.traveller.pace];
  const dayTransfer = new Array<number>(days).fill(0);
  let moves = 0;
  /* The trail stages this structure walks as its moves. */
  const walkedMoves = new Set<string>();
  for (let d = 1; d < days; d += 1) {
    const from = stays[stayOfDay[d - 1]!]!.baseId;
    const to = stays[stayOfDay[d]!]!.baseId;
    if (stayOfDay[d] === stayOfDay[d - 1] || from === to) continue;
    moves += 1;
    /* A trail stage that ends at the next bed is the move: walked, bags sent ahead, no transfer to pay. */
    const stage = input.trailLinks?.find((link) => link.fromBaseId === from && link.toBaseId === to);
    if (stage) {
      dayTransfer[d] = stage.walkMinutes;
      walkedMoves.add(stage.placeId);
      continue;
    }
    const transfer = model.leg(from, to);
    transferMinutes += transfer;
    overLimitTransfer += Math.max(0, transfer - model.limit);
    dayTransfer[d] = transfer + model.move.overheadMinutes;
  }
  dayTransfer[0] = dayTransfer[0]! + arrival;
  dayTransfer[days - 1] = dayTransfer[days - 1]! + departure;
  const capacity = model.usable.map((minutes, d) => {
    const edge = days > 1 && (d === 0 || d === days - 1);
    return Math.max(0, minutes - (minutes >= 300 ? LUNCH_MINUTES : 0) - buffer - dayTransfer[d]! - (edge ? 30 : 0));
  });
  const travelLeft = dayTransfer.map((transfer) => Math.max(model.limit - transfer, transfer > 0 ? AFTER_TRANSFER_LOOP_MINUTES : model.limit));

  // --- each place is seen from the nearest stay ----------------------------------------------
  const baseIds = [...new Set(stays.map((s) => s.baseId))];
  const home = new Map<string, string>();
  const assigned = new Map<string, StayPlaceInput[]>(baseIds.map((id) => [id, []]));
  for (const place of input.places) {
    let best: { id: string; m: number } | null = null;
    for (const id of baseIds) {
      const m = input.minutes(id, place.id);
      if (m === null) continue;
      if (!best || m < best.m) best = { id, m };
    }
    const id = best?.id ?? baseIds[0]!;
    home.set(place.id, id);
    assigned.get(id)!.push(place);
  }

  // --- fill each stay's days by cheapest insertion, best net gain first -------------------------
  let dayTravel = 0;
  let seenValue = 0;
  let placesSeen = 0;
  const used = new Array<number>(days).fill(0);
  const seenInArea = new Map<string, number>();
  /* What the next place in an area is worth: the tenth thing in one area is worth less than the first in a new one. */
  const worth = (place: StayPlaceInput) => (model.value.get(place.id) ?? 0) * AREA_RETURN ** (seenInArea.get(model.area.get(place.id) ?? '') ?? 0);
  for (const baseId of baseIds) {
    const pool = [...assigned.get(baseId)!];
    const dayIndexes = stayOfDay.map((s, d) => ({ s, d })).filter(({ s }) => stays[s]!.baseId === baseId).map(({ d }) => d).sort((a, b) => capacity[b]! - capacity[a]! || a - b);
    for (const d of dayIndexes) {
      if (pool.length === 0) break;
      let order: string[] = [];
      let travel = 0;
      let activity = 0;
      let closed = false;
      const ordinary = dayTransfer[d] === 0 && !(days > 1 && (d === 0 || d === days - 1));
      for (;;) {
        if (closed || order.length >= Math.max(1, input.traveller.stopsPerDay)) break;
        let pick: { index: number; order: string[]; added: number; gain: number } | null = null;
        for (let i = 0; i < pool.length; i += 1) {
          const place = pool[i]!;
          const fromBase = input.minutes(baseId, place.id);
          /* Only a figure somebody produced can call a place far. */
          const far = fromBase !== null && fromBase > model.reach;
          if (far && !(place.soloDayTrip && order.length === 0 && ordinary && fromBase! <= model.dayTripReach)) continue;
          if (order.length > 0 && !order.some((other) => (input.minutes(other, place.id) ?? 0) <= COHERENT_HOP_MINUTES || (input.minutes(place.id, other) ?? 0) <= COHERENT_HOP_MINUTES)) continue;
          const inserted = cheapestInsertion(model, baseId, order, place.id);
          if (travel + inserted.added > travelLeft[d]!) continue;
          if (activity + place.durationMinutes + travel + inserted.added > capacity[d]!) continue;
          /* Ranks what goes next; never refuses a place. The planner visits anything within the day's limits, and the sketch must cost what the planner would do. */
          const gain = worth(place) - inserted.added;
          if (!pick || gain > pick.gain || (gain === pick.gain && place.id < pool[pick.index]!.id)) pick = { index: i, order: inserted.order, added: inserted.added, gain };
        }
        if (!pick) break;
        const place = pool[pick.index]!;
        if ((input.minutes(baseId, place.id) ?? 0) > model.reach) closed = true;
        order = pick.order;
        travel += pick.added;
        activity += place.durationMinutes;
        seenValue += worth(place);
        const area = model.area.get(place.id) ?? '';
        seenInArea.set(area, (seenInArea.get(area) ?? 0) + 1);
        placesSeen += 1;
        pool.splice(pick.index, 1);
      }
      dayTravel += travel;
      used[d] = activity + travel;
    }
  }
  /*
   * A day the structure cannot fill is part of what it costs: the reason people
   * change hotels is that they have run out of things within reach. Counted
   * below the share of a day this pace wants filled, at half weight — a slow
   * afternoon is worth something, just less than a place worth seeing.
   */
  let idle = 0;
  for (let d = 0; d < days; d += 1) {
    if (capacity[d]! < MIN_DAY_WORTH_FILLING) continue;
    idle += Math.max(0, FILL_TARGET[input.traveller.pace] * capacity[d]! - used[d]!);
  }
  const unseen = Math.max(0, model.everything - seenValue);
  /*
   * A walked move forwards the bags: no carrying them to and from stations, so
   * the car-free part of the move overhead does not apply to it. And a stage
   * this structure does NOT walk as a move is a one-way walk from a bed that is
   * not at its end — the way back from where it ends is real travel, which a
   * single base used to get for free as if the stage were a loop.
   */
  const overhead = moves * model.move.overheadMinutes - (input.traveller.carAvailable ? 0 : walkedMoves.size * CAR_FREE_MOVE_OVERHEAD);
  for (const link of input.trailLinks ?? []) {
    if (walkedMoves.has(link.placeId)) continue;
    if (!stays.some((stay) => stay.baseId === link.fromBaseId)) continue;
    dayTravel += model.leg(link.toBaseId, link.fromBaseId);
  }
  const inconvenience = moves * model.move.inconvenienceMinutes;
  /* On a route the road is driven in day-sized legs: a leg longer than the traveller's own day is what a stay between would prevent, so it weighs double. */
  const total = dayTravel + transferMinutes + (input.route ? ROUTE_OVER_LIMIT_WEIGHT : 1) * overLimitTransfer + overhead + inconvenience + IDLE_WEIGHT * idle + unseen;
  /* Unknown ≠ far: a must-see nobody has timed from any stay still counts as within reach. */
  const reachable = (place: StayPlaceInput) => baseIds.some((id) => (input.minutes(id, place.id) ?? 0) <= (place.soloDayTrip ? model.dayTripReach : model.reach));
  const covered = [...(input.mustCover ?? []).filter((part) => partCovered(model, part, baseIds)).map((part) => part.name), ...input.places.filter((place) => place.mustSee && reachable(place)).map((place) => place.id)];
  return {
    home,
    covered,
    option: {
      stays: stays.map((s) => ({ ...s })),
      moves,
      dayTravelMinutes: Math.round(dayTravel),
      transferMinutes: Math.round(transferMinutes),
      moveOverheadMinutes: overhead,
      moveInconvenienceMinutes: inconvenience,
      unseenValueMinutes: Math.round(unseen),
      idleMinutes: Math.round(idle),
      placesSeen,
      overLimitTransferMinutes: Math.round(overLimitTransfer),
      totalCostMinutes: Math.round(total),
    },
  };
}

/* ---------------------------------------------------------------------------------------------
 * Searching the structures
 * ------------------------------------------------------------------------------------------- */

function subsetsUpTo<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  const walk = (start: number, picked: T[]) => {
    if (picked.length > 0) out.push(picked);
    if (picked.length === size) return;
    for (let i = start; i < items.length; i += 1) walk(i + 1, [...picked, items[i]!]);
  };
  walk(0, []);
  return out;
}

/** Every way to give `total` nights to stays with the given minimums. */
function nightSplits(total: number, minimums: readonly number[]): number[][] {
  const out: number[][] = [];
  const need = (from: number) => minimums.slice(from).reduce((n, m) => n + m, 0);
  const walk = (index: number, left: number, acc: number[]) => {
    if (index === minimums.length - 1) {
      if (left >= minimums[index]!) out.push([...acc, left]);
      return;
    }
    for (let n = minimums[index]!; n <= left - need(index + 1); n += 1) walk(index + 1, left - n, [...acc, n]);
  };
  if (minimums.length > 0 && total >= need(0)) walk(0, total, []);
  return out;
}

function countSplits(total: number, minimums: readonly number[]): number {
  const free = total - minimums.reduce((n, m) => n + m, 0);
  if (free < 0) return 0;
  let count = 1;
  for (let i = 1; i < minimums.length; i += 1) count = (count * (free + i)) / i;
  return count;
}

/**
 * Whether `a` is the better structure. Within a quarter of an hour the two cost
 * the same as far as this sketch can tell, and the proposal's own sense of
 * where the nights belong decides; it never outvotes a real difference.
 */
function better(model: Model, a: Evaluation, b: Evaluation | null): boolean {
  if (!b) return true;
  const difference = a.option.totalCostMinutes - b.option.totalCostMinutes;
  const tie = Math.max(TIE_MINUTES, TIE_SHARE * Math.min(a.option.totalCostMinutes, b.option.totalCostMinutes));
  if (difference <= -tie) return true;
  if (difference >= tie) return false;
  const agreement = (e: Evaluation) => e.option.stays.reduce((n, s) => n + Math.min(s.nights, model.hint.get(s.baseId) ?? 0), 0);
  const left = agreement(a);
  const right = agreement(b);
  return left !== right ? left > right : difference < 0;
}

/**
 * The traveller, as the base choice reads them, from the trip row and the
 * profile. One function so the scan and the evaluation cannot disagree.
 */
export function stayTravellerFor(input: {
  trip: { basics: { children: number; travelerNeeds: readonly string[] } };
  profile: { pace: StayTraveller['pace']; interview: { baseMoveTolerance: MoveTolerance }; derived: { activitySlotsPerDay: number }; accessibility: { mobilityLimited: boolean } };
  carAvailable: boolean;
  maxDailyTravelMinutes: number;
  maxDailyDriveMinutes?: number | null;
}): StayTraveller {
  const needs = input.trip.basics.travelerNeeds;
  return {
    moveTolerance: input.profile.interview.baseMoveTolerance,
    pace: input.profile.pace,
    maxDailyTravelMinutes: input.carAvailable && input.maxDailyDriveMinutes ? Math.min(input.maxDailyTravelMinutes, input.maxDailyDriveMinutes) : input.maxDailyTravelMinutes,
    stopsPerDay: Math.max(1, Math.round(input.profile.derived.activitySlotsPerDay)),
    children: input.trip.basics.children,
    youngChildren: needs.includes('kids_under_12'),
    reducedMobility: needs.includes('mobility_limited') || needs.includes('seniors_in_group') || input.profile.accessibility.mobilityLimited,
    carAvailable: input.carAvailable,
  };
}

/** Hotel changes the search may use: the traveller's stated cap, their tolerance, and the nights there are. */
export function allowedMoves(traveller: StayTraveller, maxBaseChanges: number, nights: number): number {
  const tolerated = traveller.moveTolerance === 'stay_put' ? 0 : traveller.moveTolerance === 'move_once' ? 1 : MAX_STAYS - 1;
  return Math.max(0, Math.min(maxBaseChanges, tolerated, MAX_STAYS - 1, Math.max(0, Math.round(nights) - 1)));
}

/** The best night split for one ordered set of stays, or null when the nights cannot cover the minimums. */
function bestSplit(model: Model, order: readonly string[], minimums: readonly number[]): Evaluation | null {
  const total = Math.max(model.nights, 0);
  if (order.length === 1) return evaluate(model, [{ baseId: order[0]!, nights: total }]);
  if (countSplits(total, minimums) === 0) return null;
  let best: Evaluation | null = null;
  if (countSplits(total, minimums) <= EXHAUSTIVE_SPLITS) {
    for (const split of nightSplits(total, minimums)) {
      const candidate = evaluate(model, order.map((baseId, i) => ({ baseId, nights: split[i]! })));
      if (better(model, candidate, best)) best = candidate;
    }
    return best;
  }
  /* A long trip: start even, then move one night at a time while that helps. */
  const split = [...minimums];
  let spare = total - split.reduce((n, m) => n + m, 0);
  for (let i = 0; spare > 0; i = (i + 1) % split.length) {
    split[i]! += 1;
    spare -= 1;
  }
  best = evaluate(model, order.map((baseId, i) => ({ baseId, nights: split[i]! })));
  for (let guard = 0; guard < 200; guard += 1) {
    let step: { from: number; to: number; evaluation: Evaluation } | null = null;
    for (let from = 0; from < split.length; from += 1) {
      if (split[from]! <= minimums[from]!) continue;
      for (let to = 0; to < split.length; to += 1) {
        if (to === from) continue;
        const next = [...split];
        next[from]! -= 1;
        next[to]! += 1;
        const candidate = evaluate(model, order.map((baseId, i) => ({ baseId, nights: next[i]! })));
        if (better(model, candidate, step?.evaluation ?? best)) step = { from, to, evaluation: candidate };
      }
    }
    if (!step) break;
    split[step.from]! -= 1;
    split[step.to]! += 1;
    best = step.evaluation;
  }
  return best;
}

function hours(minutes: number): string {
  const rounded = Math.max(0, Math.round(minutes / 5) * 5);
  if (rounded < 60) return `${rounded} minutes`;
  const h = Math.floor(rounded / 60);
  const m = rounded % 60;
  return m === 0 ? `${h} h` : `${h} h ${String(m).padStart(2, '0')}`;
}

function sentenceFor(input: StayObjectiveInput, model: Model, chosen: StayOption, alternatives: readonly StayOption[], capped: boolean): string {
  const single = chosen.moves === 0;
  const names = (option: StayOption) => [...new Set(option.stays.map((s) => s.baseName))];
  const moveClock = (option: StayOption) => option.transferMinutes + option.moveOverheadMinutes;
  if (input.bases.length === 1) return `One base, ${chosen.stays[0]!.baseName}: it is the only place to sleep the scan proposed.`;
  if (single) {
    const moving = alternatives.filter((a) => a.moves > 0).sort((a, b) => a.totalCostMinutes - b.totalCostMinutes)[0];
    const lead = input.traveller.moveTolerance === 'stay_put' || input.maxBaseChanges === 0 ? `One base, ${chosen.stays[0]!.baseName}, as you asked` : `One base, ${chosen.stays[0]!.baseName}`;
    if (!moving) return `${lead}: no second place to sleep fits the nights you have.`;
    const added = names(moving).filter((n) => n !== chosen.stays[0]!.baseName);
    const nightsThere = Math.max(1, moving.stays.filter((s) => added.includes(s.baseName)).reduce((n, s) => n + s.nights, 0));
    const saved = chosen.dayTravelMinutes - moving.dayTravelMinutes;
    const more = moving.placesSeen - chosen.placesSeen;
    const extraClock = moveClock(moving) - moveClock(chosen);
    const gain = saved > 0 ? `would save about ${hours(saved / nightsThere)} of travel a day over ${nightsThere} day${nightsThere === 1 ? '' : 's'}` : 'would not shorten the days';
    const reach = more > 0 ? ` and reach ${more} more place${more === 1 ? '' : 's'}` : '';
    return `${lead}: also sleeping in ${added.join(' and ') || names(moving).join(' and ')} ${gain}${reach}, but the move${moving.moves === 1 ? '' : 's'} would cost about ${hours(extraClock)} of packing up, checking in and travelling.`;
  }
  const alone = alternatives.filter((a) => a.moves === 0).sort((a, b) => a.totalCostMinutes - b.totalCostMinutes)[0];
  const lead = `${names(chosen).length} bases, ${names(chosen).join(', ')}`;
  if (!alone) return `${lead}: the moves cost about ${hours(moveClock(chosen))} in all.`;
  const extra = alone.dayTravelMinutes - chosen.dayTravelMinutes;
  const missed = chosen.placesSeen - alone.placesSeen;
  const perDay = extra / Math.max(1, model.days);
  const travel = extra > 0 ? `about ${hours(perDay)} more travel a day` : 'no less travel';
  const reach = missed > 0 ? `${extra > 0 ? ' and' : ','} ${missed} fewer of these places within reach` : '';
  return `${lead}: from ${alone.stays[0]!.baseName} alone it would be ${travel}${reach}; the ${chosen.moves} move${chosen.moves === 1 ? '' : 's'} cost about ${hours(moveClock(chosen) - moveClock(alone))} in all${capped ? ', within the hotel changes you allow' : ''}.`;
}

/**
 * The stays a followed trail sleeps in: each stage end in walking order, at
 * least a night each, a spare night first at a bed with a hot spring at hand
 * (a rest day mid-walk), the rest wherever the objective says they are worth
 * most. As many stages as the nights hold, from the start; none at all for a
 * traveller who asked to keep one base.
 */
function trailStays(model: Model, input: StayObjectiveInput): { evaluation: Evaluation; sentence: (nameOf: ReadonlyMap<string, string>) => string } | null {
  const known = new Set(input.bases.map((b) => b.id));
  const chain = (input.trail?.chain ?? []).filter((id) => known.has(id));
  if (chain.length < 2 || model.nights < 2 || input.traveller.moveTolerance === 'stay_put' || input.maxBaseChanges === 0) return null;
  const beds = chain.slice(0, Math.min(chain.length, model.nights));
  if (beds.length < 2) return null;
  const spare = model.nights - beds.length;
  const rest = new Set(input.trail?.restBaseIds ?? []);
  let restLeft = spare;
  const minimums = beds.map((id) => {
    if (restLeft > 0 && rest.has(id)) {
      restLeft -= 1;
      return 2;
    }
    return 1;
  });
  const evaluation = bestSplit(model, beds, minimums);
  if (!evaluation) return null;
  const restAt = beds.filter((id, i) => rest.has(id) && (evaluation.option.stays[i]?.nights ?? 0) >= 2);
  const shortBy = chain.length - beds.length;
  return {
    evaluation,
    sentence: (nameOf) => {
      const names = beds.map((id) => nameOf.get(id) ?? id);
      const restNames = restAt.map((id) => nameOf.get(id) ?? id);
      return `Following the trail from bed to bed: ${names.join(' → ')}. Each move is that day's walk, with the bags sent ahead${restNames.length > 0 ? `, and a rest day in ${restNames.join(' and ')}, where there is a hot spring` : ''}.${shortBy > 0 ? ` ${model.nights} nights hold ${beds.length - 1} of the ${chain.length - 1} stages; the rest are left off.` : ''}`;
    },
  };
}

/**
 * The structure that minimises the cost, with the record of why.
 *
 * Every non-empty set of proposed bases up to the cap is ordered (by the
 * caller's arrival-aware ordering when it gives one), given its best night
 * split, and costed. The cheapest structure for each number of moves is kept;
 * the answer is the one with the fewest moves unless one with more beats it by
 * the margin.
 */
export function chooseStays(input: StayObjectiveInput): StayChoice {
  if (input.bases.length === 0) throw new Error('Choosing where to sleep needs at least one proposed base.');
  const model = modelFor(input);
  const nameOf = new Map(input.bases.map((b) => [b.id, b.name] as const));
  const minStay = minNightsPerStay(input.traveller, model.nights);
  const maxMoves = allowedMoves(input.traveller, input.maxBaseChanges, model.nights);
  const basis = input.basis ?? 'estimated';
  const margin = MARGIN_MINUTES[basis];

  /* A followed trail decides the structure; the search only costs the simplest alternatives beside it, for the record. */
  const trail = trailStays(model, input);
  const costed: { evaluation: Evaluation; splitStay: boolean }[] = [];
  for (const subset of subsetsUpTo(input.bases.map((b) => b.id), Math.min(input.bases.length, trail ? Math.min(2, maxMoves + 1) : maxMoves + 1))) {
    const ordered = subset.length === 1 ? { order: subset, splitStay: false } : input.order ? input.order(subset) : { order: subset, splitStay: false };
    if (ordered.order.length - 1 > maxMoves) continue;
    /* A split stay's arrival night is deliberate: one night is its minimum whatever the trip. */
    const minimums = ordered.order.map((id, i) => (ordered.splitStay && i === 0 && ordered.order.lastIndexOf(id) !== 0 ? 1 : minStay));
    const evaluation = bestSplit(model, ordered.order, minimums);
    if (evaluation) costed.push({ evaluation, splitStay: ordered.splitStay });
  }
  /* Only one structure is guaranteed to exist: a single base, with every night. A trip with no structure at all has no base, which is refused above. */
  const mostCovered = Math.max(0, ...costed.map((c) => c.evaluation.covered.length));
  const bestByMoves = new Map<number, { evaluation: Evaluation; splitStay: boolean }>();
  for (const candidate of costed) {
    if (candidate.evaluation.covered.length < mostCovered) continue;
    const held = bestByMoves.get(candidate.evaluation.option.moves);
    if (!held || better(model, candidate.evaluation, held.evaluation)) bestByMoves.set(candidate.evaluation.option.moves, candidate);
  }
  const ladder = [...bestByMoves.entries()].sort((a, b) => a[0] - b[0]);
  let chosen = ladder[0]![1];
  for (const [, candidate] of ladder.slice(1)) {
    if (candidate.evaluation.option.totalCostMinutes + margin <= chosen.evaluation.option.totalCostMinutes) chosen = candidate;
  }
  if (trail) chosen = { evaluation: trail.evaluation, splitStay: false };

  const named = (evaluation: Evaluation): StayOption => ({ ...evaluation.option, stays: evaluation.option.stays.map((s) => ({ baseId: s.baseId, baseName: nameOf.get(s.baseId) ?? s.baseId, nights: s.nights })) });
  const chosenOption = named(chosen.evaluation);
  const alternatives = ladder.filter(([, c]) => c !== chosen).map(([, c]) => named(c.evaluation));
  /* The cheapest structure coverage ruled out, so the record says what naming those places cost. */
  const ruledOut = costed.filter((c) => c.evaluation.covered.length < mostCovered && c.evaluation.option.moves < chosen.evaluation.option.moves).sort((a, b) => a.evaluation.option.totalCostMinutes - b.evaluation.option.totalCostMinutes)[0];
  if (ruledOut) alternatives.push(named(ruledOut.evaluation));

  /* What "one base" ruled out, costed all the same, so "as you asked" can say what it cost. */
  if (maxMoves === 0 && input.bases.length > 1 && model.nights >= 2) {
    const least = Math.min(minStay, Math.max(1, Math.floor(model.nights / 2)));
    let beyond: Evaluation | null = null;
    for (const subset of subsetsUpTo(input.bases.map((b) => b.id), 2)) {
      if (subset.length !== 2) continue;
      const evaluation = bestSplit(model, subset, [least, least]);
      if (evaluation && better(model, evaluation, beyond)) beyond = evaluation;
    }
    if (beyond) alternatives.push(named(beyond));
  }

  const keptIds = new Set(chosenOption.stays.map((s) => s.baseId));
  const capped = input.maxBaseChanges === 0 || input.traveller.moveTolerance === 'stay_put';
  const leftOut = input.bases
    .filter((b) => !keptIds.has(b.id))
    .map((b) => {
      if (capped) return { baseId: b.id, reason: 'You asked to keep to one place to sleep.' };
      if (trail) return { baseId: b.id, reason: 'The trip follows the trail from one stage end to the next, and this is not one of them.' };
      const withIt = input.bases.map((x) => x.id).filter((id) => keptIds.has(id) || id === b.id);
      const ordered = input.order ? input.order(withIt) : { order: withIt, splitStay: false };
      const evaluation = ordered.order.length - 1 <= maxMoves ? bestSplit(model, ordered.order, ordered.order.map(() => minStay)) : null;
      if (!evaluation) return { baseId: b.id, reason: keptIds.size - 1 >= maxMoves ? 'It would take more hotel changes than you allow.' : 'The nights you have do not stretch to another stay worth unpacking for.' };
      const saved = chosenOption.dayTravelMinutes - evaluation.option.dayTravelMinutes;
      const cost = evaluation.option.transferMinutes + evaluation.option.moveOverheadMinutes - chosenOption.transferMinutes - chosenOption.moveOverheadMinutes;
      const more = evaluation.option.placesSeen - chosenOption.placesSeen;
      if (saved <= 0 && more <= 0) return { baseId: b.id, reason: 'Everything near it is as easy to reach from where you already stay, so moving hotels would cost time and save none.' };
      const gain = [saved > 0 ? `save about ${hours(saved)} of travel over the trip` : null, more > 0 ? `reach ${more} more place${more === 1 ? '' : 's'}` : null].filter(Boolean).join(' and ');
      return { baseId: b.id, reason: `Sleeping here too would ${gain}, but the extra move costs about ${hours(cost)} of packing up, checking in and travelling, which is not worth it for this trip.` };
    });

  /* A route: which of its parts the chosen stays sleep along, and which the nights or the hotel changes allowed could not reach. */
  const routeParts = input.route ? (input.mustCover ?? []).filter((part) => part.anchorId) : [];
  const chosenBaseIds = [...keptIds];
  const route = input.route
    ? {
        shape: input.route,
        parts: routeParts.map((part) => part.name),
        covered: routeParts.filter((part) => partCovered(model, part, chosenBaseIds)).map((part) => part.name),
        uncovered: routeParts.filter((part) => !partCovered(model, part, chosenBaseIds)).map((part) => part.name),
      }
    : null;
  const routeNote = route && route.uncovered.length > 0
    ? ` ${capped ? 'One place to sleep' : maxMoves < input.bases.length - 1 && model.nights >= input.bases.length ? 'The hotel changes you allow' : `${model.nights} night${model.nights === 1 ? '' : 's'}`} cannot follow the whole route: ${route.uncovered.join(', ')} ${route.uncovered.length === 1 ? 'is' : 'are'} beyond a day's reach of where you stay.`
    : '';
  /* What the cheapest structure that does not follow the route would have left beyond reach, so the sentence can say why these stays. */
  const ruledOutRoute = route && ruledOut ? routeParts.filter((part) => !partCovered(model, part, ruledOut.evaluation.option.stays.map((s) => s.baseId))).map((part) => part.name) : [];
  const routeLead =
    route && chosenOption.moves > 0 && route.uncovered.length === 0
      ? `${new Set(chosenOption.stays.map((s) => s.baseName)).size} bases along the route, ${[...new Set(chosenOption.stays.map((s) => s.baseName))].join(', ')}${
          ruledOut && ruledOutRoute.length > 0
            ? `: staying only at ${[...new Set(ruledOut.evaluation.option.stays.map((s) => nameOf.get(s.baseId) ?? s.baseId))].join(' and ')} would leave ${ruledOutRoute.join(', ')} beyond a day's reach`
            : ''
        }; the ${chosenOption.moves} move${chosenOption.moves === 1 ? '' : 's'} cost about ${hours(chosenOption.transferMinutes + chosenOption.moveOverheadMinutes)} of travelling, packing up and checking in${route.shape === 'loop' ? ', the way back to where the route began included' : ''}.`
      : null;
  const ruledOutNote = ruledOut && !routeLead ? (route ? ' It takes these stays to follow the route.' : ' It takes these stays to reach the places you named.') : '';

  return {
    stays: chosen.evaluation.option.stays.map((s) => ({ ...s })),
    splitStay: chosen.splitStay,
    homeBase: chosen.evaluation.home,
    leftOut,
    decision: {
      version: 1,
      chosen: chosenOption,
      alternatives,
      moveCost: model.move,
      minNightsPerStay: minStay,
      maxMovesAllowed: maxMoves,
      basis,
      marginMinutes: margin,
      sentence: trail ? trail.sentence(nameOf) : routeLead ?? `${sentenceFor(input, model, chosenOption, alternatives, capped)}${ruledOutNote}${routeNote}`,
      ...(route ? { route } : {}),
    },
  };
}
