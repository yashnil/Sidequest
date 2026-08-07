import { z } from 'zod';

/**
 * ONE PLACE THAT KNOWS WHAT A STAGE IS.
 *
 * There were three, and they disagreed. The stage identifiers lived in
 * `compilation.ts`, their traveller-facing labels lived beside them in a second
 * object literal keyed by hand, and their phase lived in a third object literal
 * in `progress.ts` keyed by hand again. Three hand-keyed maps over one
 * vocabulary is a defect waiting for a rename, and it did not wait: a stage
 * reached the screen as the raw string `reusing_shared_claims`, underscores and
 * all, because a *second* label map — `stepLabel` in `PlanFlow` — fell back to
 * `step.replaceAll('_', ' ')` for anything it did not recognise.
 *
 * So: one array, below. Everything else derives from it.
 *
 * | Derived | Was | Now |
 * | --- | --- | --- |
 * | `COMPILATION_STAGES` | a hand-written tuple | the registry's ids, in order |
 * | `COMPILATION_STAGE_LABELS` | a hand-keyed `Record` | `stageLabel` over the registry |
 * | `STAGE_PHASE` | a hand-keyed `Record` in `progress.ts` | the registry's `phase` |
 * | `displayStages`' skip list | three hard-coded ids | `runsInJob: false` |
 * | the work-plan step label | `replaceAll('_', ' ')` | `stageLabel`, which returns null rather than an identifier |
 *
 * A stage that is not in this array has no label, no phase and no order, and
 * `stageLabel` answers `null` for it rather than dressing the identifier up as
 * English. `progress.test.ts` asserts that no derived label is ever a snake_case
 * identifier, which is the exact shape of the string that reached the screen.
 *
 * ---
 *
 * ORDER, AND THE ONE PLACE IT IS NOT EXECUTION ORDER.
 *
 * `order` is the order the stage list is *rendered* in, and it matches the order
 * `compile.ts` runs the stages in, with a single deliberate exception:
 * `resolving_source_release` is recorded by the compiler *after*
 * `building_region_pack` (compile.ts, the `runStage('resolving_source_release')`
 * call) because the release is only known once the provider has read the pack —
 * announcing "we checked the catalogue" before anything read it would be
 * progress theatre. Both are in `shaping`, so the phase sequence is unaffected,
 * which is what the monotonicity rule below actually cares about.
 *
 * PHASES MUST BE MONOTONIC IN EXECUTION ORDER, and were not.
 *
 * `researching_official_constraints` and `discovering_food` were both mapped to
 * `verifying`, and both execute *before* `enriching_priority_candidates`, which
 * was mapped to `finding`. The visible consequence: `groupStages` reported
 * `verifying` as under way and then, two stages later, sent `finding` from done
 * back to running. A traveller watching that screen saw a phase un-finish.
 *
 * The correction is not a reshuffle of convenience — it puts the boundary where
 * the compiler already draws it. `compile.ts` marks THE CUT: everything above it
 * is deterministic or map-derived and costs nothing, everything below it is the
 * research funnel and `discovering_sources` is the first call anybody pays for.
 * `researching_official_constraints` reads what the map data already carries —
 * no search, no fetch, no model — and `discovering_food` runs immediately after
 * it, still above the cut. Both are *finding*. `enriching_priority_candidates`
 * is the first stage below the cut, and its job is choosing what is worth
 * researching. It is *verifying*.
 *
 * So the finding→verifying boundary is now exactly the cut, which is also the
 * moment the provisional board is emitted — the thing `AVAILABILITY_AFTER.finding`
 * has been promising since Phase 11.
 */

// ---------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------

/**
 * The five things a traveller is waiting for, in the order they happen.
 *
 * Named for what they are getting rather than for the module doing it. The
 * stages are still there, behind a disclosure, because an operator debugging a
 * thin region needs exactly that list — but nobody waiting for a trip should
 * have to read twenty-six rows of build log to find out how it is going.
 *
 * Declared here rather than in `progress.ts` so that the registry below can name
 * a phase without `progress.ts` and `stages.ts` importing each other.
 */
