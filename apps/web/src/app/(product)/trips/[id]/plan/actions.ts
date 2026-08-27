'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import {
  DESTINATION_RESOLUTION_VERSION,
  FEATURE_TYPE_BREADTH,
  FEATURE_TYPE_ENTITY,
  assessConfidence,
  candidateById,
  countNights,
  datesInWindow,
  MAX_TRIP_NIGHTS,
  nightsFrom,
  normalizeDestinationQuery,
  decideInterpretation,
  displayStages,
  isAbandoned,
  isTerminal,
  unansweredRequired,
  type ClarificationSet,
  type CompilationState,
  type DestinationCandidate,
  type DestinationResolution,
  type RemainingEstimate,
  type SelectedDestination,
  type StageRecord,
  type TripComposerAnswers,
  type TripPreflight,
} from '@sidequest/core';
import {
  deriveAdaptiveQuestions,
  deriveScope,
  QUESTION_IDS,
  rebuildClarificationSet,
  scopeFitsTrip,
  withAdaptiveQuestions,
} from '@sidequest/compiler';
import { capabilityRegistry } from '@/lib/capabilities';
import { compilerProviderChoice, compilerProviders, providerReadiness } from '@/lib/compiler/providers';
import { activeJobFor, startCompilation } from '@/lib/compiler/runner';
import { dispatchCompilation, pumpCompilationQueue } from '@/lib/compiler/queue';
import {
  getIntent,
  getLatestJob,
  queuePositionFor,
  reclaimAbandonedJob,
  requestCancel,
  saveClarifications,
  saveComposerAnswers,
  savePreflight,
  saveResolution,
  saveScope,
  saveSelectedCandidate,
  saveSelectedDestination,
} from '@/lib/db/compiler-repository';
import { compilationVerdict } from '@/lib/compiler/verdict';
import { callerKey, guardAction } from '@/lib/net/caller';
import { tripAccessRefusal } from '@/lib/net/trip-access';
import { reserveModelCalls } from '@/lib/compiler/daily-ceiling';
import { getProfile, getTrip, updateTripDates } from '@/lib/db/repository';
import { destinationDivisionIds } from '@/lib/destinations/identity';
import { runPreflight } from '@/lib/destinations/preflight';
import { getProvisionalBoard } from '@/lib/db/provisional-repository';
import { estimateRemainingForRun, runBucket } from '@/lib/db/timing-repository';

/**
 * The actions behind the open-world journey.
 *
 * Every one returns a discriminated result and never throws to the browser, and
 * every one writes before it returns — the durable artifact is the row, so a
 * closed laptop between two screens loses nothing.
 */

export interface ActionResult {
  ok: boolean;
  error?: string;
}

/**
 * REQUEST-SIZE BOUNDS ON WHAT THE BROWSER SENDS.
 *
 * Server actions deserialize whatever arrives, and every id here ends up in a
 * SQL parameter, a log line or a provider call. None of them has any business
 * being longer than the identifiers this codebase mints — a UUID, a resolver
 * candidate id, a strategy key — so anything larger is refused before it
 * touches storage. The message is deliberately generic: a bounds refusal is
 * for scripts, and a script does not need a diagnosis.
 */
const tripIdSchema = z.string().trim().min(1).max(64);
const candidateIdSchema = z.string().trim().min(1).max(256);
const strategyIdSchema = z.string().trim().max(64);
const clarificationAnswersSchema = z
  .array(
    z.object({
      questionId: z.string().trim().min(1).max(128),
      values: z.array(z.string().max(500)).max(24),
    }),
  )
  .max(64);

const MALFORMED_REQUEST: ActionResult = {
  ok: false,
  error: 'That request did not look right, so we did not run it.',
};

/**
 * The limiter, as one line per guarded action.
 *
 * Both the identities and the fences live in `lib/net/caller` and
 * `lib/net/rate-limit` now, rather than here. That move is the fix for a real
 * defect rather than tidying: the identity derivation this file used to own
 * read the *leftmost* `x-forwarded-for` element, which is by definition what
 * the client sent, so two header lines bought a virgin bucket. The shared
 * module refuses to derive an address it cannot stand behind and adds a fence
 * that takes no identity at all — and being shared is what let the
 * questionnaire's billed action be guarded by the same thing.
 */
async function rateGuard(kind: Parameters<typeof guardAction>[0]): Promise<string | null> {
  return guardAction(kind);
}

/**
 * Ask the resolver what the typed string might mean.
 *
 * Run once, on a button press, and stored — the geocoder's usage policy forbids
 * autocomplete, and re-resolving on every render would be the same abuse with
 * extra steps.
 */
export async function resolveDestinationAction(tripId: string): Promise<ActionResult> {
  if (!tripIdSchema.safeParse(tripId).success) return MALFORMED_REQUEST;
  const trip = getTrip(tripId);
  if (!trip) return { ok: false, error: 'We could not find that trip.' };
  /*
   * Ownership before anything is read or spent, on this and every action
   * below: the trip id is the owner's edit capability, never a share link.
   * The rule and its one internal-caller exemption live in
   * `lib/net/trip-access`.
   */
  const refusal = await tripAccessRefusal(tripId);
  if (refusal) return { ok: false, error: refusal };

  const intent = getIntent(tripId);
  const query = intent?.destinationQuery?.trim();
  if (!query) return { ok: false, error: 'Tell us where you are going first.' };

  const readiness = providerReadiness();
  if (!readiness.ready) return { ok: false, error: readiness.message };

  // After the free checks, before the geocoder round-trip: a refused request
  // must not have cost the provider anything to refuse.
  const limited = await rateGuard('destination_resolve');
  if (limited) return { ok: false, error: limited };

  /**
   * THE MODEL CALL HIDING INSIDE "LOOK UP A DESTINATION".
   *
   * `resolver.resolve` does not only geocode: on the open stack it also asks
   * the billed model whether the typed string is a place at all, once per
   * invocation and uncached. That spend was invisible to the daily ceiling,
   * which only ever counted what a *compilation* reported — so the one control
   * that bounds the aggregate bill was blind to an action any visitor can fire
   * on any trip. Booked here, before the call, because a reservation taken
   * afterwards is a ceiling discovered by crossing it.
   *
   * Only on the open stack: the fixture resolver reaches no model, and a gate
   * that refused a free lookup would be a cost control with no cost behind it.
   */
  if (compilerProviderChoice() === 'open') {
    const spend = reserveModelCalls(1, { caller: await callerKey() });
    if (!spend.allowed) return { ok: false, error: spend.message };
  }

  try {
    const { providers } = compilerProviders();
    const resolution = await providers.resolver.resolve({ query, now: new Date() });
    saveResolution(tripId, resolution);

    /**
     * One credible reading needs no screen.
     *
     * `decideInterpretation` rather than `isUnambiguous`, and that swap is the
     * whole fix for the screenshot journey. `isUnambiguous` requires the
     * ambiguity list to be *empty*, and a country always carries
     * `administrative_area_needs_subset` — so every country was "ambiguous",
     * every country got a which-one screen, and every one of those screens had
     * exactly one card on it.
     *
     * Breadth is not a question about *which* place was meant. It is a question
     * about how much of it, it has its own screen, and it comes later.
     */
    const decision = decideInterpretation(resolution);
    if (decision.kind === 'single') {
      saveSelectedCandidate(tripId, decision.candidate.id);
      saveSelectedDestination(tripId, selectedDestinationFrom(decision.candidate));
      const profile = getProfile(tripId);
      saveClarifications(
        tripId,
        rebuildClarificationSet({
          resolution,
          candidate: decision.candidate,
          nights: countNights(trip.basics.startDate, trip.basics.endDate),
          ...(profile ? { profile } : {}),
          known: knownFrom(intent?.composer ?? null),
        }),
      );
    }
  } catch (error) {
    console.error('Destination resolution failed', { tripId });
    return {
      ok: false,
      error:
        error instanceof Error && error.message.includes('slow down')
          ? 'Our map source asked us to slow down. Give it a moment and try again.'
          : 'We could not look that up just now. Nothing was lost — try again.',
    };
  }

  revalidatePath(`/trips/${tripId}/plan`);
  return { ok: true };
}

