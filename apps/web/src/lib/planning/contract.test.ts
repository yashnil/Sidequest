import { describe, expect, it } from 'vitest';
import { buildTravelerProfile, contractBands, defaultAnswers, emptyComposerAnswers, lockRank, modelMayOverride, windowConflict, type Trip, type TripComposerAnswers } from '@sidequest/core';
import { buildCanonicalTripBuildInput, timingIntentOf } from './canonical-input';
import { buildCompositionTask } from './composition';
import { adoptChosenWindow, travelerBriefFor } from './production-plan';
import { buildTripContract, contractEnforcementRecord, enforceContractOnDraft } from './trip-contract';
import { auditItinerary } from './quality-audit';
import type { TripDraft } from './trip-draft';
import { readFileSync } from 'node:fs';
import { travelerProfileSchema } from '@sidequest/core';
import { IRELAND_TRIP, irelandContext, irelandDraft } from './acceptance/ireland-replay.test';
import { reconcileTripDraft } from './reconcile';

/**
 * THE TRIP CONTRACT — A TRAVELLER ACCEPTING JUNE CAN NEVER RECEIVE OCTOBER.
 *
 * V6 §2. Two production trips lost their accepted dates: the traveller pressed
 * "Use this timing" on a June window and the plan came back for October; another
 * accepted February and received November. Four doors were involved (a stale
 * closure in the setup flow, an adoption action that never recorded acceptance,
 * a fallthrough that hard-coded "Sidequest chooses", and a model window adopted
 * over a real decision). The contract makes the outcome structurally impossible
 * whatever door regresses next: the lock lives on the trip row, the composition
 * is told what it may not change, and a contradicting window is refused and
 * recorded.
 */

const NOW = new Date('2026-09-09T12:00:00.000Z');

const irelandProfile = travelerProfileSchema.parse(JSON.parse(readFileSync(new URL('./acceptance/fixtures/ireland/profile.json', import.meta.url), 'utf8')));

function tripWith(overrides: Partial<Trip['basics']> = {}): Trip {
  return {
    id: 'trip-contract',
    basics: {
      mode: 'known_destination',
      destinationInput: 'Hokkaido',
      regionId: 'dynamic',
      startDate: '2027-06-13',
      endDate: '2027-06-20',
      arrivalTime: '15:00',
      departureTime: '11:00',
      adults: 3,
      children: 0,
      travelerNeeds: [],
      ...overrides,
    },
    status: 'draft',
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  };
}

function composerWith(patch: Partial<TripComposerAnswers>): TripComposerAnswers {
  return { ...emptyComposerAnswers('known_destination', NOW), ...patch };
}

const profile = buildTravelerProfile({ ...defaultAnswers({ travelerNeeds: [], tripDays: 8 }), dietaryNeeds: ['no_beef', 'no_pork'] as never, dietaryStrict: true }, { travelerNeeds: [], tripDays: 8 });

/** A best-time composer whose acceptance was never written — the exact production shape. */
const bestTimeUnrecorded = composerWith({ dates: { mode: 'best_time', wantsRecommendation: true } });

describe('the lock order', () => {
  it('ranks booked above hard above explicit above soft above inferred above model', () => {
    expect(lockRank('booked_lock')).toBeGreaterThan(lockRank('hard_lock'));
    expect(lockRank('hard_lock')).toBeGreaterThan(lockRank('user_explicit'));
    expect(lockRank('user_explicit')).toBeGreaterThan(lockRank('user_soft'));
    expect(lockRank('user_soft')).toBeGreaterThan(lockRank('sidequest_inferred'));
    expect(lockRank('sidequest_inferred')).toBeGreaterThan(lockRank('model_proposed'));
  });
  it('lets the model override only what Sidequest inferred or the model proposed', () => {
    expect(modelMayOverride('user_explicit')).toBe(false);
    expect(modelMayOverride('user_soft')).toBe(false);
    expect(modelMayOverride('sidequest_inferred')).toBe(true);
    expect(modelMayOverride('model_proposed')).toBe(true);
  });
});

