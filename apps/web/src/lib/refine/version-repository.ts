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
  /** The traveller's pins and board decisions as they stood with this plan. Null on a row older than this record. */
  decisions: PlanDecisions | null;
  /** When the traveller chose to keep this version; pruning never touches it. */
  savedAt: string | null;
}

/**
 * WHAT A PLAN IS BESIDES ITS DAYS.
 *
 * A pin and a skip live in their own tables, so a version that held only the
 * itinerary restored the stops and forgot what the traveller had decided about
 * them: a stop came back unpinned, and still struck off the next rebuild.
 */
export interface PlanDecisions {
  locks: { placeId: string; dayNumber: number; createdAt: string }[];
  selections: { placeId: string; status: string; source: string; reason: string | null; updatedAt: string }[];
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
  decisions_json: string | null;
  saved_at: string | null;
}

/** How many of the newest versions a trip keeps, besides any the traveller saved. */
export const VERSIONS_KEPT_PER_TRIP = 25;
/** How many versions a traveller can save on one trip, so the exemption from pruning has an end too. */
export const VERSIONS_SAVED_PER_TRIP = 10;

export function readPlanDecisions(tripId: string): PlanDecisions {
  const db = getDb();
  const locks = db.prepare('SELECT place_id, day_number, created_at FROM itinerary_locks WHERE trip_id = ? ORDER BY place_id').all(tripId) as { place_id: string; day_number: number; created_at: string }[];
  const selections = db.prepare('SELECT place_id, status, source, reason, updated_at FROM discovery_selections WHERE trip_id = ? ORDER BY rowid, place_id').all(tripId) as { place_id: string; status: string; source: string; reason: string | null; updated_at: string }[];
  return {
    locks: locks.map((row) => ({ placeId: row.place_id, dayNumber: row.day_number, createdAt: row.created_at })),
    selections: selections.map((row) => ({ placeId: row.place_id, status: row.status, source: row.source, reason: row.reason, updatedAt: row.updated_at })),
  };
}

