import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PROVISIONAL_BOARD_VERSION,
  RECONCILE_OUTCOME_COPY,
  RECONCILIATION_VERSION,
  UNNAMED_ENTRY_COPY,
  type ProvisionalBoard,
  type ProvisionalCard,
  type ReconciliationBasis,
} from '@sidequest/core';
import { getDb } from './client';
import {
  acknowledgeReconciliationEntry,
  actionStateCounts,
  clearProvisionalSelection,
  getAcknowledgements,
  getProvisionalSelections,
  getReconciliation,
  getReconciliationFor,
  listProvisionalActions,
  listReconciliationHistory,
  pendingActionCount,
  reconcilePendingActions,
  saveProvisionalBoard,
  saveReconciliation,
  setProvisionalSelection,
} from './provisional-repository';

/**
 * VERSIONED TRAVELLER INTENT, AGAINST A REAL DATABASE.
 *
 * `reconcile.test.ts` proves the *decisions*. This proves the storage promises
 * those decisions rest on, and it is written around the twelve moments a mark
 * can arrive relative to a build: before it, during it, after it, twice at once,
 * against a board that has since been rebuilt, against an artifact that has
 * since been superseded, delivered twice, replayed by a stale worker, and read
 * in between.
 *
 * The invariant every one of them is checked against is the same, and it is
 * checkable from the database rather than inferred from the code: **every action
 * ends in exactly one explicit reconciliation state.** The defect this replaced
 * left a mark made after the account was written in *no* state at all, while the
 * panel above it claimed to be showing "all N decisions you made".
 */

let directory: string;
const TRIP = 'trip-1';
const NOW = new Date('2026-08-03T09:00:00.000Z');

function closeDb(): void {
  const cache = globalThis as unknown as { sidequestDb?: { close: () => void } };
  cache.sidequestDb?.close();
  delete cache.sidequestDb;
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'sidequest-provisional-'));
  process.env.SIDEQUEST_DB_PATH = join(directory, 'provisional.db');
  closeDb();
  getDb();
  seedTrip();
});

afterEach(() => {
  closeDb();
  delete process.env.SIDEQUEST_DB_PATH;
  rmSync(directory, { recursive: true, force: true });
});

