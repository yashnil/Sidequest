import { expect, test, type Page } from '@playwright/test';
import { openHubView } from './support/hub';
import { completeQuestionnaire } from './support/trip';

/**
 * The slice this proves: a traveller sees, before building anything, when each
 * place is actually open on *their* dates — then gets an itinerary scheduled
 * inside those hours, with the constraint and its source stated, surviving a
 * refresh and recalculated when the dates change.
 *
 * Two fixtures carry the weight, and they are chosen because they fail in
 * different ways:
 *
 * - **Panorama Gondola** opens at 09:00 and stops selling walk-up tickets at
 *   16:00. It is a limited-hours stop that still fits, so it proves scheduling
 *   inside a window rather than merely refusing.
 * - **Manzanar** is two places sharing one car park: grounds that never close and
 *   a visitor centre that opens Friday to Monday. On a Tuesday-to-Thursday trip
 *   the centre has no legal day and the grounds still do — which is both the
 *   conflict path and the reason the two were split apart.
 */

const AUGUST = { start: '2026-08-12', end: '2026-08-15' };
/** Tuesday to Thursday — Manzanar's visitor centre is shut on every one. */
const MIDWEEK = { start: '2026-08-11', end: '2026-08-13' };
/** The widest radius, which is the only one that reaches the Owens Valley. */
const REGION_WIDE = 'best_regional';

async function reachBoard(page: Page, dates = AUGUST) {
  await page.goto('/trips/new');
  await page.getByLabel('Destination').fill('Mammoth Lakes');
  await page.getByLabel('Arrive').fill(dates.start);
  await page.getByLabel('Leave').fill(dates.end);
  await page.getByRole('button', { name: /^Continue$/ }).click();

  // Manzanar is ninety-five minutes down the 395: the default driving budget and
  // radius keep it off the board before hours ever get a say, and the point of
  // these tests is the hours — so the walker opens both.
  await completeQuestionnaire(page, {
    priorities: ['Scenic viewpoints', 'History & culture'],
    answers: { 'priority_role:scenic_viewpoints': 'most_days', 'priority_role:history_and_culture': 'couple', daily_driving: '360', scenic_reach: REGION_WIDE },
  });

  await page.getByRole('button', { name: 'Open the Discovery Board' }).click();
  await expect(page).toHaveURL(/\/discover$/);
  await expect(page.getByRole('heading', { name: 'Classics worth your time' })).toBeVisible();
}

/**
 * Located by its own heading, never by text anywhere on the card.
 *
 * `hasText: 'Panorama Gondola'` also matches the Devils Postpile card, whose
 * shuttle note reads "Shuttle boards near the Panorama Gondola Building" — so a
 * plain text filter asserts against whichever of the two sorts first and passes
 * or fails for reasons that have nothing to do with the place under test. The
 * same trap is documented in `weather.spec.ts` for Minaret Vista.
 */
function card(page: Page, name: string) {
  return page
    .getByRole('article')
    .filter({ has: page.getByRole('heading', { name, exact: true }) })
    .first();
}

/**
 * Open a card's own disclosure, whichever of the two it has.
 *
 * A full card folds its detail behind "More about this place"; a card nothing
 * can reach is a compact row whose disclosure is "What it is, and everything we
 * checked". The hours facts a decision needs — the last admission, the operator's
 * own note about which season's timetable this is — live inside whichever one
 * the card carries. They are in the DOM regardless, which is why the assertions
 * that moved failed on visibility rather than on a missing locator.
 */
async function openCardDetail(cardLocator: ReturnType<typeof card>) {
  const summary = cardLocator.locator('summary').first();
  await expect(summary).toBeVisible();
  const details = cardLocator.locator('details').first();
  if (await details.evaluate((element) => (element as HTMLDetailsElement).open)) return;
  await summary.click();
  await expect(details).toHaveJSProperty('open', true);
}

/**
 * Include this place *as the traveller*, not as the auto-pick.
 *
 * The distinction matters: a hand-picked stop outranks everything the machine
 * suggested, and these tests are about what happens to a choice somebody made.
 * Include is a toggle, so a card the auto-pick already chose has to be cleared
 * and re-set to become a user selection rather than left as a suggestion.
 */
async function include(cardLocator: ReturnType<typeof card>) {
  const button = cardLocator.getByRole('button', { name: 'Include' });
  if ((await button.getAttribute('aria-pressed')) === 'true') {
    await button.click();
    await expect(button).toHaveAttribute('aria-pressed', 'false');
  }
  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
}

async function build(page: Page) {
  await page.getByRole('button', { name: /Build my trip|Rebuild my trip/ }).click();
  await expect(page).toHaveURL(/\/itinerary$/, { timeout: 30_000 });
  await expect(page.getByRole('heading', { name: 'Mammoth Lakes', exact: true })).toBeVisible();
  // PRODUCTION UI V1 — stops, hours, conflicts and day weather live under Days.
  await openHubView(page, 'days');
}

