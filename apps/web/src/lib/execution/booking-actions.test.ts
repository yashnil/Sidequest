import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildLedger, deriveBookings, type BookedPlanItem, type TravelIntelligence, type Itinerary } from '@sidequest/core';
import { boardWorld, draftOf } from '@/lib/planning/acceptance/harness';
import { reconcileTripDraft } from '@/lib/planning/reconcile';
import { buildTravelIntelligence } from '@/lib/intelligence/build';
import { applyBookedFacts } from '@/lib/intelligence/booked-reconcile';

/**
 * V9 §5 — A BOOKING IS AN OBJECT THAT KNOWS WHAT IT SATISFIES.
 *
 * Through the real server actions against a real database: marking a need
 * booked links the fact to the need by id, so `deriveBookings` reads the need
 * as booked without a title heuristic; skipping records the traveller's word
 * and the need reads not needed; replacing names what was displaced; an
 * import becomes a booked fact only on confirm, matched to the need it fits.
 * Then the Book view is rendered for the owner and for the shared copy: the
 * shared copy carries no control, no reference and no import centre.
 */
const jar = new Map<string, string>();

vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined, push: () => undefined }) }));
vi.mock('next/headers', () => ({
  headers: async () => ({ get: () => null }),
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
const NOW = new Date('2026-06-01T00:00:00.000Z');

function releaseDatabase(): void {
  const holder = globalThis as unknown as { sidequestDb?: { close(): void } };
  holder.sidequestDb?.close();
  delete holder.sidequestDb;
}

beforeEach(() => {
  releaseDatabase();
  jar.clear();
  jar.set('sidequest_session', OWNER);
  dir = mkdtempSync(join(tmpdir(), 'sidequest-booking-actions-'));
  process.env.SIDEQUEST_DB_PATH = join(dir, 'test.db');
  process.env.SIDEQUEST_COMPOSER_PROVIDER = 'fixture';
});

afterEach(() => {
  releaseDatabase();
  delete process.env.SIDEQUEST_DB_PATH;
  delete process.env.SIDEQUEST_COMPOSER_PROVIDER;
  rmSync(dir, { recursive: true, force: true });
});

/** A three-night trip with one base, a drive, and a guided day — enough needs to act on. */
async function tripWithNeeds(): Promise<{ tripId: string; itinerary: Itinerary; intel: TravelIntelligence; context: ReturnType<typeof boardWorld> }> {
  const context = boardWorld();
  const draft = draftOf({
    bases: [{ id: 'base', name: 'Mammoth Lakes', nights: 3 }],
    days: [
      { base: 'base', anchors: [{ name: 'Convict Lake', transport: 'car' }] },
      { base: 'base', anchors: [{ name: 'Mono Lake', transport: 'car' }] },
      { base: 'base', anchors: [{ name: 'Hot Creek', transport: 'car' }] },
    ],
    driving: 'rental_self_drive',
  });
  const result = await reconcileTripDraft({ draft, context });
  const { createTrip, saveItinerary } = await import('@/lib/db/repository');
  const trip = createTrip(context.basics, OWNER);
  const itinerary = { ...result.itinerary, tripId: trip.id };
  saveItinerary(itinerary);
  const intel = buildTravelIntelligence({
    tripId: trip.id,
    itinerary,
    draft: { days: draft.days.map((d) => ({ anchors: d.anchors.map((a) => ({ name: a.name, ...(a.transport ? { transport: a.transport } : {}) })) })), bases: draft.bases.map((b) => ({ id: b.id })), driving: 'rental_self_drive' },
    profile: context.profile,
    basics: context.basics,
    destination: { name: 'Mammoth Lakes', countryCode: 'US' },
    composer: null,
    booked: [],
    readinessProfile: null,
    sourcedAreas: [],
    worthSkipping: [],
    userPlaces: [],
    bookedHonored: [],
    bookedConflicts: [],
    now: NOW,
    fx: null,
  });
  const { saveTravelIntelligence } = await import('@/lib/db/intelligence-repository');
  saveTravelIntelligence(intel);
  return { tripId: trip.id, itinerary, intel, context };
}

async function needsNow(input: { tripId: string; itinerary: Itinerary; intel: TravelIntelligence; context: ReturnType<typeof boardWorld> }) {
  const { listBookedItems } = await import('@/lib/db/intelligence-repository');
  const { listBookingResolutions } = await import('@/lib/db/execution-repository');
  const booked = listBookedItems(input.tripId);
  const resolutions = listBookingResolutions(input.tripId);
  const needs = deriveBookings({ itinerary: input.itinerary, pkg: input.itinerary.package, profile: input.context.profile, legs: input.intel.transport.legs, booked, daysUntilTrip: 30, remoteBaseIds: new Set(), selfDrives: true, resolutions });
  return { booked, resolutions, needs };
}

describe('marking, skipping and replacing a need', () => {
  it('mark booked → the need reads booked through its id, and the fact says it was marked from the plan', async () => {
    const trip = await tripWithNeeds();
    const rental = trip.intel.bookings.items.find((b) => b.kind === 'rental_vehicle');
    expect(rental?.status).toBe('open');
    const { markBookedAction } = await import('@/app/(product)/trips/[id]/itinerary/actions');
    const result = await markBookedAction(trip.tripId, { bookingItemId: rental!.id, type: 'rental_car', title: 'Compact from the airport desk', date: trip.itinerary.startDate, cost: { amount: 310, currency: 'USD' }, paid: 'deposit', refundable: 'refundable' });
    expect(result.ok, result.error).toBe(true);

    const { booked, needs } = await needsNow(trip);
    expect(booked).toHaveLength(1);
    expect(booked[0]!.bookingItemId).toBe(rental!.id);
    expect(booked[0]!.source).toBe('marked');
    expect(booked[0]!.paid).toBe('deposit');
    const need = needs.find((b) => b.id === rental!.id)!;
    expect(need.status).toBe('booked');
    expect(need.bookedItemId).toBe(booked[0]!.id);
    /* The ledger counts the deposit as committed and no longer lists the car as a major cost remaining. */
    const ledger = buildLedger({ budget: trip.intel.budget, booked, openNeeds: needs.filter((b) => b.status === 'open' && !b.memberIds) });
    expect(ledger.committed).toEqual({ amount: 310, currency: 'USD', count: 1 });
    expect(ledger.remainingMajor).not.toContain('the car');
    expect(ledger.lines[0]!.refundable).toBe('refundable');
  });

  it('a need marked booked via the id link needs no title match — the title can be anything', async () => {
    const trip = await tripWithNeeds();
    const stay = trip.intel.bookings.items.find((b) => b.kind === 'accommodation' && !b.memberIds)!;
    const { markBookedAction } = await import('@/app/(product)/trips/[id]/itinerary/actions');
    expect((await markBookedAction(trip.tripId, { bookingItemId: stay.id, type: 'lodging', title: 'Cabin 7', date: trip.itinerary.startDate, endDate: trip.itinerary.endDate, location: 'Twin Lakes' })).ok).toBe(true);
    const { needs } = await needsNow(trip);
    expect(needs.find((b) => b.id === stay.id)!.status).toBe('booked');
    /* The stays roll-up re-reads its members. */
    expect(needs.find((b) => b.memberIds)!.status).toBe('booked');
  });

  it('skip → the need reads not needed with the traveller’s note, and unskip puts it back', async () => {
    const trip = await tripWithNeeds();
    const rental = trip.intel.bookings.items.find((b) => b.kind === 'rental_vehicle')!;
    const { skipBookingAction, unskipBookingAction } = await import('@/app/(product)/trips/[id]/itinerary/actions');
    expect((await skipBookingAction(trip.tripId, rental.id, 'Taking the shuttle instead')).ok).toBe(true);
    let state = await needsNow(trip);
    expect(state.resolutions).toEqual([{ bookingItemId: rental.id, resolution: 'skipped', note: 'Taking the shuttle instead' }]);
    expect(state.needs.find((b) => b.id === rental.id)!.status).toBe('not_needed');

    expect((await unskipBookingAction(trip.tripId, rental.id)).ok).toBe(true);
    state = await needsNow(trip);
    expect(state.resolutions).toEqual([]);
    expect(state.needs.find((b) => b.id === rental.id)!.status).toBe('open');
  });

  it('mark booked after a skip clears the skip — the booking is the newer word', async () => {
    const trip = await tripWithNeeds();
    const rental = trip.intel.bookings.items.find((b) => b.kind === 'rental_vehicle')!;
    const { skipBookingAction, markBookedAction } = await import('@/app/(product)/trips/[id]/itinerary/actions');
    await skipBookingAction(trip.tripId, rental.id);
    await markBookedAction(trip.tripId, { bookingItemId: rental.id, type: 'rental_car', title: 'A car after all', date: trip.itinerary.startDate });
    const { resolutions, needs } = await needsNow(trip);
    expect(resolutions).toEqual([]);
    expect(needs.find((b) => b.id === rental.id)!.status).toBe('booked');
  });

  it('replace → the fact names what it replaced, taken from the plan’s own title', async () => {
    const trip = await tripWithNeeds();
    const rental = trip.intel.bookings.items.find((b) => b.kind === 'rental_vehicle')!;
    const { replaceBookingAction } = await import('@/app/(product)/trips/[id]/itinerary/actions');
    const result = await replaceBookingAction(trip.tripId, { bookingItemId: rental.id, type: 'transfer', title: 'Private driver for the week', date: trip.itinerary.startDate });
    expect(result.ok, result.error).toBe(true);
    const { booked, resolutions, needs } = await needsNow(trip);
    expect(booked[0]!.replaces).toBe(rental.title);
    expect(booked[0]!.source).toBe('marked');
    expect(resolutions).toEqual([{ bookingItemId: rental.id, resolution: 'replaced', bookedItemId: booked[0]!.id }]);
    expect(needs.find((b) => b.id === rental.id)!.status).toBe('booked');
  });

  it('add confirmation → the reference, the amount and the terms land on the fact and nothing else moves', async () => {
    const trip = await tripWithNeeds();
    const rental = trip.intel.bookings.items.find((b) => b.kind === 'rental_vehicle')!;
    const { markBookedAction, addConfirmationAction } = await import('@/app/(product)/trips/[id]/itinerary/actions');
    const marked = await markBookedAction(trip.tripId, { bookingItemId: rental.id, type: 'rental_car', title: 'Compact', date: trip.itinerary.startDate });
    expect((await addConfirmationAction(trip.tripId, marked.bookedItemId!, {})).ok).toBe(false);
    expect((await addConfirmationAction(trip.tripId, marked.bookedItemId!, { confirmationRef: 'RC-77-Q', cost: { amount: 280, currency: 'USD' }, paid: 'paid', refundable: 'non_refundable', cancellationDeadline: trip.itinerary.startDate })).ok).toBe(true);
    const { booked } = await needsNow(trip);
    expect(booked[0]).toMatchObject({ title: 'Compact', confirmationRef: 'RC-77-Q', cost: { amount: 280, currency: 'USD' }, paid: 'paid', refundable: 'non_refundable', bookingItemId: rental.id });
  });
});

describe('a confirmation, imported', () => {
  const HOTEL = (date: string, end: string) => `From: Booking.com <noreply@booking.com>
Subject: Your booking is confirmed at Lakeview Lodge

Your booking at Lakeview Lodge is confirmed.
Confirmation number: 7781.554.902
Check-in: ${date}
Check-out: ${end}
Total price: US$ 612.00
Paid with card 4111 1111 1111 1111
`;

  it('is a pending row until confirmed, holds no card number, and on confirm becomes a booked fact linked to the stay it fits', async () => {
    const trip = await tripWithNeeds();
    const { importConfirmationAction, confirmImportAction, previewImportAction } = await import('@/app/(product)/trips/[id]/itinerary/actions');
    const { listPendingImports, getImport } = await import('@/lib/db/execution-repository');
    const { getDb } = await import('@/lib/db/client');

    const imported = await importConfirmationAction(trip.tripId, { kind: 'text', text: HOTEL(trip.itinerary.startDate, trip.itinerary.endDate) });
    expect(imported.ok, imported.error).toBe(true);
    expect(imported.extracted?.type).toBe('lodging');
    expect(imported.extracted?.date).toBe(trip.itinerary.startDate);
    expect(imported.modelUsed).toBe(false);
    expect(listPendingImports(trip.tripId)).toHaveLength(1);
    /* Nothing on the trip changed yet. */
    expect((await needsNow(trip)).booked).toEqual([]);
    /* The row holds the redacted facts and never the document. */
    const raw = getDb().prepare('SELECT extracted_json FROM booking_imports WHERE id = ?').get(imported.importId) as { extracted_json: string };
    expect(raw.extracted_json).not.toContain('4111');
    expect(raw.extracted_json).not.toContain('Paid with card');

    const candidate = { type: 'lodging', title: 'Lakeview Lodge', date: trip.itinerary.startDate, endDate: trip.itinerary.endDate, location: 'Lakeview Lodge', confirmationRef: imported.extracted?.confirmationRef, cost: imported.extracted?.cost };
    const preview = await previewImportAction(trip.tripId, candidate);
    expect(preview.ok, preview.error).toBe(true);
    expect(preview.summary).toMatch(/sleep at your booking|No day changes/);

    const confirmed = await confirmImportAction(trip.tripId, imported.importId!, candidate);
    expect(confirmed.ok, confirmed.error).toBe(true);
    const { booked, needs } = await needsNow(trip);
    expect(booked).toHaveLength(1);
    expect(booked[0]!.source).toBe('imported');
    const stay = trip.intel.bookings.items.find((b) => b.kind === 'accommodation' && !b.memberIds)!;
    expect(booked[0]!.bookingItemId).toBe(stay.id);
    expect(needs.find((b) => b.id === stay.id)!.status).toBe('booked');
    expect(getImport(trip.tripId, imported.importId!)?.status).toBe('confirmed');
    expect(listPendingImports(trip.tripId)).toEqual([]);
    /* Applied to the plan, the booked lodging renames the base and says which days it reached. */
    const applied = applyBookedFacts(trip.itinerary, booked);
    expect(applied.affected.baseRenamedDays.length).toBeGreaterThan(0);
    expect(applied.affected.summary).toMatch(/sleep at your booking/);
  });

  it('discard resolves the import and books nothing', async () => {
    const trip = await tripWithNeeds();
    const { importConfirmationAction, discardImportAction } = await import('@/app/(product)/trips/[id]/itinerary/actions');
    const { getImport } = await import('@/lib/db/execution-repository');
    const imported = await importConfirmationAction(trip.tripId, { kind: 'text', text: HOTEL(trip.itinerary.startDate, trip.itinerary.endDate) });
    expect((await discardImportAction(trip.tripId, imported.importId!)).ok).toBe(true);
    expect(getImport(trip.tripId, imported.importId!)?.status).toBe('discarded');
    expect((await needsNow(trip)).booked).toEqual([]);
  });

  it('"Ask Sidequest to read it" runs offline against the saved composer: one new pending row marked as read, the old one discarded, no model call', async () => {
    const trip = await tripWithNeeds();
    const { importConfirmationAction, readImportWithSidequestAction } = await import('@/app/(product)/trips/[id]/itinerary/actions');
    const { getImport, listPendingImports } = await import('@/lib/db/execution-repository');
    const source = { kind: 'text' as const, text: HOTEL(trip.itinerary.startDate, trip.itinerary.endDate) };
    const first = await importConfirmationAction(trip.tripId, source);
    const read = await readImportWithSidequestAction(trip.tripId, first.importId!, source);
    expect(read.ok, read.error).toBe(true);
    expect(read.modelUsed).toBe(true);
    expect(read.importId).not.toBe(first.importId);
    expect(read.extracted?.title).toMatch(/Lakeview Lodge/);
    expect(getImport(trip.tripId, first.importId!)?.status).toBe('discarded');
    const pending = listPendingImports(trip.tripId);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.modelUsed).toBe(true);
  });

  it('a photo is accepted only for the explicit press, and that press says it cannot read a photo yet', async () => {
    const trip = await tripWithNeeds();
    const { importConfirmationAction, readImportWithSidequestAction } = await import('@/app/(product)/trips/[id]/itinerary/actions');
    const png = new Uint8Array(64);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    const source = { kind: 'file' as const, fileBase64: Buffer.from(png).toString('base64'), filename: 'photo.png' };
    const imported = await importConfirmationAction(trip.tripId, source);
    expect(imported.ok).toBe(true);
    expect(imported.photo).toBe(true);
    const read = await readImportWithSidequestAction(trip.tripId, imported.importId!, source);
    expect(read.ok).toBe(false);
    expect(read.error).toMatch(/photo/);
    expect(read.error).not.toMatch(/model|provider|fixture/i);
  });
});

describe('the Book view, rendered', () => {
  async function render(tripIdOrNot: string | undefined, trip: Awaited<ReturnType<typeof tripWithNeeds>>, booked: BookedPlanItem[]) {
    const { BookView } = await import('@/components/hub/BookView');
    const { listBookingResolutions, listPendingImports } = await import('@/lib/db/execution-repository');
    const applied = applyBookedFacts(trip.itinerary, booked);
    const intel = buildTravelIntelligence({
      tripId: trip.tripId,
      itinerary: applied.itinerary,
      draft: { days: [], bases: [{ id: 'base' }], driving: 'rental_self_drive' },
      profile: trip.context.profile,
      basics: trip.context.basics,
      destination: { name: 'Mammoth Lakes', countryCode: 'US' },
      composer: null,
      booked,
      readinessProfile: null,
      sourcedAreas: [],
      worthSkipping: [],
      userPlaces: [],
      bookedHonored: applied.honored,
      bookedConflicts: applied.conflicts,
      now: NOW,
      fx: null,
      resolutions: listBookingResolutions(trip.tripId),
    } as Parameters<typeof buildTravelIntelligence>[0]);
    const ledger = buildLedger({ budget: intel.budget, booked, openNeeds: intel.bookings.items.filter((b) => b.status === 'open' && !b.memberIds) });
    return renderToStaticMarkup(
      createElement(BookView, {
        ...(tripIdOrNot ? { tripId: tripIdOrNot } : {}),
        intel,
        booked,
        itinerary: applied.itinerary,
        honored: applied.honored,
        conflicts: applied.conflicts,
        resolutions: listBookingResolutions(trip.tripId),
        ledger,
        affected: applied.affected,
        pendingImports: tripIdOrNot ? listPendingImports(trip.tripId) : [],
      }),
    );
  }

  it('shows the owner every control, the reference behind a print-hidden disclosure, the import centre and the ledger', async () => {
    const trip = await tripWithNeeds();
    const rental = trip.intel.bookings.items.find((b) => b.kind === 'rental_vehicle')!;
    const { markBookedAction, skipBookingAction } = await import('@/app/(product)/trips/[id]/itinerary/actions');
    await markBookedAction(trip.tripId, { bookingItemId: rental.id, type: 'rental_car', title: 'Compact', date: trip.itinerary.startDate, confirmationRef: 'SECRET-REF-1', cost: { amount: 300, currency: 'USD' }, paid: 'paid' });
    const guided = trip.intel.bookings.items.find((b) => b.status === 'open' && !b.memberIds && b.kind !== 'rental_vehicle' && b.kind !== 'accommodation');
    if (guided) await skipBookingAction(trip.tripId, guided.id, 'Not this time');
    const { listBookedItems } = await import('@/lib/db/intelligence-repository');
    const html = await render(trip.tripId, trip, listBookedItems(trip.tripId));

    expect(html).toContain('data-testid="hub-book"');
    expect(html).toContain('data-testid="booking-row"');
    expect(html).toContain('data-testid="booking-mark-booked"');
    expect(html).toContain('data-testid="booking-skip"');
    expect(html).toContain('data-testid="booked-item"');
    expect(html).toContain('data-testid="booked-confirmation"');
    expect(html).toContain('SECRET-REF-1');
    expect(html).toMatch(/<details class="[^"]*print:hidden[^"]*" data-testid="booked-confirmation"/);
    expect(html).toContain('data-testid="booked-affected"');
    expect(html).toContain('data-testid="import-center"');
    expect(html).toContain('data-testid="import-text"');
    expect(html).toContain('data-testid="import-submit"');
    expect(html).toContain('data-testid="ledger"');
    expect(html).toContain('data-testid="ledger-committed"');
    expect(html).toContain('$300');
    if (guided) {
      expect(html).toContain('data-testid="book-skipped"');
      expect(html).toContain('data-testid="booking-unskip"');
      expect(html).toContain('Not this time');
    }
    /* Traveller language only. */
    expect(html).not.toMatch(/fixture|provider|geocoder|schema|blast radius/i);
  });

  it('gives the shared copy no control, no reference, no import centre and no ledger', async () => {
    const trip = await tripWithNeeds();
    const rental = trip.intel.bookings.items.find((b) => b.kind === 'rental_vehicle')!;
    const { markBookedAction } = await import('@/app/(product)/trips/[id]/itinerary/actions');
    await markBookedAction(trip.tripId, { bookingItemId: rental.id, type: 'rental_car', title: 'Compact', date: trip.itinerary.startDate, confirmationRef: 'SECRET-REF-2', cost: { amount: 300, currency: 'USD' } });
    const { listBookedItems } = await import('@/lib/db/intelligence-repository');
    const html = await render(undefined, trip, listBookedItems(trip.tripId));

    expect(html).toContain('data-testid="hub-book"');
    expect(html).toContain('data-testid="booking-row"');
    expect(html).toContain('Compact');
    expect(html).not.toContain('SECRET-REF-2');
    expect(html).not.toContain('data-testid="booking-mark-booked"');
    expect(html).not.toContain('data-testid="booking-skip"');
    expect(html).not.toContain('data-testid="booked-confirmation"');
    expect(html).not.toContain('data-testid="import-center"');
    expect(html).not.toContain('data-testid="ledger"');
    expect(html).not.toContain('<form');
    expect(html).not.toContain('<button');
  });
});
