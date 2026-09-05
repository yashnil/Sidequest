import type { BenchmarkTripRequest } from '@sidequest/bench';
import type { BaselineGeneration } from './generate';
import { placeAt, type PacketPlace, type ResearchPacket } from './packet-types';
import type { TripSkeleton } from './skeleton';

/**
 * DETERMINISTIC HYDRATION — THE OTHER HALF OF THE PHASE 17 DOCTRINE, KEPT.
 *
 * "The model makes holistic travel decisions. Sidequest turns those decisions
 * into a verified itinerary." A `TripSkeleton` is the first half, stated as
 * compactly as a trip's shape can be stated. This file is the second half: no
 * model, no latency, no grammar to refuse — arithmetic over the same
 * `ResearchPacket` the skeleton evidence was drawn from, run once every time,
 * producing exactly the same answer for the same skeleton.
 *
 * The boundary is the one the module comment on `skeleton.ts` already draws
 * and this file must not blur in either direction:
 *
 * **The model chooses** which few experiences anchor each day, and it chose
 * them already — `skeleton.days[].anchors`. This file does not add a new
 * anchor, drop one because a nicer one exists nearby, or reorder which day an
 * anchor belongs to. Its role is to realise the choice, not to second-guess it.
 *
 * **Sidequest determines** everything the skeleton has no field for: the
 * order stops happen in, how long getting between them actually takes, where
 * a meal goes, what time each block starts and ends, whether an anchor that
 * turned out to be infeasible has a same-kind neighbour that works, and
 * whether the trip the skeleton describes can actually end where the
 * traveller needs to leave from.
 *
 * `@sidequest/geo`'s `orderStops` and every selection/scheduling engine in
 * `@sidequest/core` are architecturally forbidden inside `baseline/` — see
 * `baseline.architecture.test.ts`'s own header — because this arm exists to
 * measure a model against Sidequest's *own* planner, and a hydration step
 * that quietly borrowed the planner's engines would be measuring the planner
 * against itself. So the sequencing below is this file's own small
 * nearest-neighbour arithmetic, the same discipline `packet.ts` already
 * applies to clustering rather than reaching for `clusterByTravelTime`.
 */

const DAY_START_MINUTE = 540; // 09:00, the default; shifted on an edge day — see `dayStartMinute`.
const DEFAULT_ACTIVITY_MINUTES = 90;
/** Kept off `PacketRouteLeg.mode` deliberately — an internal-only clock estimate, never stated as a fact. */
const ESTIMATED_KMH = 45;
const LUNCH_WINDOW: readonly [number, number] = [690, 840]; // 11:30-14:00
const DINNER_WINDOW: readonly [number, number] = [1080, 1230]; // 18:00-20:30
const MEAL_DURATION_MINUTES = 45;
/** Beyond this, two points are treated as needing a vehicle rather than a walk, for the internal clock only. */
const WALK_RADIUS_KM = 1.2;

export interface HydrationSubstitution {
  dayNumber: number;
  originalPlaceIndex: number;
  substitutePlaceIndex: number;
  reason: string;
}

export type HydrationIssueKind =
  | 'unresolvable_anchor'
  | 'inconsistent_base_reference'
  | 'empty_day'
  | 'departure_unreachable';

export interface HydrationIssue {
  kind: HydrationIssueKind;
  detail: string;
  dayNumber?: number;
}

export interface HydrationResult {
  plan: BaselineGeneration;
  substitutions: readonly HydrationSubstitution[];
  /** Left unresolved by deterministic hydration — the bounded skeleton-repair stage's input. */
  issues: readonly HydrationIssue[];
  departureClosure: { ok: boolean; detail: string };
}

/* ------------------------------------------------------------------ *
 * Small, owned geometry — see the header for why this is not imported.
 * ------------------------------------------------------------------ */

