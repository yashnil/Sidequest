import type { TripComposerAnswers } from '../../schemas/composer';
import { emptyComposerAnswers } from '../../schemas/composer';
import { buildAdvisorShortlist } from '../advise';
import type { CatalogDestination } from '../catalog/schema';
import { advisorKm, originPointFromText } from '../origin';
import { parseTravelRequest } from '../parse';
import { ADVISOR_QUESTIONS, answerAdvisorQuestion, nextQuestion, skipAdvisorQuestion, type QuestionId } from '../questions';
import type { AdvisorShortlist } from '../shortlist-schema';
import type { Check, Scenario } from './scenarios';

/**
 * RUNS ONE SCENARIO THROUGH THE WHOLE ADVISOR, LIKE A TRAVELLER WOULD.
 *
 * Parse the text → follow the interview, answering from the persona (skipping
 * what the persona has no answer to) → build the shortlist → evaluate every
 * check against the catalog entries of the primary picks. Deterministic, no
 * clock beyond the fixed `now`, no network.
 */

export const EVAL_NOW = new Date('2026-10-26T12:00:00Z');

export interface CheckResult {
  check: Check;
  pass: boolean;
  detail: string;
}

export interface ScenarioRun {
  scenario: Scenario;
  asked: QuestionId[];
  skipped: QuestionId[];
  /** Questions asked although the text already answered them. */
  redundant: QuestionId[];
  stopReason: string;
  answers: TripComposerAnswers;
  shortlist: AdvisorShortlist;
  checks: CheckResult[];
  /** Score gap between pick 1 and pick 3; zero gaps across the board are the old failure. */
  topSpread: number;
  /** Distinct world regions among the primary picks. */
  regions: number;
  /** Primary picks that clear the lead-interest floor, when a lead was stated. */
  leadServed: number | null;
  ms: number;
}

export function baseAnswers(): TripComposerAnswers {
  return { ...emptyComposerAnswers('help_me_decide', EVAL_NOW), dates: { mode: 'month', wantsRecommendation: false } };
}

function evaluate(check: Check, picks: CatalogDestination[], run: { asked: QuestionId[]; answers: TripComposerAnswers }): CheckResult {
  const all = (predicate: (entry: CatalogDestination) => boolean, what: string): CheckResult => {
    const failing = picks.filter((entry) => !predicate(entry)).map((entry) => entry.id);
    return { check, pass: picks.length > 0 && failing.length === 0, detail: picks.length === 0 ? 'no picks' : failing.length === 0 ? `all ${what}` : `not ${what}: ${failing.join(', ')}` };
  };
  switch (check.kind) {
    case 'primaries_offer':
      return all((entry) => check.experiences.some((experience) => ((entry.experiences as Record<string, number>)[experience] ?? 0) >= 2), `strong on ${check.label}`);
    case 'in_regions':
      return all((entry) => check.regions.includes(entry.worldRegion), 'in the requested regions');
    case 'in_countries':
      return all((entry) => entry.countries.some((code) => check.countries.includes(code)), 'in the requested countries');
    case 'in_season':
      return all((entry) => check.months.some((month) => entry.season[month - 1]! >= 2), `in season in ${check.months.join('/')}`);
    case 'warmth':
      return all((entry) => check.months.some((month) => (check.min === undefined || entry.highC[month - 1]! >= check.min) && (check.max === undefined || entry.highC[month - 1]! <= check.max)), `within the temperature bound`);
    case 'max_cost':
      return all((entry) => entry.cost <= check.cost, `cost ≤ ${check.cost}`);
    case 'low_mobility':
      return all((entry) => entry.lowMobility >= check.min, `low-mobility ≥ ${check.min}`);
    case 'family':
      return all((entry) => entry.family >= check.min, `family ≥ ${check.min}`);
    case 'no_car':
      return all((entry) => entry.access.car !== 'essential', 'doable without a car');
    case 'fits_nights':
      return all((entry) => entry.nights.min <= check.nights && (check.nights <= 10 || entry.nights.max >= check.nights * 0.6), `doable in ${check.nights} nights`);
    case 'within_km': {
      const origin = originPointFromText(run.answers.origin, run.answers.originCountry);
      if (!origin) return { check, pass: false, detail: 'origin did not resolve' };
      return all((entry) => advisorKm(origin, entry.center) <= check.km, `within ${check.km} km of ${origin.label}`);
    }
    case 'spread': {
      const regions = new Set(picks.map((entry) => entry.worldRegion)).size;
      return { check, pass: regions >= check.regions, detail: `${regions} regions` };
    }
    case 'unusual': {
      const count = picks.filter((entry) => entry.familiarity <= 1).length;
      return { check, pass: count >= check.atLeast, detail: `${count} little-known` };
    }
    case 'classic': {
      const count = picks.filter((entry) => entry.familiarity >= 2).length;
      return { check, pass: count >= check.atLeast, detail: `${count} well-known` };
    }
    case 'max_challenge_easiest':
      return all((entry) => entry.challenge.easiest <= check.level, `easiest version ≤ ${check.level}`);
    case 'min_challenge_typical':
      return all((entry) => entry.challenge.typical >= check.level, `typical challenge ≥ ${check.level}`);
    case 'max_questions':
      return { check, pass: run.asked.length <= check.count, detail: `${run.asked.length} asked` };
  }
}

