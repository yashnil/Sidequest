import type { DayDensityClass } from '@sidequest/core';
import type { StructurePlan, StructurePlannerInput } from './structure-planner';

/**
 * SPARSE-ITINERARY PASS (2026-11) — A LIGHT DAY SAYS WHY IT IS LIGHT.
 *
 * A live "Arusha and the Serengeti" trip came out with seven stops across nine
 * days. Nothing on the page said whether that was the plan or a failure: the
 * days simply read "Free time". It was a failure — three of the scan's four
 * places to sleep could not be placed, so every day was planned from the one
 * that could, and Ngorongoro and the Serengeti were three hours away.
 *
 * A light day is not a defect in itself. A slow pace asks for empty
 * afternoons; a day that is one long game drive is a full day with one stop.
 * So every day gets one deterministic class, with the figures it was decided
 * from:
 *
 *   full             — as many stops as the traveller's pace holds, or as full
 *                      as the planner fills a day at that pace;
 *   edge_day         — an arrival or departure day;
 *   travel_day       — a day that moves base;
 *   episode_day      — one long experience is the day (a game drive, a trek
 *                      stage, a boat day): full with one stop;
 *   relaxed_by_pace  — lighter than it could be because the traveller's pace
 *                      or mix held more back (places within reach were left
 *                      out for capacity or frequency, or the pace is slow);
 *   discovery_gap    — not held back by pace, and the scan lost something
 *                      material (a place to sleep, or a real share of what it
 *                      proposed — `lossesAreMaterial`): the day is light
 *                      because Sidequest's discovery came up short, and the
 *                      plan says so;
 *   constrained      — places within reach exist but cannot go on this day
 *                      (the travel limit, weather, closures, effort, season);
 *   nothing_in_reach — nothing left on the board is within reach of where the
 *                      traveller sleeps, and discovery lost nothing material.
 *
 * Pure: reads the plan the planner built, its input, and the scan's own
 * account of what it lost. Never calls a provider, never moves a stop. A
 * discovery gap is Sidequest's own unfinished work, so its sentence never asks
 * the traveller to do anything (CLAUDE.md V11).
 */

export type { DayDensityClass };

/** What the scan proposed and could not use, from `discovery_scans.extras_json.diagnostics`. */
export interface DiscoveryLosses {
  /** Places to sleep the scan proposed and could not place. */
  bases: readonly string[];
  /** Places the scan proposed and could not place, or placed only too vaguely to plan around. */
  places: readonly string[];
  /** How many candidates the scan proposed, to judge whether the losses are material. */
  proposed?: number;
}

export interface DayDensity {
  dayNumber: number;
  class: DayDensityClass;
  stops: number;
  /** The daytime stops the traveller's pace holds. */
  target: number;
  usableMinutes: number;
  activityMinutes: number;
  travelMinutes: number;
  freeMinutes: number;
  /** Board places within reach of tonight's base that were left out, by why. */
  unusedInReach: number;
  unusedReasons: string[];
}

export interface TripDensity {
  version: 1;
  /** The most telling class across the days: a gap outranks a lack of places, which outranks a deliberate light day. */
  class: DayDensityClass;
  /** False when any day is light because discovery came up short. */
  complete: boolean;
  stops: number;
  thinDays: number;
  losses: { bases: string[]; places: number; examples: string[] };
  days: DayDensity[];
}

/** A stop at least this long, or this share of the day, is the day. */
const EPISODE_MINUTES = 300;
const EPISODE_SHARE = 0.5;
const FILL_SHARE = { slow: 0.55, balanced: 0.7, fast: 0.85 } as const;
/** A day at its pace's stop count that still leaves this share free is light on purpose. */
const RELAXED_FREE_SHARE = 0.4;
const SEVERITY: Record<DayDensityClass, number> = { full: 0, edge_day: 0, travel_day: 0, episode_day: 1, relaxed_by_pace: 2, constrained: 3, nothing_in_reach: 4, discovery_gap: 5 };
const PACE_DROPS = new Set(['capacity', 'frequency']);
/** Lost places that make a gap material without a lost base: at least this many, and this share of the proposal. */
const MATERIAL_LOSS_MIN = 3;
const MATERIAL_LOSS_SHARE = 0.15;
const CONSTRAINT_DROPS = new Set(['weather', 'closed', 'too_strenuous', 'out_of_season', 'not_workable', 'too_far']);

