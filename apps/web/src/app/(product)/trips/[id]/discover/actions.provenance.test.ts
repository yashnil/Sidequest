import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildTravelerProfile, countTripDays } from '@sidequest/core';
import { MAMMOTH_HIKER_ANSWERS, answers, context } from '@sidequest/core/testing';

/**
 * SELECTION PROVENANCE, ROUND TRIP THROUGH THE ACTIONS A TRAVELLER PRESSES.
 *
 * Four properties, each one a defect that shipped:
 *
 *   - un-ticking one of Sidequest's picks deleted the row, so the next
 *     "Choose for me" — or the questionnaire's seeding on the way to a build —
 *     put the same place straight back;
 *   - the questionnaire's seeding passed no `decided` at all;
 *   - the reason somebody gave for a skip was never stored;
 *   - pressing "Choose for me" on a board that was already right appeared to do
 *     nothing.
 *
 * Real database, authored offline region; only Next's request-scoped helpers
 * are mocked.
 */

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw Object.assign(new Error(`REDIRECT ${to}`), { redirectedTo: to });
  },
}));

const DATES = { start: '2026-08-12', end: '2026-08-16' } as const;

let directory: string;

function releaseDatabase(): void {
  const holder = globalThis as unknown as { sidequestDb?: { close(): void } };
  holder.sidequestDb?.close();
  delete holder.sidequestDb;
}

beforeEach(() => {
  releaseDatabase();
  directory = mkdtempSync(join(tmpdir(), 'sidequest-provenance-'));
  process.env.SIDEQUEST_DB_PATH = join(directory, 'test.db');
});

afterEach(() => {
  releaseDatabase();
  delete process.env.SIDEQUEST_DB_PATH;
  rmSync(directory, { recursive: true, force: true });
});

const ctx = context({ travelerNeeds: [], tripDays: countTripDays(DATES.start, DATES.end) });
const given = answers(MAMMOTH_HIKER_ANSWERS, ctx);

async function seededTrip(): Promise<string> {
  const { createTrip, saveProfile } = await import('@/lib/db/repository');
  const trip = createTrip({
    mode: 'known_destination',
    destinationInput: 'Mammoth Lakes',
    regionId: 'eastern-sierra',
    startDate: DATES.start,
    endDate: DATES.end,
    arrivalTime: '10:00',
    departureTime: '18:00',
    adults: 2,
    children: 0,
    travelerNeeds: [],
  });
  saveProfile(trip.id, given, buildTravelerProfile(given, ctx));
  return trip.id;
}

async function rowFor(tripId: string, placeId: string) {
  const { getSelections } = await import('@/lib/db/repository');
  return getSelections(tripId).find((row) => row.placeId === placeId);
}

async function autoIds(tripId: string): Promise<string[]> {
  const { getSelections } = await import('@/lib/db/repository');
  return getSelections(tripId)
    .filter((row) => row.source === 'auto')
    .map((row) => row.placeId);
}

/** Runs the questionnaire's completion write, which seeds the board. */
async function completeQuestionnaire(tripId: string): Promise<void> {
  const { completeQuestionnaireAction } = await import('../questionnaire/actions');
  try {
    const result = await completeQuestionnaireAction(tripId, given, 'board');
    if (result && !result.ok) throw new Error(result.error);
  } catch (error) {
    if (!(error instanceof Error) || !('redirectedTo' in error)) throw error;
  }
}

