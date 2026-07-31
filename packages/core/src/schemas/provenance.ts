import { z } from 'zod';
import { isoDateSchema } from './common';

/**
 * Where a fact came from, how sure we are of it, and how long it stays true.
 *
 * One vocabulary for every sourced fact in the domain. Transport access and
 * attraction opening hours are different facts about different things, but the
 * question "who published this, when did we read it, and will it be true next
 * year?" is the same question, and answering it twice in two shapes is how a UI
 * ends up labelling a modelled guess as an official timetable.
 *
 * `volatility` is the field that decides what the product may assert. It is the
 * line between what Sidequest can encode as a rule and what it must only ever
 * ask the traveller to check for themselves.
 */
export const SOURCE_VOLATILITIES = ['stable', 'seasonal_recurring', 'dynamic'] as const;
export const sourceVolatilitySchema = z.enum(SOURCE_VOLATILITIES);
export type SourceVolatility = z.infer<typeof sourceVolatilitySchema>;

export const sourceProvenanceSchema = z
  .object({
    /**
     * - `official`  — read off the managing agency's own page on `lastVerified`.
     * - `authored`  — written from general knowledge, not checked against a source.
     * - `estimated` — a modelled or inferred figure, never a published one.
     */
    kind: z.enum(['official', 'authored', 'estimated']),
    sourceName: z.string().min(1),
    sourceUrl: z.string().url().optional(),
    /**
     * When the source was last read. Absent for `authored` data, because a
     * verification date on something nobody verified is worse than no date.
     */
    lastVerified: isoDateSchema.optional(),
    confidence: z.number().min(0).max(1),
    volatility: sourceVolatilitySchema,
    /** What the traveller must confirm themselves. Required when dynamic. */
    recheckNote: z.string().min(1).optional(),
  })
  .refine((value) => value.kind !== 'official' || value.lastVerified !== undefined, {
    message: 'Official data must record when it was verified',
    path: ['lastVerified'],
  });
export type SourceProvenance = z.infer<typeof sourceProvenanceSchema>;