/** What the scan lost, read from its stored diagnostics. Duplicates are not losses. */
export function discoveryLossesOf(diagnostics: { proposal?: { returned?: number }; placement?: { unplaced?: readonly { name: string; isBase: boolean }[] }; assembly?: readonly { name: string; code: string }[] } | null | undefined): DiscoveryLosses {
  const unplaced = diagnostics?.placement?.unplaced ?? [];
  const vague = (diagnostics?.assembly ?? []).filter((a) => a.code === 'approximate_only').map((a) => a.name);
  return {
    bases: unplaced.filter((u) => u.isBase).map((u) => u.name),
    places: [...new Set([...unplaced.filter((u) => !u.isBase).map((u) => u.name), ...vague])],
    ...(typeof diagnostics?.proposal?.returned === 'number' ? { proposed: diagnostics.proposal.returned } : {}),
  };
}

/**
 * Whether what the scan lost could plausibly be why a day is light: a place to
 * sleep lost (every day near it is planned from somewhere else), or a real
 * share of the proposal. Two vague viewpoints out of forty are not why a day
 * is empty, and calling every light day a gap would make the word mean nothing.
 */
export function lossesAreMaterial(losses: DiscoveryLosses): boolean {
  if (losses.bases.length > 0) return true;
  return losses.places.length >= Math.max(MATERIAL_LOSS_MIN, Math.ceil((losses.proposed ?? 0) * MATERIAL_LOSS_SHARE));
}

export function classifyDayDensity(input: {
  plan: Pick<StructurePlan, 'days' | 'dropped'>;
  planner: Pick<StructurePlannerInput, 'windows' | 'pace' | 'maxStopsPerDay' | 'maxDailyTravelMinutes' | 'minutes'>;
  /** The traveller asked for lots of free time: a light day is the plan. */
  freeTimeHeavy?: boolean;
  losses: DiscoveryLosses;
}): TripDensity {
  const { plan, planner } = input;
  const reach = Math.max(45, Math.floor(planner.maxDailyTravelMinutes / 2));
  const material = lossesAreMaterial(input.losses);
  const days: DayDensity[] = plan.days.map((day, index) => {
    const window = planner.windows.find((w) => w.date === day.date);
    const usable = window ? Math.max(0, window.endMinute - window.startMinute) : day.capacityMinutes;
    const travel = day.travelMinutes + day.eveningTravelMinutes;
    const free = Math.max(0, usable - day.activityMinutes - travel);
    const daytime = day.stops.filter((s) => s.slot === 'day').length;
    const unused = plan.dropped.filter((d) => {
      const m = planner.minutes(day.baseId, d.candidate.id);
      return d.reason !== 'excluded' && m !== null && m <= reach;
    });
    const unusedReasons = [...new Set(unused.map((d) => d.reason))].sort();
    const base: Omit<DayDensity, 'class'> = { dayNumber: day.dayNumber, stops: day.stops.length, target: planner.maxStopsPerDay, usableMinutes: usable, activityMinutes: day.activityMinutes, travelMinutes: travel, freeMinutes: free, unusedInReach: unused.length, unusedReasons };
    const isEdge = index === 0 || index === plan.days.length - 1;
    const longest = Math.max(0, ...day.stops.map((s) => s.candidate.durationMinutes));
    const filled = usable > 0 ? (day.activityMinutes + travel) / usable : 1;
    const cls: DayDensityClass = isEdge
      ? 'edge_day'
      : day.relocation
        ? 'travel_day'
        : longest >= EPISODE_MINUTES || (usable > 0 && longest >= usable * EPISODE_SHARE)
          ? 'episode_day'
          : daytime >= planner.maxStopsPerDay || filled >= FILL_SHARE[planner.pace]
            ? (planner.pace === 'slow' || input.freeTimeHeavy) && usable > 0 && free >= usable * RELAXED_FREE_SHARE
              ? 'relaxed_by_pace'
              : 'full'
            : unused.some((d) => PACE_DROPS.has(d.reason)) || ((planner.pace === 'slow' || input.freeTimeHeavy) && daytime >= Math.max(1, planner.maxStopsPerDay - 1))
              ? 'relaxed_by_pace'
              : material
                ? 'discovery_gap'
                : unused.some((d) => CONSTRAINT_DROPS.has(d.reason))
                  ? 'constrained'
                  : 'nothing_in_reach';
    return { ...base, class: cls };
  });
  const worst = days.reduce<DayDensityClass>((acc, d) => (SEVERITY[d.class] > SEVERITY[acc] ? d.class : acc), 'full');
  const thin = days.filter((d) => SEVERITY[d.class] >= SEVERITY.relaxed_by_pace);
  return {
    version: 1,
    class: worst,
    complete: !days.some((d) => d.class === 'discovery_gap'),
    stops: days.reduce((n, d) => n + d.stops, 0),
    thinDays: thin.length,
    losses: { bases: [...input.losses.bases], places: input.losses.places.length, examples: input.losses.places.slice(0, 3) },
    days,
  };
}

