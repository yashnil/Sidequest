import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A RULE ABOUT WHAT THIS DATABASE KEEPS, AND A CALLER FOR IT.
 *
 * Three of these tables had no retention rule at all, and the fourth had a prune
 * function, a purpose-built index and zero call sites — which is worse than
 * having none, because it looks answered.
 *
 * Each test asserts both halves: the old row goes, **and** the row that is still
 * load-bearing stays. A sweep that deletes everything is easy to write and is the
 * one failure mode that costs a traveller something.
 */

let dir: string;

function releaseDatabase(): void {
  const holder = globalThis as unknown as { sidequestDb?: { close(): void } };
  holder.sidequestDb?.close();
  delete holder.sidequestDb;
}

beforeEach(() => {
  vi.resetModules();
  releaseDatabase();
  dir = mkdtempSync(join(tmpdir(), 'sidequest-retention-'));
  process.env.SIDEQUEST_DB_PATH = join(dir, 'test.db');
});

afterEach(() => {
  releaseDatabase();
  delete process.env.SIDEQUEST_DB_PATH;
  rmSync(dir, { recursive: true, force: true });
});

const NOW = new Date('2026-08-03T00:00:00.000Z');
const daysBefore = (days: number) =>
  new Date(NOW.getTime() - days * 86_400_000).toISOString();
const daysAfter = (days: number) => new Date(NOW.getTime() + days * 86_400_000).toISOString();

async function seeded() {
  const { getDb } = await import('./client');
  const db = getDb();

  db.prepare(
    `INSERT INTO trips (id, mode, destination_input, region_id, start_date, end_date,
                        arrival_time, departure_time, adults, children, status,
                        created_at, updated_at)
     VALUES ('trip-1','known','somewhere','region-1','2026-08-12','2026-08-13',
             '10:00','18:00',2,0,'draft',?,?)`,
  ).run(NOW.toISOString(), NOW.toISOString());

  // An interpretation reading that has expired, and one that has not.
  const cache = db.prepare(
    `INSERT INTO interpretation_cache (cache_key, trip_id, payload_json, created_at, expires_at)
     VALUES (?,?,'{}',?,?)`,
  );
  cache.run('expired', 'trip-1', daysBefore(30), daysBefore(1));
  cache.run('live', 'trip-1', daysBefore(1), daysAfter(6));

  // A snapshot long past its window, and one still inside it.
  const snapshot = db.prepare(
    `INSERT INTO weather_snapshots
       (trip_id, scope_key, schema_version, status, provider, fetched_at, valid_until, payload_json)
     VALUES ('trip-1',?,1,'succeeded','test',?,?,'{}')`,
  );
  snapshot.run('ancient', daysBefore(40), daysBefore(30));
  snapshot.run('recent', daysBefore(1), daysAfter(1));
  // Expired, but only just — still worth being able to say we once had it.
  snapshot.run('lately-expired', daysBefore(3), daysBefore(2));

  const image = db.prepare(
    `INSERT INTO destination_images
       (subject_key, file_title, schema_version, provider, accepted, licence_id,
        payload_json, retrieved_at, revalidate_after)
     VALUES (?,?,1,'wikimedia',1,'CC-BY-4.0','{}',?,?)`,
  );
  image.run('subject-old', 'File:Old.jpg', daysBefore(400), daysBefore(200));
  image.run('subject-live', 'File:Live.jpg', daysBefore(10), daysAfter(20));
  image.run('subject-recently-due', 'File:Due.jpg', daysBefore(40), daysBefore(10));

  const session = db.prepare(
    `INSERT INTO decision_sessions
       (id, schema_version, answers_json, resolved_trip_id, created_at, updated_at)
     VALUES (?,1,'{}',?,?,?)`,
  );
  session.run('abandoned-old', null, daysBefore(200), daysBefore(180));
  session.run('abandoned-recent', null, daysBefore(5), daysBefore(3));
  session.run('resolved-old', 'trip-1', daysBefore(400), daysBefore(390));

  const retention = await import('./retention');
  retention.resetRetentionLatch();
  return { db, retention };
}

const idsIn = (db: { prepare: (sql: string) => { all: () => unknown[] } }, sql: string) =>
  (db.prepare(sql).all() as { key: string }[]).map((row) => row.key).sort();

