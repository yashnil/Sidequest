import { describe, expect, it } from 'vitest';
import {
  contractStatedItinerary,
  fitStatedNights,
  plannedStaysFromNights,
  sameStatedPlace,
  statedItineraryBands,
  statedItinerarySchema,
  statedStayConflicts,
  statedStopLock,
  type StatedItineraryInput,
} from './stated-itinerary';
import { countLockedFacts, contractBands, type TripContract } from './trip-contract';
import { statedStaysFor } from '../scan/assemble';
import { withStatedBases } from '../scan/stated-bases';
import { chooseStays, DEFAULT_STAY_TRAVELLER } from '../scan/stay-objective';
import { critiquePlan, type PlanCheckStopInput } from '../plan-check/critique';
import { parsePlanText } from '../plan-check/parse';
import { statedItineraryFromPlan } from '../plan-check/stated';
import { defaultAcceptedChanges } from '../plan-check/critique';

/** Invented labels; every assertion is about structure, nights and locks, never about a real place. */
const NOW = new Date('2026-11-14T12:00:00Z');

function record(stops: StatedItineraryInput['stops'], extra: Partial<StatedItineraryInput> = {}) {
  return statedItinerarySchema.parse({ version: 1, source: 'plan_check', stops, parseConfidence: 1, recordedAt: NOW.toISOString(), ...extra });
}

const stop = (id: string, label: string, nights: number, extra: Partial<StatedItineraryInput['stops'][number]> = {}) => ({ id, label, nights, nightsProvenance: 'stated' as const, dayTrip: false, fixed: false, ...extra });

describe('the stated itinerary — schema, provenance and locks', () => {
  it('locks a stated stay at user_explicit, a booked one at booked_lock and a split one at sidequest_inferred', () => {
    expect(statedStopLock({ fixed: false, nightsProvenance: 'stated' })).toBe('user_explicit');
    expect(statedStopLock({ fixed: false, nightsProvenance: 'parsed' })).toBe('user_explicit');
    expect(statedStopLock({ fixed: true, nightsProvenance: 'assumed' })).toBe('booked_lock');
    expect(statedStopLock({ fixed: false, nightsProvenance: 'assumed' })).toBe('sidequest_inferred');
  });

  it('is versioned and refuses a record it cannot read rather than guessing', () => {
    expect(statedItinerarySchema.safeParse({ version: 2, source: 'plan_check', stops: [], parseConfidence: 1, recordedAt: 'x' }).success).toBe(false);
    expect(record([stop('s1', 'Alpha', 3)]).version).toBe(1);
  });

  it('carries the stays, day trips and must-sees into the contract, and the locked stays count as locked facts', () => {
    const stated = contractStatedItinerary(record([stop('s1', 'Alpha', 3, { mustSee: ['Old Gate'] }), stop('s2', 'Beta', 0, { dayTrip: true }), stop('s3', 'Gamma', 2, { fixed: true, transportIn: { mode: 'rail', provenance: 'stated' } })]));
    expect(stated.stays.map((s) => [s.label, s.nights, s.lock])).toEqual([
      ['Alpha', 3, 'user_explicit'],
      ['Gamma', 2, 'booked_lock'],
    ]);
    expect(stated.dayTrips.map((d) => d.label)).toEqual(['Beta']);
    expect(stated.statedNights).toBe(5);
    const bands = statedItineraryBands(stated);
    expect(bands[0]).toMatch(/Alpha \(3 nights\), then Gamma \(2 nights, booked\)/);
    expect(bands.join(' ')).toMatch(/reach Gamma by train/);
    expect(bands.join(' ')).toMatch(/At Alpha they want to see: Old Gate/);

    const contract = { destination: { lock: 'user_explicit' }, timing: { open: true, lock: 'model_proposed' }, party: { adults: { lock: 'user_explicit' }, children: { lock: 'user_explicit' }, members: [], dietaryHard: [], needs: [] }, transport: { preference: { lock: 'model_proposed' }, maxDailyDriveMinutes: { lock: 'model_proposed', value: null }, prohibitions: [] }, hardConstraints: [], booked: [], priorities: [], statedItinerary: stated } as unknown as TripContract;
    expect(countLockedFacts(contract)).toBe(3 + 2);
    expect(contractBands(contract).mustKeep.join(' ')).toMatch(/own stays, in this order/);
  });
});

