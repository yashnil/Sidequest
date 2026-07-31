import { describe, expect, it } from 'vitest';
import { buildDiscoveryBoard, type DiscoveryCandidate } from '../discovery/board';
import type { QuestionnaireAnswers } from '../schemas/profile';
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

function board(
  overrides: Partial<QuestionnaireAnswers> = MAMMOTH_HIKER_ANSWERS,
  dates = AUGUST_DATES,
  travelerNeeds: TravelerNeed[] = [],
) {
  const ctx = context({ travelerNeeds });
  return buildDiscoveryBoard({
    ...boardContext(dates),
    profile: profile(overrides, ctx),
    travelerNeeds,
  });
}

function find(candidates: DiscoveryCandidate[], id: string): DiscoveryCandidate {
  const candidate = candidates.find((item) => item.place.id === id);
  if (!candidate) throw new Error(`No candidate for ${id}`);
  return candidate;
}

function rank(candidates: DiscoveryCandidate[], id: string): number {
  return candidates.findIndex((candidate) => candidate.place.id === id);
}

describe('personal fit, not popularity', () => {
  it('ranks a quiet find above a famous busy one for a traveller who avoids crowds', () => {
    const { candidates } = board({
      ...MAMMOTH_HIKER_ANSWERS,
      discoveryMix: 'deep_cuts',
      crowdTolerance: 'avoid_crowds',
    });
    // Obsidian Dome is barely known; the Lakes Basin is the postcard shot.
    expect(find(candidates, 'obsidian-dome').fit.score).toBeGreaterThan(
      find(candidates, 'mammoth-lakes-basin').fit.score,
    );
  });

  it('flips that ordering for a traveller who wants the famous ones', () => {
    const { candidates } = board({
      ...MAMMOTH_HIKER_ANSWERS,
      discoveryMix: 'mostly_classics',
      crowdTolerance: 'dont_mind',
    });
    expect(find(candidates, 'mammoth-lakes-basin').fit.score).toBeGreaterThan(
      find(candidates, 'obsidian-dome').fit.score,
    );
  });

  it('reorders the whole board when the traveller changes, not just the labels', () => {
    const hiker = board(MAMMOTH_HIKER_ANSWERS).candidates.map((c) => c.place.id);
    const historian = board({
      interests: interests({
        history_and_culture: 'core',
        food_and_towns: 'frequent',
        easy_nature_walks: 'occasional',
        hiking: 'avoid',
      }),
      pace: 'slow',
      maxDailyTravelMinutes: 240,
      regionalExpansion: 'nearby_120',
      detourToleranceMinutes: 120,
    }).candidates.map((c) => c.place.id);

    expect(hiker).not.toEqual(historian);
    expect(rank(board(MAMMOTH_HIKER_ANSWERS).candidates, 'bodie-state-historic-park')).toBeGreaterThan(
      rank(
        board({
          interests: interests({ history_and_culture: 'core', food_and_towns: 'frequent' }),
          maxDailyTravelMinutes: 240,
          regionalExpansion: 'nearby_120',
          detourToleranceMinutes: 120,
        }).candidates,
        'bodie-state-historic-park',
      ),
    );
  });

  it('keeps "top pick" rare enough to mean something', () => {
    const { candidates } = board();
    const topPicks = candidates.filter((candidate) => candidate.fit.band === 'top_pick');
    expect(topPicks.length).toBeGreaterThan(0);
    expect(topPicks.length).toBeLessThan(candidates.length / 2);
  });

  it('is deterministic across runs', () => {
    const first = board().candidates.map((c) => `${c.place.id}:${c.fit.score}`);
    const second = board().candidates.map((c) => `${c.place.id}:${c.fit.score}`);
    expect(first).toEqual(second);
  });
});

