import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IMAGERY_CONTRACT_VERSION, IMAGERY_RECORD_VERSION, type ImageryOutcome } from '@sidequest/core';
import { saveImageryOutcome, unresolvedImagerySubjects } from './imagery-repository';

/**
 * A REFUSAL THE GATE NO LONGER MAKES IS DUE NOW.
 *
 * Commons moved its thumbnails to `thumb.wikimedia.org` and, until the gate
 * learned the host, every photograph was refused as `unapproved_host` and
 * written down for ninety days. Those rows must be looked at again on the next
 * visit; an honest refusal (a fair-use file on another wiki) must not.
 */
let dir: string;

function releaseDatabase(): void {
  const holder = globalThis as unknown as { sidequestDb?: { close(): void } };
  holder.sidequestDb?.close();
  delete holder.sidequestDb;
}

beforeEach(() => {
  releaseDatabase();
  dir = mkdtempSync(join(tmpdir(), 'sidequest-imagery-'));
  process.env.SIDEQUEST_DB_PATH = join(dir, 'test.db');
});

afterEach(() => {
  releaseDatabase();
  delete process.env.SIDEQUEST_DB_PATH;
  rmSync(dir, { recursive: true, force: true });
});

function refusal(id: string, wikidataId: string, detail: string): ImageryOutcome {
  return {
    status: 'rejected',
    rejection: {
      schemaVersion: IMAGERY_RECORD_VERSION,
      subject: { kind: 'candidate', id, name: id, wikidataId },
      reason: 'unapproved_host',
      detail,
      fileTitle: 'File:x.jpg',
      provider: 'wikimedia-commons',
      contractVersion: IMAGERY_CONTRACT_VERSION,
      retrievedAt: '2026-10-25T12:00:00.000Z',
    },
  } as ImageryOutcome;
}

describe('stored imagery refusals', () => {
  it('retries a photograph refused only because of the old thumbnail host, and keeps an honest refusal', () => {
    const now = new Date('2026-10-25T12:00:00Z');
    saveImageryOutcome(refusal('belem', 'Q215003', 'thumb.wikimedia.org'), now);
    saveImageryOutcome(refusal('poster', 'Q42', 'thumb.wikimedia.org/wikipedia/en'), now);
    const outstanding = unresolvedImagerySubjects(
      [
        { kind: 'candidate' as const, id: 'belem', wikidataId: 'Q215003' },
        { kind: 'candidate' as const, id: 'poster', wikidataId: 'Q42' },
      ],
      new Date('2026-10-26T12:00:00Z'),
    );
    expect(outstanding.map((s) => s.id)).toEqual(['belem']);
  });
});
