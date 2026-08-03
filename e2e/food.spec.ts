import { mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

/** Same directory the rest of the suite writes to, created before use. */
const SHOT_DIR = 'test-results/screens';

/**
 * FOOD, END TO END.
 *
 * The journey the slice exists for: preferences in the questionnaire, a short
 * food section on the board, a build, and meals on the timeline that name real
 * places, say what they cost in detour minutes, and admit what nobody has
 * confirmed. Then the thing that matters most on a second visit — a preference
 * change producing a coherently different plan without touching the trip.
 *
 * Runs against the curated dataset, never a live restaurant API, so a failure
 * here is a change in behaviour rather than a change in somebody's opening hours.
 */

const AUGUST = { start: '2026-08-12', end: '2026-08-15' };

async function startQuestionnaire(page: Page) {
  await page.goto('/trips/new');
  await page.getByLabel('Destination').fill('Mammoth Lakes');
  await page.getByLabel('Arrive').fill(AUGUST.start);
  await page.getByLabel('Leave').fill(AUGUST.end);
  await page.getByRole('button', { name: /See what we make of it/i }).click();

  await page.getByRole('radio', { name: 'Hiking: A few times' }).check();
  await page.getByRole('radio', { name: 'Lakes & rivers: A few times' }).check();
  await page.getByRole('radio', { name: 'Viewpoints: A few times' }).check();

  for (const heading of ['How should the days feel?', 'What is the spending style?']) {
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('heading', { name: heading })).toBeVisible();
  }
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'How do you want to eat?' })).toBeVisible();
}

async function finishQuestionnaire(page: Page) {
  for (const heading of [
    'Famous or off the track?',
    'How are you getting around?',
    'How far from Mammoth Lakes?',
    'Anything to steer around?',
    'Your trip personality',
  ]) {
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('heading', { name: heading })).toBeVisible();
  }
  await page.getByRole('button', { name: 'Build my discovery board' }).click();
  await expect(page).toHaveURL(/\/discover$/);
}

async function buildTrip(page: Page) {
  await page.getByRole('button', { name: /Build my trip|Rebuild my trip/ }).click();
  await expect(page).toHaveURL(/\/itinerary$/, { timeout: 30_000 });
  await expect(page.getByRole('heading', { name: 'Eating' }).first()).toBeVisible();
}

test('the food step asks about eating and nothing about restaurants', async ({ page }) => {
  await startQuestionnaire(page);

  await expect(page.getByRole('radio', { name: /I skip it/ })).toBeVisible();
  await expect(page.getByRole('radio', { name: /Keep it cheap/ })).toBeVisible();
  await expect(page.getByText('Anything you do not eat?')).toBeVisible();

  // The strictness question is about a list, so it only exists once there is one.
  await expect(page.getByText('These are requirements, not preferences')).toHaveCount(0);
  await page.getByRole('checkbox', { name: 'Vegetarian' }).check();
  await expect(page.getByText('These are requirements, not preferences')).toBeVisible();
});

test('a built trip names real places, and says where the facts came from', async ({ page }) => {
  await startQuestionnaire(page);
  await finishQuestionnaire(page);

  // The board offers an opinion on a handful of stops, not a second board.
  const foodSection = page.getByRole('region', { name: 'Food & local stops' });
  await expect(foodSection).toBeVisible();
  expect(await foodSection.getByRole('article').count()).toBeLessThanOrEqual(6);

  await buildTrip(page);

  const eating = page.getByRole('region', { name: 'Eating' }).first();
  await expect(eating).toBeVisible();
  // Never a total: four venues in this region publish prices at all.
  await expect(eating).not.toContainText('$');
  await expect(eating.getByText(/have not checked today/i)).toBeVisible();

  // At least one meal names somewhere, with a reason that talks about the route.
  await expect(page.getByText(/on the way|right on the route|off the route/i).first()).toBeVisible();
});

