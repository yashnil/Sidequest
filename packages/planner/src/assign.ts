import { isMeaningfullyBetter, type TravelerProfile } from '@sidequest/core';
import { clusterByTravelTime, hasPoint, resolveSubMatrix, type TravelTimeMatrix, tryLeg } from '@sidequest/geo';
import type { AccessUnit } from './access';
import type { PlannedDay } from './windows';
import type { PlanningCandidate } from './types';

export interface DayAssignment {
  day: PlannedDay;
  candidates: PlanningCandidate[];
}

/**
 * OBSERVABILITY FOR THE ASSIGNMENT FUNNEL — NEVER A QUALITY GATE.
 *
 * A trip that goes from many feasible candidates to almost none scheduled
 * must never do so silently. This is not a minimum-stop requirement (no
 * threshold here ever blocks or rewrites an itinerary) — it is a record of
 * where every candidate went, so "why is this day empty" has a real answer:
 * genuinely not enough evidence/eligible places, or a planner defect. The
 * live Iceland run that exposed the original defect (15 feasible -> 1
 * scheduled) had no diagnostic that could tell the two apart; this exists so
 * that never happens invisibly again.
 */
export interface AssignmentFunnel {
  /** Individual candidates handed to `assignToDays`, before unitisation. */
  candidatesEntering: number;
  /** How many of those candidates ended up in some base window's cluster pool (locked or unlocked). */
  candidatesAssignedToWindow: number;
  /** How many candidates actually landed on a day in the returned assignment. */
  candidatesScheduled: number;
  /** Distinct locked place ids this call was asked to honour. */
  lockedRequested: number;
  /** Locked candidates that landed on their own pinned day. */
  lockedScheduled: number;
  /** Locked candidates that did not — see `lockedRejections` for why, one entry each. */
  lockedRejected: number;
  lockedRejections: readonly { placeId: string; reason: 'day_not_usable' | 'not_routable_to_target_base' }[];
  /** Every reason a unit (locked or not) never made it onto a day, tallied. */
  droppedByReason: Readonly<Record<string, number>>;
}

function emptyFunnel(candidatesEntering: number): AssignmentFunnel {
  return {
    candidatesEntering,
    candidatesAssignedToWindow: 0,
    candidatesScheduled: 0,
    lockedRequested: 0,
    lockedScheduled: 0,
    lockedRejected: 0,
    lockedRejections: [],
    droppedByReason: {},
  };
}

/**
 * A set of candidates that must travel together.
 *
 * Two independent reasons to bind places into one unit, and both are needed:
 *
 * - `Place.accessGroup` — "these have to happen on the same day". One road, one
 *   fee, one long drive out and back. Minaret Vista and Devils Postpile qualify
 *   even though you reach them by different means.
 * - `AccessUnit` — "these share one entry sequence". Devils Postpile and Rainbow
 *   Falls are one boarding; splitting them would pay for the shuttle twice.
 *
 * Clustering uses the coarser of the two, so a shared access sequence can never
 * be broken across days by a geographic decision.
 */
interface PlanningUnit {
  key: string;
  members: PlanningCandidate[];
  /** The member nearest base; the unit is clustered as if it were this place. */
  representativeId: string;
  maxDriveMinutes: number;
  topPriority: number;
}