describe('the row lock closes the question whatever the composer says', () => {
  it('a traveller-locked row with an unrecorded best-time composer is closed, dated from the row, and statable', () => {
    const timing = timingIntentOf({ composer: bestTimeUnrecorded, trip: tripWith({ timingLock: 'traveler' }), at: NOW.toISOString() });
    expect(timing.sidequestChooses).toBe(false);
    expect(timing.lock).toBe('traveler');
    expect(timing.startDate.value).toBe('2027-06-13');
    expect(timing.endDate.value).toBe('2027-06-20');
    expect(timing.startDate.source).toBe('explicit');
  });
  it('a missing composer never opens the question', () => {
    const timing = timingIntentOf({ composer: null, trip: tripWith(), at: NOW.toISOString() });
    expect(timing.sidequestChooses).toBe(false);
    expect(timing.startDate.value).toBe('2027-06-13');
    expect(timing.startDate.source).toBe('derived');
  });
  it('an unlocked best-time row is still open, so the composition may choose', () => {
    const timing = timingIntentOf({ composer: bestTimeUnrecorded, trip: tripWith(), at: NOW.toISOString() });
    expect(timing.sidequestChooses).toBe(true);
  });
});

describe('the contract', () => {
  const trip = tripWith({ timingLock: 'traveler' });
  const input = buildCanonicalTripBuildInput({ trip, composer: bestTimeUnrecorded, profile, now: NOW });
  const contract = buildTripContract({ trip, input, bookedFacts: ['Flight into New Chitose 13 June, landing 14:05'], now: NOW });

  it('holds the accepted window at user_explicit, decided by the traveller', () => {
    expect(contract.timing.open).toBe(false);
    expect(contract.timing.lock).toBe('user_explicit');
    expect(contract.timing.decidedBy).toBe('traveller');
    expect(contract.timing.startDate.value).toBe('2027-06-13');
  });
  it('holds the diet as a hard lock and the booking as a booked lock', () => {
    expect(contract.party.dietaryHard).toEqual(expect.arrayContaining([expect.stringMatching(/beef/i), expect.stringMatching(/pork/i)]));
    expect(contract.hardConstraints.some((c) => c.lock === 'hard_lock' && /beef/i.test(c.value ?? ''))).toBe(true);
    expect(contract.booked[0]?.lock).toBe('booked_lock');
  });
  it('renders MUST KEEP with the dates and the diet, and the composition task carries it', () => {
    const bands = contractBands(contract);
    expect(bands.mustKeep.join('\n')).toMatch(/2027-06-13 to 2027-06-20/);
    expect(bands.mustKeep.join('\n')).toMatch(/Do not return a different window/);
    expect(bands.mustAvoid.join('\n')).toMatch(/beef/i);
    const brief = travelerBriefFor({ input, envelope: { name: 'Hokkaido', center: { lat: 43.06, lng: 141.35 } } });
    const task = buildCompositionTask({ brief, envelope: { name: 'Hokkaido', center: { lat: 43.06, lng: 141.35 } }, mode: 'full', contract, timing: { sidequestChooses: false, today: '2026-09-09', earliestStart: '2026-09-23' } });
    expect(task).toContain('<must_keep>');
    expect(task).toContain('2027-06-13 to 2027-06-20');
    expect(task).not.toMatch(/HAS NOT CHOSEN THEIR DATES/);
  });

  it('refuses a model window against the lock and records the conflict', () => {
    const draft = { ...irelandDraft(), window: { startDate: '2026-10-12', endDate: '2026-10-19' }, timingRationale: 'October gives autumn colour across Hokkaido before the snow.' } as TripDraft;
    const conflict = windowConflict(contract, draft.window, NOW.toISOString());
    expect(conflict?.resolution).toBe('field_rejected');
    const enforced = enforceContractOnDraft(contract, draft, NOW);
    expect(enforced.draft.window).toBeUndefined();
    expect(enforced.draft.timingRationale).toBeUndefined();
    expect(enforced.conflicts.map((c) => c.field)).toEqual(expect.arrayContaining(['timing.window', 'timingRationale']));
    const record = contractEnforcementRecord(contract, enforced.conflicts);
    expect(record.timingLock).toBe('user_explicit');
    expect(record.timingDecidedBy).toBe('traveller');
    expect(record.lockedFacts).toBeGreaterThan(3);
  });
  it('passes a window through an open contract untouched', () => {
    const openTrip = tripWith();
    const openInput = buildCanonicalTripBuildInput({ trip: openTrip, composer: bestTimeUnrecorded, profile, now: NOW });
    const open = buildTripContract({ trip: openTrip, input: openInput, bookedFacts: [], now: NOW });
    expect(open.timing.open).toBe(true);
    expect(open.timing.decidedBy).toBe('nobody');
    const draft = { ...irelandDraft(), window: { startDate: '2027-07-05', endDate: '2027-07-12' } } as TripDraft;
    expect(enforceContractOnDraft(open, draft, NOW).draft.window).toEqual({ startDate: '2027-07-05', endDate: '2027-07-12' });
  });
});

