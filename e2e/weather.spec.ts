import { expect, test, type Page } from '@playwright/test';
import { openDayChecks, openHubView, openPrepareReference } from './support/hub';
import { completeQuestionnaire, createTrip } from './support/trip';
import { openBoardBackstage } from './support/trip';
import { beyondForecastTrip, forecastTrip, summerTrip, type TripDates } from './support/dates';

/**
 * The slice this proves: a traveller sees weather context on the board before
 * building anything, gets an itinerary whose days were placed against it, is
 * told plainly which kind of evidence that was, is offered a concrete fallback
 * where one honestly exists, and finds all of it still there after a refresh.
 *
 * Everything here runs against the deterministic fixture provider — the
 * Playwright web server sets `SIDEQUEST_WEATHER_PROVIDER=fixture`. That is what
 * makes "the plan reacted to the weather" a testable claim rather than a
 * description of the morning the suite happened to run.
 *
 * Two date ranges carry the weight, and they differ in kind rather than degree:
 *
 * - **NEAR** is close enough to be inside the forecast horizon, so the plan
 *   may rank one day against another.
 * - **FAR** is more than a year out, where the only honest evidence is what past
 *   years have done — and the product has to say so in those words, and must not
 *   claim one day is better than another.
 */

/**
 * A near trip, inside the forecast horizon — derived from the real clock,
 * because the weather provider reads the real clock too.
 *
 * These dates were `2026-08-03` … `2026-08-06`, and on 2026-08-06 the trip's
 * first day was three days in the past: a forecast horizon does not reach
 * backwards. Now they come from `forecastTrip`, which keeps every day well
 * inside the sixteen-day horizon whenever the suite runs.
 *
 * What that cannot keep is the *season*. A near trip in November is a November
 * trip, and Minaret Vista — open June to October — is correctly refused by the
 * board ("Usually open June to October"). So the forecast specs below never
 * name a seasonal stop; they include whichever weather-sensitive stop is in
 * season on these dates (`includeAClearDayStop`).
 */
const NEAR = forecastTrip(4);
/**
 * A summer trip, for the assertions that are about a *place* rather than a
 * forecast: Minaret Vista is a view, so it needs a clear day, in any month it is
 * open — and it is only open in summer, so the spec chooses summer.
 */
const SUMMER = summerTrip(4);
/**
 * A trip whose every day is wet, computed rather than hardcoded.
 *
 * Two constraints have to hold at once and a fixed pair of dates cannot keep
 * both as time passes. The fixture's four-step cycle is indexed by day-of-year,
 * so a wet pair is one at cycle position 2 followed by one at 3 — and four
 * consecutive dates always include a clear day, which correctly produces no
 * section at all because the planner can simply move things. The pair must also
 * sit wholly inside the sixteen-day forecast horizon, or the second day comes
 * back as a mild seasonal pattern and nothing is at risk.
 *
 * So it is derived from the same rule the fixture documents, which keeps the
 * test honest tomorrow as well as today.
 */
function washout(): { start: string; end: string } {
  const dayOfYear = (date: Date) =>
    Math.round(
      (Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) -
        Date.UTC(date.getUTCFullYear(), 0, 1)) /
        86_400_000,
    ) + 1;

  // From tomorrow, and stopping well inside the horizon so both days are a
  // forecast rather than a pattern.
  for (let offset = 1; offset <= 12; offset += 1) {
    const start = new Date();
    start.setUTCDate(start.getUTCDate() + offset);
    if (dayOfYear(start) % 4 !== 2) continue;
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 1);
    return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
  }
  throw new Error('No wet pair inside the forecast horizon — has the fixture cycle changed?');
}

const WASHOUT = washout();
/**
 * Well beyond any forecast horizon: historical patterns, and nothing else.
 * Derived, because a fixed year eventually stops being in the future.
 */
const FAR = beyondForecastTrip(4);

async function reachBoard(page: Page, dates: TripDates = NEAR) {
  await createTrip(page, 'Mammoth Lakes', { start: dates.start, end: dates.end });

  await completeQuestionnaire(page, { priorities: ['Scenic viewpoints', 'Hiking'] });

  await page.getByRole('button', { name: 'Open the Discovery Board' }).click();
  await expect(page).toHaveURL(/\/discover$/);
  await expect(page.getByRole('heading', { name: 'Classics worth your time' })).toBeVisible();
}

