import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  answerAdvisorQuestion,
  buildAdvisorShortlist,
  emptyComposerAnswers,
  nextQuestion,
  parseTravelRequest,
  type AdvisorShortlist,
  type Atlas,
  type Destination,
  type Experience,
  type TripComposerAnswers,
} from '@sidequest/core';
/* Not part of the package surface; the same reading the card's "one base in …" uses. */
import { staysNeeded } from '../../core/src/advisor/concept';
import { loadAtlas, resetAtlasForTests } from './load';

/**
 * THE PRIMARY INTENT, ON THE ATLAS THAT SHIPS.
 *
 * Requests never used to tune the advisor, answered the way a careless
 * traveller would — every interview question with its first option, which is
 * how a staging run turned "a nice retreat with my family … outdoors stuff"
 * into "mountains and trekking". Assertions are properties of the picks (what
 * they offer, how hard they are, who they suit) and of what the shortlist says
 * it was ranked on — never a destination name.
 */

vi.setConfig({ testTimeout: 180_000, hookTimeout: 120_000 });

const NOW = new Date('2026-11-08T12:00:00Z');
let atlas: Atlas;

beforeAll(() => {
  resetAtlasForTests();
  const loaded = loadAtlas({ now: NOW });
  if (!loaded) throw new Error('packages/atlas/data/atlas.json.gz is missing — build it (packages/atlas/README.md)');
  atlas = loaded.atlas;
});

interface Answered {
  shortlist: AdvisorShortlist;
  picks: Destination[];
  asked: string[];
  firstOffered: Record<string, string>;
}

/** Parse, then (optionally) take every question's first option until the interview stops — the least thoughtful traveller. */
function ask(text: string, firstOptions = true): Answered {
  const base = { ...emptyComposerAnswers('help_me_decide', NOW), dates: { mode: 'month' as const, wantsRecommendation: false } };
  let answers: TripComposerAnswers = parseTravelRequest(text, base, NOW, atlas).answers;
  const asked: string[] = [];
  const firstOffered: Record<string, string> = {};
  for (let step = 0; firstOptions && step < 12; step += 1) {
    const next = nextQuestion(answers, atlas);
    if (!next.question) break;
    const first = next.question.options(answers)[0]!;
    asked.push(next.question.id);
    firstOffered[next.question.id] = first.id;
    answers = answerAdvisorQuestion(answers, next.question.id, [first.id]);
  }
  const shortlist = buildAdvisorShortlist({ answers, catalog: atlas, catalogVersion: atlas.version, now: NOW });
  return { shortlist, picks: shortlist.picks.map((pick) => atlas.byId(pick.id)!), asked, firstOffered };
}

const offers = (destination: Destination, experiences: readonly Experience[], min = 2) => experiences.some((experience) => (destination.experiences[experience] ?? 0) >= min);
/** Built around high, hard mountain days or multi-day treks: the red flags for a restful or young-family trip. */
const strenuousLed = (destination: Destination) =>
  destination.challenge.typical >= 2 && ((destination.experiences.high_mountains ?? 0) >= 2.5 || (destination.experiences.multi_day_trekking ?? 0) >= 2.5);
const RESTORATIVE: Experience[] = ['hot_springs_wellness', 'lakes', 'beaches_swimming', 'coastal_scenery'];
const names = (picks: readonly Destination[]) => picks.map((pick) => pick.name).join(', ');

describe('relaxation and wellness', () => {
  for (const firstOptions of [false, true]) {
    it(`a burnt-out request for hot springs and gentle walks gets restorative, easy places${firstOptions ? ' (first options)' : ''}`, () => {
      const { shortlist, picks } = ask('Need to unwind after a burnt-out year. Somewhere peaceful with hot springs or a spa and gentle walks, two weeks in October.', firstOptions);
      expect(picks.length).toBe(3);
      for (const pick of picks) {
        expect(offers(pick, RESTORATIVE), pick.name).toBe(true);
        expect(pick.challenge.easiest, pick.name).toBeLessThanOrEqual(1);
        expect(strenuousLed(pick), pick.name).toBe(false);
      }
      expect(picks.filter((pick) => offers(pick, ['hot_springs_wellness'])).length, names(picks)).toBeGreaterThanOrEqual(2);
      expect(shortlist.readout.drivers[0]).toMatch(/^The kind of trip: rest and restoration/);
    });

    it(`a slow, restful week by the water stays by the water and easy${firstOptions ? ' (first options)' : ''}`, () => {
      const { shortlist, picks } = ask('A slow, restful week by the water in June - swimming, reading, maybe a massage. Nothing strenuous.', firstOptions);
      expect(picks.length).toBe(3);
      for (const pick of picks) {
        expect(offers(pick, ['beaches_swimming', 'lakes', 'hot_springs_wellness']), pick.name).toBe(true);
        expect(pick.challenge.typical, pick.name).toBeLessThanOrEqual(1);
      }
      expect(shortlist.readout.drivers[0]).toMatch(/^The kind of trip/);
    });
  }
});

