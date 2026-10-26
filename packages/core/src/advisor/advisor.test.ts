import { describe, expect, it } from 'vitest';
import { emptyComposerAnswers, tripComposerAnswersSchema, type TripComposerAnswers } from '../schemas/composer';
import { catalogDestinationSchema, type CatalogDestination } from './catalog/schema';
import { buildAdvisorShortlist, monthsLabel, rankCatalog } from './advise';
import { advisorShortlistSchema } from './shortlist-schema';
import { parseTravelRequest } from './parse';
import { effectiveRefinements, profileFrom, seasonMonthsForTraveller } from './profile';
import { ADVISOR_QUESTIONS, answerAdvisorQuestion, nextQuestion, shortlistDistance, skipAdvisorQuestion } from './questions';
import { scoreDestination } from './score';
import { selectShortlist } from './select';
import { checkPickClimate } from './climate-check';
import { originPointFromText } from './origin';

const NOW = new Date('2026-10-26T12:00:00Z');

function base(): TripComposerAnswers {
  return { ...emptyComposerAnswers('help_me_decide', NOW), dates: { mode: 'month', wantsRecommendation: false } };
}

/** A synthetic destination: every test below states the one thing it varies. */
function entry(id: string, patch: Partial<CatalogDestination> = {}): CatalogDestination {
  return catalogDestinationSchema.parse({
    id,
    name: `Place ${id}`,
    context: 'Somewhere',
    kind: 'travel_region',
    countries: ['NO'],
    worldRegion: 'northern_europe',
    center: { lat: 60, lng: 10 },
    radiusKm: 80,
    resolveAs: `Place ${id}, Norway`,
    bases: ['Town'],
    nights: { min: 3, ideal: 6, max: 12 },
    experiences: { day_hiking: 3, high_mountains: 3, lakes: 2 },
    highlights: ['A named ridge walk above the fjord', 'A lake you can row across', 'A hut with a view'],
    pitch: 'A synthetic destination used only by the advisor unit tests, with stated scores.',
    season: [0, 0, 1, 2, 3, 3, 3, 3, 2, 1, 0, 0],
    highC: [0, 1, 4, 8, 13, 17, 20, 19, 14, 8, 3, 1],
    wet: [2, 2, 2, 1, 1, 1, 1, 1, 2, 2, 2, 2],
    cost: 3,
    lodging: { simple: true, comfortable: true, luxury: false },
    challenge: { easiest: 1, typical: 2 },
    remoteness: 1,
    crowds: 1,
    familiarity: 1,
    access: { airports: ['OSL'], reach: 1, car: 'helpful', transit: 'limited', note: 'Trains to the valley, buses beyond.' },
    family: 2,
    lowMobility: 1,
    tradeoffs: ['Weather changes fast'],
    cautions: [],
    evidence: { basis: 'sidequest_editorial', asOf: '2026-10', references: ['test'] },
    ...patch,
  });
}

describe('reading what somebody typed', () => {
  it('reads the original request without inventing anything', () => {
    const parsed = parseTravelRequest(
      "Find me somewhere outdoors for the summer. I love hiking, wildlife, mountains, lakes, coast and swimming. I'm flexible on duration.",
      base(),
    );
    expect(parsed.answers.dates).toMatchObject({ mode: 'season', season: 'summer' });
    expect(parsed.answers.duration).toMatchObject({ mode: 'unknown', wantsRecommendation: true });
    expect(parsed.answers.discovery?.focus).toEqual(['hiking', 'mountains', 'wildlife', 'lakes', 'beaches']);
    expect(parsed.answers.discovery?.focusRanked).toBe(false);
    // Nothing about budget, adventure, origin or crowds was said, so nothing is set.
    expect(parsed.answers.budget).toBeUndefined();
    expect(parsed.answers.discovery?.adventure).toBeUndefined();
    expect(parsed.answers.origin).toBeUndefined();
    expect(parsed.assumptions.join(' ')).toMatch(/June–August/);
  });

  it('treats a bare "outdoors" as too vague to pick an interest for', () => {
    const parsed = parseTravelRequest('Somewhere outdoors in August', base());
    expect(parsed.answers.discovery?.focus).toEqual([]);
    expect(parsed.vague).toContain('outdoors');
  });

  it('does not read hike difficulty as a budget, or hot springs as hot weather', () => {
    const parsed = parseTravelRequest('Moderate hikes and hot springs in Iceland-style scenery', base());
    expect(parsed.answers.budget).toBeUndefined();
    expect(parsed.answers.climatePreference).toBeUndefined();
    expect(parsed.answers.discovery?.focus).toContain('volcanoes');
  });

  it('reads a named sub-region without widening it to its continent', () => {
    const parsed = parseTravelRequest('Southeast Asia in February: beaches and jungle', base());
    expect(parsed.answers.discovery?.regions).toEqual(['southeast_asia']);
  });

  it('reads "the Balkans" as its countries, not as all of southern Europe', () => {
    const parsed = parseTravelRequest('Hiking and lakes in the Balkans in June', base());
    expect(parsed.answers.discovery?.countries).toContain('ME');
    expect(parsed.answers.discovery?.countries).not.toContain('PT');
    expect(parsed.answers.discovery?.regions).toBeUndefined();
  });

  it('reads "summer" in the traveller’s own hemisphere', () => {
    const parsed = parseTravelRequest('Summer holidays from Sydney, hiking and beaches.', base());
    expect(parsed.answers.origin).toBe('Sydney');
    expect(profileFrom(parsed.answers).months).toEqual([12, 1, 2]);
    expect(seasonMonthsForTraveller('summer', null)).toEqual([6, 7, 8]);
  });

  it('places a departure city before falling back to a country centre', () => {
    expect(originPointFromText('San Francisco')).toMatchObject({ basis: 'city', countryCode: 'US' });
    expect(originPointFromText('la')).toMatchObject({ label: 'Los Angeles' });
    expect(originPointFromText('Atlantis')).toBeNull();
  });
});

