import 'server-only';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { factObservationSchema, type BookingResolution, type BookingResolutionKind, type ExtractedConfirmation, type FactObservation, type PersistedDecision } from '@sidequest/core';
import type { LockLevel } from '@sidequest/core';
import { getDb } from './client';

/**
 * V9 — PERSISTENCE FOR TRIP EXECUTION.
 *
 * Only the traveller's acts and Sidequest's observations live here; every
 * state is derived from them at load (`packages/core/src/execution`). Tables:
 *
 *   trip_decisions          a decision somebody made (route, transport, timing, a refinement)
 *   booking_resolutions     a need skipped, replaced or not needed
 *   booking_imports         a confirmation's redacted extraction, until confirmed or discarded
 *   calendar_feeds          private subscription tokens, stored hashed
 *   trip_fact_observations  what a recheck saw change
 *   trip_fact_checks        when a recheck last ran (the throttle)
 *   preference_dismissals   a learned leaning the account told Sidequest to forget
 */

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

interface DecisionRow {
  decision_key: string;
  payload_json: string;
  decided_by: string;
  decided_at: string;
}

export function listDecisions(tripId: string): PersistedDecision[] {
  const rows = getDb().prepare('SELECT decision_key, payload_json, decided_by, decided_at FROM trip_decisions WHERE trip_id = ? ORDER BY decided_at').all(tripId) as DecisionRow[];
  const out: PersistedDecision[] = [];
  for (const row of rows) {
    try {
      const payload = JSON.parse(row.payload_json) as { chosen?: unknown; why?: unknown; alternativesSeen?: unknown; lock?: unknown; scope?: unknown };
      if (typeof payload.chosen !== 'string' || payload.chosen.length === 0) continue;
      out.push({
        key: row.decision_key,
        chosen: payload.chosen,
        ...(typeof payload.why === 'string' ? { why: payload.why } : {}),
        ...(Array.isArray(payload.alternativesSeen) ? { alternativesSeen: payload.alternativesSeen.filter((a): a is string => typeof a === 'string') } : {}),
        lock: (typeof payload.lock === 'string' ? payload.lock : 'user_explicit') as LockLevel,
        decidedBy: row.decided_by === 'sidequest' ? 'sidequest' : 'traveller',
        decidedAt: row.decided_at,
        ...(payload.scope && typeof payload.scope === 'object' ? { scope: payload.scope as PersistedDecision['scope'] } : {}),
      });
    } catch {
      /* an unreadable row is skipped, never fatal */
    }
  }
  return out;
}

export function recordDecision(tripId: string, decision: Omit<PersistedDecision, 'decidedAt'> & { decidedAt?: string }, now: Date = new Date()): PersistedDecision {
  const decidedAt = decision.decidedAt ?? now.toISOString();
  const payload = { chosen: decision.chosen, why: decision.why, alternativesSeen: decision.alternativesSeen ?? [], lock: decision.lock, scope: decision.scope ?? {} };
  getDb()
    .prepare('INSERT INTO trip_decisions (id, trip_id, decision_key, payload_json, decided_by, decided_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(trip_id, decision_key) DO UPDATE SET payload_json = excluded.payload_json, decided_by = excluded.decided_by, decided_at = excluded.decided_at')
    .run(randomUUID(), tripId, decision.key, JSON.stringify(payload), decision.decidedBy, decidedAt);
  return { ...decision, decidedAt };
}

export function clearDecision(tripId: string, key: string): void {
  getDb().prepare('DELETE FROM trip_decisions WHERE trip_id = ? AND decision_key = ?').run(tripId, key);
}

// ---------------------------------------------------------------------------
// Booking resolutions
// ---------------------------------------------------------------------------

