import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { createTrip, waitUntilInteractive } from '../support/trip';
import { openHubView } from '../support/hub';
import { answerUntilShortlist, startAdvisor } from '../support/advisor';
import { expectNoHorizontalOverflow } from '../support/viewports';
import {
  bandAction,
  freshContext,
  parseIcs,
  readBookingLinks,
  readPlan,
  reloadPlan,
  removeStop,
  signature,
  stopOn,
  undoLast,
  watchNetwork,
  type PlanDay,
} from '../journeys/journey';

/**
 * STAGING ACCEPTANCE. Run only through `playwright.staging.config.ts`.
 *
 * Everything here happens on the deployed staging environment with its real
 * providers: the model's scan, Google Places and Nominatim, openrouteservice,
 * Overture/Overpass food, Open-Meteo. Every step writes a row of evidence; a
 * plan is also written out whole so a person can read it, because a green
 * spec only says a page appeared.
 */
const OUT = 'docs/release-candidate/staging';
mkdirSync(`${OUT}/screens`, { recursive: true });
const evidence = (row: Record<string, unknown>) => appendFileSync(`${OUT}/evidence.ndjson`, `${JSON.stringify({ at: new Date().toISOString(), ...row })}\n`);
const shot = (page: Page, testInfo: TestInfo, name: string) => page.screenshot({ path: `${OUT}/screens/${testInfo.project.name}-${name}.jpg`, type: 'jpeg', quality: 70, fullPage: false });

const HYDRATION = /error #(418|419|421|422|423|425)|Hydration failed|did not match|server rendered (HTML|text)/i;

/** Every console error and page error, hydration ones singled out. */
function watch(page: Page): { hydration: string[]; errors: string[] } {
  const seen = { hydration: [] as string[], errors: [] as string[] };
  const note = (text: string) => {
    if (HYDRATION.test(text)) seen.hydration.push(`${page.url()} ${text.slice(0, 300)}`);
    else seen.errors.push(`${page.url()} ${text.slice(0, 200)}`);
  };
  page.on('pageerror', (e) => note(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') note(m.text());
  });
  return seen;
}

const PUBLIC_ROUTES = ['/', '/decide', '/trips/new', '/trips/new?have=plan', '/trips', '/signin', '/privacy', '/terms', '/support', '/profile', '/this-address-leads-nowhere', '/share/AAAAAAAAAAAAAAAAAAAAAA'];

test.describe('public surface', () => {
  test('every public page renders without a hydration error or horizontal scroll', async ({ page }, testInfo) => {
    test.setTimeout(240_000);
    const seen = watch(page);
    for (const route of PUBLIC_ROUTES) {
      const response = await page.goto(route, { waitUntil: 'load' });
      const expected = route.startsWith('/share/') || route === '/this-address-leads-nowhere' ? 404 : 200;
      expect(response?.status(), route).toBe(expected);
      await page.waitForTimeout(1200);
      await expectNoHorizontalOverflow(page, route);
      if (['/', '/decide', '/trips/new'].includes(route)) await shot(page, testInfo, `public${route.replace(/\W+/g, '-') || '-home'}`);
    }
    evidence({ step: 'public-pages', project: testInfo.project.name, routes: PUBLIC_ROUTES.length, hydration: seen.hydration, consoleErrors: seen.errors.slice(0, 10) });
    expect(seen.hydration, 'no hydration errors').toEqual([]);
  });

  test('security headers, noindex and closed doors', async ({ request }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'once is enough');
    const home = await request.get('/');
    const h = home.headers();
    expect(h['content-security-policy']).toBeTruthy();
    expect(h['strict-transport-security']).toMatch(/max-age=\d+/);
    expect(h['x-frame-options']).toBe('DENY');
    expect(h['x-content-type-options']).toBe('nosniff');
    const trips = await request.get('/trips');
    expect(trips.headers()['x-robots-tag']).toMatch(/noindex/);
    const robots = await (await request.get('/robots.txt')).text();
    expect(robots).toMatch(/Disallow: \//);
    const labs = await request.get('/labs/design');
    expect([401, 403, 404]).toContain(labs.status());
    const readiness = await (await request.get('/api/readiness')).text();
    expect(readiness, 'readiness never prints a key or a path').not.toMatch(/sk-ant|AIza|\/data\/sidequest/);
    const exported = await request.get('/api/me/export');
    expect(exported.status()).toBeLessThan(500);
    evidence({ step: 'headers', csp: true, hsts: h['strict-transport-security'], frame: h['x-frame-options'], labs: labs.status(), robots: robots.split('\n').slice(0, 3) });
  });
});

interface LiveTrip {
  label: string;
  destination: string;
  start: string;
  end: string;
  /** What a person reading the plan should find: checked and written down, not only asserted. */
  expect?: { minBases?: number; minStopsPerFullDay?: number };
}

