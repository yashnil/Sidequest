import 'server-only';
import { Annotation, Command, END, START, StateGraph, interrupt, type CommandInstance } from '@langchain/langgraph';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import type { TripDraft } from '../planning/trip-draft';
import type { BookingDependency } from './invariants';
import { applyTripPatch, patchReach, tripPatchSchema, type TripPatch } from './patch';
import { blastRadiusFor, lockConflicts, preservationContractFor, radiusForPatch } from './blast-radius';
import { describeRefusal } from './describe';
import {
  MAX_REFINEMENT_MODEL_CALLS,
  intentIsReadOnly,
  refinementIntentSchema,
  type BlastRadius,
  type ClarifyingQuestion,
  type PreservationContract,
  type RefinementIntent,
  type RefinementLock,
  type RefinementStatus,
} from './state';

/**
 * THE REFINEMENT GRAPH — WHERE LANGGRAPH EARNS ITS PLACE, AND WHERE IT DOES NOT.
 *
 * PRODUCTION LOCK V5 §33. LangGraph is **not** used for the initial build. That
 * path is unchanged and stays unchanged: interview → TravelerBrief → ONE
 * composition call → canonical TripDraft → Sidequest's own verification → Trip
 * Hub. There is nothing stateful about it, nothing to resume, and no human in
 * the middle of it.
 *
 * What LangGraph is here for is the thing Sidequest genuinely did not have: a
 * refinement that can stop half way, ask the traveller one question, survive the
 * answer arriving in a different HTTP request and a server restart in between,
 * and then finish exactly where it left off. That is durable execution with a
 * human in the loop, and writing it by hand is how people end up with a
 * half-applied patch and no way to tell.
 *
 * ## The shape
 *
 *   START → interpret ─┬─→ (read-only) → END
 *                      ├─→ ask → [interrupt] → interpret (once more) → apply
 *                      └─→ apply → verify → END
 *
 * Four nodes. A `StateGraph` rather than the Functional API because the routing
 * is the interesting part — which of three ways `interpret` can go is the whole
 * design — and a graph makes that readable where a chain of `task()` calls
 * would bury it in control flow.
 *
 * ## The call ceiling is structural, not a convention
 *
 * `modelCallsThisAction` is checked before every call and the interpret node
 * refuses past `MAX_REFINEMENT_MODEL_CALLS` (§41). There is no retry edge and no
 * cycle back into `interpret` except the single resume after an interrupt, so the
 * graph *cannot* loop: the edge that would make it possible does not exist.
 *
 * ## Nothing here calls a provider
 *
 * `verify` records what must be re-measured (§51) and returns. The re-measuring
 * is done by the caller against the same seams the build uses, so a graph node
 * can never start a paid request that a resume would then repeat.
 */

/* ------------------------------------------------------------------ *
 * The channels
 * ------------------------------------------------------------------ */

const RefinementAnnotation = Annotation.Root({
  tripId: Annotation<string>({ reducer: (_, next) => next, default: () => '' }),
  canonicalTripVersion: Annotation<number>({ reducer: (_, next) => next, default: () => 0 }),
  travelerProfileVersion: Annotation<number>({ reducer: (_, next) => next, default: () => 0 }),
  userRequest: Annotation<string>({ reducer: (_, next) => next, default: () => '' }),
  /** The traveller's answer to a clarifying question, once they have given one. */
  answer: Annotation<string | undefined>({ reducer: (_, next) => next, default: () => undefined }),
  intent: Annotation<RefinementIntent | undefined>({ reducer: (_, next) => next, default: () => undefined }),
  locks: Annotation<RefinementLock[]>({ reducer: (_, next) => next, default: () => [] }),
  blastRadius: Annotation<BlastRadius | undefined>({ reducer: (_, next) => next, default: () => undefined }),
  contract: Annotation<PreservationContract | undefined>({ reducer: (_, next) => next, default: () => undefined }),
  pendingQuestion: Annotation<ClarifyingQuestion | undefined>({ reducer: (_, next) => next, default: () => undefined }),
  proposedPatch: Annotation<TripPatch | undefined>({ reducer: (_, next) => next, default: () => undefined }),
  /** The answer a read-only intent produced. No trip changes with this set. */
  explanation: Annotation<string | undefined>({ reducer: (_, next) => next, default: () => undefined }),
  applied: Annotation<string[]>({ reducer: (_, next) => next, default: () => [] }),
  refused: Annotation<{ ref: string; reason: string }[]>({ reducer: (_, next) => next, default: () => [] }),
  verificationNeeded: Annotation<string[]>({ reducer: (_, next) => next, default: () => [] }),
  status: Annotation<RefinementStatus>({ reducer: (_, next) => next, default: () => 'classifying' }),
  modelCallsThisAction: Annotation<number>({ reducer: (_, next) => next, default: () => 0 }),
  /**
   * V6 §30 — PROPOSE_CHANGE before APPLY_CHANGE for a material change.
   *
   * `pending` while the traveller is looking at what would change; `applied`
   * or `cancelled` afterwards. A resume with the answer routes straight to
   * apply or to a quiet end — never back through the model.
   */
  confirm: Annotation<'pending' | 'applied' | 'cancelled' | undefined>({ reducer: (_, next) => next, default: () => undefined }),
  errors: Annotation<string[]>({ reducer: (previous, next) => [...previous, ...next], default: () => [] }),
});

