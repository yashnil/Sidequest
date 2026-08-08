'use server';

import { redirect } from 'next/navigation';
import {
  ACTIVITY_INTENSITIES,
  BUDGET_BANDS,
  CROWD_TOLERANCES,
  DISCOVERY_MIXES,
  EARLY_MORNING_TOLERANCES,
  FREE_TIME_APPETITES,
  INTERESTS,
  PACES,
  PRODUCING_SYSTEMS,
  TRANSPORT_PREFERENCES,
  benchmarkTripRequestSchema,
  drawAssignment,
  interestLevelSchema,
  runNeutralValidation,
  seededEntropy,
  stableHash,
  systemEntropy,
  type BenchmarkInterest,
  type BenchmarkPlan,
} from '@sidequest/bench';
import { caseById } from '@sidequest/bench/cases';
import {
  fakeGroundTruth,
  failedPlan,
  sampleMetrics,
  sampleQuestion,
  sidequestPartialPlan,
  validBaselineShapedPlan,
  validSidequestShapedPlan,
} from '@sidequest/bench/testing';
import { benchmarkModeIsLive } from '@/lib/benchmark/budget';
import {
  advanceSessionState,
  createBenchmarkSession,
  insertPlan,
  saveAssignment,
  saveQuestion,
  settleRun,
  startRun,
} from '@/lib/db/benchmark-repository';
import { saveRunMetrics, saveValidation } from '@/lib/db/benchmark-review-repository';

/**
 * STARTING A COMPARISON, AND THE FIXTURE DOOR BESIDE IT.
 *
 * Two exported operations and they are not the same kind of thing, which is why
 * the second one says so in its name and refuses to run in a live build.
 *
 * `createComparisonAction` is the real one: it validates a request against the
 * shared schema, writes a session, draws the blind assignment once from system
 * entropy, and stores it. The draw happens here rather than at first render for
 * the reason the assignment schema spells out — a mapping recomputed on read is
 * a mapping that can change on refresh, and a layout that reshuffles when you
 * reload is itself a way to learn which panel is which.
 *
 * `seedFixtureComparisonAction` writes plans straight through the repositories
 * from the checked-in fixture kit. That is a test seam and nothing else: it
 * exists because the two planner arms are being built alongside this interface
 * and the review screen has to be exercisable before either lands. It is guarded
 * on `SIDEQUEST_BENCHMARK_MODE`, so a live pilot cannot produce a fixture row
 * that would then be averaged in with real ones — and the assignments it writes
 * are marked `seeded`, which is the second, independent guard against exactly
 * that pooling.
 */

export interface ComposerState {
  error: string | null;
}

const DEFAULT_MAX_DRIVE_MINUTES = 180;
const DEFAULT_MAX_TRAVEL_MINUTES = 300;

export async function createComparisonAction(
  _previous: ComposerState,
  form: FormData,
): Promise<ComposerState> {
  const now = new Date();
  const caseId = text(form, 'caseId');

  const built = caseId.length > 0 ? fromLibrary(caseId) : fromForm(form);
  if (built === null) return { error: 'unusable' };

  const parsed = benchmarkTripRequestSchema.safeParse(built.request);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'unusable' };

  const start = createBenchmarkSession({
    request: parsed.data,
    /*
     * Stable for one submission, and only for one.
     *
     * A retried POST — the browser's, or an impatient second click — carries the
     * nonce the page was rendered with, reaches the same key and adopts the
     * session the first one made, rather than opening a second comparison nobody
     * asked for.
     *
     * The nonce is what makes that safe. The key used to be the request hash and
     * the current minute, which meant two reviewers who started the same library
     * case within the same minute silently shared one session — and therefore one
     * blind assignment, one pair of plans and one review. The second reviewer
     * would have been shown a comparison somebody else's press had produced, with
     * nothing on screen saying so, and the pooled result would have counted one
     * session as two independent judgements.
     */
    idempotencyKey: `${stableHash(parsed.data)}:${submissionNonce(form)}`,
    ...(built.caseId === null ? {} : { caseId: built.caseId }),
    now,
  });

  saveAssignment(
    start.session.id,
    drawAssignment({ entropy: systemEntropy(), now, source: 'system' }),
  );

  redirect(`/labs/benchmark/${start.session.id}/run`);
}

