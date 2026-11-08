import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { planTrip } from '@sidequest/planner';
import { buildScenario } from '../../../../packages/planner/src/testing/scenario';
import { EASTERN_SIERRA, EASTERN_SIERRA_PLACES } from '../../../../packages/core/src/data/index';
import { buildLedger, buildNextActions, buildPreflight, buildTripStateGraph, deriveDecisions, type Itinerary } from '@sidequest/core';
import { ItineraryView } from './ItineraryView';

/**
 * V9 — THE HUB LEADS WITH WHAT TO DO, AND SPEAKS THE TRAVELLER'S LANGUAGE.
 *
 * Rendered on the server from the deterministic fixture plan plus the
 * execution layer derived exactly as the view model derives it (state graph,
 * next actions, Preflight, decisions, ledger) — offline, no provider, a fixed
 * clock. Owner and shared copies both: the owner gets the actions and the
 * ticks, the reader gets the same plan and none of the controls, and neither
 * reads a forensic word.
 */
vi.mock('@/app/(product)/trips/[id]/itinerary/edit-controls', () => ({
  EaseDayButton: () => null,
  PrintExpand: () => null,
  StopEditMenu: () => null,
  RegenerateButton: () => null,
}));
vi.mock('@/app/(product)/trips/[id]/itinerary/share-controls', () => ({ ShareControl: () => null }));
vi.mock('./PrintButton', () => ({ PrintButton: () => null }));

const NOW = new Date('2026-07-20T09:00:00.000Z');
const TRIP_ID = 'trip-v9-render';

const PLAN: Itinerary = (() => {
  const result = planTrip(buildScenario());
  if (!result.ok) throw new Error(`the fixture scenario did not plan: ${result.code}`);
  return result.itinerary;
})();

const COORDINATES: Record<string, { lat: number; lng: number }> = Object.fromEntries([
  ...EASTERN_SIERRA_PLACES.map((place) => [place.id, place.coordinates] as const),
  [EASTERN_SIERRA.id, EASTERN_SIERRA.baseCoordinates] as const,
]);

function execution() {
  const decisions = deriveDecisions({ itinerary: PLAN, intelligence: null, persisted: [{ key: 'timing', chosen: `${PLAN.startDate} to ${PLAN.endDate}`, lock: 'user_explicit', decidedBy: 'traveller', decidedAt: '2026-07-01T00:00:00.000Z' }] });
  const graph = buildTripStateGraph({ itinerary: PLAN, intelligence: null, booked: [], decisions, now: NOW });
  const daysUntilTrip = Math.round((Date.parse(`${PLAN.startDate}T00:00:00Z`) - Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth(), NOW.getUTCDate())) / 86_400_000);
  const nextActions = buildNextActions({ graph, lifecycle: 'ready', daysUntilTrip, now: NOW });
  const preflight = buildPreflight({ graph, intelligence: null, booked: [], checks: { preflight: [], packing: [], checklist: [] }, daysUntilTrip });
  const ledger = buildLedger({ budget: null, booked: [], openNeeds: [] });
  return { decisions, graph, nextActions, preflight, ledger, daysUntilTrip };
}

function render(mode: 'owner' | 'shared'): string {
  const layer = execution();
  return renderToStaticMarkup(
    createElement(ItineraryView, {
      itinerary: PLAN,
      preparation: [],
      ...(mode === 'owner' ? { tripId: TRIP_ID, savedToAccount: true } : {}),
      dateLabel: '12–15 Aug',
      renderedAt: NOW.getTime(),
      coordinates: COORDINATES,
      graph: layer.graph,
      nextActions: layer.nextActions,
      preflight: layer.preflight,
      decisions: layer.decisions,
      ledger: layer.ledger,
      lifecycle: 'ready',
      daysUntilTrip: layer.daysUntilTrip,
      affected: { dayNumbers: [], baseIds: [], baseRenamedDays: [], shiftedItems: [], displaced: [], notRemeasuredDays: [], summary: 'No day changes.' },
    }),
  );
}

