import 'server-only';
import { getDb } from '../db/client';

/**
 * A TOKEN BUCKET IN THE DATABASE, FOR THE ACTIONS THAT CAN SPEND.
 *
 * Every provider this product reaches is either a volunteer-run service with a
 * usage policy or a billed model, and until this existed nothing stood between
 * a held-down refresh key — or a script — and the actions that reach them:
 * `startCompilationAction`, destination resolution and the preflight had no
 * rate limit of any kind. The job-dedup index stops *concurrent* duplicates
 * for one trip; it does nothing about many trips, many clicks or many callers.
 *
 * Persisted in the same SQLite file as everything else, deliberately: this app
 * is single-node, the database is already the one shared truth across the web
 * process and the compile workers, and an in-memory bucket would reset on every
 * dev-server reload — which is exactly when a stuck client re-fires. No new
 * infrastructure for a counter.
 *
 * The table is created here, lazily, rather than in `schema.ts`: the limiter
 * is self-contained defence-in-depth, and its storage is an implementation
 * detail of this module the way the provider cache's shape is of its own.
 *
 * **Failure posture: open, and logged.** The limiter is the polite fence; the
 * hard ceiling on money is the daily spend gate in the runner. A database
 * error that locked every traveller out of planning would be a worse outcome
 * than one window of unthrottled clicks, so a read/write failure allows the
 * action and says so in the log.
 */

const TABLE_SQL = `CREATE TABLE IF NOT EXISTS rate_limit_buckets (
  bucket_key TEXT PRIMARY KEY,
  tokens REAL NOT NULL,
  refilled_at TEXT NOT NULL
)`;

export interface RateLimitRule {
  /** Burst size: how many actions may land before the clock matters. */
  capacity: number;
  /** Sustained rate, as whole or fractional tokens per minute. */
  refillPerMinute: number;
}

export type RateDecision =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

/**
 * A refusal that also says *which* fence stopped it, because the two have
 * different sentences: one is about this connection, the other is about the
 * whole deployment being busy, and telling a traveller the wrong one is telling
 * them something false.
 */
export type ActionRateDecision =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number; scope: 'caller' | 'deployment' };

/**
 * Take one token from the bucket named by `key`, refilling for elapsed time
 * first. One statement path, no transaction: SQLite serialises writers and the
 * worst race between two requests is one extra allowed action, which a fence
 * does not care about and a ledger would.
 */
export function takeRateToken(key: string, rule: RateLimitRule, now = new Date()): RateDecision {
  try {
    const db = getDb();
    db.exec(TABLE_SQL);

    const row = db
      .prepare('SELECT tokens, refilled_at FROM rate_limit_buckets WHERE bucket_key = ?')
      .get(key) as { tokens: number; refilled_at: string } | undefined;

    let tokens = rule.capacity;
    if (row) {
      const refilledAt = Date.parse(row.refilled_at);
      const elapsedMinutes = Number.isNaN(refilledAt)
        ? 0
        : Math.max(0, (now.getTime() - refilledAt) / 60_000);
      tokens = Math.min(rule.capacity, row.tokens + elapsedMinutes * rule.refillPerMinute);
    }

    if (tokens < 1) {
      const retryAfterSeconds = Math.ceil(((1 - tokens) / rule.refillPerMinute) * 60);
      return { allowed: false, retryAfterSeconds: Math.max(1, retryAfterSeconds) };
    }

    db.prepare(
      `INSERT INTO rate_limit_buckets (bucket_key, tokens, refilled_at) VALUES (?, ?, ?)
       ON CONFLICT(bucket_key) DO UPDATE SET tokens = excluded.tokens, refilled_at = excluded.refilled_at`,
    ).run(key, tokens - 1, now.toISOString());

    /*
     * Bounded, like the provider cache: a scanner cycling through spoofed
     * addresses must not grow this table without limit. Oldest-refilled rows
     * are the ones no live client is using.
     */
    db.prepare(
      `DELETE FROM rate_limit_buckets WHERE bucket_key IN (
         SELECT bucket_key FROM rate_limit_buckets ORDER BY refilled_at DESC LIMIT -1 OFFSET 5000)`,
    ).run();

    return { allowed: true };
  } catch (error) {
    console.error('Rate limiter could not read its bucket; allowing the action', { error });
    return { allowed: true };
  }
}

