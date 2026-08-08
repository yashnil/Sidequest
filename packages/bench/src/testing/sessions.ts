import { drawAssignment } from '../assign';
import { seededEntropy } from '../entropy';
import { stableHash } from '../hash';
import {
  emptyRunMetrics,
  measured,
  runMetricsSchema,
  unavailable,
  type RunMetrics,
} from '../schemas/metrics';
import {
  BENCHMARK_SESSION_VERSION,
  FORCED_CHOICE_IDS,
  RATING_DIMENSION_IDS,
  benchmarkQuestionSchema,
  blindReviewSchema,
  correctionRoundSchema,
  type BenchmarkQuestion,
  type BlindAssignment,
  type BlindReview,
  type CorrectionRound,
} from '../schemas/session';
import { FIXED_NOW } from './request';

/**
 * SESSION-SHAPED FIXTURES.
 *
 * Everything a benchmark session records around the two plans: which system
 * wore which label, what the run cost, what the reviewer said, what happened
 * when they asked for a change, and what either system asked them along the way.
 *
 * Two rules run through all of it. Nothing reads a clock — every timestamp comes
 * from `FIXED_NOW` or from a parameter, so a fixture cannot start failing at
 * midnight. And nothing draws a random number: the assignments come from
 * `seededEntropy`, which is the whole reason that function exists.
 */

export const SAMPLE_SESSION_ID = 'session-fixture-kestrel-coast';

/**
 * One assignment from one seed, deterministically.
 *
 * `source: 'seeded'` is not decoration. It is what keeps a fixture session out
 * of any aggregate over live sessions, and the assignment schema refuses a
 * seeded row that does not carry its seed.
 */
export function sampleAssignment(seed: string, now: Date = FIXED_NOW): BlindAssignment {
  return drawAssignment({ entropy: seededEntropy(seed), now, source: 'seeded', seed });
}

/**
 * The two seeds that actually produce the two render orders.
 *
 * Found by running `drawAssignment` over candidate strings rather than by
 * reasoning about the generator, because the whole point of a seeded fixture is
 * that the value is observed rather than assumed. Both put Sidequest on label A,
 * so the pair isolates the second draw: the only thing that differs between them
 * is which panel the reviewer sees first, which is exactly what an
 * ordering-bias record has to vary.
 */
export const A_LEFT_SEED = 'left-panel-a';
export const B_LEFT_SEED = 'left-panel-b';

export const aLeftAssignment: BlindAssignment = sampleAssignment(A_LEFT_SEED);
export const bLeftAssignment: BlindAssignment = sampleAssignment(B_LEFT_SEED);

/* ------------------------------------------------------------------ *
 * Metrics
 * ------------------------------------------------------------------ */

/**
 * A plausible measured run, with two boundaries deliberately unavailable.
 *
 * The two absences are the point. A system with no evidence cache has no cache
 * hit rate, and recording that as `0` would read as a deficiency rather than as
 * an architectural difference — which is the failure the whole `Measurement`
 * union exists to make unrepresentable. A fixture that measured everything would
 * never exercise it.
 */
export function sampleMetrics(overrides: Partial<RunMetrics> = {}): RunMetrics {
  const base: RunMetrics = {
    ...emptyRunMetrics('run-fixture', 'Not computed for this fixture.'),
    timeToFirstUsefulResultMs: measured(1_400, 'ms'),
    timeToFollowUpQuestionsMs: measured(900, 'ms'),
    timeToFirstItineraryMs: measured(11_200, 'ms'),
    /*
     * The arm's own total, then the validation.
     *
     * In that order, because the shared checks are the harness's rather than
     * either arm's — an arm has already stopped and reported its total by the
     * time its plan is checked. A fixture with the two the other way round
     * described a run that cannot happen.
     */
    totalWallTimeMs: measured(96_400, 'ms'),
    timeToValidatedPlanMs: measured(96_900, 'ms'),
    /*
     * The three session figures differ from each other and from the arm's own
     * total, deliberately. A fixture in which they coincided would satisfy every
     * ordering check while exercising none of them, which is exactly the state
     * the real writer was in before these fields were separated.
     */
    sessionWallTimeMs: measured(361_000, 'ms'),
    humanAnswerWaitMs: measured(74_000, 'ms'),
    sessionMachineTimeMs: measured(287_000, 'ms'),
    modelCalls: measured(7, 'calls'),
    inputTokens: measured(41_300, 'tokens'),
    outputTokens: measured(9_800, 'tokens'),
    estimatedCostMicroUsd: measured(214_000, 'micro_usd'),
    repairCalls: measured(1, 'calls'),
    providerCalls: measured(23, 'calls'),
    routeCalls: measured(4, 'calls'),
    routePairs: measured(31, 'pairs'),
    weatherCalls: measured(2, 'calls'),
    cacheHits: unavailable('not_applicable_to_system', 'This system keeps no evidence cache.'),
    cacheMisses: unavailable('not_applicable_to_system', 'This system keeps no evidence cache.'),
    retries: measured(0, 'attempts'),
    databaseGrowthBytes: measured(184_320, 'bytes'),
    warmth: 'cold',
    warmthBasis: 'A fixture figure; nothing observed a cache.',
  };
  return runMetricsSchema.parse({ ...base, ...overrides });
}

/* ------------------------------------------------------------------ *
 * Review
 * ------------------------------------------------------------------ */