function seedTrip(): void {
  getDb()
    .prepare(
      `INSERT INTO trips (id, mode, destination_input, region_id, start_date, end_date,
                          arrival_time, departure_time, adults, children, status,
                          created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      TRIP,
      'known_destination',
      'Somewhere',
      'dynamic',
      '2026-09-01',
      '2026-09-05',
      '12:00',
      '12:00',
      2,
      0,
      'draft',
      NOW.toISOString(),
      NOW.toISOString(),
    );
}

/** A compiled artifact, as far as reconciliation is concerned: identities and names. */
function seedRegion(id: string, places: { id: string; name: string }[]): void {
  getDb()
    .prepare(
      `INSERT INTO compiled_regions (id, trip_id, scope_fingerprint, schema_version,
                                     compiler_version, payload_json, created_at)
       VALUES (?,?,?,?,?,?,?)`,
    )
    .run(id, TRIP, 'fp', 1, 'test', JSON.stringify({ id, places }), NOW.toISOString());
}

/** What the trip is currently pointed at, which is what a late mark reconciles against. */
function selectRegion(id: string): void {
  getDb()
    .prepare(
      `INSERT INTO trip_intents (trip_id, mode, selected_compiled_region_id, created_at, updated_at)
       VALUES (?,?,?,?,?)
       ON CONFLICT(trip_id) DO UPDATE SET selected_compiled_region_id = excluded.selected_compiled_region_id`,
    )
    .run(TRIP, 'known_destination', id, NOW.toISOString(), NOW.toISOString());
}

function card(id: string, overrides: Partial<ProvisionalCard> = {}): ProvisionalCard {
  return {
    placeId: id,
    name: `Place ${id}`,
    locality: 'Somewhere',
    category: 'museum',
    role: 'attraction',
    sourceCategory: 'museum',
    coordinates: { lat: 40, lng: 10 },
    clusterId: 'area-1',
    clusterName: 'Area One',
    nearestBaseId: 'base-1',
    nearestBaseName: 'Base One',
    preliminaryFit: 0.6,
    matchedInterests: [],
    matchedPreferences: [],
    presence: 'single_source',
    sources: ['test'],
    mergedFromCount: 0,
    group: 'nearby_side_quests',
    pending: ['travel_time'],
    evidence: 'provisional',
    ...overrides,
  };
}

function boardOf(cards: ProvisionalCard[], jobId = 'job-1'): ProvisionalBoard {
  return {
    schemaVersion: PROVISIONAL_BOARD_VERSION,
    id: 'board',
    tripId: TRIP,
    jobId,
    scopeFingerprint: 'fp',
    version: 1,
    cards,
    clusters: [
      { id: 'area-1', name: 'Area One', baseId: 'base-1', baseName: 'Base One', cardCount: cards.length },
    ],
    counts: {
      discovered: cards.length,
      deduped: cards.length,
      shortlisted: cards.length,
      retained: cards.length,
      // Nothing was refused as transport or services in this fixture.
      droppedUtilityRole: 0,
      droppedThin: 0,
      droppedNoAccessRule: 0,
    },
    byRole: [{ role: 'attraction', count: cards.length }],
    estimated: true,
    verifiedClaimCount: 0,
    travelTimesMeasured: false,
    builtAt: NOW.toISOString(),
  };
}

function basis(overrides: Partial<ReconciliationBasis> = {}): ReconciliationBasis {
  return { removals: [], duplicates: [], changedPlaceIds: [], ...overrides };
}

/**
 * The invariant, asserted from the database rather than from the code.
 *
 * Every action is in exactly one recognised state, and the states add up to the
 * number of rows. A row in no state — the defect this whole model replaced —
 * fails here rather than showing up as a wrong number on a panel.
 */
function expectEveryActionAccountedFor(): ReturnType<typeof actionStateCounts> {
  const counts = actionStateCounts(TRIP);
  expect(counts.unrecognised).toBe(0);
  expect(counts.pending + counts.reconciled + counts.superseded + counts.withdrawn).toBe(
    counts.total,
  );
  const rows = getDb()
    .prepare('SELECT COUNT(*) AS n FROM provisional_actions WHERE trip_id = ?')
    .get(TRIP) as { n: number };
  expect(counts.total).toBe(rows.n);
  return counts;
}

// ---------------------------------------------------------------------------
// When the mark arrives, relative to the build
// ---------------------------------------------------------------------------

describe('a mark made before anything has been compiled', () => {
  it('stays pending, explicitly, and says so rather than being silently absent', () => {
    saveProvisionalBoard(boardOf([card('a')]), NOW);
    setProvisionalSelection(TRIP, 'a', 'pinned', NOW);

    const result = reconcilePendingActions({ tripId: TRIP, now: NOW });

    expect(result.state).toBe('awaiting_compiled_region');
    expect(result.pendingActions).toBe(1);
    expect(pendingActionCount(TRIP)).toBe(1);
    expect(getReconciliation(TRIP)).toBeNull();
    expectEveryActionAccountedFor();
  });

  it('is reconciled the moment the final board arrives', () => {
    saveProvisionalBoard(boardOf([card('a'), card('b')]), NOW);
    setProvisionalSelection(TRIP, 'a', 'pinned', NOW);
    setProvisionalSelection(TRIP, 'b', 'interested', NOW);

    seedRegion('region-1', [{ id: 'a', name: 'Place a' }]);
    const result = reconcilePendingActions({
      tripId: TRIP,
      now: NOW,
      compiledRegionId: 'region-1',
      basis: basis({
        removals: [{ placeId: 'b', outcome: 'removed_closed', detail: 'Gated until June.', detailStage: 'availability' }],
      }),
    });

    expect(result.state).toBe('reconciled');
    expect(result.reconciledActions).toBe(2);
    expect(result.pendingActions).toBe(0);

    const account = getReconciliation(TRIP)!;
    expect(account.entries).toHaveLength(2);
    expect(account.entries.find((entry) => entry.placeId === 'b')!.outcome).toBe('removed_closed');
    expect(expectEveryActionAccountedFor().pending).toBe(0);
  });
});

describe('a mark made while a build is running', () => {
  /**
   * The pass is synchronous and transactional, so the window this describes is
   * "after the artifact was committed and before the pass ran". The property
   * that has to hold is that no arrival order leaves an action in neither state:
   * either this pass accounts for it, or it is still pending and the next one
   * does.
   */
  it('is never lost, whichever side of the pass it lands on', () => {
    saveProvisionalBoard(boardOf([card('a'), card('b')]), NOW);
    setProvisionalSelection(TRIP, 'a', 'interested', NOW);

    seedRegion('region-1', [{ id: 'a', name: 'Place a' }, { id: 'b', name: 'Place b' }]);
    selectRegion('region-1');

    // Arrives between the artifact being committed and the pass running.
    setProvisionalSelection(TRIP, 'b', 'pinned', NOW);
    expect(pendingActionCount(TRIP)).toBe(2);

    const result = reconcilePendingActions({ tripId: TRIP, now: NOW, compiledRegionId: 'region-1' });
    expect(result.state).toBe('reconciled');
    expect(pendingActionCount(TRIP)).toBe(0);
    expect(getReconciliation(TRIP)!.entries.map((entry) => entry.placeId).sort()).toEqual(['a', 'b']);
    expectEveryActionAccountedFor();
  });
});

describe('a mark made after the account was written', () => {
  /**
   * B-1, the whole of it. The board stays interactive once the account exists,
   * nothing used to re-run reconciliation, and the panel went on claiming to
   * show "all N decisions you made" while holding N-1 of them.
   */
  it('is reconciled against the current final board rather than left unrecorded', () => {
    saveProvisionalBoard(boardOf([card('a'), card('b')]), NOW);
    setProvisionalSelection(TRIP, 'a', 'interested', NOW);
    seedRegion('region-1', [{ id: 'a', name: 'Place a' }]);
    selectRegion('region-1');

    reconcilePendingActions({ tripId: TRIP, now: NOW, compiledRegionId: 'region-1' });
    expect(getReconciliation(TRIP)!.entries).toHaveLength(1);

    // A minute later, on the same board, the traveller pins something else.
    const later = new Date(NOW.getTime() + 60_000);
    setProvisionalSelection(TRIP, 'b', 'pinned', later);
    expect(pendingActionCount(TRIP)).toBe(1);

    const result = reconcilePendingActions({ tripId: TRIP, now: later });
    expect(result.state).toBe('reconciled');

    const account = getReconciliation(TRIP)!;
    expect(account.entries.map((entry) => entry.placeId).sort()).toEqual(['a', 'b']);
    const late = account.entries.find((entry) => entry.placeId === 'b')!;
    expect(late.acknowledgementRequired).toBe(true);
    expect(pendingActionCount(TRIP)).toBe(0);
    expectEveryActionAccountedFor();
  });

  /**
   * The persisted basis earning its keep. Removals travel on the compile result
   * and the result is long gone by the time a late mark arrives — so without the
   * ledger, pinning a museum that is shut on your dates a minute after the build
   * would be answered with "nobody publishes enough about it".
   */
  it('gets the reason the build actually recorded, not the honest default', () => {
    saveProvisionalBoard(boardOf([card('a'), card('shut')]), NOW);
    setProvisionalSelection(TRIP, 'a', 'interested', NOW);
    seedRegion('region-1', [{ id: 'a', name: 'Place a' }]);
    selectRegion('region-1');

    reconcilePendingActions({
      tripId: TRIP,
      now: NOW,
      compiledRegionId: 'region-1',
      basis: basis({
        removals: [
          {
            placeId: 'shut',
            outcome: 'removed_closed',
            detail: 'The road is gated until June.',
            detailStage: 'availability',
          },
        ],
      }),
    });

    const later = new Date(NOW.getTime() + 60_000);
    setProvisionalSelection(TRIP, 'shut', 'pinned', later);
    reconcilePendingActions({ tripId: TRIP, now: later });

    const entry = getReconciliation(TRIP)!.entries.find((row) => row.placeId === 'shut')!;
    expect(entry.outcome).toBe('removed_closed');
    expect(entry.explanation).toBe(RECONCILE_OUTCOME_COPY.removed_closed);
    expect(entry.detail).toBe('The road is gated until June.');
    expect(entry.detailStage).toBe('availability');
  });
});

// ---------------------------------------------------------------------------
// Concurrency, retries and delivery
// ---------------------------------------------------------------------------

describe('two marks at once', () => {
  it('keeps both when they are different cards', () => {
    saveProvisionalBoard(boardOf([card('a'), card('b')]), NOW);
    setProvisionalSelection(TRIP, 'a', 'pinned', NOW);
    setProvisionalSelection(TRIP, 'b', 'hidden', NOW);

    const stored = getProvisionalSelections(TRIP);
    expect(stored.map((selection) => selection.intent).sort()).toEqual(['hidden', 'pinned']);
    expect(expectEveryActionAccountedFor().pending).toBe(2);
  });

  /**
   * Two marks on the same card. The later one is the traveller's answer; the
   * earlier one is history and is `superseded` rather than pending, which is
   * what keeps the pending set at most one action per card and the pass
   * idempotent without deduplicating anything at read time.
   */
  it('supersedes the earlier one on the same card rather than reconciling both', () => {
    saveProvisionalBoard(boardOf([card('a')]), NOW);
    const first = setProvisionalSelection(TRIP, 'a', 'interested', NOW);
    const second = setProvisionalSelection(TRIP, 'a', 'pinned', NOW);

    expect(second.actionVersion).toBe(first.actionVersion + 1);

    const counts = expectEveryActionAccountedFor();
    expect(counts.superseded).toBe(1);
    expect(counts.pending).toBe(1);
    expect(getProvisionalSelections(TRIP)[0]!.intent).toBe('pinned');

    const history = listProvisionalActions(TRIP);
    expect(history.map((action) => action.action)).toEqual(['interested', 'pinned']);
    expect(history[0]!.state).toBe('superseded');
  });

  /** A stale writer holding an older version cannot overwrite the current mark. */
  it('refuses a stale writer replaying an older version of the same card', () => {
    saveProvisionalBoard(boardOf([card('a')]), NOW);
    setProvisionalSelection(TRIP, 'a', 'interested', NOW);
    setProvisionalSelection(TRIP, 'a', 'pinned', NOW);

    const stale = setProvisionalSelection(TRIP, 'a', 'hidden', NOW, { actionVersion: 1 });
    expect(stale.recorded).toBe(false);
    expect(getProvisionalSelections(TRIP)[0]!.intent).toBe('pinned');
    expectEveryActionAccountedFor();
  });
});

describe('duplicate delivery', () => {
  it('records one event, not two, and changes nothing the second time', () => {
    saveProvisionalBoard(boardOf([card('a')]), NOW);
    const first = setProvisionalSelection(TRIP, 'a', 'pinned', NOW, { actionVersion: 7 });
    const replay = setProvisionalSelection(TRIP, 'a', 'pinned', NOW, { actionVersion: 7 });

    expect(first.recorded).toBe(true);
    expect(replay.recorded).toBe(false);
    expect(listProvisionalActions(TRIP)).toHaveLength(1);
    expect(expectEveryActionAccountedFor().total).toBe(1);
  });
});

describe('running the pass again', () => {
  it('is a no-op with nothing pending, and writes no second history row', () => {
    saveProvisionalBoard(boardOf([card('a')]), NOW);
    setProvisionalSelection(TRIP, 'a', 'interested', NOW);
    seedRegion('region-1', [{ id: 'a', name: 'Place a' }]);
    selectRegion('region-1');

    const first = reconcilePendingActions({ tripId: TRIP, now: NOW, compiledRegionId: 'region-1' });
    const retry = reconcilePendingActions({ tripId: TRIP, now: NOW, compiledRegionId: 'region-1' });
    const third = reconcilePendingActions({ tripId: TRIP, now: NOW });

    expect(first.state).toBe('reconciled');
    expect(retry.state).toBe('already_current');
    expect(third.state).toBe('already_current');
    expect(retry.reconciliationVersion).toBe(first.reconciliationVersion);
    expect(listReconciliationHistory(TRIP)).toHaveLength(0);
    expect(getReconciliation(TRIP)!.entries).toHaveLength(1);
  });
});

describe('a stale worker holding an older account', () => {
  /**
   * The compare-and-set, doing the only job it has. A worker that assembled an
   * account at version 2 while somebody else wrote version 3 loses — and is told
   * it lost, rather than overwriting a newer account with an older reading and
   * reporting success.
   */
  it('cannot overwrite a newer account', () => {
    saveProvisionalBoard(boardOf([card('a')]), NOW);
    setProvisionalSelection(TRIP, 'a', 'interested', NOW);
    seedRegion('region-1', [{ id: 'a', name: 'Place a' }]);

    reconcilePendingActions({ tripId: TRIP, now: NOW, compiledRegionId: 'region-1' });
    const current = getReconciliation(TRIP)!;
    expect(current.reconciliationVersion).toBe(1);

    const bumped = { ...current, reconciliationVersion: 5, reconciledAt: 'later' };
    expect(saveReconciliation(bumped, NOW)).toBe(true);

    const stale = { ...current, reconciliationVersion: 2, reconciledAt: 'stale-write' };
    expect(saveReconciliation(stale, NOW)).toBe(false);
    expect(getReconciliation(TRIP)!.reconciledAt).toBe('later');
    expect(getReconciliation(TRIP)!.reconciliationVersion).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// A superseding artifact
// ---------------------------------------------------------------------------

describe('a final board superseded by a newer one', () => {
  it('re-reconciles every affected mark and keeps the prior account inspectable', () => {
    saveProvisionalBoard(boardOf([card('a'), card('b')]), NOW);
    setProvisionalSelection(TRIP, 'a', 'pinned', NOW);
    setProvisionalSelection(TRIP, 'b', 'interested', NOW);

    seedRegion('region-1', [{ id: 'a', name: 'Place a' }, { id: 'b', name: 'Place b' }]);
    reconcilePendingActions({ tripId: TRIP, now: NOW, compiledRegionId: 'region-1' });
    expect(getReconciliation(TRIP)!.entries.every((entry) => entry.outcome === 'retained')).toBe(true);

    // The rebuild lost `a`, and it says why.
    seedRegion('region-2', [{ id: 'b', name: 'Place b' }]);
    const second = reconcilePendingActions({
      tripId: TRIP,
      now: NOW,
      compiledRegionId: 'region-2',
      basis: basis({ removals: [{ placeId: 'a', outcome: 'removed_safety_blocked' }] }),
    });

    expect(second.state).toBe('reconciled');
    expect(second.reconciledActions).toBe(2);
    expect(second.reconciliationVersion).toBe(2);

    const account = getReconciliation(TRIP)!;
    expect(account.compiledRegionId).toBe('region-2');
    expect(account.entries.find((entry) => entry.placeId === 'a')!.outcome).toBe(
      'removed_safety_blocked',
    );

    const history = listReconciliationHistory(TRIP);
    expect(history).toHaveLength(1);
    expect(history[0]!.compiledRegionId).toBe('region-1');
    expect(pendingActionCount(TRIP)).toBe(0);
    expectEveryActionAccountedFor();
  });

  /** A rebuild must not inherit the last build's acknowledgements. */
  it('clears acknowledgements when the artifact changes and keeps them when it does not', () => {
    saveProvisionalBoard(boardOf([card('a'), card('b')]), NOW);
    setProvisionalSelection(TRIP, 'a', 'pinned', NOW);
    seedRegion('region-1', [{ id: 'b', name: 'Place b' }]);
    reconcilePendingActions({ tripId: TRIP, now: NOW, compiledRegionId: 'region-1' });

    expect(
      acknowledgeReconciliationEntry(TRIP, 'region-1', {
        placeId: 'a',
        outcome: 'removed_insufficient_support',
        acknowledgedAt: NOW.toISOString(),
      }),
    ).toBe(true);
    expect(getAcknowledgements(TRIP)!.entries).toHaveLength(1);

    // Another mark against the same artifact rewrites the account and must not
    // make somebody re-read a removal they already acknowledged.
    setProvisionalSelection(TRIP, 'b', 'interested', NOW);
    selectRegion('region-1');
    reconcilePendingActions({ tripId: TRIP, now: NOW });
    expect(getAcknowledgements(TRIP)!.entries).toHaveLength(1);

    // A rebuild does clear them, because its bad news is its own.
    seedRegion('region-2', [{ id: 'b', name: 'Place b' }]);
    reconcilePendingActions({ tripId: TRIP, now: NOW, compiledRegionId: 'region-2' });
    expect(getAcknowledgements(TRIP)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// B-2 — the board a mark was made on
// ---------------------------------------------------------------------------

describe('which board a mark was made on', () => {
  it('stamps the board that was on screen, and reports it after a rebuild', () => {
    saveProvisionalBoard(boardOf([card('a')], 'job-1'), NOW);
    setProvisionalSelection(TRIP, 'a', 'pinned', NOW);

    const stored = getProvisionalSelections(TRIP)[0]!;
    expect(stored.boardVersion).toBe(1);
    expect(stored.boardId).toBe('board-v1');

    // The board is rebuilt. The mark is still a mark made on version 1.
    saveProvisionalBoard(boardOf([card('a')], 'job-2'), NOW);
    seedRegion('region-1', [{ id: 'a', name: 'Place a' }]);
    reconcilePendingActions({ tripId: TRIP, now: NOW, compiledRegionId: 'region-1' });

    const account = getReconciliation(TRIP)!;
    expect(account.provisionalBoardVersion).toBe(2);
    expect(account.entries[0]!.provisionalBoardVersion).toBe(1);
    expect(account.entries[0]!.provisionalBoardId).toBe('board-v1');
  });

  /**
   * A row written before board identity was carried. It reads as "we do not
   * know", which is an explicit state — never as version 1, which would assert
   * it was made on the first board.
   */
  it('reads a legacy row with no board as unknown rather than as version 1', () => {
    saveProvisionalBoard(boardOf([card('a')]), NOW);
    getDb()
      .prepare(
        `INSERT INTO provisional_selections (trip_id, place_id, intent, updated_at)
         VALUES (?,?,?,?)`,
      )
      .run(TRIP, 'a', 'pinned', NOW.toISOString());

    const stored = getProvisionalSelections(TRIP)[0]!;
    expect(stored.boardVersion).toBeUndefined();
    expect(stored.boardId).toBeUndefined();

    seedRegion('region-1', [{ id: 'a', name: 'Place a' }]);
    reconcilePendingActions({ tripId: TRIP, now: NOW, compiledRegionId: 'region-1' });
    const entry = getReconciliation(TRIP)!.entries[0]!;
    expect(entry.provisionalBoardVersion).toBeUndefined();
  });

  it('records no board at all when the caller says it does not know', () => {
    saveProvisionalBoard(boardOf([card('a')]), NOW);
    const written = setProvisionalSelection(TRIP, 'a', 'pinned', NOW, { board: null });
    expect(written.board.known).toBe(false);
    expect(getProvisionalSelections(TRIP)[0]!.boardVersion).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// B-6 / B-8 — names and survivors, through the stored basis
// ---------------------------------------------------------------------------

describe('what the account says about a card', () => {
  it('takes a name from the final board, and never renders an identity', () => {
    saveProvisionalBoard(boardOf([card('a')]), NOW);
    setProvisionalSelection(TRIP, 'place/osm/way/128374', 'pinned', NOW);
    setProvisionalSelection(TRIP, 'renamed', 'interested', NOW);

    seedRegion('region-1', [
      { id: 'a', name: 'Place a' },
      { id: 'renamed', name: 'The Old Lighthouse' },
    ]);
    reconcilePendingActions({ tripId: TRIP, now: NOW, compiledRegionId: 'region-1' });

    const account = getReconciliation(TRIP)!;
    expect(account.entries.find((entry) => entry.placeId === 'renamed')!.name).toBe(
      'The Old Lighthouse',
    );
    expect(account.entries.find((entry) => entry.placeId === 'place/osm/way/128374')!.name).toBe(
      UNNAMED_ENTRY_COPY,
    );
    for (const entry of account.entries) expect(entry.name).not.toBe(entry.placeId);
  });

  it('reports a changed card as changed, from the run’s own findings', () => {
    saveProvisionalBoard(boardOf([card('a')]), NOW);
    setProvisionalSelection(TRIP, 'a', 'pinned', NOW);
    seedRegion('region-1', [{ id: 'a', name: 'Place a' }]);

    reconcilePendingActions({
      tripId: TRIP,
      now: NOW,
      compiledRegionId: 'region-1',
      basis: basis({ changedPlaceIds: ['a'] }),
    });

    expect(getReconciliation(TRIP)!.entries[0]!.outcome).toBe('retained_with_changes');
  });

  it('does not claim a duplicate survivor that is not on the final board', () => {
    saveProvisionalBoard(boardOf([card('a'), card('b')]), NOW);
    setProvisionalSelection(TRIP, 'a', 'pinned', NOW);
    seedRegion('region-1', []);

    reconcilePendingActions({
      tripId: TRIP,
      now: NOW,
      compiledRegionId: 'region-1',
      basis: basis({ duplicates: [{ placeId: 'a', survivorPlaceId: 'b' }] }),
    });

    const entry = getReconciliation(TRIP)!.entries[0]!;
    expect(entry.outcome).toBe('removed_duplicate_survivor_lost');
    expect(entry.replacedByPlaceId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Withdrawal, reads, and legacy payloads
// ---------------------------------------------------------------------------

describe('taking a mark back', () => {
  it('records the withdrawal terminally rather than deleting it silently', () => {
    saveProvisionalBoard(boardOf([card('a')]), NOW);
    setProvisionalSelection(TRIP, 'a', 'pinned', NOW);
    clearProvisionalSelection(TRIP, 'a', NOW);

    expect(getProvisionalSelections(TRIP)).toHaveLength(0);
    const counts = expectEveryActionAccountedFor();
    expect(counts.withdrawn).toBe(1);
    expect(counts.superseded).toBe(1);
    expect(counts.pending).toBe(0);
    expect(listProvisionalActions(TRIP).map((action) => action.action)).toEqual([
      'pinned',
      'cleared',
    ]);
  });
});

describe('reading between a mark and a reconciliation', () => {
  /** A refresh is a read. It must not move anything. */
  it('changes no state', () => {
    saveProvisionalBoard(boardOf([card('a')]), NOW);
    setProvisionalSelection(TRIP, 'a', 'pinned', NOW);

    const before = actionStateCounts(TRIP);
    getProvisionalSelections(TRIP);
    getReconciliation(TRIP);
    getAcknowledgements(TRIP);
    listProvisionalActions(TRIP);
    pendingActionCount(TRIP);
    expect(actionStateCounts(TRIP)).toEqual(before);

    seedRegion('region-1', [{ id: 'a', name: 'Place a' }]);
    reconcilePendingActions({ tripId: TRIP, now: NOW, compiledRegionId: 'region-1' });
    expect(pendingActionCount(TRIP)).toBe(0);
  });
});

describe('an account whose artifact is not the one on screen', () => {
  /**
   * B-3, at the layer that can enforce it. The page used to read the account
   * unconditionally, so a failed rebuild left build 1's removals above build 2's
   * board with every sentence in the present tense.
   */
  it('is not returned for a different compiled region', () => {
    saveProvisionalBoard(boardOf([card('a')]), NOW);
    setProvisionalSelection(TRIP, 'a', 'interested', NOW);
    seedRegion('region-1', [{ id: 'a', name: 'Place a' }]);
    reconcilePendingActions({ tripId: TRIP, now: NOW, compiledRegionId: 'region-1' });

    expect(getReconciliationFor(TRIP, 'region-1')).not.toBeNull();
    expect(getReconciliationFor(TRIP, 'region-2')).toBeNull();
  });
});

describe('an artifact that cannot be read', () => {
  it('says so, and does not report an empty final board as a wipeout', () => {
    saveProvisionalBoard(boardOf([card('a')]), NOW);
    setProvisionalSelection(TRIP, 'a', 'pinned', NOW);
    getDb()
      .prepare(
        `INSERT INTO compiled_regions (id, trip_id, scope_fingerprint, schema_version,
                                       compiler_version, payload_json, created_at)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run('region-bad', TRIP, 'fp', 1, 'test', '{not json', NOW.toISOString());

    const result = reconcilePendingActions({
      tripId: TRIP,
      now: NOW,
      compiledRegionId: 'region-bad',
    });
    expect(result.state).toBe('compiled_region_unreadable');
    expect(getReconciliation(TRIP)).toBeNull();
    expect(pendingActionCount(TRIP)).toBe(1);
  });
});

