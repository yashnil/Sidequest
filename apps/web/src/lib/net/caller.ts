import 'server-only';
import { randomUUID } from 'node:crypto';
import { cookies, headers } from 'next/headers';
import { isSignedSessionToken, mintSessionToken } from './session-signature';
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

/**
 * HOW LONG AN ANONYMOUS TRAVELLER GOES ON OWNING THEIR OWN TRIPS.
 *
 * This cookie was minted with no lifetime and no expiry, which makes it a
 * *session* cookie: the browser drops it when it quits. There are no accounts
 * in this product, and `trips.owner_token` is this value and nothing else, so
 * quitting the browser did not sign anybody out — it destroyed the only claim
 * they had. Every trip they had made became a row nobody can reach:
 * `tripAccessRefusal` refuses it, `listTrips` lists it to nobody, and there is
 * no recovery path because there is nothing to recover *to*. A compilation is
 * minutes of work and real money, and an ordinary browser quit was throwing it
 * away.
 *
 * A hundred and eighty days, because the horizon this has to cover is a trip:
 * people plan months before they leave, and the plan has to still be theirs
 * while they are standing in the destination reading it. Bounded rather than
 * indefinite — a cookie that never expires on a product that asks for no
 * account is a tracking identifier, whatever it was minted for — and inside the
 * 400-day ceiling browsers clamp cookie lifetimes to, so what is asked for is
 * what is stored rather than something quietly shorter.
 */
export const SESSION_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 180;

/**
 * WHETHER THE ONE OWNERSHIP CREDENTIAL MAY CROSS PLAINTEXT.
 *
 * Minted without `Secure`, this cookie is sent on any http request to the host
 * and can be *written* by anyone who can answer one. For a value that is the
 * whole of trip ownership, that is the boundary itself travelling in the clear.
 *
 * Production is told from development the way `next.config.ts` already tells
 * them apart and by nothing else: `NODE_ENV`. That file's unconditional HSTS
 * header states the same assumption — a deployment is served over TLS.
 *
 * `NODE_ENV` alone is not enough here, and the gap is not hypothetical.
 * `next start` runs at NODE_ENV=production, and `playwright.config.ts` starts
 * exactly that on `http://127.0.0.1`: a production build over plaintext, where
 * a `Secure` cookie survives only by a browser's loopback-is-trustworthy
 * policy, which is not something this repository controls. Every trip-owning
 * journey in that suite rides on this cookie, so the one environment that
 * serves a production build without TLS pins the attribute down, on the same
 * bargain and with the same exact-string comparison as
 * `SIDEQUEST_ACTION_FENCES=off`: any other value, including a blank or a typo,
 * leaves `Secure` on, so a deployment cannot drift into plaintext by accident.
 */
export function secureCookiesEnabled(): boolean {
  if (process.env.SIDEQUEST_SECURE_COOKIES === 'off') return false;
  return process.env.NODE_ENV === 'production';
}

/**
 * The attributes the credential is written with, as a function of the
 * environment rather than of the ambient one — the same reason `securityHeaders`
 * in `next.config.ts` takes its environment as an argument: the production shape
 * is then assertable without booting a server.
 *
 * `httpOnly` because nothing in the browser reads this value; it exists to be
 * compared server-side against `trips.owner_token`. `sameSite: 'lax'` because
 * the trip surfaces are reached by ordinary top-level navigation — a
 * `/trips/{id}` link opened from a mail client must still arrive carrying the
 * owner's cookie, or the owner is refused their own trip — while the mutating
 * actions, which are cross-site POSTs when they are forged, are not.
 */
