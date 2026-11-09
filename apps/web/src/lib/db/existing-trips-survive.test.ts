import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * RELEASE PASS — TRIPS MADE BEFORE THIS RELEASE ARE STILL THERE AFTER IT.
 *
 * The fixture is a real database, not a synthetic one: `main` at 6aa0dc1 was
 * built as it is deployed, its own browser suite (the canonical plan, discovery
 * scan, trip hub, plan edits, Ask Sidequest, share, accounts, Help-me-choose,
 * execution, the Pack and alpha feedback — 47 journeys, fixture providers, no
 * paid call) was driven through it, the server was stopped the way a deploy
 * stops one, and the file was copied with `backup-db.mjs`. Forty-one trips,
 * thirty-three built itineraries, three accounts, shared and claimed trips, a
 * calendar feed, booked items, a confirmation import, refinement versions and
 * seven Help-me-choose sessions written by the engine this release deletes.
 * Only what is not a traveller's work was removed to keep it small: the
 * provider weather cache, all but ten weather snapshots, and the throwaway
 * server's generated signing key.
 *
 * This branch then opens that file exactly as a deploy would, and everything a
 * traveller could reach before must still be reachable: no row lost by the
 * migration, every trip and every stored plan readable through the same
 * readers the pages use, ownership unchanged, the shared copy and the calendar
 * still served, and the old Help-me-choose sessions re-entering with their
 * answers rather than disappearing. A second open changes nothing.
 */

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('next/navigation', () => ({
  redirect: (href: string) => {
    throw new Error(`redirect:${href}`);
  },
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));
/* No request scope: the readers below are the pages' own, called as an internal caller. */
vi.mock('next/headers', () => ({
  headers: async () => ({ get: () => null }),
  cookies: async () => {
    throw new Error('no request scope in this test');
  },
}));

const FIXTURE = new URL('./fixtures/main-6aa0dc1.e2e.db.gz', import.meta.url).pathname;

/** Every table that holds something a traveller made or was shown. Counted before and after the open. */
const TRAVELLER_TABLES = [
  'trips', 'trip_intents', 'traveler_profiles', 'discovery_selections', 'food_selections', 'itineraries', 'itinerary_days', 'itinerary_items',
  'trip_drafts', 'composition_attempts', 'generation_progress', 'compiled_regions', 'discovery_scans', 'decision_sessions', 'provisional_boards',
  'refinement_versions', 'refinement_runs', 'users', 'auth_sessions', 'travelers', 'trip_party_members', 'preference_evidence', 'saved_ideas',
  'trip_feedback', 'booked_plan_items', 'readiness_profiles', 'trip_checks', 'trip_intelligence', 'itinerary_locks', 'trip_decisions',
  'booking_resolutions', 'booking_imports', 'calendar_feeds', 'trip_fact_observations', 'trip_fact_checks', 'trip_status_history', 'weather_snapshots',
];

let dir: string;
let path: string;
let before: Record<string, number>;
let ownersBefore: { id: string; owner_token: string | null; user_id: string | null; share_token: string | null }[];
let columnsBefore: Record<string, string[]>;

function releaseDatabase(): void {
  const holder = globalThis as unknown as { sidequestDb?: { close(): void } };
  holder.sidequestDb?.close();
  delete holder.sidequestDb;
}

function counts(db: Database.Database): Record<string, number> {
  const present = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((row) => row.name));
  return Object.fromEntries(TRAVELLER_TABLES.filter((table) => present.has(table)).map((table) => [table, (db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n]));
}

beforeAll(() => {
  releaseDatabase();
  dir = mkdtempSync(join(tmpdir(), 'sidequest-existing-trips-'));
  path = join(dir, 'sidequest.db');
  writeFileSync(path, gunzipSync(readFileSync(FIXTURE)));
  const raw = new Database(path, { readonly: true });
  before = counts(raw);
  ownersBefore = raw.prepare('SELECT id, owner_token, user_id, share_token FROM trips ORDER BY id').all() as typeof ownersBefore;
  columnsBefore = Object.fromEntries(
    (raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map((table) => [
      table.name,
      (raw.prepare(`PRAGMA table_info("${table.name}")`).all() as { name: string }[]).map((column) => column.name),
    ]),
  );
  raw.close();
  process.env.SIDEQUEST_DB_PATH = path;
  process.env.SIDEQUEST_COMPILER_PROVIDER = 'fixture';
  process.env.SIDEQUEST_COMPOSER_PROVIDER = 'fixture';
  process.env.SIDEQUEST_WEATHER_PROVIDER = 'fixture';
  process.env.SIDEQUEST_BASE_URL = 'http://127.0.0.1:4430';
});

afterAll(() => {
  releaseDatabase();
  for (const key of ['SIDEQUEST_DB_PATH', 'SIDEQUEST_COMPILER_PROVIDER', 'SIDEQUEST_COMPOSER_PROVIDER', 'SIDEQUEST_WEATHER_PROVIDER', 'SIDEQUEST_BASE_URL']) delete process.env[key];
  rmSync(dir, { recursive: true, force: true });
});

describe('a database written by main, opened by this release', () => {
  it('is a real one: it holds built trips, accounts, shares, a feed, bookings and old Help-me-choose sessions', () => {
    expect(before.trips).toBeGreaterThanOrEqual(40);
    expect(before.itineraries).toBeGreaterThanOrEqual(30);
    expect(before.users).toBeGreaterThanOrEqual(3);
    expect(before.decision_sessions).toBeGreaterThanOrEqual(7);
    expect(before.calendar_feeds).toBeGreaterThanOrEqual(1);
    expect(before.booked_plan_items).toBeGreaterThanOrEqual(1);
    expect(before.refinement_versions).toBeGreaterThanOrEqual(1);
    expect(ownersBefore.some((trip) => trip.user_id)).toBe(true);
    expect(ownersBefore.some((trip) => trip.share_token)).toBe(true);
  });

  it('loses no row and no column to the migration, and stays a healthy database', async () => {
    const { getDb } = await import('./client');
    const db = getDb();
    expect(counts(db)).toEqual(before);
    for (const [table, columns] of Object.entries(columnsBefore)) {
      const now = (db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]).map((column) => column.name);
      expect(now.length, `table ${table} is gone`).toBeGreaterThan(0);
      for (const column of columns) expect(now, `${table}.${column}`).toContain(column);
    }
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(db.pragma('user_version', { simple: true })).toBeGreaterThanOrEqual(9);
  });

  it('leaves every trip with the owner, account and share link it had', async () => {
    const { getDb } = await import('./client');
    const after = getDb().prepare('SELECT id, owner_token, user_id, share_token FROM trips ORDER BY id').all();
    expect(after).toEqual(ownersBefore);
    const { tripOwner, tripForShareToken, listTripsFor } = await import('./repository');
    for (const trip of ownersBefore) {
      expect(tripOwner(trip.id)).toEqual({ ownerToken: trip.owner_token, userId: trip.user_id });
      if (trip.share_token) expect(tripForShareToken(trip.share_token)?.id, 'a share link sent before the release').toBe(trip.id);
    }
    /* Each account still lists exactly its own trips, and each browser its own unclaimed ones. */
    for (const userId of new Set(ownersBefore.map((trip) => trip.user_id).filter((id): id is string => Boolean(id)))) {
      const listed = listTripsFor({ userId, ownerToken: null }).map((trip) => trip.id).sort();
      expect(listed).toEqual(ownersBefore.filter((trip) => trip.user_id === userId).map((trip) => trip.id).sort());
    }
    for (const ownerToken of new Set(ownersBefore.filter((trip) => !trip.user_id && trip.owner_token).map((trip) => trip.owner_token!))) {
      const listed = listTripsFor({ userId: null, ownerToken }).map((trip) => trip.id).sort();
      expect(listed).toEqual(ownersBefore.filter((trip) => !trip.user_id && trip.owner_token === ownerToken).map((trip) => trip.id).sort());
    }
  });

  it('reads every trip, every answer set and every stored plan through the current schema — none stale, none unreadable', async () => {
    const { getDb } = await import('./client');
    const db = getDb();
    const { getTrip, getItinerary, getAnswers, getProfile, getSelections } = await import('./repository');
    const { getTripDraft } = await import('./draft-repository');
    let built = 0;
    for (const { id } of ownersBefore) {
      expect(getTrip(id)?.id, `trip ${id.slice(0, 8)}`).toBe(id);
      /* None of these may throw on a row an older build wrote. */
      getAnswers(id);
      getProfile(id);
      getSelections(id);

      const stored = db.prepare('SELECT COUNT(*) AS n FROM itineraries WHERE trip_id = ?').get(id) as { n: number };
      /* `getItinerary` throws `StaleItineraryError` or a zod error on a plan it cannot read; either fails this test. */
      const itinerary = getItinerary(id);
      expect(itinerary !== null, `trip ${id.slice(0, 8)} plan`).toBe(stored.n === 1);
      if (!itinerary) continue;
      built += 1;
      const days = (db.prepare('SELECT COUNT(*) AS n FROM itinerary_days WHERE trip_id = ?').get(id) as { n: number }).n;
      const items = (db.prepare('SELECT COUNT(*) AS n FROM itinerary_items WHERE trip_id = ?').get(id) as { n: number }).n;
      expect(itinerary.days.length).toBe(days);
      expect(itinerary.days.reduce((sum, day) => sum + day.items.length, 0)).toBe(items);

      const draftRows = (db.prepare('SELECT COUNT(*) AS n FROM trip_drafts WHERE trip_id = ?').get(id) as { n: number }).n;
      if (draftRows > 0) expect(getTripDraft(id), `trip ${id.slice(0, 8)} draft`).not.toBeNull();
    }
    expect(built).toBe(before.itineraries);
  });

  it('still reads every Discovery scan and every adopted region the old plans were built from', async () => {
    const { getDb } = await import('./client');
    const db = getDb();
    const { getCompiledRegion } = await import('./compiler-repository');
    const { scanView } = await import('./scan-repository');
    const regions = db.prepare('SELECT id FROM compiled_regions').all() as { id: string }[];
    expect(regions.length).toBe(before.compiled_regions);
    for (const { id } of regions) expect(getCompiledRegion(id), `compiled region ${id.slice(0, 8)}`).not.toBeNull();
    for (const { trip_id: tripId } of db.prepare('SELECT DISTINCT trip_id FROM discovery_scans').all() as { trip_id: string }[]) {
      expect(() => scanView(tripId), `scan of ${tripId.slice(0, 8)}`).not.toThrow();
    }
  });

  it('builds the trip page and the shared copy for every plan, and serves the calendar', async () => {
    const { getDb } = await import('./client');
    const db = getDb();
    const { getTrip, getItinerary } = await import('./repository');
    const { itineraryViewModel } = await import('@/app/(product)/trips/[id]/itinerary/view-model');
    const { stripForShare } = await import('@/app/share/[token]/strip');
    const { buildTripCalendar, loadTripCalendarSource } = await import('@/lib/execution/calendar-events');
    const { undoTarget, listVersions } = await import('@/lib/refine/version-repository');
    const { planningUpgradeFor } = await import('@/lib/trips/planning-upgrade');
    const feeds = new Set((db.prepare('SELECT trip_id FROM calendar_feeds').all() as { trip_id: string }[]).map((row) => row.trip_id));
    let pages = 0;
    let shares = 0;
    let calendars = 0;
    for (const row of ownersBefore) {
      const trip = getTrip(row.id)!;
      const itinerary = getItinerary(row.id);
      if (!itinerary) continue;
      /* The owner's page: the whole derived model (intelligence, state graph, checklist, photographs). */
      const model = await itineraryViewModel(trip, itinerary);
      expect(model.appliedItinerary.days.length, `trip ${row.id.slice(0, 8)}`).toBe(itinerary.days.length);
      expect(model.graph).toBeDefined();
      expect(model.nextActions).toBeDefined();
      pages += 1;
      /* What the hub offers on an older plan must be computable, whatever it answers. */
      expect(() => planningUpgradeFor(row.id)).not.toThrow();
      expect(() => undoTarget(row.id)).not.toThrow();
      expect(() => listVersions(row.id)).not.toThrow();
      if (row.share_token) {
        const shared = stripForShare(await itineraryViewModel(trip, itinerary, { audience: 'public' }));
        expect(shared.appliedItinerary.days.length).toBe(itinerary.days.length);
        expect(shared.readinessProfile).toBeNull();
        shares += 1;
      }
      if (feeds.has(row.id) || calendars === 0) {
        const now = new Date('2026-11-09T12:00:00.000Z');
        const loaded = await loadTripCalendarSource(trip, itinerary, now);
        const ics = buildTripCalendar(loaded.source, { name: 'Trip — Sidequest', summary: itinerary.summary, attributions: loaded.attributions, stamp: now.toISOString(), refreshInterval: 'PT1H' });
        expect(ics.startsWith('BEGIN:VCALENDAR')).toBe(true);
        expect(ics.trimEnd().endsWith('END:VCALENDAR')).toBe(true);
        calendars += 1;
      }
    }
    expect(pages).toBe(before.itineraries);
    expect(shares).toBeGreaterThanOrEqual(1);
    expect(calendars).toBeGreaterThanOrEqual(1);
  });

  it('lets a Help-me-choose session from the deleted engine re-enter with its answers', async () => {
    const { getDb } = await import('./client');
    const { getDecisionSession } = await import('./decision-repository');
    const sessions = getDb().prepare('SELECT id, resolved_trip_id FROM decision_sessions').all() as { id: string; resolved_trip_id: string | null }[];
    expect(sessions.length).toBe(before.decision_sessions);
    for (const row of sessions) {
      const session = getDecisionSession(row.id);
      expect(session, `session ${row.id.slice(0, 8)}`).not.toBeNull();
      expect(session!.resolvedTripId).toBe(row.resolved_trip_id);
      expect(typeof session!.answers).toBe('object');
    }
  });

  it('can still export and delete an old trip completely', async () => {
    const { getDb } = await import('./client');
    const db = getDb();
    const { exportOwnerData, deleteTripCompletely, tripChildTables } = await import('./data-rights-repository');
    const claimed = ownersBefore.find((trip) => trip.user_id)!;
    const exported = exportOwnerData({ userId: claimed.user_id, ownerToken: null });
    expect(exported.trips.length).toBe(ownersBefore.filter((trip) => trip.user_id === claimed.user_id).length);
    const serialised = JSON.stringify(exported);
    for (const trip of ownersBefore) {
      if (trip.owner_token) expect(serialised).not.toContain(trip.owner_token);
      if (trip.share_token) expect(serialised).not.toContain(trip.share_token);
    }

    const built = ownersBefore.find((trip) => (db.prepare('SELECT COUNT(*) AS n FROM itinerary_items WHERE trip_id = ?').get(trip.id) as { n: number }).n > 0)!;
    deleteTripCompletely(built.id);
    for (const table of ['trips', ...tripChildTables()]) {
      const column = table === 'trips' ? 'id' : 'trip_id';
      expect((db.prepare(`SELECT COUNT(*) AS n FROM "${table}" WHERE ${column} = ?`).get(built.id) as { n: number }).n, table).toBe(0);
    }
    expect((db.prepare('SELECT COUNT(*) AS n FROM trips').get() as { n: number }).n).toBe(before.trips! - 1);
  });

  it('changes nothing on a second open', async () => {
    const { getDb } = await import('./client');
    const first = getDb();
    const schema = first.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all();
    const rows = counts(first);
    releaseDatabase();
    vi.resetModules();
    const reopened = (await import('./client')).getDb();
    expect(reopened.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all()).toEqual(schema);
    expect(counts(reopened)).toEqual(rows);
    expect(reopened.pragma('integrity_check', { simple: true })).toBe('ok');
  });
});
