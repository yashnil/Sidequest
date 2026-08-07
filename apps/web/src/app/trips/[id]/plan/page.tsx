import { notFound, redirect } from 'next/navigation';
import {
  candidateById,
  countNights,
  decideInterpretation,
  displayStages,
  identityAmbiguityReasons,
  unansweredRequired,
  visibleQuestions,
  type ClarificationQuestion,
} from '@sidequest/core';
import { scopeFitsTrip } from '@sidequest/compiler';
import { PlanFlow, type PlanStep } from '@/components/PlanFlow';
import { TripContextBar } from '@/components/TripContextBar';
import { providerReadiness } from '@/lib/compiler/readiness';
import { getIntent, getLatestJob, getLatestWorkPlan } from '@/lib/db/compiler-repository';
import { getTrip } from '@/lib/db/repository';
import { compiledRegionFor, DYNAMIC_REGION_ID } from '@/lib/region';
import type { CompilationSnapshot } from './actions';
import { COMPILATION_ERROR_COPY, isRetryable } from '@sidequest/core';

export const dynamic = 'force-dynamic';

/**
 * The step is derived from what is stored, never from the URL.
 *
 * That is the whole refresh story: reload at any point and the server reads the
 * same rows and renders the same step. There is no route that can claim the
 * traveller is further along than the database says, and no render path that
 * asks a provider anything.
 */
export default async function PlanPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const trip = getTrip(id);
  if (!trip) notFound();

  // A trip against an authored region never enters this flow.
  if (trip.basics.regionId !== DYNAMIC_REGION_ID) {
    redirect(`/trips/${id}/questionnaire`);
  }

  const intent = getIntent(id);
  if (!intent) notFound();

  const compiled = compiledRegionFor(id);
  const job = getLatestJob(id);
  /**
   * What the last build reused, read from its own row.
   *
   * A stored record rather than a live measurement, so this page still answers
   * "why was that fast" with every provider switched off — and so it cannot
   * quietly change under a traveller who reloads.
   */
  const workPlan = getLatestWorkPlan(id);
  const readiness = providerReadiness();

  const snapshot: CompilationSnapshot = job
    ? {
        state: job.state,
        stages: displayStages(job),
        ...(job.errorCode ? { errorMessage: COMPILATION_ERROR_COPY[job.errorCode] } : {}),
        retryable: job.errorCode ? isRetryable(job.errorCode) : job.state === 'failed',
        ...(job.compiledRegionId ? { compiledRegionId: job.compiledRegionId } : {}),
        /*
         * So the elapsed clock is right on the first paint rather than blank
         * until the first poll a second later. A stored timestamp, not a client
         * clock — two tabs agree and a refresh does not restart it.
         *
         * `estimate` is deliberately *not* here: it is derived from timing
         * history, and a page render must not query history to draw a number
         * that the very next poll will supply.
         */
        startedAt: job.startedAt,
      }
    : { state: 'none', stages: [], retryable: false };

  /*
   * How the resolution should be read, decided once and shared by the step
   * chooser and the props below. Breadth is deliberately *not* treated as
   * identity ambiguity — a country is one place, however large.
   */
  const decision = intent.resolution ? decideInterpretation(intent.resolution) : null;

  const selectedCandidate =
    intent.resolution && intent.selectedCandidateId
      ? candidateById(intent.resolution, intent.selectedCandidateId)
      : undefined;

  const questions: ClarificationQuestion[] = visibleQuestions(intent.clarifications);
  const outstanding = unansweredRequired(intent.clarifications);

  const step = decideStep({
    hasIdentity: intent.selectedDestination !== null,
    hasResolution: intent.resolution !== null,
    notAPlace: decision?.kind === 'not_a_place' || decision?.kind === 'no_match',
    needsChoice: decision?.kind === 'choose',
    hasSelection: selectedCandidate !== undefined,
    hasPreflight: intent.preflight !== null,
    /*
     * A trip created before the composer existed has no composer answers, and
     * has therefore never been offered a preflight. Sending it round a screen it
     * cannot satisfy would strand every trip in the database from the previous
     * phase.
     */
    preflightAccepted:
      intent.composer === null || intent.composer.scopeStrategy !== undefined,
    outstanding: outstanding.length,
    hasScope: intent.scope !== null,
    scopeConfirmed: intent.scope?.confirmedByUser ?? false,
    hasCompiled: compiled !== null,
  });

  /*
   * Trip context, rendered by the page that knows about the trip.
   *
   * This is what replaced the fixed `EASTERN SIERRA` label in the global header.
   * The difference that matters: that label was a claim about the product, and
   * every field here is read from a persisted row — so it is absent when there
   * is nothing to say rather than wrong.
   */
  const nights = countNights(trip.basics.startDate, trip.basics.endDate);
  const dateMode = intent.composer?.dates.mode;

  return (
    <>
      <TripContextBar
        context={{
          tripId: id,
          destination:
            intent.selectedDestination?.qualifiedName ??
            selectedCandidate?.qualifiedName ??
            intent.destinationQuery,
          when:
            dateMode === 'month' || dateMode === 'season' || dateMode === 'undecided'
              ? 'Dates not fixed'
              : `${trip.basics.startDate} → ${trip.basics.endDate}`,
          nights,
          stage: step === 'ready' ? 'Board' : step === 'compiling' ? 'Building' : 'Planning',
        }}
      />
    <PlanFlow
      tripId={id}
      step={step}
      destinationQuery={intent.destinationQuery}
      destinationName={
        intent.selectedDestination?.displayName ??
        selectedCandidate?.displayName ??
        intent.destinationQuery
      }
      candidates={decision?.kind === 'choose' ? decision.candidates : (intent.resolution?.candidates ?? [])}
      /*
       * Only the reasons that mean "we are unsure which place you meant".
       *
       * Showing "This is a whole country — a trip needs a part of it" on a
       * which-one screen is what made the old flow read as broken: it is true,
       * it is important, and it is an answer to a different question.
       */
      ambiguityReasons={
        intent.resolution ? identityAmbiguityReasons(intent.resolution) : []
      }
      preflight={intent.preflight}
      selectedCandidateId={intent.selectedCandidateId}
      questions={questions}
      answers={intent.clarifications.answers.map((answer) => ({
        questionId: answer.questionId,
        values: [...answer.values],
      }))}
      scope={intent.scope}
      scopeFits={intent.scope ? scopeFitsTrip(intent.scope) : { fits: true }}
      snapshot={snapshot}
      coverage={compiled?.coverage ?? null}
      licences={compiled?.licences ?? []}
      attributions={compiled?.sourceManifest.attributions ?? []}
      compiledSummary={
        compiled
          ? {
              placeCount: compiled.places.length,
              baseName:
                compiled.bases.find((base) => base.id === compiled.primaryBaseId)?.name ??
                compiled.region.baseName,
              ...(compiled.bases.find((base) => base.id === compiled.primaryBaseId)?.names
                ? {
                    baseNames: compiled.bases.find(
                      (base) => base.id === compiled.primaryBaseId,
                    )!.names,
                  }
                : {}),
              subregionCount: compiled.subregions.length,
              satelliteCount: compiled.satellites.length,
              // Provenance a reader can follow back, which is what makes an
              // attribution meaningful rather than decorative.
              sourceTimestamps: compiled.places
                .filter((place) => place.source.element !== undefined)
                .slice(0, 6)
                .map((place) => ({
                  label: `${place.name} — ${place.source.element!.elementId}`,
                  ...(place.source.element!.url ? { url: place.source.element!.url } : {}),
                  ...(place.source.element!.sourceTimestamp
                    ? { at: place.source.element!.sourceTimestamp }
                    : {}),
                })),
            }
          : null
      }
      /**
       * The data snapshot this plan is frozen to.
       *
       * Rendered from the artifact rather than looked up, so this screen still
       * answers "what was this built on" with every provider switched off — and
       * so the answer cannot drift when the catalogue publishes a new release.
       */
      regionData={
        compiled?.regionPack
          ? {
              releaseId: compiled.regionPack.releaseId,
              catalog: compiled.regionPack.catalog,
              state: compiled.regionPack.state,
              recordCount: compiled.regionPack.recordCount,
              builtAt: compiled.regionPack.builtAt,
              reused: compiled.regionPack.reused,
              packId: compiled.regionPack.packId,
              contentHash: compiled.regionPack.contentHash,
            }
          : null
      }
      /**
       * The multi-base structure, read from the artifact.
       *
       * Null for every region compiled before hierarchical routing, which reads
       * correctly as a one-base trip — the shape those regions actually had.
       */
      basePortfolio={compiled?.basePortfolio ?? null}
      routingDiagnostics={compiled?.routingDiagnostics ?? null}
      workPlan={workPlan ? workPlan.entries.map((entry) => ({ ...entry })) : null}
      providerMessage={readiness.message}
      providerReady={readiness.ready}
    />
    </>
  );
}

