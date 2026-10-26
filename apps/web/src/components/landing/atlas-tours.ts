/**
 * THE LANDING GLOBE'S EXAMPLE ROUTES.
 *
 * Four trip *shapes* the front page flies between while a visitor reads. Each
 * stop is a real town or park at its real position (rounded to ~1 km), because
 * the globe is real geography and a pin in the sea would be a lie told on the
 * first screen. What they are not is a plan: the line between them is a
 * great-circle sketch, not a road, the order is one sensible shape among
 * several, and the caption says "example" every time it is shown. Nothing
 * here is researched, timed or verified, and nothing downstream reads it.
 *
 * Import-free data so the tour logic can be tested without a browser.
 */
export interface AtlasTourStop {
  name: string;
  lat: number;
  lng: number;
}

export interface AtlasTour {
  id: string;
  /** What the visitor would type — also what the "Plan this" link pre-fills. */
  prompt: string;
  /** One short line of what makes the shape interesting. Never a claim of quality or time. */
  note: string;
  days: number;
  stops: AtlasTourStop[];
  /** Camera for this tour: centre, zoom, pitch, bearing. */
  camera: { lng: number; lat: number; zoom: number; pitch: number; bearing: number };
}

export const ATLAS_TOURS: readonly AtlasTour[] = [
  {
    id: 'iceland',
    prompt: 'Iceland ring road',
    note: 'Black sand, glacier lagoons and the long way round.',
    days: 9,
    stops: [
      { name: 'Reykjavík', lat: 64.147, lng: -21.943 },
      { name: 'Vík', lat: 63.419, lng: -19.006 },
      { name: 'Höfn', lat: 64.254, lng: -15.208 },
      { name: 'Egilsstaðir', lat: 65.265, lng: -14.395 },
      { name: 'Akureyri', lat: 65.689, lng: -18.126 },
      { name: 'Borgarnes', lat: 64.538, lng: -21.921 },
    ],
    camera: { lng: -18.6, lat: 64.75, zoom: 5.4, pitch: 42, bearing: -8 },
  },
  {
    id: 'japan',
    prompt: 'Ten days in Japan',
    note: 'Two cities, a mountain lake and an old capital between them.',
    days: 10,
    stops: [
      { name: 'Tokyo', lat: 35.681, lng: 139.767 },
      { name: 'Hakone', lat: 35.232, lng: 139.107 },
      { name: 'Kyoto', lat: 35.012, lng: 135.768 },
      { name: 'Nara', lat: 34.685, lng: 135.805 },
      { name: 'Osaka', lat: 34.694, lng: 135.502 },
    ],
    camera: { lng: 137.6, lat: 35.1, zoom: 6.1, pitch: 45, bearing: 12 },
  },
  {
    id: 'east-africa',
    prompt: 'Kenya and Tanzania',
    note: 'One border, two great parks and a crater floor.',
    days: 12,
    stops: [
      { name: 'Nairobi', lat: -1.292, lng: 36.822 },
      { name: 'Maasai Mara', lat: -1.49, lng: 35.143 },
      { name: 'Serengeti', lat: -2.333, lng: 34.833 },
      { name: 'Ngorongoro', lat: -3.2, lng: 35.5 },
      { name: 'Arusha', lat: -3.387, lng: 36.683 },
    ],
    camera: { lng: 35.8, lat: -2.25, zoom: 6.2, pitch: 40, bearing: -15 },
  },
  {
    id: 'alps',
    prompt: 'Swiss Alps by train',
    note: 'Lakes first, then up into the valleys under the big peaks.',
    days: 7,
    stops: [
      { name: 'Zürich', lat: 47.377, lng: 8.541 },
      { name: 'Lucerne', lat: 47.05, lng: 8.309 },
      { name: 'Interlaken', lat: 46.686, lng: 7.863 },
      { name: 'Zermatt', lat: 46.021, lng: 7.749 },
    ],
    camera: { lng: 8.1, lat: 46.68, zoom: 7.3, pitch: 50, bearing: 20 },
  },
];

/**
 * A great-circle arc through the stops, densified so the drawn line bends on
 * the globe like a route sketch rather than cutting chords through it. Slerp
 * between unit vectors; `steps` points per leg.
 */
export function arcThrough(stops: readonly AtlasTourStop[], steps = 24): [number, number][] {
  const rad = Math.PI / 180;
  const toVec = (s: AtlasTourStop) => {
    const la = s.lat * rad;
    const lo = s.lng * rad;
    return [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)] as const;
  };
  const out: [number, number][] = [];
  for (let i = 0; i < stops.length - 1; i++) {
    const a = toVec(stops[i]!);
    const b = toVec(stops[i + 1]!);
    const dot = Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
    const omega = Math.acos(dot);
    for (let k = i === 0 ? 0 : 1; k <= steps; k++) {
      const t = k / steps;
      const s = omega < 1e-9 ? 0 : Math.sin(omega);
      const wa = s === 0 ? 1 - t : Math.sin((1 - t) * omega) / s;
      const wb = s === 0 ? t : Math.sin(t * omega) / s;
      const x = wa * a[0] + wb * b[0];
      const y = wa * a[1] + wb * b[1];
      const z = wa * a[2] + wb * b[2];
      out.push([Math.atan2(y, x) / rad, Math.atan2(z, Math.hypot(x, y)) / rad]);
    }
  }
  return out;
}

/**
 * Fraction of the drawn line at which each stop is reached (0 for the first,
 * 1 for the last), by great-circle length — which is what MapLibre's
 * `line-progress` measures, so a waypoint lights exactly as the line arrives.
 */
export function stopProgress(stops: readonly AtlasTourStop[]): number[] {
  if (stops.length < 2) return stops.map(() => 0);
  const rad = Math.PI / 180;
  const leg = (a: AtlasTourStop, b: AtlasTourStop) => {
    const h = Math.sin(((b.lat - a.lat) * rad) / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(((b.lng - a.lng) * rad) / 2) ** 2;
    return 2 * Math.asin(Math.sqrt(h));
  };
  const cumulative = [0];
  for (let i = 1; i < stops.length; i++) cumulative.push(cumulative[i - 1]! + leg(stops[i - 1]!, stops[i]!));
  const total = cumulative[cumulative.length - 1]!;
  return cumulative.map((d) => (total > 0 ? d / total : 0));
}
