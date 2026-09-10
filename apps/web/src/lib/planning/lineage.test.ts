import { describe, expect, it } from 'vitest';
import { buildTravelerProfile, defaultAnswers, emptyComposerAnswers, type Trip, type TripComposerAnswers } from '@sidequest/core';
import { buildCanonicalTripBuildInput, compositionTimingBriefOf, edgeIntentOf, isStatable, timingIntentOf } from './canonical-input';
import { buildCompositionTask, compositionUntrustedPayload } from './composition';
import { adoptChosenWindow, travelerBriefFor } from './production-plan';

import { testCompositionContext } from './testing/context';

/**
 * TRAVELER FACT LINEAGE, FOLLOWED END TO END.
 *
 * PRODUCTION LOCK V5 §3 and §4 and §7. Three defects motivated this file and
 * each has a test here that fails without the fix:
 *
 * 1. A diet the product could represent but the build path could not ("no beef,
 *    no pork") crashed Build, because the narrowing threw the requirement away
 *    and kept its strictness.
 * 2. Timing the traveller asked Sidequest to choose was answered before the trip
 *    existed, so a placeholder date reached the composition call as a fact.
 * 3. Arrival and departure times invented at trip creation were printed to the
 *    traveller as facts about flights they had not booked.
 *
 * All three are the same defect in different clothes: a value with no record of
 * where it came from, treated as though somebody had said it.
 */

const NOW = new Date('2026-09-08T12:00:00.000Z');