/**
 * Adopt an interpretation, and derive the clarification set from it.
 *
 * Clarification is derived rather than stored-and-forgotten: the same intent and
 * interpretation always produce the same questions, and answers whose questions
 * survive a re-derivation are kept.
 */
export async function selectInterpretationAction(
  tripId: string,
  candidateId: string,
): Promise<ActionResult> {
  if (
    !tripIdSchema.safeParse(tripId).success ||
    !candidateIdSchema.safeParse(candidateId).success
  ) {
    return MALFORMED_REQUEST;
  }
  const trip = getTrip(tripId);
  if (!trip) return { ok: false, error: 'We could not find that trip.' };
  const refusal = await tripAccessRefusal(tripId);
  if (refusal) return { ok: false, error: refusal };

  const intent = getIntent(tripId);
  if (!intent?.resolution) return { ok: false, error: 'We have not read that destination yet.' };

  const candidate = candidateById(intent.resolution, candidateId);
  if (!candidate) return { ok: false, error: 'That is not one of the readings we found.' };

  saveSelectedCandidate(tripId, candidateId);
  saveSelectedDestination(tripId, selectedDestinationFrom(candidate));

  const profile = getProfile(tripId);
  const rebuilt = rebuildClarificationSet(
    {
      resolution: intent.resolution,
      candidate,
      nights: countNights(trip.basics.startDate, trip.basics.endDate),
      ...(profile ? { profile } : {}),
      known: knownFrom(intent.composer),
    },
    intent.clarifications,
  );
  saveClarifications(tripId, rebuilt);

  revalidatePath(`/trips/${tripId}/plan`);
  return { ok: true };
}

export async function saveClarificationAnswersAction(
  tripId: string,
  answers: { questionId: string; values: string[] }[],
): Promise<ActionResult> {
  if (
    !tripIdSchema.safeParse(tripId).success ||
    !clarificationAnswersSchema.safeParse(answers).success
  ) {
    return MALFORMED_REQUEST;
  }
  const intent = getIntent(tripId);
  if (!intent) return { ok: false, error: 'We could not find that trip.' };
  const refusal = await tripAccessRefusal(tripId);
  if (refusal) return { ok: false, error: refusal };

  const stamp = new Date().toISOString();
  const next: ClarificationSet = {
    ...intent.clarifications,
    answers: answers
      .filter((answer) => answer.values.length > 0)
      .map((answer) => ({ ...answer, answeredAt: stamp })),
  };

  try {
    saveClarifications(tripId, next);
  } catch (error) {
    console.error('Could not save clarification answers', { tripId, error });
    return { ok: false, error: 'We could not save that just then. Try again.' };
  }

  revalidatePath(`/trips/${tripId}/plan`);
  return { ok: true };
}

/**
 * THE ONE DERIVATION, USED AT PROPOSAL TIME AND AT PROFILE-DELTA RE-DERIVATION.
 *
 * Extracted so the staleness guard below cannot drift from the proposal: both
 * read the same candidate, the same clarifications, the same preflight anchor
 * and — decisively — the profile AS IT EXISTS AT CALL TIME. The live flow
 * derives and stores the scope proposal before any questionnaire exists, so a
 * scope that reads the profile only at proposal time reads nothing, forever.
 */
function deriveTripScope(
  trip: NonNullable<ReturnType<typeof getTrip>>,
  intent: NonNullable<ReturnType<typeof getIntent>>,
  candidate: NonNullable<ReturnType<typeof activeCandidate>>,
) {
  const profile = getProfile(trip.id);
  return deriveScope({
    candidate,
    clarifications: intent.clarifications,
    /*
     * WHICH CATALOGUE DIVISION THE DESTINATION IS, RESOLVED WHERE THE INDEX IS.
     *
     * `deriveScope` reads the identifier the candidate was minted from without
     * being told. What it cannot see from here is a catalogue that publishes the
     * same place twice, at two administrative levels — and for a metropolis that
     * is the normal case, with every record in the destination referring to the
     * reading the index did *not* hand the traveller. Resolving that needs the
     * destination index, which lives on this side of the package boundary.
     *
     * The whole candidate rather than its id, because a geocoded destination
     * has no catalogue row and the only bridge to one is a code it carries.
     */
    divisionIds: destinationDivisionIds(candidate),
    ...(profile ? { profile } : {}),
    ...(intent.composer?.transport ? { composerTransport: intent.composer.transport } : {}),
    ...(intent.composer?.shape ? { composerShape: intent.composer.shape } : {}),
    /*
     * THE REACH THE TRAVELLER WAS SHOWN, HANDED TO THE THING THAT BUILDS.
     *
     * The preflight draws a structure and publishes the reach it implies; this
     * is the only line that stops the compilation deriving a second, different
     * number from its own table. Guarded on the destination key because a
     * preflight for a *different* destination is not evidence about this one —
     * the same guard `ensurePreflightAction` uses before reusing a stored one.
     */
    ...(preflightReachFor(intent, candidate.id) === undefined
      ? {}
      : { preflightReachKm: preflightReachFor(intent, candidate.id)! }),
    /*
     * THE PART THE PREFLIGHT CHOSE, HANDED TO THE THING THAT NARROWS.
     *
     * "One area, in depth" is only ever offered over a preflight structure that
     * has already chosen its first base — so when the traveller accepts it, the
     * answer to "which area" exists and is stored. This is the only line that
     * carries it across. Without it, a narrowed country was centred on the
     * candidate's geometric centre — for a real car-free trip, a twelve-
     * kilometre walking circle of uninhabited highland two hundred kilometres
     * from the base the same screen had proposed. Same destination-key guard as
     * the reach above, for the same reason.
     */
    ...(preflightAnchorFor(intent, candidate.id) === undefined
      ? {}
      : { preflightAnchor: preflightAnchorFor(intent, candidate.id)! }),
    /*
     * WHETHER A TRANSIT JOURNEY CAN BE MEASURED, ASKED OF THE BROKER.
     *
     * `deriveScope` has taken this parameter since the reach split and no
     * production caller ever supplied one, so it defaulted to `false` while the
     * preflight computed the real answer — the same two-screens-one-question
     * divergence the split existed to close, reopened by an omission. It is a
     * pure registry read: no socket, no provider import.
     */
    transitMeasurable: capabilityRegistry().assess('route_transit').available,
    nights: countNights(trip.basics.startDate, trip.basics.endDate),
    revision: intent.scopeRevision + 1,
  });

}

