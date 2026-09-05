/**
 * MAP → NAVIGATION HANDOFF.
 *
 * Documented public URL schemes only — no key, no request, nothing stored.
 * The caller decides eligibility: a place gets a link only when its position
 * is verified evidence, a leg only when it was measured between two verified
 * points. Nothing here invents a coordinate.
 */
export interface NavPoint {
  lat: number;
  lng: number;
  name?: string;
}

function coord(v: number): string {
  return v.toFixed(6).replace(/\.?0+$/, '');
}

export function placeNavigationLinks(point: NavPoint): { google: string; apple: string } {
  const pair = `${coord(point.lat)},${coord(point.lng)}`;
  const google = new URL('https://www.google.com/maps/search/');
  google.searchParams.set('api', '1');
  google.searchParams.set('query', pair);
  const apple = new URL('https://maps.apple.com/');
  apple.searchParams.set('ll', pair);
  if (point.name) apple.searchParams.set('q', point.name);
  return { google: google.toString(), apple: apple.toString() };
}

export type NavMode = 'driving' | 'walking' | 'transit';

export function legDirectionsLinks(from: NavPoint, to: NavPoint, mode: NavMode = 'driving'): { google: string; apple: string } {
  const a = `${coord(from.lat)},${coord(from.lng)}`;
  const b = `${coord(to.lat)},${coord(to.lng)}`;
  const google = new URL('https://www.google.com/maps/dir/');
  google.searchParams.set('api', '1');
  google.searchParams.set('origin', a);
  google.searchParams.set('destination', b);
  google.searchParams.set('travelmode', mode);
  const apple = new URL('https://maps.apple.com/');
  apple.searchParams.set('saddr', a);
  apple.searchParams.set('daddr', b);
  apple.searchParams.set('dirflg', mode === 'walking' ? 'w' : mode === 'transit' ? 'r' : 'd');
  return { google: google.toString(), apple: apple.toString() };
}

export function navModeFor(transportMode: string): NavMode {
  if (transportMode === 'walk' || transportMode === 'bicycle') return 'walking';
  if (transportMode === 'rail' || transportMode === 'public_bus' || transportMode === 'ferry' || transportMode === 'shuttle') return 'transit';
  return 'driving';
}
