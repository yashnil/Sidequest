import { notFound } from 'next/navigation';
import {
  applyInterpretation,
  applyThemes,
  countTripDays,
  defaultAnswers,
  normalizeAnswers,
  type QuestionnaireContext,
} from '@sidequest/core';
import { QuestionnaireWizard } from '@/components/QuestionnaireWizard';
import { InterpretationPanel } from '@/components/InterpretationPanel';
import { getAnswers, getTrip } from '@/lib/db/repository';
import { getIntent } from '@/lib/db/compiler-repository';
import { resolveTripRegion } from '@/lib/region';

export const dynamic = 'force-dynamic';

export default async function QuestionnairePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const trip = getTrip(id);
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
  const context: QuestionnaireContext = {
    travelerNeeds: trip.basics.travelerNeeds,
    tripDays: countTripDays(trip.basics.startDate, trip.basics.endDate),
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
  const intent = getIntent(id);
  const interpretation = intent?.composer?.interpretation;
  /*
   * Themes first, then the free-text chips, then whatever was actually saved.
   *
   * The order is the point. `applyThemes` only raises interests the traveller
   * ticked on the composer, so it can never lower a considered answer; the chips
   * then apply over it; and a `saved` set — anything the traveller has typed on
   * this screen — replaces both outright, because their own edits win.
   *
   * Without the first step the themes were a dead end: preserved perfectly on the
   * composer, carried into the trip untouched, and read by nothing that ranks
   * anything. Somebody who chose food, museums and city life in Help Me Decide
   * arrived at a board ranked on hiking, nature walks and viewpoints — the
   * defaults — with no sign anywhere that their answers had stopped mattering.
   */
  const seeded =
    saved ??
    applyInterpretation(applyThemes(defaultAnswers(context), intent?.composer?.themes), interpretation)
      .answers;
  const initialAnswers = normalizeAnswers(seeded, context);

  return (
    <>
      {interpretation ? (
        <InterpretationPanel
          tripId={id}
          interpretation={interpretation}
          mustDo={intent?.composer?.mustDo ?? ''}
          avoid={intent?.composer?.avoid ?? ''}
        />
      ) : null}
      <QuestionnaireWizard tripId={id} context={context} initialAnswers={initialAnswers} />
    </>
  );
}