describe('adoption of a model window', () => {
  const composer = bestTimeUnrecorded;
  it('never writes over a locked row', () => {
    const writes: string[] = [];
    const adopted = adoptChosenWindow({
      tripId: 'trip-contract',
      trip: tripWith({ timingLock: 'traveler' }),
      window: { startDate: '2026-10-12', endDate: '2026-10-19' },
      nights: 7,
      composer,
      now: NOW,
      persist: { updateTripDates: () => writes.push('dates'), saveComposerAnswers: () => writes.push('composer') },
    });
    expect(adopted).toBeNull();
    expect(writes).toEqual([]);
  });
  it('locks the row as Sidequest’s when the question really was open, and says so', () => {
    const writes: unknown[] = [];
    const adopted = adoptChosenWindow({
      tripId: 'trip-contract',
      trip: tripWith({ startDate: '2026-10-12', endDate: '2026-10-19' }),
      window: { startDate: '2027-07-05', endDate: '2027-07-12' },
      nights: 7,
      composer,
      now: NOW,
      persist: { updateTripDates: (_id, _s, _e, lock) => writes.push(lock), saveComposerAnswers: (_id, answers) => writes.push(answers) },
    });
    expect(adopted?.trip.basics.timingLock).toBe('sidequest');
    expect(writes[0]).toBe('sidequest');
    const stored = writes[1] as TripComposerAnswers;
    expect(stored.dates.recommendation?.decidedBy).toBe('sidequest');
    const closed = timingIntentOf({ composer: stored, trip: adopted!.trip, at: NOW.toISOString() });
    expect(closed.sidequestChooses).toBe(false);
    expect(closed.startDate.source).toBe('sidequest_chosen');
  });
});

describe('the audit reads the contract', () => {
  it('fails locked_dates_preserved when the itinerary is dated to another window', async () => {
    const trip: Trip = { ...IRELAND_TRIP, basics: { ...IRELAND_TRIP.basics, timingLock: 'traveler' } };
    const input = buildCanonicalTripBuildInput({ trip, composer: bestTimeUnrecorded, profile: irelandProfile, now: NOW });
    const contract = buildTripContract({ trip, input, bookedFacts: [], now: NOW });
    const draft = irelandDraft();
    const { context } = irelandContext();
    const { itinerary } = await reconcileTripDraft({ draft, context });
    const good = auditItinerary({ draft, itinerary, profile: irelandProfile, trip, contract, contractConflicts: [] });
    expect(good.checks.find((c) => c.id === 'locked_dates_preserved')?.ok).toBe(true);
    expect(good.checks.find((c) => c.id === 'contract_respected')?.ok).toBe(true);
    const moved = { ...itinerary, startDate: '2026-10-12', endDate: '2026-10-19', days: itinerary.days.map((d, i) => ({ ...d, date: `2026-10-${String(12 + i).padStart(2, '0')}` })) };
    const bad = auditItinerary({ draft, itinerary: moved, profile: irelandProfile, trip, contract, contractConflicts: [] });
    expect(bad.checks.find((c) => c.id === 'locked_dates_preserved')?.ok).toBe(false);
    expect(bad.passed).toBe(false);
  });
});
