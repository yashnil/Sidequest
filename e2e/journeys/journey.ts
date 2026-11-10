import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expect, type Browser, type BrowserContext, type Locator, type Page, type TestInfo } from '@playwright/test';
import { addDays, dayLabel, seasonalTrip, type TripDates } from '../support/dates';
import { continueButton, currentInterviewQuestion, waitUntilInteractive } from '../support/trip';
import { openHubView, openPrepareNotes, openPrepareReference, bandAction } from '../support/hub';
import { answerUntilShortlist, startAdvisor } from '../support/advisor';

/**
 * THE TRAVELLER, FROM IDEA TO A TRIP THEY CAN KEEP.
 *
 * "Input → Discovery → Selection → Planning → Itinerary → Editing → Saving →
 * Exporting → Reopening." One driver walks it for every archetype; each step
 * asserts what is actually true afterwards — the stored board after a reload, the
 * parsed calendar file, the query string of a booking link — and records its
 * result into the evidence file. A step that fails does not hide the steps after
 * it, because a report of one failure says nothing about the other fifteen.
 */

export type PartyShape = 'solo' | 'couple' | 'friends' | 'family';

export interface Archetype {
  id: string;
  label: string;
  entry: 'known' | 'advisor' | 'have_plan';
  /** What the traveller types (or, through the advisor, the request they make). */
  destination: string;
  /** A place on the fixture board named in "must not miss", so a must-do can be followed to the plan. */
  mustDoStem?: string;
  dates: TripDates;
  party: PartyShape;
  children?: number;
  needs?: readonly string[];
  car: boolean;
  priorities: readonly string[];
  pace: string;
  effort: string;
  budget: string;
  diet?: readonly string[];
  /** The advisor's request carries dates; it lands on the plan step and asks nothing more. */
  advisorRequest?: string;
}

/* Dates are computed, never written: each stays a plan ahead of the clock, in its own season. */
export const ARCHETYPES: readonly Archetype[] = [
  { id: 'tenerife-island', label: 'Tenerife island', entry: 'known', destination: 'Tenerife', mustDoStem: 'Tenerife Castle', dates: seasonalTrip({ month: 5, day: 10, days: 7 }), party: 'couple', car: false, priorities: ['Hiking', 'Scenic viewpoints'], pace: 'two_three', effort: 'moderate', budget: 'midrange' },
  { id: 'iceland-road-trip', label: 'Iceland road trip', entry: 'known', destination: 'Iceland', mustDoStem: 'Iceland Hot Springs', dates: seasonalTrip({ month: 6, day: 15, days: 9 }), party: 'friends', car: true, priorities: ['Scenic viewpoints', 'Hot springs'], pace: 'two_three', effort: 'moderate', budget: 'premium' },
  { id: 'tokyo-kyoto-transit', label: 'Tokyo and Kyoto by public transit', entry: 'known', destination: 'Tokyo and Kyoto', dates: seasonalTrip({ month: 4, day: 3, days: 10 }), party: 'couple', car: false, priorities: ['History & culture', 'Markets & street food'], pace: 'two_three', effort: 'easy', budget: 'midrange', diet: ['Vegetarian'] },
  { id: 'kyrgyzstan-remote', label: 'Kyrgyzstan remote adventure', entry: 'known', destination: 'Kyrgyzstan', dates: seasonalTrip({ month: 7, day: 8, days: 12 }), party: 'solo', car: false, priorities: ['Hiking', 'Lakes & rivers'], pace: 'one_big', effort: 'hard', budget: 'budget' },
  { id: 'safari', label: 'A safari', entry: 'advisor', destination: 'safari', advisorRequest: 'A safari to see big animals in August, about 8 nights, midrange budget.', dates: seasonalTrip({ month: 8, day: 10, days: 9 }), party: 'couple', car: false, priorities: ['Wildlife', 'Scenic viewpoints'], pace: 'two_three', effort: 'moderate', budget: 'premium' },
  { id: 'european-city-break', label: 'A European city break', entry: 'have_plan', destination: 'Lisbon', mustDoStem: 'Lisbon Old Quarter', dates: seasonalTrip({ month: 10, day: 8, days: 4 }), party: 'couple', car: false, priorities: ['History & culture', 'Markets & street food'], pace: 'two_three', effort: 'easy', budget: 'midrange' },
  { id: 'us-national-park', label: 'A US national park', entry: 'known', destination: 'Yosemite National Park', dates: seasonalTrip({ month: 6, day: 20, days: 6 }), party: 'friends', car: true, priorities: ['Hiking', 'Scenic viewpoints'], pace: 'two_three', effort: 'hard', budget: 'midrange' },
  { id: 'family-young-children', label: 'A family with young children', entry: 'known', destination: 'Costa Rica', dates: seasonalTrip({ month: 2, day: 12, days: 8 }), party: 'family', children: 2, needs: ['young_children'], car: true, priorities: ['Wildlife', 'Beaches'], pace: 'one_two', effort: 'easy', budget: 'midrange', diet: ['Vegetarian'] },
  { id: 'accessible-low-intensity', label: 'Accessible, low-intensity travel', entry: 'known', destination: 'Vienna', mustDoStem: 'Vienna City Museum', dates: seasonalTrip({ month: 9, day: 12, days: 5 }), party: 'couple', needs: ['mobility_limited'], car: false, priorities: ['Museums', 'History & culture'], pace: 'one_two', effort: 'easy', budget: 'premium' },
  { id: 'winter-sports', label: 'Winter sports', entry: 'advisor', destination: 'winter sports', advisorRequest: 'Skiing in the Alps in late January for a week, midrange budget.', dates: seasonalTrip({ month: 1, day: 23, days: 7 }), party: 'friends', car: false, priorities: ['Skiing', 'Scenic viewpoints'], pace: 'two_three', effort: 'hard', budget: 'midrange' },
];

