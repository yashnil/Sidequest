import { z } from 'zod';

/**
 * ROUTE FEASIBILITY — WHAT A TRAVEL FIGURE MAY CLAIM ABOUT THE ROAD BEHIND IT.
 *
 * A travel time says how long; this says how much anybody knows about whether
 * the journey exists at all. Two points 6 km apart either side of a sea cliff
 * are "6 km apart" and three hours apart by road, and a straight-line estimate
 * cannot tell those apart. The status travels with the figure so that nothing
 * downstream reads proximity as driveability.
 *
 *   verified              a router measured this exact pair on this profile
 *   bounded_estimate      nobody measured it, but measured legs to a common
 *                         point prove it is at least this long (triangle
 *                         inequality, `travel/feasibility.ts`); the figure is a
 *                         floor, never a precise time
 *   plausible_unverified  only the straight-line estimate stands behind it
 *   disconnected          a router evaluated both resolved endpoints on this
 *                         profile and affirmatively reported no route — the
 *                         `AUTHORITATIVE_NO_ROUTE` rule; a declined matrix cell,
 *                         a timeout or an error is never this
 *   other_mode_required   the leg is a ferry, a flight or a boat: no road
 *                         measurement applies
 *   provider_unavailable  a router was wanted and could not answer (not
 *                         configured, unreachable, out of coverage, failed);
 *                         nothing is known either way
 */
export const ROUTE_FEASIBILITY_STATUSES = ['verified', 'bounded_estimate', 'plausible_unverified', 'disconnected', 'other_mode_required', 'provider_unavailable'] as const;
export const routeFeasibilitySchema = z.enum(ROUTE_FEASIBILITY_STATUSES);
export type RouteFeasibility = z.infer<typeof routeFeasibilitySchema>;
