import { mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { createTrip, waitUntilInteractive } from './support/trip';

/**
 * DESTINATION-AWARE INTERVIEW GLOBALITY — THE DENSE CITY, END TO END.
 *
 * The seeded destination index (`e2e/support/destination-index.ndjson`) holds
 * one invented metropolis: seven million people, a forty-kilometre extent, a
 * `city` feature type. Picked from the composer's suggestions exactly as the
 * founder picked a real one, it must open an interview about food, streets,
 * culture and the hills — never lakes, geothermal and hot springs — and the
 * sidebar must not assume a car or a driving radius. Nothing here names a
 * real place; the behaviour has to come from the traits.
 */
const SHOT_DIR = '.claude-private/artifacts/interview-globality';
const DATES = { start: '2026-10-13', end: '2026-10-18' };

async function pickSeededCity(page: Page): Promise<void> {
  // The synthetic index is seeded on this page's render.
  await page.goto('/decide');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await createTrip(page, 'Meridian', DATES, { pickSuggestion: /Meridian Harbour/ });
  if (/\/plan/.test(page.url())) {
    await expect(page.getByRole('heading', { level: 1 })).not.toContainText('Looking up', { timeout: 20_000 });
  }
  const id = /\/trips\/([^/]+)\//.exec(page.url())?.[1];
  await page.goto(`/trips/${id}/questionnaire`);
}

test('a dense city picked from the index is interviewed as a city: balanced first screen, transit read, no radius', async ({ page }, testInfo) => {
  mkdirSync(SHOT_DIR, { recursive: true });
  const suffix = testInfo.project.name;
  await pickSeededCity(page);

  // The understanding screen: a confident transit read, not a car.
  const assumption = page.getByTestId('interview-assumption');
  await expect(assumption).toBeVisible();
  await expect(assumption).toContainText(/on foot and by public transport/);
  await expect(assumption).not.toContainText(/car/i);
  await page.screenshot({ path: `${SHOT_DIR}/01-understanding-${suffix}.png`, fullPage: true });

  const start = page.getByTestId('interview-start');
  await waitUntilInteractive(start);
  await start.click();

  // The first screen: a city trip, with the hills still on offer.
  const priorities = page.getByTestId('interview-question-priorities');
  await expect(priorities).toBeVisible();
  const boxes = priorities.getByRole('checkbox');
  const labels = await boxes.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('aria-label') ?? ''));
  const urban = ['Food & towns', 'Neighbourhoods & local life', 'History & culture', 'Markets & street food', 'Scenic viewpoints', 'Museums & galleries'];
  expect(labels.filter((label) => urban.includes(label)).length, `first screen was ${labels.join(', ')}`).toBeGreaterThanOrEqual(4);
  expect(labels).toContain('Hiking');
  for (const outdoor of ['Lakes & rivers', 'Scenic drives', 'Geology & geothermal', 'Hot springs', 'Wildlife']) {
    expect(labels, `${outdoor} must not lead a city interview`).not.toContain(outdoor);
  }
  await page.screenshot({ path: `${SHOT_DIR}/02-first-screen-${suffix}.png`, fullPage: true });

  // The sidebar (desktop) or sheet (phone) never stacks unsupported assumptions.
  const width = page.viewportSize()?.width ?? 1440;
  if (width >= 1024) {
    const transport = page.getByTestId('sketch-transport').first();
    await expect(transport).toContainText(/On foot and by transit/);
    await expect(transport).not.toContainText(/A car/);
    const range = page.getByTestId('sketch-range').first();
    await expect(range).toContainText(/Not decided yet/);
    await expect(range).not.toContainText(/hour out/);
    // No fifty-kilometre ring: the map frames the city, and a ring appears only once a reach is chosen.
    await expect(page.getByTestId('destination-map-canvas').first().getByText(/\d+ km/)).toHaveCount(0);
  }

  // Hand the interests to Sidequest — the destination prior must pick a city trip — then walk on
  // with "Decide for me" until the transport question, which comes right after the interests.
  for (let step = 0; step < 12; step += 1) {
    const transportQuestion = page.getByTestId('interview-question-transport_mode');
    if (await transportQuestion.isVisible().catch(() => false)) break;
    const decide = page.getByTestId('interview-decide').first();
    await expect(decide).toBeVisible();
    await decide.click();
    await page.waitForTimeout(250);
  }
  const transportQuestion = page.getByTestId('interview-question-transport_mode');
  await expect(transportQuestion).toBeVisible();
  const call = page.getByText(/What should lead the trip|What would make this trip worth taking/).first();
  await expect(call).toBeVisible();
  await expect(page.getByText(/Sidequest.s call/i).first()).toBeVisible();
  for (const outdoor of ['Lakes & rivers', 'Scenic drives', 'Hot springs']) await expect(page.getByText(new RegExp(`^${outdoor}`)).first()).toHaveCount(0);
  await expect(transportQuestion.getByRole('radio', { name: /On foot and by public transport/ })).toBeVisible();
  await expect(transportQuestion.getByRole('radio', { name: /Guided/ })).toHaveCount(0);
  await page.screenshot({ path: `${SHOT_DIR}/03-transport-${suffix}.png`, fullPage: true });
});
