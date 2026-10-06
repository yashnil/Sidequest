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
 * The one Continue on screen.
 *
 * MVP V3 — the setup flow renders a desktop action bar and a phone action bar,
 * and exactly one of them is visible at a viewport. Both carry the same test id
 * because they are the same action; the visibility filter is what picks the one
 * a person could press.
 */
function continueButton(page: Page): Locator {
  return page.getByTestId('setup-continue').locator('visible=true').first();
}

/**
 * Walk the one-question setup and land on the interview.
 *
 * MVP V3 — this used to fill a single form: a destination field, two dates, and
 * Continue. Setup is five screens now (where · when · nights · who · anything
 * fixed), each a real history entry, so the helper walks them.
 *
 * It types the destination rather than picking a suggestion, because the
 * end-to-end environment deliberately has no destination index: these tests
 * exercise the *free-text* path, which is the one that has to keep working for
 * everything the index does not hold — and which is now the canonical one.
 */
export interface CreateTripOptions {
  /** Free text for "Booked, fixed, or would regret missing". */
  mustDo?: string;
  /** Free text for "Anything you would rather not do". */
  avoid?: string;
  /** Pick the first suggestion under the field rather than keeping the typed text. */
  pickSuggestion?: boolean | RegExp;
  /** `?have=plan` — the homepage's third door. */
  havePlan?: boolean;
  /** The plan itself, one day per line (only on the `havePlan` door). */
  existingPlan?: string;
  /** Which party shape to pick. Defaults to the couple every existing spec assumes. */
  party?: 'solo' | 'couple' | 'friends' | 'family' | 'other';
}

