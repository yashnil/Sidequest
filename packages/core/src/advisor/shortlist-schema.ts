import { z } from 'zod';
import { DESTINATION_KINDS, WORLD_REGIONS } from './catalog/schema';
import { FACTOR_IDS } from './profile';

/**
 * THE STORED ADVISOR SHORTLIST.
 *
 * Written once per build to `decision_sessions.shortlist_json` and read by the
 * page, so a refresh, a back button and a shared link re-run nothing. The
 * `kind: 'advisor'` discriminator separates it from the previous ranker's
 * stored lists, which are still readable and are offered a rebuild.
 */
export const ADVISOR_SHORTLIST_VERSION = 1;

const factorSchema = z.object({
  id: z.enum(FACTOR_IDS),
  label: z.string(),
  weight: z.number(),
  value: z.number().nullable(),
  basis: z.string(),
});

export const advisorPickSchema = z.object({
  id: z.string(),
  name: z.string(),
  context: z.string(),
  kind: z.enum(DESTINATION_KINDS),
  worldRegion: z.enum(WORLD_REGIONS),
  countries: z.array(z.string()),
  center: z.object({ lat: z.number(), lng: z.number() }),
  radiusKm: z.number(),
  resolveAs: z.string(),
  wikidataId: z.string().optional(),
  role: z.enum(['primary', 'alternate']),
  score: z.number(),
  coverage: z.number(),
  match: z.enum(['strong', 'good', 'possible']),
  pitch: z.string(),
  /** Why it fits this traveller, in one sentence built from what was measured. */
  why: z.string(),
  /** Two or three of its highlights, chosen for what the traveller asked for. */
  experiences: z.array(z.string()),
  /** What this one is best at among what was asked for, in words — e.g. "bears and glaciers". */
  signature: z.string().nullable().default(null),
  /** Interests it serves strongly, by label. */
  strongFor: z.array(z.string()),
  window: z.object({ months: z.array(z.number()), label: z.string() }),
  nights: z.object({ suggested: z.number(), min: z.number(), max: z.number() }),
  character: z.string(),
  gettingThere: z.string(),
  gettingAround: z.string(),
  cost: z.object({ level: z.number(), label: z.string(), versusBudget: z.string().nullable() }),
  bases: z.array(z.string()),
  tradeoffs: z.array(z.string()),
  unverified: z.array(z.string()),
  /** For picks after the first: what makes it a different answer. */
  differsBy: z.string().nullable(),
  distanceKm: z.number().nullable(),
  climate: z
    .object({
      status: z.enum(['verified', 'differs', 'unavailable', 'not_checked']),
      note: z.string(),
    })
    .default({ status: 'not_checked', note: 'Weather not yet checked against records.' }),
  factors: z.array(factorSchema),
  references: z.array(z.string()),
});
export type AdvisorPick = z.infer<typeof advisorPickSchema>;

export const advisorShortlistSchema = z.object({
  kind: z.literal('advisor'),
  version: z.literal(ADVISOR_SHORTLIST_VERSION),
  catalogVersion: z.string(),
  builtAt: z.string(),
  elapsedMs: z.number(),
  picks: z.array(advisorPickSchema),
  alternates: z.array(advisorPickSchema),
  readout: z.object({
    /** What drove the ranking, most important first, in words. */
    drivers: z.array(z.string()),
    assumptions: z.array(z.string()),
    /** Things the traveller has not said that would most change the list. */
    openQuestions: z.array(z.string()),
    /** How the picks differ from one another, in one line. */
    spread: z.string().nullable(),
    /** When few or no destinations fit: the constraint that bit and how to relax it. */
    relaxation: z.string().nullable(),
    closeCalls: z.array(z.string()),
  }),
  stats: z.object({
    catalog: z.number(),
    eligible: z.number(),
    excluded: z.record(z.string(), z.number()),
    lambda: z.number(),
    climateChecked: z.number(),
    climateVerified: z.number(),
  }),
  /** What changed from the previous list after a refinement, in words. */
  changes: z.array(z.string()).default([]),
  previousIds: z.array(z.string()).default([]),
});
export type AdvisorShortlist = z.infer<typeof advisorShortlistSchema>;

export function isAdvisorShortlist(value: unknown): value is AdvisorShortlist {
  return typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === 'advisor';
}
