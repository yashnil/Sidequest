import { expect, test, type Page } from '@playwright/test';
import { completeQuestionnaire, createTrip, compileRegion } from './support/trip';

/**
 * THE CANONICAL GENERATION PATH, PRESSED FROM THE REAL BUTTONS.
 *
 * Four CTAs, one architecture: "Build my trip" on the Discovery Board,
 * "Regenerate" on the itinerary page, "Plan the whole trip for me" (Quick
 * Plan) before any questionnaire, and Auto Pick followed by Build. The server
 * runs with `SIDEQUEST_COMPOSER_PROVIDER=fixture`, so the model is a
 * deterministic offline composer and nothing here spends anything — what is
 * under test is that the product reaches the canonical orchestrator, persists
 * a reconciled itinerary with its package, and renders it.
 */

const AUGUST = { start: '2026-08-12', end: '2026-08-15' };

async function reachMammothBoard(page: Page) {
  await page.goto('/trips/new');
  await page.getByLabel('Destination').fill('Mammoth Lakes');
  await page.getByLabel('Arrive').fill(AUGUST.start);
  await page.getByLabel('Leave').fill(AUGUST.end);
  await page.getByRole('button', { name: /See what we make of it/i }).click();
  await completeQuestionnaire(page);
  await page.getByRole('button', { name: 'Build my discovery board' }).click();
  await expect(page).toHaveURL(/\/discover$/);
}

async function expectCanonicalItinerary(page: Page) {
  await expect(page).toHaveURL(/\/itinerary$/, { timeout: 60_000 });
  await expect(page.getByTestId('route-overview')).toBeVisible();
  await expect(page.getByTestId('route-bases')).toBeVisible();
  for (const dayNumber of [1, 2, 3, 4]) {
    await expect(page.getByRole('heading', { name: new RegExp(`^Day ${dayNumber}`) })).toBeVisible();
  }
  // Real content on every day: activities and meals, never the stale "Nothing scheduled" copy beside content.
  await expect(page.getByText(/^Nothing scheduled/)).toHaveCount(0);
  await expect(page.getByRole('heading', { name: /^Lunch/ }).first()).toBeVisible();
  await expect(page.getByTestId('where-to-stay')).toBeVisible();
  await expect(page.getByTestId('packing-list')).toBeVisible();
  await expect(page.getByTestId('before-you-go')).toBeVisible();
  await expect(page.getByTestId('before-you-go')).toContainText(/entry requirements/i);
  await expect(page.getByTestId('backups')).toBeVisible();
  await expect(page.getByTestId('considered-and-left-out')).toBeVisible();
  // A stop nothing could verify is kept and labelled, not dropped.
  await expect(page.getByRole('heading', { name: 'A Quiet Overlook Nobody Documented', exact: true })).toBeVisible();
  await expect(page.getByText('Not yet verified').first()).toBeVisible();
  await expect(page.getByText('Verified').first()).toBeVisible();
}

test('Build my trip runs the canonical path and renders the reconciled itinerary with its package', async ({ page }) => {
  await reachMammothBoard(page);
  await page.getByRole('button', { name: /Build my trip|Rebuild my trip/ }).click();
  await expectCanonicalItinerary(page);

  // Persisted: a reload shows the same plan, including the package sections.
  const heading = await page.getByRole('heading', { name: /^Day 2/ }).textContent();
  await page.reload();
  await expect(page.getByRole('heading', { name: /^Day 2/ })).toHaveText(heading ?? '');
  await expect(page.getByTestId('route-overview')).toBeVisible();
});

test('Build my trip works with nothing picked on the board', async ({ page }) => {
  await reachMammothBoard(page);
  const included = page.getByRole('button', { name: 'Include', pressed: true });
  let remaining = await included.count();
  let guard = 0;
  while (remaining > 0 && guard < 60) {
    const before = remaining;
    await included.first().click();
    // A click is a round trip to the server; wait for the count to actually move.
    await expect
      .poll(async () => page.getByRole('button', { name: 'Include', pressed: true }).count(), { timeout: 10_000 })
      .toBeLessThan(before);
    remaining = await page.getByRole('button', { name: 'Include', pressed: true }).count();
    guard += 1;
  }
  await expect(page.getByTestId('board-summary')).toContainText(/^0 chosen/);
  const build = page.getByRole('button', { name: /Build my trip/ });
  await expect(build).toBeEnabled();
  await build.click();
  await expectCanonicalItinerary(page);
});

test('Regenerate on the itinerary page runs the canonical path again', async ({ page }) => {
  await reachMammothBoard(page);
  await page.getByRole('button', { name: /Build my trip|Rebuild my trip/ }).click();
  await expectCanonicalItinerary(page);
  const regenerate = page.getByTestId('regenerate-trip');
  await expect(regenerate).toBeVisible();
  await regenerate.click();
  await expect(regenerate).toHaveText('Regenerate', { timeout: 60_000 });
  await expectCanonicalItinerary(page);
});

test('Auto pick, then Build, honours the picks as signals', async ({ page }) => {
  await reachMammothBoard(page);
  // Skip one place by hand: the signal the build must honour.
  const convict = page.getByRole('article').filter({ hasText: 'Convict Lake' }).first();
  await convict.getByRole('button', { name: 'Skip' }).click();
  await convict.getByRole('button', { name: 'Not my thing' }).click();
  await expect(convict.getByRole('button', { name: 'Skip' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: /Auto-pick|Choose for me|Pick for me/i }).first().click();
  await expect(page.getByTestId('board-summary')).not.toContainText(/^0 chosen/);
  await page.getByRole('button', { name: /Build my trip|Rebuild my trip/ }).click();
  await expectCanonicalItinerary(page);
  await expect(page.getByRole('heading', { name: 'Convict Lake', exact: true })).toHaveCount(0);
});

test('Quick Plan composes a complete trip before any questionnaire and lands on the same itinerary page', async ({ page }) => {
  const id = await createTrip(page, 'Harbour City', AUGUST);
  await page.goto(`/trips/${id}/quickplan`);
  await page.getByRole('button', { name: 'Plan the whole trip for me' }).click();
  await expect(page).toHaveURL(/\/itinerary$/, { timeout: 60_000 });
  await expect(page.getByTestId('route-overview')).toBeVisible();
  for (const dayNumber of [1, 2, 3, 4]) {
    await expect(page.getByRole('heading', { name: new RegExp(`^Day ${dayNumber}`) })).toBeVisible();
  }
  await expect(page.getByText(/^Nothing scheduled/)).toHaveCount(0);
  await expect(page.getByTestId('packing-list')).toBeVisible();
  await expect(page.getByText('Not yet verified').first()).toBeVisible();
});

test('Quick Plan after a compiled region verifies against it', async ({ page }) => {
  const id = await createTrip(page, 'Harbour City', AUGUST);
  await compileRegion(page);
  await page.goto(`/trips/${id}/quickplan`);
  await page.getByRole('button', { name: 'Plan the whole trip for me' }).click();
  await expect(page).toHaveURL(/\/itinerary$/, { timeout: 60_000 });
  await expect(page.getByTestId('route-overview')).toBeVisible();
  await expect(page.getByText('Verified').first()).toBeVisible();
});