/**
 * The same arithmetic, without spending.
 *
 * For the actions where taking a token and doing the work are separated by a
 * race that most callers lose. Asking "may I?" is not the same as "I did", and
 * an action that charged every racer would refuse travellers who were about to
 * be handed somebody else's answer for free.
 */
export function inspectRateToken(key: string, rule: RateLimitRule, now = new Date()): RateDecision {
  try {
    const db = getDb();
    db.exec(TABLE_SQL);
    const row = db
      .prepare('SELECT tokens, refilled_at FROM rate_limit_buckets WHERE bucket_key = ?')
      .get(key) as { tokens: number; refilled_at: string } | undefined;
    if (!row) return { allowed: true };

    const refilledAt = Date.parse(row.refilled_at);
    const elapsedMinutes = Number.isNaN(refilledAt)
      ? 0
      : Math.max(0, (now.getTime() - refilledAt) / 60_000);
    const tokens = Math.min(rule.capacity, row.tokens + elapsedMinutes * rule.refillPerMinute);
    if (tokens >= 1) return { allowed: true };

    const retryAfterSeconds = Math.ceil(((1 - tokens) / rule.refillPerMinute) * 60);
    return { allowed: false, retryAfterSeconds: Math.max(1, retryAfterSeconds) };
  } catch (error) {
    console.error('Rate limiter could not read its bucket; allowing the action', { error });
    return { allowed: true };
  }
}

/**
 * One decision across several identities, where the *most* restrictive answer
 * wins.
 *
 * This used to claim "an abuser has to beat both". That was wrong, and it is
 * worth recording why: both identities were client-supplied — the leftmost
 * `x-forwarded-for` element is written by the client, and a cookie is discarded
 * for free — so beating one was beating both. `lib/net/caller` now refuses to
 * derive an address it cannot stand behind, and `takeActionTokens` adds a fence
 * that takes no identity at all. What is left here is the honest, narrow claim:
 * separate buckets keep one traveller from being throttled by another behind
 * the same NAT.
 *
 * An empty identity list is allowed and means exactly what it says — nothing
 * about this request can be attributed — in which case only the shared fence
 * applies.
 */
export function takeRateTokens(
  kind: string,
  identities: readonly string[],
  rule: RateLimitRule,
  now = new Date(),
): RateDecision {
  let refused: { allowed: false; retryAfterSeconds: number } | null = null;
  for (const identity of identities) {
    const decision = takeRateToken(`${kind}:${identity}`, rule, now);
    if (!decision.allowed && (!refused || decision.retryAfterSeconds > refused.retryAfterSeconds)) {
      refused = decision;
    }
  }
  return refused ?? { allowed: true };
}

/**
 * The rules, one per guarded action, in one table so the next guarded action
 * is one row rather than a judgement call scattered through `actions.ts`.
 *
 * Sized for a person, not a pipeline: nobody resolves thirty destinations a
 * minute by hand, and a compilation takes minutes to run — three in a burst is
 * a traveller changing their mind, thirty is a script.
 */
export const ACTION_RATE_RULES = {
  /** Starts a job that can spend real money. The daily ceiling backstops this. */
  compile_start: { capacity: 3, refillPerMinute: 1 },
  /** One geocoder round-trip against a volunteer-run service. */
  destination_resolve: { capacity: 6, refillPerMinute: 3 },
  /** One climate call plus local reads; recomputed on trip-length changes. */
  preflight: { capacity: 8, refillPerMinute: 4 },
  /** One billed model call that reads the traveller's own free text. */
  interpret_text: { capacity: 4, refillPerMinute: 2 },
} as const satisfies Record<string, RateLimitRule>;

export type GuardedActionKind = keyof typeof ACTION_RATE_RULES;

/**
 * HOW MANY CALLERS' WORTH OF WORK THE WHOLE DEPLOYMENT WILL DO AT ONCE.
 *
 * The per-identity buckets above are only as good as the identity, and a review
 * proved this deployment's identities are worth very little: `x-forwarded-for`
 * is client-written unless a trusted-proxy hop count is configured, and a cookie
 * is free to discard. Rotate either and every per-identity fence yields a virgin
 * bucket.
 *
 * This bucket takes no identity at all, so there is nothing to rotate. It is
 * sized as a multiple of one caller's allowance — generous enough that a real
 * cohort of travellers never meets it, tight enough that a script rotating
 * headers is bounded by *something* rather than by nothing.
 *
 * It is a fence and not a ceiling: the money is bounded by `daily-ceiling`,
 * which now counts per caller as well as globally. This bounds the *rate* at
 * which anyone can approach it.
 */
