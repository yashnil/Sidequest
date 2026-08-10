/**
 * THE ARITHMETIC UNDER THE REGION FIGURE, SEPARATED SO IT CAN BE CHECKED.
 *
 * The figure this serves used to project with a linear equirectangular formula
 * and a single cosine correction taken at the middle latitude, documented in the
 * component as "wrong for a continent and right for the few hundred kilometres a
 * trip covers". Two things were wrong with settling for that:
 *
 *   1. **The premise stopped being true.** The product compiles anywhere, and a
 *      country-breadth portfolio really can span ten degrees of latitude. One
 *      cosine taken at the centre stretches the northern half and squashes the
 *      southern half of the same picture, so two bases the same distance apart
 *      are drawn at different lengths and the traveller cannot tell which
 *      separation is the real one.
 *   2. **A scale bar and a distance ring are not possible on top of it.** Both
 *      need a defensible pixels-per-kilometre at a stated latitude. Without one,
 *      the only honest thing the figure could say about distance was nothing,
 *      which is what it said.
 *
 * Web Mercator replaces it. It is conformal — the scale at a point is the same
 * in every direction — so a circle of true ground radius stays a circle, a
 * north-south separation and an east-west separation of equal length are drawn
 * equal, and `kmPerPixelAt` is a real number rather than an average of two
 * different ones. It is also the projection every tile provider serves, which is
 * what lets the map adapter drop a basemap behind this figure without moving a
 * single mark.
 *
 * What it is not is equal-area: a degree of longitude at 65°N is drawn the same
 * width as one at the equator, so the *same figure* has a different scale at the
 * top and the bottom. That is a property of the projection rather than a defect
 * of this module, and the figure states the latitude its scale bar is true at
 * rather than pretending one bar describes the whole frame.
 *
 * Everything here is a pure function of numbers. No React, no DOM, no provider —
 * so it is unit-tested as arithmetic, which is what it is.
 */

export interface GeoPoint {
  lat: number;
  lng: number;
}

export interface Pixel {
  x: number;
  y: number;
}

/**
 * Mean Earth radius (IUGG), and the equatorial circumference that follows from
 * the sphere Web Mercator is defined on. Mercator's own datum is the WGS84
 * sphere of radius 6378137 m; the ~0.3% difference between that and the mean
 * radius is far below the accuracy of a straight-line transfer estimate, and
 * using one constant for both the ring geometry and the scale bar keeps them
 * mutually consistent, which matters more here than either being exact.
 */
const EARTH_RADIUS_KM = 6371.0088;
export const EQUATORIAL_CIRCUMFERENCE_KM = 2 * Math.PI * EARTH_RADIUS_KM;

/**
 * The latitude at which the Mercator cylinder is conventionally truncated.
 *
 * y runs to infinity at the pole. Clamping rather than letting a NaN through is
 * the difference between a figure that is slightly wrong about Svalbard and a
 * figure that does not render at all.
 */
export const MAX_MERCATOR_LATITUDE = 85.05112878;

const RADIANS = Math.PI / 180;

/** Longitude to world x in [0, 1], 0 at 180°W. */
export function mercatorX(lng: number): number {
  return (lng + 180) / 360;
}

/** Latitude to world y in [0, 1], 0 at the northern truncation. */
export function mercatorY(lat: number): number {
  const clamped = Math.max(-MAX_MERCATOR_LATITUDE, Math.min(MAX_MERCATOR_LATITUDE, lat));
  const phi = clamped * RADIANS;
  return 0.5 - Math.log(Math.tan(Math.PI / 4 + phi / 2)) / (2 * Math.PI);
}

export function toWorld(point: GeoPoint): Pixel {
  return { x: mercatorX(point.lng), y: mercatorY(point.lat) };
}

/** World y back to latitude. The inverse exists so the forward can be tested. */
export function latitudeAt(worldY: number): number {
  return (2 * Math.atan(Math.exp((0.5 - worldY) * 2 * Math.PI)) - Math.PI / 2) / RADIANS;
}

/** World x back to longitude. */
export function longitudeAt(worldX: number): number {
  return worldX * 360 - 180;
}

export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface MapViewport {
  width: number;
  height: number;
  /** Viewport pixels per world unit. One world unit is the whole equator. */
  scale: number;
  /** Centre of the frame, in world units. */
  centre: Pixel;
  project(point: GeoPoint): Pixel;
  unproject(pixel: Pixel): GeoPoint;
  /**
   * Ground kilometres one viewport pixel covers at a given latitude.
   *
   * Latitude is a required argument rather than a stored average because in
   * Mercator it genuinely varies across the frame, and a caller that does not
   * have to say which latitude it means is a caller that will not think about it.
   */
  kmPerPixelAt(lat: number): number;
  /** The latitude of the middle of the frame. What a scale bar is true at. */
  centreLatitude: number;
}

export interface FitInput {
  points: readonly GeoPoint[];
  width: number;
  height: number;
  insets: Insets;
  /**
   * The smallest ground span the frame is allowed to represent, in kilometres.
   *
   * A single-cluster portfolio has a degenerate extent, and dividing by zero put
   * every mark at NaN — the defect the old component worked around by forcing a
   * 0.05° span. Stating it in kilometres instead means the floor is the same
   * amount of *ground* at every latitude, rather than 5.5 km at the equator and
   * 2.3 km at 65°N.
   */
  minSpanKm: number;
}

