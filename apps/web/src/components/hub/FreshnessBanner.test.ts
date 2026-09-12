import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { FactObservation, SplitPlan, VolatileFact } from '@sidequest/core';

/**
 * V9 §9 / §17 — THE BANNER AND THE SPLIT CARD, AS DOCUMENTS.
 *
 * Rendered statically: what a traveller sees before any effect runs. The
 * server actions are stubbed so importing the banner opens no database; the
 * mount-time recheck is a browser effect and is proven in `recheck.test.ts`
 * and the browser suite, not here.
 */
vi.mock('@/lib/execution/recheck-actions', () => ({
  recheckStaleFactsAction: async () => ({ ok: true, outcome: { ran: false, skipped: 'recent', lastCheckedAt: null }, observations: [] }),
  acknowledgeChangeAction: async () => ({ ok: true }),
}));

const NOW = Date.parse('2026-08-01T12:00:00.000Z');

const observation = (overrides: Partial<FactObservation> = {}): FactObservation => ({
  id: 'obs-1',
  factId: 'fact:forecast:3',
  kind: 'forecast',
  observedAt: '2026-08-01T12:00:00.000Z',
  previous: 'Clear, 8–22 °C, 3% chance of rain.',
  current: 'rain, 8–20 °C, 76% chance of rain',
  changed: true,
  dayNumbers: [3],
  summary: 'Day 3 now expects rain in the afternoon (76% chance); it was dry when the plan was built.',
  acknowledgedAt: null,
  ...overrides,
});

const fact = (overrides: Partial<VolatileFact> = {}): VolatileFact => ({
  id: 'fact:forecast:3',
  kind: 'forecast',
  subject: 'Day 3',
  readAt: '2026-07-30T12:00:00.000Z',
  staleAfterHours: 24,
  stale: true,
  recheckable: true,
  dayNumbers: [3],
  detail: 'Clear.',
  ...overrides,
});

