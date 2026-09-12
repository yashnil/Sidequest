'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { FactObservation } from '@sidequest/core';
import { acknowledgeObservation, listObservations } from '@/lib/db/execution-repository';
import { tripAccessRefusal } from '@/lib/net/trip-access';
import { recheckStaleFacts, type RecheckOutcome } from './recheck';

/**
 * V9 §9 — THE TWO DOORS THE FRESHNESS BANNER PRESSES.
 *
 * Both start with the trip's ownership seam. The recheck is the one V9 path
 * that may reach a provider, and it may because a client effect asked on the
 * owner's own page — the shared copy never mounts the banner, so a reader
 * with a link can never spend a request on somebody else's trip.
 */
const tripIdSchema = z.string().min(1).max(80);
const observationIdSchema = z.string().min(1).max(80);

export type RecheckActionResult = { ok: true; outcome: RecheckOutcome; observations: FactObservation[] } | { ok: false; error: string };

export async function recheckStaleFactsAction(tripId: string): Promise<RecheckActionResult> {
  if (!tripIdSchema.safeParse(tripId).success) return { ok: false, error: 'We could not find that trip.' };
  const refusal = await tripAccessRefusal(tripId);
  if (refusal) return { ok: false, error: refusal };
  try {
    const outcome = await recheckStaleFacts(tripId);
    /* The full open list, not only what this run wrote: an earlier run's unacknowledged change is still a change. */
    const observations = listObservations(tripId).filter((o) => o.changed && !o.acknowledgedAt);
    if (outcome.ran && outcome.counts.changed > 0) revalidatePath(`/trips/${tripId}/itinerary`);
    return { ok: true, outcome, observations };
  } catch (error) {
    console.error('Recheck failed', { tripId, message: error instanceof Error ? error.message : 'unknown' });
    return { ok: false, error: 'We could not check for changes just now. Your plan is unchanged.' };
  }
}

export type AcknowledgeResult = { ok: true } | { ok: false; error: string };

export async function acknowledgeChangeAction(tripId: string, observationId: string): Promise<AcknowledgeResult> {
  if (!tripIdSchema.safeParse(tripId).success || !observationIdSchema.safeParse(observationId).success) return { ok: false, error: 'We could not find that change.' };
  const refusal = await tripAccessRefusal(tripId);
  if (refusal) return { ok: false, error: refusal };
  acknowledgeObservation(tripId, observationId);
  revalidatePath(`/trips/${tripId}/itinerary`);
  return { ok: true };
}
