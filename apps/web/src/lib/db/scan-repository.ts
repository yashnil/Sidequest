import 'server-only';
import { randomBytes } from 'node:crypto';
import { getDb } from './client';
import { saveSelectedCompiledRegion } from './compiler-repository';
import type { CompiledRegion } from '@sidequest/core';

/**
 * V1 CONVERGENCE — THE DURABLE RECORD OF A DISCOVERY SCAN.
 *
 * One row per trip, the latest scan. The stages advance at real boundaries in
 * `discovery-scan/run.ts`; counters are things the scan actually counted. A
 * scan whose heartbeat stopped (the process died) reads as `lost` after
 * `SCAN_STALE_MS`, never as forever-running.
 */

export const SCAN_STAGES = ['proposing', 'placing', 'timing', 'assembling', 'done'] as const;
export type ScanStage = (typeof SCAN_STAGES)[number];

export const SCAN_STAGE_LABELS: Record<ScanStage, string> = {
  proposing: 'Looking for what fits you',
  placing: 'Finding each place on the map',
  timing: 'Timing the distances between them',
  assembling: 'Building your board',
  done: 'Ready',
};

export type ScanState = 'running' | 'ready' | 'failed';

export interface ScanCounters {
  proposed?: number;
  bases?: number;
  placed?: number;
  unplaced?: number;
  timed?: number;
  measured?: boolean;
}

