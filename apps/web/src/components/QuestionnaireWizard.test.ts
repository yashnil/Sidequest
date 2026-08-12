import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  INTERESTS,
  MAX_DECISION_QUESTIONS,
  decisionQuestionsFor,
  defaultAnswers,
  interestOfferFromEntityType,
  type AccessDataset,
  type AccessRule,
  type Place,
  type QuestionnaireAnswers,
  type QuestionnaireContext,
  type QuestionnaireStepId,
  type RegionDecisionQuestionRecord,
} from '@sidequest/core';
import { QuestionnaireWizard } from './QuestionnaireWizard';

/**
 * THE ENGINE WAS BUILT AND THE SCREEN NEVER READ IT.
 *
 * Two release blockers, one shape: a compiled destination knows which interests
 * it can honestly be graded on and which follow-ups its own geography justifies,
 * and the questionnaire rendered neither. A traveller planning Tokyo was graded
 * on scenic drives, geothermal ground, hot springs and stargazing — with no row
 * at all for museums, architecture, neighbourhoods or markets — and no compiled
 * region ever produced a Stage B question on screen.
 *
 * These assertions are about the wiring, not the engine. `interests/offer.ts`
 * and `interests/decisions.ts` are tested where they live; what is tested here
 * is that their answers reach a control a traveller can actually touch. Every
 * assertion below fails against the version that shipped.
 */

const CITY_OFFER = interestOfferFromEntityType('city');
const PARK_OFFER = interestOfferFromEntityType('protected_area');

function context(overrides: Partial<QuestionnaireContext> = {}): QuestionnaireContext {
  return { travelerNeeds: [], tripDays: 5, ...overrides };
}

function render(input: {
  context: QuestionnaireContext;
  answers?: QuestionnaireAnswers;
  step?: QuestionnaireStepId;
  decisionQuestions?: readonly RegionDecisionQuestionRecord[];
}): string {
  return renderToStaticMarkup(
    createElement(QuestionnaireWizard, {
      tripId: 'trip-1',
      context: input.context,
      initialAnswers: input.answers ?? defaultAnswers(input.context),
      ...(input.step ? { initialStepId: input.step } : {}),
      ...(input.decisionQuestions ? { decisionQuestions: input.decisionQuestions } : {}),
    }),
  );
}

/** The radio group for one interest, which is what a graded row *is*. */
function hasRow(markup: string, interest: string): boolean {
  return markup.includes(`name="interest-${interest}"`);
}

function rowCount(markup: string): number {
  return INTERESTS.filter((interest) => hasRow(markup, interest)).length;
}

describe('the interest rows follow the destination', () => {
  it('offers a city traveller the built and inhabited rows, and not the valley ones', () => {
    const markup = render({ context: context({ offeredInterests: CITY_OFFER.interests }) });

    for (const urban of [
      'museums_and_galleries',
      'architecture_and_landmarks',
      'neighbourhoods_and_local_life',
      'markets_and_street_food',
    ]) {
      expect(hasRow(markup, urban), `a city traveller must be able to grade ${urban}`).toBe(true);
    }
    for (const valley of ['scenic_drives', 'geology_and_geothermal', 'hot_springs', 'stargazing']) {
      expect(hasRow(markup, valley), `a city traveller must not be graded on ${valley}`).toBe(false);
    }
    // Fewer questions, not merely different ones. §6.1's burden half.
    expect(rowCount(markup)).toBeLessThan(INTERESTS.length);
  });

  it('offers a mountain destination the outdoor rows instead', () => {
    const markup = render({ context: context({ offeredInterests: PARK_OFFER.interests }) });
    expect(hasRow(markup, 'hiking')).toBe(true);
    expect(hasRow(markup, 'museums_and_galleries')).toBe(false);
  });

  it('falls back to the whole vocabulary when nothing has decided', () => {
    // Withholding a question because nobody has looked yet would be a claim
    // about the destination made out of our own ignorance.
    expect(rowCount(render({ context: context() }))).toBe(INTERESTS.length);
  });

  it('keeps a stored answer the offer no longer includes', () => {
    /*
     * The failure this forbids: a profile answered before the offer existed, or
     * against a destination that has since changed, carries `hot_springs: core`.
     * Rendering the offer alone would take the control away while the answer
     * carried on steering the research — a preference nobody could see and
     * nobody could withdraw.
     */
    const base = defaultAnswers(context());
    const answers: QuestionnaireAnswers = {
      ...base,
      interests: { ...base.interests, hot_springs: 'core', museums_and_galleries: 'frequent' },
    };
    const offered = context({ offeredInterests: CITY_OFFER.interests });

    const markup = render({ context: offered, answers });
    expect(hasRow(markup, 'hot_springs')).toBe(true);

    // And it is still on the screen that says "Everything you told us".
    const review = render({ context: offered, answers, step: 'review' });
    expect(review).toContain('Hot springs (Core)');
  });

  it('does not resurrect a row nobody graded', () => {
    // `low` is where every row starts, so it is silence rather than an answer.
    const base = defaultAnswers(context());
    const markup = render({
      context: context({ offeredInterests: CITY_OFFER.interests }),
      answers: { ...base, interests: { ...base.interests, hot_springs: 'low' } },
    });
    expect(hasRow(markup, 'hot_springs')).toBe(false);
  });
});