export type RefinementGraphState = typeof RefinementAnnotation.State;

/* ------------------------------------------------------------------ *
 * The one seam that reaches a model
 * ------------------------------------------------------------------ */

/**
 * What the interpreter returns: a reading of the request, and either a patch or
 * one question.
 *
 * `NEEDS_CLARIFICATION` is a first-class answer rather than an error (§41). The
 * model is explicitly allowed to say "I cannot do this well without knowing one
 * thing", and the alternative — guessing, then being wrong across a whole route —
 * is the failure this exists to prevent.
 */
export interface RefinementInterpretation {
  intent: RefinementIntent;
  /** Days the request named, in the traveller's own numbering. */
  namedDays?: readonly number[];
  namedBases?: readonly string[];
  /** For a read-only intent: the answer, in prose. No patch. */
  explanation?: string;
  patch?: TripPatch;
  needsClarification?: ClarifyingQuestion;
}

/** The seam the graph reaches for judgement. Exactly one call per invocation. */
export interface RefinementInterpreter {
  interpret(input: {
    request: string;
    draft: TripDraft;
    locks: readonly RefinementLock[];
    /** Present on the second call only: what the traveller answered. */
    answer?: string;
  }): Promise<RefinementInterpretation>;
}

export interface RefinementGraphDeps {
  /** The draft as it stands. Read once per invocation; never put in graph state. */
  loadDraft(tripId: string): Promise<TripDraft>;
  interpreter: RefinementInterpreter;
  /**
   * The bookings a patch must not orphan (§9). Read on the apply node rather than
   * held in graph state: a booking added while the traveller was answering a
   * clarifying question must bind the resume, not the stale copy.
   */
  loadBookings?(tripId: string): Promise<readonly BookingDependency[]>;
  /** Persist the patched draft and mint a new version. Returns the new version number. */
  commit(input: { tripId: string; draft: TripDraft; patch: TripPatch; applied: readonly string[]; baseVersion: number }): Promise<number>;
  checkpointer: BaseCheckpointSaver;
  /**
   * V6 §30 — propose a material change before applying it. The product path
   * sets this; the graph's own contract tests run without it, so a one-line
   * patch and a whole-route change both land in one pass there.
   */
  confirmMaterialChanges?: boolean;
}

/* ------------------------------------------------------------------ *
 * The graph
 * ------------------------------------------------------------------ */

/**
 * V6 §30 — what counts as material: the whole trip, three or more days, a
 * base or the route, the dates. A one-day swap lands and is undoable; a
 * change of this size is shown first.
 */
export function changeIsMaterial(radius: BlastRadius, intent: RefinementIntent): boolean {
  if (radius.wholeTrip) return true;
  if (intent === 'major_replan' || intent === 'change_route' || intent === 'change_base' || intent === 'change_timing') return true;
  if (radius.bases.length > 0) return true;
  return radius.days.length >= 3;
}

