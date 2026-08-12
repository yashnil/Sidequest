import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ITINERARY_VERSION } from '@sidequest/core';
import { planTrip } from '@sidequest/planner';
/*
 * A relative path, because the planner package deliberately exports only its
 * root and the scenario builder is a test fixture rather than product API.
 */
import { buildScenario } from '../../../../../packages/planner/src/testing/scenario';
import { getDb } from './client';
import {
  getItinerary,
  getSelections,
  getStaleItineraryDisplay,
  saveItinerary,
  setSelection,
  StaleItineraryError,
} from './repository';
import { StaleItineraryView } from '@/app/(product)/trips/[id]/itinerary/StaleItineraryView';

/**
 * PR-STALE-01: A PLAN THE TRAVELLER RECEIVED IS NEVER UNRECOVERABLE.
 *
 * `itinerary-version.test.ts` proves the gate refuses to *read* a stale row as
 * current — the right refusal, wrongly rendered: both stored itineraries in the
 * audited database showed only a version wall, with the traveller's own days
 * sitting in SQLite behind it. This file pins the recovery: the same rows come
 * back through the lenient display reader, render read-only under a dated
 * banner with the right day count, and a rebuild replaces them while leaving
 * every board selection exactly where it was.
 */

let directory: string;
const TRIP = 'trip-stale-display';

function closeDb(): void {
  const cache = globalThis as unknown as { sidequestDb?: { close: () => void } };
  cache.sidequestDb?.close();
  delete cache.sidequestDb;
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'sidequest-stale-display-'));
  process.env.SIDEQUEST_DB_PATH = join(directory, 'stale.db');
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
       VALUES (?, 'known_destination', 'Mammoth Lakes', 'eastern-sierra', '2026-08-12', '2026-08-13',
         '10:00', '18:00', 2, 0, '[]', 'planned', ?, ?)`,
    )
    .run(TRIP, now, now);
}

/**
 * A version-7-shaped plan, written the way the previous build wrote it: two
 * days, timeline items whose travel legs are the authored constants that
 * version's provider emitted, plus one row of outright garbage — because a
 * recovery reader that dies on one bad row is a wall with extra steps.
 */
function writeStaleItinerary(): void {
  const db = getDb();
  const written = '2026-07-01T12:00:00.000Z';
  db.prepare(
    `INSERT INTO itineraries (trip_id, version, region_id, base_id, base_name, start_date, end_date,
       status, summary, transport_strategy_json, food_plan_json, issues_json, unscheduled_json,
       diagnostics_json, created_at, updated_at)
     VALUES (?, ?, 'eastern-sierra', 'base-mammoth-lakes', 'Mammoth Lakes', '2026-08-12', '2026-08-13',
       'ready', '4 stops across 2 days.', '{}', '{}', '[]', '[]', '{}', ?, ?)`,
  ).run(TRIP, 7, written, written);

  const insertDay = db.prepare(
    `INSERT INTO itinerary_days (trip_id, day_number, date, base_id, base_name, theme, intensity,
       window_json, totals_json, transport_json, availability_json, weather_json, food_json, warnings_json)
     VALUES (?, ?, ?, 'base-mammoth-lakes', 'Mammoth Lakes', ?, 'moderate', '{}', '{}', '{}', '{}', '{}', '{}', '[]')`,
  );
  insertDay.run(TRIP, 1, '2026-08-12', 'Lakes around Mammoth Lakes');
  insertDay.run(TRIP, 2, '2026-08-13', 'Hiking around Mammoth Lakes');

  const insertItem = db.prepare(
    `INSERT INTO itinerary_items (trip_id, day_number, position, kind, place_id, start_minute, end_minute, item_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insertItem.run(
    TRIP,
    1,
    0,
    'travel',
    null,
    540,
    550,
    JSON.stringify({
      kind: 'travel',
      title: 'Walk to Convict Lake',
      startMinute: 540,
      endMinute: 550,
      reason: '10 min estimated travel time.',
    }),
  );
  insertItem.run(
    TRIP,
    1,
    1,
    'activity',
    'place-convict-lake',
    550,
    670,
    JSON.stringify({
      kind: 'activity',
      title: 'Convict Lake',
      startMinute: 550,
      endMinute: 670,
      reason: 'You picked this one yourself.',
    }),
  );
  insertItem.run(TRIP, 1, 2, 'meal', null, 690, 735, 'not json at all {');
  insertItem.run(
    TRIP,
    2,
    0,
    'activity',
    'place-crystal-lake',
    600,
    720,
    JSON.stringify({
      kind: 'activity',
      title: 'Crystal Lake Trail',
      startMinute: 600,
      endMinute: 720,
      reason: 'Matches your interest in hiking.',
    }),
  );
}

describe('the lenient display reader', () => {
  it('returns the stored days while the strict reader still refuses', () => {
    writeStaleItinerary();

    expect(() => getItinerary(TRIP)).toThrow(StaleItineraryError);

    const display = getStaleItineraryDisplay(TRIP);
    expect(display).not.toBeNull();
    expect(display!.storedVersion).toBe(7);
    expect(display!.savedAt).toBe('2026-07-01T12:00:00.000Z');
    expect(display!.days).toHaveLength(2);
    expect(display!.days[0]!.theme).toBe('Lakes around Mammoth Lakes');
    /* The corrupt meal row is dropped; the two good rows survive. */
    expect(display!.days[0]!.items).toHaveLength(2);
    expect(display!.days[0]!.items.map((item) => item.title)).toEqual([
      'Walk to Convict Lake',
      'Convict Lake',
    ]);
    expect(display!.days[1]!.items).toHaveLength(1);
  });

  it('renders read-only with the dated banner and the right day count', () => {
    writeStaleItinerary();
    const display = getStaleItineraryDisplay(TRIP)!;

    /* `createElement`, not JSX: the test glob only collects `.test.ts` files. */
    const html = renderToStaticMarkup(
      createElement(StaleItineraryView, {
        display,
        tripId: TRIP,
        includedCount: 3,
        dateLabel: '12–13 Aug 2026',
      }),
    );

    expect(html).toContain('Built by an earlier version of Sidequest');
    /* Dated: the banner names when the plan was written, not a version number. */
    expect(html).toContain('1 Jul 2026');
    expect(html).toContain('every choice you made');
    expect(html).toContain('Day 1');
    expect(html).toContain('Day 2');
    expect(html).not.toContain('Day 3');
    expect(html).toContain('Convict Lake');
    /*
     * And none of the engineering changelog the wall used to recite. §26: the
     * traveller is told what it means, never how the schema moved.
     */
    expect(html).not.toContain('opening hours we check');
    expect(html).not.toContain('daylight');
  });
});

describe('rebuilding over a stale plan', () => {
  it('replaces the plan and keeps every board selection', () => {
    writeStaleItinerary();
    setSelection(TRIP, 'place-convict-lake', 'included', 'user');
    setSelection(TRIP, 'place-crystal-lake', 'included', 'user');
    setSelection(TRIP, 'place-skipped', 'excluded', 'user');
    const before = getSelections(TRIP);
    expect(before).toHaveLength(3);

    /* A real current-version plan, produced by the real planner. */
    const result = planTrip(buildScenario());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    saveItinerary({ ...result.itinerary, tripId: TRIP });

    const rebuilt = getItinerary(TRIP);
    expect(rebuilt).not.toBeNull();
    expect(rebuilt!.version).toBe(ITINERARY_VERSION);
    /* The selections the rebuild planned from are untouched, byte for byte. */
    expect(getSelections(TRIP)).toEqual(before);
  });
});
