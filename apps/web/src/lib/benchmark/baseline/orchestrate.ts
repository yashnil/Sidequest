import 'server-only';
import {
  BENCHMARK_REQUEST_VERSION,
  operationKey,
  stableHash,
  type BenchReport,
  type BenchmarkPlan,
  type BenchmarkTripRequest,
  type RunMetrics,
} from '@sidequest/bench';
import { DEFAULT_MODEL, ResearchModel } from '../../providers/anthropic';
import type { StructuredModel } from '../../providers/interpretation-model';
import {
  awaitBenchmarkOperation,
  claimBenchmarkOperation,
  heartbeatBenchmarkOperation,
  settleBenchmarkOperation,
} from '../../db/benchmark-operations-repository';
import { failedPlan, toBenchmarkPlan } from './convert';
import {
  deterministicFollowUps,
  needsSynthesisCall,
  synthesiseFollowUpQuestions,
  type FollowUpQuestion,
} from './followups';
import { gatherPacketInputs, type GatherCounters } from './gather';
import {
  BASELINE_OUTPUT_SCHEMA_VERSION,
  generateBaselinePlan,
  type BaselineGeneration,
  type GenerationRetry,
} from './generate';
import { gateSpend } from '../budget';
import { resolveDestinationIdentity } from './identity';
import { BaselineLedger } from './ledger';
import { baselineCapabilities } from './mode';
import { buildResearchPacket, type PacketInputs } from './packet';
import type { ResearchPacket } from './packet-types';
import { BASELINE_PROMPT_VERSIONS } from './prompts';
import { repairBaselinePlan, repairableFindings } from './repair';
import { runPreliminaryScan, type PreliminaryScan } from './scan';
import { RunTimeline, type MonotonicClock } from './timing';

/**
 * THE BASELINE RUN, END TO END, WITH THE BUDGET ENFORCED TWICE.
 *
 * `shared request → destination identity → deterministic preliminary scan →
 *  follow-up questions → research packet → one structured generation call →
 *  neutral validation → at most one repair → final or partial plan.`
 *
 * ---
 *
 * THE CALL BUDGET, AND WHY IT IS NOT A MATTER OF DISCIPLINE.
 *
 * Three calls, maximum, ever: zero-or-one follow-up synthesis, one generation
 * plus at most one re-ask of it when the answer comes back unreadable, and
 * zero-or-one repair. They share the same three, so a run cannot have both a
 * re-ask and a repair once the optional first call has been made. Two
 * independent mechanisms enforce the ceiling and neither is a comment:
 *
 * 1. **One model instance per run, constructed with whatever is left of the
 *    three.** Every stage receives that same instance. `ResearchModel.structured`
 *    refuses once `callsRemaining` reaches zero, and it counts *attempts* rather
 *    than successes — so a malformed answer, a rate limit and an outage each
 *    consume a call, which is correct, because each of them was billed.
 *
 *    "Whatever is left" rather than three, because the question round is a
 *    separate invocation with its own instance. Two fences each holding three
 *    permit four between them, and this one is built from
 *    `BASELINE_MAX_MODEL_CALLS - modelCallsAlreadySpent`.
 * 2. **The orchestrator's own counter**, checked before each stage. It exists
 *    because the fence in (1) is structural and this one is legible: a reader
 *    can see from this file alone that there is no loop, no retry and no second
 *    repair, without having to reason about a class's internal state.
 *
 * A repair whose own output is unusable returns the plan as `partial`. There is
 * no third attempt and no path that could produce one — the repair is called
 * from exactly one place, outside any loop, and its result is converted or
 * discarded rather than re-examined. That is the difference between a bounded
 * fallback and an unbounded bill.
 *
 * ---
 *
 * SINGLE FLIGHT, AND WHY THE LEASE NEEDS A PULSE.
 *
 * Two tabs, a retried POST or a doubled harness invocation would otherwise run
 * two generations for one comparison and bill for both. The claim is durable and
 * keyed on everything that could change the answer — including the session, so
 * one session's result can never be handed to another. The default lease is
 * three minutes and one generation call is allowed four, so the run heartbeats
 * while it waits: without that, a slow but healthy call would have its own claim
 * expired underneath it and a second attempt would start beside it.
 */

export const BASELINE_MAX_MODEL_CALLS = 3;

/**
 * How many times a plan may be *asked for*. Two: the ask, and one re-ask.
 *
 * Separate from the repair, and not an addition to the budget — both draw from
 * the same three calls, so a run that re-asks has spent the repair and a run
 * that repairs never re-asked. What it buys is the case that used to end a run
 * with an empty plan and two calls unspent: a truncated or unparseable answer,
 * which is a fault in one response rather than evidence that a second would fail
 * the same way.
 */
