import { z } from 'zod';

/**
 * NEUTRAL VALIDATION FINDINGS.
 *
 * Five severities, and the fifth is the point of the file.
 *
 * The production validator has three — error, warning, info — and works around
 * the absence of a fourth by minting *codes* that mean "we could not tell"
 * (`operating_hours_unknown`, `weather_unavailable`, `dietary_support_unverified`)
 * and giving them `warning`. That collapse is fine inside one system, whose
 * evidence discipline is uniform. Across two systems it is fatal: a plan that is
 * *wrong* and a plan that is merely *unverifiable* would score the same, and the
 * system that emits less evidence would be penalised for a shape it never agreed
 * to rather than for a trip that does not work.
 *
 * So `unknown` is a severity, it carries a required reason, and it never counts
 * as a defect anywhere. It counts instead toward `verifiability` — which is
 * reported *beside* the defect counts, never behind them, because otherwise the
 * cheapest way to score well would be to state nothing at all.
 */

export const BENCH_SEVERITIES = [
  /** The plan asserts something that cannot be executed. Verified against data. */
  'critical',
  /** Executable, but violates a constraint the traveller stated explicitly. */
  'major',
  /** Executable and within the request; below a quality bar the request implies. */
  'minor',
  /** Neither a defect nor a risk. Recorded so two plans can be compared. */
  'informational',
  /**
   * The check could not be decided, because the evidence was absent. Never a
   * defect. Never rolled into a defect count. Always counted separately.
   */
  'unknown',
] as const;
export const benchSeveritySchema = z.enum(BENCH_SEVERITIES);
export type BenchSeverity = z.infer<typeof benchSeveritySchema>;

/** Why a check returned `unknown`. Closed, so "unknown" is never a shrug. */
export const UNKNOWN_REASONS = [
  /** No hours / weather / food / access dataset covered this subject. */
  'no_dataset',
  /** The plan names something the shared inventory does not hold. */
  'subject_not_in_inventory',
  /** No routing engine measured this pair. */
  'no_measured_route',
  /** An assertion with nothing behind it, where the plan format allows one. */
  'evidence_absent',
  /** The plan simply does not state what the check needs. */
  'plan_omits_field',
  /** The request does not state the constraint this check would enforce. */
  'request_omits_constraint',
  /** The rule may not apply here and there is no way to tell. */
  'not_applicable_unproven',
] as const;
export const unknownReasonSchema = z.enum(UNKNOWN_REASONS);
export type UnknownReason = z.infer<typeof unknownReasonSchema>;

/**
 * Every check the neutral validator can run.
 *
 * A closed enum, so a coverage test can assert that every check named by the
 * benchmark specification is either implemented or explicitly recorded as not
 * implemented — rather than quietly missing.
 */
export const BENCH_CHECK_CODES = [
  // Coverage and structure
  'date_missing_from_plan',
  'date_outside_range',
  'duplicate_date',
  'arrival_day_starts_too_early',
  'departure_day_ends_too_late',
  'empty_day',
  'empty_successful_plan',
  // Geography and routing
  'missing_travel_segment',
  'travel_segment_endpoints_broken',
  'route_time_unavailable',
  'impossible_jump',
  'base_inconsistent',
  'transfer_day_without_transfer',
  'transfer_understated',
  'daily_travel_exceeded',
  'daily_drive_exceeded',
  // Traveller constraints
  'mobility_conflict',
  'hard_avoidance_violated',
  'must_do_ignored',
  'must_do_deferred_with_reason',
  // Time and scheduling
  'blocks_overlap',
  'activity_duration_implausible',
  'scheduled_while_closed',
  'arrives_before_opening',
  'arrives_after_last_admission',
  'ends_after_closing',
  'seasonal_access_conflict',
  'scheduled_outside_daylight',
  'scheduled_inside_daylight_buffer',
  'excessive_density',
  'insufficient_free_time',
  // Food
  'meal_missing',
  'long_day_without_food',
  'meal_venue_closed',
  'meal_detour_excessive',
  'strict_dietary_conflict',
  // Integrity
  'duplicate_place',
  'unsupported_exact_value',
  'unsupported_factual_claim',
  'stated_totals_contradict_timeline',
  'internal_contradiction',
] as const;
export const benchCheckCodeSchema = z.enum(BENCH_CHECK_CODES);
export type BenchCheckCode = z.infer<typeof benchCheckCodeSchema>;

/** What was inspected. Never a planner-internal identifier. */
export const benchSubjectSchema = z.object({
  dayNumber: z.number().int().min(1).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  /** Shared inventory id, so two plans naming one place agree. */
  entityId: z.string().min(1).optional(),
  /** Index into the day's blocks, so two shapes can be diffed. */
  blockIndex: z.number().int().min(0).optional(),
});
export type BenchSubject = z.infer<typeof benchSubjectSchema>;

