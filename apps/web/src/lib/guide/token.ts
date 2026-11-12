import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { sessionSigningKey } from '@/lib/net/session-signature';
import type { GuideVariant } from './model';

/**
 * A SHORT-LIVED PASS FOR THE PDF RENDERER, AND FOR NOTHING ELSE.
 *
 * The renderer is a headless browser with no cookie jar, so it cannot prove it
 * is the trip's owner. The web app — which has just checked the owner — mints
 * this token for exactly one trip, one variant and five minutes, and the print
 * route accepts it in place of the owner check. It opens the print layout only:
 * no other page, no action and no API reads it.
 *
 * Signed with a key derived from the session signing key, so there is no new
 * secret to provision and a token cannot be replayed as a session.
 */
export const GUIDE_TOKEN_TTL_MS = 5 * 60_000;

function key(): string | null {
  const base = sessionSigningKey();
  return base ? createHmac('sha256', base).update('sidequest.guide-render.v1').digest('hex') : null;
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export function mintGuideToken(tripId: string, variant: GuideVariant, now = Date.now()): string | null {
  const secret = key();
  if (!secret) return null;
  const payload = Buffer.from(JSON.stringify({ t: tripId, v: variant, e: now + GUIDE_TOKEN_TTL_MS })).toString('base64url');
  return `${payload}.${sign(payload, secret)}`;
}

/** True only for an unexpired token minted for this trip and this variant. */
export function verifyGuideToken(token: string | null | undefined, tripId: string, variant: GuideVariant, now = Date.now()): boolean {
  if (!token || token.length > 512) return false;
  const secret = key();
  if (!secret) return false;
  const cut = token.lastIndexOf('.');
  if (cut <= 0) return false;
  const payload = token.slice(0, cut);
  const expected = Buffer.from(sign(payload, secret));
  const given = Buffer.from(token.slice(cut + 1));
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return false;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { t?: unknown; v?: unknown; e?: unknown };
    return parsed.t === tripId && parsed.v === variant && typeof parsed.e === 'number' && parsed.e > now;
  } catch {
    return false;
  }
}
