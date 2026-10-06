import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildTravelerProfile, countTripDays } from '@sidequest/core';
import { MAMMOTH_HIKER_ANSWERS, answers, context } from '@sidequest/core/testing';

/**
 * "AUTO-PICK PROPOSES, IT DOES NOT OVERRULE" — EXERCISED THROUGH THE ACTION.
 *
 * `autoSelect` has a thorough unit suite and it proves the wrong half. The
 * traveller's decisions are an *input* to that function, and what assembles
 * that input is eleven lines in this server action, reading the selection store
 * and handing the result down. Delete those eleven lines — replace the
 * condition with one that is never true — and the entire repository suite stays
 * green: 4,553 tests, nothing said. Measured, not supposed. The pure function's
 * tests all construct `decided` themselves, so they go on passing over an
 * argument the product no longer supplies.
 *
 * That is the shape of defect this phase keeps finding: the module was proven
 * and the call was not. So this drives `autoPickAction` itself, against a real
 * database and the real authored region, and asserts what the traveller would
 * see rather than what the function was passed.
 *
 * The two properties are the two halves of "does not overrule", and they fail
 * in different ways, which is why neither is enough on its own:
 *
 *   - **A refusal is honoured.** Without it, auto-pick spends a slot on a place
 *     the traveller said no to. The write is refused by `ON CONFLICT DO
 *     NOTHING`, so the *store* still looks right — the damage is a slot bought
 *     and never delivered, and a board one stop shorter than the pass reported.
 *     An assertion on the refused place's status alone would pass; the
 *     observable is the count.
 *   - **An acceptance is counted.** A place the traveller already chose fills
 *     part of the trip's room, so the pass has less to fill. Without it the pass
 *     picks a full trip's worth *on top of* what the traveller already had.
 *
 * Nothing here reaches a network. The region is the authored Eastern Sierra
 * fixture, which resolves offline; the only external thing mocked is Next's
 * cache revalidation, which has no meaning outside a request.
 */

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

const DATES = { start: '2026-08-12', end: '2026-08-16' } as const;

let directory: string;

function releaseDatabase(): void {
  const holder = globalThis as unknown as { sidequestDb?: { close(): void } };
  holder.sidequestDb?.close();
  delete holder.sidequestDb;
}

beforeEach(() => {
  releaseDatabase();
  directory = mkdtempSync(join(tmpdir(), 'sidequest-autopick-wiring-'));
  process.env.SIDEQUEST_DB_PATH = join(directory, 'test.db');
});

afterEach(() => {
  releaseDatabase();
  delete process.env.SIDEQUEST_DB_PATH;
  rmSync(directory, { recursive: true, force: true });
});

/** A trip in the authored region with a finished questionnaire behind it. */
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
  const ctx = context({
    travelerNeeds: [],
    tripDays: countTripDays(DATES.start, DATES.end),
  });
  const given = answers(MAMMOTH_HIKER_ANSWERS, ctx);
  saveProfile(trip.id, given, buildTravelerProfile(given, ctx));
  return trip.id;
}

/** The place ids this pass wrote, which is the only thing it actually bought. */
async function autoRows(tripId: string): Promise<string[]> {
  const { getSelections } = await import('@/lib/db/repository');
  return getSelections(tripId)
    .filter((row) => row.source === 'auto')
    .map((row) => row.placeId)
    .sort();
}

/**
 * How many places the pass told the traveller it had picked.
 *
 * Read out of the sentence because that is where it exists: the action returns
 * the store and a note, and the note is the only place the *count* is claimed.
 * That claim is the thing worth checking against the store — a pass that spends
 * a slot on a place the store then refuses reports a number it did not deliver,
 * and the traveller reads "We picked 14 places" over a board holding thirteen.
 */
function reportedCount(notes: readonly string[] | undefined): number {
  // V1 — auto-pick is the planner: the note counts every place planned, the traveller's own includes among them.
  const sentence = (notes ?? []).find((note) => note.startsWith('We planned '));
  const found = sentence ? /^We planned (\d+) places?\b/.exec(sentence) : null;
  if (!found) throw new Error(`no "We planned N places" note in: ${JSON.stringify(notes)}`);
  return Number(found[1]);
}

