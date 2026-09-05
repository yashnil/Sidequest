import { expect, test, type Page } from '@playwright/test';
import { completeQuestionnaire } from './support/trip';

/**
 * WHAT EACH ROUTE CALLS ITSELF, AND WHAT THE FRONT DOOR SAYS ABOUT YOUR TRIPS.
 *
 * Two failures that only show up outside the page you are looking at.
 *
 * The first is WCAG 2.4.2. Every route in the product inherited one marketing
 * title from the root layout, so six open trips were six identical tabs, the
 * back history was a column of the same sentence, and a screen reader announced
 * "Sidequest — trips built around how you actually travel" on arrival at the
 * questionnaire, the board and the plan alike. Nothing on any individual screen
 * looks wrong; the defect is entirely in the relationship between them, which is
 * why it survived every screen-by-screen review.
 *
 * The second is the trip list. It used to decide a row's label with one ternary
 * over a four-value column — `draft` printed "Not finished" and everything else
 * printed "Discovery board ready" — so a trip whose build had died eight days
 * earlier was announced as a finished board, linking to a page that redirected
 * somewhere else.
 */

const AUGUST = { start: '2026-08-12', end: '2026-08-15' };
const DESTINATION = 'Mammoth Lakes';

/** A trip at the questionnaire, which is as far as most of these need. */
async function startTrip(page: Page): Promise<string> {
  await page.goto('/trips/new');
  await page.getByLabel('Destination').fill(DESTINATION);
  await page.getByLabel('Arrive').fill(AUGUST.start);
  await page.getByLabel('Leave').fill(AUGUST.end);
  await page.getByRole('button', { name: /See what we make of it/i }).click();
  await expect(page.getByTestId('interview')).toBeVisible();
  const id = /\/trips\/([^/]+)\//.exec(page.url())?.[1];
  expect(id, 'a trip id should be in the URL').toBeTruthy();
  return id!;
}

test('no two routes a traveller can be on share a title', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'A document title has no viewport');

  const id = await startTrip(page);
  await completeQuestionnaire(page);
  await page.getByRole('button', { name: 'Build my discovery board' }).click();
  await expect(page).toHaveURL(/\/discover$/);
  await page.getByRole('button', { name: /Build my trip|Rebuild my trip/ }).click();
  await expect(page).toHaveURL(/\/itinerary$/, { timeout: 30_000 });

  const routes = [
    '/',
    '/trips/new',
    '/decide',
    `/trips/${id}/plan`,
    `/trips/${id}/questionnaire`,
    `/trips/${id}/discover`,
    `/trips/${id}/itinerary`,
    `/trips/${id}/edit`,
  ];

  /*
   * Keyed by where the browser actually ended up, not by what was asked for. A
   * route that redirects is one screen wearing two addresses, and holding it to
   * a distinct title would be demanding the impossible.
   */
  const titles = new Map<string, string>();
  const landings = new Set<string>();

  for (const route of routes) {
    await page.goto(route);
    await expect(page.locator('[data-loading]')).toHaveCount(0);
    const landed = new URL(page.url()).pathname;
    if (landings.has(landed)) continue;
    landings.add(landed);

    const title = await page.title();
    expect(title, `${route} has no title`).toBeTruthy();
    const clash = titles.get(title);
    expect(clash, `${route} and ${clash} both call themselves "${title}"`).toBeUndefined();
    titles.set(title, route);
  }

  /**
   * EVERY SCREEN COMPARED, AND ENOUGH OF THEM TO MEAN SOMETHING.
   *
   * This asserted `titles.size === routes.length`, which the loop above makes
   * unreachable the moment any route redirects — and one does, by design: a trip
   * against an *authored* region never enters the compile flow, so `/plan`
   * forwards to the questionnaire and eight addresses land on seven screens.
   * The two halves of this test contradicted each other, and the half that was
   * wrong was this one.
   *
   * What the test is for is that no two screens share a title. That is asserted
   * against the screens actually reached, with a floor underneath it: a product
   * that redirected everything onto one page would satisfy "no duplicates"
   * trivially, and the floor is what stops that passing.
   */
  expect(titles.size, 'two screens shared a title').toBe(landings.size);
  expect(landings.size, 'too few distinct screens were compared to prove anything').toBeGreaterThanOrEqual(
    routes.length - 1,
  );

  /*
   * And the trip routes lead with the destination. A tab strip truncates from
   * the right, so the leading words are the only ones somebody with six trips
   * open can read — "Sidequest — …" six times over is the failure this replaces.
   */
  for (const [title, route] of titles) {
    if (!route.startsWith(`/trips/${id}`)) continue;
    expect(title.startsWith(DESTINATION), `${route} does not name its destination first`).toBe(
      true,
    );
    expect(title.endsWith('Sidequest')).toBe(true);
  }
});

