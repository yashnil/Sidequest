import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { openHubView } from './support/hub';
import {
  VIEWPORTS,
  expectNoHorizontalOverflow,
  expectNoRuntimeProblems,
  watchForRuntimeProblems,
} from './support/viewports';
import {
  DEFAULT_DATES,
  compileRegion,
  completeQuestionnaire,
  createTrip,
  waitUntilInteractive,
} from './support/trip';

/**
 * EVERY VIEWPORT, STATED IN THE TEST RATHER THAN INFERRED FROM THE CONFIG.
 *
 * The suite's other specs run under whatever viewport their project declares, so
 * "which sizes are covered" was a question you could only answer by reading a
 * device descriptor in a node_modules package. This spec answers it in the one
 * place a reader looks: it iterates `VIEWPORTS` and sets each size, so a size
 * added to that list is walked here without anybody remembering to add it.
 *
 * ONE PROJECT ONLY. `playwright.config.ts` gives this file to the `tablet`
 * project and hides it from the other three, because a spec that sets its own
 * viewport learns nothing from being run again under a different one — and the
 * suite is ~131 declarations across three projects at ~12 minutes, so four
 * redundant walks of the composer is a cost with no signal behind it.
 *
 * Deliberately shallow. `visual.spec.ts` already drives the whole journey to a
 * compiled itinerary at desktop, desktop-dark and mobile; what nothing covered
 * was the tablet width, where a two-column layout is at its most likely to be
 * caught halfway between its breakpoints. So this walks the surfaces that are
 * cheap to reach and layout-dense — landing, the filled composer, and the scope
 * screen the planner lands on — at all three widths, and leaves the expensive
 * tail to the spec that was already paying for it.
 */

for (const viewport of VIEWPORTS) {
  test(`lays out the key surfaces at ${viewport.name} (${viewport.width}x${viewport.height})`, async ({
    page,
  }) => {
    const problems = watchForRuntimeProblems(page);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });

    await page.goto('/');
    await expect(page.getByRole('link', { name: 'I know where I am going' })).toBeVisible();
    await expectNoHorizontalOverflow(page, `landing at ${viewport.name}`);

    /*
     * The composer with content in it, not the empty shell: the destination field
     * gates the rest of the form, so an unfilled composer is a third of the
     * layout and the third least likely to overflow.
     */
    await page.goto('/trips/new');
    const destination = page.getByLabel('Destination');
    await waitUntilInteractive(destination);
    await destination.fill('Mammoth Lakes');
    await page.getByLabel('Arrive').fill(DEFAULT_DATES.start);
    await page.getByLabel('Leave').fill(DEFAULT_DATES.end);
    await expectNoHorizontalOverflow(page, `composer at ${viewport.name}`);

    await page.getByRole('button', { name: /^Continue$/ }).click();
    await page.waitForURL(/\/trips\/[^/]+\/questionnaire/);

    /*
     * The interests step is the densest grid the product renders: nine question
     * groups of five radio options each. It is where a width that has run out of
     * room shows first, and it is one navigation away, so all three sizes can have
     * it for the price of one page load.
     */
    await expect(page.getByTestId('interview-understanding')).toBeVisible();
    await expectNoHorizontalOverflow(page, `understanding at ${viewport.name}`);

    /*
     * And the far end of the questionnaire, which is a different layout problem:
     * the personality review puts the whole profile on one screen as bars and
     * labels, so it is the widest *content* rather than the widest control grid.
     * Reached through the shared walker so a questionnaire reordering breaks this
     * in the same place it breaks everything else.
     */
    await completeQuestionnaire(page);
    await expectNoHorizontalOverflow(page, `personality at ${viewport.name}`);

    /*
     * The board stops here. Building it compiles a region, and `visual.spec.ts`
     * already drives that to a finished itinerary at three of the four project
     * configurations — paying for it again at three widths would roughly triple
     * this spec's runtime to re-cover ground.
     */
    expectNoRuntimeProblems(problems, `Runtime problems at ${viewport.name}`);
  });
}

/**
 * THE TWO LONG SURFACES, AT EVERY WIDTH A PHONE ACTUALLY HAS.
 *
 * The sweep above deliberately stops at the personality screen, because building
 * a board compiles a region and paying for that at four widths buys four copies
 * of the same signal. But the board and the itinerary are the two densest
 * layouts in the product — a three-up card grid that collapses to one column, a
 * filter rail of chips, an action bar pinned to the bottom of the viewport, and
 * a horizontally scrolling day rail. Every one of those is a way to make a
 * document scroll sideways.
 *
 * Every phone width rather than one. This ran at 390 only, and the homepage was
 * overflowing at every width below 383 the whole time — seven pixels of margin
 * between the one width tested and the threshold. Narrower is not merely "more
 * likely to break": it is a different set of breakpoints, so it is walked rather
 * than argued about.
 */
