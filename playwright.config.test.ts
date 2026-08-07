import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import config from './playwright.config';
import { VIEWPORTS } from './e2e/support/viewports';

/**
 * ASSERTIONS ABOUT THE BROWSER SUITE'S CONFIGURATION, RUN OFFLINE.
 *
 * Every claim below is one that was made in writing about this suite and was
 * false at the time, or one whose quiet reversal has already cost a run:
 *
 *  - `testMatch` was widened once, Playwright loaded an offline vitest file,
 *    threw inside `@vitest/runner`, and collection went from 369 tests to zero.
 *    The suite reported a clean exit. Nothing noticed for days.
 *  - "Coverage at 1440x900, 1024x768 and 390x844" was recorded repeatedly while
 *    the config declared 1280x720 twice and 390x664 once.
 *  - `retries` above zero converts a flaky test into a passing one, which is the
 *    same thing as deleting the evidence.
 *
 * A comment cannot fail. This can. It imports the config rather than parsing it,
 * so it is asserting the object Playwright will actually use — which is only safe
 * because `emptyTheEndToEndDatabase()` returns early under VITEST; see the note
 * on that guard for why importing a config file is otherwise destructive.
 */

const SUITE_DIRECTORY = new URL('./e2e/', import.meta.url);

/** Every `*.spec.ts` Playwright will collect, found the way Playwright finds them. */
function specFiles(directory: URL = SUITE_DIRECTORY): URL[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return specFiles(new URL(`${entry.name}/`, directory));
    return entry.name.endsWith('.spec.ts') ? [new URL(entry.name, directory)] : [];
  });
}

describe('the browser suite configuration', () => {
  it('collects only .spec.ts, so the two runners cannot load each other files', () => {
    /*
     * Exactly this string, not merely something that happens to match. Playwright's
     * default also matches `**\/*.test.ts`, and this file is a `*.test.ts` — the
     * default is what took collection to zero.
     */
    expect(config.testMatch).toBe('**/*.spec.ts');
  });

  it('declares the expected projects and nothing else', () => {
    const names = (config.projects ?? []).map((project) => project.name);
    expect(names).toEqual(['desktop', 'desktop-dark', 'mobile', 'tablet']);
  });

  it.each(VIEWPORTS)('covers $name at $width x $height', (expected) => {
    const declared = (config.projects ?? []).filter(
      (project) =>
        project.use?.viewport?.width === expected.width &&
        project.use?.viewport?.height === expected.height,
    );
    const walked = readFileSync(new URL('./e2e/viewports.spec.ts', import.meta.url), 'utf8');

    /*
     * Declared by a project *or* walked by the responsive spec. Both hold today —
     * the project states the size for anyone reading the config, the spec sets it
     * for real — and either alone would still be honest coverage.
     */
    const covered =
      declared.length > 0 || walked.includes(`${expected.width}`) || walked.includes(expected.name);
    expect(covered, `nothing covers ${expected.width}x${expected.height}`).toBe(true);
    expect(declared.map((project) => project.name).length).toBeGreaterThan(0);
  });

  it('does not run the responsive spec four times over', () => {
    /*
     * The spec sets its own viewport, so a second project running it re-walks the
     * composer and learns nothing. This is a runtime guard, not a correctness one:
     * three redundant walks x three consecutive full runs is real minutes.
     */
    const projects = config.projects ?? [];
    const runners = projects.filter((project) => project.testMatch === '**/viewports.spec.ts');
    expect(runners.map((project) => project.name)).toEqual(['tablet']);
    for (const project of projects) {
      if (runners.includes(project)) continue;
      expect(project.testIgnore, `${project.name} would re-run the responsive spec`).toBe(
        '**/viewports.spec.ts',
      );
    }
  });

  it('retries nothing', () => {
    expect(config.retries).toBe(0);
  });

  it('skips and focuses nothing unconditionally', () => {
    /*
     * `test.skip(condition, reason)` is allowed: it is how a project-specific
     * concern — keyboard traversal on a phone — states that it does not apply,
     * and it is visible in the report as a skip with a reason. What is banned is
     * the unconditional form, `test.skip('title', ...)` or a bare `test.skip()`,
     * which removes coverage silently and permanently. The two are told apart by
     * what follows the paren: a quote or a close-paren means unconditional.
     */
    const unconditional = /\btest\.(?:skip|fixme)\s*\(\s*(?:['"`]|\))/;
    const suiteLevel = /\btest\.describe\.(?:skip|fixme)\b/;
    const focused = /\btest(?:\.describe)?\.only\b/;

    const offences = specFiles().flatMap((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .flatMap((line, index) =>
          unconditional.test(line) || suiteLevel.test(line) || focused.test(line)
            ? [`${file.pathname.split('/e2e/')[1]}:${index + 1}: ${line.trim()}`]
            : [],
        ),
    );
    expect(offences, `Tests removed from the suite:\n${offences.join('\n')}`).toEqual([]);
  });
});