/** "This would change days 4, 5 and 6 and where you sleep in Sounkyo." */
export function describeScope(radius: BlastRadius, draft?: TripDraft): string {
  const days = radius.days.length > 0 ? `day${radius.days.length === 1 ? '' : 's'} ${radius.days.slice(0, 6).join(', ').replace(/, ([^,]*)$/, ' and $1')}` : null;
  const baseNames = radius.bases.map((id) => draft?.bases.find((base) => base.id === id)?.name ?? id);
  const bases = baseNames.length > 0 ? `where you sleep in ${baseNames.slice(0, 3).join(' and ')}` : null;
  const facts = radius.facts.length > 0 ? radius.facts.map((f) => f.replace(/_/g, ' ')).join(' and ') : null;
  const parts = [days, bases, facts].filter(Boolean);
  if (radius.wholeTrip) return 'This would change the whole trip.';
  return `This would change ${parts.length > 0 ? parts.join(' and ') : 'part of the trip'}.`;
}

export function buildRefinementGraph(deps: RefinementGraphDeps) {
  const graph = new StateGraph(RefinementAnnotation)
    /**
     * INTERPRET — the one node that spends a model call.
     *
     * Runs at most twice: once on the request, and once more after the traveller
     * answers a clarifying question. The ceiling is checked here rather than
     * trusted to the graph's shape, because a ceiling that depends on nobody
     * adding an edge is not a ceiling.
     */
    .addNode('interpret', async (state) => {
      if (state.modelCallsThisAction >= MAX_REFINEMENT_MODEL_CALLS) {
        return { status: 'failed' as const, errors: [`A refinement may use at most ${MAX_REFINEMENT_MODEL_CALLS} model calls.`] };
      }
      const draft = await deps.loadDraft(state.tripId);
      let reading: RefinementInterpretation;
      try {
        reading = await deps.interpreter.interpret({ request: state.userRequest, draft, locks: state.locks, ...(state.answer ? { answer: state.answer } : {}) });
      } catch (error) {
        /*
         * §49 — the model or the provider failed. The canonical trip is
         * untouched, because nothing has been committed: the only writes so far
         * are checkpoints. The traveller is told their trip is unchanged.
         */
        return { status: 'failed' as const, modelCallsThisAction: state.modelCallsThisAction + 1, errors: [error instanceof Error ? error.message : 'The refinement model did not answer.'] };
      }
      const spent = state.modelCallsThisAction + 1;
      const intent = refinementIntentSchema.safeParse(reading.intent);
      if (!intent.success) return { status: 'failed' as const, modelCallsThisAction: spent, errors: [`Unrecognised refinement intent: ${String(reading.intent)}`] };

      if (intentIsReadOnly(intent.data)) {
        return {
          intent: intent.data,
          status: 'done' as const,
          modelCallsThisAction: spent,
          explanation: reading.explanation ?? 'No answer was produced.',
          blastRadius: blastRadiusFor({ draft, intent: intent.data }),
        };
      }

      /* A question is only allowed on the FIRST call. A second one would be a loop. */
      if (reading.needsClarification && spent < MAX_REFINEMENT_MODEL_CALLS) {
        return { intent: intent.data, status: 'awaiting_answer' as const, modelCallsThisAction: spent, pendingQuestion: reading.needsClarification };
      }

      const namedRadius = blastRadiusFor({ draft, intent: intent.data, ...(reading.namedDays ? { namedDays: reading.namedDays } : {}), ...(reading.namedBases ? { namedBases: reading.namedBases } : {}) });
      if (!reading.patch) return { intent: intent.data, status: 'failed' as const, modelCallsThisAction: spent, blastRadius: namedRadius, contract: preservationContractFor({ draft, radius: namedRadius, intent: intent.data, locks: state.locks }), errors: ['The refinement produced no change to apply.'] };
      const patch = tripPatchSchema.safeParse(reading.patch);
      if (!patch.success) return { intent: intent.data, status: 'failed' as const, modelCallsThisAction: spent, blastRadius: namedRadius, contract: preservationContractFor({ draft, radius: namedRadius, intent: intent.data, locks: state.locks }), errors: [`The proposed change was malformed: ${patch.error.issues[0]?.path.join('.')} ${patch.error.issues[0]?.message}`] };
      /* V6 — the scope is what the patch reaches inside the envelope the request allows (`radiusForPatch`). */
      const radius = radiusForPatch({ radius: namedRadius, reach: patchReach(patch.data, draft), intent: intent.data, draft });
      const contract = preservationContractFor({ draft, radius, intent: intent.data, locks: state.locks });
      const conflicts = lockConflicts({ radius, locks: state.locks, draft });
      if (conflicts.length > 0 && spent < MAX_REFINEMENT_MODEL_CALLS) {
        /*
         * §45 — a lock in the way is a decision for the traveller, not for
         * Sidequest. It is asked as a question rather than resolved by
         * overriding the lock or by refusing the request.
         */
        return {
          intent: intent.data,
          status: 'awaiting_answer' as const,
          modelCallsThisAction: spent,
          blastRadius: radius,
          contract,
          pendingQuestion: {
            question: `To do that, Sidequest would have to change ${conflicts.map((lock) => lock.label).join(' and ')}, which you asked to keep. Which would you rather?`,
            options: ['Keep it and do the rest of the change', `Change ${conflicts[0]!.label} after all`],
            because: 'One of these has to give, and only you can say which.',
          },
        };
      }
      /*
       * V6 — THE PROPOSAL SAYS WHAT WILL ACTUALLY HAPPEN.
       *
       * The patch is applied to a clone here, under the contract, and the
       * preview shown to the traveller is that application's own account —
       * one line per operation that took, one per operation that did not and
       * why. Never the model's `changed` prose: a live proposal promised "Akan-ko
       * extended from 2 to 3 nights" while both stay operations were being
       * refused, and the traveller pressed Apply on a change that did not exist.
       * The apply node re-runs the same deterministic application on resume.
       */
      const booked = deps.loadBookings ? await deps.loadBookings(state.tripId) : undefined;
      const preview = applyTripPatch({ draft, patch: patch.data, locked: contract.preserve, travellerLocked: state.locks.map((lock) => `${lock.kind}:${lock.ref}`), booked });
      if (preview.applied.length === 0) {
        return { intent: intent.data, status: 'rejected' as const, modelCallsThisAction: spent, blastRadius: radius, contract, refused: preview.refused.map((entry) => ({ ref: entry.ref, reason: entry.reason })), errors: ['Nothing in that change could be applied.'] };
      }
      const proposed: TripPatch = { ...patch.data, changed: [...preview.applied, ...preview.refused.map((entry) => `Not changed: ${describeRefusal(entry.reason)}`)].slice(0, 10) };
      /*
       * V6 §30 — a material change is proposed before it is applied. The
       * traveller sees the scope and the changes and presses Apply or Cancel;
       * the resume goes to `apply` with the patch already in state, so the
       * confirmation costs no model call.
       */
      if (deps.confirmMaterialChanges && changeIsMaterial(radius, intent.data) && !state.confirm) {
        return {
          intent: intent.data,
          status: 'awaiting_answer' as const,
          modelCallsThisAction: spent,
          blastRadius: radius,
          contract,
          proposedPatch: proposed,
          confirm: 'pending' as const,
          pendingQuestion: {
            question: `${describeScope(radius, draft)} Apply it?`,
            options: ['Apply', 'Cancel'],
            because: 'A change this size is worth a look before it lands. Cancel leaves the trip exactly as it is.',
          },
        };
      }
      return { intent: intent.data, status: 'applying' as const, modelCallsThisAction: spent, blastRadius: radius, contract, proposedPatch: proposed };
    })

    /** V6 §30 — the traveller pressed Cancel on a proposal: nothing changes, and the trip says so. */
    .addNode('cancel', async () => ({
      status: 'done' as const,
      confirm: 'cancelled' as const,
      explanation: 'Nothing was changed. Your trip is exactly as it was.',
    }))

    /**
     * ASK — the human-in-the-loop interrupt (§42).
     *
     * `interrupt()` throws a `GraphInterrupt` after the checkpointer has stored
     * this state, so the run stops here with everything needed to resume. The
     * payload is plain JSON, and this node has **no side effects** — it must be
     * safe to re-enter on resume, because that is exactly what happens.
     */
    .addNode('ask', async (state) => {
      const answer = interrupt<ClarifyingQuestion, string>(state.pendingQuestion!);
      return { answer, status: 'proposing' as const, pendingQuestion: undefined };
    })

    /**
     * APPLY — deterministic, no model, no provider.
     *
     * The patch is applied to a clone; a refusal (a lock, a missing id, a full
     * day) is recorded rather than swallowed. `commit` mints the new version, and
     * it is given the base version so the write can be refused if the trip moved
     * underneath this refinement (§48).
     */
    .addNode('apply', async (state) => {
      const draft = await deps.loadDraft(state.tripId);
      const booked = deps.loadBookings ? await deps.loadBookings(state.tripId) : undefined;
      const application = applyTripPatch({ draft, patch: state.proposedPatch!, locked: state.contract?.preserve ?? [], travellerLocked: state.locks.map((lock) => `${lock.kind}:${lock.ref}`), booked });
      if (application.applied.length === 0) {
        return { status: 'rejected' as const, refused: application.refused.map((entry) => ({ ref: entry.ref, reason: entry.reason })), errors: ['Nothing in that change could be applied.'] };
      }
      try {
        const version = await deps.commit({ tripId: state.tripId, draft: application.draft, patch: state.proposedPatch!, applied: application.applied, baseVersion: state.canonicalTripVersion });
        return {
          status: 'verifying' as const,
          applied: application.applied,
          refused: application.refused.map((entry) => ({ ref: entry.ref, reason: entry.reason })),
          canonicalTripVersion: version,
        };
      } catch (error) {
        /* §49 — a failed commit leaves the canonical trip exactly as it was. */
        return { status: 'failed' as const, errors: [error instanceof Error ? error.message : 'The change could not be saved.'] };
      }
    })

    /**
     * VERIFY — say what must be re-measured, and stop.
     *
     * §51: only the blast radius is rechecked. This node does not do the
     * rechecking, deliberately — a provider call inside a graph node is a call a
     * resume can repeat, and the verification seams already exist on the build
     * path with their own budget and deadline.
     */
    .addNode('verify', async (state) => ({ status: 'done' as const, verificationNeeded: state.contract?.recheck ?? [] }))

    .addEdge(START, 'interpret')
    .addConditionalEdges('interpret', (state) => {
      if (state.status === 'awaiting_answer') return 'ask';
      if (state.status === 'applying') return 'apply';
      return END;
    }, { ask: 'ask', apply: 'apply', [END]: END })
    /*
     * The one cycle in the graph, and it is bounded by the call ceiling rather
     * than by trust: `interpret` refuses at `MAX_REFINEMENT_MODEL_CALLS`, and the
     * answered path arrives having already spent one.
     */
    .addConditionalEdges(
      'ask',
      (state) => {
        /* A proposal answered goes straight to apply or to cancel — never back through the model. */
        if (state.confirm === 'pending' && state.proposedPatch) return /^\s*apply/i.test(state.answer ?? '') ? 'apply' : 'cancel';
        return 'interpret';
      },
      { interpret: 'interpret', apply: 'apply', cancel: 'cancel' },
    )
    .addEdge('cancel', END)
    .addConditionalEdges('apply', (state) => (state.status === 'verifying' ? 'verify' : END), { verify: 'verify', [END]: END })
    .addEdge('verify', END);

  return graph.compile({ checkpointer: deps.checkpointer });
}

/**
 * Resume an interrupted refinement with the traveller's answer.
 *
 * Typed as the state's own update shape rather than as a bare `Command`, so a
 * caller cannot pass a resume for one graph into another and find out at
 * runtime. The `resume` value is deliberately a plain string: an interrupt
 * payload has to be JSON-serialisable to survive the checkpointer (§42), and a
 * richer type here would be an invitation to put something in it that does not.
 */
export function resumeWith(answer: string): CommandInstance<string, RefinementGraphUpdate, RefinementNode> {
  return new Command<string, RefinementGraphUpdate, RefinementNode>({ resume: answer });
}

/** The update shape the graph's channels accept, which is what `invoke` wants a Command to carry. */
export type RefinementGraphUpdate = (typeof RefinementAnnotation)['Update'];
/** The graph's own node names. Typed so a resume for one graph cannot be passed to another. */
export type RefinementNode = 'interpret' | 'ask' | 'apply' | 'verify';