export function listBookingResolutions(tripId: string): BookingResolution[] {
  const rows = getDb().prepare('SELECT booking_item_id, resolution, booked_item_id, note FROM booking_resolutions WHERE trip_id = ?').all(tripId) as { booking_item_id: string; resolution: string; booked_item_id: string | null; note: string | null }[];
  return rows
    .filter((r) => r.resolution === 'skipped' || r.resolution === 'replaced' || r.resolution === 'not_needed')
    .map((r) => ({ bookingItemId: r.booking_item_id, resolution: r.resolution as BookingResolutionKind, ...(r.booked_item_id ? { bookedItemId: r.booked_item_id } : {}), ...(r.note ? { note: r.note } : {}) }));
}

export function setBookingResolution(tripId: string, resolution: BookingResolution, now: Date = new Date()): void {
  getDb()
    .prepare('INSERT INTO booking_resolutions (trip_id, booking_item_id, resolution, booked_item_id, note, resolved_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(trip_id, booking_item_id) DO UPDATE SET resolution = excluded.resolution, booked_item_id = excluded.booked_item_id, note = excluded.note, resolved_at = excluded.resolved_at')
    .run(tripId, resolution.bookingItemId, resolution.resolution, resolution.bookedItemId ?? null, resolution.note ?? null, now.toISOString());
}

export function clearBookingResolution(tripId: string, bookingItemId: string): void {
  getDb().prepare('DELETE FROM booking_resolutions WHERE trip_id = ? AND booking_item_id = ?').run(tripId, bookingItemId);
}

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

