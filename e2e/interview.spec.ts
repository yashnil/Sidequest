import { mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { openHubView, openPrepareNotes } from './support/hub';
import { completeQuestionnaire, createTrip, currentInterviewQuestion, reachScope, waitUntilInteractive } from './support/trip';

/**
 * THE ADAPTIVE INTERVIEW, ACROSS DESTINATION SHAPES, IN A REAL BROWSER.
 *
 * Five shapes the fixture stack can reach from a typed name: a seeded
 * mountain region, a dense transit city, a broad country, an island group
 * with a remote road region, and a protected river basin. For each, the
 * spec records which questions appeared and asserts that the modules the
 * shape justifies are present and the ones it does not are absent — a city
 * is never asked about graded dirt roads, a mountain region is never asked
 * about the metro, a wilderness is asked about guides and unverified
 * transfers. Screenshots land under `test-results/interview/` for review.
 *
 * Every trip runs on fixtures: the composer, compiler, weather and imagery
 * providers are all pinned offline by the Playwright server command.
 */

const SHOT_DIR = 'test-results/interview';
const DATES = { start: '2026-08-12', end: '2026-08-17' };

async function shot(page: Page, name: string, project: string) {
  mkdirSync(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: `${SHOT_DIR}/${name}-${project}.png`, fullPage: true });
}

/** A dynamic destination: through resolution, preflight and scope, then to the interview. */
async function reachInterview(page: Page, destination: string): Promise<string> {
  const id = await createTrip(page, destination, DATES);
  if (/\/plan/.test(page.url())) {
    await reachScope(page);
    await page.goto(`/trips/${id}/questionnaire`);
  }
  await expect(page.getByTestId('interview')).toBeVisible({ timeout: 20_000 });
  return id;
}

interface ShapeCase {
  name: string;
  destination: string;
  /** Interest labels the priorities screen must offer. */
  offers: string[];
  present: string[];
  absent: string[];
  answers?: Record<string, string>;
}

const SHAPES: ShapeCase[] = [
  {
    name: 'mountain-region',
    destination: 'Mammoth Lakes',
    offers: ['Hiking', 'Scenic viewpoints'],
    present: ['priorities', 'transport_mode', 'daily_driving', 'scenic_reach', 'hard_constraints'],
    absent: ['walking_tolerance', 'transit_comfort', 'day_trips', 'coverage_strategy', 'boats_ferries', 'guide_willingness'],
    answers: { transport_mode: 'rent_car' },
  },
  {
    name: 'dense-city',
    destination: 'Harbour City',
    offers: ['Neighbourhoods & local life', 'Food & local eating'],
    // Transport was settled on the research flow's clarification, so the interview never asks it again.
    present: ['priorities', 'walking_tolerance', 'day_trips', 'hard_constraints'],
    // Boats are not in this list on purpose: the harbour's scope allows ferries, so asking is justified.
    absent: ['road_comfort', 'daily_driving', 'scenic_reach', 'guide_willingness', 'coverage_strategy'],
    answers: { transport_mode: 'transit_walk' },
  },
  {
    name: 'broad-country',
    destination: 'Wide Republic',
    offers: ['History & culture'],
    present: ['priorities', 'coverage_strategy', 'base_moves', 'hard_constraints'],
    absent: ['walking_tolerance', 'transit_comfort', 'day_trips', 'scenic_reach'],
    answers: { transport_mode: 'rent_car' },
  },
  {
    name: 'wilderness-basin',
    destination: 'River Basin Reserve',
    offers: ['Wildlife'],
    present: ['priorities', 'guide_willingness', 'remote_comfort', 'hard_constraints'],
    absent: ['walking_tolerance', 'transit_comfort', 'day_trips'],
    answers: { transport_mode: 'guided' },
  },
];

for (const shape of SHAPES) {
  test(`${shape.name}: only the relevant modules are asked, and the review distinguishes answers from assumptions`, async ({ page }, testInfo) => {
    await reachInterview(page, shape.destination);
    await shot(page, `${shape.name}-01-understanding`, testInfo.project.name);
    await expect(page.getByTestId('interview-assumption')).toBeVisible();

    const start = page.getByTestId('interview-start');
    await waitUntilInteractive(start);
    await start.click();
    await expect(page.getByTestId('interview-question-priorities')).toBeVisible();
    for (const label of shape.offers) {
      await expect(page.getByRole('checkbox', { name: label, exact: true }), `${shape.destination} should offer ${label}`).toBeVisible();
    }
    await shot(page, `${shape.name}-02-priorities`, testInfo.project.name);

    const seen = await completeQuestionnaire(page, { priorities: shape.offers, answers: shape.answers ?? {} });
    for (const id of shape.present) expect(seen, `${shape.destination} should ask ${id}`).toContain(id);
    for (const id of shape.absent) expect(seen, `${shape.destination} must not ask ${id}`).not.toContain(id);
    // The normal experience stays short.
    expect(seen.length, `${shape.destination} asked ${seen.length} questions: ${seen.join(', ')}`).toBeLessThanOrEqual(16);
    expect(seen[seen.length - 1]).toBe('hard_constraints');

    await shot(page, `${shape.name}-03-review`, testInfo.project.name);
    await expect(page.getByTestId('review-told')).toBeVisible();
    await expect(page.getByTestId('review-assumed')).toBeVisible();
    await expect(page.getByTestId('review-hard')).toBeVisible();
    await expect(page.getByTestId('interview-sentence')).toBeVisible();
    // Transport is on the review whether it was asked here or carried from the research flow.
    await expect(page.getByTestId('review-change-transport_mode')).toBeVisible();
    // Decided questions carry their reason on the review.
    await expect(page.getByTestId('review-assumed').getByText(/assumed|from the destination/).first()).toBeVisible();
  });
}

