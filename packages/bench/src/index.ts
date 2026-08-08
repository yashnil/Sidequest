/**
 * The benchmark's public surface.
 *
 * This package deliberately does **not** depend on `@sidequest/planner`, and the
 * dependency list in its `package.json` is the enforcement. The neutral
 * validators must not be able to reach the deterministic scheduler, the
 * candidate selector, the route clusterer or the revision engine — not because
 * anybody would import one on purpose, but because a barrel that re-exports
 * everything makes reaching for one a one-line accident, and the resulting
 * benchmark would be grading a competitor against its rival's contract.
 *
 * `@sidequest/geo` is likewise absent: its cluster and order functions are two of
 * the four things under test. Where geometry is genuinely needed — a great-circle
 * lower bound to prove a jump impossible — the ten lines live here.
 */
export * from './schemas/request';
export * from './schemas/plan';
export * from './schemas/metrics';
export * from './schemas/finding';
export * from './schemas/session';

export * from './fingerprint';
export * from './entropy';
export * from './assign';
export * from './hash';
export * from './ground-truth';
export * from './geometry';
export * from './validate';
