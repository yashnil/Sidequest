import { z } from 'zod';
import { coordinatesSchema } from './common';

/**
 * A region is the unit Sidequest actually plans against. "Mammoth Lakes" is a
 * town; the trip is the Eastern Sierra. The base/satellite split is what lets
 * the product answer "what nearby is worth the detour" instead of only "what is
 * inside the place you typed".
 */
export const regionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** The place the traveller typed, and where they will sleep. */
  baseName: z.string().min(1),
  baseCoordinates: coordinatesSchema,
  summary: z.string().min(1),
  /** Outer bound of what this region can ever include. */
  maxRadiusKm: z.number().min(1),
  /** Strings a user might type that resolve to this region. */
  aliases: z.array(z.string().min(1)).default([]),
  /**
   * Why getting around this region works the way it does.
   *
   * A region fact, kept on the region. The strategy builder used to assert that
   * *any* destination "is a corridor with everything hanging off one highway",
   * which happens to be true of the Eastern Sierra and false of Tokyo.
   */
  transportSummary: z.string().min(1),
  /** What a traveller loses here by not driving. Region-specific, so it lives here. */
  noVehicleSummary: z.string().min(1),
  /** Why roads here close, when they do. Absent where nothing closes seasonally. */
  seasonalRoadSummary: z.string().min(1).optional(),
});
export type Region = z.infer<typeof regionSchema>;

export const WORTH_DETOUR_LABELS = [
  'core_to_trip',
  'definitely_worth_it',
  'worth_it_if_you_like_this',
  'only_if_nearby',
  'too_far_for_this_trip',
  'skip_for_your_style',
] as const;
export const worthDetourLabelSchema = z.enum(WORTH_DETOUR_LABELS);
export type WorthDetourLabel = z.infer<typeof worthDetourLabelSchema>;

export const WORTH_DETOUR_COPY: Record<WorthDetourLabel, string> = {
  core_to_trip: 'Core to your trip',
  definitely_worth_it: 'Worth the detour',
  worth_it_if_you_like_this: 'Worth it if this is your thing',
  only_if_nearby: 'Only if you are already nearby',
  too_far_for_this_trip: 'Too far for this trip',
  skip_for_your_style: 'Not your style',
};