// --- Stage B ---------------------------------------------------------------

const SOURCE = {
  kind: 'authored' as const,
  sourceName: 'Sidequest fixture',
  confidence: 0.9,
  volatility: 'stable' as const,
};

function place(id: string, driveMinutes: number): Place {
  return {
    id,
    regionId: 'r',
    name: id,
    locality: 'Somewhere',
    shortDescription: `${id} is somewhere with enough written about it to plan around.`,
    coordinates: { lat: 35.6, lng: 139.7 },
    source: {
      name: 'Sidequest fixture',
      kind: 'curated',
      confidence: 0.9,
      lastVerified: '2026-08-11',
    },
    relationship: 'satellite',
    category: 'viewpoint',
    interests: ['scenic_viewpoints'],
    typicalDurationMinutes: 90,
    costLevel: 1,
    physicalIntensity: 'easy',
    crowdLevel: 'quiet',
    popularityScore: 0.4,
    hiddenGemScore: 0.4,
    tags: [],
    weather: {
      exposure: 'mixed',
      precipitation: 'low',
      wind: 'low',
      heat: 'low',
      cold: 'low',
      visibilityDependent: false,
      poorWeatherBackup: false,
      approachDegradesWhenWet: false,
    },
    bestTimeOfDay: 'any',
    seasonalAccess: { openMonths: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], closureRisk: 'none' },
    access: {
      roadSurface: 'paved',
      mountainRoad: false,
      parkingDifficulty: 'easy',
      remoteNoServices: false,
    },
    travelFromBase: { distanceKm: driveMinutes / 2, driveMinutes, driveIsScenic: false },
  };
}

function access(placeIds: string[], approachMode: AccessRule['approachMode']): AccessDataset {
  const rule = {
    id: `rule-${approachMode}`,
    label: approachMode,
    placeIds,
    months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    approachMode,
    approachMinutes: null,
    privateVehicle: 'allowed',
    serviceRequirement: 'none',
    walkMinutesFromDropOff: 0,
    internalTransfer: { mode: 'walk', minutes: 0 },
    permitRequired: false,
    notes: [],
    provenance: SOURCE,
  } as AccessRule;
  return { regionId: 'r', points: [], services: [], rules: [rule] };
}

const IDS = ['p1', 'p2', 'p3', 'p4'];

/** Everything 45 minutes out with no way in but a road. */
const DRIVE_ONLY = decisionQuestionsFor({
  places: IDS.map((id) => place(id, 45)),
  access: access(IDS, 'drive'),
  carAvailable: false,
  secondaryBaseMinutes: [],
});

