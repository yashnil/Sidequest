/**
 * ENCODED POLYLINES, PRECISION 5.
 *
 * The compact geometry format every routing provider speaks (Google emits it
 * directly; Valhalla emits precision 6, which the adapter decodes to points
 * before this layer re-encodes at 5). One measured leg's shape is a few
 * hundred bytes rather than a few kilobytes of JSON coordinates.
 */
export interface LatLng {
  lat: number;
  lng: number;
}

const PRECISION = 1e5;

export function encodePolyline(points: readonly LatLng[]): string {
  let out = '';
  let lastLat = 0;
  let lastLng = 0;
  for (const point of points) {
    const lat = Math.round(point.lat * PRECISION);
    const lng = Math.round(point.lng * PRECISION);
    out += encodeValue(lat - lastLat) + encodeValue(lng - lastLng);
    lastLat = lat;
    lastLng = lng;
  }
  return out;
}

function encodeValue(value: number): string {
  let v = value < 0 ? ~(value << 1) : value << 1;
  let out = '';
  while (v >= 0x20) {
    out += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
    v >>= 5;
  }
  out += String.fromCharCode(v + 63);
  return out;
}

export function decodePolyline(encoded: string): LatLng[] {
  const points: LatLng[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  while (index < encoded.length) {
    let shift = 0;
    let result = 0;
    let byte: number;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;
    shift = 0;
    result = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;
    points.push({ lat: lat / PRECISION, lng: lng / PRECISION });
  }
  return points;
}

/**
 * Keep a route's shape without keeping every vertex: a leg of two thousand
 * points becomes a few hundred, which is more than a map at trip scale can
 * show. Endpoints are always kept.
 */
export function simplifyPolyline(points: readonly LatLng[], maxPoints = 400): LatLng[] {
  if (points.length <= maxPoints) return [...points];
  const step = (points.length - 1) / (maxPoints - 1);
  const out: LatLng[] = [];
  for (let i = 0; i < maxPoints; i += 1) out.push(points[Math.round(i * step)]!);
  return out;
}
