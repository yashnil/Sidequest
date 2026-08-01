import { validateAccessDataset } from '../access/provider';
import { validateFoodDataset } from '../food/provider';
import { validateOperatingHoursDataset } from '../hours/provider';
import type { CompilationErrorCode } from '../schemas/compilation';
import {
  compiledRegionSchema,
  type CompiledRegion,
} from '../schemas/compiled-region';
import type { GeographicScope } from '../schemas/scope';
import type { TravelerProfile } from '../schemas/profile';

/**
 * THE ONE DOOR A REGION COMES THROUGH.
 *
 * Before this existed, the web app imported eight Eastern Sierra constants and
 * assembled them by hand — which worked exactly as long as there was one region,
 * and made "add a second one" a change to four files and a prayer.
 *
 * A region source answers one question: *given this scope and these dates, what
 * is there?* The authored Eastern Sierra fixture answers it by reading
 * constants. The dynamic compiler answers it by calling providers for two
 * minutes. Nothing above this line can tell which happened, and that is the
 * whole point: the deterministic planner is fed a normalised artifact either
 * way, and it stays a pure function of it.
 */

export interface RegionRequest {
  /**
   * For a source that holds pre-built regions. A dynamic compiler ignores it and
   * reads `scope` instead.
   */
  regionId?: string;
  /** The confirmed scope. Absent only for a source keyed purely on region id. */
  scope?: GeographicScope;
  /** Every date of the trip. Bounds what is worth compiling. */
  dates: readonly string[];
  /** Calendar months the trip touches. */
  months: readonly number[];
  /** Present once the questionnaire is done. Shapes depth, never legality. */
  profile?: TravelerProfile;
}

export type RegionSourceResult =
  | { ok: true; region: CompiledRegion }
  | { ok: false; code: CompilationErrorCode; message: string };

export interface RegionSource {
  readonly name: string;
  /**
   * Whether this source can answer at all.
   *
   * Asked rather than discovered by failure, so a request for an uncompiled
   * destination produces "we have not built that yet" rather than an exception
   * three stages into a pipeline.
   */
  supports(request: RegionRequest): boolean;
  getCompiledRegion(request: RegionRequest): Promise<RegionSourceResult>;
}

/** A structural problem with a compiled region, in a form a UI can group. */
export interface RegionIntegrityIssue {
  code:
    | 'place_without_access_rule'
    | 'place_without_operating_calendar'
    | 'place_without_weather_location'
    | 'place_in_multiple_weather_locations'
    | 'weather_location_claims_unknown_place'
    | 'place_missing_from_matrix'
    | 'base_missing_from_matrix'
    | 'primary_base_not_in_bases'
    | 'food_venue_missing_from_matrix'
    | 'matrix_malformed'
    | 'dataset_invalid';
  detail: string;
  subjectIds: string[];
}

export class RegionIntegrityError extends Error {
  readonly issues: RegionIntegrityIssue[];

  constructor(issues: RegionIntegrityIssue[]) {
    super(`Compiled region failed ${issues.length} integrity check(s).`);
    this.name = 'RegionIntegrityError';
    this.issues = issues;
  }
}

/**
 * THE GATE.
 *
 * Five of these checks used to be unit tests over the seed data — a fixture edit
 * that broke one failed CI, which is the right place to catch it when a human
 * writes the data. A compiler writes it at request time, when CI is not
 * watching, so the same invariants have to run here or they stop existing.
 *
 * Their stakes are worth restating, because they are not cosmetic. A place no
 * weather location claims falls back to whichever forecast a consumer reaches
 * for first. A place with no hours record is one the planner has to guess about,
 * and the guess it would make — "open whenever you like" — is the one that puts
 * somebody at a locked door. A place missing from the matrix throws at the
 * moment a day is laid out, which in the old code was outside every `try` and
 * went straight to a 500.
 */
