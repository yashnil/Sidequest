import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { geographicScopeSchema, scopeFingerprint } from '@sidequest/core';
import { COLUMN_MIGRATIONS, INDEX_MIGRATIONS, SCHEMA_SQL } from './schema';
import { PRE_PHASE_12_SCHEMA } from './fixtures/pre-phase-12-schema';
import { MID_PHASE_12_SCHEMA } from './fixtures/mid-phase-12-schema';

/**
 * MIGRATING TWO REAL DATABASES ACROSS PHASE 12.
 *
 * `migration.test.ts` covers the jump from before the evidence store. This
 * covers the two upgrades a database in the wild will actually make now, and it
 * is two rather than one because they are genuinely different journeys:
 *
 * 1. **Pre-Phase-12** — the last committed schema. Carries the authored Eastern
 *    Sierra trip, a Phase-7 artifact, a Phase-8 artifact with evidence, a
 *    Phase-9 artifact with its shared pack, Phase-10 shared claims, Phase-11
 *    hierarchical routes, an itinerary, a failed job and cached weather. It has
 *    never seen a provisional board or a decision session.
 * 2. **Mid-Phase-12** — after the provisional board landed and before this
 *    sprint. Everything above, *plus* Help-Me-Decide state, a provisional board,
 *    provisional selections and a reconciliation written under the old schema.
 *
 * What both have to prove is the same sentence: **nothing already stored moves.**
 * An artifact somebody was shown last month has to render byte-identically after
 * the upgrade, a trip must not silently recompile, and the new tables have to
 * arrive empty rather than arrive populated with a guess.
 *
 * The two schema fixtures are frozen literals, never imports of the live schema.
 * The moment somebody "updates" them, this file migrates the present to the
 * present and passes forever while proving nothing.
 */

let directory: string;

