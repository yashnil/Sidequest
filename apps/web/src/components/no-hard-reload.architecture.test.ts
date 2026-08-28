import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * NOTHING IN THE PRODUCT TREE MAY HARD-RELOAD THE PAGE.
 *
 * `window.location.reload()` is a full document navigation. It tears down every
 * request the page has in flight, and on this product the requests in flight
 * are the expensive ones: a compilation poll, a board write, and — the one that
 * matters — `buildItineraryAction`, which runs for seconds and finishes with a
 * redirect the browser has to still be there to follow.
 *
 * The board had one, fired from an effect that resolves card imagery in the
 * background. A traveller pressing "Build my trip" inside that window has their
 * action aborted: the plan is built and saved on the server, the redirect is
 * dropped, and they are left on a board that has just flashed, with the button
 * relabelled "Rebuild my trip" and a panel telling them their plan is thin. A
 * success, rendered as a refusal.
 *
 * `router.refresh()` re-fetches the route's payload on the server without
 * unloading the document, so anything in flight survives it. On a
 * `force-dynamic` page the rendered result is identical.
 *
 * An architecture test rather than a component test, deliberately: the defect is
 * not "this effect reloads", it is "a reload can abort work the page started",
 * and that is true of every call site anyone might add. Effects also do not run
 * under `renderToStaticMarkup`, which is how the whole class went unseen.
 */

const ROOT = join(import.meta.dirname, '..');

/** Where a traveller goes. Excludes tests and the gated diagnostics surface. */
function productSources(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry === 'node_modules' || entry === 'labs') continue;
      productSources(path, found);
      continue;
    }
    if (!/\.tsx?$/.test(entry)) continue;
    if (/\.test\.tsx?$/.test(entry)) continue;
    found.push(path);
  }
  return found;
}

describe('the product tree', () => {
  it('is the tree it claims to be, or this test is scanning nothing', () => {
    const files = productSources(ROOT);
    expect(files.length).toBeGreaterThan(100);
    expect(files.some((path) => path.endsWith('DiscoveryBoardView.tsx'))).toBe(true);
  });

  it('never hard-reloads the page out from under work in flight', () => {
    const offenders: string[] = [];
    for (const path of productSources(ROOT)) {
      const source = readFileSync(path, 'utf8');
      for (const [index, line] of source.split('\n').entries()) {
        // The prohibition is on the call. The comment explaining why it is
        // prohibited names it, and must not trip its own rule.
        if (/^\s*\*/.test(line)) continue;
        if (/\blocation\s*\.\s*reload\s*\(/.test(line)) {
          offenders.push(`${path.slice(ROOT.length + 1)}:${index + 1}  ${line.trim()}`);
        }
      }
    }
    expect(offenders, 'use router.refresh() instead — see the note in this file').toEqual([]);
  });
});
