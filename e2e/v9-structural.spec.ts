import { expect, test } from '@playwright/test';
import { openHubView } from './support/hub';
import { buildFixtureTrip, visibleOpenNeed } from './support/v9';
import { waitUntilInteractive } from './support/trip';

/**
 * V9.1 — THE FOUNDER FLOW WITH A STRUCTURAL REFINEMENT, ON THE FIXTURE PATH.
 *
 * plan → trip → booking → Preflight → Pack → Today → "Fewer hotel changes"
 * (one `restructure` operation, answered deterministically by the fixture
 * interpreter) → the proposal's delta → Apply → reload → calendar and feed
 * consistent with the hub → Undo exact. No model anywhere.
 */
const TEN_DAYS = { start: '2026-11-10', end: '2026-11-19' };
const stable = (ics: string) => ics.replace(/DTSTAMP:[^\r\n]+/g, '').replace(/SEQUENCE:\d+/g, '');
/*
 * The subscription feed and the downloaded snapshot are the same trip, not the
 * same document: only the feed carries `REFRESH-INTERVAL` and `X-PUBLISHED-TTL`,
 * which tell a calendar client how often to come back. "Consistent" therefore
 * means the same events, so the comparison is over the VEVENT blocks.
 */
const events = (ics: string) => stable(ics).match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/g) ?? [];

test('a structural refinement is proposed with a delta, applied, reflected everywhere, and undone exactly', async ({ page }) => {
  test.setTimeout(240_000);
  const id = await buildFixtureTrip(page, 'Multibase Mammoth Lakes', TEN_DAYS);

  /* The plan has several stays; one booking marked; Preflight and the Pack are reachable. */
  const basesBefore = await page.getByTestId('route-bases').locator('[data-testid="base-card"]').count();
  expect(basesBefore).toBeGreaterThanOrEqual(2);
  /*
   * V9.1 CLOSURE §5 — the trip's length is Sidequest's to keep, not the
   * model's to restate. A merge moves nights between stays; it must never add
   * or lose one, so the day rail has exactly as many days after as before.
   */
  const dayRail = () => page.getByTestId('day-rail').locator('li');
  await openHubView(page, 'days');
  const daysBefore = await dayRail().allTextContents();
  expect(daysBefore.length).toBeGreaterThan(1);
  await openHubView(page, 'overview');
  await openHubView(page, 'book');
  const { markBooked } = visibleOpenNeed(page);
  await markBooked.click();
  await page.getByTestId('mark-booked-form').getByTestId('mark-booked-save').click();
  await expect(page.locator('#hub-view-book').getByTestId('booked-item').first()).toBeVisible({ timeout: 20_000 });
  await openHubView(page, 'prepare');
  await expect(page.locator('#hub-view-prepare').getByTestId('preflight-verdict')).toBeVisible();
  const before = await page.request.get(`/trips/${id}/itinerary/calendar`).then((r) => r.text());
  await page.goto(`/trips/${id}/pack`);
  await expect(page.getByTestId('trip-pack')).toBeVisible();
  await page.getByTestId('pack-feed-create').click();
  const feedUrl = (await page.getByTestId('pack-feed-url').inputValue().catch(async () => (await page.getByTestId('pack-feed-url').textContent()) ?? '')).replace(/^webcal:/, 'http:');
  expect(feedUrl).toMatch(/\/api\/calendar\//);
  await page.goto(`/trips/${id}/today`);
  await expect(page.getByTestId('today-page').or(page.getByTestId('today-inactive')).first()).toBeVisible();

  /* The controlled alternative: one press, a proposal with a deterministic delta. */
  await page.goto(`/trips/${id}/itinerary`);
  await expect(page.getByTestId('atlas-band')).toBeVisible();
  const chip = page.getByTestId('alternative-chip').filter({ hasText: 'Fewer hotel changes' }).first();
  await waitUntilInteractive(chip);
  await chip.click();
  const proposal = page.getByTestId('ask-proposal');
  await expect(proposal).toBeVisible({ timeout: 60_000 });
  await expect(proposal.getByTestId('proposal-delta')).toBeVisible();
  const hotelLine = proposal.locator('[data-testid="delta-line"][data-label="Hotel changes"]');
  await expect(hotelLine).toBeVisible();
  await expect(hotelLine).toHaveAttribute('data-tone', 'better');

  /* Apply: the measured delta, then every surface agrees. */
  await proposal.getByTestId('ask-proposal-apply').click();
  const result = page.getByTestId('ask-sidequest-result');
  await expect(result).toBeVisible({ timeout: 120_000 });
  await expect(result.getByTestId('ask-sidequest-undo-applied')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('atlas-band')).toBeVisible();
  const basesAfter = await page.getByTestId('route-bases').locator('[data-testid="base-card"]').count();
  expect(basesAfter).toBeLessThan(basesBefore);
  /* Fewer stays, and not one day fewer: the trip is the same length it always was. */
  await openHubView(page, 'days');
  expect((await dayRail().allTextContents()).length).toBe(daysBefore.length);
  await openHubView(page, 'overview');
  const afterApply = await page.request.get(`/trips/${id}/itinerary/calendar`).then((r) => r.text());
  expect(stable(afterApply)).not.toBe(stable(before));
  const feedAfter = await page.request.get(feedUrl).then((r) => r.text());
  expect(events(feedAfter).length).toBeGreaterThan(0);
  expect(events(feedAfter)).toEqual(events(afterApply));
  expect(feedAfter).toContain('REFRESH-INTERVAL;VALUE=DURATION:');
  /* The booked fact survived the change. */
  await openHubView(page, 'book');
  await expect(page.locator('#hub-view-book').getByTestId('booked-item').first()).toBeVisible();

  /* Undo: exact. */
  const open = page.getByTestId('ask-sidequest-open');
  await waitUntilInteractive(open);
  await open.click();
  const undo = page.getByTestId('ask-sidequest-undo');
  await expect(undo).toBeVisible();
  await undo.click();
  await expect(page.getByTestId('ask-sidequest-working')).toBeHidden({ timeout: 120_000 });
  await page.reload();
  await expect(page.getByTestId('atlas-band')).toBeVisible();
  const basesUndone = await page.getByTestId('route-bases').locator('[data-testid="base-card"]').count();
  expect(basesUndone).toBe(basesBefore);
  /* Undo is exact: the same stays and the same days, read back from the restored version. */
  await openHubView(page, 'days');
  expect(await dayRail().allTextContents()).toEqual(daysBefore);
  await openHubView(page, 'overview');
  const undone = await page.request.get(`/trips/${id}/itinerary/calendar`).then((r) => r.text());
  expect(stable(undone)).toBe(stable(before));
  const feedUndone = await page.request.get(feedUrl).then((r) => r.text());
  expect(events(feedUndone)).toEqual(events(undone));
});
