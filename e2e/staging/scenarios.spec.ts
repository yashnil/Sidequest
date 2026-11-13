import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { createTrip, waitUntilInteractive } from '../support/trip';
import { openHubView } from '../support/hub';
import { answerUntilShortlist, startAdvisor } from '../support/advisor';
import { readPlan } from '../journeys/journey';

/**
 * THE TEN-SCENARIO EVALUATION, LIVE ON STAGING (2026-11 experience transformation).
 *
 *   EVAL_OUT=docs/experience-transformation/eval/before STAGING_SCENARIOS=all \
 *     npx playwright test -c playwright.staging.config.ts e2e/staging/scenarios.spec.ts --project=desktop
 *
 * The same scenarios against whatever build staging runs, so the previous
 * implementation and the new one are compared on the same requests, the same
 * providers and the same model. Each trip is built with the traveller's
 * "Plan with smart defaults"; what is recorded is what a reader sees — the
 * overview, every day's facts, stops, meals, travel rows and notes, the
 * readiness word and the bookings — plus screenshots. Judging is separate
 * (`docs/experience-transformation/eval/`), and blind.
 */
const OUT = process.env.EVAL_OUT ?? 'docs/experience-transformation/eval/latest';
mkdirSync(`${OUT}/screens`, { recursive: true });
const record = (row: Record<string, unknown>) => appendFileSync(`${OUT}/scenarios.ndjson`, `${JSON.stringify({ at: new Date().toISOString(), ...row })}\n`);

interface Scenario {
  key: string;
  title: string;
  /** A destination typed into the setup flow, or a Help-me-choose request whose first pick is planned. */
  destination?: string;
  advisor?: string;
  start: string;
  end: string;
  party?: 'solo' | 'couple' | 'friends' | 'family';
  mustDo?: string;
}

