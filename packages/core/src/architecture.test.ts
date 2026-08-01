import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * THE GUARDRAILS THAT KEEP THE ENGINE GENERIC.
 *
 * Sidequest has one authored region and is meant to have any number. The failure
 * mode is not dramatic — nobody sets out to hard-code Mammoth Lakes into a
 * scoring function. It happens one convenience at a time: a barrel export here, a
 * magic tag there, a sentence of copy that names a highway. Each is defensible
 * alone and together they are a product that only works in one valley.
 *
 * So the rules are enforced rather than agreed. Every check below has a named
 * exception list, and adding to one is a decision somebody has to write down.
 */

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/** Packages that must work for any destination on earth. */
const GENERIC_ROOTS = [
  'packages/core/src',
  'packages/geo/src',
  'packages/planner/src',
  'packages/compiler/src',
];

/**
 * Where region-specific material is allowed to live.
 *
 * `data/` is the seed region itself. `testing/` holds the harnesses that build
 * scenarios from it. Test files may name anything they assert on — a regression
 * test for the golden fixture that could not say "Mammoth" would be useless.
 */
const ALLOWED_PATTERNS = [
  /packages\/core\/src\/data\//,
  /packages\/core\/src\/testing\//,
  /packages\/planner\/src\/testing\//,
  /\.test\.ts$/,
];

/**
 * Identifiers from the one authored region.
 *
 * Matched case-insensitively against **code**, with comments stripped first: a
 * comment explaining that "the Eastern Sierra is a corridor and Tokyo is not" is
 * exactly the kind of reasoning this repository wants written down, and banning
 * the word from prose would delete it.
 */
const FIXTURE_IDENTIFIERS = [
  'mammoth',
  'eastern sierra',
  'eastern-sierra',
  'easternSierra',
  'EASTERN_SIERRA',
  'june lake',
  'mono lake',
  'convict lake',
  'hot creek',
  'reds meadow',
  'devils postpile',
  'rainbow falls',
  'minaret',
  'manzanar',
  'obsidian dome',
  'wild willy',
  'inyo',
  'bishop',
  'bodie',
  'us-395',
  'highway 395',
];

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (full.endsWith('.ts') || full.endsWith('.tsx')) {
      out.push(full);
    }
  }
  return out;
}

function relative(path: string): string {
  return path.slice(ROOT.length).replace(/^\/+/, '');
}

/**
 * Code with comments and string-free of prose removed.
 *
 * Block and line comments go; string literals stay, because a hard-coded region
 * name in a user-facing sentence is precisely the thing being looked for.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

function genericFiles(): string[] {
  return GENERIC_ROOTS.flatMap((root) => walk(join(ROOT, root))).filter(
    (path) => !ALLOWED_PATTERNS.some((pattern) => pattern.test(relative(path))),
  );
}

describe('the generic engine stays generic', () => {
  it('has files to check, so a broken path cannot make this suite vacuous', () => {
    // Without this, a renamed directory turns every check below into a
    // green tick over an empty list.
    expect(genericFiles().length).toBeGreaterThan(40);
  });

  it('never mentions the seed region in runtime code', () => {
    const offenders: string[] = [];
    for (const path of genericFiles()) {
      const code = stripComments(readFileSync(path, 'utf8'));
      for (const identifier of FIXTURE_IDENTIFIERS) {
        if (code.toLowerCase().includes(identifier.toLowerCase())) {
          offenders.push(`${relative(path)} mentions "${identifier}"`);
        }
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('never imports the seed data from generic code', () => {
    const offenders: string[] = [];
    for (const path of genericFiles()) {
      const source = readFileSync(path, 'utf8');
      // Both spellings: the package subpath, and a relative hop into `data/`.
      if (/from\s+'@sidequest\/core\/data'/.test(source)) {
        offenders.push(`${relative(path)} imports @sidequest/core/data`);
      }
      if (/from\s+'\.\.?\/(\.\.\/)*data\//.test(source)) {
        offenders.push(`${relative(path)} imports a data/ module`);
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('does not re-export the seed region from the engine package root', () => {
    const barrel = readFileSync(join(ROOT, 'packages/core/src/index.ts'), 'utf8');
    expect(stripComments(barrel)).not.toMatch(/from\s+'\.\/data/);
  });

  it('keeps geo free of every other package', () => {
    for (const path of walk(join(ROOT, 'packages/geo/src'))) {
      const source = readFileSync(path, 'utf8');
      expect(source, relative(path)).not.toMatch(/from\s+'@sidequest\//);
    }
  });

  it('keeps the planner free of provider and network code', () => {
    for (const path of walk(join(ROOT, 'packages/planner/src'))) {
      if (/\.test\.ts$/.test(path)) continue;
      const code = stripComments(readFileSync(path, 'utf8'));
      expect(code, `${relative(path)} performs I/O`).not.toMatch(/\bfetch\s*\(/);
      expect(code, `${relative(path)} reads the environment`).not.toMatch(/process\.env/);
    }
  });

  it('never lets a URL field accept a javascript: or data: scheme', () => {
    /**
     * `z.string().url()` accepts `javascript:alert(1)`. Every URL in the product
     * is a hand-written constant today, so that has never mattered — and the
     * moment a compiled region can author a `sourceUrl` from somebody else's
     * page, each of those fields is an `href` an attacker controls, stored in
     * the database and rendered back.
     */
    const offenders: string[] = [];
    for (const path of walk(join(ROOT, 'packages/core/src/schemas'))) {
      const code = stripComments(readFileSync(path, 'utf8'));
      if (path.endsWith('common.ts')) continue;
      if (/z\.string\(\)\.url\(\)/.test(code)) {
        offenders.push(`${relative(path)} uses z.string().url() instead of httpUrlSchema`);
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});
