import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * THE BASELINE CANNOT REACH SIDEQUEST'S PLANNER.
 *
 * The experiment is a comparison between a deterministic pipeline and a
 * language model given good data. It is void the moment the second one is
 * quietly using the first one's engines — and the way that happens is not
 * somebody deciding to cheat. It is somebody needing to group places by
 * proximity, noticing that `clusterByTravelTime` exists and is exported from a
 * barrel, and importing it in one line that reviews perfectly well.
 *
 * So the ban is checked two ways, because either alone has a hole:
 *
 * **By module path**, over the transitive local import closure. A file this
 * directory imports, which imports a file that imports the planner, is just as
 * fatal as importing it here — and a path check that only looked at this
 * directory's own imports would miss it.
 *
 * **By imported symbol.** `@sidequest/core` is allowed and necessary: solar
 * geometry, operating-hours resolution and the pricing table all live in it. But
 * that same barrel re-exports `autoSelect`, `scorePlace`, `selectBases` and
 * `distributeNights`, which are four of the things under test. A path ban on
 * `@sidequest/core` would be unworkable; a symbol ban is exact.
 *
 * The last test is the one that keeps this file honest. A walk that resolves
 * nothing passes every assertion above it, silently, for ever. So the helpers
 * are pointed at material that *should* trip them, and the file fails if they do
 * not.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_SRC = resolve(HERE, '..', '..', '..');

/** Packages this arm may not reach at all, at any depth. */
const FORBIDDEN_PACKAGES = ['@sidequest/planner', '@sidequest/geo'];

/**
 * Names that may not appear in an import clause anywhere in the closure.
 *
 * The planner and geo entries are belt and braces — the package ban already
 * covers them — and they are listed because a future refactor that moved one of
 * these into `@sidequest/core` would otherwise silently unban it.
 */
const FORBIDDEN_SYMBOLS = [
  // Selection and the discovery board.
  'autoSelect',
  'buildDiscoveryBoard',
  'admitToBoard',
  'partitionBoardPlaces',
  'scorePlace',
  'assessCandidateQuality',
  // Bases, routing and nights.
  'selectBases',
  'planRouting',
  'orderRoute',
  'distributeNights',
  'rankForRouting',
  // The scheduler.
  'planTrip',
  'layoutDay',
  'packDay',
  'assignToDays',
  'reviseDayPlans',
  'validateItinerary',
  'scheduleUnits',
  'buildDay',
  // The clusterer.
  'clusterByTravelTime',
  'orderStops',
];

/**
 * Source with comments removed.
 *
 * The same rule the other architecture tests here follow: the prose explaining
 * *why* this arm does not use `clusterByTravelTime` is worth keeping, and a scan
 * that read it as a violation would delete the explanation along with the rule.
 */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