const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const benchFindingSchema = z
  .object({
    code: benchCheckCodeSchema,
    severity: benchSeveritySchema,
    subject: benchSubjectSchema,
    /**
     * For humans. Never parsed, and deliberately excluded from finding equality
     * — otherwise two identical defects phrased differently would look like two
     * different findings, and the neutrality test would pass while being wrong.
     */
    message: z.string().min(1).max(600),
    /** Which function decided this, so a finding can be re-derived. */
    groundTruth: z.string().min(1),
    observed: z.record(z.string(), scalar).default({}),
    expected: z.record(z.string(), scalar).default({}),
    unknownReason: unknownReasonSchema.optional(),
  })
  .refine((finding) => (finding.severity === 'unknown') === (finding.unknownReason !== undefined), {
    message: 'unknownReason is required exactly when the severity is unknown',
    path: ['unknownReason'],
  });
export type BenchFinding = z.infer<typeof benchFindingSchema>;

export const benchReportSchema = z.object({
  schemaVersion: z.literal(1),
  planId: z.string().min(1),
  /** Structure only. Two plans with equal fingerprints must score identically. */
  planFingerprint: z.string().min(1),
  findings: z.array(benchFindingSchema),
  counts: z.object({
    critical: z.number().int().min(0),
    major: z.number().int().min(0),
    minor: z.number().int().min(0),
    informational: z.number().int().min(0),
    unknown: z.number().int().min(0),
  }),
  /**
   * Checks decided over checks attempted.
   *
   * The honest headline, and the thing that stops `unknown` being a hiding
   * place. A plan that states nothing gets no defects and a verifiability near
   * zero, and the results view is required to show both numbers together.
   */
  verifiability: z.object({
    attempted: z.number().int().min(0),
    decided: z.number().int().min(0),
  }),
});
export type BenchReport = z.infer<typeof benchReportSchema>;

/**
 * HOW MANY CHECKS COULD NOT BE RUN BECAUSE THE INVENTORY HAD NEVER HEARD OF THE
 * PLACE.
 *
 * The single most important number to print beside a defect count, and it is not
 * a property of the plan. The shared inventory the checker resolves against is
 * the world the harness buys — which is one arm's entire planning input and only
 * an overlapping subset of the other's, because that arm compiles its own region
 * from its own resolution. So one arm's stops resolve almost always and the
 * other's resolve sometimes, and *exposure to being caught* differs between the
 * two for a reason that is a property of the instrument.
 *
 * Raw critical and major counts are therefore not comparable in level between
 * arms. They are comparable as a rate over the checks that were actually
 * decided, and this figure is what tells a reader how far apart the two
 * denominators were.
 */
export function subjectsNotInInventory(report: BenchReport): number {
  return report.findings.filter(
    (finding) => finding.severity === 'unknown' && finding.unknownReason === 'subject_not_in_inventory',
  ).length;
}

/**
 * Defects per hundred decided checks.
 *
 * `null` when nothing was decided — a plan nobody could check has no defect
 * rate, and printing `0` for it would be the most flattering possible rendering
 * of a plan the instrument could not read.
 */
export function defectRatePerHundredDecided(report: BenchReport): number | null {
  const decided = report.verifiability.decided;
  if (decided <= 0) return null;
  return ((report.counts.critical + report.counts.major) / decided) * 100;
}

/**
 * A stable ordering, so two runs of the same validator over the same plan
 * produce byte-identical reports.
 *
 * Without it the report would inherit whatever order a `Map` iterated in, which
 * is a property of insertion and therefore of the plan's shape — and a
 * neutrality test comparing two structurally equivalent plans would fail for a
 * reason that has nothing to do with either plan.
 */
export function canonicaliseFindings(findings: BenchFinding[]): BenchFinding[] {
  return [...findings].sort((a, b) => {
    if (a.code !== b.code) return a.code < b.code ? -1 : 1;
    const dayA = a.subject.dayNumber ?? 0;
    const dayB = b.subject.dayNumber ?? 0;
    if (dayA !== dayB) return dayA - dayB;
    const blockA = a.subject.blockIndex ?? -1;
    const blockB = b.subject.blockIndex ?? -1;
    if (blockA !== blockB) return blockA - blockB;
    const entityA = a.subject.entityId ?? '';
    const entityB = b.subject.entityId ?? '';
    if (entityA !== entityB) return entityA < entityB ? -1 : 1;
    return 0;
  });
}

/**
 * Finding equality for the neutrality test: everything except the prose.
 *
 * Two systems that trip the same rule about the same thing must produce the same
 * finding, and the sentence a human reads is the one part that legitimately
 * differs — it names the plan's own words back at the reviewer.
 */
export function findingIdentity(finding: BenchFinding): string {
  return JSON.stringify({
    code: finding.code,
    severity: finding.severity,
    subject: finding.subject,
    observed: sortedRecord(finding.observed),
    expected: sortedRecord(finding.expected),
    unknownReason: finding.unknownReason ?? null,
  });
}

function sortedRecord(
  record: Record<string, string | number | boolean | null>,
): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const key of Object.keys(record).sort()) {
    out[key] = record[key] ?? null;
  }
  return out;
}

export function countBySeverity(findings: BenchFinding[]): BenchReport['counts'] {
  const counts = { critical: 0, major: 0, minor: 0, informational: 0, unknown: 0 };
  for (const finding of findings) counts[finding.severity] += 1;
  return counts;
}

/**
 * The defect total the decision rules use.
 *
 * `unknown` is absent from this sum by construction rather than by remembering
 * to exclude it at each call site.
 */
export function defectCount(counts: BenchReport['counts']): number {
  return counts.critical + counts.major;
}