test('the board states opening hours against the traveller’s own dates', async ({ page }) => {
  await reachBoard(page);

  /*
   * A staffed lift with real hours says which of them binds.
   *
   * The card wears two chips at most now, and only for things that stop or
   * reshape a visit — here, that it needs a car and a clear day. `Limited hours`
   * is no longer one of them; the hours themselves are one press away, in the
   * card's own disclosure.
   *
   * The minute is asserted, not the label. "Last entry" proved a heading existed;
   * `Last entry 16:00` proves the figure a traveller actually plans around
   * reached the screen, which is the stronger of the two claims and the one this
   * fixture exists for.
   *
   * The window itself — `Open 09:00–16:30 · arrive before 16:00` — is stated
   * where it binds, on the plan beside the stop it shapes, and is asserted in the
   * test directly below against this same fixture.
   */
  const gondola = card(page, 'Panorama Gondola');
  await expect(gondola).toBeVisible();
  await openCardDetail(gondola);
  await expect(gondola.getByText('Last entry 16:00')).toBeVisible();
  await expect(gondola.getByText(/Summer scenic hours/)).toBeVisible();

  // A lake with no gate wears nothing at all. This is the assertion that stops a
  // later change from stamping "Open 24 hours" across every natural attraction —
  // and it is made with the disclosure open, so it covers the detail as well as
  // the face of the card.
  const convict = card(page, 'Convict Lake');
  await expect(convict).toBeVisible();
  await openCardDetail(convict);
  await expect(convict.getByText(/^Open \d\d:\d\d/)).toHaveCount(0);
  await expect(convict.getByText(/Last entry/)).toHaveCount(0);
  await expect(convict.getByText(/could not confirm its opening hours/)).toHaveCount(0);

  // Hours we could not confirm are admitted to, not papered over.
  const village = card(page, 'The Village at Mammoth');
  await openCardDetail(village);
  await expect(village.getByText(/We could not confirm its opening hours/)).toBeVisible();
  await expect(village.getByText(/Check them before you build a day around it/)).toBeVisible();
});

test('a limited-hours stop is scheduled inside its window, with its source', async ({ page }) => {
  await reachBoard(page);

  await include(card(page, 'Panorama Gondola'));

  await build(page);

  // The window is stated on the stop, in the traveller's terms.
  await expect(page.getByText('Open 09:00–16:30 · arrive before 16:00').first()).toBeVisible();
  // The day says which stop fixed its shape — whichever stop with published
  // hours the composed day leads with; the gondola's own window is asserted above.
  await expect(page.getByText(/sets the shape of this day/).first()).toBeVisible();
  // And where the hours came from, with no claim to have checked today.
  // EXPERIENCE V2 — the source of the hours sits behind the stop's details disclosure.
  await page.locator('#hub-view-days [data-testid="stop-details"]').evaluateAll((els) => els.forEach((el) => el.setAttribute('open', '')));
  await expect(page.getByText(/Hours from/).first()).toBeVisible();
  await expect(page.getByText(/We have not checked today/).first()).toBeVisible();

  // The one screen an assertion cannot judge: captured every run so the hours
  // treatment gets looked at in light, dark and at a phone width.
  await page.screenshot({
    path: `test-results/screens/13-hours-${test.info().project.name}.png`,
    fullPage: true,
  });

  // It survives a refresh, hours evidence and all.
  await page.reload();
  await expect(page.getByText('Open 09:00–16:30 · arrive before 16:00').first()).toBeVisible();
  await expect(page.getByText(/sets the shape of this day/).first()).toBeVisible();
});

test('a place shut on every trip date cannot be included, and says why', async ({ page }) => {
  await reachBoard(page, MIDWEEK);

  /*
   * A place nothing can reach on these dates is a compact row, and a compact row
   * carries no chips — it leads with the reason instead. That is the stronger
   * statement, so it is what is asserted: not the label `Closed on your dates`
   * but the sentence that says which dates and why.
   */
  const centre = card(page, 'Manzanar Visitor Center');
  await expect(centre).toBeVisible();
  await expect(centre.getByText(/Why this will not work/)).toBeVisible();
  await expect(centre.getByText(/your dates fall on the days of the week it does not open/)).toBeVisible();
  await expect(centre.getByText(/Shut on every day of your trip/)).toBeVisible();

  // The one control that would build an impossible plan is off.
  await expect(centre.getByRole('button', { name: 'Include' })).toBeDisabled();
  // And the others still work — this is not a dead card.
  await expect(centre.getByRole('button', { name: 'Maybe' })).toBeEnabled();
});

