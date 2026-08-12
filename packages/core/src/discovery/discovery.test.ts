import { describe, expect, it } from 'vitest';
import { autoSelect } from './autoselect';
import { buildDiscoveryBoard, type DiscoveryBoard } from './board';
import {
  EASTERN_SIERRA,
  EASTERN_SIERRA_WEATHER_LOCATIONS,
  buildFixtureWeather,
  placeById,
} from '../data/index';
import {
  MAX_BOARD_BACKUP_TRAVEL_MINUTES,
  boardWeatherBackups,
} from '../weather/board-backups';
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
import {
  TRANSIT_CITY_IDENTITY,
  transitCityBoardInput,
  transitCityTraveler,
} from '../testing/transit-city';
import { MODELLED_WALK_KMH } from '../travel/reach';
import type { TravelTimeMatrix } from '@sidequest/geo';

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
    expect(groupIds).toContain('nearby_side_quests');
    expect(groupIds).toContain('weak_fit');
  });

  /**
   * THE TWO GROUPS WHOSE HEADINGS TALK ABOUT DISTANCE ARE DECIDED BY DISTANCE.
   *
   * They were not, and this fixture is where the defect is easiest to see. Under
   * the old rule `scenic_detours` was assigned on category alone, so this very
   * board filed Minaret Vista — fifteen minutes from the bed, comfortably inside
   * this traveller's own radius — under a heading reading "Worth the detour ·
   * Further out, and the going is part of it", while `nearby_side_quests`, whose
   * heading in both vocabularies says "short hops from your base", was the
   * catch-all for whatever matched nothing else and duly collected long drives.
   *
   * A heading that asserts a fact its contents contradict is worse than no
   * heading, because a traveller plans around it. So: nothing inside the
   * traveller's radius may be filed as further out, and nothing beyond it may be
   * filed as a short hop.
   */
  it('never files a short hop as a detour, or a long haul as a short hop', () => {
    const { board } = setup();
    const near = new Set(['base', 'in_tolerance', 'unknown']);
    for (const candidate of board.candidates) {
      if (candidate.group === 'scenic_detours') {
        expect(
          near.has(candidate.detourClass),
          `${candidate.place.name} is ${candidate.travelMinutesFromBase} min out and filed under "further out"`,
        ).toBe(false);
      }
      if (candidate.group === 'nearby_side_quests') {
        expect(
          candidate.detourClass,
          `${candidate.place.name} is ${candidate.travelMinutesFromBase} min out and filed as a short hop`,
        ).not.toBe('too_far');
        expect(candidate.detourClass).not.toBe('stretch');
      }
    }
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

  /**
   * THE BOARD AND THE PLAN HAVE TO BE COUNTING THE SAME THING.
   *
   * `frequencyCaps` is one number read by three modules: auto-pick refuses
   * against it, the planner refuses against it, and the validator afterwards
   * warns when a finished plan exceeded it. The last two count *stops* — an
   * integer, one per place. Auto-pick used to spend fractions: a full unit of a
   * place's primary interest and a half of everything else it happened to
   * satisfy. So four lakeside walks could fill a two-stop lake allowance without
   * a single lake-led stop being picked, and auto-pick would then decline a
   * genuine lake against a ceiling that, counted the way every other reader
   * counts it, was empty. The traveller sees the refusal in the notes and can
   * find nothing on their board that explains it.
   *
   * Stated as the property rather than as a count of picks: every refusal on
   * frequency must be a refusal against an allowance this selection has really
   * filled, in whole stops.
   */
  it('refuses on frequency only against a ceiling its own picks have filled', () => {
    const { board, selectedIds, excluded, profile: built } = pick();
    const chargedTo = (id: string) => {
      const candidate = board.candidates.find((entry) => entry.place.id === id);
      return candidate?.fit.primaryInterest ?? candidate?.place.interests[0];
    };

    const spent = new Map<string, number>();
    for (const id of selectedIds) {
      const interest = chargedTo(id);
      if (interest) spent.set(interest, (spent.get(interest) ?? 0) + 1);
    }

    const refusals = excluded.filter((entry) => entry.reason === 'frequency');
    expect(refusals.length).toBeGreaterThan(0);
    for (const refusal of refusals) {
      const interest = chargedTo(refusal.placeId);
      const cap = built.derived.frequencyCaps[interest as keyof typeof built.derived.frequencyCaps];
      expect(
        spent.get(interest as string) ?? 0,
        `${refusal.placeId} was refused on frequency, but only ${spent.get(interest as string) ?? 0} of the ${cap} ${interest} stops are on the board`,
      ).toBeGreaterThanOrEqual(cap ?? 0);
    }
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
      expect(candidate.travelMinutesFromBase).not.toBeNull();
      expect(candidate.travelMinutesFromBase!).toBeLessThanOrEqual(
        MAX_BOARD_BACKUP_TRAVEL_MINUTES,
      );
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

// ---------------------------------------------------------------------------
// The board and the planner on one car-free trip handed a road matrix
// ---------------------------------------------------------------------------

/**
 * WHAT THIS PROVES, AND WHY IT IS A BOARD TEST RATHER THAN A PLANNER ONE.
 *
 * The compiler is supposed to measure the network a trip is made on. A live
 * Tokyo compilation stored a car-free scope against a `car` matrix, and the
 * planner grew a narrow repair for it: when nothing measured can carry a leg and
 * the road holds a short *distance*, the leg becomes a derived walk.
 *
 * That repair reached the planner and not the Discovery Board, which resolves
 * reach through `resolveCandidateReach`. So the board refused — as a transport
 * conflict — the very stops the planner would have walked to, scored them out,
 * and left auto-pick with nothing to pre-select but the base. A traveller never
 * got as far as the repair.
 *
 * Everything below runs the real board over a road matrix on which every
 * candidate is a short walk from the bed. It asserts the four properties that
 * failed together, and the negative that keeps the fix honest: a road distance
 * nobody would walk is still a refusal, and the road *duration* never appears.
 */
describe('a car-free board handed a road matrix', () => {
  const BASE = TRANSIT_CITY_IDENTITY.baseId;
  const NEAR: readonly string[] = [
    TRANSIT_CITY_IDENTITY.candidateA,
    TRANSIT_CITY_IDENTITY.candidateB,
    TRANSIT_CITY_IDENTITY.candidateC,
  ];
  /** 1.2 road-km: about sixteen minutes at the modelled pace, inside any answer. */
  const NEAR_KM = 1.2;
  /** The road minutes, which must never reach a traveller in any mode. */
  const ROAD_MINUTES = 4;

  /**
   * A road network on which the whole board is walkable — the shape the broken
   * compilation actually produced, rather than the one candidate the shared
   * fixture's road matrix carries.
   */
  function roadMatrix(): TravelTimeMatrix {
    const ids = [BASE, ...NEAR, TRANSIT_CITY_IDENTITY.candidateD];
    const near = new Set(NEAR);
    const value = (from: string, to: string, forNear: number, forFar: number): number => {
      if (from === to) return 0;
      const other = from === BASE ? to : from;
      return near.has(other) ? forNear : forFar;
    };
    return {
      mode: 'car',
      ids,
      minutes: ids.map((from) => ids.map((to) => value(from, to, ROAD_MINUTES, 22))),
      km: ids.map((from) => ids.map((to) => value(from, to, NEAR_KM, 22))),
      provenance: {
        kind: 'measured',
        note: 'Fixture road network, measured by construction.',
        source: 'packages/core/src/discovery/discovery.test.ts',
      },
    };
  }

  function carFreeBoard(): DiscoveryBoard {
    const traveller = transitCityTraveler();
    const input = transitCityBoardInput(traveller);
    return buildDiscoveryBoard({
      ...input,
      /* No timetable either: the point is a road matrix and nothing else. */
      travel: { ...input.travel, matrix: roadMatrix(), transit: null },
    });
  }

  function cardFor(board: DiscoveryBoard, id: string) {
    const found = board.candidates.find((entry) => entry.place.id === id);
    if (!found) throw new Error(`No card for ${id}`);
    return found;
  }

  it('reaches the near stops on foot rather than calling them a transport conflict', () => {
    const board = carFreeBoard();
    const expected = Math.ceil((NEAR_KM * 60) / MODELLED_WALK_KMH);
    for (const id of NEAR) {
      const card = cardFor(board, id);
      expect(card.reach.status, id).toBe('measured');
      expect(card.travelModeFromBase, id).toBe('walk');
      expect(card.travelMinutesFromBase, id).toBe(expected);
      /*
       * The provenance is the whole licence for showing the number: a derived
       * walk that presented itself as a measurement would be the substitution
       * this layer exists to stop.
       */
      expect(card.reach.status === 'measured' && card.reach.provenance, id).toBe('modelled');
      expect(card.reach.status === 'measured' && card.reach.rule, id).toBe('modelled_walk');
      /* And never the road's own duration, in any field. */
      expect(card.travelMinutesFromBase, id).not.toBe(ROAD_MINUTES);
    }
  });

  it('leaves auto-pick something to pre-select', () => {
    const board = carFreeBoard();
    const chosen = autoSelect({
      candidates: board.candidates,
      profile: transitCityTraveler(),
      tripDays: 3,
    });
    const nearChosen = NEAR.filter((id) => chosen.selectedIds.includes(id));
    expect(nearChosen.length).toBeGreaterThan(0);
    for (const id of NEAR) {
      expect(
        chosen.excluded.find((entry) => entry.placeId === id)?.reason,
        `${id} was excluded for an unverified journey`,
      ).not.toBe('reach_unverified');
    }
  });

  it('still refuses a road distance nobody would walk', () => {
    const board = carFreeBoard();
    const far = cardFor(board, TRANSIT_CITY_IDENTITY.candidateD);
    expect(far.reach.status).not.toBe('measured');
    expect(far.travelMinutesFromBase).toBeNull();
  });
});
