#!/usr/bin/env node
/**
 * THE EXECUTED-SOURCE HASH, AS A DEFINITION RATHER THAN AS A HABIT.
 *
 * Five stability gates in this repository's history recorded a sixteen-character
 * hash before the first browser run and after the third, and asserted the two
 * matched. **The method was never written down.** There is no script, no npm
 * task and no note that says which files were hashed, in what order, or with
 * what algorithm — so every recorded value is uncomparable with anything anybody
 * can compute today, and reproducing the gate meant inventing a definition and
 * hoping it was the same one.
 *
 * That is a verification failure in the same family as the one this repository
 * already records about `tail -6` swallowing a failure count: the number looked
 * like evidence and was not checkable.
 *
 * So the definition lives here, in code, and the answer changes if any of it
 * changes:
 *
 * - **What counts as executed source.** Everything under `apps/*` and
 *   `packages/*` that TypeScript or the bundler can reach, plus the test and
 *   configuration files that decide what runs: `e2e/`, the Playwright and Vitest
 *   configs, the ESLint config, and every `package.json` in the workspace. Not
 *   `node_modules`, not build output, not the databases a run creates, not
 *   anything under `.claude-private`, and not this file — a gate that changed
 *   its own answer by existing would be worse than none.
 * - **Order.** Paths are sorted, so the hash is a property of the tree rather
 *   than of the order a directory walk happened to return.
 * - **Content and path both.** The relative path is hashed alongside the bytes,
 *   so moving a file changes the answer. A rename that preserved every byte is a
 *   change to what executes.
 * - **Algorithm.** SHA-256 over the concatenated per-file digests, truncated to
 *   sixteen hex characters for legibility. Truncation is safe here because this
 *   is a change detector between two runs minutes apart, not a security
 *   boundary.
 *
 * Usage: `node scripts/source-hash.mjs` prints the hash and nothing else.
 * `--verbose` also prints the file count, which is the number to check when a
 * hash changes unexpectedly: a moved ignore rule shows up as a count change
 * long before anybody works out why the digest moved.
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

/** Directories never descended into. Build output and dependencies are not source. */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.next',
  '.turbo',
  'dist',
  'build',
  'coverage',
  'test-results',
  'playwright-report',
  '.claude-private',
  '.claude',
  'data',
]);

/** Extensions that decide what executes. */
const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.css', '.json'];

/** Roots walked. Everything outside them is not part of what a run executes. */
const ROOTS = ['apps', 'packages', 'e2e', 'scripts'];

/** Individually named files at the repository root that decide what runs. */
const ROOT_FILES = [
  'package.json',
  'package-lock.json',
  'tsconfig.base.json',
  'vitest.config.ts',
  'vitest.server-only.ts',
  'playwright.config.ts',
  'playwright.config.test.ts',
  'eslint.config.mjs',
];

/**
 * This file, excluded from its own answer.
 *
 * Editing the hasher would otherwise change the hash, which makes "nothing was
 * touched between the runs" unprovable at exactly the moment somebody is trying
 * to prove it.
 */
const SELF = 'scripts/source-hash.mjs';

function walk(directory, out) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.eslintrc') continue;
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full, out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!EXTENSIONS.some((extension) => entry.name.endsWith(extension))) continue;
    out.push(full);
  }
}

const files = [];
for (const root of ROOTS) {
  try {
    if (statSync(join(ROOT, root)).isDirectory()) walk(join(ROOT, root), files);
  } catch {
    /* A root that does not exist contributes nothing rather than throwing. */
  }
}
for (const name of ROOT_FILES) {
  try {
    if (statSync(join(ROOT, name)).isFile()) files.push(join(ROOT, name));
  } catch {
    /* Same. */
  }
}

const relatives = files
  .map((file) => relative(ROOT, file).split(sep).join('/'))
  .filter((file) => file !== SELF)
  .sort();

const digest = createHash('sha256');
for (const file of relatives) {
  const bytes = readFileSync(join(ROOT, file));
  digest.update(createHash('sha256').update(file).update('\0').update(bytes).digest());
}

const hash = digest.digest('hex').slice(0, 16);
if (process.argv.includes('--verbose')) {
  process.stdout.write(`${hash}  ${relatives.length} files\n`);
} else {
  process.stdout.write(`${hash}\n`);
}
