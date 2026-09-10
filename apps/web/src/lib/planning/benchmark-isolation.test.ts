import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * THE PRODUCTION BUILD PATH DOES NOT IMPORT THE BENCHMARK.
 *
 * PRODUCTION LOCK V5 §2. This is not tidiness. `buildHybridTripRequest` used to
 * sit in `planning/` and produce a `BenchmarkTripRequest` for every real trip a
 * traveller built, which meant a schema designed so two planners could be
 * compared on equal footing decided what the *product* was allowed to know
 * about a person. Its dietary vocabulary holds 7 values where core's holds 16,
 * so the founder's own diet — "no beef, no pork" — was filtered to nothing
 * while its strictness travelled on, and the benchmark schema then refused the
 * pair. A hard Zod throw on Build, from a file whose header says it is for
 * benchmarks.
 *
 * There is no input that reproduces that class of defect once it is fixed, and
 * no test that notices when somebody adds the import back because it was the
 * quickest way to get a field they wanted. So the property is asserted against
 * the source.
 *
 * The parser is deliberately literal about the imports this directory writes,
 * and asserts it found a plausible number of files and imports — a regex that
 * silently matched nothing would make this a test that passes forever while
 * proving nothing.
 */

const PLANNING = join(__dirname);

/**
 * The modules the one canonical generation path is made of.
 *
 * `skeleton-*.ts` are deliberately absent: CLAUDE.md records them as unwired
 * (kept for history and regression, never reached by a user CTA), and they are
 * the benchmark's own skeleton adapters. If one is ever wired to a traveller
 * CTA it belongs on this list, and this test will then say so.
 */
const CANONICAL_MODULES = [
  'production-plan.ts',
  'composition.ts',
  'composition-model.ts',
  'canonical-input.ts',
  'trip-draft.ts',
  'trip-draft-wire.ts',
  'safe-text.ts',
  'quality-audit.ts',
  'preservation.ts',
  'verification-providers.ts',
  'place-identity.ts',
  'route-selection.ts',
  'default-profile.ts',
  'fixture-composer.ts',
];

const BENCHMARK_IMPORT = /from\s+['"]([^'"]*(?:@sidequest\/bench|benchmark\/)[^'"]*)['"]/g;

function importsOf(file: string): string[] {
  const source = readFileSync(join(PLANNING, file), 'utf8');
  return [...source.matchAll(BENCHMARK_IMPORT)].map((match) => match[1]!);
}

describe('the canonical production build path is free of benchmark schemas', () => {
  it('names modules that all exist, so the list cannot rot into a no-op', () => {
    const present = new Set(readdirSync(PLANNING));
    for (const module of CANONICAL_MODULES) expect(present.has(module), `${module} is on the canonical list but not in planning/`).toBe(true);
    expect(CANONICAL_MODULES.length).toBeGreaterThanOrEqual(12);
  });

  it('imports nothing from @sidequest/bench or lib/benchmark', () => {
    const offenders: string[] = [];
    for (const module of CANONICAL_MODULES) {
      for (const specifier of importsOf(module)) offenders.push(`${module} → ${specifier}`);
    }
    expect(offenders, 'a canonical planning module imports the benchmark').toEqual([]);
  });

  it('finds real imports in those files, so the regex is not matching nothing', () => {
    const anyImport = /^\s*import\s/gm;
    let total = 0;
    for (const module of CANONICAL_MODULES) {
      total += [...readFileSync(join(PLANNING, module), 'utf8').matchAll(anyImport)].length;
    }
    expect(total).toBeGreaterThan(40);
  });

  it('keeps the benchmark request adapter outside planning/', () => {
    expect(readdirSync(PLANNING)).not.toContain('hybrid-request.ts');
  });
});