export const COMPILATION_PHASES = [
  'understanding',
  'shaping',
  'finding',
  'verifying',
  'building',
] as const;
export const compilationPhaseSchema = z.enum(COMPILATION_PHASES);
export type CompilationPhase = z.infer<typeof compilationPhaseSchema>;

export const COMPILATION_PHASE_LABELS: Record<CompilationPhase, string> = {
  understanding: 'Understanding your trip',
  shaping: 'Shaping the region',
  finding: 'Finding the strongest places',
  verifying: 'Verifying what matters',
  building: 'Building the plan',
};

export const COMPILATION_PHASE_DETAIL: Record<CompilationPhase, string> = {
  understanding: 'Working out what you meant and how much ground it covers.',
  shaping: 'Reading the map data for this region and dividing it into areas.',
  finding: 'Looking for places, merging duplicates, and dropping the empty records.',
  verifying: 'Reading official pages for hours, access, cost and cautions. This is the slow part.',
  building: 'Travel times, weather points, and what we could and could not establish.',
};

/** Where a phase sits in the sequence. Used to check that phases never go backwards. */
export const PHASE_ORDER: Record<CompilationPhase, number> = Object.fromEntries(
  COMPILATION_PHASES.map((phase, index) => [phase, index]),
) as Record<CompilationPhase, number>;

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

/**
 * One row of the registry, before `order` is stamped on from the array index.
 *
 * `order` is deliberately not written by hand: a hand-written ordinal beside a
 * hand-ordered array is a fourth thing that can disagree with the other three,
 * and the whole point of this file is that there is one.
 */
interface StageSeed {
  readonly id: string;
  readonly phase: CompilationPhase;
  /** What the traveller reads. Never an identifier, never a module name. */
  readonly label: string;
  /**
   * Whether this stage's `outcome` is a result worth putting on a phase card.
   *
   * False for plumbing. `linking_sources` finishing with "412 records matched
   * across sources" is true, useful to an operator, and not what somebody
   * waiting for a trip wants as the headline of the phase they are watching —
   * so it stays in the technical disclosure and does not become `latestOutcome`.
   */
  readonly exposesResult: boolean;
  /**
   * Operator-facing only.
   *
   * A technical-only stage never headlines a phase card. It is still listed,
   * still labelled, still timed and still shown in the disclosure — this only
   * governs whether its name is the sentence a traveller reads while waiting.
   */
  readonly technicalOnly: boolean;
  /**
   * Whether a compilation job runs this stage at all.
   *
   * Resolution, clarification and scope confirmation all happen before a job
   * exists — they are screens the traveller has already been through. Listing
   * them in the job's stage list produced a row reading "Waiting: working out
   * where you mean" for the whole compilation, which is not merely noise: it is
   * wrong. `displayStages` filters on this rather than on a hard-coded list of
   * three identifiers that nobody would remember to update.
   */
  readonly runsInJob: boolean;
}

/**
 * Every stage, in render order. The single source of the vocabulary.
 *
 * Adding a stage here is the whole job: the enum, the labels, the phase map, the
 * job's display list and the observation schema all follow. Adding one anywhere
 * else is the bug this file exists to make impossible.
 */
