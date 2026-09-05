import { expect, test, type Page } from '@playwright/test';
import { completeQuestionnaire } from './support/trip';

/**
 * EDITING A PLAN, AND TAKING IT WITH YOU.
 *
 * Two things this phase built that no browser test touched. The per-stop edit
 * menu — remove, swap, lock — and the day-level "make this easier" are the whole
 * of §11.1: a plan you cannot change is a plan you have to accept or discard,
 * and every one of these routes through a deterministic server-side replan
 * rather than through an LLM. The calendar route is §17's export half.
 *
 * The unit suite proves the *planner* honours each intent (`packages/planner`'s
 * `edit.test.ts`) and that the ICS text is well-formed (`calendar/route.test.ts`).
 * What neither can prove, and what these do, is that a traveller can reach any of
 * it: a correct edit engine behind a menu nobody renders is, from the outside,
 * no edit engine at all.
 */

const AUGUST = { start: '2026-08-12', end: '2026-08-15' };

async function buildPlan(page: Page): Promise<string> {
  await page.goto('/trips/new');
  await page.getByLabel('Destination').fill('Mammoth Lakes');
  await page.getByLabel('Arrive').fill(AUGUST.start);
  await page.getByLabel('Leave').fill(AUGUST.end);
  await page.getByRole('button', { name: /^Continue$/ }).click();
  await completeQuestionnaire(page);
  await page.getByRole('button', { name: 'Open the Discovery Board' }).click();
  await expect(page).toHaveURL(/\/discover$/);

  const id = /\/trips\/([^/]+)\/discover/.exec(page.url())?.[1];
  expect(id, 'a trip id should be in the URL').toBeTruthy();

  await page.getByRole('button', { name: /Build my trip|Rebuild my trip/ }).click();
  await expect(page).toHaveURL(/\/itinerary$/, { timeout: 30_000 });
  await expect(page.getByRole('heading', { name: /^Day 1/ })).toBeVisible();
  return id!;
}

/** Every scheduled stop that carries an edit control, by the name on its row. */
function stops(page: Page) {
  return page.getByRole('button', { name: /^Change / });
}

test('a stop can be removed from a day, and the plan is rebuilt around it', async ({ page }) => {
  await buildPlan(page);

  const menu = stops(page).first();
  const label = (await menu.getAttribute('aria-label')) ?? '';
  const title = label.replace(/^Change /, '');
  expect(title.length, 'the control should name the stop it changes').toBeGreaterThan(0);

  await menu.click();
  await page.getByRole('menuitem', { name: 'Remove from this day' }).click();

  /*
   * Gone from the plan, not merely from the screen. The removal is an intent
   * handed to the planner, which reschedules the day around the gap and writes
   * the result — so the reload is the assertion that matters.
   */
  await expect(page.getByRole('button', { name: `Change ${title}` })).toHaveCount(0, {
    timeout: 30_000,
  });
  await page.reload();
  await expect(page.getByRole('heading', { name: /^Day 1/ })).toBeVisible();
  await expect(page.getByRole('button', { name: `Change ${title}` })).toHaveCount(0);
});

test('a stop can be locked to its day, and says so', async ({ page }) => {
  await buildPlan(page);

  const menu = stops(page).first();
  const title = ((await menu.getAttribute('aria-label')) ?? '').replace(/^Change /, '');

  await menu.click();
  await page.getByRole('menuitem', { name: 'Lock to this day' }).click();

  /*
   * The lock is stored, so it survives the reload — and the menu's own offer
   * flips to the other verb, which is the only way a traveller can tell a lock
   * from a click that did nothing.
   */
  const relocated = page.getByRole('button', { name: `Change ${title}` });
  await expect(relocated).toBeVisible({ timeout: 30_000 });
  await page.reload();
  await page.getByRole('button', { name: `Change ${title}` }).click();
  await expect(page.getByRole('menuitem', { name: /^Unlock/ })).toBeVisible();
});