describe('the profile', () => {
  it('leaves what nobody said as null, never a middle value', () => {
    const profile = profileFrom(base());
    expect(profile.budget).toBeNull();
    expect(profile.adventure).toBeNull();
    expect(profile.nights).toBeNull();
    expect(profile.months).toBeNull();
  });

  it('lets an opposite refinement undo the earlier one rather than stacking', () => {
    expect(effectiveRefinements(['warmer', 'cheaper', 'cooler'])).toEqual(['cheaper']);
  });

  it('ranks interests when the traveller says which leads', () => {
    let answers = parseTravelRequest('hiking, wildlife and lakes', base()).answers;
    answers = answerAdvisorQuestion(answers, 'lead', ['wildlife']);
    const profile = profileFrom(answers);
    expect(profile.focus[0]).toBe('wildlife');
    expect(profile.leadStated).toBe(true);
    expect(profile.interests[0]!.weight).toBeGreaterThan(profile.interests[1]!.weight);
  });
});

describe('scoring one destination', () => {
  it('drops an unasked factor from the score instead of scoring it', () => {
    const answers = parseTravelRequest('hiking in July', base()).answers;
    const scored = scoreDestination(entry('a'), profileFrom(answers));
    const budget = scored.factors.find((factor) => factor.id === 'budget')!;
    expect(budget.measure.kind).toBe('not_asked');
    expect(scored.coverage).toBeLessThan(1);
  });

  it('excludes a destination that is closed in every month of the window', () => {
    const answers = parseTravelRequest('hiking in January', base()).answers;
    const scored = scoreDestination(entry('a'), profileFrom(answers));
    expect(scored.exclusion?.code).toBe('out_of_season');
  });

  it('gives no swimming credit to a beach too cold to swim from', () => {
    const answers = parseTravelRequest('beaches and swimming in July', base()).answers;
    const profile = profileFrom(answers);
    const cold = scoreDestination(entry('cold', { experiences: { beaches_swimming: 3, coastal_scenery: 1, day_hiking: 1 }, highC: [0, 0, 2, 5, 9, 12, 14, 14, 11, 7, 3, 1] }), profile);
    const warm = scoreDestination(entry('warm', { experiences: { beaches_swimming: 3, coastal_scenery: 1, day_hiking: 1 }, highC: [14, 15, 17, 20, 24, 28, 31, 31, 27, 23, 18, 15] }), profile);
    expect(warm.interestFit[0]!.value).toBeGreaterThan(cold.interestFit[0]!.value + 0.3);
  });

  it('never rewards fame unless the traveller asked for the classics', () => {
    const answers = parseTravelRequest('hiking and mountains in July', base()).answers;
    const famous = scoreDestination(entry('famous', { familiarity: 3 }), profileFrom(answers));
    const obscure = scoreDestination(entry('obscure', { familiarity: 0 }), profileFrom(answers));
    expect(famous.score).toBe(obscure.score);
    const classic = profileFrom({ ...answers, surpriseAppetite: 'familiar' });
    expect(scoreDestination(entry('famous', { familiarity: 3 }), classic).score).toBeGreaterThan(scoreDestination(entry('obscure', { familiarity: 0 }), classic).score);
  });

  it('rules out a place that needs a car for someone who will not drive, when transit is poor', () => {
    const answers = { ...parseTravelRequest('hiking in July', base()).answers, transport: 'public_transport' as const };
    const scored = scoreDestination(entry('a', { access: { airports: ['OSL'], reach: 1, car: 'essential', transit: 'poor', note: 'Only by car, really.' } }), profileFrom(answers));
    expect(scored.exclusion?.code).toBe('needs_a_car');
  });
});

