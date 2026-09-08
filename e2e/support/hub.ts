import { expect, type Page } from '@playwright/test';

/**
 * PRODUCTION UI V1 — the Trip Hub is five views under one nav (Overview ·
 * Days · Map · Plan · Prepare). A test that asserts on a section first opens
 * the view that holds it; the bottom bar carries the same views on phones.
 */
export type HubView = 'overview' | 'days' | 'map' | 'plan' | 'prepare';

/** EXPERIENCE V2 — the plan's own notes, alternatives and what was left out sit behind one disclosure on Prepare. */
export async function openPrepareNotes(page: Page): Promise<void> {
  const disclosure = page.getByTestId('prepare-notes-disclosure');
  if ((await disclosure.getAttribute('open')) === null) await disclosure.locator('summary').click();
  await expect(page.getByTestId('prepare')).toBeVisible({ timeout: 10_000 });
}

export async function openHubView(page: Page, view: HubView): Promise<void> {
  const width = page.viewportSize()?.width ?? 1440;
  // EXPERIENCE V2 — on a phone the bottom bar holds four views; Overview is the band's own title link.
  const tab = width < 640 ? (view === 'overview' ? page.getByTestId('hub-overview-link') : page.getByTestId(`hub-bottom-${view}`)) : page.getByTestId(`hub-link-${view}`);
  await expect(tab).toBeVisible({ timeout: 20_000 });
  await tab.click();
  await expect(page.locator(`#hub-view-${view}`)).toBeVisible({ timeout: 10_000 });
}

/**
 * Follow one of the trip band's actions, opening the overflow menu when the
 * viewport is too narrow to show it.
 *
 * The band shows its actions inline from the `sm` breakpoint and folds them
 * into "More" below it, so a phone-width test that clicks the action directly
 * waits sixty seconds for a control that is deliberately not there.
 */
export async function bandAction(page: Page, name: string | RegExp) {
  const direct = page.getByRole('link', { name }).or(page.getByRole('button', { name })).first();
  /*
   * Give the control a moment to appear before deciding it is hidden.
   *
   * A bare `isVisible()` samples once, so calling this straight after a
   * navigation asks whether a control is visible on a page that has not
   * painted yet — the answer is "no", and the fallback then hunts for an
   * overflow menu on a screen that has none.
   */
  await direct.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined);
  if (await direct.isVisible().catch(() => false)) return direct;
  /*
   * "More" is a <summary>, which carries no button role — matching it by role
   * waits for a control that does not exist. Its text is unique in the band.
   */
  await page.getByText('More', { exact: true }).first().click();
  return direct;
}

export async function useBandAction(page: Page, name: string | RegExp): Promise<void> {
  await (await bandAction(page, name)).click();
}
