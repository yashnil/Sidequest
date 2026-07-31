import { describe, expect, it } from 'vitest';
import { autoSelect } from './autoselect';
import { buildDiscoveryBoard, type DiscoveryBoard } from './board';
import {
  EASTERN_SIERRA,
  EASTERN_SIERRA_WEATHER_LOCATIONS,
  buildFixtureWeather,
  placeById,
} from '../data/index';
import { boardWeatherBackups } from '../weather/board-backups';
import {
  WEATHER_DATASET_VERSION,
  weatherDatasetSchema,
  type WeatherDataset,
} from '../schemas/weather';
import type { QuestionnaireAnswers, TravelerProfile } from '../schemas/profile';
import type { TravelerNeed } from '../schemas/trip';
import {
  AUGUST_DATES,
  JANUARY_DATES,
  MAMMOTH_HIKER_ANSWERS,
  boardContext,
  context,
  interests,
  profile,
} from '../testing/fixtures';

function setup(
  overrides: Partial<QuestionnaireAnswers> = MAMMOTH_HIKER_ANSWERS,
  dates = AUGUST_DATES,
  travelerNeeds: TravelerNeed[] = [],
  tripDays = 4,
): { board: DiscoveryBoard; profile: TravelerProfile; tripDays: number } {
  const ctx = context({ travelerNeeds, tripDays });
  const built = profile(overrides, ctx);
  return {
    board: buildDiscoveryBoard({
      ...boardContext(dates),
      profile: built,
      travelerNeeds,
    }),
    profile: built,
    tripDays,
  };
}

function pick(overrides: Partial<QuestionnaireAnswers> = MAMMOTH_HIKER_ANSWERS, dates = AUGUST_DATES, needs: TravelerNeed[] = [], tripDays = 4) {
  const { board, profile: built } = setup(overrides, dates, needs, tripDays);
  return { ...autoSelect({ candidates: board.candidates, profile: built, tripDays }), board, profile: built };
}

describe('discovery board grouping', () => {
  it('splits candidates into groups a traveller can actually navigate', () => {
    const { board } = setup();
    const groupIds = board.groups.map((entry) => entry.group);
    expect(groupIds).toContain('must_see_classics');
    expect(groupIds).toContain('hidden_gems');
    expect(groupIds).toContain('scenic_detours');
    expect(groupIds).toContain('weak_fit');
  });

  it('puts each candidate in exactly one group', () => {
    const { board } = setup();
    const grouped = board.groups.flatMap((entry) => entry.candidates.map((c) => c.place.id));
    expect(grouped.length).toBe(board.candidates.length);
    expect(new Set(grouped).size).toBe(grouped.length);
  });

  it('files a genuine hidden gem under hidden gems, not classics', () => {
    const { board } = setup();
    const obsidian = board.candidates.find((c) => c.place.id === 'obsidian-dome');
    expect(obsidian?.group).toBe('hidden_gems');
    expect(placeById('obsidian-dome')?.hiddenGemScore).toBeGreaterThan(0.6);
  });

  it('puts unworkable places in the skip group with an explanation', () => {
    const { board } = setup(MAMMOTH_HIKER_ANSWERS, JANUARY_DATES);
    const skip = board.groups.find((entry) => entry.group === 'weak_fit');
    expect(skip).toBeDefined();
    const postpile = skip?.candidates.find((c) => c.place.id === 'devils-postpile');
    expect(postpile).toBeDefined();
    expect(postpile?.fit.blockers[0]?.message.length).toBeGreaterThan(10);
  });

  it('offers bad-weather and low-effort backups', () => {
    const { board } = setup();
    const backups = board.groups.find((entry) => entry.group === 'low_effort_backups');
    expect(backups?.candidates.length).toBeGreaterThan(0);
    for (const candidate of backups?.candidates ?? []) {
      expect(candidate.place.weather.poorWeatherBackup).toBe(true);
    }
  });
});

