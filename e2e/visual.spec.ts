import { expect, test } from '@playwright/test';
import { completeQuestionnaire } from './support/trip';
import { mkdirSync } from 'node:fs';
import {
  expectNoHorizontalOverflow,
  expectNoRuntimeProblems,
  watchForRuntimeProblems,
} from './support/viewports';

/**
 * Not assertions about pixels — this drives the real journey, captures each
 * screen for a human to look at, and fails on console errors, page errors or a
 * horizontally scrolling body.
 *
 * The overflow probe and the console-error watch used to live here. They moved to
 * `support/viewports.ts` when `viewports.spec.ts` needed the same two checks at
 * three widths: two copies of a probe drift, and a drifting probe is worse than
 * no probe, because it still reports green.
 */

const SHOT_DIR = 'test-results/screens';

test('captures the journey and stays free of console errors and overflow', async ({
  page,
}, testInfo) => {
  mkdirSync(SHOT_DIR, { recursive: true });
  const suffix = testInfo.project.name;
  const problems = watchForRuntimeProblems(page);

  async function shot(name: string) {
    await expectNoHorizontalOverflow(page, name);
    await page.screenshot({ path: `${SHOT_DIR}/${name}-${suffix}.png`, fullPage: true });
  }

  await page.goto('/');
  await shot('01-landing');

  /*
   * The landing call to action no longer names a town, because the product no
   * longer plans one. The destination is typed into the composer instead, which
   * is also what makes this walkthrough work for any destination.
   */
  await page.getByRole('link', { name: 'I know where I am going' }).click();
  await page.getByLabel('Destination').fill('Mammoth Lakes');
  await page.getByLabel('Arrive').fill('2026-08-12');
  await page.getByLabel('Leave').fill('2026-08-15');
  await shot('02-composer');

  await page.getByRole('button', { name: /^Continue$/ }).click();
  await expect(page.getByTestId('interview-understanding')).toBeVisible();
  await shot('03-understanding');
  await completeQuestionnaire(page, { answers: { iconic_crowds: 'quieter_alternative' } });
  await shot('08-review');

  await page.getByRole('button', { name: 'Open the Discovery Board' }).click();
  await expect(page).toHaveURL(/\/discover$/);
  await expect(page.getByRole('heading', { name: 'Classics worth your time' })).toBeVisible();
  await shot('09-board');

  await page.getByTestId('board-auto-pick').click();
  await expect(page.getByTestId('board-summary')).toContainText(/[1-9]\d* chosen/);
  await shot('10-board-autopicked');

  await page.getByRole('button', { name: /Build my trip|Rebuild my trip/ }).click();
  await expect(page).toHaveURL(/\/itinerary$/, { timeout: 30_000 });
  await expect(page.getByRole('heading', { name: /^Day 1/ })).toBeVisible();
  await shot('11-itinerary');

  expectNoRuntimeProblems(problems);
});
