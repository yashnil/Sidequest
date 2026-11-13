import { describe, expect, it } from 'vitest';
import { emptyComposerAnswers, type TripComposerAnswers } from '../schemas/composer';
import { emptyAdvisorAnswers } from './answers';
import { buildAdvisorShortlist, rankCatalog } from './advise';
import { destinationCatalog } from './catalog/index';
import { asDestination, type Destination } from './destination';
import { builtAround, ownWishes, vacationFit } from './concept';
import { CHILDREN_FAMILY_FLOOR, primaryConflicts } from './conflicts';
import { parseTravelRequest } from './parse';
import { profileFrom } from './profile';
import { answerAdvisorQuestion } from './questions';
import { scoreDestination } from './score';

const NOW = new Date('2026-11-12T12:00:00Z');
const catalog = destinationCatalog();
const byId = (id: string): Destination => asDestination(catalog.find((entry) => entry.id === id)!);
function base(): TripComposerAnswers {
  return { ...emptyComposerAnswers('help_me_decide', NOW), dates: { mode: 'month', wantsRecommendation: false }, discovery: emptyAdvisorAnswers() };
}
function place(overrides: Partial<Destination>): Destination {
  return { ...asDestination(catalog[0]!), id: 'test', name: 'Test', bases: ['A'], radiusKm: 50, ...overrides };
}

const OWNER_REQUEST =
  'I want to go on a trip with my family over spring, March 19-29. Preferably a nice retreat. I want to feel good because life has been stressful recently. Outdoors stuff.';
/** The same words a card uses for a restful-trip conflict, whichever place carries it. */
const RESTFUL_CATCH = /is not what a restful trip is for/;

const owner = parseTravelRequest(OWNER_REQUEST, base(), NOW).answers;
const mountains = answerAdvisorQuestion(owner, 'focus', ['mountains']);
const VARIANTS: [string, TripComposerAnswers][] = [
  ['the request alone', owner],
  ['with "Mountains and trekking"', mountains],
  ['with "Mountains and trekking" + "Day hikes from a base"', answerAdvisorQuestion(mountains, 'mountain_style', ['base_day_hikes'])],
  ['with mountains then lakes + "Day hikes from a base"', answerAdvisorQuestion(answerAdvisorQuestion(owner, 'focus', ['mountains', 'lakes']), 'mountain_style', ['base_day_hikes'])],
];

const trekBuilt = place({ experiences: { multi_day_trekking: 3, high_mountains: 3, villages_culture: 2 }, challenge: { easiest: 1, typical: 2 } });

describe('disqualifiers from the top of the list', () => {
  it('a trek-built place conflicts with a restful trip, in the same words its card uses', () => {
    const profile = profileFrom(mountains);
    expect(builtAround(trekBuilt)).toContain('multi_day_trekking');
    const conflicts = primaryConflicts(trekBuilt, profile);
    expect(conflicts.map((conflict) => conflict.code)).toEqual(['strenuous_core']);
    const feel = vacationFit(trekBuilt, profile.concept, { nights: 10, kids: false, wishes: ownWishes(profile.interests, profile.concept) })!;
    /* One source of truth: the disqualifier's sentence is the feel's own sentence. */
    expect(feel.against).toContain(conflicts[0]!.sentence);
    expect(conflicts[0]!.sentence).toMatch(RESTFUL_CATCH);
  });

  it('is waived when the traveller asked for the strenuous thing themselves', () => {
    const hut = profileFrom(answerAdvisorQuestion(mountains, 'mountain_style', ['hut_to_hut']));
    expect(primaryConflicts(trekBuilt, hut)).toEqual([]);
    const rugged = profileFrom({ ...mountains, discovery: { ...mountains.discovery!, adventure: 'rugged' } });
    expect(primaryConflicts(trekBuilt, rugged)).toEqual([]);
    const restfulTrek = profileFrom(parseTravelRequest('Burnt out and need to switch off — a slow trek in the mountains in October.', base(), NOW).answers);
    expect(primaryConflicts(trekBuilt, restfulTrek)).toEqual([]);
  });

  it('never fires on a trip that is not restful, nor on a place that is not built around effort', () => {
    const trek = profileFrom(parseTravelRequest('Two weeks of trekking in October.', base(), NOW).answers);
    expect(primaryConflicts(trekBuilt, trek)).toEqual([]);
    const gentle = place({ experiences: { hot_springs_wellness: 3, lakes: 3, day_hiking: 2 }, challenge: { easiest: 0, typical: 1 } });
    expect(primaryConflicts(gentle, profileFrom(mountains))).toEqual([]);
  });

  it('keeps a hard place for children out of first place, and never on a missing reading', () => {
    const kids = profileFrom({ ...base(), children: 2 });
    expect(primaryConflicts(place({ family: CHILDREN_FAMILY_FLOOR - 0.5 }), kids).map((conflict) => conflict.code)).toEqual(['hard_with_children']);
    expect(primaryConflicts(place({ family: null }), kids)).toEqual([]);
    expect(primaryConflicts(place({ family: 2 }), kids)).toEqual([]);
  });

  it('keeps a car-only place out of first place for somebody who will not drive, and never on unknown access', () => {
    const noCar = profileFrom({ ...base(), transport: 'public_transport' });
    const access = asDestination(catalog[0]!).access;
    expect(primaryConflicts(place({ access: { ...access, car: 'essential', transit: 'limited' } }), noCar).map((conflict) => conflict.code)).toEqual(['needs_a_car']);
    expect(primaryConflicts(place({ access: { ...access, car: 'unknown', transit: 'unknown' } }), noCar)).toEqual([]);
  });

  it('never reads a wish back as a catch: "mountains" and a restful trip do not hold the peaks against it', () => {
    const profile = profileFrom(mountains);
    const peaks = place({ experiences: { high_mountains: 3, lakes: 3, day_hiking: 3 }, challenge: { easiest: 0, typical: 1 } });
    const feel = vacationFit(peaks, profile.concept, { nights: 10, kids: false, wishes: ownWishes(profile.interests, profile.concept) })!;
    expect(feel.against.join(' ')).not.toMatch(/high mountains/);
  });
});

