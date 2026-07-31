import { foodDatasetSchema, type FoodDataset } from '../schemas/food';

/**
 * The seam a real places provider will implement.
 *
 * Same shape as the access, hours and weather providers, and deliberately keyed
 * on the region and the dates rather than on a list of stops: which restaurants
 * are worth knowing about is a property of an area and a season, not of the
 * particular lake somebody happens to be visiting on Tuesday. The planner asks
 * nothing of this; it is handed a validated dataset and stays a pure function.
 */
export interface FoodProvider {
  readonly name: string;
  getFoodVenues(input: {
    regionId: string;
    tripDates: readonly string[];
  }): Promise<FoodDataset>;
}

export const FOOD_DATA_ERROR_CODES = ['invalid_dataset', 'unknown_region'] as const;
export type FoodDataErrorCode = (typeof FOOD_DATA_ERROR_CODES)[number];

export class FoodDataError extends Error {
  readonly code: FoodDataErrorCode;

  constructor(code: FoodDataErrorCode, message: string) {
    super(message);
    this.name = 'FoodDataError';
    this.code = code;
  }
}

/**
 * The boundary every food dataset crosses, fixture included.
 *
 * WHERE THIS DELIBERATELY DIFFERS FROM ITS THREE SIBLINGS
 *
 * Access, hours and weather all demand *complete coverage*: a place with no
 * access rule is a planning failure, because we will not assume a road exists.
 * Food cannot work that way. "There is no verified restaurant near Devils
 * Postpile" is not a gap in the data — it is the answer, and the National Park
 * Service is the one who gives it. So there is no `incomplete_coverage` code
 * here, and an empty venue list is a valid dataset rather than an error.
 *
 * What is still enforced is everything that would let a bad record through: the
 * schema, the region, and the honesty refinements inside it — a venue relied on
 * for provisioning may not have unknown hours, a dietary claim at the strongest
 * evidence level may not exist without the page it was read from, and hours we
 * did not fully read may not travel without a note telling the traveller so.
 */
export function validateFoodDataset(
  dataset: unknown,
  expected: { regionId: string },
): FoodDataset {
  const parsed = foodDatasetSchema.safeParse(dataset);
  if (!parsed.success) {
    throw new FoodDataError(
      'invalid_dataset',
      `Food data did not validate: ${JSON.stringify(parsed.error.flatten())}`,
    );
  }
  if (parsed.data.regionId !== expected.regionId) {
    throw new FoodDataError(
      'unknown_region',
      `Food data is for region "${parsed.data.regionId}", not "${expected.regionId}".`,
    );
  }
  return parsed.data;
}

/**
 * What a region looks like when nobody answered.
 *
 * A real value rather than `null`, for the reason `weather: unavailable` is a
 * real value: the planner has to be able to tell "we have no food data" from
 * "we have food data and it is thin", and only the second permits a sentence
 * like "nothing near this route fits". With this dataset the plan still gets
 * built, the meal blocks are still there, and every one of them says plainly
 * that no venue was chosen because none was known.
 */
export function emptyFoodDataset(regionId: string): FoodDataset {
  return foodDatasetSchema.parse({ version: 1, regionId, venues: [], gaps: [] });
}