/**
 * Derive the scope from the interpretation and the answers, and store it.
 *
 * Not confirmed by this: the traveller sees it first. `saveScope` bumps the
 * revision, which travels into the fingerprint, so editing an answer and coming
 * back cannot silently adopt the artifact compiled from the previous answer.
 */
export async function proposeScopeAction(tripId: string): Promise<ActionResult> {
  if (!tripIdSchema.safeParse(tripId).success) return MALFORMED_REQUEST;
  const trip = getTrip(tripId);
  if (!trip) return { ok: false, error: 'We could not find that trip.' };
  const refusal = await tripAccessRefusal(tripId);
  if (refusal) return { ok: false, error: refusal };

  const intent = getIntent(tripId);
  if (!intent) return { ok: false, error: 'We could not find that trip.' };

  const candidate = activeCandidate(intent);
  if (!candidate) return { ok: false, error: 'We do not know where you mean yet.' };

  if (unansweredRequired(intent.clarifications).length > 0) {
    return { ok: false, error: 'There are still a couple of questions to answer.' };
  }

  const scope = deriveTripScope(trip, intent, candidate);
  saveScope(tripId, scope);
  revalidatePath(`/trips/${tripId}/plan`);
  return { ok: true };
}

/**
 * RE-DERIVE THE SCOPE WHEN THE PROFILE HAS MATERIALISED SINCE IT WAS DERIVED.
 *
 * The live flow's ordering is destination and dates first, questionnaire
 * after: the scope proposal is derived and persisted at the first plan visit,
 * before any profile exists, and "Build the region" reuses the stored
 * proposal. A profile-aware derivation that runs only at proposal time is
 * therefore unreachable for every real traveller — verified on a live build
 * where a stored driving profile predated the build and the compiled region
 * still carried the profile-blind day reach. The trigger is the *delta*, not
 * the visit: `derivedFromProfile` records what the stored scope was derived
 * from, so this runs at most once per trip, exactly when a questionnaire has
 * appeared since the proposal.
 *
 * Honesty at the confirmation seam: when the re-derived ground actually
 * differs, the stored proposal is replaced UNCONFIRMED and the caller refuses
 * with a sentence saying why — the traveller confirms the region they can
 * see, never one that silently widened after they read it. When the ground
 * comes out identical (most trips), nothing is rewritten and the flow
 * proceeds without friction.
 */
function rederiveScopeIfProfileAppeared(
  trip: NonNullable<ReturnType<typeof getTrip>>,
  intent: NonNullable<ReturnType<typeof getIntent>>,
): { ok: true } | { ok: false; error: string } {
  if (!intent.scope || intent.scope.derivedFromProfile === true) return { ok: true };
  if (!getProfile(trip.id)) return { ok: true };
  const candidate = activeCandidate(intent);
  if (!candidate) return { ok: true };

  const rederived = deriveTripScope(trip, intent, candidate);
  const groundChanged =
    JSON.stringify(rederived.shape) !== JSON.stringify(intent.scope.shape) ||
    rederived.reachRadiusKm !== intent.scope.reachRadiusKm;
  if (!groundChanged) return { ok: true };

  saveScope(trip.id, rederived);
  revalidatePath(`/trips/${trip.id}/plan`);
  return {
    ok: false,
    error:
      'Your questionnaire answers changed how far this trip can reach, so we updated the proposed region — please look it over and confirm it again.',
  };
}

export async function confirmScopeAction(tripId: string): Promise<ActionResult> {
  if (!tripIdSchema.safeParse(tripId).success) return MALFORMED_REQUEST;
  const refusal = await tripAccessRefusal(tripId);
  if (refusal) return { ok: false, error: refusal };
  const intent = getIntent(tripId);
  if (!intent?.scope) return { ok: false, error: 'There is no region to confirm yet.' };

  const trip = getTrip(tripId);
  if (!trip) return { ok: false, error: 'We could not find that trip.' };
  const fresh = rederiveScopeIfProfileAppeared(trip, intent);
  if (!fresh.ok) return fresh;

  const fits = scopeFitsTrip(intent.scope);
  if (!fits.fits) return { ok: false, error: fits.reason ?? 'That region does not fit this trip.' };

  saveScope(tripId, {
    ...intent.scope,
    confirmedByUser: true,
    confirmedAt: new Date().toISOString(),
  });

  revalidatePath(`/trips/${tripId}/plan`);
  return { ok: true };
}

/**
 * Start the job, then hand the work to a dedicated process.
 *
 * The job row is what makes this survivable in every direction: the browser
 * reads state from the database rather than from any promise, the worker
 * writes to the database rather than to any pipe, and either side can die
 * without taking the other's truth with it.
 *
 * The work runs in a spawned compile worker by default — a compilation used to
 * run on this process's event loop and froze every route for the length of the
 * build. `after()` remains only as the inline fallback, for environments that
 * cannot spawn and for `SIDEQUEST_COMPILER_ISOLATION=inline`. Both live in
 * `lib/compiler/queue` now, because a build admitted from the queue has to be
 * started exactly the way one that never waited is.
 *
 * Three answers rather than two, and the middle one is new: started, *queued*
 * behind the deployment's one build slot, or — only once the queue itself is
 * full — refused with a sentence that says so.
 */
