import type { GeoBounds, GeographicScope, PackCell, PartitionPlan } from '@sidequest/core';

/**
 * CUTTING A SCOPE INTO CELLS THE EXTRACTOR CAN ACTUALLY ANSWER FOR.
 *
 * The previous discovery layer had a hard three-degree ceiling and refused
 * anything larger, which is how a request for Bali came back with nothing at
 * all. That ceiling was a property of one shared server, not of geography, and
 * copying it into the new backbone would have carried the defect forward.
 *
 * What replaces it: a scope of any size becomes a set of bounded cells, each
 * small enough to scan and each carrying a priority so that a budget which
 * cannot cover every cell covers the ones nearest the traveller first. A partial
 * partition is a normal outcome with a number attached, not a failure.
 *
 * Three properties this has to hold, and every one of them is tested:
 *
 * - **Deterministic.** The same scope produces the same cells, in the same
 *   order, with the same ids. A pack whose partition wobbles is a pack whose
 *   content hash wobbles, and then nothing can be reused.
 * - **Overlapping.** Adjacent cells share a margin, because a feature sitting on
 *   a seam is otherwise clipped out of both. Deduplication after the merge is
 *   cheaper than a missing waterfall.
 * - **Nothing names a destination.** A city, an island, a park and a rail
 *   corridor go through the same four rules.
 */

/**
 * The largest a cell may be, and the smallest.
 *
 * Cells are not only a budget device — they are how retention is spread. A live
 * New York build ran with a *single* cell covering the whole city, so the
 * feature budget filled from one contiguous corner of the source file and the
 * traveller's board came back as one borough's parks. Nothing had failed; the
 * region had simply been read from one end.
 *
 * So the cell size scales with the scope: aim for a few cells across, clamp so a
 * neighbourhood is not shredded and a country is not read at village
 * resolution.
 */
export const MAX_CELL_DEGREES = 0.6;
export const MIN_CELL_DEGREES = 0.06;
/** Cells across the longer axis. Three gives nine over a square scope. */
export const CELLS_ACROSS = 3;

/**
 * The cell size for a scope of this span.
 *
 * Exported because the number is a judgement rather than an implementation
 * detail, and a test that could not name it would be asserting on a constant it
 * had to guess.
 */
export function cellSizeFor(spanDegrees: number): number {
  return Math.min(MAX_CELL_DEGREES, Math.max(MIN_CELL_DEGREES, spanDegrees / CELLS_ACROSS));
}

/**
 * How much each cell overreaches its neighbour, in degrees.
 *
 * About 550 m at the equator. Enough that a feature whose recorded point sits a
 * few metres from a seam is inside both cells rather than neither; small enough
 * that the duplicate work is a rounding error.
 */
export const CELL_OVERLAP_DEGREES = 0.005;

/**
 * The global ceiling on cells for one pack build.
 *
 * A country-sized scope would otherwise produce thousands. Beyond this the plan
 * keeps the highest-priority cells and records how many it dropped, so the pack
 * can say "we looked at the middle of this, not the edges" rather than implying
 * it read the lot.
 */
export const MAX_CELLS = 24;

/** Latitude degrees per kilometre. Longitude is scaled by the cosine below. */
const KM_PER_DEGREE_LAT = 111;

export interface PartitionOptions {
  targetCellDegrees?: number;
  maxCells?: number;
  overlapDegrees?: number;
}

/** The whole ground a scope covers, whatever shape it is expressed in. */
export function scopeBounds(scope: GeographicScope): GeoBounds {
  const shape = scope.shape;
  if (shape.kind === 'bounds') return clampBounds(shape.bounds);
  if (shape.kind === 'radius') return clampBounds(circleBounds(shape.center, shape.radiusKm));
  if (shape.kind === 'corridor') {
    const boxes = shape.waypoints.map((point) => circleBounds(point, shape.corridorWidthKm / 2));
    return clampBounds(unionBounds(boxes));
  }
  return clampBounds(unionBounds(shape.areas.map((area) => circleBounds(area.center, area.radiusKm))));
}

/**
 * The partition.
 *
 * Four strategies, chosen by the scope's own shape rather than by its size, so a
 * corridor is cut along its line and an area set is cut per area — both of which
 * a bounding grid would fill mostly with ground nobody goes to. A ferry
 * archipelago's scope is an area set for exactly this reason.
 */
