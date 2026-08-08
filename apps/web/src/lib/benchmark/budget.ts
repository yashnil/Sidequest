import 'server-only';
import { totalBenchmarkSpendMicroUsd } from '@/lib/db/benchmark-review-repository';

/**
 * THE CEILING ON WHAT A LIVE PILOT MAY SPEND.
 *
 * Absent by default, and its absence is not a degraded mode — it is a refusal.
 * With no `SIDEQUEST_BENCHMARK_BUDGET_USD` in the environment, no paid operation
 * happens at all, the pilot is reported as intentionally skipped, and everything
 * offline still runs. That is the same posture the compiler's provider switch
 * takes: an unrecognised value falls through to *off*, because a typo should
 * cost nothing.
 *
 * Three properties, each of which exists because the obvious alternative has a
 * failure mode:
 *
 * **A malformed, negative or zero value yields `null`, never a default ceiling.**
 * A default would mean a mistyped budget quietly authorised spending nobody
 * chose.
 *
 * **Reservation happens before the call and recording after.** Checking spend
 * only afterwards means the ceiling is discovered by crossing it.
 *
 * **Refusal is a return value, never an exception.** Running out of budget is a
 * normal outcome of a bounded experiment, and a benchmark that threw would lose
 * the partial results it had already paid for.
 */

export interface BenchmarkBudget {
  ceilingMicroUsd: number;
  /** Where the ceiling came from, so a report can say so. */
  source: 'environment';
}

const MICRO_PER_USD = 1_000_000;

export function benchmarkBudgetFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): BenchmarkBudget | null {
  const raw = env.SIDEQUEST_BENCHMARK_BUDGET_USD?.trim();
  if (!raw) return null;

  const dollars = Number(raw);
  if (!Number.isFinite(dollars) || dollars <= 0) return null;
  return { ceilingMicroUsd: Math.round(dollars * MICRO_PER_USD), source: 'environment' };
}

/**
 * WHAT EACH PAID OPERATION IS ASSUMED TO COST BEFORE IT HAPPENS.
 *
 * Conservative on purpose: what the operation could cost at its own ceiling, not
 * what it probably will. Stopping *short* of the boundary is the requirement,
 * and an optimistic estimate is how a run stops just after it instead.
 *
 * The figures are anchored on measured pilot runs and rounded up — a generation
 * call that billed $1.22 is reserved at $2.50, a compilation that billed $1.72 at
 * $4.00. Rounding up costs a refused run near the ceiling; rounding down costs an
 * overspend nobody authorised, and only one of those is recoverable.
 *
 * They are estimates for *reservation only*. What is reported as cost is always
 * the ledger's own figure from the provider's usage, never one of these.
 */
export const SPEND_ESTIMATES_MICRO_USD = {
  /** One bounded, low-effort call with a 2k ceiling. */
  followUpSynthesis: 150_000,
  /** One high-effort call over a whole research packet. */
  generation: 2_500_000,
  /** The same shape, over a plan and its findings. */
  repair: 2_500_000,
  /** A whole compilation: classification, extraction, reconciliation. */
  compilation: 4_000_000,
} as const;

export type SpendDecision =
  | { kind: 'allowed'; remainingMicroUsd: number }
  | { kind: 'no_budget' }
  | { kind: 'would_exceed'; remainingMicroUsd: number; estimateMicroUsd: number };

/**
 * May this operation spend?
 *
 * The estimate is conservative on purpose: it is what the operation could cost
 * at its call ceiling, not what it probably will. Stopping short of the boundary
 * is the requirement, and an optimistic estimate is how a run stops just after
 * it instead.
 *
 * Spend is read from the ledger rather than from a counter in memory, so a
 * second process, a restart, and a run that crashed after being billed all still
 * count against the same ceiling.
 */
export function maySpend(estimateMicroUsd: number): SpendDecision {
  const budget = benchmarkBudgetFromEnv();
  if (!budget) return { kind: 'no_budget' };

  const spent = totalBenchmarkSpendMicroUsd();
  /*
   * A call nobody could price blocks, rather than counting as free.
   *
   * The ledger's total is a sum over the calls that had a rate. With one unpriced
   * call on it the total is a floor, and a ceiling compared against a floor is not
   * a ceiling — every model missing from the rate table would silently authorise
   * the whole budget again. Refusing is the conservative direction, and it is
   * recoverable by adding the rate; spending past the ceiling is not.
   */
  if (spent.costMicroUsd === null || spent.unpricedCalls > 0) {
    return { kind: 'would_exceed', remainingMicroUsd: 0, estimateMicroUsd };
  }

  const remaining = Math.max(0, budget.ceilingMicroUsd - spent.costMicroUsd);
  if (estimateMicroUsd > remaining) {
    return { kind: 'would_exceed', remainingMicroUsd: remaining, estimateMicroUsd };
  }
  return { kind: 'allowed', remainingMicroUsd: remaining };
}