export function runScenario(scenario: Scenario, catalog: readonly CatalogDestination[]): ScenarioRun {
  const started = Date.now();
  const parsed = parseTravelRequest(scenario.text, baseAnswers());
  let answers = parsed.answers;
  const asked: QuestionId[] = [];
  const skipped: QuestionId[] = [];
  /* What the text answered, measured before any question is put. */
  const answeredByText = new Set(ADVISOR_QUESTIONS.filter((question) => question.answered(answers) || (answers.discovery?.asked ?? []).includes(question.id)).map((question) => question.id));
  let stopReason = 'not_started';
  for (let guard = 0; guard < 20; guard += 1) {
    const step = nextQuestion(answers, catalog);
    stopReason = step.stopReason;
    if (!step.question) break;
    const id = step.question.id;
    asked.push(id);
    const reply = scenario.persona[id];
    if (reply === undefined) {
      /* An essential with no persona answer: take the most likely answer, as a traveller tapping quickly would. */
      if (step.question.essential) {
        const option = [...step.question.options(answers)].sort((a, b) => b.prior - a.prior)[0]!;
        answers = answerAdvisorQuestion(answers, id, [option.id]);
      } else {
        skipped.push(id);
        answers = skipAdvisorQuestion(answers, id);
      }
    } else {
      answers = answerAdvisorQuestion(answers, id, Array.isArray(reply) ? reply : [reply]);
    }
  }
  const shortlist = buildAdvisorShortlist({ answers, catalog, catalogVersion: 'eval', now: EVAL_NOW });
  const byId = new Map(catalog.map((entry) => [entry.id, entry]));
  const picks = shortlist.picks.map((pick) => byId.get(pick.id)!).filter(Boolean);
  const checks = scenario.checks.map((check) => evaluate(check, picks, { asked, answers }));
  const scores = shortlist.picks.map((pick) => pick.score);
  const leadStated = answers.discovery?.focusRanked === true || (answers.discovery?.focus.length ?? 0) === 1;
  return {
    scenario,
    asked,
    skipped,
    redundant: asked.filter((id) => answeredByText.has(id)),
    stopReason,
    answers,
    shortlist,
    checks,
    topSpread: scores.length > 1 ? Math.max(...scores) - Math.min(...scores) : 0,
    regions: new Set(shortlist.picks.map((pick) => pick.worldRegion)).size,
    leadServed: leadStated ? shortlist.picks.filter((pick) => pick.strongFor.length > 0 && pick.factors.length > 0).length : null,
    ms: Date.now() - started,
  };
}