export const MAX_GENERATION_ATTEMPTS = 2;

export const BASELINE_OPERATION_KIND = 'baseline-plan';
const HEARTBEAT_INTERVAL_MS = 45_000;

export interface FollowUpAnswer {
  question: string;
  answer: string;
}

export interface BaselineRunInput {
  sessionId: string;
  request: BenchmarkTripRequest;
  runId?: string | null;
  planId?: string;
  locale?: string;
  now?: Date;
  clock?: MonotonicClock;
  owner?: string;
  /**
   * World data the caller already holds.
   *
   * Required in fixture mode, where nothing may leave the process. Supplying it
   * in live mode is legal and is what the offline suite does to exercise the
   * full flow without a socket.
   */
  fixture?: {
    inputs: PacketInputs;
    /** A canned generation, for a fixture run that must produce a plan. */
    generation?: BaselineGeneration;
  } | null;
  /**
   * Where the supplied world came from, when one is supplied.
   *
   * Stated by the caller rather than guessed from the presence of `fixture`,
   * because the harness hands this arm a world in two very different situations
   * — a synthetic one offline, and a real one it bought a moment earlier during
   * the question round — and reporting warmth means telling them apart.
   */
  worldOrigin?: WorldWarmth;
  /**
   * What the traveller answered to the follow-up questions this arm asked.
   *
   * These reach the generation prompt and the operation identity. See the note
   * on `inputHash` for why the identity has to move with them.
   */
  followUpAnswers?: readonly FollowUpAnswer[];
  /**
   * Questions already derived and asked, so this stage is not run twice.
   *
   * Supplied by the harness in the two-phase flow: the questions were derived,
   * persisted and put to the traveller before this call, and re-deriving them
   * here would either ask a second time or spend a second optional model call.
   */
  askedQuestions?: readonly FollowUpQuestion[];
  /** Model calls already spent on this run's behalf, counted against the three. */
  modelCallsAlreadySpent?: number;
  /**
   * The shared neutral validators, injected as a port.
   *
   * A port rather than an import, because the validators are the shared
   * instrument both arms are measured with and this arm must not be able to
   * reach past them into anything else. When it is absent the run still
   * completes; the plan is simply unvalidated and says so.
   */
  validate?: (plan: BenchmarkPlan) => BenchReport | null;
  /** Injected so the offline suite can count calls without a credential. */
  createModel?: () => StructuredModel;
  gather?: typeof gatherPacketInputs;
}

export interface BaselineOutcome {
  plan: BenchmarkPlan;
  metrics: RunMetrics;
  report: BenchReport | null;
  questions: readonly FollowUpQuestion[];
  packet: ResearchPacket | null;
  scan: PreliminaryScan | null;
  /** The model output as produced, kept for the post-reveal diagnostics view. */
  native: BaselineGeneration | null;
  modelCalls: number;
  repairCalls: number;
  singleFlight: 'won' | 'lost' | 'settled' | 'exhausted' | 'unavailable';
}

