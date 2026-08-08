import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIELD_TIERS, STATED_TO_BOTH_FIELDS } from './schemas/request';

/**
 * THE NEUTRALITY OF THE NEUTRAL PACKAGE, ASSERTED RATHER THAN INTENDED.
 *
 * Everything in `@sidequest/bench` is supposed to be system-independent: the
 * shared request both planners receive, the plan shape both convert into, the
 * validators that inspect both, the fingerprint that decides what "structurally
 * equivalent" means. If any of it could reach the deterministic scheduler, the
 * candidate selector, the route clusterer or the revision engine, then one
 * competitor would be graded partly against its own contract and the whole
 * exercise would be measuring agreement rather than usefulness.
 *
 * The package's dependency list already makes most of that true — it names
 * neither `@sidequest/planner` nor `@sidequest/geo`. But a dependency list is a
 * statement about what resolves, and the interesting failure is subtler: all
 * three package barrels do `export *`, so a single line importing the wrong
 * symbol from a package that *is* a dependency would compile, run, and look
 * ordinary in review.
 *
 * So this file checks three things a package.json cannot:
 *
 * 1. no module here imports either forbidden package, by any specifier;
 * 2. no module here imports a forbidden *symbol* from any package;
 * 3. no module here reads a clock or a random number outside the one place
 *    permitted to, because a validator whose answer depends on the day, and an
 *    assignment that cannot be replayed, are both silent forms of unreliability.
 */

const ROOT = fileURLToPath(new URL('.', import.meta.url));

/** The engines under test. Importing one here would be grading a rival by its own rules. */
const FORBIDDEN_PACKAGES = ['@sidequest/planner', '@sidequest/geo'];

/**
 * Symbols that are reachable from `@sidequest/core` — a legitimate dependency —
 * and must never be reached.
 *
 * Every one is a piece of the deterministic planning stack: selection, scoring,
 * scheduling, clustering, base assignment, revision. A path-level ban would miss
 * all of them, because `packages/core/src/index.ts` re-exports the lot.
 */
const FORBIDDEN_SYMBOLS = [
  'autoSelect',
  'buildDiscoveryBoard',
  'admitToBoard',
  'partitionBoardPlaces',
  'scorePlace',
  'assessCandidateQuality',
  'selectBases',
  'planRouting',
  'orderRoute',
  'distributeNights',
  'rankForRouting',
  'clusterByTravelTime',
  'orderStops',
  'planTrip',
  'validateItinerary',
  'reviseDayPlans',
  'layoutDay',
  'packDay',
  'assignToDays',
  'scheduleUnits',
];

/**
 * Where non-determinism is allowed to live.
 *
 * `entropy.ts` exists precisely so that the answer to "what in this package can
 * be random?" is a filename rather than an audit. Everything else — including
 * every validator — must produce the same answer for the same inputs, or a plan
 * would score differently on a Tuesday and the comparison would be between two
 * afternoons rather than between two systems.
 */
const ENTROPY_MODULE = 'entropy.ts';

