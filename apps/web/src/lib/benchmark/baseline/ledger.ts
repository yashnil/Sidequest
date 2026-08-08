import 'server-only';
import { estimateCostMicroUsd } from '@sidequest/core';
import type { StructuredModel } from '../../providers/interpretation-model';
import { recordModelCall } from '../../db/benchmark-review-repository';

/**
 * EVERY CALL, INCLUDING THE ONES THAT FAILED.
 *
 * A provider that took the request, burned the tokens and returned something
 * unusable has spent real money. A ledger that only recorded successes would be
 * wrong in exactly the situation somebody is looking at it — a run that fell
 * over three times would report as having cost nothing — so this module writes a
 * row on the failure path as well, and does it in a `finally` so an exception
 * cannot skip it.
 *
 * The other rule here is about zero. `estimateCostMicroUsd` returns `null` for a
 * model with no row in the checked-in rate table, and that `null` is written as
 * `NULL` with a reason rather than coalesced. "Nobody could price this call" and
 * "this call cost nothing" are different facts, and this repository has already
 * lost the distinction once, in a usage record whose writer defaulted a missing
 * token count to `0`. Nothing here uses `??` on a cost or a token count.
 */

export type CostUnavailableReason = 'unpriced_model' | 'usage_not_reported';

export interface LedgerContext {
  sessionId: string;
  runId: string | null;
  /** The durable single-flight identity this run was claimed under. */
  operationKey: string;
  model: string;
  provider: string;
}

export interface LedgerEntry {
  operation: string;
  promptVersion: string;
  /** One per call within a run, so the ledger's unique index means something. */
  attempt: number;
}

/**
 * What the model has spent so far, where it counts.
 *
 * Read structurally rather than from `ResearchModel`, because the offline suite
 * injects fakes and the production path injects the real fence. A fake that
 * reports nothing produces `null`, which travels to the row as an explicit
 * absence — never as a zero that would read as free.
 */
interface UsageSnapshot {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  webSearches: number;
  requestId: string | null;
}

function snapshot(model: StructuredModel): UsageSnapshot | null {
  const usage = model.usage as
    | {
        inputTokens?: unknown;
        outputTokens?: unknown;
        cacheReadTokens?: unknown;
        cacheWriteTokens?: unknown;
        webSearches?: unknown;
        requestIds?: unknown;
      }
    | undefined;
  if (!usage || typeof usage.inputTokens !== 'number' || typeof usage.outputTokens !== 'number') {
    return null;
  }
  const requestIds = Array.isArray(usage.requestIds) ? usage.requestIds : [];
  const latest = requestIds[requestIds.length - 1];
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: typeof usage.cacheReadTokens === 'number' ? usage.cacheReadTokens : 0,
    cacheWriteTokens: typeof usage.cacheWriteTokens === 'number' ? usage.cacheWriteTokens : 0,
    webSearches: typeof usage.webSearches === 'number' ? usage.webSearches : 0,
    requestId: typeof latest === 'string' ? latest : null,
  };
}

export interface LedgerTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costMicroUsd: number | null;
  /** Set the moment one call could not be priced. The total is then a floor. */
  unpricedCalls: number;
}

/**
 * The run's own accounting, kept beside the database rows.
 *
 * The rows are the evidence; these totals are what the metric set is built from,
 * and they are accumulated here rather than read back so that a failure to write
 * a row cannot silently zero a metric.
 */
export class BaselineLedger {
  private readonly context: LedgerContext;
  /**
   * The one model instance this run owns.
   *
   * Held rather than passed per call, so the ledger and the fence cannot
   * diverge: there is no way to account for a call made against a different
   * instance from the one whose budget was checked.
   */
  private readonly model: StructuredModel;
  readonly totals: LedgerTotals = {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    costMicroUsd: 0,
    unpricedCalls: 0,
  };

  constructor(context: LedgerContext, model: StructuredModel) {
    this.context = context;
    this.model = model;
  }