export const REPRESENTATIVE = ['tenerife-island', 'tokyo-kyoto-transit', 'family-young-children'];

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

export const EVIDENCE_PATH = 'docs/release-candidate/final/journeys.json';
export const SCREENS_DIR = 'docs/release-candidate/final/screens';

export interface EvidenceRow { journey: string; step: string; width: number; result: 'pass' | 'fail' | 'skipped'; evidence: string }

function readEvidence(): EvidenceRow[] {
  try {
    return JSON.parse(readFileSync(EVIDENCE_PATH, 'utf8')) as EvidenceRow[];
  } catch {
    return [];
  }
}

export function recordEvidence(row: EvidenceRow): void {
  mkdirSync(dirname(EVIDENCE_PATH), { recursive: true });
  const rows = readEvidence().filter((r) => !(r.journey === row.journey && r.step === row.step && r.width === row.width));
  rows.push(row);
  rows.sort((a, b) => a.width - b.width || a.journey.localeCompare(b.journey));
  writeFileSync(EVIDENCE_PATH, `${JSON.stringify(rows, null, 2)}\n`);
}

/**
 * A viewport-only JPEG, stepped down in quality until it fits the 250 KB budget.
 * The clips are per surface so a reader can scan each width's set.
 */
export async function shoot(page: Page, name: string, testInfo: TestInfo): Promise<void> {
  const width = page.viewportSize()?.width ?? 0;
  const folder = width >= 1024 ? 'desktop' : width >= 640 ? 'tablet' : 'phone';
  const dir = join(SCREENS_DIR, folder);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.jpg`);
  for (const quality of [72, 60, 45, 30, 22]) {
    await page.screenshot({ path, type: 'jpeg', quality, timeout: 20_000 });
    if (statSync(path).size <= 250_000) return;
  }
  await testInfo.attach(`oversize-${name}`, { path, contentType: 'image/jpeg' });
}

// ---------------------------------------------------------------------------
// Runner: one step, one row
// ---------------------------------------------------------------------------

export class Journey {
  readonly failures: string[] = [];
  readonly width: number;
  /** Set once a step that everything after depends on has failed. */
  private blocked = false;
  constructor(readonly id: string, width: number) {
    this.width = width;
  }

  async step(step: string, work: () => Promise<string | void>, { critical = false }: { critical?: boolean } = {}): Promise<void> {
    if (this.blocked) {
      recordEvidence({ journey: this.id, step, width: this.width, result: 'skipped', evidence: 'A step this one depends on failed.' });
      return;
    }
    try {
      const evidence = await work();
      recordEvidence({ journey: this.id, step, width: this.width, result: 'pass', evidence: evidence ?? 'ok' });
    } catch (error) {
      const message = error instanceof Error ? error.message.replace(/\u001b\[[0-9;]*m/g, '').slice(0, 1200) : String(error);
      this.failures.push(`${step}: ${message}`);
      recordEvidence({ journey: this.id, step, width: this.width, result: 'fail', evidence: message });
      if (critical) this.blocked = true;
    }
  }
}

// ---------------------------------------------------------------------------
// Waiting
// ---------------------------------------------------------------------------

const inFlight = new WeakMap<Page, { count: number }>();

/** Count this page's own requests from the first navigation on. `waitForLoadState('networkidle')` fires once per document and then answers immediately, so it cannot see a server action. */
export function watchNetwork(page: Page): void {
  const state = { count: 0 };
  inFlight.set(page, state);
  const relevant = (request: { resourceType(): string }) => request.resourceType() === 'fetch' || request.resourceType() === 'xhr' || request.resourceType() === 'document';
  page.on('request', (request) => { if (relevant(request)) state.count += 1; });
  page.on('requestfinished', (request) => { if (relevant(request)) state.count -= 1; });
  page.on('requestfailed', (request) => { if (relevant(request)) state.count -= 1; });
}

/**
 * The page has stopped talking to the server: no fetch or document request open
 * for 500 ms. A reload before a server action has answered would be testing the
 * network, not the product.
 */
export async function settled(page: Page, budget = 6_000): Promise<void> {
  const state = inFlight.get(page);
  if (!state) throw new Error('watchNetwork was not called on this page.');
  const deadline = Date.now() + budget;
  let quietSince = Date.now();
  while (Date.now() < deadline) {
    if (state.count > 0) quietSince = Date.now();
    else if (Date.now() - quietSince >= 500) return;
    await page.waitForTimeout(100);
  }
}

// ---------------------------------------------------------------------------
// Entry: setup, the interview, the review
// ---------------------------------------------------------------------------

export function tripIdOf(page: Page): string {
  const id = /\/trips\/([^/?#]+)\//.exec(page.url())?.[1];
  if (!id) throw new Error(`No trip id in ${page.url()}`);
  return id;
}

export function nightsOf(dates: TripDates): number {
  return Math.round((Date.parse(`${dates.end}T00:00:00Z`) - Date.parse(`${dates.start}T00:00:00Z`)) / 86_400_000);
}

/** Walk the setup flow the way a traveller does, starting from the homepage door. */
export async function setUpTrip(page: Page, arch: Archetype): Promise<string> {
  await page.goto('/');
  if (arch.entry === 'have_plan') {
    await page.getByRole('link', { name: 'I already have a plan' }).click();
    await expect(page).toHaveURL(/\/trips\/new\?have=plan/);
  } else {
    await page.getByRole('link', { name: 'I know where I want to go' }).first().click();
    await expect(page).toHaveURL(/\/trips\/new/);
  }
  const field = page.getByTestId('destination-input');
  await waitUntilInteractive(field);
  await field.fill(arch.destination);
  await continueButton(page).click();
  await expect(page.getByTestId('timing-exact')).toBeVisible();
  await page.getByTestId('timing-exact').click();
  await page.getByTestId('timing-start').fill(arch.dates.start);
  await page.getByTestId('timing-end').fill(arch.dates.end);
  await continueButton(page).click();
  await page.getByTestId(`party-${arch.party}`).click();
  if (arch.children !== undefined) {
    const shown = page.getByTestId('count-children');
    for (let guard = 0; guard < 8 && Number(await shown.innerText()) !== arch.children; guard += 1) {
      const fewer = Number(await shown.innerText()) > arch.children;
      await page.getByRole('button', { name: fewer ? 'One fewer children'.replace('children', 'child') : 'One more child' }).first().click();
    }
    await expect(shown).toHaveText(String(arch.children));
  }
  for (const need of arch.needs ?? []) {
    await page.locator('label.ob-tag', { hasText: NEED_LABEL[need] ?? need }).first().click();
  }
  await continueButton(page).click();
  await expect(page.getByTestId('setup-flow')).toHaveAttribute('data-step', 'fixed');
  if (arch.entry === 'have_plan') {
    const p = arch.destination;
    await page.getByTestId('setup-existing-plan').fill(`Day 1: ${p} Old Quarter, ${p} Cathedral, ${p} City Museum, ${p} Central Market, ${p} Castle, ${p} Art Gallery\nDay 2: ${p} River Walk\nDay 3: Somewhere Nobody Has Heard Of`);
  }
  if (arch.mustDoStem) await page.getByLabel(/Booked, fixed, or would regret missing/).fill(`${arch.mustDoStem}\nThe Bellweather Observatory`);
  await continueButton(page).click();
  await page.waitForURL(/\/trips\/[^/]+\/(plan|questionnaire)/, { timeout: 30_000 });
  return tripIdOf(page);
}

/** Help me choose: a request, the questions, and "Plan this trip" on the first pick. */
export async function adviseToTrip(page: Page, arch: Archetype): Promise<{ tripId: string; chosen: string }> {
  await page.goto('/');
  await page.getByRole('link', { name: 'Help me choose' }).first().click();
  await expect(page).toHaveURL(/\/decide$/);
  await startAdvisor(page, arch.advisorRequest);
  await answerUntilShortlist(page);
  const picks = page.getByTestId('advisor-pick');
  await expect(picks.first()).toBeVisible();
  const chosen = (await picks.first().getByRole('heading', { level: 3 }).innerText()).trim();
  const go = page.getByRole('button', { name: `Plan a trip to ${chosen}` });
  await waitUntilInteractive(go);
  await go.click();
  await page.waitForURL(/\/trips\/[^/]+\/(plan|questionnaire|setup)/, { timeout: 40_000 });
  return { tripId: tripIdOf(page), chosen };
}

const NEED_LABEL: Record<string, RegExp> = {
  mobility_limited: /mobility|walking/i,
  young_children: /young children|toddler|small children/i,
};

/** Which transport option a no-car traveller should take, in preference order. */
const NO_CAR_MODES = ['transit_walk', 'no_car', 'rail_transfers', 'taxis', 'guided', 'boats_transfers', 'mixed'];
const CAR_MODES = ['rent_car', 'self_drive', 'mixed'];

/** Answers the survey from the archetype; everything unstated is handed to Sidequest. */
export async function answerInterview(page: Page, tripId: string, arch: Archetype): Promise<{ seen: string[]; transport: string | null; offered: string[] }> {
  if (!/\/questionnaire/.test(page.url())) await page.goto(`/trips/${tripId}/questionnaire`);
  await expect(page.getByTestId('interview')).toBeVisible({ timeout: 30_000 });
  const start = page.getByTestId('interview-start');
  if (await start.isVisible().catch(() => false)) {
    await waitUntilInteractive(start);
    await start.click();
  }
  const seen: string[] = [];
  let transport: string | null = null;
  let offered: string[] = [];
  const fixed: Record<string, string[]> = {
    day_shape: [arch.pace, 'two_three'],
    effort: [arch.effort, 'moderate', 'easy'],
    budget: [arch.budget, 'midrange'],
    transport_mode: arch.car ? CAR_MODES : NO_CAR_MODES,
    base_moves: ['move_if_it_saves_time'],
  };
  const answerOnScreen = async (): Promise<boolean> => {
    for (let turn = 0; turn < 40; turn += 1) {
      if (await page.getByTestId('interview-review').isVisible().catch(() => false)) return true;
      const id = await currentInterviewQuestion(page);
      if (!id) {
        await page.waitForTimeout(200);
        continue;
      }
      if (seen.at(-1) === id) {
        await page.waitForTimeout(150);
        continue;
      }
      seen.push(id);
      const screen = page.getByTestId(`interview-question-${id}`);
      await waitUntilInteractive(page.getByTestId('interview-decide'));
      if (id === 'priorities') {
        for (const label of arch.priorities) {
          let chip = screen.getByRole('checkbox', { name: label, exact: true });
          if ((await chip.count()) === 0) {
            const more = page.getByTestId('interview-more-interests');
            if (await more.isVisible().catch(() => false)) await more.click();
            chip = screen.getByRole('checkbox', { name: label, exact: true });
          }
          if ((await chip.count()) > 0) await chip.first().check();
        }
        await page.getByTestId('interview-continue').click();
        await expect(screen).toBeHidden({ timeout: 15_000 });
        continue;
      }
      if (id === 'dietary' && arch.diet) {
        for (const label of arch.diet) await screen.getByRole('checkbox', { name: label, exact: true }).first().check();
        await page.getByTestId('interview-continue').click();
        await expect(screen).toBeHidden({ timeout: 15_000 });
        continue;
      }
      let answered = false;
      if (id === 'transport_mode') offered = await screen.locator('input[type=radio]').evaluateAll((nodes) => nodes.map((node) => (node as HTMLInputElement).value));
      for (const value of fixed[id] ?? []) {
        const radio = screen.locator(`input[type=radio][value="${value}"]`);
        if ((await radio.count()) > 0) {
          await radio.first().check();
          await page.getByTestId('interview-continue').click();
          answered = true;
          if (id === 'transport_mode') transport = value;
          break;
        }
      }
      if (!answered) await page.getByTestId('interview-decide').click();
      await expect(screen).toBeHidden({ timeout: 15_000 });
    }
    return page.getByTestId('interview-review').isVisible();
  };
  expect(await answerOnScreen(), 'the interview should reach its review').toBe(true);
  if (arch.diet && !seen.includes('dietary')) {
    await page.getByTestId('interview-personalize').click();
    expect(await answerOnScreen(), 'the personalised round should reach the review').toBe(true);
    expect(seen, 'a dietary question should be reachable').toContain('dietary');
  }
  return { seen, transport, offered };
}

/** The modes that genuinely mean the traveller has no car of their own at the wheel. */
export const CAR_FREE_MODES: ReadonlySet<string> = new Set(['transit_walk', 'no_car', 'rail_transfers', 'taxis', 'guided', 'boats_transfers']);

// ---------------------------------------------------------------------------
// Board
// ---------------------------------------------------------------------------

export interface BoardCard { id: string; name: string; status: string; blocked: boolean }

export async function readBoard(page: Page): Promise<BoardCard[]> {
  await expect(page.getByTestId('board-summary')).toBeVisible({ timeout: 120_000 });
  return page.locator('[data-place-card]').evaluateAll((cards) =>
    cards.map((card) => ({
      id: card.getAttribute('data-place-card') ?? '',
      name: (card.querySelector('h3')?.textContent ?? '').trim(),
      status: card.getAttribute('data-status') ?? 'undecided',
      blocked: Boolean(card.querySelector('button[disabled]')),
    })),
  );
}

function card(page: Page, id: string): Locator {
  return page.locator(`[data-place-card="${id}"]`);
}

/** Show every place, whichever group it is folded into. */
export async function revealBoard(page: Page): Promise<void> {
  const toggles = page.locator('[data-testid="discovery-board"] details:not([open]) > summary');
  for (let index = (await toggles.count()) - 1; index >= 0; index -= 1) {
    const summary = toggles.nth(index);
    if (await summary.isVisible().catch(() => false)) await summary.click().catch(() => undefined);
  }
}

/** A card's own decision button, whether it is a full card or a compact "Probably skip" row. */
function decision(page: Page, id: string, name: 'Include' | 'Maybe' | 'Skip'): Locator {
  return card(page, id).getByRole('button', { name, exact: true }).first();
}

export async function choose(page: Page, id: string, option: 'Include' | 'Maybe'): Promise<void> {
  const button = decision(page, id, option);
  await waitUntilInteractive(button);
  await button.click();
  await expect(card(page, id)).toHaveAttribute('data-status', option === 'Include' ? 'included' : 'maybe', { timeout: 15_000 });
  await settled(page);
}

export async function reject(page: Page, id: string): Promise<void> {
  const button = decision(page, id, 'Skip');
  await waitUntilInteractive(button);
  await button.click();
  const reasons = card(page, id).getByTestId('card-pass-reasons');
  if (await reasons.isVisible().catch(() => false)) await reasons.getByRole('button').first().click();
  await expect(card(page, id)).toHaveAttribute('data-status', 'excluded', { timeout: 15_000 });
  await settled(page);
}

export function statusMap(cards: readonly BoardCard[]): Record<string, string> {
  return Object.fromEntries(cards.map((c) => [c.id, c.status]));
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export interface PlanRow { kind: string; place: string | null; title: string; text: string }
export interface PlanDay { dayNumber: number; header: string; activities: PlanRow[]; travel: PlanRow[]; meals: PlanRow[]; text: string }

/** The itinerary as the page shows it, read from the Days view. Works on an owner's page and on a shared copy. */
export async function readPlan(page: Page): Promise<PlanDay[]> {
  await openHubView(page, 'days');
  await expect(page.locator('#hub-view-days article[data-testid^="day-card-"]').first()).toBeVisible({ timeout: 30_000 });
  return page.locator('#hub-view-days article[data-testid^="day-card-"]').evaluateAll((cards) =>
    cards.map((card) => {
      const dayNumber = Number((card.getAttribute('data-testid') ?? '').replace('day-card-', ''));
      const text = (card as HTMLElement).innerText;
      const rows = [...card.querySelectorAll<HTMLElement>('[data-row-kind]')].map((row) => {
        const heading = row.querySelector<HTMLElement>('[data-testid="stop-open-sheet"], h3, h4');
        const menu = row.querySelector('[data-testid="stop-menu"]')?.getAttribute('aria-label')?.replace(/^Change /, '');
        return {
          kind: row.getAttribute('data-row-kind') ?? '',
          place: row.getAttribute('data-timeline-place'),
          title: (menu ?? heading?.innerText ?? row.innerText.split('\n')[0] ?? '').trim(),
          text: row.innerText,
        };
      });
      return {
        dayNumber,
        header: (/DAY\s+\d+\s*·[^\n]+/i.exec(text)?.[0] ?? '').trim(),
        activities: rows.filter((r) => r.kind === 'activity'),
        travel: rows.filter((r) => r.kind === 'travel'),
        meals: rows.filter((r) => r.kind === 'meal'),
        text,
      };
    }),
  );
}

export function signature(plan: readonly PlanDay[]): string {
  return JSON.stringify(plan.map((d) => ({ header: d.header, stops: d.activities.map((a) => `${a.place ?? ''}|${a.title}|${durationIn(a.text)}`) })));
}

export function durationIn(text: string): string {
  return /\b\d+\s*hr(?:\s+\d+\s*min)?\b|\b\d+\s*min\b/.exec(text.replace(/≈\d+[^\n]*/g, ''))?.[0] ?? '';
}

export function minutesOf(duration: string): number {
  const h = /(\d+)\s*hr/.exec(duration);
  const m = /(\d+)\s*min/.exec(duration);
  return (h ? Number(h[1]) * 60 : 0) + (m ? Number(m[1]) : 0);
}

export function dayMinutes(day: PlanDay): number {
  return day.activities.reduce((total, a) => total + minutesOf(durationIn(a.text)), 0);
}

export function expectedHeader(dates: TripDates, dayNumber: number): string {
  const label = dayLabel(addDays(dates.start, dayNumber - 1)); // "Wed 12 Aug"
  return label.toUpperCase();
}

export function assertPlanMatchesDates(plan: readonly PlanDay[], dates: TripDates): void {
  const nights = nightsOf(dates);
  expect(plan.length, `a ${nights}-night trip has ${nights + 1} days`).toBe(nights + 1);
  plan.forEach((day, index) => {
    expect(day.dayNumber, 'days are numbered in order').toBe(index + 1);
    expect(day.header.toUpperCase(), `day ${day.dayNumber}'s date`).toContain(expectedHeader(dates, day.dayNumber));
  });
}

