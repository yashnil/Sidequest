/**
 * Deep links into the map app the traveller already has.
 *
 * Sidequest draws no map. What it can do — and what a traveller on a pavement
 * actually wants — is hand the day's ordered stops to Google Maps or Apple Maps
 * and let their own navigation take it from there.
 *
 * Three things this file is careful about.
 *
 * **It is a URL scheme, not an API.** These are the documented public link
 * formats. No key, no request, no response to store. That matters here because
 * `.claude-private/BLOCKER-google-terms.md` rules out the Maps Platform APIs for
 * this product entirely — but a link is not Maps Content, and the coordinates
 * travelling in it are OpenStreetMap's, already attributed on the page.
 *
 * **It never invents a stop.** A place whose coordinates the compiled region does
 * not carry is dropped from the link and counted, so the caller can say the link
 * is short rather than quietly hand over a shorter day.
 *
 * **It is pure.** No clock, no network, no I/O — which is what lets it be tested
 * as a function and keeps it clear of the render-purity rules.
 */

export interface MapStop {
  id: string;
  name: string;
  lat: number;
  lng: number;
}

/**
 * Google caps a directions URL at nine intermediate waypoints, on top of the
 * origin and the destination. Past that it silently drops the tail, so the link
 * builder truncates deliberately and reports how many it left behind.
 */
export const MAX_INTERMEDIATE_WAYPOINTS = 9;

export type MapTravelMode = 'driving' | 'walking' | 'transit';

export interface DayRouteLinks {
  google: string;
  apple: string;
  /** How many stops the link actually carries. */
  included: number;
  /** Stops left out because the URL cannot hold them. Zero is the normal case. */
  omitted: number;
}

/** Six decimal places is ~0.1 m. Beyond that is noise, and it bloats the URL. */
function coord(value: number): string {
  return value.toFixed(6).replace(/\.?0+$/, '');
}

function pair(stop: MapStop): string {
  return `${coord(stop.lat)},${coord(stop.lng)}`;
}

/**
 * Builds the two deep links for one day's ordered stops.
 *
 * Returns `null` for fewer than two stops: a "directions" link from a place to
 * itself is not a route, and a single-stop day is better served by the place
 * card's own link than by a navigation URL that does nothing.
 */
export function dayRouteLinks(
  stops: readonly MapStop[],
  mode: MapTravelMode = 'driving',
): DayRouteLinks | null {
  if (stops.length < 2) return null;

  const origin = stops[0]!;
  const destination = stops[stops.length - 1]!;
  const middle = stops.slice(1, -1);
  const carried = middle.slice(0, MAX_INTERMEDIATE_WAYPOINTS);
  const omitted = middle.length - carried.length;

  const google = new URL('https://www.google.com/maps/dir/');
  google.searchParams.set('api', '1');
  google.searchParams.set('origin', pair(origin));
  google.searchParams.set('destination', pair(destination));
  if (carried.length > 0) {
    google.searchParams.set('waypoints', carried.map(pair).join('|'));
  }
  google.searchParams.set('travelmode', mode);

  /**
   * Apple's scheme has no multi-waypoint form, so the link carries the day's
   * last leg rather than pretending to carry the day. Named as such by the
   * caller — an "open in Apple Maps" that silently drops six stops is worse
   * than one that says it is the final leg.
   */
  const apple = new URL('https://maps.apple.com/');
  apple.searchParams.set('saddr', pair(origin));
  apple.searchParams.set('daddr', pair(destination));
  apple.searchParams.set('dirflg', mode === 'walking' ? 'w' : mode === 'transit' ? 'r' : 'd');

  return {
    google: google.toString(),
    apple: apple.toString(),
    included: 1 + carried.length + 1,
    omitted,
  };
}

/**
 * The travel mode to hand the map app, from the modes the day actually used.
 *
 * Driving wins whenever the day drives at all, because that is the leg a
 * traveller most needs turn-by-turn for. A day that never drives and rides
 * something scheduled asks for transit; everything else walks.
 */
export function mapModeFor(modes: readonly string[]): MapTravelMode {
  if (modes.includes('drive') || modes.includes('rideshare') || modes.includes('private_transfer')) {
    return 'driving';
  }
  if (modes.some((mode) => ['rail', 'public_bus', 'shuttle', 'ferry'].includes(mode))) {
    return 'transit';
  }
  return 'walking';
}
