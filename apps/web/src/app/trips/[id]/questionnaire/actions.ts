'use server';

import { redirect } from 'next/navigation';
import {
  autoSelect,
  buildTravelerProfile,
  countTripDays,
  questionnaireAnswersSchema,
  validatedQuestionnaireAnswersSchema,
  type QuestionnaireAnswers,
} from '@sidequest/core';
import {
  clearItinerary,
  getTrip,
  replaceAutoSelections,
  saveAnswers,
  saveProfile,
} from '@/lib/db/repository';
import { boardFor, resolveTripRegion } from '@/lib/region';

export interface SaveResult {
  ok: boolean;
  error?: string;
}

/**
 * Called as the traveller moves between steps so a refresh — or a closed laptop —
 * does not throw away half a questionnaire.
 */
export async function saveDraftAction(
  tripId: string,
  answers: QuestionnaireAnswers,
): Promise<SaveResult> {
  const parsed = questionnaireAnswersSchema.safeParse(answers);
  if (!parsed.success) {
    return { ok: false, error: 'Those answers did not look right, so we did not save them.' };
  }
  try {
    if (!getTrip(tripId)) return { ok: false, error: 'We could not find that trip any more.' };
    saveAnswers(tripId, parsed.data);
    return { ok: true };
  } catch (error) {
    console.error('Failed to save questionnaire draft', error);
    return { ok: false, error: 'We could not save your progress just then. Your answers are still here — try again.' };
  }
}

export async function completeQuestionnaireAction(
  tripId: string,
  answers: QuestionnaireAnswers,
): Promise<SaveResult> {
  const trip = getTrip(tripId);
  if (!trip) return { ok: false, error: 'We could not find that trip any more.' };

  const parsed = validatedQuestionnaireAnswersSchema.safeParse(answers);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? 'Something in the questionnaire is incomplete.',
    };
  }

  try {
    const tripDays = countTripDays(trip.basics.startDate, trip.basics.endDate);
    const profile = buildTravelerProfile(parsed.data, {
      travelerNeeds: trip.basics.travelerNeeds,
      tripDays,
    });
    saveProfile(tripId, parsed.data, profile);
    // The stored plan was built from the answers that have just been replaced.
    // Keeping it would show a transport strategy derived from a profile that no
    // longer exists, with nothing to say so.
    clearItinerary(tripId);

    // Seed the board with a balanced starting set so the traveller arrives at
    // something to confirm rather than an empty grid to work through. Done here,
    // on the write that finishes the questionnaire, rather than as a side effect
    // of rendering the board. Re-running the questionnaire re-seeds it, and any
    // card the traveller had already decided by hand is left alone.
    const resolved = await resolveTripRegion(trip);
    if (resolved.ok) {
      const board = boardFor(trip, profile, resolved.context);
      const selection = autoSelect({ candidates: board.candidates, profile, tripDays });
      replaceAutoSelections(tripId, selection.selectedIds);
    }
  } catch (error) {
    console.error('Failed to save traveler profile', error);
    return { ok: false, error: 'We could not save your profile. Nothing was lost — try again.' };
  }

  redirect(`/trips/${tripId}/discover`);
}
