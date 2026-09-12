import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * V9 §11 — THE PACK AND THE PICTURES ANSWER TO THE OWNER.
 *
 * The same pattern as `ownership-boundary.test.ts`, in its own file: every
 * new door is driven with a foreign cookie and must come back as a missing
 * trip, and with the owner's cookie must get past the guard to the trip's
 * real state (no plan built yet, on a freshly seeded trip). The picture
 * routes return their refusal before any image is drawn, which is also why
 * this test never needs the image renderer.
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
  dir = mkdtempSync(join(tmpdir(), 'sidequest-pack-ownership-'));
  process.env.SIDEQUEST_DB_PATH = join(dir, 'test.db');
});

afterEach(() => {
  releaseDatabase();
  delete process.env.SIDEQUEST_DB_PATH;
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

async function outcomeOf(run: () => Promise<unknown>): Promise<'rendered' | 'redirect' | 'not_found'> {
  try {
    await run();
    return 'rendered';
  } catch (error) {
    const digest = String((error as { digest?: string })?.digest ?? '');
    if (digest.includes('404') || digest.includes('NOT_FOUND')) return 'not_found';
    if (digest.includes('NEXT_REDIRECT')) return 'redirect';
    throw error;
  }
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

describe('the Trip Pack page', () => {
  it('404s for a foreign browser and renders for the owner', async () => {
    const tripId = await seededTrip();
    const { default: Page, generateMetadata } = await import('./page');

    jar.set('sidequest_session', INTRUDER);
    expect(await outcomeOf(() => Page(params(tripId)))).toBe('not_found');
    expect(String((await generateMetadata(params(tripId))).title)).not.toContain('Harbour City');

    jar.set('sidequest_session', OWNER);
    expect(await outcomeOf(() => Page(params(tripId)))).toBe('rendered');
    expect(String((await generateMetadata(params(tripId))).title)).toContain('Harbour City');
  });
});

describe('the picture routes', () => {
  it('refuse a foreign browser with the missing-trip sentence and give the owner the trip’s state', async () => {
    const tripId = await seededTrip();
    const { GET: overview } = await import('../card/route');
    const { GET: day } = await import('../days/[n]/card/route');
    const request = new Request(`http://localhost/trips/${tripId}/card`);

    jar.set('sidequest_session', INTRUDER);
    const foreign = await overview(request, params(tripId));
    expect(foreign.status).toBe(404);
    expect(await foreign.text()).toBe('No such trip.');
    const foreignDay = await day(request, { params: Promise.resolve({ id: tripId, n: '1' }) });
    expect(foreignDay.status).toBe(404);
    expect(await foreignDay.text()).toBe('No such trip.');

    jar.set('sidequest_session', OWNER);
    const own = await overview(request, params(tripId));
    expect(own.status).toBe(404);
    expect(await own.text()).toContain('No plan has been built');
    const ownDay = await day(request, { params: Promise.resolve({ id: tripId, n: '1' }) });
    expect(await ownDay.text()).toContain('No plan has been built');
  });
});
