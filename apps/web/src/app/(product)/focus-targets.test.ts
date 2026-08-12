import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * AN ELEMENT FOCUS IS MOVED TO MUST BE VISIBLE ONCE IT HAS FOCUS.
 *
 * The pattern this guards is everywhere in the product and is right: after a
 * step change, a route error, a boundary reset, move focus to the heading so a
 * screen-reader user is told what happened rather than left on a page that
 * changed underneath them. `tabIndex={-1}` makes the heading a programmatic
 * target without putting it in the tab order.
 *
 * The failure is what was done next. `outline-none` was added to keep the
 * target from "looking odd", which removes the only signal a *sighted* keyboard
 * user has that focus moved at all — so the fix for one disability was paid for
 * out of another's. `ReviewSurface.tsx` fixed exactly this for the benchmark's
 * lock dialog and wrote the argument out in full, including why the ring must be
 * `focus:` rather than `focus-visible:`: focus arrives from script, not from a
 * key press, so the browser's focus-visible heuristic declines and the ring
 * never paints.
 *
 * A reviewer found seven customer-facing instances of the unfixed pattern. Two
 * are repaired and guarded here. The other five are in components owned
 * elsewhere and are listed by name below rather than silently skipped — an
 * allow-list that says what is still wrong is a to-do; an unstated exclusion is
 * a lie.
 */

const WEB_SRC = new URL('../../', import.meta.url).pathname;

/**
 * Files known to still carry the defect, and whose owner is not this test.
 *
 * Listed as "may still be broken", never "must be" — a fix landing in any of
 * them keeps this green, so removing a line is the only maintenance this needs.
 */
const NOT_YET_FIXED = [
  'components/QuestionnaireWizard.tsx',
  'components/ui.tsx',
  'components/ProductChrome.tsx',
  'app/(product)/trips/[id]/discover/error.tsx',
  'app/(product)/trips/[id]/plan/error.tsx',
  'app/(product)/trips/[id]/itinerary/error.tsx',
  /*
   * Found by this scan rather than by the reviewer, and the only one on an
   * internal surface: the labs run monitor moves focus to a `role="status"`
   * paragraph after a swap and strips its outline. Same defect, same fix,
   * different owner.
   */
  'components/benchmark/RunMonitor.tsx',
];

function sourceFiles(root: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    if (statSync(path).isDirectory()) found.push(...sourceFiles(path));
    else if (entry.endsWith('.tsx')) found.push(path);
  }
  return found;
}

describe('programmatic focus targets keep a visible indicator', () => {
  it('never pairs tabIndex={-1} with outline-none on the same element', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(WEB_SRC)) {
      const relative = file.slice(file.indexOf('/src/') + 5);
      if (NOT_YET_FIXED.includes(relative)) continue;
      const text = readFileSync(file, 'utf8');
      /*
       * The element's own opening tag, from `tabIndex={-1}` to the `>` that
       * closes it. Scoped to one tag deliberately: an `outline-none` three
       * elements later is a different element's business, and a whole-file grep
       * would report it as this one's.
       *
       * `[^<]` rather than a character budget. The first draft used
       * `[\s\S]{0,600}?`, and a design-rationale comment between the attribute
       * and the class list ran past 600 characters — so the scan walked off the
       * end of the tag and reported nothing. A tag cannot contain `<`, which
       * makes that the exact boundary rather than a guess at one.
       */
      for (const match of text.matchAll(/tabIndex=\{-1\}[^<]*?>/g)) {
        /*
         * Block comments stripped first, and this bit the scan's own author:
         * the repair to these two files carries a rationale comment *inside*
         * the opening tag — the house style — and that comment names
         * `outline-none` as the thing it removed. A scan over raw tag text
         * reported both repaired files as offenders. What is under test is the
         * class list, so the prose comes out first.
         */
        if (/\boutline-none\b/.test(match[0].replace(/\/\*[\s\S]*?\*\//g, ''))) {
          offenders.push(relative);
        }
      }
    }
    expect(
      [...new Set(offenders)],
      'focus was moved to this element and then its focus ring was removed. ' +
        'Use `focus:outline focus:outline-2 focus:outline-pine focus:outline-offset-2` — ' +
        '`focus-visible:` does not paint for a programmatic focus move',
    ).toEqual([]);
  });

  /** And the two that were repaired actually carry a ring, not merely no `outline-none`. */
  it.each([
    'app/(product)/error.tsx',
    'app/(product)/decide/error.tsx',
  ])('%s gives its focused heading a ring', (relative) => {
    const text = readFileSync(join(WEB_SRC, relative), 'utf8');
    expect(text).toContain('tabIndex={-1}');
    expect(text, 'the heading focus is moved to must paint an outline on focus').toMatch(
      /focus:outline-2\s+focus:outline-pine/,
    );
  });
});
