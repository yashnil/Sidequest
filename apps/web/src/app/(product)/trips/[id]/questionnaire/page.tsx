import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import {
  applyComposer,
  applyInterpretation,
  applyThemes,
  applyTransportDecision,
  composerCarriedFields,
  countTripDays,
  defaultAnswers,
  durationFits,
  interestOfferFromEntityType,
  normalizeAnswers,
  type QuestionnaireContext,
  FEATURE_TYPE_ENTITY,
} from '@sidequest/core';
import { resolveRegion } from '@sidequest/core/data';
import { carAvailableFromAnswers } from '@sidequest/compiler';
import { InterviewWizard } from '@/components/InterviewWizard';
import { Panel } from '@/components/ui';
import { getAnswers, getProfile } from '@/lib/db/repository';
import { ownedTrip } from '@/lib/net/trip-access';
import { getIntent } from '@/lib/db/compiler-repository';
import { destinationEntryById } from '@/lib/db/destination-index-repository';
import { interviewContextFor } from '@/lib/interview/screening';
import { compiledRegionFor, DYNAMIC_REGION_ID, resolveTripRegion } from '@/lib/region';
import { isFixtureComposer } from '@/lib/providers/switches';
import { providerReadiness } from '@/lib/compiler/readiness';
import { resolveMapBasemap } from '@/components/map-adapter';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const trip = await ownedTrip(id);
  return {
    title: trip ? `${trip.basics.destinationInput} — How you travel — Sidequest` : 'How you travel — Sidequest',
  };
}

/**
 * THE ADAPTIVE INTERVIEW'S PAGE.
 *
 * Reads everything the screening needs from what is already stored — the
 * intent (destination, scope, preflight, composer), the compiled region when
 * a build has finished, the authored region when the trip is against one —
 * and hands the wizard a plain, serialisable `InterviewContext`. No provider
 * is reached on this render; a destination nothing has classified yet gets
 * the generic high-information interview rather than a wait.
 */
