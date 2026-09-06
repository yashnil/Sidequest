import { expect, type Page } from '@playwright/test';

/**
 * PRODUCTION UI V1 — the Trip Hub is five views under one nav (Overview ·
 * Days · Map · Plan · Prepare). A test that asserts on a section first opens
 * the view that holds it; the bottom bar carries the same views on phones.
 */
export type HubView = 'overview' | 'days' | 'map' | 'plan' | 'prepare';

export async function openHubView(page: Page, view: HubView): Promise<void> {
  const width = page.viewportSize()?.width ?? 1440;
  const tab = width < 640 ? page.getByTestId(`hub-bottom-${view}`) : page.getByTestId(`hub-link-${view}`);
  await expect(tab).toBeVisible({ timeout: 20_000 });
  await tab.click();
  await expect(page.locator(`#hub-view-${view}`)).toBeVisible({ timeout: 10_000 });
}
