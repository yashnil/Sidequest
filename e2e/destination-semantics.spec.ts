import { expect, test, type Page } from '@playwright/test';
import { completeQuestionnaire, waitUntilInteractive } from './support/trip';

/**
 * V8.1 — "THE CANADIAN ROCKIES" IS A MOUNTAIN REGION, NEVER A SHOP IN CALGARY.
 *
 * The production defect, end to end: a traveller types a broad natural region
 * on New trip, asks Sidequest to choose when, and reaches the interview. The
 * suite's fixture resolver replays the public geocoder's real rows for this
 * phrase (five businesses named after the range — `lib/destinations/fixtures/
 * nominatim/`) and the recorded interpreter names the parks inside it, so what
 * is exercised here is the semantic gate on the evidence that fooled
 * production, not a synthetic world.
 *
 * Runs under `playwright.timing.config.ts` (fixture climate), so the review's
 * timing pick exists and its regional sampling can be seen.
 */

const PHRASE = 'the Canadian Rockies';
const CALGARY_STREET = /17 Avenue|Bankview|Resorts of the Canadian Rockies|Chalets|Rafting|School/i;

function continueButton(page: Page) {
  return page.getByTestId('setup-continue').locator('visible=true').first();
}

test('a broad natural region is framed as a region with gateways, deferred to the review for timing, and interviewed as mountain country', async ({ page }, testInfo) => {
  await page.goto('/trips/new');
  const field = page.getByTestId('destination-input');
  await waitUntilInteractive(field);
  await field.fill(PHRASE);
  const canvas = page.getByTestId('destination-canvas');
  await expect(canvas).toContainText(PHRASE);
  await continueButton(page).click();

  /* --- destination screen: framed as a region, captioned honestly, Calgary only as a gateway ------------- */
  await expect(canvas).toHaveAttribute('data-state', 'framed', { timeout: 20_000 });
  await expect(page.getByTestId('destination-canvas-scope')).toContainText('A mountain region');
  const map = page.getByTestId('destination-map');
  await expect(map).toContainText(/areas inside this region/i);
  await expect(map).toContainText(/Gateways: .*Calgary/);
  await expect(page.locator('body')).not.toContainText(CALGARY_STREET);
  await page.screenshot({ path: testInfo.outputPath('01-destination.png'), fullPage: true });

  /* --- timing: "tell me when it is best" is accepted and deferred to the review (V7 §7) ------------------- */
  await expect(page.getByTestId('timing-best')).toBeVisible();
  await page.getByTestId('timing-best').click();
  await expect(page.getByTestId('timing-deferred')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('02-timing.png'), fullPage: true });
  await continueButton(page).click();
  await page.getByTestId('nights-7').click();
  await continueButton(page).click();
  await page.getByTestId('party-couple').click();
  await continueButton(page).click();
  await expect(page.getByTestId('setup-flow')).toHaveAttribute('data-step', 'fixed');
  await continueButton(page).click();
  await page.waitForURL(/\/trips\/[^/]+\/(plan|questionnaire)/, { timeout: 30_000 });

  /* --- the plan door never offers a business as a reading of the phrase ------------------------------------ */
  await expect(page.locator('body')).not.toContainText(CALGARY_STREET);
  await expect(page.getByText(/which one/i)).toHaveCount(0);

  /* --- interview intro: Sidequest understands the kind of trip -------------------------------------------- */
  if (!/\/questionnaire/.test(page.url())) {
    await page.waitForURL(/\/questionnaire/, { timeout: 30_000 });
  }
  const understanding = page.getByTestId('interview-understanding');
  await expect(understanding).toBeVisible({ timeout: 30_000 });
  await expect(understanding).toContainText(/Mountain country|A natural region/);
  await expect(understanding).not.toContainText(/Dense city|Good public transport/);
  await expect(page.locator('body')).not.toContainText(CALGARY_STREET);
  await page.screenshot({ path: testInfo.outputPath('03-understanding.png'), fullPage: true });

  /* --- the questions asked are about the mountains, not the metro ---------------------------------------- */
  const asked = await completeQuestionnaire(page);
  expect(asked, `asked: ${asked.join(', ')}`).toEqual(expect.arrayContaining(['hike_appetite', 'altitude_comfort']));
  expect(asked.some((id) => id === 'road_comfort' || id === 'daily_driving' || id === 'base_moves'), `asked: ${asked.join(', ')}`).toBe(true);
  for (const urban of ['transit_comfort', 'walking_tolerance', 'day_trips', 'late_nights', 'stairs_hills']) expect(asked, `asked ${urban}`).not.toContain(urban);
  await expect(page.getByTestId('interview-review')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('04-review.png'), fullPage: true });

  /* --- the review's pick is scored across the region, and says so ------------------------------------------ */
  await expect(page.getByTestId('timing-accept')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('review-timing-regional-note')).toContainText(/points across the region/);
  await expect(page.locator('body')).not.toContainText(CALGARY_STREET);
});

test('the gate on the recorded corpus: a same-named village elsewhere never stands for a region (Patagonia), a path never stands for a coast (the Amalfi Coast)', async ({ page }) => {
  for (const [phrase, never, scope] of [
    ['Patagonia', /Arizona|Colombia|Bahía Blanca/i, /A travel region|A natural region/],
    ['the Amalfi Coast', /Broken Hill|New South Wales|Australia/i, /A coast/],
  ] as const) {
    await page.goto('/trips/new');
    const field = page.getByTestId('destination-input');
    await waitUntilInteractive(field);
    await field.fill(phrase);
    await continueButton(page).click();
    const canvas = page.getByTestId('destination-canvas');
    await expect(canvas).toHaveAttribute('data-state', 'framed', { timeout: 20_000 });
    await expect(page.getByTestId('destination-canvas-scope')).toContainText(scope);
    await expect(page.locator('body')).not.toContainText(never);
  }
});