const STAGE_SEEDS = [
  // ---- understanding: before a job exists --------------------------------
  {
    id: 'resolving_destination',
    phase: 'understanding',
    label: 'Working out where you mean',
    exposesResult: false,
    technicalOnly: false,
    runsInJob: false,
  },
  {
    id: 'awaiting_clarification',
    phase: 'understanding',
    label: 'Waiting on your answers',
    exposesResult: false,
    technicalOnly: false,
    runsInJob: false,
  },
  {
    id: 'confirming_scope',
    phase: 'understanding',
    label: 'Settling the region',
    exposesResult: false,
    technicalOnly: false,
    runsInJob: false,
  },

  // ---- shaping: the place backbone ---------------------------------------
  {
    id: 'resolving_source_release',
    phase: 'shaping',
    label: 'Checking which map release to build from',
    exposesResult: false,
    technicalOnly: true,
    runsInJob: true,
  },
  {
    id: 'partitioning_scope',
    phase: 'shaping',
    label: 'Dividing the region into readable areas',
    exposesResult: true,
    technicalOnly: false,
    runsInJob: true,
  },
  {
    id: 'building_region_pack',
    phase: 'shaping',
    label: 'Preparing regional place data',
    exposesResult: true,
    technicalOnly: false,
    runsInJob: true,
  },
  {
    id: 'linking_sources',
    phase: 'shaping',
    label: 'Matching records across sources',
    exposesResult: false,
    technicalOnly: true,
    runsInJob: true,
  },
  {
    id: 'expanding_region',
    phase: 'shaping',
    label: 'Expanding it into a travel region',
    exposesResult: true,
    technicalOnly: false,
    runsInJob: true,
  },

  // ---- finding: everything above THE CUT, which costs nothing ------------
  {
    id: 'discovering_candidates',
    phase: 'finding',
    label: 'Looking for places',
    exposesResult: true,
    technicalOnly: false,
    runsInJob: true,
  },
  {
    id: 'deduplicating',
    phase: 'finding',
    label: 'Merging duplicates',
    exposesResult: true,
    technicalOnly: false,
    runsInJob: true,
  },
  {
    id: 'classifying',
    phase: 'finding',
    label: 'Sorting what we found',
    exposesResult: true,
    technicalOnly: false,
    runsInJob: true,
  },
  {
    id: 'filtering_quality',
    phase: 'finding',
    label: 'Dropping the thin records',
    exposesResult: true,
    technicalOnly: false,
    runsInJob: true,
  },
  /*
   * Above the cut, and therefore *finding* rather than *verifying*.
   *
   * The label says "checking", which is what read it as verification and put it
   * in the wrong phase. What it actually does is read the access rules the map
   * data already carries — no search, no fetch, no model, nothing bought. It is
   * the last of the free stages but one.
   */
  {
    id: 'researching_official_constraints',
    phase: 'finding',
    label: 'Checking how you get in',
    exposesResult: true,
    technicalOnly: false,
    runsInJob: true,
  },
  {
    id: 'discovering_food',
    phase: 'finding',
    label: 'Finding somewhere to eat',
    exposesResult: true,
    technicalOnly: false,
    runsInJob: true,
  },

  // ---- verifying: everything below THE CUT -------------------------------
  /*
   * The first stage of the research funnel, and therefore the first stage of the
   * *verifying* phase. It was mapped to `finding` while executing after two
   * stages mapped to `verifying`, which is what sent a finished phase back to
   * running on the progress screen.
   */
  {
    id: 'enriching_priority_candidates',
    phase: 'verifying',
    label: 'Choosing what is worth researching',
    exposesResult: false,
    technicalOnly: true,
    runsInJob: true,
  },
  {
    id: 'reusing_shared_claims',
    phase: 'verifying',
    label: 'Reading what we already know',
    exposesResult: true,
    technicalOnly: false,
    runsInJob: true,
  },
  {
    id: 'discovering_sources',
    phase: 'verifying',
    label: 'Finding who publishes this',
    exposesResult: false,
    technicalOnly: true,
    runsInJob: true,
  },
  {
    id: 'retrieving_pages',
    phase: 'verifying',
    label: 'Reading the official pages',
    exposesResult: true,
    technicalOnly: false,
    runsInJob: true,
  },
  {
    id: 'extracting_facts',
    phase: 'verifying',
    label: 'Pulling out the facts',
    exposesResult: true,
    technicalOnly: false,
    runsInJob: true,
  },
  {
    id: 'reconciling_facts',
    phase: 'verifying',
    label: 'Working out who to believe',
    exposesResult: true,
    technicalOnly: false,
    runsInJob: true,
  },
  {
    id: 'resolving_hours_and_access',
    phase: 'verifying',
    label: 'Settling opening hours',
    exposesResult: true,
    technicalOnly: false,
    runsInJob: true,
  },
  {
    id: 'resolving_costs',
    phase: 'verifying',
    label: 'Settling what things cost',
    exposesResult: true,
    technicalOnly: false,
    runsInJob: true,
  },
  {
    id: 'resolving_safety',
    phase: 'verifying',
    label: 'Collecting cautions and preparation',
    exposesResult: true,
    technicalOnly: false,
    runsInJob: true,
  },
  {
    id: 'enriching_food',
    phase: 'verifying',
    label: 'Checking the kitchens are open',
    exposesResult: true,
    technicalOnly: false,
    runsInJob: true,
  },

  // ---- building: routing, weather points, coverage ------------------------
  {
    id: 'computing_travel_times',
    phase: 'building',
    label: 'Working out travel times',
    exposesResult: true,
    technicalOnly: false,
    runsInJob: true,
  },
  {
    id: 'validating_routes',
    phase: 'building',
    label: 'Checking the legs hang together',
    exposesResult: false,
    technicalOnly: true,
    runsInJob: true,
  },
  {
    id: 'resolving_weather_locations',
    phase: 'building',
    label: 'Choosing where to read the weather',
    exposesResult: false,
    technicalOnly: true,
    runsInJob: true,
  },
  {
    id: 'calculating_coverage',
    phase: 'building',
    label: 'Counting what we found and what we missed',
    exposesResult: true,
    technicalOnly: false,
    runsInJob: true,
  },
  {
    id: 'compiling',
    phase: 'building',
    label: 'Putting it together',
    exposesResult: true,
    technicalOnly: false,
    runsInJob: true,
  },
] as const satisfies readonly StageSeed[];