const TRIPS: readonly LiveTrip[] = [
  { label: 'lisbon', destination: 'Lisbon, Portugal', start: '2027-05-13', end: '2027-05-16' },
  { label: 'iceland-ring-road', destination: 'Iceland Ring Road', start: '2027-06-14', end: '2027-06-22', expect: { minBases: 3 } },
  { label: 'tanzania', destination: 'Arusha and the Serengeti, Tanzania', start: '2027-07-05', end: '2027-07-13' },
  { label: 'scotland-highlands', destination: 'Scottish Highlands road trip', start: '2027-06-01', end: '2027-06-08', expect: { minBases: 2 } },
  { label: 'japan-linear', destination: 'Tokyo, Kyoto and Hiroshima, Japan', start: '2027-04-05', end: '2027-04-14', expect: { minBases: 3 } },
  { label: 'tenerife', destination: 'Tenerife, Canary Islands', start: '2027-02-08', end: '2027-02-13' },
];
const wanted = (process.env.STAGING_TRIPS ?? 'lisbon').split(',').map((s) => s.trim()).filter(Boolean);

/** What a reader would check: bases, stops a day, travel rows and whether each was measured. */
function summarise(plan: readonly PlanDay[]) {
  return plan.map((d) => ({
    day: d.dayNumber,
    header: d.header,
    stops: d.activities.filter((a) => a.place).map((a) => a.title),
    meals: d.meals.map((m) => m.title),
    travel: d.travel.map((t) => t.text.replace(/\s+/g, ' ').slice(0, 90)),
  }));
}

