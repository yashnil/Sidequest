import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { COMPILATION_STAGES, STAGE_REGISTRY } from '@sidequest/core';
import { FORBIDDEN_TOKENS, forbiddenTokensIn } from '@/lib/benchmark/vocabulary';

/**
 * NOT ONE BANNED WORD IN THE BLIND SURFACE.
 *
 * A source scan over every module the comparison renders. It is the cheap half
 * of the guarantee — the browser suite reads the whole response body, which
 * catches the serialised payload and anything that arrives at run time — and it
 * is the half that fails in a second on somebody's machine rather than thirteen
 * minutes into a browser run.
 *
 * Two things are checked and the second is the less obvious one.
 *
 * **No banned token in any string literal or JSX text.** Not in the whole file:
 * `import { seededEntropy } from '@sidequest/bench'` contains a product name and
 * is completely harmless, so import statements are stripped before the literals
 * are collected. An identifier is not a leak; a rendered string is.
 *
 * **No import of the product's own display vocabulary.** `EvidenceBadge` renders
 * the word "Provisional". `PLACE_CATEGORY_LABELS` and `FIT_BAND_LABELS` are one
 * competitor's nouns for things the other has no name for. `PlaceName` renders
 * an English-first display name with a native form beside it — a good rule, and
 * one system's rule. Importing any of them would label a plan in its maker's own
 * words without a single banned token appearing anywhere.
 *
 * The test files in this directory are excluded, and have to be: this one has to
 * contain the words it is banning in order to prove the scan works at all.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_SRC = resolve(HERE, '..', '..');
const SCANNED = [join(WEB_SRC, 'app', 'labs'), join(WEB_SRC, 'components', 'benchmark')];

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/**
 * Source with its comments removed.
 *
 * The idiom `render-purity.architecture.test.ts` uses, for the same reason: the
 * comments in these modules explain *why* a word is banned and name several of
 * them while doing it. Banning the words from prose would delete the explanation
 * along with the risk.
 */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

/** The body, with import statements taken out. Module specifiers are not copy. */
function withoutImports(source: string): string {
  return source.replace(/import\s+[\s\S]*?\s+from\s*['"][^'"]+['"];?/g, '');
}

/** Every quoted string, and every run of text sitting between JSX tags. */
export function renderedText(source: string): string[] {
  const body = withoutImports(source);
  const found: string[] = [];

  const literals = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g;
  let match: RegExpExecArray | null;
  while ((match = literals.exec(body))) {
    const value = match[1] ?? match[2] ?? match[3] ?? '';
    if (value.length > 0) found.push(value);
  }

  const jsxText = />([^<>{}]+)</g;
  while ((match = jsxText.exec(body))) {
    const value = (match[1] ?? '').trim();
    if (value.length > 0) found.push(value);
  }

  return found;
}

const FILES = SCANNED.flatMap((dir) => walk(dir));

/** The short tokens a file matches on a word boundary, read out of its source. */
function wordBoundarySet(source: string): string[] {
  const declaration = /WORD_BOUNDARY_TOKENS\s*=\s*new Set\(\[([\s\S]*?)\]\)/.exec(source);
  if (declaration === null) return [];
  return [...(declaration[1] ?? '').matchAll(/'([^']+)'/g)]
    .map((match) => match[1] ?? '')
    .sort();
}

/** The product's own nouns, by the name they are imported under. */
const PRODUCT_VOCABULARY = [
  'PLACE_CATEGORY_LABELS',
  'FIT_BAND_LABELS',
  'stageLabel',
  'EvidenceBadge',
  'FitMeter',
  'PlacePlate',
  'PlaceName',
  'COMPILATION_ERROR_COPY',
];

