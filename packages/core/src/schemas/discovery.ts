import { z } from 'zod';

export const SELECTION_STATUSES = ['included', 'maybe', 'excluded'] as const;
export const selectionStatusSchema = z.enum(SELECTION_STATUSES);
export type SelectionStatus = z.infer<typeof selectionStatusSchema>;

/** Short enough to sit on one line in a three-up control on a narrow card. */
export const SELECTION_STATUS_LABELS: Record<SelectionStatus, string> = {
  included: 'Include',
  maybe: 'Maybe',
  excluded: 'Skip',
};

export const selectionSourceSchema = z.enum(['auto', 'user']);
export type SelectionSource = z.infer<typeof selectionSourceSchema>;

export const discoverySelectionSchema = z.object({
  placeId: z.string().min(1),
  status: selectionStatusSchema,
  /** Distinguishes an auto-picked default from a choice the traveller made. */
  source: selectionSourceSchema,
  updatedAt: z.string().min(1),
});
export type DiscoverySelection = z.infer<typeof discoverySelectionSchema>;

/**
 * The traveller's decision about a food venue.
 *
 * Deliberately its own table and its own type rather than a `DiscoverySelection`
 * with a venue id in the `placeId` field. Only two of the three statuses mean
 * anything here — a venue is somewhere you *would like* to eat or somewhere you
 * would rather not, and there is no "maybe" that the planner could act on
 * differently — and food selections must never be counted against the
 * activity-frequency caps or the day's capacity, which is exactly what would
 * happen if they arrived in the same list.
 */
export const foodSelectionSchema = z.object({
  venueId: z.string().min(1),
  status: z.enum(['included', 'excluded']),
  source: selectionSourceSchema,
  updatedAt: z.string().min(1),
});
export type FoodSelection = z.infer<typeof foodSelectionSchema>;

export const BOARD_GROUPS = [
  'must_see_classics',
  'hidden_gems',
  'nearby_side_quests',
  'scenic_detours',
  'low_effort_backups',
  'weak_fit',
] as const;
export const boardGroupSchema = z.enum(BOARD_GROUPS);
export type BoardGroup = z.infer<typeof boardGroupSchema>;

export const BOARD_GROUP_COPY: Record<BoardGroup, { title: string; blurb: string }> = {
  must_see_classics: {
    title: 'Must-see classics',
    blurb: 'The well-known stops that still earn their place for how you travel.',
  },
  hidden_gems: {
    title: 'Personalised hidden gems',
    blurb: 'Quieter finds that match what you said you care about.',
  },
  nearby_side_quests: {
    title: 'Nearby side quests',
    blurb: 'Short hops from your base that are worth breaking up a day for.',
  },
  scenic_detours: {
    title: 'Scenic detours',
    blurb: 'Drives and viewpoints where the route is the point.',
  },
  low_effort_backups: {
    title: 'Low-effort & bad-weather backups',
    blurb: 'What to do when the weather turns or the legs are done.',
  },
  weak_fit: {
    title: 'Probably skip',
    blurb: 'Popular or nearby, but a poor match for this trip. Here is why.',
  },
};
