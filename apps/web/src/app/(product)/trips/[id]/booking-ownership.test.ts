import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * V9 §5/§6 — EVERY BOOKING DOOR ANSWERS TO THE BROWSER THAT MADE THE TRIP.
 *
 * The pattern `ownership-boundary.test.ts` set, applied to the ten actions
 * this pass adds: mark booked, add confirmation, replace, skip, unskip,
 * import, read with Sidequest, preview, confirm, discard. Each is driven
 * exactly as a browser would, with a foreign cookie and then the owner's; the
 * foreign call must come back with the shared refusal sentence, and the owner
 * must get past the guard — whatever the action then says about the trip's
 * actual state.
 */
const jar = new Map<string, string>();

vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
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

function releaseDatabase(): void {
  const holder = globalThis as unknown as { sidequestDb?: { close(): void } };
  holder.sidequestDb?.close();
  delete holder.sidequestDb;
}

beforeEach(() => {
  releaseDatabase();
  jar.clear();
  dir = mkdtempSync(join(tmpdir(), 'sidequest-booking-ownership-'));
  process.env.SIDEQUEST_DB_PATH = join(dir, 'test.db');
  process.env.SIDEQUEST_COMPOSER_PROVIDER = 'fixture';
});

afterEach(() => {
  releaseDatabase();
  delete process.env.SIDEQUEST_DB_PATH;
  delete process.env.SIDEQUEST_COMPOSER_PROVIDER;
  rmSync(dir, { recursive: true, force: true });
});

const OWNER = 'owner-browser';
const INTRUDER = 'intruder-browser';

const BASICS = {
  mode: 'known_destination' as const,
  destinationInput: 'Harbour City',
  regionId: 'open-world',
  startDate: '2026-09-01',
  endDate: '2026-09-04',
  arrivalTime: '10:00',
  departureTime: '18:00',
  adults: 2,
  children: 0,
  travelerNeeds: [],
};

async function seededTrip(): Promise<string> {
  const { createTrip } = await import('@/lib/db/repository');
  return createTrip(BASICS, OWNER).id;
}

const MARK = { bookingItemId: 'booking:lodging:base', type: 'lodging', title: 'Harbour View Hotel', date: '2026-09-01', endDate: '2026-09-04' };
const CANDIDATE = { type: 'lodging', title: 'Harbour View Hotel', date: '2026-09-01', endDate: '2026-09-04' };

type Invocation = (tripId: string) => Promise<{ ok: boolean; error?: string }>;
const ACTIONS: { name: string; invoke: Invocation }[] = [
  { name: 'markBookedAction', invoke: async (id) => (await import('./itinerary/actions')).markBookedAction(id, MARK) },
  { name: 'addConfirmationAction', invoke: async (id) => (await import('./itinerary/actions')).addConfirmationAction(id, 'nope', { confirmationRef: 'ABC123' }) },
  { name: 'replaceBookingAction', invoke: async (id) => (await import('./itinerary/actions')).replaceBookingAction(id, { ...MARK, title: 'Somewhere else' }) },
  { name: 'skipBookingAction', invoke: async (id) => (await import('./itinerary/actions')).skipBookingAction(id, 'booking:rental', 'We will take the train') },
  { name: 'unskipBookingAction', invoke: async (id) => (await import('./itinerary/actions')).unskipBookingAction(id, 'booking:rental') },
  { name: 'importConfirmationAction', invoke: async (id) => (await import('./itinerary/actions')).importConfirmationAction(id, { kind: 'text', text: 'Booking confirmed at Harbour View Hotel. Check-in: 1 September 2026. Confirmation number: HV88Q1' }) },
  { name: 'readImportWithSidequestAction', invoke: async (id) => (await import('./itinerary/actions')).readImportWithSidequestAction(id, 'nope', { kind: 'text', text: 'Booking confirmed.' }) },
  { name: 'previewImportAction', invoke: async (id) => (await import('./itinerary/actions')).previewImportAction(id, CANDIDATE) },
  { name: 'confirmImportAction', invoke: async (id) => (await import('./itinerary/actions')).confirmImportAction(id, 'nope', CANDIDATE) },
  { name: 'discardImportAction', invoke: async (id) => (await import('./itinerary/actions')).discardImportAction(id, 'nope') },
];

describe('the booking actions, invoked with a foreign cookie', () => {
  for (const action of ACTIONS) {
    it(`refuses ${action.name} for a foreign browser, and not for the owner`, async () => {
      const tripId = await seededTrip();
      const { FOREIGN_TRIP_REFUSAL } = await import('@/lib/net/trip-access');

      jar.set('sidequest_session', INTRUDER);
      const foreign = await action.invoke(tripId);
      expect(foreign.ok, `${action.name} let a foreign browser through`).toBe(false);
      expect(foreign.error).toBe(FOREIGN_TRIP_REFUSAL);

      jar.set('sidequest_session', OWNER);
      const own = await action.invoke(tripId);
      expect(own.error, `${action.name} refused its own maker`).not.toBe(FOREIGN_TRIP_REFUSAL);
    });
  }

  it('leaves nothing behind after a foreign import attempt', async () => {
    const tripId = await seededTrip();
    jar.set('sidequest_session', INTRUDER);
    const { importConfirmationAction } = await import('./itinerary/actions');
    await importConfirmationAction(tripId, { kind: 'text', text: 'Booking confirmed at Harbour View Hotel. Confirmation number: HV88Q1' });
    const { listPendingImports } = await import('@/lib/db/execution-repository');
    expect(listPendingImports(tripId)).toEqual([]);
  });

  it('refuses a booking action on a trip that belongs to nobody', async () => {
    const { createTrip } = await import('@/lib/db/repository');
    const unowned = createTrip(BASICS, null).id;
    jar.set('sidequest_session', INTRUDER);
    const { markBookedAction } = await import('./itinerary/actions');
    expect((await markBookedAction(unowned, MARK)).ok).toBe(false);
  });
});
