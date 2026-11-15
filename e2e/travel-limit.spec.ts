import { expect, test, type Page } from '@playwright/test';
import { openHubView } from './support/hub';
import { completeQuestionnaire, createTrip, waitUntilInteractive } from './support/trip';
import { summerTrip } from './support/dates';

/**
 * 2026-11 — A DAY OVER THE TRAVELLER'S OWN DAILY TRAVEL LIMIT, DECIDED ON THE PAGE.
 *
 * The planner writes every day a hard limit cannot hold, with the choices it
 * found (`package.planning.travelLimit`). These used to be sentences nobody
 * could act on. Now the executable ones are controls on the day — keep the
 * long day, or drop the traveller's own pick that takes it over — each with its
 * numbers before Apply; applying one changes the plan with no model call,
 * records a version, and Undo puts it back.
 *
 * The fixture scan reads the token `farpick` from what the traveller typed
 * (`discovery-scan/fixture.ts`) and adds four "… Far Reach …" places on a ring
 * about 45 km round the only base (`placement.ts#fixturePlacement`). Each alone
 * is a ~140-minute round trip, inside the 150-minute driving ceiling the
 * traveller states here (so the board lets them include it); any two on one
 * day are far past it. Four picks on a three-day trip cannot each have a day of
 * their own, so one day stays over the traveller's own limit because of their
 * own picks — and the planner's repair cannot move either away.
 */
const TRIP = summerTrip(3);
const FAR = /Far Reach (Lookout|Falls|Gorge|Tower)$/;

