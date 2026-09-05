import { expect, test, type Page } from '@playwright/test';
import { completeQuestionnaire } from './support/trip';

/**
 * THE TWO BOARD SURFACES THIS PHASE ADDED AND NOTHING DROVE.
 *
 * A map, and a rejection that does something. Both were built, both shipped with
 * unit coverage of their *models* — `board-map-model.test.ts` and the
 * `alsoLikeThis` cases in `board-copy.test.ts` — and neither had a single
 * assertion that they were wired to anything a traveller can press. That is the
 * exact shape of the vacuity this suite exists to catch: a correct model behind a
 * component nobody renders is indistinguishable, from the outside, from no
 * feature at all.
 *
 * Mammoth Lakes, because it is the one seeded region with stable coordinates,
 * stable travel times and enough places for a spatial claim to mean something.
 */

const AUGUST = { start: '2026-08-12', end: '2026-08-15' };

async function reachBoard(page: Page): Promise<void> {
  await page.goto('/trips/new');
  await page.getByLabel('Destination').fill('Mammoth Lakes');
  await page.getByLabel('Arrive').fill(AUGUST.start);
  await page.getByLabel('Leave').fill(AUGUST.end);
  await page.getByRole('button', { name: /^Continue$/ }).click();
  await completeQuestionnaire(page);
  await page.getByRole('button', { name: 'Open the Discovery Board' }).click();
  await expect(page).toHaveURL(/\/discover$/);
  await expect(page.getByTestId('discovery-board')).toBeVisible();
}

/**
 * A pin's label, taken apart.
 *
 * `pinLabel` composes "<name>, <distance>[, chosen]" and the distance is one of
 * three fixed forms, so the name is everything before the last of them. Parsed
 * rather than assumed because the tests below need both halves: the name to find
 * the card, and the minutes to pick a card whose rejection reason is guaranteed
 * to catch something.
 */
function readPin(label: string): { name: string; minutes: number | null } | null {
  const match = /^(.*), (at your base|\d+ min from base|journey not verified)(, chosen)?$/.exec(
    label,
  );
  if (!match) return null;
  const distance = match[2]!;
  if (distance === 'at your base') return { name: match[1]!, minutes: 0 };
  if (distance === 'journey not verified') return { name: match[1]!, minutes: null };
  return { name: match[1]!, minutes: Number.parseInt(distance, 10) };
}

async function pins(page: Page): Promise<{ name: string; minutes: number | null }[]> {
  const map = page.getByTestId('board-map');
  await expect(map).toBeVisible();
  const buttons = map.getByRole('button');
  await expect(buttons.first()).toBeVisible();

  const found: { name: string; minutes: number | null }[] = [];
  const count = await buttons.count();
  for (let index = 0; index < count; index += 1) {
    const label = (await buttons.nth(index).getAttribute('aria-label')) ?? '';
    const pin = readPin(label);
    expect(pin, `a pin is labelled "${label}", which nobody can act on`).not.toBeNull();
    found.push(pin!);
  }
  return found;
}

test('the board draws its places, and every pin says what it is and how far', async ({ page }) => {
  await reachBoard(page);

  const map = page.getByTestId('board-map');
  // A drawing with an accessible name, not a decorative graphic: this is the
  // only summary of the region's shape a screen-reader user gets.
  const drawing = map.getByRole('img');
  await expect(drawing).toBeVisible();
  const summary = await drawing.getAttribute('aria-label');
  expect(summary, 'the map must describe itself in one sentence').toBeTruthy();
  expect(summary!.length).toBeGreaterThan(10);

  const found = await pins(page);
  expect(found.length, 'the Mammoth board should place several places').toBeGreaterThan(1);

  /*
   * THE MAP AND THE BOARD HOLD THE SAME SET.
   *
   * A map quietly showing a different set of places from the list beside it
   * teaches the reader that the two disagree, and the reader is right. Anything
   * with no published position is named underneath instead of being dropped —
   * so every pin is on the board, and the map accounts for the rest in words.
   */
  for (const pin of found) {
    await expect(
      page.locator('[data-place-card]').filter({ hasText: pin.name }).first(),
      `${pin.name} is pinned but is not on the board`,
    ).toBeAttached();
  }

  const unplaced = page.getByTestId('board-map-unplaced');
  if ((await unplaced.count()) > 0) {
    await expect(unplaced).toContainText(/Not on the map, because nobody publishes where/);
  }
});