describe('feasibility gates', () => {
  it('blocks car-only places for a traveller without a car, and keeps the ones a service reaches', () => {
    const { candidates } = board({ ...MAMMOTH_HIKER_ANSWERS, willDrive: false });
    expect(find(candidates, 'convict-lake').fit.blockers.map((b) => b.code)).toContain('needs_car');
    expect(find(candidates, 'convict-lake').fit.band).toBe('not_workable');

    // The free trolley reaches the Lakes Basin in summer, and the Mammoth
    // Express reaches Bishop seven days a week all year.
    expect(find(candidates, 'mammoth-lakes-basin').fit.band).not.toBe('not_workable');
    expect(find(candidates, 'bishop-town').fit.band).not.toBe('not_workable');

    // Devils Postpile is *not* one of them, and this is the case the old
    // `transitPossible` boolean got wrong. There is a mandatory shuttle, but it
    // boards at Mammoth Mountain Main Lodge, which nothing scheduled reaches —
    // so a car-free traveller cannot get to the thing that would carry them in.
    expect(find(candidates, 'devils-postpile').fit.band).toBe('not_workable');
    expect(find(candidates, 'devils-postpile').fit.blockers.map((b) => b.code)).toContain(
      'needs_car',
    );
  });

  it('opens the shuttle-served places back up once there is a car to reach the boarding point', () => {
    const { candidates } = board();
    const postpile = find(candidates, 'devils-postpile');
    expect(postpile.fit.band).not.toBe('not_workable');
    expect(postpile.access.requiredModes).toEqual(expect.arrayContaining(['drive', 'shuttle']));
    expect(postpile.access.badges).toContain('shuttle_required');
  });

  it('refuses a shuttle-only place when the traveller ruled shuttles out', () => {
    const { candidates } = board({ ...MAMMOTH_HIKER_ANSWERS, willUseShuttles: false });
    const postpile = find(candidates, 'devils-postpile');
    expect(postpile.fit.band).toBe('not_workable');
    expect(postpile.fit.blockers[0]?.message).toMatch(/shuttle/i);
    // A place you simply drive to is untouched by that answer.
    expect(find(candidates, 'convict-lake').fit.band).not.toBe('not_workable');
  });

  it('blocks anything closed on the traveller’s dates and says so', () => {
    const { candidates } = board(MAMMOTH_HIKER_ANSWERS, JANUARY_DATES);
    const postpile = find(candidates, 'devils-postpile');
    expect(postpile.fit.band).toBe('not_workable');
    expect(postpile.fit.blockers[0]?.code).toBe('closed_on_your_dates');
    expect(postpile.fit.blockers[0]?.message).toContain('June');
    // A year-round lake is unaffected.
    expect(find(candidates, 'convict-lake').fit.band).not.toBe('not_workable');
  });

  it('blocks terrain beyond a group with limited mobility', () => {
    const { candidates } = board(MAMMOTH_HIKER_ANSWERS, AUGUST_DATES, ['mobility_limited']);
    expect(find(candidates, 'sherwin-lakes-trail').fit.blockers.map((b) => b.code)).toContain(
      'mobility',
    );
    expect(find(candidates, 'convict-lake').fit.band).not.toBe('not_workable');
  });

  it('respects an explicit avoidance of strenuous activity without banning easy walks', () => {
    const { candidates } = board({
      ...MAMMOTH_HIKER_ANSWERS,
      avoidances: ['strenuous_activity'],
    });
    expect(find(candidates, 'sherwin-lakes-trail').fit.blockers.map((b) => b.code)).toContain(
      'too_strenuous',
    );
    expect(find(candidates, 'mcgee-creek-canyon').fit.band).not.toBe('not_workable');
  });

  it('respects an avoidance of rough roads', () => {
    const { candidates } = board({
      ...MAMMOTH_HIKER_ANSWERS,
      avoidances: ['rough_or_gravel_roads'],
    });
    expect(find(candidates, 'wild-willys-hot-spring').fit.blockers.map((b) => b.code)).toContain(
      'rough_road',
    );
  });

  it('blocks a place it cannot fit inside the daily driving budget', () => {
    const { candidates } = board();
    const manzanar = find(candidates, 'manzanar-historic-site');
    expect(manzanar.fit.blockers.map((b) => b.code)).toContain('exceeds_daily_travel');
    expect(manzanar.fit.blockers[0]?.message).toContain('150');
  });

  it('removes a category the traveller asked to skip entirely', () => {
    const { candidates } = board({
      ...MAMMOTH_HIKER_ANSWERS,
      interests: interests({ ...MAMMOTH_HIKER_ANSWERS.interests, hot_springs: 'avoid' }),
    });
    const willy = find(candidates, 'wild-willys-hot-spring');
    // Its viewpoint and stargazing appeal keep it alive: the avoidance only bites
    // when the place is nothing but the avoided thing.
    expect(willy.fit.band).not.toBe('not_workable');
    expect(willy.fit.blockers.map((b) => b.code)).not.toContain('avoided_interest');

    const avoidsEverythingItOffers = board({
      ...MAMMOTH_HIKER_ANSWERS,
      interests: interests({
        ...MAMMOTH_HIKER_ANSWERS.interests,
        hot_springs: 'avoid',
        scenic_viewpoints: 'avoid',
        stargazing: 'avoid',
      }),
    });
    const nowBlocked = find(avoidsEverythingItOffers.candidates, 'wild-willys-hot-spring');
    expect(nowBlocked.fit.blockers.map((b) => b.code)).toContain('avoided_interest');
    expect(nowBlocked.fit.band).toBe('not_workable');
  });

  it('sorts everything unworkable below everything workable', () => {
    const { candidates } = board(MAMMOTH_HIKER_ANSWERS, JANUARY_DATES);
    const firstBlocked = candidates.findIndex((c) => c.fit.band === 'not_workable');
    const lastWorkable = candidates.map((c) => c.fit.band).lastIndexOf('good');
    if (firstBlocked >= 0 && lastWorkable >= 0) {
      expect(firstBlocked).toBeGreaterThan(lastWorkable);
    }
  });
});

