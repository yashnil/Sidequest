'use server';
import { revalidatePath } from 'next/cache';
import { randomUUID } from 'node:crypto';
import { getItinerary, getProfile, tripOwner } from '../db/repository';
import { recordPreferenceEvidence } from '../db/preference-evidence-repository';
import { listBookedItems } from '../db/intelligence-repository';
import { recordDecision } from '../db/execution-repository';
import { bookedItemBinds, draftDelta, evidenceRowsFromRequest, metricsDelta, type DeltaDraftShape, type DeltaLine, type DraftDelta } from '@sidequest/core';
import { getTripDraft } from '../db/draft-repository';
import { FOREIGN_TRIP_REFUSAL, ownedTrip, tripAccessRefusal } from '../net/trip-access';
import { ResearchModel } from '../providers/anthropic';
import { isCompositionModelConfigured, isFixtureComposer } from '../providers/switches';
import { reserveModelCalls } from '../compiler/daily-ceiling';
import { generateSidequestPlanForTrip } from '../planning/production-plan';
import { composerModel } from '../planning/composition-model';
import type { TripDraft } from '../planning/trip-draft';
import { SqliteRefinementCheckpointer } from './checkpointer';
import { describeContract, describeRefusal } from './describe';
import { buildRefinementGraph, resumeWith, type RefinementInterpreter } from './graph';
import { isStructuralRequest, modelRefinementInterpreter } from './interpreter';
import { tripPatchSchema, type TripPatch } from './patch';
import { RefinementBusyError, activeRun, beginRun, listRuns, updateRun, type RefinementRun } from './run-repository';
import { applyTripPatch } from './patch';
import { StaleTripVersionError, currentVersion, ensureBaselineVersion, getVersion, recordVersion, undoTarget } from './version-repository';
import { refinementRunThreadId, refinementThreadId } from './threads';
import { MAX_REFINEMENT_MODEL_CALLS, type ClarifyingQuestion, type RefinementLock } from './state';

/**
 * ASK SIDEQUEST — THE SERVER SIDE.
 *
 * PRODUCTION LOCK V5 §43–§49. Every exported action here obeys the same three
 * rules, in this order, and the order is the point:
 *
 * 1. **Ownership first, always** (§61). `tripAccessRefusal` runs before anything
 *    else — before the trip is read, before a thread id is constructed, before a
 *    run is created. A thread id is a lookup key and never a capability.
 * 2. **The lease before the work** (§48). A second request while one is in flight
 *    is refused with the reason, not queued behind a trip the traveller has not
 *    seen and not raced against it.
 * 3. **Nothing is committed until it is applied.** A failure at any point leaves
 *    the canonical trip exactly as it was, and says so (§49).
 */

export interface RefinementResult {
  ok: boolean;
  /** A sentence for the traveller. Never a schema path, a provider name or a stack. */
  error?: string;
  /** Set when Sidequest needs one answer before it can proceed (§42). */
  question?: ClarifyingQuestion;
  /** The run this belongs to, so the client can resume or poll it. */
  runId?: string;
  /** What changed, what stayed, what is being rechecked (§44). */
  summary?: { changed: readonly string[]; kept: readonly string[]; rechecking: readonly string[]; refused: readonly string[] };
  /** A read-only answer. Present only for a question about the trip. */
  answer?: string;
  version?: number;
  /** V6 §30 — ANSWER_ONLY, PROPOSE_CHANGE or APPLY_CHANGE. */
  mode?: 'answer' | 'proposal' | 'applied';
  /** V6 §30 — the preview behind a proposal: its scope and the changes it would make, before anything lands. */
  proposal?: { scope: string; changes: readonly string[]; days: readonly number[]; delta?: DraftDelta };
  /** V9 §4 — after an Apply, the measured delta between the version before and the version after. */
  delta?: DeltaLine[];
}

