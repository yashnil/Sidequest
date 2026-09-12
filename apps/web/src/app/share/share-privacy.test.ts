import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { planTrip } from '@sidequest/planner';
import type { Itinerary } from '@sidequest/core';
import { AUGUST_BASICS, buildScenario } from '../../../../../packages/planner/src/testing/scenario';

/**
 * V9 §24 — THE SHARED COPY CARRIES NO PRIVATE FACT.
 *
 * The share page is rendered here exactly as a reader with a link gets it,
 * over a trip whose owner has written down everything that must not travel:
 * a confirmation reference, a cost, a note, a payment state and a link on a
 * booking; a pending confirmation import; the traveller's own words on a
 * decision and on a skipped booking; a companion's private notes. The
 * markup is then searched for each. The strip happens at the door
 * (`strip.ts`), so no render branch can leak what it is never handed — and
 * the freshness banner, which can spend a request, is never mounted on the
 * shared copy at all.
 */

vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('next/navigation', () => ({
  redirect: (href: string) => {
    throw new Error(`redirect:${href}`);
  },
  notFound: () => {
    const error = new Error('NEXT_NOT_FOUND') as Error & { digest: string };
    error.digest = 'NEXT_HTTP_ERROR_FALLBACK;404';
    throw error;
  },
}));
vi.mock('next/headers', () => ({
  headers: async () => ({ get: () => null }),
  cookies: async () => {
    throw new Error('the share page reads no cookie');
  },
}));
/* The per-stop menu lives beside the server actions it calls; nothing below presses anything. */
vi.mock('@/app/(product)/trips/[id]/itinerary/edit-controls', () => ({ EaseDayButton: () => null, PrintExpand: () => null, StopEditMenu: () => null }));
vi.mock('@/components/PrintButton', () => ({ PrintButton: () => null }));

let dir: string;

function releaseDatabase(): void {
  const holder = globalThis as unknown as { sidequestDb?: { close(): void } };
  holder.sidequestDb?.close();
  delete holder.sidequestDb;
}

