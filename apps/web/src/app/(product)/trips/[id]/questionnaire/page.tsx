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
  stepIdForOrdinal,
  type QuestionnaireContext,
} from '@sidequest/core';
import { carAvailableFromAnswers } from '@sidequest/compiler';
import { QuestionnaireWizard } from '@/components/QuestionnaireWizard';
import { Panel } from '@/components/ui';
import { getAnswers, getDraftStep, getProfile } from '@/lib/db/repository';
import { ownedTrip } from '@/lib/net/trip-access';
import { getIntent } from '@/lib/db/compiler-repository';
import { compiledRegionFor, resolveTripRegion } from '@/lib/region';

export const dynamic = 'force-dynamic';

/** Which trip's questions these are. See the discover route for why. */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const trip = await ownedTrip(id);
  return {
    title: trip
      ? `${trip.basics.destinationInput} — How you travel — Sidequest`
      : 'How you travel — Sidequest',
  };
}

export default async function QuestionnairePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  /*
   * The owner's trip or nothing — a foreign browser sees a missing trip, the
   * same boundary every trip door holds. See `lib/net/trip-access`.
   */
  const trip = await ownedTrip(id);
  if (!trip) notFound();

  /**
   * The region reaches the questionnaire so the questions can name the place.
   *
   * Resolved through the region source rather than imported: this page must not
   * know which region it is asking about, only that there is one. A region we
   * cannot resolve yet still gets a questionnaire — with generic wording, which
   * is the honest version rather than another valley's landmarks.
   */
  const resolved = await resolveTripRegion(trip);
  const intent = getIntent(id);
  const tripDays = countTripDays(trip.basics.startDate, trip.basics.endDate);

  /**
   * WHICH INTERESTS THIS DESTINATION MAY BE GRADED ON.
   *
   * Two paths, and the second is the one that carries almost every trip: the
   * questionnaire runs *before* the compilation, so for a traveller answering it
   * for the first time there is no region and no places — only the entity type
   * they confirmed on the scope screen. `interestOfferFromEntityType` reads that
   * and says which class of destination this is, which is enough to stop a Tokyo
   * traveller being asked to grade scenic drives, geothermal ground, hot springs
   * and stargazing while having no row at all for museums or markets.
   *
   * The compiled region's own offer wins where one exists, because it was
   * derived from what the research actually found rather than from what a class
   * of place usually holds. Neither path can withhold everything: both fall
   * through to the whole vocabulary when nothing is known, and the wizard falls
   * back to it again if this is somehow absent.
   */
  const offer =
    resolved.ok && resolved.context.region.interestOffer
      ? resolved.context.region.interestOffer
      : interestOfferFromEntityType(intent?.scope?.destinationEntityType ?? 'unknown');

  const context: QuestionnaireContext = {
    travelerNeeds: trip.basics.travelerNeeds,
    tripDays,
    offeredInterests: offer.interests,
    ...(resolved.ok
      ? {
          region: {
            baseName: resolved.context.region.baseName,
            ...(resolved.context.region.questionnaireCopy
              ? { copy: resolved.context.region.questionnaireCopy }
              : {}),
          },
        }
      : {}),
  };

  /*
   * Resume from whatever was saved; otherwise start from defaults — seeded, now,
   * by whatever the traveller wrote in the composer and then *confirmed*.
   *
   * This is where the free-text boxes finally do something. They have been
   * captured since Phase 11 and read by nothing, which was the honest half to
   * ship first: the rule is that a derived preference is applied only after
   * somebody accepts it, and until there was a screen to accept it on, applying
   * it would have broken that rule rather than fulfilled it.
   *
   * `normalizeAnswers` still runs last and still wins. A confirmed chip that
   * contradicts an answer given on the basics screen — a hiking preference
   * against a stated mobility need — is clamped there, which is the right order:
   * a sentence must never outrank a question somebody was asked directly.
   */
  const saved = getAnswers(id);
  const interpretation = intent?.composer?.interpretation;
  /*
   * Themes first, then the free-text chips, then whatever was actually saved.
   *
   * The order is the point. `applyThemes` only raises interests the traveller
   * ticked on the composer, so it can never lower a considered answer; the chips
   * then apply over it; and a `saved` set — anything the traveller has typed on
   * this screen — replaces both outright, because their own edits win.
   *
   * `applyComposer` runs *before* the themes and the chips: it carries the five
   * things the composer asked outright — transport, pace, budget, crowds,
   * outdoor intensity — which were being collected, stored, and then silently
   * replaced by `defaultAnswers`. The worst of them was `willDrive: true`:
   * somebody who chose trains and buses on the first screen reached this one
   * with "You will have a car" already ticked.
   */
  /*
   * The car decision, from wherever it was actually settled.
   *
   * `applyComposer` carries the composer's transport — and on the ordinary city
   * journey the composer leaves transport undecided and the car question is
   * asked as a clarification on the plan flow instead, which `applyComposer`
   * never reads. A live car-free trip stored `willDrive: true` in its profile
   * that way, contradicting its own confirmed scope. The clarification answer
   * wins where one exists because it is the later, more specific statement; the
   * confirmed scope's assumption — which already reconciles profile over
   * clarification over composer — is the fallback. `null` means nobody said,
   * and seeds nothing.
   */
  const clarifiedCar =
    carAvailableFromAnswers(intent?.clarifications) ??
    (intent?.scope?.confirmedByUser ? intent.scope.transport.carAvailable : null);
  const seeded =
    saved ??
    applyTransportDecision(
      applyInterpretation(
        applyThemes(applyComposer(defaultAnswers(context), intent?.composer), intent?.composer?.themes),
        interpretation,
      ).answers,
      clarifiedCar,
    );
  const initialAnswers = normalizeAnswers(seeded, context);

  /*
   * Which composer answers still stand in the current answer set, so the wizard
   * can show them as confirmable assumptions instead of asking a second time.
   *
   * Recomputed against the answers on *every* load — including a resumed one.
   * This used to be `saved ? [] : composerAnsweredFields(…)`, which meant the
   * first mid-flow save stripped every "from your answers" badge and
   * resurrected the budget step the composer had already answered; refresh was
   * quietly destroying provenance under a header reading "Saved as you go".
   * `composerCarriedFields` keeps a field carried exactly while the stored
   * value still agrees with what the composer said, so a traveller's overruling
   * edit — and only that — removes the badge.
   */
  const carriedFromComposer = composerCarriedFields(intent?.composer, initialAnswers);
  /*
   * The clarification's car answer earns the same "from your answers" standing
   * as a composer answer, by the same rule `composerCarriedFields` applies: it
   * counts as carried exactly while the stored value still agrees with what
   * was said, so a traveller's overruling edit — and only that — removes it.
   */
  const alreadyAnswered =
    clarifiedCar !== null &&
    initialAnswers.willDrive === clarifiedCar &&
    !carriedFromComposer.includes('willDrive')
      ? [...carriedFromComposer, 'willDrive' as const]
      : carriedFromComposer;

  /*
   * The trip-length steer, for travellers who asked the composer for one.
   *
   * `duration.wantsRecommendation` was captured and read by nothing — a ticked
   * box that did not change a single screen. The preflight's duration guidance
   * is the existing nights-required math, already stored on the intent row, so
   * the honest fix is to finally show its answer where the traveller confirms
   * everything else. Null whenever nobody asked or nothing defensible exists;
   * the review step simply omits the panel then.
   */
  const guidance = intent?.preflight?.duration;
  let durationAdvice: string | null = null;
  if (intent?.composer?.duration?.wantsRecommendation && guidance?.kind === 'recommended') {
    const nights = Math.max(1, tripDays - 1);
    const fit = durationFits({ nights, guidance });
    durationAdvice =
      fit.note ??
      (fit.suggestion
        ? `your ${nights} night${nights === 1 ? '' : 's'} suits “${fit.suggestion.label}” — ${fit.suggestion.covers}.`
        : null);
  }

  /*
   * The wizard owns the interpretation panel now, and with it the page's
   * heading order: a page-level h1 above the panel, the panel's own h2 under
   * it, the step title demoted to h2. The panel used to render here as a
   * sibling *above* the wizard's h1, so every visit where the traveller had
   * typed free text began at heading level two — a screen reader's heading
   * list read the page inside out. Folding it into the wizard also lets it
   * collapse to a one-line bar after the first advance, instead of pushing the
   * questionnaire 1.4 mobile viewports down on every visit.
   */
  /*
   * WHY THIS SCREEN, WHEN A BOARD ALREADY EXISTS.
   *
   * The discover route sends a traveller without a profile here — correctly,
   * because the board is ranked against these answers — but it does so as a
   * silent redirect, and the provisional footer had just told them their
   * results were ready. Landing on nine questions with no explanation read as
   * a loop, not a step. One sentence turns the bounce into a path: the board
   * is built, and these answers are what unlock it.
   */
  const boardAwaitingProfile = compiledRegionFor(id) !== null && !getProfile(id);

  const wizard = (
    <QuestionnaireWizard
      tripId={id}
      context={context}
      initialAnswers={initialAnswers}
      initialStepId={stepIdForOrdinal(getDraftStep(id))}
      prefilled={alreadyAnswered}
      durationAdvice={durationAdvice}
      /*
       * Stage B: the follow-ups this destination's own geography justified.
       *
       * Only ever present once a region has been compiled, which is the point —
       * §6.2 splits intake into what has to be known before anybody researches
       * anything, and the handful of things that only become worth asking once
       * there is destination context. An empty list is the ordinary case and
       * renders nothing.
       */
      decisionQuestions={
        resolved.ok ? (resolved.context.region.decisionQuestions ?? []) : []
      }
      {...(interpretation
        ? {
            interpretation: {
              set: interpretation,
              mustDo: intent?.composer?.mustDo ?? '',
              avoid: intent?.composer?.avoid ?? '',
            },
          }
        : {})}
    />
  );

  /*
   * The wizard stays the page's root on the ordinary journey — the banner
   * wraps it only when there is genuinely a finished board waiting, so the
   * common case renders exactly what it always did.
   */
  if (!boardAwaitingProfile) return wizard;

  return (
    <>
      <div className="mx-auto max-w-3xl px-5 pt-8 sm:px-8">
        <Panel
          className="border-pine p-4 text-sm leading-relaxed text-ink"
          testId="board-awaits-answers"
        >
          The research has finished and your board is built. These questions are what rank it
          around you — answer them and the board opens straight after.
        </Panel>
      </div>
      {wizard}
    </>
  );
}