describe('the retention sweep', () => {
  it('deletes an expired interpretation reading and keeps a live one', async () => {
    const { db, retention } = await seeded();
    const result = retention.runRetentionSweep(NOW);

    expect(result.interpretations).toBe(1);
    expect(idsIn(db, 'SELECT cache_key AS key FROM interpretation_cache')).toEqual(['live']);
  });

  it('deletes a snapshot nothing can read and keeps one that only just expired', async () => {
    const { db, retention } = await seeded();
    retention.runRetentionSweep(NOW);

    expect(idsIn(db, 'SELECT scope_key AS key FROM weather_snapshots')).toEqual([
      'lately-expired',
      'recent',
    ]);
  });

  it('keeps an image record long past its re-check, and drops a very old one', async () => {
    const { db, retention } = await seeded();
    retention.runRetentionSweep(NOW);

    expect(idsIn(db, 'SELECT subject_key AS key FROM destination_images')).toEqual([
      'subject-live',
      'subject-recently-due',
    ]);
  });

  /** The one that would have hurt: provenance for a real trip is not a candidate. */
  it('never deletes a decision session that became a trip, however old', async () => {
    const { db, retention } = await seeded();
    retention.runRetentionSweep(NOW);

    expect(idsIn(db, 'SELECT id AS key FROM decision_sessions')).toEqual([
      'abandoned-recent',
      'resolved-old',
    ]);
  });

  it('is idempotent, so running it twice removes nothing the second time', async () => {
    const { retention } = await seeded();
    retention.runRetentionSweep(NOW);
    const second = retention.runRetentionSweep(NOW);

    expect(second).toEqual({
      interpretations: 0,
      weatherSnapshots: 0,
      destinationImages: 0,
      decisionSessions: 0,
      orphanedDecisions: 0,
      authStates: 0,
      authSessions: 0,
      callerSpendRows: 0,
      rateBuckets: 0,
    });
  });

  /**
   * The pointer that answers nothing.
   *
   * `resolved_trip_id` carries no foreign key on purpose — deleting a trip must
   * not destroy the record of how it was chosen. But once the trip is gone the
   * only reader of that session redirects to a page that calls `notFound()`, so
   * the row is provenance for nobody, and nothing reclaimed it ever.
   */
  it('reclaims a resolved session whose trip no longer exists', async () => {
    const { db, retention } = await seeded();
    db.prepare(
      `INSERT INTO decision_sessions
         (id, schema_version, answers_json, resolved_trip_id, created_at, updated_at)
       VALUES ('orphan',1,'{}','trip-gone',?,?)`,
    ).run(daysBefore(200), daysBefore(180));

    const result = retention.runRetentionSweep(NOW);

    expect(result.orphanedDecisions).toBe(1);
    expect(idsIn(db, 'SELECT id AS key FROM decision_sessions')).toEqual([
      'abandoned-recent',
      'resolved-old',
    ]);
  });

  /**
   * RELEASE PASS — the four tables that hold a credential or an address. Both
   * halves again: the dead row goes, the live one and every deployment-wide
   * row stay.
   */
  it('sweeps dead sign-in attempts, expired sessions, old caller ledger rows and idle rate buckets', async () => {
    const { db, retention } = await seeded();
    const state = db.prepare(`INSERT INTO auth_states (state, provider, code_verifier, return_to, owner_token, created_at, expires_at) VALUES (?,'google','v',NULL,NULL,?,?)`);
    state.run('dead', daysBefore(1), daysBefore(1));
    state.run('live', NOW.toISOString(), daysAfter(1));
    db.prepare(`INSERT INTO users (id, provider, provider_subject, created_at, last_seen_at) VALUES ('u1','google','s1',?,?)`).run(NOW.toISOString(), NOW.toISOString());
    const session = db.prepare(`INSERT INTO auth_sessions (id, user_id, token_hash, created_at, expires_at, last_seen_at) VALUES (?,'u1',?,?,?,?)`);
    session.run('expired', 'h1', daysBefore(100), daysBefore(10), daysBefore(10));
    session.run('current', 'h2', daysBefore(1), daysAfter(80), NOW.toISOString());
    db.exec('CREATE TABLE IF NOT EXISTS daily_provider_spend (day TEXT NOT NULL, counter TEXT NOT NULL, amount INTEGER NOT NULL, PRIMARY KEY (day, counter))');
    const spend = db.prepare('INSERT INTO daily_provider_spend (day, counter, amount) VALUES (?,?,1)');
    spend.run('2026-07-20', 'model_calls');
    spend.run('2026-07-20', 'model_calls@ip:203.0.113.9');
    spend.run('2026-08-02', 'model_calls@ip:203.0.113.9');
    db.exec('CREATE TABLE IF NOT EXISTS rate_limit_buckets (bucket_key TEXT PRIMARY KEY, tokens REAL NOT NULL, refilled_at TEXT NOT NULL)');
    const bucket = db.prepare('INSERT INTO rate_limit_buckets (bucket_key, tokens, refilled_at) VALUES (?,1,?)');
    bucket.run('refine:session:idle', daysBefore(10));
    bucket.run('refine:session:recent', NOW.toISOString());
    bucket.run('refine:@deployment', daysBefore(10));

    retention.runRetentionSweep(NOW);

    expect(idsIn(db, 'SELECT state AS key FROM auth_states')).toEqual(['live']);
    expect(idsIn(db, 'SELECT id AS key FROM auth_sessions')).toEqual(['current']);
    expect(idsIn(db, `SELECT day || '/' || counter AS key FROM daily_provider_spend`)).toEqual(['2026-07-20/model_calls', '2026-08-02/model_calls@ip:203.0.113.9']);
    expect(idsIn(db, 'SELECT bucket_key AS key FROM rate_limit_buckets')).toEqual(['refine:@deployment', 'refine:session:recent']);
  });

  it('runs on its own schedule, once however often it is started, and can be stopped', async () => {
    const { retention } = await seeded();
    vi.useFakeTimers({ now: new Date() });
    try {
      const stop = retention.startRetentionSchedule({ firstDelayMs: 1000, intervalMs: 5000 });
      expect(retention.startRetentionSchedule()).toBe(stop);
      expect(retention.retentionIsDue(new Date())).toBe(true);
      vi.advanceTimersByTime(1000);
      expect(retention.retentionIsDue(new Date())).toBe(false);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  /** And the latch, which is what stops it running on every build. */
  it('is due once an hour rather than on every compilation', async () => {
    const { retention } = await seeded();
    expect(retention.retentionIsDue(NOW)).toBe(true);
    retention.runRetentionSweep(NOW);
    expect(retention.retentionIsDue(NOW)).toBe(false);
    expect(
      retention.retentionIsDue(new Date(NOW.getTime() + retention.RETENTION_INTERVAL_MS)),
    ).toBe(true);
  });
});
