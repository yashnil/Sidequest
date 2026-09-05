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


/* ------------------------------------------------------------------ *
 * Composition attempts — the raw answer before any parse
 * ------------------------------------------------------------------ */

export type CompositionParseStatus = 'pending' | 'ok' | 'no_json' | 'structural' | 'semantic' | 'model_failed';

export interface CompositionAttemptRecord {
  id: string;
  tripId: string;
  attempt: number;
  model: string;
  promptVersion: string;
  enforcement: 'grammar' | 'prompt';
  schemaSha256: string;
  stopReason: string | null;
  requestId: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  elapsedMs: number | null;
  /** The visible model text, verbatim. Never thinking, never a secret. */
  rawText: string | null;
  parseStatus: CompositionParseStatus;
  /** Sanitized diagnostics: extraction result, normalization issues (paths, codes, expected/received), fields normalized. */
  parse: unknown;
  draftLinked: boolean;
  createdAt: string;
}

/** Written the moment the provider's answer is in hand — before extraction, normalization or validation. */
export function saveCompositionAttempt(input: Omit<CompositionAttemptRecord, 'parse' | 'draftLinked' | 'createdAt'> & { now?: Date }): void {
  getDb()
    .prepare(
      `INSERT INTO composition_attempts (id, trip_id, attempt, model, prompt_version, enforcement, schema_sha256, stop_reason, request_id, input_tokens, output_tokens, elapsed_ms, raw_text, parse_status, parse_json, normalized_json, draft_linked, created_at)
       VALUES (@id, @tripId, @attempt, @model, @promptVersion, @enforcement, @schemaSha256, @stopReason, @requestId, @inputTokens, @outputTokens, @elapsedMs, @rawText, @parseStatus, NULL, NULL, 0, @createdAt)
       ON CONFLICT(id) DO UPDATE SET stop_reason = excluded.stop_reason, request_id = excluded.request_id, input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens, elapsed_ms = excluded.elapsed_ms, raw_text = excluded.raw_text, parse_status = excluded.parse_status`,
    )
    .run({ ...input, createdAt: (input.now ?? new Date()).toISOString() });
}

/** The parser's verdict on an attempt, recorded whether it succeeded or not. */
export function recordCompositionParse(input: { id: string; parseStatus: CompositionParseStatus; parse: unknown; normalizedFields?: readonly string[]; draftLinked: boolean }): void {
  getDb()
    .prepare(`UPDATE composition_attempts SET parse_status = ?, parse_json = ?, normalized_json = ?, draft_linked = ? WHERE id = ?`)
    .run(input.parseStatus, JSON.stringify(input.parse ?? null), input.normalizedFields ? JSON.stringify(input.normalizedFields) : null, input.draftLinked ? 1 : 0, input.id);
}

export function listCompositionAttempts(tripId: string): CompositionAttemptRecord[] {
  const rows = getDb()
    .prepare(`SELECT * FROM composition_attempts WHERE trip_id = ? ORDER BY created_at DESC`)
    .all(tripId) as Record<string, unknown>[];
  return rows.map((row) => ({
    id: String(row.id),
    tripId: String(row.trip_id),
    attempt: Number(row.attempt),
    model: String(row.model),
    promptVersion: String(row.prompt_version),
    enforcement: row.enforcement === 'grammar' ? 'grammar' : 'prompt',
    schemaSha256: String(row.schema_sha256),
    stopReason: (row.stop_reason as string | null) ?? null,
    requestId: (row.request_id as string | null) ?? null,
    inputTokens: (row.input_tokens as number | null) ?? null,
    outputTokens: (row.output_tokens as number | null) ?? null,
    elapsedMs: (row.elapsed_ms as number | null) ?? null,
    rawText: (row.raw_text as string | null) ?? null,
    parseStatus: row.parse_status as CompositionParseStatus,
    parse: row.parse_json ? JSON.parse(String(row.parse_json)) : null,
    draftLinked: Number(row.draft_linked) === 1,
    createdAt: String(row.created_at),
  }));
}
