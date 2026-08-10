import { describe, expect, it } from 'vitest';
import {
  chooseScaleBar,
  EQUATORIAL_CIRCUMFERENCE_KM,
  fitMercator,
  geodesicRing,
  latitudeAt,
  longitudeAt,
  MAX_MERCATOR_LATITUDE,
  mercatorX,
  mercatorY,
  type GeoPoint,
} from './map-projection';

/**
 * A PROJECTION IS ARITHMETIC AND IS TESTED AS ARITHMETIC.
 *
 * The figure that uses this cannot be checked by looking at it — a projection
 * that is subtly wrong produces a picture that is subtly wrong, and a picture
 * that is subtly wrong looks exactly like a picture. So the properties are
 * asserted here, against closed-form values and against an independently written
 * distance formula rather than against the module's own.
 *
 * The haversine below is deliberately a second implementation. Reusing the one
 * the product uses would make this a test that the module agrees with itself.
 */
const EARTH_RADIUS_KM = 6371.0088;

function haversineKm(a: GeoPoint, b: GeoPoint): number {
  const toRad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toRad;
  const dLng = (b.lng - a.lng) * toRad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

function pixelDistance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

const INSETS = { top: 20, right: 20, bottom: 20, left: 20 };

describe('the Web Mercator forward transform', () => {
  it('puts the origin in the middle and the antimeridian at the edges', () => {
    expect(mercatorX(0)).toBeCloseTo(0.5, 12);
    expect(mercatorX(-180)).toBeCloseTo(0, 12);
    expect(mercatorX(180)).toBeCloseTo(1, 12);
    expect(mercatorY(0)).toBeCloseTo(0.5, 12);
  });

  it('matches the closed form at 45 degrees', () => {
    // 0.5 - ln(tan(45°) + sec(45°)) / 2π
    const expected = 0.5 - Math.log(Math.SQRT2 + 1) / (2 * Math.PI);
    expect(mercatorY(45)).toBeCloseTo(expected, 12);
    expect(mercatorY(45)).toBeCloseTo(0.359725, 6);
    // North is up: a higher latitude has a smaller y.
    expect(mercatorY(60)).toBeLessThan(mercatorY(45));
  });

  it('clamps at the pole rather than returning an infinity', () => {
    expect(Number.isFinite(mercatorY(90))).toBe(true);
    expect(mercatorY(90)).toBeCloseTo(mercatorY(MAX_MERCATOR_LATITUDE), 12);
    expect(mercatorY(-90)).toBeCloseTo(mercatorY(-MAX_MERCATOR_LATITUDE), 12);
  });

  it('inverts', () => {
    for (const lat of [-70, -33.9, 0, 12.5, 51.5, 78]) {
      expect(latitudeAt(mercatorY(lat))).toBeCloseTo(lat, 9);
    }
    for (const lng of [-179, -74, 0, 35, 139.7]) {
      expect(longitudeAt(mercatorX(lng))).toBeCloseTo(lng, 9);
    }
  });
});

describe('fitting coordinates into a frame', () => {
  it('keeps every point inside the padded box', () => {
    const points = [
      { lat: 39.0, lng: 35.0 },
      { lat: 41.1, lng: 28.9 },
      { lat: 36.9, lng: 30.7 },
      { lat: 38.4, lng: 27.1 },
    ];
    const viewport = fitMercator({ points, width: 320, height: 250, insets: INSETS, minSpanKm: 8 });
    for (const point of points) {
      const at = viewport.project(point);
      expect(at.x).toBeGreaterThanOrEqual(INSETS.left - 0.001);
      expect(at.x).toBeLessThanOrEqual(320 - INSETS.right + 0.001);
      expect(at.y).toBeGreaterThanOrEqual(INSETS.top - 0.001);
      expect(at.y).toBeLessThanOrEqual(250 - INSETS.bottom + 0.001);
    }
  });

  it('centres a single point instead of dividing by a zero extent', () => {
    const viewport = fitMercator({
      points: [{ lat: 38.72, lng: -9.14 }],
      width: 320,
      height: 250,
      insets: INSETS,
      minSpanKm: 8,
    });
    const at = viewport.project({ lat: 38.72, lng: -9.14 });
    expect(Number.isFinite(at.x)).toBe(true);
    expect(at.x).toBeCloseTo(160, 6);
    expect(at.y).toBeCloseTo(125, 6);
  });

  it('gives a degenerate extent the ground span it was asked for', () => {
    const viewport = fitMercator({
      points: [{ lat: 60, lng: 10 }],
      width: 320,
      height: 250,
      insets: INSETS,
      minSpanKm: 20,
    });
    /*
     * The floor is stated in kilometres, so it has to *be* kilometres after the
     * Mercator stretch is undone — the defect the old degrees-based floor had,
     * where the same number meant 5.5 km near the equator and 2.3 km at 65°N.
     */
    const innerHeight = 250 - INSETS.top - INSETS.bottom;
    expect(viewport.kmPerPixelAt(60) * innerHeight).toBeCloseTo(20, 6);
  });

  it('projects nothing without throwing', () => {
    const viewport = fitMercator({
      points: [],
      width: 320,
      height: 250,
      insets: INSETS,
      minSpanKm: 8,
    });
    expect(Number.isFinite(viewport.project({ lat: 0, lng: 0 }).x)).toBe(true);
  });

  it('round-trips a pixel back to the coordinate it came from', () => {
    const viewport = fitMercator({
      points: [
        { lat: -33.87, lng: 151.2 },
        { lat: -37.81, lng: 144.96 },
      ],
      width: 320,
      height: 250,
      insets: INSETS,
      minSpanKm: 8,
    });
    const original = { lat: -35.28, lng: 149.13 };
    const back = viewport.unproject(viewport.project(original));
    expect(back.lat).toBeCloseTo(original.lat, 9);
    expect(back.lng).toBeCloseTo(original.lng, 9);
  });
});

/**
 * THE PROPERTY THE OLD PROJECTION DID NOT HAVE.
 *
 * Equirectangular-with-one-cosine draws a north-south kilometre and an
 * east-west kilometre at different lengths everywhere except the latitude the
 * cosine was taken at. Mercator is conformal, so they are equal *at every point
 * in the frame* — which is what makes a distance ring a ring and a scale bar
 * meaningful.
 */
describe('scale is the same in every direction at a point', () => {
  it.each([0, 25, 45, 65])('holds at %s degrees north', (lat) => {
    const centre = { lat, lng: 12 };
    /*
     * Ten kilometres, not a hundred. Conformality is a property *at a point*:
     * over a 100 km radius at 65°N the Mercator scale genuinely varies by about
     * 1.8% between the northern and eastern vertices, so a test at that radius
     * would be measuring the frame's stretch rather than the projection's
     * isotropy. The stretch has its own assertion below.
     */
    const [north, east, south, west] = geodesicRing(centre, 10, 4);
    const viewport = fitMercator({
      points: [north!, east!, south!, west!],
      width: 320,
      height: 320,
      insets: INSETS,
      minSpanKm: 1,
    });
    const middle = viewport.project(centre);
    const vertical = pixelDistance(middle, viewport.project(north!));
    const horizontal = pixelDistance(middle, viewport.project(east!));
    expect(Math.abs(vertical - horizontal) / horizontal).toBeLessThan(0.005);
  });

  it('still stretches with latitude across one frame, and says so', () => {
    const viewport = fitMercator({
      points: [
        { lat: 5, lng: 0 },
        { lat: 65, lng: 0 },
      ],
      width: 320,
      height: 250,
      insets: INSETS,
      minSpanKm: 1,
    });
    // Not a defect: it is the projection. The figure states which latitude its
    // scale bar is true at rather than implying one bar covers the frame.
    expect(viewport.kmPerPixelAt(5)).toBeGreaterThan(viewport.kmPerPixelAt(65) * 2);
  });

  it('reports kilometres per pixel that agree with measured ground distance', () => {
    const viewport = fitMercator({
      points: [
        { lat: 46.0, lng: 7.0 },
        { lat: 47.0, lng: 9.0 },
      ],
      width: 320,
      height: 250,
      insets: INSETS,
      minSpanKm: 8,
    });
    const a = { lat: 46.5, lng: 8.0 };
    const [, east] = geodesicRing(a, 40, 4);
    const pixels = pixelDistance(viewport.project(a), viewport.project(east!));
    expect(pixels * viewport.kmPerPixelAt(a.lat)).toBeCloseTo(40, 0);
  });

  it('derives a world unit that is the equator', () => {
    expect(EQUATORIAL_CIRCUMFERENCE_KM).toBeCloseTo(40030.2, 1);
  });
});

describe('the day-reach ring', () => {
  it('puts every vertex exactly the stated distance away', () => {
    const centre = { lat: 62.0, lng: -6.77 };
    for (const vertex of geodesicRing(centre, 65, 36)) {
      expect(haversineKm(centre, vertex)).toBeCloseTo(65, 6);
    }
  });

  it('walks the compass once, in order, starting due north', () => {
    const ring = geodesicRing({ lat: 0, lng: 0 }, 100, 4);
    expect(ring).toHaveLength(4);
    // Bearing 0 is north, then east, south, west.
    expect(ring[0]!.lat).toBeGreaterThan(0);
    expect(ring[1]!.lng).toBeGreaterThan(0);
    expect(ring[2]!.lat).toBeLessThan(0);
    expect(ring[3]!.lng).toBeLessThan(0);
  });

  it('stays finite across the antimeridian', () => {
    for (const vertex of geodesicRing({ lat: -17.7, lng: 179.9 }, 120, 24)) {
      expect(Number.isFinite(vertex.lat)).toBe(true);
      expect(vertex.lng).toBeGreaterThanOrEqual(-180);
      expect(vertex.lng).toBeLessThanOrEqual(180);
    }
  });
});

describe('the scale bar', () => {
  it('picks the longest round distance that fits', () => {
    // 1 km per pixel, 100 px of room: 100 km fits, 200 does not.
    expect(chooseScaleBar(1, 100)).toEqual({ km: 100, pixels: 100 });
    expect(chooseScaleBar(0.25, 100)).toEqual({ km: 25, pixels: 100 });
  });

  it('never states a distance nobody could measure against', () => {
    const rounded = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000];
    for (const kmPerPixel of [0.01, 0.4, 3, 17, 240]) {
      const bar = chooseScaleBar(kmPerPixel, 90);
      expect(bar.pixels).toBeLessThanOrEqual(90.000001);
      expect(rounded).toContain(bar.km);
    }
  });

  it('draws too long a bar rather than none when even the smallest overflows', () => {
    // A metre per pixel with five pixels of room: even 100 m needs 1000 of them.
    const bar = chooseScaleBar(0.0001, 5);
    expect(bar.km).toBe(0.1);
    expect(bar.pixels).toBeGreaterThan(5);
  });
});
