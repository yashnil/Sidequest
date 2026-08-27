import 'server-only';
import { getDb } from '../db/client';

/**
 * THE GLOBAL CEILING ON WHAT A DAY MAY SPEND, ACROSS EVERY TRIP AND EVERY
 * CALLER.
 *
 * Per-compilation budgets bound one build; the job index bounds one trip; the
 * rate limiter bounds one connection. Nothing bounded the *sum* — fifty
 * travellers (or one script with fifty trips) could each start a fully
 * budgeted live compilation and the deployment's first sign would be the
 * bill. This ledger is the missing aggregate: a count of live compilations
 * started and model calls consumed, per UTC day, consulted before any new
 * live build may begin.
 *
 * The same posture as `lib/benchmark/budget.ts`, which the audit called the
 * pattern worth copying — reserve before the spend, read the ledger rather
 * than a counter in memory, refuse as a return value — with one deliberate
 * difference: the benchmark's ceiling is absent-means-refuse because spending
 * there is an experiment somebody opts into, while this one has a **sane
 * default**, because the product's normal path must work on a fresh deploy
 * without a tuning session. A malformed value falls back to the default
 * rather than to "unlimited"; an explicit `0` is honoured as "no live builds
 * today", because an operator who typed a zero meant it.
 *
 * Fixture and off modes never reach this: the gate is consulted only where
 * the runner is about to use the open, billable stack.
 *
 * ---
 *
 * **WHY THERE ARE TWO CEILINGS AND NOT ONE.**
 *
 * The first version of this ledger was a single global counter, and a review
 * measured what that means with the rate limiter's own numbers: one caller
 * starting three builds immediately and one a minute thereafter drains the
 * whole deployment's daily allowance in about seventeen minutes, after which
 * every other traveller is told to come back tomorrow. A cost control that any
 * single visitor can turn into an outage for everybody is an availability
 * control wearing the wrong label.
 *
 * So every spend is written twice: once to the deployment's row, and once to
 * the caller's own row for the day. The caller's ceiling is a fraction of the
 * global one, so **exhaustion is local before it is global** — the person
 * hammering the button stops, and the next visitor still gets a build. The
 * global ceiling stays exactly as it was, as the hard stop on the bill.
 *
 * A caller key is whatever the request layer can honestly attribute (see
 * `lib/net/caller`). There are three cases and they are not two:
 *
 * - **a key** — charge the deployment and that caller;
 * - **`null`, a request nobody could attribute** — charge the deployment and
 *   the *shared unattributed pool*, because the alternative is what shipped:
 *   declining the session cookie was strictly better than presenting one, since
 *   an anonymous caller was charged only globally and had the entire day's
 *   allowance to themselves while an honest browser had a fraction of it. One
 *   pool for everybody who cannot be told apart is the honest reading of "we do
 *   not know who this is", and there is nothing in it to rotate;
 * - **absent** — not a request at all: a worker, the benchmark driver, a test.
 *   Only the global ceiling applies. Inventing an identity there would hand
 *   every internal call its own allowance, which is worse than none.
 *
 * ---
 *
 * **WHAT THE NUMBERS ASSUME, WRITTEN DOWN SO THEY CAN BE ARGUED WITH.**
 *
 * The defaults were 20 builds and 300 model calls a day, which is not a
 * launch: a hundred signed-up travellers exhaust twenty builds before lunch,
 * and the first hundred people to try a product are exactly the ones who must
 * not be told to come back tomorrow. The model behind the numbers below:
 *
 * - a launch cohort of ~100 travellers; on the busiest day roughly a quarter
 *   of them open the product;
 * - a traveller who plans a trip builds once and rebuilds once after changing
 *   something — two live builds — and a handful of enthusiasts run four to six;
 * - so ~55 builds on a peak day. **60** is the ceiling, round and above it.
 * - each build is capped at `modelCallCeiling()` (12) model calls, so builds
 *   alone can reach 720; the questionnaire and plan screens interpret free text
 *   at ~2 calls per traveller, another ~50. **800** is the ceiling.
 * - a caller's share is a **tenth** rather than a quarter. Six builds a day
 *   from one browser is more than the previous quarter-of-twenty allowed
 *   (five), so no honest traveller is worse off — and it now takes at least ten
 *   distinct browsers to exhaust the day rather than four.
 *
 * These are *availability* controls, and only the global ones are security
 * controls: a caller who declines identity joins the unattributed pool, but
 * nothing here can tell two anonymous callers apart. What actually bounds an
 * anonymous flood is the three fences that take no identity at all — the global
 * ceilings here, the deployment rate fence in `lib/net/rate-limit`, and the
 * concurrency bound in `limits.ts`, which together cap the day's spend at these
 * numbers no matter how many identities anybody rotates through.
 */