export async function runBaseline(input: BaselineRunInput): Promise<BaselineOutcome> {
  const now = input.now ?? new Date();
  const timeline = new RunTimeline(input.clock);
  const capabilities = baselineCapabilities();
  const locale = input.locale ?? 'en';
  const model = process.env.ANTHROPIC_MODEL?.trim() || DEFAULT_MODEL;
  const dates = resolveTripDates(input.request, now);
  const planId = input.planId ?? `baseline:${input.sessionId}`;

  const confirmedAnswers = normaliseAnswers(input.followUpAnswers ?? []);

  const key = operationKey({
    sessionId: input.sessionId,
    requestVersion: BENCHMARK_REQUEST_VERSION,
    /*
     * THE ANSWERS ARE PART OF THE INPUT, SO THEY ARE PART OF ITS HASH.
     *
     * The identity used to be `stableHash(request)` alone, from before the
     * traveller could answer anything. Once confirmed follow-up answers reach
     * the generation prompt that is a different input producing a different
     * plan, and an identity blind to them would let the single-flight claim
     * report the *unanswered* run as already settled and hand its plan back for
     * an answered one — the answers silently discarded, with a stored plan that
     * looks like it used them.
     */
    inputHash: stableHash({ request: input.request, followUpAnswers: confirmedAnswers }),
    promptVersion: BASELINE_PROMPT_VERSIONS.generatePlan,
    schemaVersion: BASELINE_OUTPUT_SCHEMA_VERSION,
    model,
    locale,
    operation: BASELINE_OPERATION_KIND,
  });

  const claim = claim_(input, key, now);
  if (claim.kind !== 'won') {
    if (claim.kind === 'lost') {
      // Wait for the holder rather than starting a second generation beside it.
      // The loser reports the wait honestly; it does not fabricate the winner's
      // plan, because it never saw one.
      await awaitBenchmarkOperation({ operationKey: key, timeoutMs: 5_000 });
    }
    timeline.finish();
    return terminal({
      planId,
      timeline,
      request: input.request,
      dates,
      failureKind: claim.kind === 'exhausted' ? 'budget_exhausted' : 'cancelled',
      detail: CLAIM_DETAIL[claim.kind],
      singleFlight: claim.kind,
      destinationName: input.request.destination.text,
    });
  }

  const operationId = claim.id;
  const heartbeat = startHeartbeat(operationId);

  /**
   * The orchestrator's own counter. See the header: two mechanisms, neither of
   * which is a promise.
   */
  /*
   * Seeded with whatever the question round already spent on this run's behalf.
   *
   * In the two-phase flow the one optional synthesis call happens before this
   * function is entered, and a counter that started at zero here would let the
   * run make three more — four in total, past the contract's ceiling.
   */
  let modelCalls = Math.max(0, Math.trunc(input.modelCallsAlreadySpent ?? 0));
  let repairCalls = 0;
  /**
   * Two ceilings, and both have to permit the call.
   *
   * The call count is this arm's contract — three, ever. The money ceiling is the
   * pilot's, read from the ledger so a restart and a second process count against
   * the same total. Only the first of these used to be checked: `maySpend`
   * existed, was correct, and had no callers, so a run could spend past a limit
   * the founder guide states is enforced before every call.
   *
   * Skipped when the caller injected its own model, which is the offline suite:
   * there is nothing to spend, and asking would make every test depend on an
   * environment variable.
   */
  const spend = (operation: 'generation' | 'repair'): boolean => {
    if (modelCalls >= BASELINE_MAX_MODEL_CALLS) return false;
    if (!input.createModel && gateSpend(operation).kind === 'refused') return false;
    modelCalls += 1;
    return true;
  };

  const counters: GatherCounters = {
    providerCalls: 0,
    routeCalls: 0,
    routePairs: 0,
    weatherCalls: 0,
  };

  let fence: StructuredModel | null = null;
  let ledger: BaselineLedger | null = null;
  let worldWarmth: WorldWarmth = 'none';

  try {
    /* ---------- Destination identity. No model call, by construction. ------ */
    const identity = await resolveDestinationIdentity({
      text: input.request.destination.text,
      identity: input.request.destination.identity,
      geocoderPermitted: capabilities.providersPermitted && !input.fixture,
    });
    counters.providerCalls += identity.providerCalls;
    if (!identity.ok) {
      timeline.finish();
      return terminal({
        planId,
        timeline,
        request: input.request,
        dates,
        failureKind: identity.failureKind,
        detail: identity.detail,
        singleFlight: 'won',
        destinationName: input.request.destination.text,
        counters,
        worldWarmth,
        settle: { operationId, now, state: 'failed_terminal' },
      });
    }

    /* ---------- The world, bought once or supplied. ------------------------ */
    let packetInputs: PacketInputs;
    if (input.fixture) {
      packetInputs = { ...input.fixture.inputs, destination: identity.destination };
      worldWarmth = input.worldOrigin ?? 'fixture';
    } else if (!capabilities.providersPermitted) {
      timeline.finish();
      return terminal({
        planId,
        timeline,
        request: input.request,
        dates,
        failureKind: 'insufficient_data',
        detail: `${capabilities.reason} No world data was supplied, so nothing could be planned.`,
        singleFlight: 'won',
        destinationName: identity.destination.displayName,
        counters,
        worldWarmth,
        settle: { operationId, now, state: 'failed_terminal' },
      });
    } else {
      const gathered = await (input.gather ?? gatherPacketInputs)({
        request: input.request,
        destination: identity.destination,
        dates: dates.all,
        now,
        sessionId: input.sessionId,
      });
      packetInputs = gathered.inputs;
      worldWarmth = 'purchased';
      counters.providerCalls += gathered.counters.providerCalls;
      counters.routeCalls += gathered.counters.routeCalls;
      counters.routePairs += gathered.counters.routePairs;
      counters.weatherCalls += gathered.counters.weatherCalls;
    }

    const packet = buildResearchPacket(packetInputs);
    const scan = runPreliminaryScan({ request: input.request, packet });
    if (packet.places.length > 0) timeline.mark('timeToFirstUsefulResultMs');

    /* ---------- Follow-up questions. Zero or one call. --------------------- */
    if (capabilities.modelPermitted || input.createModel) {
      /*
       * THE FENCE KNOWS WHAT THE QUESTION ROUND ALREADY SPENT.
       *
       * Lifting the round out of this function created a second `ResearchModel`,
       * and two instances each holding `maxCalls: 3` permit four calls between
       * them. The contract's ceiling then rested on the orchestrator's counter
       * alone — the enforcement the contract itself calls "a promise", as against
       * the structural one it calls "a property".
       *
       * Constructing this one with what is *left* restores the property: a run
       * whose questions cost a call gets a fence of two, and a fourth call is
       * refused by the client rather than by anybody remembering to check.
       */
      fence = (input.createModel ?? (() => createBaselineModel(BASELINE_MAX_MODEL_CALLS - modelCalls)))();
      ledger = new BaselineLedger(
        {
          sessionId: input.sessionId,
          runId: input.runId ?? null,
          operationKey: key,
          model,
          provider: 'anthropic',
        },
        fence,
      );
    }

    /*
     * The rules run first and cost nothing. The one optional call happens only
     * when they produced too little to be worth interrupting somebody for — and
     * it is claimed from the budget before it is made, so the generation below
     * can never be crowded out by a stage that is meant to be optional.
     */
    const alreadyAsked = input.askedQuestions ?? null;
    const deterministic = alreadyAsked ?? deterministicFollowUps({ request: input.request, packet, scan });
    let followUps: { questions: readonly FollowUpQuestion[]; modelFailure: string | null } = {
      questions: deterministic,
      modelFailure: null,
    };
    if (
      alreadyAsked === null &&
      needsSynthesisCall(deterministic) &&
      fence &&
      ledger &&
      capabilities.mode === 'live' &&
      modelCalls + 1 < BASELINE_MAX_MODEL_CALLS &&
      spend('generation')
    ) {
      const boundFence = fence;
      followUps = await ledger.around(
        {
          operation: 'follow-up-questions',
          promptVersion: BASELINE_PROMPT_VERSIONS.followUpQuestions,
          attempt: 1,
        },
        () =>
          synthesiseFollowUpQuestions({
            request: input.request,
            packet,
            model: boundFence,
            deterministic,
          }),
        (result) => result.modelFailure,
      );
    }
    /*
     * The questions are not this arm's to time any more.
     *
     * In the two-phase flow they were derived, persisted and answered before this
     * function was entered, and `askedQuestions` hands them straight back. Marking
     * the boundary here timed re-echoing a list — a hundred and eighty
     * milliseconds against the other arm's twenty seconds of genuinely deriving
     * one, which reads as a hundredfold advantage and measures nothing. The
     * harness stamps it from the session clock, where the round actually
     * happened; see `timeToFollowUpQuestionsMs` in the orchestrator.
     */
    if (followUps.questions.length > 0) {
      timeline.mark('timeToFirstUsefulResultMs');
      if (alreadyAsked === null) timeline.mark('timeToFollowUpQuestionsMs');
    }

    /* ---------- One generation call. -------------------------------------- */
    let generation: BaselineGeneration | null = input.fixture?.generation ?? null;
    let generationFailure: { kind: BenchmarkPlan['failureKind']; detail: string } | null = null;

    if (generation === null) {
      if (capabilities.mode !== 'live' || !fence || !ledger) {
        timeline.finish();
        return terminal({
          planId,
          timeline,
          request: input.request,
          dates,
          failureKind: 'model_unavailable',
          detail: capabilities.reason,
          singleFlight: 'won',
          destinationName: identity.destination.displayName,
          counters,
          packet,
          scan,
          questions: followUps.questions,
          worldWarmth,
          settle: { operationId, now, state: 'failed_terminal' },
        });
      }
      if (!spend('generation')) {
        timeline.finish();
        return terminal({
          planId,
          timeline,
          request: input.request,
          dates,
          failureKind: 'budget_exhausted',
          detail: 'The optional preliminary call left nothing for the plan itself.',
          singleFlight: 'won',
          destinationName: identity.destination.displayName,
          counters,
          packet,
          scan,
          questions: followUps.questions,
          worldWarmth,
          settle: { operationId, now, state: 'failed_terminal' },
        });
      }

      /*
       * ONE GENERATION, AND ONE RE-ASK WHEN THE ANSWER WAS UNREADABLE.
       *
       * Bounded by `MAX_GENERATION_ATTEMPTS` rather than by a condition, so the
       * ceiling is legible from the loop header. Only an unusable *answer*
       * qualifies: a rate limit, an outage or a timeout ends the run here, and
       * asking again for those would be spending a second call to learn what the
       * first one already established.
       *
       * A truncated answer — the ceiling reached mid-plan, which arrives from
       * the client as the same unusable output — is the common shape of this,
       * and the retry says so rather than repeating the request verbatim. It is
       * still a *generation*: `repairCalls` does not move, the repair below is
       * still allowed exactly once, and the three-call budget is what stops the
       * two from ever both happening after an optional follow-up call.
       */
      let outcome = await ledger.around(
        {
          operation: 'generate-plan',
          promptVersion: BASELINE_PROMPT_VERSIONS.generatePlan,
          attempt: 1,
        },
        () =>
          generateBaselinePlan({
            model: fence as StructuredModel,
            request: input.request,
            packet,
            scan,
            followUpAnswers: confirmedAnswers,
          }),
        (result) => (result.ok ? null : result.failureKind),
      );

      for (let attempt = 2; attempt <= MAX_GENERATION_ATTEMPTS; attempt += 1) {
        if (outcome.ok || outcome.failureKind !== 'malformed_output') break;
        const retry: GenerationRetry = outcome.truncated === true ? 'truncated' : 'malformed';
        if (!spend('generation')) break;
        outcome = await ledger.around(
          {
            operation: 'generate-plan',
            promptVersion: BASELINE_PROMPT_VERSIONS.generatePlan,
            attempt,
          },
          () =>
            generateBaselinePlan({
              model: fence as StructuredModel,
              request: input.request,
              packet,
              scan,
              followUpAnswers: confirmedAnswers,
              retry,
            }),
          (result) => (result.ok ? null : result.failureKind),
        );
      }

      if (outcome.ok) generation = outcome.output;
      else generationFailure = { kind: outcome.failureKind, detail: outcome.detail };
    }

    if (generation === null) {
      timeline.finish();
      return terminal({
        planId,
        timeline,
        request: input.request,
        dates,
        failureKind: generationFailure?.kind ?? 'internal_error',
        detail: generationFailure?.detail ?? 'No plan was produced and no reason was recorded.',
        singleFlight: 'won',
        destinationName: identity.destination.displayName,
        counters,
        packet,
        scan,
        questions: followUps.questions,
        modelCalls,
        ledger,
        worldWarmth,
        settle: { operationId, now, state: 'failed_terminal' },
      });
    }

    let converted = toBenchmarkPlan({
      planId,
      requestId: input.request.requestId,
      output: generation,
      packet,
      startDate: dates.startDate,
      endDate: dates.endDate,
      generationState: 'complete',
      failureKind: null,
      failureDetail: null,
      extraUnknowns: dates.unknowns,
    });
    if (converted.plan.days.length > 0) timeline.mark('timeToFirstItineraryMs');

    /* ---------- Neutral validation, then at most one repair. -------------- */
    let report = input.validate ? input.validate(converted.plan) : null;
    let state: 'complete' | 'partial' = 'complete';
    const warnings: string[] = [];

    const defects = report ? repairableFindings(report.findings) : [];
    if (defects.length > 0) {
      if (fence && ledger && capabilities.mode === 'live' && spend('repair')) {
        repairCalls += 1;
        const repaired = await ledger.around(
          {
            operation: 'repair-plan',
            promptVersion: BASELINE_PROMPT_VERSIONS.repairPlan,
            attempt: 1,
          },
          () =>
            repairBaselinePlan({
              model: fence as StructuredModel,
              plan: generation as BaselineGeneration,
              findings: report?.findings ?? [],
              packet,
            }),
          (result) => (result.ok ? null : result.failureKind),
        );

        if (repaired.ok) {
          generation = repaired.output;
          converted = toBenchmarkPlan({
            planId,
            requestId: input.request.requestId,
            output: repaired.output,
            packet,
            startDate: dates.startDate,
            endDate: dates.endDate,
            generationState: 'complete',
            failureKind: null,
            failureDetail: null,
            extraUnknowns: dates.unknowns,
          });
          report = input.validate ? input.validate(converted.plan) : null;
          const remaining = report ? repairableFindings(report.findings) : [];
          if (remaining.length > 0) {
            /*
             * The bounded end of the road. A second repair is not attempted and
             * cannot be: this branch has no loop and the budget has nothing in
             * it. The plan is returned as partial with the residue named, which
             * is a result the benchmark can count rather than a failure it would
             * have to hide.
             */
            state = 'partial';
            warnings.push(
              `${remaining.length} problem(s) remained after the single correction attempt, and are listed in the checker's findings.`,
            );
          }
        } else {
          state = 'partial';
          warnings.push(
            'A correction was attempted and did not produce a usable plan, so the original stands with its problems intact.',
          );
        }
      } else {
        state = 'partial';
        warnings.push(
          `${defects.length} problem(s) were found and no correction attempt was available.`,
        );
      }
    }
    timeline.mark('timeToValidatedPlanMs');

    if (state === 'partial' || warnings.length > 0) {
      converted = toBenchmarkPlan({
        planId,
        requestId: input.request.requestId,
        output: generation,
        packet,
        startDate: dates.startDate,
        endDate: dates.endDate,
        generationState: state,
        failureKind: null,
        failureDetail: null,
        extraWarnings: warnings,
        extraUnknowns: dates.unknowns,
      });
    }

    timeline.finish();
    /*
     * A partial plan settles as `succeeded`.
     *
     * The operation is the *run*, and a run that produced a plan with named
     * residual problems did what it was asked to do. Recording it as failed
     * would let a retry start a second generation for the same identity, which
     * is the one thing the single-flight claim exists to prevent.
     */
    settle(operationId, now, 'succeeded', planId);

    return {
      plan: converted.plan,
      metrics: metricsFor({
        timeline,
        input,
        modelCalls,
        repairCalls,
        ledger,
        counters,
        failed: false,
        warmth: worldWarmth,
      }),
      report,
      questions: followUps.questions,
      packet,
      scan,
      native: generation,
      modelCalls,
      repairCalls,
      singleFlight: 'won',
    };
  } catch (error) {
    /*
     * An unexpected fault is still a result.
     *
     * Nothing above is supposed to throw — every stage returns an outcome — so
     * reaching here means a defect rather than a provider having a bad day. It
     * is recorded as one, with a neutral sentence that names no provider and no
     * model, because the reviewer's screen must not be able to tell the two arms
     * apart by their error text.
     */
    console.error('The baseline run faulted', {
      sessionId: input.sessionId,
      error: error instanceof Error ? error.name : 'unknown',
    });
    timeline.finish();
    return terminal({
      planId,
      timeline,
      request: input.request,
      dates,
      failureKind: 'internal_error',
      detail: 'The run stopped before it could produce a plan.',
      singleFlight: 'won',
      destinationName: input.request.destination.text,
      counters,
      modelCalls,
      ledger,
      settle: { operationId, now, state: 'failed_retryable' },
    });
  } finally {
    clearInterval(heartbeat);
  }
}