test('Decide for me chooses a destination-aware default and says why', async ({ page }, testInfo) => {
  await reachInterview(page, 'Mammoth Lakes');
  const start = page.getByTestId('interview-start');
  await waitUntilInteractive(start);
  await start.click();
  await page.getByRole('checkbox', { name: 'Hiking', exact: true }).check();
  await page.getByTestId('interview-continue').click();

  // Walk to the transport question, then hand it to Sidequest.
  for (let step = 0; step < 12; step += 1) {
    const id = await currentInterviewQuestion(page);
    if (id === 'transport_mode') break;
    await page.getByTestId('interview-decide').click();
    await page.waitForTimeout(150);
  }
  await expect(page.getByTestId('interview-question-transport_mode')).toBeVisible();
  await page.getByTestId('interview-decide').click();
  await expect(page.getByTestId('interview-question-transport_mode')).toBeHidden();
  // Back shows what was decided and the reason.
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(page.getByTestId('interview-question-transport_mode')).toBeVisible();
  const note = page.getByTestId('interview-decided-note');
  await expect(note).toBeVisible();
  await expect(note).toContainText(/hire car/);
  await shot(page, 'decide-for-me', testInfo.project.name);
});

test('Plan with smart defaults composes a trip straight from the understanding screen', async ({ page }, testInfo) => {
  await reachInterview(page, 'Mammoth Lakes');
  const defaults = page.getByTestId('interview-smart-defaults');
  await waitUntilInteractive(defaults);
  await defaults.click();
  await expect(page).toHaveURL(/\/itinerary$/, { timeout: 90_000 });
  await expect(page.getByTestId('route-overview')).toBeVisible();
  await expect(page.getByTestId('trip-snapshot')).toBeVisible();
  await openHubView(page, 'prepare');
  await openPrepareNotes(page);
  await expect(page.getByTestId('prepare')).toBeVisible();
  await expect(page.getByText(/^Nothing scheduled, and this is not an arrival or departure day/)).toHaveCount(0);
  // The DEV-only fixture badge is deliberately absent here: this suite drives a production build.
  await expect(page.getByTestId('fixture-planning-badge')).toHaveCount(0);
  await shot(page, 'smart-defaults-itinerary', testInfo.project.name);
});

test('the itinerary carries the overview map, day maps with honest legs, compact warnings and the preparation hub', async ({ page }, testInfo) => {
  await reachInterview(page, 'Mammoth Lakes');
  await completeQuestionnaire(page);
  await page.getByTestId('interview-build-trip').click();
  await expect(page).toHaveURL(/\/itinerary$/, { timeout: 90_000 });
  // PRODUCTION UI V1 — the overview carries the trip map; Days carries the day maps (a sticky
  // focus map beside the days on desktop, one map per day card below lg).
  const overviewMap = page.locator('#hub-view-overview').getByTestId('trip-overview-map');
  await expect(overviewMap).toBeVisible();
  // No straight line is ever labelled a route.
  await expect(overviewMap).toContainText(/not routes/);
  await openHubView(page, 'days');
  const desktop = (page.viewportSize()?.width ?? 1440) >= 1024;
  const dayMaps = desktop ? page.getByTestId('day-focus-map') : page.getByTestId('day-map');
  await expect(dayMaps.first()).toBeVisible();
  // Recurring uncertainty is a chip on the stop, not a paragraph per day: a day's warning box
  // carries only what is specific to that day, never the repeated verification caveat.
  const warnings = page.locator('[data-testid^="day-warnings-"]');
  if ((await warnings.count()) > 0) {
    await expect(warnings.first()).toBeVisible();
    await expect(warnings.first()).not.toContainText(/could not be independently confirmed/);
  }
  // Pressing a day-map stop focuses its timeline row.
  const pin = dayMaps.first().getByRole('button').first();
  await pin.click();
  await expect(pin).toHaveAttribute('aria-pressed', 'true');
  await openHubView(page, 'plan');
  await expect(page.getByTestId('where-to-stay').first()).toBeVisible();
  await openHubView(page, 'prepare');
  await openPrepareNotes(page);
  for (const id of ['prepare', 'before-you-go', 'packing-list']) {
    await expect(page.getByTestId(id).first(), id).toBeVisible();
  }
  await shot(page, 'itinerary', testInfo.project.name);
});