describe('selection provenance', () => {
  it('un-ticking a Sidequest pick is persisted and never re-added by auto-pick or by the questionnaire seeding', async () => {
    const { autoPickAction, setSelectionAction } = await import('./actions');
    const tripId = await seededTrip();
    const first = await autoPickAction(tripId);
    expect(first.ok, first.error).toBe(true);
    const unticked = first.autoPicks![0]!;
    expect(first.selections?.[unticked]).toBe('included');

    const result = await setSelectionAction(tripId, unticked, null);
    expect(result.ok).toBe(true);
    expect(await rowFor(tripId, unticked)).toMatchObject({ status: 'dismissed', source: 'user' });

    const again = await autoPickAction(tripId);
    expect(again.ok, again.error).toBe(true);
    expect(again.autoPicks).not.toContain(unticked);
    // On screen it is an ordinary undecided card.
    expect(again.selections?.[unticked]).toBeUndefined();
    expect(await rowFor(tripId, unticked)).toMatchObject({ status: 'dismissed', source: 'user' });

    await completeQuestionnaire(tripId);
    expect(await autoIds(tripId)).not.toContain(unticked);
    expect(await rowFor(tripId, unticked)).toMatchObject({ status: 'dismissed', source: 'user' });
    /*
     * The binding half. `ON CONFLICT DO NOTHING` keeps the dismissed row either
     * way; what tells the two apart is the slot. Seeding that does not know about
     * the un-tick spends a slot on it, has the insert refused, and comes out one
     * pick short of what auto-pick (which does know) delivers.
     */
    expect((await autoIds(tripId)).sort()).toEqual([...again.autoPicks!].sort());
  });

  it('a traveller skip, with its reason, survives auto-pick and the questionnaire seeding', async () => {
    const { autoPickAction, setSelectionAction } = await import('./actions');
    const tripId = await seededTrip();
    const first = await autoPickAction(tripId);
    const skipped = first.autoPicks![1]!;

    expect((await setSelectionAction(tripId, skipped, 'excluded', 'too_expensive')).ok).toBe(true);
    expect(await rowFor(tripId, skipped)).toMatchObject({ status: 'excluded', source: 'user', reason: 'too_expensive' });

    await autoPickAction(tripId);
    await completeQuestionnaire(tripId);
    expect(await rowFor(tripId, skipped)).toMatchObject({ status: 'excluded', source: 'user', reason: 'too_expensive' });
    expect(await autoIds(tripId)).not.toContain(skipped);

    // Changing their mind clears the old reason.
    await setSelectionAction(tripId, skipped, 'included');
    const row = await rowFor(tripId, skipped);
    expect(row).toMatchObject({ status: 'included', source: 'user' });
    expect(row?.reason).toBeUndefined();
  });

  it('a traveller include outranks the auto pick of the same place and reaches the composition as a must-include', async () => {
    const { autoPickAction, setSelectionAction } = await import('./actions');
    const { getSelections } = await import('@/lib/db/repository');
    const { boardSignalsFor } = await import('@/lib/planning/production-plan');
    const { boardFor, resolveTripRegion } = await import('@/lib/region');
    const { getProfile, getTrip } = await import('@/lib/db/repository');
    const tripId = await seededTrip();
    const first = await autoPickAction(tripId);
    const [mine, ...theirs] = first.autoPicks!;

    // Pressing Include on our pick toggles it off (dismissed); pressing it again makes it theirs.
    await setSelectionAction(tripId, mine!, null);
    await setSelectionAction(tripId, mine!, 'included');
    expect(await rowFor(tripId, mine!)).toMatchObject({ status: 'included', source: 'user' });

    const second = await autoPickAction(tripId);
    expect(second.autoPicks).not.toContain(mine);

    const trip = getTrip(tripId)!;
    const resolved = await resolveTripRegion(trip);
    if (!resolved.ok) throw new Error(resolved.error);
    const board = boardFor(trip, getProfile(tripId)!, resolved.context);
    const signals = boardSignalsFor(board.candidates, getSelections(tripId))!;
    const nameOf = (id: string) => board.candidates.find((c) => c.place.id === id)!;
    expect(signals.mustInclude).toHaveLength(1);
    expect(nameOf(mine!)).toBeDefined();
    // Sidequest's remaining picks are recommendations, never the traveller's.
    expect(signals.recommended!.length).toBeGreaterThan(0);
    expect(signals.recommended).not.toContain(signals.mustInclude[0]);
    expect(theirs.length).toBeGreaterThan(0);
  });

  it('pressing Choose for me on a board that already has the best mix says so', async () => {
    const { autoPickAction } = await import('./actions');
    const tripId = await seededTrip();
    const first = await autoPickAction(tripId);
    expect(first.change).toMatch(/^We added \d+ places?\.$/);
    const again = await autoPickAction(tripId);
    expect(again.ok).toBe(true);
    expect(again.change).toMatch(/^Your board already has the best mix/);
    expect(again.notes).toEqual([]);
    expect(again.autoPicks?.sort()).toEqual(first.autoPicks?.sort());
  });
});