/**
 * The confirmed answers, in one order and with the empty ones dropped.
 *
 * Ordered and trimmed before hashing so that the identity is a function of what
 * was answered rather than of the sequence a browser happened to post it in — a
 * hash that moved when nothing did would defeat the single-flight claim on every
 * refresh, which is the opposite of the failure the hash was widened to prevent.
 */
export function normaliseAnswers(
  answers: readonly FollowUpAnswer[],
): { question: string; answer: string }[] {
  return answers
    .map((entry) => ({ question: entry.question.trim(), answer: entry.answer.trim() }))
    .filter((entry) => entry.question.length > 0 && entry.answer.length > 0)
    .sort((left, right) => (left.question < right.question ? -1 : left.question > right.question ? 1 : 0));
}

/** The real fence, budgeted at three calls and constructed exactly once. */
export function createBaselineModel(
  /** What is left of the three, after whatever the question round spent. */
  maxCalls: number = BASELINE_MAX_MODEL_CALLS,
): StructuredModel {
  /*
   * No SDK-level retries, because this arm keeps a ledger.
   *
   * The client retries twice by default, which is right for a compilation — a
   * transient 5xx costs a retry rather than a whole build. It is wrong here: an
   * SDK retry never reaches `usage.calls`, so a request billed three times is
   * recorded once, the spend total under-reports, and the budget ceiling reads
   * low by however much the provider happened to fail. A benchmark that reports
   * cost cannot have a number that is quietly smaller than the bill.
   *
   * The re-ask on malformed output is this arm's own, is counted, and comes out
   * of the same three-call budget.
   */
  return new ResearchModel({ maxCalls: Math.max(0, maxCalls), maxRetries: 0 });
}

