import { z } from 'zod';

/**
 * IS WHAT WE FOUND GOOD ENOUGH TO PLAN A TRIP FROM?
 *
 * Everything before this asks whether a record *may* be here — is it inside the
 * scope, is it a thing to do, is it a duplicate. Nothing asked the question a
 * traveller actually has: **is this a fair picture of the destination I named?**
 *
 * That gap is not theoretical. A request for a major world city produced
 * forty-five candidates, effectively all food and shops in one outlying suburb,
 * with no central attractions, no stations and almost no opening hours — and
 * every layer downstream treated it as a finished region, because every record
 * in it was individually admissible. Admissibility is a property of a record.
 * Representativeness is a property of a *set*, and this is the type that holds
 * it.
 *
 * Three rules shape the design.
 *
 * **No score.** There is no percentage and no single number to optimise. A level
 * is a rule over named dimensions, and the dimensions that decided it are listed
 * so a person can disagree with the specific one rather than with a total.
 *
 * **No fabricated zero.** A dimension nobody could measure is `unmeasured`, which
 * is a different state from `unmet`. `observed` is optional throughout; an
 * absence is never written as 0.
 *
 * **Destination shape matters.** A quiet island with nine good places and a
 * capital with nine are not the same result, and a universal quota would call
 * one of them wrong. Expectations are derived from trip length and what kind of
 * destination this is, and are carried on the report so the arithmetic is
 * inspectable rather than implied.
 */

export const RESEARCH_READINESS_VERSION = 1 as const;

/**
 * Four states, and the middle two are the ones that earn their keep.
 *
 * `recoverable` is the only one the system acts on by itself: it means a named,
 * bounded repair would plausibly fix the deficit. `thin` means the shortfall is
 * real and nothing we can do about it — the ground is genuinely quiet — which is
 * a usable trip and must not be confused with a broken one.
 */
export const RESEARCH_READINESS_LEVELS = ['ready', 'recoverable', 'thin', 'blocked'] as const;
export const researchReadinessLevelSchema = z.enum(RESEARCH_READINESS_LEVELS);
export type ResearchReadinessLevel = z.infer<typeof researchReadinessLevelSchema>;

export const RESEARCH_READINESS_COPY: Record<
  ResearchReadinessLevel,
  { label: string; blurb: string }
> = {
  ready: {
    label: 'Ready to plan',
    blurb: 'We found a fair spread of things to do here, and enough detail to build real days.',
  },
  recoverable: {
    label: 'Still looking',
    blurb: 'What we have so far is not a fair picture of this place, so we are going back for more.',
  },
  thin: {
    label: 'Thin, but usable',
    blurb:
      'There genuinely is not much published about this place. What follows is real; there is just less of it than usual.',
  },
  blocked: {
    label: 'Not enough to plan from',
    blurb:
      'What we found would not make an honest trip here, and going back for more did not help. Better to say so than to hand you a confident guess.',
  },
};

/**
 * The questions asked of the set. One id per question, never collapsed, because
 * each has a different remedy and a merged score would hide which one failed.
 */
export const RESEARCH_DIMENSIONS = [
  /** Does the candidate geography agree with the destination that was asked for? */
  'identity_agreement',
  /** Does the compiled ground still cover the destination's own published extent? */
  'destination_coverage',
  /** Are there enough things to do for the number of days? */
  'experience_supply',
  /** Anchors, discoveries, food and support in a sane proportion. */
  'role_diversity',
  /** More than one kind of thing to do. */
  'category_diversity',
  /** Something for what the traveller said they came for. */
  'interest_coverage',
  /** Places well-known enough to build a day around, where a destination has any. */
  'anchor_coverage',
  /** Quiet finds, where the traveller asked for them. */
  'hidden_gem_coverage',
  /** Food and infrastructure are not standing in for things to do. */
  'support_balance',
  /** Bases and satellites where the trip's shape needs them. */
  'base_satellite_coverage',
  /** The things the traveller named themselves. */
  'must_do_coverage',
  /** Can we measure journeys in the modes this trip actually needs? */
  'transport_routeability',
  /** Do we know when things are open? */
  'hours_evidence',
  /** More than one catalogue, and membership actually established. */
  'source_confidence',
  /** Spread across the destination rather than pooled in one corner. */
  'geographic_spread',
] as const;
export const researchDimensionSchema = z.enum(RESEARCH_DIMENSIONS);
export type ResearchDimension = z.infer<typeof researchDimensionSchema>;