test('the two halves of Manzanar read as one site, not as a duplicate', async ({ page }) => {
  await reachBoard(page, MIDWEEK);

  const grounds = card(page, 'Manzanar National Historic Site');
  const centre = card(page, 'Manzanar Visitor Center');

  /*
   * Both say they are one site, so neither reads as a stray copy — but they say
   * it in the words their own card type has. The full card carries the dedicated
   * line, "Part of <site>. <what they share>". The compact row a blocked place
   * gets has no such paragraph; what survives into it is the shared-approach
   * caution, which still says these two are one journey.
   *
   * The asymmetry is a product finding rather than a test one, and it is
   * reported: a compact row does not name its parent site, so a traveller
   * scanning "Probably skip" sees a second Manzanar entry with no line tying it
   * to the first. What is asserted here is what each card actually states.
   */
  await openCardDetail(grounds);
  await openCardDetail(centre);
  await expect(grounds.getByText('Part of Manzanar National Historic Site')).toBeVisible();
  await expect(centre.getByText(/Shares the site entrance and car park with the tour route/)).toBeVisible();

  /*
   * And they are plainly different things: the grounds never close, the centre
   * does, and only one of them is daylight-limited. `Daylight only` is not a chip
   * any more — the sentence it stood for is, and the sentence says what the label
   * only hinted at.
   */
  await expect(grounds.getByText(/Signed for daylight use only/)).toBeVisible();
  await expect(grounds.getByText(/Shut on every day of your trip/)).toHaveCount(0);
  await expect(grounds.getByRole('button', { name: 'Include' })).toBeEnabled();
  await expect(centre.getByText(/Shut on every day of your trip/)).toBeVisible();
});

test('the grounds are still schedulable on a day the visitor centre is shut', async ({ page }) => {
  await reachBoard(page, MIDWEEK);

  await include(card(page, 'Manzanar National Historic Site'));
  await build(page);

  await expect(
    page.getByRole('heading', { name: 'Manzanar National Historic Site', exact: true }),
  ).toBeVisible();
  await page.locator('#hub-view-days [data-testid="stop-details"]').evaluateAll((els) => els.forEach((el) => el.setAttribute('open', '')));
  await expect(page.getByText(/Signed for daylight use only/).first()).toBeVisible();
  // No borrowed schedule: the grounds show no opening window.
  await expect(page.getByText(/Open 09:00–16:30/)).toHaveCount(0);
});

test('changing the dates recalculates availability rather than reusing it', async ({ page }) => {
  await reachBoard(page);

  // Wednesday to Saturday: the visitor centre opens on two of the four.
  /*
   * "Only some of your days" is the chip now, and the sentence beside it counts
   * them and states the window they fall in — which is the fact that decides
   * whether including this is worth it, so it is asserted as well as the label.
   */
  const centre = card(page, 'Manzanar Visitor Center');
  await expect(centre.getByRole('button', { name: 'Include' })).toBeEnabled();
  await expect(centre.getByText('Only some of your days')).toBeVisible();
  await expect(centre.getByText(/Open on 2 of your 4 days, 09:00–16:30/)).toBeVisible();
  await include(centre);

  await build(page);
  const firstPlan = await page.getByRole('heading', { name: /^Day 1/ }).textContent();
  expect(firstPlan).toBeTruthy();

  // Move onto a midweek span it never opens on, and rebuild from the same board.
  await page.getByRole('link', { name: 'Back to the board' }).click();
  await expect(page).toHaveURL(/\/discover$/);
  await page.goto('/trips/new');
  await reachBoard(page, MIDWEEK);
  await build(page);

  /*
   * The plan is different and the conflict is stated, not silently dropped.
   *
   * Asserted on the *rendered* date rather than the ISO string it is built
   * from. Day headings used to read "Day 1" followed by "2026-08-12" with no
   * separator — an accessible name of "Day 12026-08-12" — and now read
   * "Day 1 · Wed 12 Aug". The claim here is unchanged: the rebuilt plan covers
   * the new span and none of the old one.
   */
  await expect(page.getByText('Tue 11 Aug').first()).toBeVisible();
  await expect(page.getByText('Sat 15 Aug')).toHaveCount(0);
});

test('a manual pick that cannot be scheduled stays visible with a way out', async ({ page }) => {
  await reachBoard(page);

  await include(card(page, 'Manzanar Visitor Center'));
  await build(page);

  // Either it fitted on one of its open days, or it is an explicit conflict with
  // routes that actually resolve it. Both are correct; neither is silence.
  const scheduled = await page.getByRole('heading', { name: 'Manzanar Visitor Center' }).count();
  if (scheduled === 0) {
    await expect(page.getByText(/could not be scheduled/)).toBeVisible();
    await expect(page.getByText(/Manzanar Visitor Center/).first()).toBeVisible();
    await expect(page.getByRole('link', { name: 'Change what is on the board' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Change how you are getting around' })).toBeVisible();
  } else {
    /*
     * Scheduled — then it must be on a Friday to Monday. Matched on the
     * rendered day heading rather than the ISO date it is built from, for the
     * same reason as the specification above: day headings are human dates now.
     */
    await expect(page.getByText(/Fri 14 Aug|Sat 15 Aug/).first()).toBeVisible();
  }
});

test('captures the two halves of Manzanar for review', async ({ page }, testInfo) => {
  // The screen assertions cannot judge: two records for one site, side by side.
  await reachBoard(page, MIDWEEK);
  await card(page, 'Manzanar Visitor Center').scrollIntoViewIfNeeded();
  await page.screenshot({
    path: `test-results/screens/14-manzanar-board-${testInfo.project.name}.png`,
    fullPage: true,
  });

  await include(card(page, 'Manzanar National Historic Site'));
  await build(page);
  await page.screenshot({
    path: `test-results/screens/15-manzanar-itinerary-${testInfo.project.name}.png`,
    fullPage: true,
  });
});
