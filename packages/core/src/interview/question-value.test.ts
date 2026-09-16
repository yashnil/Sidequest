import { describe, expect, it } from 'vitest';
import { interestOfferFromEntityType } from '../interests/offer';
import { defaultAnswers } from '../questionnaire/transform';
import type { QuestionnaireAnswers } from '../schemas/profile';
import { INTERVIEW_QUESTIONS, OPERATING_MODE_QUESTIONS, interviewCatalog, type InterviewContext, type QuestionDefinition } from './catalog';
import { PLANNING_IMPACT_CONSUMERS, isPlanningImpactKey } from './impact';
import { assessSufficiency } from './sufficiency';
import { planInterview } from './selector';
import { withScreening } from './state';
import { screenDestination } from './traits';

/**
 * V12.1 §28 §29 — A QUESTION HAS TO BE ABLE TO CHANGE SOMETHING, AND THE
 * INTERVIEW HAS TO KNOW WHEN TO STOP.
 *
 * §28: *"Every adaptive question must declare what decision it can change… If
 * [the] answer cannot affect composition, operating model, chapter model,
 * budget, mobility, lodging, food [or] readiness, do not ask it."*
 *
 * The catalog has declared `impacts` since MVP V3 and `interview.test.ts`
 * already checks every question names at least one. What that could not check is
 * the thing §28 is actually about: **does answering it change the answers**. A
 * question can name four impacts and have an `apply` that returns `{}`, and the
 * declaration would be a comment.
 *
 * So this exercises every option of every operating-mode question against a real
 * answers record and requires the result to differ from what went in. It is the
 * cheapest possible proof that a screen is worth the traveller's time.
 */

function context(days = 10): InterviewContext {
  const destination = screenDestination({
    name: 'High Cordillera',
    tripDays: days,
    entityType: 'protected_area',
    breadth: 'region',
    featureType: 'national_park',
    center: { lat: -13.5, lng: -71.97 },
    semantic: { type: 'mountain_region', scale: 'region' },
    compiled: { placeCount: 40, maxElevationMetres: 3400 },
  });
  const offer = interestOfferFromEntityType('protected_area');
  return { destination, traveller: { travelerNeeds: [], tripDays: days, adults: 2, children: 0, offeredInterests: offer.interests, carried: [] } };
}

function answersFor(ctx: InterviewContext): QuestionnaireAnswers {
  return withScreening(defaultAnswers({ travelerNeeds: [], tripDays: ctx.traveller.tripDays }), ctx.destination);
}

/** Keys on the answers record that the given patch actually moves. */
function changedKeys(before: QuestionnaireAnswers, patch: Partial<QuestionnaireAnswers>): string[] {
  return Object.entries(patch)
    .filter(([key, value]) => JSON.stringify((before as Record<string, unknown>)[key]) !== JSON.stringify(value))
    .map(([key]) => key);
}

describe('every question earns its screen', () => {
  const ctx = context();
  const answers = answersFor(ctx);

  it('declares at least one impact, and every impact names a real downstream reader', () => {
    for (const question of interviewCatalog(ctx, answers)) {
      expect(question.impacts.length, `${question.id} declares no impact`).toBeGreaterThan(0);
      for (const impact of question.impacts) {
        expect(isPlanningImpactKey(impact), `${question.id} declares an unknown impact "${impact}"`).toBe(true);
        expect(PLANNING_IMPACT_CONSUMERS[impact], `${impact} has no named consumer`).toBeTruthy();
      }
    }
  });

  it('changes at least one stored answer for at least one of its options', () => {
    /*
     * The check §28 is really asking for. A declaration is a claim; this is the
     * evidence. Presentational questions are exempt and there are none today —
     * the assertion below keeps it that way.
     */
    for (const question of interviewCatalog(ctx, answers) as QuestionDefinition[]) {
      if (question.presentational) continue;
      /*
       * Single-answer questions only. A multi-select takes an *array* of values,
       * so feeding it one option is feeding it a malformed answer, and the
       * "nothing changed" that comes back would be a fact about this test rather
       * than about the question.
       */
      if (question.kind !== 'single' && question.kind !== 'scenario') continue;
      const options = question.options?.(ctx, answers) ?? [];
      if (options.length === 0) continue;
      const moved = options.some((option) => changedKeys(answers, question.apply(option.value, answers, ctx)).length > 0);
      expect(moved, `${question.id} has options but none of them changes an answer`).toBe(true);
    }
  });

  it('has no presentational questions hiding behind the exemption', () => {
    expect(INTERVIEW_QUESTIONS.filter((question) => question.presentational)).toHaveLength(0);
  });
});

