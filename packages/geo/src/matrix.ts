import { MatrixError, type TravelTimeMatrix } from './types';

export interface TravelLeg {
  minutes: number;
  km: number;
}

/**
 * Structural check of a matrix before anything depends on it.
 *
 * A missing or malformed entry has to surface here, loudly. The failure mode this
 * exists to prevent is a silent zero: a planner that reads `undefined` as 0 will
 * happily teleport a traveller from Mammoth to Bodie and produce a day that looks
 * perfectly valid and cannot be driven.
 */
export function validateMatrix(matrix: TravelTimeMatrix): void {
  const { ids, minutes, km } = matrix;

  if (ids.length === 0) {
    throw new MatrixError('matrix_empty', 'Travel-time matrix has no points.');
  }
  if (new Set(ids).size !== ids.length) {
    throw new MatrixError('matrix_duplicate_ids', 'Travel-time matrix has duplicate ids.');
  }
  if (minutes.length !== ids.length || km.length !== ids.length) {
    throw new MatrixError(
      'matrix_shape',
      `Travel-time matrix is ${minutes.length}x? for ${ids.length} points.`,
    );
  }

  for (let i = 0; i < ids.length; i += 1) {
    const minuteRow = minutes[i];
    const kmRow = km[i];
    const fromId = ids[i] ?? String(i);

    if (!minuteRow || !kmRow || minuteRow.length !== ids.length || kmRow.length !== ids.length) {
      throw new MatrixError('matrix_shape', `Row for "${fromId}" is the wrong length.`);
    }

    for (let j = 0; j < ids.length; j += 1) {
      const value = minuteRow[j];
      const distance = kmRow[j];
      const toId = ids[j] ?? String(j);

      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw new MatrixError(
          'matrix_bad_value',
          `Travel time from "${fromId}" to "${toId}" is not a usable number.`,
        );
      }
      if (typeof distance !== 'number' || !Number.isFinite(distance) || distance < 0) {
        throw new MatrixError(
          'matrix_bad_value',
          `Distance from "${fromId}" to "${toId}" is not a usable number.`,
        );
      }
      if (i === j && value !== 0) {
        throw new MatrixError(
          'matrix_bad_diagonal',
          `Travel time from "${fromId}" to itself is ${value}, expected 0.`,
        );
      }
    }
  }
}

export function matrixIndex(matrix: TravelTimeMatrix, id: string): number {
  const index = matrix.ids.indexOf(id);
  if (index < 0) {
    throw new MatrixError('matrix_missing_point', `"${id}" is not in the travel-time matrix.`);
  }
  return index;
}

export function hasPoint(matrix: TravelTimeMatrix, id: string): boolean {
  return matrix.ids.includes(id);
}

/** Throws rather than returning a default. A missing leg is a planning failure. */
export function leg(matrix: TravelTimeMatrix, fromId: string, toId: string): TravelLeg {
  const from = matrixIndex(matrix, fromId);
  const to = matrixIndex(matrix, toId);
  const minutes = matrix.minutes[from]?.[to];
  const km = matrix.km[from]?.[to];

  /*
   * `Number.isFinite`, not `typeof === 'number'`.
   *
   * `typeof NaN` is `'number'`, so the previous check accepted a NaN cell as a
   * measured leg — and a NaN travel time is the most dangerous value this
   * function can return, because every comparison against it is false. A day
   * carrying one passes every drive-time limit, every daylight check and every
   * buffer rule silently, and arrives on screen as a plan with a hole in it.
   *
   * A sparse matrix now writes NaN for an unmeasured pair deliberately, which
   * makes this the boundary that turns "we did not measure this" into a caller
   * that has to decide what to do about it.
   */
  if (!Number.isFinite(minutes) || !Number.isFinite(km)) {
    throw new MatrixError(
      'matrix_missing_leg',
      `No travel time recorded from "${fromId}" to "${toId}".`,
    );
  }
  return { minutes: minutes as number, km: km as number };
}

export function tryLeg(matrix: TravelTimeMatrix, fromId: string, toId: string): TravelLeg | null {
  if (!hasPoint(matrix, fromId) || !hasPoint(matrix, toId)) return null;
  try {
    return leg(matrix, fromId, toId);
  } catch {
    return null;
  }
}