export function partitionScope(
  scope: GeographicScope,
  options: PartitionOptions = {},
): PartitionPlan {
  const bounds = scopeBounds(scope);
  const span = Math.max(
    bounds.northEast.lat - bounds.southWest.lat,
    bounds.northEast.lng - bounds.southWest.lng,
  );
  const target = options.targetCellDegrees ?? cellSizeFor(span);
  const maxCells = Math.max(1, options.maxCells ?? MAX_CELLS);
  const overlap = options.overlapDegrees ?? CELL_OVERLAP_DEGREES;
  const shape = scope.shape;

  const centre = scopeCentre(scope);

  if (shape.kind === 'corridor') {
    const cells = corridorCells(shape.waypoints, shape.corridorWidthKm, target);
    return finalise('corridor', cells, centre, maxCells, overlap);
  }

  if (shape.kind === 'areas') {
    const cells = shape.areas.flatMap((area, index) =>
      gridCells(circleBounds(area.center, area.radiusKm), target, `a${index}`),
    );
    return finalise('areas', cells, centre, maxCells, overlap);
  }

  const cells = gridCells(bounds, target, 'g');
  return finalise(cells.length === 1 ? 'single' : 'grid', cells, centre, maxCells, overlap);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function scopeCentre(scope: GeographicScope): { lat: number; lng: number } {
  const bounds = scopeBounds(scope);
  return {
    lat: (bounds.southWest.lat + bounds.northEast.lat) / 2,
    lng: (bounds.southWest.lng + bounds.northEast.lng) / 2,
  };
}

/**
 * Cells nearest the middle first, then the global cap, then the overlap.
 *
 * Priority before truncation is the whole point: a budget that runs out should
 * cost a traveller the far corner of their region, not the town they are
 * sleeping in. Distance is measured on the cell centre, and ties break on the id
 * so that two runs order identically.
 */
function finalise(
  strategy: PartitionPlan['strategy'],
  cells: readonly PackCell[],
  centre: { lat: number; lng: number },
  maxCells: number,
  overlap: number,
): PartitionPlan {
  const ranked = [...cells]
    .map((cell) => ({
      cell,
      distance: squaredDistance(cellCentre(cell.bounds), centre),
    }))
    .sort((a, b) => a.distance - b.distance || a.cell.id.localeCompare(b.cell.id))
    .map((entry, index) => ({
      ...entry.cell,
      priority: Math.max(0, cells.length - index),
    }));

  const kept = ranked.slice(0, maxCells).map((cell) => ({
    ...cell,
    bounds: grow(cell.bounds, overlap),
  }));

  return {
    strategy,
    cells: kept.length > 0 ? kept : [fallbackCell(centre, overlap)],
    overlapDegrees: overlap,
    droppedCells: Math.max(0, ranked.length - kept.length),
  };
}

/**
 * A cell that exists so `cells` is never empty.
 *
 * `PartitionPlan.cells` is `.min(1)`, and a degenerate scope — a zero-radius
 * point, a corridor whose waypoints coincide — would otherwise produce a plan
 * the schema refuses. A single small box around the centre is the honest answer
 * to "we were asked about a point".
 */
function fallbackCell(centre: { lat: number; lng: number }, overlap: number): PackCell {
  return {
    id: 'g-0-0',
    bounds: grow(circleBounds(centre, 5), overlap),
    priority: 1,
  };
}

function gridCells(bounds: GeoBounds, target: number, prefix: string): PackCell[] {
  const latSpan = bounds.northEast.lat - bounds.southWest.lat;
  const lngSpan = bounds.northEast.lng - bounds.southWest.lng;
  if (latSpan <= 0 || lngSpan <= 0) return [];

  const rows = Math.max(1, Math.ceil(latSpan / target));
  /**
   * Longitude cells widen towards the poles.
   *
   * A 0.6° box is 66 km across at the equator and 30 km at 63° north. Cutting on
   * raw degrees would make a high-latitude scope — a subarctic national park,
   * say — into twice as many cells as it needs, each half the size, and spend
   * the cell budget on the arithmetic rather than on the ground.
   */
  const midLat = (bounds.southWest.lat + bounds.northEast.lat) / 2;
  const lngTarget = target / Math.max(0.2, Math.cos((midLat * Math.PI) / 180));
  const columns = Math.max(1, Math.ceil(lngSpan / lngTarget));

  const cells: PackCell[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      cells.push({
        id: `${prefix}-${row}-${column}`,
        bounds: {
          southWest: {
            lat: bounds.southWest.lat + (latSpan * row) / rows,
            lng: bounds.southWest.lng + (lngSpan * column) / columns,
          },
          northEast: {
            lat: bounds.southWest.lat + (latSpan * (row + 1)) / rows,
            lng: bounds.southWest.lng + (lngSpan * (column + 1)) / columns,
          },
        },
        priority: 0,
      });
    }
  }
  return cells;
}

/**
 * Cells along a line rather than across its bounding box.
 *
 * A rail corridor from one city to another has a bounding box mostly full of
 * ground the traveller will pass at a hundred miles an hour. Walking the
 * waypoints and boxing each step keeps the budget on the route.
 */