export type CompilationStage = (typeof STAGE_SEEDS)[number]['id'];

/** One stage, as the rest of the product sees it. */
export interface StageDefinition {
  readonly id: CompilationStage;
  readonly phase: CompilationPhase;
  readonly label: string;
  /** 1-based position in the rendered stage list. Stamped from the array index. */
  readonly order: number;
  readonly exposesResult: boolean;
  readonly technicalOnly: boolean;
  readonly runsInJob: boolean;
}

export const STAGE_REGISTRY: readonly StageDefinition[] = STAGE_SEEDS.map((seed, index) => ({
  ...seed,
  order: index + 1,
}));

const BY_ID = new Map<string, StageDefinition>(STAGE_REGISTRY.map((entry) => [entry.id, entry]));

/**
 * The stage vocabulary, in render order.
 *
 * Typed as a non-empty tuple so `z.enum` can take it directly — the enum and the
 * registry cannot drift because there is nothing to keep in step.
 */
export const COMPILATION_STAGES: readonly [CompilationStage, ...CompilationStage[]] =
  STAGE_REGISTRY.map((entry) => entry.id) as [CompilationStage, ...CompilationStage[]];

export const COMPILATION_STAGE_LABELS: Record<CompilationStage, string> = Object.fromEntries(
  STAGE_REGISTRY.map((entry) => [entry.id, entry.label]),
) as Record<CompilationStage, string>;

export const STAGE_PHASE: Record<CompilationStage, CompilationPhase> = Object.fromEntries(
  STAGE_REGISTRY.map((entry) => [entry.id, entry.phase]),
) as Record<CompilationStage, CompilationPhase>;

export function isCompilationStage(value: string): value is CompilationStage {
  return BY_ID.has(value);
}

export function stageDefinition(id: string): StageDefinition | null {
  return BY_ID.get(id) ?? null;
}

/**
 * The traveller-facing label for a stage identifier, or nothing.
 *
 * `null` rather than a tidied-up identifier, and that is the entire point of
 * this function. The version it replaces was `step.replaceAll('_', ' ')`, which
 * turned an unregistered identifier into a lowercase phrase that looks enough
 * like English to survive review and is not English — "reusing shared claims"
 * reached a traveller that way. A caller that gets `null` has to decide what to
 * say, which is a decision somebody makes on purpose.
 */
export function stageLabel(id: string): string | null {
  return BY_ID.get(id)?.label ?? null;
}

/** Stages a compilation job actually runs, in render order. */
export const JOB_STAGES: readonly CompilationStage[] = STAGE_REGISTRY.filter(
  (entry) => entry.runsInJob,
).map((entry) => entry.id);
