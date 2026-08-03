import { z } from 'zod';

/**
 * IS THERE ENOUGH HERE TO PLAN A TRIP — ASKED BEFORE THE MONEY IS SPENT.
 *
 * The failure this exists to prevent, measured on a live run: a whole-country
 * eleven-night compilation produced 35 source records, 13 candidates and 8
 * retained, and reported "there is not enough to plan on" **after** several
 * minutes of official-source research and model extraction. Every number in that
 * sentence was knowable in seconds, from the region pack, before a single page
 * was fetched.
 *
 * So supply is judged at the cheap end of the funnel, and the judgement carries
 * three things a bare verdict cannot:
 *
 * 1. **The measured funnel**, so a traveller and an operator can see *where* it
 *    thinned rather than only that it did.
 * 2. **A classification with a defined remedy**, so "thin" leads somewhere.
 * 3. **Recovery actions the traveller can actually take**, each of which
 *    preserves the answers they have already given.
 *
 * The rule that keeps this honest: **repair widens the search, it never lowers
 * the bar.** Dropping the quality threshold until weak objects pass would turn
 * an insufficient region into a board full of names on a map, which is the exact
 * failure the quality filter exists to prevent.
 */

export const SUPPLY_LEVELS = [
  /** Comfortably more than the trip needs. */
  'strong',
  /** Enough, with less slack than we would like. Named, not hidden. */
  'usable',
  /** Not enough yet, and there is a generic widening that might fix it. */
  'thin_repairable',
  /** Not enough, and nothing we can do about it without changing the trip. */
  'insufficient',
  /** The sources did not answer. Not a statement about the destination at all. */
  'infrastructure_failure',
] as const;
export const supplyLevelSchema = z.enum(SUPPLY_LEVELS);
export type SupplyLevel = z.infer<typeof supplyLevelSchema>;

export const SUPPLY_LEVEL_LABELS: Record<SupplyLevel, string> = {
  strong: 'Plenty to work with',
  usable: 'Enough to work with',
  thin_repairable: 'Thin — widening the search',
  insufficient: 'Not enough to plan on',
  infrastructure_failure: 'Our sources did not answer',
};

/**
 * What the traveller can do about it.
 *
 * Every one of these preserves the composer answers already given. An action
 * that meant starting over would not be a recovery, and the flow's whole promise
 * is that going back to change one thing costs one thing.
 */
export const SUPPLY_ACTIONS = [
  'narrow_destination',
  'broaden_interests',
  'allow_more_driving',
  'change_base_strategy',
  'choose_gateway',
  'continue_partial',
  'change_destination',
  'retry',
] as const;
export const supplyActionSchema = z.enum(SUPPLY_ACTIONS);
export type SupplyAction = z.infer<typeof supplyActionSchema>;

export const SUPPLY_ACTION_LABELS: Record<SupplyAction, string> = {
  narrow_destination: 'Pick one part of it',
  broaden_interests: 'Widen what counts as interesting',
  allow_more_driving: 'Accept more driving',
  change_base_strategy: 'Change how often you move base',
  choose_gateway: 'Start from a nearby town instead',
  continue_partial: 'Carry on with what we have',
  change_destination: 'Somewhere else',
  retry: 'Try again',
};

/** Every number the verdict was reached from. Measured, never estimated. */
export const supplyFunnelSchema = z.object({
  /** Records the place backbone actually returned. */
  sourceRecords: z.number().int().nonnegative(),
  /** Records that survived normalisation into candidates. */
  candidates: z.number().int().nonnegative(),
  /** Distinct categories among them. One category is not a trip. */
  categories: z.number().int().nonnegative(),
  /** Geographic clusters the candidates fall into. */
  clusters: z.number().int().nonnegative(),
  /** Candidates that could anchor a day rather than support one. */
  anchors: z.number().int().nonnegative(),
  /** Candidates near a plausible base — food, fuel, a bed. */
  supportStops: z.number().int().nonnegative(),
  /** Places we found somewhere to sleep in. */
  baseCandidates: z.number().int().nonnegative(),
  /** Days the trip has to fill. The denominator for everything above. */
  tripDays: z.number().int().nonnegative(),
});
export type SupplyFunnel = z.infer<typeof supplyFunnelSchema>;

export const SUPPLY_ASSESSMENT_VERSION = 1 as const;

export const supplyAssessmentSchema = z.object({
  schemaVersion: z.literal(SUPPLY_ASSESSMENT_VERSION),
  level: supplyLevelSchema,
  funnel: supplyFunnelSchema,
  /** One sentence, with a real number in it. */
  summary: z.string().min(1),
  /** Each shortfall named separately, so the fix is obvious. */
  shortfalls: z.array(z.string().min(1)).default([]),
  /** Ordered, most likely to help first. Empty when nothing would. */
  actions: z.array(supplyActionSchema).default([]),
  /** Which widening was attempted, when one was. */
  repairsAttempted: z.array(z.string().min(1)).default([]),
  assessedAt: z.string().min(1),
});
export type SupplyAssessment = z.infer<typeof supplyAssessmentSchema>;

/**
 * How many anchor-grade candidates a day needs before a board stops being thin.
 *
 * Two. One is a day with no alternative when it rains, no second option if
 * something is shut, and nothing for the traveller to choose between — which
 * makes the Discovery Board, whose entire purpose is choosing, pointless.
 */
export const ANCHORS_PER_DAY = 2;