/**
 * What the ledger says, and whether it is the whole story.
 *
 * `unpricedCalls` travels with the total rather than being folded into it. A
 * session containing one call nobody could price has a total that is a lower
 * bound, and presenting a lower bound as the figure is the kind of small lie a
 * cost comparison does not survive. When *no* call could be priced there is no
 * bound at all, and `spentMicroUsd` is `null` — which a reader has to render as
 * "unknown" rather than as a number.
 */
export function budgetStatus(): {
  budget: BenchmarkBudget | null;
  spentMicroUsd: number | null;
  unpricedCalls: number;
  remainingMicroUsd: number | null;
} {
  const budget = benchmarkBudgetFromEnv();
  const spent = totalBenchmarkSpendMicroUsd();
  return {
    budget,
    spentMicroUsd: spent.costMicroUsd,
    unpricedCalls: spent.unpricedCalls,
    remainingMicroUsd:
      budget && spent.costMicroUsd !== null
        ? Math.max(0, budget.ceilingMicroUsd - spent.costMicroUsd)
        : null,
  };
}

/**
 * Whether this build may make a paid benchmark call at all.
 *
 * Two switches, both of which must be deliberate: a mode that says `live`, and a
 * budget. `fixture` is the default and is what every automated test runs under,
 * so a browser suite cannot reach a model even if a future default changes.
 */
export function benchmarkModeIsLive(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SIDEQUEST_BENCHMARK_MODE?.trim().toLowerCase() === 'live';
}

export function paidOperationsPermitted(env: NodeJS.ProcessEnv = process.env): boolean {
  return benchmarkModeIsLive(env) && benchmarkBudgetFromEnv(env) !== null;
}

/**
 * THE CEILING, ASKED RATHER THAN ASSUMED.
 *
 * `paidOperationsPermitted` answers "is there a budget at all", which is a
 * different question from "is there any of it left" — and for a long time only
 * the first was ever asked. `maySpend` existed, was correct, and had no callers:
 * the ledger was written, the total was computed, and nothing consulted it before
 * a call. A run could therefore spend past a ceiling the founder guide states is
 * enforced before every call.
 *
 * This is the one predicate the paid call sites use. It returns a *reason* rather
 * than a boolean, because "no budget was configured" and "the budget is spent"
 * are different facts that a run has to record differently — the first is a
 * misconfiguration and the second is the experiment working as designed.
 */
export type SpendGate =
  | { kind: 'allowed' }
  | { kind: 'refused'; reason: string };

export function gateSpend(
  operation: keyof typeof SPEND_ESTIMATES_MICRO_USD,
  env: NodeJS.ProcessEnv = process.env,
): SpendGate {
  /*
   * Off the hook entirely when the benchmark is not in live mode.
   *
   * Not an oversight and not a loophole: outside live mode nothing in this
   * harness is authorised to reach a provider at all, so there is no spend for a
   * ceiling to bound. The gate would otherwise refuse every offline
   * demonstration — the one thing the acceptance criteria require a reviewer to
   * be able to run locally — on the grounds that no budget was configured for
   * money nobody was going to spend.
   *
   * What governs an offline run is the switch that was already governing it:
   * `baselineCapabilities()` for the model, and the compiler's own provider
   * switch for everything else.
   */
  if (!benchmarkModeIsLive(env)) return { kind: 'allowed' };

  const decision = maySpend(SPEND_ESTIMATES_MICRO_USD[operation]);
  if (decision.kind === 'allowed') return { kind: 'allowed' };
  if (decision.kind === 'no_budget') {
    return {
      kind: 'refused',
      reason: 'No spending ceiling was configured, so no paid operation was attempted.',
    };
  }
  return {
    kind: 'refused',
    reason:
      'The configured spending ceiling has too little left for this step, so it was not attempted.',
  };
}
