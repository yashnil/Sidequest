import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { planTrip } from '@sidequest/planner';
import type { Itinerary } from '@sidequest/core';
import { AUGUST_BASICS, buildScenario } from '../../../../../packages/planner/src/testing/scenario';

/**
 * V9.1 §2 — THE PUBLIC SHARE IS A BOUNDARY, NOT A FILTER.
 *
 * A read-only share used to be built from the owner's own intelligence
 * snapshot and then cleaned field by field. That works for a field and cannot
 * work for a sentence: entry, visa and health advice is composed at build time
 * from the readiness profile and the party, so "Sidequest has not
 * independently verified whether a NZ passport holder needs a visa" is written
 * once and then copied into the readiness packet, the checklist, the regret
 * list, the source registry and, through those, the state graph and Preflight.
 * No strip can take the nationality back out of prose, and one that tried by
 * matching words would be a sanitiser with a bypass waiting in it.
 *
 * So the inputs are withheld instead. `loadTripIntelligence({ audience:
 * 'public' })` builds the same trip with no readiness profile, no party diet
 * or accessibility facts and booked facts reduced to what shapes the plan.
 * These tests assert both halves: the private facts are absent, and the trip
 * is still a usable plan.
 */
const OWNER = 'owner-cookie';
const STRANGER = 'stranger-cookie';

const PRIVATE = {
  citizenship: 'NZ',
  passportExpiry: '2031-07',
  travelerName: 'Cousin Ravindra',
  needsNotes: 'gets migraines after long drives',
  dietNotes: 'severe peanut allergy carry the pen',
  confirmationRef: 'QX7-REF-4419-ZZ',
  bookingNotes: 'ask for the quiet room at the back',
  bookingUrl: 'booking.example.invalid',
};

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sidequest-share-boundary-'));
  process.env.SIDEQUEST_DB_PATH = join(dir, 'test.db');
  vi.resetModules();
});

afterEach(() => {
  delete process.env.SIDEQUEST_DB_PATH;
  rmSync(dir, { recursive: true, force: true });
});

let planned: Itinerary | null = null;
function itineraryFixture(): Itinerary {
  if (!planned) {
    const result = planTrip(buildScenario());
    if (!result.ok) throw new Error(`the fixture scenario did not plan: ${result.code}`);
    planned = result.itinerary;
  }
  return planned;
}

async function seed(owner = OWNER): Promise<string> {
  const { createTrip, saveItinerary } = await import('@/lib/db/repository');
  const trip = createTrip({ ...AUGUST_BASICS, destinationInput: 'Destination A' }, owner);
  saveItinerary({ ...itineraryFixture(), tripId: trip.id });

  const { addBookedItem, saveReadinessProfile } = await import('@/lib/db/intelligence-repository');
  addBookedItem(trip.id, {
    type: 'lodging',
    title: 'Hotel Alpha',
    date: itineraryFixture().days[0]!.date,
    endDate: itineraryFixture().days[1]!.date,
    location: 'Main Street 4',
    locked: true,
    confirmationRef: PRIVATE.confirmationRef,
    notes: PRIVATE.bookingNotes,
    url: `https://${PRIVATE.bookingUrl}/reservation/QX7`,
    cost: { amount: 1234.56, currency: 'USD' },
    status: 'booked',
    paid: 'deposit',
    refundable: 'non_refundable',
    source: 'imported',
    provider: 'Booking.com',
  });
  saveReadinessProfile(trip.id, { citizenship: PRIVATE.citizenship, passportExpiry: PRIVATE.passportExpiry, transitCountries: [] });

  const { createTraveler, setPartyMember } = await import('@/lib/db/party-repository');
  const traveler = createTraveler(
    { userId: null, ownerToken: owner },
    {
      displayName: PRIVATE.travelerName,
      diet: { needs: ['nut_allergy'], strict: true, allergyCrossContamination: true, notes: PRIVATE.dietNotes },
      needs: ['avoid_steep_descents'],
      needsNotes: PRIVATE.needsNotes,
      profile: { interests: {}, transportComfort: [], lodgingNeeds: [] },
      privacy: { hideFromPrint: false },
    } as Parameters<typeof createTraveler>[1],
  );
  setPartyMember({ tripId: trip.id, travelerId: traveler.id, role: 'other', preferencesApply: true, constraintsApply: true, participation: 'described', position: 0 });
  return trip.id;
}

