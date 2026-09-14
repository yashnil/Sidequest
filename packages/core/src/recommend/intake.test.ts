import { describe, expect, it } from 'vitest';
import {
  INTAKE_QUESTIONS,
  INTAKE_QUESTION_IDS,
  INTAKE_SIGNAL_FLOOR,
  intakeAnswered,
  intakeQueue,
  intakeReady,
  intakeSettled,
  intakeSignal,
  intakeUnderstanding,
  intakeWeight,
  nextIntakeQuestion,
} from './intake';
import { RANK_DIMENSIONS, RANK_WEIGHTS } from '../schemas/shortlist';
import { emptyComposerAnswers, type TripComposerAnswers } from '../schemas/composer';

const NOW = new Date('2026-09-13T00:00:00Z');

function blank(): TripComposerAnswers {
  return emptyComposerAnswers('help_me_decide', NOW);
}

describe('the intake ladder', () => {
  it('names every question exactly once and every question feeds a dimension the ranker measures', () => {
    expect(INTAKE_QUESTIONS.map((question) => question.id).sort()).toEqual([...INTAKE_QUESTION_IDS].sort());
    expect(new Set(INTAKE_QUESTIONS.map((question) => question.id)).size).toBe(INTAKE_QUESTIONS.length);
    for (const question of INTAKE_QUESTIONS) {
      expect(question.feeds.length).toBeGreaterThan(0);
      for (const dimension of question.feeds) expect(RANK_DIMENSIONS).toContain(dimension);
    }
  });

  it('opens with when, because nothing can be ranked against no month', () => {
    expect(nextIntakeQuestion(blank())?.id).toBe('when');
  });

  it('asks the essentials before anything heavier, then descends by nominal weight', () => {
    const queue = intakeQueue(blank());
    expect(queue.slice(0, 2).map((question) => question.id)).toEqual(['when', 'priorities']);
    const rest = queue.slice(2);
    for (let index = 1; index < rest.length; index += 1) {
      expect(intakeWeight(rest[index - 1]!)).toBeGreaterThanOrEqual(intakeWeight(rest[index]!) - 1e-9);
    }
  });

  it('weighs a question by the rank weights it unlocks, counting a repeated dimension once', () => {
    const when = INTAKE_QUESTIONS.find((question) => question.id === 'when')!;
    expect(intakeWeight(when)).toBeCloseTo(
      RANK_WEIGHTS.climateFit + RANK_WEIGHTS.daylightFit + RANK_WEIGHTS.crowdFit,
      10,
    );
  });

  it('stops asking a question that was answered, and one that was passed over', () => {
    const answered: TripComposerAnswers = { ...blank(), dates: { mode: 'month', month: 8, wantsRecommendation: false } };
    expect(intakeAnswered('when', answered)).toBe(true);
    expect(nextIntakeQuestion(answered)?.id).toBe('priorities');

    const skipped: TripComposerAnswers = { ...blank(), skipped: ['intake:when'] };
    expect(intakeAnswered('when', skipped)).toBe(false);
    expect(intakeSettled('when', skipped)).toBe(true);
    expect(nextIntakeQuestion(skipped)?.id).toBe('priorities');
  });

  it('does not read the schema default party as an answer', () => {
    expect(intakeAnswered('party', blank())).toBe(false);
    expect(intakeAnswered('party', { ...blank(), adults: 4 })).toBe(true);
    expect(intakeAnswered('party', { ...blank(), children: 1 })).toBe(true);
  });

  it('will not rank on an essential nobody answered, however much else was said', () => {
    const noThemes: TripComposerAnswers = {
      ...blank(),
      dates: { mode: 'month', month: 8, wantsRecommendation: false },
      duration: { mode: 'fixed', nights: 10, wantsRecommendation: false },
      origin: 'San Francisco',
      flightTolerance: 'long',
      climatePreference: 'warm',
      crowdTolerance: 'avoid',
      transport: 'drive',
      shape: 'circuit',
      lodgingComfort: 'simple',
      surpriseAppetite: 'surprise_me',
      tripScope: 'international',
      budgetPerPerson: 2500,
    };
    expect(intakeSignal(noThemes)).toBeGreaterThan(INTAKE_SIGNAL_FLOOR);
    expect(intakeReady(noThemes)).toBe(false);
    expect(intakeReady({ ...noThemes, themes: ['outdoors'] })).toBe(true);
  });

  it('reaches ready on the questions a traveller would actually answer first', () => {
    const early: TripComposerAnswers = {
      ...blank(),
      dates: { mode: 'month', month: 8, wantsRecommendation: false },
      themes: ['outdoors', 'mountains'],
      duration: { mode: 'fixed', nights: 10, wantsRecommendation: false },
      origin: 'San Francisco',
    };
    expect(intakeReady(early)).toBe(true);
  });

  it('never reports more signal than the whole weight table', () => {
    const everything: TripComposerAnswers = {
      ...blank(),
      dates: { mode: 'month', month: 8, wantsRecommendation: false },
      duration: { mode: 'fixed', nights: 10, wantsRecommendation: false },
      themes: ['outdoors'],
      origin: 'San Francisco',
      adults: 4,
      budgetPerPerson: 2500,
      outdoorIntensity: 'strenuous',
      climatePreference: 'cold',
      flightTolerance: 'long',
      tripScope: 'international',
      crowdTolerance: 'avoid',
      transport: 'mixed',
      shape: 'circuit',
      lodgingComfort: 'simple',
      visited: ['Iceland'],
      surpriseAppetite: 'surprise_me',
      avoid: 'nowhere very hot',
    };
    expect(intakeQueue(everything)).toHaveLength(0);
    expect(nextIntakeQuestion(everything)).toBeNull();
    expect(intakeSignal(everything)).toBeLessThanOrEqual(1);
    expect(intakeSignal(everything)).toBeGreaterThan(0.9);
  });
});

