import 'server-only';
import { getDb } from './client';
import { tripDraftSchema, TRIP_DRAFT_SCHEMA_VERSION, type TripDraft } from '@/lib/planning/trip-draft';

/**
 * The raw model draft, persisted the moment composition returns.
 *
 * Written *before* verification, routing or reconciliation run, so a failure
 * anywhere downstream never costs a second model call to recover what the
 * model actually said — the one diagnostic that was lost, repeatedly, during
 * the live Iceland rounds. One row per trip; a regeneration replaces it.
 */
export interface StoredTripDraft {
  tripId: string;
  draft: TripDraft;
  /** The model call's own diagnostic (tokens, timing, stop reason), never prose or reasoning. */
  modelCall: unknown | null;
  createdAt: string;
}

export function saveTripDraft(input: { tripId: string; draft: TripDraft; modelCall?: unknown; now?: Date }): void {
  const draft = tripDraftSchema.parse(input.draft);
  getDb()
    .prepare(
      `INSERT INTO trip_drafts (trip_id, draft_version, draft_json, model_json, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(trip_id) DO UPDATE SET draft_version = excluded.draft_version, draft_json = excluded.draft_json,
         model_json = excluded.model_json, created_at = excluded.created_at`,
    )
    .run(input.tripId, TRIP_DRAFT_SCHEMA_VERSION, JSON.stringify(draft), input.modelCall === undefined ? null : JSON.stringify(input.modelCall), (input.now ?? new Date()).toISOString());
}

export function getTripDraft(tripId: string): StoredTripDraft | null {
  const row = getDb().prepare('SELECT trip_id, draft_json, model_json, created_at FROM trip_drafts WHERE trip_id = ?').get(tripId) as
    | { trip_id: string; draft_json: string; model_json: string | null; created_at: string }
    | undefined;
  if (!row) return null;
  const parsed = tripDraftSchema.safeParse(JSON.parse(row.draft_json));
  if (!parsed.success) return null;
  return { tripId: row.trip_id, draft: parsed.data, modelCall: row.model_json ? JSON.parse(row.model_json) : null, createdAt: row.created_at };
}
