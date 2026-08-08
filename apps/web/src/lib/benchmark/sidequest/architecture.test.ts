import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * THE BENCHMARK CANNOT REACH INTO THE THING IT MEASURES.
 *
 * A benchmark that can change its subject is not a measurement, and the way that
 * happens is never deliberate. Somebody adds a flag so a run is reproducible;
 * somebody exports a helper "just for the harness"; somebody widens a planner
 * input because the adapter needed one more field. Each is reasonable in
 * isolation and the result is a pipeline shaped by its own scorecard.
 *
 * Four assertions, each aimed at one way that happens.
 *
 *   1. **Nothing under test imports the adapter.** Checked over the transitive
 *      import closure, not the first line of each file, because the leak that
 *      matters would arrive through a shared module rather than through a direct
 *      import somebody would notice in review.
 *   2. **The adapter writes nothing the product owns.** An exact-set assertion
 *      against the empty list, so a *new* forbidden call fails even if somebody
 *      has grown used to the old ones.
 *   3. **The planner's input shape is unchanged.** Snapshotted, because the
 *      cheapest way to make this arm win would be to hand the scheduler one more
 *      fact and never mention it.
 *   4. **The scoring and board modules do not know the word.** A branch on
 *      "are we being measured" would be the whole failure in one line.
 *
 * Every walk is guarded against vacuity. A path typo that made a test scan zero
 * files would otherwise pass for ever, which is the classic way an architecture
 * test stops being one.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..', '..', '..', '..');
const WEB_SRC = resolve(HERE, '..', '..', '..');
/**
 * Two directories, and the difference matters.
 *
 * The import ban covers the whole benchmark tree, because a production module
 * reaching into *any* of it is the failure. The write ban covers this adapter
 * only: the other arm's files are somebody else's to police, and asserting over
 * them would fail this suite for an edit made in a different one.
 */
const BENCHMARK_DIR = resolve(HERE, '..');
const OWN_DIR = HERE;

const PRODUCTION_ROOTS = [
  join(REPO, 'packages', 'planner', 'src'),
  join(REPO, 'packages', 'compiler', 'src'),
  join(REPO, 'packages', 'core', 'src', 'scoring'),
  join(REPO, 'packages', 'core', 'src', 'discovery'),
  join(REPO, 'packages', 'core', 'src', 'recommend'),
  join(REPO, 'packages', 'core', 'src', 'quality'),
];

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === '.next') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/**
 * Source with its comments stripped.
 *
 * The convention the other architecture tests in this repository already follow:
 * a comment explaining why a module must never import the benchmark is the
 * reasoning worth keeping, and banning the words from prose would delete the
 * explanation along with the rule.
 */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

function importsOf(file: string): string[] {
  const specs: string[] = [];
  const pattern = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g;
  const source = code(file);
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) specs.push(match[1]!);
  return specs;
}

/**
 * Resolve an import to a file on disk.
 *
 * Workspace packages are resolved by hand rather than through Node, because the
 * closure has to walk *into* `@sidequest/core` — a leak that arrived through a
 * shared package would otherwise be invisible to a traversal that stopped at
 * every bare specifier.
 */
function resolveImport(spec: string, from: string): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = join(WEB_SRC, spec.slice(2));
  else if (spec.startsWith('.')) base = resolve(dirname(from), spec);
  else if (spec.startsWith('@sidequest/')) {
    const rest = spec.slice('@sidequest/'.length);
    const [pkg, ...tail] = rest.split('/');
    if (!pkg) return null;
    base = join(REPO, 'packages', pkg, 'src', ...(tail.length > 0 ? tail : []));
  } else return null;

  for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function closureOf(entry: string): Map<string, string[]> {
  const paths = new Map<string, string[]>([[entry, [entry]]]);
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop()!;
    const path = paths.get(file)!;
    for (const spec of importsOf(file)) {
      const target = resolveImport(spec, file);
      if (!target || paths.has(target)) continue;
      paths.set(target, [...path, target]);
      stack.push(target);
    }
  }
  return paths;
}

