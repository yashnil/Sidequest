import 'server-only';
import { resolveParty, type SavedPartyHint } from '@sidequest/core';
import { currentUserId } from '@/lib/auth/session';
import { sessionToken } from '@/lib/net/caller';
import { listTravelers } from '@/lib/db/party-repository';

/**
 * WHAT IS ALREADY KNOWN ABOUT WHO TRAVELS WITH THIS PERSON.
 *
 * The people the account (or, unclaimed, this browser) has already described
 * on the party screen. Read only to avoid asking a question somebody has
 * answered before; never written from here. A store that cannot be read is a
 * store with nobody in it — the door then asks, which is the safe failure.
 */
export async function savedPartyHint(): Promise<SavedPartyHint | null> {
  try {
    const owner = { userId: await currentUserId(), ownerToken: await sessionToken({ mint: false }) };
    if (!owner.userId && !owner.ownerToken) return null;
    const travellers = listTravelers(owner);
    return travellers.length > 0 ? { travellers: travellers.map((t) => ({ ageGroup: t.ageGroup ?? null })) } : null;
  } catch {
    return null;
  }
}

/** The party a door should start from: their words, then their saved travellers, else an assumption that says so. */
export async function knownPartyFor(texts: readonly (string | null | undefined)[]) {
  return resolveParty({ texts, saved: await savedPartyHint() });
}
