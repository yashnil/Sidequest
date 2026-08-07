'use server';

import { after } from 'next/server';
import { revalidatePath } from 'next/cache';
import {
  DESTINATION_RESOLUTION_VERSION,
  FEATURE_TYPE_BREADTH,
  FEATURE_TYPE_ENTITY,
  assessConfidence,
  candidateById,
  COMPILATION_ERROR_COPY,
  countNights,
  datesInWindow,
  MAX_TRIP_NIGHTS,
  normalizeDestinationQuery,
  decideInterpretation,
  displayStages,
  isRetryable,
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
} from '@sidequest/core';
import { deriveScope, QUESTION_IDS, rebuildClarificationSet, scopeFitsTrip } from '@sidequest/compiler';
import { compilerProviders, providerReadiness } from '@/lib/compiler/providers';
import { runCompilation, startCompilation } from '@/lib/compiler/runner';
import {
  getIntent,
  getLatestJob,
  requestCancel,
  saveClarifications,
  saveComposerAnswers,
  savePreflight,
  saveResolution,
  saveScope,
  saveSelectedCandidate,
  saveSelectedDestination,
} from '@/lib/db/compiler-repository';
import { getProfile, getTrip, updateTripDates } from '@/lib/db/repository';
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
 * Ask the resolver what the typed string might mean.
 *
 * Run once, on a button press, and stored — the geocoder's usage policy forbids
 * autocomplete, and re-resolving on every render would be the same abuse with
 * extra steps.
 */
export async function resolveDestinationAction(tripId: string): Promise<ActionResult> {
  const trip = getTrip(tripId);
  if (!trip) return { ok: false, error: 'We could not find that trip.' };

  const intent = getIntent(tripId);
  const query = intent?.destinationQuery?.trim();
  if (!query) return { ok: false, error: 'Tell us where you are going first.' };

  const readiness = providerReadiness();
  if (!readiness.ready) return { ok: false, error: readiness.message };

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
  const trip = getTrip(tripId);
  if (!trip) return { ok: false, error: 'We could not find that trip.' };

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
  const intent = getIntent(tripId);
  if (!intent) return { ok: false, error: 'We could not find that trip.' };

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
 * Derive the scope from the interpretation and the answers, and store it.
 *
 * Not confirmed by this: the traveller sees it first. `saveScope` bumps the
 * revision, which travels into the fingerprint, so editing an answer and coming
 * back cannot silently adopt the artifact compiled from the previous answer.
 */
export async function proposeScopeAction(tripId: string): Promise<ActionResult> {
  const trip = getTrip(tripId);
  if (!trip) return { ok: false, error: 'We could not find that trip.' };

  const intent = getIntent(tripId);
  if (!intent) return { ok: false, error: 'We could not find that trip.' };

  const candidate = activeCandidate(intent);
  if (!candidate) return { ok: false, error: 'We do not know where you mean yet.' };

  if (unansweredRequired(intent.clarifications).length > 0) {
    return { ok: false, error: 'There are still a couple of questions to answer.' };
  }

  const profile = getProfile(tripId);
  const scope = deriveScope({
    candidate,
    clarifications: intent.clarifications,
    ...(profile ? { profile } : {}),
    ...(intent.composer?.transport ? { composerTransport: intent.composer.transport } : {}),
    ...(intent.composer?.shape ? { composerShape: intent.composer.shape } : {}),
    nights: countNights(trip.basics.startDate, trip.basics.endDate),
    revision: intent.scopeRevision + 1,
  });

  saveScope(tripId, scope);
  revalidatePath(`/trips/${tripId}/plan`);
  return { ok: true };
}

export async function confirmScopeAction(tripId: string): Promise<ActionResult> {
  const intent = getIntent(tripId);
  if (!intent?.scope) return { ok: false, error: 'There is no region to confirm yet.' };

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
 * Start the job, then do the work after the response has gone.
 *
 * `after()` is what lets the browser get an answer immediately while the
 * compilation continues — and the job row is what makes that survivable, because
 * the browser reads state from the database rather than from this promise.
 */
export async function startCompilationAction(tripId: string): Promise<ActionResult> {
  const trip = getTrip(tripId);
  if (!trip) return { ok: false, error: 'We could not find that trip.' };

  const outcome = startCompilation(trip);
  if (outcome.kind === 'blocked') return { ok: false, error: outcome.message };

  // Already running, or already compiled: both mean "what you asked for is
  // happening or has happened", which is not an error and must not start a
  // second job.
  if (outcome.kind === 'already_running' || outcome.kind === 'already_compiled') {
    revalidatePath(`/trips/${tripId}/plan`);
    return { ok: true };
  }

  const jobId = outcome.jobId;
  after(async () => {
    try {
      await runCompilation({ trip, jobId });
    } catch (error) {
      console.error('Compilation runner failed', { tripId, jobId, error });
    }
  });

  revalidatePath(`/trips/${tripId}/plan`);
  return { ok: true };
}

/** Explicit, and only from a terminal state. A retry is never automatic. */
export async function retryCompilationAction(tripId: string): Promise<ActionResult> {
  const job = getLatestJob(tripId);
  if (job && !isTerminal(job.state)) {
    return { ok: false, error: 'That compilation is still running.' };
  }
  return startCompilationAction(tripId);
}

export async function cancelCompilationAction(tripId: string): Promise<ActionResult> {
  requestCancel(tripId);
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
}

/**
 * What the progress screen polls.
 *
 * Returns what was actually stored rather than leaving the client to guess — the
 * same rule the board's auto-pick already follows, because a server revalidation
 * cannot update client state on its own.
 */
export async function compilationSnapshotAction(tripId: string): Promise<CompilationSnapshot> {
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

  return {
    state: job.state,
    stages,
    ...(job.errorCode ? { errorMessage: COMPILATION_ERROR_COPY[job.errorCode] } : {}),
    retryable: job.errorCode ? isRetryable(job.errorCode) : job.state === 'failed',
    ...(job.compiledRegionId ? { compiledRegionId: job.compiledRegionId } : {}),
    startedAt: job.startedAt,
    ...(provisionalBoardId ? { provisionalBoardId } : {}),
    ...(reused?.outcome ? { reusedSummary: reused.outcome } : {}),
    estimate,
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
  const intent = getIntent(tripId);
  if (!intent) return { ok: false, error: 'We could not find that trip.' };

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

  try {
    const preflight = await runPreflight({
      destination,
      answers: intent.composer,
      now: new Date(),
    });
    savePreflight(tripId, preflight);
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
  const trip = getTrip(tripId);
  const intent = getIntent(tripId);
  if (!trip || !intent) return { ok: false, error: 'We could not find that trip.' };
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
  const trip = getTrip(tripId);
  const intent = getIntent(tripId);
  if (!trip || !intent) return { ok: false, error: 'We could not find that trip.' };
  if (!Number.isInteger(nights) || nights < 1 || nights > MAX_TRIP_NIGHTS) {
    return { ok: false, error: 'That is not a length we offered.' };
  }

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
  const intent = getIntent(tripId);
  if (!intent) return { ok: false, error: 'We could not find that trip.' };

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
