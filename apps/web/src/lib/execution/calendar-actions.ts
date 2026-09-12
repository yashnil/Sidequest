'use server';

import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { activeCalendarFeed, createCalendarFeed, revokeCalendarFeeds } from '@/lib/db/execution-repository';
import { tripAccessRefusal } from '@/lib/net/trip-access';

/**
 * V9 §10 — THE CALENDAR SUBSCRIPTION, CREATED AND REVOKED BY ITS OWNER.
 *
 * Creating a feed mints 32 random bytes, stores their SHA-256 and returns the
 * plaintext exactly once — the Pack shows it, the traveller pastes it into a
 * calendar, and no later screen can show it again (regenerate instead, which
 * revokes the old one). Revoking makes every copy of the old URL answer "No
 * such calendar." on the next refresh. Both doors start with the ownership
 * guard, like every trip action.
 */
export type CalendarFeedResult =
  | { ok: true; path: string; url: string | null; webcal: string | null; createdAt: string }
  | { ok: false; error: string };

export type CalendarFeedRevokeResult = { ok: true; revoked: number } | { ok: false; error: string };

export type CalendarFeedStatus = { ok: true; active: { createdAt: string; lastServedAt: string | null } | null } | { ok: false; error: string };

/**
 * The origin a feed URL is completed with: the deployment's own base URL when
 * it is configured, else what the request said. Null when neither is known
 * (a test, a worker) — the client then completes it from its own location.
 */
async function requestOrigin(): Promise<string | null> {
  const configured = process.env.SIDEQUEST_BASE_URL?.trim().replace(/\/+$/, '');
  if (configured) return configured;
  try {
    const list = await headers();
    const host = list.get('x-forwarded-host') ?? list.get('host');
    if (!host) return null;
    const proto = list.get('x-forwarded-proto') ?? (host.startsWith('localhost') || host.startsWith('127.') ? 'http' : 'https');
    return `${proto}://${host}`;
  } catch {
    return null;
  }
}

export async function createCalendarFeedAction(tripId: string): Promise<CalendarFeedResult> {
  const refusal = await tripAccessRefusal(tripId);
  if (refusal) return { ok: false, error: refusal };
  const now = new Date();
  const feed = createCalendarFeed(tripId, now);
  const path = `/api/calendar/${feed.token}`;
  const origin = await requestOrigin();
  const url = origin ? `${origin}${path}` : null;
  revalidatePath(`/trips/${tripId}/pack`);
  return { ok: true, path, url, webcal: url ? url.replace(/^https?:\/\//, 'webcal://') : null, createdAt: now.toISOString() };
}

export async function revokeCalendarFeedAction(tripId: string): Promise<CalendarFeedRevokeResult> {
  const refusal = await tripAccessRefusal(tripId);
  if (refusal) return { ok: false, error: refusal };
  const revoked = revokeCalendarFeeds(tripId);
  revalidatePath(`/trips/${tripId}/pack`);
  return { ok: true, revoked };
}

/** Whether a live subscription exists — never the URL, which was shown once. */
export async function calendarFeedStatusAction(tripId: string): Promise<CalendarFeedStatus> {
  const refusal = await tripAccessRefusal(tripId);
  if (refusal) return { ok: false, error: refusal };
  return { ok: true, active: activeCalendarFeed(tripId) };
}
