import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { completeQuestionnaire, createTrip, waitUntilInteractive } from '../../../../e2e/support/trip';
import { adviseToShortlist } from '../../../../e2e/support/advisor';
import { summerTrip } from '../../../../e2e/support/dates';

/**
 * THE TWO JOURNEYS A MEASUREMENT NEEDS, WALKED ONCE AND TIMED.
 *
 * 1. Create a trip the normal way (setup → interview → Discovery scan → board →
 *    Build → itinerary) on fixture providers, timing each traveller-visible wait.
 * 2. Take "Help me choose" from a typed request to a stored shortlist.
 *
 * Writes the ids and the session cookie to `PERF_OUT` so Lighthouse and the
 * load test can open the pages this browser owns. Wall-clock times here include
 * the browser; the server's own stage timings are read from the database
 * afterwards (`db-timings.mjs`).
 */
const OUT = process.env.PERF_OUT ?? 'perf-seed.json';
const DESTINATION = process.env.PERF_DESTINATION ?? 'Harbour City';

const record: Record<string, unknown> = { destination: DESTINATION, at: new Date().toISOString() };

function save(): void {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(record, null, 2));
}

interface ActionCall {
  path: string;
  action: string;
  ms: number;
  status: number;
  requestBytes: number;
}

/**
 * Every server action the journey presses, with the time the browser waited
 * for it. The interview-step action is also kept whole (`stepReplay`) so the
 * server-timing and load scripts can replay exactly what a browser sends.
 */
function watchActions(page: Page, into: ActionCall[]): void {
  page.on('requestfinished', (request) => {
    if (request.method() !== 'POST') return;
    void (async () => {
      /* `headers()` is the provisional set and omits what a fetch added; `allHeaders()` has `next-action`. */
      const headers = await request.allHeaders();
      const action = headers['next-action'];
      if (!action) return;
      const response = await request.response();
      const timing = request.timing();
      const body = request.postData() ?? '';
      into.push({ path: new URL(request.url()).pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/, ':id'), action: action.slice(0, 12), ms: Math.round(timing.responseEnd - timing.requestStart), status: response?.status() ?? 0, requestBytes: body.length });
      const text = await response?.text().catch(() => '');
      if (text && text.includes('"stopReason"') && text.includes('"leaders"') && !record.stepReplay) {
        record.stepReplay = {
          path: new URL(request.url()).pathname,
          headers: Object.fromEntries(['next-action', 'next-router-state-tree', 'content-type', 'accept'].filter((name) => headers[name]).map((name) => [name, headers[name]])),
          body,
        };
      }
    })();
  });
}

test('create a trip through the scan and the board', async ({ page, context }) => {
  const steps: Record<string, number> = {};
  const actions: ActionCall[] = [];
  watchActions(page, actions);
  const timed =async <T>(name: string, run: () => Promise<T>): Promise<T> => {
    const started = Date.now();
    const value = await run();
    steps[name] = Date.now() - started;
    return value;
  };

  const tripId = await timed('setup_to_interview_ms', () => createTrip(page, DESTINATION, summerTrip(5)));
  await page.waitForURL(/\/questionnaire$/, { timeout: 30_000 });
  await timed('interview_walk_ms', () => completeQuestionnaire(page));

  const find = page.getByTestId('interview-find-places');
  await waitUntilInteractive(find);
  await timed('scan_press_to_board_ms', async () => {
    await find.click();
    await expect(page).toHaveURL(/\/discover$/, { timeout: 30_000 });
    await expect(page.getByTestId('board-summary')).toBeVisible({ timeout: 90_000 });
  });

  const build = page.getByRole('button', { name: /Build my trip|Rebuild my trip/ });
  await expect(build).toBeEnabled();
  await timed('build_press_to_itinerary_ms', async () => {
    await build.click();
    await expect(page).toHaveURL(/\/itinerary(#[a-z-]+)?$/, { timeout: 120_000 });
    await expect(page.getByTestId('route-overview')).toBeVisible({ timeout: 30_000 });
  });

  record.tripId = tripId;
  record.tripSteps = steps;
  record.tripActions = actions;
  record.cookies = (await context.cookies()).map((c) => ({ name: c.name, value: c.value }));
  save();
});

test('help me choose: request to shortlist', async ({ page, context }) => {
  /* The same browser identity as the trip, so one cookie opens both pages. */
  const cookies = record.cookies as { name: string; value: string }[] | undefined;
  if (cookies?.length) await context.addCookies(cookies.map((c) => ({ ...c, url: test.info().project.use.baseURL! })));
  const actions: ActionCall[] = [];
  watchActions(page, actions);
  const started = Date.now();
  const decisionId = await adviseToShortlist(page);
  record.decisionId = decisionId;
  record.advisorRequestToShortlistMs = Date.now() - started;
  await page.waitForTimeout(500);
  record.advisorActions = actions;
  if (!cookies?.length) record.cookies = (await context.cookies()).map((c) => ({ name: c.name, value: c.value }));
  save();
});
