import { expect, type Page } from '@playwright/test';
import { createTrip, waitForLookup, waitUntilInteractive } from './trip';

/**
 * V9 — the shortest road to a built trip on the fixture composer: the setup
 * door, the interview's smart defaults, the hub. Returns the trip id.
 */
/** Dates ahead of the real clock, so the trip is a plan and not a memory: the engines rank nothing on a past trip. */
export const FUTURE_DATES = { start: '2026-11-10', end: '2026-11-14' };

export async function buildFixtureTrip(page: Page, destination = 'Mammoth Lakes', dates: { start: string; end: string } = FUTURE_DATES): Promise<string> {
  const id = await createTrip(page, destination, dates);
  if (/\/plan/.test(page.url())) await waitForLookup(page);
  await page.goto(`/trips/${id}/questionnaire`);
  const defaults = page.getByTestId('interview-smart-defaults');
  await waitUntilInteractive(defaults);
  await defaults.click();
  await page.waitForURL(/\/itinerary$/, { timeout: 120_000 });
  await expect(page.getByTestId('atlas-band')).toBeVisible({ timeout: 30_000 });
  return id;
}

/** Sign in through the fixture door (`SIDEQUEST_AUTH_PROVIDER=fixture`, set by the suite). */
export async function signInFixture(page: Page, email: string): Promise<void> {
  await page.goto('/signin');
  const door = page.getByTestId('signin-fixture');
  await waitUntilInteractive(door);
  await door.click();
  await page.getByTestId('signin-email').fill(email);
  await page.getByTestId('signin-submit').click();
  await page.waitForURL(/\/trips/, { timeout: 30_000 });
}

/**
 * The first booking need whose "Mark booked" is actually on screen — the stays
 * group folds its member rows inside a disclosure, so "the first open row" can
 * resolve to a button nobody can press.
 */
export function visibleOpenNeed(page: Page): { row: ReturnType<Page['locator']>; markBooked: ReturnType<Page['locator']> } {
  const markBooked = page.locator('#hub-view-book').locator('[data-testid="booking-mark-booked"]:visible').first();
  const row = markBooked.locator('xpath=ancestor::*[@data-testid="booking-row"][1]');
  return { row, markBooked };
}