export async function startCompilationAction(tripId: string): Promise<ActionResult> {
  if (!tripIdSchema.safeParse(tripId).success) return MALFORMED_REQUEST;
  const trip = getTrip(tripId);
  if (!trip) return { ok: false, error: 'We could not find that trip.' };
  const refusal = await tripAccessRefusal(tripId);
  if (refusal) return { ok: false, error: refusal };

  /*
   * Adoption before the limiter, because adoption is free. A second click on a
   * build that is already going must show the traveller that build — charging
   * a token for it (or refusing it) would make the limiter punish exactly the
   * double-click the job index already absorbs. An *abandoned* job does not
   * count: that click is asking for a restart, which is a real start and pays
   * like one.
   */
  const running = activeJobFor(tripId);
  if (running && !isAbandoned(running, new Date())) {
    revalidatePath(`/trips/${tripId}/plan`);
    return { ok: true };
  }

  /*
   * The build must never spend money on a scope the traveller's own
   * questionnaire has since invalidated — the same guard the confirm action
   * runs, for the path where a stale confirmed proposal is built directly.
   */
  const intentForScope = getIntent(tripId);
  if (intentForScope) {
    const fresh = rederiveScopeIfProfileAppeared(trip, intentForScope);
    if (!fresh.ok) return fresh;
  }

  // Before `startCompilation`, which is the thing that can create a billable
  // job: a refused request must refuse before anything exists to pay for.
  const limited = await rateGuard('compile_start');
  if (limited) return { ok: false, error: limited };

  /*
   * Sweep before asking for capacity, so this traveller is measured against
   * what is genuinely running rather than against a slot held by a worker that
   * died while nobody had its page open. It also lets an arriving press pay for
   * the admission of whoever was already in line ahead of them.
   */
  pumpCompilationQueue();

  /*
   * The caller travels with the start, so the day's allowance is spent against
   * this browser as well as against the deployment. Without it the ceiling is a
   * single shared counter and one visitor holding down the button exhausts
   * everybody's research for the day — measured at roughly seventeen minutes.
   */
  const outcome = startCompilation(trip, new Date(), await callerKey());
  if (outcome.kind === 'blocked') return { ok: false, error: outcome.message };

  // Already running, or already compiled: both mean "what you asked for is
  // happening or has happened", which is not an error and must not start a
  // second job.
  if (outcome.kind === 'already_running' || outcome.kind === 'already_compiled') {
    revalidatePath(`/trips/${tripId}/plan`);
    return { ok: true };
  }

  /*
   * ACCEPTED, AND WAITING FOR THE ONE BUILD SLOT.
   *
   * Not an error and not a start: nothing is dispatched here, because the whole
   * point is that nothing may be. The row exists, the progress screen renders
   * the place in line, and `pumpCompilationQueue` starts it when the slot frees.
   */
  if (outcome.kind === 'queued') {
    revalidatePath(`/trips/${tripId}/plan`);
    return { ok: true };
  }

  dispatchCompilation({ tripId, jobId: outcome.jobId });

  revalidatePath(`/trips/${tripId}/plan`);
  return { ok: true };
}

/** Explicit, and only from a terminal state. A retry is never automatic. */
export async function retryCompilationAction(tripId: string): Promise<ActionResult> {
  if (!tripIdSchema.safeParse(tripId).success) return MALFORMED_REQUEST;
  const refusal = await tripAccessRefusal(tripId);
  if (refusal) return { ok: false, error: refusal };
  const job = getLatestJob(tripId);
  /*
   * An abandoned job is terminal for this purpose, and saying so here is what
   * makes the unlock real.
   *
   * Without it the screen could report `failed` and offer "Try again" while
   * this guard still read the row's own `running` and refused — a button that
   * appears exactly when it cannot work, which is worse than no button. The
   * same ninety-second threshold `startJob` already trusts enough to hand the
   * work to a different request.
   */
  if (job && !isTerminal(job.state) && !isAbandoned(job, new Date())) {
    return { ok: false, error: 'That compilation is still running.' };
  }
  return startCompilationAction(tripId);
}

/**
 * Stop, meaning now. `requestCancel` flips the job terminal in the same call,
 * so the traveller's next read says "cancelled" rather than "running until the
 * worker notices" — and the worker's pulse notices within one heartbeat
 * interval and stops the process, which is what stops the spending.
 */
export async function cancelCompilationAction(tripId: string): Promise<ActionResult> {
  if (!tripIdSchema.safeParse(tripId).success) return MALFORMED_REQUEST;
  const refusal = await tripAccessRefusal(tripId);
  if (refusal) return { ok: false, error: refusal };
  requestCancel(tripId);
  /*
   * The slot is free from this write, not from whenever the worker notices —
   * `requestCancel` flips the row terminal in the same call — so the next build
   * in line starts now rather than a poll later. It also covers the traveller
   * who cancels a *queued* build: their place in line is given up, and whoever
   * was behind them moves up.
   */
  pumpCompilationQueue();
  revalidatePath(`/trips/${tripId}/plan`);
  return { ok: true };
}

export interface CompilationSnapshot {
  state: CompilationState | 'none';
  stages: StageRecord[];
  errorMessage?: string;
  retryable: boolean;
  compiledRegionId?: string;
  /** When the job began, so the progress clock survives a refresh. */
  startedAt?: string;
  /**
   * The board emitted at the cut, if one has been.
   *
   * A board id rather than a state: a provisional board is an annotation on a
   * running job, not a phase of it. Adding a `provisional` state would change
   * `isTerminal`, the polling predicate and `decideStep`, for a thing that is
   * neither terminal nor a step.
   */
  provisionalBoardId?: string;
  /**
   * What this build did not have to buy, in the words of the stage that reused it.
   *
   * Sourced from the `reusing_shared_claims` outcome rather than composed here,
   * because the stage already counts it and a second count computed on the way
   * to the screen is a second thing that can disagree with the first.
   */
  reusedSummary?: string;
  /**
   * How much longer, when there is enough comparable history to say — and null,
   * which is the normal answer, when there is not.
   *
   * Null is rendered as silence, never as a zero and never as a percentage. See
   * `estimateRemainingFrom` for the seven separate refusals behind it.
   *
   * Optional as well as nullable, and the two mean different things: `undefined`
   * is the server-rendered first paint, which does not run the estimator because
   * a page render must not query history; `null` is the poll having asked and
   * been refused. Both render as silence, which is why the distinction costs
   * nothing on screen and is worth keeping in the type.
   */
  estimate?: RemainingEstimate | null;
  /**
   * Where this build stands in line, counting from one — and absent whenever it
   * is not waiting, which is the normal case.
   *
   * `queued` alone cannot carry this. It has always been the state of a job in
   * the instant before its worker picks it up, so a screen reading it as "in a
   * queue" would say so briefly on every single build. Present means genuinely
   * parked: nothing has been dispatched for this job, and this is how many
   * builds have to end before it starts.
   */
  queuePosition?: number;
}

/**
 * What the progress screen polls.
 *
 * Returns what was actually stored rather than leaving the client to guess — the
 * same rule the board's auto-pick already follows, because a server revalidation
 * cannot update client state on its own.
 */