export default async function QuestionnairePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const trip = await ownedTrip(id);
  if (!trip) notFound();

  const resolved = await resolveTripRegion(trip);
  const intent = getIntent(id);
  const tripDays = countTripDays(trip.basics.startDate, trip.basics.endDate);
  const seeded = trip.basics.regionId === DYNAMIC_REGION_ID ? null : resolveRegion(trip.basics.destinationInput);

  /*
   * DESTINATION-AWARE INTERVIEW GLOBALITY — a composer pick is an identity.
   * Its feature type names the kind of place, and its index row carries the
   * population and extent; both reach the screening and the interest offer.
   */
  const picked = intent?.selectedDestination ?? null;
  const pickedEntityType = picked ? FEATURE_TYPE_ENTITY[picked.featureType] : undefined;
  const indexEntry = picked ? destinationEntryById(picked.entryId) : null;
  const offer =
    resolved.ok && resolved.context.region.interestOffer
      ? resolved.context.region.interestOffer
      : interestOfferFromEntityType(intent?.scope?.destinationEntityType ?? intent?.resolution?.candidates[0]?.entityType ?? pickedEntityType ?? 'unknown');

  const context: QuestionnaireContext = {
    travelerNeeds: trip.basics.travelerNeeds,
    tripDays,
    offeredInterests: offer.interests,
    ...(resolved.ok
      ? {
          region: {
            baseName: resolved.context.region.baseName,
            ...(resolved.context.region.questionnaireCopy ? { copy: resolved.context.region.questionnaireCopy } : {}),
          },
        }
      : {}),
  };

  /*
   * Seeding, exactly as before: the composer's outright answers, then its
   * themes, then the confirmed free-text chips, then the clarification's car
   * answer — and anything actually saved on this screen replaces all of it.
   */
  const saved = getAnswers(id);
  const interpretation = intent?.composer?.interpretation;
  const clarifiedCar =
    carAvailableFromAnswers(intent?.clarifications) ??
    (intent?.scope?.confirmedByUser ? intent.scope.transport.carAvailable : null);
  const seededAnswers =
    saved ??
    applyTransportDecision(
      applyInterpretation(
        applyThemes(applyComposer(defaultAnswers(context), intent?.composer), intent?.composer?.themes),
        interpretation,
      ).answers,
      clarifiedCar,
    );
  const initialAnswers = normalizeAnswers(seededAnswers, context);

  const carriedFromComposer = composerCarriedFields(intent?.composer, initialAnswers);
  const carried =
    clarifiedCar !== null && initialAnswers.willDrive === clarifiedCar && !carriedFromComposer.includes('willDrive')
      ? [...carriedFromComposer, 'willDrive' as const]
      : carriedFromComposer;

  const guidance = intent?.preflight?.duration;
  let durationAdvice: string | null = null;
  if (intent?.composer?.duration?.wantsRecommendation && guidance?.kind === 'recommended') {
    const nights = Math.max(1, tripDays - 1);
    const fit = durationFits({ nights, guidance });
    durationAdvice = fit.note ?? (fit.suggestion ? `your ${nights} night${nights === 1 ? '' : 's'} suits “${fit.suggestion.label}” — ${fit.suggestion.covers}.` : null);
  }

  const interviewContext = interviewContextFor({
    trip,
    intent,
    region: resolved.ok ? resolved.context : null,
    seeded,
    indexEntry,
    offeredInterests: offer.interests,
    carried,
    answers: initialAnswers,
  });

  const boardAwaitingProfile = compiledRegionFor(id) !== null && !getProfile(id);

  /*
   * PRODUCTION UI V1 — where the destination is, for the real map in the
   * interview's rail: the selected destination's own centre and published
   * bounds, or the compiled region's base point. Null when nothing resolved.
   */
  const selected = intent?.selectedDestination ?? intent?.resolution?.candidates.find((c) => c.id === (intent?.selectedCandidateId ?? intent?.resolution?.unambiguousCandidateId)) ?? intent?.resolution?.candidates[0] ?? null;
  const geometry = selected?.center
    ? { name: selected.displayName ?? trip.basics.destinationInput, center: selected.center, bounds: selected.bounds ?? null, featureType: 'entityType' in selected ? selected.entityType : selected.featureType }
    : resolved.ok
      ? { name: resolved.context.region.name, center: resolved.context.region.baseCoordinates, bounds: null }
      : null;
  const tiles = resolveMapBasemap(process.env);

  const wizard = (
    <InterviewWizard
      /*
       * Remount when the free-text interpretation is confirmed: the chips are
       * applied on the server and the seeded answers change, and a client
       * component keeps its first state otherwise.
       */
      key={interpretation?.confirmedAt ?? 'fresh'}
      tripId={id}
      context={interviewContext}
      {...(context.region ? { region: context.region } : {})}
      initialAnswers={initialAnswers}
      durationAdvice={durationAdvice}
      boardAvailable={resolved.ok}
      researchAvailable={trip.basics.regionId === DYNAMIC_REGION_ID && intent?.selectedDestination !== null && providerReadiness().ready}
      /*
       * Whenever fixtures are in use, wherever that is.
       *
       * This used to be gated on NODE_ENV as well, so a *production build* run
       * with the fixture composer — which is exactly how the screenshot walks
       * and the browser suite run — showed no badge at all. The one thing that
       * badge exists to prevent is somebody mistaking fixture output for the
       * model's, and a production build is where that mistake is most likely,
       * not least. The switch is the fact; the environment is not.
       */
      fixtureMode={isFixtureComposer()}
      geometry={geometry}
      tiles={tiles}
      {...(interpretation
        ? { interpretation: { set: interpretation, mustDo: intent?.composer?.mustDo ?? '', avoid: intent?.composer?.avoid ?? '' } }
        : {})}
    />
  );

  if (!boardAwaitingProfile) return wizard;

  return (
    <>
      <div className="mx-auto max-w-3xl px-5 pt-8 sm:px-8">
        <Panel className="border-pine p-4 text-sm leading-relaxed text-ink" testId="board-awaits-answers">
          The research has finished and your board is built. These questions are what rank it around you — answer them and the board opens straight after.
        </Panel>
      </div>
      {wizard}
    </>
  );
}
