import { buildNextActions, buildPreflight, buildTripStateGraph } from '@sidequest/core';
import type { ItineraryViewModel } from '@/app/(product)/trips/[id]/itinerary/view-model';
import { renderInstant } from '@/lib/clock';

/**
 * V9 §24 — THE STRIP LIST AT THE DOOR, IN ONE PLACE.
 *
 * Everything the owner wrote or paid for stays with the owner: a booking's
 * reference, notes, cost, link, whether it is paid or refundable, which need
 * it answers, what it replaced and how it arrived; every pending import; the
 * ledger's lines (each is a booked cost); the note on a skipped booking; the
 * traveller's own words on a decision; the readiness documents; every
 * observation a recheck wrote (the freshness list is the owner's). The shared
 * render gets an empty ledger and no imports, so no render branch can leak
 * what it was never handed — and because the state graph, the next actions
 * and Preflight are derived from those inputs, they are derived again here
 * from the stripped ones, so a day badge cannot quote an observation the
 * page was never given. Exported for the privacy test, which renders the
 * page and asserts none of it reaches the markup.
 */
export function stripForShare<M extends ItineraryViewModel>(model: M): M {
  const now = new Date(renderInstant());
  const booked = model.booked.map(({ confirmationRef: _ref, notes: _notes, cost: _cost, url: _url, paid: _paid, refundable: _refundable, bookingItemId: _need, replaces: _replaces, source: _source, ...rest }) => {
    void _ref;
    void _notes;
    void _cost;
    void _url;
    void _paid;
    void _refundable;
    void _need;
    void _replaces;
    void _source;
    return rest;
  });
  const decisions = model.decisions.map((decision) => ({ ...decision, travellerFacts: [], ...(decision.decidedBy === 'traveller' ? { why: '' } : {}) }));
  const resolutions = model.resolutions.map(({ note: _note, ...rest }) => {
    void _note;
    return rest;
  });
  const graph = buildTripStateGraph({ itinerary: model.appliedItinerary, intelligence: model.intelligence, booked, decisions, resolutions, observations: [], recheck: model.recheck, now });
  const nextActions = buildNextActions({ graph, lifecycle: model.lifecycle, daysUntilTrip: model.daysUntilTrip, now, today: model.today });
  const preflight = buildPreflight({ graph, intelligence: model.intelligence, booked, checks: model.checks, daysUntilTrip: model.daysUntilTrip });
  return {
    ...model,
    booked,
    decisions,
    resolutions,
    graph,
    nextActions,
    preflight,
    readinessProfile: null,
    pendingImports: [],
    ledger: { ...model.ledger, committed: null, otherCurrencies: [], lines: [], note: '' },
    observations: [],
    changedHeadline: null,
    volatile: [],
  };
}