/* ------------------------------------------------------------------ *
 * Building a request
 * ------------------------------------------------------------------ */

function fromLibrary(
  caseId: string,
): { request: unknown; caseId: string | null } | null {
  const library = caseById(caseId);
  return library === null ? null : { request: library.request, caseId: library.caseId };
}

/**
 * The written request.
 *
 * Everything the form does not ask about is filled with an ordinary answer
 * rather than left out, because the schema has no optional sections and a
 * half-filled request would fail with an error about a field nobody was shown.
 * The filled-in values are all stated answers a traveller could plausibly have
 * given; not one of them is derived from another, which is the property the
 * request schema is built around.
 */
function fromForm(form: FormData): { request: unknown; caseId: string | null } | null {
  const startDate = text(form, 'startDate');
  const endDate = text(form, 'endDate');
  const nights = nightsBetween(startDate, endDate);
  if (nights === null) return null;

  const carAvailable = text(form, 'carAvailable') === 'yes';
  const maxDrive = carAvailable ? number(form, 'maxDrive', DEFAULT_MAX_DRIVE_MINUTES) : 0;
  const maxTravel = Math.max(maxDrive, number(form, 'maxTravel', DEFAULT_MAX_TRAVEL_MINUTES));
  const bases = number(form, 'bases', 1);
  const baseChanges = Math.max(bases - 1, number(form, 'baseChanges', 0));

  const interests: Partial<Record<BenchmarkInterest, string>> = {};
  for (const interest of INTERESTS) {
    const level = interestLevelSchema.safeParse(text(form, `interest.${interest}`));
    interests[interest] = level.success ? level.data : 'low';
  }

  return {
    caseId: null,
    request: {
      schemaVersion: 1,
      requestId: `req-${crypto.randomUUID()}`,
      destination: { mode: 'known', text: text(form, 'destination'), identity: null },
      dates: { mode: 'exact', startDate, endDate, flexDays: 0, month: null, year: null, nights },
      arrival: { precision: 'unknown', time: null },
      departure: { precision: 'unknown', time: null },
      origin: '',
      party: {
        adults: number(form, 'adults', 2),
        children: number(form, 'children', 0),
        childAges: [],
        seniorsInGroup: false,
        mobility: [],
        mobilityNotes: '',
        dietary: [],
        dietaryStrict: false,
      },
      movement: {
        preference: oneOf(form, 'transport', TRANSPORT_PREFERENCES),
        publicTransit: 'accept',
        carAvailable,
        comfortableMountainRoads: false,
        comfortableUnpavedRoads: false,
        willUseShuttlesAndFerries: true,
        maxDailyDriveMinutes: maxDrive,
        maxDailyTravelMinutes: maxTravel,
        maxAccessWalkMinutes: 30,
        desiredBaseCount: bases,
        maxBaseChanges: baseChanges,
      },
      rhythm: {
        pace: oneOf(form, 'pace', PACES),
        activityIntensity: oneOf(form, 'intensity', ACTIVITY_INTENSITIES),
        freeTime: oneOf(form, 'freeTime', FREE_TIME_APPETITES),
        earlyMornings: oneOf(form, 'earlyMornings', EARLY_MORNING_TOLERANCES),
      },
      taste: {
        interests,
        crowdTolerance: oneOf(form, 'crowds', CROWD_TOLERANCES),
        discoveryMix: oneOf(form, 'mix', DISCOVERY_MIXES),
        foodImportance: 'matters',
        nightlifeImportance: 'a_little',
        indoorOutdoorBalance: 'balanced',
        mustDo: [],
        dislikes: [],
        hardAvoidances: [],
      },
      conditions: { climate: 'no_preference', heat: 'fine', cold: 'fine', rain: 'fine', snow: 'fine' },
      practicalities: {
        budget: oneOf(form, 'budget', BUDGET_BANDS),
        accommodation: 'no_preference',
        reservations: 'a_few_is_fine',
        guidedTours: 'sometimes',
      },
      freeText: text(form, 'freeText'),
    },
  };
}

