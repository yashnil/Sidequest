import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ITINERARY_VERSION, dayBackupSchema } from '@sidequest/core';
import { getDb } from './client';
import { StaleItineraryError, getItinerary, hasItinerary } from './repository';

/**
 * WHAT HAPPENS TO A PLAN WRITTEN BY THE BUILD BEFORE THIS ONE.
 *
 * `ITINERARY_VERSION` is the only thing standing between a traveller and a
 * screen that states, with the confidence of a finished plan, a fact that has
 * since stopped being true. It has been bumped eight times. Until this file
 * there was **no test anywhere** that constructed a stale row and asserted what
 * the product does with it — not a unit test, not a browser spec — so every one
 * of those eight bumps shipped with zero coverage on the exact path it exists to
 * trigger. The three `migration*.test.ts` files migrate *tables*; none of them
 * has ever exercised an itinerary version mismatch.
 *
 * Phase 15D bumped it to 8 for `DayBackup.driveMinutesFromBase` →
 * `travelMinutesFromBase` + `travelModeFromBase`, and that rename makes the gap
 * concrete rather than theoretical. Without the bump a version-7 row would still
 * *have* a version this build accepts, sail through the gate, and then fail
 * `itinerarySchema.parse` on a missing field — which routes the traveller to
 * "that saved plan is no longer readable" (a corruption screen, with no rebuild
 * offered) instead of "this plan is from an earlier version of Sidequest" (a
 * rebuild that keeps every selection). Two very different mornings.
 *
 * Everything here runs against a real SQLite file, because the promise being
 * tested is a storage promise.
 */

let directory: string;
const TRIP = 'trip-version';

function closeDb(): void {
  const cache = globalThis as unknown as { sidequestDb?: { close: () => void } };
  cache.sidequestDb?.close();
  delete cache.sidequestDb;
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'sidequest-itinerary-version-'));
  process.env.SIDEQUEST_DB_PATH = join(directory, 'version.db');
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
  const now = '2026-08-10T09:00:00.000Z';
  getDb()
    .prepare(
      `INSERT INTO trips (id, mode, destination_input, region_id, start_date, end_date,
         arrival_time, departure_time, adults, children, traveler_needs, status, created_at, updated_at)
       VALUES (?, 'known_destination', 'Two Rivers', 'eastern-sierra', '2026-08-12', '2026-08-13',
         '10:00', '18:00', 2, 0, '[]', 'planning', ?, ?)`,
    )
    .run(TRIP, now, now);
}

/**
 * A stored plan at an arbitrary version, written the way the previous build
 * would have written it.
 *
 * The head row alone is enough: the gate reads `version` before it touches a
 * single day, which is the property that makes a rebuild offer possible at all.
 * Writing full version-7 days would test the *parser*, and the parser is not
 * what protects this path.
 */
function writeStoredItinerary(version: number): void {
  getDb()
    .prepare(
      `INSERT INTO itineraries (trip_id, version, region_id, base_id, base_name, start_date, end_date,
         status, summary, transport_strategy_json, food_plan_json, issues_json, unscheduled_json,
         diagnostics_json, created_at, updated_at)
       VALUES (?, ?, 'eastern-sierra', 'base-mammoth-lakes', 'Mammoth Lakes', '2026-08-12', '2026-08-13',
         'ready', 'A stored plan.', '{}', '{}', '[]', '[]', '{}', ?, ?)`,
    )
    .run(TRIP, version, '2026-08-10T09:00:00.000Z', '2026-08-10T09:00:00.000Z');
}

