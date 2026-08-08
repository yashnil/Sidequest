import 'server-only';
import { isResearchModelConfigured } from '../../providers/switches';

/**
 * WHETHER THIS BUILD MAY SPEND ANYTHING, ASKED WITHOUT IMPORTING ANYTHING.
 *
 * The baseline arm has two runtimes and they are not two configurations of one
 * runtime — they are different promises about what a run is allowed to do.
 *
 * In `fixture` mode nothing leaves the process. No model call, no geocoder, no
 * router, no forecast. A run either produces a plan from data the caller already
 * handed it or it records an honest failure. That is what makes the offline
 * suite meaningful: a test that passed because a provider happened to answer is
 * a test that will fail on a train.
 *
 * In `live` mode the providers are permitted, subject to their own switches.
 *
 * **The default is `fixture`**, and the direction of that default is the whole
 * point. A missing environment variable must never be the reason a benchmark
 * silently starts billing somebody; forgetting to set a variable should cost
 * nothing and say so. Live is a deliberate act.
 *
 * This module reads `process.env` and imports one import-free predicate, for the
 * reason `providers/switches.ts` exists at all: asking "is this switched on?"
 * must not pull the thing being asked about into the import graph.
 */

export const BENCHMARK_MODES = ['fixture', 'live'] as const;
export type BenchmarkMode = (typeof BENCHMARK_MODES)[number];

/** Unset, misspelt, or anything but `live` means `fixture`. Never the reverse. */
export function benchmarkMode(): BenchmarkMode {
  return process.env.SIDEQUEST_BENCHMARK_MODE?.trim().toLowerCase() === 'live'
    ? 'live'
    : 'fixture';
}

/**
 * What the run is allowed to reach, as one value rather than three questions.
 *
 * `modelPermitted` is deliberately the conjunction of the mode and the
 * credential rather than either one alone. A live-mode run with no key would
 * otherwise construct a `ResearchModel`, which throws in its constructor — and a
 * constructor throwing three stages into an orchestration is a stack trace where
 * a recorded failure belongs.
 */
export interface BaselineCapabilities {
  mode: BenchmarkMode;
  modelPermitted: boolean;
  providersPermitted: boolean;
  /** One readable sentence for the failure record when something is off. */
  reason: string;
}

export function baselineCapabilities(): BaselineCapabilities {
  const mode = benchmarkMode();
  if (mode === 'fixture') {
    return {
      mode,
      modelPermitted: false,
      providersPermitted: false,
      reason: 'This build runs the benchmark in fixture mode, so nothing leaves the process.',
    };
  }
  const configured = isResearchModelConfigured();
  return {
    mode,
    modelPermitted: configured,
    providersPermitted: true,
    reason: configured
      ? 'Live mode with a research-model credential present.'
      : 'Live mode, but no research-model credential is configured.',
  };
}
