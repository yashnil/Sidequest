import { describe, expect, it } from 'vitest';
import { defaultAnswers } from '../questionnaire/transform';
import { interestOfferFromEntityType } from '../interests/offer';
import { questionById, type InterviewContext } from './catalog';
import { recommendedInterests } from './recommended';
import { screenDestination, type ScreeningSignals } from './traits';
import type { TravelerNeed } from '../schemas/trip';

/**
 * Production pass — the priorities screen's "Recommended for this trip".
 *
 * Signals, never names: each case is a destination shape plus a season, a
 * length and a party, and the assertion is about how the recommendation moves
 * when one of those moves.
 */
function contextFor(signals: ScreeningSignals, party: { children?: number; needs?: TravelerNeed[] } = {}): InterviewContext {
  const destination = screenDestination(signals);
  const offer = interestOfferFromEntityType(signals.entityType ?? 'unknown');
  return { destination, traveller: { travelerNeeds: party.needs ?? [], tripDays: signals.tripDays, adults: 2, children: party.children ?? 0, offeredInterests: offer.interests, carried: [] } };
}

const rockies = (startDate: string, tripDays = 8): ScreeningSignals => ({
  name: 'the Canadian Rockies',
  proseName: 'the Canadian Rockies',
  tripDays,
  entityType: 'natural_region',
  breadth: 'region',
  semantic: { type: 'mountain_region', scale: 'region', landscape: 'rockies', extentSource: 'interpreted_parts', gateways: 3 },
  center: { lat: 51.4, lng: -116.2 },
  bounds: { southWest: { lat: 50.6, lng: -118.3 }, northEast: { lat: 53.2, lng: -114.9 } },
  startDate,
});

const city = (tripDays: number): ScreeningSignals => ({
  name: 'Harbour City',
  proseName: 'Harbour City',
  tripDays,
  entityType: 'city',
  breadth: 'city',
  center: { lat: 38.72, lng: -9.14 },
  startDate: '2027-05-10',
  population: 2_800_000,
});

describe('recommendedInterests', () => {
  it('leads a summer mountain trip with hiking, and says why', () => {
    const recs = recommendedInterests(contextFor(rockies('2027-07-10')));
    expect(recs.length).toBe(3);
    expect(recs[0]!.interest).toBe('hiking');
    expect(recs[0]!.reason).toMatch(/trails|mountain/i);
    for (const r of recs) expect(r.reason.length).toBeGreaterThan(5);
  });

  it('moves a family with young children off hiking and onto easy ground', () => {
    const recs = recommendedInterests(contextFor(rockies('2027-07-10'), { children: 2, needs: ['kids_under_12'] }));
    const ids = recs.map((r) => r.interest);
    expect(ids).toContain('easy_nature_walks');
    expect(ids.indexOf('hiking') === -1 || ids.indexOf('hiking') > ids.indexOf('easy_nature_walks')).toBe(true);
    expect(recs.find((r) => r.interest === 'easy_nature_walks')!.reason).toMatch(/children/i);
  });

  it('gives a short city trip what fits close to a base', () => {
    const recs = recommendedInterests(contextFor(city(3)));
    expect(recs.map((r) => r.interest)).toEqual(expect.arrayContaining(['food_and_towns']));
    expect(recs.map((r) => r.interest)).not.toContain('scenic_drives');
  });

  it('only ever recommends what the destination offers', () => {
    const ctx = contextFor(city(5));
    for (const r of recommendedInterests(ctx)) expect(ctx.traveller.offeredInterests).toContain(r.interest);
  });

  it('is what "Decide for me" applies on the priorities question', () => {
    const ctx = contextFor(rockies('2027-07-10'));
    const answers = defaultAnswers({ travelerNeeds: [], tripDays: 8 });
    const def = questionById(ctx, answers, 'priorities')!.smartDefault(ctx, answers);
    expect(def.value).toEqual(recommendedInterests(ctx).map((r) => r.interest));
  });

  it('is deterministic', () => {
    const ctx = contextFor(rockies('2027-01-10'));
    expect(recommendedInterests(ctx)).toEqual(recommendedInterests(ctx));
  });
});
