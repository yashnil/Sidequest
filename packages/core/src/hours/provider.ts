import {
  operatingHoursDatasetSchema,
  type OperatingHoursDataset,
} from '../schemas/hours';

/**
 * The seam a real hours source will arrive through.
 *
 * Async by design even though today's implementation is a local constant: when
 * Google Places, an NPS feed or an operator's own API replaces it, the signature
 * does not change and nothing above this line has to know which is running.
 *
 * The one thing a provider may never do is answer "I don't know" by omission.
 * Silence has to come back as a calendar of kind `unknown`, because a planner
 * that reads a missing record as "open whenever you like" will schedule a museum
 * at seven in the evening and call the day ready.
 */
export interface OperatingHoursProvider {
  readonly name: string;
  getOperatingHours(input: {
    regionId: string;
    placeIds: readonly string[];
    /** Trip dates as `YYYY-MM-DD`, so a live provider can scope its query. */
    dates: readonly string[];
  }): Promise<OperatingHoursDataset>;
}

export const OPERATING_HOURS_DATA_ERROR_CODES = [
  'invalid_dataset',
  'unknown_region',
  'incomplete_coverage',
] as const;
export type OperatingHoursDataErrorCode = (typeof OPERATING_HOURS_DATA_ERROR_CODES)[number];

export class OperatingHoursDataError extends Error {
  readonly code: OperatingHoursDataErrorCode;

  constructor(code: OperatingHoursDataErrorCode, message: string) {
    super(message);
    this.name = 'OperatingHoursDataError';
    this.code = code;
  }
}

/**
 * The boundary check. Every dataset crosses it, including the local fixture —
 * the check costs nothing, and a validation that only runs against data from
 * elsewhere is a validation nobody has ever seen work.
 *
 * Coverage is mandatory rather than best-effort on purpose. Requiring a calendar
 * for every place forces the honest answer to be written down: `always_open` for
 * a roadside viewpoint, `unknown` for something nobody has checked. What it
 * makes impossible is the silent third state where a place has no record and the
 * planner quietly treats it as unrestricted.
 */
export function validateOperatingHoursDataset(
  dataset: unknown,
  expected: { regionId: string; placeIds: readonly string[] },
): OperatingHoursDataset {
  const parsed = operatingHoursDatasetSchema.safeParse(dataset);
  if (!parsed.success) {
    throw new OperatingHoursDataError(
      'invalid_dataset',
      `The opening-hours data did not validate: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || 'root'} — ${issue.message}`)
        .join('; ')}`,
    );
  }

  if (parsed.data.regionId !== expected.regionId) {
    throw new OperatingHoursDataError(
      'unknown_region',
      `Opening-hours data for "${parsed.data.regionId}" cannot be used for "${expected.regionId}".`,
    );
  }

  const missing = placesWithoutOperatingCalendar(parsed.data, expected.placeIds);
  if (missing.length > 0) {
    throw new OperatingHoursDataError(
      'incomplete_coverage',
      `No opening-hours record covers ${missing.join(', ')}. We will not assume a place is open.`,
    );
  }

  return parsed.data;
}

export function placesWithoutOperatingCalendar(
  dataset: OperatingHoursDataset,
  placeIds: readonly string[],
): string[] {
  const covered = new Set(dataset.calendars.map((calendar) => calendar.placeId));
  return [...placeIds].filter((placeId) => !covered.has(placeId)).sort();
}