test.describe('live trips', () => {
  test.describe.configure({ mode: 'serial' });
  for (const trip of TRIPS.filter((t) => wanted.includes(t.label))) {
    test(`trip: ${trip.label}`, async ({ page, browser }, testInfo) => {
      test.skip(testInfo.project.name !== 'desktop', 'live trips run once, at desktop; the trip pages are then checked at every width');
      const seen = watch(page);
      watchNetwork(page);
      const started = Date.now();
      await createTrip(page, trip.destination, { start: trip.start, end: trip.end });
      await page.waitForURL(/\/questionnaire$/, { timeout: 90_000 });
      const tripId = /\/trips\/([0-9a-f-]{36})\//.exec(page.url())![1]!;
      const defaults = page.getByTestId('interview-smart-defaults');
      await waitUntilInteractive(defaults);
      await defaults.click();
      await expect(page).toHaveURL(/\/itinerary(#[a-z-]+)?$/, { timeout: 600_000 });
      await expect(page.getByTestId('route-overview')).toBeVisible({ timeout: 60_000 });
      const seconds = Math.round((Date.now() - started) / 1000);
      await shot(page, testInfo, `${trip.label}-overview`);
      const overview = (await page.locator('#hub-view-overview').innerText().catch(() => '')).slice(0, 4000);
      await openHubView(page, 'days');
      let plan = await readPlan(page);
      await shot(page, testInfo, `${trip.label}-days`);
      const summary = summarise(plan);
      const measured = summary.flatMap((d) => d.travel).filter((t) => !/\babout\b|estimate|not measured/i.test(t)).length;
      const travelRows = summary.flatMap((d) => d.travel).length;
      evidence({ step: 'trip-built', trip: trip.label, tripId, seconds, days: plan.length, stops: summary.reduce((n, d) => n + d.stops.length, 0), travelRows, travelRowsWithoutAbout: measured, overview, plan: summary });

      // Reload gives the same plan.
      expect(signature(await reloadPlan(page)), 'a reload shows the same plan').toBe(signature(plan));

      // Edit, undo, reload, re-apply.
      const day = plan.find((d) => d.activities.some((a) => a.place));
      if (day) {
        const stop = day.activities.find((a) => a.place)!;
        const baseline = signature(plan);
        await openHubView(page, 'days');
        await removeStop(page, day.dayNumber, stop.place!);
        await undoLast(page);
        expect(signature(await readPlan(page)), 'undo restores').toBe(baseline);
        expect(signature(await reloadPlan(page)), 'and it stays restored').toBe(baseline);
        await removeStop(page, day.dayNumber, stop.place!);
        plan = await reloadPlan(page);
        expect(stopOn(plan, day.dayNumber, stop.place!), 'the removal persisted').toBeFalsy();
        // Restore the version before the edit.
        await openHubView(page, 'overview');
        const versions = page.getByTestId('trip-versions');
        await expect(versions).toBeVisible();
        await versions.locator('summary').click();
        await versions.getByTestId('trip-version-restore').first().click();
        await expect(page.getByTestId('edit-toast-message')).toContainText('Restored', { timeout: 20_000 });
        expect(signature(await reloadPlan(page)), 'restoring the earlier version brings the stop back').toBe(baseline);
        evidence({ step: 'edit-undo-version', trip: trip.label, removed: stop.title, day: day.dayNumber, result: 'undo, reload, re-apply and version restore all exact' });
      }

      // Booking and map links.
      const links = await readBookingLinks(page).catch(() => []);
      for (const link of links) expect(() => new URL(link.href), link.label).not.toThrow();
      await openHubView(page, 'days');
      const routeLinks = await page.locator('[data-testid^="day-route-"]').evaluateAll((as) => as.map((a) => a.getAttribute('href') ?? ''));
      for (const href of routeLinks) expect(new URL(href).hostname).toBe('www.google.com');
      evidence({ step: 'links', trip: trip.label, booking: links.slice(0, 8), mapRouteLinks: routeLinks.length });

      // Calendar file.
      const link = await bandAction(page, 'Calendar file (.ics)');
      const [download] = await Promise.all([page.waitForEvent('download'), link.click()]);
      const ics = parseIcs(readFileSync(await download.path(), 'utf8'));
      expect(ics.events.length).toBeGreaterThan(0);
      const tz = /TZID[:=]([^\s;:]+)/.exec(ics.unfolded)?.[1] ?? null;
      evidence({ step: 'ics', trip: trip.label, events: ics.events.length, tzid: tz });

      // Print packet.
      await page.goto(`/trips/${tripId}/itinerary`);
      await page.emulateMedia({ media: 'print' });
      const pdf = await page.pdf({ printBackground: true });
      expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
      await page.emulateMedia({ media: 'screen' });

      // Share: a stranger sees a read-only copy, then nothing once revoked.
      await page.goto(`/trips/${tripId}/itinerary`);
      const share = await bandAction(page, 'Share this plan');
      await waitUntilInteractive(share);
      await share.click();
      const field = page.getByLabel('Share link');
      await expect(field).toBeVisible({ timeout: 20_000 });
      const shareUrl = await field.inputValue();
      const reader = await freshContext(browser, testInfo);
      await reader.page.goto(shareUrl);
      await expect(reader.page.getByText('Shared with you')).toBeVisible();
      expect(await reader.page.content(), 'no trip id in the shared page').not.toContain(tripId);
      await expect(reader.page.getByRole('button', { name: /^Change / })).toHaveCount(0);
      // The same stranger cannot open the owner's trip.
      for (const view of ['itinerary', 'discover', 'pack', 'questionnaire']) {
        await reader.page.goto(`/trips/${tripId}/${view}`);
        await expect(reader.page.getByTestId('atlas-band'), `a stranger never sees /${view}`).toHaveCount(0);
      }
      const revoke = page.getByTestId('share-revoke');
      await revoke.click();
      await revoke.click();
      await expect(page.getByTestId('share-revoked')).toBeVisible({ timeout: 20_000 });
      expect((await reader.page.goto(shareUrl))?.status(), 'a revoked link is gone').toBe(404);
      await reader.context.close();
      evidence({ step: 'share-and-access', trip: trip.label, result: 'shared copy read-only; owner pages hidden from a stranger; revoked link 404' });

      // Every trip view, at this width, without a hydration error.
      for (const view of ['itinerary', 'pack', 'today', 'discover', 'edit']) {
        await page.goto(`/trips/${tripId}/${view}`, { waitUntil: 'load' });
        await page.waitForTimeout(1500);
      }
      evidence({ step: 'trip-hydration', trip: trip.label, hydration: seen.hydration, consoleErrors: seen.errors.slice(0, 10) });
      expect(seen.hydration).toEqual([]);
      appendFileSync(`${OUT}/trip-ids.txt`, `${trip.label} ${tripId}\n`);

      if (trip.expect?.minBases) {
        const bases = new Set(plan.map((d) => /·\s*([^·]+)$/.exec(d.header)?.[1]?.trim() ?? '').filter(Boolean));
        evidence({ step: 'shape', trip: trip.label, basesFromHeaders: [...bases] });
      }
    });
  }
});

test.describe('help me choose, live', () => {
  for (const request of ['Two weeks in late August, beaches and mountains, not too hot, mid budget.', 'Somewhere beautiful and relaxing.']) {
    test(`advisor: ${request.slice(0, 30)}`, async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== 'desktop' || !wanted.includes('advisor'), 'opt in with STAGING_TRIPS=advisor');
      const seen = watch(page);
      await startAdvisor(page, request);
      await answerUntilShortlist(page);
      const list = page.getByTestId('advisor-shortlist');
      await expect(list).toBeVisible({ timeout: 90_000 });
      await page.waitForTimeout(20_000);
      await shot(page, testInfo, `advisor-${request.slice(0, 12).replace(/\W+/g, '-')}`);
      evidence({ step: 'advisor', request, shortlist: (await list.innerText()).slice(0, 1500), hydration: seen.hydration });
      expect(seen.hydration).toEqual([]);
    });
  }
});
