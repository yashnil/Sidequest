/**
 * The test-only surface of the compiler.
 *
 * A separate entry point rather than part of the package's main barrel, so that
 * importing a synthetic world into production code is a decision somebody made
 * rather than something that happened to be in scope. `architecture.test.ts`
 * keeps it that way.
 */
export * from './fakes';
export * from './pack-fakes';