/** V9 §4 — a draft as the delta reads it: bases with nights, days with their anchors and transport hints. */
function draftShapeOf(draft: TripDraft): DeltaDraftShape {
  return {
    bases: draft.bases.map((base) => ({ id: base.id, name: base.name, nights: base.nights })),
    days: draft.days.map((day) => ({
      dayNumber: day.dayNumber,
      baseId: day.baseId,
      anchors: day.anchors.map((anchor) => ({ name: anchor.name, role: anchor.role, kind: anchor.category, ...(anchor.transport ? { transport: anchor.transport } : {}) })),
    })),
  };
}

/** The sentence a traveller sees when refinement is not configured. No environment variable names. */
/** How many "kept" lines a traveller reads before the list stops being reassurance. */
const SUMMARY_LINE_LIMIT = 6;

const NOT_CONFIGURED = 'Sidequest cannot make changes for you right now. Your trip is unchanged.';

function interpreterFor(caller: string | null, now: Date): { interpreter: RefinementInterpreter; error?: undefined } | { interpreter?: undefined; error: string } {
  if (isFixtureComposer()) {
    /*
     * The fixture composer exists so the whole path runs offline with no paid
     * call. It cannot invent a change, so it answers every request as a question
     * about the trip — honest, and enough to exercise ownership, the lease, the
     * versioning and the UI without spending anything.
     */
    return {
      interpreter: {
        async interpret({ request, draft, structural }) {
          /*
           * V9.1 — a structural request gets a deterministic structural answer
           * offline: the shortest stay folds into its neighbour. That lets the
           * proposal, the delta, Apply, reverification and Undo run in the
           * browser suite without a model; everything else is still explained.
           */
          const patch = isStructuralRequest(request, structural) ? fixtureRestructure(draft) : null;
          if (patch) return { intent: 'change_base' as const, patch };
          return { intent: 'explain_decision' as const, explanation: 'Sidequest is running offline against saved fixtures, so it can explain this trip but not change it.' };
        },
      },
    };
  }
  if (!isCompositionModelConfigured()) return { error: NOT_CONFIGURED };
  /*
   * V9.1 — THE ALLOWANCE IS SPENT WHERE THE CALL IS MADE, NOT WHERE THE SEAM IS
   * BUILT.
   *
   * Both doors build an interpreter before the graph decides what it needs, and
   * answering a proposal is one of them — but `graph.ts` routes a pending
   * confirmation "straight to apply or to cancel — never back through the
   * model", so `interpret` is never called on that path. Reserving eagerly
   * therefore debited a call for a press that issues no request: one live
   * refinement made a single Anthropic call and moved `daily_provider_spend` by
   * two, against the rule that Apply and Cancel cost no model call.
   *
   * Deferring the reservation into `interpret` makes the ledger describe what
   * happened: one reservation per actual interpretation, none for Apply, Cancel,
   * a reload or an Undo. The ceiling is still checked before any request goes
   * out, which is the only thing it has to be in front of.
   */
  const model = new ResearchModel({ maxCalls: 1, maxRetries: 0, model: composerModel() });
  const underlying = modelRefinementInterpreter(model);
  return {
    interpreter: {
      async interpret(input) {
        const reservation = reserveModelCalls(1, { now, caller });
        if (!reservation.allowed) throw new Error(reservation.message ?? 'Today’s allowance is used up. Try again tomorrow.');
        return underlying.interpret(input);
      },
    },
  };
}

/**
 * V6 §29 — LOAD THE TRIP CONTRACT'S LOCKS INTO THE REFINEMENT.
 *
 * The contract's locked facts become refinement locks before the graph runs,
 * so "move the whole thing to October" against dates the traveller chose is
 * asked as a question rather than applied. Booked facts are already bound by
 * the apply node; activity pins from the UI are a P2 the mechanism already
 * honours.
 */
function locksFor(trip: { basics: { timingLock?: 'traveler' | 'sidequest'; startDate: string; endDate: string } }): RefinementLock[] {
  const locks: RefinementLock[] = [];
  if (trip.basics.timingLock === 'traveler') {
    locks.push({ kind: 'timing', ref: 'dates', label: `the dates you chose (${trip.basics.startDate} to ${trip.basics.endDate})`, lockedAt: new Date().toISOString() });
  }
  return locks;
}

