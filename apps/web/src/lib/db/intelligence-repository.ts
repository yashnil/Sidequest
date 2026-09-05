import 'server-only';
import { randomUUID } from 'node:crypto';
import {
  fxRateSchema,
  type FxRate,
  bookedPlanItemSchema,
  travelIntelligenceSchema,
  travelReadinessProfileSchema,
  type BookedPlanItem,
  type BookedPlanItemInput,
  type TravelIntelligence,
  type TravelReadinessProfile,
} from '@sidequest/core';
import { getDb } from './client';

/**
 * PERSISTENCE FOR THE INTELLIGENCE LAYER.
 *
 * Four trip-scoped tables, created lazily like `itinerary_locks` so they are
 * safe against an existing database:
 *
 *   booked_plan_items   what the traveller has actually arranged (facts)
 *   readiness_profiles  the minimal, private travel-document profile
 *   trip_checks         ticked items on the packing and before-you-go lists
 *   trip_intelligence   the persisted TravelIntelligence snapshot
 *
 * Confirmation references are stored because the traveller typed them and
 * wants them back; they are never logged and never exported.
 */
function ensureTables(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS booked_plan_items (
      id TEXT PRIMARY KEY,
      trip_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS booked_plan_items_trip ON booked_plan_items(trip_id);
    CREATE TABLE IF NOT EXISTS readiness_profiles (
      trip_id TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS trip_checks (
      trip_id TEXT NOT NULL,
      list TEXT NOT NULL,
      item_id TEXT NOT NULL,
      checked_at TEXT NOT NULL,
      PRIMARY KEY (trip_id, list, item_id)
    );
    CREATE TABLE IF NOT EXISTS trip_intelligence (
      trip_id TEXT PRIMARY KEY,
      fingerprint TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      built_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS trip_fx_rates (
      trip_id TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL,
      fetched_at TEXT NOT NULL
    );
  `);
}

// ---------------------------------------------------------------------------
// FX reference rates — fetched once at plan time, read on every render
// ---------------------------------------------------------------------------

export function saveFxRate(tripId: string, rate: FxRate, now: Date = new Date()): void {
  ensureTables();
  getDb().prepare('INSERT OR REPLACE INTO trip_fx_rates (trip_id, payload_json, fetched_at) VALUES (?, ?, ?)').run(tripId, JSON.stringify(rate), now.toISOString());
}

export function getFxRate(tripId: string): FxRate | null {
  ensureTables();
  const row = getDb().prepare('SELECT payload_json FROM trip_fx_rates WHERE trip_id = ?').get(tripId) as { payload_json: string } | undefined;
  if (!row) return null;
  const parsed = fxRateSchema.safeParse(JSON.parse(row.payload_json));
  return parsed.success ? parsed.data : null;
}

// ---------------------------------------------------------------------------
// Booked plan items
// ---------------------------------------------------------------------------

export function listBookedItems(tripId: string): BookedPlanItem[] {
  ensureTables();
  const rows = getDb().prepare('SELECT payload_json FROM booked_plan_items WHERE trip_id = ? ORDER BY created_at').all(tripId) as { payload_json: string }[];
  const items: BookedPlanItem[] = [];
  for (const row of rows) {
    const parsed = bookedPlanItemSchema.safeParse(JSON.parse(row.payload_json));
    if (parsed.success) items.push(parsed.data);
  }
  return items.sort((a, b) => (a.date ?? '').localeCompare(b.date ?? '') || (a.startTime ?? '').localeCompare(b.startTime ?? ''));
}

export function addBookedItem(tripId: string, input: BookedPlanItemInput, now: Date = new Date()): BookedPlanItem {
  ensureTables();
  const item = bookedPlanItemSchema.parse({ ...input, id: randomUUID(), tripId, createdAt: now.toISOString() });
  getDb().prepare('INSERT INTO booked_plan_items (id, trip_id, payload_json, created_at) VALUES (?, ?, ?, ?)').run(item.id, tripId, JSON.stringify(item), item.createdAt);
  return item;
}

export function updateBookedItem(tripId: string, id: string, patch: Partial<BookedPlanItemInput>): BookedPlanItem | null {
  ensureTables();
  const current = listBookedItems(tripId).find((b) => b.id === id);
  if (!current) return null;
  const next = bookedPlanItemSchema.parse({ ...current, ...patch, id, tripId });
  getDb().prepare('UPDATE booked_plan_items SET payload_json = ? WHERE id = ? AND trip_id = ?').run(JSON.stringify(next), id, tripId);
  return next;
}

export function removeBookedItem(tripId: string, id: string): void {
  ensureTables();
  getDb().prepare('DELETE FROM booked_plan_items WHERE id = ? AND trip_id = ?').run(id, tripId);
}

// ---------------------------------------------------------------------------
// Readiness profile
// ---------------------------------------------------------------------------

export function getReadinessProfile(tripId: string): TravelReadinessProfile | null {
  ensureTables();
  const row = getDb().prepare('SELECT payload_json FROM readiness_profiles WHERE trip_id = ?').get(tripId) as { payload_json: string } | undefined;
  if (!row) return null;
  const parsed = travelReadinessProfileSchema.safeParse(JSON.parse(row.payload_json));
  return parsed.success ? parsed.data : null;
}

export function saveReadinessProfile(tripId: string, profile: TravelReadinessProfile, now: Date = new Date()): TravelReadinessProfile {
  ensureTables();
  const parsed = travelReadinessProfileSchema.parse({ ...profile, updatedAt: now.toISOString() });
  getDb()
    .prepare('INSERT INTO readiness_profiles (trip_id, payload_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(trip_id) DO UPDATE SET payload_json = excluded.payload_json, updated_at = excluded.updated_at')
    .run(tripId, JSON.stringify(parsed), parsed.updatedAt);
  return parsed;
}

export function clearReadinessProfile(tripId: string): void {
  ensureTables();
  getDb().prepare('DELETE FROM readiness_profiles WHERE trip_id = ?').run(tripId);
}

// ---------------------------------------------------------------------------
// Checks (packing, before-you-go)
// ---------------------------------------------------------------------------

export type CheckList = 'packing' | 'checklist';

export function listChecks(tripId: string): Record<CheckList, string[]> {
  ensureTables();
  const rows = getDb().prepare('SELECT list, item_id FROM trip_checks WHERE trip_id = ?').all(tripId) as { list: CheckList; item_id: string }[];
  const out: Record<CheckList, string[]> = { packing: [], checklist: [] };
  for (const row of rows) (out[row.list] ?? (out[row.list] = [])).push(row.item_id);
  return out;
}

export function setCheck(tripId: string, list: CheckList, itemId: string, checked: boolean, now: Date = new Date()): void {
  ensureTables();
  if (checked) getDb().prepare('INSERT INTO trip_checks (trip_id, list, item_id, checked_at) VALUES (?, ?, ?, ?) ON CONFLICT(trip_id, list, item_id) DO UPDATE SET checked_at = excluded.checked_at').run(tripId, list, itemId, now.toISOString());
  else getDb().prepare('DELETE FROM trip_checks WHERE trip_id = ? AND list = ? AND item_id = ?').run(tripId, list, itemId);
}

// ---------------------------------------------------------------------------
// Draft hints
// ---------------------------------------------------------------------------

/**
 * The model's transport hints, read straight from the stored draft JSON.
 *
 * Deliberately not through `draft-repository`, whose schema module sits in
 * the same import graph as the composing model; the render path may not
 * reach anything that can call a provider. Only names and hints are read.
 */
export function getDraftHints(tripId: string): { days: { anchors: { name: string; transport?: string }[] }[] } | null {
  const row = getDb().prepare('SELECT draft_json FROM trip_drafts WHERE trip_id = ?').get(tripId) as { draft_json: string } | undefined;
  if (!row) return null;
  try {
    const raw = JSON.parse(row.draft_json) as { days?: { anchors?: { name?: unknown; transport?: unknown }[] }[] };
    if (!Array.isArray(raw.days)) return null;
    return {
      days: raw.days.map((day) => ({
        anchors: (Array.isArray(day.anchors) ? day.anchors : [])
          .filter((a) => typeof a.name === 'string' && a.name.length > 0)
          .map((a) => ({ name: a.name as string, ...(typeof a.transport === 'string' ? { transport: a.transport } : {}) })),
      })),
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Intelligence snapshot
// ---------------------------------------------------------------------------

export function saveTravelIntelligence(intel: TravelIntelligence): void {
  ensureTables();
  const parsed = travelIntelligenceSchema.parse(intel);
  getDb()
    .prepare('INSERT INTO trip_intelligence (trip_id, fingerprint, payload_json, built_at) VALUES (?, ?, ?, ?) ON CONFLICT(trip_id) DO UPDATE SET fingerprint = excluded.fingerprint, payload_json = excluded.payload_json, built_at = excluded.built_at')
    .run(parsed.tripId, parsed.itineraryFingerprint, JSON.stringify(parsed), parsed.builtAt);
}

export function getTravelIntelligence(tripId: string): TravelIntelligence | null {
  ensureTables();
  const row = getDb().prepare('SELECT payload_json FROM trip_intelligence WHERE trip_id = ?').get(tripId) as { payload_json: string } | undefined;
  if (!row) return null;
  const parsed = travelIntelligenceSchema.safeParse(JSON.parse(row.payload_json));
  return parsed.success ? parsed.data : null;
}

export function clearTravelIntelligence(tripId: string): void {
  ensureTables();
  getDb().prepare('DELETE FROM trip_intelligence WHERE trip_id = ?').run(tripId);
}
