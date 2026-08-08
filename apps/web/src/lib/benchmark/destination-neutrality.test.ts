import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * NO BENCHMARK CODE BRANCHES ON A DESTINATION.
 *
 * The temptation this test exists to remove is specific and would be easy to
 * yield to under pressure. A live pilot on New York produces a plan with an
 * obvious flaw; the flaw has a one-line fix that happens to key off the city;
 * the pilot on Bali then looks fine. What has been measured at that point is not
 * two planning architectures — it is how many destinations somebody had time to
 * special-case, and the result would be both wrong and unfalsifiable.
 *
 * So the rule is: the benchmark's fixtures may name places, because a human has
 * to be able to tell sixteen cases apart, and nothing that *runs* may branch on
 * one. The case library lives in `packages/bench/src/cases`, is excluded here by
 * name, and is the only place a real destination may appear.
 *
 * The scan is deliberately over identifiers and string literals rather than over
 * prose: a comment explaining why Bali is a hard case is exactly the kind of
 * reasoning that should survive, and banning the word would ban the explanation.
 */

const WEB_SRC = fileURLToPath(new URL('../../', import.meta.url));

/** The directories that hold benchmark code the product actually runs. */
const BENCHMARK_ROOTS = ['lib/benchmark', 'app/labs', 'components/benchmark'];

/**
 * Real places, at the granularity a benchmark case would be tempted to name.
 *
 * Countries, cities, regions and the two seed-fixture names the wider
 * architecture test already guards elsewhere in the repository. The list does not
 * have to be exhaustive to be useful — it has to cover the destinations this
 * phase's own case library uses, because those are the ones somebody debugging a
 * live pilot would reach for.
 */
const DESTINATION_NAMES = [
  'new york',
  'newyork',
  'manhattan',
  'brooklyn',
  'bali',
  'indonesia',
  'kyrgyzstan',
  'bishkek',
  'iceland',
  'reykjavik',
  'slovenia',
  'ljubljana',
  'tokyo',
  'kyoto',
  'osaka',
  'japan',
  'seoul',
  'taipei',
  'mexico city',
  'oaxaca',
  'peru',
  'colombia',
  'lisbon',
  'portugal',
  'azores',
  'faroe',
  'yosemite',
  'yellowstone',
  'denali',
  'alaska',
  'eastern sierra',
  'mammoth',
  'mono lake',
  'june lake',
  'highway 395',
];

function walk(directory: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    // A root that does not exist yet is not a violation. The non-vacuity guard
    // below is what stops that from making this test meaningless.
    return out;
  }
  for (const entry of entries) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/**
 * The file with comments stripped.
 *
 * Prose about a destination is reasoning; a string literal naming one is a
 * branch waiting to happen. Only the second is banned.
 */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

/**
 * Everything under the benchmark roots except the tests.
 *
 * A test is allowed to name a place — this one has to, in order to hold the
 * list, and a test asserting that a partial plan for an island still renders is
 * clearer with the island in it. What is banned is a *code path* that behaves
 * differently depending on where the traveller is going.
 */
function benchmarkFiles(): string[] {
  return BENCHMARK_ROOTS.flatMap((root) => walk(join(WEB_SRC, root))).filter(
    (file) => !/\.test\.tsx?$/.test(file),
  );
}

describe('the benchmark treats every destination the same', () => {
  it('is scanning real files rather than an empty tree', () => {
    expect(benchmarkFiles().length).toBeGreaterThan(5);
  });

  it('names no destination in any code path', () => {
    const offenders: string[] = [];
    for (const file of benchmarkFiles()) {
      const source = code(file).toLowerCase();
      for (const name of DESTINATION_NAMES) {
        if (source.includes(name)) {
          offenders.push(`${file.slice(WEB_SRC.length)} names "${name}"`);
        }
      }
    }
    expect(
      offenders,
      `${offenders.join('\n')}\n\nBenchmark fixtures may name places; benchmark code may not branch on one.`,
    ).toEqual([]);
  });

  it('can actually fail, so a clean result means something', () => {
    // A negative control. Without it, a scan that silently matched nothing —
    // a broken path, a changed extension — would look exactly like a pass.
    const contrived = 'const region = "New York";';
    const matched = DESTINATION_NAMES.some((name) => contrived.toLowerCase().includes(name));
    expect(matched).toBe(true);
  });
});
