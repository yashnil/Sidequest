import { describe, expect, it } from 'vitest';
import { defaultAnswers, buildTravelerProfile } from '../questionnaire/transform';
import { interestOfferFromEntityType } from '../interests/offer';
import type { QuestionnaireAnswers } from '../schemas/profile';
import { INTERVIEW_QUESTIONS, interviewCatalog, type InterviewContext } from './catalog';
import { answerQuestion, withScreening } from './state';
import { screenDestination } from './traits';
import { buildTravelerBrief, renderTravelerBriefXml, type TravelerBriefTripFacts } from './brief';

/**
 * QUALITY V1 — every impact-bearing questionnaire field reaches the
 * composition call, or is listed here as intentionally not part of it.
 *
 * The brief is the only thing the model reads about the traveller, so a
 * question whose answer changes nothing in it is a question the interview
 * should not ask. This test answers every catalog question with a value
 * other than its default and asserts the rendered brief changes.
 */
const NOW = new Date('2026-09-04T10:00:00Z');

/**
 * Questions whose answers are consumed elsewhere than the composition call,
 * on purpose, with the consumer named. Anything not on this list must move
 * the brief.
 */
const NOT_FOR_COMPOSITION: Record<string, string> = {
  group_notes: 'untrusted payload (travellerOwnWords.groupNotes) — the traveller\'s own words are never rendered inside the brief',
  weather_avoidances: 'weather layer and reconcile (extreme heat/cold avoidances) — surfaces in <avoid> only when it maps to an avoidance code',
  special_meals: 'derived food.specialMealBudget — already expressed by food_tradeoff\'s sentence when the style is unchanged',
};

function contextFor(): InterviewContext {
  const destination = screenDestination({ name: 'Green Isle', proseName: 'the island', tripDays: 8, entityType: 'country', breadth: 'country', population: 5_100_000, bounds: { southWest: { lat: 51.4, lng: -10.5 }, northEast: { lat: 55.4, lng: -5.4 } }, center: { lat: 53.4, lng: -8 }, startDate: '2026-05-10', climate: { high: 15, low: 6 }, scopeTransport: { primaryMode: 'drive', allowedModes: ['drive', 'rail', 'public_bus', 'ferry'], carAvailable: null } });
  const offer = interestOfferFromEntityType('country');
  return { destination, traveller: { travelerNeeds: [], tripDays: 8, adults: 2, children: 0, offeredInterests: offer.interests, carried: [] } };
}

const TRIP: TravelerBriefTripFacts = { destination: 'Green Isle', nights: 7, days: 8, startDate: '2026-05-10', endDate: '2026-05-17', adults: 2, children: 0, arrival: 'in the afternoon', departure: 'in the morning', bookedFacts: [] };

function briefFor(answers: QuestionnaireAnswers): string {
  const profile = buildTravelerProfile(answers, { travelerNeeds: [], tripDays: 8 });
  return renderTravelerBriefXml(buildTravelerBrief({ profile, trip: TRIP }));
}

/** A value for this question that differs from what the answers already hold. */
function alternativeValue(question: (typeof INTERVIEW_QUESTIONS)[number], ctx: InterviewContext, answers: QuestionnaireAnswers): unknown {
  const current = question.read(answers);
  switch (question.id) {
    case 'priorities':
      return ['wildlife', 'markets_and_street_food'];
    case 'names':
      return { include: ['Cliffs of the Ninth'], avoid: ['Tourist Trap Tower'] };
    case 'hard_constraints':
      return { constraints: [{ code: 'no_boats' }], notes: '', notesAreHard: false };
    case 'dietary':
      return { needs: ['vegan'], strict: true };
    case 'budget':
      return { style: 'luxury', envelope: { amount: 9000, currency: 'USD', basis: 'per_person_total' } };
    case 'group_notes':
      return 'One of us hates early starts.';
    case 'weather_avoidances':
      return ['extreme_heat'];
    default: {
      const options = question.options?.(ctx, answers) ?? [];
      const other = options.find((o) => o.value !== String(current));
      return other?.value ?? (typeof current === 'boolean' ? !current : current);
    }
  }
}

describe('the traveller brief', () => {
  const ctx = contextFor();
  const base = withScreening(defaultAnswers({ travelerNeeds: [], tripDays: 8 }), ctx.destination);
  const baseline = briefFor(base);

  it('renders every section, hard rules first, with assumptions marked', () => {
    for (const tag of ['trip_facts', 'hard_constraints', 'travel_style', 'priorities', 'transport', 'lodging', 'food', 'budget', 'popularity', 'scope', 'sidequest_signals', 'assumptions']) {
      expect(baseline, tag).toContain(`<${tag}>`);
    }
    expect(baseline.indexOf('<hard_constraints>')).toBeLessThan(baseline.indexOf('<travel_style>'));
    expect(baseline).toMatch(/\[assumed\]/);
  });

  for (const question of interviewCatalog(ctx, base)) {
    if (question.presentational) continue;
    it(`${question.id} either changes the brief or is documented as not for composition`, () => {
      const value = alternativeValue(question, ctx, base);
      const next = answerQuestion({ answers: base, ctx, question, value, now: NOW });
      const rendered = briefFor(next);
      if (NOT_FOR_COMPOSITION[question.id]) {
        expect(NOT_FOR_COMPOSITION[question.id]!.length).toBeGreaterThan(10);
        return;
      }
      expect(rendered, `${question.id} = ${JSON.stringify(value)} left the brief unchanged`).not.toEqual(baseline);
    });
  }

  it('an explicit answer loses its [assumed] mark and leaves the assumptions list', () => {
    const question = INTERVIEW_QUESTIONS.find((q) => q.id === 'base_moves')!;
    const next = answerQuestion({ answers: base, ctx, question, value: 'stay_put', now: NOW });
    const rendered = briefFor(next);
    expect(rendered).toMatch(/One base for the whole trip\n/);
    expect(rendered).not.toMatch(/One base for the whole trip \[assumed\]/);
  });

  it('booked facts and must-includes land in hard constraints', () => {
    const profile = buildTravelerProfile(base, { travelerNeeds: [], tripDays: 8 });
    const rendered = renderTravelerBriefXml(buildTravelerBrief({ profile, trip: { ...TRIP, bookedFacts: ['Hotel: Harbour Inn — 2026-05-10 to 2026-05-13.'] }, signals: { mustInclude: ['Cliffs of the Ninth'] } }));
    expect(rendered).toMatch(/<hard_constraints>[\s\S]*Booked: Hotel: Harbour Inn/);
    expect(rendered).toMatch(/Must include: Cliffs of the Ninth/);
  });
});