function list(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]!}`;
}

function clock(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return h === 0 ? `${m} min` : m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/**
 * The sentence a light day carries, or null when the class needs none. Only
 * the two classes a traveller could otherwise misread get words: a gap (so a
 * thin day is never passed off as a relaxed one) and nothing in reach (so an
 * empty afternoon is not mistaken for an oversight). Never a field name; a gap
 * is Sidequest's work, never the traveller's.
 */
export function densityNote(day: DayDensity, density: Pick<TripDensity, 'losses'>, context: { baseName: string; maxDailyTravelMinutes: number; isEmpty: boolean }): string | null {
  if (day.class === 'discovery_gap') {
    const examples = density.losses.examples.length > 0 ? ` — ${list(density.losses.examples)} among them` : '';
    const sleeps = density.losses.bases.length === 1 ? 'a place to sleep' : 'places to sleep';
    const bases = density.losses.bases.length > 0 ? ` It ${density.losses.places > 0 ? 'also ' : ''}could not place ${sleeps} the scan proposed (${list(density.losses.bases.slice(0, 3))}), so this day is planned from ${context.baseName}.` : '';
    return `A light day, and not by design: Sidequest found more for this trip than it could put on the map${examples}.${bases} This is Sidequest's to fix — nothing for you to do.`;
  }
  /* An empty day already says what is nearest (`structure-repair.ts#openDayNote`); this is for a day with something in it. */
  if (day.class === 'nothing_in_reach' && !context.isEmpty) return `A light day: nothing else on your board is within reach of ${context.baseName} under your ${clock(context.maxDailyTravelMinutes)} of travel.`;
  return null;
}

/**
 * The one trip-level line, shown beside where the trip sleeps, when a day is
 * light because discovery came up short. Null otherwise: a relaxed trip has
 * nothing to apologise for.
 */
export function tripDensityLine(density: Pick<TripDensity, 'complete' | 'losses' | 'days'> | null | undefined): string | null {
  if (!density || density.complete) return null;
  const gapDays = density.days.filter((d) => d.class === 'discovery_gap').length;
  const places = density.losses.places > 0 ? `${density.losses.places} of the places it found` : '';
  const bases = density.losses.bases.length > 0 ? `${density.losses.bases.length === 1 ? 'a place to sleep' : `${density.losses.bases.length} places to sleep`} (${list(density.losses.bases.slice(0, 3))})` : '';
  const lost = [places, bases].filter(Boolean).join(' and ');
  return `${gapDays === 1 ? 'One day is' : `${gapDays} days are`} lighter than ${gapDays === 1 ? 'it' : 'they'} should be: Sidequest could not put ${lost || 'everything it found'} on the map. That is Sidequest's to fix — nothing for you to do.`;
}

/**
 * IS THE TRIP LONGER THAN THIS AREA HOLDS? (2026-11 experience transformation)
 *
 * Read from the days themselves: an ordinary day with nothing left within
 * reach of where the traveller sleeps (`nothing_in_reach`) — not a day the
 * pace held back, not a discovery gap — is a day the area cannot fill with
 * what the traveller chose. Two or more of them (or a fifth of the trip) and
 * the honest advice is a shorter stay here or nights somewhere else, said
 * plainly. Null when the days are full, deliberately relaxed, or light for a
 * reason Sidequest owns (that is `tripDensityLine`). Pure; render-safe.
 */
export function tripLengthLine(density: Pick<TripDensity, 'days'> | null | undefined): string | null {
  if (!density || density.days.length < 4) return null;
  const empty = density.days.filter((d) => d.class === 'nothing_in_reach').length;
  if (empty < 2 && empty < density.days.length * 0.2) return null;
  const held = density.days.length - empty;
  return `What this area holds that fits you fills about ${held} of your ${density.days.length} days; ${empty === 1 ? 'one day has' : `${empty} days have`} nothing left within reach. A shorter stay here, or a few nights somewhere else, would use ${empty === 1 ? 'it' : 'them'} better — or keep ${empty === 1 ? 'it' : 'them'} as free days.`;
}