export function assertEdgesLighter(plan: readonly PlanDay[]): string {
  const middle = plan.slice(1, -1);
  const first = plan[0]!;
  const last = plan.at(-1)!;
  if (middle.length === 0) return 'no middle day to compare';
  const busiest = Math.max(...middle.map(dayMinutes));
  const busiestStops = Math.max(...middle.map((d) => d.activities.length));
  expect(dayMinutes(first), `arrival day (${dayMinutes(first)} min) should be lighter than the busiest day (${busiest} min)`).toBeLessThan(busiest);
  expect(dayMinutes(last), `departure day (${dayMinutes(last)} min) should be lighter than the busiest day (${busiest} min)`).toBeLessThan(busiest);
  expect(first.activities.length, 'arrival day stops').toBeLessThanOrEqual(busiestStops);
  expect(last.activities.length, 'departure day stops').toBeLessThanOrEqual(busiestStops);
  return `arrival ${dayMinutes(first)} min / ${first.activities.length} stops, departure ${dayMinutes(last)} min / ${last.activities.length} stops, busiest ${busiest} min / ${busiestStops} stops`;
}

export async function prepareText(page: Page): Promise<string> {
  await openHubView(page, 'prepare');
  await openPrepareNotes(page).catch(() => undefined);
  await openPrepareReference(page).catch(() => undefined);
  await page.locator('#hub-view-prepare details:not([open]) > summary').evaluateAll((all) => all.forEach((s) => (s as HTMLElement).click()));
  return page.locator('#hub-view-prepare').innerText();
}

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