describe('auto-selection', () => {
  it('is deterministic', () => {
    expect(pick().selectedIds).toEqual(pick().selectedIds);
  });

  it('scales the number of picks to trip length and pace', () => {
    const short = pick(MAMMOTH_HIKER_ANSWERS, AUGUST_DATES, [], 3);
    const long = pick(MAMMOTH_HIKER_ANSWERS, AUGUST_DATES, [], 7);
    expect(long.targetCount).toBeGreaterThan(short.targetCount);

    const slow = pick({ ...MAMMOTH_HIKER_ANSWERS, pace: 'slow' });
    const fast = pick({ ...MAMMOTH_HIKER_ANSWERS, pace: 'fast' });
    expect(fast.targetCount).toBeGreaterThan(slow.targetCount);
  });

  it('never pre-selects something unworkable', () => {
    const { selectedIds, board } = pick(MAMMOTH_HIKER_ANSWERS, JANUARY_DATES);
    for (const id of selectedIds) {
      const candidate = board.candidates.find((c) => c.place.id === id);
      expect(candidate?.fit.band).not.toBe('not_workable');
      expect(candidate?.fit.blockers).toHaveLength(0);
    }
  });

  it('honours the frequency ceiling the traveller set', () => {
    // "A few times" hiking on a four-day trip means three, not nine.
    const { selectedIds, board, profile: built } = pick();
    const hikes = selectedIds.filter(
      (id) => board.candidates.find((c) => c.place.id === id)?.fit.primaryInterest === 'hiking',
    );
    expect(hikes.length).toBeLessThanOrEqual(built.derived.frequencyCaps.hiking);
  });

  it('never pre-selects an interest the traveller asked to avoid', () => {
    const { selectedIds, board } = pick({
      ...MAMMOTH_HIKER_ANSWERS,
      interests: interests({ ...MAMMOTH_HIKER_ANSWERS.interests, hot_springs: 'avoid' }),
    });
    for (const id of selectedIds) {
      const candidate = board.candidates.find((c) => c.place.id === id);
      expect(candidate?.fit.primaryInterest).not.toBe('hot_springs');
    }
  });

  it('keeps total driving inside a sane share of the travel budget', () => {
    const { stats, profile: built } = pick();
    expect(stats.totalDriveMinutesOneWay).toBeLessThanOrEqual(
      4 * built.transport.maxDailyDriveMinutes * 0.5,
    );
  });

  it('holds roughly the famous/hidden balance the traveller asked for', () => {
    const balanced = pick();
    expect(Math.abs(balanced.stats.hiddenGemShare - 0.45)).toBeLessThanOrEqual(0.3);
    // Leaning hidden must never produce a more mainstream selection.
    const deepCuts = pick({ ...MAMMOTH_HIKER_ANSWERS, discoveryMix: 'deep_cuts' });
    expect(deepCuts.stats.hiddenGemShare).toBeGreaterThanOrEqual(balanced.stats.hiddenGemShare);
  });

  it('shifts composition toward gems once frequency ceilings stop being the binding constraint', () => {
    // On a short trip the traveller's own "a few times" ceilings bind harder than
    // a stylistic preference, so the mix can only reorder the board. Give the trip
    // room and the mix has to change what is actually picked.
    const balanced = pick(MAMMOTH_HIKER_ANSWERS, AUGUST_DATES, [], 7);
    const deepCuts = pick(
      { ...MAMMOTH_HIKER_ANSWERS, discoveryMix: 'deep_cuts' },
      AUGUST_DATES,
      [],
      7,
    );
    expect(deepCuts.stats.hiddenGemShare).toBeGreaterThan(balanced.stats.hiddenGemShare);
    expect(deepCuts.selectedIds).not.toEqual(balanced.selectedIds);
  });

  it('keeps category variety rather than repeating one kind of stop', () => {
    const { stats, selectedIds } = pick();
    const counts = Object.values(stats.byCategory);
    expect(Object.keys(stats.byCategory).length).toBeGreaterThanOrEqual(4);
    expect(Math.max(...counts)).toBeLessThanOrEqual(Math.ceil(selectedIds.length / 2));
  });

  it('explains what it held back and why', () => {
    const { notes } = pick();
    expect(notes.join(' ')).toMatch(/frequency you asked for|pre-selected/);
  });

  it('respects a mobility need by only picking low-effort stops', () => {
    const { selectedIds, board } = pick(MAMMOTH_HIKER_ANSWERS, AUGUST_DATES, ['mobility_limited']);
    expect(selectedIds.length).toBeGreaterThan(0);
    for (const id of selectedIds) {
      const intensity = board.candidates.find((c) => c.place.id === id)?.place.physicalIntensity;
      expect(['none', 'easy']).toContain(intensity);
    }
  });

  it('collapses to town stops for a traveller without a car', () => {
    const { selectedIds, board } = pick({ ...MAMMOTH_HIKER_ANSWERS, willDrive: false });
    for (const id of selectedIds) {
      const candidate = board.candidates.find((c) => c.place.id === id);
      // Nothing auto-picked may need a vehicle the traveller does not have.
      expect(candidate?.access.requiredModes).not.toContain('drive');
      expect(candidate?.access.status).not.toBe('blocked');
    }
  });

  it('produces a different selection for a different traveller', () => {
    const hiker = pick().selectedIds;
    const historian = pick({
      interests: interests({
        history_and_culture: 'core',
        food_and_towns: 'frequent',
        easy_nature_walks: 'occasional',
        hiking: 'avoid',
      }),
      maxDailyTravelMinutes: 240,
      regionalExpansion: 'nearby_120',
      detourToleranceMinutes: 120,
    }).selectedIds;
    expect(hiker).not.toEqual(historian);
    expect(historian).toContain('manzanar-historic-site');
  });
});

