import { accessDatasetSchema, type AccessDataset } from '../schemas/access';

/**
 * The seam a real transit, parking or routing service will slot into.
 *
 * Same contract as `TravelTimeProvider`: the caller resolves a dataset at the
 * server boundary and passes it into the planner as data, so planning stays a
 * pure function of its inputs. Async today with an offline implementation, so
 * that swapping in an API is not a signature change.
 */
export interface AccessProvider {
  readonly name: string;
  getAccessDataset(input: {
    regionId: string;
    placeIds: readonly string[];
    /** Trip dates as `YYYY-MM-DD`. A live provider needs them; a fixture ignores them. */
    dates: readonly string[];
  }): Promise<AccessDataset>;
}

export class AccessDataError extends Error {
  readonly code: 'invalid_dataset' | 'unknown_region' | 'incomplete_coverage';

  constructor(code: AccessDataError['code'], message: string) {
    super(message);
    this.name = 'AccessDataError';
    this.code = code;
  }
}

/**
 * Validates provider output before anything depends on it.
 *
 * Two separate guarantees, and the second is the one that matters:
 *
 * 1. the dataset is structurally sound and internally consistent (Zod);
 * 2. **every place asked about is actually covered by a rule.**
 *
 * A place with no rule is not "probably drivable". Treating silence as a road is
 * exactly how a planner ends up scheduling a hike behind a locked gate, so a gap
 * is reported as a gap and the planner refuses to place it.
 */
export function validateAccessDataset(
  dataset: unknown,
  expected: { regionId: string; placeIds: readonly string[] },
): AccessDataset {
  const parsed = accessDatasetSchema.safeParse(dataset);
  if (!parsed.success) {
    throw new AccessDataError(
      'invalid_dataset',
      `Access data for ${expected.regionId} is malformed: ${parsed.error.issues
        .map((issue) => issue.message)
        .join('; ')}`,
    );
  }
  if (parsed.data.regionId !== expected.regionId) {
    throw new AccessDataError(
      'unknown_region',
      `Access data is for "${parsed.data.regionId}", not "${expected.regionId}".`,
    );
  }

  const uncovered = uncoveredPlaceIds(parsed.data, expected.placeIds);
  if (uncovered.length > 0) {
    throw new AccessDataError(
      'incomplete_coverage',
      `No access rule covers ${uncovered.join(', ')}. We will not assume a road exists.`,
    );
  }
  return parsed.data;
}

/** Place ids the dataset says nothing about. Callers must not plan these. */
export function uncoveredPlaceIds(
  dataset: AccessDataset,
  placeIds: readonly string[],
): string[] {
  const covered = new Set(dataset.rules.flatMap((rule) => rule.placeIds));
  return placeIds.filter((id) => !covered.has(id)).sort();
}