function resolveImport(spec: string, from: string): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = join(WEB_SRC, spec.slice(2));
  else if (spec.startsWith('.')) base = resolve(dirname(from), spec);
  else return null; // A package. Covered by the specifier checks below.

  for (const candidate of [
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function specifiersOf(source: string): string[] {
  const specs: string[] = [];
  const pattern = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) specs.push(match[1]!);
  return specs;
}

/**
 * Every name an import clause binds, from any of the forms that appear here:
 * a named list, an aliased name, a namespace, a default, and `import type`.
 */
function importedNames(source: string): string[] {
  const names: string[] = [];
  const pattern = /import\s+(?:type\s+)?([\s\S]*?)\s+from\s*['"][^'"]+['"]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) {
    const clause = match[1]!;
    const braced = /\{([\s\S]*?)\}/.exec(clause);
    if (braced) {
      for (const entry of braced[1]!.split(',')) {
        const original = entry.includes(' as ') ? entry.split(' as ')[0] : entry;
        const name = (original ?? '').replace(/\btype\b/g, '').trim();
        if (name) names.push(name);
      }
    }
    const bare = clause.replace(/\{[\s\S]*?\}/g, '').replace(/,/g, ' ').trim();
    for (const token of bare.split(/\s+/)) {
      if (token && token !== '*' && token !== 'as' && token !== 'type') names.push(token);
    }
  }
  return names;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const ENTRY_MODULES = walk(HERE).filter((file) => !/\.test\.tsx?$/.test(file));

/** Every local module reachable from this directory, with the path that got there. */
function closureOf(entries: readonly string[]): Map<string, string[]> {
  const paths = new Map<string, string[]>();
  const stack: string[] = [];
  for (const entry of entries) {
    paths.set(entry, [entry]);
    stack.push(entry);
  }
  while (stack.length > 0) {
    const file = stack.pop()!;
    const path = paths.get(file)!;
    for (const spec of specifiersOf(code(file))) {
      const target = resolveImport(spec, file);
      if (!target || paths.has(target)) continue;
      paths.set(target, [...path, target]);
      stack.push(target);
    }
  }
  return paths;
}

const CLOSURE = closureOf(ENTRY_MODULES);

function relative(file: string): string {
  return file.slice(WEB_SRC.length + 1);
}

describe('the baseline arm', () => {
  it('has a closure worth checking, so a broken walk cannot pass by finding nothing', () => {
    expect(ENTRY_MODULES.length).toBeGreaterThanOrEqual(10);
    expect(CLOSURE.size).toBeGreaterThan(ENTRY_MODULES.length);

    const names = [...CLOSURE.keys()].map(relative);
    // The modules whose absence would mean the walk resolved nothing useful.
    expect(names).toContain('lib/benchmark/baseline/orchestrate.ts');
    expect(names).toContain('lib/benchmark/baseline/generate.ts');
    // And proof the walk crosses out of this directory, which is where the
    // interesting violations would hide.
    expect(names.some((name) => name.startsWith('lib/providers/'))).toBe(true);
  });

  it('reaches no forbidden package, by any path', () => {
    const violations: string[] = [];
    for (const [file, path] of CLOSURE) {
      for (const spec of specifiersOf(code(file))) {
        for (const banned of FORBIDDEN_PACKAGES) {
          if (spec === banned || spec.startsWith(`${banned}/`)) {
            violations.push(`${path.map(relative).join(' -> ')} imports ${spec}`);
          }
        }
      }
    }
    expect(violations.sort()).toEqual([]);
  });

  it('imports no forbidden symbol, from anywhere', () => {
    const violations: string[] = [];
    for (const [file, path] of CLOSURE) {
      const names = new Set(importedNames(code(file)));
      for (const banned of FORBIDDEN_SYMBOLS) {
        if (names.has(banned)) {
          violations.push(`${path.map(relative).join(' -> ')} imports ${banned}`);
        }
      }
    }
    expect(violations.sort()).toEqual([]);
  });

  /**
   * The clusterer is the single most tempting one, so it is named as well as
   * banned: a reintroduction fails with a message somebody can act on rather
   * than with a path dump.
   */
  it('groups places with arithmetic it owns rather than with the clusterer under test', () => {
    const packet = code(join(HERE, 'packet.ts'));
    expect(packet).not.toMatch(/clusterByTravelTime|orderStops|@sidequest\/geo/);
    // The positive half: the grid is here, in this file, in plain sight.
    expect(packet).toMatch(/GRID_DIVISIONS/);
    expect(packet).toMatch(/function cellFor/);
  });

  /**
   * NON-VACUITY.
   *
   * Every assertion above is of the form "this set is empty", and a helper that
   * silently returns nothing satisfies all of them. So the same helpers are run
   * against material that must trip them. If this test ever passes trivially,
   * the three above are decoration.
   */
  it('would actually catch a violation', () => {
    const hostile = [
      "import { planTrip } from '@sidequest/planner';",
      "import { clusterByTravelTime } from '@sidequest/geo';",
      "import { scorePlace, autoSelect as pick } from '@sidequest/core';",
      "import type { Something } from '@sidequest/planner/types';",
    ].join('\n');

    const specs = specifiersOf(hostile);
    expect(
      specs.filter((spec) =>
        FORBIDDEN_PACKAGES.some((banned) => spec === banned || spec.startsWith(`${banned}/`)),
      ),
    ).toHaveLength(3);

    const names = new Set(importedNames(hostile));
    expect(names.has('planTrip')).toBe(true);
    expect(names.has('clusterByTravelTime')).toBe(true);
    expect(names.has('scorePlace')).toBe(true);
    // Aliased away and still caught, which is the case a naive scan misses.
    expect(names.has('autoSelect')).toBe(true);

    // And the resolver really resolves: a real neighbour, found by path.
    expect(resolveImport('./packet-types', join(HERE, 'packet.ts'))).toBe(
      join(HERE, 'packet-types.ts'),
    );
  });
});
