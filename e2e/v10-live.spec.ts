import { expect, test } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { createTrip, completeQuestionnaire } from './support/trip';

/**
 * V10 §17 §20 — THE ONE LIVE FOUNDER BUILD.
 *
 * Run only from `playwright.v10-live.config.ts`, which starts the app on the
 * real provider stack. Everything else about V10 is proven deterministically;
 * what this and only this can prove is that the **enlarged composition envelope**
 * — the coverage graph, the jurisdictions kept apart from the destination, the
 * gateways, the official access facts and the explicit route objectives — reaches
 * a real model, inside the one-call budget and the wire, and comes back as a trip
 * whose route-critical names place and whose base transfers are measured by a
 * real router.
 *
 * Exactly one Anthropic call: the composition. No retry, no critic, no repair —
 * the architecture forbids all three, and the run asserts the ledger afterwards.
 */
test('V10 live: Iceland, one composition call, through the real stack', async ({ page }) => {
  test.setTimeout(420_000);
  const tripId = await createTrip(page, 'Iceland', { start: '2026-09-21', end: '2026-09-30' }, { mustDo: 'Glaciers, waterfalls and the black sand coast. No gravel roads.' });
  await completeQuestionnaire(page);

  await page.getByTestId('interview-build-trip').click();
  await expect(page).toHaveURL(new RegExp(`/trips/${tripId}/(build|itinerary)`), { timeout: 30_000 });
  await expect(page).toHaveURL(new RegExp(`/trips/${tripId}/itinerary(#[a-z-]+)?$`), { timeout: 300_000 });
  await expect(page.getByTestId('route-overview')).toBeVisible({ timeout: 60_000 });

  /*
   * The trip id is the artifact: the plan itself is read out of the database
   * afterwards with `dump-trip.mjs`, which is the tool that already knows how to
   * unpack the package, the preservation report and the composition attempts.
   */
  writeFileSync('.claude-private/artifacts/v10/live/trip-id.txt', `${tripId}\n`);

  await page.screenshot({ path: '.claude-private/artifacts/v10/live/01-itinerary.png', fullPage: true, animations: 'disabled' });
});
