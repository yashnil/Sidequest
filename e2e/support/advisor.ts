import { expect, type Locator, type Page } from '@playwright/test';

/**
 * Drives the destination advisor the way a quick traveller would: type a
 * request, answer each question the interview chooses with its first option,
 * and wait for the stored shortlist. The interview decides how many questions
 * there are, so this loops on what is on screen rather than hard-coding them.
 */
export const ADVISOR_REQUEST = 'Hiking and mountains in July, about 9 nights.';

/**
 * The question that can be answered right now.
 *
 * Which follow-up comes next is worked out on the server, one call per answer.
 * While that call is in flight the question just answered stays on screen,
 * marked busy, so nothing jumps — and a helper that pressed its options again
 * would be answering a question that is already answered.
 */
export function currentQuestion(page: Page): Locator {
  return page.locator('[data-testid^="advisor-question-"]:not([aria-busy="true"])').first();
}

export async function startAdvisor(page: Page, text = ADVISOR_REQUEST): Promise<string> {
  await page.goto('/decide');
  await page.getByLabel('In your own words').fill(text);
  await page.getByRole('button', { name: /Find my places|Just ask me/ }).click();
  await page.waitForURL(/\/decide\/[0-9a-f-]{8,}/);
  return new URL(page.url()).pathname.split('/').pop()!;
}

/**
 * Answers whatever is on screen until the shortlist appears.
 *
 * Bounded by time, not by a count of loop turns: each answer is followed by a
 * server round trip that chooses the next question, so how many turns pass
 * while the screen is settling says nothing about how far the interview has
 * got. `maxAnswers` is the interview's own ceiling (two essentials and five
 * follow-ups) with room to spare — exceeding it means the interview is not
 * stopping, which is a failure worth seeing.
 */
export async function answerUntilShortlist(page: Page, maxAnswers = 12, budgetMs = 120_000): Promise<void> {
  const shortlist = page.getByTestId('advisor-shortlist');
  const deadline = Date.now() + budgetMs;
  let answered = 0;
  while (Date.now() < deadline) {
    if (await shortlist.isVisible().catch(() => false)) return;
    const question = currentQuestion(page);
    if (answered < maxAnswers && (await question.isVisible().catch(() => false))) {
      const checkboxes = question.getByRole('checkbox');
      if ((await checkboxes.count()) > 0) {
        await checkboxes.first().check();
        await question.getByRole('button', { name: /^Continue with/ }).click();
      } else {
        await question.getByRole('radio').first().click();
      }
      answered += 1;
      await page.waitForTimeout(150);
      continue;
    }
    await page.waitForTimeout(300);
  }
  await expect(shortlist).toBeVisible({ timeout: 5_000 });
}

export async function adviseToShortlist(page: Page, text = ADVISOR_REQUEST): Promise<string> {
  const id = await startAdvisor(page, text);
  await answerUntilShortlist(page);
  return id;
}
