import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { planTrip } from '@sidequest/planner';
import { buildScenario } from '../../../../../../../packages/planner/src/testing/scenario';
import { getDb } from '@/lib/db/client';
import { createCalendarFeed, hashFeedToken, revokeCalendarFeeds } from '@/lib/db/execution-repository';
import { addBookedItem } from '@/lib/db/intelligence-repository';
import { saveItinerary } from '@/lib/db/repository';
import { GET } from './route';

/**
 * V9 §10 — THE FEED ANSWERS TO THE TOKEN AND TO NOTHING ELSE.
 *
 * Offline by construction, like the snapshot route's test: two trips planned
 * by the real planner from the golden fixture, stored through the real
 * repository, each with its own feed. Trip A's token must never serve trip
 * B's events, a revoked token must answer as an unknown one, and the private
 * facts typed on a booking must not be in the bytes.
 */
let directory: string;
const A = 'trip-feed-a';
const B = 'trip-feed-b';

function closeDb(): void {
  const cache = globalThis as unknown as { sidequestDb?: { close: () => void } };
  cache.sidequestDb?.close();
  delete cache.sidequestDb;
}

function seedTrip(id: string, destination: string): void {
  const now = '2026-08-10T09:00:00.000Z';
  getDb()
    .prepare(
      `INSERT INTO trips (id, mode, destination_input, region_id, start_date, end_date,
         arrival_time, departure_time, adults, children, traveler_needs, status, created_at, updated_at)
       VALUES (?, 'known_destination', ?, 'eastern-sierra', '2026-08-12', '2026-08-15',
         '11:00', '17:00', 2, 0, '[]', 'planned', ?, ?)`,
    )
    .run(id, destination, now, now);
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'sidequest-feed-'));
  process.env.SIDEQUEST_DB_PATH = join(directory, 'feed.db');
  closeDb();
  getDb();
  seedTrip(A, 'Mammoth Lakes');
  seedTrip(B, 'Mammoth Lakes');
  const result = planTrip(buildScenario());
  if (!result.ok) throw new Error('fixture plan failed');
  saveItinerary({ ...result.itinerary, tripId: A });
  saveItinerary({ ...result.itinerary, tripId: B });
  addBookedItem(A, {
    type: 'lodging',
    title: 'Sierra Lodge for trip A',
    date: '2026-08-12',
    endDate: '2026-08-15',
    location: '1 Lake Road, Mammoth Lakes',
    confirmationRef: 'REF-PRIVATE-A',
    notes: 'private note A',
    cost: { amount: 987, currency: 'USD' },
    url: 'https://example.test/a',
    status: 'booked',
    locked: true,
  });
  addBookedItem(B, { type: 'lodging', title: 'Other Lodge for trip B', date: '2026-08-12', endDate: '2026-08-15', status: 'booked', locked: true });
});

afterEach(() => {
  closeDb();
  delete process.env.SIDEQUEST_DB_PATH;
  rmSync(directory, { recursive: true, force: true });
});

const params = (token: string) => ({ params: Promise.resolve({ token }) });
const request = () => new Request('http://localhost/api/calendar/x');

describe('the calendar feed', () => {
  it('serves trip A to A’s token with feed headers, and never a byte of trip B', async () => {
    const feedA = createCalendarFeed(A);
    createCalendarFeed(B);
    const response = await GET(request(), params(feedA.token));
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('text/calendar');
    expect(response.headers.get('Cache-Control')).toBe('private, max-age=0, must-revalidate');
    expect(response.headers.get('Set-Cookie')).toBeNull();
    const body = await response.text();
    expect(body).toContain('REFRESH-INTERVAL;VALUE=DURATION:PT1H');
    expect(body).toContain('X-PUBLISHED-TTL:PT1H');
    expect(body).toContain('Booked: Sierra Lodge for trip A');
    expect(body).toContain('STATUS:CONFIRMED');
    expect(body).toContain('CATEGORIES:Booked');
    expect(body).toContain('STATUS:TENTATIVE');
    expect(body).toMatch(/DTSTART;TZID=[^:]+:\d{8}T\d{6}/);
    expect(body).toContain('BEGIN:VTIMEZONE');
    expect(body).toMatch(/^SEQUENCE:\d+$/m);
    expect(body).not.toContain('trip B');
    expect(body).not.toContain(B);
  });

  it('carries no confirmation reference, note, cost or booking URL', async () => {
    const feedA = createCalendarFeed(A);
    const body = await (await GET(request(), params(feedA.token))).text();
    expect(body).not.toContain('REF-PRIVATE-A');
    expect(body).not.toContain('private note A');
    expect(body).not.toContain('987');
    expect(body).not.toContain('example.test');
    expect(body).toContain('1 Lake Road');
  });

  it('stores only the hash of a token, and the token itself never touches the database', () => {
    const feed = createCalendarFeed(A);
    const rows = getDb().prepare('SELECT token_hash FROM calendar_feeds WHERE trip_id = ?').all(A) as { token_hash: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token_hash).toBe(hashFeedToken(feed.token));
    expect(rows[0]!.token_hash).not.toBe(feed.token);
    expect(feed.token.length).toBeGreaterThanOrEqual(43);
  });

  it('answers a revoked token, a regenerated-away token and an unknown one with the same four words', async () => {
    const first = createCalendarFeed(A);
    const second = createCalendarFeed(A);
    // Regenerating revoked the first.
    expect((await GET(request(), params(first.token))).status).toBe(404);
    expect((await GET(request(), params(second.token))).status).toBe(200);
    revokeCalendarFeeds(A);
    const revoked = await GET(request(), params(second.token));
    expect(revoked.status).toBe(404);
    expect(await revoked.text()).toBe('No such calendar.');
    const unknown = await GET(request(), params('not-a-token-at-all-not-a-token-at-all-x'));
    expect(unknown.status).toBe(404);
    expect(await unknown.text()).toBe('No such calendar.');
    expect((await GET(request(), params(A))).status).toBe(404);
  });

  it('serves a valid empty calendar while the trip has no finished plan, so subscribed clients keep refreshing', async () => {
    seedTrip('trip-feed-c', 'Somewhere');
    const feed = createCalendarFeed('trip-feed-c');
    const response = await GET(request(), params(feed.token));
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('BEGIN:VCALENDAR');
    expect(body).toContain('no finished plan');
    expect(body).not.toContain('BEGIN:VEVENT');
  });
});
