import { describe, expect, it } from 'vitest';
import { buildDiscoveryBoard, type DiscoveryCandidate } from '../discovery/board';
import {
  MAX_TOP_BAND_SHARE,
  calibrateBandDistribution,
  type FitAssessment,
  type FitBand,
} from './fit';
import {
  CROWD_TOLERANCES,
  DISCOVERY_MIXES,
  INTERESTS,
  type CrowdTolerance,
  type DiscoveryMix,
  type Interest,
  type InterestLevel,
} from '../schemas/common';
import {
  assessPlaceStanding,
  standingFields,
  WIDELY_NOTED_PROMINENCE,
} from '../quality/significance';
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

  /**
   * A THRESHOLD ABOVE THE CEILING IS A BRANCH THAT NEVER RUNS.
   *
   * The tourist-trap penalty read `popularityScore >= 0.8`, and the highest
   * prominence the standing model could produce was 0.81 — reachable only by a
   * record holding an open identifier, a second catalogue *and* four translated
   * names. Taking the alternate-name count out of prominence, which §8.3
   * requires, would have dropped the ceiling under the bar and killed this
   * branch in silence. So the bar is now the model's own constant, and this
   * runs the branch on a place scored at the top of what the model can say.
   */
  it('docks the crowd score of the most-noted place for somebody avoiding tourist traps', () => {
    const noted = standingFields(
      assessPlaceStanding({
        inKnowledgeBase: true,
        encyclopaedicArticle: true,
        crossDatasetCorroboration: true,
        /*
         * And the magnitude behind the notice, which the bar now requires: the
         * three presence statements alone stop at `MINTED_NOTICE_PROMINENCE`,
         * because a catalogue mints them for every municipal park it maps. A
         * fixture without this would be asserting the tourist-trap branch off a
         * record the model no longer calls widely noted — the dead branch this
         * test was written to prevent, one rung along.
         */
        classifyingValues: ['leisure=nature_reserve'],
        mappedExtentMetres: 2_600,
        groundWitnessCount: 5,
      }),
    );
    expect(noted.popularityScore).toBeGreaterThanOrEqual(WIDELY_NOTED_PROMINENCE);
    expect(noted.hiddenGemScore).toBeLessThanOrEqual(0.2);

    /*
     * One crowd-averse traveller, one place, two prominences — everything else
     * held equal, `crowdLevel` included, so the only thing that can move the
     * score is whether the bar was cleared.
     */
    const ctx = boardContext();
    const crowdScoreAtProminence = (popularityScore: number) => {
      const built = buildDiscoveryBoard({
        ...ctx,
        places: ctx.places.map((place) =>
          place.id === 'mammoth-lakes-basin'
            ? { ...place, popularityScore, hiddenGemScore: 0.1, crowdLevel: 'busy' as const }
            : place,
        ),
        profile: profile(MAMMOTH_HIKER_ANSWERS, context({ travelerNeeds: [] })),
      });
      return find(built.candidates, 'mammoth-lakes-basin').fit.features.crowdComfort;
    };
    expect(crowdScoreAtProminence(noted.popularityScore)).toBeLessThan(
      crowdScoreAtProminence(WIDELY_NOTED_PROMINENCE - 0.2),
    );
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

/**
 * A GRADED REFUSAL RANKS. A CONFIRMED ONE REMOVES. NOTHING ELSE DOES EITHER.
 *
 * The defect these hold shut: `applyInterpretation`'s avoidance branch ignored
 * the chip's strength entirely, so "not massively into long walks" was recorded
 * byte-identically to "no hiking" — a hard blocker, plus a ceiling on physical
 * intensity, from a sentence that asked for neither. The clamp that exists to
 * stop a model doing this was inert for every avoidance key, because the branch
 * it was protecting never read the value it clamped.
 *
 * The correction separates polarity from magnitude, so these assert the two ends
 * and the fact that they are the *same* number read two ways: `avoidances` holds
 * only what cleared `canApplyAsExclusion`, and everything softer arrives on
 * `preferenceSignals` and moves a place down the board without moving it off.
 */
describe('a preference that was not a refusal', () => {
  const strenuousId = 'sherwin-lakes-trail';

  function boardWithSignal(magnitude: number) {
    return board({
      ...MAMMOTH_HIKER_ANSWERS,
      preferenceSignals: [
        {
          target: { kind: 'avoidance', value: 'strenuous_activity' },
          key: 'avoidance:strenuous_activity',
          polarity: 'refuses',
          magnitude,
          exclusionary: false,
          source: 'deterministic',
          quote: 'not massively into long walks',
        },
      ],
    });
  }

  it('lowers the score of what it is about', () => {
    const before = find(board().candidates, strenuousId);
    const after = find(boardWithSignal(0.6).candidates, strenuousId);
    expect(after.fit.score).toBeLessThan(before.fit.score);
  });

  it('does not remove it, and adds no blocker naming a refusal nobody made', () => {
    const after = find(boardWithSignal(1).candidates, strenuousId);
    expect(after.fit.band).not.toBe('not_workable');
    expect(after.fit.blockers.map((blocker) => blocker.code)).not.toContain('too_strenuous');
  });

  it('scales: a stronger dislike costs more than a weaker one', () => {
    const mild = find(boardWithSignal(0.25).candidates, strenuousId).fit.score;
    const firm = find(boardWithSignal(0.9).candidates, strenuousId).fit.score;
    expect(firm).toBeLessThan(mild);
  });

  /**
   * The other end. A confirmed, deterministic, explicit refusal reaches
   * `avoidances` and removes — which is the behaviour worth keeping, and the one
   * the soft case was being mistaken for.
   */
  it('still removes when the traveller actually refused', () => {
    const after = find(
      board({ ...MAMMOTH_HIKER_ANSWERS, avoidances: ['strenuous_activity'] }).candidates,
      strenuousId,
    );
    expect(after.fit.blockers.map((blocker) => blocker.code)).toContain('too_strenuous');
  });

  /** And a profile that interpreted nothing scores exactly as it always did. */
  it('changes no score at all when nothing was interpreted', () => {
    const plain = board().candidates.map((candidate) => candidate.fit.score);
    const empty = board({ ...MAMMOTH_HIKER_ANSWERS, preferenceSignals: [] }).candidates.map(
      (candidate) => candidate.fit.score,
    );
    expect(empty).toEqual(plain);
  });

  /**
   * The consistency requirement, asserted rather than asserted-about: candidate
   * quality reads the magnitude through `fitScore` and through nothing else, so
   * the ranker and the quality gate cannot disagree about how strong a preference
   * was.
   */
  it('reaches candidate quality through the same number, not a second one', () => {
    const before = find(board().candidates, strenuousId);
    const after = find(boardWithSignal(0.9).candidates, strenuousId);

    /*
     * Every quality signal is identical, and that is the assertion.
     *
     * The obvious design was a second `refusalMagnitude` parameter on
     * `QualityInput`, subtracted again here. It would have charged one sentence
     * twice — once through fit and once through quality — and given the two
     * consumers separate opportunities to disagree about how strong a preference
     * was. There is one derivation, in `scorePlace`, and quality reads its
     * result. So the signals cannot move, and the score can only move by way of
     * `fitScore`.
     */
    expect(after.quality.signals).toEqual(before.quality.signals);
    expect(after.quality.score).toBeLessThanOrEqual(before.quality.score);
    expect(after.fit.score).toBeLessThan(before.fit.score);
  });
});

/**
 * LABEL CALIBRATION — §9.1's "Top pick must mean something", as arithmetic.
 *
 * The audited board: 24 of 24 cards read "Strong fit" with "0 of 6 checked"
 * underneath every one. Two mechanisms close it, tested separately: the
 * evidence cap (a compiled place with zero established significance cannot
 * exceed "Good fit"), and the distribution guard (no single top label may
 * cover more than 60% of a board's workable cards).
 */
describe('recommendation labels are calibrated', () => {
  const assessment = (placeId: string, score: number, band: FitBand): FitAssessment => ({
    placeId,
    score,
    band,
    factors: [],
    features: {
      interestMatch: 0,
      detourFit: 0,
      intensityFit: 0,
      hiddenGemAlignment: 0,
      crowdComfort: 0,
      seasonFit: 0,
      budgetFit: 0,
      logisticsEase: 0,
      transportFit: 0,
    },
    blockers: [],
    reasons: [],
    cautions: [],
    matchedInterests: [],
  });

  it('demotes the overflow of an over-subscribed top band, lowest scores first', () => {
    const uniform = Array.from({ length: 10 }, (_, index) =>
      assessment(`p${index}`, 80 + index, 'strong'),
    );
    const calibrated = calibrateBandDistribution(uniform);
    const strong = calibrated.filter((entry) => entry.band === 'strong');
    const demoted = calibrated.filter((entry) => entry.band === 'good');
    expect(strong.length).toBe(6);
    expect(demoted.length).toBe(4);
    /* The demotions land on the lowest scores, so the label still ranks. */
    expect(demoted.map((entry) => entry.placeId).sort()).toEqual(['p0', 'p1', 'p2', 'p3']);
  });

  it('leaves a healthy distribution alone', () => {
    const mixed = [
      assessment('a', 90, 'top_pick'),
      assessment('b', 80, 'strong'),
      assessment('c', 70, 'good'),
      assessment('d', 60, 'optional'),
      assessment('e', 50, 'weak'),
    ];
    expect(calibrateBandDistribution(mixed)).toEqual(mixed);
  });

  it('never demotes below optional — fixing an overclaim must not manufacture skips', () => {
    const allOptional = Array.from({ length: 10 }, (_, index) =>
      assessment(`p${index}`, 55, 'optional'),
    );
    const calibrated = calibrateBandDistribution(allOptional);
    expect(calibrated.every((entry) => entry.band === 'optional')).toBe(true);
  });

  it('is deterministic under equal scores', () => {
    const tied = Array.from({ length: 8 }, (_, index) => assessment(`p${index}`, 80, 'strong'));
    expect(calibrateBandDistribution(tied)).toEqual(calibrateBandDistribution(tied));
  });

  it('ignores unworkable candidates when computing the share', () => {
    const entries = [
      ...Array.from({ length: 4 }, (_, index) => assessment(`w${index}`, 80, 'strong')),
      ...Array.from({ length: 20 }, (_, index) => assessment(`n${index}`, 0, 'not_workable')),
    ];
    const calibrated = calibrateBandDistribution(entries);
    /* 4 of 4 workable in one band is over-share; demotion still applies. */
    expect(calibrated.filter((entry) => entry.band === 'strong').length).toBeLessThan(4);
  });
});

/**
 * THE SAME GUARANTEE, MEASURED WHERE THE TRAVELLER MEETS IT.
 *
 * The block above exercises `calibrateBandDistribution` on hand-built
 * assessments, and that is precisely why §30's mutation class 7 — "label every
 * candidate Top pick" — survived: the function was tested, its *use* was not.
 * Deleting the call inside `buildDiscoveryBoard` left every one of those unit
 * tests green while the board reverted to the audited failure, every workable
 * card carrying the same top label.
 *
 * So the property is asserted on real boards instead of on the helper, and as a
 * *share* rather than a count, so a fixture gaining or losing a place does not
 * rewrite the test.
 */
describe('no board is almost entirely one label', () => {
  /** The most-used label among the cards a traveller could actually do. */
  function dominantLabel(candidates: readonly DiscoveryCandidate[]) {
    const workable = candidates.filter((candidate) => candidate.fit.band !== 'not_workable');
    const counts = new Map<FitBand, number>();
    for (const candidate of workable) {
      counts.set(candidate.fit.band, (counts.get(candidate.fit.band) ?? 0) + 1);
    }
    const ranked = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const [band, count] = ranked[0] ?? ['good' as FitBand, 0];
    return { band, count, workable: workable.length, share: count / workable.length };
  }

  /**
   * A traveller who marked every single interest a core interest.
   *
   * In the Eastern Sierra that scores *every* workable candidate over the
   * top-pick threshold — the exact population §9.1 was written about. The only
   * thing standing between this profile and a board that says "Top pick for
   * you" twenty-three times is the distribution guard, which makes it the
   * board worth measuring.
   */
  const LOVES_EVERYTHING: Partial<QuestionnaireAnswers> = {
    ...MAMMOTH_HIKER_ANSWERS,
    interests: Object.fromEntries(
      INTERESTS.map((interest) => [interest, 'core' as InterestLevel]),
    ) as Record<Interest, InterestLevel>,
    crowdTolerance: 'dont_mind',
    avoidTouristTraps: false,
    maxDailyTravelMinutes: 300,
    detourToleranceMinutes: 180,
    regionalExpansion: 'best_regional',
  };

  it('holds the top label under its share, including where every card scores into it', () => {
    const variants: Partial<QuestionnaireAnswers>[] = [
      MAMMOTH_HIKER_ANSWERS,
      { ...MAMMOTH_HIKER_ANSWERS, discoveryMix: 'deep_cuts' },
      LOVES_EVERYTHING,
    ];
    for (const variant of variants) {
      const dominant = dominantLabel(board(variant).candidates);
      /* Below three workable cards a share says nothing, and the guard says so too. */
      expect(dominant.workable).toBeGreaterThan(3);
      expect({ band: dominant.band, over: dominant.share > MAX_TOP_BAND_SHARE }).toEqual({
        band: dominant.band,
        over: false,
      });
    }
  });

  /**
   * THREE HAND-PICKED PROFILES WERE NOT ENOUGH, AND THAT IS THE WHOLE POINT.
   *
   * The three variants above all happen to concentrate in `top_pick`, which is
   * the band the calibrator inspected first — so they passed while the
   * calibrator's loop was terminating on the first band that was *within*
   * budget and never reaching the one that was not. On `balanced` × `mild` ×
   * every-interest-`occasional` the real Eastern Sierra board came back
   * `top_pick 2 / strong 20 / good 1` over 23 workable cards: 87% of it under
   * one label, twenty cards holding a label the product's own constant allows
   * thirteen. A sweep is the only shape of test that could have caught that,
   * because the defect was in *which* band the guard looked at, and any fixed
   * set of profiles is a bet on which band a board concentrates in.
   *
   * So the property is swept over the questionnaire axes that move the score
   * distribution — the classic/hidden mix, crowd tolerance, and a uniform
   * interest level — across two seasons, and asserted for **every** band rather
   * than the dominant one. Assertions carry the failing combination, because a
   * sweep that fails anonymously costs an hour to diagnose.
   */
  it('holds every band under its share across the profile axes that move scores', () => {
    const mixes: DiscoveryMix[] = [...DISCOVERY_MIXES];
    const crowds: CrowdTolerance[] = [...CROWD_TOLERANCES];
    const levels: InterestLevel[] = ['core', 'frequent', 'occasional'];
    let boardsChecked = 0;

    for (const dates of [AUGUST_DATES, JANUARY_DATES]) {
      for (const discoveryMix of mixes) {
        for (const crowdTolerance of crowds) {
          for (const level of levels) {
            const candidates = board(
              {
                ...MAMMOTH_HIKER_ANSWERS,
                discoveryMix,
                crowdTolerance,
                interests: Object.fromEntries(
                  INTERESTS.map((interest) => [interest, level]),
                ) as Record<Interest, InterestLevel>,
                maxDailyTravelMinutes: 300,
                detourToleranceMinutes: 180,
                regionalExpansion: 'best_regional',
              },
              dates,
            ).candidates;

            const workable = candidates.filter((c) => c.fit.band !== 'not_workable');
            /* Below three cards a share says nothing, and the guard says so too. */
            if (workable.length < 3) continue;
            boardsChecked += 1;

            const counts = new Map<FitBand, number>();
            for (const candidate of workable) {
              counts.set(candidate.fit.band, (counts.get(candidate.fit.band) ?? 0) + 1);
            }
            const over = [...counts]
              .filter(([, held]) => held / workable.length > MAX_TOP_BAND_SHARE)
              .map(([band, held]) => `${band} ${held}/${workable.length}`);
            expect({
              profile: `${dates === AUGUST_DATES ? 'august' : 'january'} ${discoveryMix} ${crowdTolerance} ${level}`,
              over,
            }).toEqual({
              profile: `${dates === AUGUST_DATES ? 'august' : 'january'} ${discoveryMix} ${crowdTolerance} ${level}`,
              over: [],
            });
          }
        }
      }
    }

    /* A sweep that swept nothing is a green test protecting nothing. */
    expect(boardsChecked).toBeGreaterThanOrEqual(24);
  });
});

describe('zero-verified-evidence candidates cannot overclaim', () => {
  it('caps a compiled place with no established significance at "good"', () => {
    const base = boardContext(AUGUST_DATES);
    /*
     * The same place, twice: once as the authored fixture (curation is
     * evidence — exempt), once as a compiled record would arrive (standing
     * assessed, nothing established). Only the second is capped.
     */
    const compiledLike = {
      ...base,
      places: base.places.map((place) => ({
        ...place,
        evidenceRichness: 0.9,
        globalProminence: undefined,
        localSignificance: undefined,
      })),
    };
    const ctx = context({ travelerNeeds: [] });
    const capped = buildDiscoveryBoard({
      ...compiledLike,
      profile: profile(MAMMOTH_HIKER_ANSWERS, ctx),
      travelerNeeds: [],
    });
    for (const candidate of capped.candidates) {
      expect(['top_pick', 'strong']).not.toContain(candidate.fit.band);
      if (candidate.fit.band !== 'not_workable') {
        expect(candidate.fit.evidenceLimited).toBe(true);
      }
    }

    /* And the authored board keeps its top labels — the cap is evidence-scoped. */
    const authored = board(MAMMOTH_HIKER_ANSWERS);
    expect(
      authored.candidates.some(
        (candidate) => candidate.fit.band === 'top_pick' || candidate.fit.band === 'strong',
      ),
    ).toBe(true);
  });
});

/**
 * §9.2 — THE REASON HIERARCHY, AND THE CLAUSES IT IS ALLOWED TO MAKE.
 *
 * Measured on a live Tokyo board, eleven of twenty-one card reasons were the
 * logistics-only travel-time form and only two named a graded interest — on a
 * board whose scorer knew the graded levels, the matched interests and every
 * place's own description. The suites below hold the composer to the repaired
 * contract: lead with the strongest true connection, name what the place
 * concretely offers, append logistics rather than leading with them, and never
 * make a claim whose backing field is absent.
 */
const REASON_VARIANTS: Partial<QuestionnaireAnswers>[] = [
  MAMMOTH_HIKER_ANSWERS,
  { ...MAMMOTH_HIKER_ANSWERS, discoveryMix: 'deep_cuts', crowdTolerance: 'avoid_crowds' },
  { ...MAMMOTH_HIKER_ANSWERS, discoveryMix: 'mostly_classics', pace: 'fast' },
];

describe('§9.2 — the reason names the offer, never the tautology', () => {
  it('never emits "you like X; this is X" without naming what the place offers', () => {
    for (const variant of REASON_VARIANTS) {
      for (const candidate of board(variant).candidates) {
        for (const reason of candidate.fit.reasons) {
          /*
           * The bare form ends at the claim; the honest form continues into
           * the place's own substance. The end-anchor is the whole test.
           */
          expect(reason).not.toMatch(/and that is what this delivers\.$/);
        }
      }
    }
  });

  it('backs every interest sentence with the place’s own description', () => {
    let sentences = 0;
    for (const variant of REASON_VARIANTS) {
      for (const candidate of board(variant).candidates) {
        for (const reason of candidate.fit.reasons) {
          if (!reason.startsWith('You marked ')) continue;
          sentences += 1;
          expect(reason).toContain(candidate.place.shortDescription.trim());
        }
      }
    }
    // The sentence exists — the tautology was banned, not the interest.
    expect(sentences).toBeGreaterThan(0);
  });

  it('speaks to the interest the place leads with, not the loudest grade on the profile', () => {
    /*
     * Convict Lake is a lake first and a viewpoint fourth; this traveller
     * grades scenic viewpoints higher than lakes. The honest sentence connects
     * them through what the place actually is, not through whichever of their
     * grades is loudest.
     */
    const convict = find(board().candidates, 'convict-lake');
    expect(convict.fit.reasons[0]).toContain('lakes & rivers');
  });
});

describe('§9.2 — logistics may append, never lead over a personal reason', () => {
  const LOGISTICS_FORMS = [
    /min you were happy to travel\.$/,
    /^Minutes from where you are staying/,
  ];
  const isLogistics = (reason: string): boolean =>
    LOGISTICS_FORMS.some((form) => form.test(reason));

  it('keeps every logistics line behind the personal case, on every card', () => {
    for (const variant of REASON_VARIANTS) {
      for (const candidate of board(variant).candidates) {
        const at = candidate.fit.reasons.findIndex(isLogistics);
        if (at === -1) continue;
        // Last place, which also means alone when nothing personal is true.
        expect(
          at,
          `${candidate.place.name} puts logistics ahead of a personal reason`,
        ).toBe(candidate.fit.reasons.length - 1);
      }
    }
  });

  it('still appends the travel line, quoting the limit the traveller set', () => {
    expect(find(board().candidates, 'convict-lake').fit.reasons.at(-1)).toContain('60 min');
  });
});

describe('§9.2 — no clause without the field that backs it', () => {
  it('never calls a place an established name below the standing bar', () => {
    for (const variant of REASON_VARIANTS) {
      for (const candidate of board(variant).candidates) {
        if (candidate.place.popularityScore >= WIDELY_NOTED_PROMINENCE) continue;
        for (const reason of candidate.fit.reasons) {
          expect(reason).not.toMatch(/established names|names people come here for/);
        }
      }
    }
  });

  it('never sells fame to a traveller who asked for deep cuts', () => {
    for (const candidate of board({ ...MAMMOTH_HIKER_ANSWERS, discoveryMix: 'deep_cuts' })
      .candidates) {
      for (const reason of candidate.fit.reasons) {
        expect(reason).not.toMatch(/established names|names people come here for/);
      }
    }
  });

  it('refuses the established-names caption and the classics seat to a bounded standing', () => {
    /*
     * The live defect this pins: three suburban micro-sites — a stream-side
     * spot, a basalt knoll, a pond — rendered under "Classics worth your
     * time" captioned "One of the established names here", on the strength of
     * the knowledge-base pair the cataloguing convention mints for nearly
     * everything. The significance model itself had bounded their evidence
     * (`significanceBounded`); a caption must not assert what the rank was
     * refused. Same place, same prominence, flag flipped — the caption and
     * the classics group must both follow the flag.
     */
    const ctx = context({});
    const built = profile(MAMMOTH_HIKER_ANSWERS, ctx);
    const base = boardContext(AUGUST_DATES);
    const withFlag = (bounded: boolean) =>
      buildDiscoveryBoard({
        ...base,
        places: base.places.map((place) =>
          place.id === 'mammoth-lakes-basin'
            ? { ...place, ...(bounded ? { significanceBounded: true } : {}) }
            : place,
        ),
        profile: built,
        travelerNeeds: [],
      });

    const unbounded = find(withFlag(false).candidates, 'mammoth-lakes-basin');
    expect(unbounded.group).toBe('must_see_classics');

    const bounded = find(withFlag(true).candidates, 'mammoth-lakes-basin');
    expect(bounded.group).not.toBe('must_see_classics');
    for (const reason of bounded.fit.reasons) {
      expect(reason).not.toMatch(/established names|names people come here for/);
    }
  });

  it('never claims a quiet find off a record that is not one', () => {
    for (const variant of REASON_VARIANTS) {
      for (const candidate of board(variant).candidates) {
        if (candidate.place.hiddenGemScore >= 0.6) continue;
        for (const reason of candidate.fit.reasons) {
          expect(reason).not.toMatch(/off the standard loop/);
        }
      }
    }
  });

  it('grants "earns the extra travel" only to a stretch the scorer still rates', () => {
    let granted = 0;
    for (const variant of REASON_VARIANTS) {
      for (const candidate of board(variant).candidates) {
        for (const reason of candidate.fit.reasons) {
          if (!/earns the extra travel/.test(reason)) continue;
          granted += 1;
          expect(candidate.detourClass).toBe('stretch');
          expect(['top_pick', 'strong']).toContain(candidate.fit.band);
        }
      }
    }
    // The label is earnable, or the three assertions above guard nothing.
    expect(granted).toBeGreaterThan(0);
  });
});

/**
 * §16B — THE RANKING COMPOSITION, AND THE FOUR THINGS IT MUST NOT BREAK.
 *
 * `quality/significance.ts` was rewritten so that a category weight is a prior
 * rather than a multiplicative ceiling. The four guards below are the other
 * half of that change: the things the repair could plausibly have traded away,
 * each stated so that it fails if the composition regresses in that direction.
 *
 * They are written against `buildDiscoveryBoard` rather than `scorePlace`
 * because that is the ranking a traveller actually sees, and against the same
 * authored region every other test in this file uses — with one field varied at
 * a time, so nothing here can pass by accident of the fixture.
 */
describe('§16B — the ranking keeps its dimensions distinct', () => {
  /** Everything a fully-established place carries, and the fields that read it. */
  const CANONICAL = standingFields(
    assessPlaceStanding({
      inKnowledgeBase: true,
      encyclopaedicArticle: true,
      crossDatasetCorroboration: true,
      classifyingValues: ['leisure=nature_reserve'],
      namedInRegionRecords: true,
      publishedSites: ['https://www.parks.example.gov/x'],
    }),
  );

  /** The same board, with one place's significance set to a chosen value. */
  const boardWithSignificance = (
    placeId: string,
    experienceSignificance: number,
    overrides: Partial<QuestionnaireAnswers> = MAMMOTH_HIKER_ANSWERS,
  ) =>
    buildDiscoveryBoard({
      ...boardContext(AUGUST_DATES),
      places: boardContext(AUGUST_DATES).places.map((place) =>
        place.id === placeId ? { ...place, experienceSignificance } : place,
      ),
      profile: profile(overrides, context({ travelerNeeds: [] })),
      travelerNeeds: [],
    });

  it('does not let canonical significance buy a single point of personal fit', () => {
    /**
     * THE GUARD THAT WOULD HAVE CAUGHT THE OBVIOUS REPAIR.
     *
     * Weighting `experienceSignificance` into the fit score is the tempting way
     * to make the board notice a landmark, and it was measured before it was
     * refused: on the §29 B dense-city world it demoted all three `strong` cards
     * and cost a planned day one of its three stops, because significance
     * occupies 0.12–0.6 on real records while the nine match factors occupy
     * 0.75–1.0, and averaging the two just deflates everything compiled.
     *
     * Fit answers *does this suit you*. Significance answers *does this matter*.
     * §9 asks for both, kept apart — so this number must not move when only the
     * other one does, and the ordering must be composed where ordering happens.
     */
    const famous = boardWithSignificance('bodie-state-historic-park', 1);
    const nobody = boardWithSignificance('bodie-state-historic-park', 0.05);
    expect(find(famous.candidates, 'bodie-state-historic-park').fit.score).toBe(
      find(nobody.candidates, 'bodie-state-historic-park').fit.score,
    );
    expect(find(famous.candidates, 'bodie-state-historic-park').fit.band).toBe(
      find(nobody.candidates, 'bodie-state-historic-park').fit.band,
    );
  });

  it('refuses a place the traveller ruled out however established it is', () => {
    /*
     * A confirmed avoidance is a gate, and no amount of standing may open it. A
     * composition that let significance out-argue a refusal would be putting a
     * famous place in a trip the traveller said they did not want it in — §16B's
     * third guard, and the one a "make landmarks win" change breaks first.
     */
    const refused = buildDiscoveryBoard({
      ...boardContext(AUGUST_DATES),
      places: boardContext(AUGUST_DATES).places.map((place) =>
        place.id === 'rainbow-falls'
          ? { ...place, ...CANONICAL, experienceSignificance: 1 }
          : place,
      ),
      profile: profile(
        {
          ...MAMMOTH_HIKER_ANSWERS,
          interests: interests({
            ...MAMMOTH_HIKER_ANSWERS.interests,
            hiking: 'avoid',
            lakes_and_rivers: 'avoid',
            photography_golden_hour: 'avoid',
            scenic_viewpoints: 'avoid',
          }),
        },
        context({ travelerNeeds: [] }),
      ),
      travelerNeeds: [],
    });
    const candidate = find(refused.candidates, 'rainbow-falls');
    expect(candidate.place.experienceSignificance).toBe(1);
    expect(candidate.fit.band).toBe('not_workable');
    expect(candidate.fit.blockers.map((blocker) => blocker.code)).toContain('avoided_interest');
  });

  it('still separates two travellers by what they said they liked', () => {
    /**
     * §16B's fourth guard, and §9's "category preference" dimension: the
     * traveller's own ranking of kinds has to keep moving the board. It lives in
     * `interestMatch` — a preference of theirs, never a prior about kinds — and
     * the margin has to be a step somebody could see rather than a rounding
     * artefact, or "personalised" is decoration.
     */
    const historian = board({
      ...MAMMOTH_HIKER_ANSWERS,
      interests: interests({
        ...MAMMOTH_HIKER_ANSWERS.interests,
        history_and_culture: 'core',
        hiking: 'low',
      }),
      maxDailyTravelMinutes: 240,
      regionalExpansion: 'nearby_120',
      detourToleranceMinutes: 120,
    });
    const walker = board({
      ...MAMMOTH_HIKER_ANSWERS,
      interests: interests({
        ...MAMMOTH_HIKER_ANSWERS.interests,
        history_and_culture: 'avoid',
        hiking: 'core',
      }),
      maxDailyTravelMinutes: 240,
      regionalExpansion: 'nearby_120',
      detourToleranceMinutes: 120,
    });
    const historic = 'bodie-state-historic-park';
    const hike = 'rainbow-falls';

    /* Half a band, in a scoring range where a band is ten points. */
    expect(
      find(historian.candidates, historic).fit.score -
        find(walker.candidates, historic).fit.score,
    ).toBeGreaterThanOrEqual(5);
    expect(
      find(walker.candidates, hike).fit.score - find(historian.candidates, hike).fit.score,
    ).toBeGreaterThanOrEqual(5);
    expect(rank(historian.candidates, historic)).toBeLessThan(rank(walker.candidates, historic));
  });

  it('multiplies no score by a prior about the kind of place it is', () => {
    /**
     * The structural half of "no ceiling", asserted where a ceiling would have
     * to live. Every factor's contribution is its own weight times its own
     * score, the weights sum to one, and nothing scales the total — so there is
     * no `f(kind) × everythingElse` for a category prior to hide in. A
     * multiplicative cap added here would break the identity below on the first
     * candidate it touched.
     */
    for (const candidate of board().candidates) {
      const summed = candidate.fit.factors.reduce(
        (total, factor) => total + factor.weight * factor.score,
        0,
      );
      expect(candidate.fit.score).toBe(Math.round(summed * 100));
    }
  });
});
