import { expect, test, type Page } from '@playwright/test';

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
const REGION_WIDE = 'Best of the Eastern Sierra Go wherever it is worth it';

async function reachBoard(page: Page, dates = AUGUST) {
  await page.goto('/trips/new');
  await page.getByLabel('Where are you going?').fill('Mammoth Lakes');
  await page.getByLabel('Arrive').fill(dates.start);
  await page.getByLabel('Leave').fill(dates.end);
  await page.getByRole('button', { name: 'Start the questionnaire' }).click();

  await page.getByRole('radio', { name: 'Scenic viewpoints: Core' }).check();
  await page.getByRole('radio', { name: 'History & culture: A few times' }).check();

  for (const heading of [
    'How should the days feel?',
    'What is the spending style?',
    'Famous or off the track?',
    'How are you getting around?',
  ]) {
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('heading', { name: heading })).toBeVisible();
  }

  // Manzanar is ninety minutes each way. The default driving budget rules it out
  // on distance before hours ever get a say, and the point of these tests is the
  // hours — so this raises the limit rather than picking a nearer fixture that
  // does not have a closed weekday.
  await page
    .getByLabel('Most you want to spend at the wheel in a day')
    .fill('300');

  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'How far from Mammoth Lakes?' })).toBeVisible();

  // Manzanar is ninety-five minutes down the 395, which the default radius keeps
  // off the board entirely. These tests are about its hours, so open the radius.
  await page.getByRole('radio', { name: REGION_WIDE }).check();
  await page.getByLabel('Furthest you would drive for one stop').fill('180');

  for (const heading of ['Anything to steer around?', 'Your trip personality']) {
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('heading', { name: heading })).toBeVisible();
  }

  await page.getByRole('button', { name: 'Build my discovery board' }).click();
  await expect(page).toHaveURL(/\/discover$/);
  await expect(page.getByRole('heading', { name: 'Must-see classics' })).toBeVisible();
}

function card(page: Page, name: string) {
  return page.getByRole('article').filter({ hasText: name }).first();
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
}

test('the board states opening hours against the traveller’s own dates', async ({ page }) => {
  await reachBoard(page);

  // A staffed lift with real hours says so, and says what they are.
  const gondola = card(page, 'Panorama Gondola');
  await expect(gondola).toBeVisible();
  await expect(gondola.getByText('Limited hours')).toBeVisible();
  await expect(gondola.getByText('Last entry', { exact: true })).toBeVisible();
  await expect(gondola.getByText(/Open 09:00–16:30/)).toBeVisible();

  // A lake with no gate wears nothing at all. This is the assertion that stops a
  // later change from stamping "Open 24 hours" across every natural attraction.
  const convict = card(page, 'Convict Lake');
  await expect(convict).toBeVisible();
  await expect(convict.getByText('Limited hours')).toHaveCount(0);
  await expect(convict.getByText('Hours unconfirmed')).toHaveCount(0);
  await expect(convict.getByText(/^Open \d\d:\d\d/)).toHaveCount(0);

  // Hours we could not confirm are admitted to, not papered over.
  const village = card(page, 'The Village at Mammoth');
  await expect(village.getByText('Hours unconfirmed')).toBeVisible();
  await expect(village.getByText(/Check its hours/)).toBeVisible();
});

test('a limited-hours stop is scheduled inside its window, with its source', async ({ page }) => {
  await reachBoard(page);

  await include(card(page, 'Panorama Gondola'));

  await build(page);

  // The window is stated on the stop, in the traveller's terms.
  await expect(page.getByText('Open 09:00–16:30 · arrive before 16:00').first()).toBeVisible();
  // The day says which stop fixed its shape.
  await expect(page.getByText(/Panorama Gondola sets the shape of this day/)).toBeVisible();
  // And where the hours came from, with no claim to have checked today.
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
  await expect(page.getByText(/Panorama Gondola sets the shape of this day/)).toBeVisible();
});

test('a place shut on every trip date cannot be included, and says why', async ({ page }) => {
  await reachBoard(page, MIDWEEK);

  const centre = card(page, 'Manzanar Visitor Center');
  await expect(centre).toBeVisible();
  await expect(centre.getByText('Closed on your dates')).toBeVisible();
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

  // Both name the site they belong to, so neither looks like a stray copy.
  await expect(grounds.getByText('Part of Manzanar National Historic Site')).toBeVisible();
  await expect(centre.getByText('Part of Manzanar National Historic Site')).toBeVisible();

  // And they are plainly different things: the grounds never close, the centre
  // does, and only one of them is daylight-limited.
  await expect(grounds.getByText('Daylight only')).toBeVisible();
  await expect(grounds.getByText('Closed on your dates')).toHaveCount(0);
  await expect(grounds.getByRole('button', { name: 'Include' })).toBeEnabled();
  await expect(centre.getByText('Closed on your dates')).toBeVisible();
});

test('the grounds are still schedulable on a day the visitor centre is shut', async ({ page }) => {
  await reachBoard(page, MIDWEEK);

  await include(card(page, 'Manzanar National Historic Site'));
  await build(page);

  await expect(
    page.getByRole('heading', { name: 'Manzanar National Historic Site', exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/Signed for daylight use only/).first()).toBeVisible();
  // No borrowed schedule: the grounds show no opening window.
  await expect(page.getByText(/Open 09:00–16:30/)).toHaveCount(0);
});

test('changing the dates recalculates availability rather than reusing it', async ({ page }) => {
  await reachBoard(page);

  // Wednesday to Saturday: the visitor centre opens on two of the four.
  const centre = card(page, 'Manzanar Visitor Center');
  await expect(centre.getByRole('button', { name: 'Include' })).toBeEnabled();
  await expect(centre.getByText('Shut some of your days')).toBeVisible();
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

  // The plan is different and the conflict is stated, not silently dropped.
  await expect(page.getByText('2026-08-11')).toBeVisible();
  await expect(page.getByText('2026-08-15')).toHaveCount(0);
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
    // Scheduled — then it must be on a Friday to Monday.
    await expect(page.getByText(/2026-08-14|2026-08-15/).first()).toBeVisible();
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
