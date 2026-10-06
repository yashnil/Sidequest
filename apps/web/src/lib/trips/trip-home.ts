/**
 * WHERE "BACK TO THIS TRIP" GOES.
 *
 * The edit page sent it to `/trips/[id]/plan`, which is the research path's
 * screen and bounces a trip that never took that path — so "Back to this
 * trip" landed somewhere else. A trip's home is its itinerary when one has
 * been built, and the interview (which shows the review once answered)
 * when not.
 */
export function tripHomeHref(tripId: string, hasPlan: boolean): string {
  return hasPlan ? `/trips/${tripId}/itinerary` : `/trips/${tripId}/questionnaire`;
}