describe('the blind comparison surface', () => {
  it('is not empty, so a broken walk cannot pass by finding nothing', () => {
    expect(FILES.length).toBeGreaterThan(10);
    const names = FILES.map((file) => file.slice(WEB_SRC.length + 1));
    expect(names).toContain('components/benchmark/NeutralPlanView.tsx');
    expect(names).toContain('components/benchmark/ReviewSurface.tsx');
    expect(names).toContain('app/labs/benchmark/[sessionId]/review/page.tsx');
    expect(names).toContain('app/labs/benchmark/[sessionId]/run/page.tsx');
  });

  it('collects a real amount of text, so an empty extractor cannot pass', () => {
    const total = FILES.flatMap((file) => renderedText(code(file))).length;
    expect(total).toBeGreaterThan(200);
  });

  it('contains no forbidden token in anything it renders', () => {
    const violations: string[] = [];
    for (const file of FILES) {
      for (const text of renderedText(code(file))) {
        for (const token of forbiddenTokensIn(text)) {
          violations.push(`${file.slice(WEB_SRC.length + 1)}: "${token}" in ${text.slice(0, 80)}`);
        }
      }
    }
    expect([...new Set(violations)].sort()).toEqual([]);
  });

  it('borrows none of the product’s own display vocabulary', () => {
    const violations: string[] = [];
    for (const file of FILES) {
      const source = code(file);
      for (const name of PRODUCT_VOCABULARY) {
        const imported = new RegExp(`\\b${name}\\b`);
        if (imported.test(source)) {
          violations.push(`${file.slice(WEB_SRC.length + 1)} uses ${name}`);
        }
      }
    }
    expect([...new Set(violations)].sort()).toEqual([]);
  });

  /**
   * THE BROWSER SUITE'S COPY OF THE LIST, KEPT HONEST.
   *
   * `e2e/support/benchmark.ts` cannot import the canonical vocabulary: it is
   * loaded by Playwright, and Playwright's loader will not link a TypeScript
   * entry point reached through a workspace symlink — which is how
   * `@sidequest/core` resolves. So the curated half of the list is copied there,
   * and a copy that nobody compares is a copy that silently narrows.
   *
   * Compared as text rather than by import, because the two files are loaded by
   * two different runners and this one is the only place both can be read. Add a
   * word to the canonical list and forget the browser suite, and this fails in a
   * second with the word in the message.
   */
  describe('the browser suite mirrors the same vocabulary', () => {
    const MIRROR = resolve(WEB_SRC, '..', '..', '..', 'e2e', 'support', 'benchmark.ts');
    const mirror = readFileSync(MIRROR, 'utf8');
    const derived = new Set<string>([
      ...COMPILATION_STAGES.map((stage) => stage.toLowerCase()),
      ...STAGE_REGISTRY.map((stage) => stage.label.toLowerCase()),
    ]);

    it('copies every curated word', () => {
      const missing = FORBIDDEN_TOKENS.filter(
        (token) => !derived.has(token) && !mirror.includes(`'${token}'`),
      );
      expect(missing).toEqual([]);
    });

    it('derives the stage names rather than copying them', () => {
      expect(mirror).toMatch(/COMPILATION_STAGES/);
      expect(mirror).toMatch(/STAGE_REGISTRY/);
    });

    it('applies the same word-boundary rule', () => {
      const canonical = wordBoundarySet(readFileSync(join(WEB_SRC, 'lib/benchmark/vocabulary.ts'), 'utf8'));
      expect(canonical.length).toBeGreaterThan(0);
      expect(wordBoundarySet(mirror)).toEqual(canonical);
    });
  });

  /**
   * THE NEGATIVE CONTROL.
   *
   * A scanner that silently stopped matching would pass every assertion above
   * for ever, and a leakage test that cannot fail is worse than no test because
   * it reads as one. So the same extractor and the same predicate are pointed at
   * a module that leaks in each of the three ways that matter, and each has to
   * be caught.
   */
  describe('the scan itself can fail', () => {
    const leaky = [
      "const label = 'Built by Sidequest';",
      'function Panel() { return <p>This plan is deterministic.</p>; }',
      "const note = `a hidden gem worth a detour`;",
    ].join('\n');

    it('catches a name in a string literal', () => {
      const caught = renderedText(leaky).flatMap((text) => forbiddenTokensIn(text));
      expect(caught).toContain('sidequest');
    });

    it('catches an architecture word in JSX text', () => {
      const caught = renderedText(leaky).flatMap((text) => forbiddenTokensIn(text));
      expect(caught).toContain('deterministic');
    });

    it("catches the product's own nouns", () => {
      const caught = renderedText(leaky).flatMap((text) => forbiddenTokensIn(text));
      expect(caught).toContain('hidden gem');
      expect(caught).toContain('worth a detour');
    });

    it('does not fire on a module specifier, which is not copy', () => {
      const harmless = "import { drawAssignment } from '@sidequest/bench';\nconst x = 1;";
      const caught = renderedText(harmless).flatMap((text) => forbiddenTokensIn(text));
      expect(caught).toEqual([]);
    });
  });
});

/* ------------------------------------------------------------------ *
 * A React key is not a private field
 * ------------------------------------------------------------------ */

/**
 * NOTHING BINDS A PRODUCING SYSTEM INTO A `key`.
 *
 * The cross-session totals page mapped over `PRODUCING_SYSTEMS` with
 * `key={system}` in ten places. Nothing rendered it — and React serialises the
 * key into the flight payload regardless, so the page carried both system names
 * forty-six times while displaying neutral placeholders, on a route two clicks
 * from every blind screen.
 *
 * The offline token scan could not see it, because the names arrive as an
 * imported constant rather than as a string literal. A browser assertion could
 * not be made reliable either, because the browser suite shares one database and
 * earlier specs deliberately reveal sessions — after which the names are the
 * reviewer's own knowledge and printing them is correct.
 *
 * So the guarantee is stated as the structural rule it actually is: a key may
 * not be an expression that evaluates to a producing system. The failure it
 * catches is the one that happened, and it catches it in the source rather than
 * three layers downstream.
 */
describe('what a React key may be bound to', () => {
  const FORBIDDEN_KEY_BINDINGS = [
    /key=\{\s*system\s*\}/,
    /key=\{\s*arm\s*\}/,
    /key=\{\s*producedBy\s*\}/,
    /key=\{\s*first\s*\}/,
  ];

  it('never keys a rendered element on a producing system', () => {
    const offenders: string[] = [];
    for (const dir of SCANNED) {
      for (const file of walk(dir)) {
        // Comments, stripped. The note explaining this rule names the shape it
        // forbids, and a check that fails on its own explanation teaches people
        // to delete the explanation.
        const source = code(file);
        for (const pattern of FORBIDDEN_KEY_BINDINGS) {
          if (pattern.test(source)) {
            offenders.push(`${file} keys an element on ${pattern.source}`);
          }
        }
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});
