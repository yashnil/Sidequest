import { z } from 'zod';

/**
 * V10 §16 — THE QUALITY COMPILER'S REPORT.
 *
 * The shape only, so `schemas/itinerary.ts` can persist it without importing the
 * compiler that produces it (which reads an `Itinerary` and would close the
 * cycle). The compiler itself lives beside the deterministic audit, in the web
 * app's planning layer, for the same reason `quality-audit.ts` does: it reads
 * the reconciled plan.
 *
 * The compiler differs from the audit in exactly one respect, and it is the
 * respect §16 asks for: the audit *reports*, and the compiler **may correct**
 * what is safely derivable — a day's stop order before the legs are built, a
 * claim about the route that the route contradicts, a stated precision the
 * measurements do not carry. Everything else it leaves exactly as the model
 * composed it and exposes as a precise issue. No repair model, no second call.
 */

export const QUALITY_COMPILER_CHECKS = [
  /** §7 — every day's order is geographically coherent, or says why it cannot be judged. */
  'route_order_coherent',
  /** §6 — the route-critical legs are measured, and no stated precision outruns them. */
  'route_completeness',
  /** §2 — no sentence gives a currency, a visa rule or a driving rule to a region instead of a jurisdiction. */
  'jurisdiction_language',
  /** §8 — arrival and departure both work, with their real overheads. */
  'gateway_feasible',
  /** §9 §22 — a required shuttle, ferry, permit or guide is represented as a dependency, never as generic car travel. */
  'access_requirements_represented',
  /** §9 §22 — nothing known to be closed is scheduled as an ordinary stop. */
  'no_closed_stop',
  /** §16 — a sunrise or sunset stop is at that hour. */
  'time_of_day_respected',
  /** §10 — the plan's dates are ones the destination's things are actually reachable in, or say they may not be. */
  'seasonal_feasibility',
  /** §4 §22 — one connected experience is counted once. */
  'no_duplicate_experience',
  /** §16 — a day's content and travel fit the day. */
  'day_duration_plausible',
  /** §7 — no claim that the route does not double back unless it does not. */
  'no_backtracking_claim',
  /** §13 — a boat tour, gondola or trail segment is never a leg between two stops. */
  'transport_semantics',
  /** §11 §12 — the experiences the trip is built around are worth building it around. */
  'signature_quality',
  /** §5 — every route-critical name is on the map. */
  'route_critical_placed',
  /** §2 §22 — a destination region has not become its containing country. */
  'destination_not_country',
  /**
   * V12 §24 §26 — a stop is planned on a day its own calendar supports.
   *
   * A weekly market, a seasonal ferry, a permit window. The V11 live Kyrgyzstan
   * build put a Sunday market on a Sunday and nothing checked it — the model
   * happened to be right, which is not the same as the plan being verified.
   */
  'date_specific_calendar',
] as const;
export const qualityCompilerCheckSchema = z.enum(QUALITY_COMPILER_CHECKS);
export type QualityCompilerCheck = z.infer<typeof qualityCompilerCheckSchema>;

export const qualityCompilerIssueSchema = z.object({
  check: qualityCompilerCheckSchema,
  severity: z.enum(['blocker', 'issue', 'caution']),
  dayNumber: z.number().int().min(1).optional(),
  /** Precise, for an operator. Names fields and figures. */
  detail: z.string().min(1).max(400),
  /** What a traveller reads. No vocabulary, no field names (§19). Absent when the issue is not the traveller's business. */
  travellerNote: z.string().min(1).max(240).optional(),
  /** Set when the compiler fixed it deterministically rather than only naming it. */
  corrected: z.boolean().default(false),
});
export type QualityCompilerIssue = z.infer<typeof qualityCompilerIssueSchema>;

export const QUALITY_COMPILER_VERSION = 1 as const;

export const qualityCompilerReportSchema = z.object({
  version: z.literal(QUALITY_COMPILER_VERSION),
  /** False when any issue is a blocker: the plan stands, but it is not "Ready". */
  passed: z.boolean(),
  /** Checks that ran and found nothing, so a green check is evidence rather than an absence. */
  clean: z.array(qualityCompilerCheckSchema).default([]),
  issues: z.array(qualityCompilerIssueSchema).max(120).default([]),
  /** Checks the compiler could not run, and why — an unrun check is never a pass. */
  skipped: z.array(z.object({ check: qualityCompilerCheckSchema, reason: z.string().min(1).max(200) })).default([]),
});
export type QualityCompilerReport = z.infer<typeof qualityCompilerReportSchema>;

/** §22 — blockers are the PASS standard's own list. A blocker means the plan may not claim to be ready. */
export function compilerBlockers(report: QualityCompilerReport): readonly QualityCompilerIssue[] {
  return report.issues.filter((issue) => issue.severity === 'blocker');
}
