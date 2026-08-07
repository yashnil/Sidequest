import { expect, test, type Page } from '@playwright/test';
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

  await page.getByRole('button', { name: /See what we make of it/i }).click();
  await page.getByRole('radio', { name: 'Hiking: A few times' }).check();
  await page.getByRole('radio', { name: 'Lakes & rivers: A few times' }).check();
  await page.getByRole('radio', { name: 'Scenic viewpoints: Core' }).check();
  await page.getByRole('radio', { name: 'Geology & geothermal: Once or twice' }).check();
  await shot('03-interests');

  await advance(page, 'How should the days feel?');
  await shot('04-rhythm');
  await advance(page, 'What is the spending style?');
  await advance(page, 'How do you want to eat?');
  await advance(page, 'Famous or off the track?');
  await page.getByRole('radio', { name: /Crowds ruin it/ }).check();
  await shot('05-discovery');
  await advance(page, 'How are you getting around?');
  await shot('06-transport');
  await advance(page, 'How far from Mammoth Lakes?');
  await advance(page, 'Anything to steer around?');
  await shot('07-constraints');
  await advance(page, 'Your trip personality');
  await shot('08-personality');

  await page.getByRole('button', { name: 'Build my discovery board' }).click();
  await expect(page).toHaveURL(/\/discover$/);
  await expect(page.getByRole('heading', { name: 'Must-see classics' })).toBeVisible();
  await shot('09-board');

  await page.getByRole('button', { name: 'Auto-pick the best mix for me' }).click();
  await expect(page.getByTestId('board-summary')).toContainText(/[1-9]\d* in/);
  await shot('10-board-autopicked');

  await page.getByRole('button', { name: /Build my trip|Rebuild my trip/ }).click();
  await expect(page).toHaveURL(/\/itinerary$/, { timeout: 30_000 });
  await expect(page.getByRole('heading', { name: /^Day 1/ })).toBeVisible();
  await shot('11-itinerary');

  expectNoRuntimeProblems(problems);
});

async function advance(page: Page, nextHeading: string) {
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: nextHeading })).toBeVisible();
}
