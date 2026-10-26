'use server';

import { revalidatePath } from 'next/cache';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { SIGNAL_STRENGTH, featureIsLearnable } from '@sidequest/core';
import { cookies } from 'next/headers';
import { currentUser, currentUserId } from '@/lib/auth/session';
import { AUTH_COOKIE } from '@/lib/auth/config';
import { DELETE_ALL_CONFIRMATION } from '@/lib/data-rights/confirmation';
import { anyTripBusy, deleteOwnerData, ownedTripIds } from '@/lib/db/data-rights-repository';
import { guardAction, presentedSessionToken, secureCookiesEnabled } from '@/lib/net/caller';
import { updateUserProfile } from '@/lib/db/auth-repository';
import { dismissFeature, restoreFeature } from '@/lib/db/execution-repository';
import { learnedWithDismissals, recordPreferenceEvidence } from '@/lib/db/preference-evidence-repository';

export type ProfileResult = { ok: true } | { ok: false; error: string };

const schema = z.object({
  displayName: z.string().trim().max(60),
  homeAirport: z.string().trim().max(12),
  usual: z
    .object({
      budgetStyle: z.string().max(40).optional(),
      pace: z.string().max(40).optional(),
      drives: z.boolean().optional(),
      foodNotes: z.string().max(400).optional(),
      lodgingNotes: z.string().max(400).optional(),
    })
    .optional(),
});

/**
 * V6 §45 — the signed-in travel profile: stable preferences the next trip
 * may carry forward, only when the traveller asks to ("Use my usual
 * preferences"), and never a hard constraint learned from anything but their
 * own words.
 */
export async function saveProfileAction(input: z.infer<typeof schema>): Promise<ProfileResult> {
  const user = await currentUser();
  if (!user) return { ok: false, error: 'Sign in to keep a travel profile.' };
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Something in that form was too long.' };
  updateUserProfile(user.id, {
    displayName: parsed.data.displayName || null,
    homeAirport: parsed.data.homeAirport.toUpperCase() || null,
    profile: { ...user.profile, usual: { ...(user.profile.usual as Record<string, unknown> | undefined), ...(parsed.data.usual ?? {}) } },
  });
  revalidatePath('/profile');
  return { ok: true };
}

/**
 * V9 §18 — "SIDEQUEST NOTICED", AND THE TRAVELLER'S TWO ANSWERS.
 *
 * Dismiss writes one row in `preference_dismissals`; from then on the leaning
 * never reaches a brief (`learnedForOwner` filters it) and it shows on the
 * profile as forgotten, with Restore beside it. Restore removes the row and
 * records an explicit confirmation on the ledger in the ledger's own
 * vocabulary (`recommendation_accepted`, source `explicit`, account scope):
 * the traveller asked for the leaning back, which is the strongest thing a
 * click can say about taste. Nothing here can touch a diet, a need or any
 * other feature the ledger refuses (`featureIsLearnable`).
 */
const featureSchema = z.string().trim().min(1).max(80);

export async function dismissLearnedAction(feature: string): Promise<ProfileResult> {
  const user = await currentUser();
  if (!user) return { ok: false, error: 'Sign in to change what Sidequest remembers.' };
  const parsed = featureSchema.safeParse(feature);
  if (!parsed.success || !featureIsLearnable(parsed.data)) return { ok: false, error: 'That is not something Sidequest learned.' };
  dismissFeature(user.id, parsed.data);
  revalidatePath('/profile');
  return { ok: true };
}

export async function restoreLearnedAction(feature: string): Promise<ProfileResult> {
  const user = await currentUser();
  if (!user) return { ok: false, error: 'Sign in to change what Sidequest remembers.' };
  const parsed = featureSchema.safeParse(feature);
  if (!parsed.success || !featureIsLearnable(parsed.data)) return { ok: false, error: 'That is not something Sidequest learned.' };
  restoreFeature(user.id, parsed.data);
  recordConfirmation(user.id, parsed.data, 'restored');
  revalidatePath('/profile');
  return { ok: true };
}

