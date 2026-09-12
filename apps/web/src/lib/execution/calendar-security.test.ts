import type { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { planTrip } from '@sidequest/planner';
import type { Itinerary } from '@sidequest/core';
import { AUGUST_BASICS, buildScenario } from '../../../../../packages/planner/src/testing/scenario';
import { findComponents, hasUnescapedSeparator, icsSyntaxDefects, parseIcs, property, rawIcsLines, octetLength } from './ics-parse';

/**
 * V9.1 §8 — THE CALENDAR TOKEN, THE FEED AND THE SNAPSHOT, PROVEN AT THE BYTES.
 *
 * Driven through the real repositories and the real route handlers on a
 * temporary database, with a trip whose owner has written down everything
 * that must never reach a calendar: a confirmation reference, a note, a
 * cost, a booking link, a companion's name and needs, a passport expiry.
 *
 *   - the feed token is 32 bytes from `crypto.randomBytes`, base64url, 43
 *     characters, and the database holds only its SHA-256;
 *   - revoke stops the route on the very next request; regenerate revokes the
 *     old token in the same statement; trip A's token never opens trip B;
 *   - the feed and the snapshot parse as iCalendar and carry the properties
 *     Apple, Google and Outlook rely on, with stable UIDs across reads;
 *   - neither document, and no read-only share, carries a private fact.
 */
const jar = new Map<string, string>();
const randomBytesSizes: number[] = [];

vi.mock('node:crypto', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown> & { randomBytes: typeof randomBytes };
  return {
    ...actual,
    default: actual,
    randomBytes: (size: number, callback?: (err: Error | null, buf: Buffer) => void) => {
      randomBytesSizes.push(size);
      return callback ? actual.randomBytes(size, callback) : actual.randomBytes(size);
    },
  };
});
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('next/navigation', () => ({
  redirect: (href: string) => {
    throw new Error(`redirect:${href}`);
  },
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));
vi.mock('next/headers', () => ({
  headers: async () => ({ get: (name: string) => (name === 'host' ? 'sidequest.test' : name === 'x-forwarded-proto' ? 'https' : null) }),
  cookies: async () => ({
    get: (name: string) => {
      const value = jar.get(name);
      return value === undefined ? undefined : { value };
    },
    set: (name: string, value: string) => {
      jar.set(name, value);
    },
  }),
}));

let dir: string;
const OWNER = 'owner-browser';

function releaseDatabase(): void {
  const holder = globalThis as unknown as { sidequestDb?: { close(): void } };
  holder.sidequestDb?.close();
  delete holder.sidequestDb;
}

beforeEach(() => {
  releaseDatabase();
  jar.clear();
  randomBytesSizes.length = 0;
  dir = mkdtempSync(join(tmpdir(), 'sidequest-calendar-security-'));
  process.env.SIDEQUEST_DB_PATH = join(dir, 'test.db');
  process.env.SIDEQUEST_COMPILER_PROVIDER = 'fixture';
  process.env.SIDEQUEST_COMPOSER_PROVIDER = 'fixture';
  process.env.SIDEQUEST_WEATHER_PROVIDER = 'fixture';
  delete process.env.SIDEQUEST_BASE_URL;
});

afterEach(() => {
  releaseDatabase();
  delete process.env.SIDEQUEST_DB_PATH;
  delete process.env.SIDEQUEST_COMPILER_PROVIDER;
  delete process.env.SIDEQUEST_COMPOSER_PROVIDER;
  delete process.env.SIDEQUEST_WEATHER_PROVIDER;
  rmSync(dir, { recursive: true, force: true });
});

const PLAN: Itinerary = (() => {
  const result = planTrip(buildScenario());
  if (!result.ok) throw new Error(`the fixture scenario did not plan: ${result.code}`);
  return result.itinerary;
})();

/** Every string is unique enough that finding it in a document means it leaked. */
const SECRETS = {
  confirmationRef: 'QX7-REF-4419-ZZ',
  notes: 'ask for the quiet room at the back',
  url: 'booking.example.invalid',
  cost: '1234.56',
  costRounded: '1,235',
  travelerName: 'Cousin Ravindra',
  needsNotes: 'gets migraines after long drives',
  dietNotes: 'severe peanut allergy carry the pen',
  passportExpiry: '2031-07',
  citizenship: 'NZ',
};

interface Seeded {
  tripId: string;
  bookedTitle: string;
}

async function seedTrip(label: 'A' | 'B'): Promise<Seeded> {
  const { createTrip, saveItinerary } = await import('@/lib/db/repository');
  const trip = createTrip({ ...AUGUST_BASICS, destinationInput: `Destination ${label}` }, OWNER);
  const plan = label === 'A' ? { ...PLAN, tripId: trip.id } : { ...PLAN, tripId: trip.id, baseName: 'Bravo Base Only', summary: 'TRIP-B-SUMMARY-SENTINEL.' };
  saveItinerary(plan);
  const bookedTitle = label === 'A' ? 'Hotel Alpha Only' : 'Hotel Bravo Only';

  const { addBookedItem, saveReadinessProfile } = await import('@/lib/db/intelligence-repository');
  addBookedItem(trip.id, {
    type: 'lodging',
    title: bookedTitle,
    date: PLAN.days[0]!.date,
    endDate: PLAN.days[2]!.date,
    location: 'Main Street 4, Twin Lakes',
    locked: true,
    confirmationRef: SECRETS.confirmationRef,
    notes: SECRETS.notes,
    url: `https://${SECRETS.url}/reservation/QX7`,
    cost: { amount: 1234.56, currency: 'USD' },
    status: 'booked',
    paid: 'deposit',
    refundable: 'non_refundable',
    source: 'imported',
    provider: 'Booking.com',
  });
  saveReadinessProfile(trip.id, { citizenship: SECRETS.citizenship, passportExpiry: SECRETS.passportExpiry, transitCountries: [] });

  const { createTraveler, setPartyMember } = await import('@/lib/db/party-repository');
  const traveler = createTraveler(
    { userId: null, ownerToken: OWNER },
    {
      displayName: SECRETS.travelerName,
      diet: { needs: ['nut_allergy'], strict: true, allergyCrossContamination: true, notes: SECRETS.dietNotes },
      needs: ['avoid_steep_descents'],
      needsNotes: SECRETS.needsNotes,
      profile: { interests: {}, transportComfort: [], lodgingNeeds: [] },
      privacy: { hideFromPrint: false },
    } as Parameters<typeof createTraveler>[1],
  );
  setPartyMember({ tripId: trip.id, travelerId: traveler.id, role: 'other', preferencesApply: true, constraintsApply: true, participation: 'described', position: 0 });
  return { tripId: trip.id, bookedTitle };
}

async function feedResponse(token: string): Promise<Response> {
  const { GET } = await import('@/app/api/calendar/[token]/route');
  return GET(new Request(`https://sidequest.test/api/calendar/${token}`), { params: Promise.resolve({ token }) });
}

async function snapshotResponse(tripId: string): Promise<Response> {
  const { GET } = await import('@/app/(product)/trips/[id]/itinerary/calendar/route');
  return GET(new Request(`https://sidequest.test/trips/${tripId}/itinerary/calendar`), { params: Promise.resolve({ id: tripId }) });
}

function uidsOf(text: string): string[] {
  return findComponents(parseIcs(text), 'VEVENT').map((event) => property(event, 'UID')!.value);
}

describe('the feed token', () => {
  it('is 32 bytes from crypto.randomBytes, 43 base64url characters, and is stored only as its SHA-256', async () => {
    const { tripId } = await seedTrip('A');
    const { createCalendarFeed, hashFeedToken, tripForFeedToken } = await import('@/lib/db/execution-repository');
    const { getDb } = await import('@/lib/db/client');
    randomBytesSizes.length = 0;
    const { token } = createCalendarFeed(tripId);
    expect(randomBytesSizes).toContain(32);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);

    const rows = getDb().prepare('SELECT * FROM calendar_feeds').all() as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token_hash).toBe(hashFeedToken(token));
    expect(String(rows[0]!.token_hash)).toMatch(/^[0-9a-f]{64}$/);
    const everything = JSON.stringify(rows);
    expect(everything).not.toContain(token);
    expect(everything).not.toContain(token.slice(0, 16));
    expect(tripForFeedToken(token)).toBe(tripId);
    /* A token that is merely short, or merely wrong, opens nothing. */
    expect(tripForFeedToken('')).toBeNull();
    expect(tripForFeedToken(token.slice(0, 31))).toBeNull();
    expect(tripForFeedToken(`${token.slice(0, 42)}${token.endsWith('A') ? 'B' : 'A'}`)).toBeNull();
  });

  it('serves the feed, then serves nothing the moment it is revoked', async () => {
    const { tripId } = await seedTrip('A');
    const { createCalendarFeedAction, revokeCalendarFeedAction } = await import('./calendar-actions');
    jar.set('sidequest_session', OWNER);
    const created = await createCalendarFeedAction(tripId);
    if (!created.ok) throw new Error(created.error);
    const token = created.path.slice('/api/calendar/'.length);

    const before = await feedResponse(token);
    expect(before.status).toBe(200);
    expect(before.headers.get('content-type')).toContain('text/calendar');
    expect(await before.text()).toContain('BEGIN:VEVENT');

    expect(await revokeCalendarFeedAction(tripId)).toEqual({ ok: true, revoked: 1 });
    const after = await feedResponse(token);
    expect(after.status).toBe(404);
    expect(await after.text()).toBe('No such calendar.');
  });

  it('regenerating hands out a new token and the old one stops in the same statement', async () => {
    const { tripId } = await seedTrip('A');
    const { createCalendarFeed, tripForFeedToken, activeCalendarFeed } = await import('@/lib/db/execution-repository');
    const first = createCalendarFeed(tripId, new Date('2026-09-01T00:00:00.000Z'));
    expect((await feedResponse(first.token)).status).toBe(200);
    const second = createCalendarFeed(tripId, new Date('2026-09-02T00:00:00.000Z'));
    expect(second.token).not.toBe(first.token);
    expect(tripForFeedToken(first.token)).toBeNull();
    expect((await feedResponse(first.token)).status).toBe(404);
    expect((await feedResponse(second.token)).status).toBe(200);
    expect(activeCalendarFeed(tripId)?.id).toBe(second.id);
  });

  it('never serves trip B through trip A’s token, nor the other way round', async () => {
    const a = await seedTrip('A');
    const b = await seedTrip('B');
    const { createCalendarFeed } = await import('@/lib/db/execution-repository');
    const tokenA = createCalendarFeed(a.tripId).token;
    const tokenB = createCalendarFeed(b.tripId).token;

    const feedA = await (await feedResponse(tokenA)).text();
    const feedB = await (await feedResponse(tokenB)).text();
    expect(feedA).toContain(a.bookedTitle);
    expect(feedA).not.toContain(b.bookedTitle);
    expect(feedA).not.toContain('Bravo Base Only');
    expect(feedA).not.toContain('TRIP-B-SUMMARY-SENTINEL');
    expect(feedB).toContain(b.bookedTitle);
    expect(feedB).toContain('Bravo Base Only');
    expect(feedB).not.toContain(a.bookedTitle);
    expect(feedA).not.toContain(b.tripId);
    expect(feedB).not.toContain(a.tripId);
    /* Every UID names its own trip, and only its own. */
    for (const uid of uidsOf(feedA)) expect(uid.startsWith(`${a.tripId}-`)).toBe(true);
    for (const uid of uidsOf(feedB)) expect(uid.startsWith(`${b.tripId}-`)).toBe(true);
  });

  it('answers an unknown token with the same four words as a revoked one — the URL is not an oracle', async () => {
    await seedTrip('A');
    const unknown = await feedResponse('A'.repeat(43));
    expect(unknown.status).toBe(404);
    expect(await unknown.text()).toBe('No such calendar.');
  });
});