function rowsOf(page: Page, dayNumber: number): Locator {
  return page.locator(`#hub-view-days [data-timeline-place][data-day="${dayNumber}"][data-row-kind="activity"]`);
}

async function rowFor(page: Page, dayNumber: number, placeId: string): Promise<Locator> {
  const row = page.locator(`#hub-view-days [data-timeline-place="${placeId}"][data-day="${dayNumber}"]`);
  await expect(row).toHaveCount(1, { timeout: 15_000 });
  await row.scrollIntoViewIfNeeded();
  return row;
}

async function openMenu(row: Locator): Promise<void> {
  const button = row.getByTestId('stop-menu');
  await waitUntilInteractive(button);
  await button.click();
  await expect(button).toHaveAttribute('aria-expanded', 'true');
}

async function openDayControls(row: Locator): Promise<Locator> {
  await openMenu(row);
  const controls = row.getByTestId('stop-day-controls');
  await controls.getByRole('button', { name: /Move, re-time or keep/ }).click();
  return controls;
}

/** The toast that says what changed, once the page has shown it. */
async function expectToast(page: Page): Promise<string> {
  const toast = page.getByTestId('edit-toast');
  await expect(toast).toHaveAttribute('data-state', 'shown', { timeout: 25_000 });
  return page.getByTestId('edit-toast-message').innerText();
}