const PHONES = VIEWPORTS.filter((entry) => entry.width <= 420);

for (const phone of PHONES) {
  test(`the board and the itinerary do not scroll sideways at ${phone.name} (${phone.width}x${phone.height})`, async ({
    page,
  }) => {
    const problems = watchForRuntimeProblems(page);
    await page.setViewportSize({ width: phone.width, height: phone.height });
    const where = `${phone.width}x${phone.height}`;

    await page.goto('/trips/new');
    const destination = page.getByLabel('Destination');
    await waitUntilInteractive(destination);
    await destination.fill('Mammoth Lakes');
    await page.getByLabel('Arrive').fill(DEFAULT_DATES.start);
    await page.getByLabel('Leave').fill(DEFAULT_DATES.end);
    await page.getByRole('button', { name: /^Continue$/ }).click();
    await page.waitForURL(/\/trips\/[^/]+\/questionnaire/);
    await completeQuestionnaire(page);

    await page.getByRole('button', { name: 'Open the Discovery Board' }).click();
    await expect(page).toHaveURL(/\/discover$/);
    await expect(page.getByRole('heading', { name: 'Classics worth your time' })).toBeVisible();
    await expectNoHorizontalOverflow(page, `discovery board at ${where}`);

    /*
     * The board first, the commentary after. On a phone the two columns become
     * one, and the rail used to be laid out ahead of the cards — so the traveller
     * scrolled past four analysis panels to reach the thing the page is named
     * after. Measured rather than asserted on class names.
     *
     * Against the backstage toggle rather than against the personality heading:
     * the rail's panels are inside a closed disclosure now, and a heading inside
     * a closed `<details>` has no box at all — `boundingBox()` returns null and
     * the comparison it was written for cannot be made. The toggle is the rail's
     * first rendered element, which is the thing the ordering claim is about.
     */
    const firstCard = page.getByTestId('discovery-board').getByRole('article').first();
    const rail = page.getByTestId('board-backstage-toggle');
    const cardBox = await firstCard.boundingBox();
    const railBox = await rail.boundingBox();
    expect(cardBox, 'the board should have a card').not.toBeNull();
    expect(railBox, 'the rail should carry the backstage toggle').not.toBeNull();
    expect(cardBox!.y, 'the first card must come before the analysis rail').toBeLessThan(railBox!.y);

    /*
     * And the action bar is pinned to the bottom of the viewport rather than
     * having scrolled away with the top of a thirty-screen page.
     */
    const bar = page.getByTestId('board-action-bar');
    await page.mouse.wheel(0, 4000);
    await expect(bar).toBeInViewport();

    await page.getByRole('button', { name: /Build my trip|Rebuild my trip/ }).click();
    await expect(page).toHaveURL(/\/itinerary$/, { timeout: 30_000 });
    await expectNoHorizontalOverflow(page, `itinerary overview at ${where}`);
    await openHubView(page, 'days');
    await expect(page.getByRole('heading', { name: /^Day 1/ })).toBeVisible();
    await expectNoHorizontalOverflow(page, `itinerary at ${where}`);

    expectNoRuntimeProblems(problems, `Runtime problems at ${where}`);
  });
}

/**
 * EVERY NORMAL ROUTE, AT EVERY DECLARED VIEWPORT.
 *
 * §39's stability gate asks for two properties by name — "zero console errors on
 * normal routes" and "no horizontal overflow" — and neither was true of *every*
 * route. What existed checked the surfaces a journey passes through: the sweep
 * above walks the composer and the questionnaire, `visual.spec.ts` walks the
 * journey to a built itinerary at three project configurations, `compile.spec`
 * checks the plan flow once. Nothing ever loaded `/decide/<id>`, the edit screen
 * or the screen a stale trip link lands on, and nothing checked any of them at
 * the tablet or the narrow-phone width.
 *
 * The expensive part — a real trip, a compiled region, a shortlist — is paid for
 * once in `beforeAll` against a context the tests share, and each test then
 * re-loads the finished routes at its own width. Sharing a context is what makes
 * the homepage worth loading at all: the trip list is scoped to the browser that
 * made the trips, so a fresh context would render the empty state, and the empty
 * state is not where the homepage's overflow was.
 *
 * Loaded per width rather than resized between reads. A resize reflows, which
 * catches most things, but a layout that measures on mount and never listens
 * would pass a resize and fail a fresh load — and a fresh load is what a
 * traveller does.
 */
