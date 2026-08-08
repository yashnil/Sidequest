/**
 * The only geometry the benchmark does, written out rather than imported.
 *
 * `@sidequest/geo` has a haversine, and using it would be harmless — but that
 * package also exports the travel-time clusterer and the stop orderer, which are
 * two of the four engines under test. Depending on the package at all would make
 * "did the baseline reach for the optimiser?" a question about discipline rather
 * than a question about the dependency graph. Ten lines is a cheap price for an
 * answer a build tool can give.
 */

const EARTH_RADIUS_KM = 6371;

export function haversineKm(
  from: { latitude: number; longitude: number },
  to: { latitude: number; longitude: number },
): number {
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = toRadians(to.latitude - from.latitude);
  const dLon = toRadians(to.longitude - from.longitude);
  const lat1 = toRadians(from.latitude);
  const lat2 = toRadians(to.latitude);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.sin(dLon / 2) * Math.sin(dLon / 2) * Math.cos(lat1) * Math.cos(lat2);
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * The floor on how long a journey could possibly take.
 *
 * Used in exactly one direction: to prove that a gap in a plan is too short for
 * a leg nobody measured. A straight line at an optimistic speed is a lower
 * bound, so exceeding it proves impossibility; falling under it proves nothing,
 * and the check returns `unknown` rather than inventing a travel time.
 */
export function fastestPossibleMinutes(km: number, groundSpeedKmh: number): number {
  if (km <= 0) return 0;
  return Math.ceil((km / groundSpeedKmh) * 60);
}

/** Every consecutive pair of an array, in order. */
export function consecutivePairs<T>(items: readonly T[]): [T, T][] {
  const pairs: [T, T][] = [];
  for (let index = 1; index < items.length; index += 1) {
    const previous = items[index - 1];
    const current = items[index];
    if (previous !== undefined && current !== undefined) pairs.push([previous, current]);
  }
  return pairs;
}

/** Every calendar date from start to end inclusive, stepped in UTC. */
export function eachDate(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  const cursor = new Date(`${startDate}T00:00:00Z`);
  const last = new Date(`${endDate}T00:00:00Z`);
  if (Number.isNaN(cursor.getTime()) || Number.isNaN(last.getTime())) return dates;

  // Stepped in UTC because these are labels on a calendar rather than instants.
  // Reading them locally is how a trip gains or loses a day across a timezone
  // boundary, and how a Thursday-only ferry silently becomes a Wednesday one.
  let guard = 0;
  while (cursor <= last && guard < 400) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    guard += 1;
  }
  return dates;
}