export async function undoLast(page: Page): Promise<void> {
  const undo = page.getByTestId('edit-toast-undo');
  await expect(undo).toBeVisible({ timeout: 15_000 });
  await undo.click();
  await expect(page.getByTestId('edit-toast-message')).toContainText(/Undone|back as it was|restored/i, { timeout: 25_000 });
  await settled(page);
}

export interface EditTarget { fromDay: number; toDay: number; place: string; title: string }

export async function pickEditTarget(page: Page): Promise<EditTarget> {
  const plan = await readPlan(page);
  const dayWithStops = plan.find((d) => d.dayNumber > 1 && d.dayNumber < plan.length && d.activities.filter((a) => a.place).length >= 2) ?? plan.find((d) => d.activities.some((a) => a.place))!;
  expect(dayWithStops, 'a day with stops to edit').toBeTruthy();
  const stop = dayWithStops.activities.find((a) => a.place)!;
  const toDay = dayWithStops.dayNumber === plan.length ? 1 : dayWithStops.dayNumber + 1;
  return { fromDay: dayWithStops.dayNumber, toDay, place: stop.place!, title: stop.title };
}

export async function moveStop(page: Page, target: EditTarget): Promise<string> {
  const row = await rowFor(page, target.fromDay, target.place);
  const controls = await openDayControls(row);
  await controls.getByTestId('stop-move-day').selectOption(String(target.toDay));
  const message = await expectToast(page);
  await expect(page.locator(`#hub-view-days [data-timeline-place="${target.place}"][data-day="${target.toDay}"]`)).toHaveCount(1, { timeout: 25_000 });
  await settled(page);
  return message;
}

