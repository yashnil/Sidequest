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
 *
 * V9.1 — the intelligence snapshot carries its own copy of the booked facts,
 * so the same projection runs over `intelligence.bookings.booked` and the
 * stripped snapshot is what the derived layers and the render receive. A copy
 * no branch happens to print today is still a copy the door handed over. The
 * snapshot's budget carries the same money a second time — what the owner
 * actually paid, per category and as a total — so the shared budget keeps the
 * estimate bands and drops every actual. Those fields are optional, and their
 * absence is exactly the shape of a trip with nothing booked, which every
 * render already handles.
 */
function stripBookedFact<F extends ItineraryViewModel['booked'][number]>(fact: F) {
  const { confirmationRef: _ref, notes: _notes, cost: _cost, url: _url, paid: _paid, refundable: _refundable, bookingItemId: _need, replaces: _replaces, source: _source, ...rest } = fact;
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
}

/** The estimate bands stay; every figure derived from what the owner actually paid goes. */
function stripBudgetActuals<B extends ItineraryViewModel['intelligence']['budget']>(budget: B) {
  const { booked: _booked, actualTotal: _actualTotal, remainingEstimate: _remaining, ...rest } = budget;
  void _booked;
  void _actualTotal;
  void _remaining;
  return {
    ...rest,
    booked: [],
    lines: budget.lines.map(({ actual: _actual, ...line }) => {
      void _actual;
      return line;
    }),
  };
}

export function stripForShare<M extends ItineraryViewModel>(model: M): M {
  const now = new Date(renderInstant());
  const booked = model.booked.map(stripBookedFact);
  const intelligence = {
    ...model.intelligence,
    bookings: { ...model.intelligence.bookings, booked: model.intelligence.bookings.booked.map(stripBookedFact) },
    budget: stripBudgetActuals(model.intelligence.budget),
  };
  const decisions = model.decisions.map((decision) => ({ ...decision, travellerFacts: [], ...(decision.decidedBy === 'traveller' ? { why: '' } : {}) }));
  const resolutions = model.resolutions.map(({ note: _note, ...rest }) => {
    void _note;
    return rest;
  });
  const graph = buildTripStateGraph({ itinerary: model.appliedItinerary, intelligence, booked, decisions, resolutions, observations: [], recheck: model.recheck, now });
  const nextActions = buildNextActions({ graph, lifecycle: model.lifecycle, daysUntilTrip: model.daysUntilTrip, now, today: model.today });
  const preflight = buildPreflight({ graph, intelligence, booked, checks: model.checks, daysUntilTrip: model.daysUntilTrip });
  return {
    ...model,
    intelligence,
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
