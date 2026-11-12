import { buildTravelerProfile, countTripDays, defaultAnswers, type QuestionnaireAnswers, type TravelerProfile, type Trip, type TripComposerAnswers } from '@sidequest/core';

/**
 * THE PROFILE A TRIP HAS BEFORE THE INTERVIEW.
 *
 * A leaf module on purpose: the render path (itinerary page, calendar export,
 * trip hub) needs this and must not reach any module that can call a
 * provider or a model. See `render-purity.architecture.test.ts`.
 */
export function defaultProfileFor(trip: Trip, composer: TripComposerAnswers | null): TravelerProfile {
  const context = { travelerNeeds: trip.basics.travelerNeeds, tripDays: countTripDays(trip.basics.startDate, trip.basics.endDate) };
  const answers: QuestionnaireAnswers = { ...defaultAnswers(context) };
  if (composer?.pace === 'slow') answers.pace = 'slow';
  else if (composer?.pace === 'packed') answers.pace = 'fast';
  if (composer?.outdoorIntensity === 'gentle') answers.dailyIntensity = 'light';
  else if (composer?.outdoorIntensity === 'strenuous') answers.dailyIntensity = 'intense';
  /*
   * 2026-11 — the kind of trip, carried from "Help me choose". A restorative,
   * wellness or family trip starts slow and light unless the traveller said
   * otherwise: the eleven-day Kumano plan was built at a balanced pace for a
   * request about resting. Defaults only — every one is a question the
   * interview still asks and the traveller can change.
   */
  const restful = (composer?.discovery?.concept ?? []).filter((entry) => entry.key === 'restoration' || entry.key === 'wellness' || entry.key === 'family_bonding').reduce((sum, entry) => sum + entry.weight, 0);
  if (restful >= 0.5) {
    if (!composer?.pace) answers.pace = 'slow';
    if (!composer?.outdoorIntensity) answers.dailyIntensity = 'light';
  }
  if (composer?.transport === 'public_transport') answers.willDrive = false;
  if (composer?.maxDailyDriveMinutes !== undefined) {
    answers.maxDailyTravelMinutes = Math.max(30, Math.min(480, composer.maxDailyDriveMinutes));
  }
  if (composer?.budget === 'budget') answers.budgetStyle = 'budget';
  else if (composer?.budget === 'premium' || composer?.budget === 'luxury') answers.budgetStyle = 'premium';
  return buildTravelerProfile(answers, context);
}