export const RESEARCH_DIMENSION_LABELS: Record<ResearchDimension, string> = {
  identity_agreement: 'The place we searched',
  destination_coverage: 'How much of it we covered',
  experience_supply: 'Enough to fill the days',
  role_diversity: 'A mix of kinds',
  category_diversity: 'Variety',
  interest_coverage: 'What you came for',
  anchor_coverage: 'The well-known ones',
  hidden_gem_coverage: 'The quiet ones',
  support_balance: 'Things to do, not just places to eat',
  base_satellite_coverage: 'Somewhere to stay, and trips out',
  must_do_coverage: 'What you asked for by name',
  transport_routeability: 'Getting between them',
  hours_evidence: 'When things are open',
  source_confidence: 'How well sourced this is',
  geographic_spread: 'Spread across the area',
};

/**
 * `unmeasured` is not a failure and never counts as one.
 *
 * A dimension we could not evaluate — because the input it reads was itself
 * absent — is a hole in our instrument, not a verdict about the destination. It
 * is reported and excluded from the level rule, which is what stops a broken
 * measurement from reading as a broken place.
 */
export const RESEARCH_DIMENSION_STATES = ['met', 'partial', 'unmet', 'not_applicable', 'unmeasured'] as const;
export const researchDimensionStateSchema = z.enum(RESEARCH_DIMENSION_STATES);
export type ResearchDimensionState = z.infer<typeof researchDimensionStateSchema>;

export const researchDimensionReportSchema = z.object({
  dimension: researchDimensionSchema,
  state: researchDimensionStateSchema,
  /** Measured. Absent means not measured — never zero. */
  observed: z.number().optional(),
  /** What this destination and trip length made us expect. Absent when nothing did. */
  expected: z.number().optional(),
  /** One sentence a traveller could read, with a real number in it. */
  detail: z.string().min(1),
  /**
   * Whether failing this alone withholds the board.
   *
   * A small set of dimensions are required and the rest are advisory. Which are
   * required is a property of the destination and the trip, decided by the
   * assessor and recorded here, so a country and a city can differ without a
   * second code path.
   */
  required: z.boolean(),
});
export type ResearchDimensionReport = z.infer<typeof researchDimensionReportSchema>;

/** Everything counted, so a level is inspectable rather than asserted. */
export const researchFunnelSchema = z.object({
  /** Records the pack yielded, before any admission. */
  packRecords: z.number().int().min(0),
  /** Things to do that survived every gate. */
  visitable: z.number().int().min(0),
  /** Of those, ones we can build a day around. */
  anchors: z.number().int().min(0),
  discoveries: z.number().int().min(0),
  food: z.number().int().min(0),
  support: z.number().int().min(0),
  gateways: z.number().int().min(0),
  /** Attractions kept as discoveries because we could not place them. */
  anchorDemotions: z.number().int().min(0),
  /** Admitted records whose administrative membership nobody could establish. */
  membershipUnverified: z.number().int().min(0),
  tripDays: z.number().int().min(0),
});
export type ResearchFunnel = z.infer<typeof researchFunnelSchema>;

/**
 * Bounded repairs, named. Each is a way of *looking again*, never of lowering a
 * bar — a repair that relaxed a threshold would be manufacturing the readiness
 * it claims to measure.
 */
