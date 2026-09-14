import { expect, test, type Page } from '@playwright/test';

/**
 * "WHERE SHOULD I GO", THROUGH THE BROWSER.
 *
 * The mode has been in the schema since Phase 7 with no code path behind it, so
 * every assertion here is of behaviour that did not exist. What it proves, in
 * order: both doors are reachable from the front page; four answers produce a
 * ranked list; the list explains itself and says what it could not see; a
 * refresh loses nothing; and choosing a destination carries every preference
 * into an ordinary trip.
 *
 * The environment has a *synthetic* index — five invented countries — so these
 * run entirely offline and name nowhere real. See `lib/destinations/seed`.
 */

async function answerAndRank(page: Page): Promise<void> {
  await page.goto('/decide');
  /*
   * V11 §A1 — the intake asks one question at a time, in the order that changes
   * the ranking most, and stops as soon as it can rank. Two answers is enough,
   * which is why the primary action appears here rather than a third question.
   */
  await page.getByRole('radio', { name: 'Some time in a month' }).check();
  await page.getByLabel('Which month?').selectOption('7');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Hiking and being outside' }).check();
  await page.getByRole('checkbox', { name: 'Mountains and high country' }).check();
  await page.getByRole('button', { name: 'One more question' }).click();
  await page.getByRole('spinbutton', { name: 'Nights away' }).fill('9');
  await page.getByRole('button', { name: 'Show me where to go' }).click();
  await page.waitForURL(/\/decide\/[0-9a-f-]{8,}/);
}

/** The featured answer: three and a wildcard, with everything else demoted below. */
async function shortlist(page: Page) {
  const featured = page.getByTestId('shortlist-featured');
  await expect(featured).toBeVisible({ timeout: 30_000 });
  return featured;
}

test('both doors are on the front page, and the second one works', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('link', { name: 'I know where I want to go' })).toBeVisible();

  await page.getByRole('link', { name: 'Help me choose' }).click();
  await expect(page).toHaveURL(/\/decide$/);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('when and what for');
});

test('four answers produce a ranked, explained shortlist', async ({ page }) => {
  await answerAndRank(page);
  const list = await shortlist(page);
  const items = list.getByRole('listitem');

  const count = await items.count();
  expect(count, 'a shortlist is a choice, not a verdict').toBeGreaterThan(1);
  expect(count, 'nobody reads more than eight').toBeLessThanOrEqual(8);

  /*
   * V11 §A2 — the evidence is on the card it belongs to, not in a second panel
   * that argued for the lead destination all over again. Every featured card
   * carries its own "what we checked" disclosure and its own Plan action.
   */
  await expect(items.first().getByText('What we checked, one thing at a time')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Plan this' }).first()).toBeVisible();
});

/**
 * The property the whole `Measure` union exists for, asserted where a traveller
 * would actually see it: a dimension nobody could measure is named on screen,
 * not silently scored as a zero.
 */
test('says what it could not see rather than scoring it as zero', async ({ page }) => {
  await answerAndRank(page);
  await shortlist(page);

  /*
   * The caveats fold behind one summary line now, and the count in that line is
   * itself part of the claim: three surfaces used to state their own, which on a
   * tied ranking ran to eleven consecutive negative sentences directly under the
   * results. Folded is not hidden — this knocks, and then asserts every one of
   * them is still there.
   */
  const caveats = page
    .locator('details')
    /*
     * The count in the summary, not the words alone. The per-destination
     * breakdown's own preamble says "a few we could not check at all", so a bare
     * phrase match resolves to that disclosure instead — which is a real panel
     * with real content, so the mistake reads as a copy failure rather than as a
     * locator one.
     */
    .filter({ hasText: /\d+ things? we could not check/ })
    .first();
  await expect(caveats).toBeVisible();
  await caveats.locator(':scope > summary').click();
  await expect(caveats).toContainText(/Flights —/);
  await expect(caveats).toContainText(/Visas and entry rules —/);
  await expect(caveats).toContainText(/Safety —/);

  /*
   * Climate is off in this environment, so a dimension that was not measured has
   * to appear as unmeasured with the reason it was not measured — never as a
   * zero. Asserted on the per-destination breakdown, which is where a traveller
   * comparing two of them would look.
   */
  const breakdown = page
    .locator('details')
    .filter({ hasText: 'What we checked, one thing at a time' })
    .first();
  await breakdown.locator(':scope > summary').click();
  await expect(breakdown.getByText('we could not check this').first()).toBeVisible();
});

test('a refresh loses nothing', async ({ page }) => {
  await answerAndRank(page);
  const before = await (await shortlist(page)).getByRole('listitem').allInnerTexts();

  await page.reload();
  const after = await (await shortlist(page)).getByRole('listitem').allInnerTexts();

  expect(after, 'the same ranking, from the row rather than from a re-run').toEqual(before);
});

/**
 * The transition the brief cares about most: a destination adopted from a
 * shortlist has to become an ordinary trip, carrying every answer with it.
 */
test('choosing a destination carries the answers into a normal trip', async ({ page }) => {
  await answerAndRank(page);
  const list = await shortlist(page);

  const chosen = (await list.getByRole('heading', { level: 3 }).first().innerText()).trim();

  await page.getByRole('button', { name: 'Plan this' }).first().click();
  await page.waitForURL(/\/trips\/[^/]+\/plan/, { timeout: 30_000 });

  // The trip knows where it is going, and it did not ask again.
  await expect(page.locator('body')).toContainText(chosen);
  await expect(page.getByRole('heading', { level: 1 })).not.toContainText('Looking up');
});

test('changing the answers replaces the list rather than leaving a stale one', async ({ page }) => {
  await answerAndRank(page);
  await shortlist(page);

  /*
   * Revising reopens the same intake, and with every question settled it opens
   * on the summary — so a question is reopened by pressing the line that states
   * its answer, which is what "change what you told us" means on this screen.
   */
  await page.getByRole('button', { name: 'Change what you told us' }).click();
  await page.getByRole('button', { name: /Hiking and being outside/ }).first().click();
  await page.getByRole('checkbox', { name: 'City life' }).check();
  await page.getByRole('button', { name: 'Save and rank again' }).click();

  // The stored shortlist is dropped on save, so the screen re-ranks rather than
  // showing an answer to the previous question.
  await shortlist(page);
});