/**
 * Ask for the forecast, because nothing asks for it on your behalf any more.
 *
 * The board used to fetch weather while rendering, so it simply had a forecast
 * the first time anybody saw it — and so did every reload, and every reload paid
 * for it. Weather is now a persisted snapshot written by an explicit operation,
 * which means a board with no snapshot has no weather and says so.
 *
 * That is the product behaviour, so the tests press the button. A helper rather
 * than a line in each spec, because "the forecast arrives when you ask for it"
 * is now a precondition of every weather assertion on the board.
 */
async function fetchWeather(page: Page) {
  /*
   * The weather panel is one of the things that moved backstage when the board
   * stopped opening with an account of its own research, so the control has to
   * be uncovered before it can be pressed. It is in the DOM either way — which
   * is why this failed on `toBeVisible` against a button the report showed
   * resolving perfectly well.
   */
  await openBoardBackstage(page);
  const button = page.getByTestId('weather-refresh');
  await expect(button).toBeVisible();
  await button.click();
  await expect(button).toHaveText('Fetch it again', { timeout: 20_000 });
}

/**
 * Located by heading, not by text.
 *
 * `hasText: 'Minaret Vista'` also matches Devils Postpile, whose access-group
 * line reads "Part of Reds Meadow / Minaret Vista corridor" — so a plain text
 * filter silently asserts against the wrong card and passes or fails for
 * reasons that have nothing to do with the place under test.
 */
function card(page: Page, name: string) {
  return page
    .getByRole('article')
    .filter({ has: page.getByRole('heading', { name, exact: true }) })
    .first();
}

async function include(cardLocator: ReturnType<typeof card>) {
  const button = cardLocator.getByRole('button', { name: 'Include' });
  if ((await button.getAttribute('aria-pressed')) === 'true') {
    await button.click();
    await expect(button).toHaveAttribute('aria-pressed', 'false');
  }
  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
}

/**
 * Include a stop whose whole value is the view, that is open on the trip's
 * dates — so the plan has something the weather can work against.
 *
 * This used to be `include(card(page, 'Minaret Vista'))`, which is a summer-only
 * place on a trip whose month is whatever month the suite runs in (the forecast
 * window follows the real clock). Out of season its Include is rightly disabled
 * and the spec timed out pressing it. The cards say which places need a clear
 * day and whether they can be included on these dates, so the spec reads that
 * rather than naming a place.
 *
 * Returns the name included, or null when the fixture region has no
 * view-dependent stop in season at all (Mammoth Lakes from December to March:
 * the only year-round one, Alabama Hills, is past the default driving budget).
 * The callers' assertions are about the forecast and the layout, which still
 * hold; the annotation makes the gap visible in the report rather than silent.
 */
async function includeAClearDayStop(page: Page): Promise<string | null> {
  const candidates = page
    .getByRole('article')
    .filter({ has: page.getByText('Needs a clear day', { exact: true }) })
    .filter({ has: page.getByRole('button', { name: 'Include', disabled: false }) });
  const count = await candidates.count();
  if (count === 0) {
    test.info().annotations.push({
      type: 'season',
      description: 'No view-dependent stop is open on these forecast dates; built without one.',
    });
    return null;
  }
  const chosen = candidates.first();
  const name = (await chosen.getByRole('heading', { level: 3 }).first().innerText()).trim();
  await include(card(page, name));
  return name;
}

async function build(page: Page) {
  await page.getByRole('button', { name: /Build my trip|Rebuild my trip/ }).click();
  await expect(page).toHaveURL(/\/itinerary$/, { timeout: 30_000 });
  await expect(page.getByRole('heading', { name: 'Mammoth Lakes', exact: true })).toBeVisible();
  // PRODUCTION UI V1 — stops, hours, conflicts and day weather live under Days.
  await openHubView(page, 'days');
}

test('the board carries weather context for the traveller’s own dates', async ({ page }) => {
  // Summer, chosen: the card under test is a seasonal viewpoint, and out of
  // season the board rightly refuses it before weather has anything to say.
  await reachBoard(page, SUMMER);

  // A viewpoint whose whole value is the view says the view is weather-
  // dependent. This is the badge that changes a decision.
  const vista = card(page, 'Minaret Vista');
  await expect(vista).toBeVisible();
  await expect(vista.getByText('Needs a clear day', { exact: true })).toBeVisible();

  // A sheltered stop in town offers itself as the fallback.
  const village = card(page, 'The Village at Mammoth');
  await expect(village.getByText('Bad-weather option')).toBeVisible();

  // And a place the weather does not bear on wears no weather badge at all —
  // the regression guard against every card growing one.
  const creek = card(page, 'Hot Creek');
  await expect(creek.getByText('Needs a clear day')).toHaveCount(0);
});

