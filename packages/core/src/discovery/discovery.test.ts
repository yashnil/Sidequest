import { describe, expect, it } from 'vitest';
import { autoSelect } from './autoselect';
import { buildDiscoveryBoard, type DiscoveryBoard } from './board';
import { placeById } from '../data/index';
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
      expect(candidate.place.worksInBadWeather).toBe(true);
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