describe('a stored account written before this model existed', () => {
  /**
   * Compatibility, stated as a test rather than as a comment. A version-2
   * payload with no `basis` and no `reconciliationVersion` still parses, because
   * every difference is additive with a default or a relaxation. The alternative
   * was to bump the version and have every stored account degrade to absent —
   * losing exactly the explanations this module exists to keep.
   */
  it('still parses, and reads as version 1 of the account rather than throwing', () => {
    const legacy = {
      schemaVersion: RECONCILIATION_VERSION,
      tripId: TRIP,
      provisionalBoardId: 'board-v1',
      provisionalBoardVersion: 1,
      compiledRegionId: 'region-1',
      entries: [
        {
          placeId: 'a',
          name: 'Place a',
          provisionalBoardVersion: 1,
          intent: 'pinned',
          outcome: 'removed_closed',
          reasonCode: 'closed_on_trip_dates',
          explanation: 'An official source says it is shut on your dates.',
          alternatives: [],
          acknowledgementRequired: true,
        },
      ],
      addedPlaceIds: [],
      reconciledAt: NOW.toISOString(),
    };
    getDb()
      .prepare(
        `INSERT INTO board_reconciliations
           (trip_id, provisional_board_id, compiled_region_id, schema_version, payload_json, created_at)
         VALUES (?,?,?,?,?,?)`,
      )
      .run(TRIP, 'board-v1', 'region-1', RECONCILIATION_VERSION, JSON.stringify(legacy), NOW.toISOString());

    const account = getReconciliation(TRIP)!;
    expect(account.entries).toHaveLength(1);
    expect(account.reconciliationVersion).toBe(1);
    expect(account.basis.removals).toEqual([]);
  });

  it('reads an unparseable payload as absent rather than throwing', () => {
    getDb()
      .prepare(
        `INSERT INTO board_reconciliations
           (trip_id, provisional_board_id, compiled_region_id, schema_version, payload_json, created_at)
         VALUES (?,?,?,?,?,?)`,
      )
      .run(TRIP, 'board-v1', 'region-1', RECONCILIATION_VERSION, '{not json', NOW.toISOString());

    expect(() => getReconciliation(TRIP)).not.toThrow();
    expect(getReconciliation(TRIP)).toBeNull();
    expect(getAcknowledgements(TRIP)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// G-21 / G-22
// ---------------------------------------------------------------------------

describe('storing a provisional board', () => {
  /**
   * G-21. The insert conflicted on `id` only, while the table also carries a
   * unique index on `job_id` — so a second board from one job raised a
   * constraint error the runner's `try` swallowed, and the build lost its board
   * with nothing anywhere saying so.
   */
  it('treats a second board from one job as an explicit no-op, not a throw', () => {
    const first = saveProvisionalBoard(boardOf([card('a')], 'job-1'), NOW);
    expect(first.stored).toBe(true);
    expect(first.version).toBe(1);

    let second: ReturnType<typeof saveProvisionalBoard> | undefined;
    expect(() => {
      second = saveProvisionalBoard(boardOf([card('a'), card('b')], 'job-1'), NOW);
    }).not.toThrow();
    expect(second!.stored).toBe(false);
    expect(second!.boardId).toBe(first.boardId);

    const rows = getDb()
      .prepare('SELECT COUNT(*) AS n FROM provisional_boards WHERE trip_id = ?')
      .get(TRIP) as { n: number };
    expect(rows.n).toBe(1);
  });

  it('supersedes across jobs, and stamps the job in the same transaction', () => {
    getDb()
      .prepare(
        `INSERT INTO compilation_jobs (id, trip_id, scope_fingerprint, state, stage,
                                       started_at, updated_at, heartbeat_at, correlation_id)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        'job-2',
        TRIP,
        'fp',
        'running',
        'discovering_sources',
        NOW.toISOString(),
        NOW.toISOString(),
        NOW.toISOString(),
        'corr-1',
      );

    saveProvisionalBoard(boardOf([card('a')], 'job-1'), NOW);
    const second = saveProvisionalBoard(boardOf([card('a')], 'job-2'), NOW);

    expect(second.version).toBe(2);
    const job = getDb()
      .prepare('SELECT provisional_board_id FROM compilation_jobs WHERE id = ?')
      .get('job-2') as { provisional_board_id: string | null };
    expect(job.provisional_board_id).toBe(second.boardId);
  });
});

describe('acknowledging a removal', () => {
  /**
   * G-22. It used to be an unconditional `UPDATE … WHERE trip_id = ?` with a
   * `void` return, so an acknowledgement against a trip with no account — or an
   * account about a different build — reported success having written nothing,
   * and the row stayed unread under a confirmation saying otherwise.
   */
  it('reports failure when it matched no row', () => {
    expect(
      acknowledgeReconciliationEntry(TRIP, 'region-1', {
        placeId: 'a',
        outcome: 'removed_closed',
        acknowledgedAt: NOW.toISOString(),
      }),
    ).toBe(false);
    expect(getAcknowledgements(TRIP)).toBeNull();
  });

  it('refuses to attach an acknowledgement to an account about a different build', () => {
    saveProvisionalBoard(boardOf([card('a')]), NOW);
    setProvisionalSelection(TRIP, 'a', 'pinned', NOW);
    seedRegion('region-1', []);
    reconcilePendingActions({ tripId: TRIP, now: NOW, compiledRegionId: 'region-1' });

    expect(
      acknowledgeReconciliationEntry(TRIP, 'region-9', {
        placeId: 'a',
        outcome: 'removed_insufficient_support',
        acknowledgedAt: NOW.toISOString(),
      }),
    ).toBe(false);
    expect(getAcknowledgements(TRIP)).toBeNull();

    expect(
      acknowledgeReconciliationEntry(TRIP, 'region-1', {
        placeId: 'a',
        outcome: 'removed_insufficient_support',
        acknowledgedAt: NOW.toISOString(),
      }),
    ).toBe(true);
    expect(getAcknowledgements(TRIP)!.entries.map((entry) => entry.placeId)).toEqual(['a']);
  });
});
