'use server';

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getDb } from '@/lib/db/client';
import { productEvent } from '@/lib/net/product-events';
import { tripAccessRefusal } from '@/lib/net/trip-access';

/**
 * PRIVATE ALPHA — "TELL US ABOUT THIS PLAN".
 *
 * One row in `trip_feedback` (the post-trip table, with `kind: 'alpha'`): a
 * category, optionally the day and the place it is about, and an optional
 * comment. Nothing else from the trip or the profile is copied in — the row
 * points at the trip, and the trip is where the context lives. Owner only, like
 * every other write.
 */
/* Not exported: a 'use server' module may export async functions only. */
const ALPHA_FEEDBACK_CATEGORIES = ['useful', 'too_packed', 'wrong_recommendation', 'missing_place', 'outdated', 'bug'] as const;

const schema = z.object({
  category: z.enum(ALPHA_FEEDBACK_CATEGORIES),
  dayNumber: z.number().int().min(1).max(60).nullable().optional(),
  place: z.string().trim().max(120).optional(),
  comment: z.string().trim().max(1000).optional(),
});

export type AlphaFeedbackResult = { ok: true } | { ok: false; error: string };

export async function submitAlphaFeedbackAction(tripId: string, input: unknown): Promise<AlphaFeedbackResult> {
  const refusal = await tripAccessRefusal(tripId);
  if (refusal) return { ok: false, error: refusal };
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Pick what this is about; the comment can be up to 1,000 characters.' };
  const now = new Date();
  try {
    getDb()
      .prepare('INSERT INTO trip_feedback (id, trip_id, payload_json, created_at) VALUES (?, ?, ?, ?)')
      .run(randomUUID(), tripId, JSON.stringify({ kind: 'alpha', ...parsed.data }), now.toISOString());
  } catch {
    return { ok: false, error: 'We could not save that just now. Nothing was lost on the trip — try again.' };
  }
  productEvent('feedback_submitted', tripId, { category: parsed.data.category, day: parsed.data.dayNumber ?? null, hasComment: Boolean(parsed.data.comment) });
  return { ok: true };
}
