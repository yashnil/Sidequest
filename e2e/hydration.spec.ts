import { expect, test, type Page } from '@playwright/test';
import { buildFixtureTrip } from './support/v9';
import { bandAction } from './support/hub';
import { completeQuestionnaire, createTrip, waitUntilInteractive } from './support/trip';
import { answerUntilShortlist, startAdvisor } from './support/advisor';
import { summerTrip } from './support/dates';
import { routeTiles } from './maps/support/tiles';

/**
 * NO PAGE MAY DISAGREE WITH ITSELF.
 *
 * React error #418 is the server and the browser producing different markup for
 * the same page. React recovers by throwing the server's work away and rendering
 * the whole boundary again on the client, so nothing looks wrong and the page
 * costs twice what it should. It sat in the console of every walk for weeks
 * because no assertion ever read the console.
 *
 * Run in a browser whose locale and time zone are deliberately not the server's
 * as well as in one that matches: a mismatch only a traveller abroad would see
 * is the same bug, and the machine a test runs on is the one place where the
 * two always agree.
 */

const HYDRATION = /error #(418|419|421|422|423|425)|Hydration failed|did not match|server rendered (HTML|text)/i;

interface Observed {
  route: string;
  message: string;
}

function watch(page: Page, observed: Observed[]): void {
  const note = (message: string): void => {
    if (HYDRATION.test(message)) observed.push({ route: page.url(), message: message.slice(0, 500) });
  };
  page.on('pageerror', (error) => note(`${error.message}\n${error.stack ?? ''}`));
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') note(message.text());
  });
}

/** Open a route and stay until React has finished with it: a mismatch is reported after the shell has painted. */
async function visit(page: Page, route: string): Promise<void> {
  await page.goto(route, { waitUntil: 'load' });
  await expect(page.locator('[data-loading]')).toHaveCount(0, { timeout: 20_000 });
  await waitUntilInteractive(page.locator('body a[href], body button').first());
  await page.waitForTimeout(400);
}

const FOREIGN = { locale: 'de-DE', timezoneId: 'Asia/Tokyo' } as const;

const PUBLIC_ROUTES = [
  '/',
  '/signin',
  '/support',
  '/privacy',
  '/terms',
  '/decide',
  '/explore',
  '/trips',
  '/trips/new',
  '/trips/new?have=plan',
  '/profile',
  '/this-address-leads-nowhere',
  '/share/AAAAAAAAAAAAAAAAAAAAAA',
];

const TRIP_ROUTES = ['plan', 'questionnaire', 'discover', 'build', 'itinerary', 'edit', 'pack', 'today', 'party', 'feedback', 'provisional'];

const CONTEXTS = [
  ["the server's own locale", {}],
  ['a browser abroad', FOREIGN],
  /* Motion's hook answers from `matchMedia` on the client and has no answer on the server. */
  ['a browser asking for less motion', { contextOptions: { reducedMotion: 'reduce' } }],
] as const;

for (const [label, options] of CONTEXTS) {
  test.describe(`hydration, in ${label}`, () => {
    test.use(options);
    /* A build and a dozen trip routes in one test on purpose, so one trip pays for all of them. */
    test.setTimeout(240_000);
    test.skip(({ colorScheme }) => colorScheme === 'dark', 'A mismatch does not depend on colour scheme');

    test('no public page disagrees with itself', async ({ page }) => {
      const observed: Observed[] = [];
      watch(page, observed);
      await routeTiles(page);
      for (const route of PUBLIC_ROUTES) await visit(page, route);
      /* The advisor's session page renders from stored answers, at every stage of them. */
      const session = await startAdvisor(page);
      await visit(page, `/decide/${session}`);
      await answerUntilShortlist(page);
      await visit(page, `/decide/${session}`);
      expect(observed, 'hydration errors on public pages').toEqual([]);
    });

    test('no page of a fully built trip disagrees with itself', async ({ page, browser }) => {
      const observed: Observed[] = [];
      watch(page, observed);
      await routeTiles(page);

      const id = await buildFixtureTrip(page);
      for (const route of TRIP_ROUTES) await visit(page, `/trips/${id}/${route}`);
      for (const view of ['days', 'map', 'book', 'prepare']) await visit(page, `/trips/${id}/itinerary#${view}`);
      await visit(page, '/trips');
      await visit(page, '/profile');

      /* The share page is read by a browser that never saw the trip, so it gets a context of its own. */
      await visit(page, `/trips/${id}/itinerary`);
      const share = await bandAction(page, 'Share this plan');
      await waitUntilInteractive(share);
      await share.click();
      const link = await page.getByLabel('Share link').inputValue();
      /* A page that says something different once a link exists: the Pack's share field. Likewise once a calendar feed does. */
      await visit(page, `/trips/${id}/pack`);
      const feed = page.getByTestId('pack-feed-create');
      await waitUntilInteractive(feed);
      await feed.click();
      await expect(page.getByTestId('pack-feed-url')).toBeVisible({ timeout: 15_000 });
      await visit(page, `/trips/${id}/pack`);
      await visit(page, `/trips/${id}/itinerary`);

      const reader = await browser.newContext('contextOptions' in options ? options.contextOptions : options);
      const readerPage = await reader.newPage();
      watch(readerPage, observed);
      await routeTiles(readerPage);
      await visit(readerPage, new URL(link).pathname);
      await reader.close();

      expect(observed, 'hydration errors on a built trip').toEqual([]);
    });

    test('no stage of the journey disagrees with itself, on a first visit or a reload', async ({ page }) => {
      const observed: Observed[] = [];
      watch(page, observed);
      await routeTiles(page);

      const id = await createTrip(page, 'Mammoth Lakes', summerTrip(4));
      await visit(page, `/trips/${id}/questionnaire`);
      await completeQuestionnaire(page);
      await visit(page, `/trips/${id}/questionnaire`);
      await completeQuestionnaire(page);
      await page.getByRole('button', { name: 'Open the Discovery Board' }).click();
      await expect(page.getByTestId('board-summary')).toBeVisible({ timeout: 90_000 });
      await visit(page, `/trips/${id}/discover`);
      await page.getByRole('button', { name: /Build my trip|Rebuild my trip/ }).first().click();
      await page.waitForURL(/\/itinerary(#[a-z-]+)?$/, { timeout: 120_000 });
      await expect(page.getByTestId('atlas-band')).toBeVisible({ timeout: 30_000 });
      /* A choice the trip page remembers for the session: the next load of the page starts with it. */
      await page.waitForTimeout(800);
      const stop = page.locator('#hub-view-days [data-timeline-place][data-day="2"]').first().getByTestId('stop-number');
      if (await stop.isVisible().catch(() => false)) await stop.click();
      await page.waitForTimeout(1500);
      await visit(page, `/trips/${id}/itinerary`);
      await visit(page, `/trips/${id}/itinerary`);
      await visit(page, `/trips/${id}/pack`);
      await visit(page, `/trips/${id}/itinerary`);

      expect(observed, 'hydration errors along the journey').toEqual([]);
    });
  });
}
