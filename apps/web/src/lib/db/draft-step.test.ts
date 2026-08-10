import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTrip, getAnswers, getDraftStep, saveAnswers } from './repository';
import { defaultAnswers, type TripBasics } from '@sidequest/core';

/**
 * THE CALL THAT CRASHED, AND THE ONE THAT MADE IT LOOK SAFE.
 *
 * `saveAnswers` gained an optional `step`, documented as "omitting it leaves the
 * stored position untouched". The first implementation bound `null` into a
 * `NOT NULL` column and coalesced against `excluded.draft_step` in the update
 * clause — which cannot work: SQLite enforces `NOT NULL` *before* it detects
 * the uniqueness conflict, so the insert throws and the update clause is never
 * reached. Every caller that omitted a step would have crashed.
 *
 * Nothing caught it because `saveAnswers` had no test at all. It has one now,
 * and the two-argument call is the first case, because that is the one that was
 * broken.
 */

let directory: string;

const BASICS: TripBasics = {
  mode: 'known_destination',
  destinationInput: 'Testland',
  regionId: 'eastern-sierra',
  startDate: '2026-08-12',
  endDate: '2026-08-15',
  arrivalTime: '11:00',
  departureTime: '17:00',
  adults: 2,
  children: 0,
  travelerNeeds: [],
};

/** The same open-a-fresh-database dance every repository test here uses. */
function resetDb(): void {
  const cache = globalThis as unknown as { sidequestDb?: { close: () => void } };
  cache.sidequestDb?.close();
  delete cache.sidequestDb;
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'sidequest-draft-step-'));
  process.env.SIDEQUEST_DB_PATH = join(directory, 'test.db');
  resetDb();
});

afterEach(() => {
  resetDb();
  delete process.env.SIDEQUEST_DB_PATH;
  rmSync(directory, { recursive: true, force: true });
});

describe('saving a questionnaire draft', () => {
  it('does not throw when no step is given', () => {
    const trip = createTrip(BASICS);
    const answers = defaultAnswers({ travelerNeeds: [], tripDays: 4 });
    expect(() => saveAnswers(trip.id, answers)).not.toThrow();
    expect(getAnswers(trip.id)).not.toBeNull();
    /* Nobody recorded a position, so the first step is where they resume. */
    expect(getDraftStep(trip.id)).toBe(0);
  });

  it('records a step when one is given, and reads it back', () => {
    const trip = createTrip(BASICS);
    const answers = defaultAnswers({ travelerNeeds: [], tripDays: 4 });
    saveAnswers(trip.id, answers, 5);
    expect(getDraftStep(trip.id)).toBe(5);
  });

  it('leaves a recorded step alone when a later save omits one', () => {
    /*
     * The documented contract, and the reason the naive fix was tempting: a
     * save that is only about answers must not silently send somebody back to
     * the beginning.
     */
    const trip = createTrip(BASICS);
    const answers = defaultAnswers({ travelerNeeds: [], tripDays: 4 });
    saveAnswers(trip.id, answers, 4);
    saveAnswers(trip.id, { ...answers, pace: 'slow' });
    expect(getDraftStep(trip.id)).toBe(4);
    expect(getAnswers(trip.id)?.pace).toBe('slow');
  });

  it('moves the step backwards as well as forwards', () => {
    /* Going back has to persist, or Back is a control that loses work. */
    const trip = createTrip(BASICS);
    const answers = defaultAnswers({ travelerNeeds: [], tripDays: 4 });
    saveAnswers(trip.id, answers, 6);
    saveAnswers(trip.id, answers, 2);
    expect(getDraftStep(trip.id)).toBe(2);
  });

  it('reads zero for a trip nobody has answered', () => {
    const trip = createTrip(BASICS);
    expect(getDraftStep(trip.id)).toBe(0);
  });
});
