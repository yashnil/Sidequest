import { expect, test } from '@playwright/test';

/**
 * V11 §5 — THE DESIGN LAB RENDERS.
 *
 * There is no React render-testing library in this repository — components are
 * proved through pure functions and through the browser — so a page that throws
 * at render would otherwise be caught by nobody until somebody opened it. The
 * lab is the visual source of truth; a broken one is worse than none, because
 * every new component is told to copy from it.
 *
 * Deliberately shallow. This asserts that the page renders, that each section a
 * component author is sent to find is present, and that the four-word status
 * vocabulary is the one on show. It does not assert pixels: that is what the
 * screenshot review is for.
 */
test('the design lab renders every pattern a component author is sent to copy', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto('/labs/design');
  await expect(page.getByRole('heading', { level: 1, name: 'Design lab' })).toBeVisible();

  for (const section of [
    'Typography',
    'Buttons',
    'Status — four words, and only four',
    'Pills',
    'Surfaces',
    'Itinerary timeline',
    'Recommendation card',
    'Reranking controls',
    'Map markers',
    'Loading, empty and error',
    'Radius',
  ]) {
    await expect(page.getByRole('heading', { level: 2, name: section })).toBeVisible();
  }

  /* The four words, and no fifth one masquerading as a status. */
  for (const word of ['Confirmed', 'Planned', 'Check', 'Still checking']) {
    await expect(page.getByText(word, { exact: true }).first()).toBeVisible();
  }

  expect(errors, errors.join('\n')).toEqual([]);
});

test('the design lab names no real destination, because it shows patterns', async ({ page }) => {
  /*
   * The fixture-quarantine guard enforces this over the source. Asserting it
   * over the *rendered* page too is the cheap half of the same promise: a lab
   * that drifts into real place names becomes a second, unversioned opinion
   * about how destinations are written.
   */
  await page.goto('/labs/design');
  const text = (await page.locator('main, body').first().innerText()).toLowerCase();
  for (const place of ['banff', 'jasper', 'patagonia', 'peru', 'iceland', 'kyrgyzstan']) {
    expect(text, `the lab should not name ${place}`).not.toContain(place);
  }
});
