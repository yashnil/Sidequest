import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Itinerary } from '@sidequest/core';
import { getDb } from '@/lib/db/client';
import { clearItinerary, clearItineraryLock, createTrip, getItinerary, getItineraryLocks, getSelections, preservePlan, saveItinerary, setItineraryLock, setSelection, updateTripBasics } from '@/lib/db/repository';
import { getTripDraft, saveTripDraft } from '@/lib/db/draft-repository';
import { boardWorld, draftOf } from '@/lib/planning/acceptance/harness';
import { reconcileTripDraft } from '@/lib/planning/reconcile';
import { VERSIONS_KEPT_PER_TRIP, VERSIONS_SAVED_PER_TRIP, currentVersion, getVersion, listRestorePoints, recordBuiltVersion, recordEditVersion, recordVersion, setVersionSaved, undoTarget } from './version-repository';
import { restorePlanVersion, restorePointsFor } from './restore';

vi.mock('server-only', () => ({}));

let dir: string;

function closeDb(): void {
  const cache = globalThis as unknown as { sidequestDb?: { close: () => void } };
  cache.sidequestDb?.close();
  delete cache.sidequestDb;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sidequest-plan-history-'));
  process.env.SIDEQUEST_DB_PATH = join(dir, 'history.db');
  closeDb();
  getDb();
});

afterEach(() => {
  closeDb();
  delete process.env.SIDEQUEST_DB_PATH;
  rmSync(dir, { recursive: true, force: true });
});

const BASICS = {
  mode: 'known_destination' as const,
  destinationInput: 'Harbour City',
  regionId: 'open-world',
  startDate: '2026-08-12',
  endDate: '2026-08-15',
  arrivalTime: '10:00',
  departureTime: '18:00',
  arrivalPrecision: 'exact' as const,
  departurePrecision: 'exact' as const,
  adults: 2,
  children: 0,
  travelerNeeds: [],
};

async function seed(theme = 'The original day'): Promise<{ tripId: string; itinerary: Itinerary }> {
  const tripId = createTrip(BASICS, 'session:mine').id;
  const draft = draftOf({
    bases: [{ id: 'base', name: 'Mammoth Lakes', nights: 3 }],
    days: [
      { base: 'base', anchors: [{ name: 'Convict Lake' }], theme },
      { base: 'base', anchors: [{ name: 'Mono Lake' }] },
      { base: 'base', anchors: [{ name: 'Hot Creek' }] },
    ],
  });
  saveTripDraft({ tripId, draft });
  const built = await reconcileTripDraft({ draft, context: boardWorld() });
  const itinerary = { ...built.itinerary, tripId };
  saveItinerary(itinerary);
  return { tripId, itinerary: getItinerary(tripId)! };
}

function withTheme(itinerary: Itinerary, theme: string): Itinerary {
  return { ...itinerary, days: itinerary.days.map((day, index) => (index === 0 ? { ...day, theme } : day)) };
}

/** What a rebuild does to the stored rows, in the order `generateSidequestPlanForTrip` does it. */
function rebuild(tripId: string, next: Itinerary, draftTheme = 'The rebuilt day'): void {
  preservePlan(tripId, { changed: 'Your plan before it was rebuilt', refreshDecisions: false });
  const draft = getTripDraft(tripId)!.draft;
  const rebuilt = { ...draft, days: draft.days.map((day, index) => (index === 0 ? { ...day, theme: draftTheme } : day)) };
  saveTripDraft({ tripId, draft: rebuilt });
  saveItinerary(next);
  recordBuiltVersion({ tripId, itinerary: next, draft: rebuilt });
}

describe('nothing replaces a plan the history does not hold', () => {
  it('records a plan with no history before saveItinerary replaces it, whoever the caller is', async () => {
    const { tripId, itinerary } = await seed();
    expect(currentVersion(tripId)).toBe(0);
    saveItinerary(withTheme(itinerary, 'Overwritten by a caller that knows nothing about versions'));
    expect(currentVersion(tripId)).toBe(1);
    expect(JSON.stringify(getVersion(tripId, 1)!.itinerary)).toBe(JSON.stringify(itinerary));
  });

  it('records the plan before clearItinerary deletes it', async () => {
    const { tripId, itinerary } = await seed();
    clearItinerary(tripId);
    expect(getItinerary(tripId)).toBeNull();
    expect(JSON.stringify(getVersion(tripId, currentVersion(tripId))!.itinerary)).toBe(JSON.stringify(itinerary));
  });

  it('adds nothing for a trip that is only ever built once', async () => {
    const { tripId, itinerary } = await seed();
    recordBuiltVersion({ tripId, itinerary });
    expect(currentVersion(tripId)).toBe(0);
    expect(restorePointsFor(tripId)).toEqual([]);
    expect(undoTarget(tripId)).toBeNull();
  });
});

