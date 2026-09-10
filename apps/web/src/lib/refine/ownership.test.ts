import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A THREAD ID IS NOT A CAPABILITY.
 *
 * PRODUCTION LOCK V5 §61. Every refinement action is a trip-mutating door, and
 * the class of hole a graph-backed feature grows is the one where the thread id
 * *is* the check: a caller who knows or is shown `sidequest:<tripId>` can then
 * read its checkpoints and drive its graph.
 *
 * These tests state the property from the outside. A browser that did not make
 * the trip may not refine it, may not answer its questions, may not undo it, and
 * may not read its conversation — and the refusal is the same sentence every
 * other trip door uses, so the URL is not an oracle for whether the trip exists.
 *
 * The cookie jar is a mock and switching browsers is `jar.clear()`, exactly as
 * `(product)/ownership.test.ts` does it.
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
  dir = mkdtempSync(join(tmpdir(), 'sidequest-refine-own-'));
  process.env.SIDEQUEST_DB_PATH = join(dir, 'test.db');
});

afterEach(() => {
  releaseDatabase();
  delete process.env.SIDEQUEST_DB_PATH;
  rmSync(dir, { recursive: true, force: true });
});

const BASICS = {
  mode: 'known_destination' as const,
  destinationInput: 'Harbour City',
  regionId: 'open-world',
  startDate: '2026-09-01',
  endDate: '2026-09-04',
  arrivalTime: '10:00',
  departureTime: '18:00',
  arrivalPrecision: 'exact' as const,
  departurePrecision: 'exact' as const,
  adults: 2,
  children: 0,
  travelerNeeds: [],
};

async function tripOwnedBy(owner: string): Promise<string> {
  const { createTrip } = await import('@/lib/db/repository');
  return createTrip(BASICS, owner).id;
}

/** Become a browser: present this session cookie on every subsequent call. */
function asBrowser(token: string): void {
  jar.clear();
  jar.set('sidequest_session', token);
}

describe('a browser that did not make the trip cannot refine it', () => {
  it('refuses to start a refinement, with the same sentence every other trip door uses', async () => {
    const { refineTripAction } = await import('./actions');
    const { FOREIGN_TRIP_REFUSAL } = await import('@/lib/net/trip-access');
    const tripId = await tripOwnedBy('session:mine');
    asBrowser('session:theirs');
    const result = await refineTripAction({ tripId, request: 'Make day 2 easier.' });
    expect(result.ok).toBe(false);
    expect(result.error).toBe(FOREIGN_TRIP_REFUSAL);
    /* Nothing was created: no run, therefore no lease and no thread. */
    const { listRuns } = await import('./run-repository');
    expect(listRuns(tripId)).toEqual([]);
  });

  it('refuses to answer a question on it', async () => {
    const { answerRefinementAction } = await import('./actions');
    const { FOREIGN_TRIP_REFUSAL } = await import('@/lib/net/trip-access');
    const tripId = await tripOwnedBy('session:mine');
    asBrowser('session:theirs');
    const result = await answerRefinementAction({ tripId, runId: 'any', answer: 'A' });
    expect(result.error).toBe(FOREIGN_TRIP_REFUSAL);
  });

  it('refuses to undo it', async () => {
    const { undoRefinementAction } = await import('./actions');
    const { FOREIGN_TRIP_REFUSAL } = await import('@/lib/net/trip-access');
    const tripId = await tripOwnedBy('session:mine');
    asBrowser('session:theirs');
    expect((await undoRefinementAction({ tripId })).error).toBe(FOREIGN_TRIP_REFUSAL);
  });

  it('refuses to read its conversation', async () => {
    const { refinementHistoryAction } = await import('./actions');
    const { FOREIGN_TRIP_REFUSAL } = await import('@/lib/net/trip-access');
    const tripId = await tripOwnedBy('session:mine');
    asBrowser('session:theirs');
    const result = await refinementHistoryAction({ tripId });
    expect(result.ok).toBe(false);
    expect(result.runs).toBeUndefined();
    expect(result.error).toBe(FOREIGN_TRIP_REFUSAL);
  });

  it('is refused before the trip is even read, so a missing trip and a foreign one look the same', async () => {
    const { refineTripAction } = await import('./actions');
    const { FOREIGN_TRIP_REFUSAL } = await import('@/lib/net/trip-access');
    asBrowser('session:theirs');
    /* A trip id that never existed refuses identically: the URL is not an oracle. */
    const result = await refineTripAction({ tripId: 'no-such-trip', request: 'Anything.' });
    expect(result.error).toBe(FOREIGN_TRIP_REFUSAL);
  });
});

