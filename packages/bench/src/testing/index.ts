/**
 * THE BENCHMARK FIXTURE KIT.
 *
 * Everything an offline benchmark test needs and nothing it has to build: a
 * ground truth over an invented coastline, a good plan, every single-defect
 * variant of that plan, the two blind assignments, and the session records that
 * sit around them.
 *
 * Two properties hold across the whole directory, and both are load-bearing for
 * a benchmark whose results are meant to survive being re-run.
 *
 * **No clock.** `FIXED_NOW` is a constant and every builder takes `now` as a
 * parameter defaulting to it, so a fixture cannot behave differently in the
 * afternoon or on the far side of a date line.
 *
 * **No randomness.** The assignments come from `seededEntropy` with two seeds
 * that were found by running the generator, not guessed at. `sampleAssignment`
 * is the only door to a fixture assignment, and it always marks the row
 * `seeded`, which keeps it out of any aggregate over live sessions.
 */
export * from './request';
export * from './world';
export * from './plans';
export * from './sessions';