const TABLE_SQL = `CREATE TABLE IF NOT EXISTS daily_provider_spend (
  day TEXT NOT NULL,
  counter TEXT NOT NULL,
  amount INTEGER NOT NULL,
  PRIMARY KEY (day, counter)
)`;

export type DailySpendCounter = 'live_compilations' | 'model_calls';

/** Sized for the launch cohort. The arithmetic is in the header. */
const DEFAULT_DAILY_LIVE_COMPILATIONS = 60;
const DEFAULT_DAILY_MODEL_CALLS = 800;

/**
 * A caller's share of the day, as a fraction of the deployment's ceiling.
 *
 * A tenth of a cohort-sized ceiling, which is both more allowance and more
 * protection than the quarter of a tiny one it replaces: six builds a day from
 * one browser rather than five, and ten distinct browsers to exhaust the day
 * rather than four. Rounded up and floored at one, so a caller is never refused
 * before they have spent anything — a ceiling of zero for everybody is not a
 * fair share, it is a closed product.
 */
const PER_CALLER_SHARE = 0.1;

/**
 * The one bucket every request nobody could attribute is charged to.
 *
 * Not an identity and not a guess: it is the statement that these requests
 * cannot be told apart, so they share one allowance between them. The `@`
 * prefix cannot collide with a real key, which is always `ip:…` or `session:…`.
 */
const UNATTRIBUTED_CALLER = '@unattributed';

function perCallerCeiling(globalCeiling: number): number {
  return Math.max(1, Math.ceil(globalCeiling * PER_CALLER_SHARE));
}

/**
 * The caller's row key, in the same `counter` column.
 *
 * The table is created here rather than in `schema.ts`, and it already exists
 * in deployments with the two-column primary key, so the caller dimension is
 * encoded into the key instead of added as a column: SQLite cannot extend a
 * primary key with `ALTER TABLE`, and a migration that rebuilt the table would
 * be a lot of machinery for a counter that resets every midnight. Existing rows
 * are the global ones and keep their meaning exactly.
 */
function callerCounter(counter: DailySpendCounter, caller: string): string {
  return `${counter}@${caller.slice(0, 96)}`;
}

/**
 * Which caller row a spend belongs to, or null for "no caller row at all".
 *
 * The whole distinction between `null` and absent lives here, and it is the one
 * thing that stops declining a cookie being a discount. See the header.
 */
function chargeKey(caller: string | null | undefined): string | null {
  if (caller === undefined) return null;
  return caller ?? UNATTRIBUTED_CALLER;
}

function ceilingFrom(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  // Zero is a decision; garbage is not. Negative and NaN fall to the default
  // because "we could not read the ceiling" must never read as "no ceiling".
  if (!Number.isFinite(value) || value < 0) return fallback;
  return Math.floor(value);
}

export function dailyLiveCompilationCeiling(): number {
  return ceilingFrom('SIDEQUEST_DAILY_LIVE_COMPILATIONS', DEFAULT_DAILY_LIVE_COMPILATIONS);
}

export function dailyModelCallCeiling(): number {
  return ceilingFrom('SIDEQUEST_DAILY_MODEL_CALLS', DEFAULT_DAILY_MODEL_CALLS);
}