export interface ScanView {
  state: ScanState | 'lost' | 'none';
  scanId: string | null;
  stage: ScanStage | null;
  counters: ScanCounters;
  autoBuild: boolean;
  failureKind: string | null;
  failureRef: string | null;
  compiledRegionId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

/** A heartbeat older than this means the process running the scan is gone. */
export const SCAN_STALE_MS = 90_000;

interface Row {
  trip_id: string;
  scan_id: string;
  state: ScanState;
  stage: ScanStage;
  counters_json: string;
  auto_build: number;
  failure_kind: string | null;
  failure_ref: string | null;
  compiled_region_id: string | null;
  started_at: string;
  heartbeat_at: string;
  finished_at: string | null;
}

export function beginScan(tripId: string, now: Date, options: { autoBuild: boolean }): { scanId: string } {
  const scanId = randomBytes(8).toString('hex');
  const at = now.toISOString();
  getDb()
    .prepare(
      `INSERT INTO discovery_scans (trip_id, scan_id, state, stage, counters_json, auto_build, failure_kind, failure_ref, compiled_region_id, started_at, heartbeat_at, finished_at)
       VALUES (?, ?, 'running', 'proposing', '{}', ?, NULL, NULL, NULL, ?, ?, NULL)
       ON CONFLICT(trip_id) DO UPDATE SET scan_id = excluded.scan_id, state = 'running', stage = 'proposing', counters_json = '{}',
         auto_build = excluded.auto_build, failure_kind = NULL, failure_ref = NULL, compiled_region_id = NULL,
         started_at = excluded.started_at, heartbeat_at = excluded.heartbeat_at, finished_at = NULL`,
    )
    .run(tripId, scanId, options.autoBuild ? 1 : 0, at, at);
  return { scanId };
}

function forScan(tripId: string, scanId: string): Row | undefined {
  return getDb().prepare('SELECT * FROM discovery_scans WHERE trip_id = ? AND scan_id = ?').get(tripId, scanId) as Row | undefined;
}

export function markScanStage(tripId: string, scanId: string, stage: ScanStage, now: Date): void {
  getDb().prepare(`UPDATE discovery_scans SET stage = ?, heartbeat_at = ? WHERE trip_id = ? AND scan_id = ? AND state = 'running'`).run(stage, now.toISOString(), tripId, scanId);
}

export function noteScanCounters(tripId: string, scanId: string, counters: ScanCounters, now: Date): void {
  const row = forScan(tripId, scanId);
  if (!row || row.state !== 'running') return;
  const merged = { ...(JSON.parse(row.counters_json) as ScanCounters), ...counters };
  getDb().prepare('UPDATE discovery_scans SET counters_json = ?, heartbeat_at = ? WHERE trip_id = ? AND scan_id = ?').run(JSON.stringify(merged), now.toISOString(), tripId, scanId);
}

export function heartbeatScan(tripId: string, scanId: string, now: Date): void {
  getDb().prepare(`UPDATE discovery_scans SET heartbeat_at = ? WHERE trip_id = ? AND scan_id = ? AND state = 'running'`).run(now.toISOString(), tripId, scanId);
}

export function failScan(tripId: string, scanId: string, kind: string, now: Date): string {
  const ref = randomBytes(4).toString('hex');
  getDb()
    .prepare(`UPDATE discovery_scans SET state = 'failed', failure_kind = ?, failure_ref = ?, finished_at = ?, heartbeat_at = ? WHERE trip_id = ? AND scan_id = ?`)
    .run(kind, ref, now.toISOString(), now.toISOString(), tripId, scanId);
  return ref;
}

/**
 * The artifact, written and adopted in one transaction with the scan's
 * completion, so a reader never sees a ready scan without its region or a
 * region adopted by a scan that says it is still running.
 */
export function completeScan(tripId: string, scanId: string, region: CompiledRegion, now: Date): void {
  const db = getDb();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO compiled_regions (id, trip_id, scope_fingerprint, schema_version, compiler_version, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET payload_json = excluded.payload_json, scope_fingerprint = excluded.scope_fingerprint, created_at = excluded.created_at`,
    ).run(region.id, tripId, region.scopeFingerprint, region.schemaVersion, region.compilerVersion, JSON.stringify(region), now.toISOString());
    saveSelectedCompiledRegion(tripId, region.id);
    db.prepare(`UPDATE discovery_scans SET state = 'ready', stage = 'done', compiled_region_id = ?, finished_at = ?, heartbeat_at = ? WHERE trip_id = ? AND scan_id = ?`).run(
      region.id,
      now.toISOString(),
      now.toISOString(),
      tripId,
      scanId,
    );
  })();
}

export function scanView(tripId: string, now: Date = new Date()): ScanView {
  const row = getDb().prepare('SELECT * FROM discovery_scans WHERE trip_id = ?').get(tripId) as Row | undefined;
  if (!row) {
    return { state: 'none', scanId: null, stage: null, counters: {}, autoBuild: false, failureKind: null, failureRef: null, compiledRegionId: null, startedAt: null, finishedAt: null };
  }
  const stale = row.state === 'running' && now.getTime() - Date.parse(row.heartbeat_at) > SCAN_STALE_MS;
  const counters: ScanCounters = (() => {
    try {
      return JSON.parse(row.counters_json) as ScanCounters;
    } catch {
      return {};
    }
  })();
  return {
    state: stale ? 'lost' : row.state,
    scanId: row.scan_id,
    stage: row.stage,
    counters,
    autoBuild: row.auto_build === 1,
    failureKind: row.failure_kind,
    failureRef: row.failure_ref,
    compiledRegionId: row.compiled_region_id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

/** Consumed once: the auto-build flag is cleared when the build it asked for is started. */
export function clearScanAutoBuild(tripId: string): void {
  getDb().prepare('UPDATE discovery_scans SET auto_build = 0 WHERE trip_id = ?').run(tripId);
}

/** What the scan proposed that is not a place to plan: food areas, classics left out on purpose, the practical package. */
export interface ScanProposalExtras {
  foodAreas: { name: string; locality: string; specialty: string; why: string }[];
  skipped: { name: string; reason: string }[];
  package: { transportSummary: string; transportNotes: string[]; beforeYouGo: string[]; packing: string[]; foodStrategy: string[]; bookingPriorities: string[] };
  /** V1 — the scan's own account of itself. Developer-facing; no traveller screen reads it. */
  diagnostics?: ScanDiagnostics;
}

/** What a scan proposed, what it could not place and why, and whether it recovered — enough to explain a thin scan without rerunning it. */
export interface ScanDiagnostics {
  proposal: { returned: number; kept: number; dropped: { name: string; reason: string }[]; stopReason: string | null; outputTokens: number | null };
  envelope: { scale: string | null; reachKm: number; center: { lat: number; lng: number } };
  placement: {
    attempted: number;
    unplaced: { name: string; locality: string; category: string; isBase: boolean; outcome: string; attempts: { provider: string; query: string; outcome: string }[] }[];
  };
  /** Placed, but not usable as a point: only the town placed, or the same place as another proposal. */
  assembly: { name: string; code: string }[];
  /** Private alpha — area-only candidates that got a bounded access-point search, and what it found. */
  accessRecovery?: { name: string; originalOutcome: string; attempted: boolean; queries: { provider: string; query: string; outcome: string }[]; outcome: string; accessPoint?: { kind: string; provider: string; coordinates: { lat: number; lng: number } } }[];
  recovery: {
    attempted: boolean;
    reasons: string[];
    before: { have: number; needed: number; kinds: number };
    after?: { have: number; needed: number; kinds: number };
    /** `added` | `none_new` | `model_unavailable` | `allowance_used` | `model_failed` | `invalid_response`. */
    outcome?: string;
    added?: number;
  };
}

export function saveScanProposalExtras(tripId: string, extras: ScanProposalExtras): void {
  getDb().prepare('UPDATE discovery_scans SET extras_json = ? WHERE trip_id = ?').run(JSON.stringify(extras), tripId);
}

export function getScanProposalExtras(tripId: string): ScanProposalExtras | null {
  const row = getDb().prepare('SELECT extras_json FROM discovery_scans WHERE trip_id = ?').get(tripId) as { extras_json: string | null } | undefined;
  if (!row?.extras_json) return null;
  try {
    return JSON.parse(row.extras_json) as ScanProposalExtras;
  } catch {
    return null;
  }
}
