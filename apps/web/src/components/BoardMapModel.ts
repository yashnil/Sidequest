import { fitMercator, geodesicRing, type GeoPoint } from './map-projection';

/**
 * WHERE THE PLACES ON THE BOARD ACTUALLY ARE.
 *
 * The product had no map anywhere — a travel planner whose entire subject is
 * geography, asking people to choose between two dozen places by reading their
 * names. "27 min from base" is not an answer to *where is this*: it does not say
 * whether two stops sit beside each other, whether the far ones are all in one
 * direction, or whether a cluster would make a day.
 *
 * This is the arithmetic behind the drawing, kept apart from it so it can be
 * checked as arithmetic. The projection is the same Web Mercator the region
 * figure and the tile adapter use, which is what would let a basemap slide under
 * these marks later without moving one of them.
 *
 * WHAT IT REFUSES TO DO. Nothing here invents a coordinate. A candidate with no
 * position is not placed at the base, not placed at the centre and not given a
 * plausible-looking dot — it is returned in `unplaced`, and the surface says so
 * in words. A pin at a made-up position is worse than no pin, because a map is
 * read as a claim about the ground.
 */

export interface BoardMapPlace {
  id: string;
  name: string;
  coordinates?: { lat: number; lng: number } | undefined;
  /** Marked included by the traveller. Drawn differently, never hidden. */
  chosen: boolean;
  /** Minutes from base, where a journey was measured. */
  travelMinutes: number | null;
}

export interface BoardMapPin extends BoardMapPlace {
  x: number;
  y: number;
  /** How many pins share this position after rounding. See `NUDGE_STEP_PX`. */
  overlapping: number;
}

export interface BoardMapModel {
  width: number;
  height: number;
  base: { x: number; y: number; name: string } | null;
  pins: BoardMapPin[];
  /** Candidates with no published position. Named, never drawn. */
  unplaced: BoardMapPlace[];
  /** A ring of true ground radius round the base, for a sense of scale. */
  ring: { path: string; km: number } | null;
  /** A sentence for a screen reader, covering the same content as the drawing. */
  summary: string;
}

const INSETS = { top: 14, right: 14, bottom: 14, left: 14 };

/**
 * The smallest ground span a frame may represent.
 *
 * A board whose places all sit within a few hundred metres would otherwise be
 * scaled until the rounding noise in the coordinates filled the frame, which
 * draws a spread that is not there. Two kilometres is roughly the distance at
 * which two stops stop being the same street corner.
 */
const MIN_SPAN_KM = 2;

/**
 * How far apart two pins must be before they read as two pins.
 *
 * Coincident marks are the failure that makes a map useless rather than merely
 * imprecise: three stops in one park become one dot, and the traveller counts
 * nineteen places on a board of twenty-one. Pins closer than this are fanned
 * around their shared point in a deterministic spiral — the position moves by a
 * few pixels, which is well inside the accuracy the frame can express anyway.
 */
const NUDGE_STEP_PX = 7;

export function buildBoardMap(input: {
  base: { name: string; coordinates: { lat: number; lng: number } } | null;
  places: readonly BoardMapPlace[];
  width: number;
  height: number;
}): BoardMapModel | null {
  const { base, width, height } = input;
  const placed = input.places.filter(
    (place): place is BoardMapPlace & { coordinates: { lat: number; lng: number } } =>
      Boolean(place.coordinates),
  );
  const unplaced = input.places.filter((place) => !place.coordinates);
  if (placed.length === 0) return null;

  const points: GeoPoint[] = [
    ...placed.map((place) => place.coordinates),
    ...(base ? [base.coordinates] : []),
  ];
  const viewport = fitMercator({ points, width, height, insets: INSETS, minSpanKm: MIN_SPAN_KM });

  /*
   * Ordered before nudging so the fan is stable: two renders of the same board
   * must put the same pin in the same place, or a card's highlight would point
   * at a different dot after a refresh.
   */
  const ordered = [...placed].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const taken: { x: number; y: number }[] = [];
  const pins: BoardMapPin[] = ordered.map((place) => {
    const at = viewport.project(place.coordinates);
    let { x, y } = at;
    let overlapping = 0;
    while (taken.some((other) => Math.hypot(other.x - x, other.y - y) < NUDGE_STEP_PX)) {
      overlapping += 1;
      // A square spiral: right, up, left, down, at a growing radius. Cheap,
      // deterministic, and it keeps a cluster visibly a cluster.
      const step = Math.ceil(overlapping / 4) * NUDGE_STEP_PX;
      const quarter = overlapping % 4;
      x = at.x + (quarter === 0 ? step : quarter === 2 ? -step : 0);
      y = at.y + (quarter === 1 ? -step : quarter === 3 ? step : 0);
      if (overlapping > 16) break;
    }
    taken.push({ x, y });
    return { ...place, x, y, overlapping };
  });

  const baseAt = base ? viewport.project(base.coordinates) : null;

  /*
   * One ring, at a round number of kilometres chosen to sit inside the frame.
   *
   * Drawn from real coordinates walked out along bearings rather than as an SVG
   * circle sized by eye, so the distance it claims is the distance it is. It is
   * the only thing on this drawing that makes the scale legible without a
   * legend, and it is omitted rather than guessed when there is no base.
   */
  let ring: BoardMapModel['ring'] = null;
  if (base && baseAt) {
    const kmPerPixel = viewport.kmPerPixelAt(base.coordinates.lat);
    const halfFrame = Math.min(width, height) / 2 - INSETS.left;
    const candidateKm = [1, 2, 5, 10, 20, 50, 100, 200].filter(
      (km) => km / kmPerPixel < halfFrame,
    );
    const km = candidateKm[candidateKm.length - 1];
    if (km) {
      const path = `${geodesicRing(base.coordinates, km, 48)
        .map((point, index) => {
          const at = viewport.project(point);
          return `${index === 0 ? 'M' : 'L'}${at.x.toFixed(1)} ${at.y.toFixed(1)}`;
        })
        .join(' ')} Z`;
      ring = { path, km };
    }
  }

  const chosen = pins.filter((pin) => pin.chosen).length;
  const summary = [
    `${pins.length} ${pins.length === 1 ? 'place' : 'places'} on the map`,
    base ? `around ${base.name}` : null,
    chosen > 0 ? `${chosen} of them chosen` : null,
    unplaced.length > 0
      ? `${unplaced.length} more with no published position`
      : null,
  ]
    .filter(Boolean)
    .join(', ');

  return {
    width,
    height,
    base: baseAt ? { ...baseAt, name: base!.name } : null,
    pins,
    unplaced,
    ring,
    summary: `${summary}.`,
  };
}