describe('a restful family trip, on the curated catalog', () => {
  for (const [label, answers] of VARIANTS) {
    it(`never puts first a place whose own card says it is not what a restful trip is for (${label})`, () => {
      const list = buildAdvisorShortlist({ answers, catalog, catalogVersion: 'test', now: NOW });
      expect(list.picks.length).toBeGreaterThan(0);
      const top = list.picks[0]!;
      expect(top.tradeoffs.join(' '), top.name).not.toMatch(RESTFUL_CATCH);
      /* No primary carries a disqualifier while conflict-free places qualify. */
      const profile = profileFrom(answers);
      for (const pick of list.picks) expect(primaryConflicts(byId(pick.id), profile), pick.name).toEqual([]);
      /* What the card shows is what ranked it: the feel on the card is the vacation factor's own reading. */
      for (const pick of list.picks) {
        const factor = pick.factors.find((entry) => entry.id === 'vacation');
        expect(pick.feel?.basis).toBe(factor?.basis);
      }
    });
  }

  it('answers "Day hikes from a base" with day-hiking places that suit a restful trip', () => {
    const list = buildAdvisorShortlist({ answers: VARIANTS[2]![1], catalog, catalogVersion: 'test', now: NOW });
    for (const pick of list.picks) {
      expect(pick.feel?.value ?? 0, pick.name).toBeGreaterThanOrEqual(0.75);
      expect(byId(pick.id).experiences.day_hiking ?? 0, pick.name).toBeGreaterThanOrEqual(2);
    }
  });

  it('still shows a trek-built place lower down, with its conflict stated first', () => {
    const ranking = rankCatalog(mountains, catalog);
    const conflicted = ranking.ranked.find((scored) => scored.conflicts.length > 0);
    expect(conflicted).toBeDefined();
    const scored = scoreDestination(conflicted!.destination, ranking.profile);
    expect(scored.conflicts[0]!.sentence).toMatch(RESTFUL_CATCH);
  });
});

describe('no over-correction', () => {
  it('a trekking request still leads with trekking regions', () => {
    const answers = parseTravelRequest('Two weeks of multi-day trekking, hut to hut, in the high mountains in September.', base(), NOW).answers;
    const list = buildAdvisorShortlist({ answers, catalog, catalogVersion: 'test', now: NOW });
    const top = byId(list.picks[0]!.id);
    expect(top.experiences.multi_day_trekking ?? 0).toBeGreaterThanOrEqual(2);
    for (const pick of list.picks) expect(pick.tradeoffs.join(' ')).not.toMatch(RESTFUL_CATCH);
  });
});
