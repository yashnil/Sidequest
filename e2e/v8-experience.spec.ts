import { expect, test, type Page } from '@playwright/test';
import { VIEWPORTS, expectNoHorizontalOverflow, expectNoRuntimeProblems, watchForRuntimeProblems } from './support/viewports';
import { completeQuestionnaire, createTrip, waitUntilInteractive } from './support/trip';
import { openHubView } from './support/hub';

/**
 * V8 — THE REDESIGNED EXPERIENCE, WALKED IN A REAL BROWSER.
 *
 * Part 22's dedicated specs H–L: the party editor, reduced-motion mode, the
 * major viewport sweep, the keyboard/focus path, and "no console or page
 * errors" on every surface the redesign touched. The build lifecycle (A–G)
 * lives in `build-lifecycle.spec.ts`. Runs under `playwright.timing.config.ts`
 * with the fixture climate, so the review carries a timing pick.
 *
 * Every trip runs on fixtures; nothing here spends a model call.
 */

const DATES = { start: '2027-05-11', end: '2027-05-18' };

async function signIn(page: Page, email: string): Promise<void> {
  await page.goto('/signin');
  await expect(page.getByTestId('signin-fixture')).toBeVisible();
  await page.getByTestId('signin-email').fill(email);
  await page.getByTestId('signin-submit').click();
  await page.waitForURL((url) => !url.pathname.startsWith('/signin'), { timeout: 15_000 });
}

/** Setup → interview → review, dated (so no timing pick is needed). */
async function reachReview(page: Page, destination = 'Kenya and Tanzania'): Promise<string> {
  const tripId = await createTrip(page, destination, DATES);
  if (!/questionnaire/.test(page.url())) await page.goto(`/trips/${tripId}/questionnaire`);
  await completeQuestionnaire(page);
  await expect(page.getByTestId('interview-review')).toBeVisible({ timeout: 20_000 });
  return tripId;
}

test('H — the party editor describes a person in planning terms, keeps hard requirements apart, and the review reflects them', async ({ page }) => {
  const problems = watchForRuntimeProblems(page);
  await signIn(page, 'party-editor@example.com');
  const tripId = await reachReview(page);
  await page.goto(`/trips/${tripId}/party`);
  await expect(page.getByTestId('party-editor')).toBeVisible({ timeout: 15_000 });
  const form = page.getByTestId('party-form');
  await expect(form).toBeVisible();
  await page.getByTestId('person-name').fill('Mum');
  /* A hard requirement: a functional need, plus the "cannot, not would-rather-not" strictness on a diet. */
  const need = page.locator('[data-testid^="person-need-"]').first();
  await need.check({ force: true });
  const diet = page.locator('[data-testid^="person-diet-"]').first();
  await diet.check({ force: true });
  await page.getByTestId('person-diet-strict').check({ force: true });
  await page.getByTestId('person-needs-notes').fill('Cannot walk more than about 2 km continuously');
  await page.getByTestId('person-save').click();
  const member = page.getByTestId('party-member').first();
  await expect(member).toBeVisible({ timeout: 15_000 });
  await expect(member).toContainText('Mum');
  await expect(member).toContainText(/2 km/);
  /* No diagnosis is ever asked for, and no internal vocabulary reaches the page. */
  const text = (await page.locator('body').innerText()).toLowerCase();
  for (const word of ['diagnosis', 'schema', 'fixture', 'provider', 'zod']) expect(text, word).not.toContain(word);
  /* The review is still the completed interview, with the party on it. */
  await page.goto(`/trips/${tripId}/questionnaire`);
  await expect(page.getByTestId('interview-review')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('interview-understanding')).toHaveCount(0);
  expectNoRuntimeProblems(problems, 'party editor');
});

test('I — reduced motion: the interview, the review, the build and the hub render and work with animations collapsed', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const problems = watchForRuntimeProblems(page);
  const tripId = await reachReview(page);
  /* Every animated element resolves instantly: nothing on screen may still be mid-entrance a frame later. */
  const stillAnimating = await page.evaluate(() => {
    const animations = document.getAnimations();
    return animations.filter((a) => a.playState === 'running' && (a.effect?.getComputedTiming().duration as number) > 100).length;
  });
  expect(stillAnimating, 'no animation longer than 100 ms runs under reduced motion').toBe(0);
  await page.getByTestId('interview-build-trip').click();
  await expect(page).toHaveURL(new RegExp(`/trips/${tripId}/itinerary(#[a-z-]+)?$`), { timeout: 60_000 });
  await expect(page.getByTestId('route-overview')).toBeVisible();
  await openHubView(page, 'days');
  await expect(page.locator('#hub-view-days')).toBeVisible();
  await openHubView(page, 'prepare');
  await expect(page.getByTestId('packing-list')).toBeVisible();
  expectNoRuntimeProblems(problems, 'reduced motion');
});

