import { leg, matrixIndex } from './matrix';
import type { TravelTimeMatrix } from './types';

export interface Cluster {
  /** The member most central to the group, by total travel time to the others. */
  medoidId: string;
  memberIds: string[];
}

export interface ClusterOptions {
  /** How many groups to produce. Clamped to the number of points available. */
  k: number;
  /**
   * Trip base. Not clustered itself; used to seed and to order the results so
   * near-to-base groups come first.
   */
  baseId?: string;
  maxIterations?: number;
}

/**
 * k-medoids over the travel-time matrix.
 *
 * Medoids rather than centroids because the only distance available is a matrix
 * of real travel times — there is no meaningful "average" of two road journeys,
 * but there is a most-central actual place. Working on travel time rather than
 * straight-line distance is what stops the planner pairing two points that look
 * close on a map but sit on opposite sides of a ridge with an hour of road
 * between them.
 *
 * Fully deterministic: farthest-point seeding, and every tie broken by id.
 */
export function clusterByTravelTime(
  matrix: TravelTimeMatrix,
  ids: readonly string[],
  options: ClusterOptions,
): Cluster[] {
  const points = [...new Set(ids)].sort();
  for (const id of points) matrixIndex(matrix, id); // fail early on unknown ids

  const k = Math.max(1, Math.min(options.k, points.length));
  if (points.length === 0) return [];
  if (points.length <= k) {
    return points.map((id) => ({ medoidId: id, memberIds: [id] }));
  }

  const distance = (a: string, b: string) => leg(matrix, a, b).minutes;

  // --- Seed: farthest-point sampling ------------------------------------
  const medoids: string[] = [];
  const first = options.baseId
    ? [...points].sort(
        (a, b) => distance(options.baseId!, b) - distance(options.baseId!, a) || a.localeCompare(b),
      )[0]!
    : [...points].sort(
        (a, b) => totalDistance(b, points, distance) - totalDistance(a, points, distance) || a.localeCompare(b),
      )[0]!;
  medoids.push(first);

  while (medoids.length < k) {
    let best: string | null = null;
    let bestScore = -1;
    for (const candidate of points) {
      if (medoids.includes(candidate)) continue;
      const score = Math.min(...medoids.map((medoid) => distance(candidate, medoid)));
      if (score > bestScore || (score === bestScore && best !== null && candidate < best)) {
        best = candidate;
        bestScore = score;
      }
    }
    if (best === null) break;
    medoids.push(best);
  }

  // --- Alternate assignment and medoid update ---------------------------
  const maxIterations = options.maxIterations ?? 24;
  let assignment = assign(points, medoids, distance);

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    const updated = medoids.map((medoid, index) => {
      const members = assignment[index] ?? [];
      if (members.length === 0) return medoid;
      return [...members].sort(
        (a, b) => totalDistance(a, members, distance) - totalDistance(b, members, distance) || a.localeCompare(b),
      )[0]!;
    });

    if (updated.every((id, index) => id === medoids[index])) break;
    for (let index = 0; index < updated.length; index += 1) medoids[index] = updated[index]!;
    assignment = assign(points, medoids, distance);
  }

  const clusters = medoids
    .map((medoidId, index) => ({ medoidId, memberIds: [...(assignment[index] ?? [])].sort() }))
    .filter((cluster) => cluster.memberIds.length > 0);

  // Nearest-to-base group first, so day one does not open with the longest drive.
  const base = options.baseId;
  return clusters.sort((a, b) => {
    if (base) {
      const delta = distance(base, a.medoidId) - distance(base, b.medoidId);
      if (delta !== 0) return delta;
    }
    return a.medoidId.localeCompare(b.medoidId);
  });
}

function assign(
  points: readonly string[],
  medoids: readonly string[],
  distance: (a: string, b: string) => number,
): string[][] {
  const buckets: string[][] = medoids.map(() => []);
  for (const point of points) {
    let bestIndex = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let index = 0; index < medoids.length; index += 1) {
      const medoid = medoids[index]!;
      const value = distance(point, medoid);
      const isBetter =
        value < bestDistance ||
        (value === bestDistance && medoid.localeCompare(medoids[bestIndex]!) < 0);
      if (isBetter) {
        bestDistance = value;
        bestIndex = index;
      }
    }
    buckets[bestIndex]!.push(point);
  }
  return buckets;
}

function totalDistance(
  id: string,
  members: readonly string[],
  distance: (a: string, b: string) => number,
): number {
  return members.reduce((sum, member) => sum + distance(id, member), 0);
}