describe('the feed and the snapshot, as documents', () => {
  async function bothDocuments(): Promise<{ tripId: string; feed: string; feedAgain: string; snapshot: string }> {
    const { tripId } = await seedTrip('A');
    const { createCalendarFeed } = await import('@/lib/db/execution-repository');
    const { token } = createCalendarFeed(tripId);
    jar.set('sidequest_session', OWNER);
    const feed = await (await feedResponse(token)).text();
    const feedAgain = await (await feedResponse(token)).text();
    const snapshotRes = await snapshotResponse(tripId);
    expect(snapshotRes.status).toBe(200);
    expect(snapshotRes.headers.get('content-disposition')).toContain('.ics');
    return { tripId, feed, feedAgain, snapshot: await snapshotRes.text() };
  }

  it('parse as RFC 5545 with CRLF, folded continuations and no line over 75 octets', async () => {
    const { feed, snapshot } = await bothDocuments();
    for (const [name, text] of [
      ['feed', feed],
      ['snapshot', snapshot],
    ] as const) {
      expect(icsSyntaxDefects(text), `${name} has a syntax defect`).toEqual([]);
      expect(text.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
      expect(text.endsWith('END:VCALENDAR\r\n')).toBe(true);
      expect(text, `${name} never folded a line`).toMatch(/\r\n [^\r\n]/);
      for (const line of rawIcsLines(text)) expect(octetLength(line)).toBeLessThanOrEqual(75);
    }
  });

  it('carry PRODID, VERSION, METHOD, one VTIMEZONE per zone matching every DTSTART;TZID, a UTC DTSTAMP, a numeric SEQUENCE and a known STATUS', async () => {
    const { feed, snapshot } = await bothDocuments();
    for (const text of [feed, snapshot]) {
      const doc = parseIcs(text);
      expect(doc.name).toBe('VCALENDAR');
      expect(property(doc, 'PRODID')?.value).toBe('-//Sidequest//Itinerary//EN');
      expect(property(doc, 'VERSION')?.value).toBe('2.0');
      expect(property(doc, 'METHOD')?.value).toBe('PUBLISH');
      expect(property(doc, 'X-WR-CALNAME')?.value).toBeTruthy();

      const zoneIds = findComponents(doc, 'VTIMEZONE').map((z) => property(z, 'TZID')?.value);
      expect(new Set(zoneIds).size).toBe(zoneIds.length);
      const events = findComponents(doc, 'VEVENT');
      expect(events.length).toBeGreaterThan(3);
      const usedZones = new Set<string>();
      for (const event of events) {
        const start = property(event, 'DTSTART');
        const end = property(event, 'DTEND');
        expect(start?.params.TZID, `DTSTART without TZID: ${start?.raw}`).toBeTruthy();
        expect(end?.params.TZID).toBe(start?.params.TZID);
        usedZones.add(start!.params.TZID!);
        expect(zoneIds).toContain(start!.params.TZID);
        expect(start?.value).toMatch(/^\d{8}T\d{6}$/);
        expect(property(event, 'DTSTAMP')?.value).toMatch(/^\d{8}T\d{6}Z$/);
        expect(property(event, 'SEQUENCE')?.value).toMatch(/^\d+$/);
        expect(['CONFIRMED', 'TENTATIVE']).toContain(property(event, 'STATUS')?.value);
        expect(property(event, 'UID')?.value).toMatch(/@sidequest$/);
        for (const name of ['SUMMARY', 'DESCRIPTION', 'LOCATION']) {
          const value = property(event, name)?.value;
          if (value !== undefined) expect(hasUnescapedSeparator(value), `${name} left a separator unescaped: ${value}`).toBe(false);
        }
      }
      /* Every declared zone is used, and every used zone is declared. */
      expect([...usedZones].sort()).toEqual([...zoneIds].sort());
      /* The booked stay is CONFIRMED and categorised; suggestions are TENTATIVE. */
      const booked = events.find((e) => property(e, 'UID')?.value.includes('-booked-'));
      expect(property(booked!, 'STATUS')?.value).toBe('CONFIRMED');
      expect(property(booked!, 'CATEGORIES')?.value).toBe('Booked');
      expect(property(booked!, 'LOCATION')?.value).toBe('Main Street 4\\, Twin Lakes');
      expect(events.filter((e) => property(e, 'STATUS')?.value === 'TENTATIVE').length).toBeGreaterThan(0);
    }
  });

  it('give every event a unique UID that is the same on a second read and the same in the snapshot', async () => {
    const { feed, feedAgain, snapshot } = await bothDocuments();
    const first = uidsOf(feed);
    expect(new Set(first).size).toBe(first.length);
    expect(uidsOf(feedAgain)).toEqual(first);
    expect(uidsOf(snapshot)).toEqual(first);
    /* The two reads differ only by DTSTAMP, if at all. */
    const strip = (text: string) => text.replace(/^DTSTAMP:.*$/gm, 'DTSTAMP:*');
    expect(strip(feedAgain)).toBe(strip(feed));
  });

  it('put REFRESH-INTERVAL and X-PUBLISHED-TTL on the feed only', async () => {
    const { feed, snapshot } = await bothDocuments();
    const feedDoc = parseIcs(feed);
    expect(property(feedDoc, 'REFRESH-INTERVAL')?.params).toEqual({ VALUE: 'DURATION' });
    expect(property(feedDoc, 'REFRESH-INTERVAL')?.value).toMatch(/^PT\d+[HM]$/);
    expect(property(feedDoc, 'X-PUBLISHED-TTL')?.value).toBe(property(feedDoc, 'REFRESH-INTERVAL')?.value);
    const snapshotDoc = parseIcs(snapshot);
    expect(property(snapshotDoc, 'REFRESH-INTERVAL')).toBeUndefined();
    expect(property(snapshotDoc, 'X-PUBLISHED-TTL')).toBeUndefined();
  });

  it('carry no confirmation reference, note, cost, link, companion or health fact', async () => {
    const { feed, snapshot } = await bothDocuments();
    for (const [doc, text] of [
      ['feed', feed],
      ['snapshot', snapshot],
    ] as const) {
      for (const [name, secret] of Object.entries(SECRETS)) {
        expect(text.includes(secret), `${name} reached the ${doc}`).toBe(false);
      }
      for (const word of ['deposit', 'Non-refundable', 'non_refundable', 'nut_allergy', 'avoid_steep_descents', 'peanut', 'passport', 'USD']) {
        expect(text.includes(word), `${word} reached the ${doc}`).toBe(false);
      }
      /* What may travel: the stay's title and where it is. */
      expect(text).toContain('Booked: Hotel Alpha Only');
    }
  });

  it('the snapshot is owner-gated and a foreign browser gets the missing-trip answer', async () => {
    const { tripId } = await seedTrip('A');
    jar.set('sidequest_session', 'intruder-browser');
    const foreign = await snapshotResponse(tripId);
    expect(foreign.status).toBe(404);
    expect(await foreign.text()).toBe('No such trip.');
    jar.clear();
    expect((await snapshotResponse(tripId)).status).toBe(404);
  });
});

describe('a read-only share', () => {
  it('strips references, notes, costs, links, terms, the readiness profile and the companion’s private words before render', async () => {
    const { tripId } = await seedTrip('A');
    const { ensureShareToken, tripForShareToken, getItinerary } = await import('@/lib/db/repository');
    const { itineraryViewModel } = await import('@/app/(product)/trips/[id]/itinerary/view-model');
    const { stripForShare } = await import('@/app/share/[token]/strip');
    const token = ensureShareToken(tripId);
    if (!token) throw new Error('no share token');
    const trip = tripForShareToken(token)!;
    const model = await itineraryViewModel(trip, getItinerary(tripId)!);
    /* The owner's model holds the facts; the shared one holds none of them. */
    expect(JSON.stringify(model.booked)).toContain(SECRETS.confirmationRef);
    const shared = stripForShare(model);
    expect(shared.booked).toHaveLength(1);
    for (const key of ['confirmationRef', 'notes', 'cost', 'url', 'paid', 'refundable', 'source']) expect(shared.booked[0], `${key} survived the strip`).not.toHaveProperty(key);
    expect(shared.readinessProfile).toBeNull();
    expect(shared.pendingImports).toEqual([]);
    expect(shared.ledger.lines).toEqual([]);
    /*
     * The intelligence snapshot carries its own copy of the booked facts
     * (`intelligence.booked`); the door must strip that copy too, or a render
     * branch that reads the snapshot instead of `model.booked` would leak.
     */
    const snapshotBooked = JSON.stringify((shared.intelligence as { booked?: unknown }).booked ?? []);
    for (const [name, secret] of Object.entries(SECRETS)) expect(snapshotBooked.includes(secret), `${name} survived the strip inside intelligence.booked`).toBe(false);
    /*
     * V9.1 §2 — every one of them, with no allowance.
     *
     * An earlier pass exempted `citizenship` here: it survived inside
     * Sidequest's own advisory sentences ("…whether a NZ passport holder needs
     * a visa…"), which are composed at build time and which no strip can take
     * a nationality back out of. The boundary moved instead of the filter — a
     * share now builds its intelligence with no readiness profile and no party
     * facts, so the sentence is never written. The allowance is gone.
     */
    /* The gap is exactly one word in prose, never a field: nothing in the payload holds it as a value of its own. */
    const asField = (node: unknown): boolean => {
      if (typeof node === 'string') return node.trim() === SECRETS.citizenship;
      if (Array.isArray(node)) return node.some(asField);
      if (node && typeof node === 'object') return Object.values(node).some(asField);
      return false;
    };
    expect(asField(shared), 'citizenship is carried as a field, not only inside prose').toBe(false);
  });
});
