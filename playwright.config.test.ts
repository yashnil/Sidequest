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

  it('does not run a responsive spec four times over', () => {
    /*
     * A responsive spec sets its own viewport, so a second project running it
     * re-walks the same screens and learns nothing. This is a runtime guard, not
     * a correctness one: redundant walks x three consecutive full runs is real
     * minutes.
     *
     * Compared as a set rather than by identity, because there is more than one
     * such spec now. The benchmark added its own sweep and was initially left off
     * the list — which meant it ran three times, once per full project, each
     * overriding the viewport it was written to probe, and never once at the
     * tablet width it exists for. Passing, three times, while testing nothing it
     * claimed to.
     */
    const asSet = (value: unknown): string[] =>
      (Array.isArray(value) ? value : [value]).filter((entry): entry is string => typeof entry === 'string').sort();

    const projects = config.projects ?? [];
    const responsive = projects
      .filter((project) => asSet(project.testMatch).some((glob) => glob.includes('viewports.spec.ts')))
      .map((project) => project.name);
    expect(responsive).toEqual(['tablet']);

    const expected = asSet(projects.find((project) => project.name === 'tablet')?.testMatch);
    expect(expected.length, 'the tablet project runs no responsive spec').toBeGreaterThan(0);

    for (const project of projects) {
      if (project.name === 'tablet') continue;
      expect(asSet(project.testIgnore), `${project.name} would re-run a responsive spec`).toEqual(
        expected,
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

  /**
   * THE BROWSER SUITE REACHES NOTHING THAT COSTS MONEY.
   *
   * Every one of these pins exists because the absence of a switch is a
   * property of a shell, and a shell is not something a test suite gets to
   * assume. `ANTHROPIC_API_KEY=` is blanked rather than merely unset, because a
   * developer whose environment happens to carry a research credential would
   * otherwise make every browser run spend real money — and the two newest pins
   * are here for the sharper version of that: the benchmark surface can spend on
   * a *reviewer's click*, and it reads its ceiling from the environment.
   *
   * Asserted here rather than trusted to the config, so that removing one is a
   * failing test rather than a quiet change in what a run is allowed to do.
   */
  it('pins every provider switch away from live in the server it starts', () => {
    const command = config.webServer?.command ?? '';
    for (const pin of [
      'ANTHROPIC_API_KEY=',
      'SIDEQUEST_WEATHER_PROVIDER=fixture',
      'SIDEQUEST_COMPILER_PROVIDER=fixture',
      'SIDEQUEST_CLIMATE_PROVIDER=off',
      'SIDEQUEST_BENCHMARK_MODE=fixture',
      'SIDEQUEST_BENCHMARK_BUDGET_USD=',
    ]) {
      expect(command, `the end-to-end server no longer pins ${pin}`).toContain(pin);
    }
    expect(command).not.toContain('SIDEQUEST_COMPILER_PROVIDER=open');
    expect(command).not.toContain('SIDEQUEST_BENCHMARK_MODE=live');
  });
});
