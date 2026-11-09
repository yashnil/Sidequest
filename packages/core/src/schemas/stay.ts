import { z } from 'zod';

/**
 * RELEASE CANDIDATE — THE RECORD OF WHERE THE TRIP SLEEPS, AND WHY.
 *
 * Written by the stay objective (`scan/stay-objective.ts`) when a scan's bases
 * are chosen, stored on the region's base portfolio and copied onto the plan
 * (`itinerary.package.planning.stay`), so any screen can explain the structure
 * in a sentence with its numbers rather than restating a rule. Every figure is
 * minutes of the traveller's time; `basis` says whether a router measured the
 * travel or Sidequest estimated it.
 */
export const MOVE_TOLERANCES = ['stay_put', 'move_once', 'move_if_it_saves_time', 'move_freely'] as const;
export const moveToleranceSchema = z.enum(MOVE_TOLERANCES);
export type MoveTolerance = z.infer<typeof moveToleranceSchema>;

const minutes = z.number().finite();

export const stayOptionSchema = z.object({
  stays: z.array(z.object({ baseId: z.string().min(1), baseName: z.string().min(1), nights: z.number().int().nonnegative() })).min(1),
  moves: z.number().int().nonnegative(),
  /** Loops out from where you sleep, summed over the trip. */
  dayTravelMinutes: minutes,
  /** Between stays, plus arrival and departure legs when known. */
  transferMinutes: minutes,
  /** Clock time lost to packing up and checking in and out, over all moves. */
  moveOverheadMinutes: minutes,
  /** The traveller's own reluctance to move, in minutes-equivalent, over all moves. */
  moveInconvenienceMinutes: minutes,
  /** Tier-weighted visit minutes of what this structure cannot fit or reach. */
  unseenValueMinutes: minutes,
  /** Minutes of ordinary day nothing within reach could fill, below this pace's fill target. */
  idleMinutes: minutes,
  placesSeen: z.number().int().nonnegative(),
  /** The part of any transfer beyond the traveller's daily travel ceiling, counted once more. */
  overLimitTransferMinutes: minutes,
  totalCostMinutes: minutes,
});
export type StayOption = z.infer<typeof stayOptionSchema>;

export const stayDecisionSchema = z.object({
  version: z.literal(1),
  chosen: stayOptionSchema,
  /** The best structure for each other number of moves the search considered. */
  alternatives: z.array(stayOptionSchema).default([]),
  /** What one move costs this traveller before its transfer. */
  moveCost: z.object({ overheadMinutes: minutes, inconvenienceMinutes: minutes, tolerance: moveToleranceSchema, factors: z.array(z.string().min(1)).default([]) }),
  minNightsPerStay: z.number().int().positive(),
  /** Hotel changes the traveller allows; the search never exceeds it. */
  maxMovesAllowed: z.number().int().nonnegative(),
  basis: z.enum(['measured', 'estimated']),
  /** Minutes a structure with more moves had to win by. */
  marginMinutes: minutes,
  /** One sentence a screen can show. */
  sentence: z.string().min(1),
});
export type StayDecision = z.infer<typeof stayDecisionSchema>;
