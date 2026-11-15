import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb } from '@/lib/db/client';
import { createTrip, getItinerary, getSelections, saveItinerary, setItineraryLock } from '@/lib/db/repository';
import { addBookedItem } from '@/lib/db/intelligence-repository';
import { currentVersion, undoTarget } from '@/lib/refine/version-repository';
import { LIMITLAND_DATES, activities, overLimitItinerary } from '@/lib/planning/acceptance/travel-limit-world';

/**
 * 2026-11 — A DAILY-TRAVEL-LIMIT CHOICE IS A HAND EDIT: A VERSION, AND UNDOABLE.
 *
 * Through the real server action and a real database: applying a choice saves
 * the changed plan, records a version, skips a dropped stop on the board inside
 * the edit, and the toast's Undo (`undoTripEditAction`) puts the plan back
 * byte for byte, board decision included. A booked or locked stop is refused.
 */
vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('@/lib/net/trip-access', () => ({ tripAccessRefusal: async () => null }));
vi.mock('@/lib/net/caller', () => ({ guardAction: async () => null, guardBilledAction: async () => null, callerKey: async () => 'test-caller' }));

let dir: string;

function closeDb(): void {
  const cache = globalThis as unknown as { sidequestDb?: { close: () => void } };
  cache.sidequestDb?.close();
  delete cache.sidequestDb;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sidequest-travel-limit-'));
  process.env.SIDEQUEST_DB_PATH = join(dir, 'limit.db');
  closeDb();
  getDb();
});

afterEach(() => {
  closeDb();
  delete process.env.SIDEQUEST_DB_PATH;
  rmSync(dir, { recursive: true, force: true });
});

async function seed() {
  const tripId = createTrip(
    { mode: 'known_destination', destinationInput: 'Limitland', regionId: 'open-world', ...LIMITLAND_DATES, arrivalTime: '10:00', departureTime: '17:00', arrivalPrecision: 'exact', departurePrecision: 'exact', adults: 2, children: 0, travelerNeeds: [] },
    'session:mine',
  ).id;
  const { itinerary, farId } = await overLimitItinerary();
  saveItinerary({ ...itinerary, tripId });
  return { tripId, farId, stored: JSON.stringify(getItinerary(tripId)) };
}

describe('applying a daily-travel-limit choice', () => {
  it('drop: the day changes, a version is recorded, the board skips the stop, and Undo restores everything exactly', async () => {
    const { applyTravelLimitChoiceAction, undoTripEditAction } = await import('./actions');
    const { tripId, farId, stored } = await seed();
    const versionBefore = currentVersion(tripId);

    const result = await applyTravelLimitChoiceAction(tripId, `drop_stop:2:${farId}`);
    expect(result).toMatchObject({ ok: true, undoable: true, restoresPlaceId: farId });
    expect(result.changed).toMatch(/You dropped Far Lookout from day 2/);
    const after = getItinerary(tripId)!;
    expect(activities(after, 2).map((i) => i.title)).not.toContain('Far Lookout');
    expect(after.package!.planning!.travelLimit!.decisions).toHaveLength(1);
    expect(currentVersion(tripId)).toBeGreaterThan(versionBefore);
    expect(undoTarget(tripId)).not.toBeNull();
    expect(getSelections(tripId).find((s) => s.placeId === farId)?.status).toBe('excluded');

    const undone = await undoTripEditAction(tripId, farId);
    expect(undone.ok).toBe(true);
    expect(JSON.stringify(getItinerary(tripId))).toBe(stored);
    expect(getSelections(tripId).find((s) => s.placeId === farId)?.status).not.toBe('excluded');
  });

  it('keep: nothing on the day moves, the decision is recorded as a version, and Undo reopens the decision', async () => {
    const { applyTravelLimitChoiceAction, undoTripEditAction } = await import('./actions');
    const { tripId, stored } = await seed();
    const result = await applyTravelLimitChoiceAction(tripId, 'accept_long_day:2');
    expect(result).toMatchObject({ ok: true, undoable: true });
    const after = getItinerary(tripId)!;
    expect(after.package!.planning!.travelLimit!.days[0]!.accepted).toBe(true);
    expect(after.package!.feasibility!.items.find((i) => i.dayNumber === 2 && i.area === 'transport')!.severity).toBe('caution');
    expect((await undoTripEditAction(tripId)).ok).toBe(true);
    expect(JSON.stringify(getItinerary(tripId))).toBe(stored);
  });

  it('refuses to drop a stop the traveller booked or locked, and changes nothing', async () => {
    const { applyTravelLimitChoiceAction } = await import('./actions');
    const locked = await seed();
    setItineraryLock(locked.tripId, locked.farId, 2);
    expect(await applyTravelLimitChoiceAction(locked.tripId, `drop_stop:2:${locked.farId}`)).toMatchObject({ ok: false });
    expect(JSON.stringify(getItinerary(locked.tripId))).toBe(locked.stored);

    const booked = await seed();
    addBookedItem(booked.tripId, { type: 'activity', title: 'Far Lookout tour', date: LIMITLAND_DATES.startDate, placeId: booked.farId, status: 'booked', locked: true });
    expect(await applyTravelLimitChoiceAction(booked.tripId, `drop_stop:2:${booked.farId}`)).toMatchObject({ ok: false });
    expect(JSON.stringify(getItinerary(booked.tripId))).toBe(booked.stored);
  });
});
