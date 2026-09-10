'use server';

import { redirect } from 'next/navigation';
import { z } from 'zod';
import { authProviders } from '@/lib/auth/config';
import { safeReturnTo } from '@/lib/auth/google';
import { currentUser, signInUser, signOutUser } from '@/lib/auth/session';
import { claimBrowserResources, countUnclaimedTrips, upsertUser } from '@/lib/db/auth-repository';
import { guardAction, sessionToken } from '@/lib/net/caller';

/**
 * THE SIGN-IN DOORS THAT ARE SERVER ACTIONS.
 *
 * Google is a redirect dance and lives under `/api/auth/google`; the fixture
 * door and sign-out are plain actions. Both are rate-fenced like every other
 * pre-trip door, because there is no trip to own yet.
 */

export type SignInResult = { ok: true; href: string } | { ok: false; error: string };

const fixtureSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(200),
  name: z.string().trim().max(60).optional(),
  returnTo: z.string().max(400).optional(),
});

/**
 * The fixture door: an email, no password. Refused unless the deployment
 * opened it (`SIDEQUEST_AUTH_PROVIDER=fixture`, never in production without
 * `SIDEQUEST_AUTH_FIXTURE=allow`). Exists so the browser suite can prove the
 * ownership boundary between two real accounts.
 */
export async function fixtureSignInAction(input: { email: string; name?: string; returnTo?: string }): Promise<SignInResult> {
  if (!authProviders().fixture) return { ok: false, error: 'Sign-in is not available on this deployment.' };
  const limited = await guardAction('trip_create');
  if (limited) return { ok: false, error: limited };
  const parsed = fixtureSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'That does not look like an email address.' };
  const user = upsertUser({ provider: 'fixture', subject: parsed.data.email, email: parsed.data.email, emailVerified: false, displayName: parsed.data.name ?? parsed.data.email.split('@')[0] ?? null });
  await signInUser(user.id);
  return { ok: true, href: safeReturnTo(parsed.data.returnTo) };
}

export async function signOutAction(): Promise<void> {
  await signOutUser();
  redirect('/');
}

export type ClaimResult = { ok: true; trips: number; travelers: number } | { ok: false; error: string };

/**
 * "Save your trips to your account." Moves everything THIS browser's cookie
 * owns and nobody has claimed onto the signed-in account, in one transaction.
 * Another browser's trips cannot be named by this statement, so they cannot
 * be claimed.
 */
export async function claimBrowserTripsAction(): Promise<ClaimResult> {
  const user = await currentUser();
  if (!user) return { ok: false, error: 'Sign in first, then save your trips.' };
  const token = await sessionToken({ mint: false });
  if (!token) return { ok: true, trips: 0, travelers: 0 };
  const moved = claimBrowserResources(user.id, token);
  return { ok: true, trips: moved.trips, travelers: moved.travelers };
}

/** How many unclaimed trips this browser holds — the number the offer shows. */
export async function unclaimedTripCountAction(): Promise<number> {
  const token = await sessionToken({ mint: false });
  return countUnclaimedTrips(token);
}
