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
  await page.getByRole('button', { name: /^Continue$/ }).click();
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
  for (let step = 0; step < 16; step += 1) {
    const scope = page.getByRole('heading', { name: 'Here is what we are about to do' });
    if (await scope.isVisible().catch(() => false)) return;

    /*
     * A known destination lands on the interview; the research steps are an
     * explicit request from there. See `requestExploration`.
     */
    const explore = page.getByTestId('interview-explore');
    if (await explore.isVisible().catch(() => false)) {
      await waitUntilInteractive(explore);
      await explore.click();
      await page.waitForURL(/\/trips\/[^/]+\/plan/, { timeout: 20_000 });
      continue;
    }

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


/**
 * THE HEADING A FINISHED BUILD LANDS ON, NAMED ONCE.
 *
 * It was the literal string `'What this trip is built on'` in nine specs and two
 * helpers. That title was an accurate name for a build report and the wrong name
 * for the screen — what has happened, from the traveller's side, is that we went
 * and looked — so it became `We have been through <destination>`, and nine specs
 * spent sixty seconds each waiting for a heading that no longer exists.
 *
 * A prefix rather than the whole sentence, because the rest of it is the
 * destination and every spec uses a different synthetic world.
 */
export const REGION_READY_HEADING = /^We have been through /;

/**
 * Ask for the optional research from the interview's understanding screen.
 *
 * The plan page hands a known destination straight to the interview, so the
 * research steps (preflight, clarification, scope, build) are reached only by
 * pressing "Explore experiences first". That press saves nothing about the
 * traveller's preferences; the interview can still be answered afterwards.
 */
export async function requestExploration(page: Page): Promise<void> {
  await page.waitForURL(/\/trips\/[^/]+\/(plan|questionnaire)/, { timeout: 20_000 });
  const explore = page.getByTestId('interview-explore');
  await expect(explore).toBeVisible({ timeout: 20_000 });
  await waitUntilInteractive(explore);
  await explore.click();
  await page.waitForURL(/\/trips\/[^/]+\/plan/, { timeout: 20_000 });
}

/** Push all the way through to a compiled region. */
export async function compileRegion(page: Page): Promise<void> {
  // `reachScope` presses "Explore experiences first" itself when the interview is on screen.
  await reachScope(page);
  await page.getByRole('button', { name: 'Start exploring' }).click();
  await expect(page.getByRole('heading', { name: REGION_READY_HEADING })).toBeVisible({
    timeout: 90_000,
  });
}

/**
 * OPEN A DISCLOSURE, WITHOUT CLOSING ONE THAT IS ALREADY OPEN.
 *
 * Both of the product's big `<details>` panels — the plan page's build report and
 * the board's backstage — were introduced by this phase to get the engine's
 * account of itself out from in front of the places. Everything they hold is
 * still in the DOM, so `.textContent()` reads it either way; `toBeVisible()` does
 * not, which is the whole reason a dozen assertions had to learn to knock first.
 *
 * Idempotent on purpose. A helper that blindly clicks `summary` is a helper that
 * closes the panel for the second assertion in the same test, and the failure it
 * produces ("element is not visible") reads exactly like the regression it is
 * not.
 */
async function openDisclosure(page: Page, testId: string, summary: Locator): Promise<void> {
  const details = page.getByTestId(testId);
  await expect(details).toBeVisible();
  if (await details.evaluate((element) => (element as HTMLDetailsElement).open)) return;
  await summary.click();
  await expect(details).toHaveJSProperty('open', true);
}

/**
 * Reveal the plan page's build report: sources, coverage, work plan, licences.
 *
 * `:scope > summary`, not `summary`. The build report now *contains* four more
 * disclosures — the place-data release, how travel times were measured, what the
 * build reused, and the stage log — so a descendant search resolves to five
 * elements and Playwright refuses in strict mode. The failure it produced was
 * five specs reporting `strict mode violation` on a helper, which reads like a
 * broken locator rather than like the panel gaining children it was designed to
 * gain. A disclosure has exactly one summary of its own; this asks for that one.
 */
export async function openHowThisWasBuilt(page: Page): Promise<void> {
  const details = page.getByTestId('how-this-was-built');
  await openDisclosure(page, 'how-this-was-built', details.locator(':scope > summary'));
}

/** Reveal the board's backstage: readiness, what we searched, personality, weather. */
export async function openBoardBackstage(page: Page): Promise<void> {
  await openDisclosure(page, 'board-backstage', page.getByTestId('board-backstage-toggle'));
}

/**
 * THE WHOLE INTERVIEW, ONCE, IN ONE PLACE.
 *
 * The questionnaire is adaptive now: which screens appear, and in what order,
 * depends on the destination's screening and on earlier answers. So this is a
 * walker rather than a script — it reads the id of the question on screen and
 * answers it from `choices`, picking the priorities it was given, choosing a
 * named option where one is given, and handing everything else to Sidequest
 * with "Decide this for me". It stops at the review screen; callers press the
 * CTA they are testing.
 *
 * The defaults reproduce the canonical hiking/lakes/viewpoints traveller the
 * suite has always driven, on a car, within about an hour of base.
 */
export interface InterviewChoices {
  /** Interest labels to tick on the priorities screen. */
  priorities?: readonly string[];
  /** Option values by question id (`transport_mode: 'rent_car'`), applied when that question appears. */
  answers?: Readonly<Record<string, string>>;
  /** Question ids to answer with "No preference" rather than "Decide this for me". */
  noPreference?: readonly string[];
}

export const DEFAULT_INTERVIEW: Required<InterviewChoices> = {
  priorities: ['Hiking', 'Lakes & rivers', 'Scenic viewpoints'],
  answers: {
    'priority_role:hiking': 'couple',
    'priority_role:lakes_and_rivers': 'couple',
    'priority_role:scenic_viewpoints': 'most_days',
    transport_mode: 'rent_car',
    day_shape: 'two_three',
    effort: 'moderate',
    budget: 'midrange',
    iconic_crowds: 'go_at_odd_hours',
    food_tradeoff: 'convenient',
    famous_vs_hidden: 'balanced',
    day_start: 'normal',
    scenic_reach: 'nearby_60',
    daily_driving: '150',
    road_comfort: 'mountain',
    base_moves: 'move_if_it_saves_time',
    hike_appetite: 'half_day',
    altitude_comfort: 'fine',
    walking_tolerance: 'moderate',
    transit_comfort: 'best_value',
    day_trips: 'one_day_trip',
  },
  noPreference: [],
};

/** The question on screen, by id, or null on the understanding or review screens. */
export async function currentInterviewQuestion(page: Page): Promise<string | null> {
  const question = page.locator('[data-testid^="interview-question-"]');
  if ((await question.count()) === 0) return null;
  const id = await question.first().getAttribute('data-testid');
  return id ? id.replace('interview-question-', '') : null;
}

export async function completeQuestionnaire(page: Page, choices: InterviewChoices = {}): Promise<string[]> {
  const seen: string[] = [];
  const priorities = choices.priorities ?? DEFAULT_INTERVIEW.priorities;
  const answers = { ...DEFAULT_INTERVIEW.answers, ...(choices.answers ?? {}) };
  const noPreference = new Set(choices.noPreference ?? []);

  const interview = page.getByTestId('interview');
  await expect(interview).toBeVisible({ timeout: 20_000 });
  const start = page.getByTestId('interview-start');
  if (await start.isVisible().catch(() => false)) {
    await waitUntilInteractive(start);
    await start.click();
  }

  for (let step = 0; step < 40; step += 1) {
    if (await page.getByTestId('interview-review').isVisible().catch(() => false)) return seen;
    const id = await currentInterviewQuestion(page);
    if (!id) {
      await page.waitForTimeout(200);
      continue;
    }
    seen.push(id);
    const screen = page.getByTestId(`interview-question-${id}`);
    await waitUntilInteractive(page.getByTestId('interview-decide'));
    if (id === 'priorities') {
      for (const label of priorities) {
        let chip = screen.getByRole('checkbox', { name: label, exact: true });
        if ((await chip.count()) === 0) {
          const more = page.getByTestId('interview-more-interests');
          if (await more.isVisible().catch(() => false)) await more.click();
          chip = screen.getByRole('checkbox', { name: label, exact: true });
        }
        if ((await chip.count()) > 0 && !(await chip.first().isChecked())) await chip.first().check();
      }
      await advanceInterview(page, id);
      continue;
    }
    const wanted = answers[id];
    if (wanted !== undefined) {
      const radio = screen.locator(`input[type=radio][value="${wanted}"]`);
      if ((await radio.count()) > 0) {
        await radio.first().check();
        await advanceInterview(page, id);
        continue;
      }
    }
    if (noPreference.has(id)) {
      await page.getByTestId('interview-no-preference').click();
    } else {
      await page.getByTestId('interview-decide').click();
    }
    await expect(screen).toBeHidden({ timeout: 15_000 });
  }
  await expect(page.getByTestId('interview-review')).toBeVisible({ timeout: 20_000 });
  return seen;
}

/** From the review, press the board CTA and land on the Discovery Board. */
export async function buildBoardFromReview(page: Page): Promise<void> {
  await expect(page.getByTestId('interview-review')).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Open the Discovery Board' }).click();
  await expect(page).toHaveURL(/\/discover$/, { timeout: 30_000 });
}

/** The canonical cultural walker: viewpoints, history, easy walks. */
export const CULTURAL_INTERVIEW: InterviewChoices = {
  priorities: ['Scenic viewpoints', 'History & culture', 'Easy nature walks'],
  answers: { 'priority_role:scenic_viewpoints': 'most_days', 'priority_role:history_and_culture': 'couple', 'priority_role:easy_nature_walks': 'couple' },
};

/** Press Continue and wait for the question to leave the screen. */
async function advanceInterview(page: Page, id: string): Promise<void> {
  const screen = page.getByTestId(`interview-question-${id}`);
  await page.getByTestId('interview-continue').click();
  await expect(screen).toBeHidden({ timeout: 15_000 });
}

/**
 * From the review screen, jump to one question and answer it.
 *
 * The review lists every question with a Change control; this presses the one
 * for `questionId`, picks `value`, and walks the rest of the way back to the
 * review through whatever follows.
 */
export async function changeInterviewAnswer(page: Page, questionId: string, value: string, choices: InterviewChoices = {}): Promise<void> {
  await expect(page.getByTestId('interview-review')).toBeVisible({ timeout: 20_000 });
  const change = page.getByTestId(`review-change-${questionId}`);
  await expect(change).toBeVisible();
  await change.click();
  await expect(page.getByTestId(`interview-question-${questionId}`)).toBeVisible({ timeout: 15_000 });
  await page.locator(`input[type=radio][value="${value}"]`).first().check();
  await advanceInterview(page, questionId);
  await completeQuestionnaire(page, choices);
}