describe('choosing the shortlist', () => {
  const catalog = [
    entry('alps-a', { center: { lat: 46.5, lng: 8 }, countries: ['CH'], worldRegion: 'western_europe' }),
    entry('alps-b', { center: { lat: 46.6, lng: 8.2 }, countries: ['CH'], worldRegion: 'western_europe' }),
    entry('alps-c', { center: { lat: 46.4, lng: 7.8 }, countries: ['CH'], worldRegion: 'western_europe' }),
    entry('rockies', { center: { lat: 51, lng: -116 }, countries: ['CA'], worldRegion: 'north_america_west', experiences: { day_hiking: 3, high_mountains: 3, lakes: 3, wildlife_general: 2 } }),
    entry('tianshan', { center: { lat: 42.5, lng: 78.4 }, countries: ['KG'], worldRegion: 'caucasus_central_asia', experiences: { day_hiking: 3, high_mountains: 3, multi_day_trekking: 3, lakes: 2 }, cost: 1 }),
  ];

  it('prefers three different answers to three versions of one', () => {
    const answers = parseTravelRequest('hiking and mountains in July, anywhere in the world', base()).answers;
    const { profile, ranked } = rankCatalog(answers, catalog);
    const ids = selectShortlist(ranked, profile).picks.map((scored) => scored.destination.id);
    expect(ids.filter((id) => id.startsWith('alps')).length).toBeLessThanOrEqual(1);
  });

  it('does not push a region-restricted request apart for the sake of it', () => {
    const answers = parseTravelRequest('hiking and mountains in July in Europe', base()).answers;
    const { profile, ranked } = rankCatalog(answers, catalog);
    const ids = selectShortlist(ranked, profile).picks.map((scored) => scored.destination.id);
    expect(ids.every((id) => id.startsWith('alps'))).toBe(true);
  });

  it('is deterministic', () => {
    const answers = parseTravelRequest('hiking and mountains in July', base()).answers;
    const a = buildAdvisorShortlist({ answers, catalog, catalogVersion: 't', now: NOW });
    const b = buildAdvisorShortlist({ answers, catalog, catalogVersion: 't', now: NOW });
    expect(a.picks.map((pick) => pick.id)).toEqual(b.picks.map((pick) => pick.id));
  });

  it('writes a shortlist the stored schema can read back', () => {
    const answers = parseTravelRequest('hiking and mountains in July', base()).answers;
    const shortlist = buildAdvisorShortlist({ answers, catalog, catalogVersion: 't', now: NOW });
    expect(advisorShortlistSchema.safeParse(JSON.parse(JSON.stringify(shortlist))).success).toBe(true);
    expect(tripComposerAnswersSchema.safeParse(answers).success).toBe(true);
  });

  it('says what changed after a refinement', () => {
    const answers = parseTravelRequest('hiking and mountains in July', base()).answers;
    const first = buildAdvisorShortlist({ answers, catalog, catalogVersion: 't', now: NOW });
    const cheaper = { ...answers, discovery: { ...answers.discovery!, refinements: ['cheaper' as const] } };
    const second = buildAdvisorShortlist({ answers: cheaper, catalog, catalogVersion: 't', now: NOW, previous: first });
    expect(second.changes.length).toBeGreaterThan(0);
    expect(second.previousIds).toEqual(first.picks.map((pick) => pick.id));
  });
});