const DEPLOYMENT_FENCE_MULTIPLE = 8;

export function deploymentRule(kind: GuardedActionKind): RateLimitRule {
  const rule = ACTION_RATE_RULES[kind];
  return {
    capacity: rule.capacity * DEPLOYMENT_FENCE_MULTIPLE,
    refillPerMinute: rule.refillPerMinute * DEPLOYMENT_FENCE_MULTIPLE,
  };
}

/**
 * The whole decision for one guarded action: the caller's fences, then the
 * deployment's.
 *
 * Order matters. The caller's buckets are consulted first so that an ordinary
 * traveller who is over their own limit is told so, and — more importantly — so
 * that one caller's spam is charged to their own bucket before it can consume
 * the shared one. A refusal from the caller's fence therefore costs the shared
 * fence nothing at all, which is what stops a single script draining the fence
 * that protects everybody else.
 */
export function takeActionTokens(
  kind: GuardedActionKind,
  identities: readonly string[],
  rule: RateLimitRule,
  now = new Date(),
): ActionRateDecision {
  const caller = takeRateTokens(kind, identities, rule, now);
  if (!caller.allowed) {
    return { allowed: false, retryAfterSeconds: caller.retryAfterSeconds, scope: 'caller' };
  }

  const shared = takeRateToken(`${kind}:deployment`, deploymentRule(kind), now);
  if (!shared.allowed) {
    return { allowed: false, retryAfterSeconds: shared.retryAfterSeconds, scope: 'deployment' };
  }
  return { allowed: true };
}

/**
 * The same question, asked without answering it.
 *
 * For the one guarded action whose work is claimed by a lease: fifty concurrent
 * presses on the same reading buy *one* provider call and forty-nine free
 * replays, so charging all fifty would refuse travellers who were about to be
 * given an answer that cost nothing. They check here, and only the invocation
 * that wins the lease charges itself with `takeActionTokens`.
 */
export function peekActionTokens(
  kind: GuardedActionKind,
  identities: readonly string[],
  rule: RateLimitRule,
  now = new Date(),
): ActionRateDecision {
  for (const identity of identities) {
    const decision = inspectRateToken(`${kind}:${identity}`, rule, now);
    if (!decision.allowed) {
      return { allowed: false, retryAfterSeconds: decision.retryAfterSeconds, scope: 'caller' };
    }
  }
  const shared = inspectRateToken(`${kind}:deployment`, deploymentRule(kind), now);
  if (!shared.allowed) {
    return { allowed: false, retryAfterSeconds: shared.retryAfterSeconds, scope: 'deployment' };
  }
  return { allowed: true };
}

/**
 * The sentence a refused traveller reads. Honest about what happened and what
 * to do, with no header jargon: this is an action result, not an HTTP status.
 */
export function rateLimitedCopy(retryAfterSeconds: number): string {
  const wait =
    retryAfterSeconds >= 90
      ? `about ${Math.ceil(retryAfterSeconds / 60)} minutes`
      : `about ${Math.max(5, Math.ceil(retryAfterSeconds / 5) * 5)} seconds`;
  return `We are getting a lot of requests from this connection just now, so we paused this one. Nothing was lost — your trip is saved. Try again in ${wait}.`;
}

/**
 * The other sentence: the deployment is busy, not this traveller.
 *
 * Kept separate because blaming "this connection" when the shared fence fired
 * would be a false explanation to somebody who has done nothing unusual, and a
 * traveller who follows a false explanation ("I'll switch to my phone") is
 * worse off than one told the truth.
 */
export function deploymentBusyCopy(retryAfterSeconds: number): string {
  const wait =
    retryAfterSeconds >= 90
      ? `about ${Math.ceil(retryAfterSeconds / 60)} minutes`
      : `about ${Math.max(5, Math.ceil(retryAfterSeconds / 5) * 5)} seconds`;
  return `Sidequest is busy right now, so we paused this one rather than starting something we could not finish. Nothing was lost — your trip is saved. Try again in ${wait}.`;
}