/**
 * One place decides which screen a traveller is on.
 *
 * Ordered by what has actually been established rather than by what they last
 * clicked, so a back-navigation and a refresh land in the same place — and a
 * compiled region wins over everything, because once there is an artifact the
 * earlier steps are history rather than work outstanding.
 */
function decideStep(input: {
  hasIdentity: boolean;
  hasResolution: boolean;
  notAPlace: boolean;
  needsChoice: boolean;
  hasSelection: boolean;
  hasPreflight: boolean;
  preflightAccepted: boolean;
  outstanding: number;
  hasScope: boolean;
  scopeConfirmed: boolean;
  hasCompiled: boolean;
}): PlanStep {
  if (input.hasCompiled) return 'ready';
  /**
   * Confirmation is the point of no return, and it is checked before the job
   * exists on purpose.
   *
   * Keying this on the job row instead left a window — between confirming and
   * the row being written — where a refresh landed back on the scope screen and
   * offered to start a second compilation. Reworking the scope is what comes
   * back here, and that derives a fresh, unconfirmed scope.
   */
  if (input.scopeConfirmed) return 'compiling';

  /*
   * A destination picked from the index skips resolution entirely.
   *
   * There is nothing to look up about a row somebody pointed at, and the screen
   * that used to sit here — "Reading Kyrgyzstan", with one button on it —
   * carried no decision at all.
   */
  if (!input.hasIdentity) {
    if (!input.hasResolution) return 'destination';
    if (input.notAPlace) return 'not_a_place';
    if (input.needsChoice && !input.hasSelection) return 'interpretation';
    if (!input.hasSelection) return 'destination';
  }

  /*
   * Preflight comes before the questions, not after.
   *
   * It is free and it is the screen that tells somebody whether we understood
   * them. Asking three clarifying questions and *then* revealing that there is
   * nothing in the region worth planning is the ordering this phase exists to
   * invert.
   */
  if (!input.preflightAccepted) return 'preflight';
  if (input.outstanding > 0) return 'clarification';
  if (!input.hasScope) return 'clarification';
  return 'scope';
}