/** "That's right" on a noticed leaning: the same explicit confirmation, without a dismissal to undo. */
export async function confirmLearnedAction(feature: string): Promise<ProfileResult> {
  const user = await currentUser();
  if (!user) return { ok: false, error: 'Sign in to change what Sidequest remembers.' };
  const parsed = featureSchema.safeParse(feature);
  if (!parsed.success || !featureIsLearnable(parsed.data)) return { ok: false, error: 'That is not something Sidequest learned.' };
  recordConfirmation(user.id, parsed.data, 'confirmed');
  revalidatePath('/profile');
  return { ok: true };
}

function recordConfirmation(userId: string, feature: string, how: 'restored' | 'confirmed'): void {
  const known = learnedWithDismissals({ userId, ownerToken: null }).learned.find((p) => p.feature === feature);
  /* A confirmation agrees with the lean as it stands; with nothing learned there is nothing to agree with, and nothing is written. */
  if (!known) return;
  recordPreferenceEvidence([
    {
      id: randomUUID(),
      userId,
      ownerToken: null,
      travelerId: null,
      tripId: null,
      scope: 'account',
      signal: 'recommendation_accepted',
      feature,
      polarity: known.weight >= 0 ? 1 : -1,
      strength: SIGNAL_STRENGTH.recommendation_accepted,
      source: 'explicit',
      context: { surface: 'profile', how },
      createdAt: new Date().toISOString(),
    },
  ]);
}

/**
 * PRODUCTION PASS — "DELETE ALL MY DATA".
 *
 * Deletes everything the asker owns under the one ownership rule
 * (`lib/net/trip-access.ts`): every trip on the signed-in account and the
 * account itself (its sessions, people, evidence, saved ideas and dismissals
 * cascade), plus every *unclaimed* row the presented browser cookie made. A
 * trip on someone else's account is never reached through the cookie.
 *
 * Two steps: the page asks first, and this action refuses unless the typed
 * confirmation phrase arrives with it, so a stray POST cannot erase anything.
 * The browser keeps its anonymous cookie, which afterwards owns nothing; the
 * account cookie is cleared because the account is gone.
 */
export type DeleteAllResult = { ok: true; trips: number; account: boolean } | { ok: false; error: string };

export async function deleteAllMyDataAction(confirmation: string): Promise<DeleteAllResult> {
  const limited = await guardAction('data_rights');
  if (limited) return { ok: false, error: limited };
  if (typeof confirmation !== 'string' || confirmation.trim().toLowerCase() !== DELETE_ALL_CONFIRMATION) {
    return { ok: false, error: `Type “${DELETE_ALL_CONFIRMATION}” to confirm. Nothing was deleted.` };
  }
  const userId = await currentUserId();
  const ownerToken = await presentedSessionToken();
  if (!userId && !ownerToken) return { ok: true, trips: 0, account: false };
  const owner = { userId, ownerToken };
  if (anyTripBusy(ownedTripIds(owner))) {
    return { ok: false, error: 'One of your trips is being researched right now. Stop that build first, then try again. Nothing was deleted.' };
  }
  try {
    const report = deleteOwnerData(owner);
    if (report.account) {
      const jar = await cookies();
      jar.set(AUTH_COOKIE, '', { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 0, secure: secureCookiesEnabled() });
    }
    console.warn('[sidequest] data deletion', JSON.stringify({ kind: userId ? 'account' : 'browser', trips: report.trips, account: report.account }));
    revalidatePath('/', 'layout');
    return { ok: true, trips: report.trips, account: report.account };
  } catch (error) {
    console.error('Data deletion failed', { name: error instanceof Error ? error.name : 'Error' });
    return { ok: false, error: 'We could not delete your data just then. Nothing was deleted — try again.' };
  }
}
