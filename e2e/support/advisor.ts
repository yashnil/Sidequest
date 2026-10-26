import { expect, type Page } from '@playwright/test';

/**
 * Drives the destination advisor the way a quick traveller would: type a
 * request, answer each question the interview chooses with its first option,
 * and wait for the stored shortlist. The interview decides how many questions
 * there are, so this loops on what is on screen rather than hard-coding them.
 */
export const ADVISOR_REQUEST = 'Hiking and mountains in July, about 9 nights.';

export async function startAdvisor(page: Page, text = ADVISOR_REQUEST): Promise<string> {
  await page.goto('/decide');
  await page.getByLabel('In your own words').fill(text);
  await page.getByRole('button', { name: /Find my places|Just ask me/ }).click();
  await page.waitForURL(/\/decide\/[0-9a-f-]{8,}/);
  return new URL(page.url()).pathname.split('/').pop()!;
}

export async function answerUntilShortlist(page: Page, maxSteps = 12): Promise<void> {
  const shortlist = page.getByTestId('advisor-shortlist');
  for (let step = 0; step < maxSteps; step += 1) {
    if (await shortlist.isVisible().catch(() => false)) return;
    const question = page.locator('[data-testid^="advisor-question-"]').first();
    if (await question.isVisible().catch(() => false)) {
      const checkboxes = question.getByRole('checkbox');
      if ((await checkboxes.count()) > 0) {
        await checkboxes.first().check();
        await question.getByRole('button', { name: /^Continue with/ }).click();
      } else {
        await question.getByRole('radio').first().click();
      }
      await page.waitForTimeout(150);
      continue;
    }
    await page.waitForTimeout(400);
  }
  await expect(shortlist).toBeVisible({ timeout: 30_000 });
}

export async function adviseToShortlist(page: Page, text = ADVISOR_REQUEST): Promise<string> {
  const id = await startAdvisor(page, text);
  await answerUntilShortlist(page);
  return id;
}
