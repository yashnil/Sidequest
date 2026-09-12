'use server';

import { z } from 'zod';
import { getTrip, revokeShareToken, rotateShareToken } from '@/lib/db/repository';
import { tripAccessRefusal } from '@/lib/net/trip-access';

/**
 * V9 §24 — REVOKE OR REPLACE A SHARE LINK.
 *
 * Both answer to the trip's ownership seam, like `createShareLinkAction`
 * beside them. Revoking sets the token to nothing — the old link then opens
 * the same 404 as a link that never existed. Rotating mints a fresh token in
 * the same statement that drops the old one, so no instant exists in which
 * both open the trip.
 */
const tripIdSchema = z.string().min(1).max(80);

export type RevokeShareResult = { ok: true; revoked: boolean } | { ok: false; error: string };
export type RotateShareResult = { ok: true; path: string } | { ok: false; error: string };

export async function revokeShareLinkAction(tripId: string): Promise<RevokeShareResult> {
  if (!tripIdSchema.safeParse(tripId).success || !getTrip(tripId)) return { ok: false, error: 'We could not find that trip any more.' };
  const refusal = await tripAccessRefusal(tripId);
  if (refusal) return { ok: false, error: refusal };
  return { ok: true, revoked: revokeShareToken(tripId) };
}

export async function rotateShareLinkAction(tripId: string): Promise<RotateShareResult> {
  if (!tripIdSchema.safeParse(tripId).success || !getTrip(tripId)) return { ok: false, error: 'We could not find that trip any more.' };
  const refusal = await tripAccessRefusal(tripId);
  if (refusal) return { ok: false, error: refusal };
  const token = rotateShareToken(tripId);
  if (!token) return { ok: false, error: 'We could not make a new link just then. The old one is unchanged.' };
  return { ok: true, path: `/share/${token}` };
}
