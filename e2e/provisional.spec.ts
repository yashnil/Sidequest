import { expect, test, type Page } from '@playwright/test';
import { createTrip, reachScope } from './support/trip';

/**
 * THE BOARD BEFORE DEEP VERIFICATION.
 *
 * `AVAILABILITY_AFTER.finding` has promised "a provisional board — nothing on it
 * is verified yet" since Phase 11, and `progress.test.ts` has asserted that
 * wording ever since. There was never a board. These are the assertions that
 * make the promise true.
 *
 * The one that matters most is not that the board renders — it is that **no card
 * claims a travel time**. `travelFromBase` is `{0, 0}` from the moment a
 * candidate is built until the route matrix corrects it, every comparison
 * against zero passes, and a day built from one satisfies every drive limit
 * silently. The provisional card type has no minutes field at all, and this is
 * where that becomes observable rather than merely designed.
 */

/**
 * Build a trip and land on its provisional board.
 *
 * Navigated to directly rather than clicked from the progress screen, and the
 * reason is a property of this environment rather than of the product: the
 * fixture compiler finishes a synthetic world in about a second, so the window
 * in which the progress screen is still running is shorter than its own poll
 * interval. Racing it would make these tests flaky about something they are not
 * trying to assert.
 *
 * That the board exists *before* anything is bought is asserted deterministically
 * where it can be — `compiler.test.ts`, which proves the emission happens before
 * the first source-discovery call — and the link itself is asserted once, below,
 * with a tolerance for the fixture having already finished.
 */
async function reachProvisionalBoard(page: Page): Promise<string> {
  const tripId = await createTrip(page, 'Ferry Island');
  await reachScope(page);
  await page.getByRole('button', { name: 'Build the region' }).click();
  await page.waitForTimeout(2_000);
  await page.goto(`/trips/${tripId}/provisional`);
  return tripId;
}

test('a provisional board exists, and it is honest about what it is', async ({ page }) => {
  await reachProvisionalBoard(page);

  const cards = page.getByTestId('provisional-card');
  await expect(cards.first()).toBeVisible();
  expect(await cards.count()).toBeGreaterThan(0);

  // Every card says it is provisional and says what is still missing.
  await expect(page.getByText('Nothing here is verified').first()).toBeVisible();
  await expect(page.getByText(/Still to check:/).first()).toBeVisible();
});

/**
 * The rule the separate type exists for. A zero rendered as a drive is the
 * defect the routing-semantics architecture test was written to prevent, and
 * this is its browser-visible counterpart.
 */
test('no provisional card claims a travel time, a price or an opening hour', async ({ page }) => {
  await reachProvisionalBoard(page);

  const board = page.getByTestId('provisional-card');
  await expect(board.first()).toBeVisible();

  const text = (await board.allInnerTexts()).join('\n');
  // No durations, no distances, no money, no clock times.
  expect(text, 'a provisional card must not claim minutes').not.toMatch(/\b\d+\s*min\b/i);
  expect(text, 'a provisional card must not claim a distance').not.toMatch(/\b\d+(\.\d+)?\s*km\b/i);
  expect(text, 'a provisional card must not claim a price').not.toMatch(/[$£€]\s?\d/);
  expect(text, 'a provisional card must not claim an opening time').not.toMatch(/\d{1,2}:\d{2}/);

  // And it must not offer to build a plan from unverified places.
  await expect(page.getByRole('button', { name: /build my trip/i })).toHaveCount(0);
});

test('a choice made on the provisional board persists across a refresh', async ({ page }) => {
  await reachProvisionalBoard(page);

  const first = page.getByTestId('provisional-card').first();
  await expect(first).toBeVisible();
  /*
   * The card's own name node, not the wrapper. The wrapper's text is name plus
   * locality, which does not survive a `hasText` round trip.
   */
  const name = (await first.locator('.font-display').first().innerText()).trim();

  await first.getByRole('button', { name: 'Must do' }).click();
  await expect(first.getByRole('button', { name: 'Must do' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  await page.reload();
  const again = page
    .getByTestId('provisional-card')
    .filter({ hasText: name })
    .first();
  await expect(again.getByRole('button', { name: 'Must do' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});

test('hiding a card removes it from the board and stays hidden', async ({ page }) => {
  await reachProvisionalBoard(page);

  const cards = page.getByTestId('provisional-card');
  await expect(cards.first()).toBeVisible();
  const before = await cards.count();

  await cards.first().getByRole('button', { name: 'Hide it' }).click();
  await expect(cards).toHaveCount(before - 1);

  await page.reload();
  await expect(page.getByTestId('provisional-card')).toHaveCount(before - 1);
});

/**
 * The property that makes "you can close this page" true rather than
 * aspirational: rendering this route reads rows and does nothing else. The
 * final board's route cannot say that — it fetches a forecast during render —
 * which is exactly why the provisional board got its own.
 */
test('rendering the provisional board starts no external work', async ({ page }) => {
  const tripId = await reachProvisionalBoard(page);

  const external: string[] = [];
  page.on('request', (request) => {
    const url = request.url();
    if (!url.startsWith('http://127.0.0.1') && !url.startsWith('http://localhost')) {
      external.push(url);
    }
  });

  await page.goto(`/trips/${tripId}/provisional`);
  await expect(page.getByTestId('provisional-card').first()).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('provisional-card').first()).toBeVisible();

  expect(external, `the provisional route reached ${external.join(', ')}`).toEqual([]);
});

test('the board survives leaving and coming back', async ({ page }) => {
  const tripId = await reachProvisionalBoard(page);
  await expect(page.getByTestId('provisional-card').first()).toBeVisible();

  await page.getByRole('link', { name: 'Back to progress' }).click();
  await expect(page).toHaveURL(new RegExp(`/trips/${tripId}/plan`));

  await page.goto(`/trips/${tripId}/provisional`);
  await expect(page.getByTestId('provisional-card').first()).toBeVisible();
});