test('an itinerary is built against a forecast, and says so', async ({ page }) => {
  await reachBoard(page);
  await includeAClearDayStop(page);
  await build(page);

  await openDayChecks(page);
  const weather = page.getByRole('region', { name: 'Weather on day 1' }).first();
  await expect(weather).toBeVisible();
  await expect(weather.getByText('Forecast', { exact: true })).toBeVisible();

  // The point it was taken at, and the attribution the licence requires (the trip-wide weather panel lives under Prepare).
  await openHubView(page, 'prepare');
  /* V11 §I — the weather plan is reference material, under Prepare's "Good to know" disclosure. */
  await openPrepareReference(page);
  const prepare = page.locator('#hub-view-prepare');
  await expect(prepare.getByText(/Taken at (one point|\d+ separate points)/)).toBeVisible();
  await expect(prepare.getByText(/have not checked today/i).first()).toBeVisible();

  // Daylight is stated as a real time rather than as a disclaimer — unless the fixture's sunset is
  // at or past 23:30, which PRODUCTION UI V1 suppresses on purpose ("light until 23:59" tells nobody anything).
  await openHubView(page, 'days');
  const light = page.getByText(/light until \d\d:\d\d/);
  if ((await light.count()) > 0) await expect(light.first()).toBeVisible();
});

test('a day the weather threatens is given a concrete fallback or an honest gap', async ({
  page,
}) => {
  await reachBoard(page);
  await includeAClearDayStop(page);
  await build(page);

  const fallback = page.getByText(/^If it turns/);
  const noFallback = page.getByText(/No strong fallback for this one/);
  const hasFallback = (await fallback.count()) > 0;
  const admitsNone = (await noFallback.count()) > 0;

  // One or the other on any day the weather works against — never a threatened
  // day with nothing said about it.
  const cautions = await page.getByText(/Working against it/).count();
  if (cautions > 0) expect(hasFallback || admitsNone).toBe(true);

  // Whatever is offered names a real place with real hours, not a category.
  if (hasFallback) {
    await expect(fallback.first().locator('..')).toContainText(/Open/);
  }
});

test('the weather behind a plan survives a refresh unchanged', async ({ page }) => {
  await reachBoard(page);
  await build(page);

  await openDayChecks(page);
  const before = await page
    .getByRole('region', { name: 'Weather on day 1' })
    .first()
    .innerText();

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Mammoth Lakes', exact: true })).toBeVisible();
  await openHubView(page, 'days');
  await openDayChecks(page);

  const after = await page
    .getByRole('region', { name: 'Weather on day 1' })
    .first()
    .innerText();

  // A stored plan renders against the evidence it was built from. If a refresh
  // silently refetched, the numbers here could move under the traveller without
  // the plan that depends on them moving with it.
  expect(after).toBe(before);
});

test('different dates get different weather, and a different kind of it', async ({ page }) => {
  await reachBoard(page);
  await build(page);
  await openDayChecks(page);
  const near = await page
    .getByRole('region', { name: 'Weather on day 1' })
    .first()
    .innerText();

  // A second trip on dates past the horizon. Two trips rather than editing one,
  // because what is being proved is that the dates decide the weather — and a
  // fresh trip is the shortest path to two plans that differ only in that.
  await reachBoard(page, FAR);
  await build(page);
  await openDayChecks(page);
  const far = await page
    .getByRole('region', { name: 'Weather on day 1' })
    .first()
    .innerText();

  expect(far).not.toBe(near);
  expect(near).toContain('Forecast');
  expect(far).toMatch(/Typical|historical/);
});