describe('the freshness banner', () => {
  it('lists each open change with a proposal and an acknowledgement, under the headline', async () => {
    const { FreshnessBanner } = await import('./FreshnessBanner');
    const html = renderToStaticMarkup(createElement(FreshnessBanner, { tripId: 't1', observations: [observation(), observation({ id: 'obs-2', factId: 'fact:hours:i9', kind: 'hours', dayNumbers: [2], summary: 'The museum on day 2 is now closed on that date; it was open at the planned time when the plan was built.' })], volatile: [], lastCheckedAt: '2026-08-01T11:00:00.000Z', headline: '2 things changed since this trip was planned.', now: NOW }));
    expect(html).toContain('data-testid="freshness-banner"');
    expect(html).toContain('2 things changed since this trip was planned.');
    expect(html.match(/data-testid="freshness-change"/g)).toHaveLength(2);
    expect(html.match(/data-testid="freshness-propose"/g)).toHaveLength(2);
    expect(html.match(/data-testid="freshness-acknowledge"/g)).toHaveLength(2);
    expect(html).toContain('data-kind="hours"');
    expect(html).toContain('Your plan has not been changed.');
    expect(html).not.toContain('freshness-checking');
  });

  it('renders nothing when nothing changed and nothing is due', async () => {
    const { FreshnessBanner } = await import('./FreshnessBanner');
    const html = renderToStaticMarkup(createElement(FreshnessBanner, { tripId: 't1', observations: [observation({ acknowledgedAt: '2026-08-01T13:00:00.000Z' })], volatile: [fact({ stale: false })], lastCheckedAt: null, headline: null, now: NOW }));
    expect(html).toBe('');
  });

  it('shows the quiet checking line from the first paint when a check is due', async () => {
    const { FreshnessBanner } = await import('./FreshnessBanner');
    const html = renderToStaticMarkup(createElement(FreshnessBanner, { tripId: 't1', observations: [], volatile: [fact()], lastCheckedAt: null, headline: null, now: NOW }));
    expect(html).toContain('data-testid="freshness-checking"');
    expect(html).toContain('Checking what changed…');
  });

  it('asks only when something stale is answerable and no check ran in the last six hours', async () => {
    const { shouldRecheck, RECHECK_AFTER_HOURS } = await import('./FreshnessBanner');
    expect(shouldRecheck({ lastCheckedAt: null, volatile: [fact()], now: NOW })).toBe(true);
    expect(shouldRecheck({ lastCheckedAt: null, volatile: [], now: NOW })).toBe(false);
    expect(shouldRecheck({ lastCheckedAt: null, volatile: [fact({ recheckable: false })], now: NOW })).toBe(false);
    expect(shouldRecheck({ lastCheckedAt: null, volatile: [fact({ stale: false })], now: NOW })).toBe(false);
    expect(shouldRecheck({ lastCheckedAt: new Date(NOW - (RECHECK_AFTER_HOURS - 1) * 3_600_000).toISOString(), volatile: [fact()], now: NOW })).toBe(false);
    expect(shouldRecheck({ lastCheckedAt: new Date(NOW - (RECHECK_AFTER_HOURS + 1) * 3_600_000).toISOString(), volatile: [fact()], now: NOW })).toBe(true);
  });

  it('proposes a change in the traveller’s words, from the observation alone', async () => {
    const { proposalFor } = await import('./FreshnessBanner');
    expect(proposalFor(observation())).toBe('Day 3 now expects rain, 8–20 °C, 76% chance of rain: swap the outdoor blocks for the indoor backup and keep the rest of the day.');
    expect(proposalFor(observation({ current: 'clear, 10–24 °C, 3% chance of rain' }))).toContain("Day 3's forecast changed to clear");
    expect(proposalFor(observation({ kind: 'hours', dayNumbers: [2], summary: 'The museum on day 2 is now closed on that date; it was open at the planned time when the plan was built.' }))).toBe('The museum on day 2 is now closed on that date; it was open at the planned time when the plan was built. Move it to a time it is open, or replace it on day 2.');
  });

  it('raises the same event name the hub’s Ask trigger raises', async () => {
    const source = await import('node:fs').then((fs) => fs.readFileSync(new URL('./FreshnessBanner.tsx', import.meta.url), 'utf8'));
    const { ASK_OPEN_EVENT } = await import('./HubShell');
    expect(source).toContain(`const ASK_OPEN = '${ASK_OPEN_EVENT}'`);
    const split = await import('node:fs').then((fs) => fs.readFileSync(new URL('./SplitPlanCard.tsx', import.meta.url), 'utf8'));
    expect(split).toContain(`const ASK_OPEN = '${ASK_OPEN_EVENT}'`);
  });
});

describe('the split card', () => {
  const plan: SplitPlan = {
    dayNumber: 4,
    groups: [
      { who: 'Mum', does: 'the lakeside walk and a long lunch' },
      { who: 'The others', does: 'the ridge hike' },
    ],
    rejoin: 'at the lodge by 17:00',
    transportNote: 'The day moves by car: one car cannot serve both halves, so the second group needs its own way or the rejoin point is where the car is.',
    bookingsNote: 'Booked today: Gondola tickets — say which half it belongs to.',
  };

  it('renders the groups, the rejoin, the transport reading and the bookings note', async () => {
    const { SplitPlanCard } = await import('./SplitPlanCard');
    const html = renderToStaticMarkup(createElement(SplitPlanCard, { plan, tripId: 't1' }));
    expect(html).toContain('data-testid="split-plan-4"');
    expect(html.match(/data-testid="split-group"/g)).toHaveLength(2);
    expect(html).toContain('the lakeside walk and a long lunch');
    expect(html).toContain('at the lodge by 17:00');
    expect(html).toContain('one car cannot serve both halves');
    expect(html).toContain('Gondola tickets');
    expect(html).not.toContain('split-suggest-4');
  });

  it('offers a different split only when the page says the party has a difference to split over', async () => {
    const { SplitPlanCard } = await import('./SplitPlanCard');
    const { splitRequestFor } = await import('./split-request');
    const html = renderToStaticMarkup(createElement(SplitPlanCard, { plan, tripId: 't1', canSuggest: true }));
    expect(html).toContain('data-testid="split-suggest-4"');
    expect(splitRequestFor(4, plan)).toBe('Plan a split for day 4: Mum take a gentler half while the others keep the day as written, and say where and when everyone meets again.');
    expect(splitRequestFor(2)).toMatch(/^Plan a split for day 2: /);
  });
});