describe('a rebuild can be taken back, exactly', () => {
  it('restores the plan, its draft, its pins and its board decisions, including hand edits', async () => {
    const { tripId, itinerary } = await seed();
    const edited = withTheme(itinerary, 'My own hand edit');
    recordEditVersion({ tripId, before: itinerary, after: edited, changed: 'Renamed day one' });
    saveItinerary(edited);
    setItineraryLock(tripId, 'place-a', 1);
    setSelection(tripId, 'place-b', 'excluded', 'user');
    const draftBefore = JSON.stringify(getTripDraft(tripId)!.draft);
    const planBefore = JSON.stringify(getItinerary(tripId));

    preservePlan(tripId, { changed: 'Your plan before it was rebuilt' });
    clearItineraryLock(tripId, 'place-a');
    setSelection(tripId, 'place-b', 'included', 'user');
    rebuild(tripId, withTheme(itinerary, 'Rebuilt from scratch'));
    expect(getItinerary(tripId)!.days[0]!.theme).toBe('Rebuilt from scratch');

    const target = undoTarget(tripId)!;
    const outcome = restorePlanVersion({ tripId, version: target.version, request: 'Undo', changed: 'Restored' });
    expect(outcome.ok).toBe(true);
    expect(JSON.stringify(getItinerary(tripId))).toBe(planBefore);
    expect(JSON.stringify(getTripDraft(tripId)!.draft)).toBe(draftBefore);
    expect(getItineraryLocks(tripId)).toEqual([{ placeId: 'place-a', dayNumber: 1 }]);
    expect(getSelections(tripId).find((s) => s.placeId === 'place-b')?.status).toBe('excluded');
  });

  it('a restore is itself undoable', async () => {
    const { tripId, itinerary } = await seed();
    const rebuilt = withTheme(itinerary, 'Rebuilt');
    rebuild(tripId, rebuilt);
    const rebuiltJson = JSON.stringify(getItinerary(tripId));
    expect(restorePlanVersion({ tripId, version: undoTarget(tripId)!.version, request: 'Undo', changed: 'Restored' }).ok).toBe(true);
    expect(getItinerary(tripId)!.days[0]!.theme).toBe(itinerary.days[0]!.theme);
    expect(restorePlanVersion({ tripId, version: undoTarget(tripId)!.version, request: 'Undo', changed: 'Restored' }).ok).toBe(true);
    expect(JSON.stringify(getItinerary(tripId))).toBe(rebuiltJson);
  });

  it('gives back a lock that was removed along with its stop', async () => {
    const { tripId, itinerary } = await seed();
    setItineraryLock(tripId, 'place-gone', 2);
    /* removeStopAction's order: preserve, save, the skip and the unpin, then the version after. */
    preservePlan(tripId);
    const after = withTheme(itinerary, 'Stop removed');
    saveItinerary(after);
    setSelection(tripId, 'place-gone', 'excluded', 'user');
    clearItineraryLock(tripId, 'place-gone');
    recordEditVersion({ tripId, before: itinerary, after, changed: 'Removed a stop' });

    expect(restorePlanVersion({ tripId, version: undoTarget(tripId)!.version, request: 'Undo', changed: 'Restored' }).ok).toBe(true);
    expect(getItineraryLocks(tripId)).toEqual([{ placeId: 'place-gone', dayNumber: 2 }]);
    expect(getSelections(tripId).some((s) => s.placeId === 'place-gone' && s.status === 'excluded')).toBe(false);

    /* And undoing that undo takes the stop, and the pin, off again. */
    expect(restorePlanVersion({ tripId, version: undoTarget(tripId)!.version, request: 'Undo', changed: 'Restored' }).ok).toBe(true);
    expect(getItineraryLocks(tripId)).toEqual([]);
    expect(getSelections(tripId).find((s) => s.placeId === 'place-gone')?.status).toBe('excluded');
  });

  it('keeps a pin set since the last version on the version before the next edit', async () => {
    const { tripId, itinerary } = await seed();
    preservePlan(tripId);
    setItineraryLock(tripId, 'late-pin', 1);
    preservePlan(tripId);
    const after = withTheme(itinerary, 'Edited');
    saveItinerary(after);
    recordEditVersion({ tripId, before: itinerary, after, changed: 'Edit' });
    expect(undoTarget(tripId)!.decisions!.locks.map((l) => l.placeId)).toEqual(['late-pin']);
  });

  it('refuses a version for dates the trip no longer has, in words', async () => {
    const { tripId, itinerary } = await seed();
    rebuild(tripId, withTheme(itinerary, 'Rebuilt'));
    updateTripBasics(tripId, { ...BASICS, startDate: '2026-09-01', endDate: '2026-09-05' });
    const version = undoTarget(tripId)!.version;
    const outcome = restorePlanVersion({ tripId, version, request: 'x', changed: 'y' });
    expect(outcome).toEqual({ ok: false, error: expect.stringContaining('different dates') });
    expect(restorePointsFor(tripId).find((p) => p.version === version)?.blocked).toContain('different dates');
  });
});

