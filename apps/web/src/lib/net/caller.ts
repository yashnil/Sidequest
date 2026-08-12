import 'server-only';
import { randomUUID } from 'node:crypto';
import { cookies, headers } from 'next/headers';
import {
  ACTION_RATE_RULES,
  deploymentBusyCopy,
  peekActionTokens,
  rateLimitedCopy,
  takeActionTokens,
  type ActionRateDecision,
  type GuardedActionKind,
} from './rate-limit';

/**
 * WHO IS ASKING, AND HOW MUCH OF THAT WE ARE ENTITLED TO BELIEVE.
 *
 * This used to be a private helper inside `plan/actions.ts`, and it derived the
 * caller's address from `x-forwarded-for`'s **leftmost** element. A review
 * pointed out what that means: the leftmost element of that header is by
 * definition what the client sent — conforming proxies *append* their own
 * observation on the right — so it is attacker-controlled in every topology,
 * not only proxy-less ones. Two header lines bought a virgin bucket, and the
 * second identity (a cookie) is discardable for free, so both fences that
 * claimed "an abuser has to beat both" were the same input.
 *
 * The honest position is that a deployment with nothing in front of it cannot
 * attribute a request to a network peer at all — the app router exposes no
 * socket address — so this module refuses to pretend:
 *
 * - **With `SIDEQUEST_TRUSTED_PROXY_HOPS` set**, the address is taken from the
 *   right of `x-forwarded-for`, counting past exactly that many trusted hops.
 *   That value is written by infrastructure the operator controls and cannot be
 *   pushed leftwards by the client.
 * - **Without it**, there is no address identity. Not a spoofable one: none.
 *
 * What holds when identity is worthless is the *unconditional* fence in
 * `rate-limit`: a deployment-wide bucket per action kind that no amount of
 * header or cookie rotation escapes, sized for a whole deployment rather than
 * for one person. Rotation now buys nothing rather than everything.
 *
 * The session cookie stays, because it is the fence that keeps one ordinary
 * traveller from being throttled by another behind the same NAT, and it is the
 * same cookie trip ownership is keyed on. It is never treated as proof of
 * anything.
 */

/** One cookie for the two things that need a per-browser identity. */
export const SESSION_COOKIE = 'sidequest_session';

/** How many hops of `x-forwarded-for` this deployment's own edge appends. */
function trustedProxyHops(): number {
  const raw = process.env.SIDEQUEST_TRUSTED_PROXY_HOPS?.trim();
  if (!raw) return 0;
  const value = Number(raw);
  // Garbage reads as "no trusted proxy", never as "trust the client".
  if (!Number.isFinite(value) || value < 1) return 0;
  return Math.floor(value);
}

/**
 * The address this deployment can actually stand behind, or null.
 *
 * Counting from the right is the whole point. With one trusted hop the last
 * value was written by our own proxy about the peer it saw; with two, the last
 * was written by our proxy about the next proxy, and the one before it is the
 * peer. A client can prepend as many values as it likes and never reach these
 * positions.
 */
export async function callerAddress(): Promise<string | null> {
  const hops = trustedProxyHops();
  if (hops === 0) return null;
  try {
    const requestHeaders = await headers();
    const chain = (requestHeaders.get('x-forwarded-for') ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    const address = chain[chain.length - hops];
    return address && address.length <= 64 ? address : null;
  } catch {
    return null;
  }
}

/**
 * The browser's session token: read, and minted on first contact when the
 * caller is somewhere a cookie can be written.
 *
 * `mint: false` for anything that renders — a server component cannot set a
 * cookie, and asking it to throws. Actions mint; pages read.
 */
export async function sessionToken({ mint }: { mint: boolean }): Promise<string | null> {
  try {
    const jar = await cookies();
    const existing = jar.get(SESSION_COOKIE)?.value?.slice(0, 64);
    if (existing) return existing;
    if (!mint) return null;

    const minted = randomUUID();
    try {
      jar.set(SESSION_COOKIE, minted, { httpOnly: true, sameSite: 'lax', path: '/' });
    } catch {
      // Read-only cookie context. The token is still returned, because the
      // caller may only need it for this request; nothing depends on it having
      // been persisted.
    }
    return minted;
  } catch {
    // Outside a request scope: a test, a worker, an internal caller.
    return null;
  }
}

/**
 * Every identity worth holding a separate bucket for, most specific first.
 *
 * May be empty, and an empty list is a real answer rather than a failure: it
 * means nothing about this request can be attributed, and the deployment-wide
 * fence is what bounds it.
 */
export async function requestIdentities(): Promise<string[]> {
  const identities: string[] = [];
  const address = await callerAddress();
  if (address) identities.push(`ip:${address}`);
  const session = await sessionToken({ mint: true });
  if (session) identities.push(`session:${session}`);
  return identities;
}

/**
 * The key a day's spend is attributed to.
 *
 * The address when the infrastructure vouches for one, the session cookie
 * otherwise, and null when neither exists. Null matters: with no key the daily
 * ledger applies only its global ceiling, which is the honest behaviour —
 * minting an identity per request would hand every request a fresh personal
 * allowance, which is worse than having none.
 */
export async function callerKey(): Promise<string | null> {
  const address = await callerAddress();
  if (address) return `ip:${address}`;
  const session = await sessionToken({ mint: true });
  return session ? `session:${session}` : null;
}

/**
 * The limiter, as one line per guarded action. Returns the traveller's
 * sentence when the action must wait, null when it may run.
 */
export async function guardAction(kind: GuardedActionKind): Promise<string | null> {
  return refusalFor(takeActionTokens(kind, await requestIdentities(), ACTION_RATE_RULES[kind]));
}

/**
 * ASK WITHOUT PAYING, FOR THE ACTION WHOSE WORK IS CLAIMED BY A LEASE.
 *
 * `readUnresolvedTextAction` is the odd one out: fifty concurrent presses on
 * the same reading buy exactly one provider call, because a lease settles who
 * calls and everybody else replays the winner's answer for free. Taking a token
 * per press would refuse most of those travellers to protect a spend that was
 * never going to happen — the same mistake as throttling a cache hit, which
 * this codebase already refuses to do for the preflight.
 *
 * So that action checks here first, and the one invocation that wins the lease
 * calls `chargeAction` on the way to the provider. Two calls rather than one,
 * and the seam between them is exactly the seam between "may I" and "I did".
 */
export async function checkAction(kind: GuardedActionKind): Promise<string | null> {
  return refusalFor(peekActionTokens(kind, await requestIdentities(), ACTION_RATE_RULES[kind]));
}

/** Take the token for work that is definitely happening. */
export async function chargeAction(kind: GuardedActionKind): Promise<void> {
  takeActionTokens(kind, await requestIdentities(), ACTION_RATE_RULES[kind]);
}

/** The traveller's sentence for whichever fence answered. */
function refusalFor(decision: ActionRateDecision): string | null {
  if (decision.allowed) return null;
  return decision.scope === 'deployment'
    ? deploymentBusyCopy(decision.retryAfterSeconds)
    : rateLimitedCopy(decision.retryAfterSeconds);
}
