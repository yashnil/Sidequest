'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { type BuildResult, buildItinerary } from '@/lib/planning/build';

export type { BuildResult } from '@/lib/planning/build';

/**
 * Builds and stores the itinerary, then navigates to it.
 *
 * The work moved to `@/lib/planning/build` so that exactly one sequence turns a
 * trip into a plan — see the note there. What stays here is the pair of things
 * only a browser needs: the cache invalidation, and the navigation. Both happen
 * strictly after the plan is safely written, and neither happens at all when it
 * was not.
 */
export async function buildItineraryAction(tripId: string): Promise<BuildResult> {
  const result = await buildItinerary(tripId);
  if (!result.ok) return result;

  revalidatePath(`/trips/${tripId}/itinerary`);
  // `redirect` throws, so nothing below it runs and the caller never sees this
  // return. It is here because a function typed as returning a result should
  // not rely on a thrown control-flow signal to satisfy its own signature.
  redirect(`/trips/${tripId}/itinerary`);
  return result;
}