/* ------------------------------------------------------------------ *
 * Single flight
 * ------------------------------------------------------------------ */

const CLAIM_DETAIL: Record<'lost' | 'settled' | 'exhausted' | 'unavailable', string> = {
  lost: 'Another run of this identical request is already in flight.',
  settled: 'This request has already been run to a terminal state.',
  exhausted: 'This request has used every attempt it is allowed.',
  unavailable: 'The benchmark store could not be reached, so no run was started.',
};

type Claimed =
  | { kind: 'won'; id: string }
  | { kind: 'lost' }
  | { kind: 'settled' }
  | { kind: 'exhausted' }
  | { kind: 'unavailable' };

function claim_(input: BaselineRunInput, key: string, now: Date): Claimed {
  try {
    const claim = claimBenchmarkOperation({
      sessionId: input.sessionId,
      kind: BASELINE_OPERATION_KIND,
      operationKey: key,
      owner: input.owner ?? 'baseline',
      now,
    });
    return claim.kind === 'won' ? { kind: 'won', id: claim.operation.id } : { kind: claim.kind };
  } catch (error) {
    console.error('Could not claim a benchmark operation', {
      sessionId: input.sessionId,
      error: error instanceof Error ? error.name : 'unknown',
    });
    return { kind: 'unavailable' };
  }
}