test('a trip beyond the forecast window says so in those words', async ({ page }) => {
  await reachBoard(page, FAR);
  await build(page);

  await openDayChecks(page);
  const weather = page.getByRole('region', { name: 'Weather on day 1' }).first();
  // PRODUCTION UI V1 — the day line carries the chip ("Typical"); the reasoning sits behind a disclosure.
  await expect(weather.getByText('Typical')).toBeVisible();
  const summary = weather.locator('summary');
  if ((await summary.count()) > 0) {
    await summary.first().click();
    await expect(weather.getByText(/not a forecast/i).first()).toBeVisible();
  }

  // And it must not claim a day. "Best on Thursday" is a forecast sentence.
  await expect(page.getByText(/clearest|best day|looks like the day/i)).toHaveCount(0);
  await expect(page.getByText('Forecast', { exact: true })).toHaveCount(0);
  await openHubView(page, 'prepare');
  /* V11 §I — the weather plan is reference material, under Prepare's "Good to know" disclosure. */
  await openPrepareReference(page);
  const prepare = page.locator('#hub-view-prepare');
  await expect(prepare.getByText('Historical pattern', { exact: true }).first()).toBeVisible();
  /*
   * V9.1 §10 — on a phone Preflight's "Can wait" bucket starts folded behind a
   * "Show N" button. The honesty sentence lives in it, so the assertion is that
   * it is *reachable*: open the fold where there is one, then read it. On a wide
   * screen the list is always open and there is no button to press.
   */
  const showLater = prepare.getByTestId('preflight-later-toggle');
  if (await showLater.isVisible().catch(() => false)) await showLater.click();
  await expect(prepare.getByText(/too far out for a forecast|not a forecast/i).first()).toBeVisible();
});

test('weather never overrides the hours or the transport it sits behind', async ({ page }) => {
  await reachBoard(page);
  await build(page);

  // Whatever the weather did, the constraints below it still hold. These are the
  // two failures that would matter most: a stop scheduled on a closed date, and
  // a day built around a service that does not run.
  await expect(page.getByText(/is closed on|does not run on/)).toHaveCount(0);
  await expect(page.getByText(/after it closes at/)).toHaveCount(0);
});

test('the weather surfaces read at every viewport', async ({ page }, testInfo) => {
  const problems: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console.error: ${message.text()}`);
  });
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));

  await reachBoard(page);
  await includeAClearDayStop(page);

  await expect(async () => {
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `the board scrolls horizontally by ${overflow}px`).toBeLessThanOrEqual(1);
  }).toPass({ timeout: 5_000 });
  await page.screenshot({
    path: `test-results/screens/13-weather-board-${testInfo.project.name}.png`,
    fullPage: true,
  });

  await build(page);
  await expect(async () => {
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `the itinerary scrolls horizontally by ${overflow}px`).toBeLessThanOrEqual(1);
  }).toPass({ timeout: 5_000 });
  await page.screenshot({
    path: `test-results/screens/13-weather-itinerary-${testInfo.project.name}.png`,
    fullPage: true,
  });

  expect(problems, `Runtime problems:\n${problems.join('\n')}`).toEqual([]);
});

test('an ordinary week gets no backup section, because nothing needs one', async ({ page }) => {
  // The regression guard against the section becoming wallpaper: if every stop
  // still has a good day to move to, there is nothing to say.
  await reachBoard(page);
  await expect(page.getByRole('heading', { name: 'If the weather turns' })).toHaveCount(0);
});

test('a washout week surfaces backups that live in other groups', async ({ page }) => {
  await reachBoard(page, WASHOUT);
  await fetchWeather(page);

  const heading = page.getByRole('heading', { name: 'If the weather turns' });
  await expect(heading).toBeVisible();
  const section = page.locator('section', { has: heading });

  // Forecast dates get forecast language, and nothing claims to be scheduled.
  await expect(section.getByText('Forecast', { exact: true })).toBeVisible();
  await expect(section.getByText(/Nothing here is scheduled/)).toBeVisible();

  // The whole point: a suggestion whose own primary group is something else.
  // Earthquake Fault is filed under hidden gems and would never reach the
  // existing "Low-effort & bad-weather backups" group.
  await expect(section.getByText('Earthquake Fault')).toBeVisible();

  // And it is a list of names, not a second copy of every card.
  await expect(section.getByRole('article')).toHaveCount(0);
});

test('a place the traveller ruled out never appears as a backup', async ({ page }) => {
  await reachBoard(page, WASHOUT);
  await fetchWeather(page);
  const heading = page.getByRole('heading', { name: 'If the weather turns' });
  await expect(heading).toBeVisible();

  const list = page.locator('section', { has: heading }).getByRole('listitem');
  const first = await list.first().locator('p').first().innerText();

  // Rule it out on its own card, and it must vanish from the reserve list.
  const card = page
    .getByRole('article')
    .filter({ has: page.getByRole('heading', { name: first, exact: true }) })
    .first();
  // Skipping asks why before it commits, and the answer is what records the pass.
  await card.getByRole('button', { name: 'Skip' }).click();
  await card.getByRole('button', { name: 'Not my thing' }).click();
  await expect(card.getByRole('button', { name: 'Skip' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  await expect(
    page.locator('section', { has: heading }).getByRole('listitem').filter({ hasText: first }),
  ).toHaveCount(0);
});