describe('what the trip page reads', () => {
  it('lists each plan once, newest first, and marks the one in use', async () => {
    const { tripId, itinerary } = await seed();
    rebuild(tripId, withTheme(itinerary, 'Rebuilt'));
    expect(restorePlanVersion({ tripId, version: undoTarget(tripId)!.version, request: 'Undo', changed: 'Restored an earlier version' }).ok).toBe(true);
    const points = restorePointsFor(tripId);
    expect(points.map((p) => [p.current, p.label])).toEqual([
      [true, 'Restored an earlier version'],
      [false, 'Rebuilt your trip'],
    ]);
  });

  it('a version older than this build lists as blocked and never throws', async () => {
    const { tripId, itinerary } = await seed();
    rebuild(tripId, withTheme(itinerary, 'Rebuilt'));
    getDb().prepare('UPDATE refinement_versions SET itinerary_json = ? WHERE trip_id = ? AND version = 1').run(JSON.stringify({ version: 1, days: [] }), tripId);
    const blocked = listRestorePoints(tripId, { startDate: BASICS.startDate, endDate: BASICS.endDate, itineraryVersion: itinerary.version }).find((p) => p.version === 1);
    expect(blocked?.blocked).toContain('earlier version');
    expect(undoTarget(tripId)).toBeNull();
    expect(restorePlanVersion({ tripId, version: 1, request: 'x', changed: 'y' }).ok).toBe(false);
    /* Reading the head for a new baseline must survive it too. */
    expect(() => preservePlan(tripId)).not.toThrow();
  });
});

describe('a build that fails leaves the plan and its draft as they were', () => {
  const failing = async (tripId: string, modelCall?: unknown) => {
    const { keepingDraftOnFailure } = await import('@/lib/planning/production-plan');
    const draft = getTripDraft(tripId)!.draft;
    return keepingDraftOnFailure(tripId, async () => {
      saveTripDraft({ tripId, draft: { ...draft, days: draft.days.map((day, i) => (i === 0 ? { ...day, theme: 'Half-built rebuild' } : day)) }, ...(modelCall ? { modelCall } : {}) });
      return { ok: false as const };
    });
  };

  it('puts a planner-written draft back when the build fails, and leaves the plan on the page', async () => {
    const { tripId, itinerary } = await seed();
    const draftBefore = JSON.stringify(getTripDraft(tripId)!.draft);
    await failing(tripId);
    expect(JSON.stringify(getTripDraft(tripId)!.draft)).toBe(draftBefore);
    expect(JSON.stringify(getItinerary(tripId))).toBe(JSON.stringify(itinerary));
  });

  it('keeps a draft the model paid for, so a retry can reuse it', async () => {
    const { tripId } = await seed();
    await failing(tripId, { model: 'x' });
    expect(getTripDraft(tripId)!.draft.days[0]!.theme).toBe('Half-built rebuild');
  });
});

describe('the history has an end', () => {
  const step = (tripId: string, itinerary: Itinerary, index: number) =>
    recordVersion({ tripId, previousVersion: currentVersion(tripId), summary: { changed: [`Change ${index}`], kept: [], rechecking: [] }, itinerary: withTheme(itinerary, `Theme ${index}`) });

  it('never prunes the newest versions or the ones the traveller kept', async () => {
    const { tripId, itinerary } = await seed();
    step(tripId, itinerary, 0);
    expect(setVersionSaved(tripId, 1, true)).toEqual({ ok: true });
    for (let index = 1; index < VERSIONS_KEPT_PER_TRIP * 2; index += 1) step(tripId, itinerary, index);

    const versions = (getDb().prepare('SELECT version FROM refinement_versions WHERE trip_id = ? ORDER BY version').all(tripId) as { version: number }[]).map((r) => r.version);
    expect(versions.length).toBe(VERSIONS_KEPT_PER_TRIP + 1);
    expect(versions[0]).toBe(1);
    expect(versions.at(-1)).toBe(currentVersion(tripId));
    expect(currentVersion(tripId)).toBe(VERSIONS_KEPT_PER_TRIP * 2);
    expect(undoTarget(tripId)).not.toBeNull();
  });

  it('caps how many a traveller can keep, and says so', async () => {
    const { tripId, itinerary } = await seed();
    for (let index = 0; index < VERSIONS_SAVED_PER_TRIP + 1; index += 1) step(tripId, itinerary, index);
    for (let version = 1; version <= VERSIONS_SAVED_PER_TRIP; version += 1) expect(setVersionSaved(tripId, version, true)).toEqual({ ok: true });
    expect(setVersionSaved(tripId, VERSIONS_SAVED_PER_TRIP + 1, true)).toEqual({ ok: false, error: expect.stringContaining(`up to ${VERSIONS_SAVED_PER_TRIP}`) });
  });
});