function walk(directory: string, out: string[] = []): string[] {
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/**
 * The file with its comments removed.
 *
 * Reasoning about a forbidden symbol is exactly what the prose in this package
 * is for — several files name `autoSelect` and `clusterByTravelTime` in order to
 * explain why they are not used. Banning the words would ban the explanation.
 */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

function sourceFiles(): string[] {
  return walk(ROOT).filter((file) => !file.endsWith('.test.ts'));
}

function relative(file: string): string {
  return file.slice(ROOT.length);
}

describe('the benchmark package cannot reach the engines it is meant to judge', () => {
  it('is guarding a real package rather than an empty directory', () => {
    // Without this, every assertion below passes trivially the day somebody
    // moves the source and forgets this file.
    expect(sourceFiles().length).toBeGreaterThan(10);
  });

  it('imports neither the scheduler package nor the geometry package', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const source = code(file);
      for (const pkg of FORBIDDEN_PACKAGES) {
        if (source.includes(pkg)) offenders.push(`${relative(file)} imports ${pkg}`);
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('imports no planning symbol from any package', () => {
    const offenders: string[] = [];
    const importPattern = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;

    for (const file of sourceFiles()) {
      const source = code(file);
      for (const match of source.matchAll(importPattern)) {
        const specifier = match[2] ?? '';
        // Only imports that cross a package boundary can reach the engines; a
        // relative import stays inside this package, which is the thing being
        // proved clean.
        if (specifier.startsWith('.')) continue;
        const named = (match[1] ?? '')
          .split(',')
          .map((entry) => entry.replace(/\btype\b/, '').split(' as ')[0]?.trim() ?? '')
          .filter(Boolean);
        for (const symbol of named) {
          if (FORBIDDEN_SYMBOLS.includes(symbol)) {
            offenders.push(`${relative(file)} imports ${symbol} from ${specifier}`);
          }
        }
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('reads no clock, so a plan scores the same on any day', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const source = code(file);
      if (/\bDate\.now\(\)/.test(source) || /new Date\(\s*\)/.test(source)) {
        offenders.push(`${relative(file)} reads the clock`);
      }
    }
    expect(
      offenders,
      `${offenders.join('\n')}\n\nThe instant a run is judged at is injected — see BenchmarkGroundTruth.now.`,
    ).toEqual([]);
  });

  it('draws randomness in exactly one module, and never from Math.random', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const source = code(file);
      if (/Math\.random\s*\(/.test(source)) {
        offenders.push(`${relative(file)} calls Math.random`);
      }
      if (/crypto\.getRandomValues|randomBytes|randomUUID/.test(source)) {
        if (!file.endsWith(ENTROPY_MODULE)) {
          offenders.push(`${relative(file)} reaches for entropy outside ${ENTROPY_MODULE}`);
        }
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('reaches no network and no filesystem', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const source = code(file);
      if (/\bfetch\s*\(/.test(source)) offenders.push(`${relative(file)} calls fetch`);
      if (/from ['"]node:fs['"]/.test(source)) offenders.push(`${relative(file)} reads the disk`);
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('declares neither forbidden package as a dependency', () => {
    const manifest = JSON.parse(
      readFileSync(join(ROOT, '..', 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> };
    const dependencies = Object.keys(manifest.dependencies ?? {});
    for (const pkg of FORBIDDEN_PACKAGES) {
      expect(dependencies, `${pkg} is a declared dependency`).not.toContain(pkg);
    }
  });
});

/**
 * THE PRE-REGISTERED DOCUMENT AND THE CODE IT DESCRIBES.
 *
 * `decision-rules.md` §7 has to disclose which request fields only one planner
 * can act on, because those fields are excluded from the head-to-head verdict.
 * That list was typed by hand and said eight; the table said fourteen. A
 * pre-registered document under-reporting the asymmetry it exists to disclose is
 * worse than one that never mentioned it, because the number is taken on trust.
 *
 * The list is generated now, and this is the test that keeps the document
 * honest: adding a `stated_to_both` field without updating the count breaks here
 * rather than silently making a frozen document wrong.
 */
describe('the disclosed asymmetry', () => {
  it('matches the count the pre-registered rules print', () => {
    expect(STATED_TO_BOTH_FIELDS).toHaveLength(14);
  });

  it('is derived from the tier table rather than written out beside it', () => {
    const fromTable = (Object.keys(FIELD_TIERS) as (keyof typeof FIELD_TIERS)[]).filter(
      (path) => FIELD_TIERS[path] === 'stated_to_both',
    );
    expect([...STATED_TO_BOTH_FIELDS].sort()).toEqual([...fromTable].sort());
  });

  it('covers every field of the request, so none is silently untiered', () => {
    const tiers = new Set(Object.values(FIELD_TIERS));
    expect([...tiers].sort()).toEqual(['both', 'stated_to_both']);
  });
});
