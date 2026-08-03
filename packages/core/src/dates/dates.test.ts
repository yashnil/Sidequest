import { describe, expect, it } from 'vitest';
import {
  CLIMATE_DATASET_VERSION,
  CLIMATE_EVIDENCE_NOTE,
  buildRegionPortfolio,
  climateProfileSchema,
  datesInWindow,
  durationClustersFrom,
  durationFits,
  recommendDateWindows,
  recommendTripLength,
  scopeStrategiesFor,
  seasonMonths,
  type ClimateNormal,
  type ClimateProfile,
  type DestinationIndexEntry,
  type TripComposerAnswers,
} from '../index';

const NOW = new Date('2026-08-02T00:00:00.000Z');

/**
 * A continental-mountain profile: cold snowy winters, hot dry summers, long
 * summer daylight. Shaped like Kyrgyzstan without being it — the point of the
 * whole design is that no destination is named anywhere in the engine.
 */
function normal(month: number, over: Partial<ClimateNormal> = {}): ClimateNormal {
  const base: Record<number, Partial<ClimateNormal>> = {
    1: { temperature: { low: -12, high: -3 }, wetDays: 9, snowDays: 11, daylightHours: 9.3, freezeDays: 30 },
    2: { temperature: { low: -11, high: -1 }, wetDays: 9, snowDays: 10, daylightHours: 10.5, freezeDays: 27 },
    3: { temperature: { low: -5, high: 6 }, wetDays: 11, snowDays: 6, daylightHours: 12 , freezeDays: 20 },
    4: { temperature: { low: 2, high: 15 }, wetDays: 12, snowDays: 2, daylightHours: 13.6, freezeDays: 8 },
    5: { temperature: { low: 7, high: 21 }, wetDays: 12, snowDays: 0, daylightHours: 14.9, freezeDays: 1 },
    6: { temperature: { low: 11, high: 26 }, wetDays: 8, snowDays: 0, daylightHours: 15.5, freezeDays: 0 },
    7: { temperature: { low: 14, high: 30 }, wetDays: 5, snowDays: 0, daylightHours: 15.2, hotDays: 6, freezeDays: 0 },
    8: { temperature: { low: 13, high: 29 }, wetDays: 4, snowDays: 0, daylightHours: 14.1, hotDays: 5, freezeDays: 0 },
    9: { temperature: { low: 8, high: 24 }, wetDays: 4, snowDays: 0, daylightHours: 12.6, freezeDays: 0 },
    10: { temperature: { low: 2, high: 16 }, wetDays: 7, snowDays: 1, daylightHours: 11.1, freezeDays: 6 },
    11: { temperature: { low: -4, high: 7 }, wetDays: 9, snowDays: 5, daylightHours: 9.8, freezeDays: 18 },
    12: { temperature: { low: -9, high: 0 }, wetDays: 10, snowDays: 9, daylightHours: 9.1, freezeDays: 28 },
  };
  return {
    month,
    temperature: { low: 5, high: 15 },
    precipitationMm: 30,
    wetDays: 8,
    snowDays: 0,
    daylightHours: 12,
    hotDays: 0,
    freezeDays: 0,
    ...base[month],
    ...over,
  };
}

const PROFILE: ClimateProfile = {
  schemaVersion: CLIMATE_DATASET_VERSION,
  coordinates: { lat: 41.5, lng: 74.7 },
  sampleYearFrom: 2005,
  sampleYearTo: 2024,
  months: Array.from({ length: 12 }, (_, index) => normal(index + 1)),
  provider: 'Open-Meteo',
  dataset: 'ERA5 reanalysis',
  attribution: 'Weather data by Open-Meteo.com (CC BY 4.0)',
  retrievedAt: '2026-08-01T00:00:00.000Z',
};

