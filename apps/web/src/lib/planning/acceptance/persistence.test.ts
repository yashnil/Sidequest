import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '@/lib/db/client';
import { getItinerary, getReadiness, saveItinerary, saveReadiness } from '@/lib/db/repository';
import { getTripDraft, saveTripDraft } from '@/lib/db/draft-repository';
import { reconcileTripDraft } from '../reconcile';
import { icelandContext, icelandDraft } from './iceland-replay.test';

/**
 * GENERATE → PERSIST → RELOAD → SEMANTIC EQUALITY.
 *
 * The canonical itinerary, its package, its dispositions and its readiness
 * go through the real SQLite repository the itinerary page reads from, and
 * come back deep-equal. The raw draft is stored separately and comes back
 * verbatim.
 */
let directory: string;
function closeDb(): void {
  const cache = globalThis as unknown as { sidequestDb?: { close: () => void } };
  cache.sidequestDb?.close();
  delete cache.sidequestDb;
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'sidequest-persistence-'));
  process.env.SIDEQUEST_DB_PATH = join(directory, 'p.db');
  closeDb();
  getDb()
    .prepare(
      `INSERT INTO trips (id, mode, destination_input, region_id, start_date, end_date, arrival_time, departure_time, adults, children, traveler_needs, status, created_at, updated_at)
       VALUES ('iceland-replay', 'known_destination', 'Iceland', 'dynamic', '2026-07-05', '2026-07-17', '10:00', '16:00', 2, 0, '[]', 'draft', '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z')`,
    )
    .run();
});

afterEach(() => {
  closeDb();
  delete process.env.SIDEQUEST_DB_PATH;
  rmSync(directory, { recursive: true, force: true });
});

describe('persistence round trip', () => {
  it('the reconciled Iceland itinerary, package, readiness and raw draft survive save and reload unchanged', async () => {
    const draft = icelandDraft();
    const result = await reconcileTripDraft({ draft, context: icelandContext().context });
    saveTripDraft({ tripId: 'iceland-replay', draft, modelCall: { callLabel: 'replay' }, now: new Date('2026-06-01T00:00:00Z') });
    saveItinerary(result.itinerary);
    saveReadiness('iceland-replay', result.readiness, new Date('2026-06-01T00:00:00Z'));

    const reloaded = getItinerary('iceland-replay');
    expect(reloaded).toEqual(result.itinerary);
    expect(reloaded?.package?.anchors).toHaveLength(32);
    expect(reloaded?.package?.anchors.map((a) => a.disposition)).toEqual(result.dispositions.map((a) => a.disposition));
    expect(getReadiness('iceland-replay')).toEqual(result.readiness);

    // LIVE WORLD V1 gate: measured legs keep their basis, provider, timestamp and encoded shape across the database.
    const legsOf = (days: typeof result.itinerary.days) => days.flatMap((d) => d.items.flatMap((i) => (i.kind === 'travel' && i.travel ? [i.travel] : [])));
    const measured = legsOf(reloaded!.days).filter((l) => l.provenance === 'measured');
    expect(measured.length).toBeGreaterThanOrEqual(5);
    expect(measured.every((l) => l.basis === 'static' && l.provider && l.measuredAt)).toBe(true);
    const withShape = measured.filter((l) => typeof l.geometry === 'string');
    expect(withShape.length).toBeGreaterThanOrEqual(3);
    expect(withShape.map((l) => l.geometry)).toEqual(legsOf(result.itinerary.days).filter((l) => typeof l.geometry === 'string').map((l) => l.geometry));
    const storedDraft = getTripDraft('iceland-replay');
    expect(storedDraft?.draft).toEqual(draft);
    expect(storedDraft?.modelCall).toEqual({ callLabel: 'replay' });
  });
});
