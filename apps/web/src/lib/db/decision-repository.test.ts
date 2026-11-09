import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DESTINATION_CATALOG_VERSION,
  arrayWorld,
  buildAdvisorShortlist,
  destinationCatalog,
  emptyAdvisorAnswers,
  emptyComposerAnswers,
  type TripComposerAnswers,
} from '@sidequest/core';
import { getDb } from './client';
import { createDecisionSession, getDecisionSession, saveDecisionShortlist } from './decision-repository';

/**
 * A DECISION SESSION OUTLIVES THE ENGINE THAT RANKED IT.
 *
 * `decision_sessions.shortlist_json` held the previous ranker's shortlist
 * until the destination advisor replaced it, and those rows are still on disk
 * — in every database that existed before the change — with nothing left that
 * can read them. What the traveller is owed on such a row is everything they
 * said: the session must load, its answers must be intact, and the list must
 * read as "not built yet" so the page re-enters the interview. It must never
 * throw, and it must never take the answers down with the list.
 */

let directory: string;

function releaseDatabase(): void {
  const cache = globalThis as unknown as { sidequestDb?: { close: () => void } };
  cache.sidequestDb?.close();
  delete cache.sidequestDb;
}

beforeEach(() => {
  releaseDatabase();
  directory = mkdtempSync(join(tmpdir(), 'sidequest-decision-'));
  process.env.SIDEQUEST_DB_PATH = join(directory, 'decision.db');
});

afterEach(() => {
  releaseDatabase();
  delete process.env.SIDEQUEST_DB_PATH;
  rmSync(directory, { recursive: true, force: true });
});

const NOW = new Date('2026-11-08T12:00:00.000Z');

function answers(): TripComposerAnswers {
  return {
    ...emptyComposerAnswers('help_me_decide', NOW),
    adults: 3,
    duration: { ...emptyComposerAnswers('help_me_decide', NOW).duration, nights: 9 },
    discovery: { ...emptyAdvisorAnswers(), request: 'somewhere cold with mountains' },
  };
}

function storeRaw(id: string, shortlistJson: string): void {
  getDb().prepare('UPDATE decision_sessions SET shortlist_json = ? WHERE id = ?').run(shortlistJson, id);
}

/**
 * A row exactly as the previous ranker wrote it: `schemaVersion: 1`, a
 * `rankerVersion`, picks keyed by index `entryId`, and no `kind`.
 */
const OLD_RANKER_SHORTLIST = {
  schemaVersion: 1,
  rankerVersion: 'ranker/2026-08-03.1',
  inputKey: 'v1|help_me_decide|month:7|nights:9',
  picks: [
    {
      entryId: 'overture:region:0851b1c8',
      releaseId: '2026-07-22.0',
      displayName: 'Troms',
      qualifiedName: 'Troms, Norway',
      featureType: 'region',
      center: { lat: 69.6, lng: 19.0 },
      countryCode: 'NO',
      score: 81,
      coverage: 0.62,
      band: 'strong_match',
      factors: [{ dimension: 'climate', weight: 0.2, measure: { kind: 'measured', value: 0.9, basis: 'twenty-year normals' } }],
      conflicts: [],
      unknowns: ['Cost of living'],
      reasons: ['Cool in July.'],
      tradeoffs: [],
      suggestedNights: 8,
      bestMonths: [7, 8],
    },
  ],
  considered: 412,
  excluded: [],
  blindSpots: ['Islands the index does not hold.'],
  builtAt: '2026-08-14T09:30:00.000Z',
  elapsedMs: 4200,
  climateRequests: 12,
};

describe('a session stored by the previous ranker', () => {
  it('loads without throwing, with its answers intact and no list — so it re-enters the interview', () => {
    const given = answers();
    const id = createDecisionSession(given, 'session:mine', NOW);
    storeRaw(id, JSON.stringify(OLD_RANKER_SHORTLIST));

    let session: ReturnType<typeof getDecisionSession> = null;
    expect(() => {
      session = getDecisionSession(id);
    }).not.toThrow();

    expect(session).not.toBeNull();
    expect(session!.advisor).toBeNull();
    expect(session!.answers).toEqual(given);
    expect(session!.ownerToken).toBe('session:mine');
    expect(session!.resolvedTripId).toBeNull();
    // The old field is gone rather than null: nothing can render a list no engine stands behind.
    expect(session).not.toHaveProperty('shortlist');
  });

  it('is not mistaken for an advisor list by a `kind` it never carried', () => {
    const id = createDecisionSession(answers(), 'session:mine', NOW);
    // The old shape with the new discriminator bolted on is still not an advisor shortlist.
    storeRaw(id, JSON.stringify({ ...OLD_RANKER_SHORTLIST, kind: 'advisor' }));
    expect(getDecisionSession(id)?.advisor).toBeNull();
    expect(getDecisionSession(id)?.answers.adults).toBe(3);
  });

  it.each([
    ['text that is not JSON', '{"schemaVersion":1,"picks":['],
    ['a JSON null', 'null'],
    ['a JSON array', '[]'],
    ['a bare string', '"shortlist"'],
    ['an empty object', '{}'],
  ])('reads %s in the column as no list yet, never as a lost session', (_label, stored) => {
    const given = answers();
    const id = createDecisionSession(given, 'session:mine', NOW);
    storeRaw(id, stored);
    const session = getDecisionSession(id);
    expect(session?.advisor).toBeNull();
    expect(session?.answers).toEqual(given);
  });

  it('is replaced by the advisor list the moment one is built', () => {
    const given = answers();
    const id = createDecisionSession(given, 'session:mine', NOW);
    storeRaw(id, JSON.stringify(OLD_RANKER_SHORTLIST));

    const shortlist = buildAdvisorShortlist({
      answers: given,
      catalog: arrayWorld(destinationCatalog(), DESTINATION_CATALOG_VERSION),
      catalogVersion: DESTINATION_CATALOG_VERSION,
      now: NOW,
    });
    saveDecisionShortlist(id, shortlist, NOW);

    const session = getDecisionSession(id);
    expect(session?.advisor?.kind).toBe('advisor');
    expect(session?.advisor?.picks.map((pick) => pick.id)).toEqual(shortlist.picks.map((pick) => pick.id));
    expect(session?.answers).toEqual(given);
  });
});

describe('a session with no list', () => {
  it('reads as null, which is different from an empty list', () => {
    const id = createDecisionSession(answers(), null, NOW);
    expect(getDecisionSession(id)?.advisor).toBeNull();
  });

  it('is still refused when its answers cannot be read: the answers are the session', () => {
    const id = createDecisionSession(answers(), 'session:mine', NOW);
    getDb().prepare('UPDATE decision_sessions SET answers_json = ? WHERE id = ?').run('{"mode":"nonsense"}', id);
    expect(getDecisionSession(id)).toBeNull();
  });
});
