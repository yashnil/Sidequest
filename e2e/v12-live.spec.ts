import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { completeQuestionnaire, createTrip } from './support/trip';
import { openHubView } from './support/hub';

/**
 * V12 §55 §56 §57 — THE THREE LIVE ACCEPTANCES.
 *
 * Run only from `playwright.v12-live.config.ts`, which starts the app on the
 * real provider stack. Everything else about V12 is proven deterministically —
 * the context matrix, the failure corpus, the mode-consistency gate, the
 * calendar layer — because all of it is pure. What only a real model can show is
 * whether a **composition envelope carrying an operating model** produces a trip
 * that is recognisably that kind of trip.
 *
 * **Exactly one Anthropic call each.** No retry, no critic, no repair: the
 * architecture forbids all three and the config sets `retries: 0`, so a failure
 * is a failure rather than a second call.
 *
 * Each scenario is chosen to be a different *operating family*, because a pass
 * where all three came back as the same shape of trip would prove nothing.
 */

const OUT = '.claude-private/artifacts/v12/live';
mkdirSync(OUT, { recursive: true });

async function captureTrip(page: Page, slug: string, tripId: string, seen: string[]): Promise<void> {
  writeFileSync(`${OUT}/${slug}-trip-id.txt`, `${tripId}\n`);
  writeFileSync(`${OUT}/${slug}-questions.txt`, `${seen.join('\n')}\n`);
  await page.screenshot({ path: `${OUT}/${slug}-01-hub.png`, fullPage: true, animations: 'disabled' });
  for (const view of ['days', 'map', 'book', 'prepare'] as const) {
    await openHubView(page, view);
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${OUT}/${slug}-${view}.png`, fullPage: true, animations: 'disabled' });
  }
}

/**
 * §55 — four young friends, twelve days, fit, moderate budget, backpacks,
 * hostels welcome, culture and hiking, high adventure, buses and trains fine,
 * interested in a multi-day trek, willing to rough it, does not want luxury.
 */
test('V12 live: overland backpacking, one composition call', async ({ page }) => {
  test.setTimeout(480_000);
  const tripId = await createTrip(
    page,
    'Peru',
    { start: '2026-06-06', end: '2026-06-18' },
    {
      party: 'friends',
      mustDo: 'A multi-day trek, and time in the towns. Hostels and guesthouses are fine. We will use buses and trains; we are not hiring a car.',
      avoid: 'Nothing luxurious. No private transfers we do not need.',
    },
  );
  const seen = await completeQuestionnaire(page, {
    strict: true,
    priorities: ['Hiking', 'Neighbourhoods & local life', 'Markets & street food'],
    /* Being among the place is the reason for the trip; the trek is most days of it. */
    interestRoles: { neighbourhoods_and_local_life: 'build_around', hiking: 'most_days', markets_and_street_food: 'couple' },
    answers: {
      transport_mode: 'transit_walk',
      effort: 'intense',
      budget: 'cheap',
      lodging_style: 'hostel',
      rustic_lodging: 'yes',
      base_moves: 'move_freely',
      hike_appetite: 'full_day',
      coverage_strategy: 'breadth',
      free_time: 'balanced',
    },
  });
  writeFileSync(`${OUT}/backpacking-questions.txt`, `${seen.join('\n')}\n`);

  await page.getByTestId('interview-build-trip').click();
  await expect(page).toHaveURL(new RegExp(`/trips/${tripId}/(build|itinerary)`), { timeout: 30_000 });
  await expect(page).toHaveURL(new RegExp(`/trips/${tripId}/itinerary(#[a-z-]+)?$`), { timeout: 420_000 });
  await expect(page.getByTestId('atlas-band')).toBeVisible({ timeout: 60_000 });

  await captureTrip(page, 'backpacking', tripId, seen);
});

/**
 * §56 — a couple, seven nights, moderate-high budget, relaxation is the primary
 * goal, beach and snorkelling, low activity density, good food, a comfortable
 * resort, willing to do one or two excursions.
 */
test('V12 live: resort relaxation, one composition call', async ({ page }) => {
  test.setTimeout(480_000);
  const tripId = await createTrip(
    page,
    'Maldives',
    { start: '2026-11-07', end: '2026-11-14' },
    {
      party: 'couple',
      mustDo: 'Rest. Beach and snorkelling, good food, one or two excursions at most. One resort unless there is a real reason to split.',
      avoid: 'Sightseeing schedules. Moving around. Early starts.',
    },
  );
  const seen = await completeQuestionnaire(page, {
    strict: true,
    priorities: ['Beaches & swimming'],
    interestRoles: { beaches_and_swimming: 'build_around' },
    answers: {
      /*
       * V12 finding — no `boats_transfers` option here either.
       *
       * An atoll nation whose every transfer is a boat or a seaplane offers
       * `rent_car · no_car · transit_walk · mixed`, the generic fallback: the
       * screening did not read it as an archipelago and the country has no
       * compiled reality. A hire car is the *first* option offered. "No car" is
       * the only honest answer available.
       */
      transport_mode: 'no_car',
      effort: 'light',
      budget: 'premium',
      base_moves: 'stay_put',
      free_time: 'lots',
      day_shape: 'one_big',
      lodging_style: 'resort',
      coverage_strategy: 'depth',
    },
  });

  await page.getByTestId('interview-build-trip').click();
  await expect(page).toHaveURL(new RegExp(`/trips/${tripId}/(build|itinerary)`), { timeout: 30_000 });
  await expect(page).toHaveURL(new RegExp(`/trips/${tripId}/itinerary(#[a-z-]+)?$`), { timeout: 420_000 });
  await expect(page.getByTestId('atlas-band')).toBeVisible({ timeout: 60_000 });

  await captureTrip(page, 'resort', tripId, seen);
});

/**
 * §57 — seven to nine days, gorilla trekking is the primary goal, wildlife and
 * culture secondary, comfortable but not ultra-luxury, willing to use a driver
 * and guide, moderate to high activity, recovery after hard activity matters.
 */
test('V12 live: guided wildlife, one composition call', async ({ page }) => {
  test.setTimeout(480_000);
  const tripId = await createTrip(
    page,
    'Rwanda',
    { start: '2026-08-14', end: '2026-08-22' },
    {
      party: 'couple',
      mustDo: 'Gorilla trekking is the reason for the trip. Wildlife and local culture around it. A driver and guide throughout; we are not self-driving.',
      avoid: 'Ultra-luxury. Anything that needs a permit we cannot get.',
    },
  );
  const seen = await completeQuestionnaire(page, {
    strict: true,
    priorities: ['Wildlife', 'Hiking', 'History & culture'],
    /* The permit is the trip; hiking is how you reach it; culture is around it. */
    interestRoles: { wildlife: 'build_around', hiking: 'couple', history_and_culture: 'couple' },
    answers: {
      /*
       * V12 finding — there is no `guided` option here.
       *
       * `transport_mode` builds its options from the country's compiled travel
       * reality, and only twenty-nine countries have one. Rwanda has none, so
       * the shape-based fallback offers `rent_car · no_car · transit_walk ·
       * mixed` — and a trip whose whole premise is a driver and a permit-led
       * guide has to be expressed as "no car". `guide_willingness` below is
       * what actually carries the intent.
       */
      transport_mode: 'no_car',
      effort: 'moderate',
      budget: 'midrange',
      guide_willingness: 'prefer',
      hike_appetite: 'half_day',
      base_moves: 'move_if_it_saves_time',
      permit_activities: 'build_around',
    },
  });

  await page.getByTestId('interview-build-trip').click();
  await expect(page).toHaveURL(new RegExp(`/trips/${tripId}/(build|itinerary)`), { timeout: 30_000 });
  await expect(page).toHaveURL(new RegExp(`/trips/${tripId}/itinerary(#[a-z-]+)?$`), { timeout: 420_000 });
  await expect(page.getByTestId('atlas-band')).toBeVisible({ timeout: 60_000 });

  await captureTrip(page, 'wildlife', tripId, seen);
});