beforeEach(() => {
  releaseDatabase();
  dir = mkdtempSync(join(tmpdir(), 'sidequest-share-privacy-'));
  process.env.SIDEQUEST_DB_PATH = join(dir, 'test.db');
  process.env.SIDEQUEST_COMPILER_PROVIDER = 'fixture';
  process.env.SIDEQUEST_COMPOSER_PROVIDER = 'fixture';
  process.env.SIDEQUEST_WEATHER_PROVIDER = 'fixture';
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

/** Every string below is unique enough that finding it in the markup means it leaked. */
const SECRETS = {
  confirmationRef: 'QX7-REF-4419-ZZ',
  bookingNotes: 'ask for the quiet room at the back — private note',
  bookingUrl: 'https://booking.example.invalid/reservation/QX7',
  cost: '1234.56',
  importRef: 'IMPORT-REF-88AB',
  importTitle: 'Pending import title Zebra Lodge',
  decisionWhy: 'because Mum cannot do the second drive — decision note',
  resolutionNote: 'we skipped this because my brother is scared of boats',
  partyNotes: 'gets migraines after long drives — party private note',
  travelerName: 'Cousin Ravindra',
};

async function seedSharedTrip(): Promise<{ tripId: string; token: string }> {
  const { createTrip, saveItinerary, ensureShareToken } = await import('@/lib/db/repository');
  const trip = createTrip(AUGUST_BASICS, 'owner-browser');
  saveItinerary({ ...PLAN, tripId: trip.id });

  const { addBookedItem } = await import('@/lib/db/intelligence-repository');
  addBookedItem(trip.id, { type: 'lodging', title: 'Sierra Pines Lodge', date: PLAN.days[0]!.date, endDate: PLAN.days[3]!.date, confirmationRef: SECRETS.confirmationRef, notes: SECRETS.bookingNotes, url: SECRETS.bookingUrl, cost: { amount: 1234.56, currency: 'USD' }, status: 'booked', paid: 'deposit', refundable: 'non_refundable', source: 'imported', replaces: 'The suggested motel', bookingItemId: 'need-lodging-1' } as Parameters<typeof addBookedItem>[1]);

  const { recordImport, recordDecision, setBookingResolution } = await import('@/lib/db/execution-repository');
  recordImport(trip.id, { sourceKind: 'text', modelUsed: false, extracted: { type: 'lodging', typeConfidence: 'high', title: SECRETS.importTitle, confirmationRef: SECRETS.importRef, fields: [], gaps: [] } });
  recordDecision(trip.id, { key: 'route', chosen: 'One base', why: SECRETS.decisionWhy, lock: 'user_explicit', decidedBy: 'traveller' });
  setBookingResolution(trip.id, { bookingItemId: 'need-ferry-1', resolution: 'skipped', note: SECRETS.resolutionNote });

  const { createTraveler, setPartyMember } = await import('@/lib/db/party-repository');
  const traveler = createTraveler(
    { userId: null, ownerToken: 'owner-browser' },
    { displayName: SECRETS.travelerName, diet: { needs: [], strict: false, allergyCrossContamination: false }, needs: ['avoid_steep_descents'], needsNotes: SECRETS.partyNotes, profile: { interests: {}, transportComfort: [], lodgingNeeds: [] }, privacy: { hideFromPrint: false } },
  );
  setPartyMember({ tripId: trip.id, travelerId: traveler.id, role: 'other', preferencesApply: true, constraintsApply: true, participation: 'described', position: 0 });

  const token = ensureShareToken(trip.id);
  if (!token) throw new Error('no share token');
  return { tripId: trip.id, token };
}

async function renderShare(token: string): Promise<string> {
  const { default: SharedTripPage } = await import('./[token]/page');
  const element = await SharedTripPage({ params: Promise.resolve({ token }) });
  return renderToStaticMarkup(createElement(() => element as React.ReactElement));
}

describe('the shared copy of a plan', () => {
  it('renders the plan and none of the owner’s private facts', async () => {
    const { token } = await seedSharedTrip();
    const html = await renderShare(token);
    expect(html.length).toBeGreaterThan(1000);
    /* The booking itself may show as a fact of the trip; nothing the owner wrote or paid may. */
    for (const [name, secret] of Object.entries(SECRETS)) {
      expect(html.includes(secret), `${name} reached the shared markup`).toBe(false);
    }
    for (const word of ['deposit', 'non_refundable', 'Non-refundable', 'need-lodging-1', 'The suggested motel']) {
      expect(html.includes(word), `${word} reached the shared markup`).toBe(false);
    }
  });

  it('never mounts the freshness banner, which is the one surface that can spend a request', async () => {
    const { tripId, token } = await seedSharedTrip();
    const { recordObservations } = await import('@/lib/db/execution-repository');
    recordObservations(tripId, [{ factId: 'fact:forecast:2', kind: 'forecast', observedAt: '2026-08-01T12:00:00.000Z', previous: 'dry', current: 'rain', changed: true, dayNumbers: [2], summary: 'Day 2 now expects rain; it was dry when the plan was built. OBSERVATION-SENTINEL' }]);
    const html = await renderShare(token);
    expect(html).not.toContain('freshness-banner');
    expect(html).not.toContain('freshness-change');
    expect(html).not.toContain('OBSERVATION-SENTINEL');
    expect(html).not.toContain('import-center');
    expect(html).not.toContain('ledger-committed');
  });

  it('strips at the door: the model handed to the render carries none of the private fields', async () => {
    const { tripId, token } = await seedSharedTrip();
    const { tripForShareToken, getItinerary } = await import('@/lib/db/repository');
    const { itineraryViewModel } = await import('@/app/(product)/trips/[id]/itinerary/view-model');
    const { stripForShare } = await import('./[token]/strip');
    const trip = tripForShareToken(token)!;
    const model = await itineraryViewModel(trip, getItinerary(tripId)!);
    const shared = stripForShare(model);
    expect(shared.booked).toHaveLength(1);
    const item = shared.booked[0]! as Record<string, unknown>;
    for (const key of ['confirmationRef', 'notes', 'cost', 'url', 'paid', 'refundable', 'bookingItemId', 'replaces', 'source']) expect(item, `${key} survived the strip`).not.toHaveProperty(key);
    expect(shared.pendingImports).toEqual([]);
    expect(shared.ledger.lines).toEqual([]);
    expect(shared.ledger.committed).toBeNull();
    expect(shared.resolutions.every((r) => !('note' in r))).toBe(true);
    expect(shared.decisions.every((d) => !JSON.stringify(d).includes(SECRETS.decisionWhy))).toBe(true);
    expect(shared.observations).toEqual([]);
    expect(shared.readinessProfile).toBeNull();
    expect(JSON.stringify(shared)).not.toContain(SECRETS.partyNotes);
  });

  it('a revoked link is a 404, and the new link after a rotation opens while the old one does not', async () => {
    const { token } = await seedSharedTrip();
    const { revokeShareToken, rotateShareToken, tripForShareToken } = await import('@/lib/db/repository');
    const tripId = tripForShareToken(token)!.id;
    revokeShareToken(tripId);
    await expect(renderShare(token)).rejects.toMatchObject({ digest: expect.stringContaining('404') });
    const fresh = rotateShareToken(tripId)!;
    expect((await renderShare(fresh)).length).toBeGreaterThan(1000);
    await expect(renderShare(token)).rejects.toMatchObject({ digest: expect.stringContaining('404') });
  });
});
