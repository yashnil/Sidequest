import { z } from 'zod';
import {
  closureRiskSchema,
  costLevelSchema,
  crowdLevelSchema,
  interestSchema,
  parkingDifficultySchema,
  physicalIntensitySchema,
  placeCategorySchema,
  roadSurfaceSchema,
  timeOfDaySchema,
} from './common';
import { POI_BASE_FIELDS } from './poi';
import { placeWeatherProfileSchema } from './weather';

/**
 * When the place itself is reachable at all — the snow gate, not the shuttle.
 *
 * `shuttleMonths` used to live here and no longer does. Whether a shuttle
 * replaces private vehicles is a property of a *service calendar*, which has
 * days of the week and hours; a month list on the place could only ever be a
 * second, coarser answer to a question `schemas/access.ts` already answers
 * properly, and the two had already drifted apart.
 */
export const seasonalAccessSchema = z.object({
  /** Months (1-12) the place is normally reachable. */
  openMonths: z.array(z.number().int().min(1).max(12)).min(1).max(12),
  closureRisk: closureRiskSchema,
  note: z.string().min(1).optional(),
});
export type SeasonalAccess = z.infer<typeof seasonalAccessSchema>;

/**
 * The physical facts of getting to the door: what the road is like and what is
 * there when you arrive.
 *
 * Deliberately *not* "do you need a car" or "is transit possible". Those two
 * booleans lived here until they proved unwritable — Devils Postpile is
 * shuttle-only between fixed hours in some months and drivable in others, and
 * the Lakes Basin trolley runs June to mid-September and stops at 17:30. A field
 * that has to be true and false on different days of the same trip is not a
 * field. Both now come from date-aware access rules; see `schemas/access.ts`.
 */
export const placeAccessSchema = z.object({
  roadSurface: roadSurfaceSchema,
  mountainRoad: z.boolean(),
  parkingDifficulty: parkingDifficultySchema,
  /** No fuel, water, toilets or reliable phone signal at or near the stop. */
  remoteNoServices: z.boolean().default(false),
});
export type PlaceAccess = z.infer<typeof placeAccessSchema>;

/**
 * Places that sit behind one shared gate, road or shuttle.
 *
 * Reds Meadow is the case that forced this: Minaret Vista is the fee station,
 * and Devils Postpile and Rainbow Falls are both beyond it on the same road,
 * served by the same mandatory shuttle. Treating them as three independent stops
 * lets a planner schedule them on three different days, which would mean paying
 * and boarding three times — or, worse, "driving" to Rainbow Falls on a day when
 * private vehicles are not allowed past the vista at all.
 *
 * The planner keeps members of a group in the same geographic cluster, so they
 * land on the same day or not at all. Destination-agnostic: any shuttle system,
 * toll road or single-entrance valley uses the same mechanism.
 */
export const accessGroupSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  note: z.string().min(1).optional(),
});
export type AccessGroup = z.infer<typeof accessGroupSchema>;

export const travelFromBaseSchema = z.object({
  distanceKm: z.number().min(0),
  driveMinutes: z.number().int().min(0),
  /** True when the drive itself is part of the appeal, not just transit cost. */
  driveIsScenic: z.boolean().default(false),
});
export type TravelFromBase = z.infer<typeof travelFromBaseSchema>;

export const placeSchema = z.object({
  ...POI_BASE_FIELDS,
  /** Base = you sleep here / it is the anchor. Satellite = you travel out to it. */
  relationship: z.enum(['base', 'satellite']),
  category: placeCategorySchema,
  /**
   * Interests this place genuinely satisfies, ordered by how central each one is
   * to the place itself. Order is load-bearing: the first entry the traveller
   * cares about becomes the place's primary interest, which is what frequency
   * ceilings are counted against. A viewpoint hike is a hike first.
   */
  interests: z.array(interestSchema).min(1),
  typicalDurationMinutes: z.number().int().min(15).max(600),
  costLevel: costLevelSchema,
  physicalIntensity: physicalIntensitySchema,
  crowdLevel: crowdLevelSchema,
  /** 0-1 how well known the place is. Deliberately separate from fit. */
  popularityScore: z.number().min(0).max(1),
  /** 0-1 how far off the standard tourist track it is. */
  hiddenGemScore: z.number().min(0).max(1),
  /**
   * How this place reacts to weather, on the axes that change a decision.
   * Canonical facts about the place itself — never a forecast, never a date.
   */
  weather: placeWeatherProfileSchema,
  bestTimeOfDay: timeOfDaySchema.default('any'),
  seasonalAccess: seasonalAccessSchema,
  access: placeAccessSchema,
  /** Set when this place shares an access road, gate or shuttle with others. */
  accessGroup: accessGroupSchema.optional(),
  travelFromBase: travelFromBaseSchema,
  /** Practical caveat shown verbatim on the card when present. */
  logisticsNote: z.string().min(1).optional(),
  imageUrl: z.string().url().optional(),
});
export type Place = z.infer<typeof placeSchema>;

export const placeCollectionSchema = z.array(placeSchema);
