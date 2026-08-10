import { z } from 'zod';
import { destinationShapeSchema } from './timing';
import { scopeBreadthSchema } from './geography';

/**
 * HOW LONG THE WHOLE PATH TOOK, NOT JUST EACH STAGE OF IT.
 *
 * `stage_observations` already measures every stage of a compilation — duration,
 * provider calls, cache hits, warmth, and now the recovery pass. What it cannot
 * answer is the only question a traveller actually has: **how long from starting
 * a trip to having something I can use?** A stage clock cannot answer it because
 * the answer crosses stage boundaries, crosses screens, and includes the parts
 * where nothing of ours is running at all.
 *
 * Four spans, and each one ends at a point where the product became more useful
 * than it was: a profile exists, a board exists, a plan was computed, a plan
 * exists. Nothing else is a milestone; a span that ended when an internal
 * function returned would measure our architecture rather than somebody's
 * afternoon.
 *
 * ## The honesty problem, and how it is handled
 *
 * Three of these four are wall clock from the moment a trip was created, so they
 * contain human thinking time — nine questionnaire steps, a board somebody
 * browsed for ten minutes, a coffee. A number like that is true and is nearly
 * useless for judging whether a change made anything faster.
 *
 * So a span carries **two** figures. `durationMs` is what the traveller
 * experienced. `machineMs` is the part of it this system can account for as its
 * own work, summed from the stage observations and the planner's own clock.
 * `machineMs` is optional and its absence means *nobody counted*, never zero:
 * the same rule the readiness contract holds to, for the same reason.
 *
 * ## Where it may live
 *
 * On a row, never on the artifact. Everything here is a property of one run on
 * one machine on one afternoon, and `schemas/compiled-region.ts` sets out at
 * length why that may not be folded into something two builds have to agree on
 * byte for byte.
 */

export const JOURNEY_SPAN_VERSION = 1 as const;

export const JOURNEY_SPANS = [
  /** Trip created → a traveller profile exists. */
  'questionnaire_completion',
  /** Trip created → a Discovery Board exists with a starting selection on it. */
  'first_useful_board',
  /** The planner's own call. Machine time only; no human is waiting on a screen. */
  'planning',
  /** Trip created → an itinerary is stored and can be opened. */
  'usable_itinerary',
] as const;
export const journeySpanKindSchema = z.enum(JOURNEY_SPANS);
export type JourneySpanKind = z.infer<typeof journeySpanKindSchema>;

export const JOURNEY_SPAN_LABELS: Record<JourneySpanKind, string> = {
  questionnaire_completion: 'From starting a trip to finishing the questions',
  first_useful_board: 'From starting a trip to a usable Discovery Board',
  planning: 'Laying out the days',
  usable_itinerary: 'From starting a trip to a finished itinerary',
};

export const journeySpanSchema = z.object({
  schemaVersion: z.literal(JOURNEY_SPAN_VERSION),
  tripId: z.string().min(1),
  span: journeySpanKindSchema,
  startedAt: z.string().min(1),
  completedAt: z.string().min(1),
  /** Wall clock. What the traveller experienced, thinking time included. */
  durationMs: z.number().int().min(0),
  /**
   * The part of it this system can account for as its own work.
   *
   * Absent means nobody counted — never zero. A span with no attributable work
   * and a span whose work nobody measured are different claims, and only the
   * first is worth acting on.
   */
  machineMs: z.number().int().min(0).optional(),
  /** The bucketing a comparison needs, so a city is not averaged with a country. */
  breadth: scopeBreadthSchema.optional(),
  shape: destinationShapeSchema.optional(),
  observedAt: z.string().min(1),
});
export type JourneySpan = z.infer<typeof journeySpanSchema>;

/**
 * The share of a wall-clock span that was us.
 *
 * `null` rather than a number when nothing was attributed, because a bar drawn
 * at zero reads as "instant" and the truth is "unmeasured". The same distinction
 * `observed` draws on a readiness dimension.
 */
export function machineShareOf(span: JourneySpan): number | null {
  if (span.machineMs === undefined || span.durationMs <= 0) return null;
  return Math.min(1, span.machineMs / span.durationMs);
}
