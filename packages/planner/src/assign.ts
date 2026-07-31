import { clusterByTravelTime, type TravelTimeMatrix } from '@sidequest/geo';
import type { AccessUnit } from './access';
import type { PlannedDay } from './windows';
import type { PlanningCandidate } from './types';

export interface DayAssignment {
  day: PlannedDay;
  candidates: PlanningCandidate[];
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
          a.driveMinutesFromBase - b.driveMinutesFromBase || a.place.id.localeCompare(b.place.id),
      );
      return {
        key,
        members: sorted,
        representativeId: sorted[0]!.place.id,
        maxDriveMinutes: Math.max(...sorted.map((member) => member.driveMinutesFromBase)),
        topPriority: Math.max(...sorted.map((member) => member.priority)),
      };
    })
    .sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Below this a day cannot hold even the shortest stop plus the drive to it, so it
 * must not be handed a geographic cluster. Giving a 30-minute departure morning a
 * quarter of the trip's places strands them: they overflow into a second pass and
 * end up wherever there is room rather than where they belong.
 */
const MIN_PLANNABLE_MINUTES = 90;

/**
 * Groups places geographically and hands each group to a day.
 *
 * Three decisions carry the quality here:
 *
 * 1. Clustering runs on travel time, not straight-line distance, and on *units*
 *    rather than places — so anything behind a shared gate is guaranteed to land
 *    in the same group and therefore on the same day.
 * 2. Only days that can genuinely hold a stop take part, so a cluster is never
 *    handed to a departure morning that has half an hour in it.
 * 3. Groups are matched to days by weight: the cluster that reaches furthest from
 *    base is paired with the day that has the most hours in it. That is what stops
 *    a two-hour round trip being handed to the arrival afternoon.
 */
export function assignToDays(
  eligible: readonly PlanningCandidate[],
  days: readonly PlannedDay[],
  matrix: TravelTimeMatrix,
  baseId: string,
  unitByPlaceId: ReadonlyMap<string, AccessUnit>,
  /** Unit key → the dates a legal way in exists. Absent means unconstrained. */
  feasibleDates: ReadonlyMap<string, ReadonlySet<string>>,
  /** Place id → the dates it is open long enough to visit. Absent means unconstrained. */
  openDates: ReadonlyMap<string, ReadonlySet<string>>,
): DayAssignment[] {
  const usableDays = days.filter((day) => day.capacityMinutes >= MIN_PLANNABLE_MINUTES);
  if (usableDays.length === 0 || eligible.length === 0) {
    return days.map((day) => ({ day, candidates: [] }));
  }

  const units = buildUnits(eligible, unitByPlaceId);
  const clusters = clusterByTravelTime(
    matrix,
    units.map((unit) => unit.representativeId),
    { k: usableDays.length, baseId },
  );

  const unitByRepresentative = new Map(units.map((unit) => [unit.representativeId, unit]));

  const clusterLoads = clusters.map((cluster) => {
    const members = cluster.memberIds
      .map((id) => unitByRepresentative.get(id))
      .filter((unit): unit is PlanningUnit => unit !== undefined);
    return {
      candidates: members.flatMap((unit) => unit.members),
      // The access units inside this geographic cluster, so day assignment can
      // ask "can this actually be reached on that date?".
      unitKeys: [
        ...new Set(
          members.flatMap((unit) =>
            unit.members.map((member) => unitByPlaceId.get(member.place.id)?.key ?? unit.key),
          ),
        ),
      ],
      placeIds: members.flatMap((unit) => unit.members.map((member) => member.place.id)),
      weight: members.length > 0 ? Math.max(...members.map((unit) => unit.maxDriveMinutes)) : 0,
      topPriority: members.length > 0 ? Math.max(...members.map((unit) => unit.topPriority)) : 0,
    };
  });

  // Heaviest cluster to the roomiest day.
  const orderedClusters = [...clusterLoads].sort(
    (a, b) => b.weight - a.weight || b.topPriority - a.topPriority,
  );
  const orderedDays = [...usableDays].sort(
    (a, b) => b.capacityMinutes - a.capacityMinutes || a.dayNumber - b.dayNumber,
  );

  const assignmentByDay = new Map<number, PlanningCandidate[]>();
  for (const day of days) assignmentByDay.set(day.dayNumber, []);

  /**
   * How much of a cluster genuinely works on a given date — counting both
   * halves of the question, because they fail independently.
   *
   * Without the access half, geography alone decides the day and a
   * shuttle-served valley lands on a Tuesday the shuttle does not run. Without
   * the hours half, a state park that shuts on Wednesdays lands on Wednesday.
   * Either way the packer then rejects it and it spills into an overflow pass,
   * by which time every other day is full of auto-picks — and a traveller's
   * hand-picked stop loses to a weekday.
   */
  const workableParts = (cluster: (typeof clusterLoads)[number], date: string) => {
    const reachableUnits = cluster.unitKeys.filter(
      (key) => feasibleDates.get(key)?.has(date) ?? true,
    ).length;
    const openPlaces = cluster.placeIds.filter(
      (placeId) => openDates.get(placeId)?.has(date) ?? true,
    ).length;
    return reachableUnits + openPlaces;
  };

  // Fewest clusters so far wins, and `sort` is stable, so the capacity order
  // already baked into `orderedDays` breaks every tie. Fully deterministic.
  const clustersPerDay = new Map<number, number>();

  for (const cluster of orderedClusters) {
    const best = Math.max(...orderedDays.map((day) => workableParts(cluster, day.date)));
    const pool = orderedDays.filter((day) => workableParts(cluster, day.date) === best);
    const day = [...pool].sort(
      (a, b) => (clustersPerDay.get(a.dayNumber) ?? 0) - (clustersPerDay.get(b.dayNumber) ?? 0),
    )[0];
    if (!day) continue;
    clustersPerDay.set(day.dayNumber, (clustersPerDay.get(day.dayNumber) ?? 0) + 1);
    assignmentByDay.get(day.dayNumber)?.push(...cluster.candidates);
  }

  return days.map((day) => ({
    day,
    candidates: (assignmentByDay.get(day.dayNumber) ?? []).sort(
      (a, b) => b.priority - a.priority || a.place.id.localeCompare(b.place.id),
    ),
  }));
}