describe('what Sidequest understands', () => {
  it('says nothing nobody said, except the party, which is marked as an assumption', () => {
    const lines = intakeUnderstanding(blank());
    expect(lines.map((line) => line.id)).toEqual(['party']);
    expect(lines[0]!.assumed).toBe(true);
    expect(lines[0]!.value).toBe('2 travellers');
  });

  it('stops calling the party an assumption once somebody says who is going', () => {
    const lines = intakeUnderstanding({ ...blank(), adults: 4 });
    const party = lines.find((line) => line.id === 'party')!;
    expect(party.assumed).toBe(false);
    expect(party.value).toBe('4 travellers');
  });

  it('states whether a budget figure was meant to cover getting there', () => {
    const included = intakeUnderstanding({ ...blank(), budgetPerPerson: 2500, budgetIncludesFlights: true });
    expect(included.find((line) => line.id === 'budget')!.value).toContain('flights included');
    const excluded = intakeUnderstanding({ ...blank(), budgetPerPerson: 2500, budgetIncludesFlights: false });
    expect(excluded.find((line) => line.id === 'budget')!.value).toContain('before flights');
    const silent = intakeUnderstanding({ ...blank(), budgetPerPerson: 2500 });
    expect(silent.find((line) => line.id === 'budget')!.value).toBe('2,500 per person');
  });

  it('every line points back at a question that exists', () => {
    const lines = intakeUnderstanding({
      ...blank(),
      dates: { mode: 'month', month: 12, wantsRecommendation: false },
      themes: ['outdoors', 'wildlife'],
      duration: { mode: 'range', minNights: 8, maxNights: 12, wantsRecommendation: false },
      origin: 'San Francisco',
      adults: 4,
      surpriseAppetite: 'surprise_me',
    });
    for (const line of lines) expect(INTAKE_QUESTION_IDS).toContain(line.id);
    expect(lines.find((line) => line.id === 'when')!.value).toBe('December');
    expect(lines.find((line) => line.id === 'length')!.value).toBe('8–12 nights');
  });
});
