import { notFound, redirect } from 'next/navigation';
import {
  candidateById,
  displayStages,
  unansweredRequired,
  visibleQuestions,
  type ClarificationQuestion,
} from '@sidequest/core';
import { scopeFitsTrip } from '@sidequest/compiler';
import { PlanFlow, type PlanStep } from '@/components/PlanFlow';
import { providerReadiness } from '@/lib/compiler/providers';
import { getIntent, getLatestJob } from '@/lib/db/compiler-repository';
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
  const readiness = providerReadiness();

  const snapshot: CompilationSnapshot = job
    ? {
        state: job.state,
        stages: displayStages(job),
        ...(job.errorCode ? { errorMessage: COMPILATION_ERROR_COPY[job.errorCode] } : {}),
        retryable: job.errorCode ? isRetryable(job.errorCode) : job.state === 'failed',
        ...(job.compiledRegionId ? { compiledRegionId: job.compiledRegionId } : {}),
      }
    : { state: 'none', stages: [], retryable: false };

  const selectedCandidate =
    intent.resolution && intent.selectedCandidateId
      ? candidateById(intent.resolution, intent.selectedCandidateId)
      : undefined;

  const questions: ClarificationQuestion[] = visibleQuestions(intent.clarifications);
  const outstanding = unansweredRequired(intent.clarifications);

  const step = decideStep({
    hasResolution: intent.resolution !== null,
    notAPlace: intent.resolution?.ambiguityReasons.includes('query_is_not_a_place') ?? false,
    candidateCount: intent.resolution?.candidates.length ?? 0,
    hasSelection: selectedCandidate !== undefined,
    outstanding: outstanding.length,
    hasScope: intent.scope !== null,
    scopeConfirmed: intent.scope?.confirmedByUser ?? false,
    jobState: snapshot.state,
    hasCompiled: compiled !== null,
  });

  return (
    <PlanFlow
      tripId={id}
      step={step}
      destinationQuery={intent.destinationQuery}
      candidates={intent.resolution?.candidates ?? []}
      ambiguityReasons={intent.resolution?.ambiguityReasons ?? []}
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
      providerMessage={readiness.message}
      providerReady={readiness.ready}
    />
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
  hasResolution: boolean;
  notAPlace: boolean;
  candidateCount: number;
  hasSelection: boolean;
  outstanding: number;
  hasScope: boolean;
  scopeConfirmed: boolean;
  jobState: CompilationSnapshot['state'];
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
  if (!input.hasResolution) return 'destination';
  if (input.notAPlace || input.candidateCount === 0) return 'not_a_place';
  if (!input.hasSelection) return 'interpretation';
  if (input.outstanding > 0) return 'clarification';
  if (!input.hasScope) return 'clarification';
  return 'scope';
}