/** Exactly what `getDb()` does on open: current schema, then additive columns. */
function migrate(databasePath: string): void {
  const db = new Database(databasePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  const apply = db.transaction(() => {
    for (const migration of COLUMN_MIGRATIONS) {
      const columns = db.prepare(`PRAGMA table_info(${migration.table})`).all() as {
        name: string;
      }[];
      if (columns.length === 0) continue;
      if (columns.some((column) => column.name === migration.column)) continue;
      db.exec(
        `ALTER TABLE ${migration.table} ADD COLUMN ${migration.column} ${migration.definition}`,
      );
    }
  });
  apply();
  /*
   * And the indexes that cannot live in `SCHEMA_SQL`, in the order the driver
   * applies them.
   *
   * `SCHEMA_SQL` runs before the column migrations, so an index over a column
   * that arrives by migration would fail on exactly the databases the migration
   * exists for. Replaying that ordering here rather than skipping it is the whole
   * point of this function: a migration test that migrates differently from the
   * driver is testing a database nobody has.
   */
  for (const statement of INDEX_MIGRATIONS) db.exec(statement);
  db.close();
}

const NOW = '2026-08-01T10:00:00.000Z';

/**
 * Six generations of artifact in one database, which is what a real one holds.
 *
 * Written with named columns rather than positionally, so a column added to the
 * live schema between now and whenever somebody reads this does not silently
 * shift every value one to the left.
 */
function seedThroughPhase11(db: Database.Database): void {
  const trip = (id: string, region: string, start: string, end: string): void => {
    db.prepare(
      `INSERT INTO trips (id, mode, destination_input, region_id, start_date, end_date,
        arrival_time, departure_time, adults, children, traveler_needs, status,
        created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(id, 'known', region, region, start, end, '13:00', '10:00', 2, 0, '[]', 'planned', NOW, NOW);
  };

  // (1) The authored Eastern Sierra trip, which predates the compiler entirely.
  trip('trip-authored', 'eastern-sierra', '2026-08-12', '2026-08-16');
  db.prepare(
    `INSERT INTO traveler_profiles (trip_id, profile_version, answers_json, profile_json,
      created_at, updated_at) VALUES (?,?,?,?,?,?)`,
  ).run('trip-authored', 1, '{"answers":[]}', '{"version":1}', NOW, NOW);
  db.prepare(
    `INSERT INTO discovery_selections (trip_id, place_id, status, source, updated_at)
     VALUES (?,?,?,?,?)`,
  ).run('trip-authored', 'place-a', 'included', 'user', NOW);
  db.prepare(
    `INSERT INTO itineraries (trip_id, version, region_id, base_id, base_name, start_date,
      end_date, status, summary, transport_strategy_json, food_plan_json, issues_json,
      unscheduled_json, diagnostics_json, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    'trip-authored', 4, 'eastern-sierra', 'base-a', 'A base', '2026-08-12', '2026-08-16',
    'ready', 'A summary.', '{}', '{}', '[]', '[]', '{}', NOW, NOW,
  );
  db.prepare(
    `INSERT INTO itinerary_items (trip_id, day_number, position, kind, place_id,
      start_minute, end_minute, item_json) VALUES (?,?,?,?,?,?,?,?)`,
  ).run('trip-authored', 1, 0, 'place', 'place-a', 540, 660, '{"kind":"place"}');

  // (2) Phase-7: an artifact with no evidence key at all.
  trip('trip-p7', 'compiled-p7', '2026-09-01', '2026-09-05');
  db.prepare(
    `INSERT INTO compiled_regions (id, trip_id, scope_fingerprint, schema_version,
      compiler_version, payload_json, created_at) VALUES (?,?,?,?,?,?,?)`,
  ).run(
    'region-p7', 'trip-p7', 'fp-p7', 1, 'sidequest-compiler/1',
    JSON.stringify({ schemaVersion: 1, id: 'region-p7', places: [] }), NOW,
  );

  // (3) Phase-8: evidence, and a page read to produce it.
  trip('trip-p8', 'compiled-p8', '2026-10-01', '2026-10-04');
  db.prepare(
    `INSERT INTO compiled_regions (id, trip_id, scope_fingerprint, schema_version,
      compiler_version, payload_json, created_at) VALUES (?,?,?,?,?,?,?)`,
  ).run(
    'region-p8', 'trip-p8', 'fp-p8', 1, 'sidequest-compiler/1',
    JSON.stringify({
      schemaVersion: 1,
      id: 'region-p8',
      places: [],
      evidence: { places: [], region: [] },
    }),
    NOW,
  );
  db.prepare(
    `INSERT INTO source_documents (url, compiled_region_id, subject_id, publisher,
      authority, title, content_hash, content_bytes, robots_allowed, retrieved_at,
      published_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    'https://example.org/hours', 'region-p8', 'subject-1', 'example.org', 'government',
    'Opening hours', 'hash-1', 4096, 1, NOW, null,
  );

  // (4) Phase-9: an artifact naming its pack, and the shared pack row.
  trip('trip-p9', 'compiled-p9', '2026-11-01', '2026-11-05');
  db.prepare(
    `INSERT INTO compiled_regions (id, trip_id, scope_fingerprint, schema_version,
      compiler_version, payload_json, created_at) VALUES (?,?,?,?,?,?,?)`,
  ).run(
    'region-p9', 'trip-p9', 'fp-p9', 1, 'sidequest-compiler/1',
    JSON.stringify({
      schemaVersion: 1,
      id: 'region-p9',
      places: [],
      evidence: { places: [], region: [] },
      regionPack: { packId: 'pack-9', releaseId: '2026-07-22.0', catalog: 'overture', reused: false },
    }),
    NOW,
  );
  db.prepare(
    `INSERT INTO region_packs (id, scope_hash, catalog, release_id, schema_version, state,
      content_hash, record_count, payload_json, created_at, expires_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    'pack-9', 'scope-9', 'overture', '2026-07-22.0', 1, 'ready', 'content-9', 3805,
    '{"schemaVersion":1}', NOW, null,
  );

  // (5) Phase-10: a shared claim, quoted by an artifact, with its source and document.
  db.prepare(
    `INSERT INTO evidence_sources (id, canonical_url, host, origin, publisher, authority,
      payload_json, first_seen_at, last_seen_at) VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(
    'src-1', 'https://example.org/hours', 'example.org', 'https://example.org',
    'example.org', 'government', '{"schemaVersion":1}', NOW, NOW,
  );
  db.prepare(
    `INSERT INTO evidence_documents (id, source_id, content_digest, status, content_bytes,
      truncated, etag, last_modified, vary, cache_control, content_observed_at,
      last_checked_at, published_at, retrieval_version, payload_json)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    'doc-1', 'src-1', 'sha256:abc', 'ok', 4096, 0, 'W/"1"', null, null, null,
    NOW, NOW, null, 'retrieval/1', '{"schemaVersion":1}',
  );
  db.prepare(
    `INSERT INTO evidence_claims (id, subject_key, fact_path, source_id, document_version_id,
      content_digest, extraction_key, origin, payload_json, first_seen_at, last_seen_at,
      supersedes_claim_id, superseded) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    'claim-1', 'subject-1', 'hours.regular', 'src-1', 'doc-1', 'sha256:abc',
    'extract/1', 'extraction', '{"open":"09:00"}', NOW, NOW, null, 0,
  );
  db.prepare(
    `INSERT INTO compiled_region_claims (compiled_region_id, claim_id) VALUES (?,?)`,
  ).run('region-p9', 'claim-1');

  // (6) Phase-11: hierarchical routing on the artifact, and a real itinerary from it.
  trip('trip-p11', 'compiled-p11', '2026-12-01', '2026-12-06');
  db.prepare(
    `INSERT INTO compiled_regions (id, trip_id, scope_fingerprint, schema_version,
      compiler_version, payload_json, created_at) VALUES (?,?,?,?,?,?,?)`,
  ).run(
    'region-p11', 'trip-p11', 'fp-p11', 1, 'sidequest-compiler/1',
    JSON.stringify({
      schemaVersion: 1,
      id: 'region-p11',
      places: [],
      evidence: { places: [], region: [] },
      regionPack: { packId: 'pack-9', releaseId: '2026-07-22.0', catalog: 'overture', reused: true },
      routing: { plannedPairs: 1296, flatPairs: 1444, clusters: 4, providerCalls: 12, reductions: [] },
    }),
    NOW,
  );
  db.prepare(
    `INSERT INTO itineraries (trip_id, version, region_id, base_id, base_name, start_date,
      end_date, status, summary, transport_strategy_json, food_plan_json, issues_json,
      unscheduled_json, diagnostics_json, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    'trip-p11', 1, 'compiled-p11', 'base-p11', 'A base', '2026-12-01', '2026-12-06',
    'ready_with_cautions', 'Six days.', '{}', '{}', '[]', '[]', '{}', NOW, NOW,
  );

  // (7) A compilation that died halfway, which a crash genuinely leaves behind.
  db.prepare(
    `INSERT INTO compilation_jobs (id, trip_id, scope_fingerprint, state, stage, stages_json,
      started_at, updated_at, finished_at, heartbeat_at, cancel_requested, error_code,
      error_detail, compiled_region_id, correlation_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    'job-failed', 'trip-p8', 'fp-old', 'failed', 'discovering_candidates',
    '[{"stage":"expanding_region","status":"done","ms":1}]', NOW, NOW, NOW, NOW, 0,
    'provider_unavailable', 'The map service did not answer.', null, 'corr-1',
  );

  // (8) Weather somebody already fetched, under the old cache.
  db.prepare(
    `INSERT INTO weather_cache (cache_key, payload_json, stored_at) VALUES (?,?,?)`,
  ).run('weather|eastern-sierra|2026-08-12', '{"days":[]}', NOW);
}

/** The Phase-12 state that only the mid fixture can hold. */
function seedPhase12(db: Database.Database): void {
  db.prepare(
    `INSERT INTO decision_sessions (id, schema_version, answers_json, shortlist_json,
      resolved_trip_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?)`,
  ).run(
    'decide-1', 1, JSON.stringify({ nights: 12, interests: ['mountains'] }),
    JSON.stringify({ schemaVersion: 1, entries: [] }), null, NOW, NOW,
  );

  db.prepare(
    `INSERT INTO provisional_boards (id, trip_id, job_id, scope_fingerprint, schema_version,
      version, supersedes_board_id, payload_json, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(
    'board-1', 'trip-p11', 'job-p11', 'fp-p11', 1, 1, null,
    JSON.stringify({ schemaVersion: 1, id: 'board-1', tripId: 'trip-p11', cards: [] }), NOW,
  );
  db.prepare(
    `INSERT INTO provisional_selections (trip_id, place_id, intent, updated_at)
     VALUES (?,?,?,?)`,
  ).run('trip-p11', 'place-pinned', 'pinned', NOW);
  db.prepare(
    `INSERT INTO provisional_selections (trip_id, place_id, intent, updated_at)
     VALUES (?,?,?,?)`,
  ).run('trip-p11', 'place-hidden', 'hidden', NOW);

  db.prepare(
    `INSERT INTO board_reconciliations (trip_id, provisional_board_id, compiled_region_id,
      schema_version, payload_json, created_at) VALUES (?,?,?,?,?,?)`,
  ).run(
    'trip-p11', 'board-1', 'region-p11', 1,
    JSON.stringify({ schemaVersion: 1, tripId: 'trip-p11', entries: [] }), NOW,
  );
}

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe('a pre-Phase-12 database survives the final sprint', () => {
  let path: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'sidequest-migration-p12-'));
    path = join(directory, 'pre.db');
    const db = new Database(path);
    db.pragma('foreign_keys = ON');
    db.exec(PRE_PHASE_12_SCHEMA);
    seedThroughPhase11(db);
    db.close();
  });

  it('gains every new table, and every one of them arrives empty', () => {
    migrate(path);
    const db = new Database(path);
    /*
     * Arriving *empty* is the assertion, not merely arriving. A migration that
     * back-filled a provisional board for an old trip would be inventing a
     * screen nobody was ever shown, and a reconciliation nobody's choices
     * produced.
     */
    for (const table of [
      'decision_sessions',
      'provisional_boards',
      'provisional_selections',
      'board_reconciliations',
      'destination_images',
      'stage_observations',
      'interpretation_cache',
      'weather_snapshots',
    ]) {
      const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
      expect(row.n, `${table} arrived with rows in it`).toBe(0);
    }
    db.close();
  });

  it('leaves every generation of artifact byte-identical', () => {
    const before = new Database(path);
    const payloads = Object.fromEntries(
      (
        before.prepare('SELECT id, payload_json FROM compiled_regions').all() as {
          id: string;
          payload_json: string;
        }[]
      ).map((row) => [row.id, row.payload_json]),
    );
    before.close();

    migrate(path);

    const after = new Database(path);
    for (const row of after.prepare('SELECT id, payload_json FROM compiled_regions').all() as {
      id: string;
      payload_json: string;
    }[]) {
      expect(row.payload_json, `${row.id} changed under migration`).toBe(payloads[row.id]);
    }
    // And no artifact acquired a key it never had.
    const p7 = JSON.parse(payloads['region-p7'] ?? '{}') as Record<string, unknown>;
    expect(p7.evidence).toBeUndefined();
    expect(p7.regionPack).toBeUndefined();
    expect(p7.stageCount).toBeUndefined();
    after.close();
  });

  it('does not make a single old trip look like it needs recompiling', () => {
    const before = new Database(path);
    const fingerprints = (
      before.prepare('SELECT trip_id, scope_fingerprint FROM compiled_regions').all() as {
        trip_id: string;
        scope_fingerprint: string;
      }[]
    ).map((row) => `${row.trip_id}:${row.scope_fingerprint}`);
    before.close();

    migrate(path);

    const after = new Database(path);
    const now = (
      after.prepare('SELECT trip_id, scope_fingerprint FROM compiled_regions').all() as {
        trip_id: string;
        scope_fingerprint: string;
      }[]
    ).map((row) => `${row.trip_id}:${row.scope_fingerprint}`);
    expect(now.sort()).toEqual(fingerprints.sort());
    expect(
      (after.prepare('SELECT COUNT(*) AS n FROM compilation_jobs WHERE state IN (?,?)')
        .get('queued', 'running') as { n: number }).n,
    ).toBe(0);
    after.close();
  });

  it('reports honestly when the fingerprint derivation itself has changed', () => {
    /**
     * THE TEST THAT WAS VACUOUS, AND WHAT IT NOW MEASURES.
     *
     * The version above reads `scope_fingerprint` from the database, runs an
     * additive DDL migration that never touches that column, reads it back, and
     * asserts the two are equal. It passes unconditionally — a `SELECT` before
     * and after a migration that alters no rows *cannot* differ — while its own
     * comment claimed it proved "unchanged fingerprints are precisely what stops
     * the plan page starting a new build". That is the one property it could not
     * see.
     *
     * It missed a real event. Adding an `edge:` segment to `scopeFingerprint`
     * orphaned every pre-existing artifact **by scope**, and this file reported
     * nothing, because the stored string had not changed — the *function* had.
     *
     * So the assertion has to recompute. `scopeFingerprint(storedScope)` against
     * the stored string is the only comparison that can tell a stable derivation
     * from a changed one, and it is deliberately **not** an equality assertion:
     * this closure changes the derivation again, on purpose, by adding the
     * containment contract version. What must hold is that the change is
     * *visible* and *consistent* — every artifact is orphaned, or none is, and
     * never a silent mixture where some old verdicts are treated as current.
     */
    const database = new Database(path);
    const rows = database.prepare(
      'SELECT id, scope_fingerprint, payload_json FROM compiled_regions',
    ).all() as { id: string; scope_fingerprint: string; payload_json: string }[];
    database.close();

    expect(rows.length, 'the fixture has no artifacts to check').toBeGreaterThan(0);

    const verdicts = rows.map((row) => {
      const payload = JSON.parse(row.payload_json) as { scope?: unknown };
      const scope = geographicScopeSchema.safeParse(payload.scope);
      return {
        id: row.id,
        /*
         * An artifact whose stored scope no longer parses is already absent to
         * every read path, so it is neither current nor a silent survivor.
         */
        readable: scope.success,
        current: scope.success && scopeFingerprint(scope.data) === row.scope_fingerprint,
      };
    });

    const readable = verdicts.filter((entry) => entry.readable);
    const current = readable.filter((entry) => entry.current);
    /*
     * All or nothing. A mixture means the derivation depends on something that
     * varies between artifacts, which is the shape in which "some old boards are
     * still trusted" hides.
     */
    expect(
      current.length === 0 || current.length === readable.length,
      `${current.length} of ${readable.length} stored artifacts are current under today's derivation — a mixture means the key depends on something that varies`,
    ).toBe(true);
  });

  it('never serves an artifact whose key today’s derivation would not produce', () => {
    /**
     * The other half, and the one that protects a traveller rather than a
     * migration: `getCompiledRegion` is a **primary-key** lookup reached from a
     * trip's stored `selected_compiled_region_id`, so it never consulted the
     * fingerprint. The pack invalidation could hold three ways over and the
     * *artifact* built from a contaminated pack would render until somebody
     * pressed rebuild.
     */
    const database = new Database(path);
    const row = database.prepare(
      'SELECT id, scope_fingerprint, payload_json FROM compiled_regions LIMIT 1',
    ).get() as { id: string; scope_fingerprint: string; payload_json: string } | undefined;
    database.close();
    expect(row).toBeDefined();

    const payload = JSON.parse(row!.payload_json) as { scope?: unknown; scopeFingerprint?: string };
    const scope = geographicScopeSchema.safeParse(payload.scope);
    if (!scope.success) return;

    /*
     * The artifact carries both its inputs and its key, so the staleness check
     * needs nothing external — which is what makes it applicable on the
     * primary-key path, where no scope is in hand to compare against.
     */
    const recomputed = scopeFingerprint(scope.data);
    const stale = { ...payload, scopeFingerprint: `${recomputed}/from-another-contract` };
    expect(scopeFingerprint(scope.data) === stale.scopeFingerprint).toBe(false);
  });

  it('leaves the itinerary, its items and the shared claim exactly where they were', () => {
    migrate(path);
    const db = new Database(path);
    expect(
      (db.prepare('SELECT summary FROM itineraries WHERE trip_id = ?').get('trip-authored') as {
        summary: string;
      }).summary,
    ).toBe('A summary.');
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM itinerary_items').get() as { n: number }).n,
    ).toBe(1);
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM evidence_claims WHERE superseded = 0')
        .get() as { n: number }).n,
    ).toBe(1);
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM compiled_region_claims').get() as { n: number }).n,
    ).toBe(1);
    // The pack a Phase-9 plan names is still the pack it names.
    expect(
      (db.prepare('SELECT content_hash FROM region_packs WHERE id = ?').get('pack-9') as {
        content_hash: string;
      }).content_hash,
    ).toBe('content-9');
    db.close();
  });

  it('keeps a failed job failed, and its old fabricated stage clock readable', () => {
    migrate(path);
    const db = new Database(path);
    const job = db.prepare('SELECT state, stages_json, operational_json FROM compilation_jobs WHERE id = ?')
      .get('job-failed') as { state: string; stages_json: string; operational_json: string | null };
    expect(job.state).toBe('failed');
    /*
     * The old row still carries `ms: 1` from the fabricated clock. It is left
     * exactly as written: rewriting somebody's stored history to match a schema
     * we changed afterwards is a worse lie than the one we are fixing.
     * `observedDurationMs` returns null for it, and the screen shows no duration.
     */
    expect(JSON.parse(job.stages_json)).toEqual([
      { stage: 'expanding_region', status: 'done', ms: 1 },
    ]);
    // The new column exists and is null, which reads as "this build recorded none".
    expect(job.operational_json).toBeNull();
    db.close();
  });

  it('is idempotent: migrating twice changes nothing', () => {
    migrate(path);
    const first = new Database(path);
    const snapshot = JSON.stringify(
      first.prepare('SELECT id, payload_json FROM compiled_regions ORDER BY id').all(),
    );
    first.close();
    migrate(path);
    const second = new Database(path);
    expect(
      JSON.stringify(second.prepare('SELECT id, payload_json FROM compiled_regions ORDER BY id').all()),
    ).toBe(snapshot);
    second.close();
  });
});