describe('honouring the stated stays, checked after the plan is built', () => {
  const stated = contractStatedItinerary(record([stop('s1', 'Alpha', 4), stop('s2', 'Kyoto', 3)]));

  it('reads stays off the nightly bases and finds every stated stay honoured', () => {
    const planned = plannedStaysFromNights(['Alpha', 'Alpha', 'Alpha', 'Alpha', 'Kyoto', 'Kyoto', 'Kyoto']);
    expect(planned).toEqual([
      { baseName: 'Alpha', nights: 4 },
      { baseName: 'Kyoto', nights: 3 },
    ]);
    const { outcomes, conflicts } = statedStayConflicts(stated, planned, NOW.toISOString());
    expect(outcomes.every((o) => o.outcome === 'honoured')).toBe(true);
    expect(conflicts).toHaveLength(0);
  });

  it('records a conflict, never a silent replacement, when the nights or the stay are not kept', () => {
    const changed = statedStayConflicts(stated, plannedStaysFromNights(['Alpha', 'Alpha', 'Alpha', 'Alpha', 'Alpha', 'Kyoto', 'Kyoto']), NOW.toISOString());
    expect(changed.conflicts.map((c) => c.field)).toEqual(['stated.stay.s1', 'stated.stay.s2']);
    expect(changed.conflicts[1]).toMatchObject({ lock: 'user_explicit', resolution: 'field_rejected' });
    expect(changed.conflicts[1]!.detail).toMatch(/gave 3 nights in Kyoto; the plan could only hold 2/);
    const missing = statedStayConflicts(stated, plannedStaysFromNights(['Alpha', 'Alpha', 'Alpha', 'Alpha', 'Alpha', 'Alpha', 'Alpha']), NOW.toISOString());
    expect(missing.outcomes[1]!.outcome).toBe('not_slept');
    expect(missing.conflicts[1]!.detail).toMatch(/could not be planned as a stay/);
  });

  it('matches a base that carries a district, but never a name that joins two places', () => {
    expect(sameStatedPlace('Kyoto', 'Kyoto (Higashiyama)')).toBe(true);
    expect(sameStatedPlace('Rome', 'Rome and Florence')).toBe(false);
    expect(sameStatedPlace('Rome', 'Romeo Bay Village Resort Centre')).toBe(false);
  });

  it('fits only Sidequest’s own nights to the trip’s length', () => {
    const fitted = fitStatedNights(
      [
        { stopId: 'a', nights: 3, lock: 'user_explicit' },
        { stopId: 'b', nights: 2, lock: 'sidequest_inferred' },
      ],
      6,
    );
    expect(fitted.nights.get('a')).toBe(3);
    expect(fitted.nights.get('b')).toBe(3);
    expect(fitted.mismatch).toBe(0);
    const held = fitStatedNights([{ stopId: 'a', nights: 3, lock: 'user_explicit' }], 5);
    expect(held.nights.get('a')).toBe(3);
    expect(held.mismatch).toBe(2);
  });
});

