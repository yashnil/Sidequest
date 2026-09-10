'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { PreferenceEvidenceRow } from '@sidequest/core';
import { getDb } from '@/lib/db/client';
import { recordPreferenceEvidence } from '@/lib/db/preference-evidence-repository';
import { tripOwner } from '@/lib/db/repository';
import { tripAccessRefusal } from '@/lib/net/trip-access';

/**
 * V6 §46 — POST-TRIP FEEDBACK, LIGHTWEIGHT, FED TO THE EVIDENCE LEDGER.
 *
 * Six questions, none required. Loved and would-skip name features from the
 * trip's own vocabulary (categories the traveller ticks); pace and driving
 * become account-scoped leanings; the free text is kept on the feedback row
 * and never interpreted into a rule.
 */

const schema = z.object({
  loved: z.array(z.string().max(60)).max(12).default([]),
  skip: z.array(z.string().max(60)).max(12).default([]),
  pace: z.enum(['too_slow', 'right', 'too_fast']).optional(),
  driving: z.enum(['too_much', 'right', 'could_take_more']).optional(),
  surprised: z.string().max(400).optional(),
  budget: z.enum(['under', 'right', 'over']).optional(),
  notes: z.string().max(600).optional(),
});
export type FeedbackInput = z.infer<typeof schema>;

export type FeedbackResult = { ok: true } | { ok: false; error: string };

export async function submitFeedbackAction(tripId: string, input: FeedbackInput): Promise<FeedbackResult> {
  const refusal = await tripAccessRefusal(tripId);
  if (refusal) return { ok: false, error: refusal };
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Something in that was too long.' };
  const now = new Date();
  const owner = tripOwner(tripId);
  getDb().prepare('INSERT INTO trip_feedback (id, trip_id, payload_json, created_at) VALUES (?, ?, ?, ?)').run(randomUUID(), tripId, JSON.stringify(parsed.data), now.toISOString());
  const base = { userId: owner?.userId ?? null, ownerToken: owner?.userId ? null : (owner?.ownerToken ?? null), travelerId: null, tripId, scope: 'account' as const, source: 'post_trip' as const, context: {}, createdAt: now.toISOString() };
  const rows: Omit<PreferenceEvidenceRow, 'id'>[] = [
    ...parsed.data.loved.map((feature) => ({ ...base, signal: 'post_trip_loved' as const, feature: `theme:${feature.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`, polarity: 1 as const, strength: 1 })),
    ...parsed.data.skip.map((feature) => ({ ...base, signal: 'post_trip_skip' as const, feature: `theme:${feature.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`, polarity: -1 as const, strength: 1 })),
    ...(parsed.data.pace && parsed.data.pace !== 'right' ? [{ ...base, signal: 'post_trip_pace' as const, feature: 'pace:fast', polarity: (parsed.data.pace === 'too_slow' ? 1 : -1) as 1 | -1, strength: 0.9 }] : []),
    ...(parsed.data.driving && parsed.data.driving !== 'right' ? [{ ...base, signal: 'post_trip_pace' as const, feature: 'theme:driving', polarity: (parsed.data.driving === 'could_take_more' ? 1 : -1) as 1 | -1, strength: 0.9 }] : []),
  ];
  if (rows.length > 0) recordPreferenceEvidence(rows);
  revalidatePath(`/trips/${tripId}/feedback`);
  return { ok: true };
}
