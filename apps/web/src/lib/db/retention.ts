import 'server-only';
import { getDb } from './client';
import { pruneExpiredInterpretations } from './interpretation-repository';

/**
 * WHAT THIS DATABASE IS ALLOWED TO KEEP.
 *
 * Four tables grew without a rule, and one of them had a prune function, an index
 * built specifically for that prune, and **zero call sites** — which is the same
 * as having no rule at all, with the additional cost of looking like it had one.
 *
 * The policies below are not the same policy applied four times, because the four
 * tables fail differently:
 *
 * - **`interpretation_cache`** already carries `expires_at`, written by the
 *   repository from a stated TTL. There is nothing to decide here; the row is
 *   dead the moment it expires and the only defect was that nobody ever deleted
 *   one. Emptying it costs at most one model call on a sentence somebody has
 *   already had read.
 *
 * - **`weather_snapshots`** is one row per (trip, scope). A snapshot past its
 *   `valid_until` is *already* refused by every render — `weatherSnapshotState`
 *   reads it as `expired` and `resolveTripRegion` treats it as absent — so a row
 *   kept beyond that window is a row nothing can ever read again. Deleted well
 *   after expiry rather than at it, so that "the weather we had has passed its
 *   window" stays sayable for a while instead of collapsing to "never fetched".
 *
 * - **`destination_images`** is the one table here that is *worth* keeping. It is
 *   traveller-independent, it is the record of a licence decision, and re-deriving
 *   a row costs somebody else's API two requests. Rejections are worth as much as
 *   acceptances: without the stored refusal, every build re-fetches, re-checks and
 *   re-refuses the same file. So the rule is long, and it keys off
 *   `revalidate_after` — which is set when the row is written and never refreshed
 *   by a read, so the accurate sentence is not "nobody has looked at it" but
 *   *nothing has re-resolved it since it fell due*. The grace exceeds the longest
 *   live window in the table (the 90-day rejection retry), so the sweep provably
 *   never removes a record that is still doing work.
 *
 * - **`decision_sessions`** holds what somebody was deciding between before a trip
 *   existed. A session that *became* a trip is provenance and is kept
 *   indefinitely. One that was abandoned is a half-finished form, and keeping
 *   every abandoned form for ever is how a table that nothing reads becomes the
 *   largest one in the database.
 *
 * Every policy is age-based rather than count-based, because a count cap deletes
 * a busy week's work and keeps a quiet month's. Nothing here is load-bearing: a
 * plan carries its own copy of everything it was built from, so this whole module
 * could delete every row it touches and no stored itinerary would change.
 *
 * ## The trigger is its own, and that is the correction
 *
 * This used to be called inside `if (evidenceStoreNeedsSweep())` — a count of
 * `evidence_documents` over 200. None of these four tables is grown by evidence
 * documents, and `decision_sessions` is grown by a flow that runs no compilation
 * at all. Measured across two full browser-suite runs: `evidence_documents`
 * peaked at **28**, so the sweep never fired once, while `decision_sessions` went
 * 30 → 60 and `weather_snapshots` 113 → 226. A deployment that never accumulates
 * 200 evidence documents would never apply a retention rule however large these
 * tables got.
 *
 * So retention latches on its own clock: at most once an hour, on the rare path a
 * compilation already stalls on, never from a render.
 */

const DAY_MS = 86_400_000;

/**
 * Days after a snapshot stops being renderable before its row goes.
 *
 * Seven, so that a traveller who comes back a week later still sees "the weather
 * we had for these dates has passed the window it was good for" — an account of
 * something that happened — rather than "not fetched", which is an account of
 * something that did not.
 */
export const WEATHER_SNAPSHOT_GRACE_DAYS = 7;

/**
 * Days past an image record's own revalidation date before it is dropped.
 *
 * Ninety. The record is cheap, traveller-independent and expensive to re-derive,
 * and the licence gate already refuses to *display* anything past
 * `revalidate_after` — so a stale row is inert rather than dangerous, and the
 * only cost of keeping it is bytes. What this removes is the row for a subject
 * nothing has referred to in a quarter of a year.
 */
export const IMAGE_RECORD_GRACE_DAYS = 90;

