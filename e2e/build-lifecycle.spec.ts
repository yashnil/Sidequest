import { expect, test, type Page } from '@playwright/test';
import { completeQuestionnaire, waitUntilInteractive } from './support/trip';

/**
 * V8 — THE BUILD / RETRY STATE MACHINE, IN A REAL BROWSER.
 *
 * The production sequence of 2026-09-11 (`.claude-private/V8-BUILD-FAILURE.md`):
 * Kenya and Tanzania → "tell me when it is best" → the interview → the review
 * → the accepted window → Build. The Build request died on the wire; the
 * generic boundary replaced the page; "Try again" restarted the interview and
 * overwrote the answers; the server finished a build nobody could reach.
 *
 * Invariant under test, in the founder's words: ONCE THE REVIEW SCREEN SAYS
 * THE TRIP IS READY TO BUILD, THE TRAVELLER MUST NEVER BE FORCED TO RE-ANSWER
 * THE INTERVIEW BECAUSE OF A RENDER, NAVIGATION, NETWORK, OR BUILD FAILURE.
 *
 * Runs under `playwright.timing.config.ts` (fixture climate, so a window is
 * proposed and accepted). Every build is the fixture composer: instant, free.
 * Two fixture-only destination tokens exist for this spec — `Unbuildable`
 * makes the composition fail, `Slowbuild` makes it take eight seconds — see
 * `planning/fixture-composer.ts`.
 */

const continueButton = (page: Page) => page.getByTestId('setup-continue').locator('visible=true').first();

/** Setup → interview → review, with the timing question open and then accepted. Returns the trip id and the accepted dates. */
async function reachAcceptedReview(page: Page, destination: string): Promise<{ tripId: string; startDate: string; endDate: string }> {
  await page.goto('/trips/new');
  const field = page.getByTestId('destination-input');
  await waitUntilInteractive(field);
  await field.fill(destination);
  await continueButton(page).click();
  await expect(page.getByTestId('timing-best')).toBeVisible();
  await page.getByTestId('timing-best').click();
  await expect(page.getByTestId('timing-deferred')).toBeVisible();
  await continueButton(page).click();
  await expect(page.getByRole('heading', { name: /How many nights/ })).toBeVisible();
  await page.getByTestId('nights-7').click();
  await continueButton(page).click();
  await expect(page.getByTestId('party-friends')).toBeVisible();
  await page.getByTestId('party-friends').click();
  await continueButton(page).click();
  await expect(page.getByTestId('setup-flow')).toHaveAttribute('data-step', 'fixed');
  await continueButton(page).click();
  await page.waitForURL(/\/trips\/[^/]+\/(plan|questionnaire)/, { timeout: 30_000 });
  const tripId = /\/trips\/([^/]+)\//.exec(page.url())![1]!;
  if (!/questionnaire/.test(page.url())) await page.goto(`/trips/${tripId}/questionnaire`);
  await completeQuestionnaire(page);
  await expect(page.getByTestId('interview-review')).toBeVisible();
  const accept = page.getByTestId('timing-accept');
  await expect(accept).toBeVisible({ timeout: 20_000 });
  const window = (await page.getByTestId('timing-pick').innerText()).match(/(\d{4}-\d{2}-\d{2}) → (\d{4}-\d{2}-\d{2})/);
  expect(window, 'the pick shows its dates').toBeTruthy();
  await accept.click();
  await expect(page.getByTestId('review-timing-accepted')).toBeVisible();
  return { tripId, startDate: window![1]!, endDate: window![2]! };
}

/** The review's own count of questions, as the proof that nothing was re-asked. */
async function answeredCount(page: Page): Promise<number> {
  const note = await page.getByTestId('stage-path').innerText();
  const match = /(\d+) answered/.exec(note);
  return match ? Number(match[1]) : -1;
}