/**
 * The nonce this form was rendered with, or a fresh one.
 *
 * A submission that arrives without one cannot be recognised as a retry of
 * anything, and guessing that it is a retry of the last identical request is the
 * failure this field exists to remove. So an absent nonce opens a session of its
 * own: a duplicate comparison is visible and discardable, whereas two reviewers
 * folded into one are neither.
 */
function submissionNonce(form: FormData): string {
  const supplied = text(form, 'submissionNonce');
  return supplied.length > 0 ? supplied : crypto.randomUUID();
}

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function number(form: FormData, name: string, fallback: number): number {
  const parsed = Number(text(form, name));
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

function oneOf<T extends readonly string[]>(form: FormData, name: string, options: T): T[number] {
  const value = text(form, name);
  return (options as readonly string[]).includes(value) ? value : options[0]!;
}

/** Null rather than a guess: a request whose dates do not parse is not a request. */
function nightsBetween(startDate: string, endDate: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) return null;
  const start = Date.parse(`${startDate}T00:00:00.000Z`);
  const end = Date.parse(`${endDate}T00:00:00.000Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const nights = Math.round((end - start) / 86_400_000);
  return nights >= 1 && nights <= 30 ? nights : null;
}

/* ------------------------------------------------------------------ *
 * The fixture seam
 * ------------------------------------------------------------------ */

/**
 * The three shapes a seeded comparison can be written in.
 *
 * `awaiting_answers` is the newest and the one the browser suite had no way to
 * reach: it stops the session at the question round, with unanswered questions
 * and the second press on screen. Without it every viewport and accessibility
 * sweep ran against a session already at `ready_for_review`, so the question
 * panel, the answer controls and the "build both plans" button had never been
 * measured at any viewport, focused by any keyboard check, or seen by any
 * contrast or target-size sweep.
 */
export type FixtureShape = 'both_complete' | 'partial_and_failed' | 'awaiting_answers';

export interface FixtureResult {
  ok: boolean;
  sessionId: string | null;
}

/**
 * A whole session, written from the checked-in fixture kit.
 *
 * Not a benchmark result and never counted as one: the assignment is marked
 * `seeded` and carries its seed, which is the flag every aggregate in this
 * interface splits on. What it is for is the browser suite — the review screen,
 * the panel ordering, the correction limit and the reveal all have to be
 * exercisable while the two planner arms are still being written, and a screen
 * nobody can drive is a screen nobody has checked.
 *
 * Refuses outright when the build is live, so a pilot that is spending real
 * money cannot have a fixture row appear in the middle of it.
 */
export async function seedFixtureComparisonAction(input: {
  caseId: string;
  seed: string;
  shape: FixtureShape;
}): Promise<FixtureResult> {
  if (benchmarkModeIsLive()) return { ok: false, sessionId: null };

  const library = caseById(input.caseId);
  if (library === null) return { ok: false, sessionId: null };

  const now = new Date();
  const start = createBenchmarkSession({
    request: library.request,
    /*
     * The whole input, not just the seed.
     *
     * `fixture:${seed}` was entirely caller-controlled and named only one of the
     * three things that decide what gets written. The same seed with a different
     * case, or a different shape, adopted whatever session that seed had already
     * made and returned `ok` — so a browser test that asked for a partial-and-
     * failed pair against one traveller could be handed two complete plans
     * against another and go on to assert against them.
     */
    idempotencyKey: `fixture:${stableHash({
      seed: input.seed,
      caseId: library.caseId,
      shape: input.shape,
    })}`,
    caseId: library.caseId,
    now,
  });
  const sessionId = start.session.id;

  saveAssignment(
    sessionId,
    drawAssignment({
      entropy: seededEntropy(input.seed),
      now,
      source: 'seeded',
      seed: input.seed,
    }),
  );

  if (start.kind === 'adopted') return { ok: true, sessionId };

  /*
   * A session parked at the question round, with nothing answered.
   *
   * Written directly rather than by running the preparation, for the same reason
   * the plan fixtures are: nothing here may reach a provider. What it produces is
   * the state a reviewer is actually in while they answer — two runs open, a
   * pooled list, and the second press waiting — which is what the browser sweeps
   * needed and could not otherwise get to.
   */
  if (input.shape === 'awaiting_answers') {
    /*
     * One unanswered question per system, and the arm names come from the shared
     * constant rather than from a literal.
     *
     * The leakage scan reads every string literal in this directory, and it is
     * right to: a system name typed here is a system name one refactor away from
     * a rendered attribute. The same reason the plan fixtures pair themselves by
     * reading `producedBy` off the plan instead of keeping a table.
     */
    for (const [index, system] of PRODUCING_SYSTEMS.entries()) {
      startRun({ sessionId, arm: system, now });
      saveQuestion(
        sampleQuestion({
          sessionId,
          questionId: stableHash({ sessionId, sequence: index, shape: input.shape }),
          askedBy: system,
          sequence: index,
          ...(index === 0
            ? {}
            : {
                questionText: 'Roughly what time do you expect to arrive on the first day?',
                answerType: 'single_choice' as const,
                options: [
                  { value: 'morning', label: 'Morning' },
                  { value: 'evening', label: 'Evening or later' },
                ],
              }),
          // Unanswered, which is the whole point: the controls only render then.
          answeredAt: null,
          elapsedMs: null,
          answerValues: null,
          answeredFrom: 'unanswered',
        }),
      );
    }
    advanceSessionState({ sessionId, from: 'created', to: 'preparing', now });
    advanceSessionState({ sessionId, from: 'preparing', to: 'awaiting_answers', now });
    return { ok: true, sessionId };
  }

  /*
   * Which fixture plan belongs to which arm is read off the plan itself.
   *
   * `producedBy` is on every stored plan, so the pairing needs no table here —
   * and a table would be the one place in this interface where a system name
   * appeared as a literal, which is precisely what the leakage scan is for.
   */
  const candidates: readonly BenchmarkPlan[] =
    input.shape === 'both_complete'
      ? [validSidequestShapedPlan, validBaselineShapedPlan]
      : [sidequestPartialPlan, failedPlan];
  const truth = fakeGroundTruth();

  for (const system of PRODUCING_SYSTEMS) {
    const plan = candidates.find((candidate) => candidate.producedBy === system);
    if (!plan) continue;

    const run = startRun({ sessionId, arm: system, now });
    const inserted = insertPlan({
      sessionId,
      runId: run.id,
      plan,
      expectedSupersedesPlanId: null,
      now,
    });
    if (inserted.kind === 'inserted') {
      saveValidation({
        sessionId,
        planId: inserted.stored.id,
        report: runNeutralValidation(plan, truth),
        now,
      });
    }
    saveRunMetrics({ sessionId, runId: run.id, metrics: sampleMetrics({ runId: run.id }), now });
    settleRun({
      runId: run.id,
      state:
        plan.generationState === 'complete'
          ? 'succeeded'
          : plan.generationState === 'partial'
            ? 'partial'
            : 'failed',
      now,
    });

    /*
     * The id is hashed rather than composed out of the arm's name.
     *
     * A question id is a string the asking system chose, and the obvious
     * `${sessionId}:${system}:1` would have put the answer to the whole
     * experiment inside an attribute on the answer form. The render side hashes
     * ids again on the way out for exactly the same reason, because the two
     * real arms will mint ids this file never sees.
     */
    saveQuestion(
      sampleQuestion({
        sessionId,
        questionId: stableHash({ sessionId, system, sequence: 0 }),
        askedBy: system,
        sequence: 0,
      }),
    );
  }

  advanceSessionState({ sessionId, from: 'created', to: 'ready_for_review', now });
  return { ok: true, sessionId };
}