/**
 * A pulse while the long call runs.
 *
 * `unref` so a stray timer cannot hold a process open — a test runner that hung
 * for forty-five seconds after its assertions passed would be blamed on the
 * suite rather than on the timer, which is how these survive for months.
 */
function startHeartbeat(operationId: string): ReturnType<typeof setInterval> {
  const timer = setInterval(() => {
    try {
      heartbeatBenchmarkOperation(operationId, new Date());
    } catch {
      // A missed pulse expires the lease, which the claim path already handles
      // as a normal outcome. It is not worth failing a run over.
    }
  }, HEARTBEAT_INTERVAL_MS);
  timer.unref?.();
  return timer;
}

function settle(
  operationId: string,
  now: Date,
  state: 'succeeded' | 'failed_terminal' | 'failed_retryable',
  resultRef: string | null,
  detail?: string,
): void {
  try {
    settleBenchmarkOperation({
      id: operationId,
      state,
      now,
      resultRef,
      failureKind: state === 'succeeded' ? null : state,
      detail: detail ?? null,
    });
  } catch (error) {
    console.error('Could not settle a benchmark operation', {
      operationId,
      error: error instanceof Error ? error.name : 'unknown',
    });
  }
}

/* ------------------------------------------------------------------ *
 * Terminal states
 * ------------------------------------------------------------------ */

