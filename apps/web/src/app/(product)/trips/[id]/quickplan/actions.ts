'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { generateSidequestPlanForTrip } from '@/lib/planning/production-plan';
import { tripAccessRefusal } from '@/lib/net/trip-access';

/**
 * Quick Plan — "plan what you think is right for me" from destination, dates
 * and travellers alone. The SAME canonical architecture as "Build my trip"
 * (`generateSidequestPlanForTrip`), configured lighter: no Discovery Board
 * signals, a default profile when the questionnaire was skipped, a shorter
 * verification deadline. It lands on the same itinerary page, so nothing a
 * traveller sees depends on which button they pressed.
 */
export async function buildQuickPlanAction(tripId: string): Promise<{ ok: boolean; error?: string }> {
  const refusal = await tripAccessRefusal(tripId);
  if (refusal) return { ok: false, error: refusal };

  const result = await generateSidequestPlanForTrip(tripId, { caller: 'quick_plan_action', mode: 'quick' });
  if (!result.ok) return { ok: false, error: result.error ?? 'We could not compose your trip just then.' };

  revalidatePath(`/trips/${tripId}/itinerary`);
  revalidatePath(`/trips/${tripId}/quickplan`);
  redirect(`/trips/${tripId}/itinerary`);
}