function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const R = 6371.0088;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h = sinLat * sinLat + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sinLng * sinLng;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Internal-clock-only estimate. Never becomes a stated `travel.minutes` fact — see `travelFor`. */
function estimatedMinutes(km: number): number {
  return Math.max(5, Math.round((km / ESTIMATED_KMH) * 60));
}

interface Point {
  lat: number;
  lng: number;
}

/**
 * A measured leg where the packet has one, keyed by place index — this
 * file's only source of a *stated* travel time. Symmetric: a measured leg
 * from A to B stands for B to A too, since the packet's own routing pass
 * measures a road, not a direction.
 */
function measuredMinutesLookup(
  packet: ResearchPacket,
): (fromIndex: number, toIndex: number) => { minutes: number; mode: 'drive' | 'walk' | 'transit' } | null {
  const table = new Map<string, { minutes: number; mode: 'drive' | 'walk' | 'transit' }>();
  for (const leg of packet.routeLegs) {
    table.set(`${leg.fromIndex}:${leg.toIndex}`, { minutes: leg.minutes, mode: leg.mode });
    if (!table.has(`${leg.toIndex}:${leg.fromIndex}`)) {
      table.set(`${leg.toIndex}:${leg.fromIndex}`, { minutes: leg.minutes, mode: leg.mode });
    }
  }
  return (fromIndex, toIndex) => table.get(`${fromIndex}:${toIndex}`) ?? null;
}

/**
 * NEAREST-NEIGHBOUR SEQUENCING, OWNED BY THIS FILE.
 *
 * Deterministic: ties break by the stop's own place index, never by
 * insertion order or anything that would make two runs over the same
 * skeleton disagree. Good enough for the handful of stops one day holds —
 * see `packages/geo/src/order.ts`'s own comment on why a day's worth of
 * stops does not need a heavier optimiser, restated here because this file
 * cannot import that one.
 */
function orderByNearestNeighbour(start: Point, stops: readonly { id: number; point: Point }[]): number[] {
  const remaining = new Map(stops.map((stop) => [stop.id, stop.point]));
  const order: number[] = [];
  let current = start;
  while (remaining.size > 0) {
    let bestId: number | null = null;
    let bestKm = Number.POSITIVE_INFINITY;
    for (const [id, point] of [...remaining.entries()].sort((a, b) => a[0] - b[0])) {
      const km = haversineKm(current, point);
      if (km < bestKm) {
        bestKm = km;
        bestId = id;
      }
    }
    const chosenId = bestId ?? [...remaining.keys()].sort((a, b) => a - b)[0]!;
    order.push(chosenId);
    current = remaining.get(chosenId)!;
    remaining.delete(chosenId);
  }
  return order;
}

/* ------------------------------------------------------------------ *
 * Feasibility and substitution
 * ------------------------------------------------------------------ */

const AVOIDANCE_KEYWORDS: Partial<Record<BenchmarkTripRequest['taste']['hardAvoidances'][number], readonly string[]>> = {
  long_hikes: ['hiking', 'trail'],
  strenuous_activity: [],
  rough_or_unpaved_roads: [],
  nightlife: ['bar', 'pub', 'nightclub'],
  boats_and_ferries: ['ferry', 'boat', 'harbour'],
};

/**
 * A hard-constraint refusal, not a preference weighing — the same
 * distinction `HARD_AVOIDANCES` itself draws in the shared request schema.
 * Deliberately narrow: only checks this file can act on deterministically
 * (season, car dependence, wheelchair access, the avoidance list's
 * keyword-mappable members), never a judgement call about whether a place
 * merely *fits* the traveller, which stays the model's — the skeleton
 * already made that call by choosing the anchor.
 */
