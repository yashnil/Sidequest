import { describe, expect, it } from 'vitest';
import { expandRegion, worthDetourLabel } from './expansion';
import { assessSeason, describeOpenSeason } from './season';
import { EASTERN_SIERRA, EASTERN_SIERRA_ACCESS, EASTERN_SIERRA_PLACES, placeById } from '../data/index';
import { assessPlaceAccess, capabilityFromProfile } from '../access/feasibility';
import {
  AUGUST_DATES,
  AUGUST_MONTHS,
  JANUARY_MONTHS,
  MAMMOTH_HIKER_ANSWERS,
  boardContext,
  context,
  profile,
} from '../testing/fixtures';

const expand = (
  overrides: Parameters<typeof profile>[0] = MAMMOTH_HIKER_ANSWERS,
  dates = AUGUST_DATES,
  ctx = context(),
) => {
  const shared = boardContext(dates);
  return expandRegion({
    region: EASTERN_SIERRA,
    places: EASTERN_SIERRA_PLACES,
    profile: profile(overrides, ctx),
    months: shared.months,
    dates: shared.dates,
    access: shared.access,
  });
};

describe('regional expansion', () => {
  it('turns a destination into a base plus satellites', () => {
    const expansion = expand();
    expect(expansion.base.length).toBeGreaterThan(0);
    expect(expansion.satellites.length).toBeGreaterThan(5);
    expect(expansion.base.every((item) => item.place.relationship === 'base')).toBe(true);
    expect(expansion.satellites.every((item) => item.place.relationship === 'satellite')).toBe(true);
  });

  it('reaches the Eastern Sierra names a Mammoth trip should include', () => {
    const ids = expand().satellites.map((item) => item.place.id);
    expect(ids).toContain('convict-lake');
    expect(ids).toContain('hot-creek-geologic-site');
    expect(ids).toContain('minaret-vista');
    expect(ids).toContain('june-lake-loop');
    expect(ids).toContain('mono-lake-south-tufa');
  });

  it('sorts satellites by how far out they are', () => {
    const times = expand().satellites.map((item) => item.driveMinutes);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it('widens and narrows with the traveller’s stated radius', () => {
    const tight = expand({ ...MAMMOTH_HIKER_ANSWERS, regionalExpansion: 'destination_only' });
    const wide = expand({
      ...MAMMOTH_HIKER_ANSWERS,
      regionalExpansion: 'best_regional',
      detourToleranceMinutes: 150,
      maxDailyTravelMinutes: 300,
    });

    expect(tight.radiusMinutes).toBeLessThan(wide.radiusMinutes);
    expect(tight.satellites.length).toBeLessThan(wide.satellites.length);

    const tightIds = tight.satellites.map((item) => item.place.id);
    expect(tightIds).not.toContain('mono-lake-south-tufa');

    const wideIds = wide.satellites.map((item) => item.place.id);
    expect(wideIds).toContain('bodie-state-historic-park');
  });

  it('puts anything past the daily driving budget out of reach', () => {
    const expansion = expand();
    const beyond = expansion.beyondRadius.map((item) => item.place.id);
    // Two hours each way from Mammoth is a travel day, not a day trip.
    expect(beyond).toContain('alabama-hills');
    expect(beyond).toContain('manzanar-historic-site');
  });

  it('classifies a stop just outside the limit as a stretch rather than dropping it', () => {
    const expansion = expand({ ...MAMMOTH_HIKER_ANSWERS, detourToleranceMinutes: 40 });
    const monoLake = expansion.satellites.find((item) => item.place.id === 'mono-lake-south-tufa');
    expect(monoLake?.detourClass).toBe('stretch');
  });

  it('reports the share of the day a round trip consumes', () => {
    const monoLake = expand().satellites.find((item) => item.place.id === 'mono-lake-south-tufa');
    // 50 minutes each way against a 150 minute daily budget.
    expect(monoLake?.travelBudgetShare).toBeCloseTo(100 / 150, 5);
  });
});

describe('seasonal access', () => {
  it('reports a summer-only place as open in August and closed in January', () => {
    const postpile = placeById('devils-postpile')!;
    expect(assessSeason(postpile, AUGUST_MONTHS).status).toBe('open');
    expect(assessSeason(postpile, JANUARY_MONTHS).status).toBe('closed');
  });

  it('leaves the shuttle to the access rules rather than answering by month', () => {
    // `assessSeason` answers "is the road open"; it deliberately no longer
    // answers "is a shuttle mandatory", because that question needs a weekday
    // and an hour and this one only ever had a month.
    const postpile = placeById('devils-postpile')!;
    expect(assessSeason(postpile, AUGUST_MONTHS)).not.toHaveProperty('shuttleRequired');
    expect(assessSeason(postpile, [10]).status).toBe('open');

    const capability = capabilityFromProfile(profile(MAMMOTH_HIKER_ANSWERS, context()));
    const august = assessPlaceAccess({
      placeId: 'devils-postpile',
      dataset: EASTERN_SIERRA_ACCESS,
      dates: ['2026-08-12'],
      capability,
    });
    expect(august.requiredModes).toContain('shuttle');

    // October: the road is open and the shuttle has stopped, so you drive.
    const october = assessPlaceAccess({
      placeId: 'devils-postpile',
      dataset: EASTERN_SIERRA_ACCESS,
      dates: ['2026-10-12'],
      capability,
    });
    expect(october.requiredModes).not.toContain('shuttle');
    expect(october.requiredModes).toContain('drive');
  });

  it('reports a partially open window when a trip straddles the closure', () => {
    const tioga = placeById('tioga-pass-tuolumne')!;
    const assessment = assessSeason(tioga, [10, 11]);
    expect(assessment.status).toBe('partially_open');
    expect(assessment.openTripMonths).toEqual([10]);
  });

  it('leaves a year-round place open whenever you go', () => {
    const convict = placeById('convict-lake')!;
    expect(assessSeason(convict, JANUARY_MONTHS).status).toBe('open');
    expect(describeOpenSeason(convict)).toBe('Open year-round');
  });

  it('describes a contiguous season readably', () => {
    expect(describeOpenSeason(placeById('devils-postpile')!)).toBe('Usually open June to October');
  });
});

describe('worth-the-detour verdict', () => {
  it('combines distance with fit rather than reporting distance alone', () => {
    expect(worthDetourLabel('in_tolerance', 'top_pick')).toBe('definitely_worth_it');
    expect(worthDetourLabel('stretch', 'top_pick')).toBe('definitely_worth_it');
    expect(worthDetourLabel('stretch', 'strong')).toBe('worth_it_if_you_like_this');
    expect(worthDetourLabel('in_tolerance', 'optional')).toBe('only_if_nearby');
    expect(worthDetourLabel('too_far', 'good')).toBe('too_far_for_this_trip');
    expect(worthDetourLabel('base', 'strong')).toBe('core_to_trip');
    expect(worthDetourLabel('in_tolerance', 'not_workable')).toBe('skip_for_your_style');
  });
});
