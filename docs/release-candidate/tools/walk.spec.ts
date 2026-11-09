import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { test } from '@playwright/test';
import { completeQuestionnaire, createTrip, waitUntilInteractive } from '../../../e2e/support/trip';
import { bandAction, openHubView } from '../../../e2e/support/hub';
import { answerUntilShortlist } from '../../../e2e/support/advisor';
import { routeTiles } from '../../../e2e/maps/support/tiles';
import { summerTrip } from '../../../e2e/support/dates';

/**
 * The first-time traveller's walk: every surface the release brief names, in
 * the order somebody meets them. Each surface is photographed inside its own
 * step and a failed step is recorded and walked past, so one missing control
 * never costs the rest of the set.
 */
const OUT = process.env.WALK_OUT ?? 'after';
const MAPS = process.env.WALK_MAPS !== 'off';

test('walk the product as a first-time traveller', async ({ page }, info) => {
  const device = info.project.name;
  const dir = path.join(new URL('.', import.meta.url).pathname, '..', 'screens', MAPS ? OUT : `${OUT}-fallback`, device);
  mkdirSync(dir, { recursive: true });
  const notes: string[] = [];
  page.on('pageerror', (error) => notes.push(`PAGEERROR ${error.message.slice(0, 200)}`));
  page.on('console', (message) => {
    if (message.type() === 'error') notes.push(`CONSOLE ${message.text().slice(0, 200)}`);
  });
  if (MAPS) await routeTiles(page);

  const shot = async (name: string, options: { full?: boolean } = {}) => {
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(dir, `${name}.jpg`), type: 'jpeg', quality: device === 'mobile' ? 52 : 62, fullPage: options.full ?? false, animations: 'disabled' });
  };
  const step = async (name: string, body: () => Promise<void>) => {
    try {
      await body();
    } catch (error) {
      notes.push(`STEP ${name}: ${(error as Error).message.split('\n')[0]?.slice(0, 240)}`);
    }
  };

  const hubOnly = !MAPS;

  if (!hubOnly) {
    await step('landing', async () => {
      await page.goto('/');
      await page.waitForTimeout(1500);
      await shot('01-landing');
    });

    await step('help-me-choose', async () => {
      await page.goto('/decide');
      const box = page.getByLabel('In your own words');
      await waitUntilInteractive(box);
      await shot('02-help-me-choose');
      await box.fill('Hiking and mountains in July, about 9 nights.');
      await page.getByRole('button', { name: /Find my places|Just ask me/ }).click();
      await page.waitForURL(/\/decide\/[0-9a-f-]{8,}/);
      await page.waitForTimeout(1200);
      await shot('03-help-me-choose-question');
      await answerUntilShortlist(page);
      await page.waitForTimeout(1500);
      await shot('04-help-me-choose-shortlist');
    });

    await step('new-trip', async () => {
      await page.goto('/trips/new');
      await waitUntilInteractive(page.getByTestId('destination-input'));
      await shot('05-new-trip');
    });
  }

  const tripId = await createTrip(page, 'Mammoth Lakes', summerTrip(4));

  await step('questionnaire', async () => {
    await page.goto(`/trips/${tripId}/questionnaire`);
    const start = page.getByTestId('interview-start');
    await waitUntilInteractive(start);
    if (!hubOnly) await shot('06-questionnaire-start');
    await start.click();
    await page.waitForTimeout(700);
    if (!hubOnly) await shot('07-questionnaire-question');
    await completeQuestionnaire(page);
    if (!hubOnly) await shot('08-questionnaire-review');
  });

  await step('scan-and-board', async () => {
    /* The scan door where the server has a geocoder; the fixture server offers the board directly. */
    const find = page.getByTestId('interview-find-places');
    if (await find.isVisible().catch(() => false)) await find.click();
    else await page.getByRole('button', { name: 'Open the Discovery Board' }).click();
    await page.waitForTimeout(350);
    if (!hubOnly) await shot('09-scan-loading');
    await page.getByTestId('board-summary').waitFor({ timeout: 90_000 });
    await page.waitForTimeout(1500);
    if (!hubOnly) await shot('10-discovery-board');
  });

  await step('generation', async () => {
    await page.getByRole('button', { name: /Build my trip|Rebuild my trip/ }).first().click();
    await page.waitForTimeout(300);
    if (!hubOnly) await shot('11-generation');
    await page.waitForURL(/\/itinerary(#[a-z-]+)?$/, { timeout: 120_000 });
    await page.getByTestId('atlas-band').waitFor({ timeout: 30_000 });
  });

  await step('trip-overview', async () => {
    await page.waitForTimeout(1500);
    await shot('12-trip-overview');
  });

  await step('days', async () => {
    await openHubView(page, 'days');
    await page.evaluate(() => document.getElementById('day-2')?.scrollIntoView({ block: 'start' }));
    await page.waitForTimeout(1500);
    await shot('13-day-by-day');
  });

  await step('select-a-stop', async () => {
    const row = page.locator('#hub-view-days [data-timeline-place][data-day="2"]').first();
    await row.scrollIntoViewIfNeeded();
    /* The number on the row is the button that shows the stop on the map. */
    await row.getByTestId('stop-number').click();
    await page.waitForTimeout(1800);
    await shot('14-stop-selected-map');
  });

  await step('phone-map', async () => {
    if (device !== 'mobile') return;
    const open = page.getByTestId('day-map-sheet-open');
    if (await open.isVisible().catch(() => false)) await open.click();
    await page.waitForTimeout(2500);
    await shot('15-phone-day-map');
    await page.getByTestId('day-map-dock-close').click();
  });

  await step('editing', async () => {
    const menu = page.locator('#hub-view-days [data-testid="stop-menu"]').locator('visible=true').first();
    await menu.scrollIntoViewIfNeeded();
    await menu.click();
    await page.waitForTimeout(500);
    await shot('16-editing-stop');
    await page.keyboard.press('Escape');
    await menu.click().catch(() => {});
    const dayEdit = page.locator('[data-testid^="day-edit-"]').locator('visible=true').first();
    if ((await dayEdit.count()) > 0) {
      await dayEdit.locator(':scope > summary').click();
      await dayEdit.scrollIntoViewIfNeeded();
      await page.waitForTimeout(400);
      await shot('17-editing-day');
    }
  });

  await step('map', async () => {
    await openHubView(page, 'map');
    await page.waitForTimeout(2500);
    await shot('18-map');
    const day = page.getByTestId('map-day-2').or(page.getByTestId('journey-day').nth(1)).locator('visible=true').first();
    if ((await day.count()) > 0) {
      await day.click();
      await page.waitForTimeout(2200);
      await shot('19-map-day');
    }
  });

  await step('bookings', async () => {
    await openHubView(page, 'book');
    await page.waitForTimeout(800);
    await shot('20-bookings');
  });

  await step('prepare', async () => {
    await openHubView(page, 'prepare');
    await page.waitForTimeout(800);
    await shot('21-prepare');
  });

  if (!hubOnly) {
    await step('share', async () => {
      await page.goto(`/trips/${tripId}/itinerary`);
      await page.getByTestId('atlas-band').waitFor({ timeout: 30_000 });
      const share = await bandAction(page, 'Share this plan');
      await share.click();
      await page.waitForTimeout(1200);
      await shot('22-share');
    });

    await step('exports', async () => {
      await page.goto(`/trips/${tripId}/pack`);
      await page.getByTestId('trip-pack').waitFor({ timeout: 30_000 });
      await shot('23-exports-pack');
    });
  }

  // eslint-disable-next-line no-console -- a developer tool: this line is its report.
  console.log(`WALK ${device} trip=${tripId}\n${notes.join('\n')}`);
});