export async function compilationSnapshotAction(tripId: string): Promise<CompilationSnapshot> {
  if (!tripIdSchema.safeParse(tripId).success) {
    return { state: 'none', stages: [], retryable: false };
  }
  /*
   * A foreign poll gets the no-job answer, not a refusal sentence: this is a
   * read, and "nothing here" is the same thing the page's 404 already says.
   * It also keeps the reclaim write below out of a stranger's reach.
   */
  if (await tripAccessRefusal(tripId)) {
    return { state: 'none', stages: [], retryable: false };
  }

  /**
   * ORPHANS ARE ENDED HERE, NOT MERELY DESCRIBED.
   *
   * This poll used to *report* an abandoned job as failed while the row said
   * `running` forever — which kept the elapsed clock counting ("Working —
   * 12198m 51s" reached a real screen) and left `startJob` as the only thing
   * that could ever end the row. The reclaim writes the honest terminal state
   * — interrupted, retryable, nothing lost — the first time anybody looks
   * after the heartbeat goes cold, and the terminal-write guards keep a
   * returning process from arguing with it.
   */
  reclaimAbandonedJob(tripId, new Date());

  /**
   * AND THE QUEUE IS MOVED HERE, WHICH IS WHERE SOMEBODY IS ACTUALLY LOOKING.
   *
   * A worker exiting pumps the queue in the same process that launched it, but
   * that is not the only way a slot frees: a build cancelled from another tab, a
   * worker reaped after the web process restarted, a slot released by the
   * heartbeat sweep above. This poll is the one thing that reliably runs while
   * anybody is waiting — every 1.2 s from the waiting traveller's own page — so
   * it is what guarantees a queued build eventually starts rather than sitting
   * behind a slot nobody noticed was empty.
   *
   * It is not this trip's queue. The pump is deployment-wide by nature, so the
   * traveller watching a running build is also the one advancing the line behind
   * it; that is the point, and it costs one indexed count per poll.
   */
  pumpCompilationQueue();

  const job = getLatestJob(tripId);
  if (!job) return { state: 'none', stages: [], retryable: false };

  const stages = displayStages(job);

  /*
   * The estimate, or nothing, and nothing is the normal answer.
   *
   * The bucket comes from the run's *own* observations rather than from the
   * trip's scope, because warmth is a property of what the cache held when this
   * build started and not of the destination. Re-deriving it here would ask for
   * a warm bucket's history while watching a cold build — a confident number
   * from the wrong population, which is the failure mode this whole subsystem
   * was rebuilt to stop.
   *
   * Until the runner records a `StageObservation` per stage there is no bucket
   * and therefore no estimate, and the screen shows elapsed time only. That is
   * the honest degradation, not a gap.
   */
  const bucket = runBucket(job.id);
  const estimate = bucket
    ? estimateRemainingForRun({
        remainingStages: stages
          .filter((record) => record.status === 'waiting' || record.status === 'running')
          .map((record) => record.stage),
        ...bucket,
      })
    : null;

  const reused = stages.find(
    (record) => record.stage === 'reusing_shared_claims' && record.status === 'done',
  );

  /*
   * One read, not two.
   *
   * This was `provisionalBoardIdFor(tripId) ? { … provisionalBoardIdFor(tripId)! }`,
   * which parses the stored board twice on every poll — a JSON parse and a Zod
   * validation of a forty-card document, 1.2 seconds apart from the next pair,
   * for a value that cannot change between the two calls.
   */
  const provisionalBoardId = provisionalBoardIdFor(tripId);

  /**
   * A BUILD WHOSE PROCESS IS GONE IS FAILED, NOT RUNNING.
   *
   * `isAbandoned` existed and was consulted in exactly one place — `startJob`,
   * deciding whether a *new* request could take over a stale row. The screen
   * never asked. So if the server process died mid-build, the traveller watched
   * a live-ticking elapsed clock, polling every 1.2 seconds, for ever: the state
   * stayed `running`, "Try again" is gated on `failed`, and the retry action
   * refuses while a job is non-terminal. Three correct-looking guards adding up
   * to a screen that could never move.
   *
   * Reported rather than written. The row is left alone — a process that comes
   * back and finishes should still be able to complete its own job — and what
   * changes is only what this snapshot *says*, which is what the retry path
   * reads. A ninety-second silence is already the threshold `startJob` trusts
   * enough to hand the work to somebody else.
   */
  const abandoned = isAbandoned(job, new Date());
  const state: CompilationState = abandoned ? 'failed' : job.state;

  /*
   * Null for every build that is not parked, which is every build that is
   * actually being worked on. See `CompilationSnapshot.queuePosition`.
   */
  const queuePosition = queuePositionFor(job.id);

  /**
   * The failure's copy and retryability, decided by the one verdict function
   * the server render also calls. The code alone misstated two live failure
   * classes — a catalogue outage told as "not enough here to plan on", and a
   * wall-clock kill told as "we ran out of lookups" — so both surfaces read
   * the code, the detail and the stage records together. See
   * `lib/compiler/verdict.ts`.
   */
  const verdict = job.errorCode
    ? compilationVerdict({
        errorCode: job.errorCode,
        errorDetail: job.errorDetail,
        stages: job.stages,
      })
    : null;

  return {
    state,
    stages,
    ...(verdict
      ? { errorMessage: verdict.message }
      : abandoned
        ? {
            errorMessage:
              'That build stopped without finishing — the server it was running on went away. Nothing was lost; starting it again picks up everything we had already read.',
          }
        : {}),
    retryable: verdict ? verdict.retryable : state === 'failed',
    ...(job.compiledRegionId ? { compiledRegionId: job.compiledRegionId } : {}),
    startedAt: job.startedAt,
    ...(provisionalBoardId ? { provisionalBoardId } : {}),
    ...(reused?.outcome ? { reusedSummary: reused.outcome } : {}),
    estimate,
    /*
     * Read after the pump above, deliberately: if this poll is the one that
     * admitted the job, the honest answer is "not waiting any more" rather than
     * a position taken a few statements earlier.
     */
    ...(queuePosition !== null ? { queuePosition } : {}),
  };
}

/**
 * A resolver candidate, in the shape the composer and preflight speak.
 *
 * The two paths into the flow — picking an index row and typing free text —
 * converge here, so everything downstream reads one type. Without this, half the
 * new screens would have to branch on which door the traveller came through,
 * and the free-text path would quietly get a worse product.
 *
 * `releaseId: 'resolver'` is a truthful marker rather than a fake pin: this
 * identity came from a geocoder, not from a pinned catalogue release, and a
 * release id copied from somewhere else would be a provenance claim we cannot
 * support.
 */
function selectedDestinationFrom(candidate: DestinationCandidate): SelectedDestination {
  return {
    entryId: `resolver:${candidate.id}`,
    catalog: 'nominatim',
    sourceId: candidate.providerRefs[0]?.externalId ?? candidate.id,
    releaseId: 'resolver',
    displayName: candidate.displayName,
    qualifiedName: candidate.qualifiedName,
    featureType: FEATURE_TYPE_FROM_ENTITY[candidate.entityType] ?? 'other',
    center: candidate.center,
    ...(candidate.bounds ? { bounds: candidate.bounds } : {}),
    ...(candidate.countryCode ? { countryCode: candidate.countryCode } : {}),
    ...(candidate.regionCode ? { regionCode: candidate.regionCode } : {}),
    aliases: [...candidate.aliases],
    hierarchy: candidate.administrativeAreas,
    selectedAt: new Date().toISOString(),
  };
}

/**
 * THE OTHER HALF OF THE BRIDGE.
 *
 * `selectedDestinationFrom` turns a resolver candidate into the shape the new
 * screens speak; this turns an index selection back into the shape the *scope*
 * layer speaks. Both directions are needed because the two entry paths — picking
 * a suggestion, and typing free text — have to converge on one representation
 * before `deriveScope` runs.
 *
 * A live evaluation is what found this: a destination picked from the index
 * reached the preflight, chose a strategy, and then `proposeScopeAction` refused
 * it with "pick which reading you meant first" — because there was no resolver
 * candidate and nothing had noticed that there did not need to be one.
 *
 * The confidence is deliberately *not* invented. An index row is a record from a
 * pinned catalogue release that the traveller pointed at, which is a stronger
 * provenance than a geocoder guess, and `user_confirmed` says exactly that
 * without claiming corroboration nobody performed.
 */
