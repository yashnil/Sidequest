/**
 * Geographic and routing primitives. Framework-free, destination-agnostic, and
 * deliberately ignorant of what a "place" or a "traveller" is — this package
 * knows about points, distances and orderings, nothing else.
 */

export interface GeoPoint {
  /** Stable identifier. Matrix rows and columns are keyed by this. */
  id: string;
  lat: number;
  lng: number;
}

export const TRAVEL_MODES = ['car', 'foot', 'transit'] as const;
export type TravelMode = (typeof TRAVEL_MODES)[number];

/**
 * How a matrix's numbers were arrived at. This travels with the data so the UI
 * and the planner can never quietly present a model as a measurement.
 *
 * - `measured`  — from a routing service against the real road network.
 * - `modelled`  — derived from an explicit road-topology model of the region.
 * - `estimated` — a crude fallback (e.g. straight-line distance and an assumed
 *                 speed). Usable to keep the planner running, never to be shown
 *                 as a real drive time.
 */
export type MatrixProvenanceKind = 'measured' | 'modelled' | 'estimated';

export interface MatrixProvenance {
  kind: MatrixProvenanceKind;
  /** Human-readable account of how the numbers were produced. */
  note: string;
  source?: string;
}

export interface TravelTimeMatrix {
  mode: TravelMode;
  /** Row/column order. Index of an id is its row and column. */
  ids: readonly string[];
  /** minutes[from][to]. Not assumed symmetric, though modelled matrices are. */
  minutes: readonly (readonly number[])[];
  /** km[from][to]. */
  km: readonly (readonly number[])[];
  provenance: MatrixProvenance;
}

/**
 * The seam a real routing service will slot into. Nothing in the planner talks to
 * a provider directly — the caller resolves a matrix and passes it in as data,
 * which is what keeps planning a pure function.
 */
export interface TravelTimeProvider {
  readonly name: string;
  getMatrix(points: readonly GeoPoint[], mode: TravelMode): Promise<TravelTimeMatrix>;
}

export class MatrixError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'MatrixError';
    this.code = code;
  }
}
