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

export const TRAIL_STAGE_RESOLUTIONS = ['walk', 'split', 'alternative', 'unresolved'] as const;
export const trailStageRecordSchema = z.object({
  placeId: z.string().min(1),
  name: z.string().min(1),
  /** 1-based position along the trail as followed. */
  order: z.number().int().positive(),
  fromBaseId: z.string().min(1).nullable(),
  toBaseId: z.string().min(1).nullable(),
  fromName: z.string().min(1).nullable(),
  toName: z.string().min(1).nullable(),
  km: z.number().nonnegative().nullable(),
  ascentM: z.number().nonnegative().nullable(),
  /** `measured`: a hiking router answered; `proposal`: the research model's own figures; `duration`: neither, the time on site the model gave. */
  distanceBasis: z.enum(['measured', 'proposal', 'duration']),
  walkMinutes: z.number().nonnegative(),
  resolution: z.enum(TRAIL_STAGE_RESOLUTIONS),
  /** The day this stage is the move, once the stays are chosen. */
  dayNumber: z.number().int().positive().optional(),
  /** Latest start that still finishes before civil dusk with the margin, minutes from local midnight. */
  latestStartMinute: z.number().optional(),
  duskMinute: z.number().optional(),
  /** What the day says about it: why it was split or replaced, or what is still unresolved. */
  note: z.string().min(1).optional(),
  /** Which half of a split stage this is. */
  part: z.union([z.literal(1), z.literal(2)]).optional(),
});
export type TrailStageRecord = z.infer<typeof trailStageRecordSchema>;

export const trailRecordSchema = z.object({
  version: z.literal(1),
  followed: z.boolean(),
  stages: z.array(trailStageRecordSchema).default([]),
  /** Proposed stages left out of the sequence, with why (an end nobody could place, a stage that joins nothing). */
  dropped: z.array(z.object({ name: z.string().min(1), reason: z.string().min(1) })).default([]),
  limits: z.object({ walkMinutes: z.number().positive(), ascentM: z.number().positive(), basis: z.string().min(1) }),
  /** Rest nights the stays hold mid-trail, at a village with a hot spring where the scan offered one. */
  restBaseIds: z.array(z.string().min(1)).default([]),
  /** From the trail's last bed to where the traveller leaves, estimated. */
  returnLeg: z.object({ fromBaseId: z.string().min(1), fromName: z.string().min(1), minutes: z.number().nonnegative(), basis: z.literal('estimated') }).optional(),
  /** Why the trip is not walked inn to inn, when it is not. */
  gap: z.string().min(1).optional(),
});
export type TrailRecord = z.infer<typeof trailRecordSchema>;

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
  /**
   * A route-shaped trip (a ring road, a road trip, "A to B"): the proposed
   * bases along the route, which of them the chosen stays sleep within a
   * day's reach of, and which the nights or the hotel changes allowed could
   * not. Absent on a trip that is not a route.
   */
  route: z
    .object({
      shape: z.enum(['loop', 'linear', 'touring']),
      parts: z.array(z.string().min(1)).default([]),
      covered: z.array(z.string().min(1)).default([]),
      uncovered: z.array(z.string().min(1)).default([]),
    })
    .optional(),
  /**
   * 2026-11 (point-to-point trekking) — a stage-based walk followed inn to
   * inn (`scan/trail-stages.ts`): the ordered stages, how each is covered
   * (walked, split at an intermediate overnight, replaced by the usual bus or
   * skip, or still unresolved), the figures each was judged on and where they
   * came from, and the party's limits. `followed: false` with a `gap` says
   * honestly that the trip could not be planned as a walk from inn to inn.
   */
  trail: trailRecordSchema.optional(),
});
export type StayDecision = z.infer<typeof stayDecisionSchema>;