test('the trip list says where each trip actually is, and can remove one', async ({ page }) => {
  const id = await startTrip(page);

  await page.goto('/');
  /*
   * Found by its own link rather than by its destination.
   *
   * The suite shares one database and one worker, so by the time this runs there
   * are a dozen other Mammoth Lakes trips in the list from other specs. Matching
   * on the name would pick whichever of them sorted highest and then assert this
   * test's expectations about somebody else's trip — a pass or a failure that has
   * nothing to do with either.
   */
  const rowFor = (tripId: string) =>
    page
      .getByRole('listitem')
      .filter({ has: page.locator(`a[href="/trips/${tripId}/plan"]`) })
      .first();

  // And it may be below the fold: a brand-new trip sorts last, behind everything
  // that is building, planned or waiting on an answer.
  const more = page.getByRole('button', { name: /^Show \d+ more trip/ });
  if (await more.isVisible().catch(() => false)) await more.click();

  const row = rowFor(id);
  await expect(row).toBeVisible();

  /*
   * A trip nobody has researched yet says so, and offers the thing that carries
   * on from there. "Discovery board ready" over a trip with no board was the
   * defect: a label that is wrong is worse than no label, because it sends the
   * traveller to a page that redirects them away.
   */
  await expect(row).toContainText('Not researched yet');
  await expect(row.getByRole('link', { name: 'Carry on' })).toHaveAttribute(
    'href',
    `/trips/${id}/plan`,
  );
  // The dates a person reads, not two ISO strings.
  await expect(row).not.toContainText(AUGUST.start);
  await expect(row).toContainText(/night/);

  /*
   * REMOVING ONE IS TWO PRESSES AND NOT A DIALOG.
   *
   * The row turns into its own confirmation: the question is in the flow of the
   * page, both answers are real buttons, and neither is a `window.confirm` —
   * which is unstyled, unannounced to some assistive technology, and
   * unreachable by keyboard on iOS Safari inside a transition.
   */
  await row.getByRole('button', { name: `Remove the ${DESTINATION} trip` }).click();

  /*
   * The confirming row no longer holds the link this row was found by, so it is
   * found by the question instead — and exactly one row may be asking it, which
   * is itself worth asserting on a list of a dozen identically-named trips.
   */
  const asking = page
    .getByRole('listitem')
    .filter({ hasText: 'This deletes the answers and any research done for it' });
  await expect(asking).toHaveCount(1);
  await expect(asking).toContainText(DESTINATION);
  await asking.getByRole('button', { name: 'Keep it' }).click();
  await expect(rowFor(id)).toBeVisible();

  await rowFor(id).getByRole('button', { name: `Remove the ${DESTINATION} trip` }).click();
  await asking.getByRole('button', { name: 'Remove', exact: true }).click();

  /*
   * Gone, and gone from the database rather than from the list component: the
   * trip's own route must no longer resolve. This is the assertion that makes
   * the delete real — a row that disappears from a client-side array and leaves
   * sixty rows in the table is the state this control was built to end.
   */
  await expect(
    page.getByRole('listitem').filter({ has: page.locator(`a[href="/trips/${id}/plan"]`) }),
  ).toHaveCount(0, { timeout: 15_000 });

  /**
   * GONE FROM THE DATABASE, PROVED BY THE SCREEN THE ROUTE NOW RENDERS.
   *
   * This asserted `status() === 404` on a raw request, which is not what the
   * route answers: the plan page streams, so the response is committed as 200
   * with the loading skeleton in it and the `notFound()` inside the suspended
   * body arrives afterwards. The status is a finding in its own right — a
   * removed trip's URL answers 200 to any crawler or monitor, under the title of
   * the page it is not — and is reported rather than asserted around.
   *
   * What proves the delete reached the database is the screen: that heading
   * renders only when `getTrip` returns nothing, so a row that vanished from a
   * client-side array while sixty rows stayed in the table cannot produce it.
   * That is the same claim the status check was making, made where the product
   * actually answers it.
   */
  await page.goto(`/trips/${id}/plan`);
  await expect(page.getByRole('heading', { name: 'We cannot find that trip' })).toBeVisible({
    timeout: 15_000,
  });
});
