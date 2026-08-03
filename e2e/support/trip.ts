import { expect, type Page } from '@playwright/test';

/**
 * The journey helpers, in one place.
 *
 * They used to be copy-pasted into six specs, which was survivable while the
 * composer had four fields and stopped being so the moment the flow changed:
 * one phase's worth of UI work meant the same three edits in six files, and the
 * sixth was always the one that got missed. Every spec drives the product
 * through these.
 */

export const DEFAULT_DATES = { start: '2026-08-12', end: '2026-08-16' };

/**
 * Fill the composer and submit it.
 *
 * Types the destination rather than picking a suggestion, because the end-to-end
 * environment deliberately has no destination index: these tests exercise the
 * *fallback* path — typed text, one explicit resolution — which is the one that
 * has to keep working for everything the index does not hold.
 */
export async function createTrip(
  page: Page,
  destination: string,
  dates: { start: string; end: string } = DEFAULT_DATES,
): Promise<string> {
  await page.goto('/trips/new');
  await page.getByLabel('Destination').fill(destination);
  await page.getByLabel('Arrive').fill(dates.start);
  await page.getByLabel('Leave').fill(dates.end);
  await page.getByRole('button', { name: /See what we make of it/i }).click();
  await page.waitForURL(/\/trips\/[^/]+\/(plan|questionnaire)/);
  const id = /\/trips\/([^/]+)\//.exec(page.url())?.[1];
  expect(id, 'a trip id should be in the URL').toBeTruthy();
  return id!;
}

/**
 * Wait for the destination lookup to finish.
 *
 * There is no button to press: the flow resolves on arrival, because a screen
 * whose only possible action is "yes, do the thing I already asked for" is a
 * click that exists because the code needed one.
 */
export async function waitForLookup(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { level: 1 })).not.toContainText('Looking up', {
    timeout: 20_000,
  });
}

/** Check the first radio of every group on screen, whatever the groups are. */
export async function answerEveryQuestion(page: Page): Promise<void> {
  const radios = page.locator('input[type=radio]');
  const groups = new Set<string>();
  const count = await radios.count();
  for (let index = 0; index < count; index += 1) {
    const name = await radios.nth(index).getAttribute('name');
    if (name && !groups.has(name)) {
      groups.add(name);
      await radios.nth(index).check();
    }
  }
}

/**
 * Walk whichever steps this destination produced, until the scope screen.
 *
 * A loop rather than a fixed sequence, because the whole design derives the step
 * from stored state: a country gets a strategy question, a city does not, and a
 * destination with no clarifications goes straight through. Polling for "which
 * screen am I on now" is also what makes this immune to the race the previous
 * version had — it checked for the *next* screen before the transition it had
 * just triggered had rendered, then waited twenty seconds for a heading that was
 * two steps away.
 */
export async function reachScope(page: Page): Promise<void> {
  await waitForLookup(page);

  /*
   * The loop tolerates a screen that has not finished computing — it polls, and
   * the preflight's "Reading the region" state simply produces another turn.
   * Twelve turns at 400 ms plus the per-action waits is comfortably more than
   * the preflight has ever needed, and running out is a real failure rather
   * than a timing one.
   */
  for (let step = 0; step < 12; step += 1) {
    const scope = page.getByRole('heading', { name: 'Here is what we are about to do' });
    if (await scope.isVisible().catch(() => false)) return;

    const research = page.getByRole('button', { name: /Go and research this/i });
    if (await research.isVisible().catch(() => false)) {
      await answerEveryQuestion(page);
      await research.click();
      await expect(research).toHaveCount(0, { timeout: 20_000 });
      continue;
    }

    const proceed = page.getByRole('button', { name: /^Continue$/ });
    if (await proceed.isVisible().catch(() => false)) {
      await answerEveryQuestion(page);
      await proceed.click();
      await expect(proceed).toHaveCount(0, { timeout: 20_000 });
      continue;
    }

    await page.waitForTimeout(400);
  }

  await expect(page.getByRole('heading', { name: 'Here is what we are about to do' })).toBeVisible({
    timeout: 20_000,
  });
}


/** Push all the way through to a compiled region. */
export async function compileRegion(page: Page): Promise<void> {
  await reachScope(page);
  await page.getByRole('button', { name: 'Build the region' }).click();
  await expect(page.getByRole('heading', { name: 'What this trip is built on' })).toBeVisible({
    timeout: 90_000,
  });
}