const SCENARIOS: readonly Scenario[] = [
  { key: 'family-wellness-march', title: 'Family wellness retreat in March (Help me choose)', advisor: 'I want to go on a trip with my family over spring, March 19-29. Preferably a nice retreat. I want to feel good because life has been stressful recently. Outdoors stuff.', start: '2027-03-19', end: '2027-03-29' },
  { key: 'kumano-kodo', title: 'Kumano Kodo pilgrimage', destination: 'Kumano Kodo, Japan', start: '2027-03-19', end: '2027-03-29', party: 'family' },
  { key: 'iceland-ring-road', title: 'Iceland Ring Road', destination: 'Iceland Ring Road', start: '2027-06-14', end: '2027-06-22', party: 'couple' },
  { key: 'kyrgyzstan', title: 'Kyrgyzstan adventure', destination: 'Kyrgyzstan', start: '2027-07-10', end: '2027-07-20', party: 'friends' },
  { key: 'tanzania-safari', title: 'Tanzania safari', destination: 'Tanzania safari', start: '2027-07-05', end: '2027-07-13', party: 'couple' },
  { key: 'tokyo-kyoto-transit', title: 'Tokyo and Kyoto by public transport', destination: 'Tokyo and Kyoto by train', start: '2027-04-05', end: '2027-04-14', party: 'couple' },
  { key: 'city-break', title: 'European city break', destination: 'Lisbon, Portugal', start: '2027-05-13', end: '2027-05-16', party: 'couple' },
  { key: 'beach-island', title: 'Beach and island retreat', destination: 'Kauai, Hawaii', start: '2027-09-10', end: '2027-09-17', party: 'couple' },
  { key: 'mountain-hiking', title: 'Mountain hiking vacation', destination: 'Dolomites hiking', start: '2027-07-01', end: '2027-07-08', party: 'friends' },
  { key: 'multigenerational', title: 'Multi-generational family holiday', destination: 'Algarve, Portugal', start: '2027-06-20', end: '2027-06-27', party: 'family', mustDo: 'Travelling with our children and their grandparents; easy days.' },
];
const wanted = (process.env.STAGING_SCENARIOS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const chosen = wanted.includes('all') ? SCENARIOS : SCENARIOS.filter((s) => wanted.includes(s.key));

async function fromAdvisor(page: Page, scenario: Scenario): Promise<{ pick: string; shortlist: string }> {
  await startAdvisor(page, scenario.advisor!);
  await answerUntilShortlist(page, 12, 240_000);
  const shortlist = (await page.getByTestId('advisor-shortlist').innerText()).slice(0, 4000);
  await page.screenshot({ path: `${OUT}/screens/${scenario.key}-shortlist.jpg`, type: 'jpeg', quality: 70, fullPage: true });
  const first = page.getByTestId('advisor-pick').first();
  const pick = (await first.getByRole('heading', { level: 3 }).innerText()).trim();
  await first.getByRole('button', { name: /Plan a trip to/ }).click();
  await page.waitForURL(/\/trips\/[0-9a-f-]{36}\//, { timeout: 120_000 });
  return { pick, shortlist };
}

test.describe('ten scenarios', () => {
  test.describe.configure({ mode: 'serial' });
  for (const scenario of chosen) {
    test(`scenario: ${scenario.key}`, async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== 'desktop', 'one width; the pages are judged from text and screenshots');
      test.setTimeout(1_200_000);
      const started = Date.now();
      let advisor: { pick: string; shortlist: string } | null = null;
      if (scenario.advisor) {
        advisor = await fromAdvisor(page, scenario);
        if (!/\/questionnaire$/.test(page.url())) await page.goto(page.url().replace(/\/trips\/([0-9a-f-]{36})\/.*/, '/trips/$1/questionnaire'));
      } else {
        await createTrip(page, scenario.destination!, { start: scenario.start, end: scenario.end }, { ...(scenario.party ? { party: scenario.party } : {}), ...(scenario.mustDo ? { mustDo: scenario.mustDo } : {}) });
        await page.waitForURL(/\/questionnaire$/, { timeout: 120_000 });
      }
      const tripId = /\/trips\/([0-9a-f-]{36})\//.exec(page.url())![1]!;
      const defaults = page.getByTestId('interview-smart-defaults');
      await waitUntilInteractive(defaults);
      await defaults.click();
      await expect(page).toHaveURL(/\/itinerary(#[a-z-]+)?$/, { timeout: 900_000 });
      await expect(page.getByTestId('atlas-band')).toBeVisible({ timeout: 60_000 });
      const seconds = Math.round((Date.now() - started) / 1000);
      await page.screenshot({ path: `${OUT}/screens/${scenario.key}-overview.jpg`, type: 'jpeg', quality: 70 });
      const band = (await page.getByTestId('atlas-band').innerText().catch(() => '')).slice(0, 1500);
      const overview = (await page.locator('#hub-view-overview').innerText().catch(() => '')).slice(0, 6000);
      await openHubView(page, 'days');
      const days = (await page.locator('#hub-view-days').innerText().catch(() => '')).slice(0, 30000);
      const plan = await readPlan(page);
      await page.screenshot({ path: `${OUT}/screens/${scenario.key}-days.jpg`, type: 'jpeg', quality: 70, fullPage: true });
      await openHubView(page, 'book');
      const bookings = (await page.locator('#hub-view-book').innerText().catch(() => '')).slice(0, 6000);
      /* Places to stay: press the first stay's button like a traveller, record what it names. Absent on builds without the panel. */
      let lodging: { shown: boolean; names: string[]; empty?: string } = { shown: false, names: [] };
      const lodgingButton = page.getByTestId('lodging-picks-button').first();
      if (await lodgingButton.isVisible().catch(() => false)) {
        await lodgingButton.click();
        const panel = page.getByTestId('lodging-picks').first();
        await expect(panel.getByTestId('lodging-picks-results').or(panel.getByTestId('lodging-picks-empty')).or(panel.getByRole('alert'))).toBeVisible({ timeout: 90_000 });
        const names = await panel.getByTestId('lodging-pick').locator('p.font-display').allInnerTexts();
        /* allInnerTexts never waits for an element that is not there; innerText would sit out the test timeout. */
        const empty = [...(await panel.getByTestId('lodging-picks-empty').allInnerTexts()), ...(await panel.getByRole('alert').allInnerTexts())].join(' ').trim();
        lodging = { shown: true, names: names.map((n) => n.trim()).slice(0, 8), ...(empty ? { empty } : {}) };
        await panel.screenshot({ path: `${OUT}/screens/${scenario.key}-lodging.jpg`, type: 'jpeg', quality: 70 }).catch(() => undefined);
      }
      /* The printed guide, both formats, through whatever renderer this environment has (EVAL_PDF=all or a list of keys). */
      const pdfWanted = (process.env.EVAL_PDF ?? '').split(',').map((s) => s.trim());
      const pdf: Record<string, { status: number; bytes: number; type: string | null }> = {};
      if (pdfWanted.includes('all') || pdfWanted.includes(scenario.key)) {
        mkdirSync(`${OUT}/pdf`, { recursive: true });
        for (const variant of ['compact', 'complete'] as const) {
          const response = await page.request.get(`/api/trips/${tripId}/guide.pdf?variant=${variant}`, { timeout: 180_000 });
          const body = await response.body();
          pdf[variant] = { status: response.status(), bytes: body.length, type: response.headers()['content-type'] ?? null };
          if (response.ok() && body.subarray(0, 5).toString() === '%PDF-') writeFileSync(`${OUT}/pdf/${scenario.key}-${variant}.pdf`, body);
        }
      }
      record({
        scenario: scenario.key,
        title: scenario.title,
        request: scenario.advisor ?? scenario.destination,
        dates: `${scenario.start} → ${scenario.end}`,
        party: scenario.party ?? null,
        advisor,
        tripId,
        seconds,
        band,
        overview,
        days,
        bookings,
        lodging,
        pdf,
        plan: plan.map((d) => ({ day: d.dayNumber, header: d.header, stops: d.activities.filter((a) => a.place).map((a) => a.title), meals: d.meals.map((m) => m.title), travel: d.travel.map((t) => t.text.replace(/\s+/g, ' ').slice(0, 120)) })),
      });
    });
  }
});
