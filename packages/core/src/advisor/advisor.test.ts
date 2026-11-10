import { describe, expect, it } from 'vitest';
import { emptyComposerAnswers, tripComposerAnswersSchema, type TripComposerAnswers } from '../schemas/composer';
import { catalogDestinationSchema, type CatalogDestination } from './catalog/schema';
import { buildAdvisorShortlist, monthsLabel, rankCatalog } from './advise';
import { advisorShortlistSchema } from './shortlist-schema';
import { parseTravelRequest } from './parse';
import { advisorAnswersSchema } from './answers';
import { effectiveRefinements, profileFrom, seasonMonthsForTraveller } from './profile';
import { ADVISOR_QUESTIONS, answerAdvisorQuestion, skipAdvisorQuestion } from './questions';
import { nextQuestion, shortlistDistance } from './interview-policy';
import { scoreDestination } from './score';
import { selectShortlist } from './select';
import { checkPickClimate } from './climate-check';
import { destinationCatalog } from './catalog/index';
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

  it('reads a calendar range as both when and how long, so length is never asked', () => {
    const parsed = parseTravelRequest('march 19-27, mountains, outdoors, budget friendly', base(), NOW);
    expect(parsed.answers.dates).toMatchObject({ mode: 'exact', startDate: '2027-03-19', endDate: '2027-03-27' });
    expect(parsed.answers.duration).toMatchObject({ mode: 'fixed', nights: 8 });
    expect(parsed.readings.map((r) => r.label)).toEqual(expect.arrayContaining(['March 19–27', '8 nights']));
    const asked = new Set<string>();
    let answers = parsed.answers;
    for (let i = 0; i < 8; i += 1) {
      const next = nextQuestion(answers, [entry('a'), entry('b', { cost: 1 })]).question;
      if (!next) break;
      asked.add(next.id);
      answers = skipAdvisorQuestion(answers, next.id);
    }
    expect(asked.has('length')).toBe(false);
    expect(asked.has('when')).toBe(false);
  });

  it.each([
    ['19-27 march', '2027-03-19', '2027-03-27', 8],
    ['Mar 30 to Apr 4', '2027-03-30', '2027-04-04', 5],
    ['19th of March until the 27th', '2027-03-19', '2027-03-27', 8],
    ['dec 28 - jan 4', '2026-12-28', '2027-01-04', 7],
  ])('reads the date range in %s', (text, start, end, nights) => {
    const parsed = parseTravelRequest(text, base(), NOW);
    expect(parsed.answers.dates).toMatchObject({ mode: 'exact', startDate: start, endDate: end });
    expect(parsed.answers.duration).toMatchObject({ mode: 'fixed', nights });
  });

  it('does not read a party size after a month as a date range', () => {
    expect(parseTravelRequest('march 5-7 people, mountains', base(), NOW).answers.dates).toMatchObject({ mode: 'month', month: 3 });
  });

  it('does not read a length span after a month as a date range', () => {
    const parsed = parseTravelRequest('in march for 5-7 days', base(), NOW);
    expect(parsed.answers.dates).toMatchObject({ mode: 'month', month: 3 });
    expect(parsed.answers.duration).toMatchObject({ mode: 'range', minNights: 4, maxNights: 6 });
  });

  it('treats a bare "outdoors" as too vague to pick an interest for', () => {
    const parsed = parseTravelRequest('Somewhere outdoors in August', base());
    expect(parsed.answers.discovery?.focus).toEqual([]);
    expect(parsed.vague).toContain('outdoors');
    /* The word is a leaning, shown back as an assumption — never a stated interest. */
    expect(parsed.answers.discovery?.moods).toEqual(['scenic']);
    expect(parsed.answers.discovery?.pursuits).toBeUndefined();
    expect(parsed.assumptions.join(' ')).toMatch(/No activity named/);
  });

  it('reads a request with no activity in it as leanings, not as arbitrary words to look up', () => {
    const relaxing = parseTravelRequest('Somewhere beautiful and relaxing.', base());
    expect(relaxing.answers.discovery?.moods).toEqual(['scenic', 'relaxing']);
    expect(relaxing.answers.discovery?.terms).toBeUndefined();
    const friends = parseTravelRequest('An unforgettable trip with my friends.', base());
    expect(friends.answers.discovery?.moods).toEqual(['social', 'memorable']);
    expect(friends.answers.discovery?.terms).toBeUndefined();
    const cheap = parseTravelRequest('Good scenery, not too expensive.', base());
    expect(cheap.answers.discovery?.moods).toEqual(['scenic']);
    expect(cheap.answers.budget).toBe('mid_range');
    const easy = parseTravelRequest('Somewhere adventurous but not too difficult.', base());
    expect(easy.answers.discovery?.moods).toEqual(['adventurous']);
    expect(easy.answers.discovery?.adventure).toBe('active');
    /* Who is travelling is not a thing to search guides for. */
    const access = parseTravelRequest('Good scenery that works for a wheelchair user', base());
    expect(access.answers.travelerNeeds).toContain('mobility_limited');
    expect(access.answers.discovery?.terms).toBeUndefined();
  });

  it('stores every reading of a vague request in a form the answers schema accepts', () => {
    /* A session that fails this parse is a 404 for the person who wrote it. */
    for (const text of ['Somewhere beautiful and relaxing.', 'An unforgettable trip with my friends for a romantic adventure.', 'Good scenery, not too expensive.']) {
      expect(advisorAnswersSchema.safeParse(parseTravelRequest(text, base()).answers.discovery).success, text).toBe(true);
    }
  });

  it('drops the mood the moment something specific is said', () => {
    const parsed = parseTravelRequest('Somewhere beautiful for hiking', base());
    expect(parsed.answers.discovery?.focus).toEqual(['hiking']);
    expect(parsed.answers.discovery?.moods).toBeUndefined();
  });

  it('reads a precise pursuit as itself: hot springs are not volcanoes, a food trip is not half a culture trip', () => {
    expect(parseTravelRequest('A week of hot springs in winter', base()).answers.discovery).toMatchObject({ focus: [], pursuits: ['hot_springs'] });
    expect(parseTravelRequest('Stargazing somewhere remote in March', base()).answers.discovery?.pursuits).toEqual(['stargazing']);
    expect(parseTravelRequest('A food-focused trip in October: markets, regional cooking, wine', base()).answers.discovery?.pursuits).toContain('food');
    expect(parseTravelRequest('Temples and ruins in March', base()).answers.discovery).toMatchObject({ focus: [], pursuits: ['culture'] });
    expect(parseTravelRequest('Food and culture in Japan', base()).answers.discovery?.focus).toEqual(['culture_food']);
  });

  it('does not read hike difficulty as a budget, or hot springs as hot weather', () => {
    const parsed = parseTravelRequest('Moderate hikes and hot springs in Iceland-style scenery', base());
    expect(parsed.answers.budget).toBeUndefined();
    expect(parsed.answers.climatePreference).toBeUndefined();
    expect(parsed.answers.discovery?.pursuits).toContain('hot_springs');
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

describe('reading negations, amounts and who is going (audit 2026-11)', () => {
  const read = (text: string) => parseTravelRequest(text, base(), NOW);
  const labels = (text: string) => read(text).readings.map((reading) => reading.label);

  it('reads "no snow" as a refusal, never as a wish for snow', () => {
    for (const text of ['hiking but no snow, march', 'I want to go hiking in the mountains in March but I don’t want snow', 'hiking in december, avoid snow and ice']) {
      const parsed = read(text);
      expect(parsed.answers.discovery?.focus, text).not.toContain('snow');
      expect(parsed.answers.discovery?.avoidSnow, text).toBe(true);
      expect(parsed.answers.discovery?.focus, text).toContain('hiking');
    }
    expect(read('skiing in february').answers.discovery?.focus).toEqual(['snow']);
    expect(read('snowboarding in january').answers.discovery?.focus).toEqual(['snow']);
  });

  it('treats "don’t mind snow" as tolerance: neither a wish nor a refusal', () => {
    const parsed = read('I don’t mind snow, hiking in march');
    expect(parsed.answers.discovery?.focus).toEqual(['hiking']);
    expect(parsed.answers.discovery?.avoidSnow).toBeUndefined();
  });

  it('puts a snowbound month out of season for somebody who refused snow, and caps a frozen one for a hiker', () => {
    const alpine = entry('alpine', { experiences: { day_hiking: 3, high_mountains: 3, winter_snow: 3 }, season: [3, 3, 3, 2, 1, 3, 3, 3, 3, 2, 1, 3] });
    const noSnow = profileFrom(read('hiking in the mountains in March, no snow').answers);
    expect(scoreDestination(alpine, noSnow).exclusion?.code).toBe('out_of_season');
    // A coast rated for its winter that is frozen in March is not a hiking month, even without a snow rating.
    const arctic = entry('arctic', { experiences: { day_hiking: 3, coastal_scenery: 3, villages_culture: 1 }, season: [2, 2, 2, 2, 2, 3, 3, 3, 2, 1, 1, 2], highC: [-1, 0, 2, 5, 9, 12, 15, 14, 10, 6, 2, 0] });
    expect(scoreDestination(arctic, profileFrom(read('hiking in March').answers)).bestMonths).toEqual([]);
  });

  it('reads "not too strenuous" as gentle, not as strenuous', () => {
    for (const text of ['relaxed, not too strenuous, lakes in september', 'nothing too strenuous, lakes in june']) {
      expect(read(text).answers.discovery?.adventure, text).toBe('comfortable');
    }
    expect(read('intense hiking every day, multi-day treks, august').answers.discovery?.adventure).toBe('rugged');
    expect(read('intense hiking every day, multi-day treks, august').answers.discovery?.mountainStyle).toBe('hut_to_hut');
    expect(read('hardcore trekking at high altitude in october').answers.discovery?.mountainStyle).toBe('high_altitude');
  });

  it('reads every way of refusing to drive as no car, and only an unrefused drive as driving', () => {
    for (const text of ['I don’t like driving, culture and food in may', 'no driving please, lakes in august', 'don’t want to drive, hiking', 'public transport only, mountains', 'I hate driving']) {
      expect(read(text).answers.transport, text).toBe('public_transport');
    }
    expect(read('happy to drive, scenic road trip in june').answers.transport).toBe('drive');
  });

  it('reads a refused interest as a soft mark against places built around it', () => {
    const parsed = read('not too expensive, beaches in july, no cities');
    expect(parsed.answers.discovery?.focus).toEqual(['beaches']);
    expect(parsed.answers.discovery?.refused).toEqual(['cities']);
    const profile = profileFrom(parsed.answers);
    const city = entry('city', { experiences: { beaches_swimming: 3, coastal_scenery: 3, city_life: 3 }, highC: [14, 15, 17, 20, 24, 28, 31, 31, 27, 23, 18, 15], season: [1, 1, 2, 2, 3, 3, 3, 3, 3, 2, 1, 1] });
    const quiet = entry('quiet', { experiences: { beaches_swimming: 3, coastal_scenery: 3, villages_culture: 1 }, highC: [14, 15, 17, 20, 24, 28, 31, 31, 27, 23, 18, 15], season: [1, 1, 2, 2, 3, 3, 3, 3, 3, 2, 1, 1] });
    expect(scoreDestination(quiet, profile).score).toBeGreaterThan(scoreDestination(city, profile).score);
  });

  it('reads "anywhere but Europe" as every region except Europe', () => {
    const regions = read('beaches in march, anywhere but europe').answers.discovery?.regions ?? [];
    expect(regions).not.toContain('southern_europe');
    expect(regions).toContain('caribbean');
    expect(read('not europe this time, hiking in may').answers.discovery?.regions).not.toContain('western_europe');
  });

  it('reads money: words before amounts, an amount per night, and "no budget" as the opposite of budget', () => {
    expect(read('under $1500 for a week of hiking in july').answers.budget).toBe('mid_range');
    expect(read('under $1,000 for 10 days of beaches').answers.budget).toBe('budget');
    expect(read('€300 a day, food in october').answers.budget).toBe('premium');
    expect(read('money is no object, wildlife').answers.budget).toBe('luxury');
    expect(read('not too expensive, beaches').answers.budget).toBe('mid_range');
    expect(read('cheap, under $5000 for two weeks').answers.budget).toBe('budget');
    expect(read('under $1500 for a week of hiking in july').assumptions.join(' ')).toMatch(/\$214 a night/);
  });

  it('never reads a rate as the trip length', () => {
    const parsed = read('100 euros a day, culture in april, 10 days');
    expect(parsed.answers.duration).toMatchObject({ mode: 'fixed', nights: 9 });
    expect(read('€100 a day, culture in april').answers.duration.mode).toBe('unknown');
  });

  it('rules out a place two cost levels over a tight budget, and only bends a comfortable one', () => {
    const pricey = entry('pricey', { cost: 4 });
    expect(scoreDestination(pricey, profileFrom(read('not too expensive, hiking in july').answers)).exclusion?.code).toBe('over_budget');
    expect(scoreDestination(pricey, profileFrom({ ...read('hiking in july').answers, budget: 'premium' })).exclusion).toBeNull();
  });

  it('reads "a week or two" as a range and the other flexible lengths', () => {
    expect(read('a week or two in spring').answers.duration).toMatchObject({ mode: 'range', minNights: 7, maxNights: 14 });
    expect(read('one or two weeks in the fall').answers.duration).toMatchObject({ mode: 'range', minNights: 7, maxNights: 14 });
    expect(read('5-7 days in may').answers.duration).toMatchObject({ mode: 'range', minNights: 4, maxNights: 6 });
  });

  it('reads more ways of writing dates', () => {
    expect(read('between the 3rd and 14th of june, beaches').answers.dates).toMatchObject({ mode: 'exact', startDate: '2027-06-03', endDate: '2027-06-14' });
    expect(read('3/19 - 3/27 hiking').answers.dates).toMatchObject({ mode: 'exact', startDate: '2027-03-19', endDate: '2027-03-27' });
    expect(read('19/3 - 27/3 hiking').answers.dates).toMatchObject({ mode: 'exact', startDate: '2027-03-19', endDate: '2027-03-27' });
    // Ambiguous day and month: left for the question rather than guessed.
    expect(read('3/4 - 3/9 hiking').answers.dates.mode).toBe('month');
    expect(read('mid-may to early june, lakes').answers.dates).toMatchObject({ mode: 'months', months: [5, 6] });
    expect(read('next month, hiking').answers.dates).toMatchObject({ mode: 'month', month: 11 });
  });

  it('does not read the verb "may" as a month', () => {
    expect(read('we may go hiking in june').answers.dates).toMatchObject({ mode: 'month', month: 6 });
    expect(read('hiking in may').answers.dates).toMatchObject({ mode: 'month', month: 5 });
  });

  it('reads who is going, so "who’s going" is never asked after it was said', () => {
    const kids = read('family trip with two kids aged 6 and 9 in july, beaches and wildlife').answers;
    expect(kids.children).toBe(2);
    expect(kids.travelerNeeds).toContain('kids_under_12');
    const teens = read('with our kids aged 14 and 16, hiking in july').answers;
    expect(teens.children).toBe(2);
    expect(teens.travelerNeeds).not.toContain('kids_under_12');
    expect(read('no kids, just me and my partner, beaches').answers.children).toBe(0);
    expect(labels('a couple of days in the alps')).not.toContain('A couple');
    for (const text of ['group of friends, nightlife and beaches in june', 'solo, hiking, september', 'me and my partner, beaches in june', 'with two kids in july, beaches']) {
      let answers = read(text).answers;
      const asked: string[] = [];
      for (let i = 0; i < 10; i += 1) {
        const step = nextQuestion(answers, destinationCatalog());
        if (!step.question) break;
        asked.push(step.question.id);
        answers = skipAdvisorQuestion(answers, step.question.id);
      }
      expect(asked, text).not.toContain('party');
    }
  });

  it('reads a stated lead, so "which matters most" is not asked', () => {
    const parsed = read('mostly hiking, some food and culture, september');
    expect(parsed.answers.discovery?.focus[0]).toBe('hiking');
    expect(parsed.answers.discovery?.focusRanked).toBe(true);
  });

  it('does not let one clause’s negation reach into the next', () => {
    const parsed = read('no car, but happy to hike in the mountains in june');
    expect(parsed.answers.discovery?.focus).toEqual(expect.arrayContaining(['hiking', 'mountains']));
    expect(parsed.answers.transport).toBe('public_transport');
    expect(read('not just beaches, also mountains, july').answers.discovery?.focus).toEqual(expect.arrayContaining(['beaches', 'mountains']));
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