/** Everything reached on foot. A hire car changes nothing here. */
const WALKABLE = decisionQuestionsFor({
  places: IDS.map((id) => place(id, 8)),
  access: access(IDS, 'walk'),
  carAvailable: false,
  secondaryBaseMinutes: [],
});

describe('a destination-triggered question reaches the control it steers', () => {
  it('asks about a hire car where the region cannot be crossed without one', () => {
    const markup = render({
      context: context(),
      step: 'transport',
      decisionQuestions: DRIVE_ONLY,
    });

    expect(markup).toContain('data-testid="decision-question-rent_a_car"');
    expect(markup).toContain('Would you take a hire car here?');
    // §6.6: the reason it matters, on screen with the question.
    expect(markup).toContain('most of what we found would have to come off the plan');
    // And the measurement that justified interrupting anybody.
    expect(markup).toMatch(/4 of the 4 places we found have no way in but a drive/);
  });

  it('asks nothing at all where the answer would change nothing', () => {
    expect(WALKABLE.map((question) => question.id)).not.toContain('rent_a_car');
    const markup = render({
      context: context(),
      step: 'transport',
      decisionQuestions: WALKABLE,
    });
    expect(markup).not.toContain('data-testid="decision-question-');
    expect(markup).not.toContain('Because of where you are going');
  });

  it('renders nothing for a trip whose region has not been compiled yet', () => {
    // Stage B is by definition post-research; the default has to be silence.
    const markup = render({ context: context(), step: 'transport' });
    expect(markup).not.toContain('Because of where you are going');
  });

  it('never lets a follow-up become a second questionnaire', () => {
    /*
     * Capped at render as well as at emission. The emitter truncates, but a
     * screen that renders whatever it is handed is one bad stored artifact away
     * from four extra questions on one step.
     */
    const overflowing: RegionDecisionQuestionRecord[] = (
      ['willDrive', 'maxDailyTravelMinutes', 'willUseShuttles'] as const
    ).map((answerField, index) => ({
      id: 'rent_a_car',
      prompt: `Prompt ${index}`,
      why: `Why ${index}`,
      evidence: `Evidence ${index}`,
      answerField,
    }));
    const markup = render({
      context: context(),
      step: 'transport',
      decisionQuestions: [
        ...overflowing,
        {
          id: 'early_start',
          prompt: 'A fourth question nobody should see',
          why: 'why',
          evidence: 'evidence',
          answerField: 'dayStart',
        },
      ],
    });
    expect(markup).not.toContain('A fourth question nobody should see');
    expect(markup.split('Because of where you are going').length - 1).toBeLessThanOrEqual(
      MAX_DECISION_QUESTIONS,
    );
  });
});

/**
 * THE PAGE HAS TO ACTUALLY HAND THESE OVER.
 *
 * The two blockers above were not missing engines — both were built, both were
 * stored on the compiled region, and the screen read neither. A component test
 * proves the wizard renders what it is given; only the page decides whether it
 * is given anything, and the page is an async server component with a database
 * behind it, so this reads its source.
 *
 * Grep-based on purpose, the same trade `consumers.architecture.test.ts` makes:
 * an import-graph proof would be stronger and would also miss the thing that
 * actually went wrong, which was a prop nobody passed.
 */
const PAGE = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../app/(product)/trips/[id]/questionnaire/page.tsx',
  ),
  'utf8',
);

describe('the questionnaire page supplies what the wizard renders', () => {
  it('resolves an interest offer and puts it on the context', () => {
    // The compiled region's own offer where there is one…
    expect(PAGE).toContain('resolved.context.region.interestOffer');
    // …and the entity type otherwise, which is the path a first-time
    // traveller is on, because the questionnaire runs before compilation.
    expect(PAGE).toContain('interestOfferFromEntityType');
    expect(PAGE).toContain('destinationEntityType');
    expect(PAGE).toContain('offeredInterests: offer.interests');
  });

  it('passes the compiled region’s Stage B questions to the wizard', () => {
    expect(PAGE).toContain('decisionQuestions={');
    expect(PAGE).toContain('resolved.context.region.decisionQuestions');
  });
});