  /**
   * Run one model operation and record it, whatever happens.
   *
   * `failureOf` reads the operation's own outcome, because every call site here
   * returns a discriminated result rather than throwing — and a wrapper that
   * only noticed exceptions would file every schema rejection as a success.
   */
  async around<T>(
    entry: LedgerEntry,
    run: () => Promise<T>,
    failureOf: (result: T) => string | null,
  ): Promise<T> {
    const before = snapshot(this.model);
    const startedAt = new Date();
    let failureKind: string | null = 'internal_error';
    try {
      const result = await run();
      failureKind = failureOf(result);
      return result;
    } finally {
      this.write(entry, before, startedAt, failureKind);
    }
  }

  private write(
    entry: LedgerEntry,
    before: UsageSnapshot | null,
    startedAt: Date,
    failureKind: string | null,
  ): void {
    const after = snapshot(this.model);
    const finishedAt = new Date();

    const measured = before !== null && after !== null;
    const inputTokens = measured ? Math.max(0, after.inputTokens - before.inputTokens) : 0;
    const outputTokens = measured ? Math.max(0, after.outputTokens - before.outputTokens) : 0;
    const cacheReadTokens = measured ? Math.max(0, after.cacheReadTokens - before.cacheReadTokens) : 0;
    const cacheWriteTokens = measured
      ? Math.max(0, after.cacheWriteTokens - before.cacheWriteTokens)
      : 0;
    const webSearches = measured ? Math.max(0, after.webSearches - before.webSearches) : 0;

    /*
     * Two different absences, kept apart.
     *
     * An unpriced model means the rate table has no row for it. Unreported usage
     * means the model in this run counts nothing — a test double, or a provider
     * that returned no usage block. Both produce a NULL cost, and collapsing
     * them into one reason would make a missing rate table look like a missing
     * provider response for ever afterwards.
     */
    const costMicroUsd = measured
      ? estimateCostMicroUsd(this.context.model, {
          inputTokens,
          outputTokens,
          cacheReadTokens,
          cacheWriteTokens,
          webSearches,
        })
      : null;
    const costUnavailableReason: CostUnavailableReason | null = measured
      ? costMicroUsd === null
        ? 'unpriced_model'
        : null
      : 'usage_not_reported';

    this.totals.calls += 1;
    this.totals.inputTokens += inputTokens;
    this.totals.outputTokens += outputTokens;
    if (costMicroUsd === null) {
      this.totals.unpricedCalls += 1;
    } else if (this.totals.costMicroUsd !== null) {
      this.totals.costMicroUsd += costMicroUsd;
    }

    try {
      recordModelCall({
        sessionId: this.context.sessionId,
        runId: this.context.runId,
        // The attempt distinguishes the three calls inside one claimed
        // operation; the unique index is on the pair, so a retry of the same
        // operation at the same attempt is refused rather than double-counted.
        operationKey: `${this.context.operationKey}:${entry.operation}`,
        arm: 'baseline',
        operation: entry.operation,
        provider: this.context.provider,
        model: this.context.model,
        promptVersion: entry.promptVersion,
        requestId: after?.requestId ?? null,
        attempt: entry.attempt,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        costMicroUsd,
        costUnavailableReason,
        outcome: failureKind === null ? 'succeeded' : 'failed',
        failureKind,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs: finishedAt.getTime() - startedAt.getTime(),
      });
    } catch (error) {
      /*
       * A ledger write that fails must not take the run with it.
       *
       * The plan is the thing the traveller and the reviewer are waiting for; an
       * accounting row that could not be written is a gap in the evidence, which
       * is worth a loud line in the log and is not worth losing a plan over.
       */
      console.error('Could not record a benchmark model call', {
        sessionId: this.context.sessionId,
        operation: entry.operation,
        attempt: entry.attempt,
        error: error instanceof Error ? error.name : 'unknown',
      });
    }
  }
}