describe('the scan sleeps where the plan says', () => {
  const proposal = {
    bases: [{ key: 'b1', name: 'Model Base', locality: 'Model Base', nightsHint: 4, why: 'x' }],
    candidates: [],
    foodAreas: [],
    skipped: [],
    package: { transportSummary: '', transportNotes: [], beforeYouGo: [], packing: [], foodStrategy: [], bookingPriorities: [] },
  } as unknown as Parameters<typeof withStatedBases>[0];

  it('adds every stated stay as a base, in order, ahead of the proposal’s own', () => {
    const { proposal: next, keys } = withStatedBases(proposal, [
      { label: 'Alpha', nights: 4 },
      { label: 'Kyoto', nights: 3, fixed: true },
    ]);
    expect(next.bases.map((b) => b.name)).toEqual(['Alpha', 'Kyoto', 'Model Base']);
    expect(keys).toHaveLength(2);
    expect(next.bases[1]!.why).toMatch(/booked/);
    const matched = withStatedBases({ ...proposal, bases: [{ key: 'b9', name: 'Kyoto (Higashiyama)', locality: 'Kyoto', nightsHint: 2, why: 'x' }] } as typeof proposal, [{ label: 'Kyoto', nights: 3 }]);
    expect(matched.keys).toEqual(['b9']);
    expect(matched.proposal.bases[0]!.nightsHint).toBe(3);
  });

  it('keeps the stated nights, and gives an unplaced stay’s nights to its neighbour with a record', () => {
    const kept = statedStaysFor(
      [
        { key: 'k1', label: 'Alpha', nights: 4, lock: 'user_explicit' },
        { key: 'k2', label: 'Kyoto', nights: 3, lock: 'user_explicit' },
      ],
      [
        { id: 'base-a', key: 'k1' },
        { id: 'base-k', key: 'k2' },
      ],
      7,
    )!;
    expect(kept.stays.map((s) => [s.baseId, s.nights])).toEqual([
      ['base-a', 4],
      ['base-k', 3],
    ]);
    expect(kept.record.honoured.map((h) => h.label)).toEqual(['Alpha', 'Kyoto']);
    const lost = statedStaysFor(
      [
        { key: 'k1', label: 'Alpha', nights: 4, lock: 'user_explicit' },
        { key: 'k2', label: 'Kyoto', nights: 3, lock: 'user_explicit' },
      ],
      [{ id: 'base-a', key: 'k1' }],
      7,
    )!;
    expect(lost.stays).toEqual([{ baseId: 'base-a', nights: 7, label: 'Alpha' }]);
    expect(lost.record.unplaced[0]!.label).toBe('Kyoto');
    expect(lost.note).toMatch(/Kyoto could not be placed/);
  });

  it('the stay objective takes the stated stays as the structure even when one base would be cheaper', () => {
    const minutes = (a: string, b: string) => (a === b ? 0 : 200);
    const choice = chooseStays({
      bases: [
        { id: 'a', name: 'Alpha' },
        { id: 'k', name: 'Kyoto' },
      ],
      places: [],
      minutes,
      nights: 7,
      maxBaseChanges: 0,
      traveller: DEFAULT_STAY_TRAVELLER,
      stated: {
        stays: [
          { baseId: 'a', nights: 4, label: 'Alpha' },
          { baseId: 'k', nights: 3, label: 'Kyoto' },
        ],
      },
    });
    expect(choice.stays).toEqual([
      { baseId: 'a', nights: 4 },
      { baseId: 'k', nights: 3 },
    ]);
    expect(choice.decision.sentence).toMatch(/^Your own plan, as you wrote it: Alpha for 4 nights, then Kyoto for 3 nights\./);
  });
});

describe('a checked plan becomes the stated itinerary with honest provenance', () => {
  it('"3 nights in Kyoto" is stated; an even split is assumed; an accepted major change becomes theirs', () => {
    const parsed = parsePlanText('10 days: 4 nights Alpha, 3 nights in Kyoto, Gamma', NOW);
    const stops: PlanCheckStopInput[] = parsed.stops.map((s, i) => ({ label: s.label, point: { lat: 35 + i * 0.3, lng: 139 }, countryCode: 'JP', kind: 'city', nights: s.nights, nightsBasis: s.nightsBasis, dayTrip: s.dayTrip }));
    const result = critiquePlan({ totalNights: parsed.totalNights, stops });
    const accepted = defaultAcceptedChanges(result.proposal.changes);
    const stated = statedItineraryFromPlan({ version: result.proposal.original, original: result.proposal.original, changes: result.proposal.changes, accepted, parseConfidence: parsed.confidence, now: NOW });
    expect(stated.stops.map((s) => [s.label, s.nights, s.nightsProvenance])).toEqual([
      ['Alpha', 4, 'stated'],
      ['Kyoto', 3, 'stated'],
      ['Gamma', 2, 'assumed'],
    ]);
    expect(statedItinerarySchema.safeParse(stated).success).toBe(true);
  });
});