export const RESEARCH_REPAIRS = [
  /** Ask the fallback source for the specific categories that came back empty. */
  'category_targeted_query',
  /** Re-read the parts of the ground that produced nothing. */
  'reread_underserved_areas',
  /** Look for stations, terminals and airports where the trip needs a way in. */
  'gateway_discovery',
  /** The cached ground is incomplete; buy it again. */
  'refresh_stale_pack',
  /** The destination we resolved does not agree with the ground we read. */
  'reresolve_identity',
  /**
   * Read the whole map layer again, looking for the things the traveller named.
   *
   * Deficit-directed in the strict sense: the subject is one specific request
   * rather than the shape of the board. The first pass answers from what this
   * trip can actually use; this one goes back over **every record the ground
   * layer holds**, including the ones the inventory refused, with the
   * containment overlay's verdict on each — which is the only place left where
   * evidence about a named subject could still be.
   *
   * What it produces is a *truer status*, never a wider board. The matrix, the
   * hours and the access rules were bought for the set that survived admission,
   * so a record added after them would be a card with no travel time and no
   * opening hours. A repair that quietly included one would be manufacturing the
   * coverage it claims to measure. Keeping a named place *on* the board in the
   * first place is a different mechanism and happens earlier; see
   * `namedByTraveller` on the discovery seam.
   */
  'targeted_subject_query',
] as const;
export const researchRepairSchema = z.enum(RESEARCH_REPAIRS);
export type ResearchRepair = z.infer<typeof researchRepairSchema>;

export const RESEARCH_REPAIR_COPY: Record<ResearchRepair, string> = {
  category_targeted_query: 'Looking specifically for the kinds of places we came up short on',
  reread_underserved_areas: 'Going back over the parts of the area that turned up empty',
  gateway_discovery: 'Finding the stations and terminals this trip needs',
  refresh_stale_pack: 'Fetching the map data again, because what we had was incomplete',
  reresolve_identity: 'Checking we searched the right place',
  targeted_subject_query: 'Looking again for the places you named yourself',
};

/**
 * DIMENSIONS THAT MAY NOT WITHHOLD A BOARD, EVEN WHEN THEY FAIL OUTRIGHT.
 *
 * `blocked` means "what we found would not make an honest trip here". That is a
 * verdict about the *destination*, and only a dimension that measures the
 * destination may reach it.
 *
 * `must_do_coverage` does not. It measures our answer to one specific request,
 * and failing it says nothing about whether the other forty things we found are
 * real. Withholding the whole board because one named place could not be found
 * would replace a good trip with no trip — which is the same mistake the
 * planner's terminal gate already refuses to make, where `must_include_unscheduled`
 * is deliberately excluded from the codes that invalidate an itinerary. One
 * argument, applied at both ends of the pipeline.
 */
export const NON_WITHHOLDING_DIMENSIONS: readonly ResearchDimension[] = ['must_do_coverage'];

export function dimensionWithholdsBoard(dimension: ResearchDimension): boolean {
  return !NON_WITHHOLDING_DIMENSIONS.includes(dimension);
}

export const researchRepairAttemptSchema = z.object({
  repair: researchRepairSchema,
  /** Which deficits this attempt was chosen to address. */
  addressing: z.array(researchDimensionSchema).min(1),
  outcome: z.enum(['improved', 'no_change', 'failed', 'budget_refused']),
  /** The level before and after, so a loop cannot claim progress it did not make. */
  levelBefore: researchReadinessLevelSchema,
  levelAfter: researchReadinessLevelSchema,
  /** Visitable candidates before and after. The measurable part of "it helped". */
  visitableBefore: z.number().int().min(0),
  visitableAfter: z.number().int().min(0),
  detail: z.string().min(1),
});
export type ResearchRepairAttempt = z.infer<typeof researchRepairAttemptSchema>;