describe('the trip-type questions specifically', () => {
  const ctx = context();
  const answers = answersFor(ctx);

  it('every option of every one of them moves a real field', () => {
    for (const question of OPERATING_MODE_QUESTIONS) {
      const options = question.options?.(ctx, answers) ?? [];
      expect(options.length, `${question.id} offers nothing`).toBeGreaterThan(1);
      for (const option of options) {
        const patch = question.apply(option.value, answers, ctx);
        expect(Object.keys(patch).length, `${question.id} / ${option.value} writes nothing`).toBeGreaterThan(0);
      }
      /* And at least one option genuinely differs from the default state. */
      expect(options.some((option) => changedKeys(answers, question.apply(option.value, answers, ctx)).length > 0), `${question.id} never changes anything`).toBe(true);
    }
  });

  it('offers a smart default that is one of its own options', () => {
    for (const question of OPERATING_MODE_QUESTIONS) {
      const values = new Set((question.options?.(ctx, answers) ?? []).map((option) => option.value));
      const fallback = question.smartDefault(ctx, answers);
      expect(values.has(String(fallback.value)), `${question.id}: "${String(fallback.value)}" is not one of its options`).toBe(true);
      expect(fallback.reason.length).toBeGreaterThan(0);
    }
  });

  it('is silent until the traveller has said what the trip is for', () => {
    /* §29 from the other side: no stated priority means no family, and no family means no family question. */
    for (const question of OPERATING_MODE_QUESTIONS) {
      expect(question.relevance(ctx, answers), `${question.id} fired on a blank interview`).toBe(0);
    }
  });
});

describe('the stop condition', () => {
  const ctx = context();

  it('does not add a critical unknown that the traveller cannot be expected to answer yet', () => {
    /* A blank interview is already sufficient or one question short — never a wall of trip-type questions. */
    const plan = planInterview({ ctx, answers: answersFor(ctx) });
    const sufficiency = assessSufficiency(plan);
    if (sufficiency.kind === 'several') {
      for (const unknown of sufficiency.unknowns) {
        expect(OPERATING_MODE_QUESTIONS.map((question) => question.id), `${unknown.id} blocks a blank interview`).not.toContain(unknown.id);
      }
    }
  });

  it('keeps the walked interview short even when a family is confidently diagnosed', () => {
    const base = answersFor(ctx);
    const trek = {
      ...base,
      interests: { ...base.interests, hiking: 'core' as const },
      interestRoles: { hiking: 'build_around' as const },
      dailyIntensity: 'intense' as const,
      rusticLodgingOk: true,
      willDrive: false,
      provenance: { ...base.provenance, priorities: { source: 'explicit' as const, strength: 'strong' as const, confidence: 1 }, priority_roles: { source: 'explicit' as const, strength: 'strong' as const, confidence: 1 } },
    };
    const plan = planInterview({ ctx, answers: trek });
    const bank = new Set(OPERATING_MODE_QUESTIONS.map((question) => question.id));
    const asked = plan.shown.filter((id) => bank.has(id));
    expect(asked.length).toBeGreaterThan(0);
    /* `OPERATING_BUDGET`. The rest wait behind "Personalize it more" rather than becoming a screen of their own. */
    expect(asked.length).toBeLessThanOrEqual(2);
  });
});