export type ImportSourceKind = 'text' | 'eml' | 'pdf' | 'image';
export interface BookingImport {
  id: string;
  tripId: string;
  sourceKind: ImportSourceKind;
  extracted: ExtractedConfirmation;
  status: 'pending' | 'confirmed' | 'discarded';
  modelUsed: boolean;
  bookedItemId: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

interface ImportRow {
  id: string;
  trip_id: string;
  source_kind: string;
  extracted_json: string;
  status: string;
  model_used: number;
  booked_item_id: string | null;
  created_at: string;
  resolved_at: string | null;
}

function parseImport(row: ImportRow): BookingImport | null {
  try {
    return {
      id: row.id,
      tripId: row.trip_id,
      sourceKind: row.source_kind as ImportSourceKind,
      extracted: JSON.parse(row.extracted_json) as ExtractedConfirmation,
      status: row.status as BookingImport['status'],
      modelUsed: row.model_used === 1,
      bookedItemId: row.booked_item_id,
      createdAt: row.created_at,
      resolvedAt: row.resolved_at,
    };
  } catch {
    return null;
  }
}

export function recordImport(tripId: string, input: { sourceKind: ImportSourceKind; extracted: ExtractedConfirmation; modelUsed: boolean }, now: Date = new Date()): BookingImport {
  const id = randomUUID();
  getDb().prepare('INSERT INTO booking_imports (id, trip_id, source_kind, extracted_json, status, model_used, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, tripId, input.sourceKind, JSON.stringify(input.extracted), 'pending', input.modelUsed ? 1 : 0, now.toISOString());
  return { id, tripId, sourceKind: input.sourceKind, extracted: input.extracted, status: 'pending', modelUsed: input.modelUsed, bookedItemId: null, createdAt: now.toISOString(), resolvedAt: null };
}

export function getImport(tripId: string, id: string): BookingImport | null {
  const row = getDb().prepare('SELECT * FROM booking_imports WHERE id = ? AND trip_id = ?').get(id, tripId) as ImportRow | undefined;
  return row ? parseImport(row) : null;
}

export function listPendingImports(tripId: string): BookingImport[] {
  const rows = getDb().prepare("SELECT * FROM booking_imports WHERE trip_id = ? AND status = 'pending' ORDER BY created_at DESC").all(tripId) as ImportRow[];
  return rows.map(parseImport).filter((r): r is BookingImport => r !== null);
}

export function resolveImport(tripId: string, id: string, outcome: { status: 'confirmed' | 'discarded'; bookedItemId?: string }, now: Date = new Date()): void {
  getDb().prepare('UPDATE booking_imports SET status = ?, booked_item_id = ?, resolved_at = ? WHERE id = ? AND trip_id = ?').run(outcome.status, outcome.bookedItemId ?? null, now.toISOString(), id, tripId);
}

/** A confirmed or discarded import's extraction is not needed after a month; the row stays as a record. */
export function purgeResolvedImports(tripId: string, before: Date): number {
  return getDb().prepare("UPDATE booking_imports SET extracted_json = '{}' WHERE trip_id = ? AND status != 'pending' AND resolved_at < ? AND extracted_json != '{}'").run(tripId, before.toISOString()).changes;
}

// ---------------------------------------------------------------------------
// Calendar feeds
// ---------------------------------------------------------------------------

export function hashFeedToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Mint a feed token. The plaintext is returned once and never stored. Any earlier live feed for the trip is revoked. */
export function createCalendarFeed(tripId: string, now: Date = new Date()): { token: string; id: string } {
  const token = randomBytes(32).toString('base64url');
  const id = randomUUID();
  const db = getDb();
  db.transaction(() => {
    db.prepare('UPDATE calendar_feeds SET revoked_at = ? WHERE trip_id = ? AND revoked_at IS NULL').run(now.toISOString(), tripId);
    db.prepare('INSERT INTO calendar_feeds (id, trip_id, token_hash, created_at) VALUES (?, ?, ?, ?)').run(id, tripId, hashFeedToken(token), now.toISOString());
  })();
  return { token, id };
}

export function activeCalendarFeed(tripId: string): { id: string; createdAt: string; lastServedAt: string | null } | null {
  const row = getDb().prepare('SELECT id, created_at, last_served_at FROM calendar_feeds WHERE trip_id = ? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1').get(tripId) as { id: string; created_at: string; last_served_at: string | null } | undefined;
  return row ? { id: row.id, createdAt: row.created_at, lastServedAt: row.last_served_at } : null;
}

export function revokeCalendarFeeds(tripId: string, now: Date = new Date()): number {
  return getDb().prepare('UPDATE calendar_feeds SET revoked_at = ? WHERE trip_id = ? AND revoked_at IS NULL').run(now.toISOString(), tripId).changes;
}

/** The trip a feed token opens, or null. Revoked tokens and empty strings resolve to nothing. */
export function tripForFeedToken(token: string, now: Date = new Date()): string | null {
  if (!token || token.length < 32) return null;
  const row = getDb().prepare('SELECT id, trip_id FROM calendar_feeds WHERE token_hash = ? AND revoked_at IS NULL').get(hashFeedToken(token)) as { id: string; trip_id: string } | undefined;
  if (!row) return null;
  getDb().prepare('UPDATE calendar_feeds SET last_served_at = ? WHERE id = ?').run(now.toISOString(), row.id);
  return row.trip_id;
}

// ---------------------------------------------------------------------------
// Fact observations and the recheck throttle
// ---------------------------------------------------------------------------

interface ObservationRow {
  id: string;
  fact_id: string;
  kind: string;
  observed_at: string;
  previous_json: string | null;
  current_json: string | null;
  changed: number;
  day_numbers: string;
  summary: string;
  acknowledged_at: string | null;
}

export function listObservations(tripId: string, limit = 50): FactObservation[] {
  const rows = getDb().prepare('SELECT * FROM trip_fact_observations WHERE trip_id = ? ORDER BY observed_at DESC LIMIT ?').all(tripId, limit) as ObservationRow[];
  const out: FactObservation[] = [];
  for (const row of rows) {
    const parsed = factObservationSchema.safeParse({
      id: row.id,
      factId: row.fact_id,
      kind: row.kind,
      observedAt: row.observed_at,
      previous: row.previous_json ? (JSON.parse(row.previous_json) as string | null) : null,
      current: row.current_json ? (JSON.parse(row.current_json) as string | null) : null,
      changed: row.changed === 1,
      dayNumbers: JSON.parse(row.day_numbers) as number[],
      summary: row.summary,
      acknowledgedAt: row.acknowledged_at,
    });
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

export function recordObservations(tripId: string, observations: readonly Omit<FactObservation, 'id' | 'acknowledgedAt'>[]): FactObservation[] {
  const db = getDb();
  const insert = db.prepare('INSERT INTO trip_fact_observations (id, trip_id, fact_id, kind, observed_at, previous_json, current_json, changed, day_numbers, summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const written: FactObservation[] = [];
  db.transaction(() => {
    for (const o of observations) {
      const id = randomUUID();
      /* A newer unchanged reading of a fact supersedes an older changed one only when acknowledged; a repeated "changed" for the same fact is not written twice. */
      const open = db.prepare('SELECT id FROM trip_fact_observations WHERE trip_id = ? AND fact_id = ? AND changed = 1 AND acknowledged_at IS NULL').get(tripId, o.factId) as { id: string } | undefined;
      if (open && o.changed) continue;
      insert.run(id, tripId, o.factId, o.kind, o.observedAt, JSON.stringify(o.previous), JSON.stringify(o.current), o.changed ? 1 : 0, JSON.stringify(o.dayNumbers), o.summary);
      written.push({ ...o, id, acknowledgedAt: null });
    }
  })();
  return written;
}

export function acknowledgeObservation(tripId: string, id: string, now: Date = new Date()): void {
  getDb().prepare('UPDATE trip_fact_observations SET acknowledged_at = ? WHERE id = ? AND trip_id = ?').run(now.toISOString(), id, tripId);
}

export function acknowledgeAllObservations(tripId: string, now: Date = new Date()): number {
  return getDb().prepare('UPDATE trip_fact_observations SET acknowledged_at = ? WHERE trip_id = ? AND acknowledged_at IS NULL').run(now.toISOString(), tripId).changes;
}

export function lastFactCheck(tripId: string): { checkedAt: string; outcome: Record<string, unknown> } | null {
  const row = getDb().prepare('SELECT checked_at, outcome_json FROM trip_fact_checks WHERE trip_id = ?').get(tripId) as { checked_at: string; outcome_json: string } | undefined;
  if (!row) return null;
  try {
    return { checkedAt: row.checked_at, outcome: JSON.parse(row.outcome_json) as Record<string, unknown> };
  } catch {
    return { checkedAt: row.checked_at, outcome: {} };
  }
}

export function recordFactCheck(tripId: string, outcome: Record<string, unknown>, now: Date = new Date()): void {
  getDb().prepare('INSERT INTO trip_fact_checks (trip_id, checked_at, outcome_json) VALUES (?, ?, ?) ON CONFLICT(trip_id) DO UPDATE SET checked_at = excluded.checked_at, outcome_json = excluded.outcome_json').run(tripId, now.toISOString(), JSON.stringify(outcome));
}

// ---------------------------------------------------------------------------
// Preference dismissals
// ---------------------------------------------------------------------------

export function listDismissedFeatures(userId: string): string[] {
  return (getDb().prepare('SELECT feature FROM preference_dismissals WHERE user_id = ?').all(userId) as { feature: string }[]).map((r) => r.feature);
}

export function dismissFeature(userId: string, feature: string, now: Date = new Date()): void {
  getDb().prepare('INSERT INTO preference_dismissals (user_id, feature, dismissed_at) VALUES (?, ?, ?) ON CONFLICT(user_id, feature) DO UPDATE SET dismissed_at = excluded.dismissed_at').run(userId, feature, now.toISOString());
}

export function restoreFeature(userId: string, feature: string): void {
  getDb().prepare('DELETE FROM preference_dismissals WHERE user_id = ? AND feature = ?').run(userId, feature);
}