// ---------------------------------------------------------------------------
// One day, in order
// ---------------------------------------------------------------------------

/**
 * A STOP ON A DAY, AND THE ORDER IT IS VISITED IN.
 *
 * The board's model answers "how spread out is this"; a day answers a different
 * question — "where does this day take me, and in what order" — and the two
 * cannot share a model, because the board's pins are deliberately sorted by id
 * so a highlight is stable, and a day's are meaningless in any order but the
 * plan's.
 *
 * What it does share is the projection, the insets and the minimum span, which
 * is the arithmetic that has to agree: a day drawn at one scale beside a board
 * drawn at another would make the same two kilometres look like two different
 * distances on one page.
 */
export interface DayMapStop {
  id: string;
  name: string;
  coordinates: { lat: number; lng: number };
}

export interface DayMapPin extends DayMapStop {
  x: number;
  y: number;
  /** 1-based, in the order the plan visits them. Drawn inside the mark. */
  order: number;
}

export interface DayMapModel {
  width: number;
  height: number;
  base: { x: number; y: number } | null;
  pins: DayMapPin[];
  /** The stops joined in plan order, as an SVG path. Straight lines, not routes. */
  route: string;
  /** A sentence covering the same content as the drawing. */
  summary: string;
}

/**
 * THE DAY, DRAWN.
 *
 * The finished itinerary — the thing this product exists to hand over — shipped
 * as an unillustrated, unmapped text schedule, while the coordinates for every
 * stop were already threaded into the view to build a Google Maps link. A plan
 * whose whole subject is geography, printed with no geography in it.
 *
 * WHAT IT REFUSES TO DO, exactly as the board's model does: nothing here invents
 * a coordinate. A stop the compiled region has no position for is not placed at
 * the base, not placed at the centre, and not drawn — it is simply absent from
 * the pins, and the caption says how many stops the drawing carries so the
 * reader can see the drawing is short rather than assume it is whole.
 *
 * The line between stops is straight and is never labelled with a distance,
 * because the journey is not straight and the timeline beside it already carries
 * the measured minutes.
 *
 * Null when there is nothing to draw — fewer than one placed stop — so a day
 * with no geography renders no frame rather than an empty box.
 */
export function buildDayMap(input: {
  base: { lat: number; lng: number } | null;
  stops: readonly DayMapStop[];
  width: number;
  height: number;
}): DayMapModel | null {
  const { base, stops, width, height } = input;
  if (stops.length === 0) return null;

  const viewport = fitMercator({
    points: [...stops.map((stop) => stop.coordinates), ...(base ? [base] : [])],
    width,
    height,
    insets: INSETS,
    minSpanKm: MIN_SPAN_KM,
  });

  const pins: DayMapPin[] = stops.map((stop, index) => ({
    ...stop,
    ...viewport.project(stop.coordinates),
    order: index + 1,
  }));

  /*
   * The route starts at the bed when we know where it is, because a day begins
   * and ends there and a line that starts at the first stop hides the longest
   * leg of the morning.
   */
  const baseAt = base ? viewport.project(base) : null;
  const path = [...(baseAt ? [baseAt] : []), ...pins]
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(1)} ${point.y.toFixed(1)}`)
    .join(' ');

  return {
    width,
    height,
    base: baseAt,
    pins,
    route: path,
    summary: `${pins.length} ${pins.length === 1 ? 'stop' : 'stops'} on this day, in order: ${pins
      .map((pin) => pin.name)
      .join(', ')}.`,
  };
}
