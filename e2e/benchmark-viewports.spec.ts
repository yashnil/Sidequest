import { expect, test, type Page } from '@playwright/test';
import {
  completeReview,
  lockAndReveal,
  reachReview,
  seedQuestionRound,
  seedReviewableSession,
  showPanel,
} from './support/benchmark';
import {
  VIEWPORTS,
  expectNoHorizontalOverflow,
  expectNoRuntimeProblems,
  watchForRuntimeProblems,
} from './support/viewports';

/**
 * THE COMPARISON AT EVERY WIDTH THE PRODUCT IS TESTED AT.
 *
 * Its own file rather than an addition to `viewports.spec.ts`, which is run only
 * by the tablet project and belongs to the customer journey. The interesting
 * width for this phase is 1024: it is where the two-column layout is caught
 * between its breakpoints, and where a seven-point rating row is most likely to
 * push the document sideways.
 *
 * A page that scrolls horizontally is the responsive failure screenshots hide,
 * because a full-page capture is as wide as the content rather than as wide as
 * the window. The probe is the shared one, retried, because a late layout pass
 * can widen the document a frame after navigation resolves.
 */

test.describe('the comparison at every viewport', () => {
  for (const viewport of VIEWPORTS) {
    test(`fits at ${viewport.name} (${viewport.width}x${viewport.height})`, async ({ page }) => {
      const problems = watchForRuntimeProblems(page);
      await page.setViewportSize({ width: viewport.width, height: viewport.height });

      const sessionId = await seedReviewableSession(page, { seed: `viewport-${viewport.name}` });

      await page.goto('/labs/benchmark');
      await expect(page.getByTestId('session-list')).toBeVisible();
      await expectNoHorizontalOverflow(page, `the index at ${viewport.name}`);

      await page.goto('/labs/benchmark/new');
      await expect(page.getByTestId('case-select')).toBeVisible();
      await expectNoHorizontalOverflow(page, `the composer at ${viewport.name}`);

      await page.goto(`/labs/benchmark/${sessionId}/run`);
      await expect(page.getByTestId('panel-states')).toBeVisible();
      await expectNoHorizontalOverflow(page, `the progress screen at ${viewport.name}`);

      /*
       * THE QUESTION ROUND, WHICH NO VIEWPORT RUN HAD EVER RENDERED.
       *
       * The seeded session above lands at `ready_for_review`, so the pooled
       * question list, its answer controls and the second press were absent from
       * every measurement in this file. They are the densest new thing in the
       * phase — a select and a button on one row, inside a panel, at 390 pixels —
       * which makes them exactly the kind of thing that goes over the edge first.
       */
      const askingId = await seedQuestionRound(page, `viewport-asking-${viewport.name}`);
      await expect(page.getByTestId('pooled-questions')).toBeVisible();
      await expect(page.getByTestId('plan-both')).toBeVisible();
      await expectNoHorizontalOverflow(page, `the question round at ${viewport.name}`);
      void askingId;

      await reachReview(page, sessionId);
      await expectNoHorizontalOverflow(page, `the review at ${viewport.name}`);

      /*
       * The seven-point row is the specific thing being measured. It is the
       * densest object in the phase, and at 390 pixels it is the one most likely
       * to be the first thing over the edge — so it is asserted directly rather
       * than only through the document width.
       *
       * Measured on the labels rather than the inputs: every radio here is a
       * transparent overlay inset to its label's padding box, so it reads two
       * pixels shorter than the control a finger actually lands on.
       */
      for (const label of ['A', 'B'] as const) {
        await showPanel(page, label);
        await expectNoHorizontalOverflow(page, `the review at ${viewport.name}, panel ${label}`);
        await expectTheRatingRowFits(page, label, viewport.name);
      }

      /*
       * And with the confirmation open. It is the widest thing this surface
       * puts on screen — a heading, a sentence and two buttons in a row — and it
       * only exists once every scale is answered, which is why nothing measured
       * it before.
       */
      await completeReview(page);
      await page.getByTestId('lock-open').click();
      await expect(page.getByTestId('lock-confirm-panel')).toBeVisible();
      await expectNoHorizontalOverflow(
        page,
        `the review at ${viewport.name} with the lock confirmation open`,
      );
      // Backed out, so the shared helper finds the trigger where it expects it.
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('lock-confirm-panel')).toHaveCount(0);

      await lockAndReveal(page, sessionId);
      await expectNoHorizontalOverflow(page, `the report at ${viewport.name}`);

      await page.goto('/labs/benchmark/results');
      await expect(page.getByTestId('weight-label')).toBeVisible();
      await expectNoHorizontalOverflow(page, `the dashboard at ${viewport.name}`);

      expectNoRuntimeProblems(problems, `the comparison at ${viewport.name}`);
    });
  }
});

/**
 * THE SEVEN-POINT ROW, MEASURED AGAINST SOMETHING THAT CAN FAIL.
 *
 * The assertion here used to be `row.width <= viewport.width`, which is not a
 * test: the row is a block inside a column inside a padded container, so its box
 * is narrower than the window by construction and stays narrower even when its
 * *contents* have burst out of it. It passed at every width and would have
 * passed at every width the row was broken at.
 *
 * Two things that can genuinely fail replace it. The row must fit inside the
 * panel that contains it, which is what catches a column that has been pushed
 * wide; and the row must not scroll inside itself, which is what catches seven
 * 44-pixel targets refusing to divide 390 pixels between them. Then each option
 * is measured for the target size, as before.
 */
async function expectTheRatingRowFits(
  page: Page,
  label: 'A' | 'B',
  where: string,
): Promise<void> {
  const row = page.locator(`[data-testid="rating-${label}-pacing"]`).first();
  await expect(row).toBeVisible();

  const fit = await row.evaluate((node) => {
    const panel = node.closest('[data-testid^="panel-"]') ?? node.parentElement!;
    return {
      rowWidth: node.getBoundingClientRect().width,
      panelWidth: panel.getBoundingClientRect().width,
      overflow: node.scrollWidth - node.clientWidth,
    };
  });

  expect(fit.rowWidth, `the rating row overflows its panel at ${where}, panel ${label}`)
    .toBeLessThanOrEqual(fit.panelWidth + 1);
  expect(fit.overflow, `the rating row scrolls inside itself at ${where}, panel ${label}`)
    .toBeLessThanOrEqual(1);

  const options = row.locator('label');
  const optionCount = await options.count();
  expect(optionCount).toBe(7);
  for (let index = 0; index < optionCount; index += 1) {
    const box = await options.nth(index).boundingBox();
    if (box === null) continue;
    expect(box.height, `option ${index + 1} of panel ${label} at ${where}`).toBeGreaterThanOrEqual(
      44,
    );
    expect(box.width, `option ${index + 1} of panel ${label} at ${where}`).toBeGreaterThanOrEqual(
      24,
    );
  }
}
