import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { completeQuestionnaire, createTrip } from './support/trip';
import { openHubView } from './support/hub';

/**
 * V11 §R §S — THE TWO LIVE FOUNDER BUILDS.
 *
 * Run only from `playwright.v11-live.config.ts`, which starts the app on the
 * real provider stack. Everything else about V11 is proven deterministically —
 * the nine-shape matrix, the founder fixtures, the four-width visual walk. What
 * these two and only these two can prove is that a **real model**, given the V11
 * composition envelope, returns a trip the V11 layers make a good trip out of:
 * the stay sequence, the chapters, the signature experiences, the archetype-aware
 * readiness, the plausibility gate and the jurisdiction language.
 *
 * **Exactly one Anthropic call each.** The composition. No retry, no critic, no
 * repair — the architecture forbids all three and the config sets `retries: 0`,
 * so a failure is a failure rather than a second call.
 *
 * The trip id is the artifact: the plan is read out of the database afterwards
 * with `apps/web/scripts/dump-trip.mjs`, which already knows how to unpack the
 * package, the preservation report and the composition attempts.
 */

const OUT = '.claude-private/artifacts/v11/live';
mkdirSync(OUT, { recursive: true });

async function captureTrip(page: Page, slug: string, tripId: string): Promise<void> {
  writeFileSync(`${OUT}/${slug}-trip-id.txt`, `${tripId}\n`);
  await page.screenshot({ path: `${OUT}/${slug}-01-hub.png`, fullPage: true, animations: 'disabled' });
  for (const view of ['days', 'map', 'book', 'prepare'] as const) {
    await openHubView(page, view);
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${OUT}/${slug}-${view}.png`, fullPage: true, animations: 'disabled' });
  }
}

/**
 * §R — four fit young friends, ten nights, August, intense, hiking, scenery and
 * unusual experiences; basic lodging fine; guides and private transfers fine.
 */
test('V11 live: Kyrgyzstan, one composition call, through the real stack', async ({ page }) => {
  test.setTimeout(480_000);
  const tripId = await createTrip(
    page,
    'Kyrgyzstan',
    { start: '2026-08-05', end: '2026-08-15' },
    {
      party: 'friends',
      mustDo: 'Song-Köl and the Ala-Kul crossing. Guides and private drivers are fine; we will not self-drive. Basic lodging, yurts and camps are fine.',
      avoid: 'Nothing long in a city. No self-driving.',
    },
  );
  const kyrgyzstanSeen = await completeQuestionnaire(page, {
    priorities: ['Hiking', 'Scenic viewpoints', 'Unusual experiences'],
    /*
     * Values from the interview catalog, not invented ones: an answer the
     * question does not offer falls through to "Sidequest decides", which would
     * silently make this a different scenario from the one §R states.
     */
    answers: {
      transport_mode: 'guided',
      effort: 'intense',
      day_shape: 'two_three',
      budget: 'midrange',
      hike_appetite: 'full_day',
      lodging_style: 'basic_hotel',
      base_moves: 'move_freely',
    },
  });

  /*
   * The walker hands a question it cannot answer to Sidequest, silently. On a
   * run that costs a call that would quietly make this a different scenario
   * from the one §R states, so the questions this scenario is *about* are
   * asserted to have been asked, and the whole list is written out beside the
   * trip id for the inspection afterwards.
   */
  writeFileSync(`${OUT}/kyrgyzstan-questions.txt`, `${kyrgyzstanSeen.join('\n')}\n`);
  expect(kyrgyzstanSeen, 'the scenario is about how this party moves and how hard the days are').toEqual(
    expect.arrayContaining(['transport_mode', 'effort']),
  );

  await page.getByTestId('interview-build-trip').click();
  await expect(page).toHaveURL(new RegExp(`/trips/${tripId}/(build|itinerary)`), { timeout: 30_000 });
  await expect(page).toHaveURL(new RegExp(`/trips/${tripId}/itinerary(#[a-z-]+)?$`), { timeout: 420_000 });
  await expect(page.getByTestId('atlas-band')).toBeVisible({ timeout: 60_000 });

  await captureTrip(page, 'kyrgyzstan', tripId);
});

/**
 * §S — the Canadian Rockies, the other founder trip: a natural region rather
 * than a country, a Canadian jurisdiction, a Calgary gateway and known closures.
 */
test('V11 live: Canadian Rockies, one composition call, through the real stack', async ({ page }) => {
  test.setTimeout(480_000);
  const tripId = await createTrip(
    page,
    'Canadian Rockies',
    { start: '2026-07-10', end: '2026-07-18' },
    {
      party: 'couple',
      mustDo: 'The Icefields Parkway, Moraine Lake and Lake Louise. We fly into Calgary and out of Calgary, and we will hire a car.',
      avoid: 'Nothing that needs a permit we cannot get.',
    },
  );
  const rockiesSeen = await completeQuestionnaire(page, {
    priorities: ['Hiking', 'Scenic viewpoints', 'Lakes & rivers'],
    answers: {
      transport_mode: 'rent_car',
      effort: 'moderate',
      day_shape: 'two_three',
      budget: 'midrange',
      hike_appetite: 'half_day',
      lodging_style: 'basic_hotel',
      base_moves: 'move_if_it_saves_time',
    },
  });

  writeFileSync(`${OUT}/rockies-questions.txt`, `${rockiesSeen.join('\n')}\n`);
  expect(rockiesSeen, 'the scenario is about a hire car and a moderate pace').toEqual(
    expect.arrayContaining(['transport_mode', 'effort']),
  );

  await page.getByTestId('interview-build-trip').click();
  await expect(page).toHaveURL(new RegExp(`/trips/${tripId}/(build|itinerary)`), { timeout: 30_000 });
  await expect(page).toHaveURL(new RegExp(`/trips/${tripId}/itinerary(#[a-z-]+)?$`), { timeout: 420_000 });
  await expect(page.getByTestId('atlas-band')).toBeVisible({ timeout: 60_000 });

  await captureTrip(page, 'rockies', tripId);
});