function buildUnits(
  candidates: readonly PlanningCandidate[],
  unitByPlaceId: ReadonlyMap<string, AccessUnit>,
): PlanningUnit[] {
  const byKey = new Map<string, PlanningCandidate[]>();
  for (const candidate of candidates) {
    const key =
      candidate.place.accessGroup?.id ??
      unitByPlaceId.get(candidate.place.id)?.key ??
      candidate.place.id;
    const bucket = byKey.get(key);
    if (bucket) bucket.push(candidate);
    else byKey.set(key, [candidate]);
  }

  return [...byKey.entries()]
    .map(([key, members]) => {
      const sorted = [...members].sort(
        (a, b) =>
          a.travelMinutesFromBase - b.travelMinutesFromBase || a.place.id.localeCompare(b.place.id),
      );
      return {
        key,
        members: sorted,
        representativeId: sorted[0]!.place.id,
        /*
         * The furthest member, in whatever mode reaches it. Named `maxDrive`
         * historically and read as a distance ordering rather than as a budget,
         * which is why the rename below it is safe — nothing compares this to
         * `maxDailyDriveMinutes`.
         */
        maxDriveMinutes: Math.max(...sorted.map((member) => member.travelMinutesFromBase)),
        topPriority: Math.max(...sorted.map((member) => member.priority)),
      };
    })
    .sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Weather's entire authority over day assignment, in one function.
 *
 * It arrives *after* legality: `pool` already holds only the days on which every
 * reachable, open part of this cluster works, and every day in it is a day the
 * plan would have been happy with. So the choice here can never produce an
 * illegal itinerary — the worst it can do is pick a legal day that is slightly
 * less balanced than the one load-spreading would have chosen.
 *
 * It is also deliberately reluctant. Clustering has already spent effort making
 * each day geographically coherent, and every move trades some of that for a
 * prediction. `isMeaningfullyBetter` is the exchange rate: it takes a genuine
 * change of category — settled to showery, clear to shut-in — before anything
 * moves, so a plan cannot reshuffle over the difference between a 19% and a 21%
 * chance of rain, which is a difference no traveller could perceive and no
 * forecast could support.
 *
 * Ties fall back to the balanced choice, so identical inputs always produce the
 * identical plan.
 */
function preferByWeather(
  cluster: { placeIds: string[] },
  pool: readonly PlannedDay[],
  balanced: PlannedDay | undefined,
  weatherPreferenceFor: (placeIds: readonly string[], date: string) => number | null,
): PlannedDay | undefined {
  if (!balanced || pool.length < 2) return balanced;

  const incumbent = weatherPreferenceFor(cluster.placeIds, balanced.date);
  if (incumbent === null) return balanced;

  let best = balanced;
  let bestScore = incumbent;
  for (const day of pool) {
    const score = weatherPreferenceFor(cluster.placeIds, day.date);
    if (score === null) continue;
    // Strictly greater, so an equal score never displaces the balanced choice
    // and the comparison order cannot leak into the result.
    if (score > bestScore) {
      best = day;
      bestScore = score;
    }
  }

  return isMeaningfullyBetter(bestScore, incumbent) ? best : balanced;
}

/**
 * Below this a day cannot hold even the shortest stop plus the drive to it, so it
 * must not be handed a geographic cluster. Giving a 30-minute departure morning a
 * quarter of the trip's places strands them: they overflow into a second pass and
 * end up wherever there is room rather than where they belong.
 */
export const MIN_PLANNABLE_MINUTES = 90;

/**
 * Does this traveller want their hard days kept apart?
 *
 * §9.3 lists "long hikes on consecutive days when pace says otherwise" beside
 * "a museum every day" as things personalization must not do — and the planner
 * had a per-day intensity ceiling and nothing at all between days.
 *
 * Two answers make somebody exempt, and both are the traveller saying so
 * themselves: a fast pace is a request for a full week, and a preferred
 * intensity of `strenuous` is a request for hard days. Everybody else — which is
 * most people, including the balanced-pace hiker this exists for — gets a day's
 * recovery between climbs where the trip can afford one.
 */
export function wantsStrenuousDaysApart(profile: TravelerProfile): boolean {
  return profile.pace !== 'fast' && profile.derived.preferredPhysicalIntensity !== 'strenuous';
}

/**
 * ONE BASE'S OWN SLICE OF THE TRIP — LOCAL CLUSTERING, LOCAL DAY MATCHING.
 *
 * Exactly the algorithm `assignToDays` used to run once, globally, over every
 * eligible unit in the trip — unchanged in its own logic (k-medoids seeded on
 * the base, weight-to-day matching, hard-day spacing, weather preference) —
 * now run once per base window instead of once for the whole trip. Every unit
 * passed in has already been confirmed (by the caller, Stage C) to have real
 * routing evidence to *this* base specifically, so `resolveSubMatrix` here
 * only ever needs to resolve pairs among places that could plausibly share a
 * day, never a pair spanning two different bases the traveller is never at
 * the same time.
 *
 * The peeling fallback from the prior round is kept, deliberately, at this
 * scale: within one base's own small set of units, one genuinely-unroutable
 * pair is still a real, if rare, possibility (two satellites of the same base
 * that happen to have no measured leg between them), and dropping just that
 * one unit — never the whole window — is still the correct, non-fabricating
 * degradation `scheduleUnits` already established one stage later. What it
 * must never again do is run over units from *other* bases, which is what
 * turned one unroutable pair into "drop nearly everything".
 */
function assignWithinWindow(
  units: readonly PlanningUnit[],
  windowDays: readonly PlannedDay[],
  baseId: string,
  matrix: TravelTimeMatrix,
  travelLegs: TravelTimeMatrix | undefined,
  feasibleDates: ReadonlyMap<string, ReadonlySet<string>>,
  openDates: ReadonlyMap<string, ReadonlySet<string>>,
  weatherPreferenceFor: (placeIds: readonly string[], date: string) => number | null,
  separateStrenuousDays: boolean,
  assignmentByDay: Map<number, PlanningCandidate[]>,
  droppedByReason: Record<string, number>,
): void {
  if (units.length === 0 || windowDays.length === 0) return;

  const drop = (reason: string, count = 1) => {
    droppedByReason[reason] = (droppedByReason[reason] ?? 0) + count;
  };

  let clusterUnits = [...units];
  let resolvedForClustering = resolveSubMatrix(
    matrix,
    [baseId, ...clusterUnits.map((unit) => unit.representativeId)],
    travelLegs,
  );
  while (!resolvedForClustering.ok) {
    const unresolvedIds = new Set(resolvedForClustering.unresolved);
    const implicated = clusterUnits.filter((unit) => unresolvedIds.has(unit.representativeId));
    if (implicated.length === 0) {
      drop('local_cluster_unresolvable', clusterUnits.length);
      return;
    }
    const offPrimary = implicated.filter((unit) => !hasPoint(matrix, unit.representativeId));
    const pool = offPrimary.length > 0 ? offPrimary : implicated;
    const peeled = [...pool].sort((a, b) => a.representativeId.localeCompare(b.representativeId))[0]!;
    clusterUnits = clusterUnits.filter((unit) => unit !== peeled);
    drop('peeled_within_local_cluster');
    if (clusterUnits.length === 0) return;
    resolvedForClustering = resolveSubMatrix(
      matrix,
      [baseId, ...clusterUnits.map((unit) => unit.representativeId)],
      travelLegs,
    );
  }

  const clusters = clusterByTravelTime(
    resolvedForClustering.matrix,
    clusterUnits.map((unit) => unit.representativeId),
    { k: windowDays.length, baseId },
  );

  const unitByRepresentative = new Map(clusterUnits.map((unit) => [unit.representativeId, unit]));

  const clusterLoads = clusters.map((cluster) => {
    const members = cluster.memberIds
      .map((id) => unitByRepresentative.get(id))
      .filter((unit): unit is PlanningUnit => unit !== undefined);
    return {
      candidates: members.flatMap((unit) => unit.members),
      unitKeys: [...new Set(members.map((unit) => unit.key))],
      placeIds: members.flatMap((unit) => unit.members.map((member) => member.place.id)),
      weight: members.length > 0 ? Math.max(...members.map((unit) => unit.maxDriveMinutes)) : 0,
      topPriority: members.length > 0 ? Math.max(...members.map((unit) => unit.topPriority)) : 0,
      strenuous: members.some((unit) =>
        unit.members.some((member) => member.place.physicalIntensity === 'strenuous'),
      ),
    };
  });

  // Heaviest cluster to the roomiest day, both scoped to this window only.
  const orderedClusters = [...clusterLoads].sort(
    (a, b) => b.weight - a.weight || b.topPriority - a.topPriority,
  );
  const orderedDays = [...windowDays].sort(
    (a, b) => b.capacityMinutes - a.capacityMinutes || a.dayNumber - b.dayNumber,
  );

  const workableParts = (cluster: (typeof clusterLoads)[number], date: string) => {
    const reachableUnits = cluster.unitKeys.filter(
      (key) => feasibleDates.get(key)?.has(date) ?? true,
    ).length;
    const openPlaces = cluster.placeIds.filter(
      (placeId) => openDates.get(placeId)?.has(date) ?? true,
    ).length;
    return reachableUnits + openPlaces;
  };

  const clustersPerDay = new Map<number, number>();
  const strenuousDays = new Set<number>();

  for (const cluster of orderedClusters) {
    const best = Math.max(...orderedDays.map((day) => workableParts(cluster, day.date)));
    const workable = orderedDays.filter((day) => workableParts(cluster, day.date) === best);

    const spaced =
      separateStrenuousDays && cluster.strenuous
        ? workable.filter(
            (day) =>
              !strenuousDays.has(day.dayNumber) &&
              !strenuousDays.has(day.dayNumber - 1) &&
              !strenuousDays.has(day.dayNumber + 1),
          )
        : workable;
    const pool = spaced.length > 0 ? spaced : workable;

    const balanced = [...pool].sort(
      (a, b) => (clustersPerDay.get(a.dayNumber) ?? 0) - (clustersPerDay.get(b.dayNumber) ?? 0),
    )[0];
    const day = preferByWeather(cluster, pool, balanced, weatherPreferenceFor);
    if (!day) {
      drop('no_workable_day_in_window', cluster.candidates.length);
      continue;
    }
    clustersPerDay.set(day.dayNumber, (clustersPerDay.get(day.dayNumber) ?? 0) + 1);
    if (cluster.strenuous) strenuousDays.add(day.dayNumber);
    assignmentByDay.get(day.dayNumber)?.push(...cluster.candidates);
  }
}

/**
 * Groups places geographically and hands each group to a day.
 *
 * Restructured around one invariant the original single global clustering
 * pass violated: **a candidate at one base is never compared, for any
 * purpose, against a candidate at a different base.** A multi-base trip's
 * real routing evidence is inherently local — the primary matrix and
 * `travelLegs` both describe "this base and its own neighbourhood", never
 * "every base in the trip against every other" — and asking `clusterByTravelTime`
 * to resolve pairwise distances across the whole trip at once meant one
 * genuinely sparse pairing between two *unrelated* bases could peel away
 * units that had perfectly good local evidence, all the way down to almost
 * nothing (a real live Iceland run: 15 feasible candidates, 1 scheduled).
 *
 * Five stages, in order:
 *
 * 1. **Locked anchors placed first, directly onto their pinned day** — never
 *    subject to clustering surviving at all. A lock only fails to land here
 *    when its own pinned day is not usable or the day's own base genuinely
 *    cannot reach it; both are recorded in the returned `funnel`, never
 *    silent.
 * 2. **Base windows** — the trip's own usable days, partitioned by which
 *    base each one starts from. A loop that returns to an earlier base
 *    shares one window with its first stay there; a genuinely different
 *    stay is a different window.
 * 3. **Each remaining (unlocked, or lock-not-honoured) unit joins the one
 *    base window it has real evidence of reaching** — the nearest one when
 *    more than one qualifies, none when nowhere does.
 * 4. **Clustering runs once per window**, over only that window's own units
 *    and days — see `assignWithinWindow`.
 * 5. Untouched: within a window, weight-to-day matching, hard-day spacing
 *    and weather preference are the exact same logic this function always
 *    used, merely scoped smaller.
 */
export function assignToDays(
  eligible: readonly PlanningCandidate[],
  days: readonly PlannedDay[],
  matrix: TravelTimeMatrix,
  /**
   * The base a given date starts from.
   *
   * A function rather than a string, because on a multi-base trip the answer
   * changes partway through — and a day clustered around the base the traveller
   * has already left is a day of impossible drives that all look reasonable
   * individually.
   */
  baseIdFor: (date: string) => string,
  unitByPlaceId: ReadonlyMap<string, AccessUnit>,
  /** Unit key → the dates a legal way in exists. Absent means unconstrained. */
  feasibleDates: ReadonlyMap<string, ReadonlySet<string>>,
  /** Place id → the dates it is open long enough to visit. Absent means unconstrained. */
  openDates: ReadonlyMap<string, ReadonlySet<string>>,
  /**
   * How much a set of places wants a date, 0–1, or null when there is nothing
   * to go on. Null is the normal answer beyond the forecast horizon and it
   * means "leave the assignment exactly as geography made it" — which is the
   * only honest thing a fortnight of past Augusts can say about next Tuesday.
   */
  weatherPreferenceFor: (placeIds: readonly string[], date: string) => number | null = () => null,
  /**
   * Whether this traveller's hard days should be kept off each other's heels.
   * See `wantsStrenuousDaysApart` — §9.3's "long hikes on consecutive days when
   * pace says otherwise".
   */
  separateStrenuousDays = false,
  /** See `PlannerInput.travelLegs`. Consulted only once `matrix` itself cannot answer for a pair. */
  travelLegs?: TravelTimeMatrix,
  /**
   * Place id → the day number the traveller pinned it to. Optional and
   * additive: every caller before this field existed passes nothing, and
   * gets exactly the pre-lock-awareness behaviour (locks still work, via
   * `plan.ts`'s own post-assignment move — see that file's own header on
   * why leaving it in place is a harmless no-op once this stage already
   * placed things correctly).
   */
  locks?: ReadonlyMap<string, number>,
): { assignments: DayAssignment[]; funnel: AssignmentFunnel } {
  const funnel = emptyFunnel(eligible.length);
  const usableDays = days.filter((day) => day.capacityMinutes >= MIN_PLANNABLE_MINUTES);
  if (usableDays.length === 0 || eligible.length === 0) {
    return { assignments: days.map((day) => ({ day, candidates: [] })), funnel };
  }

  const assignmentByDay = new Map<number, PlanningCandidate[]>();
  for (const day of days) assignmentByDay.set(day.dayNumber, []);
  const droppedByReason: Record<string, number> = {};

  const allUnits = buildUnits(eligible, unitByPlaceId);

  // --- Stage B: locked units, placed before any clustering can decide whether ---
  // --- they survive it. ------------------------------------------------------
  const dayByNumber = new Map(usableDays.map((day) => [day.dayNumber, day]));
  const placedUnitKeys = new Set<string>();
  const lockedRejections: { placeId: string; reason: 'day_not_usable' | 'not_routable_to_target_base' }[] = [];
  let lockedRequested = 0;
  let lockedScheduled = 0;
  if (locks && locks.size > 0) {
    lockedRequested = new Set(locks.keys()).size;
    for (const unit of allUnits) {
      const lockedDayNumber = unit.members
        .map((member) => locks.get(member.place.id))
        .find((day): day is number => day !== undefined);
      if (lockedDayNumber === undefined) continue;

      const lockedPlaceId = unit.members.find((member) => locks.has(member.place.id))!.place.id;
      const targetDay = dayByNumber.get(lockedDayNumber);
      if (!targetDay) {
        lockedRejections.push({ placeId: lockedPlaceId, reason: 'day_not_usable' });
        continue;
      }
      const targetBaseId = baseIdFor(targetDay.date);
      const routable =
        tryLeg(matrix, targetBaseId, unit.representativeId) !== null ||
        (travelLegs !== undefined && tryLeg(travelLegs, targetBaseId, unit.representativeId) !== null);
      if (!routable) {
        lockedRejections.push({ placeId: lockedPlaceId, reason: 'not_routable_to_target_base' });
        continue;
      }

      assignmentByDay.get(targetDay.dayNumber)!.push(...unit.members);
      placedUnitKeys.add(unit.key);
      lockedScheduled += 1;
    }
  }

  const remainingUnits = allUnits.filter((unit) => !placedUnitKeys.has(unit.key));

  // --- Stage A: base windows — the trip's own days, partitioned by which ---
  // --- base each one starts from. --------------------------------------------
  const windowsByBase = new Map<string, PlannedDay[]>();
  for (const day of usableDays) {
    const baseId = baseIdFor(day.date);
    const bucket = windowsByBase.get(baseId);
    if (bucket) bucket.push(day);
    else windowsByBase.set(baseId, [day]);
  }

  // --- Stage C: each remaining unit joins the one base window it has real ---
  // --- evidence of reaching — the nearest one, never all of them at once. ---
  const windowUnits = new Map<string, PlanningUnit[]>();
  for (const baseId of windowsByBase.keys()) windowUnits.set(baseId, []);
  let candidatesAssignedToWindow = 0;
  for (const unit of remainingUnits) {
    let bestBaseId: string | null = null;
    let bestMinutes = Number.POSITIVE_INFINITY;
    for (const baseId of windowsByBase.keys()) {
      const leg = tryLeg(matrix, baseId, unit.representativeId) ?? (travelLegs ? tryLeg(travelLegs, baseId, unit.representativeId) : null);
      if (!leg) continue;
      if (leg.minutes < bestMinutes || (leg.minutes === bestMinutes && (bestBaseId === null || baseId.localeCompare(bestBaseId) < 0))) {
        bestBaseId = baseId;
        bestMinutes = leg.minutes;
      }
    }
    if (bestBaseId === null) {
      droppedByReason.no_base_window_reachable = (droppedByReason.no_base_window_reachable ?? 0) + unit.members.length;
      continue;
    }
    windowUnits.get(bestBaseId)!.push(unit);
    candidatesAssignedToWindow += unit.members.length;
  }

  // --- Stage D + E: cluster and match to a day, independently per window. ---
  for (const [baseId, windowDays] of windowsByBase) {
    const units = windowUnits.get(baseId) ?? [];
    assignWithinWindow(
      units,
      windowDays,
      baseId,
      matrix,
      travelLegs,
      feasibleDates,
      openDates,
      weatherPreferenceFor,
      separateStrenuousDays,
      assignmentByDay,
      droppedByReason,
    );
  }

  const assignments = days.map((day) => ({
    day,
    candidates: (assignmentByDay.get(day.dayNumber) ?? []).sort(
      (a, b) => b.priority - a.priority || a.place.id.localeCompare(b.place.id),
    ),
  }));

  const candidatesScheduled = assignments.reduce((sum, entry) => sum + entry.candidates.length, 0);
  funnel.candidatesAssignedToWindow = candidatesAssignedToWindow + lockedScheduled;
  funnel.candidatesScheduled = candidatesScheduled;
  funnel.lockedRequested = lockedRequested;
  funnel.lockedScheduled = lockedScheduled;
  funnel.lockedRejected = lockedRejections.length;
  funnel.lockedRejections = lockedRejections;
  funnel.droppedByReason = droppedByReason;

  return { assignments, funnel };
}
