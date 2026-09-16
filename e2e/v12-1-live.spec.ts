import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { completeQuestionnaire, createTrip } from './support/trip';
import { openHubView } from './support/hub';

/**
 * V12.1 §49 §50 — THE TWO LIVE ACCEPTANCES.
 *
 * Run only from `playwright.v12.1-live.config.ts`, which starts the app on the
 * real provider stack. Everything about the Journey model is proven
 * deterministically — the fixture matrix, the failure corpus, the mode screen,
 * the readiness profiles, the five replayed live trips — because all of it is
 * pure. What only a real model can show is whether a trip *composed* with these
 * semantics in the envelope comes back **moving** like the kind of trip it is.
 *
 * The two scenarios are the two operating families V12 left unsatisfiable:
 * `rail_journey` and `island_hopping`, both of which sat at a transport
 * certainty of 0.90 that no road router could ever meet. If the Journey layer
 * works, both are now able to reach Ready on the right kind of evidence, and
 * neither says "allowance".
 *
 * **Exactly one Anthropic call each.** No retry, no critic, no repair.
 */

const OUT = '.claude-private/artifacts/v12.1/live';
/** The database `playwright.v12.1-live.config.ts` starts the app on. */
const DATABASE = 'apps/web/data/v12-1-live.db';
mkdirSync(OUT, { recursive: true });

async function captureTrip(page: Page, slug: string, tripId: string, seen: string[]): Promise<void> {
  writeFileSync(`${OUT}/${slug}-trip-id.txt`, `${tripId}\n`);
  /*
   * V12.2 — DUMP THE DRAFT, NOT ONLY THE PICTURES.
   *
   * The V12.1 Japan acceptance is unreplayable: the live database was reset
   * before the third call, and all that survived was screenshots and the
   * rendered day text. Everything a later pass needs to re-judge a trip lives in
   * the draft and the stored itinerary, so it is written beside them here — the
   * same shape `dump-trip.mjs` produces, which the V11 and V12 replays read.
   *
   * Best-effort: a dump that fails must never fail an acceptance that has
   * already spent its model call.
   */
  try {
    const { execFileSync } = await import('node:child_process');
    execFileSync('node', ['apps/web/scripts/dump-trip.mjs', DATABASE, tripId, `${OUT}/${slug}-dump`], { stdio: 'ignore' });
  } catch {
    /* Recorded by its absence; the screenshots below still land. */
  }
  writeFileSync(`${OUT}/${slug}-questions.txt`, `${seen.join('\n')}\n`);
  await page.screenshot({ path: `${OUT}/${slug}-01-hub.png`, fullPage: true, animations: 'disabled' });
  for (const view of ['days', 'map', 'book', 'prepare'] as const) {
    await openHubView(page, view);
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${OUT}/${slug}-${view}.png`, fullPage: true, animations: 'disabled' });
  }
}

/** Words a traveller must never read on a finished plan (§19). */
const FORBIDDEN = [/\ballowance\b/i, /provider unsupported/i, /operator-timed/i, /evidence insufficient/i, /\bunmeasured\b/i, /not routed/i];

async function assertNoForensicWords(page: Page, slug: string): Promise<void> {
  await openHubView(page, 'days');
  const text = (await page.locator('#hub-view-days').innerText()).replace(/\s+/g, ' ');
  writeFileSync(`${OUT}/${slug}-days.txt`, text);
  for (const pattern of FORBIDDEN) {
    expect(pattern.test(text), `the days view says "${text.match(pattern)?.[0]}"`).toBe(false);
  }
}

/**
 * §49 — ten days, Tokyo to Kyoto to Hiroshima or Osaka, a first-time traveller,
 * food and culture, moderate pace, no rental car, comfortable with trains, and
 * efficient logistics.
 */
test('V12.1 live: intercity rail and urban transit, one composition call', async ({ page }) => {
  test.setTimeout(480_000);
  const tripId = await createTrip(
    page,
    'Japan',
    { start: '2026-10-10', end: '2026-10-20' },
    {
      party: 'couple',
      mustDo: 'Tokyo, Kyoto and one more city — Hiroshima or Osaka. Food and culture. We will travel by train; we are not hiring a car. Keep the logistics simple and the luggage moves few.',
      avoid: 'Driving. Long days of transit. Anything that needs a car.',
    },
  );
  const seen = await completeQuestionnaire(page, {
    strict: true,
    priorities: ['Food & local eating', 'History & culture', 'Neighbourhoods & local life'],
    /* Food is what the trip is built around; culture is most days; the neighbourhoods are how it is seen. */
    interestRoles: { food_and_towns: 'build_around', history_and_culture: 'most_days', neighbourhoods_and_local_life: 'couple' },
    answers: {
      /* Japan's compiled reality offers this: trains for the regional days, metro and foot in the cities. */
      transport_mode: 'rail_transfers',
      effort: 'moderate',
      budget: 'midrange',
      base_moves: 'move_if_it_saves_time',
      free_time: 'balanced',
      coverage_strategy: 'best_subset',
    },
  });

  await page.getByTestId('interview-build-trip').click();
  await expect(page).toHaveURL(new RegExp(`/trips/${tripId}/(build|itinerary)`), { timeout: 30_000 });
  await expect(page).toHaveURL(new RegExp(`/trips/${tripId}/itinerary(#[a-z-]+)?$`), { timeout: 420_000 });
  await expect(page.getByTestId('atlas-band')).toBeVisible({ timeout: 60_000 });

  await assertNoForensicWords(page, 'japan');
  await captureTrip(page, 'japan', tripId, seen);
});

/**
 * §50 — nine days, two or three islands at most, beaches and local culture, a
 * moderate budget, ferries preferred, willing to move, no rental car needed
 * across the islands.
 */
test('V12.1 live: island hopping by ferry, one composition call', async ({ page }) => {
  test.setTimeout(480_000);
  const tripId = await createTrip(
    page,
    'Greece',
    { start: '2026-06-06', end: '2026-06-15' },
    {
      party: 'couple',
      mustDo: 'Two or three islands at most, reached by ferry. Beaches and the towns. We want time in each place rather than a crossing every other day.',
      avoid: 'Hiring a car to get between the islands. More than three islands. Rushing.',
    },
  );
  const seen = await completeQuestionnaire(page, {
    strict: true,
    priorities: ['Beaches & swimming', 'Food & local eating', 'History & culture'],
    interestRoles: { beaches_and_swimming: 'build_around', food_and_towns: 'most_days', history_and_culture: 'couple' },
    answers: {
      /* Greece's compiled reality offers boats and local transfers; a hire car is per-island, not between them. */
      transport_mode: 'boats_transfers',
      effort: 'light',
      budget: 'midrange',
      base_moves: 'move_once',
      free_time: 'lots',
      coverage_strategy: 'depth',
    },
  });

  await page.getByTestId('interview-build-trip').click();
  await expect(page).toHaveURL(new RegExp(`/trips/${tripId}/(build|itinerary)`), { timeout: 30_000 });
  await expect(page).toHaveURL(new RegExp(`/trips/${tripId}/itinerary(#[a-z-]+)?$`), { timeout: 420_000 });
  await expect(page.getByTestId('atlas-band')).toBeVisible({ timeout: 60_000 });

  await assertNoForensicWords(page, 'greece');
  await captureTrip(page, 'greece', tripId, seen);
});
