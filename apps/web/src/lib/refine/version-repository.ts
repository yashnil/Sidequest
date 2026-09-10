import 'server-only';
import { randomUUID } from 'node:crypto';
import { getDb } from '../db/client';
import { itinerarySchema, type Itinerary } from '@sidequest/core';
import { tripDraftSchema, type TripDraft } from '../planning/trip-draft';
import type { RefinementIntent } from './state';

/**
 * EVERY ACCEPTED CHANGE IS A VERSION, AND THE OLD ONE SURVIVES.
 *
 * PRODUCTION LOCK V5 §46, §47 and §48.
 *
 * ## Undo restores state; it does not replay a graph
 *
 * The tempting implementation is to walk the checkpointer back one step. It is
 * wrong twice over: replaying a node re-triggers whatever that node called, so
 * "undo" costs a model call and a set of provider requests; and a re-run can
 * produce something that is *not* what was undone, because a model call is not a
 * pure function. So the itinerary and the draft are stored whole, per version,
 * and Undo is a lookup and a write.
 *
 * The cost is disk, and a trip's worth of JSON is a few tens of kilobytes.
 *
 * ## Optimistic concurrency
 *
 * `version` is monotonic per trip and per lane, and `recordVersion` refuses a
 * write whose `previousVersion` is not the current head. Two refinements racing
 * the same trip therefore produce one success and one refusal, rather than a
 * last-writer-wins overwrite of work the traveller could still see on screen.
 */

export interface TripVersionSummary {
  changed: readonly string[];
  kept: readonly string[];
  rechecking: readonly string[];
  refused?: readonly { ref: string; reason: string }[];
}

export interface TripVersion {
  id: string;
  tripId: string;
  version: number;
  previousVersion: number | null;
  lane: 'canonical' | 'branch';
  request: string | null;
  intent: RefinementIntent | null;
  summary: TripVersionSummary;
  itinerary: Itinerary;
  draft: TripDraft | null;
  createdAt: string;
}

interface VersionRow {
  id: string;
  trip_id: string;
  version: number;
  previous_version: number | null;
  lane: string;
  request: string | null;
  intent: string | null;
  summary_json: string;
  itinerary_json: string;
  draft_json: string | null;
  created_at: string;
}

/** The head version for a trip in a lane, or 0 when nothing has been versioned yet. */
export function currentVersion(tripId: string, lane: 'canonical' | 'branch' = 'canonical'): number {
  const row = getDb().prepare('SELECT MAX(version) AS version FROM refinement_versions WHERE trip_id = ? AND lane = ?').get(tripId, lane) as { version: number | null } | undefined;
  return row?.version ?? 0;
}

export class StaleTripVersionError extends Error {
  readonly expected: number;
  readonly actual: number;
  constructor(expected: number, actual: number) {
    super(`This trip has changed since that edit was prepared (expected version ${expected}, found ${actual}).`);
    this.name = 'StaleTripVersionError';
    this.expected = expected;
    this.actual = actual;
  }
}

/**
 * Record a new version, refusing a stale write.
 *
 * `previousVersion` is the version the change was computed against. Passing the
 * wrong one is the concurrency failure this exists to catch, so it throws rather
 * than returning a flag: a caller that ignores a returned flag silently
 * overwrites, and that is the outcome with no acceptable failure mode.
 */