export async function removeStop(page: Page, dayNumber: number, placeId: string): Promise<string> {
  const row = await rowFor(page, dayNumber, placeId);
  await openMenu(row);
  await row.getByRole('menuitem', { name: /Remove from this day/ }).click();
  const message = await expectToast(page);
  await expect(page.locator(`#hub-view-days [data-timeline-place="${placeId}"][data-day="${dayNumber}"]`)).toHaveCount(0, { timeout: 25_000 });
  await settled(page);
  return message;
}

export async function addCustomStop(page: Page, dayNumber: number, title: string, minutes: number): Promise<string> {
  const day = page.getByTestId(`day-edit-${dayNumber}`);
  await day.scrollIntoViewIfNeeded();
  if ((await day.getAttribute('open')) === null) await day.locator(':scope > summary').click();
  await day.getByTestId('add-stop-open').click();
  await day.getByTestId('add-stop-title').fill(title);
  await day.locator('input[name="minutes"]').fill(String(minutes));
  await day.getByTestId('add-stop-submit').click();
  const message = await expectToast(page);
  await expect(page.locator(`#hub-view-days [data-testid="day-card-${dayNumber}"]`).getByText(title).first()).toBeVisible({ timeout: 25_000 });
  await settled(page);
  return message;
}

export async function setDuration(page: Page, dayNumber: number, placeId: string, minutes: number): Promise<string> {
  const row = await rowFor(page, dayNumber, placeId);
  const controls = await openDayControls(row);
  await controls.getByTestId('stop-minutes').fill(String(minutes));
  await controls.getByTestId('stop-minutes').press('Enter');
  const message = await expectToast(page);
  await settled(page);
  return message;
}

