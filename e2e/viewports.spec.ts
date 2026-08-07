import { expect, test } from '@playwright/test';
import {
  VIEWPORTS,
  expectNoHorizontalOverflow,
  expectNoRuntimeProblems,
  watchForRuntimeProblems,
} from './support/viewports';
import { DEFAULT_DATES, completeQuestionnaire, waitUntilInteractive } from './support/trip';

/**
 * THREE VIEWPORTS, STATED IN THE TEST RATHER THAN INFERRED FROM THE CONFIG.
 *
 * The suite's other specs run under whatever viewport their project declares, so
 * "which sizes are covered" was a question you could only answer by reading a
 * device descriptor in a node_modules package. This spec answers it in the one
 * place a reader looks: it names each size and sets it, so a reviewer can see
 * 1440x900, 1024x768 and 390x844 without leaving the file.
 *
 * ONE PROJECT ONLY. `playwright.config.ts` gives this file to the `tablet`
 * project and hides it from the other three, because a spec that sets its own
 * viewport learns nothing from being run again under a different one — and the
 * suite is ~131 declarations across three projects at ~12 minutes, so four
 * redundant walks of the composer is a cost with no signal behind it.
 *
 * Deliberately shallow. `visual.spec.ts` already drives the whole journey to a
 * compiled itinerary at desktop, desktop-dark and mobile; what nothing covered
 * was the tablet width, where a two-column layout is at its most likely to be
 * caught halfway between its breakpoints. So this walks the surfaces that are
 * cheap to reach and layout-dense — landing, the filled composer, and the scope
 * screen the planner lands on — at all three widths, and leaves the expensive
 * tail to the spec that was already paying for it.
 */

for (const viewport of VIEWPORTS) {
  test(`lays out the key surfaces at ${viewport.name} (${viewport.width}x${viewport.height})`, async ({
    page,
  }) => {
    const problems = watchForRuntimeProblems(page);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });

    await page.goto('/');
    await expect(page.getByRole('link', { name: 'I know where I am going' })).toBeVisible();
    await expectNoHorizontalOverflow(page, `landing at ${viewport.name}`);

    /*
     * The composer with content in it, not the empty shell: the destination field
     * gates the rest of the form, so an unfilled composer is a third of the
     * layout and the third least likely to overflow.
     */
    await page.goto('/trips/new');
    const destination = page.getByLabel('Destination');
    await waitUntilInteractive(destination);
    await destination.fill('Mammoth Lakes');
    await page.getByLabel('Arrive').fill(DEFAULT_DATES.start);
    await page.getByLabel('Leave').fill(DEFAULT_DATES.end);
    await expectNoHorizontalOverflow(page, `composer at ${viewport.name}`);

    await page.getByRole('button', { name: /See what we make of it/i }).click();
    await page.waitForURL(/\/trips\/[^/]+\/questionnaire/);

    /*
     * The interests step is the densest grid the product renders: nine question
     * groups of five radio options each. It is where a width that has run out of
     * room shows first, and it is one navigation away, so all three sizes can have
     * it for the price of one page load.
     */
    await expect(page.getByRole('heading', { name: 'What are you actually here for?' })).toBeVisible();
    await expectNoHorizontalOverflow(page, `interests at ${viewport.name}`);

    /*
     * And the far end of the questionnaire, which is a different layout problem:
     * the personality review puts the whole profile on one screen as bars and
     * labels, so it is the widest *content* rather than the widest control grid.
     * Reached through the shared walker so a questionnaire reordering breaks this
     * in the same place it breaks everything else.
     */
    await completeQuestionnaire(page);
    await expectNoHorizontalOverflow(page, `personality at ${viewport.name}`);

    /*
     * The board stops here. Building it compiles a region, and `visual.spec.ts`
     * already drives that to a finished itinerary at three of the four project
     * configurations — paying for it again at three widths would roughly triple
     * this spec's runtime to re-cover ground.
     */
    expectNoRuntimeProblems(problems, `Runtime problems at ${viewport.name}`);
  });
}
