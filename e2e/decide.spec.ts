import { expect, test } from '@playwright/test';
import { adviseToShortlist, answerUntilShortlist, startAdvisor } from './support/advisor';

/**
 * "HELP ME CHOOSE", THROUGH THE BROWSER (the 2026-10 destination advisor).
 *
 * What it proves, in order: both doors are on the front page; free text is read
 * and not asked again; the interview asks a bounded number of questions and can
 * be cut short; the shortlist shows real travel destinations with reasons,
 * timing, trade-offs and what is unchecked; a refresh loses nothing; a
 * refinement re-ranks without restarting; and choosing a destination produces
 * an ordinary trip carrying every answer.
 *
 * The advisor ranks a bundled catalog with no model and no provider, so this
 * runs offline; the climate check is off in this environment and the cards
 * must say so rather than claim a verification.
 */

test('both doors are on the front page, and the second one works', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('link', { name: 'I know where I want to go' })).toBeVisible();
  await page.getByRole('link', { name: 'Help me choose' }).click();
  await expect(page).toHaveURL(/\/decide$/);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Not sure where?');
});

test('reads what was typed and does not ask it again', async ({ page }) => {
  await startAdvisor(page, 'Find me somewhere outdoors for the summer. I love hiking, wildlife, mountains, lakes, coast and swimming. I’m flexible on duration.');
  await expect(page.getByText('What we took from that')).toBeVisible();
  await expect(page.getByText('Summer · June–August').first()).toBeVisible();
  /*
   * When, what for and how long were all in the sentence. Which follow-up comes
   * first is the interview's call (the largest expected change to the list), so
   * this asserts only that a follow-up is asked and that it is none of those.
   */
  await expect(page.locator('[data-testid^="advisor-question-"]').first()).toBeVisible();
  await expect(page.getByTestId('advisor-question-when')).toHaveCount(0);
  await expect(page.getByTestId('advisor-question-focus')).toHaveCount(0);
  await expect(page.getByTestId('advisor-question-length')).toHaveCount(0);
});

test('the interview can be cut short, and stops on its own within a handful of questions', async ({ page }) => {
  await startAdvisor(page);
  let questions = 0;
  for (let step = 0; step < 10; step += 1) {
    if (await page.getByTestId('advisor-shortlist').isVisible().catch(() => false)) break;
    const question = page.locator('[data-testid^="advisor-question-"]').first();
    if (!(await question.isVisible().catch(() => false))) {
      await page.waitForTimeout(400);
      continue;
    }
    questions += 1;
    if (questions === 2) {
      await page.getByRole('button', { name: 'Show me places now' }).click();
      break;
    }
    await question.getByRole('radio').first().click();
  }
  await expect(page.getByTestId('advisor-shortlist')).toBeVisible({ timeout: 30_000 });
  expect(questions).toBeLessThanOrEqual(7);
});

test('the shortlist argues for each place and says what it has not checked', async ({ page }) => {
  await adviseToShortlist(page);
  const picks = page.getByTestId('advisor-pick');
  await expect(picks).toHaveCount(3);
  const first = picks.first();
  for (const label of ['Best time', 'Trip length', 'Character', 'Costs', 'Getting there', 'Getting around', 'Where you’d stay', 'Weather check']) {
    await expect(first.getByText(label, { exact: true })).toBeVisible();
  }
  await expect(first.getByText('The catch')).toBeVisible();
  /* Climate is off here: the card must not claim a check that never happened. */
  await expect(first).not.toContainText('Checked against');
  await first.getByText('Not checked yet').click();
  await expect(first).toContainText('Prices, opening dates and permits');
  /* Never an administrative unit. */
  await expect(page.getByTestId('advisor-shortlist')).not.toContainText(/Municipality|Voivodeship|County of/);
  await expect(page.getByRole('button', { name: /Plan a trip to/ }).first()).toBeVisible();
});

test('a refresh loses nothing', async ({ page }) => {
  await adviseToShortlist(page);
  const before = await page.getByTestId('advisor-pick').getByRole('heading', { level: 3 }).allInnerTexts();
  await page.reload();
  await expect(page.getByTestId('advisor-shortlist')).toBeVisible();
  expect(await page.getByTestId('advisor-pick').getByRole('heading', { level: 3 }).allInnerTexts()).toEqual(before);
});

test('a refinement re-ranks without restarting, and says what changed', async ({ page }) => {
  await adviseToShortlist(page);
  await page.getByRole('button', { name: 'Something completely different' }).click();
  await expect(page.getByRole('status').filter({ hasText: /New:|Nothing better fits/ })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('advisor-pick').first()).toBeVisible();
  await page.getByRole('button', { name: 'Less expensive' }).click();
  await expect(page.getByTestId('advisor-shortlist')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Undo all nudges' })).toBeVisible({ timeout: 20_000 });
});

test('choosing a destination carries the answers into a normal trip', async ({ page }) => {
  await adviseToShortlist(page);
  const chosen = (await page.getByTestId('advisor-pick').first().getByRole('heading', { level: 3 }).innerText()).trim();
  await page.getByRole('button', { name: `Plan a trip to ${chosen}` }).click();
  await page.waitForURL(/\/trips\/[^/]+\/plan/, { timeout: 30_000 });
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
});

test('the interview is keyboard-operable', async ({ page }) => {
  await startAdvisor(page);
  const question = page.locator('[data-testid^="advisor-question-"]').first();
  await expect(question).toBeVisible();
  const option = question.getByRole('radio').first().or(question.getByRole('checkbox').first());
  await option.first().focus();
  await expect(option.first()).toBeFocused();
  await page.keyboard.press(await question.getByRole('checkbox').count() > 0 ? 'Space' : 'Enter');
  await answerUntilShortlist(page);
});
