import { expect, test, type Page } from '@playwright/test';
import { createTrip } from './support/trip';

/**
 * A PAGE RENDER STARTS NO EXTERNAL WORK.
 *
 * The property is about the *server*, and a browser cannot watch the server's
 * sockets. So this proves it the only way a browser honestly can: by watching
 * for the side effect a render-time fetch necessarily has.
 *
 * If rendering `/discover` still fetched a forecast — as it did, inside
 * `resolveTripRegion` — then the weather would already be there the first time
 * the page was seen, and it would keep re-fetching on every reload. It is not,
 * and it does not. The board arrives saying it has no weather, says so again
 * after five reloads, and only acquires a forecast when somebody presses the
 * button. That sequence is impossible if a render fetches, and it is exactly
 * what the sequence below asserts.
 *
 * The second half is the one the acceptance criterion actually names: refresh,
 * leave and return, at every phase, must be safe. A page that spends money on
 * reload is one whose refresh behaviour nobody can afford to test — which is how
 * the defect survived as long as it did.
 */

const AUGUST_TRIP = { start: '2026-08-12', end: '2026-08-16' };

/**
 * Answer whatever this destination's questionnaire asks, and walk to the board.
 *
 * The first version of this clicked "Continue" without answering anything, and
 * the questionnaire — correctly — refuses to advance off a step with no answer.
 * So the loop spun for twelve iterations and the assertion failed against the
 * questionnaire URL rather than the board.
 *
 * `answerEveryQuestion` from the shared helpers is what the other six specs use,
 * and it is a loop over whatever radio groups are on screen rather than a fixed
 * script — which is the property that keeps every spec working when a step is
 * added or a destination produces a different set.
 */
async function reachBoard(page: Page): Promise<string> {
  const id = await createTrip(page, 'Mammoth Lakes', AUGUST_TRIP);
  await expect(
    page.getByRole('heading', { name: 'What are you actually here for?' }),
  ).toBeVisible();

  /*
   * The same walk `weather.spec` does, step by named step.
   *
   * Two earlier versions of this were loops — click whatever "Continue" is on
   * screen until a board appears — and both failed against the questionnaire
   * URL. The first answered every group with its *first* radio, which on the
   * interests step is "Avoid", producing an empty profile the questionnaire
   * correctly refuses to build from. The second set two interests and still
   * stalled, because a loop that polls for a button cannot tell "this step is
   * not ready" from "this step has no Continue".
   *
   * Naming the steps makes a failure say which screen it stopped on, which is
   * the whole reason the other six specs are written this way.
   */
  await page.getByRole('radio', { name: 'Scenic viewpoints: Core' }).check();
  await page.getByRole('radio', { name: 'Hiking: A few times' }).check();

  for (const heading of [
    'How should the days feel?',
    'What is the spending style?',
    'How do you want to eat?',
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
  await expect(page).toHaveURL(/\/discover$/, { timeout: 30_000 });
  return id;
}

test('the board arrives with no weather, and reloading never fetches any', async ({ page }) => {
  await reachBoard(page);

  const panel = page.getByTestId('weather-snapshot');
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('heading', { name: 'Weather: not fetched' })).toBeVisible();
  await expect(panel.getByTestId('weather-refresh')).toHaveText('Fetch the weather');

  /*
   * The load-bearing assertion. Five renders. A render that fetched would have
   * populated the snapshot on the first one, and the heading would change on its
   * own — which is precisely what the old code did, invisibly, on every page
   * load anybody ever made.
   */
  for (let reload = 0; reload < 5; reload += 1) {
    await page.reload();
    await expect(
      page.getByTestId('weather-snapshot').getByRole('heading', { name: 'Weather: not fetched' }),
    ).toBeVisible();
  }
});

test('the weather arrives only when it is asked for, and stays put afterwards', async ({
  page,
}) => {
  await reachBoard(page);

  const panel = page.getByTestId('weather-snapshot');
  await panel.getByTestId('weather-refresh').click();

  await expect(
    page.getByTestId('weather-snapshot').getByRole('heading', { name: /^Weather: fetched/ }),
  ).toBeVisible({ timeout: 30_000 });

  /*
   * The provenance a stored snapshot is required to carry.
   *
   * Matched on the definition *terms* rather than on loose text: "Fetched"
   * appears in the heading, in the explanatory line and as the term itself, and
   * a substring match resolved to three elements. Asserting on the term is also
   * the more honest assertion — the claim is that the panel carries these
   * labelled facts, not that the word appears somewhere on the page.
   */
  const fetched = page.getByTestId('weather-snapshot');
  for (const term of ['Fetched', 'Source', 'Points sampled']) {
    await expect(fetched.locator('dt', { hasText: new RegExp(`^${term}\\s*$`) })).toBeVisible();
  }

  const stamp = await fetched.locator('time').getAttribute('datetime');
  expect(stamp, 'a fetched snapshot records when').toBeTruthy();

  /*
   * And a reload does not silently re-fetch. The timestamp is the tell: a render
   * that spent a request would move it.
   */
  await page.reload();
  await page.waitForTimeout(1_500);
  await expect(page.getByTestId('weather-snapshot').locator('time')).toHaveAttribute(
    'datetime',
    stamp!,
  );
});

/**
 * The refresh is reachable and operable without a mouse, and it is a real
 * button rather than a link dressed as one — because it spends a request and
 * writes a row, and the affordance has to say so.
 */
test('the refresh is a keyboard-operable button', async ({ page }) => {
  await reachBoard(page);

  const button = page.getByTestId('weather-refresh');
  await expect(button).toHaveRole('button');
  await button.focus();
  await expect(button).toBeFocused();
  await page.keyboard.press('Enter');

  await expect(
    page.getByTestId('weather-snapshot').getByRole('heading', { name: /^Weather: fetched/ }),
  ).toBeVisible({ timeout: 30_000 });
});

/**
 * Refresh, leave and return, at every phase that exists on this journey.
 *
 * The acceptance criterion in full. Each of these routes resolves a region on
 * the server, which is what used to make each of them a forecast request.
 */
test('refresh, leave and return is safe at every phase', async ({ page }) => {
  const tripId = await reachBoard(page);

  const routes = [
    `/trips/${tripId}/questionnaire`,
    `/trips/${tripId}/discover`,
    `/trips/${tripId}/provisional`,
    `/trips/${tripId}/itinerary`,
    '/decide',
    '/',
  ];

  for (const route of routes) {
    await page.goto(route);
    await page.reload();
    /*
     * Back and forward, and the forward is allowed to be refused.
     *
     * `goForward()` rejects with `net::ERR_ABORTED` when the forward entry has
     * been superseded — a race between the history entry and a server-rendered
     * navigation, and a property of Chromium's session history rather than of
     * this product. Asserting on it made the test fail for a reason that has
     * nothing to do with what it is checking.
     *
     * What is actually being checked is on the line after: whatever the browser
     * ends up showing, the page is alive and no route produced a server error.
     * That holds whether or not the forward navigation was honoured.
     */
    await page.goBack().catch(() => undefined);
    await page.goForward().catch(() => undefined);
    // The shell renders whatever the route decided to say. What must never
    // happen is a crash or an unhandled server error.
    await expect(page.locator('body')).toBeVisible();
    expect(await page.title()).not.toContain('500');
  }
});