export async function createTrip(
  page: Page,
  destination: string,
  dates: { start: string; end: string } = DEFAULT_DATES,
  options: CreateTripOptions = {},
): Promise<string> {
  await page.goto(options.havePlan ? '/trips/new?have=plan' : '/trips/new');
  const field = page.getByTestId('destination-input');
  await waitUntilInteractive(field);
  await field.fill(destination);
  if (options.pickSuggestion) {
    const suggestion =
      options.pickSuggestion instanceof RegExp
        ? page.getByTestId(/destination-suggestion-\d+/).filter({ hasText: options.pickSuggestion }).first()
        : page.getByTestId('destination-suggestion-0');
    await expect(suggestion, 'the index should offer a suggestion for this destination').toBeVisible({ timeout: 15_000 });
    await suggestion.click();
    await expect(page.getByTestId('destination-chosen')).toBeVisible();
  }
  await continueButton(page).click();

  // When: exact dates, which is the shape every existing spec assumes.
  await expect(page.getByTestId('timing-exact')).toBeVisible();
  await page.getByTestId('timing-exact').click();
  await page.getByTestId('timing-start').fill(dates.start);
  await page.getByTestId('timing-end').fill(dates.end);
  await continueButton(page).click();

  // Two exact dates answer "how many nights", so that screen is skipped.
  const party = options.party ?? 'couple';
  await expect(page.getByTestId(`party-${party}`)).toBeVisible();
  await page.getByTestId(`party-${party}`).click();
  await continueButton(page).click();

  // Anything already fixed: nothing, unless this spec is about something that is.
  await expect(page.getByTestId('setup-flow')).toHaveAttribute('data-step', 'fixed');
  if (options.existingPlan) await page.getByTestId('setup-existing-plan').fill(options.existingPlan);
  if (options.mustDo) await page.getByLabel(/Booked, fixed, or would regret missing/).fill(options.mustDo);
  if (options.avoid) await page.getByLabel(/Anything you would rather not do/).fill(options.avoid);
  await continueButton(page).click();

  await page.waitForURL(/\/trips\/[^/]+\/(plan|questionnaire)/, { timeout: 30_000 });
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
/**
 * V1 CONVERGENCE — THE RESEARCH PATH IS BEHIND A URL NOW.
 *
 * The normal flow offers the Discovery scan ("Find places for my trip"); the
 * old "Explore experiences first" link that starts the compile path under
 * `/plan` renders only when the questionnaire is opened with `?research=1`.
 * Specs that exercise the compile path open that door here, which is the
 * same press on the same control — only the way to reach it moved.
 */
export async function openResearchDoor(page: Page): Promise<void> {
  // Trip creation redirects; reading the URL before it lands made this a silent no-op.
  const url = new URL(page.url());
  if (!/\/questionnaire$/.test(url.pathname) || url.searchParams.get('research') === '1') return;
  url.searchParams.set('research', '1');
  await page.goto(url.toString());
}

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
    await openResearchDoor(page);
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
  /*
   * `/plan` hands a known destination on to the interview, and the research
   * door is on the questionnaire — so wait for that page here, once. Waiting
   * inside `openResearchDoor` stalled `reachScope`, which calls it on every turn
   * of its loop while it is legitimately on `/plan`.
   */
  await page.waitForURL(/\/trips\/[^/]+\/questionnaire/, { timeout: 30_000 }).catch(() => undefined);
  await openResearchDoor(page);
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
  /**
   * V12 §2 — THE ROLE MATRIX, WHICH THE RADIO BRANCH CANNOT ANSWER.
   *
   * `priority_roles` is one screen with a row per chosen interest and four roles
   * across (`once · couple · most_days · build_around`). It is not a single
   * radio group, so the walker's ordinary branch could not touch it and every
   * scenario fell through to "Decide this for me" — which takes the smart
   * default, first pick `most_days` and the rest `couple`.
   *
   * That silently made every walked trip the same shape at the exact point V12
   * is about: a scenario that says "build the trip around the trek" arrived as
   * "most days have a walk". Keyed by interest id, values from the four roles.
   */
  interestRoles?: Readonly<Record<string, string>>;
  /**
   * Fail loudly when a named answer is not among the options offered.
   *
   * Off by default, because most specs are indifferent to which option they get.
   * A live acceptance is not: an unoffered value falls through to "Sidequest
   * decides", and a run that costs a model call would then be measuring a
   * different scenario from the one it claims to. With this on, the walker says
   * which question, which value, and what was actually on offer.
   */
  strict?: boolean;
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
    if (id === 'priority_roles' && choices.interestRoles) {
      for (const [interest, role] of Object.entries(choices.interestRoles)) {
        const cell = screen.locator(`input[type=radio][name="priority_roles:${interest}"][value="${role}"]`);
        if ((await cell.count()) === 0) {
          if (choices.strict) throw new Error(`priority_roles has no row "${interest}" with role "${role}" — the interest may not have been chosen on the priorities screen.`);
          continue;
        }
        await cell.first().check();
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
      if (choices.strict) {
        const offered = await screen.locator('input[type=radio]').evaluateAll((nodes) => [...new Set(nodes.map((node) => (node as HTMLInputElement).value))]);
        throw new Error(`"${id}" was asked but does not offer "${wanted}". It offered: ${offered.join(', ') || '(no radio options)'}.`);
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
/**
 * Open the review's per-question ledger.
 *
 * MVP V3 — the review leads with a glance of six statements, and every
 * question's own row moved behind one disclosure. A spec that wants a specific
 * question's Change link opens the appendix first, exactly as a traveller does.
 */
export async function openReviewLedger(page: Page): Promise<void> {
  const ledger = page.getByTestId('review-ledger');
  await expect(ledger).toBeVisible({ timeout: 20_000 });
  if (await ledger.evaluate((element) => (element as HTMLDetailsElement).open)) return;
  await ledger.locator('summary').click();
  await expect(ledger).toHaveJSProperty('open', true);
}

export async function changeInterviewAnswer(page: Page, questionId: string, value: string, choices: InterviewChoices = {}): Promise<void> {
  await expect(page.getByTestId('interview-review')).toBeVisible({ timeout: 20_000 });
  await openReviewLedger(page);
  const change = page.getByTestId(`review-change-${questionId}`);
  await expect(change).toBeVisible();
  await change.click();
  await expect(page.getByTestId(`interview-question-${questionId}`)).toBeVisible({ timeout: 15_000 });
  await page.locator(`input[type=radio][value="${value}"]`).first().check();
  await advanceInterview(page, questionId);
  await completeQuestionnaire(page, choices);
}
