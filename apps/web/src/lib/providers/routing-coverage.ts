/**
 * ROUTER COVERAGE IS KNOWN BEFORE THE REQUEST.
 *
 * A self-hosted Valhalla holds the tiles somebody built it with — this
 * deployment's holds Iceland. Asking it to route Dublin → Kilkenny costs a
 * request, a wait and a predictable "no suitable edges" for every one of 34
 * legs, which is what the live Ireland build did while its verification
 * deadline ran out. The operator declares what the router covers, and any pair
 * outside it is skipped at once — never asked, never counted as "no route".
 *
 *   SIDEQUEST_ROUTES_COVERAGE=IS                    country codes
 *   SIDEQUEST_ROUTES_COVERAGE=63.2,-24.6,66.6,-13.3  one bbox: south,west,north,east
 *   SIDEQUEST_ROUTES_COVERAGE=IS;41,-9.5,51.5,10     several, separated by ';'
 *   (unset)                                          coverage unknown: every pair is attempted, as before
 *
 * Nothing here is a fact about the world beyond a handful of generous country
 * bounding boxes used only to skip hopeless requests early. Undeclared
 * coverage never blocks anything.
 */
export interface Bbox {
  south: number;
  west: number;
  north: number;
  east: number;
}

/** Generous bounding boxes for the countries an operator is most likely to build tiles for. Only ever used to skip a request, never to place anything. */
const COUNTRY_BBOX: Record<string, Bbox> = {
  IS: { south: 63.2, west: -24.6, north: 66.6, east: -13.3 },
  IE: { south: 51.3, west: -10.8, north: 55.5, east: -5.9 },
  GB: { south: 49.8, west: -8.7, north: 60.9, east: 1.8 },
  PT: { south: 36.9, west: -9.6, north: 42.2, east: -6.1 },
  ES: { south: 35.9, west: -9.4, north: 43.9, east: 4.4 },
  FR: { south: 41.3, west: -5.2, north: 51.2, east: 9.6 },
  IT: { south: 36.6, west: 6.6, north: 47.1, east: 18.6 },
  CH: { south: 45.8, west: 5.9, north: 47.9, east: 10.5 },
  NO: { south: 57.9, west: 4.5, north: 71.3, east: 31.2 },
  NZ: { south: -47.4, west: 166.3, north: -34.3, east: 178.6 },
  JP: { south: 24.0, west: 122.9, north: 45.6, east: 146.0 },
  US: { south: 24.4, west: -125.0, north: 49.4, east: -66.9 },
  CA: { south: 41.7, west: -141.0, north: 83.2, east: -52.6 },
  AU: { south: -43.7, west: 112.9, north: -10.6, east: 153.7 },
  TZ: { south: -11.8, west: 29.3, north: -0.9, east: 40.5 },
  KE: { south: -4.7, west: 33.9, north: 5.1, east: 41.9 },
};

export interface RoutingCoverage {
  /** False when nothing was declared: every pair is attempted, exactly as before this existed. */
  declared: boolean;
  boxes: readonly Bbox[];
  label: string;
  covers(point: { lat: number; lng: number }): boolean;
  coversAll(points: readonly { lat: number; lng: number }[]): boolean;
}

function parseBox(part: string): Bbox | null {
  const numbers = part.split(',').map((n) => Number(n.trim()));
  if (numbers.length !== 4 || numbers.some((n) => !Number.isFinite(n))) return null;
  const [south, west, north, east] = numbers as [number, number, number, number];
  if (south >= north || west >= east) return null;
  return { south, west, north, east };
}

export function parseRoutingCoverage(raw: string | undefined): RoutingCoverage {
  const parts = (raw ?? '')
    .split(';')
    .map((p) => p.trim())
    .filter(Boolean);
  const boxes: Bbox[] = [];
  const labels: string[] = [];
  for (const part of parts) {
    const box = parseBox(part);
    if (box) {
      boxes.push(box);
      labels.push(`box ${part}`);
      continue;
    }
    const country = COUNTRY_BBOX[part.toUpperCase()];
    if (country) {
      boxes.push(country);
      labels.push(part.toUpperCase());
    }
  }
  const declared = boxes.length > 0;
  const covers = (point: { lat: number; lng: number }) => !declared || boxes.some((b) => point.lat >= b.south && point.lat <= b.north && point.lng >= b.west && point.lng <= b.east);
  return {
    declared,
    boxes,
    label: declared ? labels.join(', ') : 'not declared (every pair is attempted)',
    covers,
    coversAll: (points) => points.every(covers),
  };
}

export const ROUTES_COVERAGE_ENV = 'SIDEQUEST_ROUTES_COVERAGE';

export function routingCoverageFromEnv(env: Record<string, string | undefined> = process.env): RoutingCoverage {
  return parseRoutingCoverage(env[ROUTES_COVERAGE_ENV]);
}
