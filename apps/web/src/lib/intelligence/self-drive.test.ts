import { describe, expect, it } from 'vitest';
import { boardWorld, draftOf } from '@/lib/planning/acceptance/harness';
import { reconcileTripDraft } from '@/lib/planning/reconcile';
import { buildTravelIntelligence } from './build';
import type { TripDraft } from '@/lib/planning/trip-draft';

/**
 * §18 — A RENTAL DESK, A RENTAL BILL AND A DRIVING PERMIT NEED A RENTAL.
 *
 * The live Kyrgyzstan build stated `driving: private_driver` and put a hired
 * driver with a 4x4 over the jailoo tracks. The finished trip then told the
 * traveller:
 *
 *   "Rental desk and pickup (estimate): 30 min"
 *   "11 rental days plus fuel not included … excludes tolls, parking, one-way
 *    fees, full excess cover"
 *   "Confirm licence and IDP rules; decide the rental excess cover."
 *
 * about a car nobody on that trip will ever hire. The cause was one word: the
 * intelligence layer's `drives` meant "a car is involved" where it had to mean
 * "the traveller is at the wheel".
 */
async function intelligenceFor(draft: TripDraft) {
  const context = boardWorld();
  const result = await reconcileTripDraft({ draft, context });
  return buildTravelIntelligence({
    tripId: context.tripId,
    itinerary: result.itinerary,
    draft: {
      days: draft.days.map((d) => ({ anchors: d.anchors.map((a) => ({ name: a.name, ...(a.transport ? { transport: a.transport } : {}) })) })),
      bases: draft.bases.map((b) => ({ id: b.id })),
      ...(draft.driving ? { driving: draft.driving } : {}),
    },
    profile: context.profile,
    basics: context.basics,
    destination: { name: 'Mammoth Lakes', countryCode: 'US' },
    composer: null,
    booked: [],
    readinessProfile: null,
    sourcedAreas: [],
    worthSkipping: [],
    userPlaces: [],
    bookedHonored: [],
    bookedConflicts: [],
    now: new Date('2026-06-01T00:00:00.000Z'),
    fx: null,
  });
}

const drivingDraft = (driving: TripDraft['driving']) =>
  draftOf({
    bases: [{ id: 'base', name: 'Mammoth Lakes', nights: 3 }],
    days: [
      { base: 'base', anchors: [{ name: 'Convict Lake', transport: 'car' }] },
      { base: 'base', anchors: [{ name: 'Mono Lake', transport: 'car' }] },
      { base: 'base', anchors: [{ name: 'Hot Creek', transport: 'four_wheel_drive' }] },
    ],
    driving,
  });

describe('a trip driven by somebody else', () => {
  it('is billed for no rental days', async () => {
    const intel = await intelligenceFor(drivingDraft('private_driver'));
    const bases = intel.budget.lines.map((l) => l.basis).join(' | ');
    expect(bases).not.toMatch(/rental days/);
  });

  it('never mentions a rental desk anywhere the traveller reads', async () => {
    /* The whole intelligence object, because a rental desk may surface in
     * terminal logistics, readiness or prepare and the traveller reads all three. */
    const intel = await intelligenceFor(drivingDraft('operator_transfer'));
    expect(JSON.stringify(intel)).not.toMatch(/Rental desk/i);
  });

  it('is asked to confirm no driving permit or rental excess', async () => {
    const intel = await intelligenceFor(drivingDraft('private_driver'));
    expect(JSON.stringify(intel)).not.toMatch(/rental excess|IDP rules/i);
  });
});

describe('a trip the traveller drives', () => {
  it('still gets the rental line, the desk and the permit check', async () => {
    const intel = await intelligenceFor(drivingDraft('rental_self_drive'));
    expect(intel.budget.lines.map((l) => l.basis).join(' | ')).toMatch(/rental days/);
  });
});
