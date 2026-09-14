import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * EVERY COMPONENT THE SHARED KIT EXPORTS IS RENDERED SOMEWHERE.
 *
 * `ui.tsx` is the one file in the app whose exports are all *screen*: a
 * component here that nothing imports is not a spare part, it is a design
 * decision the product made and then stopped showing, and nothing in the build
 * says so. That is what happened to `FitMeterLegend` — the visible key
 * explaining what the fit meter's five dashes counted. The Discovery Board
 * rebuild moved the calibrated label onto the meter and dropped the legend's
 * only call site, so the component survived, typechecked, was covered by
 * nothing, and rendered nowhere. A reader looking for the key found no key; a
 * developer reading the source found a component that looked live.
 *
 * §37 asks for obsolete UI to be removed before a release judgement. This is
 * that rule, made mechanical: a component whose last consumer disappears fails
 * here, and the author then has to choose — render it again, or delete it.
 * Either answer is fine. Leaving it is what is not.
 *
 * Grep-based, the same trade `consumers.architecture.test.ts` makes in core: an
 * import-graph proof would be stronger and would also miss the case that
 * actually occurs, which is a component imported and then never placed. A
 * component named in a JSX tag somewhere is the closest cheap proxy for
 * "rendered", and it is what a reviewer would check by hand.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_SRC = resolve(HERE, '..');
const KIT = join(HERE, 'ui.tsx');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.tsx?$/.test(path)) out.push(path);
  }
  return out;
}

/**
 * Components only — an upper-case `export function`.
 *
 * Helpers (`cx`, `buttonClass`), tokens and types are excluded because an
 * unused one of those is ordinary dead code with no product meaning, and
 * because several are consumed inside `ui.tsx` itself, where a search outside
 * the file would report a false absence.
 */
function exportedComponents(source: string): string[] {
  return [...source.matchAll(/^export function ([A-Z]\w*)/gm)].map((match) => match[1]!);
}

describe('the shared UI kit exports nothing it does not render', () => {
  const kit = readFileSync(KIT, 'utf8');
  const components = exportedComponents(kit);
  /*
   * Tests are excluded from the corpus for the reason the core version gives:
   * a test asserting a consumer exists must not be able to satisfy itself. So
   * is `ui.tsx`, where one component composing another proves nothing about
   * whether either reaches a screen.
   */
  const sources = walk(WEB_SRC)
    .filter((path) => path !== KIT && !path.includes('.test.'))
    .map((path) => ({ path, text: readFileSync(path, 'utf8') }));

  it('searches a real corpus, and finds real components', () => {
    expect(sources.length).toBeGreaterThan(40);
    expect(components.length).toBeGreaterThan(8);
  });

  for (const component of components) {
    it(`<${component}> is rendered somewhere`, () => {
      const renderers = sources
        .filter((source) => source.text.includes(`<${component}`))
        .map((source) => source.path);
      expect(
        renderers.length,
        `ui.tsx exports <${component}> and no screen renders it. ` +
          'Put it back on a page, or delete it — an unrendered component is a ' +
          'design decision nobody can see.',
      ).toBeGreaterThan(0);
    });
  }
});

/**
 * V11 §C — THE RADIUS SCALE IS FOUR VALUES, AND ONLY FOUR.
 *
 * The V11 audit counted **fourteen** distinct `rounded-*` values across the
 * product. None of that was anyone's decision; it is what happens when each
 * component answers the question alone, and the result is a screen where three
 * boxes on one row have three different corners for no reason a reader could
 * name.
 *
 * `globals.css` publishes the scale — `--radius-control`, `--radius-card`,
 * `--radius-panel`, `--radius-plate` — and `/labs/design` renders it. This makes
 * the scale enforceable rather than merely documented: a `rounded-md` added
 * tomorrow fails here with the file that added it.
 *
 * `rounded-full` and `rounded-sm` are deliberately allowed. A pill and a hairline
 * corner are shapes rather than points on the surface scale, and expressing
 * "completely round" as a token would be a token nobody could read.
 */
describe('V11 §C — one radius scale', () => {
  const TAILWIND_RADII = /\brounded(?:-[a-z]+)?-(?:md|lg|xl|2xl|3xl)\b/;

  it('uses the published tokens rather than Tailwind’s own scale', () => {
    const offenders: string[] = [];
    for (const file of walk(WEB_SRC).filter((path) => path.endsWith('.tsx') && !path.includes('.test.'))) {
      const source = readFileSync(file, 'utf8');
      for (const [index, line] of source.split('\n').entries()) {
        if (TAILWIND_RADII.test(line)) offenders.push(`${file.replace(WEB_SRC, '')}:${index + 1}`);
      }
    }
    expect(offenders, `use var(--radius-control|card|panel|plate) instead:\n${offenders.join('\n')}`).toEqual([]);
  });
});