test('a meal never claims a booking exists', async ({ page }) => {
  await startQuestionnaire(page);
  await finishQuestionnaire(page);
  await buildTrip(page);

  const body = await page.locator('body').innerText();
  expect(body).not.toMatch(/we have booked|reservation confirmed|table reserved/i);
  if (/book ahead|booking required/i.test(body)) {
    expect(body).toMatch(/have not booked anything/i);
  }
});

test('a strict dietary need is answered with honesty rather than reassurance', async ({ page }) => {
  await startQuestionnaire(page);
  await page.getByRole('checkbox', { name: 'Nut allergy' }).check();
  await page.getByRole('checkbox', { name: 'These are requirements, not preferences' }).check();
  await finishQuestionnaire(page);
  await buildTrip(page);

  const body = await page.locator('body').innerText();
  expect(body).not.toMatch(/allergen[- ]safe|safe for your allergy|guaranteed/i);
  await expect(page.getByText(/not a kitchen one/i)).toBeVisible();
});

test('the plan survives a refresh unchanged, then changes when the preference does', async ({
  page,
}) => {
  await startQuestionnaire(page);
  await finishQuestionnaire(page);
  await buildTrip(page);

  const before = await page.locator('ol').first().innerText();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Eating' }).first()).toBeVisible();
  expect(await page.locator('ol').first().innerText()).toBe(before);

  const url = page.url();
  const tripPath = url.slice(0, url.lastIndexOf('/'));

  // Change how they want to eat, and nothing else.
  await page.goto(`${tripPath}/questionnaire`);
  await expect(page.getByRole('heading', { name: 'What are you actually here for?' })).toBeVisible();
  for (const heading of ['How should the days feel?', 'What is the spending style?', 'How do you want to eat?']) {
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('heading', { name: heading })).toBeVisible();
  }
  await page.getByRole('radio', { name: /Keep it cheap/ }).check();
  await finishQuestionnaire(page);
  await buildTrip(page);

  const after = await page.locator('ol').first().innerText();
  expect(after).not.toBe(before);
});

test('a venue the traveller rules out never appears on the plan', async ({ page }) => {
  await startQuestionnaire(page);
  await finishQuestionnaire(page);

  const foodSection = page.getByRole('region', { name: 'Food & local stops' });
  const firstCard = foodSection.getByRole('article').first();
  const name = (await firstCard.getByRole('heading').innerText()).trim();
  await firstCard.getByRole('button', { name: 'Not for me' }).click();
  await expect(firstCard.getByRole('button', { name: 'Not for me' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  // The decision survives a reload before it is ever built against.
  await page.reload();
  await expect(
    page
      .getByRole('region', { name: 'Food & local stops' })
      .getByRole('article')
      .filter({ has: page.getByRole('heading', { name, exact: true }) })
      .getByRole('button', { name: 'Not for me' }),
  ).toHaveAttribute('aria-pressed', 'true');

  await buildTrip(page);
  const timeline = await page.locator('ol').first().innerText();
  expect(timeline).not.toContain(name);
});

test('the itinerary is readable with no console errors and no sideways scroll', async ({
  page,
}, testInfo) => {
  const problems: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console.error: ${message.text()}`);
  });
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));

  await startQuestionnaire(page);
  await page.getByRole('checkbox', { name: 'Vegetarian' }).check();
  await finishQuestionnaire(page);
  await buildTrip(page);

  await expect(async () => {
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `the itinerary scrolls horizontally by ${overflow}px`).toBeLessThanOrEqual(1);
  }).toPass({ timeout: 5_000 });

  mkdirSync(SHOT_DIR, { recursive: true });
  await page.screenshot({
    path: `${SHOT_DIR}/14-food-${testInfo.project.name}.png`,
    fullPage: true,
  });

  expect(problems, `Runtime problems:\n${problems.join('\n')}`).toEqual([]);
});

test('the food choices are reachable by keyboard', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'Keyboard traversal is a desktop concern');

  await startQuestionnaire(page);
  await finishQuestionnaire(page);

  const first = page
    .getByRole('region', { name: 'Food & local stops' })
    .getByRole('button', { name: 'Sounds good' })
    .first();
  await first.focus();
  await expect(first).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(first).toHaveAttribute('aria-pressed', 'true');
});