function corridorCells(
  waypoints: readonly { lat: number; lng: number }[],
  widthKm: number,
  target: number,
): PackCell[] {
  const cells: PackCell[] = [];
  const halfWidth = Math.max(2, widthKm / 2);
  for (let index = 0; index < waypoints.length; index += 1) {
    const from = waypoints[index]!;
    const to = waypoints[index + 1];
    cells.push({ id: `c-${index}-0`, bounds: circleBounds(from, halfWidth), priority: 0 });
    if (!to) continue;
    /**
     * Intermediate boxes between consecutive waypoints, so a long leg is not a
     * pair of endpoints with a hole between them.
     */
    const spanDeg = Math.max(
      Math.abs(to.lat - from.lat),
      Math.abs(to.lng - from.lng) * Math.max(0.2, Math.cos((from.lat * Math.PI) / 180)),
    );
    const steps = Math.min(8, Math.max(0, Math.ceil(spanDeg / target) - 1));
    for (let step = 1; step <= steps; step += 1) {
      const fraction = step / (steps + 1);
      cells.push({
        id: `c-${index}-${step}`,
        bounds: circleBounds(
          {
            lat: from.lat + (to.lat - from.lat) * fraction,
            lng: from.lng + (to.lng - from.lng) * fraction,
          },
          halfWidth,
        ),
        priority: 0,
      });
    }
  }
  return cells;
}

export function circleBounds(
  centre: { lat: number; lng: number },
  radiusKm: number,
): GeoBounds {
  const radius = Math.max(0.5, radiusKm);
  const latDelta = radius / KM_PER_DEGREE_LAT;
  const lngDelta = radius / (KM_PER_DEGREE_LAT * Math.max(0.1, Math.cos((centre.lat * Math.PI) / 180)));
  return {
    southWest: { lat: centre.lat - latDelta, lng: centre.lng - lngDelta },
    northEast: { lat: centre.lat + latDelta, lng: centre.lng + lngDelta },
  };
}

function unionBounds(boxes: readonly GeoBounds[]): GeoBounds {
  const first = boxes[0];
  if (!first) return { southWest: { lat: -1, lng: -1 }, northEast: { lat: 1, lng: 1 } };
  return boxes.reduce((accumulator, box) => ({
    southWest: {
      lat: Math.min(accumulator.southWest.lat, box.southWest.lat),
      lng: Math.min(accumulator.southWest.lng, box.southWest.lng),
    },
    northEast: {
      lat: Math.max(accumulator.northEast.lat, box.northEast.lat),
      lng: Math.max(accumulator.northEast.lng, box.northEast.lng),
    },
  }));
}

function grow(bounds: GeoBounds, degrees: number): GeoBounds {
  return clampBounds({
    southWest: { lat: bounds.southWest.lat - degrees, lng: bounds.southWest.lng - degrees },
    northEast: { lat: bounds.northEast.lat + degrees, lng: bounds.northEast.lng + degrees },
  });
}

/**
 * Latitude is clamped, longitude is not wrapped.
 *
 * A scope crossing the antimeridian would need two boxes rather than one wrapped
 * one, and nothing upstream produces one today — a geocoder returns a bbox that
 * has already been split. Clamping longitude instead would silently turn such a
 * scope into the entire planet, which is the failure worth preventing.
 */
function clampBounds(bounds: GeoBounds): GeoBounds {
  return {
    southWest: {
      lat: Math.max(-85, Math.min(85, bounds.southWest.lat)),
      lng: Math.max(-180, Math.min(180, bounds.southWest.lng)),
    },
    northEast: {
      lat: Math.max(-85, Math.min(85, bounds.northEast.lat)),
      lng: Math.max(-180, Math.min(180, bounds.northEast.lng)),
    },
  };
}

function cellCentre(bounds: GeoBounds): { lat: number; lng: number } {
  return {
    lat: (bounds.southWest.lat + bounds.northEast.lat) / 2,
    lng: (bounds.southWest.lng + bounds.northEast.lng) / 2,
  };
}

function squaredDistance(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const lat = a.lat - b.lat;
  const lng = (a.lng - b.lng) * Math.max(0.1, Math.cos((b.lat * Math.PI) / 180));
  return lat * lat + lng * lng;
}

export function boundsContain(bounds: GeoBounds, point: { lat: number; lng: number }): boolean {
  return (
    point.lat >= bounds.southWest.lat &&
    point.lat <= bounds.northEast.lat &&
    point.lng >= bounds.southWest.lng &&
    point.lng <= bounds.northEast.lng
  );
}

export function boundsAreaDeg2(bounds: GeoBounds): number {
  return (
    Math.abs(bounds.northEast.lat - bounds.southWest.lat) *
    Math.abs(bounds.northEast.lng - bounds.southWest.lng)
  );
}
