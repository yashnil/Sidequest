import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { expectNoHorizontalOverflow } from '../support/viewports';
import { openHubView } from '../support/hub';
import { waitUntilInteractive } from '../support/trip';
import {
  ARCHETYPES,
  CAR_FREE_MODES,
  Journey,
  REPRESENTATIVE,
  addCustomStop,
  adviseToTrip,
  answerInterview,
  assertEdgesLighter,
  assertIcsConsistent,
  assertPlanMatchesDates,
  bandAction,
  choose,
  durationIn,
  freshContext,
  minutesOf,
  moveStop,
  nightsOf,
  parseIcs,
  parseStay,
  pickEditTarget,
  prepareText,
  readBoard,
  readBookingLinks,
  readDayMap,
  readPlan,
  reject,
  reloadPlan,
  removeStop,
  revealBoard,
  setDuration,
  setUpTrip,
  settled,
  shoot,
  signIn,
  signOut,
  signature,
  statusMap,
  stopOn,
  undoLast,
  watchNetwork,
  type Archetype,
  type BoardCard,
  type EditTarget,
  type PlanDay,
} from './journey';

/** "Could not be scheduled", which sits under the days rather than on Prepare. */
async function unscheduledText(page: import('@playwright/test').Page): Promise<string> {
  await openHubView(page, 'days');
  return page.locator('#hub-view-days').innerText();
}

const CUSTOM_STOP = 'Journey coffee stop';
const PRIVATE_NOTE = 'JOURNEY-PRIVATE-NOTE-7731';
const PRIVATE_REF = 'JRN-CONF-5501';
const PRIVATE_COST = '4321';

/** Which archetypes each width walks in full. */
function archetypesFor(project: string): readonly Archetype[] {
  return project === 'desktop' ? ARCHETYPES : ARCHETYPES.filter((a) => REPRESENTATIVE.includes(a.id));
}