async function buildOverLimitTrip(page: Page): Promise<void> {
  await createTrip(page, 'farpick Mammoth Lakes', TRIP);
  await page.waitForURL(/\/questionnaire$/, { timeout: 20_000 });
  /* The traveller's own driving ceiling makes the limit hard; the wide reach keeps the far places on the board. */
  await completeQuestionnaire(page, { answers: { transport_mode: 'rent_car', daily_driving: '150', scenic_reach: 'best_regional' } });
  const find = page.getByTestId('interview-find-places');
  await waitUntilInteractive(find);
  await find.click();
  await expect(page).toHaveURL(/\/discover$/, { timeout: 30_000 });
  await expect(page.getByTestId('board-summary')).toBeVisible({ timeout: 60_000 });

  /* Include each as the traveller, not as the auto-pick: a toggle the auto-pick already set is cleared and set again. */
  const cards = page.getByRole('article').filter({ has: page.getByRole('heading', { name: FAR }) });
  await expect(cards).toHaveCount(4, { timeout: 15_000 });
  for (let index = 0; index < 4; index += 1) {
    const include = cards.nth(index).getByRole('button', { name: 'Include' });
    if ((await include.getAttribute('aria-pressed')) === 'true') {
      await include.click();
      await expect(include).toHaveAttribute('aria-pressed', 'false');
    }
    await include.click();
    await expect(include).toHaveAttribute('aria-pressed', 'true');
  }

  await page.getByRole('button', { name: /Build my trip|Rebuild my trip/ }).click();
  await expect(page).toHaveURL(/\/itinerary(#[a-z-]+)?$/, { timeout: 90_000 });
  await openHubView(page, 'days');
}

function rowsNamed(page: Page, name: string | RegExp) {
  return page.locator('#hub-view-days [data-row-kind="activity"]').filter({ hasText: name });
}

function openPanel(page: Page) {
  return page.locator('#hub-view-days [data-testid^="travel-limit-day-"][data-state="open"]').first();
}

async function dayOf(panel: ReturnType<typeof openPanel>): Promise<number> {
  const day = Number(((await panel.getAttribute('data-testid')) ?? '').replace('travel-limit-day-', ''));
  expect(day).toBeGreaterThan(0);
  return day;
}

test('dropping a far pick changes the day, is recorded as a version, and restoring brings it back', async ({ page }) => {
  test.setTimeout(300_000);
  await buildOverLimitTrip(page);

  /* A day over the limit asks for a decision, with real controls. */
  const panel = openPanel(page);
  await expect(panel).toBeVisible({ timeout: 30_000 });
  const dayNumber = await dayOf(panel);
  await expect(panel.getByTestId('travel-limit-headline')).toContainText(/past the 2 h 30 a day you set/);

  /* Every control is executable: keep the day, or drop a pick — each with its numbers before Apply. */
  const kinds = await panel.getByTestId('travel-limit-option').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-kind')));
  expect(kinds).toContain('accept_long_day');
  expect(kinds).toContain('drop_stop');
  expect(kinds.every((kind) => kind === 'accept_long_day' || kind === 'drop_stop')).toBe(true);
  await expect(panel.locator('[data-testid="travel-limit-option"][data-kind="accept_long_day"]')).toContainText(/past your 2 h 30 a day/);
  const drop = panel.locator('[data-testid="travel-limit-option"][data-kind="drop_stop"]').first();
  const label = ((await drop.locator('span.font-medium').first().textContent()) ?? '').trim();
  const name = label.replace(/^Drop /, '');
  expect(name).toMatch(FAR);
  await expect(drop.getByTestId('travel-limit-effect')).toContainText(/saves about .* of travel: day \d+ goes from about .* to about/);
  await expect(rowsNamed(page, name)).toHaveCount(1);
  /* Nothing to press before a choice is made. */
  await expect(panel.getByTestId('travel-limit-apply')).toBeDisabled();

  await drop.click();
  await panel.getByTestId('travel-limit-apply').click();
  await expect(page.getByTestId('edit-toast-message')).toContainText(`You dropped ${name} from day ${dayNumber}`, { timeout: 30_000 });

  /*
   * The day changed: the pick is gone from the plan, and the day says what was
   * chosen — as its decision when that brought it inside the limit, or above the
   * one choice left (keep the day) when other picks still hold it over.
   */
  await expect(rowsNamed(page, name)).toHaveCount(0, { timeout: 30_000 });
  const after = page.getByTestId(`travel-limit-day-${dayNumber}`);
  await expect(after.locator('[data-testid="travel-limit-decided"], [data-testid="travel-limit-history"]')).toContainText(`You dropped ${name}`);
  if ((await after.getAttribute('data-state')) === 'open') {
    const left = await after.getByTestId('travel-limit-option').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-kind')));
    expect(left).toEqual(['accept_long_day']);
  }
  await page.reload();
  await openHubView(page, 'days');
  await expect(rowsNamed(page, name)).toHaveCount(0);

  /* A version was recorded under the change's own words. */
  await openHubView(page, 'overview');
  const versions = page.getByTestId('trip-versions');
  await expect(versions).toBeVisible();
  await versions.locator('summary').click();
  await expect(versions.getByTestId('trip-version-row').filter({ hasText: `You dropped ${name}` }).first()).toBeVisible({ timeout: 15_000 });

  /* Going back is the exact restore: the version before the drop comes back, the pick with it, and its day asks again. */
  await versions.getByTestId('trip-version-restore').first().click();
  await expect(page.getByTestId('edit-toast-message')).toContainText('Restored', { timeout: 15_000 });
  await openHubView(page, 'days');
  await expect(rowsNamed(page, name)).toHaveCount(1, { timeout: 30_000 });
  await expect(page.getByTestId(`travel-limit-day-${dayNumber}`)).toHaveAttribute('data-state', 'open');
});

test('keeping the long day moves nothing, and the toast’s Undo reopens the decision', async ({ page }) => {
  test.setTimeout(300_000);
  await buildOverLimitTrip(page);
  const panel = openPanel(page);
  await expect(panel).toBeVisible({ timeout: 30_000 });
  const dayNumber = await dayOf(panel);
  const stopsBefore = await page.locator('#hub-view-days [data-row-kind="activity"]').count();

  await panel.locator('[data-testid="travel-limit-option"][data-kind="accept_long_day"]').click();
  await panel.getByTestId('travel-limit-apply').click();
  await expect(page.getByTestId('edit-toast-message')).toContainText(/stays as planned/, { timeout: 30_000 });
  const decided = page.getByTestId(`travel-limit-day-${dayNumber}`);
  await expect(decided).toHaveAttribute('data-state', 'decided');
  await expect(decided.getByTestId('travel-limit-decided')).toContainText(`You chose to keep day ${dayNumber} as planned`);
  await expect(page.locator('#hub-view-days [data-row-kind="activity"]')).toHaveCount(stopsBefore);

  await page.getByTestId('edit-toast-undo').click();
  await expect(page.getByTestId(`travel-limit-day-${dayNumber}`)).toHaveAttribute('data-state', 'open', { timeout: 30_000 });
});