export const destinationResearchReadinessSchema = z.object({
  schemaVersion: z.literal(RESEARCH_READINESS_VERSION),
  level: researchReadinessLevelSchema,
  funnel: researchFunnelSchema,
  dimensions: z.array(researchDimensionReportSchema),
  /** The unmet required dimensions that decided the level. Empty when `ready`. */
  binding: z.array(researchDimensionSchema).default([]),
  /** Repairs worth trying, in the order the loop would try them. */
  repairs: z.array(researchRepairSchema).default([]),
  /** What was actually tried, and what it bought. Append-only within one build. */
  repairsAttempted: z.array(researchRepairAttemptSchema).default([]),
  /** One sentence. Names a number, names no destination. */
  summary: z.string().min(1),
});
export type DestinationResearchReadiness = z.infer<typeof destinationResearchReadinessSchema>;

/**
 * THE LEVEL, AS A RULE OVER THE DIMENSIONS RATHER THAN A SCORE.
 *
 * In core rather than beside the assessor, because two things now need it and a
 * second copy would drift: the compiler decides a level at build time, and the
 * settlement below re-decides one after a traveller has answered a question the
 * build could not. Two implementations of a level rule is how a board comes to
 * explain itself differently on two screens.
 *
 * The line between `ready` and `thin` is the one worth being careful about. An
 * advisory dimension coming back `partial` is the *ordinary* condition of open
 * data — we know the opening hours for ten places out of fourteen, which is a
 * good day — and treating that as a shortfall would mark every destination on
 * earth as thin, which tells a traveller nothing. `thin` is reserved for a
 * material shortfall: a required dimension that only half holds, or an advisory
 * one that fails outright.
 */
export function researchLevelFor(
  binding: readonly ResearchDimension[],
  repairs: readonly ResearchRepair[],
  dimensions: readonly ResearchDimensionReport[],
): ResearchReadinessLevel {
  if (binding.length > 0) {
    if (repairs.length > 0) return 'recoverable';
    /*
     * A failure that is about our answer to one request, rather than about the
     * destination, is stated and not made fatal.
     *
     * `blocked` withholds the Discovery Board entirely, and it should: a board
     * that misrepresents a place is worse than no board. But "we could not find
     * the museum you named" says nothing about whether the other forty things we
     * found are real, and refusing the trip over it would replace a good trip
     * with no trip. See `NON_WITHHOLDING_DIMENSIONS`.
     */
    return binding.some((dimension) => dimensionWithholdsBoard(dimension)) ? 'blocked' : 'thin';
  }

  const material = dimensions.some(
    (entry) =>
      (entry.required && entry.state === 'partial') || (!entry.required && entry.state === 'unmet'),
  );
  return material ? 'thin' : 'ready';
}

/**
 * The one rule that must never be softened.
 *
 * A blocked board is withheld. Not greyed out, not shown with a banner — a board
 * that misrepresents a destination is worse than no board, because a traveller
 * cannot tell the difference and will plan against it.
 */
export function mayShowDiscoveryBoard(readiness: DestinationResearchReadiness): boolean {
  return readiness.level !== 'blocked';
}

/** Whether the automatic loop should try again. */
export function shouldAttemptRecovery(readiness: DestinationResearchReadiness): boolean {
  return readiness.level === 'recoverable' && readiness.repairs.length > 0;
}

/** The dimensions a traveller should be told about, worst first. */
export function reportableDeficits(
  readiness: DestinationResearchReadiness,
): ResearchDimensionReport[] {
  const rank: Record<ResearchDimensionState, number> = {
    unmet: 0,
    partial: 1,
    met: 2,
    not_applicable: 3,
    unmeasured: 4,
  };
  return readiness.dimensions
    .filter((entry) => entry.state === 'unmet' || entry.state === 'partial')
    .sort((a, b) => {
      if (a.required !== b.required) return a.required ? -1 : 1;
      return rank[a.state] - rank[b.state];
    });
}
