import { describe, expect, it } from 'vitest';
import { buildFeasibilityReport, buildStructuralMetrics, buildTravelerProfile, defaultAnswers, partyVenueFit, type ContractPartyMember, type Trip } from '@sidequest/core';
import { buildCanonicalTripBuildInput } from '../canonical-input';
import { buildTripContract } from '../trip-contract';
import { auditItinerary } from '../quality-audit';
import { buildPreservationReport } from '../preservation';
import { reconcileTripDraft } from '../reconcile';
import { travelerBriefFor } from '../production-plan';
import { boardWorld, draftOf, type DayShape } from './harness';
import { IRELAND_TRIP, irelandContext, irelandDraft } from './ireland-replay.test';

/**
 * THE TRIP QUALITY CORPUS — V6 §54/§55/§56.
 *
 * Twelve trip shapes, each a synthetic draft in the exact form the two
 * production defects took, reconciled offline against the fictional world
 * with no provider, and held to the structural metrics: no silent loss, no
 * transfer or gateway as a stop, locked dates preserved, party hard fails
 * zero where the day offers a split, an undecided gateway read as a
 * dependency. Nothing here is a taste judgement; every assertion is a
 * number a person could check by hand.
 */

const NOW = new Date('2026-09-10T12:00:00Z');
const WEEK = { startDate: '2027-06-13', endDate: '2027-06-20' };

function tripFor(basics: Partial<Trip['basics']>, id = 'corpus'): Trip {
  return {
    id,
    basics: { mode: 'known_destination', destinationInput: 'Corpus', regionId: 'eastern-sierra', startDate: WEEK.startDate, endDate: WEEK.endDate, arrivalTime: '15:00', departureTime: '11:00', adults: 2, children: 0, travelerNeeds: [], timingLock: 'traveler', ...basics },
    status: 'planned',
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  };
}

function member(id: string, displayName: string, patch: Partial<ContractPartyMember> = {}): ContractPartyMember {
  return { id, displayName, dietary: [], needs: [], preferencesApply: true, constraintsApply: true, ...patch };
}

async function run(input: { draft: ReturnType<typeof draftOf>; trip: Trip; members?: ContractPartyMember[]; dietary?: string[]; strict?: boolean }) {
  const answers = { ...defaultAnswers({ travelerNeeds: input.trip.basics.travelerNeeds, tripDays: 8 }), ...(input.dietary ? { dietaryNeeds: input.dietary as never, dietaryStrict: input.strict ?? true } : {}) };
  const profile = buildTravelerProfile(answers, { travelerNeeds: input.trip.basics.travelerNeeds, tripDays: 8 });
  const context = boardWorld({ basics: input.trip.basics });
  const { itinerary } = await reconcileTripDraft({ draft: input.draft, context: { ...context, profile } });
  const canonical = buildCanonicalTripBuildInput({ trip: input.trip, composer: null, profile, now: NOW });
  const contract = buildTripContract({ trip: input.trip, input: canonical, bookedFacts: [], members: input.members ?? [], now: NOW });
  const audit = auditItinerary({ draft: input.draft, itinerary, profile, trip: input.trip, contract, contractConflicts: [], partyNeeds: contract.party.needs });
  const feasibility = buildFeasibilityReport({ itinerary, contract, audit, partyNeeds: contract.party.needs });
  const preservation = buildPreservationReport(input.draft, itinerary);
  const metrics = buildStructuralMetrics({ itinerary: { ...itinerary, package: itinerary.package ? { ...itinerary.package, feasibility } : undefined }, contract, audit, silentAnchorLoss: preservation.silentLoss });
  const brief = travelerBriefFor({ input: canonical, envelope: { name: 'Corpus', center: { lat: 37.6, lng: -118.9 } }, party: (input.members ?? []).map((m) => ({ displayName: m.displayName, dietaryHard: m.dietary, dietarySoft: [], needs: m.needs, differences: [], preferencesApply: m.preferencesApply, constraintsApply: m.constraintsApply })) });
  return { itinerary, contract, audit, feasibility, preservation, metrics, brief };
}

