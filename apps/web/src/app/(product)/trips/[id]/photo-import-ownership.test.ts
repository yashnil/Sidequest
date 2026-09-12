import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * V9.1 §7 — A PHOTO ANSWERS TO THE BROWSER THAT MADE THE TRIP.
 *
 * The pattern `booking-ownership.test.ts` set, applied to the two doors a
 * photo passes through: the upload (`importConfirmationAction` with an
 * image) and the explicit reading (`readImportWithSidequestAction` with the
 * same image). A foreign cookie gets the shared refusal sentence and leaves
 * no row behind; the owner gets past the guard. The reading is also proven
 * to be the owner's alone: a foreign browser cannot spend the press on the
 * owner's pending import even when it knows the import id.
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
  dir = mkdtempSync(join(tmpdir(), 'sidequest-photo-ownership-'));
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

/** SOI · APP0 · DQT · SOF0 · SOS · a few scan bytes · EOI — a JPEG by its bytes, named as nothing. */
const TINY_JPEG = new Uint8Array([
  0xff, 0xd8,
  0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
  0xff, 0xdb, 0x00, 0x06, 0x00, 0x01, 0x01, 0x01,
  0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00,
  0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00,
  0x12, 0x34,
  0xff, 0xd9,
]);
const SOURCE = { kind: 'file' as const, fileBase64: Buffer.from(TINY_JPEG).toString('base64'), filename: 'confirmation.jpg' };

async function seededTrip(): Promise<string> {
  const { createTrip } = await import('@/lib/db/repository');
  return createTrip(BASICS, OWNER).id;
}

describe('the photo import doors, invoked with a foreign cookie', () => {
  it('refuses the upload for a foreign browser, leaves nothing behind, and admits the owner', async () => {
    const tripId = await seededTrip();
    const { FOREIGN_TRIP_REFUSAL } = await import('@/lib/net/trip-access');
    const { importConfirmationAction } = await import('./itinerary/actions');
    const { listPendingImports } = await import('@/lib/db/execution-repository');

    jar.set('sidequest_session', INTRUDER);
    const foreign = await importConfirmationAction(tripId, SOURCE);
    expect(foreign.ok).toBe(false);
    expect(foreign.error).toBe(FOREIGN_TRIP_REFUSAL);
    expect(listPendingImports(tripId)).toEqual([]);

    jar.set('sidequest_session', OWNER);
    const own = await importConfirmationAction(tripId, SOURCE);
    expect(own.ok, own.error).toBe(true);
    expect(own.photo).toBe(true);
    expect(own.sourceKind).toBe('image');
    expect(listPendingImports(tripId)).toHaveLength(1);
  });

  it('refuses the reading for a foreign browser even with the owner’s import id, and admits the owner', async () => {
    const tripId = await seededTrip();
    const { FOREIGN_TRIP_REFUSAL } = await import('@/lib/net/trip-access');
    const { importConfirmationAction, readImportWithSidequestAction } = await import('./itinerary/actions');
    const { getImport, listPendingImports } = await import('@/lib/db/execution-repository');

    jar.set('sidequest_session', OWNER);
    const uploaded = await importConfirmationAction(tripId, SOURCE);
    expect(uploaded.ok).toBe(true);

    jar.set('sidequest_session', INTRUDER);
    const foreign = await readImportWithSidequestAction(tripId, uploaded.importId!, SOURCE);
    expect(foreign.ok).toBe(false);
    expect(foreign.error).toBe(FOREIGN_TRIP_REFUSAL);
    /* The owner's pending import is untouched: still pending, still unread. */
    expect(getImport(tripId, uploaded.importId!)).toMatchObject({ status: 'pending', modelUsed: false });
    expect(listPendingImports(tripId)).toHaveLength(1);

    jar.set('sidequest_session', OWNER);
    const own = await readImportWithSidequestAction(tripId, uploaded.importId!, SOURCE);
    expect(own.error).not.toBe(FOREIGN_TRIP_REFUSAL);
    expect(own.ok, own.error).toBe(true);
    expect(own.modelUsed).toBe(true);
  });

  it('refuses both doors on a trip that belongs to nobody', async () => {
    const { createTrip } = await import('@/lib/db/repository');
    const unowned = createTrip(BASICS, null).id;
    jar.set('sidequest_session', INTRUDER);
    const { importConfirmationAction, readImportWithSidequestAction } = await import('./itinerary/actions');
    expect((await importConfirmationAction(unowned, SOURCE)).ok).toBe(false);
    expect((await readImportWithSidequestAction(unowned, 'nope', SOURCE)).ok).toBe(false);
  });
});