async function models(tripId: string) {
  const { getTrip, getItinerary } = await import('@/lib/db/repository');
  const { itineraryViewModel } = await import('@/app/(product)/trips/[id]/itinerary/view-model');
  const trip = getTrip(tripId)!;
  const itinerary = getItinerary(tripId)!;
  const owner = await itineraryViewModel(trip, itinerary);
  const shared = await itineraryViewModel(trip, itinerary, { audience: 'public' });
  return { owner, shared };
}

describe('what a public share is built from', () => {
  it('carries the citizenship in the private trip and nothing of it in the public one', async () => {
    const tripId = await seed();
    const { owner, shared } = await models(tripId);
    /* The private build says the honest thing about entry requirements, naming the passport. */
    expect(JSON.stringify(owner.intelligence)).toContain(PRIVATE.citizenship);
    /* The public build never composed that sentence, so there is nothing to strip. */
    /*
     * Precisely: no sentence about *this* traveller's nationality. The two
     * letters alone are not the test — `readiness.coverageNote` is a fixed
     * sentence naming every country Sidequest carries advisories for ("AU, CA,
     * DE, FR, GB, IE, NZ, US"), which says nothing about who is travelling and
     * reads the same for a trip with no profile at all.
     */
    const personal = /passport holder|\bNZ\b\s*(passport|citizen)|citizenship is|passport expires in \d/i;
    expect(personal.test(JSON.stringify(owner.intelligence))).toBe(true);
    expect(personal.test(JSON.stringify(shared.intelligence))).toBe(false);
    /*
     * What the public build says instead is the empty state: "Add your
     * citizenship", "Tell Sidequest the month your passport expires" — the
     * same prompts a trip whose owner never filled in a readiness profile
     * shows, which disclose nothing about anybody.
     */
    expect(JSON.stringify(shared.intelligence.readiness)).toMatch(/Add your citizenship/);
    /* The only survivor of the two letters is a fixed list, and it names the others too. */
    const note = shared.intelligence.readiness.coverageNote;
    expect(note).toContain('NZ');
    expect(note).toContain('US');
    expect(note).toContain('GB');
    expect(shared.readinessProfile).toBeNull();
  });

  it('excludes the whole advisory path the readiness profile generates, not just the word', async () => {
    const tripId = await seed();
    const { owner, shared } = await models(tripId);
    const mentions = (model: typeof owner, where: (m: typeof owner) => unknown) =>
      /passport holder|visa|entry requirements/i.test(JSON.stringify(where(model)));
    /* Each of these is a separate copy of the same generated sentence in the owner's snapshot. */
    expect(mentions(owner, (m) => m.intelligence.readiness)).toBe(true);
    /* None of them is rebuilt for the public audience. */
    expect(JSON.stringify(shared.intelligence.readiness.entries)).not.toContain(PRIVATE.citizenship);
    expect(JSON.stringify(shared.intelligence.checklist)).not.toContain(PRIVATE.citizenship);
    expect(JSON.stringify(shared.intelligence.regret)).not.toContain(PRIVATE.citizenship);
    expect(JSON.stringify(shared.intelligence.sourceRegistry)).not.toContain(PRIVATE.citizenship);
    /* And the layers derived from it carry none either. */
    expect(JSON.stringify(shared.graph)).not.toContain(PRIVATE.citizenship);
    expect(JSON.stringify(shared.preflight)).not.toContain(PRIVATE.citizenship);
  });

  it('keeps the party out: a companion name, their functional needs and their diet', async () => {
    const tripId = await seed();
    const { shared } = await models(tripId);
    const bytes = JSON.stringify(shared);
    for (const secret of [PRIVATE.travelerName, PRIVATE.needsNotes, PRIVATE.dietNotes, PRIVATE.passportExpiry]) {
      expect(bytes.includes(secret), `${secret} reached the public build`).toBe(false);
    }
  });

  it('keeps a booking confirmation reference, its cost, notes and link out', async () => {
    const tripId = await seed();
    const { shared } = await models(tripId);
    const bytes = JSON.stringify(shared);
    for (const secret of [PRIVATE.confirmationRef, PRIVATE.bookingNotes, PRIVATE.bookingUrl, '1234.56']) {
      expect(bytes.includes(secret), `${secret} reached the public build`).toBe(false);
    }
    /* Including the snapshot's own second copy of the booked list and of the spend. */
    expect(JSON.stringify(shared.intelligence.bookings.booked)).not.toContain(PRIVATE.confirmationRef);
    expect(JSON.stringify(shared.intelligence.budget)).not.toContain('1234.56');
  });

  it('carries no tick list: what the owner has already done is the owner’s record', async () => {
    const tripId = await seed();
    const { owner, shared } = await models(tripId);
    expect(owner.checks).toBeDefined();
    expect(shared.checks).toEqual({ packing: [], checklist: [], preflight: [] });
  });
});

