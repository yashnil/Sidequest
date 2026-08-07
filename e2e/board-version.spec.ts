import { expect, test, type Page } from '@playwright/test';
import { createTrip, reachScope } from './support/trip';

/**
 * A COUNT MUST DESCRIBE THE BOARD IT IS SITTING BESIDE.
 *
 * The defect these guard: every derived summary on both boards was computed from
 * client state seeded once from props and never resynchronised. A number is a
 * number, so a total describing the state of an hour ago looks exactly like a
 * total describing now — there is nothing on screen to notice.
 *
 * Two properties are asserted, and they are different claims:
 *
 * 1. **The summary follows the server.** State moves underneath a page that is
 *    already open; the counts beside the board must be the server's answer after
 *    the next re-render, not the copy the component was born with.
 * 2. **Nothing on the page describes a different version from anything else.**
 *    Every derived summary stamps the board version it was computed against, and
 *    the whole page must agree — checked at 390×844, where the same controls are
 *    also measured against WCAG 2.5.5's 44 px minimum, because a summary that is
 *    correct and untappable is not a fixed screen.
 *
 * Offline throughout: the compiler runs against the deterministic synthetic
 * worlds. "Ferry Island" is a synthetic test world; no real destination is named.
 */

/** WCAG 2.5.5 (AA), and the product's own floor. */
const MIN_TARGET_PX = 44;

/**
 * Build a trip and land on its provisional board.
 *
 * Navigated to directly rather than clicked from the progress screen, for the
 * reason `provisional.spec.ts` records: the fixture compiler finishes a
 * synthetic world in about a second, which is shorter than the progress
 * screen's own poll interval.
 */
async function reachProvisionalBoard(page: Page): Promise<string> {
  const tripId = await createTrip(page, 'Ferry Island');
  await reachScope(page);
  await page.getByRole('button', { name: 'Build the region' }).click();
  await page.waitForTimeout(2_000);
  await page.goto(`/trips/${tripId}/provisional`);
  await expect(page.getByTestId('provisional-card').first()).toBeVisible({ timeout: 30_000 });
  return tripId;
}

test('a summary never renders a total the server has already moved past', async ({
  page,
  context,
}) => {
  const tripId = await reachProvisionalBoard(page);

  const cards = page.getByTestId('provisional-card');
  expect(await cards.count()).toBeGreaterThan(1);

  const marked = page.getByTestId('count-marked');
  await expect(marked).toHaveText('0');

  // One decision here.
  await cards.nth(0).getByRole('button', { name: 'Must do' }).click();
  await expect(marked).toHaveText('1');

  /*
   * A second decision made somewhere else entirely.
   *
   * A second tab is the cheapest way to move the stored state underneath a page
   * that is already open, and it is not a contrived one: the product's own copy
   * says "you can close this page", so two views of one trip is a state it
   * invites. A rebuild produces the same situation with a new board version.
   */
  const other = await context.newPage();
  await other.goto(`/trips/${tripId}/provisional`);
  await expect(other.getByTestId('provisional-card').first()).toBeVisible({ timeout: 30_000 });
  await other.getByTestId('provisional-card').nth(1).getByRole('button', { name: 'Must do' }).click();
  await expect(other.getByTestId('count-marked')).toHaveText('2');
  await other.close();

  /*
   * Now act on the first page, which re-renders it against stored state.
   *
   * Before the fix this component held its own copy of the marks and only ever
   * patched it, so the total stayed at one — its own one — beside a board the
   * server had already told it held two decisions. The board was the server's;
   * the number was not.
   */
  await cards.nth(0).getByRole('button', { name: 'Interested' }).click();
  await expect(marked).toHaveText('2', { timeout: 15_000 });

  // And the whole page still describes one board.
  await expectOneVersionOnThePage(page);

  // A refresh reproduces it rather than producing a third answer.
  await page.reload();
  await expect(page.getByTestId('count-marked')).toHaveText('2');
  await expectOneVersionOnThePage(page);
});

test('on a small screen the board agrees with itself and every control is tappable', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await reachProvisionalBoard(page);

  await expectOneVersionOnThePage(page);

  /*
   * Height, not width: these controls are laid out in rows that fill the card,
   * so the short dimension is the one that was 32 px. Every button and every
   * disclosure on the board, rather than a sample — one control left behind is
   * exactly the shape this defect had.
   */
  const controls = page.locator(
    '[data-testid="provisional-board"] button, [data-testid="provisional-board"] summary, [data-testid="provisional-board"] a[class*="inline-flex"]',
  );
  const count = await controls.count();
  expect(count).toBeGreaterThan(0);

  for (let index = 0; index < count; index += 1) {
    const control = controls.nth(index);
    if (!(await control.isVisible().catch(() => false))) continue;
    const box = await control.boundingBox();
    if (!box) continue;
    const name = (await control.innerText().catch(() => '')).trim().slice(0, 40);
    expect(box.height, `"${name}" is ${box.height}px tall`).toBeGreaterThanOrEqual(MIN_TARGET_PX);
  }

  // Nothing overflows the viewport horizontally at 390px.
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollWidth).toBeLessThanOrEqual(390);
});

/**
 * Every stamped summary on the page names the same board.
 *
 * The stamps are written by the same call that produced the numbers, so a
 * disagreement here is a summary that outlived what it describes.
 */
async function expectOneVersionOnThePage(page: Page): Promise<void> {
  const versions = await page.locator('[data-board-version]').evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute('data-board-version') ?? ''),
  );
  expect(versions.length, 'no summary declared the board it describes').toBeGreaterThan(1);
  expect(new Set(versions).size, `the page carries ${new Set(versions).size} board versions`).toBe(1);
}
