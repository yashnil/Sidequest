import { describe, expect, it } from 'vitest';
import { INTAKE_QUESTION_IDS, intakeAnswered, intakeReady } from '@sidequest/core';
import {
  decisionAnswersSchema,
  decisionAnswersToComposer,
  emptyDecisionAnswers,
  type DecisionAnswersInput,
} from './decision-answers';

const NOW = new Date('2026-09-13T00:00:00Z');

/**
 * V11 §A5 — NOTHING THE TRAVELLER SAID IS RE-ASKED.
 *
 * The product requirement is a single sentence — "choosing a recommendation
 * transfers everything, no re-entering information" — and the only structural
 * way to hold it is for the intake to write the *same record* trip setup reads.
 * `adoptDestinationAction` spreads the stored `TripComposerAnswers` into the
 * trip's own composer row, so the whole guarantee reduces to this: every answer
 * the intake collects has to reach `TripComposerAnswers`.
 *
 * A test that listed the fields by hand would pass for ever while somebody added
 * a fifteenth question. So it is driven off `INTAKE_QUESTION_IDS`: a question
 * whose answer does not survive the conversion fails here by name.
 */

const FULL: DecisionAnswersInput = {
  ...emptyDecisionAnswers(),
  dateMode: 'flexible',
  startDate: '2026-12-18',
  endDate: '2027-01-03',
  nights: null,
  minNights: 8,
  maxNights: 12,
  shape: 'circuit',
  transport: 'mixed',
  pace: 'packed',
  themes: ['outdoors', 'wildlife'],
  outdoorIntensity: 'strenuous',
  budget: null,
  adults: 4,
  children: 0,
  avoid: 'nowhere very hot',
  origin: 'San Francisco',
  originCountry: 'us',
  flightTolerance: 'long',
  climatePreference: 'warm',
  lodgingComfort: 'simple',
  tripScope: 'international',
  surpriseAppetite: 'surprise_me',
  crowdTolerance: 'avoid',
  visited: ['Iceland', 'Portugal'],
  budgetPerPerson: 2500,
  budgetIncludesFlights: false,
  travelerNeeds: [],
  skipped: [],
};

describe('what the intake collects reaches the trip', () => {
  it('accepts the whole ladder', () => {
    expect(decisionAnswersSchema.safeParse(FULL).success).toBe(true);
  });

  it('answers every question the ladder can ask', () => {
    const composer = decisionAnswersToComposer(FULL, NOW);
    const unanswered = INTAKE_QUESTION_IDS.filter((id) => !intakeAnswered(id, composer));
    /* `party` is answered by four adults; `visited` by two names; and so on for all seventeen. */
    expect(unanswered).toEqual([]);
    expect(intakeReady(composer)).toBe(true);
  });

  it('carries every V11 recommender field onto the composer record unchanged', () => {
    const composer = decisionAnswersToComposer(FULL, NOW);
    expect(composer.origin).toBe('San Francisco');
    expect(composer.originCountry).toBe('US');
    expect(composer.flightTolerance).toBe('long');
    expect(composer.climatePreference).toBe('warm');
    expect(composer.lodgingComfort).toBe('simple');
    expect(composer.tripScope).toBe('international');
    expect(composer.surpriseAppetite).toBe('surprise_me');
    expect(composer.crowdTolerance).toBe('avoid');
    expect(composer.visited).toEqual(['Iceland', 'Portugal']);
    expect(composer.budgetPerPerson).toBe(2500);
    expect(composer.budgetIncludesFlights).toBe(false);
    expect(composer.adults).toBe(4);
    expect(composer.themes).toEqual(['outdoors', 'wildlife']);
    expect(composer.avoid).toBe('nowhere very hot');
  });

  it('keeps a free window and a trip length as two different facts', () => {
    const composer = decisionAnswersToComposer(FULL, NOW);
    expect(composer.dates.startDate).toBe('2026-12-18');
    expect(composer.dates.endDate).toBe('2027-01-03');
    expect(composer.duration).toEqual({ mode: 'range', minNights: 8, maxNights: 12, wantsRecommendation: false });
  });

  it('asks for a duration rather than inventing one when nobody said', () => {
    const composer = decisionAnswersToComposer({ ...FULL, nights: null, minNights: null, maxNights: null }, NOW);
    expect(composer.duration).toEqual({ mode: 'unknown', wantsRecommendation: true });
  });

  it('drops one bad string rather than the whole intake', () => {
    const composer = decisionAnswersToComposer(
      { ...FULL, themes: ['outdoors', 'nonsense'], travelerNeeds: ['kids_under_12', 'nonsense'] },
      NOW,
    );
    expect(composer.themes).toEqual(['outdoors']);
    expect(composer.travelerNeeds).toEqual(['kids_under_12']);
  });

  it('records a passed-over question so it is never asked twice', () => {
    const composer = decisionAnswersToComposer({ ...FULL, skipped: ['intake:lodging'] }, NOW);
    expect(composer.skipped).toEqual(['intake:lodging']);
  });

  it('a blank intake answers nothing and is not rankable', () => {
    const composer = decisionAnswersToComposer(emptyDecisionAnswers(), NOW);
    expect(intakeReady(composer)).toBe(false);
    expect(intakeAnswered('when', composer)).toBe(false);
    expect(intakeAnswered('priorities', composer)).toBe(false);
  });
});