/**
 * The reach the stored preflight published, but only if it is about *this*
 * destination.
 *
 * The identity check is the whole of the function. A preflight for the previous
 * thing the traveller typed is not evidence about the current one, and adopting
 * its reach would compile a region shaped like a destination they abandoned.
 *
 * Two id forms have to be reconciled, and that is not incidental: a destination
 * picked from the index carries the index entry id, while one resolved from
 * free text is stored as `resolver:<candidate id>` by `selectedDestinationFrom`
 * above. Comparing the raw strings matched the first and silently missed the
 * second — which would have left exactly the arbitrary-destination journey
 * without the fix, and that is the journey it was written for.
 */
function preflightReachFor(
  intent: { preflight?: TripPreflight | null | undefined },
  candidateId: string,
): number | undefined {
  const preflight = intent.preflight;
  if (!preflight) return undefined;
  const key = preflight.destinationKey;
  if (key !== candidateId && key !== `resolver:${candidateId}`) return undefined;
  const reach = preflight.portfolio?.reachRadiusKm;
  return typeof reach === 'number' && reach > 0 ? reach : undefined;
}

/**
 * The first base of the stored preflight's route — the part "one area" means.
 *
 * Same identity guard as `preflightReachFor` above, and the same reason: a
 * preflight for a destination the traveller has since abandoned is not evidence
 * about this one. The first route entry rather than the gateway, because the
 * route is the structure's own ordering of where the trip actually stays and
 * the gateway is only where it enters.
 */
function preflightAnchorFor(
  intent: { preflight?: TripPreflight | null | undefined },
  candidateId: string,
): { id: string; name: string; center: { lat: number; lng: number } } | undefined {
  const preflight = intent.preflight;
  if (!preflight) return undefined;
  const key = preflight.destinationKey;
  if (key !== candidateId && key !== `resolver:${candidateId}`) return undefined;
  const part = preflight.portfolio?.route[0];
  return part ? { id: part.id, name: part.name, center: part.center } : undefined;
}

function candidateFromSelected(destination: SelectedDestination): DestinationCandidate {
  const entityType = FEATURE_TYPE_ENTITY[destination.featureType];
  return {
    id: destination.entryId,
    displayName: destination.displayName,
    qualifiedName: destination.qualifiedName,
    entityType,
    breadth: FEATURE_TYPE_BREADTH[destination.featureType],
    center: destination.center,
    ...(destination.bounds ? { bounds: destination.bounds } : {}),
    ...(destination.countryCode ? { countryCode: destination.countryCode } : {}),
    ...(destination.regionCode ? { regionCode: destination.regionCode } : {}),
    aliases: [...destination.aliases],
    administrativeAreas: [...destination.hierarchy],
    timeZones: [],
    providerRefs: [
      {
        provider: destination.catalog,
        externalId: destination.sourceId,
      },
    ],
    confidence: assessConfidence([
      'user_confirmed',
      'exact_name_match',
      ...(destination.bounds ? (['boundary_available'] as const) : (['no_boundary_available'] as const)),
    ]),
    note: `Chosen from the ${destination.catalog} place index.`,
  };
}

/**
 * The candidate this trip is working from, whichever door it came through.
 *
 * The resolver's candidate wins when there is one, because it carries a time
 * zone and a corroboration record the index does not.
 */
function activeCandidate(intent: {
  resolution: DestinationResolution | null;
  selectedCandidateId: string | null;
  selectedDestination: SelectedDestination | null;
}): DestinationCandidate | null {
  if (intent.resolution && intent.selectedCandidateId) {
    const found = candidateById(intent.resolution, intent.selectedCandidateId);
    if (found) return found;
  }
  return intent.selectedDestination ? candidateFromSelected(intent.selectedDestination) : null;
}

const FEATURE_TYPE_FROM_ENTITY: Partial<Record<string, SelectedDestination['featureType']>> = {
  country: 'country',
  multi_country: 'country',
  state_or_province: 'region',
  subregion: 'county',
  city: 'city',
  metro_area: 'city',
  neighbourhood: 'district',
  island: 'island',
  archipelago: 'island',
  protected_area: 'national_park',
  point_of_interest: 'landmark',
};

/**
 * The cheap answer, computed once and stored.
 *
 * Called from the plan page's preflight step rather than during render: this
 * makes one network request (climate, cached for a month) and a handful of local
 * queries, and a page that did that on every render would be doing hidden I/O in
 * a component — the thing the architecture tests exist to prevent.
 *
 * Idempotent by destination: a stored preflight for the same destination is
 * returned rather than recomputed, so a refresh is free.
 */