async function draftFor(tripId: string): Promise<TripDraft | null> {
  return getTripDraft(tripId)?.draft ?? null;
}

/**
 * Ask Sidequest to change the trip, or to explain it.
 *
 * One model call. A question comes back as `question` and the run stays open
 * holding the lease; `answerRefinementAction` resumes it.
 */
export async function refineTripAction(input: { tripId: string; request: string; idempotencyKey?: string; structural?: boolean }): Promise<RefinementResult> {
  const refusal = await tripAccessRefusal(input.tripId);
  if (refusal) return { ok: false, error: refusal };
  const trip = await ownedTrip(input.tripId);
  if (!trip) return { ok: false, error: FOREIGN_TRIP_REFUSAL };

  const request = input.request.trim();
  if (request.length === 0) return { ok: false, error: 'Tell Sidequest what you would like changed.' };
  if (request.length > 600) return { ok: false, error: 'That is longer than Sidequest can act on. Try one change at a time.' };

  const draft = await draftFor(input.tripId);
  if (!draft) return { ok: false, error: 'There is no plan to change yet. Build the trip first.' };

  const now = new Date();
  /*
   * §46 — the trip as built becomes version 1 before anything edits it, so the
   * FIRST refinement is undoable. Without this the live acceptance run finished a
   * successful change at head version 1, and `undoTarget` (head - 1) had nothing
   * to return: the traveller's first edit was the one edit they could not take
   * back. Lazy and idempotent, so an unrefined trip pays nothing.
   */
  const built = getItinerary(input.tripId);
  const baseVersion = built ? ensureBaselineVersion({ tripId: input.tripId, itinerary: built, draft, now }) : currentVersion(input.tripId);
  const threadId = refinementThreadId(input.tripId);

  let run: RefinementRun;
  try {
    const started = beginRun({ tripId: input.tripId, threadId, request, baseVersion, ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}), now });
    if (started.reused) {
      /* §59 — a double press is one press. Answer with whatever that run has already produced. */
      return started.run.status === 'awaiting_answer' && started.run.question
        ? { ok: true, runId: started.run.id, question: started.run.question }
        : { ok: started.run.status !== 'failed', runId: started.run.id, ...(started.run.error ? { error: started.run.error } : {}) };
    }
    run = started.run;
  } catch (error) {
    if (error instanceof RefinementBusyError) return { ok: false, error: error.message, runId: error.activeRun.id, ...(error.activeRun.question ? { question: error.activeRun.question } : {}) };
    throw error;
  }

  const seam = interpreterFor(null, now);
  if (!seam.interpreter) {
    updateRun({ id: run.id, status: 'failed', error: seam.error, now });
    return { ok: false, error: seam.error, runId: run.id };
  }

  return runGraph({ tripId: input.tripId, run, draft, interpreter: seam.interpreter, request, baseVersion, locks: locksFor(trip) });
}

/** Resume a refinement that stopped to ask one question (§42). */
export async function answerRefinementAction(input: { tripId: string; runId: string; answer: string }): Promise<RefinementResult> {
  const refusal = await tripAccessRefusal(input.tripId);
  if (refusal) return { ok: false, error: refusal };
  const run = activeRun(input.tripId);
  if (!run || run.id !== input.runId) return { ok: false, error: 'That question is no longer open. Ask Sidequest again when you are ready.' };
  const draft = await draftFor(input.tripId);
  if (!draft) return { ok: false, error: 'There is no plan to change yet.' };
  const now = new Date();
  const seam = interpreterFor(null, now);
  if (!seam.interpreter) {
    updateRun({ id: run.id, status: 'failed', error: seam.error, now });
    return { ok: false, error: seam.error, runId: run.id };
  }
  return runGraph({ tripId: input.tripId, run, draft, interpreter: seam.interpreter, request: run.request, baseVersion: run.baseVersion, answer: input.answer.slice(0, 400) });
}

/**
 * Drive the graph and translate its outcome into a sentence.
 *
 * The commit is the only thing here that writes to the trip, and it does three
 * things in one place so they cannot drift: persist and verify the patched draft
 * through the one canonical pipeline, mint the version, and return the new
 * version number for the optimistic-concurrency check.
 */