describe('the climate schema forbids a dated claim', () => {
  it('has no field a calendar date could be written into', () => {
    const keys = Object.keys(PROFILE.months[0]!);
    expect(keys).not.toContain('date');
    expect(keys).toContain('month');
  });

  it('refuses a profile with fewer than twelve months', () => {
    const partial = { ...PROFILE, months: PROFILE.months.slice(0, 6) };
    expect(climateProfileSchema.safeParse(partial).success).toBe(false);
  });

  it('carries the years its numbers came from', () => {
    expect(PROFILE.sampleYearTo - PROFILE.sampleYearFrom).toBe(19);
  });
});

describe('seasons follow the hemisphere', () => {
  it('puts southern spring in September', () => {
    expect(seasonMonths('spring', -33)).toEqual([9, 10, 11]);
    expect(seasonMonths('summer', -33)).toEqual([12, 1, 2]);
  });

  it('gives every month in the tropics, where the four-season model says nothing', () => {
    expect(seasonMonths('winter', 3)).toHaveLength(12);
  });
});

describe('recommending when to go', () => {
  it('prefers the warm, dry, long-daylight months for an outdoor trip', () => {
    const guidance = recommendDateWindows({ profile: PROFILE, year: 2027, now: NOW });
    if (guidance.kind !== 'recommended') throw new Error('expected a recommendation');
    const months = guidance.windows.map((window) => window.month);
    expect(months.some((month) => month >= 6 && month <= 9)).toBe(true);
    expect(months).not.toContain(1);
  });

  it('labels every number as climate, never as a forecast', () => {
    const guidance = recommendDateWindows({ profile: PROFILE, year: 2027, now: NOW });
    if (guidance.kind !== 'recommended') throw new Error('expected a recommendation');
    for (const window of guidance.windows) {
      expect(window.evidenceNote).toBe(CLIMATE_EVIDENCE_NOTE);
      expect(window.evidenceNote.toLowerCase()).toContain('not a forecast');
    }
  });

  it('refuses to recommend anything without a profile', () => {
    const guidance = recommendDateWindows({ profile: null, year: 2027, now: NOW });
    expect(guidance.kind).toBe('unavailable');
    if (guidance.kind !== 'unavailable') throw new Error('unreachable');
    expect(guidance.note).toContain('will not guess');
  });

  it('names what it could not establish rather than leaving it out', () => {
    const guidance = recommendDateWindows({ profile: PROFILE, year: 2027, now: NOW });
    if (guidance.kind !== 'recommended') throw new Error('expected a recommendation');
    const unknowns = guidance.windows[0]!.unknowns.join(' ');
    expect(unknowns).toContain('crowd');
    expect(unknowns).toContain('Prices');
  });

  it('states the tradeoff of a window as loudly as the reason for it', () => {
    const guidance = recommendDateWindows({
      profile: PROFILE,
      year: 2027,
      now: NOW,
      onlyMonths: [1],
      limit: 1,
    });
    if (guidance.kind !== 'recommended') throw new Error('expected a recommendation');
    const january = guidance.windows[0]!;
    expect(january.tradeoffs.length).toBeGreaterThan(0);
    expect(january.tradeoffs.join(' ')).toMatch(/cold|snow|daylight|Freezing/i);
  });

  it('rolls a month already past into next year', () => {
    // Asked in August, "February" can only mean the coming one.
    const guidance = recommendDateWindows({
      profile: PROFILE,
      year: 2026,
      now: NOW,
      onlyMonths: [2],
      limit: 1,
    });
    if (guidance.kind !== 'recommended') throw new Error('expected a recommendation');
    expect(guidance.windows[0]!.year).toBe(2027);
  });

  it('shifts what counts as comfortable for a trip that happens indoors', () => {
    const cultural = {
      themes: ['culture', 'food'],
    } as unknown as TripComposerAnswers;
    const outdoors = { themes: ['outdoors', 'mountains'] } as unknown as TripComposerAnswers;

    const forCulture = recommendDateWindows({
      profile: PROFILE,
      year: 2027,
      now: NOW,
      answers: cultural,
      limit: 12,
    });
    const forOutdoors = recommendDateWindows({
      profile: PROFILE,
      year: 2027,
      now: NOW,
      answers: outdoors,
      limit: 12,
    });
    if (forCulture.kind !== 'recommended' || forOutdoors.kind !== 'recommended') {
      throw new Error('expected recommendations');
    }
    const octoberCulture = forCulture.windows.find((w) => w.month === 10)!.score;
    const octoberOutdoors = forOutdoors.windows.find((w) => w.month === 10)!.score;
    expect(octoberCulture).toBeGreaterThan(octoberOutdoors);
  });

  it('is deterministic', () => {
    const a = recommendDateWindows({ profile: PROFILE, year: 2027, now: NOW });
    const b = recommendDateWindows({ profile: PROFILE, year: 2027, now: NOW });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('turns a window into dates that fall inside its month', () => {
    const guidance = recommendDateWindows({ profile: PROFILE, year: 2027, now: NOW, onlyMonths: [7], limit: 1 });
    if (guidance.kind !== 'recommended') throw new Error('expected a recommendation');
    const { startDate, endDate } = datesInWindow(guidance.windows[0]!, 8);
    expect(startDate.slice(0, 7)).toBe('2027-07');
    expect(endDate.slice(0, 7)).toBe('2027-07');
  });
});

// ---------------------------------------------------------------------------
// Region portfolios and duration
// ---------------------------------------------------------------------------

function feature(
  id: string,
  name: string,
  lat: number,
  lng: number,
  over: Partial<DestinationIndexEntry> = {},
): DestinationIndexEntry {
  return {
    id,
    catalog: 'test',
    sourceId: id,
    featureType: 'city',
    displayName: name,
    aliases: [],
    hierarchy: [],
    center: { lat, lng },
    population: 50_000,
    ...over,
  };
}

/** Four separated clusters, roughly 200–400 km apart. */
const COUNTRY = [
  feature('a1', 'Northcity', 42.87, 74.6, { population: 1_000_000, prominence: 92 }),
  feature('a2', 'Northtown', 42.9, 74.9, { population: 30_000 }),
  feature('b1', 'Lakeside', 42.49, 78.39, { population: 70_000, prominence: 60 }),
  feature('b2', 'Lakevillage', 42.6, 77.1, { population: 12_000 }),
  feature('c1', 'Southcity', 40.51, 72.8, { population: 300_000, prominence: 75 }),
  feature('d1', 'Fareast', 39.9, 71.7, { population: 40_000 }),
];

describe('a country becomes a portfolio, not a bigger circle', () => {
  it('finds separate clusters and names a gateway', () => {
    const portfolio = buildRegionPortfolio({
      entries: COUNTRY,
      mode: 'drive',
      destinationName: 'Testland',
      nights: 11,
    });
    expect(portfolio.gateway?.name).toBe('Northcity');
    expect(portfolio.allClusters.length).toBeGreaterThanOrEqual(3);
    // Places within a day's reach of each other are one cluster, not two bases.
    const north = portfolio.allClusters.find((cluster) => cluster.name === 'Northcity')!;
    expect(north.memberCount).toBeGreaterThanOrEqual(2);
  });

  it('proposes more bases for a longer trip and fewer for a short one', () => {
    const long = buildRegionPortfolio({ entries: COUNTRY, mode: 'drive', destinationName: 'Testland', nights: 12 });
    const short = buildRegionPortfolio({ entries: COUNTRY, mode: 'drive', destinationName: 'Testland', nights: 4 });
    expect(long.basesProposed).toBeGreaterThan(short.basesProposed);
    expect(short.basesProposed).toBe(1);
  });

  it('names what it left out and why, rather than dropping it silently', () => {
    const portfolio = buildRegionPortfolio({ entries: COUNTRY, mode: 'drive', destinationName: 'Testland', nights: 4 });
    expect(portfolio.excluded.length).toBeGreaterThan(0);
    for (const entry of portfolio.excluded) expect(entry.reason.length).toBeGreaterThan(10);
  });

  it('honours a stated ceiling on base changes', () => {
    const portfolio = buildRegionPortfolio({
      entries: COUNTRY,
      mode: 'drive',
      destinationName: 'Testland',
      nights: 14,
      maxBaseChanges: 1,
    });
    expect(portfolio.basesProposed).toBe(2);
    expect(portfolio.excluded.some((entry) => entry.reason.includes('rather not move'))).toBe(true);
  });

  it('merges far less ground without a car', () => {
    const driving = buildRegionPortfolio({ entries: COUNTRY, mode: 'drive', destinationName: 'Testland' });
    const walking = buildRegionPortfolio({ entries: COUNTRY, mode: 'walk', destinationName: 'Testland' });
    expect(walking.allClusters.length).toBeGreaterThanOrEqual(driving.allClusters.length);
  });

  it('says so rather than inventing a base when there is nowhere to sleep', () => {
    const noTowns = [feature('r1', 'Some Region', 41, 74, { featureType: 'region' })];
    const portfolio = buildRegionPortfolio({ entries: noTowns, mode: 'drive', destinationName: 'Testland' });
    expect(portfolio.gateway).toBeNull();
    expect(portfolio.rationale).toContain('could not find');
  });

  it('is deterministic', () => {
    const a = buildRegionPortfolio({ entries: COUNTRY, mode: 'drive', destinationName: 'Testland', nights: 9 });
    const b = buildRegionPortfolio({ entries: [...COUNTRY].reverse(), mode: 'drive', destinationName: 'Testland', nights: 9 });
    expect(a.route.map((c) => c.id)).toEqual(b.route.map((c) => c.id));
  });

  it('the route and the strategy list describe the same trip', () => {
    /*
     * A live defect: the route was chosen nearest-first from the gateway while
     * the strategies were chosen by rank, so the map showed three towns around
     * the capital and the text beside it named three regions of the country.
     * Selection is by rank now; only the *order* is nearest-next.
     */
    const portfolio = buildRegionPortfolio({
      entries: COUNTRY,
      mode: 'drive',
      destinationName: 'Testland',
      nights: 12,
    });
    /*
     * The property is not that the two lists are equal — a twelve-night trip can
     * afford four bases while the "circuit" strategy describes three. It is that
     * both draw from the *same rank order*, so the route is always the top N
     * clusters and never a different N chosen by proximity.
     */
    const byRank = portfolio.allClusters.map((cluster) => cluster.name);
    const routeNames = portfolio.route.map((cluster) => cluster.name);
    expect([...routeNames].sort()).toEqual(byRank.slice(0, routeNames.length).sort());

    const strategies = scopeStrategiesFor({ portfolio, nights: 12, destinationName: 'Testland' });
    const circuit = strategies.find((strategy) => strategy.id === 'circuit')!;
    expect(circuit.covers).toEqual(byRank.slice(0, circuit.covers.length));
    // And the strategy's areas are a subset of the route's, not a different set.
    for (const name of circuit.covers) expect(routeNames).toContain(name);
  });
});

describe('scope strategies come from the geography', () => {
  const portfolio = buildRegionPortfolio({ entries: COUNTRY, mode: 'drive', destinationName: 'Testland', nights: 11 });

  it('offers depth, two bases and a circuit when the clusters support them', () => {
    const strategies = scopeStrategiesFor({ portfolio, nights: 11, destinationName: 'Testland' });
    expect(strategies.map((s) => s.id)).toEqual(['one_area', 'two_bases', 'circuit', 'name_it']);
    for (const strategy of strategies.slice(0, 3)) expect(strategy.available).toBe(true);
  });

  it('keeps an option a short trip cannot afford, and says why', () => {
    const strategies = scopeStrategiesFor({ portfolio, nights: 4, destinationName: 'Testland' });
    const circuit = strategies.find((s) => s.id === 'circuit')!;
    expect(circuit.available).toBe(false);
    expect(circuit.unavailableReason).toContain('you have 4');
  });

  it('names the areas each strategy would cover, so the choice is concrete', () => {
    const strategies = scopeStrategiesFor({ portfolio, nights: 11, destinationName: 'Testland' });
    expect(strategies[1]!.covers.length).toBe(2);
    expect(strategies[1]!.covers[0]).toBe('Northcity');
  });
});

describe('recommending a trip length', () => {
  const portfolio = buildRegionPortfolio({ entries: COUNTRY, mode: 'drive', destinationName: 'Testland' });
  const clusters = durationClustersFrom(portfolio);

  it('derives options from the clusters rather than from the country', () => {
    const guidance = recommendTripLength({
      featureType: 'country',
      destinationName: 'Testland',
      clusters,
    });
    if (guidance.kind !== 'recommended') throw new Error('expected a recommendation');
    expect(guidance.options.length).toBeGreaterThanOrEqual(2);
    expect(guidance.basis).toContain('distinct area');
    expect(guidance.options.every((option) => option.maxNights >= option.minNights)).toBe(true);
  });

  it('recommends nothing when nobody has said how long the trip is', () => {
    /*
     * The badge that used to sit here read "best value for the ground" and was
     * on the shortest option for every destination, because the metric behind
     * it (clusters per night) is the same for every option by construction. A
     * recommendation with no basis is worse than none.
     */
    const guidance = recommendTripLength({
      featureType: 'country',
      destinationName: 'Testland',
      clusters,
    });
    if (guidance.kind !== 'recommended') throw new Error('expected a recommendation');
    expect(guidance.options.filter((option) => option.recommended)).toHaveLength(0);
  });

  it('recommends the option that fits the nights the traveller has', () => {
    const guidance = recommendTripLength({
      featureType: 'country',
      destinationName: 'Testland',
      clusters,
      nights: 11,
    });
    if (guidance.kind !== 'recommended') throw new Error('expected a recommendation');
    const recommended = guidance.options.filter((option) => option.recommended);
    expect(recommended).toHaveLength(1);
    // Whatever the arithmetic produces, it must not be the shortest option for
    // an eleven-night trip.
    const shortest = guidance.options.reduce((a, b) => (a.maxNights < b.maxNights ? a : b));
    expect(recommended[0]!.label).not.toBe(shortest.label);
  });

  it('marks the closest option when no range contains the nights given', () => {
    const guidance = recommendTripLength({
      featureType: 'country',
      destinationName: 'Testland',
      clusters,
      nights: 29,
    });
    if (guidance.kind !== 'recommended') throw new Error('expected a recommendation');
    const recommended = guidance.options.filter((option) => option.recommended);
    expect(recommended).toHaveLength(1);
    const longest = guidance.options.reduce((a, b) => (a.maxNights > b.maxNights ? a : b));
    expect(recommended[0]!.label).toBe(longest.label);
  });

  it('longer options reach more of the region', () => {
    const guidance = recommendTripLength({ featureType: 'country', destinationName: 'Testland', clusters });
    if (guidance.kind !== 'recommended') throw new Error('expected a recommendation');
    const sorted = [...guidance.options].sort((a, b) => a.maxNights - b.maxNights);
    for (let index = 1; index < sorted.length; index += 1) {
      expect(sorted[index]!.clustersReached).toBeGreaterThanOrEqual(sorted[index - 1]!.clustersReached);
    }
  });

  it('refuses rather than guessing when nothing has been clustered', () => {
    const guidance = recommendTripLength({ featureType: 'country', destinationName: 'Testland', clusters: [] });
    expect(guidance.kind).toBe('unavailable');
  });

  it('tells a traveller with fixed dates what those dates buy', () => {
    const guidance = recommendTripLength({ featureType: 'country', destinationName: 'Testland', clusters });
    const short = durationFits({ nights: 3, guidance });
    expect(short.note ?? '').toMatch(/short|would build/i);

    const long = durationFits({ nights: 20, guidance });
    expect(long.fits).toBe(true);
  });

  it('never silently shrinks the destination', () => {
    const guidance = recommendTripLength({ featureType: 'country', destinationName: 'Testland', clusters });
    const verdict = durationFits({ nights: 4, guidance });
    // Either it fits, or the shortfall is stated. Never a quiet truncation.
    expect(verdict.fits === true || typeof verdict.note === 'string').toBe(true);
  });
});