/** Restricts a matrix to a subset of ids, preserving the given order. */
export function subMatrix(matrix: TravelTimeMatrix, ids: readonly string[]): TravelTimeMatrix {
  const indices = ids.map((id) => matrixIndex(matrix, id));
  return {
    mode: matrix.mode,
    ids: [...ids],
    minutes: indices.map((from) => indices.map((to) => matrix.minutes[from]?.[to] ?? 0)),
    km: indices.map((from) => indices.map((to) => matrix.km[from]?.[to] ?? 0)),
    provenance: matrix.provenance,
  };
}

export type ResolvedSubMatrix =
  | { ok: true; matrix: TravelTimeMatrix }
  | { ok: false; unresolved: readonly string[] };

/**
 * A small, complete matrix over exactly `ids` — never the whole board — built
 * from `primary` and, for any pair `primary` cannot answer, `fallback`.
 *
 * The point of this over `subMatrix`: `subMatrix` requires every id already
 * be in the source matrix (it throws via `matrixIndex` otherwise), which is
 * exactly wrong for an id introduced after that matrix was built — a base or
 * a stop resolved from a traveller-supplied trip structure, for instance.
 * Here, a missing pair is a fact to report, not a throw: if `primary` and
 * `fallback` together cannot measure every pair among `ids`, this returns
 * exactly which ids could not be resolved instead of a matrix, so a caller
 * can surface a typed failure rather than handing an incomplete matrix to
 * something (`orderStops`, `routeSummary`) that assumes a complete one and
 * throws partway through.
 *
 * Never fabricates: every returned cell is either `0` (a point to itself) or
 * a value `tryLeg` actually returned from one of the two sources.
 */
export function resolveSubMatrix(
  primary: TravelTimeMatrix,
  ids: readonly string[],
  fallback?: TravelTimeMatrix | null,
): ResolvedSubMatrix {
  const uniqueIds = [...new Set(ids)];
  const minutes: number[][] = [];
  const km: number[][] = [];
  const unresolved = new Set<string>();

  for (const fromId of uniqueIds) {
    const minuteRow: number[] = [];
    const kmRow: number[] = [];
    for (const toId of uniqueIds) {
      if (fromId === toId) {
        minuteRow.push(0);
        kmRow.push(0);
        continue;
      }
      const resolved = tryLeg(primary, fromId, toId) ?? (fallback ? tryLeg(fallback, fromId, toId) : null);
      if (!resolved) {
        unresolved.add(fromId);
        unresolved.add(toId);
        minuteRow.push(Number.NaN);
        kmRow.push(Number.NaN);
        continue;
      }
      minuteRow.push(resolved.minutes);
      kmRow.push(resolved.km);
    }
    minutes.push(minuteRow);
    km.push(kmRow);
  }

  if (unresolved.size > 0) return { ok: false, unresolved: [...unresolved] };
  return {
    ok: true,
    matrix: {
      mode: primary.mode,
      ids: uniqueIds,
      minutes,
      km,
      provenance: {
        kind: 'measured',
        note: 'Resolved on demand from the primary matrix and a supplementary matrix, for exactly these points.',
      },
    },
  };
}

export interface RouteSummary {
  totalMinutes: number;
  totalKm: number;
  legs: (TravelLeg & { fromId: string; toId: string })[];
}

/** Totals for an ordered sequence of stops, as given (no reordering). */
export function routeSummary(
  matrix: TravelTimeMatrix,
  orderedIds: readonly string[],
): RouteSummary {
  const legs: (TravelLeg & { fromId: string; toId: string })[] = [];
  let totalMinutes = 0;
  let totalKm = 0;

  for (let i = 0; i + 1 < orderedIds.length; i += 1) {
    const fromId = orderedIds[i]!;
    const toId = orderedIds[i + 1]!;
    const value = leg(matrix, fromId, toId);
    legs.push({ ...value, fromId, toId });
    totalMinutes += value.minutes;
    totalKm += value.km;
  }

  return { totalMinutes, totalKm, legs };
}