/** The UTC day a spend belongs to. UTC so two processes never disagree. */
function dayOf(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export function recordDailySpend(
  counter: DailySpendCounter,
  amount: number,
  now = new Date(),
  caller?: string | null,
): void {
  if (!Number.isFinite(amount) || amount <= 0) return;
  try {
    const db = getDb();
    db.exec(TABLE_SQL);
    const write = db.prepare(
      `INSERT INTO daily_provider_spend (day, counter, amount) VALUES (?, ?, ?)
       ON CONFLICT(day, counter) DO UPDATE SET amount = amount + excluded.amount`,
    );
    const day = dayOf(now);
    const rounded = Math.round(amount);
    write.run(day, counter, rounded);
    // The caller's own row, so one visitor's share can run out while the
    // deployment's has not. Written in the same call as the global one because
    // a spend recorded against only one of them is a ceiling that lies.
    const key = chargeKey(caller);
    if (key) write.run(day, callerCounter(counter, key), rounded);
  } catch (error) {
    // A ledger that cannot be written is a ceiling that cannot be trusted; the
    // gate below fails closed for the same reason, so the money stays bounded.
    console.error('Could not record daily provider spend', { counter, error });
  }
}

export function dailySpendSoFar(
  counter: DailySpendCounter,
  now = new Date(),
  caller?: string | null,
): number {
  const db = getDb();
  db.exec(TABLE_SQL);
  const keyed = chargeKey(caller);
  const row = db
    .prepare('SELECT amount FROM daily_provider_spend WHERE day = ? AND counter = ?')
    .get(dayOf(now), keyed ? callerCounter(counter, keyed) : counter) as
    | { amount: number }
    | undefined;
  return row?.amount ?? 0;
}

export type DailySpendDecision =
  | { allowed: true }
  | { allowed: false; message: string };

/**
 * The traveller's sentence, not the operator's. It names what ran out and what
 * still works, and it does not apologise for a defect, because a ceiling
 * holding is the system working.
 */
const CEILING_REACHED_MESSAGE =
  'Sidequest has done all the live research it can afford today, so we are not starting another build right now. Your trip and everything already built are saved — try again tomorrow, or plan a destination we already hold.';

/**
 * The other refusal, and it says something different on purpose.
 *
 * When a caller has used their own share the deployment is *not* out of
 * research — telling them "try again tomorrow, we are done for the day" would
 * be a false statement about the system rather than a true one about them. The
 * sentence names what is theirs, keeps the promise that nothing was lost, and
 * does not lecture.
 */
const SHARE_REACHED_MESSAGE =
  'You have used your share of today’s live research, so we are not starting another build on this browser right now. Everything already built is saved — try again tomorrow, or open a destination we already hold.';

/**
 * May a new live compilation begin?
 *
 * **Fails closed.** This is the hard stop on aggregate spend, and a gate that
 * answered "the ledger is broken, go ahead" would be a ceiling only on good
 * days. (The same database failure would stop the job row being written a
 * moment later anyway, so nothing extra is lost by refusing honestly.)
 *
 * Two ceilings, and the caller's is checked **first**: the two refusals read
 * differently, and a caller who has spent their own share should be told that
 * rather than told the deployment is exhausted — which, in the case this order
 * matters for, it is not.
 */
export function dailySpendGate(
  now = new Date(),
  caller?: string | null,
): DailySpendDecision {
  try {
    const keyed = chargeKey(caller);
    if (keyed) {
      if (
        dailySpendSoFar('live_compilations', now, keyed) >=
        perCallerCeiling(dailyLiveCompilationCeiling())
      ) {
        return { allowed: false, message: SHARE_REACHED_MESSAGE };
      }
      if (dailySpendSoFar('model_calls', now, keyed) >= perCallerCeiling(dailyModelCallCeiling())) {
        return { allowed: false, message: SHARE_REACHED_MESSAGE };
      }
    }
    if (dailySpendSoFar('live_compilations', now) >= dailyLiveCompilationCeiling()) {
      return { allowed: false, message: CEILING_REACHED_MESSAGE };
    }
    if (dailySpendSoFar('model_calls', now) >= dailyModelCallCeiling()) {
      return { allowed: false, message: CEILING_REACHED_MESSAGE };
    }
    return { allowed: true };
  } catch (error) {
    console.error('Could not read the daily spend ledger; refusing a live build', { error });
    return {
      allowed: false,
      message:
        'We could not verify today’s research allowance just now, so we did not start a live build. Nothing was lost — try again in a moment.',
    };
  }
}

/**
 * BOOK MODEL CALLS AGAINST THE DAY BEFORE MAKING THEM.
 *
 * The ledger was written as a *compilation* ledger: only the runner recorded
 * `model_calls`, from the diagnostics of a finished build. Three other
 * production paths reach the same billed model — destination interpretation on
 * the plan screen, free-text interpretation in the questionnaire, and the labs
 * harness — and none of their spends was visible to the ceiling. An
 * unauthenticated caller could therefore run an unbounded bill through actions
 * that the ceiling was never told about, which makes §23's "maximum
 * provider/model budgets" true of one path and false of the product.
 *
 * This is the entry point for every *other* spender: reserve first, then call.
 * Reserving rather than counting afterwards is the same rule the benchmark
 * budget follows and the same rule `startCompilation` follows — a ceiling
 * discovered by crossing it is not a ceiling — and it is what makes two
 * simultaneous requests cost two reservations rather than one.
 *
 * The reservation is deliberately **not** refunded when the call fails. A
 * request that reached the provider and came back empty has usually been paid
 * for, and a ledger that gave the money back on failure would let a flapping
 * provider be billed all day inside a ceiling that never moved.
 */
export function reserveModelCalls(
  count = 1,
  options: { now?: Date; caller?: string | null } = {},
): DailySpendDecision {
  const now = options.now ?? new Date();
  // Threaded rather than defaulted: `null` and absent mean different things
  // here, and collapsing them would put every internal reservation into the
  // shared unattributed pool. See `chargeKey`.
  const caller = options.caller;
  const decision = dailySpendGate(now, caller);
  if (!decision.allowed) return decision;
  recordDailySpend('model_calls', count, now, caller);
  return { allowed: true };
}