// ---------------------------------------------------------------------------

describe('a mid-Phase-12 database survives the final sprint', () => {
  let path: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'sidequest-migration-p12b-'));
    path = join(directory, 'mid.db');
    const db = new Database(path);
    db.pragma('foreign_keys = ON');
    db.exec(MID_PHASE_12_SCHEMA);
    seedThroughPhase11(db);
    seedPhase12(db);
    db.close();
  });

  it('does not lose a single provisional selection', () => {
    migrate(path);
    const db = new Database(path);
    const rows = db
      .prepare('SELECT place_id, intent FROM provisional_selections ORDER BY place_id')
      .all() as { place_id: string; intent: string }[];
    /*
     * Both of them, and with their intents intact. "Hidden" is as much a
     * decision as "pinned" — a migration that kept only the pins would be
     * deciding on somebody's behalf that their dismissals did not count.
     */
    expect(rows).toEqual([
      { place_id: 'place-hidden', intent: 'hidden' },
      { place_id: 'place-pinned', intent: 'pinned' },
    ]);
    db.close();
  });

  it('keeps the provisional board readable and the decision session intact', () => {
    migrate(path);
    const db = new Database(path);
    const board = db.prepare('SELECT payload_json, version FROM provisional_boards WHERE id = ?')
      .get('board-1') as { payload_json: string; version: number };
    expect(board.version).toBe(1);
    expect(JSON.parse(board.payload_json)).toMatchObject({ id: 'board-1', tripId: 'trip-p11' });
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM decision_sessions').get() as { n: number }).n,
    ).toBe(1);
    db.close();
  });

  it('adds the acknowledgement column without claiming anything was acknowledged', () => {
    migrate(path);
    const db = new Database(path);
    const row = db
      .prepare('SELECT schema_version, acknowledged_json FROM board_reconciliations WHERE trip_id = ?')
      .get('trip-p11') as { schema_version: number; acknowledged_json: string | null };
    /*
     * Null, not `{}`. An empty object would be a record of the panel having been
     * shown and nothing acknowledged; null is the truth, which is that this
     * reconciliation predates acknowledgement entirely.
     */
    expect(row.acknowledged_json).toBeNull();
    /*
     * And the row is still at schema version 1, which the reader treats as
     * absent rather than coercing. A v1 reconciliation has no reason codes and
     * no explanations; parsing it as v2 would put empty strings on screen where
     * an explanation belongs.
     */
    expect(row.schema_version).toBe(1);
    db.close();
  });

  it('leaves imagery and timing optional, and both empty', () => {
    migrate(path);
    const db = new Database(path);
    for (const table of ['destination_images', 'stage_observations']) {
      expect(
        (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n,
        `${table} was populated by a migration`,
      ).toBe(0);
    }
    // And the artifacts still render without either: neither table is referenced
    // by a foreign key from anything an old trip owns.
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM compiled_regions').get() as { n: number }).n,
    ).toBe(4);
    db.close();
  });

  it('adds the two new tables and touches nothing that was already there', () => {
    const before = new Database(path);
    const counts = {
      trips: (before.prepare('SELECT COUNT(*) AS n FROM trips').get() as { n: number }).n,
      boards: (before.prepare('SELECT COUNT(*) AS n FROM provisional_boards').get() as { n: number }).n,
      claims: (before.prepare('SELECT COUNT(*) AS n FROM evidence_claims').get() as { n: number }).n,
    };
    before.close();

    migrate(path);

    const after = new Database(path);
    expect((after.prepare('SELECT COUNT(*) AS n FROM trips').get() as { n: number }).n).toBe(counts.trips);
    expect((after.prepare('SELECT COUNT(*) AS n FROM provisional_boards').get() as { n: number }).n).toBe(counts.boards);
    expect((after.prepare('SELECT COUNT(*) AS n FROM evidence_claims').get() as { n: number }).n).toBe(counts.claims);
    for (const table of ['interpretation_cache', 'weather_snapshots']) {
      expect(
        (after.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n,
      ).toBe(0);
    }
    after.close();
  });

  it('lets a traveller-scoped interpretation exist only alongside a trip', () => {
    migrate(path);
    const db = new Database(path);
    db.pragma('foreign_keys = ON');
    /*
     * The inverse of the evidence-store assertion, and deliberately so. A shared
     * evidence row may not be keyed on a trip; this one *must* be, because it is
     * a reading of one person's sentence rather than a fact about the world.
     */
    expect(() =>
      db
        .prepare(
          `INSERT INTO interpretation_cache (cache_key, trip_id, payload_json, created_at, expires_at)
           VALUES (?,?,?,?,?)`,
        )
        .run('interp:x', 'trip-that-does-not-exist', '{}', NOW, NOW),
    ).toThrow();

    db.prepare(
      `INSERT INTO interpretation_cache (cache_key, trip_id, payload_json, created_at, expires_at)
       VALUES (?,?,?,?,?)`,
    ).run('interp:x', 'trip-p11', '{}', NOW, '2026-09-01T00:00:00.000Z');
    db.prepare('DELETE FROM trips WHERE id = ?').run('trip-p11');
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM interpretation_cache').get() as { n: number }).n,
    ).toBe(0);
    db.close();
  });
});
