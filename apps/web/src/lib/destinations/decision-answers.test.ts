import { describe, expect, it } from 'vitest';
import { emptyComposerAnswers, tripComposerAnswersSchema } from '@sidequest/core';
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
 * `adoptAdvisorPickAction` spreads the stored `TripComposerAnswers` into the
 * trip's own composer row, so the whole guarantee reduces to this: every answer
 * this shape can carry has to reach `TripComposerAnswers`.
 *
 * A test that listed the fields by hand would pass for ever while somebody added
 * a new one. So it is driven off the schema's own keys: a field whose answer
 * does not survive the conversion fails here by name, and so does a field
 * nobody has written a second value for.
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

  /**
   * A second, different, valid value for every field the schema accepts. The
   * conversion is a pure function, so a field has reached the composer record
   * exactly when changing it changes that record.
   */
  const CHANGED: { [K in keyof Required<DecisionAnswersInput>]: DecisionAnswersInput[K] } = {
    dateMode: 'month',
    startDate: '2026-12-20',
    endDate: '2027-01-05',
    month: 7,
    season: 'summer',
    nights: 5,
    minNights: 9,
    maxNights: 13,
    shape: 'one_base',
    transport: 'drive',
    pace: 'slow',
    themes: ['food'],
    outdoorIntensity: 'gentle',
    budget: 'premium',
    adults: 3,
    children: 2,
    avoid: 'long drives',
    origin: 'Lisbon',
    originCountry: 'pt',
    flightTolerance: 'short',
    climatePreference: 'cold',
    lodgingComfort: 'refined',
    tripScope: 'domestic',
    surpriseAppetite: 'familiar',
    crowdTolerance: 'unbothered',
    visited: ['Norway'],
    budgetPerPerson: 4000,
    budgetIncludesFlights: true,
    travelerNeeds: ['kids_under_12'],
    skipped: ['intake:lodging'],
  };

  it('has a second value for every field the schema accepts', () => {
    expect(Object.keys(CHANGED).sort()).toEqual(Object.keys(decisionAnswersSchema.shape).sort());
  });

  it.each(Object.keys(decisionAnswersSchema.shape) as (keyof DecisionAnswersInput)[])(
    'carries %s onto the composer record',
    (field) => {
      const changed = { ...FULL, [field]: CHANGED[field] } as DecisionAnswersInput;
      expect(decisionAnswersSchema.safeParse(changed).success, `${field}: the second value is not valid input`).toBe(true);
      expect(changed[field], `${field}: the second value is the first one`).not.toEqual(FULL[field]);
      expect(decisionAnswersToComposer(changed, NOW), `${field} is collected and then dropped`).not.toEqual(
        decisionAnswersToComposer(FULL, NOW),
      );
    },
  );

  it('writes a record the stored-answers schema reads back unchanged', () => {
    // The decision session stores this and re-reads it strictly on every load:
    // a conversion that produced something the schema refuses would be a
    // session nobody could open.
    for (const input of [FULL, emptyDecisionAnswers()]) {
      const composer = decisionAnswersToComposer(input, NOW);
      const parsed = tripComposerAnswersSchema.safeParse(JSON.parse(JSON.stringify(composer)));
      expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues)).toBe(true);
      expect(parsed.data).toEqual(composer);
    }
  });

  it('is always a help-me-decide record with no destination, whatever was collected', () => {
    const composer = decisionAnswersToComposer(FULL, NOW);
    expect(composer.mode).toBe('help_me_decide');
    expect(composer.destination).toBeUndefined();
    expect(composer.destinationQuery).toBeUndefined();
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

  it('a blank intake says nothing the traveller did not', () => {
    const composer = decisionAnswersToComposer(emptyDecisionAnswers(), NOW);
    const untouched = emptyComposerAnswers('help_me_decide', NOW);

    // No window, no length, no interests: the three things a ranking needs
    // first are all still open, so nothing downstream can mistake a default
    // for an answer.
    expect(composer.dates).toEqual({ mode: 'month', year: 2026, wantsRecommendation: false });
    expect(composer.duration).toEqual({ mode: 'unknown', wantsRecommendation: true });
    expect(composer.themes).toEqual([]);
    expect(composer.travelerNeeds).toEqual([]);
    expect(composer.skipped).toEqual([]);

    // And every preference is absent rather than defaulted.
    for (const field of [
      'shape',
      'transport',
      'pace',
      'budget',
      'outdoorIntensity',
      'avoid',
      'origin',
      'originCountry',
      'flightTolerance',
      'climatePreference',
      'lodgingComfort',
      'tripScope',
      'surpriseAppetite',
      'crowdTolerance',
      'visited',
      'budgetPerPerson',
      'budgetIncludesFlights',
    ] as const) {
      expect(composer[field], `${field} was invented`).toEqual(untouched[field]);
      expect(composer[field], `${field} was invented`).toBeUndefined();
    }
  });
});
