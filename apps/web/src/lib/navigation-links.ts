/**
 * MAP → NAVIGATION HANDOFF.
 *
 * Documented public URL schemes only — no key, no request, nothing stored.
 * The caller decides eligibility: a place gets a link only when its position
 * is verified evidence, a leg only when it was measured between two verified
 * points. Nothing here invents a coordinate.
 *
 * V9 §11 — two Apple forms. iOS 18.4 / macOS 15.4 introduced the unified
 * `maps.apple.com/directions` and `/place` URLs (`mode=`, repeatable
 * `waypoint=`); the legacy `?daddr=` / `?ll=&q=` form is still documented and
 * is what an older phone understands. Both are emitted so the traveller's
 * surface can show the unified link and keep the legacy one beside it, and
 * `copyable` gives the plain text a paper packet or a clipboard wants.
 */
export interface NavPoint {
  lat: number;
  lng: number;
  name?: string;
}

function coord(v: number): string {
  return v.toFixed(6).replace(/\.?0+$/, '');
}

/** `lat,lng` with six decimals and no trailing zeros — the pair every scheme accepts. */
export function coordinatePair(point: Pick<NavPoint, 'lat' | 'lng'>): string {
  return `${coord(point.lat)},${coord(point.lng)}`;
}

export interface PlaceLinks {
  google: string;
  /** Apple unified (`/place?coordinate=`), iOS 18.4+ / macOS 15.4+. */
  apple: string;
  /** Apple legacy (`?ll=&q=`), for older devices. */
  appleLegacy: string;
}

export function placeNavigationLinks(point: NavPoint): PlaceLinks {
  const pair = coordinatePair(point);
  const google = new URL('https://www.google.com/maps/search/');
  google.searchParams.set('api', '1');
  google.searchParams.set('query', pair);
  const apple = new URL('https://maps.apple.com/place');
  apple.searchParams.set('coordinate', pair);
  if (point.name) apple.searchParams.set('name', point.name);
  const legacy = new URL('https://maps.apple.com/');
  legacy.searchParams.set('ll', pair);
  if (point.name) legacy.searchParams.set('q', point.name);
  return { google: google.toString(), apple: apple.toString(), appleLegacy: legacy.toString() };
}

export type NavMode = 'driving' | 'walking' | 'transit';

export interface DirectionsLinks {
  google: string;
  /** Apple unified (`/directions?source=&destination=&mode=`). */
  apple: string;
  /** Apple legacy (`?saddr=&daddr=&dirflg=`). */
  appleLegacy: string;
}

function appleLegacyFlag(mode: NavMode): string {
  return mode === 'walking' ? 'w' : mode === 'transit' ? 'r' : 'd';
}

export function legDirectionsLinks(from: NavPoint, to: NavPoint, mode: NavMode = 'driving'): DirectionsLinks {
  const a = coordinatePair(from);
  const b = coordinatePair(to);
  const google = new URL('https://www.google.com/maps/dir/');
  google.searchParams.set('api', '1');
  google.searchParams.set('origin', a);
  google.searchParams.set('destination', b);
  google.searchParams.set('travelmode', mode);
  const apple = new URL('https://maps.apple.com/directions');
  apple.searchParams.set('source', a);
  apple.searchParams.set('destination', b);
  apple.searchParams.set('mode', mode);
  const legacy = new URL('https://maps.apple.com/');
  legacy.searchParams.set('saddr', a);
  legacy.searchParams.set('daddr', b);
  legacy.searchParams.set('dirflg', appleLegacyFlag(mode));
  return { google: google.toString(), apple: apple.toString(), appleLegacy: legacy.toString() };
}

/**
 * The text a traveller copies or reads off paper: the coordinate pair, then
 * the name when there is one. Coordinates first because that is the part a
 * map app's search box needs verbatim; the name is for the human.
 */
export function copyable(point: Pick<NavPoint, 'lat' | 'lng'>, name?: string): string {
  const pair = coordinatePair(point);
  const label = (name ?? '').trim();
  return label ? `${pair} · ${label}` : pair;
}

export function navModeFor(transportMode: string): NavMode {
  if (transportMode === 'walk' || transportMode === 'bicycle') return 'walking';
  if (transportMode === 'rail' || transportMode === 'public_bus' || transportMode === 'ferry' || transportMode === 'shuttle') return 'transit';
  return 'driving';
}