const SIDEQUEST_SHAPED_SCORES: Readonly<Record<string, number>> = {
  overall_quality: 6,
  would_take: 6,
  personal_fit: 6,
  discovery_quality: 5,
  excitement: 5,
  pacing: 6,
  logistical_realism: 7,
  food_placement: 6,
  transport_realism: 7,
  clarity: 5,
  trust: 6,
  flexibility: 4,
  alternatives: 6,
  handling_unknowns: 7,
  effort_to_fix: 6,
};

const BASELINE_SHAPED_SCORES: Readonly<Record<string, number>> = {
  overall_quality: 5,
  would_take: 4,
  personal_fit: 5,
  discovery_quality: 6,
  excitement: 6,
  pacing: 4,
  logistical_realism: 3,
  food_placement: 4,
  transport_realism: 3,
  clarity: 6,
  trust: 3,
  flexibility: 6,
  alternatives: 3,
  handling_unknowns: 2,
  effort_to_fix: 3,
};

function scores(source: Readonly<Record<string, number>>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const dimension of RATING_DIMENSION_IDS) out[dimension] = source[dimension] ?? 4;
  return out;
}

function everyChoice(option: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const id of FORCED_CHOICE_IDS) out[id] = option;
  return out;
}

/**
 * A completed blind review.
 *
 * Both panels rated, all six forced choices answered, and a written reason on
 * the primary one. `panelTimeMs` is present and unequal on purpose: a reviewer
 * who spent twice as long on one panel is a first-position effect waiting to be
 * estimated, and a fixture with equal times would let a bug in that analysis
 * pass unnoticed.
 */
export function sampleReview(
  overrides: Partial<BlindReview> = {},
  now: Date = FIXED_NOW,
): BlindReview {
  const base = {
    schemaVersion: BENCHMARK_SESSION_VERSION,
    sessionId: SAMPLE_SESSION_ID,
    reviewer: 'reviewer-fixture',
    ratings: [
      { state: 'rated', label: 'A', scores: scores(SIDEQUEST_SHAPED_SCORES) },
      { state: 'rated', label: 'B', scores: scores(BASELINE_SHAPED_SCORES) },
    ],
    choices: { ...everyChoice('A'), more_interesting: 'B', fewer_changes: 'tie' },
    explanation:
      'The first one reads like somebody had actually checked the times; the second is nicer to read but I would not trust the afternoon.',
    panelTimeMs: { A: 412_000, B: 233_000 },
    submittedAt: now.toISOString(),
  };
  return blindReviewSchema.parse({ ...base, ...overrides });
}

/* ------------------------------------------------------------------ *
 * Corrections
 * ------------------------------------------------------------------ */

const SAMPLE_INSTRUCTION =
  'The second day is too much driving. Keep the tarn and drop the cable car, and give me the afternoon back.';

/**
 * One correction round, with the instruction hashed rather than merely stored.
 *
 * The hash is what proves both systems were asked the same thing in the same
 * words. A round that recorded only the text would let a later edit — or a
 * well-meaning bit of prompt formatting — change one system's instruction
 * without leaving a trace.
 */
export function sampleCorrection(
  overrides: Partial<CorrectionRound> = {},
  now: Date = FIXED_NOW,
): CorrectionRound {
  const base = {
    schemaVersion: BENCHMARK_SESSION_VERSION,
    sessionId: SAMPLE_SESSION_ID,
    system: 'sidequest',
    round: 1,
    supersedesPlanId: 'plan-fixture-sidequest',
    resultPlanId: 'plan-fixture-repaired',
    instructionText: SAMPLE_INSTRUCTION,
    instructionHash: stableHash(SAMPLE_INSTRUCTION),
    outcome: 'applied',
    regressedFindingCodes: [],
    newCriticalCount: 0,
    newMajorCount: 0,
    satisfaction: 6,
    abandoned: false,
    abandonReason: null,
    requestedAt: now.toISOString(),
    completedAt: new Date(now.getTime() + 42_000).toISOString(),
  };
  const merged = { ...base, ...overrides };
  return correctionRoundSchema.parse({
    ...merged,
    // Recomputed from the merged text rather than carried over from the default,
    // because a fixture whose hash did not follow its own instruction would be
    // the exact corruption the field exists to detect.
    instructionHash: overrides.instructionHash ?? stableHash(merged.instructionText),
  });
}

/* ------------------------------------------------------------------ *
 * The question ledger
 * ------------------------------------------------------------------ */

/**
 * A question one system asked and the shared request already answered.
 *
 * `answeredFrom: 'shared_request'` with `elapsedMs: 0` is the case the ledger
 * exists to keep separate from an unanswered one: zero milliseconds of a human's
 * time is a real measurement, and an absent answer has no elapsed time at all.
 */
export function sampleQuestion(
  overrides: Partial<BenchmarkQuestion> = {},
  now: Date = FIXED_NOW,
): BenchmarkQuestion {
  const base = {
    schemaVersion: BENCHMARK_SESSION_VERSION,
    sessionId: SAMPLE_SESSION_ID,
    questionId: 'question-fixture-1',
    askedBy: 'baseline',
    stage: 'clarification',
    sequence: 0,
    questionText: 'Will you have a car for the whole trip?',
    whyItMatters: 'Half the coast is unreachable without one, and the plan changes shape either way.',
    answerType: 'boolean',
    options: [
      { value: 'yes', label: 'Yes' },
      { value: 'no', label: 'No' },
    ],
    required: true,
    presentedAt: now.toISOString(),
    answeredAt: now.toISOString(),
    elapsedMs: 0,
    answerValues: ['yes'],
    answeredFrom: 'shared_request',
    transferredTo: null,
  };
  return benchmarkQuestionSchema.parse({ ...base, ...overrides });
}
