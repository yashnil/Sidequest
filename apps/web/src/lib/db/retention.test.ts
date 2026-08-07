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