export async function ensurePreflightAction(tripId: string): Promise<ActionResult> {
  if (!tripIdSchema.safeParse(tripId).success) return MALFORMED_REQUEST;
  const intent = getIntent(tripId);
  if (!intent) return { ok: false, error: 'We could not find that trip.' };
  const refusal = await tripAccessRefusal(tripId);
  if (refusal) return { ok: false, error: refusal };

  const destination = intent.selectedDestination;
  if (!destination) return { ok: false, error: 'We do not know where you mean yet.' };

  /*
   * The clarification set is derived here, not only after a resolver run.
   *
   * Both entry paths reach this point, and the rules that decide which questions
   * a destination needs are the same for both. Deriving them only on the
   * resolver path is what left an index-selected country with an empty question
   * set — so the strategy answer had nowhere to land and the scope layer had
   * nothing to read.
   */
  const profile = getProfile(tripId);
  const trip = getTrip(tripId);
  if (trip && intent.clarifications.questions.length === 0) {
    saveClarifications(
      tripId,
      rebuildClarificationSet(
        {
          resolution: intent.resolution ?? emptyResolution(destination),
          candidate: candidateFromSelected(destination),
          nights: countNights(trip.basics.startDate, trip.basics.endDate),
          ...(profile ? { profile } : {}),
          known: knownFrom(intent.composer),
        },
        intent.clarifications,
      ),
    );
  }

  if (intent.preflight && intent.preflight.destinationKey === destination.entryId) {
    return { ok: true };
  }

  // After the idempotent return above — a stored preflight re-read on refresh
  // is free and must never be throttled — and before the network call below.
  const limited = await rateGuard('preflight');
  if (limited) return { ok: false, error: limited };

  try {
    const preflight = await runPreflight({
      destination,
      answers: intent.composer,
      now: new Date(),
    });
    savePreflight(tripId, preflight);

    /*
     * ADAPTIVE QUESTIONS ARE DERIVED HERE, AND NOWHERE EARLIER.
     *
     * They read the preliminary scan, which is the only thing that knows
     * anything specific about *this* trip — how many areas there are, how far
     * apart they sit, what the structure had to leave out, whether the season
     * genuinely matters here. Deriving them before the scan would produce the
     * trait-gated questions the bank next door already asks; deriving them
     * after compilation would be asking about decisions already taken.
     *
     * Folded in additively, so nothing a traveller has already answered is
     * disturbed by a question arriving beside it.
     */
    const withAdaptive = withAdaptiveQuestions(
      getIntent(tripId)?.clarifications ?? intent.clarifications,
      deriveAdaptiveQuestions({
        preflight,
        /*
         * `nightsFrom`, not `duration.nights`.
         *
         * `duration.nights` is only set when the traveller typed a night count.
         * The ordinary path — entering two dates — leaves it undefined, which
         * made this `null` for most travellers and broke both directions at
         * once: the hotel-move rule is gated on `nights >= 5` and never fired,
         * while the date rule is gated on `nights === null` and asked somebody
         * who had just entered exact dates whether they would move them.
         * `nightsFrom` derives it from whichever the traveller actually gave.
         */
        nights: intent.composer ? nightsFrom(intent.composer) : null,
        known: {
          ...knownFrom(intent.composer),
          ...(intent.composer?.shape ? { shape: intent.composer.shape } : {}),
          ...(intent.composer?.mustDo ? { mustDo: intent.composer.mustDo } : {}),
          /*
           * How settled the dates are, from the mode the traveller chose rather
           * than from whether a night count happens to be stored. `exact` and
           * `flexible` mean they have dates; the other three mean they have not
           * decided, which is the only state where offering to move them is a
           * question rather than an insult.
           */
          ...(intent.composer
            ? {
                datesSettled:
                  intent.composer.dates.mode === 'exact' ||
                  intent.composer.dates.mode === 'flexible',
                wantsDateAdvice: intent.composer.dates.wantsRecommendation,
              }
            : {}),
        },
        existingIds: (getIntent(tripId)?.clarifications ?? intent.clarifications).questions.map(
          (question) => question.id,
        ),
      }),
    );
    saveClarifications(tripId, withAdaptive);
  } catch (error) {
    console.error('Preflight failed', { tripId, error });
    return { ok: false, error: 'We could not read that region just now. Try again.' };
  }

  revalidatePath(`/trips/${tripId}/plan`);
  return { ok: true };
}

/**
 * What the composer already settled, in the shape the clarification rules read.
 *
 * One function rather than an inline object at each call site, because the three
 * places that rebuild a question set have to agree about this — and a fourth one
 * that forgot would re-ask a question the traveller has already answered, which
 * is the single thing this product promises not to do.
 */
function knownFrom(composer: TripComposerAnswers | null): {
  transport?: string;
  scopeStrategy?: boolean;
} {
  if (!composer) return {};
  return {
    ...(composer.transport ? { transport: composer.transport } : {}),
    ...(composer.scopeStrategy ? { scopeStrategy: true } : {}),
  };
}

/**
 * A resolution-shaped record for a destination that never needed resolving.
 *
 * The clarification rules take a `DestinationResolution` because they read its
 * ambiguity reasons. An index selection has none — that is the whole point of it
 * — so this is an empty one rather than a fabricated one: no ambiguity, one
 * candidate, and `providersConsulted` naming the index rather than a geocoder we
 * did not call.
 */
function emptyResolution(destination: SelectedDestination): DestinationResolution {
  const candidate = candidateFromSelected(destination);
  return {
    schemaVersion: DESTINATION_RESOLUTION_VERSION,
    query: destination.displayName,
    normalizedQuery: normalizeDestinationQuery(destination.displayName),
    candidates: [candidate],
    ambiguityReasons: [],
    unambiguousCandidateId: candidate.id,
    providersConsulted: [destination.catalog],
    resolvedAt: destination.selectedAt,
  };
}

/**
 * Adopt a recommended date window, or a recommended trip length.
 *
 * The preflight showed both and let the traveller do nothing with either, which
 * makes a recommendation into advice. This is what turns "August is strongest
 * here" into a trip that happens in August.
 *
 * The dates it produces are the *middle* of the month, and the composer keeps
 * `dates.mode` unchanged so nothing presents that midpoint as a decision the
 * traveller made. The evidence is month-grained; picking a specific week would
 * be precision the data does not carry, and the screen says so.
 */
export async function adoptDateWindowAction(
  tripId: string,
  month: number,
  year: number,
): Promise<ActionResult> {
  if (!tripIdSchema.safeParse(tripId).success) return MALFORMED_REQUEST;
  const trip = getTrip(tripId);
  const intent = getIntent(tripId);
  if (!trip || !intent) return { ok: false, error: 'We could not find that trip.' };
  const refusal = await tripAccessRefusal(tripId);
  if (refusal) return { ok: false, error: refusal };
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    return { ok: false, error: 'That is not a month we offered.' };
  }

  const nights = countNights(trip.basics.startDate, trip.basics.endDate);
  const { startDate, endDate } = datesInWindow({ month, year }, Math.max(1, nights));

  updateTripDates(tripId, startDate, endDate);
  if (intent.composer) {
    saveComposerAnswers(tripId, {
      ...intent.composer,
      dates: { ...intent.composer.dates, startDate, endDate, year },
      updatedAt: new Date().toISOString(),
    });
  }

  revalidatePath(`/trips/${tripId}/plan`);
  return { ok: true };
}

export async function adoptTripLengthAction(
  tripId: string,
  nights: number,
): Promise<ActionResult> {
  if (!tripIdSchema.safeParse(tripId).success) return MALFORMED_REQUEST;
  const trip = getTrip(tripId);
  const intent = getIntent(tripId);
  if (!trip || !intent) return { ok: false, error: 'We could not find that trip.' };
  const refusal = await tripAccessRefusal(tripId);
  if (refusal) return { ok: false, error: refusal };
  if (!Number.isInteger(nights) || nights < 1 || nights > MAX_TRIP_NIGHTS) {
    return { ok: false, error: 'That is not a length we offered.' };
  }

  // This action recomputes the preflight below, which is a real provider
  // call, so it draws from the same bucket the preflight itself does.
  const limited = await rateGuard('preflight');
  if (limited) return { ok: false, error: limited };

  const start = Date.parse(`${trip.basics.startDate}T00:00:00Z`);
  if (Number.isNaN(start)) return { ok: false, error: 'That trip has no usable start date.' };
  const endDate = new Date(start + nights * 86_400_000).toISOString().slice(0, 10);

  updateTripDates(tripId, trip.basics.startDate, endDate);
  if (intent.composer) {
    saveComposerAnswers(tripId, {
      ...intent.composer,
      dates: { ...intent.composer.dates, endDate },
      duration: { ...intent.composer.duration, mode: 'fixed', nights },
      updatedAt: new Date().toISOString(),
    });
  }

  /*
   * The preflight is recomputed, because a different length is a different
   * portfolio: the number of bases a trip can hold is the thing this screen's
   * whole recommendation turns on. Clearing the stored one is what forces it.
   */
  if (intent.selectedDestination) {
    savePreflight(tripId, {
      ...(await runPreflight({
        destination: intent.selectedDestination,
        answers: getIntent(tripId)?.composer ?? null,
        now: new Date(),
      })),
    });
  }

  revalidatePath(`/trips/${tripId}/plan`);
  return { ok: true };
}