describe('the interview', () => {
  const catalog = [
    entry('mountain', { experiences: { high_mountains: 3, day_hiking: 3, multi_day_trekking: 2 } }),
    entry('safari', { center: { lat: -2, lng: 35 }, countries: ['TZ'], worldRegion: 'east_africa', experiences: { big_game_safari: 3, wildlife_general: 3, birding: 2 }, season: [2, 2, 1, 0, 0, 3, 3, 3, 3, 2, 1, 2], highC: [28, 28, 27, 25, 24, 23, 23, 24, 26, 27, 27, 27] }),
    entry('reef', { center: { lat: -8, lng: 115 }, countries: ['ID'], worldRegion: 'southeast_asia', experiences: { snorkel_dive: 3, beaches_swimming: 3, marine_wildlife: 3 }, season: [1, 1, 2, 2, 3, 3, 3, 3, 3, 2, 1, 1], highC: [30, 30, 30, 31, 31, 30, 29, 29, 30, 31, 31, 30] }),
  ];

  it('asks the essentials first, and never something the text answered', () => {
    const answers = parseTravelRequest('wildlife and mountains', base()).answers;
    const step = nextQuestion(answers, catalog);
    expect(step.question?.id).toBe('when');
    expect(step.ready).toBe(false);
  });

  it('values a discriminating question above one whose every answer leaves the list alone', () => {
    let answers = parseTravelRequest('wildlife, mountains and snorkelling in July', base()).answers;
    answers = { ...answers, discovery: { ...answers.discovery!, asked: ['region', 'reach'] } };
    const step = nextQuestion(answers, catalog);
    const lead = step.values.find((value) => value.id === 'lead')!.value;
    const crowds = step.values.find((value) => value.id === 'crowds')?.value ?? 0;
    expect(lead).toBeGreaterThan(crowds);
  });

  it('never asks a skipped question again', () => {
    let answers = parseTravelRequest('wildlife and mountains in July', base()).answers;
    const first = nextQuestion(answers, catalog).question!;
    answers = skipAdvisorQuestion(answers, first.id);
    expect(nextQuestion(answers, catalog).question?.id).not.toBe(first.id);
  });

  it('every option prior is positive and every question has options', () => {
    const answers = parseTravelRequest('wildlife, mountains, lakes and beaches in July', base()).answers;
    for (const question of ADVISOR_QUESTIONS) {
      const options = question.options(answers);
      if (question.applies(answers)) expect(options.length, question.id).toBeGreaterThan(0);
      for (const option of options) expect(option.prior, `${question.id}:${option.id}`).toBeGreaterThan(0);
    }
  });

  it('measures shortlist change with the top three weighing double', () => {
    expect(shortlistDistance(['a', 'b', 'c'], ['a', 'b', 'c'])).toBe(0);
    expect(shortlistDistance(['a', 'b', 'c'], ['x', 'y', 'z'])).toBe(1);
    expect(shortlistDistance(['a', 'b', 'c', 'd'], ['a', 'b', 'c', 'x'])).toBeLessThan(shortlistDistance(['a', 'b', 'c', 'd'], ['x', 'b', 'c', 'd']));
  });
});

describe('checking the weather against records', () => {
  const pick = () => {
    const answers = parseTravelRequest('hiking in July', base()).answers;
    return buildAdvisorShortlist({ answers, catalog: [entry('a')], catalogVersion: 't', now: NOW }).picks[0]!;
  };
  const profile = (high: number) => ({
    schemaVersion: 1 as const,
    coordinates: { lat: 60, lng: 10 },
    sampleYearFrom: 2005,
    sampleYearTo: 2024,
    months: Array.from({ length: 12 }, (_, index) => ({ month: index + 1, temperature: { low: high - 8, high }, precipitationMm: 60, wetDays: 9, snowDays: 0, daylightHours: 15, hotDays: 0, freezeDays: 0 })),
    provider: 'test',
    dataset: 'test',
    attribution: 'test',
    retrievedAt: NOW.toISOString(),
  });

  it('agrees within tolerance', () => {
    expect(checkPickClimate(pick(), profile(19) as never, false, entry('a')).status).toBe('verified');
  });

  it('reports a disagreement instead of keeping the editorial number', () => {
    const result = checkPickClimate(pick(), profile(31) as never, false, entry('a'));
    expect(result.status).toBe('differs');
    expect(result.note).toMatch(/31 °C/);
  });

  it('says when nothing answered', () => {
    expect(checkPickClimate(pick(), null, true).status).toBe('unavailable');
  });
});

describe('month labels', () => {
  it('joins runs and wraps December', () => {
    expect(monthsLabel([6, 7, 8])).toBe('June–August');
    expect(monthsLabel([12, 1, 2])).toBe('December–February');
    expect(monthsLabel([3, 4, 9, 10])).toBe('March–April, September–October');
  });
});