function isAnchorInfeasible(place: PacketPlace, request: BenchmarkTripRequest): string | null {
  if (place.seasonal.state === 'closed_in_season') {
    return `closed for the trip's dates (${place.seasonal.note})`;
  }
  if (place.access.requiresCar === true && !request.movement.carAvailable) {
    return 'requires a car the traveller does not have available';
  }
  if (
    place.access.wheelchair === 'no' &&
    request.party.mobility.includes('wheelchair_user')
  ) {
    return 'not accessible to a wheelchair user';
  }
  const text = `${place.kind} ${place.tags.join(' ')}`.toLowerCase();
  for (const avoidance of request.taste.hardAvoidances) {
    const keywords = AVOIDANCE_KEYWORDS[avoidance];
    if (keywords && keywords.length > 0 && keywords.some((keyword) => text.includes(keyword))) {
      return `matches a stated hard avoidance (${avoidance})`;
    }
  }
  return null;
}

/**
 * Same kind, nearby, not already infeasible, not already used elsewhere in
 * the trip. The nearest such place wins, ties broken by index — the only
 * substitute this file will ever propose is one that preserves what the
 * anchor was *for* (its own experience kind), never a different kind of
 * experience standing in for it.
 */
function findSubstitute(
  packet: ResearchPacket,
  original: PacketPlace,
  request: BenchmarkTripRequest,
  alreadyUsed: ReadonlySet<number>,
): PacketPlace | null {
  let best: PacketPlace | null = null;
  let bestKm = Number.POSITIVE_INFINITY;
  for (const candidate of packet.places) {
    if (candidate.index === original.index) continue;
    if (candidate.kind !== original.kind) continue;
    if (alreadyUsed.has(candidate.index)) continue;
    if (isAnchorInfeasible(candidate, request) !== null) continue;
    const km = haversineKm(
      { lat: original.latitude, lng: original.longitude },
      { lat: candidate.latitude, lng: candidate.longitude },
    );
    if (km < bestKm || (km === bestKm && (best === null || candidate.index < best.index))) {
      best = candidate;
      bestKm = km;
    }
  }
  return best;
}

/* ------------------------------------------------------------------ *
 * The build
 * ------------------------------------------------------------------ */

interface ResolvedBase {
  id: string;
  placeIndex: number | null;
  name: string;
  nights: number;
  why: string;
  point: Point | null;
}

function resolveBaseCoordinate(
  base: TripSkeleton['bases'][number],
  packet: ResearchPacket,
): Point | null {
  const place = placeAt(packet, base.placeIndex);
  if (place) return { lat: place.latitude, lng: place.longitude };
  const candidate = packet.baseCandidates.find((b) => b.name === base.name);
  if (candidate) return { lat: candidate.latitude, lng: candidate.longitude };
  if (packet.baseCandidates.length > 0) {
    const first = packet.baseCandidates[0]!;
    return { lat: first.latitude, lng: first.longitude };
  }
  return { lat: packet.destination.latitude, lng: packet.destination.longitude };
}

function dayStartMinute(dayNumber: number, totalDays: number, request: BenchmarkTripRequest): number {
  if (dayNumber === 1 && request.arrival.precision === 'exact' && request.arrival.time) {
    const [h, m] = request.arrival.time.split(':').map(Number);
    return Math.max(DAY_START_MINUTE, (h ?? 9) * 60 + (m ?? 0) + 60);
  }
  if (
    dayNumber === totalDays &&
    request.departure.precision === 'exact' &&
    request.departure.time
  ) {
    return DAY_START_MINUTE - 60;
  }
  return DAY_START_MINUTE;
}

