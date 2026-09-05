import 'server-only';
import { benchmarkPlanSchema, type BenchmarkPlan, type BenchReport, type RunMetrics } from '@sidequest/bench';
import { getDb } from './client';

/**
 * PERSISTENCE FOR THE PHASE 17 HYBRID PLAN.
 *
 * One row per trip, replaced wholesale on rebuild — the same contract
 * `saveItinerary` holds for the deterministic plan. Kept in its own table
 * rather than reusing the benchmark repository: that store's rows are keyed to
 * a benchmark session and a blind assignment, neither of which exists for an
 * ordinary trip, and borrowing it would mean either inventing a fake session
 * per trip or weakening the constraints that make blinding correct.
 */

interface HybridPlanRow {
  trip_id: string;
  plan_json: string;
  metrics_json: string;
  report_json: string | null;
  created_at: string;
  updated_at: string;
}

export interface StoredHybridPlan {
  tripId: string;
  plan: BenchmarkPlan;
  metrics: RunMetrics;
  report: BenchReport | null;
  createdAt: string;
  updatedAt: string;
}

export function saveHybridPlan(input: {
  tripId: string;
  plan: BenchmarkPlan;
  metrics: RunMetrics;
  report: BenchReport | null;
  now: Date;
}): void {
  const now = input.now.toISOString();
  getDb()
    .prepare(
      `INSERT INTO hybrid_plans (trip_id, plan_json, metrics_json, report_json, created_at, updated_at)
       VALUES (@tripId, @planJson, @metricsJson, @reportJson, @now, @now)
       ON CONFLICT(trip_id) DO UPDATE SET
         plan_json = excluded.plan_json,
         metrics_json = excluded.metrics_json,
         report_json = excluded.report_json,
         updated_at = excluded.updated_at`,
    )
    .run({
      tripId: input.tripId,
      planJson: JSON.stringify(input.plan),
      metricsJson: JSON.stringify(input.metrics),
      reportJson: input.report ? JSON.stringify(input.report) : null,
      now,
    });
}

export function getHybridPlan(tripId: string): StoredHybridPlan | null {
  const row = getDb()
    .prepare('SELECT * FROM hybrid_plans WHERE trip_id = ?')
    .get(tripId) as HybridPlanRow | undefined;
  if (!row) return null;

  const parsed = benchmarkPlanSchema.safeParse(JSON.parse(row.plan_json));
  if (!parsed.success) return null;

  return {
    tripId: row.trip_id,
    plan: parsed.data,
    metrics: JSON.parse(row.metrics_json) as RunMetrics,
    report: row.report_json ? (JSON.parse(row.report_json) as BenchReport) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function deleteHybridPlan(tripId: string): void {
  getDb().prepare('DELETE FROM hybrid_plans WHERE trip_id = ?').run(tripId);
}