describe('what a public share still is', () => {
  it('is a usable plan: the days, the stays, the route and the destination survive', async () => {
    const tripId = await seed();
    const { owner, shared } = await models(tripId);
    expect(shared.appliedItinerary.days.length).toBe(owner.appliedItinerary.days.length);
    expect(shared.appliedItinerary.days.length).toBeGreaterThan(0);
    /* Every day keeps its stops: withholding the traveller never removes the trip. */
    const stops = (m: typeof owner) => m.appliedItinerary.days.reduce((n, day) => n + day.items.length, 0);
    expect(stops(shared)).toBe(stops(owner));
    expect(shared.appliedItinerary.summary).toBe(owner.appliedItinerary.summary);
  });

  it('keeps the preparation that follows from the destination rather than from the traveller', async () => {
    const tripId = await seed();
    const { shared } = await models(tripId);
    /* Weather, lodging areas and the budget bands are all about the place, and all still there. */
    expect(shared.intelligence.weather).toBeDefined();
    expect(shared.intelligence.budget.lines.length).toBeGreaterThan(0);
    expect(shared.intelligence.readiness).toBeDefined();
  });

  it('still knows a booking exists, which is what makes the plan read as real', async () => {
    const tripId = await seed();
    const { shared } = await models(tripId);
    expect(shared.booked.length).toBeGreaterThan(0);
    expect(shared.booked[0]!.title).toBe('Hotel Alpha');
    expect(shared.booked[0]).not.toHaveProperty('confirmationRef');
  });

  it('never writes the public build over the owner’s stored snapshot', async () => {
    const tripId = await seed();
    const { getTravelIntelligence } = await import('@/lib/db/intelligence-repository');
    await models(tripId);
    const stored = getTravelIntelligence(tripId);
    /* The owner's row is the private one: building a share must not have replaced it. */
    expect(stored).not.toBeNull();
    expect(JSON.stringify(stored)).toContain(PRIVATE.citizenship);
  });
});

describe('one user cannot reach another’s execution state', () => {
  it('refuses the trip to a browser that did not make it', async () => {
    const tripId = await seed();
    const { listTrips } = await import('@/lib/db/repository');
    /* The dashboard is the owner-scoped read: a stranger's cookie lists nothing of this trip. */
    expect(listTrips(OWNER).map((t) => t.id)).toContain(tripId);
    expect(listTrips(STRANGER).map((t) => t.id)).not.toContain(tripId);
  });

  it('a share token opens only the trip it was minted for', async () => {
    const first = await seed();
    const second = await seed();
    const { ensureShareToken, tripForShareToken } = await import('@/lib/db/repository');
    const token = ensureShareToken(first)!;
    expect(tripForShareToken(token)?.id).toBe(first);
    expect(tripForShareToken(token)?.id).not.toBe(second);
    expect(tripForShareToken('not-a-real-token')).toBeNull();
  });
});