export function stopOn(plan: readonly PlanDay[], dayNumber: number, placeId: string): PlanRow | undefined {
  return plan.find((d) => d.dayNumber === dayNumber)?.activities.find((a) => a.place === placeId);
}

/** Back to the Days view after a hard reload. */
export async function reloadPlan(page: Page): Promise<PlanDay[]> {
  await page.reload();
  return readPlan(page);
}

// ---------------------------------------------------------------------------
// Map
// ---------------------------------------------------------------------------

export async function readDayMap(page: Page, dayNumber: number): Promise<{ markers: string[]; list: string[] }> {
  await openHubView(page, 'map');
  await page.getByTestId(`map-day-${dayNumber}`).click();
  const workspace = page.getByTestId('map-workspace');
  await expect(workspace).toHaveAttribute('data-map-mode', 'day');
  await expect(workspace).toHaveAttribute('data-day', String(dayNumber));
  const stage = page.locator('#hub-view-map').getByTestId('trip-overview-map');
  await expect(stage.locator('svg[aria-roledescription="map"]').first()).toHaveAttribute('aria-label', new RegExp(`on day ${dayNumber}`), { timeout: 15_000 });
  const markers = await stage.locator('[data-marker]').evaluateAll((nodes) =>
    nodes.map((n) => ({ id: n.getAttribute('data-marker') ?? '', kind: n.querySelector('[data-marker-kind]')?.getAttribute('data-marker-kind') ?? '' })),
  );
  const list = await stage.getByTestId('map-list-equivalent').locator('li').allInnerTexts();
  return {
    markers: markers.filter((m) => m.kind !== 'base' && m.kind !== 'gateway' && !m.id.startsWith('scan-base-')).map((m) => m.id),
    list,
  };
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

export interface BookingLinkRead { row: string; label: string; href: string }

export async function readBookingLinks(page: Page): Promise<BookingLinkRead[]> {
  await openHubView(page, 'book');
  const rows = page.getByTestId('booking-suggestion');
  await expect(rows.first()).toBeVisible({ timeout: 15_000 });
  const out: BookingLinkRead[] = [];
  for (const row of await rows.all()) {
    const title = (await row.innerText()).split('\n')[0] ?? '';
    for (const link of await row.getByTestId('booking-link').all()) {
      out.push({ row: title, label: (await link.innerText()).split('\n')[0]!.trim(), href: (await link.getAttribute('href')) ?? '' });
    }
  }
  return out;
}

export interface StayRange { place: string; checkIn: string; checkOut: string; adults: string | null; children: string | null }

export function parseStay(href: string): StayRange | null {
  const url = new URL(href);
  if (!url.hostname.endsWith('booking.com')) return null;
  return {
    place: url.searchParams.get('ss') ?? '',
    checkIn: url.searchParams.get('checkin') ?? '',
    checkOut: url.searchParams.get('checkout') ?? '',
    adults: url.searchParams.get('group_adults'),
    children: url.searchParams.get('group_children'),
  };
}

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

export interface IcsEvent { uid: string; summary: string; description: string; dtstart: string; dtend: string; startDate: string; raw: string }
export interface IcsRead { events: IcsEvent[]; timezones: string[]; unfolded: string }

export function parseIcs(text: string): IcsRead {
  expect(text.startsWith('BEGIN:VCALENDAR'), 'a calendar starts with BEGIN:VCALENDAR').toBe(true);
  expect(text.trimEnd().endsWith('END:VCALENDAR'), 'and ends with END:VCALENDAR').toBe(true);
  expect(text, 'lines end CRLF').toContain('\r\n');
  const unfolded = text.replace(/\r\n[ \t]/g, '');
  const timezones = [...unfolded.matchAll(/^TZID:(.+)$/gm)].map((m) => m[1]!.trim());
  const events = [...unfolded.matchAll(/BEGIN:VEVENT\r\n([\s\S]*?)END:VEVENT/g)].map((m) => {
    const raw = m[1]!;
    const field = (name: string): string => new RegExp(`^${name}[^:\\r\\n]*:(.*)$`, 'm').exec(raw)?.[1]?.trim() ?? '';
    const dtstart = field('DTSTART');
    const date = dtstart.slice(0, 8);
    return { uid: field('UID'), summary: field('SUMMARY'), description: field('DESCRIPTION'), dtstart, dtend: field('DTEND'), startDate: `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`, raw };
  });
  return { events, timezones, unfolded };
}

export function assertIcsConsistent(ics: IcsRead, dates: TripDates, label: string): string {
  expect(ics.events.length, `${label}: has events`).toBeGreaterThan(0);
  expect(new Set(ics.events.map((e) => e.uid)).size, `${label}: every UID is unique`).toBe(ics.events.length);
  expect(ics.timezones.length, `${label}: declares a time zone`).toBeGreaterThan(0);
  for (const event of ics.events) {
    expect(event.startDate >= dates.start && event.startDate <= dates.end, `${label}: "${event.summary}" on ${event.startDate} is inside the trip`).toBe(true);
    expect(event.raw, `${label}: "${event.summary}" carries a time zone`).toMatch(/DTSTART;TZID=|DTSTART;VALUE=DATE/);
    expect(event.dtstart, `${label}: "${event.summary}" is not in UTC`).not.toMatch(/Z$/);
  }
  return `${ics.events.length} events, TZ ${ics.timezones[0]}`;
}

// ---------------------------------------------------------------------------
// People and contexts
// ---------------------------------------------------------------------------

export async function signIn(page: Page, email: string, name?: string): Promise<void> {
  await page.goto('/signin');
  const door = page.getByTestId('signin-fixture');
  await expect(door).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('signin-email').fill(email);
  if (name) await page.getByTestId('signin-name').fill(name);
  await page.getByTestId('signin-submit').click();
  await page.waitForURL(/\/trips(\?|$)/, { timeout: 30_000 });
  await expect(page.getByTestId('nav-account')).toBeVisible();
}

export async function signOut(page: Page): Promise<void> {
  await page.getByTestId('nav-account').locator('summary').click();
  await page.getByTestId('nav-signout').click();
  await page.waitForURL(/\/$/, { timeout: 15_000 });
}

export interface PageContext { context: BrowserContext; page: Page }

export async function freshContext(browser: Browser, testInfo: TestInfo, storageState?: Awaited<ReturnType<BrowserContext['storageState']>>): Promise<PageContext> {
  const context = await browser.newContext({
    baseURL: testInfo.project.use.baseURL!,
    viewport: testInfo.project.use.viewport ?? { width: 1440, height: 900 },
    ...(storageState ? { storageState } : {}),
  });
  return { context, page: await context.newPage() };
}

export { bandAction };