async function runGraph(input: {
  tripId: string;
  run: RefinementRun;
  draft: TripDraft;
  interpreter: RefinementInterpreter;
  request: string;
  baseVersion: number;
  answer?: string;
  locks?: RefinementLock[];
  structural?: boolean;
}): Promise<RefinementResult> {
  const { tripId, run, draft, interpreter } = input;
  const graph = buildRefinementGraph({
    loadDraft: async () => draft,
    /* §9 — a patch may not orphan a booked fact. Read at apply time, never cached in state. */
    loadBookings: async () => listBookedItems(tripId).filter((item) => bookedItemBinds(item)).map((item) => ({ title: item.title, date: item.date, endDate: item.endDate, baseId: item.baseId })),
    interpreter,
    checkpointer: new SqliteRefinementCheckpointer(tripId),
    /* V6 §30 — a change of three days or more, a base, the route or the dates is shown before it lands. */
    confirmMaterialChanges: true,
    async commit({ draft: patched, applied, baseVersion }) {
      /*
       * §51 — reverification runs the canonical pipeline over the patched draft.
       * It is currently whole-trip rather than blast-radius-scoped; the recheck
       * list is computed and persisted on the version, and `reconcile.ts` does
       * not consume it yet. The cost is largely absorbed because persisted place
       * identities from the previous build are reused before any provider is
       * asked (`persistedIdentitiesFor`). Recorded as P1.
       */
      const verified = await generateSidequestPlanForTrip(tripId, { useDraft: patched, mode: 'full' });
      if (!verified.ok || !verified.result) throw new Error(verified.error ?? 'The change could not be verified.');
      const version = recordVersion({
        tripId,
        previousVersion: baseVersion,
        request: input.request,
        /* V6 — the version records what was applied, never what the model said it would do. */
        summary: { changed: [...applied], kept: [], rechecking: [] },
        itinerary: verified.result.itinerary,
        draft: patched,
      });
      /*
       * V6 §31 — every applied refinement is preference evidence, trip-scoped:
       * "fewer temples, more neighbourhoods" changes this trip now and leaves
       * a low-confidence lean on the ledger. It becomes account-wide only when
       * repeated or said outright. Never a hard constraint.
       */
      try {
        const owner = tripOwner(tripId);
        const rows = evidenceRowsFromRequest({ request: input.request, tripId, userId: owner?.userId ?? null, ownerToken: owner?.ownerToken ?? null, now: new Date(), idFor: () => randomUUID() });
        if (rows.length > 0) recordPreferenceEvidence(rows);
      } catch (error) {
        console.warn('Could not record preference evidence for a refinement', { tripId, message: error instanceof Error ? error.message : 'unknown' });
      }
      return version.version;
    },
  });

  /*
   * PRODUCTION LOCK V5 — ONE ACTION, ONE SLICE OF GRAPH STATE.
   *
   * `graph.invoke` on a thread RESUMES that thread's checkpoint. With the run's
   * whole history in one namespace, a second refinement inherited the first
   * one's channels: the live closure run reported `modelCalls: 2` for a single
   * call, and carried the previous run's error alongside its own.
   *
   * The counter being wrong is the harmless half. The dangerous half is that
   * `interpret` refuses once `modelCallsThisAction` reaches the ceiling — so
   * after two failed refinements a trip would silently refuse every future one,
   * without calling anything, forever.
   *
   * The thread is the run: a new action gets a fresh one, and a resume after a
   * clarifying question passes the same run and lands back in its own state.
   * The trip id stays the prefix, so ownership, `tripIdOfThread` and the
   * `ON DELETE CASCADE` from `trips` behave exactly as before. `checkpoint_ns`
   * was tried first and does not work — LangGraph reserves it for subgraphs.
   */
  const config = { configurable: { thread_id: refinementRunThreadId(tripId, run.id) } };
  try {
    const state = input.answer
      ? await graph.invoke(resumeWith(input.answer), config)
      : await graph.invoke({ tripId, canonicalTripVersion: input.baseVersion, userRequest: input.request, locks: input.locks ?? [], status: 'classifying' as const, structural: input.structural === true }, config);

    if (state.status === 'awaiting_answer' && state.pendingQuestion) {
      updateRun({ id: run.id, status: 'awaiting_answer', intent: state.intent ?? null, modelCalls: state.modelCallsThisAction, question: state.pendingQuestion });
      /* V6 §30 — a proposal carries its preview: the scope, the days, and the changes it would make. */
      if (state.confirm === 'pending' && state.proposedPatch && state.blastRadius) {
        /*
         * V9 §4 — THE DETERMINISTIC DELTA, BEFORE APPLY.
         *
         * The same application the graph ran on its clone, run again here on
         * the draft as stored, and the two shapes compared: bases, hotel
         * changes, stops, signature stops kept, the days that change. From the
         * drafts themselves — never the model's prose, and no provider has
         * run, so nothing here is a measured minute.
         */
        let delta: DraftDelta | undefined;
        try {
          const booked = listBookedItems(tripId).filter((item) => bookedItemBinds(item)).map((item) => ({ title: item.title, date: item.date, endDate: item.endDate, baseId: item.baseId }));
          const preview = applyTripPatch({ draft, patch: state.proposedPatch, locked: state.contract?.preserve ?? [], travellerLocked: (input.locks ?? state.locks).map((lock) => `${lock.kind}:${lock.ref}`), booked });
          delta = draftDelta(draftShapeOf(draft), draftShapeOf(preview.draft));
        } catch (error) {
          console.warn('Could not compute the proposal delta', { tripId, runId: run.id, message: error instanceof Error ? error.message : 'unknown' });
        }
        return { ok: true, runId: run.id, question: state.pendingQuestion, mode: 'proposal', proposal: { scope: state.blastRadius.reason, changes: state.proposedPatch.changed.slice(0, 10), days: state.blastRadius.days, ...(delta ? { delta } : {}) } };
      }
      return { ok: true, runId: run.id, question: state.pendingQuestion };
    }
    if (state.status === 'failed' || state.status === 'rejected') {
      const message = travellerSentenceFor(state.errors, state.refused);
      /*
       * The traveller gets one sentence; an operator needs the cause.
       *
       * The live acceptance run failed here and logged nothing, so the reason —
       * the model truncated at `max_tokens` — was only recoverable by decoding
       * the LangGraph checkpoint by hand. That the checkpoint HAD it is the
       * durable saver doing its job; that it was the only copy was a gap.
       */
      console.warn('A refinement did not produce a change', { tripId, runId: run.id, status: state.status, intent: state.intent ?? null, modelCalls: state.modelCallsThisAction, errors: state.errors, refused: state.refused.map((entry) => entry.reason) });
      updateRun({ id: run.id, status: state.status, intent: state.intent ?? null, modelCalls: state.modelCallsThisAction, question: null, error: message });
      return { ok: false, error: message, runId: run.id };
    }
    if (state.explanation) {
      updateRun({ id: run.id, status: 'done', intent: state.intent ?? null, modelCalls: state.modelCallsThisAction, question: null, result: { explanation: state.explanation } });
      /*
       * V9 §18 — a cancelled proposal that would have moved where the traveller
       * sleeps is a leaning, not a rule: one quiet, trip-scoped row against
       * hotel changes. Taste only; never a constraint, never account-wide on
       * its own.
       */
      if (state.confirm === 'cancelled' && (state.blastRadius?.bases.length ?? 0) > 0) recordCancelledBaseChange(tripId);
      return { ok: true, runId: run.id, answer: state.explanation, mode: 'answer' };
    }
    /*
     * §11, §44 — the summary is written in the traveller's words.
     *
     * The contract addresses things by identity (`activity:d1-a0-ala-too-square`)
     * because preservation has to be checkable. The first live refinement showed
     * those addresses to the traveller under "Kept". `describe.ts` is now the one
     * boundary where an address becomes a sentence, and nothing internal crosses
     * it: not an id, not a fact key, not a refusal written for a log.
     */
    const described = describeContract({ contract: state.contract, draft });
    const summary = {
      changed: state.applied,
      kept: described.kept.slice(0, SUMMARY_LINE_LIMIT),
      rechecking: described.rechecking,
      refused: state.refused.map((entry) => describeRefusal(entry.reason)),
    };
    updateRun({ id: run.id, status: 'done', intent: state.intent ?? null, modelCalls: state.modelCallsThisAction, question: null, result: summary });
    /*
     * V9 §3 — an applied refinement is a decision the traveller made, recorded
     * as one: the request as the chosen option, at `user_explicit`, over the
     * scope the change reached. Read back by the state graph and the decision
     * cards; never a second source of truth for the itinerary itself.
     */
    try {
      recordDecision(tripId, {
        key: `refinement:${state.canonicalTripVersion}`,
        chosen: input.request,
        why: state.applied[0] ?? 'A change you asked for.',
        lock: 'user_explicit',
        decidedBy: 'traveller',
        scope: { dayNumbers: state.blastRadius?.days ?? [], baseIds: state.blastRadius?.bases ?? [] },
      });
    } catch (error) {
      console.warn('Could not record the refinement decision', { tripId, runId: run.id, message: error instanceof Error ? error.message : 'unknown' });
    }
    /* V9 §4 — the measured delta: the structural metrics of the version before against the version after. */
    const delta = appliedDelta(tripId, input.baseVersion, state.canonicalTripVersion);
    revalidatePath(`/trips/${tripId}/itinerary`);
    return { ok: true, runId: run.id, summary, version: state.canonicalTripVersion, mode: 'applied', ...(delta.length > 0 ? { delta } : {}) };
  } catch (error) {
    /*
     * §49 — the trip is unchanged, and that is the first thing the traveller is
     * told. A stale version is its own sentence because it has a different
     * remedy: reload and ask again.
     */
    const message = error instanceof StaleTripVersionError ? 'Your trip changed while Sidequest was working on this. Reload and ask again.' : 'Sidequest could not apply that change. Your current trip is unchanged.';
    console.error('A refinement failed', { tripId, runId: run.id, error: error instanceof Error ? error.message : 'unknown' });
    updateRun({ id: run.id, status: 'failed', question: null, error: message });
    return { ok: false, error: message, runId: run.id };
  }
}