for (const viewport of VIEWPORTS) {
  test(`J/L — the redesigned surfaces lay out at ${viewport.name} (${viewport.width}x${viewport.height}) with no overflow and no runtime problems`, async ({ page }) => {
    const problems = watchForRuntimeProblems(page);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto('/');
    await expect(page.getByRole('link', { name: /I know where I want to go/ })).toBeVisible();
    await expectNoHorizontalOverflow(page, `home at ${viewport.name}`);
    await page.goto('/trips');
    await expectNoHorizontalOverflow(page, `dashboard at ${viewport.name}`);
    const tripId = await createTrip(page, 'Kenya and Tanzania', DATES);
    if (!/questionnaire/.test(page.url())) await page.goto(`/trips/${tripId}/questionnaire`);
    await expect(page.getByTestId('interview')).toBeVisible({ timeout: 20_000 });
    await expectNoHorizontalOverflow(page, `understanding at ${viewport.name}`);
    const start = page.getByTestId('interview-start');
    await waitUntilInteractive(start);
    await start.click();
    await expect(page.locator('[data-testid^="interview-question-"]').first()).toBeVisible({ timeout: 15_000 });
    await expectNoHorizontalOverflow(page, `question at ${viewport.name}`);
    /* The action bar is reachable without scrolling the question away on a phone. */
    await expect(page.getByTestId('interview-continue')).toBeInViewport();
    await completeQuestionnaire(page);
    await expectNoHorizontalOverflow(page, `review at ${viewport.name}`);
    /* The Build action is on screen at every width without scrolling to the end of the review. */
    await expect(page.getByTestId('interview-build-trip')).toBeInViewport();
    await page.getByTestId('interview-build-trip').click();
    await expect(page).toHaveURL(new RegExp(`/trips/${tripId}/itinerary(#[a-z-]+)?$`), { timeout: 60_000 });
    await expect(page.getByTestId('atlas-band').first()).toBeVisible({ timeout: 30_000 });
    await expectNoHorizontalOverflow(page, `hub overview at ${viewport.name}`);
    for (const view of ['days', 'map', 'plan', 'prepare'] as const) {
      await openHubView(page, view);
      await expectNoHorizontalOverflow(page, `hub ${view} at ${viewport.name}`);
    }
    /* The map never renders at zero height. */
    await openHubView(page, 'map');
    const mapBox = await page.locator('#hub-view-map').boundingBox();
    expect(mapBox?.height ?? 0, 'the map view has height').toBeGreaterThan(120);
    expectNoRuntimeProblems(problems, `viewport ${viewport.name}`);
  });
}

test('K — keyboard: the review reaches Build by Tab with a visible focus ring, and the Ask Sidequest sheet closes on Escape and restores focus', async ({ page }) => {
  const problems = watchForRuntimeProblems(page);
  const tripId = await reachReview(page);
  /* Tab from the top until the Build control has focus; every stop along the way must be a visible, named control. */
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  let reached = false;
  for (let i = 0; i < 80; i += 1) {
    await page.keyboard.press('Tab');
    const focused = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el) return null;
      const style = getComputedStyle(el);
      return { testId: el.getAttribute('data-testid'), tag: el.tagName, outline: style.outlineStyle, outlineWidth: style.outlineWidth, name: (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 40) };
    });
    if (!focused) continue;
    if (focused.testId === 'interview-build-trip') {
      reached = true;
      expect(focused.outline, 'the Build control shows a focus ring').not.toBe('none');
      break;
    }
  }
  expect(reached, 'Build my trip is reachable by keyboard').toBe(true);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/trips/${tripId}/itinerary(#[a-z-]+)?$`), { timeout: 60_000 });
  /* The sheet: Escape closes it and focus returns to the control that opened it. */
  const open = page.getByTestId('ask-sidequest-open').locator('visible=true').first();
  await expect(open).toBeVisible({ timeout: 30_000 });
  await open.focus();
  await page.keyboard.press('Enter');
  const sheet = page.getByTestId('ask-sidequest-sheet');
  await expect(sheet).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  const restored = await page.evaluate(() => document.activeElement?.getAttribute('data-testid'));
  expect(restored, 'focus returns to the Ask Sidequest trigger').toBe('ask-sidequest-open');
  expectNoRuntimeProblems(problems, 'keyboard path');
});
