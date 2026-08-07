import { expect, type Locator, type Page } from '@playwright/test';

/**
 * The journey helpers, in one place.
 *
 * They used to be copy-pasted into six specs, which was survivable while the
 * composer had four fields and stopped being so the moment the flow changed:
 * one phase's worth of UI work meant the same three edits in six files, and the
 * sixth was always the one that got missed. Every spec drives the product
 * through these.
 */

export const DEFAULT_DATES = { start: '2026-08-12', end: '2026-08-16' };

/**
 * WAIT UNTIL THE APP OWNS THE CONTROL, NOT MERELY UNTIL IT IS ON SCREEN.
 *
 * Playwright's actionability checks answer "is this element visible, stable and
 * editable". On a server-rendered page every one of them is satisfied *before
 * the JavaScript that gives the element behaviour has run* — so `fill` sets the
 * value, no handler observes it, and the value sits there looking correct while
 * the component's state stays empty.
 *
 * That is not a slow test. It is a lost keystroke, and it is unrecoverable:
 * React does not re-read a pre-existing input value when it hydrates, so nothing
 * later in the journey can put it right. The composer gates its second section
 * on the destination it believes it has, so the observed symptom was a
 * sixty-second timeout waiting for `getByLabel('Arrive')` — a field the form was
 * correctly refusing to render, on a page whose first field visibly contained
 * the typed text.
 *
 * The condition below is the real one: React attaches a fiber to a DOM node when
 * it takes ownership of it, so a node carrying `__reactFiber$…` is a node whose
 * events will be seen. Waiting for the *specific* control rather than for the
 * document also survives streamed hydration, where the shell is interactive
 * before a section further down is.
 *
 * This is a readiness condition, not a tolerance: it waits for a state to be
 * true rather than for time to pass, and it fails loudly if that state never
 * arrives.
 */
export async function waitUntilInteractive(locator: Locator): Promise<void> {
  await expect
    .poll(
      async () =>
        locator
          .evaluate((element) =>
            Object.keys(element).some((key) => key.startsWith('__reactFiber$')),
          )
          .catch(() => false),
      {
        message: 'the control never became interactive — the page did not hydrate',
        timeout: 15_000,
      },
    )
    .toBe(true);
}

/**
 * Fill the composer and submit it.
 *
 * Types the destination rather than picking a suggestion, because the end-to-end
 * environment deliberately has no destination index: these tests exercise the
 * *fallback* path — typed text, one explicit resolution — which is the one that
 * has to keep working for everything the index does not hold.
 */
export async function createTrip(
  page: Page,
  destination: string,
  dates: { start: string; end: string } = DEFAULT_DATES,
): Promise<string> {
  await page.goto('/trips/new');
  const field = page.getByLabel('Destination');
  await waitUntilInteractive(field);
  await field.fill(destination);
  await page.getByLabel('Arrive').fill(dates.start);
  await page.getByLabel('Leave').fill(dates.end);
  await page.getByRole('button', { name: /See what we make of it/i }).click();
  await page.waitForURL(/\/trips\/[^/]+\/(plan|questionnaire)/);
  const id = /\/trips\/([^/]+)\//.exec(page.url())?.[1];
  expect(id, 'a trip id should be in the URL').toBeTruthy();
  return id!;
}

/**
 * Wait for the destination lookup to finish.
 *
 * There is no button to press: the flow resolves on arrival, because a screen
 * whose only possible action is "yes, do the thing I already asked for" is a
 * click that exists because the code needed one.
 */
export async function waitForLookup(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { level: 1 })).not.toContainText('Looking up', {
    timeout: 20_000,
  });
}

/** Check the first radio of every group on screen, whatever the groups are. */
export async function answerEveryQuestion(page: Page): Promise<void> {
  const radios = page.locator('input[type=radio]');
  const groups = new Set<string>();
  const count = await radios.count();
  for (let index = 0; index < count; index += 1) {
    const name = await radios.nth(index).getAttribute('name');
    if (name && !groups.has(name)) {
      groups.add(name);
      await radios.nth(index).check();
    }
  }
}

/**
 * Walk whichever steps this destination produced, until the scope screen.
 *
 * A loop rather than a fixed sequence, because the whole design derives the step
 * from stored state: a country gets a strategy question, a city does not, and a
 * destination with no clarifications goes straight through. Polling for "which
 * screen am I on now" is also what makes this immune to the race the previous
 * version had — it checked for the *next* screen before the transition it had
 * just triggered had rendered, then waited twenty seconds for a heading that was
 * two steps away.
 */
