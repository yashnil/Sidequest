'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import {
  buildDiscoveryBoard,
  EASTERN_SIERRA_BASE_ID,
  EASTERN_SIERRA_PLACES,
  easternSierraTravelMatrix,
  REGIONS,
  tripMonths,
} from '@sidequest/core';
import { planTrip } from '@sidequest/planner';
import { getProfile, getSelections, getTrip, saveItinerary } from '@/lib/db/repository';

export interface BuildResult {
  ok: boolean;
  error?: string;
}

/**
 * Builds and stores the itinerary, then navigates to it.
 *
 * Nothing here claims success it did not achieve: planning failures and
 * persistence failures both return a message and stay on the board. The redirect
 * only happens after the plan is safely written.
 */
export async function buildItineraryAction(tripId: string): Promise<BuildResult> {
  const trip = getTrip(tripId);
  if (!trip) return { ok: false, error: 'We could not find that trip any more.' };

  const profile = getProfile(tripId);
  if (!profile) {
    return { ok: false, error: 'Finish the questionnaire first — we need your profile to plan around.' };
  }

  const region = REGIONS.find((item) => item.id === trip.basics.regionId);
  if (!region) return { ok: false, error: 'We do not have that region mapped.' };

  const selections = getSelections(tripId);
  if (selections.filter((entry) => entry.status !== 'excluded').length === 0) {
    return {
      ok: false,
      error: 'Nothing is marked to include yet. Pick a few places, or use auto-pick, then try again.',
    };
  }

  try {
    const board = buildDiscoveryBoard({
      region,
      places: EASTERN_SIERRA_PLACES,
      profile,
      months: tripMonths(trip.basics.startDate, trip.basics.endDate),
      travelerNeeds: trip.basics.travelerNeeds,
    });

    const result = planTrip({
      tripId,
      basics: trip.basics,
      profile,
      region,
      candidates: board.candidates,
      selections,
      matrix: easternSierraTravelMatrix(),
      baseId: EASTERN_SIERRA_BASE_ID,
    });

    if (!result.ok) {
      return { ok: false, error: planFailureCopy(result.code, result.message) };
    }

    saveItinerary(result.itinerary);
  } catch (error) {
    console.error('Failed to build itinerary', error);
    return {
      ok: false,
      error: 'We built a plan but could not save it. Nothing was lost — try again.',
    };
  }

  revalidatePath(`/trips/${tripId}/itinerary`);
  redirect(`/trips/${tripId}/itinerary`);
}

function planFailureCopy(code: string, message: string): string {
  switch (code) {
    case 'no_candidates':
      return 'Nothing on your board can be planned yet. Include a few places and try again.';
    case 'matrix_unusable':
      return `We do not have usable travel times for this region, so we will not guess at a plan. ${message}`;
    case 'no_usable_days':
      return 'Those dates do not contain a usable day. Check your arrival and departure times.';
    default:
      return message;
  }
}
