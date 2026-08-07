'use server';

import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import {
  autoSelect,
  buildTravelerProfile,
  cacheKeyForSpans,
  countTripDays,
  mergeModelProposals,
  questionnaireAnswersSchema,
  recordModelPass,
  spansForModel,
  validatedQuestionnaireAnswersSchema,
  type ModelFallbackOutcome,
  type QuestionnaireAnswers,
} from '@sidequest/core';
import {
  clearItinerary,
  getTrip,
  replaceAutoSelections,
  saveAnswers,
  saveProfile,
} from '@/lib/db/repository';
import { getIntent, saveComposerAnswers } from '@/lib/db/compiler-repository';
import {
  awaitModelOperation,
  claimModelOperation,
  getCachedInterpretation,
  heartbeatModelOperation,
  saveCachedInterpretation,
  settleModelOperation,
  supersedeModelOperations,
} from '@/lib/db/interpretation-repository';
import {
  INTERPRETATION_PROMPT_VERSIONS,
  createInterpretationModel,
  interpretationModelId,
  isInterpretationModelConfigured,
  proposeInterpretations,
  type StructuredModel,
} from '@/lib/providers/interpretation-model';
import { boardFor, resolveTripRegion } from '@/lib/region';

export interface SaveResult {
  ok: boolean;
  error?: string;
}

/**
 * Called as the traveller moves between steps so a refresh — or a closed laptop —
 * does not throw away half a questionnaire.
 */
export async function saveDraftAction(
  tripId: string,
  answers: QuestionnaireAnswers,
): Promise<SaveResult> {
  const parsed = questionnaireAnswersSchema.safeParse(answers);
  if (!parsed.success) {
    return { ok: false, error: 'Those answers did not look right, so we did not save them.' };
  }
  try {
    if (!getTrip(tripId)) return { ok: false, error: 'We could not find that trip any more.' };
    saveAnswers(tripId, parsed.data);
    return { ok: true };
  } catch (error) {
    console.error('Failed to save questionnaire draft', error);
    return { ok: false, error: 'We could not save your progress just then. Your answers are still here — try again.' };
  }
}

export async function completeQuestionnaireAction(
  tripId: string,
  answers: QuestionnaireAnswers,
): Promise<SaveResult> {
  const trip = getTrip(tripId);
  if (!trip) return { ok: false, error: 'We could not find that trip any more.' };

  const parsed = validatedQuestionnaireAnswersSchema.safeParse(answers);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? 'Something in the questionnaire is incomplete.',
    };
  }

  try {
    const tripDays = countTripDays(trip.basics.startDate, trip.basics.endDate);
    const profile = buildTravelerProfile(parsed.data, {
      travelerNeeds: trip.basics.travelerNeeds,
      tripDays,
    });
    saveProfile(tripId, parsed.data, profile);
    // The stored plan was built from the answers that have just been replaced.
    // Keeping it would show a transport strategy derived from a profile that no
    // longer exists, with nothing to say so.
    clearItinerary(tripId);

    // Seed the board with a balanced starting set so the traveller arrives at
    // something to confirm rather than an empty grid to work through. Done here,
    // on the write that finishes the questionnaire, rather than as a side effect
    // of rendering the board. Re-running the questionnaire re-seeds it, and any
    // card the traveller had already decided by hand is left alone.
    const resolved = await resolveTripRegion(trip);
    if (resolved.ok) {
      const board = boardFor(trip, profile, resolved.context);
      const selection = autoSelect({ candidates: board.candidates, profile, tripDays });
      replaceAutoSelections(tripId, selection.selectedIds);
    }
  } catch (error) {
    console.error('Failed to save traveler profile', error);
    return { ok: false, error: 'We could not save your profile. Nothing was lost — try again.' };
  }

  redirect(`/trips/${tripId}/discover`);
}

/**
 * Accept an interpretation, minus whatever the traveller dropped.
 *
 * The confirmation, and the only thing that lets a chip affect anything. Three
 * properties it has to hold:
 *
 * - **The verbatim text is untouched.** `mustDo` and `avoid` come out of this
 *   byte-identical. A classification somebody accepted is still not a record of
 *   what they said.
 * - **A dropped chip is marked rejected, not deleted.** Chip ids are stable
 *   across re-runs of the same text, so a rejection survives — otherwise
 *   re-parsing would quietly resurrect something they had already refused.
 * - **It writes to the composer, not to the profile.** The answers are the
 *   durable artifact and the profile is derived from them, so a preference
 *   written into the profile would be discarded the next time anybody changed a
 *   weight.
 */
