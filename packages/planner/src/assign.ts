import { clusterByTravelTime, type TravelTimeMatrix } from '@sidequest/geo';
import type { PlannedDay } from './windows';
import type { PlanningCandidate } from './types';

export interface DayAssignment {
  day: PlannedDay;
  candidates: PlanningCandidate[];
}

/**
 * A set of candidates that must travel together — either one place on its own, or
 * everything behind a shared gate such as the Reds Meadow shuttle.
 */
interface PlanningUnit {
  key: string;
  members: PlanningCandidate[];
  /** The member nearest base; the unit is clustered as if it were this place. */
  representativeId: string;
  maxDriveMinutes: number;
  topPriority: number;
}

function buildUnits(candidates: readonly PlanningCandidate[]): PlanningUnit[] {
  const byKey = new Map<string, PlanningCandidate[]>();
  for (const candidate of candidates) {
    const key = candidate.place.accessGroup?.id ?? candidate.place.id;
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
): DayAssignment[] {
  const usableDays = days.filter((day) => day.capacityMinutes >= MIN_PLANNABLE_MINUTES);
  if (usableDays.length === 0 || eligible.length === 0) {
    return days.map((day) => ({ day, candidates: [] }));
  }

  const units = buildUnits(eligible);
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

  orderedClusters.forEach((cluster, index) => {
    const day = orderedDays[index % orderedDays.length];
    if (!day) return;
    const bucket = assignmentByDay.get(day.dayNumber);
    if (bucket) bucket.push(...cluster.candidates);
  });

  return days.map((day) => ({
    day,
    candidates: (assignmentByDay.get(day.dayNumber) ?? []).sort(
      (a, b) => b.priority - a.priority || a.place.id.localeCompare(b.place.id),
    ),
  }));
}