describe('a stored plan from an earlier build', () => {
  it('is refused as stale rather than read, and names the version it was', () => {
    writeStoredItinerary(ITINERARY_VERSION - 1);

    /*
     * `hasItinerary` still says yes, and must: the trip *has* a plan, it is
     * simply one this build will not render. A repository that answered "no"
     * here would send the traveller to "you have not built this trip yet" and
     * quietly lose every choice they made.
     */
    expect(hasItinerary(TRIP)).toBe(true);

    let thrown: unknown;
    try {
      getItinerary(TRIP);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(StaleItineraryError);
    expect((thrown as StaleItineraryError).storedVersion).toBe(ITINERARY_VERSION - 1);
  });

  it('is refused whichever earlier version it is, including the one before the rename', () => {
    /*
     * `ITINERARY_VERSION - 1` is 7 — the version this pass superseded and the
     * one that can still be sitting in a real database. The earlier two are the
     * general promise.
     */
    for (const version of [2, 5, ITINERARY_VERSION - 1]) {
      getDb().prepare('DELETE FROM itineraries WHERE trip_id = ?').run(TRIP);
      writeStoredItinerary(version);
      expect(() => getItinerary(TRIP), `version ${version} was read`).toThrow(StaleItineraryError);
    }
  });

  it('does not throw for a plan written by this build', () => {
    writeStoredItinerary(ITINERARY_VERSION);
    /*
     * It fails for a different reason — the head row has no days — and the point
     * is precisely that: the *version gate* let it through. A test that only
     * asserted "throws" would pass with the gate rejecting everything.
     */
    expect(() => getItinerary(TRIP)).not.toThrow(StaleItineraryError);
  });
});

describe('the backup field the version bump was for', () => {
  const backup = {
    placeId: 'place-1',
    name: 'The Old Mill',
    trigger: 'Rain from mid-morning.',
    why: 'Almost all of it is indoors.',
    accessSummary: 'About 20 min by train from your base.',
    openingSummary: 'Open 10:00 to 17:00 on this date.',
  };

  it('accepts the mode-carrying shape this build writes', () => {
    const parsed = dayBackupSchema.parse({
      ...backup,
      travelMinutesFromBase: 20,
      travelModeFromBase: 'rail',
    });
    expect(parsed.travelMinutesFromBase).toBe(20);
    expect(parsed.travelModeFromBase).toBe('rail');
  });

  it('cannot be satisfied by the old drive-named field, and quietly drops it', () => {
    /*
     * Two separate facts, tested separately because the first version of this
     * test conflated them and passed for the wrong reason.
     *
     * First: a version-7 payload — the old key, neither new field — does not
     * parse. Not because the old key is *refused* (zod strips unknown keys, so
     * it is silently ignored), but because the mode and minutes it fails to
     * supply are required. Either way, a v7 backup cannot slip through wearing
     * v8's clothes.
     */
    expect(() => dayBackupSchema.parse({ ...backup, driveMinutesFromBase: 20 })).toThrow();
    /*
     * Second: beside a complete v8 payload the old key is stripped, not kept.
     * This is a tolerance, stated as one — a writer that emitted both shapes
     * would not be caught here, only relieved of the legacy field on the way
     * through. The refusal that matters is the missing-mode one below.
     */
    const parsed = dayBackupSchema.parse({
      ...backup,
      travelMinutesFromBase: 20,
      travelModeFromBase: 'rail',
      driveMinutesFromBase: 20,
    });
    expect('driveMinutesFromBase' in parsed).toBe(false);
  });

  it('refuses a mode that means "we do not know"', () => {
    /*
     * `unsupported` is the resolver's honest answer for a journey nothing could
     * establish — which makes it minutes with no recoverable mode, the exact
     * shape the version bump exists to keep out of storage.
     */
    expect(() =>
      dayBackupSchema.parse({
        ...backup,
        travelMinutesFromBase: 20,
        travelModeFromBase: 'unsupported',
      }),
    ).toThrow();
  });

  it('refuses minutes with no mode beside them', () => {
    /*
     * The exact defect, in schema form: a duration whose mode is unrecoverable.
     * That is what version 7 stored, and what nothing downstream could tell was
     * a walk rather than a drive.
     */
    expect(() => dayBackupSchema.parse({ ...backup, travelMinutesFromBase: 20 })).toThrow();
  });
});
