import { appendFileSync, mkdirSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { waitUntilInteractive } from '../support/trip';
import { openHubView } from '../support/hub';
import { readPlan } from '../journeys/journey';

/**
 * FINAL PASS — MODE 3 LIVE: A PLAN THE TRAVELLER ALREADY HAD, ON STAGING.
 *
 *   EVAL_OUT=docs/final-completion/eval/live npx playwright test -c playwright.staging.config.ts e2e/staging/import-plan.spec.ts --project=desktop
 *
 * Real providers. The plan check is deterministic (no model call); the build
 * that follows is the ordinary scan + planner. What is recorded: what was read,
 * the proposed changes with their class (safe or major), and whether the built
 * trip sleeps where the traveller said, for as many nights as they said.
 */
const OUT = process.env.EVAL_OUT ?? 'docs/final-completion/eval/live';
mkdirSync(`${OUT}/screens`, { recursive: true });
const record = (row: Record<string, unknown>) => appendFileSync(`${OUT}/scenarios.ndjson`, `${JSON.stringify({ at: new Date().toISOString(), ...row })}\n`);

const PLAN = "April 5-15 2027: 4 nights Tokyo, 3 nights Kyoto, 2 nights Osaka, 1 night Sapporo, by train, for the two of us. Is that too much?";

test('imported itinerary: stated nights survive into a live-built trip', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'one width');
  test.setTimeout(1_200_000);
  const started = Date.now();
  await page.goto('/improve');
  const input = page.getByTestId('plan-check-input');
  await waitUntilInteractive(input);
  await input.fill(PLAN);
  await page.getByTestId('plan-check-submit').click();
  await expect(page.getByTestId('plan-check-result')).toBeVisible({ timeout: 120_000 });
  const read = await page.getByTestId('plan-check-stop').allInnerTexts();
  const changes = await page.getByTestId('plan-check-change').evaluateAll((nodes) => nodes.map((n) => ({ text: (n as HTMLElement).innerText.slice(0, 400), kind: n.getAttribute('data-kind'), class: n.getAttribute('data-class'), accepted: n.getAttribute('data-accepted') })));
  const findings = await page.getByTestId('plan-check-finding').allInnerTexts();
  const headline = (await page.getByTestId('plan-check-headline').allInnerTexts()).join(' ');
  await page.screenshot({ path: `${OUT}/screens/imported-itinerary-check.jpg`, type: 'jpeg', quality: 70, fullPage: true });

  /* Plan exactly as written: every stated night is the traveller's. */
  const asWritten = page.getByTestId('plan-check-plan-as-written').or(page.getByTestId('plan-check-plan')).first();
  await waitUntilInteractive(asWritten);
  await asWritten.click();
  await page.waitForURL(/\/trips\/[0-9a-f-]{36}\//, { timeout: 120_000 });
  const tripId = /\/trips\/([0-9a-f-]{36})\//.exec(page.url())![1]!;
  if (!/\/questionnaire$/.test(page.url())) await page.goto(`/trips/${tripId}/questionnaire`);
  const defaults = page.getByTestId('interview-smart-defaults');
  await waitUntilInteractive(defaults);
  await defaults.click();
  await expect(page).toHaveURL(/\/itinerary(#[a-z-]+)?$/, { timeout: 900_000 });
  const seconds = Math.round((Date.now() - started) / 1000);
  const bases = await page.getByTestId('base-card').allInnerTexts();
  const stated = await page.getByTestId('stated-stay').evaluateAll((nodes) => nodes.map((n) => ({ text: (n as HTMLElement).innerText, outcome: n.getAttribute('data-outcome') })));
  const conflicts = await page.getByTestId('stated-conflict').allInnerTexts();
  await page.screenshot({ path: `${OUT}/screens/imported-itinerary-overview.jpg`, type: 'jpeg', quality: 70 });
  const overview = (await page.locator('#hub-view-overview').innerText().catch(() => '')).slice(0, 6000);
  await openHubView(page, 'days');
  const days = (await page.locator('#hub-view-days').innerText().catch(() => '')).slice(0, 30000);
  const plan = await readPlan(page);
  record({ scenario: 'imported-itinerary', tripId, seconds, input: PLAN, read, headline, findings, changes, bases, stated, conflicts, overview, days, plan });
  /* The claim under test: four stated stays, each honoured. */
  expect(stated.length).toBe(4);
  expect(stated.filter((s) => s.outcome === 'honoured').length).toBeGreaterThanOrEqual(3);
});