describe('the owner reaches their own trip, and gets an honest answer', () => {
  it('is refused for a reason about the trip rather than about ownership', async () => {
    const { refineTripAction } = await import('./actions');
    const tripId = await tripOwnedBy('session:mine');
    asBrowser('session:mine');
    /* Owned, but never built: the honest refusal is about the missing plan. */
    const result = await refineTripAction({ tripId, request: 'Make day 2 easier.' });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no plan to change yet/);
  });

  it('rejects an empty or oversized request without touching the trip', async () => {
    const { refineTripAction } = await import('./actions');
    const tripId = await tripOwnedBy('session:mine');
    asBrowser('session:mine');
    expect((await refineTripAction({ tripId, request: '   ' })).error).toMatch(/Tell Sidequest what/);
    expect((await refineTripAction({ tripId, request: 'x'.repeat(601) })).error).toMatch(/one change at a time/);
    const { listRuns } = await import('./run-repository');
    expect(listRuns(tripId)).toEqual([]);
  });

  it('can read its own empty conversation', async () => {
    const { refinementHistoryAction } = await import('./actions');
    const tripId = await tripOwnedBy('session:mine');
    asBrowser('session:mine');
    const result = await refinementHistoryAction({ tripId });
    expect(result.ok).toBe(true);
    expect(result.runs).toEqual([]);
    expect(result.canUndo).toBe(false);
  });
});

/**
 * §13 — UNDO RESTORES STATE, AND CALLS NOTHING.
 *
 * The live closure could not demonstrate this end to end, because the one
 * authorised refinement failed and left no version to undo. What can be proved
 * without a model — and is the whole of what undo does — is proved here through
 * the real server action: ownership, the real version repository, an exact
 * restore, and a path on which no interpreter is ever constructed.
 */
describe('undo', () => {
  async function seedVersions(tripId: string) {
    const { recordVersion } = await import('./version-repository');
    const { boardWorld, draftOf } = await import('@/lib/planning/acceptance/harness');
    const { reconcileTripDraft } = await import('@/lib/planning/reconcile');
    const context = boardWorld();
    const original = draftOf({
      bases: [{ id: 'base', name: 'Mammoth Lakes', nights: 3 }],
      days: [
        { base: 'base', anchors: [{ name: 'Convict Lake' }], theme: 'The original day one' },
        { base: 'base', anchors: [{ name: 'Mono Lake' }] },
        { base: 'base', anchors: [{ name: 'Hot Creek' }] },
      ],
      signatures: ['The Convict Lake morning'],
    });
    /*
     * The fixture world builds its itinerary against its own trip; retarget it
     * at the trip this test created, or `saveItinerary` refuses on the foreign
     * key — which is the schema correctly declining to store a trip's itinerary
     * under another trip's id.
     */
    const first = await reconcileTripDraft({ draft: original, context });
    const itinerary = { ...first.itinerary, tripId };
    recordVersion({ tripId, previousVersion: 0, request: 'the built trip', summary: { changed: ['built'], kept: [], rechecking: [] }, itinerary: { ...itinerary, summary: 'ORIGINAL' }, draft: original });

    /* A second version that changes the trip, exactly as an applied refinement would. */
    const refined = { ...original, days: original.days.map((d) => (d.dayNumber === 1 ? { ...d, theme: 'A different day one' } : d)), signatures: ['Something else entirely'] };
    recordVersion({ tripId, previousVersion: 1, request: 'change day one', summary: { changed: ['day 1'], kept: [], rechecking: [] }, itinerary: { ...itinerary, summary: 'REFINED' }, draft: refined });
    return { original };
  }

  it('restores the exact previous version and constructs no model at all', async () => {
    const { undoRefinementAction } = await import('./actions');
    const { currentVersion, getVersion } = await import('./version-repository');
    const { getTripDraft } = await import('@/lib/db/draft-repository');
    const tripId = await tripOwnedBy('session:mine');
    asBrowser('session:mine');
    const { original } = await seedVersions(tripId);
    expect(currentVersion(tripId)).toBe(2);

    /* No ANTHROPIC credential is present in this process, and undo must not care. */
    delete process.env.ANTHROPIC_API_KEY;
    const result = await undoRefinementAction({ tripId });
    expect(result.ok).toBe(true);

    /*
     * The restore is itself a version, so history stays append-only and an undo
     * can be undone. Version 3 carries version 1's content exactly.
     */
    expect(currentVersion(tripId)).toBe(3);
    const restored = getVersion(tripId, 3);
    expect(restored?.itinerary.summary).toBe('ORIGINAL');
    expect(restored?.draft).toEqual(original);
    /* And the live draft the trip renders from is the original, byte for byte. */
    expect(getTripDraft(tripId)?.draft).toEqual(original);
  });

  it('says there is nothing to undo on a trip that has never been refined', async () => {
    const { undoRefinementAction } = await import('./actions');
    const tripId = await tripOwnedBy('session:mine');
    asBrowser('session:mine');
    const result = await undoRefinementAction({ tripId });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/nothing to undo/);
  });
});