describe('the benchmark adapter cannot alter production', () => {
  const productionFiles = PRODUCTION_ROOTS.flatMap((root) => walk(root)).filter(
    (file) => !file.endsWith('.test.ts') && !file.endsWith('.test.tsx'),
  );

  it('scans a plausible number of production modules', () => {
    // The vacuity guard. Without it, a wrong path makes every assertion below
    // pass by scanning nothing at all.
    expect(productionFiles.length).toBeGreaterThan(20);
    for (const root of PRODUCTION_ROOTS) {
      expect(walk(root).length, root).toBeGreaterThan(0);
    }
  });

  it('resolves imports across workspace packages, so the closure is real', () => {
    // The second vacuity guard, and the more important one: a traversal that
    // resolved nothing would report an empty closure and a clean bill of health.
    const planner = join(REPO, 'packages', 'planner', 'src', 'plan.ts');
    const closure = closureOf(planner);
    expect(closure.size).toBeGreaterThan(5);
    expect([...closure.keys()].some((file) => file.includes(join('packages', 'core')))).toBe(true);
  });

  it('never imports anything under the benchmark directory', () => {
    const offenders: string[] = [];
    for (const file of productionFiles) {
      for (const [reached, path] of closureOf(file)) {
        if (reached.startsWith(BENCHMARK_DIR)) {
          offenders.push(path.map((step) => step.slice(REPO.length + 1)).join(' → '));
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('the adapter writes nothing the product owns', () => {
  /**
   * The writes a benchmark must never make, by name.
   *
   * Each one would let this arm hand itself an outcome: a plan it saved rather
   * than produced, a selection it chose rather than let auto-pick choose, a scope
   * it confirmed without the confirmation rule, a stage observation that would
   * pollute the estimator's history with synthetic runs, a compiled region it
   * assembled instead of compiling.
   */
  const FORBIDDEN = [
    'saveItinerary(',
    'saveReadiness(',
    'replaceAutoSelections(',
    'setSelection(',
    'saveScope(',
    'recordStageObservation(',
    'saveCompiledRegion',
  ];

  const ownFiles = walk(OWN_DIR);

  it('has files to check', () => {
    expect(ownFiles.length).toBeGreaterThan(3);
  });

  it('contains none of the forbidden writes', () => {
    const offenders: string[] = [];
    for (const file of ownFiles) {
      if (file.endsWith('architecture.test.ts')) continue;
      const source = code(file);
      for (const token of FORBIDDEN) {
        if (source.includes(token)) offenders.push(`${file.slice(REPO.length + 1)}: ${token}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('never switches the live provider stack on', () => {
    // A benchmark that set `SIDEQUEST_COMPILER_PROVIDER=open` would spend real
    // money against volunteer-run services on every run of the test suite.
    for (const file of ownFiles) {
      if (file.endsWith('architecture.test.ts')) continue;
      expect(code(file)).not.toContain('SIDEQUEST_COMPILER_PROVIDER');
    }
  });
});

describe('the planner is unchanged by the existence of a benchmark', () => {
  /**
   * Every field `planTrip` reads off its parameter object.
   *
   * Snapshotted rather than described, because the cheapest imaginable way to
   * make this arm look better would be to widen this object by one field and
   * feed it something the other arm never received. A change here is a change to
   * the contract under test, and it should cost a deliberate edit to this list.
   */
  const EXPECTED_KEYS = [
    'access',
    'baseId',
    'basePortfolio',
    'basics',
    'candidates',
    'config',
    'food',
    'foodSelections',
    'generatedAt',
    'hours',
    'matrix',
    'now',
    'profile',
    'region',
    'selections',
    'tripId',
    'weather',
  ];

  it('reads exactly the inputs it read before', () => {
    const source = code(join(REPO, 'packages', 'planner', 'src', 'plan.ts'));
    const keys = new Set<string>();
    const pattern = /\binput\.([A-Za-z_$][\w$]*)/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source))) keys.add(match[1]!);

    expect(keys.size).toBeGreaterThan(10);
    expect([...keys].sort()).toEqual(EXPECTED_KEYS);
  });
});

describe('scoring and the board have never heard of a benchmark', () => {
  const FILES = [
    join(REPO, 'packages', 'core', 'src', 'scoring', 'fit.ts'),
    join(REPO, 'packages', 'core', 'src', 'discovery', 'board.ts'),
  ];

  it('contains no benchmark token', () => {
    for (const file of FILES) {
      expect(existsSync(file), file).toBe(true);
      // Read raw rather than comment-stripped: a branch on "are we being
      // measured" hiding in a string literal is exactly as bad as one in code,
      // and neither of these two files has any reason to mention the word.
      expect(readFileSync(file, 'utf8').toLowerCase()).not.toContain('benchmark');
    }
  });
});