/** Below this many distinct categories, every day is the same day. */
export const MIN_CATEGORIES = 3;

/**
 * What the numbers in the funnel actually are.
 *
 * The preflight counts *settlements and areas from map data*; the compiler
 * counts *candidate places that survived quality filtering*. Both are useful and
 * they are not the same thing — and a live capture showed the preflight telling
 * a traveller "150 candidates", which reads as a hundred and fifty things to do
 * when it means a hundred and fifty populated places. One word, and it was an
 * overclaim.
 */
export const SUPPLY_BASES = ['map_records', 'researched_candidates'] as const;
export const supplyBasisSchema = z.enum(SUPPLY_BASES);
export type SupplyBasis = z.infer<typeof supplyBasisSchema>;

export interface AssessSupplyInput {
  funnel: SupplyFunnel;
  /** What was counted. Decides the noun in every sentence below. */
  basis?: SupplyBasis;
  /** Set when the backbone itself failed, which is a different verdict entirely. */
  infrastructureFailed?: boolean;
  /** Whether a widening pass has already run. Decides repairable vs insufficient. */
  alreadyRepaired?: boolean;
  now: Date;
}

/**
 * The verdict, from the funnel alone.
 *
 * Pure and deterministic, so the same measurements always produce the same
 * sentence — and so the thresholds are visible in one place rather than spread
 * across the compiler as scattered `if (kept.length === 0)` early returns, which
 * is how the old flow came to have four different "not enough" messages that
 * fired at four different costs.
 */
export function assessSupply(input: AssessSupplyInput): SupplyAssessment {
  const { funnel } = input;
  const shortfalls: string[] = [];
  const actions: SupplyAction[] = [];

  if (input.infrastructureFailed) {
    return {
      schemaVersion: SUPPLY_ASSESSMENT_VERSION,
      level: 'infrastructure_failure',
      funnel,
      summary: 'Our place data source did not answer, so we cannot say what is here.',
      shortfalls: ['This is about our sources, not about the destination.'],
      actions: ['retry'],
      repairsAttempted: [],
      assessedAt: input.now.toISOString(),
    };
  }

  const anchorsNeeded = Math.max(ANCHORS_PER_DAY, funnel.tripDays * ANCHORS_PER_DAY);
  const anchorRatio = anchorsNeeded === 0 ? 1 : funnel.anchors / anchorsNeeded;

  if (funnel.anchors < anchorsNeeded) {
    shortfalls.push(
      `${funnel.anchors} place${funnel.anchors === 1 ? '' : 's'} worth building a day around, against the ${anchorsNeeded} a ${funnel.tripDays}-day trip needs.`,
    );
  }
  if (funnel.categories < MIN_CATEGORIES) {
    shortfalls.push(
      `Only ${funnel.categories} kind${funnel.categories === 1 ? '' : 's'} of thing to do, so every day would look the same.`,
    );
  }
  if (funnel.baseCandidates === 0) {
    shortfalls.push('Nowhere inside the region we could sensibly base you.');
  }
  if (funnel.clusters === 0) {
    shortfalls.push('Nothing we found groups into an area a day could cover.');
  }

  const level: SupplyLevel = input.infrastructureFailed
    ? 'infrastructure_failure'
    : shortfalls.length === 0 && anchorRatio >= 2
      ? 'strong'
      : shortfalls.length === 0
        ? 'usable'
        : funnel.baseCandidates === 0 || anchorRatio < 0.25
          ? input.alreadyRepaired
            ? 'insufficient'
            : 'thin_repairable'
          : input.alreadyRepaired
            ? 'usable'
            : 'thin_repairable';

  if (level === 'thin_repairable' || level === 'insufficient') {
    /*
     * Ordered by how much they usually help, and every one of them is something
     * the *traveller* controls. "Try a different search" is our job, not theirs,
     * and it has already happened by the time this list is shown.
     */
    actions.push('narrow_destination', 'broaden_interests', 'allow_more_driving', 'change_base_strategy');
    if (funnel.baseCandidates === 0) actions.push('choose_gateway');
    if (level === 'thin_repairable' && funnel.anchors > 0) actions.push('continue_partial');
    actions.push('change_destination');
  }

  const noun = input.basis === 'researched_candidates' ? 'candidate' : 'mapped place';
  const plural = funnel.candidates === 1 ? noun : `${noun}s`;
  const areas = `${funnel.clusters} area${funnel.clusters === 1 ? '' : 's'}`;

  const summary =
    level === 'strong'
      ? `${funnel.candidates} ${plural} across ${areas} — comfortably enough to build ${funnel.tripDays} days from.`
      : level === 'usable'
        ? `${funnel.candidates} ${plural} across ${areas}. Enough for ${funnel.tripDays} days, without much to spare.`
        : level === 'insufficient'
          ? `We found ${funnel.candidates} ${plural} here, and widening the search did not change that.`
          : `Only ${funnel.candidates} ${plural} so far, which is thin for ${funnel.tripDays} days. We will widen the search before spending anything on research.`;

  return {
    schemaVersion: SUPPLY_ASSESSMENT_VERSION,
    level,
    funnel,
    summary,
    shortfalls,
    actions,
    repairsAttempted: [],
    assessedAt: input.now.toISOString(),
  };
}

/** Whether the funnel is good enough to justify paid research. */
export function supplyAllowsResearch(assessment: SupplyAssessment): boolean {
  return assessment.level === 'strong' || assessment.level === 'usable';
}