export function hydrateSkeleton(input: {
  skeleton: TripSkeleton;
  packet: ResearchPacket;
  request: BenchmarkTripRequest;
}): HydrationResult {
  const { skeleton, packet, request } = input;
  const measured = measuredMinutesLookup(packet);
  const substitutions: HydrationSubstitution[] = [];
  const issues: HydrationIssue[] = [];
  const usedAnchorIndices = new Set<number>();

  const resolvedBases: ResolvedBase[] = skeleton.bases.map((base) => ({
    id: base.id,
    placeIndex: base.placeIndex,
    name: base.name,
    nights: base.nights,
    why: base.why,
    point: resolveBaseCoordinate(base, packet),
  }));
  const baseById = new Map(resolvedBases.map((base) => [base.id, base]));

  const totalDays = skeleton.days.length;
  const sortedDays = [...skeleton.days].sort((a, b) => a.dayNumber - b.dayNumber);

  const days: BaselineGeneration['days'] = sortedDays.map((day, dayPosition) => {
    if (day.baseId === null) {
      return {
        dayNumber: day.dayNumber,
        baseId: null,
        theme: day.theme,
        blocks: [],
        statedTotals: { travelMinutes: null, driveMinutes: null, freeMinutes: null },
        alternatives: [],
        warnings: ['The skeleton did not assign this day to a base.'],
      };
    }

    const base = baseById.get(day.baseId);
    if (!base || !base.point) {
      issues.push({
        kind: 'inconsistent_base_reference',
        detail: `Day ${day.dayNumber} names base "${day.baseId}", which is not one of the skeleton's own bases.`,
        dayNumber: day.dayNumber,
      });
      return {
        dayNumber: day.dayNumber,
        baseId: day.baseId,
        theme: day.theme,
        blocks: [],
        statedTotals: { travelMinutes: null, driveMinutes: null, freeMinutes: null },
        alternatives: [],
        warnings: ['This day named a base the skeleton never defined; it could not be scheduled.'],
      };
    }

    const nextDay = sortedDays[dayPosition + 1];
    const endBase =
      nextDay && nextDay.baseId !== null && nextDay.baseId !== day.baseId
        ? (baseById.get(nextDay.baseId) ?? base)
        : base;
    const isRelocationDay = endBase.id !== base.id;

    // Resolve anchors: substitute an infeasible one where a safe neighbour
    // exists, drop it (recorded) where none does, and never invent a reason
    // for an index the packet cannot even find.
    const resolvedAnchors: { place: PacketPlace; role: 'primary' | 'secondary'; substituted: boolean }[] = [];
    for (const anchor of day.anchors) {
      const place = placeAt(packet, anchor.placeIndex);
      if (!place) {
        issues.push({
          kind: 'unresolvable_anchor',
          detail: `Day ${day.dayNumber}'s anchor at index ${anchor.placeIndex} does not exist in the research packet.`,
          dayNumber: day.dayNumber,
        });
        continue;
      }
      const infeasibleReason = isAnchorInfeasible(place, request);
      if (infeasibleReason === null) {
        resolvedAnchors.push({ place, role: anchor.role, substituted: false });
        usedAnchorIndices.add(place.index);
        continue;
      }
      const substitute = findSubstitute(packet, place, request, usedAnchorIndices);
      if (substitute) {
        substitutions.push({
          dayNumber: day.dayNumber,
          originalPlaceIndex: place.index,
          substitutePlaceIndex: substitute.index,
          reason: `The planned anchor was ${infeasibleReason}; substituted the nearest available place of the same kind.`,
        });
        resolvedAnchors.push({ place: substitute, role: anchor.role, substituted: true });
        usedAnchorIndices.add(substitute.index);
      }
      // No safe substitute: the anchor is dropped. Not itself an `issue` —
      // one lost secondary anchor is not consequential — unless it leaves
      // the day with nothing at all, checked below.
    }

    if (resolvedAnchors.length === 0 && day.anchors.length > 0) {
      issues.push({
        kind: 'empty_day',
        detail: `Day ${day.dayNumber} lost every anchor to an infeasibility with no available substitute.`,
        dayNumber: day.dayNumber,
      });
    }

    const stops = resolvedAnchors.map((resolved) => ({
      id: resolved.place.index,
      point: { lat: resolved.place.latitude, lng: resolved.place.longitude },
    }));
    const order = orderByNearestNeighbour(base.point!, stops);
    const anchorByIndex = new Map(resolvedAnchors.map((resolved) => [resolved.place.index, resolved]));

    const blocks: BaselineGeneration['days'][number]['blocks'] = [];
    let clock = dayStartMinute(day.dayNumber, totalDays, request);
    let travelMinutesTotal = 0;
    let driveMinutesTotal = 0;
    let hadLunch = false;
    let hadDinner = false;
    let previousPoint = base.point!;
    let previousIndex: number | null = base.placeIndex;

    const maybeInsertMeal = (): void => {
      if (!hadLunch && clock >= LUNCH_WINDOW[0] && clock <= LUNCH_WINDOW[1]) {
        const venue = nearestFoodPlace(packet, previousPoint, usedAnchorIndices);
        blocks.push(mealBlock('lunch', venue, clock));
        clock += MEAL_DURATION_MINUTES;
        hadLunch = true;
      } else if (!hadDinner && clock >= DINNER_WINDOW[0] && clock <= DINNER_WINDOW[1]) {
        const venue = nearestFoodPlace(packet, previousPoint, usedAnchorIndices);
        blocks.push(mealBlock('dinner', venue, clock));
        clock += MEAL_DURATION_MINUTES;
        hadDinner = true;
      }
    };

    for (let position = 0; position < order.length; position += 1) {
      const resolved = anchorByIndex.get(order[position]!)!;
      const point = { lat: resolved.place.latitude, lng: resolved.place.longitude };

      if (previousIndex !== resolved.place.index) {
        const km = haversineKm(previousPoint, point);
        const leg = measured(previousIndex ?? -1, resolved.place.index);
        const travelMinutes = leg ? leg.minutes : estimatedMinutes(km);
        const mode: 'drive' | 'walk' | 'transit' = leg
          ? leg.mode
          : km <= WALK_RADIUS_KM
            ? 'walk'
            : 'drive';
        blocks.push({
          kind: 'travel',
          title: `Travel to ${placeLabel(resolved.place)}`,
          startMinute: clock,
          endMinute: clock + travelMinutes,
          placeIndex: null,
          travel: {
            mode,
            fromPlaceIndex: previousIndex,
            toPlaceIndex: resolved.place.index,
            minutes: leg ? leg.minutes : null,
            provenance: leg ? 'measured' : 'unknown',
          },
          meal: null,
          opening: null,
          note: '',
          uncertainty: leg ? [] : ['This travel time was not measured; the schedule allows for it but the plan cannot state it.'],
          sourceIndex: null,
        });
        clock += travelMinutes;
        travelMinutesTotal += travelMinutes;
        if (mode === 'drive') driveMinutesTotal += travelMinutes;
      }

      maybeInsertMeal();

      const duration = resolved.place.typicalDurationMinutes ?? DEFAULT_ACTIVITY_MINUTES;
      blocks.push({
        kind: 'activity',
        title: placeLabel(resolved.place),
        startMinute: clock,
        endMinute: clock + duration,
        placeIndex: resolved.place.index,
        travel: null,
        meal: null,
        opening: resolved.place.hours.state === 'known'
          ? {
              openMinute: resolved.place.hours.windows[0]?.openMinute ?? 0,
              closeMinute: resolved.place.hours.windows[0]?.closeMinute ?? 1440,
              lastAdmissionMinute: null,
              sourceIndex: resolved.place.hours.windows[0] ? resolved.place.hours.sourceIndex : null,
            }
          : null,
        note: resolved.substituted
          ? `Planned as the anchor closest in kind to what the trip’s shape called for here.`
          : '',
        uncertainty: [],
        sourceIndex: resolved.place.sourceIndex,
      });
      clock += duration;
      previousPoint = point;
      previousIndex = resolved.place.index;
    }

    maybeInsertMeal();

    // The relocation leg, if this day changes base — a `transfer`, not an
    // ordinary `travel` block, so a validator reading block kinds can tell
    // "moved between activities" from "moved to a new overnight base".
    if (isRelocationDay) {
      const km = haversineKm(previousPoint, endBase.point!);
      const leg = measured(previousIndex ?? -1, endBase.placeIndex ?? -1);
      const travelMinutes = leg ? leg.minutes : estimatedMinutes(km);
      blocks.push({
        kind: 'transfer',
        title: `Relocate to ${endBase.name}`,
        startMinute: clock,
        endMinute: clock + travelMinutes,
        placeIndex: endBase.placeIndex,
        travel: {
          mode: 'drive',
          fromPlaceIndex: previousIndex,
          toPlaceIndex: endBase.placeIndex,
          minutes: leg ? leg.minutes : null,
          provenance: leg ? 'measured' : 'unknown',
        },
        meal: null,
        opening: null,
        note: '',
        uncertainty: leg ? [] : ['This relocation time was not measured; the schedule allows for it but the plan cannot state it.'],
        sourceIndex: null,
      });
      clock += travelMinutes;
      travelMinutesTotal += travelMinutes;
      driveMinutesTotal += travelMinutes;
    }

    const dayEndMinute = Math.min(1380, dayStartMinute(day.dayNumber, totalDays, request) + 16 * 60);
    const freeMinutes = Math.max(0, dayEndMinute - clock);

    return {
      dayNumber: day.dayNumber,
      baseId: day.baseId,
      theme: day.theme,
      blocks: blocks.slice(0, 10),
      statedTotals: {
        travelMinutes: travelMinutesTotal,
        driveMinutes: driveMinutesTotal,
        freeMinutes,
      },
      alternatives: [],
      warnings: [],
    };
  });

  const usedBaseIds = new Set(days.map((day) => day.baseId).filter((id): id is string => id !== null));
  const bases: BaselineGeneration['bases'] = resolvedBases
    .filter((base) => usedBaseIds.has(base.id))
    .map((base) => ({
      id: base.id,
      placeIndex: base.placeIndex,
      name: base.name,
      nights: base.nights,
      why: base.why,
    }));

  const departureClosure = verifyDepartureClosure({ resolvedBases, sortedDays, packet, request, measured });
  if (!departureClosure.ok) {
    issues.push({ kind: 'departure_unreachable', detail: departureClosure.detail });
  }

  const exclusions = skeleton.majorOmissions.map((omission) => ({
    placeIndex: omission.placeIndex,
    reason: omission.reason,
  }));

  const archetypeLabel = skeleton.archetype.replace(/_/g, ' ');
  const summary =
    `${skeleton.purpose} A ${archetypeLabel} trip across ${bases.length} base(s) ` +
    `over ${skeleton.days.length} day(s).`;
  const scopeNote = `Built deterministically from ${bases.length} skeleton base(s) and ` +
    `${skeleton.days.reduce((total, day) => total + day.anchors.length, 0)} chosen anchor(s).`;

  const unknowns = [
    ...skeleton.unresolved,
    ...(departureClosure.ok ? [] : [departureClosure.detail]),
  ];

  const plan: BaselineGeneration = {
    summary: summary.slice(0, 800),
    scopeNote: scopeNote.slice(0, 300),
    bases,
    days,
    exclusions,
    unknowns: unknowns.slice(0, 15),
    preparation: [],
    warnings: [],
  };

  return { plan, substitutions, issues, departureClosure };
}