test('the exact production path: accept the window, Build, the generation screen, the Trip Hub, a reload — and the answers, the timing and the profile survive', async ({ page }) => {
  const { tripId, startDate } = await reachAcceptedReview(page, 'Kenya and Tanzania');
  const answered = await answeredCount(page);

  /* The press is acknowledged before any request returns: the generation surface is on screen at once. */
  await page.getByTestId('interview-build-trip').click();
  await expect(page.getByTestId('generation-overlay')).toBeVisible({ timeout: 2_000 });
  /* …and the build is a place: the route moves to /build, then to the hub when the run says done. */
  await expect(page).toHaveURL(new RegExp(`/trips/${tripId}/(build|itinerary)`), { timeout: 15_000 });
  await expect(page).toHaveURL(new RegExp(`/trips/${tripId}/itinerary(#[a-z-]+)?$`), { timeout: 60_000 });
  await expect(page.getByTestId('route-overview')).toBeVisible();

  /* G — a successful build followed by a reload of the build route lands on the hub, never on the interview. */
  await page.goto(`/trips/${tripId}/build`);
  await expect(page).toHaveURL(new RegExp(`/trips/${tripId}/itinerary`), { timeout: 15_000 });

  /* D — the accepted window is the trip's dates, on the hub… */
  const hero = page.getByTestId('atlas-band').first();
  await expect(hero).toBeVisible({ timeout: 30_000 });
  const monthShort = new Date(`${startDate}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }).split(' ')[1]!;
  await expect(hero).toContainText(monthShort);

  /* C/D — …and the review still holds the completed interview and the locked window; nothing asks again. */
  await page.goto(`/trips/${tripId}/questionnaire`);
  await expect(page.getByTestId('interview-review')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('interview-understanding')).toHaveCount(0);
  expect(await answeredCount(page)).toBe(answered);
  await expect(page.getByTestId('review-timing-accepted')).toBeVisible();
  await expect(page.getByTestId('review-timing-accepted')).toContainText(startDate);
  await expect(page.getByTestId('timing-accept')).toHaveCount(0);
});

test('B — the Build request dies on the wire: no error page, no interview reset, the run is found and followed', async ({ page }) => {
  const { tripId, startDate } = await reachAcceptedReview(page, 'Kenya and Tanzania');
  const answered = await answeredCount(page);

  /* The production 499: the server receives the Build request and the browser side of it is dropped half a second in. */
  let dropped = false;
  await page.route(`**/trips/${tripId}/questionnaire`, async (route) => {
    if (route.request().method() !== 'POST' || dropped) return route.continue();
    dropped = true;
    void route.fetch().catch(() => undefined);
    await page.waitForTimeout(500);
    await route.abort('failed');
  });
  await page.getByTestId('interview-build-trip').click();
  await expect(page.getByTestId('generation-overlay')).toBeVisible({ timeout: 2_000 });
  await expect.poll(() => dropped, { timeout: 10_000 }).toBe(true);

  /* Never the boundary. */
  await expect(page.getByTestId('route-failure')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: /did not load|hit a problem/ })).toHaveCount(0);
  /* The client asked the run row whether its press landed, and followed it. */
  await expect(page).toHaveURL(new RegExp(`/trips/${tripId}/itinerary(#[a-z-]+)?$`), { timeout: 60_000 });
  await expect(page.getByTestId('route-overview')).toBeVisible();

  /* The answers and the window are exactly as they were. */
  await page.goto(`/trips/${tripId}/questionnaire`);
  await expect(page.getByTestId('interview-review')).toBeVisible({ timeout: 20_000 });
  expect(await answeredCount(page)).toBe(answered);
  await expect(page.getByTestId('review-timing-accepted')).toContainText(startDate);
});

test('E — a double press is one run: both requests carry one key and one plan is built', async ({ page }) => {
  const { tripId } = await reachAcceptedReview(page, 'Kenya and Tanzania');
  const keys: string[] = [];
  await page.route(`**/trips/${tripId}/questionnaire`, async (route) => {
    if (route.request().method() === 'POST') {
      const body = route.request().postData() ?? '';
      const match = /"([a-f0-9]{24})"/.exec(body);
      if (match) keys.push(match[1]!);
      /* Hold the first one long enough for the second press to land while it is in flight. */
      if (keys.length === 1) await page.waitForTimeout(800);
    }
    return route.continue();
  });
  const build = page.getByTestId('interview-build-trip');
  await build.click();
  /* The second press: the button is already disabled and the overlay is up; press the overlay's ground instead, which must be inert. */
  await expect(build).toBeDisabled().catch(() => undefined);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/trips/${tripId}/itinerary(#[a-z-]+)?$`), { timeout: 60_000 });
  expect(keys.length).toBeGreaterThanOrEqual(1);
  expect(new Set(keys).size, 'every Build request of this press carries the same key').toBe(1);
  /* The run the server holds is that press. */
  const view = await page.evaluate(async (id) => (await fetch(`/api/trips/${id}/progress`)).json(), tripId);
  expect(view.state).toBe('succeeded');
  expect(view.buildKey).toBe(keys[0]);
});

test('a failed build is a designed state: the profile is kept, "Try build again" starts a new run from it, "Return to review" shows the completed interview', async ({ page }) => {
  const { tripId } = await reachAcceptedReview(page, 'Unbuildable Kenya and Tanzania');
  const answered = await answeredCount(page);
  await page.getByTestId('interview-build-trip').click();
  await expect(page).toHaveURL(new RegExp(`/trips/${tripId}/build`), { timeout: 15_000 });
  const failure = page.getByTestId('build-failure');
  await expect(failure).toBeVisible({ timeout: 30_000 });
  await expect(failure).toContainText('Your trip profile is saved');
  await expect(failure).not.toContainText(/zod|schema|anthropic|fixture|stack|provider/i);
  await expect(page.getByTestId('build-failure-ref')).toContainText(/[A-Za-z0-9_-]{8}/);

  /* A reload of the build route shows the same failure state, never the interview. */
  await page.reload();
  await expect(page.getByTestId('build-failure')).toBeVisible({ timeout: 30_000 });

  /* Return to review: the completed interview, with its answers and no re-asking. */
  await page.getByTestId('build-return-review').click();
  await expect(page.getByTestId('interview-review')).toBeVisible({ timeout: 20_000 });
  expect(await answeredCount(page)).toBe(answered);
  await expect(page.getByTestId('review-active-build')).toHaveAttribute('data-state', 'failed');

  /* Try build again, from the build screen, on the saved profile. The composition fails the same way; a new run is recorded. */
  await page.getByTestId('review-open-build').click();
  await expect(page.getByTestId('build-retry')).toBeVisible({ timeout: 20_000 });
  const before = await page.evaluate(async (id) => (await fetch(`/api/trips/${id}/progress`)).json(), tripId);
  await page.getByTestId('build-retry').click();
  await expect.poll(async () => (await page.evaluate(async (id) => (await fetch(`/api/trips/${id}/progress`)).json(), tripId)).buildKey, { timeout: 20_000 }).not.toBe(before.buildKey);
  await expect(page.getByTestId('build-failure')).toBeVisible({ timeout: 30_000 });
});

test('F — a reload during generation returns to the live build, and the review points at it rather than starting another', async ({ page }) => {
  const { tripId } = await reachAcceptedReview(page, 'Slowbuild Kenya and Tanzania');
  await page.getByTestId('interview-build-trip').click();
  await expect(page).toHaveURL(new RegExp(`/trips/${tripId}/build`), { timeout: 15_000 });
  await expect(page.getByTestId('generation-overlay')).toHaveAttribute('data-state', 'running');
  await page.reload();
  await expect(page.getByTestId('generation-overlay')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('generation-overlay')).toHaveAttribute('data-state', 'running');
  /* Back on the review while it runs: no second Build, a door to the build instead. */
  await page.goto(`/trips/${tripId}/questionnaire`);
  await expect(page.getByTestId('review-active-build')).toHaveAttribute('data-state', 'running', { timeout: 20_000 });
  await expect(page.getByTestId('interview-build-trip')).toHaveCount(0);
  await page.getByTestId('interview-open-build').click();
  await expect(page).toHaveURL(new RegExp(`/trips/${tripId}/itinerary(#[a-z-]+)?$`), { timeout: 60_000 });
});
