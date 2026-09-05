import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import {
  candidateById,
  countNights,
  decideInterpretation,
  displayStages,
  identityAmbiguityReasons,
  isAbandoned,
  settleMustDoCoverage,
  unansweredRequired,
  visibleQuestions,
  type ClarificationQuestion,
} from '@sidequest/core';
import { formatDayRange } from '@/lib/format/dates';
import { scopeFitsTrip } from '@sidequest/compiler';
import { PlanFlow, type PlanStep } from '@/components/PlanFlow';
import { TripContextBar } from '@/components/TripContextBar';
import { providerReadiness } from '@/lib/compiler/readiness';
import {
  getIntent,
  getLatestJob,
  getLatestWorkPlan,
  queuePositionFor,
} from '@/lib/db/compiler-repository';
import { ownedTrip } from '@/lib/net/trip-access';
import { compiledRegionFor, DYNAMIC_REGION_ID } from '@/lib/region';
import type { CompilationSnapshot } from './actions';
import { compilationVerdict } from '@/lib/compiler/verdict';

export const dynamic = 'force-dynamic';

/**
 * The tab says which trip, not what the product is.
 *
 * Every route in the product inherited one marketing title from the root
 * layout, so six open trips were six identical tabs and a screen-reader user
 * heard the same sentence on arrival at every screen. Read from the stored trip
 * — the same row the page renders — so it cannot claim a destination the page
 * does not show.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const trip = await ownedTrip(id);
  return {
    /*
     * The destination first, like every other trip route.
     *
     * A tab strip truncates from the right, so the leading words are the only
     * ones a traveller with six trips open can read. "Planning Mammoth Lakes"
     * and "Planning Mammoth Lakes area" truncate to the same thing; the
     * destination does not.
     */
    title: trip ? `${trip.basics.destinationInput} — Planning — Sidequest` : 'Planning — Sidequest',
  };
}

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
  /*
   * The owner's trip or nothing — a foreign browser sees a missing trip, the
   * same boundary every trip door holds. See `lib/net/trip-access`.
   */
  const trip = await ownedTrip(id);
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

  /**
   * The frozen reading, with what the traveller has since decided applied.
   *
   * Both halves come from storage — the artifact and the composer — so this is a
   * pure function of two persisted values rather than a verdict recomputed from
   * whatever happens to be reachable at render. See `settleMustDoCoverage`.
   */
  const settled = settleMustDoCoverage({
    ...(compiled?.researchReadiness ? { readiness: compiled.researchReadiness } : {}),
    ...(compiled?.mustDoCoverage ? { coverage: compiled.mustDoCoverage } : {}),
    decisions: intent.composer?.mustDoDecisions ?? [],
  });

  /**
   * A BUILD WHOSE PROCESS IS GONE IS NOT RUNNING, ON THE FIRST PAINT TOO.
   *
   * The poll has known this since Wave A — `compilationSnapshotAction` reclaims
   * an orphan and reports `failed`. The *server render* did not, and it is what
   * a traveller sees first. So a job whose heartbeat had been cold for eight
   * days painted "Working · 12458m 52s" with four phase cards breathing at it,
   * and the poll never corrected it because the polling predicate only fires
   * for `queued` and `running` — a row left at `partial` never gets a second
   * look. The screen could not move.
   *
   * Read, not written: this render must not mutate a job row, and the reclaim
   * in the action already owns the write.
   */
  const abandoned = job ? isAbandoned(job, new Date()) : false;

  /**
   * WHAT A FAILED BUILD SAYS AND WHETHER IT MAY OFFER A RETRY — ONE DECIDER.
   *
   * `compilationVerdict` reads the code, the detail and the stage records
   * together, because the code alone told two lies on live builds: a catalogue
   * outage read as a verdict about the destination, and a wall-clock kill read
   * as an exhausted lookup ledger. The poll (`compilationSnapshotAction`) calls
   * the same function, so the first paint and every refresh agree.
   */
  const verdict = job?.errorCode
    ? compilationVerdict({
        errorCode: job.errorCode,
        errorDetail: job.errorDetail,
        stages: job.stages,
      })
    : null;

  const snapshot: CompilationSnapshot = job
    ? {
        state: abandoned ? 'failed' : job.state,
        stages: displayStages(job),
        ...(verdict
          ? { errorMessage: verdict.message }
          : abandoned
            ? {
                errorMessage:
                  'This build stopped before it finished — the machine it was running on went away. Nothing was lost; starting it again picks up everything we had already read.',
              }
            : {}),
        retryable: verdict ? verdict.retryable : abandoned || job.state === 'failed',
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
        /*
         * So a parked build says "waiting for a free slot" on the first paint
         * rather than "Getting started…" until the first poll a second later.
         * `waitingSince` is the row's own answer to "has anything been
         * dispatched for this"; the position is what the poll then keeps fresh.
         */
        ...(job.waitingSince ? { queuePosition: queuePositionFor(job.id) ?? 1 } : {}),
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
              : // `2026-10-12 → 2026-10-18` was the database's format on the
                // strip that follows a traveller through the whole journey.
                formatDayRange(trip.basics.startDate, trip.basics.endDate),
          nights,
          stage:
            step === 'ready'
              ? 'Researched'
              : step === 'compiling'
                ? // "Building" over a build that stopped days ago is the same
                  // present tense the progress card was corrected for.
                  abandoned || (job && job.state !== 'queued' && job.state !== 'running')
                  ? 'Stopped'
                  : // And "Building" over a build nothing has been dispatched
                    // for is the same overclaim one step earlier.
                    job?.waitingSince
                    ? 'Waiting'
                    : 'Building'
                : 'Planning',
        }}
      />
      {/*
        PHASE 17 — THE MINIMAL-FIRST PATH, OFFERED RATHER THAN FORCED.
        Everything below this still works exactly as it did; this is a second
        door next to it, not a replacement for it. See
        `.claude-private/phase-17-baseline-first-hybrid-planner.md` §7-8.
      */}
      <p className="mx-auto max-w-3xl px-4 pt-4 text-sm text-ink-muted sm:px-6">
        Or skip ahead —{' '}
        <Link href={`/trips/${id}/quickplan`} className="underline underline-offset-4">
          let Sidequest plan the whole trip now
        </Link>
        .
      </p>
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
      {...(settled.readiness ? { researchReadiness: settled.readiness } : {})}
      {...(settled.coverage ? { mustDoCoverage: settled.coverage } : {})}
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
              // attribution meaningful rather than decorative. The label is
              // the place's name alone: the raw element id — a bare UUID on
              // the catalogue this ships with — told a traveller nothing, and
              // the link underneath still reaches the exact source record.
              sourceTimestamps: compiled.places
                .filter((place) => place.source.element !== undefined)
                .slice(0, 6)
                .map((place) => ({
                  label: place.name,
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
      /**
       * WHAT THE ARTIFACT ITSELF MEASURED, SO A STORED GRADE CAN BE CHECKED.
       *
       * A live artifact rendered "PUBLIC TRANSPORT · Good · Measured road times
       * across 26 points" three rows under "DRIVING TIMES · Not relevant here".
       * The compiler that wrote those rows has been repaired, but a coverage
       * report is stored *inside* the artifact and no repair reaches backwards
       * — only a paid rebuild would.
       *
       * These two facts are the artifact's own and cannot be faked: which
       * network the matrix measured, and how many transit journeys a timetable
       * provider actually answered. `reconcileRouting` uses them to refuse any
       * routing grade the artifact cannot support. See `lib/format/coverage`.
       */
      routingTruth={
        compiled
          ? {
              matrixMode: compiled.travelTimes.mode,
              transitMeasured: compiled.transitEvidence?.measured ?? 0,
              transitRequested: compiled.transitEvidence?.requested ?? 0,
            }
          : null
      }
      routingDiagnostics={compiled?.routingDiagnostics ?? null}
      workPlan={workPlan ? workPlan.entries.map((entry) => ({ ...entry })) : null}
      providerMessage={readiness.message}
      providerReady={readiness.ready}
      providerNextActions={readiness.nextActions}
      providerMissing={readiness.missing}
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