describe('auto-pick, driven through the action a traveller presses', () => {
  it('never spends a slot on a place the traveller has already refused', async () => {
    const { autoPickAction } = await import('./actions');
    const { setSelection } = await import('@/lib/db/repository');

    const tripId = await seededTrip();
    const first = await autoPickAction(tripId);
    expect(first.ok, first.error).toBe(true);
    const picked = await autoRows(tripId);
    /* Below a couple of picks the arithmetic below cannot distinguish anything. */
    expect(picked.length).toBeGreaterThan(2);

    /*
     * The traveller refuses the very place the pass chose first, which is the
     * only choice that makes this a measurement: refusing something it was
     * never going to pick would leave the second run identical either way.
     */
    const refused = picked[0]!;
    const again = await seededTrip();
    setSelection(again, refused, 'excluded', 'user');
    const second = await autoPickAction(again);
    expect(second.ok, second.error).toBe(true);

    const afterRefusal = await autoRows(again);
    expect(afterRefusal, 'auto-pick planned a place the traveller had said no to').not.toContain(
      refused,
    );
    /*
     * And it filled the room it had. This is the assertion that fails when the
     * action stops telling `autoSelect` what was decided: the pass still picks
     * the refused place, the insert is silently ignored, and the traveller gets
     * a board one stop shorter than the sentence above it claims.
     */
    /*
     * V1 — the room is days, not a slot count, so the planner may fill the
     * refused place's time with one alternative or two. What binds is that it
     * still fills the trip and that what it reports is what it wrote.
     */
    expect(Math.abs(afterRefusal.length - picked.length), 'refusing one place should not empty or overfill the trip').toBeLessThanOrEqual(1);
    expect(reportedCount(second.notes), 'the report must count exactly what was written').toBe(afterRefusal.length);
    expect(second.selections?.[refused]).toBe('excluded');
  });

  it('counts what the traveller already chose against the room the trip has', async () => {
    const { autoPickAction } = await import('./actions');
    const { setSelection } = await import('@/lib/db/repository');

    const tripId = await seededTrip();
    const first = await autoPickAction(tripId);
    expect(first.ok, first.error).toBe(true);
    const picked = await autoRows(tripId);
    expect(picked.length).toBeGreaterThan(2);

    const chosen = picked[0]!;
    const again = await seededTrip();
    setSelection(again, chosen, 'included', 'user');
    const second = await autoPickAction(again);
    expect(second.ok, second.error).toBe(true);

    const afterChoice = await autoRows(again);
    expect(afterChoice).not.toContain(chosen);
    /*
     * One place is already in the trip, so the pass has one fewer slot to fill.
     * Without the traveller's choice reaching it, the pass fills a whole trip's
     * worth *beside* what they had already put in.
     */
    expect(
      Math.abs(afterChoice.length + 1 - picked.length),
      'auto-pick ignored a stop the traveller had already put in the trip and filled the ' +
        'whole trip again around it',
    ).toBeLessThanOrEqual(1);
    /*
     * THE ASSERTION THAT ACTUALLY BINDS THIS HALF, and the reason it is on the
     * sentence rather than on the store.
     *
     * `replaceAutoSelections` inserts `ON CONFLICT DO NOTHING`, so the row count
     * comes out the same whether the pass respected the traveller's choice or
     * re-picked it and had the write refused. The store cannot tell those apart;
     * the *report* can. A pass that spent a slot it never delivered says it
     * picked one more place than the board holds, and that number is what the
     * traveller reads.
     */
    expect(
      reportedCount(second.notes),
      'auto-pick reported picking more places than it wrote, which is a slot spent on a ' +
        'place the traveller had already put in the trip themselves',
    ).toBe(afterChoice.length + 1); // the traveller's own include is planned too, and counted once
    expect(second.selections?.[chosen]).toBe('included');
  });
});