export function sessionCookieOptions(options: { secure: boolean }) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: SESSION_COOKIE_MAX_AGE_SECONDS,
    secure: options.secure,
  };
}

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

    const minted = mintSessionToken(randomUUID());
    try {
      jar.set(SESSION_COOKIE, minted, sessionCookieOptions({ secure: secureCookiesEnabled() }));
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
  /*
   * THE RAW COOKIE, DELIBERATELY, AND ONLY HERE.
   *
   * A rate bucket is a *restriction*: the worst a forged or rotated value can
   * do is fall back to the deployment-wide fence, which is exactly where a
   * caller presenting no cookie at all already is. Refusing to key a bucket on
   * an unsigned value would throttle nobody it does not already throttle and
   * would stop throttling the naive case, so this reads whatever the browser
   * presented.
   *
   * `callerKey` is the opposite case and takes the opposite decision: a
   * per-caller row on the daily ledger is a *grant*, so it must never be opened
   * by a value the client chose.
   *
   * What it does *not* do is mint. A bucket keyed on a token the server just
   * created is a fresh bucket on every request from a caller who never keeps a
   * cookie, which is a fence that opens for the one caller it is for. Nothing
   * is lost by reading only: a request with no cookie has no per-caller bucket
   * and is bounded by the deployment-wide fence, which is where it already was.
   */
  const session = await presentedSessionToken();
  if (session) identities.push(`session:${session}`);
  return identities;
}

/**
 * THE SESSION TOKEN, BUT ONLY WHERE THIS DEPLOYMENT ISSUED IT.
 *
 * The one seam between "who owns this trip" and "whose allowance is this".
 * Ownership compares the whole cookie against a stored token and is safe with a
 * value nobody issued, because such a value matches nothing. A *budget* keyed
 * on the same unverified value is not safe at all: the cookie is written by the
 * client, so sending a fresh random string on every request opened a fresh
 * per-caller bucket on every request and the per-caller ceiling — the control
 * that stops one visitor draining the deployment's day — cost nothing to
 * evade.
 *
 * A token whose signature does not verify is not treated as a different
 * identity; it is treated as **no identity**, which puts it in the shared
 * unattributed pool beside every caller who declines the cookie. So rotating
 * buys the pool rather than a personal allowance, declining still works, and an
 * ordinary browser that accepted the cookie we minted keeps its own share.
 */
export async function attributableSession(): Promise<string | null> {
  /*
   * READ, NEVER MINT. THE MINT IS THE HOLE THIS CLOSES.
   *
   * The first version of this asked `sessionToken({ mint: true })`, and a
   * signature only stops a caller *choosing* a token — it does nothing about a
   * caller *asking the server for one*. A client that simply discards the
   * `Set-Cookie` arrives with no cookie on every request, is handed a brand-new
   * signed token every time, and opens a brand-new per-caller ledger row every
   * time. Measured against a twenty-build ceiling with a per-caller share of
   * two: twenty-one distinct signed identities, twenty builds allowed, the
   * per-caller fence never once firing. That is the very outcome this module's
   * header says it exists to prevent, reached without forging anything.
   *
   * So an identity has to *survive a round trip*: only a token the browser
   * presented, and that this deployment signed, is one. A request arriving
   * without a cookie is unattributable — which is exactly what it is — and
   * joins the shared pool alongside every other caller nobody can tell apart.
   *
   * The cookie is still minted, by `sessionToken` wherever ownership needs one.
   * An ordinary browser is therefore unattributed for its first action and has
   * its own share from the second onwards; a caller that never keeps a cookie
   * never leaves the shared pool.
   */
  const presented = await presentedSessionToken();
  if (presented === null) return null;
  return isSignedSessionToken(presented) ? presented : null;
}

/**
 * The cookie value the browser actually sent, with nothing minted.
 *
 * Separate from `sessionToken` because the two answer different questions.
 * `sessionToken` answers "what identity should this browser carry from now on",
 * and minting is the whole point of it. This answers "what did this request
 * arrive with", and minting would be the defect.
 */
export async function presentedSessionToken(): Promise<string | null> {
  try {
    const jar = await cookies();
    return jar.get(SESSION_COOKIE)?.value?.slice(0, 64) ?? null;
  } catch {
    // Outside a request scope: a test, a worker, an internal caller.
    return null;
  }
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
  const session = await attributableSession();
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
