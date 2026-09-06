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