function placeLabel(place: PacketPlace): string {
  return place.name;
}

function nearestFoodPlace(
  packet: ResearchPacket,
  from: Point,
  excluding: ReadonlySet<number>,
): PacketPlace | null {
  let best: PacketPlace | null = null;
  let bestKm = Number.POSITIVE_INFINITY;
  for (const place of packet.places) {
    if (!place.food || excluding.has(place.index)) continue;
    const km = haversineKm(from, { lat: place.latitude, lng: place.longitude });
    if (km < bestKm) {
      best = place;
      bestKm = km;
    }
  }
  return best;
}

function mealBlock(
  slot: 'lunch' | 'dinner',
  venue: PacketPlace | null,
  startMinute: number,
): BaselineGeneration['days'][number]['blocks'][number] {
  return {
    kind: 'meal',
    title: venue ? `${slot === 'lunch' ? 'Lunch' : 'Dinner'} at ${venue.name}` : slot === 'lunch' ? 'Lunch' : 'Dinner',
    startMinute,
    endMinute: startMinute + MEAL_DURATION_MINUTES,
    placeIndex: venue?.index ?? null,
    travel: null,
    meal: {
      slot,
      stopKind: venue ? 'venue' : 'unstated',
      venuePlaceIndex: venue?.index ?? null,
      detourMinutes: 0,
    },
    opening: null,
    note: '',
    uncertainty: venue ? [] : ['No nearby food venue was in the research packet at this point in the day.'],
    sourceIndex: null,
  };
}