interface TerminalInput {
  planId: string;
  timeline: RunTimeline;
  request: BenchmarkTripRequest;
  dates: TripDates;
  failureKind: NonNullable<BenchmarkPlan['failureKind']>;
  detail: string;
  singleFlight: BaselineOutcome['singleFlight'];
  destinationName: string;
  counters?: GatherCounters;
  packet?: ResearchPacket | null;
  scan?: PreliminaryScan | null;
  questions?: readonly FollowUpQuestion[];
  modelCalls?: number;
  ledger?: BaselineLedger | null;
  worldWarmth?: WorldWarmth;
  settle?: {
    operationId: string;
    now: Date;
    state: 'failed_terminal' | 'failed_retryable';
  };
}

function terminal(input: TerminalInput): BaselineOutcome {
  if (input.settle) {
    settle(input.settle.operationId, input.settle.now, input.settle.state, null, input.detail);
  }
  return {
    plan: failedPlan({
      planId: input.planId,
      requestId: input.request.requestId,
      destination: {
        entityId: input.packet?.destination.entityId ?? null,
        name: input.destinationName,
        latitude: input.packet?.destination.latitude ?? null,
        longitude: input.packet?.destination.longitude ?? null,
      },
      startDate: input.dates.startDate,
      endDate: input.dates.endDate,
      failureKind: input.failureKind,
      failureDetail: input.detail,
      unknowns: [...input.dates.unknowns, ...(input.packet?.unknowns ?? [])],
    }),
    metrics: metricsFor({
      timeline: input.timeline,
      input: { sessionId: '', request: input.request },
      modelCalls: input.modelCalls ?? 0,
      repairCalls: 0,
      ledger: input.ledger ?? null,
      counters: input.counters ?? null,
      failed: true,
      warmth: input.worldWarmth ?? 'none',
    }),
    report: null,
    questions: input.questions ?? [],
    packet: input.packet ?? null,
    scan: input.scan ?? null,
    native: null,
    modelCalls: input.modelCalls ?? 0,
    repairCalls: 0,
    singleFlight: input.singleFlight,
  };
}

function metricsFor(input: {
  timeline: RunTimeline;
  input: { sessionId: string; request: BenchmarkTripRequest };
  modelCalls: number;
  repairCalls: number;
  ledger: BaselineLedger | null;
  counters: GatherCounters | null;
  failed: boolean;
  warmth: WorldWarmth;
}): RunMetrics {
  const totals = input.ledger?.totals ?? null;
  return input.timeline.toRunMetrics({
    runId: `baseline:${input.input.request.requestId}`,
    failed: input.failed,
    modelCalls: input.modelCalls,
    repairCalls: input.repairCalls,
    inputTokens: totals?.inputTokens ?? null,
    outputTokens: totals?.outputTokens ?? null,
    costMicroUsd: totals?.costMicroUsd ?? null,
    unpricedCalls: totals?.unpricedCalls ?? 0,
    providerCalls: input.counters?.providerCalls ?? null,
    routeCalls: input.counters?.routeCalls ?? null,
    routePairs: input.counters?.routePairs ?? null,
    weatherCalls: input.counters?.weatherCalls ?? null,
    /*
     * OBSERVED, NOT ASSUMED — AND OBSERVED ABOUT THE RIGHT THING.
     *
     * This used to be an unconditional `unknown`, which is a default dressed as
     * a declaration and which meant every latency figure on the dashboard pooled
     * first runs with repeats.
     *
     * This arm holds no evidence cache of its own, so the only reuse it can
     * genuinely observe is whether the world it planned against was bought
     * during this session or handed to it from an earlier preparation of the
     * same session. That is what the harness tells it, and it is a fact rather
     * than an inference: a run that made the provider calls itself is cold, and
     * one that planned against a world already stored is warm.
     */
    ...WORLD_WARMTH[input.warmth],
  });
}