test('pressing a pin brings its card into view', async ({ page }) => {
  await reachBoard(page);

  const found = await pins(page);
  const target = found[found.length - 1]!;
  const map = page.getByTestId('board-map');
  const pin = map.getByRole('button', { name: new RegExp(`^${escapeRegExp(target.name)},`) });

  /*
   * Selection is two-way, which is the whole point of drawing it (§10.5). A map
   * that cannot be tied back to the list is decoration, and a decorative map on
   * a screen this dense is worse than none.
   */
  await expect(pin).toHaveAttribute('aria-pressed', 'false');
  await pin.click();
  await expect(pin).toHaveAttribute('aria-pressed', 'true');

  // The name is written over the drawing, and the card it belongs to is on
  // screen rather than somewhere down four thousand pixels of board.
  await expect(map.locator('svg text').filter({ hasText: target.name }).first()).toBeVisible();
  const card = page.locator('[data-place-card]').filter({ hasText: target.name }).first();
  await expect(card).toBeInViewport();
});

test('a rejection reason turns into an offer about the rest of the board', async ({ page }) => {
  await reachBoard(page);

  /*
   * The nearest place on the board, so that "too far" necessarily has something
   * to catch: the offer is strictly "at least as bad on the named axis as the
   * one you rejected", which for the closest card is everything else that has a
   * measured journey and no decision on it yet. Picking an arbitrary card would
   * make this pass or fail on which card the auto-selection happened to leave
   * alone, which is not a property of the product.
   */
  const measured = (await pins(page)).filter((pin) => pin.minutes !== null);
  expect(measured.length, 'some journeys should be measured on this board').toBeGreaterThan(1);
  const nearest = measured.reduce((best, pin) => (pin.minutes! < best.minutes! ? pin : best));

  const card = page.locator('[data-place-card]').filter({ hasText: nearest.name }).first();
  await card.getByRole('button', { name: 'Skip' }).click();

  // The reason is asked for once, in place of the three decision buttons rather
  // than under them.
  const reasons = card.getByTestId('card-pass-reasons');
  await expect(reasons).toBeVisible();
  await expect(reasons.getByRole('button', { name: 'Too far' })).toBeVisible();
  await reasons.getByRole('button', { name: 'Too far' }).click();

  // It was recorded as a decision, and it produced a question about the board
  // rather than being filed away for a future trip (§10.6).
  await expect(card.getByRole('button', { name: 'Skip' })).toHaveAttribute('aria-pressed', 'true');
  const followUp = page.getByTestId('board-pass-followup');
  await expect(followUp).toBeVisible();
  await expect(followUp).toContainText(/at least as far out/);
  await expect(followUp).toContainText(`Because you passed on ${nearest.name}`);

  /*
   * Nothing is applied silently: a single "no" is not a mandate to remove five
   * things somebody has not looked at yet. So the count must not have moved
   * until the offer is accepted, and must move when it is.
   */
  const chosenBefore = await chosenCount(page);
  await followUp.getByTestId('board-pass-followup-apply').click();
  await expect(followUp).toHaveCount(0);
  await expect
    .poll(() => chosenCount(page), { message: 'accepting the offer should skip more places' })
    .toBeLessThanOrEqual(chosenBefore);

  // And the skips survive a reload, because they were written rather than kept
  // in the component.
  await page.reload();
  await expect(
    page
      .locator('[data-place-card]')
      .filter({ hasText: nearest.name })
      .first()
      .getByRole('button', { name: 'Skip' }),
  ).toHaveAttribute('aria-pressed', 'true');
});

/** How many places the board says are chosen, off its own summary line. */
async function chosenCount(page: Page): Promise<number> {
  const text = (await page.getByTestId('board-summary').textContent()) ?? '';
  return Number.parseInt(/(\d+)\s+chosen/.exec(text)?.[1] ?? '-1', 10);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
