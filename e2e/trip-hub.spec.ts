import { expect, test, type Page } from '@playwright/test';
import { createTrip, waitForLookup, waitUntilInteractive } from './support/trip';

/**
 * THE TRIP HUB, END TO END, ON FIXTURES.
 *
 * New trip → interview (smart defaults) → itinerary hub → every section →
 * a booked item that changes the plan → a readiness profile that changes the
 * readiness packet → a tick that survives reload → the calendar export that
 * carries the booking → the read-only share copy → an existing-plan critique.
 * Zero model calls, zero paid calls: the Playwright server pins every provider
 * to fixtures.
 */
const AUGUST = { start: '2026-08-12', end: '2026-08-16' };

async function buildWithDefaults(page: Page, destination = 'Mammoth Lakes'): Promise<string> {
  const id = await createTrip(page, destination, AUGUST);
  // The plan page resolves the destination (and its country) before the interview, as the product flow does.
  if (/\/plan/.test(page.url())) await waitForLookup(page);
  await page.goto(`/trips/${id}/questionnaire`);
  const defaults = page.getByTestId('interview-smart-defaults');
  await waitUntilInteractive(defaults);
  await defaults.click();
  await expect(page).toHaveURL(/\/itinerary$/, { timeout: 90_000 });
  return id;
}

test('the hub has every section, calm by default, with urgent items only where they are real', async ({ page }) => {
  await buildWithDefaults(page);
  const nav = page.getByTestId('trip-hub-nav');
  await expect(nav).toBeVisible();
  for (const id of ['overview', 'itinerary', 'stays', 'getting-around', 'food', 'book-first', 'before-you-go', 'pack', 'budget', 'backups', 'verify']) {
    await expect(page.getByTestId(`hub-link-${id}`)).toBeVisible();
  }
  await expect(page.getByTestId('hub-overview')).toBeVisible();
  await expect(page.getByTestId('hub-stays')).toBeVisible();
  await expect(page.getByTestId('hub-base').first()).toBeVisible();
  await expect(page.getByTestId('hub-transport')).toBeVisible();
  await expect(page.getByTestId('hub-terminal-arriving')).toBeVisible();
  await expect(page.getByTestId('hub-terminal-leaving')).toBeVisible();
  await expect(page.getByTestId('hub-food')).toBeVisible();
  await expect(page.getByTestId('hub-food-day').first()).toBeVisible();
  await expect(page.getByTestId('hub-book-first')).toBeVisible();
  await expect(page.locator('[data-testid="hub-booking"][data-kind="accommodation"]').first()).toBeVisible();
  await expect(page.getByTestId('hub-before-you-go')).toBeVisible();
  await expect(page.getByTestId('hub-readiness-entry_documents')).toBeVisible();
  // Nobody said their citizenship, so the visa layer needs input — never a guess.
  await expect(page.locator('[data-testid="hub-readiness-entry"][data-kind="visa"]')).toHaveAttribute('data-state', 'needs_input');
  await expect(page.getByTestId('hub-checklist')).toBeVisible();
  await expect(page.getByTestId('hub-pack')).toBeVisible();
  await expect(page.getByTestId('hub-packing-list')).toBeVisible();
  await expect(page.getByTestId('hub-budget')).toBeVisible();
  await expect(page.getByTestId('hub-budget')).toContainText(/Ranges, not quotes/);
  await expect(page.getByTestId('hub-backups')).toBeVisible();
  await expect(page.getByTestId('hub-backup-day').first()).toBeVisible();
  await expect(page.getByTestId('hub-verify')).toBeVisible();
  await expect(page.getByTestId('hub-sources')).toBeVisible();
  // Calm: no warning counts thrown at the traveller.
  await expect(page.getByText(/\d+ verification warnings/)).toHaveCount(0);
});