describe('families', () => {
  for (const firstOptions of [false, true]) {
    it(`young children and "outdoors and nature" get easy, child-suitable nature${firstOptions ? ' (first options)' : ''}`, () => {
      const { shortlist, picks } = ask('Family holiday with two kids aged 5 and 8 in July, outdoors and nature, nothing too hard.', firstOptions);
      expect(picks.length).toBe(3);
      for (const pick of picks) {
        expect(pick.family ?? 0, pick.name).toBeGreaterThanOrEqual(2);
        expect(pick.challenge.typical, pick.name).toBeLessThanOrEqual(1);
        expect(strenuousLed(pick), pick.name).toBe(false);
      }
      expect(shortlist.readout.drivers).toContain('Travelling with children');
      expect(shortlist.readout.drivers[0]).toMatch(/^The kind of trip: family time/);
    });
  }

  it('children, warmth, beaches and animals get child-suitable beach or wildlife places', () => {
    const { picks } = ask('February half-term with our children (7 and 10), somewhere warm with beaches and animals.', false);
    expect(picks.length).toBe(3);
    for (const pick of picks) {
      expect(pick.family ?? 0, pick.name).toBeGreaterThanOrEqual(2);
      expect(offers(pick, ['beaches_swimming', 'wildlife_general', 'marine_wildlife', 'big_game_safari']), pick.name).toBe(true);
      expect(strenuousLed(pick), pick.name).toBe(false);
    }
  });

  it('a restful family retreat with "outdoors stuff" is never turned into mountains and trekking by the interview', () => {
    const { shortlist, picks, asked, firstOffered } = ask(
      'Thinking about a getaway with my family in late April. Somewhere tranquil, we have all been worn out lately. Some outdoors stuff would be good.',
    );
    /* The kind of trip already said what it is about; if the activity question comes at all, mountains is not what it offers first. */
    if (asked.includes('focus')) expect(firstOffered.focus).not.toBe('mountains');
    expect(shortlist.readout.drivers[0]).toMatch(/^The kind of trip: rest and restoration/);
    expect(shortlist.readout.drivers.join(' | ')).not.toMatch(/mountains and trekking/);
    expect(picks.length).toBe(3);
    for (const pick of picks) {
      expect(offers(pick, RESTORATIVE), pick.name).toBe(true);
      expect(strenuousLed(pick), pick.name).toBe(false);
      expect(pick.challenge.typical, pick.name).toBeLessThanOrEqual(1);
      expect(pick.family ?? 3, pick.name).toBeGreaterThanOrEqual(2);
      /* Red flag: a multi-base road trip. */
      expect(staysNeeded(pick), pick.name).toBeLessThanOrEqual(2);
    }
    /* The card's signature names what carries the trip, not peaks or treks. */
    for (const pick of shortlist.picks) expect(pick.signature ?? '', pick.name).not.toMatch(/high mountains|multi-day trekking/);
  });
});

describe('adventure is still adventure', () => {
  for (const firstOptions of [false, true]) {
    it(`serious multi-day trekking at altitude still gets trekking and high mountains${firstOptions ? ' (first options)' : ''}`, () => {
      const { shortlist, picks } = ask('Serious multi-day trekking at altitude in October, three weeks, happy to camp.', firstOptions);
      expect(picks.length).toBe(3);
      for (const pick of picks) expect(offers(pick, ['multi_day_trekking', 'high_mountains']), pick.name).toBe(true);
      expect(picks.filter((pick) => (pick.experiences.multi_day_trekking ?? 0) >= 2).length, names(picks)).toBeGreaterThanOrEqual(2);
      expect(picks.reduce((sum, pick) => sum + pick.challenge.typical, 0) / picks.length, names(picks)).toBeGreaterThanOrEqual(1.5);
      expect(shortlist.readout.drivers[0]).toMatch(/^What you want to do: mountains/);
    });
  }

  it('rafting, canyoning and volcano hikes stay active and outdoors', () => {
    const { picks } = ask('Adventurous trip in August: white-water rafting, canyoning and volcano hikes, rugged and remote.', false);
    expect(picks.length).toBe(3);
    for (const pick of picks) expect(offers(pick, ['day_hiking', 'volcanoes_geothermal', 'paddling_boating']), pick.name).toBe(true);
    expect(picks.some((pick) => pick.challenge.typical >= 2), names(picks)).toBe(true);
  });

  it('hut-to-hut with teenagers is still a trek: a family is not a reason to drop what was asked', () => {
    const { picks } = ask('Hut-to-hut hiking in July with our teenagers, aged 15 and 17.', false);
    expect(picks.length).toBe(3);
    for (const pick of picks) expect(pick.experiences.multi_day_trekking ?? 0, pick.name).toBeGreaterThanOrEqual(2);
  });
});

describe('culture', () => {
  it('temples, history and food get culture-and-food places, ranked on what was asked', () => {
    const { shortlist, picks } = ask('Ancient temples, history and great food for 10 days in November.', false);
    expect(picks.length).toBe(3);
    for (const pick of picks) {
      expect(pick.experiences.villages_culture ?? 0, pick.name).toBeGreaterThanOrEqual(2);
      expect(offers(pick, ['food', 'city_life']), pick.name).toBe(true);
    }
    expect(shortlist.readout.drivers[0]).toMatch(/^What you want to do: culture and food/);
  });

  it('museums, architecture and old towns by train get culture without a car', () => {
    const { shortlist, picks } = ask('Museums, architecture and old towns in May, travelling by train.', false);
    expect(picks.length).toBe(3);
    for (const pick of picks) {
      expect(offers(pick, ['villages_culture', 'city_life']), pick.name).toBe(true);
      expect(pick.access.car, pick.name).not.toBe('essential');
    }
    expect(shortlist.readout.drivers).toContain('No car needed');
  });
});
