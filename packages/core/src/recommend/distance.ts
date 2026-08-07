import type { Coordinates } from '../schemas/common';

/**
 * Great-circle kilometres between two points.
 *
 * A local copy rather than an import from `@sidequest/geo`, and the reason is a
 * type rather than a preference: `haversineKm` takes a `GeoPoint`, which carries
 * an `id` because matrix rows and columns are keyed by it. A destination
 * shortlist has coordinates and no routing identity, and inventing one to
 * satisfy a signature would put a fake id into a comparison that has nothing to
 * do with routing.
 *
 * This is the only place in the recommendation layer that measures anything
 * geographic, and it measures exactly one thing: whether two suggestions are far
 * enough apart to be different suggestions. It is **never** a travel time and
 * never rendered as one — the standing rule that a straight line may decide what
 * to buy and may never be sold as a road.
 */
const EARTH_RADIUS_KM = 6371.0088;

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

export function separationKm(a: Coordinates, b: Coordinates): number {
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}
