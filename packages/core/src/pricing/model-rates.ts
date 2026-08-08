/**
 * WHAT A MODEL CALL COSTS, AS A CHECKED-IN TABLE RATHER THAN A CONSTANT.
 *
 * There is already one pricing constant in this codebase — a pair of numbers in
 * the research-model client, correctly labelled "a diagnostic figure, never a
 * bill". It is fine for what it does, and it is not fine for a benchmark, for
 * one specific reason: it is not keyed by model. It holds one model's published
 * rates and applies them to whatever `ANTHROPIC_MODEL` happens to name, so a
 * comparison run against a cheaper model would report a cost advantage that
 * nobody actually enjoyed.
 *
 * A benchmark that compares two systems on cost cannot have that. So:
 *
 * **Rates are keyed by exact model id**, and `priceFor` returns `null` for one it
 * does not hold. Not a default, not the nearest neighbour, not the most
 * expensive — `null`, which travels through the metric layer as an explicit
 * `unpriced_model` absence and is rendered as such. A figure nobody can source
 * is worse than a missing figure, because a missing figure prompts a question.
 *
 * **Every rate carries where it came from and when it was read.** A number in a
 * results table without those two is an assertion, and this whole phase is about
 * not making assertions nobody can check.
 *
 * **There is no environment override.** A rate a developer typed into a shell is
 * not better evidence than a rate a developer typed into a file, and it is a
 * great deal harder to review. Adding a model means adding a row here, and a
 * test fails until somebody does.
 */

export interface ModelRate {
  /** The exact API model id. Never a family name or an alias. */
  readonly modelId: string;
  readonly inputPerMTokUsd: number;
  readonly outputPerMTokUsd: number;
  /** Writing to the prompt cache costs more than a plain input token. */
  readonly cacheWriteMultiplier: number;
  /** Reading from it costs a great deal less. */
  readonly cacheReadMultiplier: number;
  readonly webSearchPerCallUsd: number;
  /** Where the numbers were read. Rendered beside any figure derived from them. */
  readonly source: string;
  /** When they were read, so a stale table is visibly stale. */
  readonly asOf: string;
}

/**
 * The rates this build knows.
 *
 * The multipliers and the search price are the ones the existing research-model
 * client already applies; they are restated here rather than imported because
 * that client is `server-only` and this module has to be reachable from pure
 * package code, and because a benchmark's cost table should be legible in one
 * place rather than assembled from two.
 */
export const MODEL_RATES: Readonly<Record<string, ModelRate>> = {
  'claude-opus-5': {
    modelId: 'claude-opus-5',
    inputPerMTokUsd: 5,
    outputPerMTokUsd: 25,
    cacheWriteMultiplier: 1.25,
    cacheReadMultiplier: 0.1,
    webSearchPerCallUsd: 0.01,
    source: 'https://www.anthropic.com/pricing',
    asOf: '2026-08-06',
  },
};

/** `null` rather than a default. The absence is the answer. */
export function priceFor(modelId: string): ModelRate | null {
  return MODEL_RATES[modelId] ?? null;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  webSearches: number;
}

/**
 * Integer micro-USD, or `null` when the model is unpriced.
 *
 * Micro-USD integers rather than floating dollars because a sum of floats is not
 * associative and a cost table that disagrees with itself depending on the order
 * of the rows is the kind of defect nobody finds. Rounded once, at the end.
 */
export function estimateCostMicroUsd(modelId: string, usage: TokenUsage): number | null {
  const rate = priceFor(modelId);
  if (!rate) return null;

  const perToken = (perMillion: number) => perMillion / 1e6;
  const dollars =
    usage.inputTokens * perToken(rate.inputPerMTokUsd) +
    usage.cacheWriteTokens * perToken(rate.inputPerMTokUsd) * rate.cacheWriteMultiplier +
    usage.cacheReadTokens * perToken(rate.inputPerMTokUsd) * rate.cacheReadMultiplier +
    usage.outputTokens * perToken(rate.outputPerMTokUsd) +
    usage.webSearches * rate.webSearchPerCallUsd;

  if (!Number.isFinite(dollars)) return null;
  return Math.round(dollars * 1e6);
}

/** The label any surface showing one of these numbers is required to carry. */
export const COST_DISCLOSURE =
  'Estimated from published list prices. Not a bill, and not a measurement of what was charged.';
