'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { currentUser } from '@/lib/auth/session';
import { updateUserProfile } from '@/lib/db/auth-repository';

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
