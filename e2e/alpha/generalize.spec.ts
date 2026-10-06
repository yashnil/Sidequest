import { appendFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { createTrip, waitUntilInteractive } from '../support/trip';

/**
 * PRIVATE ALPHA — NEW DESTINATIONS THROUGH THE DEPLOYED APP (paid: one scan each).
 *
 *   SIDEQUEST_ALPHA_LIVE=1 SIDEQUEST_ALPHA_DESTINATIONS="Dolomites, Italy|Portugal"
 *
 * Smart defaults (scan → auto-pick → planner build). Trip ids and share links
 * are appended to SIDEQUEST_ALPHA_STATE so the plans can be read afterwards.
 */
const live = process.env.SIDEQUEST_ALPHA_LIVE === '1';
const destinations = (process.env.SIDEQUEST_ALPHA_DESTINATIONS ?? '').split('|').map((d) => d.trim()).filter(Boolean);
const out = process.env.SIDEQUEST_ALPHA_STATE ?? 'test-results/alpha-generalize.ndjson';

test.skip(!live || destinations.length === 0, 'Paid live suite: set SIDEQUEST_ALPHA_LIVE=1 and SIDEQUEST_ALPHA_DESTINATIONS.');

for (const [index, destination] of destinations.entries()) {
  test(`smart defaults: ${destination}`, async ({ page }) => {
    const start = `2027-0${6 + index}-08`;
    const end = `2027-0${6 + index}-13`;
    await createTrip(page, destination, { start, end });
    await page.waitForURL(/\/questionnaire$/, { timeout: 60_000 });
    const tripId = /\/trips\/([0-9a-f-]{36})\//.exec(page.url())![1]!;
    const defaults = page.getByTestId('interview-smart-defaults');
    await waitUntilInteractive(defaults);
    const began = Date.now();
    await defaults.click();
    await expect(page).toHaveURL(/\/itinerary(#[a-z-]+)?$/, { timeout: 540_000 });
    const seconds = Math.round((Date.now() - began) / 1000);
    await page.goto(`/trips/${tripId}/pack`);
    const mint = page.getByTestId('pack-share-link').getByRole('button', { name: 'Share this plan' });
    if (await mint.isVisible().catch(() => false)) {
      await waitUntilInteractive(mint);
      await mint.click();
    }
    const shareUrl = await page.getByLabel('Share link').inputValue({ timeout: 20_000 });
    appendFileSync(out, `${JSON.stringify({ destination, tripId, shareUrl, seconds })}\n`);
  });
}