export async function reachScope(page: Page): Promise<void> {
  await waitForLookup(page);

  /*
   * The loop tolerates a screen that has not finished computing — it polls, and
   * the preflight's "Reading the region" state simply produces another turn.
   * Twelve turns at 400 ms plus the per-action waits is comfortably more than
   * the preflight has ever needed, and running out is a real failure rather
   * than a timing one.
   */
  for (let step = 0; step < 12; step += 1) {
    const scope = page.getByRole('heading', { name: 'Here is what we are about to do' });
    if (await scope.isVisible().catch(() => false)) return;

    const research = page.getByRole('button', { name: /Go and research this/i });
    if (await research.isVisible().catch(() => false)) {
      await answerEveryQuestion(page);
      await research.click();
      await expect(research).toHaveCount(0, { timeout: 20_000 });
      continue;
    }

    const proceed = page.getByRole('button', { name: /^Continue$/ });
    if (await proceed.isVisible().catch(() => false)) {
      await answerEveryQuestion(page);
      await proceed.click();
      await expect(proceed).toHaveCount(0, { timeout: 20_000 });
      continue;
    }

    await page.waitForTimeout(400);
  }

  await expect(page.getByRole('heading', { name: 'Here is what we are about to do' })).toBeVisible({
    timeout: 20_000,
  });
}


/** Push all the way through to a compiled region. */
export async function compileRegion(page: Page): Promise<void> {
  await reachScope(page);
  await page.getByRole('button', { name: 'Build the region' }).click();
  await expect(page.getByRole('heading', { name: 'What this trip is built on' })).toBeVisible({
    timeout: 90_000,
  });
}

/**
 * THE WHOLE QUESTIONNAIRE, ONCE, IN ONE PLACE.
 *
 * Lifted out of `discovery.spec.ts` because a second copy had already appeared —
 * a hand-rolled loop that pressed "Continue" a fixed number of times and gave up
 * silently at step 3 of 9, then spent thirty seconds waiting for a URL nothing
 * was going to navigate to. The stall was reported as a routing failure, which
 * is exactly the class of misleading timeout this suite has just finished
 * removing.
 *
 * Step by step rather than a loop, and deliberately: the questionnaire refuses
 * to continue from an empty profile, so "answer every unanswered group with its
 * first option" walks straight into a screen that will not advance. The steps
 * are asserted by heading, so a reordering fails on the name of the screen that
 * moved rather than on a count.
 */
export async function completeQuestionnaire(page: Page): Promise<void> {
  // Interests: the canonical hiking/lakes/viewpoints traveller.
  await page.getByRole('radio', { name: 'Hiking: A few times' }).check();
  await page.getByRole('radio', { name: 'Lakes & rivers: A few times' }).check();
  await page.getByRole('radio', { name: 'Scenic viewpoints: Core' }).check();
  await page.getByRole('radio', { name: 'Geology & geothermal: Once or twice' }).check();
  await page.getByRole('button', { name: 'Continue' }).click();

  // Rhythm
  await expect(page.getByRole('heading', { name: 'How should the days feel?' })).toBeVisible();
  await page.getByRole('radio', { name: /^Balanced/ }).check();
  await page.getByRole('button', { name: 'Continue' }).click();

  // Budget
  await page.getByRole('radio', { name: /^Mid-range/ }).check();
  await page.getByRole('button', { name: 'Continue' }).click();

  // Food
  await expect(page.getByRole('heading', { name: 'How do you want to eat?' })).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();

  // Discovery
  await page.getByRole('radio', { name: /^A real mix/ }).check();
  await page.getByRole('radio', { name: /Crowds ruin it/ }).check();
  await page.getByRole('button', { name: 'Continue' }).click();

  // Transport
  await expect(page.getByRole('heading', { name: 'How are you getting around?' })).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();

  // Region
  await page.getByRole('radio', { name: /Within ~1 hour/ }).check();
  await page.getByRole('button', { name: 'Continue' }).click();

  // Constraints
  await page.getByRole('button', { name: 'Continue' }).click();

  // Review
  await expect(page.getByRole('heading', { name: 'Your trip personality' })).toBeVisible();
}