/** The measured delta between two persisted versions' `package.metrics`; empty when either has none. */
function appliedDelta(tripId: string, beforeVersion: number, afterVersion: number): DeltaLine[] {
  try {
    const before = getVersion(tripId, beforeVersion)?.itinerary;
    const after = getVersion(tripId, afterVersion)?.itinerary ?? getItinerary(tripId);
    const previousMetrics = before?.package?.metrics;
    const nextMetrics = after?.package?.metrics;
    if (!previousMetrics || !nextMetrics || !after) return [];
    return metricsDelta(previousMetrics, nextMetrics, after.days.length);
  } catch (error) {
    console.warn('Could not compute the applied delta', { tripId, message: error instanceof Error ? error.message : 'unknown' });
    return [];
  }
}

/** V9 §18 — "the traveller cancelled a proposal that moved a base": one trip-scoped, low-strength behaviour row. */
function recordCancelledBaseChange(tripId: string, now: Date = new Date()): void {
  try {
    const owner = tripOwner(tripId);
    recordPreferenceEvidence([
      {
        userId: owner?.userId ?? null,
        ownerToken: owner?.ownerToken ?? null,
        travelerId: null,
        tripId,
        scope: 'trip',
        signal: 'place_rejected',
        feature: 'hotel_changes',
        polarity: -1,
        strength: 0.4,
        source: 'behaviour',
        context: { reason: 'cancelled_base_proposal' },
        createdAt: now.toISOString(),
      },
    ]);
  } catch (error) {
    console.warn('Could not record the cancelled base proposal', { tripId, message: error instanceof Error ? error.message : 'unknown' });
  }
}