const check = (audit: { checks: { id: string; ok: boolean; detail: string }[] }, id: string) => audit.checks.find((c) => c.id === id)!;

function eightDays(base: string, anchorsFor: (day: number) => DayShape['anchors'], extra: Partial<DayShape> = {}): DayShape[] {
  return Array.from({ length: 8 }, (_, i) => ({ base, anchors: anchorsFor(i + 1), ...extra }));
}

describe('the trip quality corpus', () => {
  it('regional self-drive (Hokkaido-like): transfers fold into legs, an undecided airport is a dependency, no beef/no pork is a hard lock, the accepted dates hold', async () => {
    const draft = draftOf({
      archetype: 'road_trip',
      driving: 'rental_self_drive',
      signatures: ['Daisetsuzan alpine day', 'Furano lavender'],
      bases: [
        { id: 'furano', name: 'Furano', nights: 3, style: 'small pension', overnight: 'guesthouse' },
        { id: 'sounkyo', name: 'Sounkyo Onsen', nights: 2, style: 'onsen ryokan', overnight: 'hotel' },
        { id: 'kushiro', name: 'Kushiro', nights: 2, style: 'business hotel', overnight: 'hotel' },
      ],
      days: [
        { base: 'furano', anchors: [{ name: 'New Chitose or Asahikawa Airport', category: 'other' }, { name: 'Farm Tomita', category: 'nature' }], relocation: false },
        { base: 'furano', anchors: [{ name: 'Shikisai-no-oka', category: 'nature' }, { name: 'Blue Pond', category: 'water', timeOfDay: 'morning' }] },
        { base: 'furano', anchors: [{ name: 'Furano lavender fields', category: 'nature' }, { name: 'Ningle Terrace', category: 'town' }] },
        { base: 'sounkyo', relocation: true, anchors: [{ name: 'Drive Furano to Sounkyo', category: 'scenic_drive', transport: 'car' }, { name: 'Ginga and Ryusei Falls', category: 'water' }] },
        { base: 'sounkyo', intensity: 'intense', anchors: [{ name: 'Daisetsuzan alpine day', category: 'hike', minutes: 420 }] },
        { base: 'kushiro', relocation: true, anchors: [{ name: 'Transfer to Kushiro', category: 'other', transport: 'car' }, { name: 'Lake Akan', category: 'water' }] },
        { base: 'kushiro', anchors: [{ name: 'Kushiro Shitsugen National Park', category: 'nature' }, { name: 'Washo Market', category: 'market' }] },
        { base: 'kushiro', anchors: [{ name: 'Nusamai Bridge', category: 'landmark', timeOfDay: 'sunset' }] },
      ],
    });
    const trip = tripFor({ adults: 3 });
    const r = await run({ draft, trip, dietary: ['no_beef', 'no_pork'], strict: true });
    expect(r.preservation.silentLoss).toBe(0);
    expect(r.metrics.transfersAsStops).toBe(0);
    expect(r.itinerary.package!.anchors.filter((a) => a.disposition === 'folded_into_transfer').map((a) => a.name)).toEqual(['Drive Furano to Sounkyo', 'Transfer to Kushiro']);
    expect(r.itinerary.package!.anchors.find((a) => a.name === 'New Chitose or Asahikawa Airport')?.disposition).toBe('folded_into_terminal');
    expect(check(r.audit, 'transfers_not_experiences').ok).toBe(true);
    expect(check(r.audit, 'locked_dates_preserved').ok).toBe(true);
    expect(r.contract.timing.lock).toBe('user_explicit');
    expect(r.contract.party.dietaryHard.join(' ')).toMatch(/beef/i);
    expect(r.contract.party.dietaryHard.join(' ')).toMatch(/pork/i);
    expect(r.feasibility.verdict).toBe('unresolved_major_dependency');
    expect(r.feasibility.items.some((i) => /arrive through/.test(i.detail))).toBe(true);
    expect(r.metrics.unverifiedCriticalDependencies).toBeGreaterThan(0);
    expect(r.metrics.lockedFactViolations).toBe(0);
  });

  it('family wildlife (Madhya Pradesh-like): the Bhopal drive is a transfer, the safari is an operated experience, child and diet constraints survive', async () => {
    const draft = draftOf({
      archetype: 'lodge_circuit',
      driving: 'private_driver',
      signatures: ['Bandhavgarh safaris'],
      bases: [
        { id: 'bhopal', name: 'Bhopal', nights: 1, overnight: 'hotel' },
        { id: 'bandhavgarh', name: 'Bandhavgarh', nights: 4, overnight: 'lodge', style: 'safari lodge' },
        { id: 'khajuraho', name: 'Khajuraho', nights: 2, overnight: 'hotel' },
      ],
      days: [
        { base: 'bhopal', anchors: [{ name: 'Upper Lake', category: 'water' }] },
        { base: 'bandhavgarh', relocation: true, anchors: [{ name: 'Drive Bhopal to Bandhavgarh', category: 'scenic_drive', transport: 'private_transfer', minutes: 360 }] },
        { base: 'bandhavgarh', anchors: [{ name: 'Tala zone morning safari', category: 'wildlife', timeOfDay: 'sunrise', transport: 'four_wheel_drive' }, { name: 'Magadhi zone afternoon safari', category: 'wildlife', timeOfDay: 'afternoon', transport: 'four_wheel_drive' }] },
        { base: 'bandhavgarh', anchors: [{ name: 'Khitauli zone safari', category: 'wildlife', timeOfDay: 'sunrise', transport: 'four_wheel_drive' }], intensity: 'light' },
        { base: 'bandhavgarh', anchors: [{ name: 'Bandhavgarh Fort', category: 'historic' }] },
        { base: 'bandhavgarh', anchors: [{ name: 'Tala zone evening safari', category: 'wildlife', timeOfDay: 'afternoon', transport: 'four_wheel_drive' }] },
        { base: 'khajuraho', relocation: true, anchors: [{ name: 'Bandhavgarh to Khajuraho drive', category: 'scenic_drive', transport: 'private_transfer', minutes: 300 }] },
        { base: 'khajuraho', anchors: [{ name: 'Western Group of Temples', category: 'historic', timeOfDay: 'morning' }] },
      ],
    });
    const trip = tripFor({ adults: 2, children: 2, travelerNeeds: ['kids_under_12'] });
    const members = [member('m1', 'Priya'), member('m2', 'Arjun'), member('m3', 'Meera', { ageGroup: 'child' }), member('m4', 'Kabir', { ageGroup: 'child', needs: ['Needs predictable meal times'] })];
    const r = await run({ draft, trip, members, dietary: ['no_beef', 'no_pork'], strict: true });
    expect(r.preservation.silentLoss).toBe(0);
    expect(r.metrics.transfersAsStops).toBe(0);
    expect(r.itinerary.package!.anchors.filter((a) => a.anchorKind === 'transfer').map((a) => a.name)).toEqual(['Drive Bhopal to Bandhavgarh', 'Bandhavgarh to Khajuraho drive']);
    /* A five-hour drive that nobody could time is a band, never a two-hour "activity". */
    const khajuraho = r.itinerary.days[6]!;
    expect(khajuraho.items.some((i) => i.kind === 'activity' && /drive/i.test(i.title))).toBe(false);
    expect(Boolean(khajuraho.totals.unmeasuredMajorTransfer) || khajuraho.totals.allowanceMinutes > 0 || khajuraho.totals.estimatedMinutes > 0).toBe(true);
    expect(r.contract.party.members.map((m) => m.displayName)).toEqual(['Priya', 'Arjun', 'Meera', 'Kabir']);
    expect(r.contract.hardConstraints.some((c) => /Kabir/.test(c.value ?? '') && /meal/i.test(c.value ?? ''))).toBe(true);
    expect(r.brief.party).toHaveLength(4);
    expect(r.contract.party.dietaryHard.length).toBe(2);
  });

  it('mixed-mobility family: an intense day without a split is a party hard fail; with a split it passes', async () => {
    const base = [{ id: 'town', name: 'Town', nights: 7, overnight: 'hotel' as const }];
    const days = (withSplit: boolean): DayShape[] => eightDays('town', (n) => (n === 4 ? [{ name: 'Ridge Summit Trail', category: 'hike', minutes: 420 }] : [{ name: `Lake ${n}`, category: 'water' }]), {}).map((d, i) => (i === 3 ? { ...d, intensity: 'intense', ...(withSplit ? { split: { who: 'Mum', does: 'takes the lakeside boardwalk and the museum', rejoin: 'the hotel terrace at five' } } : {}) } : d));
    const trip = tripFor({ adults: 3, travelerNeeds: ['mobility_limited'] });
    const members = [member('a', 'Mum', { needs: ['Avoid steep descents'] }), member('b', 'Dad'), member('c', 'Sam')];
    const without = await run({ draft: draftOf({ bases: base, days: days(false) }), trip, members });
    expect(check(without.audit, 'party_hard_fails').ok).toBe(false);
    expect(without.feasibility.verdict).toBe('infeasible');
    expect(without.metrics.partyHardFails).toBeGreaterThan(0);
    const withSplit = await run({ draft: draftOf({ bases: base, days: days(true) }), trip, members });
    expect(check(withSplit.audit, 'party_hard_fails').ok).toBe(true);
    expect(withSplit.itinerary.days[3]!.split?.who).toBe('Mum');
    expect(withSplit.metrics.partyHardFails).toBe(0);
    expect(withSplit.feasibility.items.filter((i) => i.area === 'party')).toHaveLength(0);
  });

  it('jeep-safari family: a long day with no steep ground is a caution to check, never a contradiction; a rest stop settles it; the dawn drive starts before dawn', async () => {
    /*
     * Live Madhya Pradesh build (V6 acceptance call 2): two safari days the
     * model called "intense" were declared contradicted for a grandmother who
     * avoids steep descents, and the sunrise safari sat at 10:30 because the
     * day opened at 09:00. A jeep is not a descent, and a sunrise is at dawn.
     */
    const base = [{ id: 'lodge', name: 'Lodge', nights: 7, overnight: 'hotel' as const }];
    const safariDay = (withRest: boolean) => [
      { name: 'National park morning safari', category: 'wildlife' as const, minutes: 210, transport: 'four_wheel_drive' as const, timeOfDay: 'sunrise' as const },
      ...(withRest ? [{ name: 'Rest at the lodge', category: 'relaxation' as const, role: 'secondary' as const, minutes: 120 }] : []),
      { name: 'National park evening safari', category: 'wildlife' as const, minutes: 180, transport: 'four_wheel_drive' as const, timeOfDay: 'sunset' as const },
    ];
    const days = (withRest: boolean): DayShape[] => eightDays('lodge', (n) => (n === 4 ? safariDay(withRest) : [{ name: `Temple ${n}`, category: 'historic' }]), {}).map((d, i) => (i === 3 ? { ...d, intensity: 'intense' } : d));
    const trip = tripFor({ adults: 4, travelerNeeds: ['mobility_limited'] });
    const members = [member('a', 'Amma', { needs: ['Avoid steep descents'] }), member('b', 'Ravi'), member('c', 'Priya'), member('d', 'Kabir')];
    const bare = await run({ draft: draftOf({ bases: base, days: days(false) }), trip, members });
    expect(check(bare.audit, 'party_hard_fails').ok).toBe(true);
    expect(bare.feasibility.verdict).not.toBe('infeasible');
    expect(bare.feasibility.items.filter((i) => i.area === 'party').map((i) => i.severity)).toEqual(['caution']);
    expect(bare.metrics.partyHardFails).toBe(0);
    const day4 = bare.itinerary.days[3]!;
    expect(day4.window.startMinute).toBe(5 * 60 + 30);
    expect(day4.window.note).toMatch(/before dawn/);
    const safari = day4.items.find((i) => i.kind === 'activity' && /morning safari/.test(i.title))!;
    expect(safari.startMinute).toBeLessThan(9 * 60);
    expect(check(bare.audit, 'time_intent_respected').ok).toBe(true);
    expect(bare.itinerary.days[0]!.window.startMinute).toBeGreaterThanOrEqual(9 * 60);
    const rested = await run({ draft: draftOf({ bases: base, days: days(true) }), trip, members });
    expect(rested.feasibility.items.filter((i) => i.area === 'party')).toHaveLength(0);
  });

  it('multi-diet group: every person’s rule is the group’s rule, and a venue is judged per person', async () => {
    const trip = tripFor({ adults: 3 });
    const members = [member('a', 'A', { dietary: ['No beef', 'No pork'] }), member('b', 'B', { dietary: ['Vegetarian'] }), member('c', 'C', { dietary: ['Nut allergy'] })];
    const r = await run({ draft: draftOf({ bases: [{ id: 'town', name: 'Town', nights: 7 }], days: eightDays('town', (n) => [{ name: `Stop ${n}`, category: 'landmark' }]) }), trip, members });
    expect(r.contract.party.dietaryHard).toEqual(['No beef', 'No pork', 'Vegetarian', 'Nut allergy']);
    expect(r.brief.hardConstraints.filter((line) => /cannot eat/.test(line))).toHaveLength(4);
    const fit = partyVenueFit([{ name: 'A', needs: ['no_beef', 'no_pork'], strict: true }, { name: 'B', needs: ['vegetarian'], strict: false }, { name: 'C', needs: ['nut_allergy'], strict: true }], { types: ['steak_house'] });
    expect(fit.overall).toBe('conflict');
  });

  it('wheelchair / step-free: the need is a hard lock, and a strenuous day with no alternative is infeasible', async () => {
    const trip = tripFor({ adults: 2, travelerNeeds: ['mobility_limited'] });
    const members = [member('a', 'Jo', { needs: ['Step-free or wheelchair access'] }), member('b', 'Lee')];
    const days = eightDays('town', (n) => (n === 5 ? [{ name: 'Canyon rim scramble', category: 'hike', minutes: 300 }] : [{ name: `Gallery ${n}`, category: 'museum' }])).map((d, i) => (i === 4 ? { ...d, intensity: 'intense' as const } : d));
    const r = await run({ draft: draftOf({ bases: [{ id: 'town', name: 'Town', nights: 7 }], days }), trip, members });
    expect(r.contract.hardConstraints.some((c) => /Jo: Step-free/.test(c.value ?? ''))).toBe(true);
    expect(r.contract.party.needs).toContain('Step-free or wheelchair access');
    expect(r.feasibility.verdict).toBe('infeasible');
    expect(r.feasibility.items.find((i) => i.area === 'party')?.detail).toMatch(/step-free|walking/i);
  });

  it('one hard allergy: strict, never inferred safe, and the kitchen must be asked', async () => {
    const trip = tripFor({ adults: 2 });
    const members = [member('a', 'Noor', { dietary: ['Nut allergy'] }), member('b', 'Zed')];
    const r = await run({ draft: draftOf({ bases: [{ id: 'town', name: 'Town', nights: 7 }], days: eightDays('town', (n) => [{ name: `Walk ${n}`, category: 'neighbourhood' }]) }), trip, members });
    expect(r.contract.hardConstraints.some((c) => c.lock === 'hard_lock' && /Noor cannot eat: Nut allergy/.test(c.value ?? ''))).toBe(true);
    const fit = partyVenueFit([{ name: 'Noor', needs: ['nut_allergy'], strict: true }], { types: ['ramen_restaurant'] });
    expect(fit.overall).toBe('unknown');
    expect(fit.askTheKitchen).toBe(true);
  });

  it('dense transit city (Hong Kong-like) and single-base urban (NYC-like): one base, no churn, no transfer stops, meals placed', async () => {
    for (const name of ['Harbour City', 'Big City']) {
      const trip = tripFor({ adults: 2, destinationInput: name });
      const days = eightDays('centre', (n) => [{ name: `${name} Market ${n}`, category: 'market' }, { name: `Neighbourhood walk ${n}`, category: 'neighbourhood', role: 'secondary' }], { meals: { breakfast: 'coffee near base', lunch: 'noodles in the market quarter', dinner: 'dai pai dong on the waterfront' } });
      const r = await run({ draft: draftOf({ archetype: 'single_base_urban', driving: 'none', bases: [{ id: 'centre', name: `${name} centre`, nights: 7 }], days }), trip });
      expect(r.metrics.hotelChurn).toBe(0);
      expect(r.metrics.transfersAsStops).toBe(0);
      expect(r.metrics.mealCoverage).toBeGreaterThanOrEqual(0.75);
      expect(r.preservation.silentLoss).toBe(0);
      expect(['feasible', 'feasible_with_cautions']).toContain(r.feasibility.verdict);
    }
  });

  it('couple luxury/food and backpacking friends: lodging character and nights survive, dates hold', async () => {
    const luxury = draftOf({ bases: [{ id: 'cape', name: 'Cape Town', nights: 4, style: 'boutique hotel with a view', overnight: 'hotel' }, { id: 'wine', name: 'Franschhoek', nights: 3, style: 'wine estate suite', overnight: 'hotel' }], days: [...eightDays('cape', (n) => [{ name: `Table ${n}`, category: 'food' }]).slice(0, 4), ...eightDays('wine', (n) => [{ name: `Estate ${n}`, category: 'food' }]).slice(0, 4).map((d, i) => (i === 0 ? { ...d, relocation: true } : d))] });
    const friends = draftOf({ bases: [{ id: 'a', name: 'Bishkek', nights: 2, overnight: 'hostel' }, { id: 'b', name: 'Karakol', nights: 3, overnight: 'hostel' }, { id: 'c', name: 'Song-Köl', nights: 2, overnight: 'yurt' }], days: [...eightDays('a', (n) => [{ name: `Bazaar ${n}`, category: 'market' }]).slice(0, 2), ...eightDays('b', (n) => [{ name: `Gorge ${n}`, category: 'hike' }]).slice(0, 3).map((d, i) => (i === 0 ? { ...d, relocation: true } : d)), ...eightDays('c', (n) => [{ name: `Pasture ${n}`, category: 'nature' }]).slice(0, 3).map((d, i) => (i === 0 ? { ...d, relocation: true } : d))] });
    for (const draft of [luxury, friends]) {
      const r = await run({ draft, trip: tripFor({ adults: 2 }) });
      expect(check(r.audit, 'nights_sum').ok).toBe(true);
      expect(check(r.audit, 'locked_dates_preserved').ok).toBe(true);
      expect(r.preservation.silentLoss).toBe(0);
      expect(r.metrics.lockedFactViolations).toBe(0);
    }
  });

  it('long road trip (Ireland, recorded): the metrics read the replay without a single violation of a locked or hard fact', async () => {
    const draft = irelandDraft();
    const { context } = irelandContext();
    const { itinerary } = await reconcileTripDraft({ draft, context });
    const trip: Trip = { ...IRELAND_TRIP, basics: { ...IRELAND_TRIP.basics, timingLock: 'traveler' } };
    const canonical = buildCanonicalTripBuildInput({ trip, composer: null, profile: context.profile, now: NOW });
    const contract = buildTripContract({ trip, input: canonical, bookedFacts: [], now: NOW });
    const audit = auditItinerary({ draft, itinerary, profile: context.profile, trip, contract, contractConflicts: [] });
    const metrics = buildStructuralMetrics({ itinerary, contract, audit });
    expect(metrics.lockedFactViolations).toBe(0);
    expect(metrics.transfersAsStops).toBe(0);
    expect(metrics.silentAnchorLoss).toBe(0);
    expect(metrics.hotelChurn).toBeGreaterThan(0);
    expect(metrics.activityDiversity).toBeGreaterThan(0.3);
    expect(Object.values(metrics).every((v) => v === null || typeof v === 'number' || v === 1)).toBe(true);
  });
});