export function recordVersion(input: {
  tripId: string;
  previousVersion: number;
  lane?: 'canonical' | 'branch';
  request?: string;
  intent?: RefinementIntent;
  summary: TripVersionSummary;
  itinerary: Itinerary;
  draft?: TripDraft | null;
  now?: Date;
}): TripVersion {
  const lane = input.lane ?? 'canonical';
  const db = getDb();
  const now = (input.now ?? new Date()).toISOString();
  const id = randomUUID();
  let created: TripVersion | null = null;
  db.transaction(() => {
    const head = currentVersion(input.tripId, lane);
    if (head !== input.previousVersion) throw new StaleTripVersionError(input.previousVersion, head);
    const version = head + 1;
    db.prepare(
      `INSERT INTO refinement_versions (id, trip_id, version, previous_version, lane, request, intent, summary_json, itinerary_json, draft_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.tripId,
      version,
      head === 0 ? null : head,
      lane,
      input.request ?? null,
      input.intent ?? null,
      JSON.stringify(input.summary),
      JSON.stringify(input.itinerary),
      input.draft ? JSON.stringify(input.draft) : null,
      now,
    );
    created = {
      id,
      tripId: input.tripId,
      version,
      previousVersion: head === 0 ? null : head,
      lane,
      request: input.request ?? null,
      intent: input.intent ?? null,
      summary: input.summary,
      itinerary: input.itinerary,
      draft: input.draft ?? null,
      createdAt: now,
    };
  })();
  if (!created) throw new Error('The version was not recorded.');
  return created;
}

/**
 * THE TRIP AS SIDEQUEST FIRST BUILT IT, RECORDED BEFORE ANYTHING CHANGES IT.
 *
 * PRODUCTION LOCK V5 §46. Undo restores the version before the head, so a trip
 * whose first refinement is its only version has nothing to go back to — and the
 * first change a traveller makes is exactly the one most likely to want undoing.
 * The live acceptance run proved it: one successful refinement, head version 1,
 * `undoTarget` null, no Undo offered.
 *
 * So the build itself becomes version 1. It is recorded lazily rather than at
 * build time, because a trip that is never refined should not pay for a copy of
 * itself, and because that keeps generation and refinement independent.
 *
 * Idempotent: a trip that already has any version keeps the head it has.
 */
export function ensureBaselineVersion(input: { tripId: string; itinerary: Itinerary; draft?: TripDraft | null; now?: Date }): number {
  const head = currentVersion(input.tripId);
  if (head > 0) return head;
  const recorded = recordVersion({
    tripId: input.tripId,
    previousVersion: 0,
    summary: { changed: [], kept: [], rechecking: [] },
    itinerary: input.itinerary,
    draft: input.draft ?? null,
    now: input.now,
  });
  return recorded.version;
}

function parseRow(row: VersionRow): TripVersion {
  return {
    id: row.id,
    tripId: row.trip_id,
    version: row.version,
    previousVersion: row.previous_version,
    lane: row.lane === 'branch' ? 'branch' : 'canonical',
    request: row.request,
    intent: (row.intent as RefinementIntent | null) ?? null,
    summary: safeSummary(row.summary_json),
    itinerary: itinerarySchema.parse(JSON.parse(row.itinerary_json)),
    draft: row.draft_json ? tripDraftSchema.parse(JSON.parse(row.draft_json)) : null,
    createdAt: row.created_at,
  };
}

/**
 * A summary that cannot fail to read.
 *
 * The summary is display text, and a stored row whose shape has drifted must not
 * make a whole version unreadable — losing the ability to *restore* a trip
 * because its change-summary changed shape would be the worst possible trade.
 */
function safeSummary(json: string): TripVersionSummary {
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const list = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []);
    return { changed: list(parsed.changed), kept: list(parsed.kept), rechecking: list(parsed.rechecking) };
  } catch {
    return { changed: [], kept: [], rechecking: [] };
  }
}

export function listVersions(tripId: string, lane: 'canonical' | 'branch' = 'canonical', limit = 20): TripVersion[] {
  const rows = getDb().prepare('SELECT * FROM refinement_versions WHERE trip_id = ? AND lane = ? ORDER BY version DESC LIMIT ?').all(tripId, lane, limit) as VersionRow[];
  return rows.map(parseRow);
}

export function getVersion(tripId: string, version: number, lane: 'canonical' | 'branch' = 'canonical'): TripVersion | null {
  const row = getDb().prepare('SELECT * FROM refinement_versions WHERE trip_id = ? AND lane = ? AND version = ?').get(tripId, lane, version) as VersionRow | undefined;
  return row ? parseRow(row) : null;
}

/**
 * The version Undo should restore: the one before the head.
 *
 * Null when there is nothing to undo, which is a real answer and not an error —
 * a trip that has never been refined has no previous version, and the UI should
 * say so rather than offering a button that fails.
 */
export function undoTarget(tripId: string): TripVersion | null {
  const head = currentVersion(tripId);
  if (head <= 1) return null;
  return getVersion(tripId, head - 1);
}