/**
 * Fit a set of coordinates into a box, preserving shape.
 *
 * One scale for both axes — never a separate x and y stretch — because an
 * anisotropic fit would silently undo the one property this projection was
 * chosen for.
 */
export function fitMercator(input: FitInput): MapViewport {
  const { width, height, insets, minSpanKm } = input;
  const innerWidth = Math.max(1, width - insets.left - insets.right);
  const innerHeight = Math.max(1, height - insets.top - insets.bottom);

  const world = (input.points.length > 0 ? input.points : [{ lat: 0, lng: 0 }]).map(toWorld);
  const xs = world.map((point) => point.x);
  const ys = world.map((point) => point.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);

  const centre = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
  const centreLatitude = latitudeAt(centre.y);

  /*
   * The floor, converted from ground kilometres into world units *at this
   * frame's latitude*, which is where the Mercator stretch has to be undone
   * rather than ignored: a world unit is `EQUATORIAL_CIRCUMFERENCE_KM · cos φ`
   * kilometres on the ground.
   */
  const kmPerWorldUnit = EQUATORIAL_CIRCUMFERENCE_KM * Math.cos(centreLatitude * RADIANS);
  const floorSpan = kmPerWorldUnit > 0 ? minSpanKm / kmPerWorldUnit : 1e-6;

  const spanX = Math.max(maxX - minX, floorSpan);
  const spanY = Math.max(maxY - minY, floorSpan);
  const scale = Math.min(innerWidth / spanX, innerHeight / spanY);

  const originX = insets.left + innerWidth / 2 - centre.x * scale;
  const originY = insets.top + innerHeight / 2 - centre.y * scale;

  return {
    width,
    height,
    scale,
    centre,
    centreLatitude,
    project(point: GeoPoint): Pixel {
      const worldPoint = toWorld(point);
      return { x: originX + worldPoint.x * scale, y: originY + worldPoint.y * scale };
    },
    unproject(pixel: Pixel): GeoPoint {
      const worldX = (pixel.x - originX) / scale;
      const worldY = (pixel.y - originY) / scale;
      return { lat: latitudeAt(worldY), lng: longitudeAt(worldX) };
    },
    kmPerPixelAt(lat: number): number {
      return (EQUATORIAL_CIRCUMFERENCE_KM * Math.cos(lat * RADIANS)) / scale;
    },
  };
}

/**
 * The true set of points a fixed ground distance from a centre.
 *
 * Drawn as a polygon of real coordinates rather than as an SVG `<circle>` with a
 * radius guessed from the scale, and the difference is the whole point: this is
 * a distance the traveller can check, not an ellipse that happens to look about
 * right. Each vertex is produced by the spherical direct problem — walk `radius`
 * kilometres from the centre along a bearing — so every vertex is exactly the
 * stated distance away, and the shape the projection gives it is whatever the
 * projection gives it.
 */
export function geodesicRing(centre: GeoPoint, radiusKm: number, steps = 72): GeoPoint[] {
  const angular = radiusKm / EARTH_RADIUS_KM;
  const lat1 = centre.lat * RADIANS;
  const lng1 = centre.lng * RADIANS;
  const points: GeoPoint[] = [];

  for (let step = 0; step < steps; step += 1) {
    const bearing = (step / steps) * 2 * Math.PI;
    const lat2 = Math.asin(
      Math.sin(lat1) * Math.cos(angular) + Math.cos(lat1) * Math.sin(angular) * Math.cos(bearing),
    );
    const lng2 =
      lng1 +
      Math.atan2(
        Math.sin(bearing) * Math.sin(angular) * Math.cos(lat1),
        Math.cos(angular) - Math.sin(lat1) * Math.sin(lat2),
      );
    points.push({ lat: lat2 / RADIANS, lng: ((lng2 / RADIANS + 540) % 360) - 180 });
  }

  return points;
}

/**
 * Rounded distances a scale bar is allowed to state.
 *
 * A bar reading "137 km" is a bar nobody measures anything against. The list is
 * the usual 1/2/5 progression with the quarter steps that keep a bar from
 * collapsing to a quarter of its available width between decades.
 */
const SCALE_STEPS: readonly number[] = [
  0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000,
];

export interface ScaleBar {
  km: number;
  pixels: number;
}

/**
 * The longest round distance that fits in the space available.
 *
 * Returns the smallest step when even that overflows, so an extremely zoomed-out
 * frame draws a bar that is too long rather than no bar at all — an absent scale
 * is indistinguishable from a figure that has no opinion about distance.
 */
export function chooseScaleBar(kmPerPixel: number, maxPixels: number): ScaleBar {
  let chosen = SCALE_STEPS[0]!;
  for (const step of SCALE_STEPS) {
    if (step / kmPerPixel <= maxPixels) chosen = step;
  }
  return { km: chosen, pixels: chosen / kmPerPixel };
}
