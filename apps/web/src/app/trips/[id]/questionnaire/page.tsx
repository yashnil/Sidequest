import { notFound } from 'next/navigation';
import { countTripDays, defaultAnswers, normalizeAnswers } from '@sidequest/core';
import { QuestionnaireWizard } from '@/components/QuestionnaireWizard';
import { getAnswers, getTrip } from '@/lib/db/repository';

export const dynamic = 'force-dynamic';

export default async function QuestionnairePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const trip = getTrip(id);
  if (!trip) notFound();

  const context = {
    travelerNeeds: trip.basics.travelerNeeds,
    tripDays: countTripDays(trip.basics.startDate, trip.basics.endDate),
  };

  // Resume from whatever was saved; otherwise start from defaults that already
  // reflect the needs captured on the basics screen.
  const saved = getAnswers(id);
  const initialAnswers = normalizeAnswers(saved ?? defaultAnswers(context), context);

  return <QuestionnaireWizard tripId={id} context={context} initialAnswers={initialAnswers} />;
}