function tripWith(overrides: Partial<Trip['basics']> = {}): Trip {
  return {
    id: 'trip-lineage',
    basics: {
      mode: 'known_destination',
      destinationInput: 'Hong Kong',
      regionId: 'dynamic',
      startDate: '2027-02-06',
      endDate: '2027-02-12',
      arrivalTime: '15:00',
      departureTime: '11:00',
      adults: 2,
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

function profileWithDiet(needs: string[], strict: boolean, notes?: string) {
  const answers = defaultAnswers({ travelerNeeds: [], tripDays: 7 });
  return buildTravelerProfile(
    { ...answers, dietaryNeeds: needs as never, dietaryStrict: strict, ...(notes ? { dietaryNotes: notes } : {}) },
    { travelerNeeds: [], tripDays: 7 },
  );
}

describe('§4 — a stated diet survives the build path', () => {
  it('"no beef, no pork" builds an input with two absolute requirements and no orphan strictness', () => {
    const profile = profileWithDiet(['no_beef', 'no_pork'], true);
    const input = buildCanonicalTripBuildInput({ trip: tripWith(), composer: null, profile, now: NOW });
    expect(input.party.dietary.map((r) => r.type)).toEqual(['no_beef', 'no_pork']);
    expect(input.party.dietary.every((r) => r.strictness === 'strict')).toBe(true);
    expect(input.party.dietaryAbsolute).toBe(true);
  });

  it('reaches the composition task as an absolute rule, in words', () => {
    const profile = profileWithDiet(['no_beef', 'no_pork'], true);
    const task = buildCompositionTask(testCompositionContext({ trip: tripWith(), profile, envelope: { name: 'Hong Kong', center: { lat: 22.3, lng: 114.2 } }, now: NOW }));
    expect(task).toMatch(/no beef/i);
    expect(task).toMatch(/no pork/i);
  });

  it('strictness with nothing to be strict about produces no requirement rather than an orphan', () => {
    const profile = profileWithDiet([], true);
    const input = buildCanonicalTripBuildInput({ trip: tripWith(), composer: null, profile, now: NOW });
    expect(input.party.dietary).toEqual([]);
    expect(input.party.dietaryAbsolute).toBe(false);
  });

  it('free text alone is a requirement in its own right', () => {
    const profile = profileWithDiet([], true, 'Severe peanut allergy — cross-contamination matters');
    const input = buildCanonicalTripBuildInput({ trip: tripWith(), composer: null, profile, now: NOW });
    expect(input.party.dietary).toHaveLength(1);
    expect(input.party.dietary[0]!.type).toBe('free_text');
    expect(input.party.dietary[0]!.strictness).toBe('strict');
  });

  it('an allergy is absolute whatever the strict box said, and nothing else is upgraded', () => {
    const profile = profileWithDiet(['nut_allergy', 'no_beef'], false);
    const input = buildCanonicalTripBuildInput({ trip: tripWith(), composer: null, profile, now: NOW });
    const byType = new Map(input.party.dietary.map((r) => [r.type, r.strictness]));
    expect(byType.get('nut_allergy')).toBe('strict');
    expect(byType.get('no_beef')).toBe('preference');
  });
});

describe('§3 — February in, February out', () => {
  it('carries stated dates through as explicit facts, with no month substituted anywhere', () => {
    const composer = composerWith({ dates: { mode: 'exact', startDate: '2027-02-06', endDate: '2027-02-12', wantsRecommendation: false } });
    const input = buildCanonicalTripBuildInput({ trip: tripWith(), composer, profile: profileWithDiet([], false), now: NOW });
    expect(input.timing.startDate.value).toBe('2027-02-06');
    expect(input.timing.startDate.source).toBe('explicit');
    expect(isStatable(input.timing.startDate)).toBe(true);
    const brief = travelerBriefFor({ input, envelope: { name: 'Hong Kong', center: { lat: 22.3, lng: 114.2 } } });
    expect(brief.tripFacts.startDate).toBe('2027-02-06');
    const rendered = buildCompositionTask({ brief, envelope: { name: 'Hong Kong', center: { lat: 22.3, lng: 114.2 } }, mode: 'full', timing: compositionTimingBriefOf(input.timing) });
    expect(rendered).toContain('2027-02-06');
    /*
     * The specific regression: no other month may appear as a trip date. The
     * prompt-version line carries its own release date, so it is excluded by
     * name rather than by making the pattern vaguer.
     */
    const body = rendered.split('\n').filter((line) => !line.startsWith('Operation version:')).join('\n');
    const months = [...body.matchAll(/20\d\d-(\d\d)-\d\d/g)].map((m) => m[1]);
    expect(new Set(months)).toEqual(new Set(['02']));
  });

  it('nights are derived from the dates, and say so', () => {
    const composer = composerWith({ dates: { mode: 'exact', startDate: '2027-02-06', endDate: '2027-02-12', wantsRecommendation: false } });
    const input = buildCanonicalTripBuildInput({ trip: tripWith(), composer, profile: profileWithDiet([], false), now: NOW });
    expect(input.nights.value).toBe(6);
    expect(input.nights.source).toBe('derived');
  });
});

describe('§5/§6 — "tell me when it is best" stays open until the trip is composed', () => {
  const composer = composerWith({ dates: { mode: 'best_time', wantsRecommendation: true } });

  it('leaves the dates unknown rather than adopting the trip row placeholder', () => {
    const timing = timingIntentOf({ composer, trip: tripWith(), at: NOW.toISOString() });
    expect(timing.sidequestChooses).toBe(true);
    expect(timing.startDate.value).toBeNull();
    expect(timing.startDate.source).toBe('unknown');
    /* The placeholder is still available as a labelled hint, never as a fact. */
    expect(timing.provisional?.basis).toBe('placeholder');
  });

  it('omits the dates from the brief and asks the model to choose the window', () => {
    const input = buildCanonicalTripBuildInput({ trip: tripWith(), composer, profile: profileWithDiet([], false), now: NOW });
    const brief = travelerBriefFor({ input, envelope: { name: 'Hong Kong', center: { lat: 22.3, lng: 114.2 } } });
    expect(brief.tripFacts.startDate).toBeUndefined();
    expect(brief.tripFacts.season).toBeUndefined();
    const task = buildCompositionTask({ brief, envelope: { name: 'Hong Kong', center: { lat: 22.3, lng: 114.2 } }, mode: 'full', timing: compositionTimingBriefOf(input.timing) });
    expect(task).toMatch(/HAS NOT CHOSEN THEIR DATES/);
    expect(task).toMatch(/Return `window`/);
    expect(task).not.toContain('2027-02-06');
  });

  it('closes once the traveller accepts a proposed window, and attributes it', () => {
    const accepted = composerWith({
      dates: {
        mode: 'best_time',
        wantsRecommendation: true,
        recommendation: { startDate: '2027-03-08', endDate: '2027-03-14', label: 'early March', month: 3, year: 2027, reasons: [], tradeoffs: [], unknowns: [], basis: 'climate_normals', generatedAt: NOW.toISOString(), accepted: true },
      },
    });
    const timing = timingIntentOf({ composer: accepted, trip: tripWith(), at: NOW.toISOString() });
    expect(timing.sidequestChooses).toBe(false);
    expect(timing.startDate.value).toBe('2027-03-08');
    expect(timing.startDate.source).toBe('accepted_recommendation');
    expect(isStatable(timing.startDate)).toBe(true);
  });

  it('carries the traveller’s own constraint into the choice', () => {
    const windowed = composerWith({ dates: { mode: 'window', earliest: '2027-06-01', latest: '2027-07-15', wantsRecommendation: true } });
    const timing = timingIntentOf({ composer: windowed, trip: tripWith(), at: NOW.toISOString() });
    expect(compositionTimingBriefOf(timing).constraint).toContain('free between 2027-06-01 and 2027-07-15');
  });
});

describe('§7 — an edge nobody stated is never printed as a time', () => {
  it('an exact arrival is statable and says the time', () => {
    const edge = edgeIntentOf({ precision: 'exact', time: '07:45' }, 'arrival', NOW.toISOString());
    expect(edge.statable).toBe(true);
    expect(edge.phrase).toBe('at 07:45');
    expect(edge.planningMinute).toBe(7 * 60 + 45);
  });

  it('an unknown arrival keeps a planning allowance and states no time', () => {
    const edge = edgeIntentOf(undefined, 'arrival', NOW.toISOString());
    expect(edge.statable).toBe(false);
    expect(edge.phrase).toBe('time not set yet');
    expect(edge.time.value).toBeNull();
    expect(edge.planningMinute).toBeNull();
  });

  it('a part-of-day arrival plans conservatively and still states no clock time', () => {
    const edge = edgeIntentOf({ precision: 'afternoon' }, 'arrival', NOW.toISOString());
    expect(edge.statable).toBe(false);
    expect(edge.phrase).toBe('in the afternoon');
    expect(edge.planningMinute).toBe(16 * 60);
  });

  it('"not booked yet" reads as a decision, not as ignorance', () => {
    expect(edgeIntentOf({ precision: 'not_booked' }, 'departure', NOW.toISOString()).phrase).toBe('not booked yet');
  });

  it('the composition task and payload never print the invented 15:00 or 11:00', () => {
    const context = testCompositionContext({ trip: tripWith(), envelope: { name: 'Hong Kong', center: { lat: 22.3, lng: 114.2 } }, now: NOW });
    const text = buildCompositionTask(context) + JSON.stringify(compositionUntrustedPayload(context));
    expect(text).not.toContain('at 15:00');
    expect(text).not.toContain('at 11:00');
    expect(text).toContain('time not set yet');
  });
});

/**
 * §5/§6 — THE WINDOW THE MODEL CHOSE BECOMES THE TRIP'S DATES.
 *
 * Found by the live browser walk, before any model call was spent: the draft
 * schema carried `window`, the prompt asked for it, and **nothing consumed it**.
 * A "tell me when it is best" trip would have been composed for one month and
 * dated to the placeholder of another — every day's date, its weather and its
 * daylight belonging to a month nobody chose.
 */
describe('§6 — adopting the window the composition chose', () => {
  const trip = tripWith({ startDate: '2027-10-13', endDate: '2027-10-18' });
  const composer = composerWith({ dates: { mode: 'best_time', wantsRecommendation: true } });

  it('replaces the placeholder dates and records where they came from', () => {
    const saved: unknown[] = [];
    const adopted = adoptChosenWindow({
      tripId: trip.id,
      trip,
      window: { startDate: '2027-03-08', endDate: '2027-03-13' },
      nights: 5,
      composer,
      now: NOW,
      persist: { updateTripDates: () => saved.push('dates'), saveComposerAnswers: (_id, answers) => saved.push(answers) },
    });
    expect(adopted?.trip.basics.startDate).toBe('2027-03-08');
    expect(adopted?.trip.basics.endDate).toBe('2027-03-13');
    const stored = saved[1] as TripComposerAnswers;
    expect(stored.dates.recommendation?.accepted).toBe(true);
    expect(stored.dates.recommendation?.basis).toBe('composed_with_trip');
    expect(stored.dates.recommendation?.label).toBe('Early March');
    /* The lineage now reads as a decision rather than an open question — and, V6, as Sidequest's decision, not the traveller's. */
    const closed = timingIntentOf({ composer: stored, trip: adopted!.trip, at: NOW.toISOString() });
    expect(closed.sidequestChooses).toBe(false);
    expect(closed.lock).toBe('sidequest');
    expect(closed.startDate.source).toBe('sidequest_chosen');
    expect(stored.dates.recommendation?.decidedBy).toBe('sidequest');
    expect(isStatable(closed.startDate)).toBe(true);
  });

  it('refuses a window of the wrong length rather than silently changing the trip', () => {
    const noop = { updateTripDates: () => undefined, saveComposerAnswers: () => undefined };
    expect(adoptChosenWindow({ tripId: trip.id, trip, window: { startDate: '2027-03-08', endDate: '2027-03-20' }, nights: 5, composer, now: NOW, persist: noop })).toBeNull();
  });

  it('refuses a malformed, reversed or past window', () => {
    const noop = { updateTripDates: () => undefined, saveComposerAnswers: () => undefined };
    const at = (window: { startDate: string; endDate: string }) => adoptChosenWindow({ tripId: trip.id, trip, window, nights: 5, composer, now: NOW, persist: noop });
    expect(at({ startDate: 'next March', endDate: '2027-03-13' })).toBeNull();
    expect(at({ startDate: '2027-03-13', endDate: '2027-03-08' })).toBeNull();
    /* NOW is 2026-09-08; a window five nights long but already gone is refused. */
    expect(at({ startDate: '2026-03-08', endDate: '2026-03-13' })).toBeNull();
  });
});

/**
 * §6 — A CHOSEN WINDOW CANNOT BE IN THE PAST.
 *
 * The live Hong Kong build (2026-09-09) chose 2025-11-05: the right season, a
 * year that had already gone. A model has no clock, and nothing in the task said
 * when "now" was. Sidequest refused the window — which is the safe outcome —
 * but the traveller was then left with a plan whose own timing rationale named a
 * month their dates did not.
 */
describe('§6 — the window the model is asked for is anchored to today', () => {
  it('states today and the earliest permissible start in the task', () => {
    const composer = composerWith({ dates: { mode: 'best_time', wantsRecommendation: true } });
    const input = buildCanonicalTripBuildInput({ trip: tripWith(), composer, profile: profileWithDiet([], false), now: NOW });
    const brief = travelerBriefFor({ input, envelope: { name: 'Hong Kong', center: { lat: 22.3, lng: 114.2 } } });
    const timing = compositionTimingBriefOf(input.timing, NOW);
    expect(timing.today).toBe('2026-09-08');
    /* A fortnight out: a trip nobody has booked cannot start tomorrow. */
    expect(timing.earliestStart).toBe('2026-09-22');
    const task = buildCompositionTask({ brief, envelope: { name: 'Hong Kong', center: { lat: 22.3, lng: 114.2 } }, mode: 'full', timing });
    expect(task).toContain('Today is 2026-09-08');
    expect(task).toMatch(/must start on or after 2026-09-22/);
    expect(task).toMatch(/never a year that has already gone/);
  });

  it('carries the dates even when the traveller fixed their own, so nothing has to special-case it', () => {
    const composer = composerWith({ dates: { mode: 'exact', startDate: '2027-02-06', endDate: '2027-02-12', wantsRecommendation: false } });
    const input = buildCanonicalTripBuildInput({ trip: tripWith(), composer, profile: profileWithDiet([], false), now: NOW });
    const timing = compositionTimingBriefOf(input.timing, NOW);
    expect(timing.sidequestChooses).toBe(false);
    expect(timing.today).toBe('2026-09-08');
  });
});
