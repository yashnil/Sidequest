import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { planTrip } from '@sidequest/planner';
import { buildScenario } from '../../../../../../../../../packages/planner/src/testing/scenario';
import { getDb } from '@/lib/db/client';
import { saveItinerary } from '@/lib/db/repository';
import { GET } from './route';

/**
 * §17 EXPORT: THE CALENDAR FILE IS A REAL VCALENDAR, WITH THE PLAN IN IT.
 *
 * Offline by construction: the itinerary is produced by the real planner from
 * the golden fixture scenario and stored through the real repository, and the
 * route reads it back. No provider is consulted — a region that fails to
 * resolve falls back to the required ODbL attribution rather than to silence.
 */

let directory: string;
const TRIP = 'trip-ics';

function closeDb(): void {
  const cache = globalThis as unknown as { sidequestDb?: { close: () => void } };
  cache.sidequestDb?.close();
  delete cache.sidequestDb;
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'sidequest-ics-'));
  process.env.SIDEQUEST_DB_PATH = join(directory, 'ics.db');
  closeDb();
  getDb();
  const now = '2026-08-10T09:00:00.000Z';
  getDb()
    .prepare(
      `INSERT INTO trips (id, mode, destination_input, region_id, start_date, end_date,
         arrival_time, departure_time, adults, children, traveler_needs, status, created_at, updated_at)
       VALUES (?, 'known_destination', 'Mammoth Lakes', 'eastern-sierra', '2026-08-12', '2026-08-15',
         '11:00', '17:00', 2, 0, '[]', 'planned', ?, ?)`,
    )
    .run(TRIP, now, now);
});

afterEach(() => {
  closeDb();
  delete process.env.SIDEQUEST_DB_PATH;
  rmSync(directory, { recursive: true, force: true });
});

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe('the calendar export', () => {
  it('emits a standard VCALENDAR with TZID local times, a VTIMEZONE, SEQUENCE and STATUS on every event', async () => {
    const result = planTrip(buildScenario());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    saveItinerary({ ...result.itinerary, tripId: TRIP });

    const response = await GET(new Request('http://localhost/x'), params(TRIP));
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('text/calendar');
    expect(response.headers.get('Content-Disposition')).toContain('.ics');

    const body = await response.text();
    expect(body.startsWith('BEGIN:VCALENDAR')).toBe(true);
    expect(body.trimEnd().endsWith('END:VCALENDAR')).toBe(true);

    /* One VEVENT per activity at least — the plan's stops all export. */
    const activities = result.itinerary.days.reduce(
      (sum, day) => sum + day.items.filter((item) => item.kind === 'activity').length,
      0,
    );
    const events = body.match(/BEGIN:VEVENT/g) ?? [];
    expect(events.length).toBeGreaterThanOrEqual(activities);

    /*
     * V9 §10 — every local time names its zone, and the zone is defined in the
     * file. A floating time renders at the viewer's wall clock; a TZID time
     * renders at the destination's, which is what a calendar opened at home
     * before departure needs to say.
     */
    const starts = body.match(/DTSTART;TZID=([^:]+):(\S+)/g) ?? [];
    expect(starts.length).toBe(events.length);
    for (const start of starts) expect(start).toMatch(/^DTSTART;TZID=[A-Za-z_+\-/0-9]+:\d{8}T\d{6}$/);
    expect(body).toContain('BEGIN:VTIMEZONE');
    expect(body.match(/^SEQUENCE:0$/gm)?.length).toBe(events.length);
    expect(body.match(/^STATUS:TENTATIVE$/gm)?.length).toBe(events.length);
    /* The snapshot is a file, not a subscription: no refresh hint. */
    expect(body).not.toContain('REFRESH-INTERVAL');

    /* Attribution survives the export (§17). */
    expect(body).toContain('OpenStreetMap');
  });

  it('refuses a stale plan with a rebuild message rather than exporting stale claims', async () => {
    getDb()
      .prepare(
        `INSERT INTO itineraries (trip_id, version, region_id, base_id, base_name, start_date, end_date,
           status, summary, transport_strategy_json, food_plan_json, issues_json, unscheduled_json,
           diagnostics_json, created_at, updated_at)
         VALUES (?, 7, 'eastern-sierra', 'base', 'Mammoth Lakes', '2026-08-12', '2026-08-15',
           'ready', 'Old.', '{}', '{}', '[]', '[]', '{}', ?, ?)`,
      )
      .run(TRIP, '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z');

    const response = await GET(new Request('http://localhost/x'), params(TRIP));
    expect(response.status).toBe(409);
    expect(await response.text()).toContain('Rebuild');
  });

  it('404s honestly when there is no trip or no plan', async () => {
    expect((await GET(new Request('http://localhost/x'), params('no-such-trip'))).status).toBe(404);
    expect((await GET(new Request('http://localhost/x'), params(TRIP))).status).toBe(404);
  });
});
