import { expect, test, type Page } from '@playwright/test';
import { completeQuestionnaire, openBoardBackstage } from './support/trip';

/**
 * The journey this slice promises: a traveller enters a Mammoth Lakes trip,
 * answers the questionnaire, sees their profile reflected back, and gets a
 * Discovery Board of the Eastern Sierra that remembers what they picked.
 */

const AUGUST_TRIP = { start: '2026-08-12', end: '2026-08-15' };
const JANUARY_TRIP = { start: '2027-01-12', end: '2027-01-15' };

async function createTrip(page: Page, dates: { start: string; end: string }) {
  await page.goto('/trips/new');
  await page.getByLabel('Destination').fill('Mammoth Lakes');
  await page.getByLabel('Arrive').fill(dates.start);
  await page.getByLabel('Leave').fill(dates.end);
  await page.getByRole('button', { name: /See what we make of it/i }).click();
  await expect(page.getByRole('heading', { name: 'What are you actually here for?' })).toBeVisible();
}

test('a traveller goes from a blank trip to a personalised Eastern Sierra board', async ({
  page,
}) => {
  await createTrip(page, AUGUST_TRIP);
  await completeQuestionnaire(page);

  // The profile is reflected back before anything is generated.
  await expect(page.getByText(/pace over 4 days/)).toBeVisible();
  await expect(page.getByText('Detour limit')).toBeVisible();

  await page.getByRole('button', { name: 'Build my discovery board' }).click();

  await expect(page).toHaveURL(/\/discover$/);
  await expect(page.getByRole('heading', { name: /Eastern Sierra/ })).toBeVisible();

  // The region, not just the town.
  for (const name of ['Convict Lake', 'Mono Lake South Tufa', 'June Lake Loop', 'Minaret Vista']) {
    // Exact, because the food section below the board holds a "Restaurant at
    // Convict Lake" and a loose name match finds both.
    await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  }

  /*
    Grouped the way the brief asks for, in the words the board now uses. The
    headings were renamed away from the internal taxonomy — "Must-see classics"
    and "Personalised hidden gems" were the group *identifiers* with their
    underscores taken out — and `BOARD_GROUP_HEADINGS` is where they live.
  */
  await expect(page.getByRole('heading', { name: 'Classics worth your time' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Quiet finds' })).toBeVisible();

  /*
    Cards carry fit, the journey, effort and a profile-specific explanation.

    The argument is a paragraph on the face of the card now rather than a
    disclosure headed "Why this fits you", and the journey is a clause on the
    locality line rather than a "From base" definition-list entry — both moves
    made for the same reason, which is that a card is a comparison surface and a
    stack of labelled rows is not one. Asserted by their test hooks and by the
    sentence they produce, so a card that renders the labels and no content
    cannot pass.
  */
  const convict = page.getByRole('article').filter({ hasText: 'Convict Lake' }).first();
  await expect(convict.getByText(/Top pick for you|Strong fit|Good fit/)).toBeVisible();
  await expect(convict.getByTestId('card-why')).toBeVisible();
  await expect(convict.getByTestId('card-why')).not.toBeEmpty();
  await expect(convict.getByText(/from base|at your base/)).toBeVisible();
  await expect(convict.getByText('Effort')).toBeVisible();
});

test('the board arrives pre-selected rather than empty', async ({ page }) => {
  await createTrip(page, AUGUST_TRIP);
  await completeQuestionnaire(page);
  await page.getByRole('button', { name: 'Build my discovery board' }).click();
  await expect(page).toHaveURL(/\/discover$/);

  // A balanced starting set is already applied — the traveller confirms a plan
  // rather than building one from a grid of 22 cards.
  // The visible counter by its own identity, not by a text shape. A text shape
  // matches whatever else happens to start the same way — the board's live
  // region did, and four specs failed at once for a reason none of them was
  // about. The count reads "N chosen" now; "in" was shorthand nobody says.
  await expect(page.getByTestId('board-summary')).toContainText(/[1-9]\d* chosen/);

  const card = page.getByRole('article').filter({ hasText: 'Convict Lake' }).first();
  await expect(card.getByRole('button', { name: 'Include' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});

test('a hand-made choice overrides the auto-pick and survives a refresh', async ({ page }) => {
  await createTrip(page, AUGUST_TRIP);
  await completeQuestionnaire(page);
  await page.getByRole('button', { name: 'Build my discovery board' }).click();
  await expect(page).toHaveURL(/\/discover$/);

  /*
   * A pass is two presses now: "Skip" asks why, and the reason is applied to
   * this trip rather than filed away. The five reasons replace the three-way
   * control in place, so the button this asserted on is gone between the two
   * presses — which is why the old single click failed on "element not found"
   * rather than on a wrong state.
   */
  const card = page.getByRole('article').filter({ hasText: 'Convict Lake' }).first();
  await card.getByRole('button', { name: 'Skip' }).click();
  await expect(card.getByTestId('card-pass-reasons')).toBeVisible();
  await card.getByRole('button', { name: 'Not my thing' }).click();
  await expect(card.getByRole('button', { name: 'Skip' })).toHaveAttribute('aria-pressed', 'true');

  await page.reload();

  const afterReload = page.getByRole('article').filter({ hasText: 'Convict Lake' }).first();
  await expect(afterReload.getByRole('button', { name: 'Skip' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(afterReload.getByRole('button', { name: 'Include' })).toHaveAttribute(
    'aria-pressed',
    'false',
  );

  // Re-running the automatic choice must not undo a decision made by hand.
  await page.getByTestId('board-auto-pick').click();
  await expect(afterReload.getByRole('button', { name: 'Skip' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});

test('the counts from "choose for me" persist across a reload', async ({ page }) => {
  await createTrip(page, AUGUST_TRIP);
  await completeQuestionnaire(page);
  await page.getByRole('button', { name: 'Build my discovery board' }).click();

  await page.getByTestId('board-auto-pick').click();
  const counter = page.getByTestId('board-summary');
  await expect(counter).toContainText(/[1-9]\d* chosen/);
  /*
    And it says what it did, where it was pressed. The control used to change
    some borders far down a very long page and say nothing at all, which read as
    a button that did nothing.
  */
  await expect(page.getByTestId('board-auto-pick-notes')).toBeVisible();

  const before = await counter.textContent();
  await page.reload();
  await expect(page.getByTestId('board-summary')).toHaveText(before ?? '');
});

test('a winter trip is told plainly what is shut rather than shown a broken plan', async ({
  page,
}) => {
  await createTrip(page, JANUARY_TRIP);
  await completeQuestionnaire(page);
  await page.getByRole('button', { name: 'Build my discovery board' }).click();

  /*
   * The count of shut places is backstage now, with the readiness reading, the
   * personality and the weather — the board leads with places rather than with
   * an account of the research. Folded, not dropped: this opens the panel and
   * asserts the sentence is still counted and still named.
   */
  await openBoardBackstage(page);
  await expect(page.getByText(/places are shut on your dates/)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Probably skip' })).toBeVisible();

  /*
    By heading, not by text: `hasText: 'Devils Postpile'` also matches the
    Rainbow Falls card, which names the monument in the corridor they share — so
    this was asserting about a different place and would have passed or failed
    for reasons unrelated to the one under test.
  */
  const postpile = page
    .getByRole('article')
    .filter({
      has: page.getByRole('heading', { name: 'Devils Postpile National Monument', exact: true }),
    })
    .first();
  /*
    The date fact in the words the row uses. "Closed on your dates" was an
    hours-badge chip, and the things-to-skip group is a compact list that carries
    no chips — so the sentence itself is what has to survive the compaction. In
    January what shuts this is the season on the road rather than an opening
    timetable, so the row names the season and the consequence, which is the more
    specific of the two statements.
  */
  await expect(postpile.getByText('Why this will not work')).toBeVisible();
  await expect(postpile.getByText(/Usually open June to October/)).toBeVisible();
  await expect(postpile.getByText(/it will not be reachable on your dates/)).toBeVisible();

  // Year-round places are unaffected.
  await expect(page.getByRole('heading', { name: 'Convict Lake', exact: true })).toBeVisible();
});

test('a card opens for the detail and closes again, keeping the decision made on it', async ({
  page,
}) => {
  /**
   * The board was 13,930px tall at 1440 and 25,270px at 390 because every card
   * printed its description, its weather caveat and its whole argument at once.
   * The argument is now one disclosure away — which is only acceptable if it is
   * genuinely still there, and if opening it is not a decision about the place.
   */
  await createTrip(page, AUGUST_TRIP);
  await completeQuestionnaire(page);
  await page.getByRole('button', { name: 'Build my discovery board' }).click();
  await expect(page).toHaveURL(/\/discover$/);

  const convict = page.getByRole('article').filter({ hasText: 'Convict Lake' }).first();
  const details = convict.locator('details', { hasText: 'More about this place' }).first();
  const description = details.locator('p').first();

  /*
    Collapsed on arrival, and it now holds the *detail* rather than the argument.
    The disclosure and the paragraph swapped places: a product whose whole
    differentiation is personal fit was hiding its case behind a summary and
    leading with the disclaimers. So the argument is asserted on the face of the
    card, and what is behind the door is the description and the provenance.
  */
  expect(await details.evaluate((node) => (node as HTMLDetailsElement).open)).toBe(false);
  await expect(description).toBeHidden();
  await expect(convict.getByTestId('card-why')).toBeVisible();

  // Mark it, then open it. The mark must be untouched by the disclosure.
  await convict.getByRole('button', { name: 'Maybe' }).click();
  await expect(convict.getByRole('button', { name: 'Maybe' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  await convict.getByText('More about this place').click();
  await expect(details).toHaveAttribute('open', '');
  await expect(description).toBeVisible();

  await convict.getByText('More about this place').click();
  expect(await details.evaluate((node) => (node as HTMLDetailsElement).open)).toBe(false);
  await expect(convict.getByRole('button', { name: 'Maybe' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  // And the decision-critical facts never went behind the disclosure at all.
  await expect(convict.getByText(/from base|at your base/)).toBeVisible();
  await expect(convict.getByText('Effort')).toBeVisible();
});

test('filters narrow the board and give every card back', async ({ page }) => {
  await createTrip(page, AUGUST_TRIP);
  await completeQuestionnaire(page);
  await page.getByRole('button', { name: 'Build my discovery board' }).click();
  await expect(page).toHaveURL(/\/discover$/);

  const board = page.getByTestId('discovery-board');
  const cards = board.getByRole('article');
  // `count()` does not wait for anything, so the board has to be asserted
  // present before it is counted — otherwise this measures an empty document.
  await expect(cards.first()).toBeVisible();
  const before = await cards.count();
  expect(before, 'the board should have cards to filter').toBeGreaterThan(1);

  // Something the traveller has decided on, so we can prove a filter is a view
  // rather than an edit.
  const convict = page.getByRole('article').filter({ hasText: 'Convict Lake' }).first();
  await convict.getByRole('button', { name: 'Maybe' }).click();
  await expect(convict.getByRole('button', { name: 'Maybe' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  const rail = page.getByTestId('board-filters');
  await expect(rail).toBeVisible();

  // The narrowest distance step this board offers.
  const nearest = rail.getByRole('radio').nth(1);
  await nearest.check();
  await expect(nearest).toBeChecked();

  const narrowed = await cards.count();
  expect(narrowed, 'the filter should remove something').toBeLessThan(before);
  expect(narrowed, 'the filter should keep something').toBeGreaterThan(0);
  await expect(page.getByTestId('board-filter-count')).toContainText(
    `Showing ${narrowed} of ${before}`,
  );

  // Reversible, and the mark survived being filtered out and back in.
  await page.getByTestId('board-filter-clear').click();
  await expect(cards).toHaveCount(before);
  await expect(
    page
      .getByRole('article')
      .filter({ hasText: 'Convict Lake' })
      .first()
      .getByRole('button', { name: 'Maybe' }),
  ).toHaveAttribute('aria-pressed', 'true');
});

test('things to skip are one line each, and can still be put back', async ({ page }) => {
  /**
   * Six full-size cards arguing for places we have just explained are wrong for
   * this trip is about two thousand pixels of the board. The group is still
   * complete and still explained — it is simply a list.
   */
  await createTrip(page, JANUARY_TRIP);
  await completeQuestionnaire(page);
  await page.getByRole('button', { name: 'Build my discovery board' }).click();

  const list = page.getByTestId('skip-list');
  await expect(list).toBeVisible();

  const rows = list.getByRole('article');
  await expect(rows.first()).toBeVisible();
  const count = await rows.count();
  expect(count, 'the January board should have things to skip').toBeGreaterThan(0);

  // Compact: a row is a fraction of the height of a card in a normal group.
  const card = page
    .getByRole('article')
    .filter({ hasText: 'Convict Lake' })
    .first();
  const cardBox = await card.boundingBox();
  const rowBox = await rows.first().boundingBox();
  expect(cardBox, 'a normal card should have a box').not.toBeNull();
  expect(rowBox, 'a skip row should have a box').not.toBeNull();
  expect(rowBox!.height).toBeLessThan(cardBox!.height);

  // Still says why, and still lets the traveller disagree with us.
  await expect(rows.first().getByText(/Why this will not work|Why we would skip it/)).toBeVisible();
  const maybe = rows.first().getByRole('button', { name: 'Maybe' });
  await maybe.click();
  await expect(maybe).toHaveAttribute('aria-pressed', 'true');
});

test('the questionnaire adapts and refuses to continue on an empty profile', async ({ page }) => {
  await createTrip(page, AUGUST_TRIP);

  // Nothing chosen yet — every interest is still "if nearby".
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Pick at least one thing' })).toBeVisible();

  await page.getByRole('radio', { name: 'Hiking: Core' }).check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'How should the days feel?' })).toBeVisible();

  // Walk forward to the transport step, checking each heading on the way so a
  // change in step order fails loudly instead of silently skipping a step.
  for (const heading of [
    'What is the spending style?',
    'How do you want to eat?',
    'Famous or off the track?',
    'How are you getting around?',
  ]) {
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('heading', { name: heading })).toBeVisible();
  }
  await expect(page.getByText('Steep mountain roads are fine')).toBeVisible();

  await page.getByLabel('You will have a car').uncheck();
  await expect(page.getByText('Steep mountain roads are fine')).toBeHidden();
  /*
   * The note that appears when the car is unchecked. Its wording moved when the
   * questionnaire stopped naming one valley's trolley and bus route — the
   * assertion is on the *behaviour*, which is that a no-car answer says plainly
   * what it costs.
   */
  await expect(page.getByText(/Without a car we will keep to what walks/)).toBeVisible();

  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('radio', { name: /Up to ~2 hours/ })).toHaveCount(0);
  await expect(page.getByText(/Wider radii are hidden because you are not driving/)).toBeVisible();
});

test('questionnaire progress survives a refresh mid-flow', async ({ page }) => {
  await createTrip(page, AUGUST_TRIP);
  await page.getByRole('radio', { name: 'Stargazing: Core' }).check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'How should the days feel?' })).toBeVisible();

  await page.reload();

  /*
   * BOTH HALVES OF "PROGRESS", NOW THAT BOTH ARE KEPT.
   *
   * This used to assert only that the answer survived — and it could only do
   * that because a refresh dumped the traveller back on step one, where the
   * radio happened to be on screen. The position was React state while the
   * answers were saved, so a refresh on step seven of nine restarted at step
   * one with everything intact and nothing to say which answers had been
   * reached deliberately, under a header reading "Saved as you go".
   *
   * Progress is the step *and* the answers. So: they come back where they were,
   * and the answer is still there when they step back to it.
   */
  await expect(page.getByRole('heading', { name: 'How should the days feel?' })).toBeVisible();
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(page.getByRole('radio', { name: 'Stargazing: Core' })).toBeChecked();
});

test('the whole journey is reachable by keyboard', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'Keyboard traversal is a desktop concern');

  await createTrip(page, AUGUST_TRIP);

  // Focus lands somewhere in the document and the first interest control is
  // reachable by tabbing, with a visible focus ring.
  const firstRadio = page.getByRole('radio', { name: 'Hiking: Skip' });
  await firstRadio.focus();
  await expect(firstRadio).toBeFocused();

  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('radio', { name: 'Hiking: A few times' })).toBeChecked();

  await page.getByRole('button', { name: 'Continue' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'How should the days feel?' })).toBeVisible();
});