describe('the derived bad-weather backup section', () => {
  /**
   * The defect this closes: `groupFor` assigns a primary group in a fixed order
   * — hidden gem, then popular, then scenic, then backup — so five of the seven
   * places that genuinely are bad-weather options never reach the backup branch.
   * The section is a cross-cut over the same cards rather than a re-grouping,
   * because a place's primary category is not a function of this week's weather.
   */
  function boardWith(weather: WeatherDataset, dates = AUGUST_DATES) {
    return buildDiscoveryBoard({
      ...boardContext(dates),
      profile: profile(),
      weather,
      dates,
    });
  }

  function weatherFor(dates: readonly string[], now: Date) {
    return buildFixtureWeather({
      regionId: EASTERN_SIERRA.id,
      locations: EASTERN_SIERRA_WEATHER_LOCATIONS,
      dates,
      now,
    });
  }

  /** Close enough that every date is a forecast, and wet enough to matter. */
  const NOW = new Date('2026-08-10T12:00:00.000Z');

  /**
   * A trip that lands entirely in bad weather.
   *
   * The fixture's four-step cycle is indexed by day-of-year, so any run of four
   * consecutive dates walks clear → showery → wet → stormy and every place gets
   * a good day somewhere. That is the *common* case and it correctly produces no
   * section at all: if the planner can move a stop to Tuesday, it was never in
   * trouble. To have something genuinely at risk you need a short trip whose
   * every day is wet, which is what 14–15 August is (cycle positions 2 and 3).
   */
  const WASHOUT = ['2026-08-14', '2026-08-15'];

  it('says nothing when every stop still has a good day to move to', () => {
    // The ordinary case, and the one that keeps the section from becoming
    // wallpaper: four consecutive dates give everything at least one clear day.
    const board = boardWith(weatherFor(AUGUST_DATES, NOW));
    expect(boardWeatherBackups(board.candidates)).toBeNull();
  });

  it('surfaces a rain-friendly place whose primary group is something else', () => {
    const board = boardWith(weatherFor(WASHOUT, NOW), WASHOUT);
    const backups = boardWeatherBackups(board.candidates);
    expect(backups, 'a two-day washout should put something at risk').not.toBeNull();

    const ids = backups!.suggestions.map((entry) => entry.placeId);
    expect(ids.length).toBeGreaterThan(0);

    // At least one suggestion must be a place the board files elsewhere —
    // otherwise the section is just the existing group under a new name.
    const elsewhere = backups!.suggestions.filter(
      (entry) => entry.category !== 'low_effort_backups',
    );
    expect(elsewhere.length).toBeGreaterThan(0);
  });

  it('never offers something that is itself in trouble', () => {
    const board = boardWith(weatherFor(WASHOUT, NOW), WASHOUT);
    const backups = boardWeatherBackups(board.candidates)!;
    const atRisk = new Set(backups.atRisk.map((entry) => entry.placeId));
    for (const suggestion of backups.suggestions) {
      expect(atRisk.has(suggestion.placeId)).toBe(false);
    }
  });

  it('never offers a place that is equally sensitive to the same weather', () => {
    const board = boardWith(weatherFor(WASHOUT, NOW), WASHOUT);
    const backups = boardWeatherBackups(board.candidates)!;
    for (const suggestion of backups.suggestions) {
      const place = placeById(suggestion.placeId)!;
      expect(
        place.weather.poorWeatherBackup || place.weather.exposure === 'indoor',
        `${suggestion.placeId} is not actually a backup`,
      ).toBe(true);
      expect(place.weather.visibilityDependent).toBe(false);
    }
  });

  it('never offers something unreachable, shut, or a long drive away', () => {
    const board = boardWith(weatherFor(WASHOUT, NOW), WASHOUT);
    const backups = boardWeatherBackups(board.candidates)!;
    const byId = new Map(board.candidates.map((entry) => [entry.place.id, entry]));
    for (const suggestion of backups.suggestions) {
      const candidate = byId.get(suggestion.placeId)!;
      expect(candidate.access.status).not.toBe('blocked');
      expect(candidate.operating.status).not.toBe('closed_throughout');
      expect(candidate.operating.status).not.toBe('unknown');
      expect(candidate.fit.band).not.toBe('not_workable');
      expect(candidate.driveMinutes).toBeLessThanOrEqual(75);
    }
  });

  it('never names an unusable place as at risk', () => {
    // A January trip: most of the region is behind a snow gate, and a place
    // nobody can reach is not "at risk from the weather" — it is simply not on
    // this trip, and saying otherwise would double-report the same problem.
    const board = boardWith(weatherFor(JANUARY_DATES, NOW), JANUARY_DATES);
    const backups = boardWeatherBackups(board.candidates);
    const byId = new Map(board.candidates.map((entry) => [entry.place.id, entry]));
    for (const entry of backups?.atRisk ?? []) {
      expect(byId.get(entry.placeId)!.fit.band).not.toBe('not_workable');
    }
  });

  it('keeps forecast and seasonal-pattern evidence distinct', () => {
    const near = boardWeatherBackups(
      boardWith(weatherFor(WASHOUT, NOW), WASHOUT).candidates,
    );
    expect(near?.evidence).toBe('forecast');

    /**
     * An explicitly wet season, built here rather than taken from the fixture.
     *
     * The offline generator's seasonal values sit just under the caution
     * threshold, so a far-future trip against it produces no section — which is
     * a true statement about a reliable September and a useless test. This says
     * outright that four days in five are wet at this time of year, which is the
     * shape the live archive returns for a genuine monsoon or storm season.
     */
    const far = ['2027-11-14', '2027-11-15'];
    const board = boardWith(wetSeason(far), far);
    const distant = boardWeatherBackups(board.candidates);

    expect(distant, 'a wet season should prompt preparation').not.toBeNull();
    expect(distant!.evidence).toBe('historical_pattern');
    expect(distant!.suggestions.length).toBeGreaterThan(0);
  });

  /** A historical pattern that says this period is reliably wet. */
  function wetSeason(dates: readonly string[]): WeatherDataset {
    return weatherDatasetSchema.parse({
      version: WEATHER_DATASET_VERSION,
      regionId: EASTERN_SIERRA.id,
      locations: EASTERN_SIERRA_WEATHER_LOCATIONS,
      days: EASTERN_SIERRA_WEATHER_LOCATIONS.flatMap((location) =>
        dates.map((date) => ({
          kind: 'historical_pattern' as const,
          locationId: location.id,
          date,
          bandStart: '11-09',
          bandEnd: '11-19',
          sampleYearFrom: 2017,
          sampleYearTo: 2026,
          sampleCount: 110,
          method: 'Test pattern.',
          temperatureMaxC: { p10: 2, p50: 6, p90: 10 },
          temperatureMinC: { p10: -6, p50: -2, p90: 2 },
          wetDayFrequency: 0.8,
          snowDayFrequency: 0.45,
          windGustKphP90: 70,
          computedAt: '2026-08-10T12:00:00.000Z',
          attribution: {
            provider: 'Test',
            notice: 'Test pattern.',
            url: 'https://example.invalid/t',
          },
        })),
      ),
      solar: [],
      generatedAt: '2026-08-10T12:00:00.000Z',
      providerName: 'Test',
    });
  }

  it('is deterministic and free of duplicates', () => {
    const board = boardWith(weatherFor(WASHOUT, NOW), WASHOUT);
    const first = boardWeatherBackups(board.candidates)!;
    const second = boardWeatherBackups(board.candidates)!;
    expect(second).toEqual(first);
    expect(new Set(first.suggestions.map((entry) => entry.placeId)).size).toBe(
      first.suggestions.length,
    );
  });
});
