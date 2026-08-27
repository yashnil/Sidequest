import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CANONICAL_DESTINATIONS, quarantinedNames } from './fixtures/canonical-subjects';

/**
 * THE FIXTURE MAY NOT LEAK INTO THE PRODUCT.
 *
 * This is the test that makes the canonical subject list safe to have. §4 is
 * explicit that the dense-metropolis failure must not be repaired with
 * destination-specific names or rules, and the most natural way to make a recall
 * gate pass is to feed its own answer key back into acquisition — a seed list, a
 * "known landmarks" boost, a hard-coded significance override. Every one of
 * those would turn the measurement into a mirror.
 *
 * So the rule is mechanical: **no production file may contain any name from the
 * fixture, and no production file may import the fixture module.** Test files
 * may, because a test that could not name what it asserts on would be useless.
 *
 * If this fails, the answer is never to add an exception. It is that the engine
 * has learned a place instead of learning to look.
 */

/** Six directories up from `apps/web/src/lib/iq/recall/`: the repository root. */
const ROOT = fileURLToPath(new URL('../../../../../..', import.meta.url));

/**
 * Everything that ships: every workspace package's source and the whole web
 * app, because the
 * leak this guards against is as likely in a copy line or a scoring table as in
 * a provider.
 */
const PRODUCTION_ROOTS = [
  join('apps', 'web', 'src'),
  join('packages', 'core', 'src'),
  join('packages', 'compiler', 'src'),
  join('packages', 'planner', 'src'),
  join('packages', 'geo', 'src'),
  join('packages', 'bench', 'src'),
];

/** The evaluation lives here and is the one place these names belong. */
const EVALUATION_DIR = join('apps', 'web', 'src', 'lib', 'iq');

/**
 * NAMED EXCEPTIONS, WHICH ARE DEBTS RATHER THAN PERMISSIONS.
 *
 * Same discipline as `packages/core/src/architecture.test.ts`: an exception is
 * allowed to exist and has to be written down, so that adding one is a decision
 * somebody makes rather than something that happens.
 *
 * `must-do.ts` names a Tokyo market twice, in documentation, as the worked
 * example for a sentence-splitting rule ("Tsukiji outer market and the old
 * Yanaka streets" splits; "Museum of Art and History" does not). It is inert —
 * a comment cannot influence acquisition — and it predates this fixture. It is
 * listed rather than deleted because this evaluation may not edit production
 * code; the right resolution is a one-word edit to that comment, at which point
 * this entry should go.
 */
const NAMED_EXCEPTIONS: Readonly<Record<string, readonly string[]>> = {
  [join('packages', 'compiler', 'src', 'must-do.ts')]: ['Tsukiji Outer Market'],
};

function sourceFiles(dir: string): string[] {
  const absolute = join(ROOT, dir);
  let entries: string[];
  try {
    entries = readdirSync(absolute);
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry);
    if (statSync(join(ROOT, path)).isDirectory()) {
      files.push(...sourceFiles(path));
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entry)) continue;
    if (entry.endsWith('.test.ts') || entry.endsWith('.test.tsx')) continue;
    if (path.startsWith(EVALUATION_DIR + sep)) continue;
    files.push(path);
  }
  return files;
}

const FILES = PRODUCTION_ROOTS.flatMap(sourceFiles);

/**
 * How a name is looked for.
 *
 * Word boundaries for Latin text, because a short alias would otherwise match
 * inside an unrelated identifier and a quarantine test that cries wolf is a
 * quarantine test somebody deletes. Plain containment for scripts with no word
 * boundaries to speak of.
 */
const WORD_CHARACTER = /[\p{L}\p{N}]/u;

function occurrencesOf(name: string, text: string): boolean {
  const latin = /^[\p{Script=Latin}\p{M}\p{N}\p{P}\s]+$/u.test(name);
  if (!latin) return text.includes(name);
  const haystack = text.toLowerCase();
  const needle = name.toLowerCase();
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return false;
    const before = at === 0 ? '' : haystack[at - 1]!;
    const after = haystack[at + needle.length] ?? '';
    if (!WORD_CHARACTER.test(before) && !WORD_CHARACTER.test(after)) return true;
    from = at + 1;
  }
}

describe('canonical subjects are quarantined to the evaluation', () => {
  it('has production code to check', () => {
    /*
     * The check above is a loop over a file list, and a loop over an empty list
     * passes. This is the assertion that the quarantine is looking at anything
     * at all — the failure mode a previous wave of this repository shipped
     * twice.
     */
    expect(FILES.length).toBeGreaterThan(200);
  });

  it('names no fixture subject anywhere in production code', () => {
    const names = quarantinedNames();
    expect(names.length).toBeGreaterThan(30);

    const violations: string[] = [];
    for (const file of FILES) {
      const text = readFileSync(join(ROOT, file), 'utf8');
      const allowed = NAMED_EXCEPTIONS[file] ?? [];
      for (const name of names) {
        if (allowed.includes(name)) continue;
        if (occurrencesOf(name, text)) violations.push(`${file}: "${name}"`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('keeps every named exception real, so the list cannot rot', () => {
    /*
     * An exception whose file no longer contains the name is a dead licence,
     * and dead licences accumulate until nobody knows which ones matter. This
     * fails when the debt has been paid, which is the moment to delete it.
     */
    const stale: string[] = [];
    for (const [file, names] of Object.entries(NAMED_EXCEPTIONS)) {
      const text = readFileSync(join(ROOT, file), 'utf8');
      for (const name of names) {
        if (!occurrencesOf(name, text)) stale.push(`${file}: "${name}"`);
      }
    }
    expect(stale).toEqual([]);
  });

  it('is imported by nothing that ships', () => {
    const violations: string[] = [];
    for (const file of FILES) {
      const text = readFileSync(join(ROOT, file), 'utf8');
      if (/from\s+['"][^'"]*iq\/recall/.test(text)) violations.push(file);
    }
    expect(violations).toEqual([]);
  });

  it('covers destinations of genuinely different shapes', () => {
    /*
     * §29 opens with "do not judge global quality from one destination", and a
     * fixture holding three metropolises would satisfy the letter of a recall
     * gate while proving nothing about a road region. The shapes are asserted
     * rather than trusted.
     */
    const shapes = new Set(
      Object.values(CANONICAL_DESTINATIONS).map((destination) => destination.shape),
    );
    expect(shapes.size).toBeGreaterThanOrEqual(3);
    expect(
      Object.values(CANONICAL_DESTINATIONS).every((destination) => destination.subjects.length >= 10),
    ).toBe(true);
  });

  it('declares where each subject’s source presence came from', () => {
    /*
     * Stage one of the report is "published by the source". An unlabelled
     * fixture would let the gate assert a product failed to find something
     * nobody publishes, which is a lie in the product's disfavour. Every subject
     * has to say which it is.
     */
    const undeclared = Object.values(CANONICAL_DESTINATIONS).flatMap((destination) =>
      destination.subjects.filter(
        (subject) => subject.sourceEvidence !== 'probed' && subject.sourceEvidence !== 'expected',
      ),
    );
    expect(undeclared).toEqual([]);
  });
});
