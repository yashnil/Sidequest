import { appendFileSync, mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { createTrip, waitUntilInteractive } from './support/trip';
import { openHubView } from './support/hub';
import { answerUntilShortlist, startAdvisor } from './support/advisor';

/**
 * RELEASE-CANDIDATE LIVE ACCEPTANCE. Run only through `playwright.rc-live.config.ts`.
 *
 * Real model, real geocoder, real routers, the normal app. Results land in
 * `docs/release-candidate/live/`; the plans are read back from the run's own
 * database afterwards, because a green spec says only that a page appeared.
 */
const OUT = 'docs/release-candidate/live';
mkdirSync(OUT, { recursive: true });
const record = (row: Record<string, unknown>) => appendFileSync(`${OUT}/runs.ndjson`, `${JSON.stringify({ at: new Date().toISOString(), ...row })}\n`);
const shot = (page: Page, name: string) => page.screenshot({ path: `${OUT}/${name}.jpg`, type: 'jpeg', quality: 70 });

const TRIPS = [
  { label: 'utah-road-trip', destination: 'Moab, Arches and Canyonlands, Utah', start: '2027-04-12', end: '2027-04-17' },
  { label: 'kyoto-city', destination: 'Kyoto and Nara, Japan', start: '2027-04-05', end: '2027-04-11' },
  { label: 'tenerife-island', destination: 'Tenerife, Canary Islands', start: '2027-02-08', end: '2027-02-13' },
  { label: 'tanzania-safari', destination: 'Arusha and the Serengeti, Tanzania', start: '2027-07-05', end: '2027-07-13' },
];

test.describe.configure({ mode: 'serial' });

for (const trip of TRIPS) {
  test(`trip: ${trip.label}`, async ({ page }) => {
    const started = Date.now();
    await createTrip(page, trip.destination, { start: trip.start, end: trip.end });
    await page.waitForURL(/\/questionnaire$/, { timeout: 90_000 });
    const tripId = /\/trips\/([0-9a-f-]{36})\//.exec(page.url())?.[1] ?? null;
    const defaults = page.getByTestId('interview-smart-defaults');
    await waitUntilInteractive(defaults);
    await defaults.click();
    await expect(page).toHaveURL(/\/itinerary(#[a-z-]+)?$/, { timeout: 480_000 });
    await expect(page.getByTestId('route-overview')).toBeVisible({ timeout: 60_000 });
    record({ kind: 'trip', ...trip, tripId, seconds: Math.round((Date.now() - started) / 1000) });
    await shot(page, `${trip.label}-overview`);
    await openHubView(page, 'days');
    await shot(page, `${trip.label}-days`);
  });
}

for (const request of ['Remote monasteries and high passes in October.', 'Somewhere beautiful and relaxing.']) {
  test(`help me choose: ${request}`, async ({ page }) => {
    const started = Date.now();
    await startAdvisor(page, request);
    await answerUntilShortlist(page);
    await expect(page.getByTestId('advisor-shortlist')).toBeVisible({ timeout: 60_000 });
    /* The one bounded research call, when the list is weak, runs after the list is on screen. */
    await page.waitForTimeout(30_000);
    record({ kind: 'decide', request, url: page.url(), seconds: Math.round((Date.now() - started) / 1000) });
    await shot(page, `decide-${request.slice(0, 16).replace(/\W+/g, '-')}`);
  });
}
