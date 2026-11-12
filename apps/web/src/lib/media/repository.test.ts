import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { saveMediaSelections, selectedMediaFor, unresolvedMediaIds } from './repository';
import { fixtureMedia } from './resolve';

/** The media cache rides on `destination_images`; these pin its keys, its re-check rule and what is never stored. */

let dir: string;

function releaseDatabase(): void {
  const holder = globalThis as unknown as { sidequestDb?: { close(): void } };
  holder.sidequestDb?.close();
  delete holder.sidequestDb;
}

beforeEach(() => {
  releaseDatabase();
  dir = mkdtempSync(join(tmpdir(), 'sidequest-media-'));
  process.env.SIDEQUEST_DB_PATH = join(dir, 'test.db');
});

afterEach(() => {
  releaseDatabase();
  delete process.env.SIDEQUEST_DB_PATH;
  rmSync(dir, { recursive: true, force: true });
});

const NOW = new Date('2026-11-12T12:00:00Z');

/** A QID the fixture resolver gives a photograph (not one in three it refuses). */
function photographedQid(): string {
  for (let n = 1; n < 50; n += 1) {
    const qid = `Q${n}`;
    if (fixtureMedia({ wikidataId: qid, name: qid }, NOW).card.status === 'selected') return qid;
  }
  throw new Error('no fixture QID with a photograph');
}

describe('media repository', () => {
  it('round-trips a selection per context and keys it by QID', () => {
    const qid = photographedQid();
    saveMediaSelections(fixtureMedia({ wikidataId: qid, name: qid }, NOW), NOW);
    const cards = selectedMediaFor([qid, 'Q999999'], 'card', NOW);
    expect(Object.keys(cards)).toEqual([qid]);
    expect(cards[qid]?.context).toBe('card');
    expect(unresolvedMediaIds([qid, 'Q999999'], ['card', 'hero'], NOW)).toEqual(['Q999999']);
  });

  it('a selection past its licence re-check does not render and counts as unresolved', () => {
    const qid = photographedQid();
    saveMediaSelections(fixtureMedia({ wikidataId: qid, name: qid }, NOW), NOW);
    const later = new Date(NOW.getTime() + 31 * 86_400_000);
    expect(selectedMediaFor([qid], 'card', later)).toEqual({});
    expect(unresolvedMediaIds([qid], ['card'], later)).toEqual([qid]);
  });

  it('never stores "the service did not answer"', () => {
    saveMediaSelections(
      { card: { status: 'none', version: 1, context: 'card', wikidataId: 'Q5', reason: 'provider_unavailable', rejected: [] } },
      NOW,
    );
    expect(unresolvedMediaIds(['Q5'], ['card'], NOW)).toEqual(['Q5']);
  });

  it('a stored "none" is looked at, and a re-selection replaces the old row', () => {
    saveMediaSelections({ card: { status: 'none', version: 1, context: 'card', wikidataId: 'Q6', reason: 'all_rejected', rejected: [] } }, NOW);
    expect(unresolvedMediaIds(['Q6'], ['card'], NOW)).toEqual([]);
    expect(selectedMediaFor(['Q6'], 'card', NOW)).toEqual({});
    const qid = photographedQid();
    const photo = fixtureMedia({ wikidataId: qid, name: qid }, NOW).card;
    saveMediaSelections({ card: { ...photo, wikidataId: 'Q6' } as typeof photo }, NOW);
    expect(selectedMediaFor(['Q6'], 'card', NOW).Q6?.status).toBe('selected');
  });
});