export async function confirmInterpretationAction(
  tripId: string,
  keptChipIds: string[],
): Promise<{ ok: boolean; error?: string }> {
  const intent = getIntent(tripId);
  const composer = intent?.composer;
  if (!composer?.interpretation) {
    return { ok: false, error: 'There is nothing to confirm for this trip.' };
  }

  const kept = new Set(keptChipIds);
  try {
    saveComposerAnswers(tripId, {
      ...composer,
      interpretation: {
        ...composer.interpretation,
        chips: composer.interpretation.chips.map((chip) => ({
          ...chip,
          status: kept.has(chip.id) ? ('confirmed' as const) : ('rejected' as const),
        })),
        confirmedAt: new Date().toISOString(),
      },
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Could not confirm an interpretation', { tripId, error });
    return { ok: false, error: 'We could not save that just then. Try again.' };
  }

  revalidatePath(`/trips/${tripId}/questionnaire`);
  return { ok: true };
}

export interface ReadRestResult {
  ok: boolean;
  outcome?: ModelFallbackOutcome;
  /** How many new proposals appeared. Zero is a normal, honest answer. */
  added?: number;
  error?: string;
}

/**
 * ASK THE BOUNDED READER ABOUT THE LEFTOVERS. ONCE.
 *
 * The whole execution order lives in this function, in the order it has to
 * happen, and every step of it can be pointed at:
 *
 * 1. **The deterministic parse has already run.** `interpretation` was written
 *    by `classifyPreferences` when the composer was submitted — free, offline
 *    and reproducible. This action cannot run before it, because there would be
 *    no `unresolved` array to read.
 * 2. **Only the unresolved spans are eligible.** `spansForModel` reads that
 *    array and nothing else. The destination, the dates and the rest of the
 *    composer are in scope in *this* function and are never passed on.
 * 3. **At most one call.** Guarded three ways: the model is constructed with
 *    `maxCalls: 1`, `canOfferModelPass` hides the button once a call is
 *    recorded, and the recorded `calls` field is capped at one by the schema.
 * 4. **Strict validation, then proposed chips.** `mergeModelProposals` writes
 *    `status: 'proposed'` and never touches `confirmedAt`.
 * 5. **Confirmation is a separate action.** `confirmInterpretationAction`, the
 *    button beside it. Until that runs, `activeChips` returns nothing and the
 *    board, the ranker and the planner see exactly what they saw before.
 *
 * It is a traveller-initiated action rather than something a page render
 * triggers, and that is not a style preference: a render that bought a model
 * call would spend money on every refresh and every back button.
 *
 * Every failure — no credentials, too much text, an outage, an unusable answer,
 * a spent budget — takes the same path: record what happened, leave the
 * traveller's own words byte-identical, return an outcome the screen has a
 * sentence for, and never block the trip.
 *
 * ---
 *
 * **WHY THERE IS A LEASE AND NOT JUST A COUNTER.**
 *
 * Step 3 above used to be three guards and all three were checks of a *stored
 * fact*, read before an `await`. `interpretation.modelPass.calls > 0` is read
 * here, `proposeInterpretations` is awaited, and the record is written after it
 * returns — so two invocations that arrive within that window both read zero,
 * both call, and the record still says one. Two tabs, a double click, a refresh
 * mid-flight and a retried server action all produce exactly that window. The
 * ceiling was a comment.
 *
 * It is now `claimModelOperation`, and the claim happens **before the first
 * `await` in this function**, which is what makes it real: JavaScript runs the
 * synchronous prefix of every invocation to completion, and better-sqlite3's
 * insert is synchronous, so the unique partial index on the running state
 * settles the race with no interleaving point inside it. One winner calls; every
 * loser waits on the winner's result, replays it for free, and if the winner
 * dies its lease expires and somebody else may try — a bounded number of times.
 */
export async function readUnresolvedTextAction(tripId: string): Promise<ReadRestResult> {
  const intent = getIntent(tripId);
  const composer = intent?.composer;
  const interpretation = composer?.interpretation;
  if (!composer || !interpretation) {
    return { ok: false, error: 'There is nothing to read for this trip.' };
  }
  if (interpretation.confirmedAt) {
    return { ok: false, error: 'This interpretation has already been accepted.' };
  }
  if (interpretation.modelPass && interpretation.modelPass.calls > 0) {
    return { ok: false, error: 'We have already read the rest of this once.' };
  }

  const now = new Date();
  const { spans, refusal } = spansForModel(interpretation);
  const promptVersion = INTERPRETATION_PROMPT_VERSIONS.interpretPreferences;
  const modelId = interpretationModelId();

  const save = (next: typeof interpretation): void => {
    saveComposerAnswers(tripId, {
      ...composer,
      interpretation: next,
      updatedAt: new Date().toISOString(),
    });
    revalidatePath(`/trips/${tripId}/questionnaire`);
  };

  const persist = (outcome: ModelFallbackOutcome, calls: 0 | 1): ReadRestResult => {
    save(
      recordModelPass({
        set: interpretation,
        outcome,
        attemptedAt: now.toISOString(),
        promptVersion,
        modelId,
        spansOffered: spans.length,
        calls,
      }),
    );
    return { ok: true, outcome, added: 0 };
  };

  const applyResponse = (response: unknown, calls: 0 | 1): ReadRestResult => {
    const merged = mergeModelProposals({
      set: interpretation,
      spans,
      response,
      attemptedAt: now.toISOString(),
      promptVersion,
      modelId,
      calls,
    });
    save(merged.set);
    return { ok: true, outcome: merged.outcome, added: merged.accepted.length };
  };

  /*
   * Everything below the claim is synchronous until the provider call, and
   * deliberately so. Moving any of these reads after an `await` would reopen
   * exactly the window the lease closes.
   */
  if (refusal) return persist(refusal, 0);
  if (!isInterpretationModelConfigured()) return persist('not_configured', 0);

  const cacheKey = cacheKeyForSpans({
    spans,
    taxonomyVersion: interpretation.lexiconVersion,
    promptVersion,
    modelId,
    locale: interpretation.lexiconLocale,
  });

  /*
   * A cache hit costs nothing and is charged nothing.
   *
   * `calls: 0` means the trip's one reading is still available — a refresh
   * that replayed a stored answer must not consume a budget nobody spent.
   */
  const cached = getCachedInterpretation(tripId, cacheKey, now);
  if (cached) return applyResponse(cached, 0);

  /*
   * The text has moved on. Anything this trip is still holding for an older
   * sentence is retired here rather than left to land later: its answer is about
   * words that no longer exist, and applying it would attribute a reading of a
   * deleted sentence to the current one.
   */
  supersedeModelOperations({ tripId, kind: MODEL_OPERATION_KIND, keepCacheKey: cacheKey, now });

  const claim = claimModelOperation({
    tripId,
    kind: MODEL_OPERATION_KIND,
    cacheKey,
    owner: randomUUID().slice(0, 8),
    now,
  });

  if (claim.kind === 'exhausted') return persist('budget_exhausted', 0);

  if (claim.kind === 'settled') {
    /*
     * Somebody already finished this exact reading. Replay it, free.
     *
     * `failed_terminal` deliberately replays as a *failure* rather than as a
     * fresh attempt: an answer the schema could not use will not become usable
     * by being asked for again, and a screen that re-asked on every paint would
     * spend money on a render.
     */
    if (claim.operation.state === 'succeeded' && claim.operation.result !== null) {
      return applyResponse(claim.operation.result, 0);
    }
    return persist(outcomeForFailure(claim.operation.failureKind), 0);
  }

  if (claim.kind === 'lost') {
    /*
     * Another invocation holds the reading. Wait for it, bounded, and then use
     * whatever it got. Under no circumstances call the provider: the losing side
     * of a race is the side that must not spend.
     */
    const finished = await awaitModelOperation({
      tripId,
      kind: MODEL_OPERATION_KIND,
      cacheKey,
      timeoutMs: LOSER_WAIT_MS,
    });
    if (finished?.state === 'succeeded' && finished.result !== null) {
      return applyResponse(finished.result, 0);
    }
    if (finished?.state === 'superseded') {
      return { ok: false, error: 'Your words changed while we were reading. Nothing was lost.' };
    }
    if (finished && !['pending', 'running'].includes(finished.state)) {
      return persist(outcomeForFailure(finished.failureKind), 0);
    }
    // Still running when the clock ran out. Nothing is recorded, because nothing
    // has happened yet — the holder will record its own outcome.
    return { ok: false, error: 'We are still reading the rest of this. Give it a moment and refresh.' };
  }

  const operationId = claim.operation.id;
  const heartbeat = setInterval(
    () => heartbeatModelOperation(operationId, new Date()),
    HEARTBEAT_MS,
  );
  // Never hold the process open for a heartbeat.
  heartbeat.unref?.();

  try {
    const model = createInterpretationModel();
    const result = await proposeInterpretations(model, {
      spans,
      locale: interpretation.lexiconLocale,
    });

    if (!result.ok) {
      /*
       * The spend is recorded either way, and the two failure families are kept
       * apart. An outage may be tried again; an unusable answer may not.
       */
      settleModelOperation({
        id: operationId,
        state: result.outcome === 'invalid_response' ? 'failed_terminal' : 'failed_retryable',
        now: new Date(),
        failureKind: result.outcome,
        usage: spendOf(model, result.calls),
      });
      return persist(result.outcome, result.calls);
    }

    saveCachedInterpretation(tripId, cacheKey, result.response, now);
    settleModelOperation({
      id: operationId,
      state: 'succeeded',
      now: new Date(),
      result: result.response,
      usage: spendOf(model, result.calls),
    });
    return applyResponse(result.response, 1);
  } catch (error) {
    /*
     * The last resort, and it still keeps the promise: the composer is not
     * rewritten on this path at all, so the traveller's words are exactly what
     * they were before the button was pressed. The lease is released as a
     * retryable failure rather than left to expire, so the trip is not stuck
     * behind a request that already finished.
     */
    settleModelOperation({
      id: operationId,
      state: 'failed_retryable',
      now: new Date(),
      failureKind: 'threw',
      detail: 'The reading threw before it could be recorded.',
      usage: { calls: 1 },
    });
    console.error('Could not read the unresolved text', { tripId, error });
    return { ok: false, error: 'We could not read the rest just then. Your words are saved as you wrote them.' };
  } finally {
    clearInterval(heartbeat);
  }
}

/** One kind per paid operation. Namespaces the lease within a trip. */
const MODEL_OPERATION_KIND = 'interpretation';

/** How long a loser waits before saying "still going" rather than calling. */
const LOSER_WAIT_MS = 20_000;

/** Comfortably inside the lease window, so a live holder is never reclaimed. */
const HEARTBEAT_MS = 5_000;

/**
 * A stored failure, back in the vocabulary the screen has sentences for.
 *
 * The lease records the failure *kind* rather than the outcome so that the two
 * remain independently readable; this is the one place they are joined, and an
 * unrecognised kind falls to `provider_unavailable`, which is the honest
 * catch-all: we asked, and we do not have an answer.
 */
function outcomeForFailure(failureKind: string | null): ModelFallbackOutcome {
  const known: ModelFallbackOutcome[] = [
    'invalid_response',
    'provider_unavailable',
    'not_configured',
    'budget_exhausted',
    'no_proposals',
  ];
  const match = known.find((outcome) => outcome === failureKind);
  return match ?? 'provider_unavailable';
}

/**
 * WHAT THE READING ACTUALLY COST, FROM THE FENCE THAT PAID FOR IT.
 *
 * Recorded on every terminal path, including the failures — which is the half
 * that matters. A call that came back malformed, or timed out after the provider
 * had already generated its answer, has been paid for exactly like one that
 * worked, and an operation row saying `calls: 1` beside `cost: 0` is an audit
 * trail that under-reports precisely the runs somebody would want to look at.
 *
 * Read off the model after the call rather than returned by it: the failure
 * paths return an outcome and no response, so a result-shaped channel would lose
 * the spend on the exact cases it exists for.
 *
 * Zero when the fence does not count — the offline fakes — and that is honest
 * rather than missing, because those spent nothing.
 */
function spendOf(model: StructuredModel, calls: 0 | 1) {
  const usage = model.usage;
  return {
    calls,
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    costMicroUsd: Math.round((usage?.estimatedCostUsd ?? 0) * 1_000_000),
  };
}