/** One sentence, from whatever the graph recorded. Never a schema path or a provider name. */
function travellerSentenceFor(errors: readonly string[], refused: readonly { reason: string }[]): string {
  if (refused.some((entry) => entry.reason.includes('locked'))) return 'That would have changed something you asked Sidequest to keep, so nothing was changed.';
  if (errors.some((entry) => entry.includes('model calls'))) return `Sidequest allows ${MAX_REFINEMENT_MODEL_CALLS} attempts at one change. Try asking for something more specific.`;
  return 'Sidequest could not make that change. Your current trip is unchanged.';
}

/**
 * Restore the version before the current one (§46).
 *
 * A persisted-state restore, deliberately not a graph replay: replaying a node
 * re-triggers whatever it called, so an undo would cost a model call and could
 * return something that is not what was undone.
 */
export async function undoRefinementAction(input: { tripId: string }): Promise<RefinementResult> {
  const refusal = await tripAccessRefusal(input.tripId);
  if (refusal) return { ok: false, error: refusal };
  const target = undoTarget(input.tripId);
  if (!target) return { ok: false, error: 'There is nothing to undo on this trip.' };
  const head = currentVersion(input.tripId);
  const { saveItinerary } = await import('../db/repository');
  const { saveTripDraft } = await import('../db/draft-repository');
  saveItinerary(target.itinerary);
  if (target.draft) saveTripDraft({ tripId: input.tripId, draft: target.draft });
  /*
   * The restore is itself a version, so the history stays append-only and a
   * traveller can undo an undo. Overwriting the head would make "restore" the
   * one operation with no record of having happened.
   */
  recordVersion({
    tripId: input.tripId,
    previousVersion: head,
    request: `Undo back to version ${target.version}`,
    summary: { changed: [`Restored the trip as it was before your last change.`], kept: [], rechecking: [] },
    itinerary: target.itinerary,
    draft: target.draft,
  });
  revalidatePath(`/trips/${input.tripId}/itinerary`);
  /*
   * §11 — "Restored version 1" is the system's own bookkeeping read aloud. The
   * traveller asked for their trip back; that is what the sentence says.
   */
  return { ok: true, version: head + 1, summary: { changed: ['Your trip is back as it was before your last change.'], kept: [], rechecking: [], refused: [] } };
}