export function checkRegionIntegrity(region: CompiledRegion): RegionIntegrityIssue[] {
  const issues: RegionIntegrityIssue[] = [];
  const placeIds = region.places.map((place) => place.id);
  const matrixIds = new Set(region.travelTimes.ids);

  const push = (
    code: RegionIntegrityIssue['code'],
    detail: string,
    subjectIds: string[],
  ): void => {
    if (subjectIds.length > 0 || code === 'matrix_malformed') {
      issues.push({ code, detail, subjectIds });
    }
  };

  // Datasets first: a malformed one makes every check below meaningless.
  try {
    validateAccessDataset(region.access, { regionId: region.region.id, placeIds });
  } catch (error) {
    push('dataset_invalid', `Access data: ${messageOf(error)}`, ['access']);
  }
  try {
    validateOperatingHoursDataset(region.operatingHours, {
      regionId: region.region.id,
      placeIds,
    });
  } catch (error) {
    push('dataset_invalid', `Opening hours: ${messageOf(error)}`, ['hours']);
  }
  if (region.food) {
    try {
      validateFoodDataset(region.food, { regionId: region.region.id });
    } catch (error) {
      push('dataset_invalid', `Food data: ${messageOf(error)}`, ['food']);
    }
  }

  // Weather zones: exactly one location must claim each place.
  const claimCounts = new Map<string, number>();
  for (const location of region.weatherLocations) {
    for (const placeId of location.placeIds) {
      claimCounts.set(placeId, (claimCounts.get(placeId) ?? 0) + 1);
    }
  }
  push(
    'place_without_weather_location',
    'No forecast point claims these, so their weather would come from whichever point a consumer reached for first.',
    placeIds.filter((id) => !claimCounts.has(id)).sort(),
  );
  push(
    'place_in_multiple_weather_locations',
    'More than one forecast point claims these, so their weather would be decided by array order.',
    [...claimCounts.entries()].filter(([, count]) => count > 1).map(([id]) => id).sort(),
  );
  const known = new Set(placeIds);
  push(
    'weather_location_claims_unknown_place',
    'A forecast point claims a place this region does not have.',
    region.weatherLocations
      .flatMap((location) => location.placeIds.filter((placeId) => !known.has(placeId)))
      .sort(),
  );

  // The matrix. A missing row is a throw at day-layout time, not a warning.
  push(
    'place_missing_from_matrix',
    'These have no travel-time row, so a day containing one cannot be laid out.',
    placeIds.filter((id) => !matrixIds.has(id)).sort(),
  );
  push(
    'base_missing_from_matrix',
    'A base with no travel-time row cannot start or end a day.',
    region.bases.filter((base) => !matrixIds.has(base.routingId)).map((base) => base.id).sort(),
  );
  push(
    'primary_base_not_in_bases',
    'The primary base is not one of the bases.',
    region.bases.some((base) => base.id === region.primaryBaseId) ? [] : [region.primaryBaseId],
  );
  if (region.food) {
    const missing = region.food.venues
      .map((venue) => venue.routingId)
      .filter((routingId) => !matrixIds.has(routingId));
    push(
      'food_venue_missing_from_matrix',
      'A food venue with no travel-time row cannot have its detour priced.',
      [...new Set(missing)].sort(),
    );
  }

  // Matrix shape. Cheap, and a silent zero here teleports a traveller.
  const size = region.travelTimes.ids.length;
  const shapeOk =
    region.travelTimes.minutes.length === size &&
    region.travelTimes.km.length === size &&
    region.travelTimes.minutes.every((row) => row.length === size) &&
    region.travelTimes.km.every((row) => row.length === size);
  if (!shapeOk) {
    issues.push({
      code: 'matrix_malformed',
      detail: `Travel-time matrix is not ${size}x${size}.`,
      subjectIds: [],
    });
  }

  return issues;
}

/**
 * Parse, then check. Both, in that order, at every boundary a compiled region
 * crosses — the same parse-at-both-boundaries rule the repository already
 * applies to every stored itinerary.
 */
export function validateCompiledRegion(candidate: unknown): CompiledRegion {
  const region = compiledRegionSchema.parse(candidate);
  const issues = checkRegionIntegrity(region);
  if (issues.length > 0) throw new RegionIntegrityError(issues);
  return region;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