/** Where the world this run planned against came from. */
export type WorldWarmth = 'purchased' | 'reused' | 'fixture' | 'none';

/**
 * WARMTH HAS TO MEAN THE SAME THING ON BOTH ARMS, OR IT MEANS NOTHING.
 *
 * The other arm answers "did the shared store already hold this region when the
 * compilation started" — a genuine cold-or-warm distinction *across* sessions,
 * which is what makes a latency figure readable.
 *
 * This one briefly answered a different question: "was the world pre-bought
 * earlier in this same session". Since the harness always buys it in the question
 * round, the answer was always yes, so every ordinary live run reported `warm` —
 * and the same row simultaneously carried a world-purchase time saying the
 * provider calls *were* made, seconds earlier. Two incompatible definitions under
 * one field name, and a reader splitting latency on it would have been comparing
 * one arm cold against the other permanently warm.
 *
 * So a world bought during this session is `cold` whichever phase bought it,
 * which is the same sentence the other arm's classification means. Nothing here
 * observes reuse *across* sessions — this arm keeps no store between them — so
 * `warm` is unreachable and says so, rather than being handed out for the wrong
 * reason.
 */
const WORLD_WARMTH: Record<WorldWarmth, { warmth: RunMetrics['warmth']; warmthBasis: string }> = {
  purchased: {
    warmth: 'cold',
    warmthBasis: 'The world this run planned against was bought during this comparison.',
  },
  reused: {
    warmth: 'cold',
    warmthBasis:
      'The world this run planned against was bought during this comparison, in the question round rather than here. Nothing was held from an earlier session.',
  },
  fixture: {
    warmth: 'unknown',
    warmthBasis: 'A synthetic world was supplied, which is neither cold nor warm.',
  },
  none: {
    warmth: 'unknown',
    warmthBasis: 'The run stopped before any world was gathered, so there was nothing to reuse.',
  },
};

/* ------------------------------------------------------------------ *
 * Dates
 * ------------------------------------------------------------------ */

export interface TripDates {
  startDate: string;
  endDate: string;
  all: readonly string[];
  /** Said out loud when the dates were not the traveller's. */
  unknowns: readonly string[];
}

/**
 * The dates the plan is laid out on, and an honest note when they were assumed.
 *
 * A neutral plan must carry a start and an end, and a traveller with a
 * `month` or `undecided` request has given neither. Silently picking one and
 * presenting it as theirs would be the plan asserting something nobody said, so
 * the anchor is chosen deterministically, the day count comes from the nights
 * they *did* state, and the assumption is written into the plan's own unknowns
 * where a reviewer will see it.
 */
export function resolveTripDates(request: BenchmarkTripRequest, now: Date): TripDates {
  const unknowns: string[] = [];
  let start = request.dates.startDate;

  if (start === null) {
    if (request.dates.year !== null && request.dates.month !== null) {
      start = `${String(request.dates.year).padStart(4, '0')}-${String(request.dates.month).padStart(2, '0')}-01`;
      unknowns.push(
        'The traveller gave a month rather than dates, so the plan is laid out from the first of that month; the shape of the days is what matters, not the calendar.',
      );
    } else {
      const anchor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
      start = anchor.toISOString().slice(0, 10);
      unknowns.push(
        'The traveller gave no dates, so the plan is laid out from a placeholder start; the sequence of days is what matters, not the calendar.',
      );
    }
  }

  const days = Math.max(1, request.dates.nights + 1);
  const all: string[] = [];
  const startMs = Date.parse(`${start}T00:00:00.000Z`);
  for (let index = 0; index < days; index += 1) {
    all.push(new Date(startMs + index * 86_400_000).toISOString().slice(0, 10));
  }
  const endFromNights = all[all.length - 1] ?? start;

  return {
    startDate: start,
    /*
     * The stated end date wins where there is one, even if it disagrees with the
     * night count — the traveller said both, and re-deriving one from the other
     * would quietly correct them.
     */
    endDate: request.dates.endDate ?? endFromNights,
    all,
    unknowns,
  };
}