/** The conversation so far, for the Ask Sidequest panel. Owner only. */
export async function refinementHistoryAction(input: { tripId: string }): Promise<{ ok: boolean; runs?: RefinementRun[]; canUndo?: boolean; error?: string }> {
  const refusal = await tripAccessRefusal(input.tripId);
  if (refusal) return { ok: false, error: refusal };
  return { ok: true, runs: listRuns(input.tripId, 10), canUndo: undoTarget(input.tripId) !== null };
}

/** Kept so the module's imports stay honest about what it reads. */
export async function refinementReadyAction(input: { tripId: string }): Promise<{ ok: boolean; ready: boolean }> {
  const refusal = await tripAccessRefusal(input.tripId);
  if (refusal) return { ok: false, ready: false };
  return { ok: true, ready: Boolean(getTripDraft(input.tripId) && getItinerary(input.tripId) && getProfile(input.tripId)) };
}

/**
 * The fixture's structural answer: fold the shortest stay into the neighbour
 * that shares its side of the route, keeping the nights total. Null on a
 * one-base trip, where there is no hotel change to remove.
 */
function fixtureRestructure(draft: TripDraft): TripPatch | null {
  const live = draft.bases.filter((base) => base.nights > 0);
  if (live.length < 2) return null;
  const shortest = [...live].sort((a, b) => a.nights - b.nights || draft.bases.indexOf(a) - draft.bases.indexOf(b))[0]!;
  const index = draft.bases.indexOf(shortest);
  const neighbour = draft.bases[index - 1] && draft.bases[index - 1]!.nights > 0 ? draft.bases[index - 1]! : draft.bases[index + 1]!;
  if (!neighbour) return null;
  /* V9.1 CLOSURE — topology only: which stay folds into which. Sidequest moves the nights. */
  return tripPatchSchema.parse({
    operations: [
      { op: 'restructure', merge: [{ from: shortest.id, into: neighbour.id }], why: `One hotel change fewer: the ${shortest.nights}-night stay in ${shortest.name} folds into ${neighbour.name}.` },
    ],
  });
}
