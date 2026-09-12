import { expect, type Page } from '@playwright/test';

/**
 * PRODUCTION UI V1 — the Trip Hub is six views under one nav (Trip · Days ·
 * Map · Plan · Book · Prepare; V9 added Book). A test that asserts on a
 * section first opens the view that holds it; the bottom bar carries Days ·
 * Book · Prepare · Map on phones, and Plan is reached from the desktop nav.
 */
export type HubView = 'overview' | 'days' | 'map' | 'plan' | 'book' | 'prepare';

/** EXPERIENCE V2 — the plan's own notes, alternatives and what was left out sit behind one disclosure on Prepare. */
export async function openPrepareNotes(page: Page): Promise<void> {
  const disclosure = page.getByTestId('prepare-notes-disclosure');
  if ((await disclosure.getAttribute('open')) === null) await disclosure.locator('summary').click();
  await expect(page.getByTestId('prepare')).toBeVisible({ timeout: 10_000 });
}

export async function openHubView(page: Page, view: HubView): Promise<void> {
  const width = page.viewportSize()?.width ?? 1440;
  // EXPERIENCE V2 — on a phone the bottom bar holds four views; Overview is the band's own title link.
  // V9 — Plan is not in the phone bar; a phone test reaches it through the address (`#plan`), which the shell honours.
  if (width < 640 && view === 'plan') {
    await page.evaluate(() => {
      /*
       * Clear it first and tell the shell outright. Assigning the hash it
       * already holds fires no `hashchange`, so a second visit to Plan in the
       * same page — or a load that arrived with the hash already set — would
       * leave the view closed while the address says it is open.
       */
      window.location.hash = '';
      window.location.hash = '#plan';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    await expect(page.locator('#hub-view-plan')).toBeVisible({ timeout: 10_000 });
    return;
  }
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
  /*
   * `visible=true` before `.first()`, not after: a band renders the same
   * control twice — once in the row and once inside "More" — and one of the two
   * is hidden at any width. Taking the first in DOM order and then asking
   * whether it is visible reads the hidden copy and sends the caller hunting
   * for an overflow menu it did not need.
   */
  const direct = page.getByRole('link', { name }).or(page.getByRole('button', { name })).locator('visible=true').first();
  /*
   * "More" is a <summary>, which carries no button role — matching it by role
   * waits for a control that does not exist. Its text is unique in the band.
   */
  const more = page.getByText('More', { exact: true }).locator('visible=true').first();
  /*
   * Wait for whichever of the two arrives, rather than giving the direct
   * control a fixed budget and then committing to the overflow menu.
   *
   * A bare `isVisible()` samples once, so asking straight after a navigation
   * reads a page that has not painted. A short fixed wait instead of that is
   * no better: it passes alone and on a quiet machine, and under a
   * single-worker run of the whole project the board simply takes longer than
   * the budget to paint, after which the fallback opens — or, when a previous
   * call in the same test already opened it, *closes* — the overflow menu and
   * then clicks a control that is no longer on screen. Racing the
   * two is the honest wait — it ends as soon as either is on screen. `.first()`
   * closes the race: once the menu is open both are on screen at the same
   * time, and a bare `.or()` of two present controls is a strict-mode
   * violation rather than a satisfied wait.
   */
  await expect(direct.or(more).first()).toBeVisible({ timeout: 30_000 });
  if (await direct.isVisible().catch(() => false)) return direct;
  await more.click();
  return direct;
}

export async function useBandAction(page: Page, name: string | RegExp): Promise<void> {
  await (await bandAction(page, name)).click();
}