test('a booked hotel and a booked flight become facts the plan is rebuilt around, and survive a reload', async ({ page }) => {
  const id = await buildWithDefaults(page);
  await page.getByTestId('booked-add').first().click();
  await page.getByTestId('booked-title').fill('Hotel B by the creek');
  await page.getByTestId('booked-date').fill(AUGUST.start);
  await page.getByTestId('booked-end-date').fill(AUGUST.end);
  await page.getByTestId('booked-location').fill('Creekside');
  await page.getByTestId('booked-save').click();
  await expect(page.getByTestId('booked-item')).toHaveCount(1, { timeout: 20_000 });
  await expect(page.getByTestId('hub-booked-honored')).toContainText(/Hotel B by the creek/);
  await expect(page.getByTestId('hub-base-booked').first()).toContainText(/Hotel B/);
  // The day headers now name the booked base.
  await expect(page.getByText(/based in Creekside/).first()).toBeVisible();

  // A booked departure flight tightens the last day.
  await page.getByTestId('booked-add').first().click();
  await page.getByTestId('booked-type').selectOption('flight');
  await page.getByTestId('booked-title').fill('Flight home');
  await page.getByTestId('booked-date').fill(AUGUST.end);
  await page.getByTestId('booked-start').fill('13:00');
  await page.getByTestId('booked-save').click();
  await expect(page.getByTestId('booked-item')).toHaveCount(2, { timeout: 20_000 });
  await expect(page.getByTestId('hub-terminal-leaving')).toContainText(/from your booking/);
  await expect(page.getByTestId('hub-booked-honored')).toContainText(/Departure flight at 13:00/);

  await page.reload();
  await expect(page.getByTestId('booked-item')).toHaveCount(2);
  await expect(page.getByText(/based in Creekside/).first()).toBeVisible();

  // The calendar carries the bookings first.
  const response = await page.request.get(`/trips/${id}/itinerary/calendar`);
  expect(response.ok()).toBe(true);
  const ics = await response.text();
  expect(ics).toContain('SUMMARY:Booked: Hotel B by the creek');
  expect(ics).toContain('SUMMARY:Booked: Flight home');
  expect(ics.indexOf('Booked: Hotel B')).toBeLessThan(ics.indexOf('Day 1') === -1 ? ics.length : ics.indexOf('Day 1'));
});

test('the readiness profile changes the packet without ever confirming a legal fact, and a tick survives reload', async ({ page }) => {
  await buildWithDefaults(page);
  await page.getByTestId('readiness-open').click();
  await page.getByTestId('readiness-citizenship').fill('GB');
  await page.getByTestId('readiness-passport').fill('2028-06');
  await page.getByTestId('readiness-save').click();
  const visa = page.locator('[data-testid="hub-readiness-entry"][data-kind="visa"]');
  await expect(visa).toHaveAttribute('data-state', 'unverified', { timeout: 20_000 });
  await expect(visa).toContainText(/not independently verified/);
  await expect(visa).not.toContainText(/do not need/i);
  await expect(visa.getByRole('link', { name: /Foreign travel advice/ })).toBeVisible();
  await expect(page.locator('[data-testid="hub-readiness-entry"][data-kind="passport_validity"]')).toHaveAttribute('data-state', 'unverified');

  const first = page.getByTestId('hub-packing-list').getByRole('checkbox').first();
  await first.check();
  await expect(first).toBeChecked();
  await page.reload();
  await expect(page.getByTestId('hub-packing-list').getByRole('checkbox').first()).toBeChecked();
});

test('the shared copy carries the hub read-only: no forms, every section', async ({ page }) => {
  await buildWithDefaults(page);
  await page.getByRole('button', { name: /Share this plan/ }).click();
  const link = page.getByLabel('Share link');
  await expect(link).toBeVisible({ timeout: 20_000 });
  const href = await link.inputValue();
  await page.goto(href);
  await expect(page.getByTestId('hub-stays')).toBeVisible();
  await expect(page.getByTestId('hub-before-you-go')).toBeVisible();
  await expect(page.getByTestId('booked-add')).toHaveCount(0);
  await expect(page.getByTestId('readiness-open')).toHaveCount(0);
});

test('optimise my existing plan: the traveller’s places are checked and the plan is critiqued, not replaced', async ({ page }) => {
  await page.goto('/trips/new?have=plan');
  const field = page.getByLabel('Destination');
  await waitUntilInteractive(field);
  await field.fill('Mammoth Lakes');
  await page.getByLabel('Which places does your plan already have?').fill('Convict Lake\nMinaret Vista\nNowhere Special');
  await page.getByLabel('Arrive').fill(AUGUST.start);
  await page.getByLabel('Leave').fill(AUGUST.end);
  await page.getByRole('button', { name: /^Continue$/ }).click();
  await page.waitForURL(/\/trips\/[^/]+\/(plan|questionnaire)/);
  const id = /\/trips\/([^/]+)\//.exec(page.url())![1]!;
  if (/\/plan/.test(page.url())) await waitForLookup(page);
  await page.goto(`/trips/${id}/questionnaire`);
  const defaults = page.getByTestId('interview-smart-defaults');
  await waitUntilInteractive(defaults);
  await defaults.click();
  await expect(page).toHaveURL(/\/itinerary$/, { timeout: 90_000 });
  const critique = page.getByTestId('hub-critique');
  await expect(critique).toBeVisible();
  await expect(critique).toContainText(/Your plan, checked/);
  await expect(critique.getByTestId('hub-critique-finding').first()).toBeVisible();
  const places = critique.getByTestId('hub-critique-places');
  await expect(places).toContainText('Convict Lake');
  await expect(places.locator('[data-outcome="not_found"]')).toContainText('Nowhere Special');
  // The plan itself is still a plan: days, bases, the hub.
  await expect(page.getByRole('heading', { name: /^Day 1/ })).toBeVisible();
  await expect(page.getByTestId('hub-stays')).toBeVisible();
});
