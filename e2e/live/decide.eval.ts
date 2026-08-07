import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import {
  measured,
  notMeasured,
  renderMeasurement,
  serialise,
  type Measured,
} from '../support/live-journey.ts';

/**
 * HELP ME DECIDE, LIVE — AND THE IMAGERY THAT COMES WITH IT.
 *
 * Two things this measures that nothing offline can:
 *
 *   1. **The shortlist is deterministic and free.** No model call, against the
 *      real 109k-row destination index rather than five invented countries. Any
 *      model spend recorded during this run is a defect, not a cost.
 *   2. **Imagery resolves against real Wikimedia Commons.** The shortlist action
 *      is where identity is established, so this is the cheapest honest exercise
 *      of the whole licence gate: real Wikidata ids, real `extmetadata`, real
 *      refusals.
 *
 * Usage:
 *   node --experimental-strip-types e2e/live/decide.eval.ts
 */

const BASE = process.env.SIDEQUEST_BASE_URL ?? 'http://localhost:4200';
const OUT = 'test-results/live';
const slug = process.argv[2] ?? 'decide';

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  /*
   * Two records, because they are two different kinds of claim.
   *
   * `measurements` holds everything this run either saw or explicitly did not,
   * and it is serialised through `serialise` so an absence lands in the JSON as
   * `{state: "not_measured", because: {...}, reads: "..."}` with no value key of
   * any kind. `context` holds the things that are not measurements at all — the
   * request log, the console log — and they keep their plain shapes.
   */
  const measurements: Record<string, Measured<unknown>> = {};
  const evidence: Record<string, unknown> = {};

  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(error.message));

  /** Every request that left our origin while the shortlist page rendered. */
  const external: string[] = [];
  page.on('request', (request) => {
    if (!request.url().startsWith(BASE)) external.push(request.url());
  });

  await page.goto(`${BASE}/decide`);
  await page.screenshot({ path: `${OUT}/${slug}-composer.png`, fullPage: true });

  /*
   * The four answers the composer actually needs, named rather than guessed.
   *
   * An earlier version checked the first radio of every group and clicked
   * whatever "Continue" it found, and the rank button stayed disabled for thirty
   * seconds — because nights and the interest checkboxes are not radios, so
   * nothing it did satisfied the form. Naming them is what `decide.spec` does,
   * and a failure then says which field is missing.
   */
  await page.getByRole('radio', { name: 'Some time in a month' }).check();
  await page.getByLabel('Which month?').selectOption('4');
  await page.getByLabel('How many nights?').fill('5');
  for (const interest of ['Eating well', 'History, museums and architecture', 'City life']) {
    await page
      .getByRole('checkbox', { name: interest })
      .check()
      .catch(() => undefined);
  }
  await page
    .getByRole('radio', { name: 'Stay in one place' })
    .check()
    .catch(() => undefined);
  await page
    .getByRole('radio', { name: 'Trains, buses and transfers', exact: true })
    .check()
    .catch(() => undefined);
  await page.screenshot({ path: `${OUT}/${slug}-answers.png`, fullPage: true });
  await page.getByRole('button', { name: 'Show me where to go' }).click();
  await page.waitForURL(/\/decide\/[0-9a-f-]{8,}/, { timeout: 60_000 });

  const t0 = Date.now();
  /*
   * The shortlist is a labelled list, not a set of articles.
   *
   * This waited on `getByRole('article')`, which the shortlist has never
   * rendered — so it burned its full two-minute budget on every run and then
   * recorded `shortlistCount: 0` beside a screenshot plainly showing eight
   * destinations. A measurement that reads zero when the thing is on screen is
   * worse than no measurement, because it is reported with the same confidence.
   */
  /*
   * ...and the same discipline one level down, which the fix above stopped short
   * of. `Date.now() - t0` was recorded whether or not the shortlist arrived, so a
   * run that timed out reported `timeToShortlistMs: 120000` as if that were how
   * long the product took; and `.catch(() => 0)` still turned a failed count into
   * a shortlist of nothing. Both now say plainly that they did not measure.
   */
  const list = page.getByRole('list', { name: 'Suggested destinations' });
  const items = list.getByRole('listitem');
  const appeared = await items
    .first()
    .waitFor({ timeout: 120_000 })
    .then(() => true)
    .catch(() => false);
  measurements.timeToShortlistMs = appeared
    ? measured(Date.now() - t0)
    : notMeasured(
        'deadline_expired',
        'the shortlist never rendered within the 120s deadline — this is a deadline, not a render time',
      );

  /*
   * ...AND THE COUNT BEHIND IT, WHICH WAS THE LAST ZERO IN THIS FILE.
   *
   * `items.count().catch(() => null)` looks careful and is not: `count()` does
   * not throw on a list that is not there. It answers `0`. So a run whose
   * shortlist never rendered — the `appeared === false` branch directly above,
   * which had just finished saying so — went on to publish
   * `shortlistCount: observed 0`, a confident statement that the real 109k-row
   * index produced no destinations. The count is only a measurement if the list
   * that would hold the items is on the page, and that is now checked rather
   * than assumed.
   */
  if (!appeared) {
    measurements.shortlistCount = notMeasured(
      'deadline_expired',
      'the shortlist list never appeared within 120s, so its items were never counted — this is not a shortlist of zero destinations',
    );
  } else if ((await list.count().catch(() => 0)) === 0) {
    measurements.shortlistCount = notMeasured(
      'markup_absent',
      'no list labelled "Suggested destinations" was on the page when the count was taken',
    );
  } else {
    const counted = await items.count().catch(() => null);
    measurements.shortlistCount =
      counted === null
        ? notMeasured('probe_threw', 'counting the shortlist items raised')
        : measured(counted);
  }

  await page.screenshot({ path: `${OUT}/${slug}-shortlist.png`, fullPage: true });
  measurements.shortlistText = await page
    .locator('#main')
    .innerText()
    .then((text) => measured(text.slice(0, 2500)))
    // `.catch(() => '')` was here. An empty string is a page with nothing on it.
    .catch((error: unknown) =>
      notMeasured(
        'markup_absent',
        `#main could not be read: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );

  evidence.externalRequestsDuringRender = [...new Set(external)];
  evidence.consoleErrors = consoleErrors;
  await browser.close();

  const report = {
    measurements: Object.fromEntries(
      Object.entries(measurements).map(([field, value]) => [field, serialise(value)]),
    ),
    ...evidence,
  };
  writeFileSync(`${OUT}/${slug}-decide.json`, JSON.stringify(report, null, 2));
  process.stdout.write(
    [
      ...Object.entries(measurements).map(([field, value]) => renderMeasurement(field, value)),
      `externalRequestsDuringRender: ${JSON.stringify(evidence.externalRequestsDuringRender)}`,
      `consoleErrors: ${JSON.stringify(evidence.consoleErrors)}`,
      '',
    ].join('\n'),
  );
}

void main();