for (const arch of ARCHETYPES) {
  test(`journey: ${arch.label}`, async ({ page, browser }, testInfo) => {
    test.skip(!archetypesFor(testInfo.project.name).includes(arch), 'A representative three run at tablet and phone.');
    const width = page.viewportSize()!.width;
    const journey = new Journey(arch.id, width);
    watchNetwork(page);
    const photo = arch.id === 'tenerife-island' ? (name: string) => shoot(page, name, testInfo) : async () => undefined;
    let tripId = '';
    let destinationName = arch.destination;
    let cards: BoardCard[] = [];
    let manual: BoardCard | undefined;
    let rejected: BoardCard | undefined;
    let plan: PlanDay[] = [];
    let target: EditTarget | undefined;
    let editedSignature = '';
    let shareUrl = '';
    /* Whether this archetype's "no car" was actually offered and taken; on some destinations the survey offers only driving options. */
    let carFree = !arch.car;
    let transportEvidence = '';

    // ---------- Input ----------
    await journey.step('entry', async () => {
      if (arch.entry === 'advisor') {
        const { tripId: id, chosen } = await adviseToTrip(page, arch);
        tripId = id;
        destinationName = chosen;
        await photo('01-entry');
        return `advisor shortlist → Plan this on "${chosen}" → trip ${id}`;
      }
      tripId = await setUpTrip(page, arch);
      await photo('01-entry');
      return `door "${arch.entry}", trip ${tripId}, url ${page.url()}`;
    }, { critical: true });

    await journey.step('interview', async () => {
      await page.waitForLoadState('domcontentloaded');
      const { seen, transport, offered } = await answerInterview(page, tripId, arch);
      if (!arch.car) carFree = transport !== null && CAR_FREE_MODES.has(transport);
      transportEvidence = `transport answered "${transport ?? 'decided for me'}" of [${offered.join(', ')}]`;
      const facts = await page.getByTestId('review-facts').innerText();
      await photo('02-review');
      if (arch.entry === 'advisor') {
        expect(facts).toMatch(/\d+ nights?/i);
        return `questions: ${seen.length}; ${transportEvidence}; review: ${facts.replace(/\s+/g, ' ').slice(0, 200)}`;
      }
      expect(facts, 'the review states the nights').toContain(`${nightsOf(arch.dates)} night`);
      if (arch.party === 'family') expect(facts, 'the review states the children').toMatch(/2 child/i);
      await page.reload();
      await expect(page.getByTestId('interview-review')).toBeVisible({ timeout: 30_000 });
      return `questions: ${seen.join(',')}; ${transportEvidence}; review: ${facts.replace(/\s+/g, ' ').slice(0, 200)}; survives reload`;
    }, { critical: true });

    // ---------- Discovery ----------
    await journey.step('board-opens', async () => {
      const find = page.getByTestId('interview-find-places');
      await waitUntilInteractive(find);
      await find.click();
      await expect(page).toHaveURL(/\/discover$/, { timeout: 40_000 });
      await expect(page.getByTestId('board-summary')).toBeVisible({ timeout: 120_000 });
      await revealBoard(page);
      cards = await readBoard(page);
      const included = cards.filter((c) => c.status === 'included');
      expect(cards.length, 'the board holds places').toBeGreaterThan(5);
      expect(included.length, 'Sidequest arrives with picks').toBeGreaterThan(0);
      await photo('03-board');
      if (arch.entry === 'have_plan') {
        const critique = page.getByTestId('plan-critique');
        await expect(critique, 'an existing plan is checked on the board').toBeVisible();
        await expect(critique.locator('[data-kind="not_checked"]')).toContainText('Somewhere Nobody Has Heard Of');
      }
      return `${cards.length} places, ${included.length} chosen by Sidequest`;
    }, { critical: true });

    // ---------- Selection ----------
    await journey.step('auto-pick-changes-selections', async () => {
      /* Un-tick three of Sidequest's picks (never the traveller's must-do), so "Choose for me" has something real to do. */
      await revealBoard(page);
      const before = await readBoard(page);
      const unticked = before.filter((c) => c.status === 'included' && !(arch.mustDoStem && c.name.includes(arch.mustDoStem))).slice(0, 3);
      expect(unticked.length, 'picks to un-tick').toBeGreaterThan(0);
      for (const card of unticked) {
        const include = page.locator(`[data-place-card="${card.id}"]`).getByRole('button', { name: 'Include', exact: true }).first();
        await waitUntilInteractive(include);
        await include.click();
        await expect(page.locator(`[data-place-card="${card.id}"]`)).not.toHaveAttribute('data-status', 'included');
      }
      await settled(page);
      const beforeChoose = await readBoard(page);
      const auto = page.getByTestId('board-auto-pick');
      await waitUntilInteractive(auto);
      await auto.click();
      await expect.poll(async () => JSON.stringify(statusMap(await readBoard(page))), { timeout: 20_000, message: '"Choose for me" should change the board' }).not.toBe(JSON.stringify(statusMap(beforeChoose)));
      await settled(page);
      const after = await readBoard(page);
      for (const card of unticked) expect(statusMap(after)[card.id], `"${card.name}" stays out once the traveller took it out`).not.toBe('included');
      await page.reload();
      await revealBoard(page);
      expect(statusMap(await readBoard(page)), '"Choose for me" survives a reload').toEqual(statusMap(after));
      cards = after;
      const included = (list: readonly BoardCard[]) => list.filter((c) => c.status === 'included').length;
      return `un-ticked ${unticked.length}; "Choose for me" went from ${included(beforeChoose)} to ${included(after)} included, and survives a reload`;
    });

    await journey.step('manual-pick-and-rejection-persist', async () => {
      await revealBoard(page);
      cards = await readBoard(page);
      manual = cards.find((c) => c.status !== 'included' && !c.blocked);
      rejected = cards.find((c) => c.status === 'included' && c.id !== manual?.id && !(arch.mustDoStem && c.name.includes(arch.mustDoStem)));
      expect(manual, 'a place not yet chosen').toBeTruthy();
      expect(rejected, 'a chosen place to turn down').toBeTruthy();
      await choose(page, manual!.id, 'Include');
      await reject(page, rejected!.id);
      const before = statusMap(await readBoard(page));
      await page.reload();
      await revealBoard(page);
      const after = statusMap(await readBoard(page));
      expect(after[manual!.id]).toBe('included');
      expect(after[rejected!.id]).toBe('excluded');
      expect(after, 'every card as it was').toEqual(before);
      return `included "${manual!.name}", skipped "${rejected!.name}"; ${Object.keys(after).length} statuses identical after reload`;
    });

    await journey.step('auto-pick-respects-traveller', async () => {
      await page.getByTestId('board-auto-pick').click();
      await settled(page);
      await expect(page.getByTestId('board-auto-pick')).toBeEnabled({ timeout: 20_000 });
      await page.reload();
      await revealBoard(page);
      cards = await readBoard(page);
      const after = statusMap(cards);
      expect(after[manual!.id], 'your own pick stays').toBe('included');
      expect(after[rejected!.id], 'what you turned down stays down').toBe('excluded');
      return 'manual pick and rejection unchanged after a second "Choose for me"';
    });

    await journey.step('failure-injected-mid-build', async () => {
      const statuses = statusMap(cards);
      await page.route('**/discover', (route) => (route.request().method() === 'POST' ? route.abort('connectionreset') : route.continue()));
      try {
        const build = page.getByRole('button', { name: /^(Build my trip|Rebuild my trip)/ }).first();
        await waitUntilInteractive(build);
        await build.click();
        await expect(page.getByRole('alert').first(), 'a failed build says so').toBeVisible({ timeout: 20_000 });
        await expect(page).toHaveURL(/\/discover/);
      } finally {
        await page.unroute('**/discover');
      }
      await page.reload();
      await revealBoard(page);
      expect(statusMap(await readBoard(page)), 'nothing on the board was lost').toEqual(statuses);
      return `a build press whose request died showed an error and left all ${Object.keys(statuses).length} picks`;
    });

    // ---------- Planning ----------
    await journey.step('build', async () => {
      const build = page.getByRole('button', { name: /^(Build my trip|Rebuild my trip)/ }).first();
      await waitUntilInteractive(build);
      await build.click();
      await expect(page).toHaveURL(/\/itinerary(#.*)?$/, { timeout: 180_000 });
      await expect(page.getByTestId('atlas-band')).toBeVisible({ timeout: 30_000 });
      await photo('04-trip');
      await expectNoHorizontalOverflow(page, 'itinerary');
      return page.url();
    }, { critical: true });

    await journey.step('plan-dates-and-days', async () => {
      plan = await readPlan(page);
      await photo('05-days');
      if (arch.entry === 'advisor') {
        expect(plan.length).toBeGreaterThanOrEqual(2);
        return `${plan.length} days, ${plan[0]!.header} … ${plan.at(-1)!.header}`;
      }
      assertPlanMatchesDates(plan, arch.dates);
      return `${plan.length} days, ${plan[0]!.header} … ${plan.at(-1)!.header}`;
    }, { critical: true });

    await journey.step('plan-edges-lighter', async () => assertEdgesLighter(plan));

    await journey.step('picks-present-or-explained', async () => {
      const onPlan = new Set(plan.flatMap((d) => d.activities.map((a) => a.place)));
      const notes = `${await prepareText(page)}\n${await unscheduledText(page)}`;
      const included = cards.filter((c) => c.status === 'included');
      const missing = included.filter((c) => !onPlan.has(c.id));
      const unexplained = missing.filter((c) => !notes.includes(c.name));
      expect(unexplained.map((c) => c.name), 'every included place is on the plan or explained').toEqual([]);
      expect(onPlan.has(manual!.id) || notes.includes(manual!.name), `your pick "${manual!.name}" is present or explained`).toBe(true);
      expect(onPlan.has(rejected!.id), `what you turned down, "${rejected!.name}", stays off the plan`).toBe(false);
      return `${included.length - missing.length}/${included.length} on the plan, ${missing.length} explained`;
    });

    await journey.step('plan-stops-were-on-the-board-as-picks', async () => {
      const included = new Set(cards.filter((c) => c.status === 'included').map((c) => c.id));
      const known = new Set(cards.map((c) => c.id));
      const unticked = plan.flatMap((d) => d.activities).filter((a) => a.place && known.has(a.place) && !included.has(a.place));
      /* Not asserted: the planner's fillers (`FILLER_MIN_FIT`) top up a day from the untouched board by design. Recorded so a difference is visible. */
      return `${plan.flatMap((d) => d.activities).length} scheduled stops; ${unticked.length} added by the planner as fillers beyond the ticks${unticked.length ? `: ${unticked.map((a) => a.title).join(', ')}` : ''}`;
    });

    if (arch.mustDoStem) {
      await journey.step('must-dos-reach-the-plan', async () => {
        const onPlan = plan.flatMap((d) => d.activities.map((a) => a.title));
        const notes = `${await prepareText(page)}\n${await unscheduledText(page)}`;
        expect(onPlan.some((t) => t.includes(arch.mustDoStem!)), `"${arch.mustDoStem}" is on the plan`).toBe(true);
        expect(notes, 'a must-do nobody could place is explained, not dropped').toContain('The Bellweather Observatory');
        return `"${arch.mustDoStem}" scheduled; the unplaceable one is explained`;
      });
    }

    if (arch.entry === 'have_plan') {
      await journey.step('existing-plan-checked-not-replaced', async () => {
        await openHubView(page, 'prepare');
        const prepare = await prepareText(page);
        expect(prepare, 'the critique reaches the finished plan').toMatch(/Your plan, checked/);
        const titles = plan.flatMap((d) => d.activities.map((a) => a.title)).join('|');
        for (const named of [`${arch.destination} Old Quarter`, `${arch.destination} River Walk`]) expect(titles, `"${named}", named in the plan the traveller brought, is scheduled`).toContain(named);
        expect(prepare, 'a place the board could not check is called out').toContain('Somewhere Nobody Has Heard Of');
        return 'the plan they brought is critiqued on the finished trip and its places are scheduled';
      });
    }

    // ---------- Constraints ----------
    await journey.step('constraints-reach-the-plan', async () => {
      await openHubView(page, 'days');
      const said: string[] = [];
      if (carFree) {
        const driving = plan.flatMap((d) => d.travel.map((t) => t.text)).filter((t) => /\bdrive\b|\bdriving\b/i.test(t));
        expect(driving, 'no-car means no driving legs').toEqual([]);
        said.push('no driving legs');
      } else {
        said.push(arch.car ? 'car trip' : `no car-free option was offered here (${transportEvidence})`);
      }
      if (arch.needs?.includes('mobility_limited')) {
        const strenuous = plan.flatMap((d) => d.activities).filter((a) => /strenuous/i.test(a.text));
        expect(strenuous.map((a) => a.title), 'limited mobility keeps strenuous stops off the plan').toEqual([]);
        said.push('no strenuous stops');
      }
      if (arch.diet) {
        await openHubView(page, 'plan');
        await page.getByTestId('plan-tab-food').click();
        const food = await page.getByTestId('hub-food-section').innerText();
        expect(food.toLowerCase(), 'the diet appears on the food plan').toContain(arch.diet[0]!.toLowerCase());
        said.push(`diet on food plan`);
        await openHubView(page, 'days');
      }
      return said.join('; ');
    });

    // ---------- Booking links ----------
    await journey.step('booking-links', async () => {
      await settled(page);
      const links = await readBookingLinks(page);
      await photo('07-book');
      const stays = links.map((l) => parseStay(l.href)).filter((s): s is NonNullable<typeof s> => s !== null);
      const start = arch.entry === 'advisor' ? plan[0]! : undefined;
      expect(stays.length, 'at least one stay search').toBeGreaterThan(0);
      if (!start) {
        expect(stays[0]!.checkIn, 'first check-in is the arrival date').toBe(arch.dates.start);
        expect(stays.at(-1)!.checkOut, 'last check-out is the departure date').toBe(arch.dates.end);
      }
      for (let i = 1; i < stays.length; i += 1) expect(stays[i]!.checkIn, 'stays are consecutive').toBe(stays[i - 1]!.checkOut);
      if (arch.party === 'solo') expect(stays[0]!.adults).toBe('1');
      if (arch.party === 'couple') expect(stays[0]!.adults).toBe('2');
      if (arch.children) expect(stays[0]!.children, 'children reach the search').toBe(String(arch.children));
      for (const stay of stays) expect(stay.place.trim().length, 'the search names a place').toBeGreaterThan(1);
      const cars = links.filter((l) => /kayak|expedia/i.test(l.href));
      if (carFree) expect(cars.map((l) => l.href), 'no car, no car rental offer').toEqual([]);
      else if (arch.car) {
        expect(cars.length, 'a car trip offers a rental search').toBeGreaterThan(0);
        for (const car of cars) {
          const url = new URL(car.href);
          if (url.hostname.includes('kayak')) expect(url.pathname).toContain(`/${arch.dates.start}/${arch.dates.end}`);
          if (url.hostname.includes('expedia')) expect(decodeURIComponent(url.searchParams.get('date1') ?? '')).toBe(`${arch.dates.start.slice(5, 7)}/${arch.dates.start.slice(8, 10)}/${arch.dates.start.slice(0, 4)}`);
        }
      }
      const airbnb = links.filter((l) => /airbnb/.test(l.href)).map((l) => new URL(l.href));
      for (const url of airbnb) {
        expect(url.searchParams.get('checkin')).toBeTruthy();
        expect(url.searchParams.get('adults')).toBeTruthy();
        if (arch.children) expect(url.searchParams.get('children')).toBe(String(arch.children));
      }
      return `${links.length} links over ${stays.length} stays, ${stays[0]!.checkIn} → ${stays.at(-1)!.checkOut}, adults ${stays[0]!.adults}, children ${stays[0]!.children ?? 0}, ${cars.length} car searches`;
    });

    await journey.step('book-a-fact', async () => {
      await openHubView(page, 'plan');
      await page.getByTestId('booked-add').first().click();
      const form = page.getByTestId('booked-form');
      await form.getByTestId('booked-title').fill('Journey booked hotel');
      await form.getByTestId('booked-date').fill(arch.entry === 'advisor' ? await form.getByTestId('booked-date').inputValue() : arch.dates.start);
      await form.locator('input[name="confirmationRef"]').fill(PRIVATE_REF);
      await form.locator('input[name="costAmount"]').fill(PRIVATE_COST);
      await form.locator('input[name="notes"]').fill(PRIVATE_NOTE);
      await form.getByTestId('booked-save').click();
      await expect(page.locator('#hub-view-plan').getByTestId('booked-item')).toHaveCount(1, { timeout: 25_000 });
      return 'a booking with a reference, a cost and a note is on the trip';
    });

    // ---------- Editing ----------
    await journey.step('edit-move-undo-reload', async () => {
      target = await pickEditTarget(page);
      const before = await readPlan(page);
      const baseline = signature(before);
      const message = await moveStop(page, target);
      await undoLast(page);
      let after = await readPlan(page);
      expect(signature(after), 'Undo restores the plan').toBe(baseline);
      after = await reloadPlan(page);
      expect(signature(after), 'and it stays restored').toBe(baseline);
      await moveStop(page, target);
      after = await reloadPlan(page);
      expect(stopOn(after, target.toDay, target.place), `the stop is on day ${target.toDay}`).toBeTruthy();
      expect(stopOn(after, target.fromDay, target.place), `and not on day ${target.fromDay}`).toBeFalsy();
      plan = after;
      return `"${target.title}" day ${target.fromDay}→${target.toDay}: "${message}"; undo restored; re-applied and read back`;
    });

    await journey.step('edit-remove-undo-reload', async () => {
      const day = plan.find((d) => d.activities.filter((a) => a.place && a.place !== target!.place).length >= 1)!;
      const stop = day.activities.find((a) => a.place && a.place !== target!.place)!;
      const baseline = signature(plan);
      await openHubView(page, 'days');
      await removeStop(page, day.dayNumber, stop.place!);
      await undoLast(page);
      let after = await readPlan(page);
      expect(signature(after), 'Undo restores the plan').toBe(baseline);
      after = await reloadPlan(page);
      expect(signature(after)).toBe(baseline);
      await removeStop(page, day.dayNumber, stop.place!);
      after = await reloadPlan(page);
      expect(stopOn(after, day.dayNumber, stop.place!), 'the stop is gone').toBeFalsy();
      plan = after;
      return `"${stop.title}" removed from day ${day.dayNumber}; undo restored; re-applied and read back`;
    });

    await journey.step('edit-add-custom-undo-reload', async () => {
      const dayNumber = plan[1]!.dayNumber;
      const baseline = signature(plan);
      await addCustomStop(page, dayNumber, CUSTOM_STOP, 60);
      await undoLast(page);
      let after = await readPlan(page);
      expect(signature(after), 'Undo restores the plan').toBe(baseline);
      after = await reloadPlan(page);
      expect(signature(after)).toBe(baseline);
      await addCustomStop(page, dayNumber, CUSTOM_STOP, 60);
      after = await reloadPlan(page);
      expect(after.find((d) => d.dayNumber === dayNumber)!.text, 'the custom stop is on the day').toContain(CUSTOM_STOP);
      plan = after;
      return `"${CUSTOM_STOP}" added to day ${dayNumber}; undo restored; re-applied and read back`;
    });

    await journey.step('edit-duration-undo-reload', async () => {
      const day = plan.find((d) => d.activities.some((a) => a.place && a.place !== target!.place))!;
      const stop = day.activities.find((a) => a.place && a.place !== target!.place)!;
      const original = minutesOf(durationIn(stop.text));
      const wanted = original === 90 ? 120 : 90;
      const baseline = signature(plan);
      const message = await setDuration(page, day.dayNumber, stop.place!, wanted);
      await undoLast(page);
      let after = await readPlan(page);
      expect(signature(after), 'Undo restores the plan').toBe(baseline);
      after = await reloadPlan(page);
      expect(signature(after)).toBe(baseline);
      await setDuration(page, day.dayNumber, stop.place!, wanted);
      after = await reloadPlan(page);
      expect(minutesOf(durationIn(stopOn(after, day.dayNumber, stop.place!)!.text)), `"${stop.title}" lasts ${wanted} min`).toBe(wanted);
      plan = after;
      editedSignature = signature(after);
      return `"${stop.title}" ${original}→${wanted} min: "${message}"; undo restored; re-applied and read back`;
    });

    await journey.step('failure-injected-mid-edit', async () => {
      const before = signature(await readPlan(page));
      const day = plan.find((d) => d.activities.some((a) => a.place))!;
      const stop = day.activities.find((a) => a.place)!;
      await page.route('**/itinerary', (route) => (route.request().method() === 'POST' ? route.abort('connectionreset') : route.continue()));
      try {
        const row = page.locator(`#hub-view-days [data-timeline-place="${stop.place}"][data-day="${day.dayNumber}"]`);
        await row.scrollIntoViewIfNeeded();
        await row.getByTestId('stop-menu').click();
        await row.getByRole('menuitem', { name: /Remove from this day/ }).click();
        await expect(row.getByRole('alert').first(), 'a failed edit says so, in place').toBeVisible({ timeout: 20_000 });
        await expect(row.getByRole('alert').first()).toContainText(/could not reach/i);
      } finally {
        await page.unroute('**/itinerary');
      }
      const after = signature(await reloadPlan(page));
      expect(after, 'the plan is exactly as it was').toBe(before);
      return 'an edit whose request died said so and changed nothing';
    });

    // ---------- Map ----------
    await journey.step('map-pins-match-day-stops', async () => {
      await settled(page);
      const placed = plan.filter((d) => d.activities.some((a) => a.place));
      const checked: string[] = [];
      for (const day of placed.slice(0, 4)) {
        const map = await readDayMap(page, day.dayNumber);
        const stops = day.activities.filter((a) => a.place).map((a) => a.place!);
        expect([...map.markers].sort(), `day ${day.dayNumber}: pins and stops`).toEqual([...stops].sort());
        const named = day.activities.filter((a) => a.place).map((a) => a.title);
        for (const title of named) expect(map.list.join('\n'), `day ${day.dayNumber} names ${title}`).toContain(title);
        checked.push(`day ${day.dayNumber}: ${map.markers.length}`);
      }
      await photo('06-map');
      return `pins per day — ${checked.join(', ')}`;
    });

    // ---------- Exports ----------
    await journey.step('ics-download', async () => {
      await settled(page);
      const link = await bandAction(page, 'Calendar file (.ics)');
      const [download] = await Promise.all([page.waitForEvent('download'), link.click()]);
      expect(download.suggestedFilename()).toMatch(/\.ics$/);
      const text = readFileSync(await download.path(), 'utf8');
      const ics = parseIcs(text);
      const dates = arch.entry === 'advisor' ? { start: ics.events.map((e) => e.startDate).sort()[0]!, end: ics.events.map((e) => e.startDate).sort().at(-1)! } : arch.dates;
      const consistent = assertIcsConsistent(ics, dates, '.ics');
      const activities = plan.flatMap((d) => d.activities);
      expect(ics.events.length, 'at least one event per scheduled stop').toBeGreaterThanOrEqual(activities.length);
      for (const leak of [PRIVATE_NOTE, PRIVATE_REF, PRIVATE_COST]) expect(ics.unfolded, `"${leak}" must not leave in the calendar`).not.toContain(leak);
      expect(ics.events.some((e) => e.summary.includes(CUSTOM_STOP)), 'the custom stop is in the calendar').toBe(true);
      expect(ics.unfolded, 'a removed stop is not').not.toMatch(/SUMMARY:(?!Booked).*\bJourney removed\b/);
      return consistent;
    });

    await journey.step('calendar-feed', async () => {
      await page.goto(`/trips/${tripId}/pack`);
      await photo('08-pack');
      const create = page.getByTestId('pack-feed-create');
      await waitUntilInteractive(create);
      await create.click();
      const field = page.getByTestId('pack-feed-url');
      await expect(field).toBeVisible({ timeout: 20_000 });
      const url = await field.inputValue();
      expect(url).toMatch(/\/api\/calendar\//);
      const stranger = await freshContext(browser, testInfo);
      const response = await stranger.context.request.get(url);
      expect(response.status()).toBe(200);
      const ics = parseIcs(await response.text());
      expect(ics.events.length, 'the feed carries the plan').toBeGreaterThan(0);
      for (const leak of [PRIVATE_NOTE, PRIVATE_REF, PRIVATE_COST]) expect(ics.unfolded, `"${leak}" must not leave in the feed`).not.toContain(leak);
      await page.getByTestId('pack-feed-revoke').click();
      await page.getByTestId('pack-feed-revoke').click();
      await expect(page.getByTestId('pack-feed')).toHaveAttribute('data-active', 'false', { timeout: 20_000 });
      const dead = await stranger.context.request.get(url);
      expect(dead.status(), 'a revoked feed returns nothing').toBe(404);
      await stranger.context.close();
      return `feed served ${ics.events.length} events with no private fields, and 404 after revoke`;
    });

    await journey.step('print-packet', async () => {
      await page.addInitScript(() => {
        (window as unknown as { __printed: number }).__printed = 0;
        window.print = () => {
          (window as unknown as { __printed: number }).__printed += 1;
        };
      });
      await page.goto(`/trips/${tripId}/itinerary?print=1`);
      await expect.poll(() => page.evaluate(() => (window as unknown as { __printed: number }).__printed), { timeout: 20_000, message: 'the page opens the print dialog' }).toBeGreaterThan(0);
      await page.emulateMedia({ media: 'print' });
      for (const day of plan) await expect(page.getByTestId(`day-card-${day.dayNumber}`), `day ${day.dayNumber} prints`).toBeVisible();
      await expect(page.getByTestId('stop-menu').first(), 'edit controls do not print').toBeHidden();
      const pdf = await page.pdf({ printBackground: true });
      expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
      const pages = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;
      expect(pages, 'the packet has pages').toBeGreaterThanOrEqual(plan.length > 3 ? 2 : 1);
      await page.emulateMedia({ media: 'screen' });
      await page.goto(`/trips/${tripId}/itinerary`);
      return `${plan.length} days visible in print media, a ${pages}-page PDF, window.print called`;
    });

    await journey.step('map-links', async () => {
      await openHubView(page, 'days');
      const checked: string[] = [];
      for (const day of plan) {
        const link = page.getByTestId(`day-route-${day.dayNumber}`);
        if ((await link.count()) === 0) continue;
        const url = new URL((await link.getAttribute('href'))!);
        expect(url.hostname).toBe('www.google.com');
        expect(url.pathname).toBe('/maps/dir/');
        const origin = url.searchParams.get('origin') ?? '';
        const destination = url.searchParams.get('destination') ?? '';
        expect(origin, 'origin is a coordinate').toMatch(/^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/);
        expect(destination, 'destination is a coordinate').toMatch(/^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/);
        const waypoints = (url.searchParams.get('waypoints') ?? '').split('|').filter(Boolean);
        const placed = day.activities.filter((a) => a.place).length;
        expect(waypoints.length + 2, `day ${day.dayNumber} route carries each placed stop`).toBeGreaterThanOrEqual(Math.min(placed, 2));
        expect(waypoints.length + 2, `day ${day.dayNumber} route is not longer than the day`).toBeLessThanOrEqual(placed + 1);
        if (carFree) expect(url.searchParams.get('travelmode'), 'no-car route is not a driving route').not.toBe('driving');
        checked.push(`d${day.dayNumber}:${waypoints.length + 2}`);
        const apple = page.getByTestId(`day-notes-${day.dayNumber}`).getByRole('link', { name: 'Open the day there', includeHidden: true });
        const appleHref = await apple.getAttribute('href');
        expect(new URL(appleHref!).hostname).toBe('maps.apple.com');
      }
      expect(checked.length, 'at least one day has a route link').toBeGreaterThan(0);
      return `Google/Apple links well-formed: ${checked.join(', ')}`;
    });

    // ---------- Share ----------
    await journey.step('share-link', async () => {
      await page.goto(`/trips/${tripId}/itinerary`);
      const share = await bandAction(page, 'Share this plan');
      await waitUntilInteractive(share);
      await share.click();
      const field = page.getByLabel('Share link');
      await expect(field).toBeVisible({ timeout: 20_000 });
      shareUrl = await field.inputValue();
      const reader = await freshContext(browser, testInfo);
      await reader.page.goto(shareUrl);
      await expect(reader.page.getByText('Shared with you')).toBeVisible();
      const shared = await readPlan(reader.page);
      await shoot(reader.page, `09-share`, testInfo).catch(() => undefined);
      expect(shared.length, 'every day is shared').toBe(plan.length);
      expect(shared.map((d) => d.activities.map((a) => a.place)), 'the shared copy shows the same stops').toEqual(plan.map((d) => d.activities.map((a) => a.place)));
      const html = await reader.page.content();
      const body = (await reader.page.locator('body').innerText()).toLowerCase();
      expect(html, 'the trip id is not in the shared page').not.toContain(tripId);
      for (const leak of [PRIVATE_NOTE, PRIVATE_REF]) expect(html, `"${leak}" must not reach a shared copy`).not.toContain(leak);
      expect(body, 'a stranger does not see money the traveller spent').not.toContain(PRIVATE_COST);
      if (arch.diet) expect(body, 'the party’s diet is not in the shared copy').not.toContain(arch.diet[0]!.toLowerCase());
      await expect(reader.page.getByRole('button', { name: /^Change / })).toHaveCount(0);
      await expect(reader.page.getByText('Calendar file (.ics)')).toHaveCount(0);
      await reader.context.close();
      return `a fresh browser sees all ${shared.length} days and stops, no private fields, no edit controls`;
    });

    await journey.step('share-revoked-dies', async () => {
      const revoke = page.getByTestId('share-revoke');
      await revoke.click();
      await revoke.click();
      await expect(page.getByTestId('share-revoked')).toBeVisible({ timeout: 20_000 });
      const reader = await freshContext(browser, testInfo);
      const response = await reader.page.goto(shareUrl);
      expect(response?.status(), 'a revoked link is a 404').toBe(404);
      await reader.context.close();
      return 'revoked link 404s in a fresh browser';
    });

    // ---------- Reopen ----------
    await journey.step('reopen-with-saved-cookie', async () => {
      await page.goto(`/trips/${tripId}/itinerary`);
      const owner = signature(await readPlan(page));
      const state = await page.context().storageState();
      const again = await freshContext(browser, testInfo, state);
      await again.page.goto(`/trips/${tripId}/itinerary`);
      expect(signature(await readPlan(again.page)), 'the identical plan').toBe(owner);
      expect(owner, 'and it is the edited one').toBe(editedSignature);
      await again.context.close();
      return 'a new context with the saved cookie sees the identical, edited plan';
    });

    await journey.step('sign-out-and-back-in-keeps-trip', async () => {
      const email = `${arch.id}-${width}-${Date.now()}@example.com`;
      await signIn(page, email, 'Journey Owner');
      const claim = page.getByTestId('claim-trips');
      await expect(claim).toBeVisible({ timeout: 20_000 });
      await claim.click();
      await expect(page.getByTestId('claim-banner')).toHaveCount(0, { timeout: 20_000 });
      await signOut(page);
      await page.goto(`/trips/${tripId}/itinerary`);
      await expect(page.locator('body'), 'signed out, the trip is closed').not.toContainText(plan[0]!.activities[0]?.title ?? destinationName, { timeout: 15_000 });
      await signIn(page, email);
      await page.goto(`/trips/${tripId}/itinerary`);
      expect(signature(await readPlan(page)), 'signing back in keeps the plan').toBe(editedSignature);
      return 'sign out closed it, sign in reopened the identical plan';
    });

    await journey.step('second-user-cannot-open', async () => {
      const stranger = await freshContext(browser, testInfo);
      await signIn(stranger.page, `stranger-${arch.id}-${width}-${Date.now()}@example.com`, 'Stranger');
      const response = await stranger.page.goto(`/trips/${tripId}/itinerary`);
      await expect(stranger.page.getByTestId('atlas-band'), 'another account never sees the trip').toHaveCount(0);
      const body = await stranger.page.locator('body').innerText();
      for (const day of plan) for (const stop of day.activities) expect(body, `another account learns nothing about "${stop.title}"`).not.toContain(stop.title);
      await expect(stranger.page.getByRole('heading').first()).toBeVisible();
      const heading = await stranger.page.getByRole('heading').first().innerText();
      await stranger.context.close();
      return `another account: HTTP ${response?.status()}, page reads "${heading}"`;
    });

    expect(journey.failures, `${arch.id} at ${width}: ${journey.failures.length} step(s) failed:\n${journey.failures.join('\n\n')}`).toEqual([]);
  });
}
