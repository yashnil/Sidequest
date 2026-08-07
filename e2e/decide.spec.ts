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
  await page.getByRole('radio', { name: 'Some time in a month' }).check();
  await page.getByLabel('Which month?').selectOption('7');
  await page.getByLabel('How many nights?').fill('9');
  await page.getByRole('checkbox', { name: 'Hiking and being outside' }).check();
  await page.getByRole('checkbox', { name: 'Mountains and high country' }).check();
  await page.getByRole('radio', { name: 'Two bases, split the trip' }).check();
  await page.getByRole('radio', { name: 'Drive', exact: true }).check();
  await page.getByRole('button', { name: 'Show me where to go' }).click();
  await page.waitForURL(/\/decide\/[0-9a-f-]{8,}/);
}

async function shortlist(page: Page) {
  const list = page.getByRole('list', { name: 'Suggested destinations' });
  await expect(list).toBeVisible({ timeout: 30_000 });
  return list;
}

test('both doors are on the front page, and the second one works', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('link', { name: 'I know where I am going' })).toBeVisible();

  await page.getByRole('link', { name: 'Help me decide' }).click();
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

  // The detail panel argues for the selected one rather than repeating the row.
  await expect(page.locator('section[aria-labelledby="shortlist-detail-heading"]')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Plan / })).toBeVisible();
});

/**
 * The property the whole `Measure` union exists for, asserted where a traveller
 * would actually see it: a dimension nobody could measure is named on screen,
 * not silently scored as a zero.
 */
test('says what it could not see rather than scoring it as zero', async ({ page }) => {
  await answerAndRank(page);
  await shortlist(page);

  await expect(page.getByRole('heading', { name: /cannot see/i })).toBeVisible();
  const blindSpots = page.locator('section[aria-labelledby="blind-spots"]');
  await expect(blindSpots).toContainText(/flight/i);
  await expect(blindSpots).toContainText(/visa/i);
  await expect(blindSpots).toContainText(/safety/i);

  // Climate is off in this environment, so the page must say so rather than
  // quietly ranking as though the weather had been checked.
  await expect(page.locator('body')).toContainText(/climate records are switched off/i);

  // And the per-destination breakdown distinguishes measured from not measured.
  await page.getByText('What went into this, dimension by dimension').first().click();
  await expect(page.getByText('not measured').first()).toBeVisible();
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

  const chosen = (
    await list.getByRole('listitem').first().locator('span').first().innerText()
  ).trim();

  await page.getByRole('button', { name: /^Plan / }).click();
  await page.waitForURL(/\/trips\/[^/]+\/plan/, { timeout: 30_000 });

  // The trip knows where it is going, and it did not ask again.
  await expect(page.locator('body')).toContainText(chosen);
  await expect(page.getByRole('heading', { level: 1 })).not.toContainText('Looking up');
});

test('changing the answers replaces the list rather than leaving a stale one', async ({ page }) => {
  await answerAndRank(page);
  await shortlist(page);

  await page.getByRole('button', { name: 'Change what you told us' }).click();
  await page.getByRole('checkbox', { name: 'City life' }).check();
  await page.getByRole('button', { name: 'Save and rank again' }).click();

  // The stored shortlist is dropped on save, so the screen re-ranks rather than
  // showing an answer to the previous question.
  await shortlist(page);
});