/** The text a person reads: tags stripped, the print appendix and the forensic disclosure left out. */
function readable(html: string): string {
  return html
    .replace(/<details[^>]*data-testid="how-this-was-checked"[\s\S]*?<\/details>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');
}

describe('the V9 hub, rendered for the owner', () => {
  const html = render('owner');

  it('shows the Next Best Action card on the trip, above its days', () => {
    expect(html).toContain('data-testid="next-action-card"');
    expect(html).toContain('data-testid="next-action-phase"');
    /* 2026-11 — the trip summary sits above the days on the Itinerary tab. */
    expect(html.indexOf('data-testid="next-action-card"')).toBeLessThan(html.indexOf('id="hub-view-days"'));
  });

  it('has four tabs over the six views, the same four in the phone bar', () => {
    for (const id of ['days', 'map', 'book', 'prepare']) expect(html).toContain(`data-testid="hub-link-${id}"`);
    for (const id of ['days', 'map', 'book', 'prepare']) expect(html).toContain(`data-testid="hub-bottom-${id}"`);
    for (const id of ['overview', 'plan']) expect(html).not.toContain(`data-testid="hub-link-${id}"`);
    for (const id of ['overview', 'days', 'map', 'plan', 'book', 'prepare']) expect(html).toContain(`id="hub-view-${id}"`);
    expect(html).toContain('data-testid="hub-book"');
    expect(html).toContain('data-testid="booking-suggestions"');
  });

  it('renders the decisions as records with a "Why this?" and alternative chips', () => {
    expect(html).toContain('data-testid="decision-card" data-key="transport"');
    expect(html).toContain('data-testid="decision-card" data-key="timing"');
    expect(html).toContain('data-testid="decision-why"');
    expect(html).toContain('data-testid="alternative-chip"');
    /* The traveller's own timing row overlays the derived record. */
    expect(html).toMatch(/data-key="timing" data-lock="user_explicit"/);
  });

  it('leads Prepare with the checklist: one count, the departure in words, the action sections', () => {
    expect(html).toContain('data-testid="preflight"');
    expect(html).toMatch(/data-testid="preflight-verdict" data-verdict="(ready|nearly|not_yet)"/);
    /* 2026-11 — sections by when the traveller acts, not by bucket; no giant day figure. */
    expect(html).toContain('data-testid="hub-checklist"');
    expect(html).toContain('data-testid="hub-before-you-go"');
    expect(html).toMatch(/data-testid="preflight-days">Leaves /);
    expect(html).not.toContain('hv-away');
    /* The old header id survives on the thing that replaced it. */
    expect(html).toContain('data-testid="prepare-top"');
    /* An item with a check id carries a tick for the owner. */
    expect(html).toContain('data-testid="preflight-tick"');
  });

  it('badges every day with where it stands', () => {
    for (const day of PLAN.days) expect(html).toMatch(new RegExp(`data-testid="day-state-${day.dayNumber}" data-state="[a-z_]+"`));
  });

  it('says the trip is kept on the account and offers the Pack', () => {
    expect(html).toContain('data-testid="saved-to-account"');
    expect(html).toContain('data-testid="open-pack"');
    expect(html).toContain(`/trips/${TRIP_ID}/pack`);
  });

  it('reads no forensic word anywhere a traveller reads', () => {
    const text = readable(html);
    expect(text).not.toMatch(/dependency unresolved|partially verified|blast radius|provider|unmeasured|unverified/i);
  });
});

describe('the V9 hub, rendered for a reader of a share link', () => {
  const html = render('shared');

  it('still leads with the next actions and Preflight, without a control', () => {
    expect(html).toContain('data-testid="next-action-card"');
    expect(html).toContain('data-testid="preflight"');
    expect(html).toContain('data-testid="hub-book"');
    expect(html).not.toContain('data-testid="preflight-tick"');
    expect(html).not.toContain('data-testid="alternative-chip"');
    expect(html).not.toContain('data-testid="saved-to-account"');
    expect(html).not.toContain('data-testid="open-pack"');
    expect(html).not.toContain(TRIP_ID);
  });

  it('reads no forensic word either', () => {
    expect(readable(html)).not.toMatch(/dependency unresolved|partially verified|blast radius|provider|unmeasured|unverified/i);
  });
});
