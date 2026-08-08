import { planFingerprint } from './fingerprint';
import type { BenchmarkGroundTruth } from './ground-truth';
import {
  BENCH_CHECK_CODES,
  canonicaliseFindings,
  countBySeverity,
  type BenchCheckCode,
  type BenchFinding,
  type BenchReport,
} from './schemas/finding';
import { type BenchmarkPlan } from './schemas/plan';
import { checkClaims } from './validate/claims';
import { canonicalisePlan, createContext, type CheckContext } from './validate/context';
import { checkConstraints } from './validate/constraints';
import { checkCoverage } from './validate/coverage';
import { checkFood } from './validate/food';
import { checkIntegrity } from './validate/integrity';
import { checkRouting } from './validate/routing';
import { checkScheduling } from './validate/scheduling';

/**
 * THE NEUTRAL VALIDATOR.
 *
 * One function, two inputs, and the second one is the entire fairness argument:
 * everything the checks know about the world arrives through the
 * `BenchmarkGroundTruth` port, and this file imports neither the planner, the
 * geo package nor core. That is not a promise about discipline — it is a
 * property a build tool can check, which is the only kind of neutrality worth
 * having in a benchmark whose author also wrote one of the competitors.
 *
 * Three rules hold across every check beneath this:
 *
 * **`unknown` is never a defect.** Missing hours, an unmeasured route, a place
 * the shared inventory does not hold, a field the plan simply did not state —
 * all of those produce an `unknown` with a named reason and count toward
 * verifiability instead. The alternative, which the production validator lives
 * with quite happily inside one system, is that a plan that is *wrong* and a
 * plan that is merely *unverifiable* score the same.
 *
 * **Verifiability is reported beside the defects, never behind them.** A plan
 * that states nothing gets very few defects and a verifiability near zero, and
 * the two numbers together are the honest summary. Either alone can be gamed.
 *
 * **The report is a pure function of the plan's structure.** Array order is not
 * structure, prose is not structure, and which system produced it is certainly
 * not structure — so the days and blocks are canonically ordered before any
 * check sees them, and the findings are canonically sorted before they leave.
 */

export const BENCH_REPORT_VERSION = 1 as const;

/** Which module implements each check, so a coverage test can find a gap. */
export const CHECK_MODULES = [
  'coverage',
  'routing',
  'constraints',
  'scheduling',
  'food',
  'integrity',
  'claims',
] as const;
export type CheckModule = (typeof CHECK_MODULES)[number];

/**
 * Every check code, mapped to the module that decides it.
 *
 * Exhaustive by type, and asserted exhaustive by test. A code added to
 * `BENCH_CHECK_CODES` and forgotten here fails the build rather than quietly
 * never firing — which is the failure mode that would matter most, because a
 * check nobody notices is missing looks exactly like a check that always passes.
 */
export const CHECK_COVERAGE: Record<BenchCheckCode, CheckModule> = {
  date_missing_from_plan: 'coverage',
  date_outside_range: 'coverage',
  duplicate_date: 'coverage',
  arrival_day_starts_too_early: 'coverage',
  departure_day_ends_too_late: 'coverage',
  empty_day: 'coverage',
  empty_successful_plan: 'coverage',

  missing_travel_segment: 'routing',
  travel_segment_endpoints_broken: 'routing',
  route_time_unavailable: 'routing',
  impossible_jump: 'routing',
  base_inconsistent: 'routing',
  transfer_day_without_transfer: 'routing',
  transfer_understated: 'routing',
  daily_travel_exceeded: 'routing',
  daily_drive_exceeded: 'routing',

  mobility_conflict: 'constraints',
  hard_avoidance_violated: 'constraints',
  must_do_ignored: 'constraints',
  must_do_deferred_with_reason: 'constraints',

  blocks_overlap: 'scheduling',
  activity_duration_implausible: 'scheduling',
  scheduled_while_closed: 'scheduling',
  arrives_before_opening: 'scheduling',
  arrives_after_last_admission: 'scheduling',
  ends_after_closing: 'scheduling',
  seasonal_access_conflict: 'scheduling',
  scheduled_outside_daylight: 'scheduling',
  scheduled_inside_daylight_buffer: 'scheduling',
  excessive_density: 'scheduling',
  insufficient_free_time: 'scheduling',

  meal_missing: 'food',
  long_day_without_food: 'food',
  meal_venue_closed: 'food',
  meal_detour_excessive: 'food',
  strict_dietary_conflict: 'food',

  duplicate_place: 'integrity',
  stated_totals_contradict_timeline: 'integrity',
  internal_contradiction: 'integrity',
  unsupported_exact_value: 'claims',
  unsupported_factual_claim: 'claims',
};

type CheckFunction = (
  plan: BenchmarkPlan,
  truth: BenchmarkGroundTruth,
  ctx: CheckContext,
) => BenchFinding[];

const CHECKS: readonly { module: CheckModule; run: CheckFunction }[] = [
  { module: 'coverage', run: checkCoverage },
  { module: 'routing', run: checkRouting },
  { module: 'constraints', run: checkConstraints },
  { module: 'scheduling', run: checkScheduling },
  { module: 'food', run: checkFood },
  { module: 'integrity', run: checkIntegrity },
  { module: 'claims', run: checkClaims },
];

export function runNeutralValidation(
  plan: BenchmarkPlan,
  truth: BenchmarkGroundTruth,
): BenchReport {
  const canonical = canonicalisePlan(plan);
  const ctx = createContext(canonical, truth);
  const findings: BenchFinding[] = [];

  for (const check of CHECKS) {
    try {
      findings.push(...check.run(canonical, truth, ctx));
    } catch {
      /**
       * A validator that throws must not be able to score either plan.
       *
       * Every check below is written to produce findings rather than exceptions
       * for a malformed plan, so reaching here means a defect in this package.
       * It is recorded as one attempted, undecided check — the verifiability
       * ratio drops, no defect is invented against the plan, and the remaining
       * modules still run instead of the whole report being lost.
       */
      ctx.undecided();
    }
  }

  const ordered = canonicaliseFindings(findings.filter(isKnownCode));
  return {
    schemaVersion: BENCH_REPORT_VERSION,
    planId: String(plan.planId ?? ''),
    // Fingerprinted from the canonical projection rather than the plan as it
    // arrived, so two serialisations of one plan cannot report different
    // structures.
    planFingerprint: planFingerprint(canonical),
    findings: ordered,
    counts: countBySeverity(ordered),
    verifiability: { attempted: ctx.tally.attempted, decided: ctx.tally.decided },
  };
}

const KNOWN_CODES = new Set<string>(BENCH_CHECK_CODES);

function isKnownCode(finding: BenchFinding): boolean {
  return KNOWN_CODES.has(finding.code);
}
