import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * V9 §8 — TODAY IS AN OWNER DOOR.
 *
 * The day-of page shows the reservation behind the next thing, reference
 * included, so a browser that did not make the trip must get exactly what it
 * gets on every other trip page: a 404 that names nothing. The pattern is
 * `ownership-boundary.test.ts`'s; this file exists so that one need not grow.
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
  dir = mkdtempSync(join(tmpdir(), 'sidequest-today-ownership-'));
  process.env.SIDEQUEST_DB_PATH = join(dir, 'test.db');
  process.env.SIDEQUEST_COMPILER_PROVIDER = 'fixture';
});

afterEach(() => {
  releaseDatabase();
  delete process.env.SIDEQUEST_DB_PATH;
  delete process.env.SIDEQUEST_COMPILER_PROVIDER;
  rmSync(dir, { recursive: true, force: true });
});

const OWNER = 'owner-browser';
const INTRUDER = 'intruder-browser';

async function seededTrip(): Promise<string> {
  const { createTrip } = await import('@/lib/db/repository');
  return createTrip(
    { mode: 'known_destination', destinationInput: 'Harbour City', regionId: 'open-world', startDate: '2026-09-01', endDate: '2026-09-04', arrivalTime: '10:00', departureTime: '18:00', adults: 2, children: 0, travelerNeeds: [] },
    OWNER,
  ).id;
}

async function outcomeOf(run: () => Promise<unknown>): Promise<'rendered' | 'not_found'> {
  try {
    await run();
    return 'rendered';
  } catch (error) {
    const digest = String((error as { digest?: string })?.digest ?? '');
    if (digest.includes('404') || digest.includes('NOT_FOUND')) return 'not_found';
    throw error;
  }
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

describe('the Today page', () => {
  it('404s for a foreign browser and for no cookie, and renders for the owner', async () => {
    const tripId = await seededTrip();
    const { default: TodayPage, generateMetadata } = await import('./page');

    expect(await outcomeOf(() => TodayPage(params(tripId)))).toBe('not_found');
    jar.set('sidequest_session', INTRUDER);
    expect(await outcomeOf(() => TodayPage(params(tripId)))).toBe('not_found');
    expect(String((await generateMetadata(params(tripId))).title)).not.toContain('Harbour City');

    jar.set('sidequest_session', OWNER);
    expect(await outcomeOf(() => TodayPage(params(tripId)))).toBe('rendered');
    expect(String((await generateMetadata(params(tripId))).title)).toContain('Harbour City');
  });
});