/**
 * Days an abandoned decision session survives.
 *
 * Sixty. Long enough that "I was looking at this a month ago" still works, short
 * enough that a form nobody finished is not kept for ever. A session that
 * resolved into a trip is **never** deleted here: it is the provenance behind a
 * real trip, and it disappears with that trip's row.
 */
export const ABANDONED_DECISION_DAYS = 60;

export interface RetentionResult {
  interpretations: number;
  weatherSnapshots: number;
  destinationImages: number;
  decisionSessions: number;
  /** Sessions that resolved into a trip that no longer exists. */
  orphanedDecisions: number;
}

/**
 * Apply every retention rule. Never throws.
 *
 * Each table is swept on its own so that one failure — a table an older database
 * does not have, a lock held by another writer — does not stop the other three.
 * A sweep that removed nothing is the normal outcome and is not worth a log line.
 */
export const RETENTION_INTERVAL_MS = 60 * 60 * 1000;

/**
 * When retention last ran, in this process.
 *
 * Deliberately in memory rather than a row. The cost of a missed sweep is some
 * bytes until the next compilation; the cost of a row is a write on a path whose
 * entire purpose is to avoid unnecessary writes. A restart simply sweeps once
 * more, which is the harmless direction.
 */
let lastSweptAtMs = 0;

/** Whether enough time has passed to be worth the stall. */
export function retentionIsDue(now: Date): boolean {
  return now.getTime() - lastSweptAtMs >= RETENTION_INTERVAL_MS;
}

/** For tests, which must not inherit another test's latch. */
export function resetRetentionLatch(): void {
  lastSweptAtMs = 0;
}

export function runRetentionSweep(now: Date): RetentionResult {
  lastSweptAtMs = now.getTime();
  return {
    interpretations: sweep('interpretation_cache', () => pruneExpiredInterpretations(now)),
    weatherSnapshots: sweep('weather_snapshots', () =>
      deleteWhere(
        'DELETE FROM weather_snapshots WHERE valid_until <= ?',
        isoDaysBefore(now, WEATHER_SNAPSHOT_GRACE_DAYS),
      ),
    ),
    destinationImages: sweep('destination_images', () =>
      deleteWhere(
        'DELETE FROM destination_images WHERE revalidate_after <= ?',
        isoDaysBefore(now, IMAGE_RECORD_GRACE_DAYS),
      ),
    ),
    decisionSessions: sweep('decision_sessions', () =>
      deleteWhere(
        /*
         * `resolved_trip_id IS NULL` is the whole of "abandoned".
         *
         * A session that became a trip is the answer to "why was I shown this",
         * and it is kept indefinitely rather than aged out — the column carries no
         * foreign key precisely so that deleting a trip cannot silently destroy
         * the record of how it was chosen.
         */
        'DELETE FROM decision_sessions WHERE resolved_trip_id IS NULL AND updated_at <= ?',
        isoDaysBefore(now, ABANDONED_DECISION_DAYS),
      ),
    ),
    /*
     * A resolved session whose trip is gone is not provenance. It is a pointer.
     *
     * `resolved_trip_id` deliberately carries no foreign key, so that deleting a
     * trip cannot destroy the record of how it was chosen. The consequence is
     * that nothing ever reclaims one — and the only thing that reads a resolved
     * session redirects to `/trips/{id}/plan`, which calls `notFound()` when the
     * trip has gone. So the row answers no question for anybody and is kept for
     * ever, which is the opposite of the intent behind leaving the key off.
     *
     * The same clock as an abandoned session, because the two are the same kind
     * of thing once the trip is gone.
     */
    orphanedDecisions: sweep('decision_sessions/orphaned', () =>
      deleteWhere(
        `DELETE FROM decision_sessions
          WHERE resolved_trip_id IS NOT NULL
            AND resolved_trip_id NOT IN (SELECT id FROM trips)
            AND updated_at <= ?`,
        isoDaysBefore(now, ABANDONED_DECISION_DAYS),
      ),
    ),
  };
}

function isoDaysBefore(now: Date, days: number): string {
  return new Date(now.getTime() - days * DAY_MS).toISOString();
}

function deleteWhere(sql: string, cutoff: string): number {
  return Number(getDb().prepare(sql).run(cutoff).changes ?? 0);
}

function sweep(table: string, run: () => number): number {
  try {
    return run();
  } catch (error) {
    console.error('Retention sweep failed for a table', { table, error });
    return 0;
  }
}