/**
 * Adopt a scope strategy chosen on the preflight screen.
 *
 * Two writes, both of which matter:
 *
 * - **onto the composer**, because the scope is *derived* and a value written
 *   only there would be lost the moment somebody pressed "rework it";
 * - **onto the clarification answers**, so the breadth and base questions this
 *   choice already answers are never asked a second time. Asking a traveller the
 *   same thing twice is precisely what "one questionnaire" promises not to do.
 *
 * The clarification write is a single replacement of the whole answer list
 * rather than one call per question. An earlier version wrote twice, each time
 * re-reading the intent, and the second write silently reverted part of the
 * first — the kind of defect that only shows up when both questions happen to be
 * present, which is exactly the country case this screen exists for.
 */
export async function applyStrategyAction(tripId: string, strategyId: string): Promise<ActionResult> {
  if (
    !tripIdSchema.safeParse(tripId).success ||
    !strategyIdSchema.safeParse(strategyId).success
  ) {
    return MALFORMED_REQUEST;
  }
  const intent = getIntent(tripId);
  if (!intent) return { ok: false, error: 'We could not find that trip.' };
  const refusal = await tripAccessRefusal(tripId);
  if (refusal) return { ok: false, error: refusal };

  /*
   * An empty strategy is a real answer, not a missing one.
   *
   * A region with a single cluster offers no strategies, so there is nothing to
   * pick — and the traveller still has to be able to move on. Recording `none`
   * is what stops them looping back to this screen forever.
   */
  const plan = strategyId === '' ? null : STRATEGY_CONSEQUENCES[strategyId];
  if (strategyId !== '' && !plan) {
    return { ok: false, error: 'That is not one of the options we offered.' };
  }

  if (intent.composer) {
    saveComposerAnswers(tripId, {
      ...intent.composer,
      ...(plan ? { shape: plan.shape } : {}),
      scopeStrategy: strategyId === '' ? 'none' : strategyId,
      updatedAt: new Date().toISOString(),
    });
  }

  if (!plan) {
    revalidatePath(`/trips/${tripId}/plan`);
    return { ok: true };
  }

  const answeredAt = new Date().toISOString();
  const implied = new Map<string, string>([
    [QUESTION_IDS.breadthStrategy, plan.breadthAnswer],
    [QUESTION_IDS.baseStrategy, plan.baseAnswer],
  ]);

  const kept = intent.clarifications.answers.filter((answer) => !implied.has(answer.questionId));
  const added = [...implied.entries()].map(([questionId, value]) => ({
    questionId,
    values: [value],
    answeredAt,
  }));

  /*
   * Re-derive the question set now that the strategy is known.
   *
   * Without this the two questions the strategy just answered stay in the set
   * and are presented on the very next screen — which a live run caught: choose
   * "two bases", press continue, and be asked how many times you are willing to
   * change hotel. The answers survive the rebuild; the questions do not.
   */
  const withStrategy = getIntent(tripId);
  const trip = getTrip(tripId);
  const candidate = withStrategy ? activeCandidate(withStrategy) : null;
  if (withStrategy && trip && candidate) {
    const profile = getProfile(tripId);
    saveClarifications(
      tripId,
      rebuildClarificationSet(
        {
          resolution: withStrategy.resolution ?? emptyResolution(withStrategy.selectedDestination!),
          candidate,
          nights: countNights(trip.basics.startDate, trip.basics.endDate),
          ...(profile ? { profile } : {}),
          known: knownFrom(withStrategy.composer),
        },
        { ...withStrategy.clarifications, answers: [...kept, ...added] },
      ),
    );

    /*
     * When nothing *required* is left, go straight to the scope screen.
     *
     * A screen carrying one optional question is a screen nobody reads, and the
     * codebase already applies that rule to the interpretation step. What
     * remains optional — a fixed airport, say — does not change what gets built,
     * and the scope screen shows the region anyway.
     */
    const settled = getIntent(tripId);
    if (settled && unansweredRequired(settled.clarifications).length === 0) {
      await proposeScopeAction(tripId);
    }
  }

  revalidatePath(`/trips/${tripId}/plan`);
  return { ok: true };
}

/**
 * What each strategy means downstream, in one table.
 *
 * A table rather than three nested ternaries so that adding a strategy is one
 * row and forgetting a consequence is a type error rather than a silent
 * default.
 */
const STRATEGY_CONSEQUENCES: Record<
  string,
  { shape: NonNullable<TripComposerAnswers['shape']>; breadthAnswer: string; baseAnswer: string }
> = {
  one_area: { shape: 'one_base', breadthAnswer: 'one_area', baseAnswer: '0' },
  name_it: { shape: 'one_base', breadthAnswer: 'name_it', baseAnswer: '0' },
  two_bases: { shape: 'two_bases', breadthAnswer: 'circuit', baseAnswer: '1' },
  circuit: { shape: 'circuit', breadthAnswer: 'circuit', baseAnswer: '2' },
};

/** The stored board's id, when the cut has produced one for this trip. */
function provisionalBoardIdFor(tripId: string): string | null {
  return getProvisionalBoard(tripId)?.id ?? null;
}

/**
 * GO BACK TO THE REGION SCREEN FROM THE QUESTIONS.
 *
 * Section 18.1 requires Back on every step, and the clarification step had
 * none — the traveller's only route back to the region preview was the
 * browser's own button, which on a flow whose step is *derived from stored
 * state* rather than from the URL does not go back at all.
 *
 * The step is derived, so "back" cannot be a link. It has to undo the thing
 * that moved them forward, which is the scope strategy recorded on the
 * composer. Clearing it is enough: `decideStep` returns `preflight` the moment
 * `scopeStrategy` is absent.
 *
 * **Every answer is kept.** The clarification answers stay exactly where they
 * are, so somebody who steps back to look at the region and then comes forward
 * finds their questions still answered. Losing them would make Back a
 * punishment, which is how a product teaches people not to check their work.
 */
export async function reopenPreflightAction(tripId: string): Promise<ActionResult> {
  if (!tripIdSchema.safeParse(tripId).success) return MALFORMED_REQUEST;
  const intent = getIntent(tripId);
  if (!intent) return { ok: false, error: 'We could not find that trip.' };
  const refusal = await tripAccessRefusal(tripId);
  if (refusal) return { ok: false, error: refusal };
  if (!intent.composer) {
    return { ok: false, error: 'There is nothing to go back to on this trip.' };
  }

  const { scopeStrategy: _cleared, ...rest } = intent.composer;
  saveComposerAnswers(tripId, { ...rest, updatedAt: new Date().toISOString() });
  revalidatePath(`/trips/${tripId}/plan`);
  return { ok: true };
}