describe('explanations', () => {
  it('explains a fit using the traveller’s own answers', () => {
    const { candidates } = board();
    const reasons = find(candidates, 'convict-lake').fit.reasons;
    expect(reasons.length).toBeGreaterThan(0);
    expect(reasons.join(' ')).toMatch(/scenic viewpoints|lakes/i);
    // Distance reasoning quotes the limit the traveller actually set.
    expect(reasons.join(' ')).toContain('60 min');
  });

  it('changes the explanation when the profile changes', () => {
    const crowdAverse = find(
      board({ ...MAMMOTH_HIKER_ANSWERS, crowdTolerance: 'avoid_crowds' }).candidates,
      'obsidian-dome',
    ).fit.reasons.join(' ');
    const crowdTolerant = find(
      board({ ...MAMMOTH_HIKER_ANSWERS, crowdTolerance: 'dont_mind' }).candidates,
      'obsidian-dome',
    ).fit.reasons.join(' ');
    expect(crowdAverse).not.toBe(crowdTolerant);
    expect(crowdAverse).toContain('quiet');
  });

  it('offers no reasons for something it just told you not to do', () => {
    const { candidates } = board(MAMMOTH_HIKER_ANSWERS, JANUARY_DATES);
    const postpile = find(candidates, 'devils-postpile');
    expect(postpile.fit.reasons).toHaveLength(0);
    expect(postpile.fit.blockers.length).toBeGreaterThan(0);
  });

  it('surfaces the practical warnings that decide whether a stop works', () => {
    const { candidates } = board();
    expect(find(candidates, 'hot-creek-geologic-site').fit.cautions.join(' ')).toMatch(
      /unpaved|prohibited/i,
    );
    expect(find(candidates, 'devils-postpile').fit.cautions.join(' ')).toMatch(/shuttle/i);
    expect(find(candidates, 'little-lakes-valley').fit.cautions.join(' ')).toMatch(/[Pp]arking/);
  });

  it('keeps every factor explainable and weighted to one', () => {
    const { candidates } = board();
    for (const candidate of candidates) {
      const totalWeight = candidate.fit.factors.reduce((sum, factor) => sum + factor.weight, 0);
      expect(totalWeight).toBeCloseTo(1, 5);
      for (const factor of candidate.fit.factors) {
        expect(factor.score).toBeGreaterThanOrEqual(0);
        expect(factor.score).toBeLessThanOrEqual(1);
        expect(factor.contribution).toBeCloseTo(factor.weight * factor.score, 10);
      }
      expect(Object.keys(candidate.fit.features)).toHaveLength(candidate.fit.factors.length);
    }
  });
});
