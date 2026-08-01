import { notFound } from 'next/navigation';
import {
  countTripDays,
  defaultAnswers,
  normalizeAnswers,
  type QuestionnaireContext,
} from '@sidequest/core';
import { QuestionnaireWizard } from '@/components/QuestionnaireWizard';
import { getAnswers, getTrip } from '@/lib/db/repository';
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

  // Resume from whatever was saved; otherwise start from defaults that already
  // reflect the needs captured on the basics screen.
  const saved = getAnswers(id);
  const initialAnswers = normalizeAnswers(saved ?? defaultAnswers(context), context);

  return <QuestionnaireWizard tripId={id} context={context} initialAnswers={initialAnswers} />;
}