test('a swap offers only what this trip can actually put in the slot', async ({ page }) => {
  await buildPlan(page);

  const menu = stops(page).first();
  await menu.click();
  await page.getByRole('menuitem', { name: 'Swap for something similar…' }).click();

  /**
   * EITHER A REAL ALTERNATIVE OR AN HONEST REFUSAL — never a silent menu.
   *
   * The offers come from this trip's own unused supply, filtered to the same
   * day, similar effort, reachable and open. A board with nothing spare is a
   * legitimate outcome, and the product says so in a sentence that also says
   * what is still possible; what must never happen is a menu that opens onto
   * nothing and leaves somebody pressing it again.
   */
  /*
   * WAIT FOR THE MENU TO STOP BEING THE FIRST MENU.
   *
   * `Swap for something similar…` loads its offers asynchronously and replaces
   * the three original items with either the offers or the refusal. Until it
   * resolves, `getByRole('menuitem')` still matches "Lock to this day" and
   * "Remove from this day" — so `offers.first().or(nothingSpare)` was satisfied
   * by the menu the click was meant to leave, and the branch below then read a
   * DOM that had changed underneath it. Observed as
   * `getByRole('menuitem').first()` resolving to nothing a moment after being
   * asserted visible.
   *
   * The condition is the disappearance of the item that was pressed: it is gone
   * exactly when the offers have arrived, whichever way they came back. A state
   * to wait for, not a duration.
   */
  await expect(page.getByRole('menuitem', { name: 'Swap for something similar…' })).toHaveCount(0, {
    timeout: 30_000,
  });

  const offers = page.getByRole('menuitem');
  const nothingSpare = page.getByText(/Nothing else on your board fits this slot/);
  await expect(offers.first().or(nothingSpare)).toBeVisible({ timeout: 30_000 });

  if (await nothingSpare.isVisible().catch(() => false)) {
    await expect(nothingSpare).toContainText(/Removing it is still an option/);
    return;
  }

  // Every offer names the place and why it fits, so the choice is informed.
  const first = offers.first();
  await expect(first).not.toBeEmpty();
  const swapped = (await first.innerText()).split('\n')[0]!.trim();
  await first.click();

  await expect(page.getByRole('button', { name: `Change ${swapped}` })).toBeVisible({
    timeout: 30_000,
  });
});

test('a day can be made easier, and the plan says what it did', async ({ page }) => {
  await buildPlan(page);

  /*
   * The control appears only on days it can act on — a light day offered "make
   * this easier" is a button that can only apologise — so this asserts on
   * whichever day has one, and that at least one day of a four-day plan does.
   */
  const ease = page.getByRole('button', { name: 'Make this day easier' }).first();
  await expect(ease).toBeVisible();

  const before = await page.getByRole('button', { name: /^Change / }).count();
  await ease.click();

  /*
   * Easing is a rebuild, not a cosmetic change: it drops the least-valuable stop
   * of the day and re-times the rest. So the plan must come back with fewer
   * stops, and it must be the stored plan rather than a client-side edit.
   */
  await expect
    .poll(() => page.getByRole('button', { name: /^Change / }).count(), {
      message: 'easing a day should leave it with fewer stops',
      timeout: 30_000,
    })
    .toBeLessThan(before);

  await page.reload();
  await expect(page.getByRole('heading', { name: /^Day 1/ })).toBeVisible();
  expect(await page.getByRole('button', { name: /^Change / }).count()).toBeLessThan(before);
});

test('the plan downloads as a calendar a calendar application can open', async ({ page }) => {
  const id = await buildPlan(page);

  // The link a traveller presses, on the page where they finished.
  await expect(page.getByRole('link', { name: 'Calendar file (.ics)' })).toHaveAttribute(
    'href',
    `/trips/${id}/itinerary/calendar`,
  );

  const response = await page.request.get(`/trips/${id}/itinerary/calendar`);
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toContain('text/calendar');
  expect(response.headers()['content-disposition']).toContain('.ics');

  const body = await response.text();
  expect(body.startsWith('BEGIN:VCALENDAR')).toBe(true);
  expect(body.trimEnd().endsWith('END:VCALENDAR')).toBe(true);
  // CRLF, because RFC 5545 says so and because a bare LF is the one thing that
  // makes a calendar file silently unimportable.
  expect(body).toContain('\r\n');

  /*
   * Real events with local times, and the attribution that rides with them.
   *
   * Floating local times on purpose: "09:30 at the shrine" means 09:30 on the
   * traveller's wrist. A `Z` here would shift every event by the reader's own
   * offset, which is the defect the route was written to avoid.
   */
  expect(body).toContain('BEGIN:VEVENT');
  expect(body).toMatch(/DTSTART:\d{8}T\d{6}(?!Z)/);
  expect(body).not.toMatch(/DTSTART:\d{8}T\d{6}Z/);
  expect(body).toContain('OpenStreetMap');
});

test('a trip with no plan is refused a calendar rather than given an empty one', async ({
  page,
}) => {
  /**
   * The failure worth having a test for: an export that succeeds with nothing in
   * it is worse than one that refuses, because the traveller finds out at the
   * airport. A trip that has never been planned has no calendar to give.
   */
  await page.goto('/trips/new');
  await page.getByLabel('Destination').fill('Mammoth Lakes');
  await page.getByLabel('Arrive').fill(AUGUST.start);
  await page.getByLabel('Leave').fill(AUGUST.end);
  await page.getByRole('button', { name: /^Continue$/ }).click();
  await expect(page.getByTestId('interview')).toBeVisible();

  const id = /\/trips\/([^/]+)\//.exec(page.url())?.[1];
  const response = await page.request.get(`/trips/${id}/itinerary/calendar`);
  expect(response.status()).toBe(404);
  expect(await response.text()).toMatch(/No plan has been built/);
});