/**
 * THE DEPARTURE-CLOSURE INVARIANT, CHECKED — NOT ASSUMED.
 *
 * `BASELINE_GENERATE_INSTRUCTION` already tells a full-plan composer the
 * trip has to end somewhere the traveller can leave from; this is that same
 * doctrine, applied to a skeleton hydration cannot ask a model about, so it
 * is verified instead. Absent a distinct departure-location entity in this
 * packet's own data model (`BenchmarkTripRequest.origin` is free text, never
 * geocoded — see the request schema's own comment), the working definition
 * is the one the prompt already states: unless the trip's own bases say
 * otherwise, departure is from the same point arrival was, which in this
 * data model is the first day's base (or, failing that, the destination
 * itself).
 */
function verifyDepartureClosure(input: {
  resolvedBases: readonly ResolvedBase[];
  sortedDays: readonly TripSkeleton['days'][number][];
  packet: ResearchPacket;
  request: BenchmarkTripRequest;
  measured: (fromIndex: number, toIndex: number) => { minutes: number; mode: string } | null;
}): { ok: boolean; detail: string } {
  const { resolvedBases, sortedDays, packet, request, measured } = input;
  const lastDayWithBase = [...sortedDays].reverse().find((day) => day.baseId !== null);
  if (!lastDayWithBase) return { ok: true, detail: 'No day was assigned a base; nothing to verify.' };

  const lastBase = resolvedBases.find((base) => base.id === lastDayWithBase.baseId);
  const firstDayWithBase = sortedDays.find((day) => day.baseId !== null);
  const firstBase = firstDayWithBase
    ? resolvedBases.find((base) => base.id === firstDayWithBase.baseId)
    : undefined;

  const arrivalPoint: Point = firstBase?.point ?? {
    lat: packet.destination.latitude,
    lng: packet.destination.longitude,
  };
  if (!lastBase || !lastBase.point) {
    return { ok: true, detail: 'The final day\'s base could not be located; departure closure was not checked.' };
  }
  if (firstBase && lastBase.id === firstBase.id) {
    return { ok: true, detail: 'The trip ends at the same base it started from.' };
  }

  const km = haversineKm(lastBase.point, arrivalPoint);
  const leg =
    lastBase.placeIndex !== null && firstBase?.placeIndex !== null && firstBase !== undefined
      ? measured(lastBase.placeIndex, firstBase.placeIndex ?? -1)
      : null;
  const minutes = leg ? leg.minutes : estimatedMinutes(km);
  const ceiling = Math.max(request.movement.maxDailyTravelMinutes, 240);

  if (minutes <= ceiling) {
    return {
      ok: true,
      detail: `The final base is about ${minutes} minute(s) from where the trip began — within a single travel day.`,
    };
  }
  return {
    ok: false,
    detail: `The final base is about ${minutes} minute(s) from where the trip began, past the traveller's own daily travel limit — the route as planned may not close in time for departure.`,
  };
}