/** Puts a version's pins and board decisions back exactly, inside the caller's transaction. */
export function writePlanDecisions(tripId: string, decisions: PlanDecisions): void {
  const db = getDb();
  db.prepare('DELETE FROM itinerary_locks WHERE trip_id = ?').run(tripId);
  const lock = db.prepare('INSERT INTO itinerary_locks (trip_id, place_id, day_number, created_at) VALUES (?, ?, ?, ?)');
  for (const row of decisions.locks) lock.run(tripId, row.placeId, row.dayNumber, row.createdAt);
  db.prepare('DELETE FROM discovery_selections WHERE trip_id = ?').run(tripId);
  const selection = db.prepare('INSERT INTO discovery_selections (trip_id, place_id, status, source, reason, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
  for (const row of decisions.selections) selection.run(tripId, row.placeId, row.status, row.source, row.reason, row.updatedAt);
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
    const decisions = readPlanDecisions(input.tripId);
    db.prepare(
      `INSERT INTO refinement_versions (id, trip_id, version, previous_version, lane, request, intent, summary_json, itinerary_json, draft_json, created_at, decisions_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      JSON.stringify(decisions),
    );
    /* Never the newest, never one the traveller saved; `version` keeps counting, so the calendar's SEQUENCE and the concurrency token are unaffected. */
    db.prepare(
      `DELETE FROM refinement_versions WHERE trip_id = ? AND lane = ? AND saved_at IS NULL
         AND version NOT IN (SELECT version FROM refinement_versions WHERE trip_id = ? AND lane = ? ORDER BY version DESC LIMIT ?)`,
    ).run(input.tripId, lane, input.tripId, lane, VERSIONS_KEPT_PER_TRIP);
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
      decisions,
      savedAt: null,
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
 * Idempotent: a trip whose head already *is* this plan keeps the head it has.
 *
 * RELEASE PASS — THE HEAD HAS TO BE THE PLAN ON THE PAGE, OR UNDO LIES.
 *
 * "Any version at all" used to be enough, and that was only true while every
 * change to a plan went through this history. Two kinds did not: a rebuild,
 * and every edit made by hand on a day (a move, a custom stop, a duration).
 * So after "Ask → move a stop by hand → Ask again → Undo", Undo restored the
 * head before the second Ask — a snapshot taken before the hand edit — and the
 * traveller's own change vanished under a sentence that said the trip was
 * "back as it was before your last change". It was not.
 *
 * The plan as it stands is now recorded whenever the head is not it, so the
 * version before any change is always exactly what was on the page. A
 * comparison that is wrong in the cautious direction (two equal plans read as
 * different) costs one extra snapshot and restores the same thing.
 */
export function ensureBaselineVersion(input: { tripId: string; itinerary: Itinerary; draft?: TripDraft | null; now?: Date; changed?: string; refreshDecisions?: boolean }): number {
  const head = currentVersion(input.tripId);
  if (head > 0) {
    const current = readableVersion(input.tripId, head);
    if (current && samePlan(current.itinerary, input.itinerary)) {
      /*
       * The head row stands for the present, so a pin toggled since it was
       * written belongs on it. Updated rather than added: the head's number is
       * the concurrency token a refinement already in flight is holding.
       */
      if (input.refreshDecisions !== false) getDb().prepare('UPDATE refinement_versions SET decisions_json = ? WHERE trip_id = ? AND lane = ? AND version = ?').run(JSON.stringify(readPlanDecisions(input.tripId)), input.tripId, 'canonical', head);
      return head;
    }
  }
  const recorded = recordVersion({
    tripId: input.tripId,
    previousVersion: head,
    summary: { changed: input.changed ? [input.changed] : [], kept: [], rechecking: [] },
    itinerary: input.itinerary,
    draft: input.draft ?? null,
    now: input.now,
  });
  return recorded.version;
}

/**
 * Whether two plans are the same plan.
 *
 * A stored version has been through JSON and the schema; the plan handed in
 * may not have been, so the two can differ in key order and in defaults the
 * schema fills while being the same trip. Both are read through the schema and
 * compared with their keys in one order. A plan the schema will not read is
 * "different" — the cautious answer, which costs a snapshot, never a restore.
 */
function samePlan(stored: Itinerary, candidate: Itinerary): boolean {
  const parsed = itinerarySchema.safeParse(candidate);
  if (!parsed.success) return false;
  return canonicalJson(stored) === canonicalJson(parsed.data);
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return entry;
    const record = entry as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, record[key]]));
  });
}

/**
 * A CHANGE MADE BY HAND IS A VERSION TOO.
 *
 * Moving a stop, adding one of your own, changing a duration, easing or fixing
 * a day: each used to overwrite the stored plan with no way back. Each is now
 * recorded exactly as an Ask Sidequest change is — the plan before it (if the
 * history does not already end there) and the plan after it — so the one Undo
 * the product has restores the state immediately before the traveller's last
 * change, whichever kind of change it was. Nothing is planned, measured or
 * called here: two rows.
 */
export function recordEditVersion(input: { tripId: string; before: Itinerary; after: Itinerary; draft?: TripDraft | null; changed: string; now?: Date }): number {
  /* No refresh: the edit's own side effects (the skip and the unpinned stop) have been written by now, and the row before the edit must not learn them. */
  const head = ensureBaselineVersion({ tripId: input.tripId, itinerary: input.before, draft: input.draft ?? null, refreshDecisions: false, ...(input.now ? { now: input.now } : {}) });
  return recordVersion({
    tripId: input.tripId,
    previousVersion: head,
    summary: { changed: [input.changed], kept: [], rechecking: [] },
    itinerary: input.after,
    draft: input.draft ?? null,
    ...(input.now ? { now: input.now } : {}),
  }).version;
}

/**
 * A whole-trip rebuild is a version, once the trip has a history at all.
 *
 * A trip's very first build records nothing: nothing can be lost yet, and one
 * that is never changed should not pay for a copy of itself. A rebuild always
 * finds a history, because `saveItinerary` wrote the plan it replaced.
 */
export function recordBuiltVersion(input: { tripId: string; itinerary: Itinerary; draft?: TripDraft | null }): void {
  const head = currentVersion(input.tripId);
  if (head === 0) return;
  recordVersion({ tripId: input.tripId, previousVersion: head, summary: { changed: ['Rebuilt your trip'], kept: [], rechecking: [] }, itinerary: input.itinerary, draft: input.draft ?? null });
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
    decisions: safeDecisions(row.decisions_json),
    savedAt: row.saved_at,
  };
}

function safeDecisions(json: string | null): PlanDecisions | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as Partial<PlanDecisions>;
    return Array.isArray(parsed.locks) && Array.isArray(parsed.selections) ? { locks: parsed.locks, selections: parsed.selections } : null;
  } catch {
    return null;
  }
}

/** A version this build can still read. A row written under an older plan schema is history, not an error. */
function readableVersion(tripId: string, version: number): TripVersion | null {
  try {
    return getVersion(tripId, version);
  } catch {
    return null;
  }
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
  return readableVersion(tripId, head - 1);
}

/** What the trip page shows for one version: no plan body, so listing cannot fail on an old row. */
export interface RestorePoint {
  version: number;
  label: string;
  createdAt: string;
  saved: boolean;
  current: boolean;
  dayCount: number;
  startDate: string | null;
  endDate: string | null;
  /** Null when it can be restored; otherwise the sentence saying why not. */
  blocked: string | null;
}

const FALLBACK_LABEL = 'Your plan as it stood';

/**
 * The versions a traveller can go back to, newest first.
 *
 * A row that repeats a newer one (a restore, or a snapshot of the same plan) is
 * not a separate place to go back to, so only the newest of each plan is listed.
 */
export function listRestorePoints(tripId: string, trip: { startDate: string; endDate: string; itineraryVersion: number }): RestorePoint[] {
  const rows = getDb()
    .prepare(
      `SELECT version, summary_json, created_at, saved_at, itinerary_json FROM refinement_versions
       WHERE trip_id = ? AND lane = 'canonical' ORDER BY version DESC LIMIT ?`,
    )
    .all(tripId, VERSIONS_KEPT_PER_TRIP + VERSIONS_SAVED_PER_TRIP) as Pick<VersionRow, 'version' | 'summary_json' | 'created_at' | 'saved_at' | 'itinerary_json'>[];
  const seen = new Set<string>();
  const head = rows[0]?.version ?? 0;
  const points: RestorePoint[] = [];
  for (const row of rows) {
    let plan: { version?: unknown; startDate?: unknown; endDate?: unknown; days?: unknown };
    try {
      plan = JSON.parse(row.itinerary_json) as typeof plan;
    } catch {
      continue;
    }
    const key = canonicalJson(plan);
    if (seen.has(key) && row.saved_at === null) continue;
    seen.add(key);
    const startDate = typeof plan.startDate === 'string' ? plan.startDate : null;
    const endDate = typeof plan.endDate === 'string' ? plan.endDate : null;
    points.push({
      version: row.version,
      label: safeSummary(row.summary_json).changed[0] ?? FALLBACK_LABEL,
      createdAt: row.created_at,
      saved: row.saved_at !== null,
      current: row.version === head,
      dayCount: Array.isArray(plan.days) ? plan.days.length : 0,
      startDate,
      endDate,
      blocked: restoreRefusal({ planVersion: plan.version, startDate, endDate }, trip),
    });
  }
  return points;
}

/** The one rule for whether a stored plan may go back on a trip; the list and the restore both ask it. */
export function restoreRefusal(plan: { planVersion: unknown; startDate: string | null; endDate: string | null }, trip: { startDate: string; endDate: string; itineraryVersion: number }): string | null {
  if (plan.planVersion !== trip.itineraryVersion) return 'Built by an earlier version of Sidequest, so it can no longer be opened.';
  if (plan.startDate !== trip.startDate || plan.endDate !== trip.endDate) return 'This version was for different dates, so it no longer fits this trip.';
  return null;
}

/**
 * Keep or stop keeping a version. A limit the traveller reaches comes back as a
 * sentence to show them, not an error.
 */
export function setVersionSaved(tripId: string, version: number, saved: boolean, now: Date = new Date()): { ok: true } | { ok: false; error: string } {
  const db = getDb();
  if (saved) {
    const row = db.prepare("SELECT COUNT(*) AS count FROM refinement_versions WHERE trip_id = ? AND lane = 'canonical' AND saved_at IS NOT NULL").get(tripId) as { count: number };
    if (row.count >= VERSIONS_SAVED_PER_TRIP) return { ok: false, error: `You can keep up to ${VERSIONS_SAVED_PER_TRIP} versions of a trip. Remove one first.` };
  }
  const result = db.prepare("UPDATE refinement_versions SET saved_at = ? WHERE trip_id = ? AND lane = 'canonical' AND version = ?").run(saved ? now.toISOString() : null, tripId, version);
  return result.changes === 0 ? { ok: false, error: 'That version is no longer here.' } : { ok: true };
}
