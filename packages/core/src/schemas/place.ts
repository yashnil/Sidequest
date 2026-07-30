import { z } from 'zod';
import {
  closureRiskSchema,
  coordinatesSchema,
  costLevelSchema,
  crowdLevelSchema,
  interestSchema,
  isoDateSchema,
  parkingDifficultySchema,
  physicalIntensitySchema,
  placeCategorySchema,
  roadSurfaceSchema,
  timeOfDaySchema,
  weatherSensitivitySchema,
} from './common';

/**
 * Where the data came from. Provenance is a first-class field rather than an
 * afterthought: curated seed rows and future API rows must be distinguishable,
 * and confidence has to travel with the record for the honesty of the UI copy.
 */
export const placeSourceSchema = z.object({
  name: z.string().min(1),
  kind: z.enum(['curated', 'osm', 'google_places', 'opentripmap', 'wikivoyage', 'official']),
  url: z.string().url().optional(),
  /** 0-1. Curated-and-checked rows sit high; scraped rows will sit lower. */
  confidence: z.number().min(0).max(1),
  lastVerified: isoDateSchema,
});
export type PlaceSource = z.infer<typeof placeSourceSchema>;

/**
 * Seasonal reality. The Eastern Sierra is the archetype for why this cannot be a
 * boolean: Devils Postpile is road-closed most of the year and shuttle-only in
 * peak summer, while Tioga Pass simply does not exist as an option in April.
 */
export const seasonalAccessSchema = z
  .object({
    /** Months (1-12) the place is normally reachable. */
    openMonths: z.array(z.number().int().min(1).max(12)).min(1).max(12),
    closureRisk: closureRiskSchema,
    /** Months where a mandatory shuttle replaces private vehicles. */
    shuttleMonths: z.array(z.number().int().min(1).max(12)).max(12).default([]),
    note: z.string().min(1).optional(),
  })
  .refine(
    (value) => value.shuttleMonths.every((month) => value.openMonths.includes(month)),
    'Shuttle months must be a subset of open months',
  );
export type SeasonalAccess = z.infer<typeof seasonalAccessSchema>;

export const placeAccessSchema = z.object({
  requiresCar: z.boolean(),
  transitPossible: z.boolean(),
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
  id: z.string().min(1),
  regionId: z.string().min(1),
  name: z.string().min(1),
  locality: z.string().min(1),
  shortDescription: z.string().min(1).max(280),
  /** Base = you sleep here / it is the anchor. Satellite = you travel out to it. */
  relationship: z.enum(['base', 'satellite']),
  coordinates: coordinatesSchema,
  category: placeCategorySchema,
  /**
   * Interests this place genuinely satisfies, ordered by how central each one is
   * to the place itself. Order is load-bearing: the first entry the traveller
   * cares about becomes the place's primary interest, which is what frequency
   * ceilings are counted against. A viewpoint hike is a hike first.
   */
  interests: z.array(interestSchema).min(1),
  tags: z.array(z.string().min(1)).default([]),
  typicalDurationMinutes: z.number().int().min(15).max(600),
  costLevel: costLevelSchema,
  physicalIntensity: physicalIntensitySchema,
  crowdLevel: crowdLevelSchema,
  /** 0-1 how well known the place is. Deliberately separate from fit. */
  popularityScore: z.number().min(0).max(1),
  /** 0-1 how far off the standard tourist track it is. */
  hiddenGemScore: z.number().min(0).max(1),
  weatherSensitivity: weatherSensitivitySchema,
  /** Works as a wet- or bad-weather fallback. */
  worksInBadWeather: z.boolean(),
  bestTimeOfDay: timeOfDaySchema.default('any'),
  seasonalAccess: seasonalAccessSchema,
  access: placeAccessSchema,
  /** Set when this place shares an access road, gate or shuttle with others. */
  accessGroup: accessGroupSchema.optional(),
  travelFromBase: travelFromBaseSchema,
  /** Practical caveat shown verbatim on the card when present. */
  logisticsNote: z.string().min(1).optional(),
  imageUrl: z.string().url().optional(),
  source: placeSourceSchema,
});
export type Place = z.infer<typeof placeSchema>;

export const placeCollectionSchema = z.array(placeSchema);