test.describe('every normal route', () => {
  let context: BrowserContext;
  let shared: Page;
  /** The authored-region journey: questionnaire, board, itinerary, edit. */
  let planned: string;
  /** A dynamic destination, because only that flow has a plan screen of its own. */
  let compiled: string;
  /** A shortlist, so `/decide/<id>` is a screen rather than a redirect. */
  let decided: string;

  test.beforeAll(async ({ browser }, workerInfo) => {
    /*
     * `baseURL` restated, because a hand-made context does not get it.
     *
     * The `page` fixture is built from the project's `use` block; anything
     * created through `browser.newContext()` starts from Playwright's defaults,
     * and a relative `goto('/trips/new')` against a context with no base throws
     * "Invalid URL" rather than failing as a missing page. Read from the project
     * rather than restated, so the one canonical port stays canonical.
     */
    context = await browser.newContext({ baseURL: workerInfo.project.use.baseURL });
    shared = await context.newPage();

    planned = await createTrip(shared, 'Mammoth Lakes');
    await completeQuestionnaire(shared);
    await shared.getByRole('button', { name: 'Open the Discovery Board' }).click();
    await expect(shared).toHaveURL(/\/discover$/);
    await shared.getByRole('button', { name: /Build my trip|Rebuild my trip/ }).click();
    await expect(shared).toHaveURL(/\/itinerary$/, { timeout: 60_000 });

    compiled = await createTrip(shared, 'Harbour City');
    await compileRegion(shared);

    await shared.goto('/decide');
    await shared.getByRole('radio', { name: 'Some time in a month' }).check();
    await shared.getByLabel('Which month?').selectOption('7');
    await shared.getByLabel('How many nights?').fill('9');
    await shared.getByRole('checkbox', { name: 'Hiking and being outside' }).check();
    await shared.getByRole('radio', { name: 'Two bases, split the trip' }).check();
    await shared.getByRole('radio', { name: 'Drive', exact: true }).check();
    await shared.getByRole('button', { name: 'Show me where to go' }).click();
    await shared.waitForURL(/\/decide\/[0-9a-f-]{8,}/);
    decided = new URL(shared.url()).pathname.split('/').pop()!;
  });

  test.afterAll(async () => {
    await context?.close();
  });

  for (const viewport of VIEWPORTS) {
    test(`renders without console errors or sideways scroll at ${viewport.name}`, async () => {
      const problems = watchForRuntimeProblems(shared);
      await shared.setViewportSize({ width: viewport.width, height: viewport.height });

      const routes = [
        '/',
        '/trips/new',
        '/decide',
        `/decide/${decided}`,
        `/trips/${compiled}/plan`,
        `/trips/${planned}/questionnaire`,
        `/trips/${planned}/discover`,
        `/trips/${planned}/itinerary`,
        `/trips/${planned}/edit`,
        /*
         * The screen a stale link lands on. It is a normal route — every
         * traveller who bookmarks a trip and later removes it arrives here — and
         * it renders through the same chrome as everything above.
         */
        '/trips/no-such-trip/plan',
      ];

      for (const route of routes) {
        await shared.goto(route);
        /*
         * The skeleton gone and the screen's own heading up: a readiness
         * condition rather than a wait, and the thing that makes an overflow
         * measurement a measurement of the page rather than of its placeholder.
         */
        await expect(shared.locator('[data-loading]')).toHaveCount(0, { timeout: 30_000 });
        /*
         * `.first()` so that a route with two level-one headings fails on its
         * own accessibility spec rather than here, on a strict-mode violation
         * that says nothing about layout. What is being established is that the
         * screen rendered, not that it has exactly one title.
         */
        await expect(
          shared.getByRole('heading', { level: 1 }).first(),
          `${route} rendered no heading at ${viewport.name}`,
        ).toBeVisible({ timeout: 30_000 });
        await expectNoHorizontalOverflow(shared, `${route} at ${viewport.name}`);
      }

      expectNoRuntimeProblems(problems, `Runtime problems at ${viewport.name}`);
    });
  }
});
