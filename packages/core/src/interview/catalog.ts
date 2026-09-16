import { UNIVERSAL_INTERESTS } from '../interests/vocabulary';
import {
  INTEREST_LABELS,
  INTERESTS,
  REGIONAL_EXPANSIONS,
  type BudgetStyle,
  type Interest,
  type InterestLevel,
  type RegionalExpansion,
} from '../schemas/common';
import { DIETARY_NEED_KIND, DIETARY_NEED_LABELS, DIETARY_NEEDS } from '../schemas/food';
import {
  HARD_CONSTRAINT_LABELS,
  type HardConstraint,
  type HardConstraintCode,
  type PreferenceSource,
} from '../schemas/interview';
import type { QuestionnaireAnswers } from '../schemas/profile';
import type { TravelerNeed } from '../schemas/trip';
import { availableRegionalExpansions, EXPANSION_CEILING_MINUTES } from '../questionnaire/definition';
import type { PlanningImpactKey } from './impact';
import { hasTrait, type DestinationQuestionContext, type DestinationTrait } from './traits';
import { PRIORITY_ROLE_ANSWERS, type InterestRoles, type PriorityRoleAnswer } from '../intent/roles';
import { diagnoseTrip, intentIsSpecified, looksLikeAny } from './diagnosis';
import type { OperatingType } from '../operating/model';
import { modeStatusFor } from '../reality/schema';
import { movementFromReality } from '../reality/interview';

/**
 * THE QUESTION CATALOG — DECLARATIVE, GENERIC, TEMPLATED BY CONTEXT.
 *
 * Every question here states what it can change (`impacts`), how much it
 * costs to answer (`burden`), how much is at stake if it goes unasked
 * (`criticality`), and when it is worth asking at all (`relevance`, a pure
 * function of the destination screening and the answers so far). The selector
 * (`selector.ts`) reads those four things and nothing else; the wizard reads
 * `kind`, `prompt`, `why` and `options`. No destination is named anywhere in
 * this file — copy that mentions a place reads it from the context.
 */

export type InterviewTier = 'core' | 'destination' | 'fine_tune';

export const INTERVIEW_MODULES = [
  'priorities',
  'rhythm',
  'tradeoffs',
  'urban_mobility',
  'road_trip',
  'remote_wilderness',
  'island_water',
  'altitude_outdoor',
  'food',
  'broad_scope',
  'family_group',
  'budget',
  'hard_constraints',
  'names',
  /**
   * V12.1 §27 — the questions only *this kind of trip* raises.
   *
   * Not a topic like the others: a module whose questions are chosen by what
   * the answers so far say the trip **is**. A trek asks where you sleep on the
   * trail; a resort week asks whether it is one property or two; a safari asks
   * whether the vehicle is yours. None of them is worth asking of anybody else,
   * and every one of them changes the plan.
   */
  'operating_mode',
] as const;
export type InterviewModule = (typeof INTERVIEW_MODULES)[number];

export const INTERVIEW_MODULE_LABELS: Record<InterviewModule, string> = {
  priorities: 'What the trip is for',
  rhythm: 'How the days feel',
  tradeoffs: 'The trade-offs',
  urban_mobility: 'Getting around the city',
  road_trip: 'On the road',
  remote_wilderness: 'Remote travel',
  island_water: 'Islands and water',
  altitude_outdoor: 'Effort and altitude',
  food: 'Food',
  broad_scope: 'How much ground',
  family_group: 'The group',
  budget: 'Spend',
  hard_constraints: 'Hard limits',
  names: 'Named places',
  operating_mode: 'How this trip works',
};

export type ResponseKind =
  | 'single'
  | 'scenario'
  | 'multi'
  | 'interests'
  /** PRODUCT RECOVERY V1 — one screen: every chosen interest × its role. */
  | 'interest_roles'
  | 'dietary'
  | 'hard_constraints'
  | 'budget'
  | 'names'
  | 'text';

export interface InterviewOption {
  value: string;
  label: string;
  detail?: string;
}

export interface InterviewTraveller {
  travelerNeeds: readonly TravelerNeed[];
  tripDays: number;
  adults: number;
  children: number;
  offeredInterests: readonly Interest[];
  composerThemes?: readonly string[];
  /** Answer fields the composer already settled and the stored answers still agree with. */
  carried: readonly string[];
  /** Whether the composer captured must-do / avoid text, so the names question need not ask again. */
  composerNamedPlaces?: boolean;
  /**
   * V6 §6 — WHO IS TRAVELLING, AS THE SELECTOR READS IT.
   *
   * Present only when the traveller described people. `needs` are functional
   * need keys across the party; `drivers` counts members who said they can
   * drive (null when nobody said either way); `dietsRecorded` is true when
   * every member has a diet on record, which makes the trip-level dietary
   * question redundant rather than wrong.
   */
  party?: {
    members: number;
    needs: readonly string[];
    drivers: number | null;
    dietsRecorded: boolean;
    /** V7 §5 — whether the described members actually differ (needs, diets, capacity, notes). */
    differences?: boolean;
  };
}

export interface InterviewContext {
  destination: DestinationQuestionContext;
  traveller: InterviewTraveller;
}

export interface SmartDefault {
  value: unknown;
  reason: string;
  source: Extract<PreferenceSource, 'smart_default' | 'destination_prior'>;
}

export interface QuestionDefinition {
  id: string;
  module: InterviewModule;
  tier: InterviewTier;
  kind: ResponseKind;
  prompt: (ctx: InterviewContext, answers: QuestionnaireAnswers) => string;
  why: (ctx: InterviewContext) => string;
  options?: (ctx: InterviewContext, answers: QuestionnaireAnswers) => InterviewOption[];
  impacts: readonly PlanningImpactKey[];
  /** Whether an answer here can become a hard constraint. */
  hardCapable: boolean;
  /** 1 quick tap · 2 a moment's thought · 3 real effort. */
  burden: 1 | 2 | 3;
  /** 0 nice to know · 3 the plan is wrong without it. */
  criticality: 0 | 1 | 2 | 3;
  /** Can be left with "No preference". */
  optional: boolean;
  /** 0 hides the question; 1 is fully relevant. Pure. */
  relevance: (ctx: InterviewContext, answers: QuestionnaireAnswers) => number;
  /** Question ids that must be answered (explicitly or by default) first. */
  dependsOn?: readonly string[];
  /** Question ids whose explicit answer makes this one redundant. */
  supersededBy?: readonly string[];
  /** Answer fields the composer may have carried; a carried field means the question is already answered. */
  carriedFields?: readonly string[];
  /** The current value, for rendering the selected state. */
  read: (answers: QuestionnaireAnswers) => unknown;
  /** The answer, as a patch on the answers. */
  apply: (value: unknown, answers: QuestionnaireAnswers, ctx: InterviewContext) => Partial<QuestionnaireAnswers>;
  /** What "decide for me" chooses, and the sentence it shows. */
  smartDefault: (ctx: InterviewContext, answers: QuestionnaireAnswers) => SmartDefault;
  /** Presentational or consent-only questions may carry no impact. None today. */
  presentational?: boolean;
  /**
   * MVP V3, Stage 14 — whether this question offers "Something else".
   *
   * True for every preference whose options are a *simplification* of what a
   * person would actually say. "How hard do you want to work for it?" has three
   * options and a thousand real answers, and "I'm very fit but don't want two
   * huge hiking days back to back" is one of them. False for questions whose
   * options are exhaustive by construction (a month, a head count, a hard
   * constraint that is already free text).
   */
  elaborates?: boolean;
}

/**
 * Questions where an option is a simplification, so the traveller is offered a
 * line of their own beside it. Listed once, here, rather than sprinkled through
 * the definitions, so "which questions accept nuance" is answerable by reading
 * one thing. `interview.test.ts` checks every id names a real question.
 */
export const ELABORATING_QUESTIONS: readonly string[] = [
  'priorities',
  'priority_roles',
  'transport_mode',
  'day_shape',
  'effort',
  'iconic_crowds',
  'famous_vs_hidden',
  'food_tradeoff',
  'budget',
  'convenience_spend',
  'base_moves',
  'coverage_strategy',
  'lodging_style',
  'hike_appetite',
  'walking_tolerance',
  'day_trips',
  'remote_comfort',
  'guide_willingness',
  'scenic_reach',
  'daily_driving',
];

export function questionElaborates(id: string): boolean {
  return ELABORATING_QUESTIONS.includes(id);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const LEVEL_RANK: Record<InterestLevel, number> = { avoid: 0, low: 1, occasional: 2, frequent: 3, core: 4 };
const CHOSEN_LEVELS: InterestLevel[] = ['occasional', 'frequent', 'core'];

function t(ctx: InterviewContext, trait: DestinationTrait): boolean {
  return hasTrait(ctx.destination, trait);
}

export function chosenInterests(answers: QuestionnaireAnswers): Interest[] {
  return INTERESTS.filter((interest) => CHOSEN_LEVELS.includes(answers.interests[interest] ?? 'low'));
}

const THEME_INTERESTS: Record<string, Interest[]> = {
  outdoors: ['hiking', 'easy_nature_walks', 'scenic_viewpoints'],
  mountains: ['hiking', 'scenic_drives', 'scenic_viewpoints'],
  water: ['beaches_and_swimming', 'lakes_and_rivers'],
  wildlife: ['wildlife'],
  food: ['food_and_towns', 'markets_and_street_food'],
  culture: ['history_and_culture', 'museums_and_galleries', 'architecture_and_landmarks'],
  cities: ['neighbourhoods_and_local_life', 'architecture_and_landmarks'],
  quiet: ['scenic_viewpoints', 'easy_nature_walks'],
};

/** Interests a destination shape leads with, for the priority offer and the destination prior. */
function signatureInterests(ctx: InterviewContext): Interest[] {
  const d = ctx.destination;
  const out: Interest[] = [];
  const push = (...items: Interest[]) => {
    for (const item of items) if (!out.includes(item)) out.push(item);
  };
  // A city leads with what cities do — eating, streets, culture — and keeps a way out to the hills and the water.
  if (hasTrait(d, 'dense_urban')) push('food_and_towns', 'neighbourhoods_and_local_life', 'history_and_culture', 'markets_and_street_food', 'scenic_viewpoints', 'museums_and_galleries', 'architecture_and_landmarks', 'easy_nature_walks', 'hiking');
  if (hasTrait(d, 'mountain')) push('hiking', 'scenic_viewpoints', 'lakes_and_rivers', 'scenic_drives', 'easy_nature_walks', 'wildlife');
  if (hasTrait(d, 'wilderness')) push('wildlife', 'hiking', 'easy_nature_walks', 'scenic_viewpoints', 'stargazing');
  if (hasTrait(d, 'beach') || hasTrait(d, 'island') || hasTrait(d, 'archipelago')) push('beaches_and_swimming', 'scenic_viewpoints', 'food_and_towns', 'wildlife', 'easy_nature_walks');
  if (hasTrait(d, 'road_trip_region') || hasTrait(d, 'compact_country')) push('scenic_drives', 'scenic_viewpoints', 'history_and_culture', 'food_and_towns', 'easy_nature_walks');
  if (hasTrait(d, 'broad_geography')) push('history_and_culture', 'food_and_towns', 'scenic_viewpoints', 'neighbourhoods_and_local_life');
  if (hasTrait(d, 'food_dense')) push('food_and_towns', 'markets_and_street_food');
  return out;
}

/**
 * DESTINATION-AWARE INTERVIEW GLOBALITY — WHICH FAMILY AN INTEREST BELONGS TO.
 *
 * Never shown to a traveller. The first screen is capped per family so that
 * one theme cannot monopolise it: the vocabulary's own order opens with eight
 * outdoor rows, and a destination nobody had screened yet used to inherit
 * exactly that order — hiking, nature walks, viewpoints, lakes, scenic drives,
 * wildlife, geothermal, hot springs — for a city of seven million.
 */
export const INTEREST_FAMILIES = ['outdoors', 'scenery', 'water', 'nature_science', 'food', 'culture', 'urban_life'] as const;
export type InterestFamily = (typeof INTEREST_FAMILIES)[number];
export const INTEREST_FAMILY: Record<Interest, InterestFamily> = {
  hiking: 'outdoors',
  easy_nature_walks: 'outdoors',
  scenic_viewpoints: 'scenery',
  scenic_drives: 'scenery',
  photography_golden_hour: 'scenery',
  stargazing: 'scenery',
  lakes_and_rivers: 'water',
  beaches_and_swimming: 'water',
  hot_springs: 'water',
  wildlife: 'nature_science',
  geology_and_geothermal: 'nature_science',
  food_and_towns: 'food',
  markets_and_street_food: 'food',
  history_and_culture: 'culture',
  museums_and_galleries: 'culture',
  architecture_and_landmarks: 'culture',
  neighbourhoods_and_local_life: 'urban_life',
};
/** Rows on the first priorities screen. */
export const FIRST_SCREEN_INTERESTS = 8;
/** At most this many rows from one family on that screen. */
export const MAX_PER_FAMILY = 2;
/** Families every destination can serve; one row from each is guaranteed a place when the offer holds one. */
const GUARANTEED_FAMILIES: readonly InterestFamily[] = ['food', 'culture'];

/**
 * The eight categories the priorities screen shows first, ranked and then
 * balanced.
 *
 * Rank: what the traveller already said (composer themes, chosen rows), then
 * the destination's signature, then the universal core, then the rest of the
 * offer in its own order. Balance: at most `MAX_PER_FAMILY` rows per family,
 * with the best food and culture rows guaranteed a place, so a mountain
 * region still asks about eating and a harbour city still offers the hills.
 * Everything in the offer remains reachable behind "More interests".
 */
export function priorityOffer(ctx: InterviewContext, answers: QuestionnaireAnswers): Interest[] {
  const offered = ctx.traveller.offeredInterests.length > 0 ? ctx.traveller.offeredInterests : INTERESTS;
  const ranked: Interest[] = [];
  const push = (interest: Interest) => {
    if (!ranked.includes(interest) && offered.includes(interest)) ranked.push(interest);
  };
  const chosen = chosenInterests(answers);
  for (const theme of ctx.traveller.composerThemes ?? []) for (const interest of THEME_INTERESTS[theme] ?? []) push(interest);
  for (const interest of chosen) push(interest);
  for (const interest of signatureInterests(ctx)) push(interest);
  for (const interest of UNIVERSAL_INTERESTS) push(interest);
  for (const interest of offered) push(interest);

  const out: Interest[] = [];
  const perFamily = new Map<InterestFamily, number>();
  const take = (interest: Interest) => {
    if (out.includes(interest)) return;
    out.push(interest);
    perFamily.set(INTEREST_FAMILY[interest], (perFamily.get(INTEREST_FAMILY[interest]) ?? 0) + 1);
  };
  // What the traveller already chose is never balanced away.
  for (const interest of ranked) if (chosen.includes(interest)) take(interest);
  // One row from each guaranteed family, the best-ranked one.
  for (const family of GUARANTEED_FAMILIES) {
    if (out.length >= FIRST_SCREEN_INTERESTS) break;
    if ((perFamily.get(family) ?? 0) > 0) continue;
    const best = ranked.find((interest) => INTEREST_FAMILY[interest] === family && !out.includes(interest));
    if (best) take(best);
  }
  // The rest by rank, capped per family.
  for (const interest of ranked) {
    if (out.length >= FIRST_SCREEN_INTERESTS) break;
    if ((perFamily.get(INTEREST_FAMILY[interest]) ?? 0) >= MAX_PER_FAMILY) continue;
    take(interest);
  }
  // A small offer relaxes the cap rather than showing an emptier screen.
  for (const interest of ranked) {
    if (out.length >= FIRST_SCREEN_INTERESTS) break;
    take(interest);
  }
  return out.slice(0, Math.max(FIRST_SCREEN_INTERESTS, chosen.length));
}

function choice(def: Omit<QuestionDefinition, 'kind' | 'hardCapable' | 'optional'> & { kind?: 'single' | 'scenario'; hardCapable?: boolean; optional?: boolean }): QuestionDefinition {
  return { kind: 'single', hardCapable: false, optional: true, ...def };
}

function labelOf(options: readonly InterviewOption[], value: unknown): string {
  return options.find((option) => option.value === value)?.label ?? String(value);
}

const MINUTES_LABEL = (minutes: number): string =>
  minutes % 60 === 0 ? `${minutes / 60} h` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;

// ---------------------------------------------------------------------------
// Core questions
// ---------------------------------------------------------------------------

const PRIORITIES: QuestionDefinition = {
  id: 'priorities',
  module: 'priorities',
  tier: 'core',
  kind: 'interests',
  prompt: () => 'What would make this trip worth taking?',
  why: () => 'Pick what matters most. We ask how big a role each one should play next, and only for the ones you pick.',
  options: (ctx, answers) => priorityOffer(ctx, answers).map((interest) => ({ value: interest, label: INTEREST_LABELS[interest] })),
  impacts: ['activity_frequency', 'famous_vs_hidden', 'trip_archetype'],
  hardCapable: false,
  burden: 2,
  criticality: 3,
  optional: false,
  relevance: () => 1,
  read: (answers) => chosenInterests(answers),
  apply: (value, answers) => {
    const chosen = new Set((Array.isArray(value) ? value : []).filter((v): v is Interest => (INTERESTS as readonly string[]).includes(String(v))));
    const interests = { ...answers.interests };
    for (const interest of INTERESTS) {
      const current = interests[interest] ?? 'low';
      if (chosen.has(interest)) {
        if (LEVEL_RANK[current] < LEVEL_RANK.frequent) interests[interest] = 'frequent';
      } else if (current !== 'avoid') {
        interests[interest] = 'low';
      }
    }
    return { interests };
  },
  smartDefault: (ctx, answers) => {
    const picks = priorityOffer(ctx, answers).slice(0, 3);
    const label = ctx.destination.traits.length > 0 ? `a place like ${ctx.destination.proseName}` : 'most trips';
    return {
      value: picks,
      reason: `We'll lead with ${picks.map((p) => INTEREST_LABELS[p].toLowerCase()).join(', ')} — the things ${label} does best.`,
      source: ctx.destination.traits.length > 0 ? 'destination_prior' : 'smart_default',
    };
  },
};

const ROLE_OPTIONS: InterviewOption[] = [
  { value: 'once', label: 'One great one', detail: 'A single standout, not a theme' },
  { value: 'couple', label: 'A couple of times', detail: 'Woven through the trip' },
  { value: 'most_days', label: 'Most days', detail: 'Expect it on the majority of days' },
  { value: 'build_around', label: 'Build the trip around it', detail: 'This is the reason for the trip' },
];
const ROLE_LEVEL: Record<string, InterestLevel> = { once: 'occasional', couple: 'frequent', most_days: 'core', build_around: 'core' };
const LEVEL_ROLE: Partial<Record<InterestLevel, string>> = { occasional: 'once', frequent: 'couple', core: 'most_days' };

/**
 * PRODUCT RECOVERY V1 — ONE SCREEN FOR EVERY CHOSEN INTEREST'S ROLE.
 *
 * Five chosen interests used to mean five screens of "What role should X
 * play?". This asks the same question once, as a matrix: each chosen interest
 * on its own row, the same four roles across. The per-interest questions stay
 * in the catalog for the brief, analytics and "Decide for me" (hidden, never
 * shown) so nothing that reads `priority_role:<interest>` breaks.
 */
export const PRIORITY_ROLES: QuestionDefinition = {
  id: 'priority_roles',
  module: 'priorities',
  tier: 'core',
  kind: 'interest_roles',
  prompt: () => 'What should lead the trip?',
  why: () => 'How often something appears is a different question from whether you like it. Two hikes in four days is a different trip from one every morning.',
  options: () => ROLE_OPTIONS,
  impacts: ['activity_frequency', 'day_density'],
  hardCapable: false,
  burden: 2,
  criticality: 2,
  optional: true,
  dependsOn: ['priorities'],
  relevance: (_ctx, answers) => (chosenInterests(answers).length > 0 ? 1 : 0),
  /*
   * The recorded answer first: a traveller who chose "Build the trip around it"
   * was shown "Most days" when they came back, because the level is all that
   * survived and `core` reads back as the weaker of the two roles that produce it.
   */
  read: (answers) => Object.fromEntries(chosenInterests(answers).map((interest) => [interest, answers.interestRoles?.[interest] ?? LEVEL_ROLE[answers.interests[interest] ?? 'low'] ?? 'couple'])),
  apply: (value, answers) => {
    const record = (value && typeof value === 'object' ? (value as Record<string, unknown>) : {}) as Record<string, unknown>;
    const interests = { ...answers.interests };
    /*
     * V12 §2 — KEEP THE ANSWER, AND KEEP THE LEVEL IT IMPLIES.
     *
     * `ROLE_LEVEL` is lossy by construction: `most_days` and `build_around`
     * both become `core`, so a trip built around a trek and a trip that walks
     * most mornings arrive at the planner as the same fact. The level is still
     * written, because everything downstream reads it and nothing about those
     * readers changes here — and the role is written beside it, so the layers
     * that need to know whether something is a rhythm or the reason for the
     * journey can ask.
     */
    const roles: InterestRoles = { ...(answers.interestRoles ?? {}) };
    // Every row the traveller set; a role for an interest not yet chosen chooses it.
    for (const [key, raw] of Object.entries(record)) {
      if (!(INTERESTS as readonly string[]).includes(key)) continue;
      const role = String(raw ?? '');
      if (ROLE_LEVEL[role]) interests[key as Interest] = ROLE_LEVEL[role]!;
      if ((PRIORITY_ROLE_ANSWERS as readonly string[]).includes(role)) roles[key as Interest] = role as PriorityRoleAnswer;
    }
    return { interests, interestRoles: roles };
  },
  smartDefault: (ctx, answers) => {
    const role = ctx.destination.tripDays >= 5 ? 'couple' : 'once';
    const chosen = chosenInterests(answers);
    // The first pick leads; the rest are woven through.
    const value = Object.fromEntries(chosen.map((interest, index) => [interest, index === 0 ? 'most_days' : role]));
    return { value, reason: chosen.length > 0 ? `${INTEREST_LABELS[chosen[0]!]} leads; the rest appear ${role === 'couple' ? 'a couple of times' : 'once'} across ${ctx.destination.tripDays} days.` : 'Nothing chosen yet.', source: 'smart_default' };
  },
};

export function roleQuestionFor(interest: Interest, position: number): QuestionDefinition {
  const label = INTEREST_LABELS[interest].toLowerCase();
  return {
    id: `priority_role:${interest}`,
    module: 'priorities',
    tier: position < 3 ? 'core' : 'fine_tune',
    kind: 'single',
    prompt: () => `What role should ${label} play?`,
    why: () => 'How often something appears is a different question from whether you like it. Two hikes in four days is a different trip from one every morning.',
    options: () => ROLE_OPTIONS,
    impacts: ['activity_frequency', 'day_density'],
    hardCapable: false,
    burden: 1,
    criticality: 1,
    optional: true,
    dependsOn: ['priorities'],
    // Hidden from the interview: the matrix question asks this for every chosen interest at once. Kept for the brief, analytics and by-id reads.
    relevance: () => 0,
    read: (answers) => LEVEL_ROLE[answers.interests[interest] ?? 'low'],
    /* The same answer, kept the same way as the matrix above keeps it. */
    apply: (value, answers): Partial<QuestionnaireAnswers> => {
      const patch: Partial<QuestionnaireAnswers> = {
        interests: { ...answers.interests, [interest]: ROLE_LEVEL[String(value)] ?? 'frequent' },
      };
      if ((PRIORITY_ROLE_ANSWERS as readonly string[]).includes(String(value))) {
        const roles: InterestRoles = { ...(answers.interestRoles ?? {}) };
        roles[interest] = String(value) as PriorityRoleAnswer;
        patch.interestRoles = roles;
      }
      return patch;
    },
    smartDefault: (ctx) => ({
      value: ctx.destination.tripDays >= 5 ? 'couple' : 'once',
      reason: `${ctx.destination.tripDays >= 5 ? 'A couple of' : 'One'} ${label} ${ctx.destination.tripDays >= 5 ? 'stops fit' : 'stop fits'} ${ctx.destination.tripDays} days without crowding out everything else.`,
      source: 'smart_default',
    }),
  };
}

const TRANSPORT_MODE: QuestionDefinition = choice({
  id: 'transport_mode',
  module: 'tradeoffs',
  tier: 'core',
  prompt: (ctx) => (t(ctx, 'dense_urban') ? `How do you want to move around ${ctx.destination.proseName}?` : `How will you get around ${ctx.destination.proseName}?`),
  why: (ctx) =>
    t(ctx, 'road_trip_region') || t(ctx, 'mountain')
      ? 'This decides which places are even reachable, and whether one base can cover the region.'
      : t(ctx, 'dense_urban')
        ? 'This sets how far apart the days can range and how much of the city you see between stops.'
        : t(ctx, 'guide_transfer_likely')
          ? 'Some of what is worth doing here cannot be reached without a guide or an arranged transfer.'
          : 'This decides which places are reachable and how the days are shaped.',
  options: (ctx) => {
    /*
     * V7 §7 — THE OPTIONS COME FROM WHAT IS TRUE HERE, NOT FROM THE SHAPE ALONE.
     *
     * Where the reality layer knows the country, a hire car is offered only
     * where it is a good idea (or possible with stated friction), trains and
     * hired transfers are their own option, and nothing collapses into "a car".
     */
    const reality = ctx.destination.reality;
    if (reality?.recommendation) {
      const options: InterviewOption[] = [];
      const rec = reality.recommendation;
      const status = (mode: Parameters<typeof modeStatusFor>[1]) => modeStatusFor(reality, mode);
      const regionalRail = rec.regional.includes('high_speed_rail') || rec.regional.includes('intercity_train') || rec.regional.includes('private_driver');
      const urbanTransit = rec.urban.length > 0;
      /*
       * V12.1 §12 — A RAIL COUNTRY OFFERS RAIL, WHETHER OR NOT ITS CITIES WERE READ.
       *
       * This used to require `urbanTransit && regionalRail`, and the dry run for
       * the §49 acceptance found what that costs: a ten-day trip to **Japan** was
       * offered exactly two ways of getting around — "Rent a car" and "A mix".
       * The Shinkansen is `recommended` in the compiled reality and the traveller
       * could not choose it.
       *
       * The cause is that `urban` is only populated where the screening read the
       * destination as urban, and a whole country typed as one phrase is not read
       * that way. So the country's own *regional* answer was discarded because
       * nothing had been established about its cities — our gap in reading the
       * ground, turned into a restriction on the traveller. That is the same
       * mistake this pass exists to correct, one screen earlier than usual.
       *
       * The regional answer now stands on its own, and the detail line says which
       * of the two situations it is rather than claiming a metro nobody screened.
       */
      if (regionalRail) options.push({ value: 'rail_transfers', label: 'Trains and hired transfers between places', detail: urbanTransit ? 'On foot, metro and ride-hailing in the city' : 'Trains for the long legs, and local transport once you are there' });
      else if (urbanTransit) options.push({ value: 'transit_walk', label: 'On foot and by public transport', detail: 'Keeps the days flexible and the city close' });
      if (rec.regional.includes('guided_transfer')) options.push({ value: 'guided', label: 'Guided, with transfers arranged', detail: 'Let local operators handle the hard legs' });
      if (rec.regional.includes('ferry') && !regionalRail) options.push({ value: 'boats_transfers', label: 'Boats and local transfers', detail: 'Move between islands by ferry or short hop' });
      if (urbanTransit) options.push({ value: 'taxis', label: 'Mostly taxis and rideshare', detail: 'Pay a little to skip the timetable' });
      const car = status('rental_car');
      const canDrive = ctx.traveller.party?.drivers !== 0;
      if (canDrive && (car === 'recommended' || car === 'viable')) options.push({ value: 'rent_car', label: 'Rent a car', detail: rec.regional.includes('rental_car') ? 'Most of what is worth seeing here sits at the end of a drive' : urbanTransit ? 'For days out; not for the city itself' : 'Freedom to reach the far corners' });
      else if (canDrive && car === 'friction') options.push({ value: 'rent_car', label: 'Rent a car, knowing the catch', detail: (reality.modes.find((m) => m.mode === 'self_drive')?.reason ?? 'Possible with friction').split('. ')[0]! });
      if (!options.some((o) => o.value === 'mixed')) options.push({ value: 'mixed', label: 'A mix, whatever works', detail: 'Decide leg by leg' });
      return options.slice(0, 4);
    }
    /*
     * No recommendation (the country is compiled but the shape is unread, or
     * nothing is compiled): the shape's options, minus a hire car wherever the
     * country's own facts say driving is discouraged or unavailable.
     */
    const carRefused = reality ? ['discouraged', 'unavailable'].includes(modeStatusFor(reality, 'self_drive')) || ['discouraged', 'unavailable'].includes(modeStatusFor(reality, 'rental_car')) : false;
    const withoutCar = (options: InterviewOption[]): InterviewOption[] => {
      if (!carRefused) return options;
      const kept = options.filter((o) => o.value !== 'rent_car' && o.value !== 'self_drive');
      if (!kept.some((o) => o.value === 'transit_walk' || o.value === 'guided' || o.value === 'boats_transfers')) kept.unshift({ value: 'transit_walk', label: 'On foot and by public transport', detail: 'Keeps the days flexible and the city close' });
      if (!kept.some((o) => o.value === 'mixed')) kept.push({ value: 'mixed', label: 'A mix, whatever works', detail: 'Decide leg by leg' });
      return kept;
    };
    if (t(ctx, 'guide_transfer_likely') || t(ctx, 'wilderness')) {
      return withoutCar([
        { value: 'guided', label: 'Guided, with transfers arranged', detail: 'Let local operators handle the hard legs' },
        { value: 'self_drive', label: 'Self-drive where a road exists', detail: 'A hire car for the reachable parts, transfers only where there is no road' },
        { value: 'mixed', label: 'A mix, whatever works', detail: 'Decide leg by leg' },
      ]);
    }
    if (t(ctx, 'archipelago') && !t(ctx, 'road_trip_region')) {
      return withoutCar([
        { value: 'boats_transfers', label: 'Boats and local transfers', detail: 'Move between islands by ferry or short hop' },
        { value: 'rent_car', label: 'Rent a car on the islands', detail: 'Drive each island, ferry the car where it goes' },
        { value: 'mixed', label: 'A mix', detail: 'Whatever each island needs' },
      ]);
    }
    if (t(ctx, 'dense_urban') || t(ctx, 'transit_rich') || t(ctx, 'walk_heavy')) {
      return withoutCar([
        { value: 'transit_walk', label: 'On foot and by public transport', detail: 'Keeps the days flexible and the city close' },
        { value: 'taxis', label: 'Mostly taxis and rideshare', detail: 'Pay a little to skip the timetable' },
        { value: 'rent_car', label: 'Rent a car', detail: 'For day trips out; not for the city itself' },
      ]);
    }
    return withoutCar([
      { value: 'rent_car', label: 'Rent a car', detail: t(ctx, 'road_trip_region') || t(ctx, 'mountain') ? 'Most of what is worth seeing here sits at the end of a drive' : 'Freedom to reach the far corners' },
      { value: 'no_car', label: 'No car', detail: 'Shuttles, tours, taxis and whatever runs to a timetable' },
      { value: 'transit_walk', label: 'On foot and by public transport', detail: 'Where it goes, and nowhere it does not' },
      { value: 'mixed', label: 'A mix, whatever works', detail: 'A car for the far stops, local transport in town' },
    ]);
  },
  impacts: ['transportation_mode', 'scope', 'base_count', 'trip_archetype', 'driving'],
  burden: 1,
  criticality: 3,
  carriedFields: ['willDrive'],
  // When the destination's shape does not settle the mode, this is asked first: uncertainty becomes a question, not a default.
  relevance: (ctx) => (ctx.destination.assumption?.confidence === 'high' ? 1 : 1.5),
  read: (answers) => answers.transportChoice ?? (answers.willDrive ? (answers.guideWillingness === 'prefer' ? 'self_drive' : answers.privateTransfers === 'fine' ? 'mixed' : 'rent_car') : answers.guideWillingness === 'prefer' ? 'guided' : answers.privateTransfers === 'fine' && answers.transportPriority === 'least_stressful' ? 'taxis' : answers.boatsAndFerries === 'fine' && answers.privateTransfers === 'fine' ? 'boats_transfers' : 'transit_walk'),
  apply: (value) => {
    const choice = String(value) as NonNullable<QuestionnaireAnswers['transportChoice']>;
    const chosen = (patch: Partial<QuestionnaireAnswers>): Partial<QuestionnaireAnswers> => ({ ...patch, transportChoice: choice });
    switch (choice) {
      case 'rail_transfers':
        return chosen({ willDrive: false, privateTransfers: 'fine', willUseShuttles: true, transportPriority: 'best_value' });
      case 'rent_car':
        return chosen({ willDrive: true, guideWillingness: 'sometimes', transportPriority: 'best_value' });
      case 'self_drive':
        return chosen({ willDrive: true, guideWillingness: 'sometimes', privateTransfers: 'if_needed' });
      case 'mixed':
        return chosen({ willDrive: true, privateTransfers: 'fine', transportPriority: 'best_value' });
      case 'guided':
        return chosen({ willDrive: false, guideWillingness: 'prefer', privateTransfers: 'fine', transportPriority: 'least_stressful' });
      case 'taxis':
        return chosen({ willDrive: false, privateTransfers: 'fine', transportPriority: 'least_stressful', willUseShuttles: true });
      case 'boats_transfers':
        return chosen({ willDrive: false, boatsAndFerries: 'fine', privateTransfers: 'fine', willUseShuttles: true });
      case 'no_car':
        return chosen({ willDrive: false, willUseShuttles: true, transportPriority: 'best_value' });
      case 'transit_walk':
      default:
        return { willDrive: false, willUseShuttles: true, transportPriority: 'best_value', privateTransfers: 'if_needed', transportChoice: 'transit_walk' };
    }
  },
  smartDefault: (ctx) => {
    /*
     * V7 §7 — A RECOMMENDATION NEEDS EVIDENCE ABOUT THE COUNTRY, NOT A SHAPE.
     *
     * The reality layer's recommendation (compiled facts about driving law,
     * transit, rail, transfers) is the only thing that may say "Sidequest
     * recommends". A shape trait alone never recommends a car: a municipality
     * typed `state` was once told to rent one. Without a recommendation the
     * honest default is "Sidequest will choose after it sees the route".
     */
    const reality = ctx.destination.reality;
    const fromReality = movementFromReality(reality);
    if (reality?.recommendation && fromReality) {
      const value = fromReality === 'rail_transfers' ? 'rail_transfers' : fromReality === 'car' ? 'rent_car' : fromReality === 'guided' ? 'guided' : fromReality === 'boat' ? 'boats_transfers' : fromReality === 'transit_walk' ? 'transit_walk' : 'mixed';
      return { value, reason: reality.recommendation.sentence, source: 'destination_prior' };
    }
    const movement = ctx.destination.assumption?.movement;
    if (movement === 'transit_walk') return { value: 'transit_walk', reason: `We'll assume you're happy walking and riding public transport, because that keeps a trip to ${ctx.destination.proseName} flexible.`, source: 'destination_prior' };
    if (movement === 'guided') return { value: 'guided', reason: `We'll assume guided legs and arranged transfers for the remote parts of ${ctx.destination.proseName}, and self-drive nowhere it is not needed.`, source: 'destination_prior' };
    if (movement === 'boat') return { value: 'boats_transfers', reason: `We'll assume boats and local transfers between islands, which is how ${ctx.destination.proseName} is usually done.`, source: 'destination_prior' };
    /*
     * A shape alone may still say "car" — but only where no country knowledge
     * exists to contradict it (a mountain region nobody has compiled). Where
     * the country IS compiled and did not recommend one, the shape does not
     * get to overrule the facts.
     */
    if (movement === 'car' && (!reality || reality.destination.coverage === 'none')) return { value: 'rent_car', reason: `We'll assume a hire car, because most of what is worth seeing around ${ctx.destination.proseName} sits at the end of a drive.`, source: 'destination_prior' };
    // Nothing supports one mode over another: the least committal choice, said plainly — never "a car" because no better evidence exists.
    return { value: 'mixed', reason: `Sidequest will choose how to get around ${ctx.destination.proseName} once it sees the route; until then the plan may mix a hired ride, trains and local transport. Change this if you already know what you want.`, source: 'smart_default' };
  },
});

const DAY_SHAPE: QuestionDefinition = choice({
  id: 'day_shape',
  module: 'rhythm',
  tier: 'core',
  kind: 'scenario',
  prompt: () => 'Which day sounds better?',
  why: () => 'This sets how much we fit into a day and how much slack it keeps.',
  options: () => [
    { value: 'one_big', label: 'One major experience, then time to linger', detail: 'A slow day with room to sit down' },
    { value: 'two_three', label: 'Two or three meaningful stops', detail: 'Balanced, still time for a long lunch' },
    { value: 'cover', label: "Cover a lot — I'm happy being on the move", detail: 'Full days, accept the travel' },
  ],
  impacts: ['day_density', 'activity_frequency'],
  burden: 1,
  criticality: 2,
  carriedFields: ['pace'],
  relevance: () => 1,
  read: (answers) => ({ slow: 'one_big', balanced: 'two_three', fast: 'cover' })[answers.pace],
  apply: (value) => ({ pace: value === 'one_big' ? 'slow' : value === 'cover' ? 'fast' : 'balanced' }),
  smartDefault: (ctx) => ({
    value: ctx.traveller.travelerNeeds.length > 0 ? 'one_big' : 'two_three',
    reason: ctx.traveller.travelerNeeds.length > 0 ? 'With the group you described, one main thing a day plus room to breathe holds up better than a packed one.' : 'Two or three real stops a day is the pace most trips settle into; change it if you know you run faster or slower.',
    source: 'smart_default',
  }),
});

const DAY_START: QuestionDefinition = choice({
  id: 'day_start',
  module: 'rhythm',
  tier: 'core',
  prompt: () => 'How early will you start?',
  why: (ctx) =>
    t(ctx, 'heat_sensitive')
      ? 'In your dates the cool hours are the morning, so this decides how much is done before the heat.'
      : t(ctx, 'weather_exposed')
        ? 'Early starts buy quiet trails and the best light; late ones buy easy mornings. Both are fine — we plan around it.'
        : 'This sets when days begin, which decides whether the famous places are seen before the crowds.',
  options: () => [
    { value: 'early', label: 'Early', detail: 'Out before the light gets flat' },
    { value: 'normal', label: 'Normal', detail: 'Moving by mid-morning' },
    { value: 'relaxed', label: 'Relaxed', detail: 'Coffee first, no alarms' },
  ],
  impacts: ['day_start', 'crowds'],
  burden: 1,
  criticality: 1,
  relevance: (ctx) => (t(ctx, 'heat_sensitive') || t(ctx, 'weather_exposed') ? 1 : 0.7),
  read: (answers) => answers.dayStart,
  apply: (value) => ({ dayStart: value === 'early' ? 'early' : value === 'relaxed' ? 'relaxed' : 'normal' }),
  smartDefault: (ctx) => (t(ctx, 'heat_sensitive') ? { value: 'early', reason: "We'll start early on the hot days so the outdoor stops land before the heat.", source: 'destination_prior' } : { value: 'normal', reason: "We'll plan for a mid-morning start — early enough for the best of the day, late enough for a proper breakfast.", source: 'smart_default' }),
});

const EFFORT: QuestionDefinition = choice({
  id: 'effort',
  module: 'rhythm',
  tier: 'core',
  prompt: () => 'How hard do you want to work for it?',
  why: (ctx) => (t(ctx, 'dense_urban') ? 'City days are walking days. This sets how far a day may go on foot and how many hills it may climb.' : 'This caps the effort of any single stop and how much of it a day may hold.'),
  options: (ctx) => [
    { value: 'light', label: 'Light', detail: t(ctx, 'dense_urban') ? 'Short walks between rides, flat where possible' : 'Short walks, mostly flat' },
    { value: 'moderate', label: 'Moderate', detail: t(ctx, 'dense_urban') ? 'A few miles a day on foot is fine' : 'A few miles and some climbing is fine' },
    { value: 'intense', label: 'Intense', detail: t(ctx, 'dense_urban') ? 'Long days on foot, hills included' : 'Long days, real elevation gain' },
  ],
  impacts: ['effort', 'walking', 'activity_frequency'],
  burden: 1,
  criticality: 2,
  carriedFields: ['dailyIntensity'],
  relevance: (ctx) => (ctx.traveller.travelerNeeds.includes('mobility_limited') ? 0 : 1),
  read: (answers) => answers.dailyIntensity,
  apply: (value) => ({ dailyIntensity: value === 'light' ? 'light' : value === 'intense' ? 'intense' : 'moderate' }),
  smartDefault: (ctx) => ({
    value: ctx.traveller.travelerNeeds.includes('seniors_in_group') || ctx.traveller.children > 0 ? 'light' : 'moderate',
    reason: ctx.traveller.travelerNeeds.includes('seniors_in_group') || ctx.traveller.children > 0 ? "We'll keep the effort light for the group you described." : "We'll assume moderate days — a few miles and some climbing — and never the hardest option available.",
    source: 'smart_default',
  }),
});

const ICONIC_CROWDS: QuestionDefinition = choice({
  id: 'iconic_crowds',
  module: 'tradeoffs',
  tier: 'core',
  kind: 'scenario',
  prompt: () => 'That famous place is genuinely special, but crowded.',
  why: () => 'This decides whether busy places are scheduled at all, and whether we push them to the quiet hours.',
  options: () => [
    { value: 'see_it_anyway', label: 'See it, even busy', detail: 'Popular is popular for a reason' },
    { value: 'go_at_odd_hours', label: 'Go at an inconvenient time to avoid the crowd', detail: 'Dawn or dusk, and we plan the day around it' },
    { value: 'quieter_alternative', label: 'Prefer the quieter alternative', detail: 'Trade some polish for room to breathe' },
  ],
  impacts: ['crowds', 'day_start', 'famous_vs_hidden'],
  burden: 1,
  criticality: 2,
  carriedFields: ['crowdTolerance'],
  relevance: () => 1,
  read: (answers) => answers.iconicCrowdStrategy,
  apply: (value) => {
    const strategy = String(value) as QuestionnaireAnswers['iconicCrowdStrategy'];
    if (strategy === 'see_it_anyway') return { iconicCrowdStrategy: strategy, crowdTolerance: 'dont_mind' };
    if (strategy === 'quieter_alternative') return { iconicCrowdStrategy: strategy, crowdTolerance: 'avoid_crowds' };
    return { iconicCrowdStrategy: 'go_at_odd_hours', crowdTolerance: 'avoid_crowds' };
  },
  smartDefault: () => ({ value: 'go_at_odd_hours', reason: "We'll put the famous places at the quiet ends of the day rather than skip them.", source: 'smart_default' }),
});

const FAMOUS_VS_HIDDEN: QuestionDefinition = choice({
  id: 'famous_vs_hidden',
  module: 'tradeoffs',
  tier: 'core',
  prompt: (ctx) => (t(ctx, 'dense_urban') ? 'Highlights, or neighbourhoods?' : 'Famous, or off the track?'),
  why: () => 'Both exist here. This sets the mix.',
  options: (ctx) =>
    t(ctx, 'dense_urban')
      ? [
          { value: 'mostly_classics', label: 'The landmarks', detail: 'Do not make me hunt' },
          { value: 'balanced', label: 'A real mix', detail: 'Landmarks plus a few local streets' },
          { value: 'mostly_hidden', label: 'Mostly neighbourhoods', detail: 'Where the city actually lives' },
          { value: 'deep_cuts', label: 'Deep cuts', detail: 'Send me where the guidebooks stop' },
        ]
      : [
          { value: 'mostly_classics', label: 'The famous ones', detail: 'Do not make me hunt' },
          { value: 'balanced', label: 'A real mix', detail: 'Highlights plus a few finds' },
          { value: 'mostly_hidden', label: 'Mostly hidden gems', detail: 'Trade some polish for quiet' },
          { value: 'deep_cuts', label: 'Deep cuts', detail: 'Send me where the guidebooks stop' },
        ],
  impacts: ['famous_vs_hidden'],
  burden: 1,
  criticality: 1,
  relevance: () => 0.8,
  read: (answers) => answers.discoveryMix,
  apply: (value) => ({ discoveryMix: (['mostly_classics', 'balanced', 'mostly_hidden', 'deep_cuts'].includes(String(value)) ? String(value) : 'balanced') as QuestionnaireAnswers['discoveryMix'] }),
  smartDefault: (_ctx, answers) => (answers.iconicCrowdStrategy === 'quieter_alternative' ? { value: 'mostly_hidden', reason: "You said you would take the quieter alternative, so we'll lean toward hidden gems.", source: 'smart_default' } : { value: 'balanced', reason: "We'll mix the famous places with a few quieter finds.", source: 'smart_default' }),
});

const FOOD_TRADEOFF: QuestionDefinition = choice({
  id: 'food_tradeoff',
  module: 'food',
  tier: 'core',
  kind: 'scenario',
  prompt: () => 'For dinner:',
  why: (ctx) => (t(ctx, 'food_dense') ? 'Meals get placed on the route you are already taking, and here they can be the route. This decides whether a day bends around a meal.' : 'Meals get placed on the route you are already taking. This decides whether a day bends around one.'),
  options: () => [
    { value: 'convenient', label: "Somewhere good near the day's route", detail: 'Local, casual, no detour' },
    { value: 'exceptional', label: 'Cross town for one excellent meal', detail: 'Happy to plan a day around dinner' },
    { value: 'fuel', label: 'Mostly fuel — spend on experiences instead', detail: 'Bakeries, markets, quick counters' },
  ],
  impacts: ['food_strategy', 'meal_frequency'],
  burden: 1,
  criticality: 2,
  carriedFields: ['foodImportance'],
  relevance: (ctx) => (t(ctx, 'food_dense') ? 1 : 0.8),
  read: (answers) => (answers.foodStyle === 'destination' ? 'exceptional' : answers.foodStyle === 'budget' ? 'fuel' : 'convenient'),
  apply: (value, _answers, ctx) => {
    if (value === 'exceptional') return { foodStyle: 'destination', specialMealAppetite: ctx.destination.tripDays >= 6 ? 'a_few' : 'one' };
    if (value === 'fuel') return { foodStyle: 'budget', specialMealAppetite: 'none', willPackLunch: true };
    return { foodStyle: 'local_casual', specialMealAppetite: 'one' };
  },
  smartDefault: (ctx) => (t(ctx, 'food_dense') ? { value: 'exceptional', reason: `Eating is a big part of ${ctx.destination.proseName}, so we'll plan one day around a meal worth crossing town for and keep the rest local.`, source: 'destination_prior' } : { value: 'convenient', reason: "We'll pick good local places on the route rather than detour for dinner.", source: 'smart_default' }),
});

const BUDGET: QuestionDefinition = {
  id: 'budget',
  module: 'budget',
  tier: 'core',
  kind: 'budget',
  prompt: () => 'What is the spending style?',
  why: () => 'Used for which paid things make the cut and how comfortable the beds are, not to pad a total. A rough envelope helps; exact accounting does not.',
  options: () => [
    { value: 'cheap', label: 'Keep it cheap', detail: 'Free stops and public land do the work' },
    { value: 'value', label: 'Good value', detail: 'Pay where it is clearly worth it' },
    { value: 'midrange', label: 'Mid-range', detail: 'Park fees, a gondola, a nice dinner are fine' },
    { value: 'premium', label: 'Premium', detail: 'Paid experiences whenever they are better' },
    { value: 'luxury', label: 'No ceiling', detail: 'Cost is not a filter' },
    { value: 'dont_know', label: "I don't know — optimise for good value", detail: 'We choose sensibly and say when something is a splurge' },
  ],
  impacts: ['budget', 'convenience', 'lodging'],
  hardCapable: false,
  burden: 2,
  criticality: 2,
  optional: true,
  carriedFields: ['budgetStyle'],
  relevance: () => 1,
  read: (answers) => ({ style: answers.provenance.budget?.reason?.includes('value') ? 'value' : answers.budgetStyle === 'budget' ? 'cheap' : answers.budgetStyle, envelope: answers.budgetEnvelope ?? null }),
  apply: (value) => {
    const raw = (value ?? {}) as { style?: string; envelope?: { amount?: number; basis?: string; currency?: string } | null };
    const style = raw.style ?? 'dont_know';
    const budgetStyle: BudgetStyle = style === 'cheap' ? 'budget' : style === 'premium' ? 'premium' : style === 'luxury' ? 'luxury' : 'midrange';
    const envelope = raw.envelope && typeof raw.envelope.amount === 'number' && raw.envelope.amount > 0
      ? { amount: Math.min(1_000_000, raw.envelope.amount), currency: (raw.envelope.currency ?? 'USD').slice(0, 3).toUpperCase().padEnd(3, 'D'), basis: (['per_person_per_day', 'per_person_trip', 'group_trip'].includes(String(raw.envelope.basis)) ? raw.envelope.basis : 'per_person_per_day') as NonNullable<QuestionnaireAnswers['budgetEnvelope']>['basis'] }
      : undefined;
    return { budgetStyle, ...(style === 'value' || style === 'cheap' ? { convenienceSpend: 'save_money' } : {}), ...(envelope ? { budgetEnvelope: envelope } : { budgetEnvelope: undefined }) };
  },
  smartDefault: () => ({ value: { style: 'dont_know', envelope: null }, reason: "We'll optimise for good value: mid-range choices, and we say when something is a splurge.", source: 'smart_default' }),
};

const CONVENIENCE_SPEND: QuestionDefinition = choice({
  id: 'convenience_spend',
  module: 'budget',
  tier: 'core',
  kind: 'scenario',
  prompt: () => 'When paying a bit more saves hassle:',
  why: () => 'This decides when the plan books a transfer, a timed entry or a nearer hotel instead of the cheaper, slower option.',
  options: () => [
    { value: 'save_money', label: 'Save the money, take the slower way', detail: 'Buses, walking, self-guided' },
    { value: 'balance', label: 'Balance it', detail: 'Pay when the saving is real' },
    { value: 'pay_to_reduce_hassle', label: 'Pay to reduce hassle', detail: 'Transfers, bookings, the closer bed' },
  ],
  impacts: ['convenience', 'guide_transfer', 'lodging'],
  burden: 1,
  criticality: 1,
  relevance: (ctx) => (t(ctx, 'remote') || t(ctx, 'guide_transfer_likely') || t(ctx, 'broad_geography') ? 1 : 0.7),
  read: (answers) => answers.convenienceSpend,
  apply: (value) => ({ convenienceSpend: (['save_money', 'balance', 'pay_to_reduce_hassle'].includes(String(value)) ? String(value) : 'balance') as QuestionnaireAnswers['convenienceSpend'], ...(value === 'pay_to_reduce_hassle' ? { privateTransfers: 'fine' as const } : {}) }),
  smartDefault: (_ctx, answers) => (answers.budgetStyle === 'budget' ? { value: 'save_money', reason: "You are keeping it cheap, so we'll take the slower, cheaper way where the difference is small.", source: 'smart_default' } : { value: 'balance', reason: "We'll pay for convenience only where the saving is real.", source: 'smart_default' }),
});

const DIETARY: QuestionDefinition = {
  id: 'dietary',
  module: 'food',
  tier: 'core',
  kind: 'dietary',
  prompt: () => 'Anything you do not eat?',
  why: () => 'Pick a way of eating, add anything you avoid, and write the rest. We only say a place can handle one of these when the place itself has published that it can.',
  options: () => DIETARY_NEEDS.map((need) => ({ value: need, label: DIETARY_NEED_LABELS[need], detail: DIETARY_NEED_KIND[need] })),
  impacts: ['food_strategy', 'hard_constraints'],
  hardCapable: true,
  burden: 1,
  criticality: 2,
  optional: true,
  /* V6 — asked of everyone, unless every named member already has a diet on record: then it is redundant, not wrong. */
  relevance: (ctx) => (ctx.traveller.party?.dietsRecorded ? 0.2 : 1),
  read: (answers) => ({ needs: answers.dietaryNeeds, strict: answers.dietaryStrict, notes: answers.dietaryNotes ?? '' }),
  /*
   * MVP V3, Stage 16 — a diet, any number of exclusions, and the traveller's
   * own words, all kept separately. Nothing here derives one from another: a
   * religion is never inferred from an ingredient, and an ingredient is never
   * inferred from a religion (`dietary.test.ts`).
   */
  apply: (value) => {
    const raw = (value ?? {}) as { needs?: unknown; strict?: unknown; notes?: unknown };
    const needs = (Array.isArray(raw.needs) ? raw.needs : []).filter((n): n is QuestionnaireAnswers['dietaryNeeds'][number] => (DIETARY_NEEDS as readonly string[]).includes(String(n)));
    const notes = typeof raw.notes === 'string' ? raw.notes.trim().slice(0, 300) : '';
    return {
      dietaryNeeds: [...new Set(needs)].sort(),
      // Free text alone can be a requirement: "severe peanut allergy" is not a preference.
      dietaryStrict: (needs.length > 0 || notes.length > 0) && raw.strict === true,
      dietaryNotes: notes.length > 0 ? notes : undefined,
    };
  },
  smartDefault: () => ({ value: { needs: [], strict: false, notes: '' }, reason: "We'll assume no dietary restrictions.", source: 'smart_default' }),
};

/** The hard-constraint chips, only the ones that could bind in this destination. */
export function hardConstraintOffer(ctx: InterviewContext, answers: QuestionnaireAnswers): { code: HardConstraintCode; label: string; detail: string; values?: { value: number; label: string }[] }[] {
  const d = ctx.destination;
  const offer: ReturnType<typeof hardConstraintOffer> = [];
  const road = hasTrait(d, 'road_trip_region') || hasTrait(d, 'mountain') || hasTrait(d, 'compact_country') || hasTrait(d, 'broad_geography') || d.traits.length === 0;
  if (road && answers.willDrive) {
    offer.push({ code: 'max_daily_drive_minutes', label: 'A hard ceiling on daily driving', detail: 'Days over it are reshaped, not warned about', values: [120, 180, 240].map((m) => ({ value: m, label: MINUTES_LABEL(m) })) });
  }
  if (road && answers.willDrive) offer.push({ code: 'cannot_drive', label: 'Nobody will be driving', detail: 'Removes every place with no way in but a drive' });
  offer.push({ code: 'max_walking_minutes', label: 'A ceiling on walking per day', detail: 'Total time on foot, including getting to things', values: [60, 120, 240].map((m) => ({ value: m, label: MINUTES_LABEL(m) })) });
  if (hasTrait(d, 'water_transfer') || hasTrait(d, 'island') || hasTrait(d, 'archipelago') || hasTrait(d, 'beach')) offer.push({ code: 'no_boats', label: 'No boats or ferries', detail: 'Anything only reached by water comes off' });
  if (hasTrait(d, 'internal_flight_likely') || hasTrait(d, 'archipelago') || hasTrait(d, 'wilderness')) offer.push({ code: 'no_small_aircraft', label: 'No small aircraft', detail: 'No charter or bush flights' });
  if (hasTrait(d, 'mountain') || hasTrait(d, 'wilderness') || chosenInterests(answers).includes('hiking')) offer.push({ code: 'no_strenuous_hiking', label: 'No strenuous hiking', detail: 'Caps every trail at moderate' });
  if (hasTrait(d, 'high_altitude') || ctx.traveller.travelerNeeds.includes('altitude_sensitive')) offer.push({ code: 'no_high_altitude', label: 'No high altitude', detail: 'Keeps the plan below the high passes' });
  if (hasTrait(d, 'remote') || hasTrait(d, 'wilderness') || hasTrait(d, 'road_trip_region')) offer.push({ code: 'no_remote_areas', label: 'Nowhere without signal or services', detail: 'Keeps every day near a town' });
  offer.push({ code: 'wheelchair_accessible', label: 'Everything wheelchair accessible', detail: 'Only stops with step-free access on record' });
  if (hasTrait(d, 'walk_heavy') || hasTrait(d, 'dense_urban') || ctx.traveller.travelerNeeds.includes('seniors_in_group')) offer.push({ code: 'no_stairs', label: 'No stairs', detail: 'Lifts and level routes only' });
  offer.push({ code: 'must_be_back_by', label: 'Back at base by a set hour', detail: 'Every day ends by this time', values: [18 * 60, 20 * 60, 22 * 60].map((m) => ({ value: m, label: `${String(Math.floor(m / 60)).padStart(2, '0')}:00` })) });
  offer.push({ code: 'no_early_starts', label: 'No early starts', detail: 'Nothing before a relaxed morning' });
  if (hasTrait(d, 'nightlife_dense') || hasTrait(d, 'dense_urban')) offer.push({ code: 'no_late_nights', label: 'No late nights', detail: 'Evenings end early' });
  if (hasTrait(d, 'multi_base_likely') || hasTrait(d, 'broad_geography') || hasTrait(d, 'archipelago')) offer.push({ code: 'no_hotel_changes', label: 'One base for the whole trip', detail: 'No packing up mid-trip' });
  return offer;
}

const HARD_CONSTRAINTS: QuestionDefinition = {
  id: 'hard_constraints',
  module: 'hard_constraints',
  tier: 'core',
  kind: 'hard_constraints',
  prompt: () => 'Anything that must not happen?',
  why: () => 'These are filters, not preferences: the plan is reshaped around them rather than warned about them. Free text stays a preference unless you tick that it is a hard requirement.',
  options: (ctx, answers) => hardConstraintOffer(ctx, answers).map((entry) => ({ value: entry.code, label: entry.label, detail: entry.detail })),
  impacts: ['hard_constraints', 'driving', 'walking', 'ferry', 'flight', 'effort', 'accessibility', 'day_start', 'hotel_switching', 'remote_logistics'],
  hardCapable: true,
  burden: 2,
  criticality: 3,
  optional: true,
  relevance: () => 1,
  read: (answers) => ({ constraints: answers.hardConstraints.filter((c) => c.code !== 'must_include' && c.code !== 'must_avoid'), notes: answers.hardNotes ?? '', notesAreHard: Boolean(answers.hardNotes) }),
  apply: (value, answers) => {
    const raw = (value ?? {}) as { constraints?: unknown; notes?: unknown; notesAreHard?: unknown };
    const kept = answers.hardConstraints.filter((c) => c.code === 'must_include' || c.code === 'must_avoid');
    const incoming = (Array.isArray(raw.constraints) ? raw.constraints : []) as HardConstraint[];
    const cleaned: HardConstraint[] = incoming
      .filter((c) => c && typeof c === 'object' && (Object.keys(HARD_CONSTRAINT_LABELS) as string[]).includes(String(c.code)))
      .map((c) => ({ code: c.code, ...(typeof c.value === 'number' ? { value: Math.max(0, Math.min(1440, Math.round(c.value))) } : {}), ...(typeof c.text === 'string' && c.text.trim() ? { text: c.text.trim().slice(0, 160) } : {}) }));
    const notes = typeof raw.notes === 'string' ? raw.notes.trim().slice(0, 500) : '';
    const hard = raw.notesAreHard === true && notes.length > 0;
    return {
      hardConstraints: [...kept, ...cleaned],
      hardNotes: hard ? notes : undefined,
      // Soft notes stay soft: they travel as accessibility notes, never as a filter.
      accessibilityNotes: !hard && notes.length > 0 ? notes : answers.accessibilityNotes,
    };
  },
  smartDefault: () => ({ value: { constraints: [], notes: '', notesAreHard: false }, reason: "We'll assume nothing is off-limits beyond what you have already told us.", source: 'smart_default' }),
};

// ---------------------------------------------------------------------------
// Destination modules
// ---------------------------------------------------------------------------

const WALKING_TOLERANCE: QuestionDefinition = choice({
  id: 'walking_tolerance',
  module: 'urban_mobility',
  tier: 'destination',
  prompt: (ctx) => `How much of ${ctx.destination.proseName} do you want to experience on foot?`,
  why: () => "Walking is how a city is actually seen, and it is also the effort budget. This sets how far apart a day's stops may be.",
  options: () => [
    { value: 'lots', label: 'As much as possible', detail: 'Whole neighbourhoods on foot, rides only to cross town' },
    { value: 'moderate', label: 'A comfortable amount', detail: 'A few miles a day, then a ride' },
    { value: 'little', label: 'Keep it short', detail: 'Ride between stops, walk inside them' },
  ],
  impacts: ['walking', 'effort', 'transportation_mode'],
  burden: 1,
  criticality: 2,
  relevance: (ctx) => (t(ctx, 'walk_heavy') || t(ctx, 'dense_urban') ? 1 : 0),
  read: (answers) => answers.walkingTolerance,
  apply: (value) => {
    const tolerance = (['lots', 'moderate', 'little'].includes(String(value)) ? String(value) : 'moderate') as QuestionnaireAnswers['walkingTolerance'];
    return { walkingTolerance: tolerance, maxAccessWalkMinutes: tolerance === 'lots' ? 45 : tolerance === 'little' ? 10 : 25 };
  },
  smartDefault: (ctx) => (ctx.traveller.travelerNeeds.includes('seniors_in_group') || ctx.traveller.travelerNeeds.includes('mobility_limited') ? { value: 'little', reason: "We'll keep walking short for the group you described and ride between stops.", source: 'smart_default' } : { value: 'moderate', reason: "We'll plan a comfortable amount on foot — a few miles a day — and ride to cross town.", source: 'smart_default' }),
});

const TRANSIT_COMFORT: QuestionDefinition = choice({
  id: 'transit_comfort',
  module: 'urban_mobility',
  tier: 'destination',
  prompt: () => 'When there is more than one way across town:',
  why: () => 'Orders the options the transport data supports. It never makes an impossible one possible.',
  options: () => [
    { value: 'cheapest', label: 'Ride the network, whatever it takes', detail: 'Cheapest, and part of the experience' },
    { value: 'best_value', label: 'Public transport when it is simple', detail: 'A taxi when the change is awkward' },
    { value: 'least_stressful', label: 'Taxis and rideshare, mostly', detail: 'Least stressful, whatever it costs' },
  ],
  impacts: ['transportation_mode', 'convenience'],
  burden: 1,
  criticality: 1,
  dependsOn: ['transport_mode'],
  relevance: (ctx, answers) => (!answers.willDrive && (t(ctx, 'transit_rich') || t(ctx, 'dense_urban')) ? 1 : 0),
  read: (answers) => answers.transportPriority,
  apply: (value) => ({ transportPriority: (['cheapest', 'best_value', 'least_stressful'].includes(String(value)) ? String(value) : 'best_value') as QuestionnaireAnswers['transportPriority'], ...(value === 'least_stressful' ? { privateTransfers: 'fine' as const } : {}) }),
  smartDefault: () => ({ value: 'best_value', reason: "We'll use public transport when it is simple and a taxi when the change is awkward.", source: 'smart_default' }),
});

const DAY_TRIPS: QuestionDefinition = choice({
  id: 'day_trips',
  module: 'urban_mobility',
  tier: 'destination',
  prompt: (ctx) => `City immersion, or day trips out of ${ctx.destination.proseName}?`,
  why: () => 'A day out costs a day in. This sets how far from the city the plan may look.',
  options: (ctx) => [
    { value: 'stay_in_city', label: 'Stay in the city', detail: 'Every day inside it' },
    { value: 'one_day_trip', label: 'One day out', detail: 'A single trip somewhere worth the journey' },
    { value: 'several', label: 'Several day trips', detail: ctx.destination.tripDays >= 6 ? 'The city as a base for the region' : 'Trade city days for the region' },
  ],
  impacts: ['regional_expansion', 'detour', 'scope', 'day_density'],
  burden: 1,
  criticality: 2,
  relevance: (ctx) => (t(ctx, 'dense_urban') && ctx.destination.tripDays >= 3 ? 1 : 0),
  read: (answers) => answers.dayTripAppetite,
  apply: (value, answers, ctx) => {
    const appetite = (['stay_in_city', 'one_day_trip', 'several'].includes(String(value)) ? String(value) : 'one_day_trip') as QuestionnaireAnswers['dayTripAppetite'];
    const wanted: RegionalExpansion = appetite === 'stay_in_city' ? 'destination_only' : appetite === 'several' ? 'nearby_120' : 'nearby_60';
    const allowed = availableRegionalExpansions(answers.willDrive, undefined);
    const expansion = allowed.includes(wanted) ? wanted : allowed[allowed.length - 1]!;
    void ctx;
    return { dayTripAppetite: appetite, regionalExpansion: expansion, detourToleranceMinutes: appetite === 'stay_in_city' ? 0 : Math.min(180, EXPANSION_CEILING_MINUTES[expansion]) };
  },
  smartDefault: (ctx) => (ctx.destination.tripDays >= 4 ? { value: 'one_day_trip', reason: `With ${ctx.destination.tripDays} days we'll keep one day for a trip out and the rest in the city.`, source: 'smart_default' } : { value: 'stay_in_city', reason: `${ctx.destination.tripDays} days is a city trip; we'll stay inside it.`, source: 'smart_default' }),
});

const LATE_NIGHTS: QuestionDefinition = choice({
  id: 'late_nights',
  module: 'urban_mobility',
  tier: 'destination',
  prompt: () => 'How late do the evenings go?',
  why: () => 'Late nights and early starts do not share a day. This keeps the plan from asking for both.',
  options: () => [
    { value: 'fine', label: 'Late is fine', detail: 'Evenings are part of the trip' },
    { value: 'sometimes', label: 'Sometimes', detail: 'A late night or two, not before an early start' },
    { value: 'no', label: 'Early nights', detail: 'Dinner, then done' },
  ],
  impacts: ['day_start', 'day_density'],
  burden: 1,
  criticality: 1,
  relevance: (ctx) => (t(ctx, 'nightlife_dense') ? 1 : t(ctx, 'dense_urban') ? 0.5 : 0),
  read: (answers) => answers.lateNights,
  apply: (value) => ({ lateNights: (['fine', 'sometimes', 'no'].includes(String(value)) ? String(value) : 'sometimes') as QuestionnaireAnswers['lateNights'] }),
  smartDefault: (_ctx, answers) => (answers.dayStart === 'early' ? { value: 'no', reason: "You start early, so we'll keep the evenings short.", source: 'smart_default' } : { value: 'sometimes', reason: "We'll allow a late night or two, never before an early start.", source: 'smart_default' }),
});

const STAIRS_HILLS: QuestionDefinition = choice({
  id: 'stairs_hills',
  module: 'urban_mobility',
  tier: 'destination',
  prompt: () => 'Stairs and steep streets:',
  why: () => 'Some of the best views here are up a lot of steps. This decides whether they are offered.',
  options: () => [
    { value: 'fine', label: 'Fine', detail: 'Steps are part of it' },
    { value: 'prefer_not', label: 'Rather not', detail: 'Offer the lift or the flat route where one exists' },
    { value: 'cannot', label: 'Cannot', detail: 'Level access only — a hard rule' },
  ],
  impacts: ['accessibility', 'walking', 'hard_constraints'],
  hardCapable: true,
  burden: 1,
  criticality: 2,
  relevance: (ctx) => ((t(ctx, 'walk_heavy') && (t(ctx, 'mountain') || t(ctx, 'island'))) || ctx.traveller.travelerNeeds.includes('seniors_in_group') || ctx.traveller.travelerNeeds.includes('mobility_limited') ? 1 : 0),
  read: (answers) => answers.stairsAndHills,
  apply: (value) => ({ stairsAndHills: (['fine', 'prefer_not', 'cannot'].includes(String(value)) ? String(value) : 'fine') as QuestionnaireAnswers['stairsAndHills'] }),
  smartDefault: (ctx) => (ctx.traveller.travelerNeeds.includes('mobility_limited') ? { value: 'cannot', reason: 'You told us somebody has limited mobility, so level access is a rule.', source: 'smart_default' } : { value: 'prefer_not', reason: "We'll offer the lift or the flat route where one exists.", source: 'smart_default' }),
});

const DAILY_DRIVING: QuestionDefinition = choice({
  id: 'daily_driving',
  module: 'road_trip',
  tier: 'destination',
  prompt: () => 'Most you want to spend at the wheel in a day?',
  why: () => 'Round trip, driving only. Days over it are reshaped; time on a shuttle counts separately.',
  options: (ctx) => [
    { value: '90', label: 'Up to 1½ hours', detail: 'Close to base' },
    { value: '150', label: 'Up to 2½ hours', detail: 'A comfortable day' },
    { value: '240', label: 'Up to 4 hours', detail: 'For something worth it' },
    { value: '360', label: 'Whatever the route needs', detail: t(ctx, 'broad_geography') ? 'Long transfer days are part of covering ground' : 'Long days, big country' },
  ],
  impacts: ['driving', 'scope', 'base_count', 'detour'],
  burden: 1,
  criticality: 2,
  dependsOn: ['transport_mode'],
  relevance: (ctx, answers) => (answers.willDrive && ctx.traveller.party?.drivers !== 0 && (t(ctx, 'road_trip_region') || t(ctx, 'mountain') || t(ctx, 'compact_country') || t(ctx, 'broad_geography') || t(ctx, 'remote') || ctx.destination.traits.length === 0) ? 1 : 0),
  read: (answers) => String([90, 150, 240, 360].reduce((best, m) => (Math.abs(m - answers.maxDailyTravelMinutes) < Math.abs(best - answers.maxDailyTravelMinutes) ? m : best), 150)),
  apply: (value) => ({ maxDailyTravelMinutes: Math.max(30, Math.min(480, Number(value) || 150)) }),
  smartDefault: (ctx) => (t(ctx, 'broad_geography') || t(ctx, 'remote') ? { value: '240', reason: `Distances around ${ctx.destination.proseName} are long, so we'll allow up to four hours on the days that need it and keep the others short.`, source: 'destination_prior' } : { value: '150', reason: "We'll keep driving to about two and a half hours a day, round trip.", source: 'smart_default' }),
});

const ROAD_COMFORT: QuestionDefinition = choice({
  id: 'road_comfort',
  module: 'road_trip',
  tier: 'destination',
  prompt: () => 'What kind of roads are you happy to drive?',
  why: () => 'In some regions the last few miles to the good stuff are a pass or a graded track. This decides whether they are offered.',
  options: () => [
    { value: 'paved', label: 'Paved only', detail: 'Main roads, no drop-offs' },
    { value: 'mountain', label: 'Mountain passes are fine', detail: 'Switchbacks and drop-offs, on tarmac' },
    { value: 'gravel', label: 'Passes and graded gravel are fine', detail: 'The last miles to a trailhead or a spring' },
  ],
  impacts: ['accessibility', 'detour', 'remote_logistics'],
  burden: 1,
  criticality: 2,
  dependsOn: ['transport_mode'],
  relevance: (ctx, answers) => (answers.willDrive && ctx.traveller.party?.drivers !== 0 && (t(ctx, 'mountain') || t(ctx, 'remote') || t(ctx, 'wilderness') || t(ctx, 'winter_access')) ? 1 : 0),
  read: (answers) => (answers.comfortableGravelRoads ? 'gravel' : answers.comfortableMountainRoads ? 'mountain' : 'paved'),
  apply: (value) => ({ comfortableMountainRoads: value !== 'paved', comfortableGravelRoads: value === 'gravel' }),
  smartDefault: (ctx) => (t(ctx, 'winter_access') ? { value: 'paved', reason: "Your dates fall in the winter season, so we'll keep to paved, maintained roads unless you say otherwise.", source: 'destination_prior' } : { value: 'mountain', reason: "We'll assume mountain passes on tarmac are fine and keep off gravel unless you say otherwise.", source: 'smart_default' }),
});

const SCENIC_REACH: QuestionDefinition = choice({
  id: 'scenic_reach',
  module: 'road_trip',
  tier: 'destination',
  prompt: (ctx) => `How far down the broader region around ${ctx.destination.proseName} should Sidequest look?`,
  why: () => 'The best of a region is rarely all in one place. This sets the search radius and how long a single detour may be.',
  options: (ctx, answers) => {
    const allowed = availableRegionalExpansions(answers.willDrive, undefined);
    const all: InterviewOption[] = [
      { value: 'destination_only', label: `${ctx.destination.name} itself`, detail: 'Keep it tight' },
      { value: 'nearby_30', label: 'Within about 30 minutes', detail: 'Whatever is on the doorstep' },
      { value: 'nearby_60', label: 'Within about an hour', detail: 'A comfortable day out' },
      { value: 'nearby_120', label: 'Up to two hours, for something special', detail: 'A long day, labelled as one' },
      { value: 'best_regional', label: `Best of ${ctx.destination.proseName}, wherever it leads`, detail: 'Restructure the trip if it is worth it' },
    ];
    return all.filter((option) => allowed.includes(option.value as RegionalExpansion));
  },
  impacts: ['regional_expansion', 'detour', 'scope', 'base_count'],
  burden: 1,
  criticality: 2,
  relevance: (ctx) => (t(ctx, 'dense_urban') || t(ctx, 'broad_geography') ? 0 : t(ctx, 'road_trip_region') || t(ctx, 'mountain') || t(ctx, 'compact_country') || t(ctx, 'island') ? 1 : 0.6),
  read: (answers) => answers.regionalExpansion,
  apply: (value, answers) => {
    const wanted = (REGIONAL_EXPANSIONS as readonly string[]).includes(String(value)) ? (String(value) as RegionalExpansion) : 'nearby_60';
    const allowed = availableRegionalExpansions(answers.willDrive, undefined);
    const expansion = allowed.includes(wanted) ? wanted : allowed[allowed.length - 1]!;
    return { regionalExpansion: expansion, detourToleranceMinutes: expansion === 'destination_only' ? 0 : Math.min(180, EXPANSION_CEILING_MINUTES[expansion]) };
  },
  smartDefault: (ctx, answers) => (answers.willDrive && ctx.destination.tripDays >= 4 ? { value: 'nearby_120', reason: `With a car and ${ctx.destination.tripDays} days we'll reach up to two hours out for the things worth it, and label those days as long ones.`, source: 'destination_prior' } : { value: 'nearby_60', reason: "We'll look up to about an hour from base.", source: 'smart_default' }),
});

const BASE_MOVES: QuestionDefinition = choice({
  id: 'base_moves',
  module: 'road_trip',
  tier: 'destination',
  kind: 'scenario',
  // PRODUCT RECOVERY V1 — a preference, not a claim. Nothing is measured at interview time, so no saving is stated.
  prompt: () => 'Would you change hotels when it meaningfully reduces backtracking?',
  why: () => 'This decides the route architecture: one base with longer days out, or a moving route with shorter ones. Sidequest measures the actual saving when it builds the trip.',
  options: () => [
    { value: 'move_once', label: 'Once, if it helps', detail: 'One change is fine when it clearly saves time' },
    { value: 'stay_put', label: 'Stay put', detail: 'One base, even if two days run longer' },
    { value: 'move_if_it_saves_time', label: 'Only when the saving is clear', detail: 'Decide by how much time a move saves' },
    { value: 'move_freely', label: 'As often as the route wants', detail: 'A circuit, a new bed most nights' },
  ],
  impacts: ['hotel_switching', 'base_count', 'trip_archetype', 'driving'],
  burden: 1,
  criticality: 2,
  carriedFields: ['shape'],
  relevance: (ctx) => (ctx.destination.tripDays >= 4 && (t(ctx, 'multi_base_likely') || t(ctx, 'broad_geography') || t(ctx, 'archipelago') || t(ctx, 'compact_country') || t(ctx, 'road_trip_region')) && !t(ctx, 'dense_urban') ? 1 : 0),
  read: (answers) => answers.baseMoveTolerance,
  apply: (value) => ({ baseMoveTolerance: (['stay_put', 'move_once', 'move_if_it_saves_time', 'move_freely'].includes(String(value)) ? String(value) : 'move_if_it_saves_time') as QuestionnaireAnswers['baseMoveTolerance'] }),
  smartDefault: (ctx) => (t(ctx, 'broad_geography') || t(ctx, 'archipelago') ? { value: 'move_freely', reason: `${ctx.destination.proseName} is too spread out for one bed; we'll move when the route wants it.`, source: 'destination_prior' } : { value: 'move_if_it_saves_time', reason: "We'll move hotels only when it clearly saves time.", source: 'smart_default' }),
});

const GUIDE_WILLINGNESS: QuestionDefinition = choice({
  id: 'guide_willingness',
  module: 'remote_wilderness',
  tier: 'destination',
  prompt: () => 'Guides and organised days:',
  why: (ctx) => `Some of ${ctx.destination.proseName} cannot be reached, or should not be attempted, without one. This decides whether those days are offered.`,
  options: () => [
    { value: 'prefer', label: 'Prefer guided', detail: 'Let someone who knows it lead' },
    { value: 'sometimes', label: 'Where it earns its place', detail: 'Guided for the hard days, self-led for the rest' },
    { value: 'avoid', label: 'Avoid', detail: 'Self-guided wherever it is possible' },
  ],
  impacts: ['guide_transfer', 'remote_logistics', 'convenience'],
  burden: 1,
  criticality: 3,
  relevance: (ctx) => (t(ctx, 'guide_transfer_likely') || t(ctx, 'wilderness') || t(ctx, 'remote') ? 1 : 0),
  read: (answers) => answers.guideWillingness,
  apply: (value) => ({ guideWillingness: (['prefer', 'sometimes', 'avoid'].includes(String(value)) ? String(value) : 'sometimes') as QuestionnaireAnswers['guideWillingness'] }),
  smartDefault: (ctx, answers) =>
    answers.guideWillingness === 'prefer'
      ? { value: 'prefer', reason: `You chose guided travel, so we'll lean on guides across ${ctx.destination.proseName}.`, source: 'smart_default' }
      : { value: 'sometimes', reason: `We'll use guides for the parts of ${ctx.destination.proseName} that need one and leave the rest self-led.`, source: 'destination_prior' },
});

const PRIVATE_TRANSFERS: QuestionDefinition = choice({
  id: 'private_transfers',
  module: 'remote_wilderness',
  tier: 'destination',
  prompt: () => 'Are you comfortable with transfers Sidequest may not be able to independently route?',
  why: () => 'Lodge boats, charter legs and arranged 4×4 transfers are real, but nobody publishes a timetable we can check. We can plan around them, marked as unverified, or leave them out.',
  options: () => [
    { value: 'fine', label: 'Yes, plan around them', detail: 'Marked as unverified until confirmed locally' },
    { value: 'if_needed', label: 'Only where nothing else works', detail: 'Prefer legs we can measure' },
    { value: 'avoid', label: 'Leave them out', detail: 'Only legs Sidequest can verify' },
  ],
  impacts: ['guide_transfer', 'remote_logistics', 'convenience'],
  burden: 1,
  criticality: 2,
  relevance: (ctx) => (t(ctx, 'guide_transfer_likely') || t(ctx, 'wilderness') ? 1 : t(ctx, 'remote') || t(ctx, 'water_transfer') ? 0.7 : 0),
  read: (answers) => answers.privateTransfers,
  apply: (value) => ({ privateTransfers: (['fine', 'if_needed', 'avoid'].includes(String(value)) ? String(value) : 'if_needed') as QuestionnaireAnswers['privateTransfers'] }),
  smartDefault: (ctx) => ({ value: 'fine', reason: `Getting into the remote parts of ${ctx.destination.proseName} means arranged transfers; we'll plan around them and mark each one as unverified until it is confirmed.`, source: 'destination_prior' }),
});

const REMOTE_COMFORT: QuestionDefinition = choice({
  id: 'remote_comfort',
  module: 'remote_wilderness',
  tier: 'destination',
  prompt: () => 'Days with no phone signal, no shops and a long way to help:',
  why: () => 'This decides whether the far places are offered at all, and how self-sufficient each day has to be.',
  options: () => [
    { value: 'fine', label: 'Fine', detail: 'That is part of why we are going' },
    { value: 'prefer_not', label: 'Rather not', detail: 'Keep most days near a town' },
    { value: 'cannot', label: 'Cannot', detail: 'Never out of reach of services — a hard rule' },
  ],
  impacts: ['remote_logistics', 'hard_constraints', 'scope'],
  hardCapable: true,
  burden: 1,
  criticality: 3,
  relevance: (ctx) => (t(ctx, 'remote') || t(ctx, 'wilderness') ? 1 : 0),
  read: (answers) => answers.remoteComfort,
  apply: (value) => ({ remoteComfort: (['fine', 'prefer_not', 'cannot'].includes(String(value)) ? String(value) : 'fine') as QuestionnaireAnswers['remoteComfort'] }),
  smartDefault: (ctx) => (ctx.traveller.children > 0 || ctx.traveller.travelerNeeds.length > 0 ? { value: 'prefer_not', reason: "With the group you described we'll keep most days within reach of a town.", source: 'smart_default' } : { value: 'fine', reason: "We'll assume days out of signal are part of the point, and say plainly which ones they are.", source: 'destination_prior' }),
});

const RUSTIC_LODGING: QuestionDefinition = choice({
  id: 'rustic_lodging',
  module: 'remote_wilderness',
  tier: 'destination',
  prompt: () => 'Homestays, camps and simple lodges:',
  why: () => 'In remote places the only bed near the good stuff is often a simple one. This decides whether the plan may use it.',
  options: () => [
    { value: 'yes', label: 'Happily', detail: 'A yurt, a homestay, a tented camp' },
    { value: 'no', label: 'Rather not', detail: 'Proper hotels, even if the day gets longer' },
  ],
  impacts: ['lodging', 'base_count', 'remote_logistics'],
  burden: 1,
  criticality: 1,
  /* V8.1 — in mountain country the bed near the trailhead is a hut, a camp or a lodge; the question is whether the plan may use one. */
  relevance: (ctx) => (t(ctx, 'remote') || t(ctx, 'wilderness') || t(ctx, 'mountain') ? 1 : 0),
  read: (answers) => (answers.rusticLodgingOk ? 'yes' : 'no'),
  apply: (value, answers) => ({ rusticLodgingOk: value !== 'no', ...(value !== 'no' && answers.lodgingStyle === 'no_preference' ? { lodgingStyle: 'nature_lodge' as const } : {}) }),
  smartDefault: () => ({ value: 'yes', reason: "We'll assume a simple bed near the good stuff beats a hotel two hours away.", source: 'destination_prior' }),
});

const BOATS_FERRIES: QuestionDefinition = choice({
  id: 'boats_ferries',
  module: 'island_water',
  tier: 'destination',
  prompt: () => 'Boats and ferries:',
  why: (ctx) => `Some of ${ctx.destination.proseName} only opens up by water. We leave it out if you would rather not.`,
  options: () => [
    { value: 'fine', label: 'Fine', detail: 'Part of the trip' },
    { value: 'prefer_not', label: 'Rather not', detail: 'Short crossings only, if at all' },
    { value: 'cannot', label: 'Cannot', detail: 'No boats — a hard rule' },
  ],
  impacts: ['ferry', 'scope', 'hard_constraints'],
  hardCapable: true,
  burden: 1,
  criticality: 2,
  relevance: (ctx) => (t(ctx, 'water_transfer') || t(ctx, 'archipelago') || t(ctx, 'island') ? 1 : 0),
  read: (answers) => answers.boatsAndFerries,
  apply: (value) => ({ boatsAndFerries: (['fine', 'prefer_not', 'cannot'].includes(String(value)) ? String(value) : 'fine') as QuestionnaireAnswers['boatsAndFerries'], willUseShuttles: value !== 'cannot' }),
  smartDefault: () => ({ value: 'fine', reason: "We'll assume boats are fine and say which days depend on one.", source: 'destination_prior' }),
});

const INTERNAL_FLIGHTS: QuestionDefinition = choice({
  id: 'internal_flights',
  module: 'island_water',
  tier: 'destination',
  prompt: () => 'Short internal flights:',
  why: () => 'A one-hour hop can replace a day of driving or a night at sea. This decides whether the plan may use one.',
  options: () => [
    { value: 'fine', label: 'Fine', detail: 'Use them where they save a day' },
    { value: 'prefer_not', label: 'Rather not', detail: 'Only if there is no reasonable alternative' },
    { value: 'cannot', label: 'Cannot', detail: 'No small aircraft — a hard rule' },
  ],
  impacts: ['flight', 'scope', 'base_count', 'hard_constraints'],
  hardCapable: true,
  burden: 1,
  criticality: 1,
  /*
   * PRODUCT RECOVERY V1 — asked only when the destination's own extent makes an
   * internal flight a real planning decision (`internal_flight_likely`: about
   * 900 km across, or islands hundreds of km apart, or a scope that accepts
   * air transfers). A broad country like Ireland is not one; it was asked.
   */
  relevance: (ctx) => (t(ctx, 'internal_flight_likely') ? 1 : 0),
  read: (answers) => answers.internalFlights,
  apply: (value) => ({ internalFlights: (['fine', 'prefer_not', 'cannot'].includes(String(value)) ? String(value) : 'fine') as QuestionnaireAnswers['internalFlights'] }),
  smartDefault: () => ({ value: 'fine', reason: "We'll use a short flight where it saves a whole day, and say so.", source: 'destination_prior' }),
});

const HIKE_APPETITE: QuestionDefinition = choice({
  id: 'hike_appetite',
  module: 'altitude_outdoor',
  tier: 'destination',
  kind: 'scenario',
  prompt: () => 'Which sounds better?',
  why: () => 'Length and effort of a hike are a different question from how often. This caps the trail, not the count.',
  options: () => [
    { value: 'full_day', label: 'One unforgettable four-hour hike', detail: 'Elevation gain, a summit or a lake at the end' },
    { value: 'half_day', label: 'A couple of hours out, then lunch', detail: 'Real trail, back by early afternoon' },
    { value: 'short', label: 'Three easy scenic stops', detail: 'Short walks from the car park' },
    { value: 'none', label: 'No real hikes', detail: 'Viewpoints and easy paths only' },
  ],
  /* V8.1 — `scope` too: a full-day hike decides how far that day can reach. */
  impacts: ['effort', 'activity_frequency', 'day_density', 'scope'],
  burden: 1,
  /* V8.1 — criticality 2: in a mountain region the length of the trail decides the shape of most days, and the trail-setting question depends on it. */
  criticality: 2,
  relevance: (ctx, answers) => (chosenInterests(answers).includes('hiking') || t(ctx, 'mountain') || t(ctx, 'wilderness') ? 1 : 0),
  read: (answers) => answers.hikeAppetite,
  apply: (value, answers) => {
    const appetite = (['none', 'short', 'half_day', 'full_day'].includes(String(value)) ? String(value) : 'half_day') as QuestionnaireAnswers['hikeAppetite'];
    const interests = { ...answers.interests };
    if (appetite === 'none') interests.hiking = 'avoid';
    else if ((interests.hiking ?? 'low') === 'low' || interests.hiking === 'avoid') interests.hiking = appetite === 'full_day' ? 'frequent' : 'occasional';
    return { hikeAppetite: appetite, interests, avoidances: appetite === 'short' || appetite === 'none' ? [...new Set([...answers.avoidances, 'long_hikes' as const])] : answers.avoidances.filter((a) => a !== 'long_hikes') };
  },
  smartDefault: (_ctx, answers) => (answers.dailyIntensity === 'intense' ? { value: 'full_day', reason: 'You asked for intense days, so one full-day hike is on the table.', source: 'smart_default' } : answers.dailyIntensity === 'light' ? { value: 'short', reason: 'Light days mean short walks from the car park rather than a real trail.', source: 'smart_default' } : { value: 'half_day', reason: "We'll allow a half-day hike and keep the rest of that day easy.", source: 'smart_default' }),
});

const ALTITUDE_COMFORT: QuestionDefinition = choice({
  id: 'altitude_comfort',
  module: 'altitude_outdoor',
  tier: 'destination',
  prompt: () => 'High altitude:',
  why: (ctx) => `Parts of ${ctx.destination.proseName} sit high enough to matter. This sets how the first days are paced and whether the high passes are offered.`,
  options: () => [
    { value: 'fine', label: 'Fine', detail: 'Been high before, no trouble' },
    { value: 'take_it_slow', label: 'Take it slow', detail: 'Easy first days, sleep low, climb gradually' },
    { value: 'avoid_high', label: 'Avoid the high places', detail: 'Keep the plan below the passes — a hard rule' },
  ],
  impacts: ['effort', 'day_density', 'hard_constraints', 'scope'],
  hardCapable: true,
  burden: 1,
  criticality: 2,
  /* V8.1 — a mountain region exposes the traveller to elevation whether or not a compiled region has measured a peak yet. */
  relevance: (ctx) => (t(ctx, 'high_altitude') || t(ctx, 'mountain') || ctx.traveller.travelerNeeds.includes('altitude_sensitive') ? 1 : 0),
  read: (answers) => answers.altitudeComfort,
  apply: (value) => ({ altitudeComfort: (['fine', 'take_it_slow', 'avoid_high'].includes(String(value)) ? String(value) : 'fine') as QuestionnaireAnswers['altitudeComfort'] }),
  smartDefault: (ctx) => (ctx.traveller.travelerNeeds.includes('altitude_sensitive') ? { value: 'take_it_slow', reason: 'You told us somebody is sensitive to altitude, so the first days stay low and easy.', source: 'smart_default' } : { value: 'take_it_slow', reason: "We'll pace the first days for the altitude — easy starts, sleeping low — which costs nothing if you turn out to be fine.", source: 'destination_prior' }),
});

/**
 * V8.1 — TWO QUESTIONS ONLY A MOUNTAIN OR WILDERNESS REGION EARNS.
 *
 * "The Canadian Rockies" used to be interviewed like a city because the
 * geocoder had resolved it to one (`.claude-private/V8.1-DESTINATION-FAILURE.md`).
 * With the semantic reading in place the `mountain`/`wilderness` traits are
 * real, and the questions that change a mountain plan most are where the
 * trail starts and ends, and whether the permit-bound days shape the trip.
 */
const TRAIL_SETTING: QuestionDefinition = choice({
  id: 'trail_setting',
  module: 'altitude_outdoor',
  tier: 'destination',
  kind: 'scenario',
  prompt: () => 'Front-country or backcountry?',
  why: (ctx) => `In ${ctx.destination.proseName} the same mountain offers a marked trail from a car park and a two-day approach to a hut. This decides which kind of day the plan may build.`,
  options: () => [
    { value: 'frontcountry', label: 'Front-country', detail: 'Marked trails, car parks, back by dinner' },
    { value: 'mixed', label: 'Mostly front-country', detail: 'With one bigger day if it earns its place' },
    { value: 'backcountry', label: 'Backcountry', detail: 'Huts, long approaches, real remoteness' },
  ],
  impacts: ['effort', 'remote_logistics', 'lodging'],
  burden: 1,
  criticality: 2,
  /* Asked once the trail length is known: where a day starts and ends only makes sense after how long it is. */
  dependsOn: ['hike_appetite'],
  relevance: (ctx) => (t(ctx, 'mountain') || t(ctx, 'wilderness') ? 1 : 0),
  read: (answers) => answers.trailSetting,
  apply: (value, answers) => {
    const setting = (['frontcountry', 'mixed', 'backcountry'].includes(String(value)) ? String(value) : 'mixed') as QuestionnaireAnswers['trailSetting'];
    return {
      trailSetting: setting,
      /* A backcountry day is a hut or a camp by definition; a front-country-only traveller has said nothing about beds. */
      ...(setting === 'backcountry' ? { rusticLodgingOk: true } : {}),
      ...(setting === 'frontcountry' && answers.hikeAppetite === 'full_day' ? { hikeAppetite: 'half_day' as const } : {}),
    };
  },
  smartDefault: (_ctx, answers) =>
    answers.hikeAppetite === 'full_day' && answers.rusticLodgingOk
      ? { value: 'mixed', reason: 'You want a real hike and a simple bed is fine, so one bigger day with a hut or camp is on the table; the rest stays front-country.', source: 'smart_default' }
      : answers.hikeAppetite === 'none' || answers.hikeAppetite === 'short'
        ? { value: 'frontcountry', reason: 'Short walks from the car park keep every day front-country.', source: 'smart_default' }
        : { value: 'mixed', reason: "We'll keep the days front-country — marked trails, back by dinner — and leave room for one bigger day.", source: 'destination_prior' },
});

const PERMIT_ACTIVITIES: QuestionDefinition = choice({
  id: 'permit_activities',
  module: 'altitude_outdoor',
  tier: 'destination',
  prompt: () => 'Some of the best days here need a permit or a booking weeks ahead.',
  why: () => 'A trail quota, a hut bed, a park shuttle or a guided crossing is booked long before the trip. This decides whether the plan is built around those days or leaves them out.',
  options: () => [
    { value: 'build_around', label: 'Build around them', detail: 'Plan the best days and tell me exactly what to book' },
    { value: 'keep_flexible', label: 'Keep it flexible', detail: 'Skip anything that needs a permit or an early booking' },
  ],
  impacts: ['activity_frequency', 'scope', 'day_density'],
  burden: 1,
  criticality: 1,
  relevance: (ctx) => (t(ctx, 'mountain') || t(ctx, 'wilderness') ? 1 : 0),
  read: (answers) => answers.permitSensitiveActivities,
  apply: (value) => ({ permitSensitiveActivities: (value === 'build_around' ? 'build_around' : 'keep_flexible') as QuestionnaireAnswers['permitSensitiveActivities'] }),
  smartDefault: (_ctx, answers) =>
    answers.hikeAppetite === 'full_day' || answers.trailSetting === 'backcountry'
      ? { value: 'build_around', reason: 'You want the big days, and the big days here are the ones that need booking, so the plan is built around them and says what to book.', source: 'smart_default' }
      : { value: 'keep_flexible', reason: "We'll keep the plan flexible and leave out anything that needs a permit weeks ahead; say so if a permit-bound day is the point.", source: 'destination_prior' },
});

const COVERAGE_STRATEGY: QuestionDefinition = choice({
  id: 'coverage_strategy',
  module: 'broad_scope',
  tier: 'destination',
  kind: 'scenario',
  prompt: (ctx) => `${ctx.destination.proseName} is more than ${ctx.destination.tripDays} days can cover. Would you rather:`,
  why: () => 'This decides whether the trip goes deep on a couple of regions or moves through more of them, and how many bases that takes.',
  options: () => [
    { value: 'depth', label: 'Go deep on one or two regions', detail: 'Fewer bases, fuller days, less time in transit' },
    { value: 'breadth', label: 'Move around and see more of it', detail: 'More bases, more transfer days, a wider picture' },
    { value: 'best_subset', label: 'Show me the best coherent subset', detail: 'Let Sidequest choose the regions that fit the days' },
  ],
  impacts: ['scope', 'base_count', 'trip_archetype', 'hotel_switching'],
  burden: 1,
  criticality: 3,
  relevance: (ctx) => (t(ctx, 'broad_geography') ? 1 : 0),
  read: (answers) => answers.scopeStrategy,
  apply: (value) => {
    const strategy = (['depth', 'breadth', 'best_subset'].includes(String(value)) ? String(value) : 'best_subset') as QuestionnaireAnswers['scopeStrategy'];
    return { scopeStrategy: strategy, ...(strategy === 'depth' ? { baseMoveTolerance: 'move_once' as const } : strategy === 'breadth' ? { baseMoveTolerance: 'move_freely' as const } : {}) };
  },
  smartDefault: (ctx) => ({ value: 'best_subset', reason: `We'll choose the parts of ${ctx.destination.proseName} that make one coherent trip in ${ctx.destination.tripDays} days and name what was left out.`, source: 'destination_prior' }),
});

const EVERYONE_EVERY_DAY: QuestionDefinition = choice({
  id: 'everyone_every_day',
  module: 'family_group',
  tier: 'destination',
  prompt: () => 'Does everyone need to enjoy every day?',
  why: () => 'A group with different appetites can split for an afternoon or stay together. This decides whether a day may hold a hard hike and an easy alternative side by side.',
  options: () => [
    { value: 'yes', label: 'Everyone does everything together', detail: 'Every stop has to work for the whole group' },
    { value: 'no', label: 'Fine to split up for a few hours', detail: 'One hard thing and one easy thing in the same afternoon' },
  ],
  impacts: ['group_fit', 'day_density', 'effort'],
  burden: 1,
  criticality: 1,
  /*
   * V7 §5 — ASKED ONLY WHEN THERE IS SOMETHING TO SPLIT OVER. "Four adults" is
   * not a difference; a member with a need, a child in a group of adults, or
   * described members whose profiles differ is. Otherwise the answer changes
   * nothing and the question is a survey line.
   */
  relevance: (ctx) => ((ctx.traveller.party?.differences ?? false) || (ctx.traveller.party?.needs.length ?? 0) > 0 || (ctx.traveller.children > 0 && ctx.traveller.adults + ctx.traveller.children >= 3) || ctx.traveller.travelerNeeds.length > 0 ? 1 : 0),
  read: (answers) => (answers.everyoneEveryDay ? 'yes' : 'no'),
  apply: (value) => ({ everyoneEveryDay: value !== 'no' }),
  smartDefault: (ctx) => (ctx.traveller.children > 0 ? { value: 'yes', reason: "With children along we'll keep the group together and every stop workable for all of you.", source: 'smart_default' } : { value: 'no', reason: "We'll allow the group to split for an afternoon when appetites differ.", source: 'smart_default' }),
});

const GROUP_NOTES: QuestionDefinition = {
  id: 'group_notes',
  module: 'family_group',
  tier: 'fine_tune',
  kind: 'text',
  prompt: () => 'Anything about the group we should plan around?',
  why: () => 'Who has a veto, who tires first, who has to be back for a nap. Kept with your trip and read when the days are composed.',
  impacts: ['group_fit'],
  hardCapable: false,
  burden: 3,
  criticality: 0,
  optional: true,
  relevance: (ctx) => (ctx.traveller.adults + ctx.traveller.children >= 3 || t(ctx, 'family_logistics_sensitive') ? 0.6 : 0),
  read: (answers) => answers.groupNotes ?? '',
  apply: (value) => ({ groupNotes: typeof value === 'string' && value.trim() ? value.trim().slice(0, 500) : undefined }),
  smartDefault: () => ({ value: '', reason: 'Nothing noted about the group.', source: 'smart_default' }),
};

// ---------------------------------------------------------------------------
// Fine tune
// ---------------------------------------------------------------------------

const NAMES: QuestionDefinition = {
  id: 'names',
  module: 'names',
  tier: 'fine_tune',
  kind: 'names',
  prompt: () => 'Anything by name?',
  why: () => 'Places you must see and places you must not. These are the only names that reach the plan as instructions; everything else is a preference.',
  impacts: ['hard_constraints', 'trip_archetype'],
  hardCapable: true,
  burden: 3,
  criticality: 1,
  optional: true,
  relevance: (ctx) => (ctx.traveller.composerNamedPlaces ? 0.3 : 0.6),
  read: (answers) => ({ include: answers.mustInclude, avoid: answers.mustAvoid }),
  apply: (value, answers) => {
    const raw = (value ?? {}) as { include?: unknown; avoid?: unknown };
    const clean = (list: unknown): string[] => (Array.isArray(list) ? list : []).map((s) => String(s).trim()).filter((s) => s.length > 0 && s.length <= 120).slice(0, 10);
    const include = clean(raw.include);
    const avoid = clean(raw.avoid);
    const kept = answers.hardConstraints.filter((c) => c.code !== 'must_include' && c.code !== 'must_avoid');
    return {
      mustInclude: include,
      mustAvoid: avoid,
      hardConstraints: [...kept, ...include.map((text) => ({ code: 'must_include' as const, text })), ...avoid.map((text) => ({ code: 'must_avoid' as const, text }))],
    };
  },
  smartDefault: () => ({ value: { include: [], avoid: [] }, reason: 'No named places.', source: 'smart_default' }),
};

const LODGING_STYLE: QuestionDefinition = choice({
  id: 'lodging_style',
  module: 'budget',
  tier: 'fine_tune',
  prompt: () => 'What kind of place do you want to sleep in?',
  why: () => 'Sidequest recommends areas, never a named hotel. This sets what kind of area.',
  options: () => (['no_preference', 'hostel', 'basic_hotel', 'boutique_hotel', 'apartment', 'resort', 'luxury_hotel', 'nature_lodge'] as const).map((value) => ({ value, label: ({ hostel: 'Hostel or guesthouse', basic_hotel: 'Simple, clean hotel', boutique_hotel: 'Small hotel with character', apartment: 'Apartment or rental', resort: 'Resort', luxury_hotel: 'Luxury hotel', nature_lodge: 'Lodge or cabin in nature', no_preference: 'No preference' } as const)[value] })),
  impacts: ['lodging', 'budget'],
  burden: 1,
  criticality: 1,
  relevance: () => 0.5,
  read: (answers) => answers.lodgingStyle,
  apply: (value) => ({ lodgingStyle: (['hostel', 'basic_hotel', 'boutique_hotel', 'apartment', 'resort', 'luxury_hotel', 'nature_lodge', 'no_preference'].includes(String(value)) ? String(value) : 'no_preference') as QuestionnaireAnswers['lodgingStyle'] }),
  smartDefault: (_ctx, answers) => ({ value: answers.budgetStyle === 'luxury' ? 'luxury_hotel' : answers.budgetStyle === 'budget' ? 'basic_hotel' : 'no_preference', reason: "We'll match the lodging to your spending style.", source: 'smart_default' }),
});

const BREAKFAST: QuestionDefinition = choice({
  id: 'breakfast',
  module: 'food',
  tier: 'fine_tune',
  prompt: () => 'What does breakfast look like?',
  why: () => 'Decides whether mornings start with a named cafe on the way out, or nothing at all.',
  options: () => [
    { value: 'skip', label: 'I skip it', detail: 'Do not book me a breakfast' },
    { value: 'coffee_light', label: 'Coffee and something', detail: 'Quick, and on the way out' },
    { value: 'full', label: 'A proper sit-down', detail: 'Worth starting the day later for' },
    { value: 'depends', label: 'Depends on the day', detail: 'Early start, quick. Slow morning, longer' },
  ],
  impacts: ['food_strategy', 'day_start'],
  burden: 1,
  criticality: 0,
  relevance: () => 0.5,
  read: (answers) => answers.breakfastStyle,
  apply: (value) => ({ breakfastStyle: (['skip', 'coffee_light', 'full', 'depends'].includes(String(value)) ? String(value) : 'coffee_light') as QuestionnaireAnswers['breakfastStyle'] }),
  smartDefault: (_ctx, answers) => ({ value: answers.dayStart === 'early' ? 'coffee_light' : 'depends', reason: 'Quick on early days, longer on slow ones.', source: 'smart_default' }),
});

const SPECIAL_MEALS: QuestionDefinition = choice({
  id: 'special_meals',
  module: 'food',
  tier: 'fine_tune',
  prompt: () => 'How many meals should be an event?',
  why: () => 'A four-day trip gets one special dinner even from somebody who eats out constantly at home.',
  options: () => [
    { value: 'none', label: 'None', detail: 'No occasion dinners' },
    { value: 'one', label: 'One', detail: 'A single evening worth dressing for' },
    { value: 'a_few', label: 'A few', detail: 'More than one, not every night' },
    { value: 'often', label: 'Most nights', detail: 'This is what the trip is for' },
  ],
  impacts: ['meal_frequency', 'budget'],
  burden: 1,
  criticality: 0,
  relevance: (_ctx, answers) => (answers.foodStyle === 'budget' ? 0 : 0.5),
  read: (answers) => answers.specialMealAppetite,
  apply: (value) => ({ specialMealAppetite: (['none', 'one', 'a_few', 'often'].includes(String(value)) ? String(value) : 'one') as QuestionnaireAnswers['specialMealAppetite'] }),
  smartDefault: () => ({ value: 'one', reason: 'One evening worth dressing for.', source: 'smart_default' }),
});

const PACK_LUNCH: QuestionDefinition = choice({
  id: 'pack_lunch',
  module: 'food',
  tier: 'fine_tune',
  prompt: () => 'Happy to pick up a lunch and carry it?',
  why: () => 'Some of the best days out have nowhere at all to buy food.',
  options: () => [
    { value: 'yes', label: 'Yes', detail: 'A grocery stop and a rucksack is a fine answer to lunch' },
    { value: 'no', label: 'No', detail: 'Plan a sit-down lunch, or a shorter day' },
  ],
  impacts: ['food_strategy', 'remote_logistics'],
  burden: 1,
  criticality: 0,
  relevance: (ctx) => (t(ctx, 'mountain') || t(ctx, 'wilderness') || t(ctx, 'remote') || t(ctx, 'road_trip_region') ? 0.5 : 0),
  read: (answers) => (answers.willPackLunch ? 'yes' : 'no'),
  apply: (value) => ({ willPackLunch: value !== 'no' }),
  smartDefault: () => ({ value: 'yes', reason: 'A packed lunch keeps the far days possible.', source: 'smart_default' }),
});

const FREE_TIME: QuestionDefinition = choice({
  id: 'free_time',
  module: 'rhythm',
  tier: 'fine_tune',
  prompt: () => 'How much unscheduled time?',
  why: () => 'Pace says how much a day can hold; this says how much of that you want filled.',
  options: () => [
    { value: 'packed', label: 'Fill it', detail: 'Slack is wasted' },
    { value: 'balanced', label: 'Some', detail: 'An open afternoon here and there' },
    { value: 'lots', label: 'Lots', detail: 'Half the days mostly open' },
  ],
  impacts: ['day_density'],
  burden: 1,
  criticality: 0,
  carriedFields: ['freeTime'],
  relevance: () => 0.5,
  read: (answers) => answers.freeTime,
  apply: (value) => ({ freeTime: (['packed', 'balanced', 'lots'].includes(String(value)) ? String(value) : 'balanced') as QuestionnaireAnswers['freeTime'] }),
  smartDefault: () => ({ value: 'balanced', reason: 'An open afternoon here and there.', source: 'smart_default' }),
});

const WEATHER_AVOIDANCES: QuestionDefinition = {
  id: 'weather_avoidances',
  module: 'rhythm',
  tier: 'destination',
  kind: 'multi',
  prompt: (ctx) => (t(ctx, 'heat_sensitive') ? 'It will be hot in your dates. Anything to steer around?' : t(ctx, 'cold_sensitive') ? 'It will be cold in your dates. Anything to steer around?' : 'Anything the weather should steer you around?'),
  why: () => 'Read against the forecast or the climate normal for the day a place would land on.',
  options: () => [
    { value: 'extreme_heat', label: 'Being out in extreme heat' },
    { value: 'extreme_cold', label: 'Being out in extreme cold' },
    { value: 'early_mornings', label: 'Early mornings' },
    { value: 'long_drives', label: 'Long drives' },
  ],
  impacts: ['weather_sensitivity', 'day_start', 'driving'],
  hardCapable: false,
  burden: 1,
  criticality: 1,
  optional: true,
  relevance: (ctx) => (t(ctx, 'heat_sensitive') || t(ctx, 'cold_sensitive') ? 1 : 0.3),
  read: (answers) => answers.avoidances.filter((a) => ['extreme_heat', 'extreme_cold', 'early_mornings', 'long_drives'].includes(a)),
  apply: (value, answers) => {
    const picked = new Set((Array.isArray(value) ? value : []).map(String));
    const managed = ['extreme_heat', 'extreme_cold', 'early_mornings', 'long_drives'];
    const rest = answers.avoidances.filter((a) => !managed.includes(a));
    const added = managed.filter((a) => picked.has(a)) as QuestionnaireAnswers['avoidances'];
    return { avoidances: [...rest, ...added] };
  },
  smartDefault: (ctx) => (t(ctx, 'heat_sensitive') ? { value: ['extreme_heat'], reason: "We'll keep the exposed stops out of the hottest hours.", source: 'destination_prior' } : { value: [], reason: 'Nothing weather-specific to steer around.', source: 'smart_default' }),
};

export const CORE_QUESTIONS: readonly QuestionDefinition[] = [
  PRIORITIES,
  TRANSPORT_MODE,
  DAY_SHAPE,
  DAY_START,
  EFFORT,
  ICONIC_CROWDS,
  FAMOUS_VS_HIDDEN,
  FOOD_TRADEOFF,
  BUDGET,
  CONVENIENCE_SPEND,
  DIETARY,
  HARD_CONSTRAINTS,
];


// ---------------------------------------------------------------------------
// V12.1 §27 — Operating-mode questions
//
// THE QUESTIONS ONLY *THIS KIND OF TRIP* RAISES.
//
// V12 derived `TripOperatingModel` before the composition call and handed it to
// composition, readiness and quality. The intake never saw it, so every
// traveller was asked the same questions in the same order whatever trip they
// were describing — which is the thing §25 says a traveller should notice has
// changed.
//
// Two rules govern what is allowed in here, and between them they are why this
// module is eight questions rather than forty.
//
//   **§28 — a question must be able to change something.** Every one below
//   writes real answer fields that a real downstream reader consumes, and the
//   `impacts` list names them. `question-value.test.ts` holds this to the code.
//
//   **No duplicates of the generic set.** The catalog already asks about guide
//   willingness, lodging style, base moves, day trips, late nights, driving
//   ceilings and convenience spend, for everybody. A trek question that asked
//   "do you mind a guide?" would be the same question wearing a second id, and
//   the selector would show both. What is here is what the generic set
//   genuinely cannot ask: where you sleep *on a trail*, whether a night bus is
//   a bed, whether the safari vehicle is yours.
//
// **Nothing here says the family's name.** §25: a question may be asked
// *because* the trip looks like a trek; it may never use the word "operating
// model", and none of these prompts does.
// ---------------------------------------------------------------------------

/** How strongly this trip has to look like one of these families before its question is worth a screen. */
function familyFit(ctx: InterviewContext, answers: QuestionnaireAnswers, families: readonly OperatingType[]): number {
  if (!intentIsSpecified(answers)) return 0;
  return looksLikeAny(diagnoseTrip(ctx, answers), families);
}

const TREK_NIGHTS: QuestionDefinition = choice({
  id: 'trek_nights',
  module: 'operating_mode',
  tier: 'destination',
  prompt: () => 'On the nights out on the route, where would you rather sleep?',
  why: () => 'What sleeps on a multi-day route is booked months ahead and decides how far each day can run. It is a different question from what you want in a town.',
  options: () => [
    { value: 'huts', label: 'Huts or refuges', detail: 'A bed, a roof and usually a meal. Booked early.' },
    { value: 'camps', label: 'Tented or yurt camps', detail: 'Set up for you, further from the road' },
    { value: 'own_tent', label: 'Our own tent', detail: 'Wild camping where it is allowed' },
    { value: 'back_to_town', label: 'Back to a town each night', detail: 'Day walks out and back rather than a through-route' },
  ],
  impacts: ['lodging', 'effort', 'base_count', 'budget'],
  burden: 1,
  criticality: 2,
  relevance: (ctx, answers) => familyFit(ctx, answers, ['multi_day_trek', 'remote_overland']),
  read: (answers) => answers.trailSetting === 'backcountry' ? (answers.rusticLodgingOk ? 'camps' : 'huts') : answers.trailSetting === 'frontcountry' ? 'back_to_town' : undefined,
  apply: (value) => {
    switch (String(value)) {
      case 'huts':
        return { lodgingStyle: 'basic_hotel', rusticLodgingOk: true, trailSetting: 'backcountry' };
      case 'camps':
        return { lodgingStyle: 'nature_lodge', rusticLodgingOk: true, trailSetting: 'backcountry' };
      case 'own_tent':
        return { lodgingStyle: 'nature_lodge', rusticLodgingOk: true, trailSetting: 'backcountry', remoteComfort: 'fine' };
      case 'back_to_town':
      default:
        return { trailSetting: 'frontcountry', rusticLodgingOk: false };
    }
  },
  smartDefault: (_ctx, answers) => (answers.rusticLodgingOk ? { value: 'huts', reason: 'We will plan around huts where the route has them, and say when it does not.', source: 'smart_default' } : { value: 'back_to_town', reason: 'Day walks out and back, so every night is a proper bed.', source: 'smart_default' }),
});

const TREK_LOAD: QuestionDefinition = choice({
  id: 'trek_load',
  module: 'operating_mode',
  tier: 'destination',
  prompt: () => 'Who carries the gear?',
  why: () => 'Carrying everything roughly halves how far a day goes and changes what a day can include. Somebody else carrying it is a cost and an arrangement.',
  options: () => [
    { value: 'ourselves', label: 'We carry everything', detail: 'Shorter days, full independence' },
    { value: 'porters', label: 'Porters or pack animals', detail: 'Longer days, arranged in advance' },
    { value: 'vehicle', label: 'A vehicle meets us', detail: 'Day packs only; bags move by road' },
  ],
  impacts: ['effort', 'day_density', 'guide_transfer', 'budget'],
  burden: 1,
  criticality: 2,
  relevance: (ctx, answers) => familyFit(ctx, answers, ['multi_day_trek']),
  read: (answers) => (answers.guideWillingness === 'prefer' ? 'porters' : answers.dailyIntensity === 'intense' ? 'ourselves' : undefined),
  apply: (value, answers) => {
    switch (String(value)) {
      case 'ourselves':
        return { dailyIntensity: 'intense', guideWillingness: answers.guideWillingness === 'prefer' ? 'sometimes' : answers.guideWillingness };
      case 'porters':
        return { guideWillingness: 'prefer', privateTransfers: 'fine' };
      case 'vehicle':
      default:
        return { privateTransfers: 'fine', guideWillingness: 'sometimes' };
    }
  },
  smartDefault: () => ({ value: 'porters', reason: 'We will assume the heavy bags are carried for you and say where that has to be arranged.', source: 'smart_default' }),
});

const OVERNIGHT_TRANSPORT: QuestionDefinition = choice({
  id: 'overnight_transport',
  module: 'operating_mode',
  tier: 'destination',
  prompt: () => 'Travelling overnight — a night bus or a sleeper train:',
  why: () => 'An overnight leg buys a whole day and costs a night of sleep. Whether it is on the table changes how far the route can reach.',
  options: () => [
    { value: 'yes', label: 'Yes, that saves a day', detail: 'Long legs at night, days kept for places' },
    { value: 'sleeper_only', label: 'Only in a proper sleeper', detail: 'A berth, not a reclining seat' },
    { value: 'no', label: 'No — I want a bed', detail: 'Every night in a room' },
  ],
  impacts: ['transportation_mode', 'lodging', 'scope', 'day_density'],
  burden: 1,
  criticality: 2,
  relevance: (ctx, answers) => familyFit(ctx, answers, ['overland_backpacking', 'rail_journey']),
  read: (answers) => (answers.maxDailyTravelMinutes >= 420 ? 'yes' : undefined),
  apply: (value, answers) => {
    switch (String(value)) {
      case 'yes':
        return { maxDailyTravelMinutes: Math.max(answers.maxDailyTravelMinutes, 420), rusticLodgingOk: true, willUseShuttles: true };
      case 'sleeper_only':
        return { maxDailyTravelMinutes: Math.max(answers.maxDailyTravelMinutes, 360), convenienceSpend: 'balance' };
      case 'no':
      default:
        return { maxDailyTravelMinutes: Math.min(answers.maxDailyTravelMinutes, 300) };
    }
  },
  smartDefault: () => ({ value: 'no', reason: 'We will keep every night in a room and plan the long legs by day.', source: 'smart_default' }),
});

const RESORT_SHAPE: QuestionDefinition = choice({
  id: 'resort_shape',
  module: 'operating_mode',
  tier: 'destination',
  prompt: () => 'One place the whole time, or two?',
  why: () => 'Moving between properties costs most of a day here, and it is the single biggest decision about how this trip feels.',
  options: () => [
    { value: 'one', label: 'One place, all week', detail: 'Unpack once' },
    { value: 'two', label: 'Split it between two', detail: 'A change of scene, one transfer day' },
    { value: 'open', label: 'Whatever suits the place', detail: 'Decide it for me' },
  ],
  impacts: ['base_count', 'hotel_switching', 'lodging', 'day_density'],
  burden: 1,
  criticality: 2,
  relevance: (ctx, answers) => familyFit(ctx, answers, ['resort_stay']),
  read: (answers) => (answers.baseMoveTolerance === 'stay_put' ? 'one' : answers.baseMoveTolerance === 'move_once' ? 'two' : undefined),
  apply: (value) => (String(value) === 'one' ? { baseMoveTolerance: 'stay_put' } : String(value) === 'two' ? { baseMoveTolerance: 'move_once' } : { baseMoveTolerance: 'move_if_it_saves_time' }),
  smartDefault: () => ({ value: 'one', reason: 'One property the whole time, so no day is spent moving.', source: 'smart_default' }),
});

const RESORT_BALANCE: QuestionDefinition = choice({
  id: 'resort_balance',
  module: 'operating_mode',
  tier: 'destination',
  prompt: () => 'How much do you want to be doing?',
  why: () => 'On a trip like this an empty afternoon is the plan working rather than a gap in it — but only if that is what you wanted.',
  options: () => [
    { value: 'mostly_still', label: 'Mostly nothing', detail: 'The property, the water, a book' },
    { value: 'one_thing', label: 'One thing most days', detail: 'A dive, a boat, a village — then back' },
    { value: 'out_daily', label: 'Out every day', detail: 'Excursions are the point' },
  ],
  impacts: ['day_density', 'activity_frequency', 'budget'],
  burden: 1,
  criticality: 2,
  relevance: (ctx, answers) => familyFit(ctx, answers, ['resort_stay']),
  read: (answers) => (answers.freeTime === 'lots' ? 'mostly_still' : answers.freeTime === 'packed' ? 'out_daily' : undefined),
  apply: (value) =>
    String(value) === 'mostly_still'
      ? { freeTime: 'lots', pace: 'slow', dailyIntensity: 'light' }
      : String(value) === 'out_daily'
        ? { freeTime: 'packed', pace: 'balanced' }
        : { freeTime: 'balanced', pace: 'slow' },
  smartDefault: () => ({ value: 'one_thing', reason: 'One thing most days, and the rest of the time yours.', source: 'smart_default' }),
});

const WILDLIFE_VEHICLE: QuestionDefinition = choice({
  id: 'wildlife_vehicle',
  module: 'operating_mode',
  tier: 'destination',
  prompt: () => 'On the game drives, would you rather have the vehicle to yourselves?',
  why: () => 'A private vehicle decides when you leave, how long you stay at a sighting and where you sit — and it costs noticeably more than a shared one.',
  options: () => [
    { value: 'private', label: 'Ours alone', detail: 'We set the pace and the hours' },
    { value: 'shared', label: 'Share it', detail: 'Fixed departure times, lower cost' },
    { value: 'either', label: 'Either is fine', detail: 'Whichever the lodge normally does' },
  ],
  impacts: ['guide_transfer', 'budget', 'convenience', 'day_start'],
  burden: 1,
  criticality: 2,
  relevance: (ctx, answers) => familyFit(ctx, answers, ['guided_wildlife']),
  read: (answers) => (answers.privateTransfers === 'fine' && answers.convenienceSpend === 'pay_to_reduce_hassle' ? 'private' : undefined),
  apply: (value) =>
    String(value) === 'private'
      ? { privateTransfers: 'fine', guideWillingness: 'prefer', convenienceSpend: 'pay_to_reduce_hassle' }
      : String(value) === 'shared'
        ? { guideWillingness: 'prefer', convenienceSpend: 'save_money' }
        : { guideWillingness: 'prefer', convenienceSpend: 'balance' },
  smartDefault: () => ({ value: 'either', reason: 'Whatever the camp normally runs, and we will say what that means for the mornings.', source: 'smart_default' }),
});

const ISLAND_COUNT: QuestionDefinition = choice({
  id: 'island_count',
  module: 'operating_mode',
  tier: 'destination',
  prompt: () => 'How many islands is this trip?',
  why: () => 'Every hop costs a boat, a check-out and most of a day. Two islands well beats four in passing, unless seeing more is the point.',
  options: () => [
    { value: 'one', label: 'One, properly', detail: 'No crossings after the first' },
    { value: 'two', label: 'Two', detail: 'One crossing in the middle' },
    { value: 'three', label: 'Three', detail: 'Two crossings; days get shorter' },
    { value: 'as_many', label: 'As many as fit', detail: 'Keep moving' },
  ],
  impacts: ['base_count', 'hotel_switching', 'scope', 'transportation_mode'],
  burden: 1,
  criticality: 3,
  relevance: (ctx, answers) => familyFit(ctx, answers, ['island_hopping']),
  read: (answers) => (answers.baseMoveTolerance === 'stay_put' ? 'one' : answers.baseMoveTolerance === 'move_once' ? 'two' : answers.baseMoveTolerance === 'move_freely' ? 'as_many' : undefined),
  apply: (value) => {
    switch (String(value)) {
      case 'one':
        return { baseMoveTolerance: 'stay_put', scopeStrategy: 'depth' };
      case 'two':
        return { baseMoveTolerance: 'move_once', scopeStrategy: 'best_subset' };
      case 'three':
        return { baseMoveTolerance: 'move_if_it_saves_time', scopeStrategy: 'best_subset' };
      case 'as_many':
      default:
        return { baseMoveTolerance: 'move_freely', scopeStrategy: 'breadth' };
    }
  },
  smartDefault: (ctx) => (ctx.traveller.tripDays >= 9 ? { value: 'three', reason: 'Three islands over this many days, with the crossings planned as whole half-days.', source: 'smart_default' } : { value: 'two', reason: 'Two islands, so only one day goes to a crossing.', source: 'smart_default' }),
});

const RAIL_BOOKING: QuestionDefinition = choice({
  id: 'rail_booking',
  module: 'operating_mode',
  tier: 'destination',
  prompt: () => 'On the long train legs:',
  why: () => 'Reserved seats and passes are bought before you go, and which one you want changes what the days can be pinned to.',
  options: () => [
    { value: 'reserved', label: 'Reserved seats, booked ahead', detail: 'Fixed departures, nothing to queue for' },
    { value: 'pass', label: 'A rail pass, decide as we go', detail: 'Flexible, sometimes standing' },
    { value: 'cheapest', label: 'Whatever is cheapest', detail: 'Slower trains are fine' },
  ],
  impacts: ['transportation_mode', 'budget', 'convenience', 'day_start'],
  burden: 1,
  criticality: 2,
  relevance: (ctx, answers) => familyFit(ctx, answers, ['rail_journey']),
  read: (answers) => (answers.convenienceSpend === 'pay_to_reduce_hassle' ? 'reserved' : answers.convenienceSpend === 'save_money' ? 'cheapest' : undefined),
  apply: (value) =>
    String(value) === 'reserved'
      ? { convenienceSpend: 'pay_to_reduce_hassle', transportPriority: 'fastest' }
      : String(value) === 'pass'
        ? { convenienceSpend: 'balance', transportPriority: 'best_value' }
        : { convenienceSpend: 'save_money', transportPriority: 'cheapest' },
  smartDefault: () => ({ value: 'reserved', reason: 'We will assume reserved seats on the long legs and put them on the booking list.', source: 'smart_default' }),
});


const CITY_SHAPE: QuestionDefinition = choice({
  id: 'city_shape',
  module: 'operating_mode',
  tier: 'destination',
  prompt: () => 'Which would you rather look back on?',
  why: () => 'The famous rooms and the ordinary streets are two different weeks in the same city, and they are timed and routed differently.',
  options: () => [
    { value: 'the_great_ones', label: 'The great collections and the landmarks', detail: 'Timed entries, early starts, a booked list' },
    { value: 'the_streets', label: 'Streets, markets and whichever quarter we end up in', detail: 'Fewer fixed times, longer on foot' },
    { value: 'both', label: 'Two or three of the famous things, then wander', detail: 'A booked morning, an open afternoon' },
  ],
  impacts: ['famous_vs_hidden', 'crowds', 'day_density', 'walking'],
  burden: 1,
  criticality: 2,
  relevance: (ctx, answers) => familyFit(ctx, answers, ['urban_culture', 'urban_family']),
  read: (answers) => (answers.discoveryMix === 'mostly_classics' ? 'the_great_ones' : answers.discoveryMix === 'mostly_hidden' || answers.discoveryMix === 'deep_cuts' ? 'the_streets' : undefined),
  apply: (value) =>
    String(value) === 'the_great_ones'
      ? { discoveryMix: 'mostly_classics', iconicCrowdStrategy: 'go_at_odd_hours', convenienceSpend: 'pay_to_reduce_hassle' }
      : String(value) === 'the_streets'
        ? { discoveryMix: 'mostly_hidden', iconicCrowdStrategy: 'quieter_alternative' }
        : { discoveryMix: 'balanced', iconicCrowdStrategy: 'go_at_odd_hours' },
  smartDefault: () => ({ value: 'both', reason: 'Two or three of the famous things booked, and the rest of each day left open.', source: 'smart_default' }),
});

const CITY_TABLE: QuestionDefinition = choice({
  id: 'city_table',
  module: 'operating_mode',
  tier: 'destination',
  prompt: () => 'How much of the eating should be decided in advance?',
  why: () => 'A table that has to be booked weeks out pins a whole evening, and a city where the good places are walk-ins does not need any of that.',
  options: () => [
    { value: 'book_the_lot', label: 'Book the good ones', detail: 'Reservations weeks ahead; evenings are fixed' },
    { value: 'one_or_two', label: 'One or two, the rest as we go', detail: 'A couple of evenings pinned' },
    { value: 'walk_in', label: 'Walk in wherever', detail: 'Nothing booked; queue if it is worth it' },
  ],
  impacts: ['food_strategy', 'meal_frequency', 'budget', 'convenience'],
  burden: 1,
  criticality: 2,
  relevance: (ctx, answers) => familyFit(ctx, answers, ['urban_food_nightlife']),
  read: (answers) => (answers.specialMealAppetite === 'often' ? 'book_the_lot' : answers.specialMealAppetite === 'none' ? 'walk_in' : undefined),
  apply: (value) =>
    String(value) === 'book_the_lot'
      ? { specialMealAppetite: 'often' as const, convenienceSpend: 'pay_to_reduce_hassle' as const, foodStyle: 'destination' as const }
      : String(value) === 'walk_in'
        ? { specialMealAppetite: 'none' as const, convenienceSpend: 'save_money' as const, foodStyle: 'local_casual' as const }
        : { specialMealAppetite: 'a_few' as const, convenienceSpend: 'balance' as const },
  smartDefault: () => ({ value: 'one_or_two', reason: 'A couple of evenings booked and the rest left to the night.', source: 'smart_default' }),
});

export const OPERATING_MODE_QUESTIONS: readonly QuestionDefinition[] = [
  CITY_SHAPE,
  CITY_TABLE,
  TREK_NIGHTS,
  TREK_LOAD,
  OVERNIGHT_TRANSPORT,
  RESORT_SHAPE,
  RESORT_BALANCE,
  WILDLIFE_VEHICLE,
  ISLAND_COUNT,
  RAIL_BOOKING,
];

export const DESTINATION_QUESTIONS: readonly QuestionDefinition[] = [
  COVERAGE_STRATEGY,
  BASE_MOVES,
  DAILY_DRIVING,
  SCENIC_REACH,
  ROAD_COMFORT,
  WALKING_TOLERANCE,
  TRANSIT_COMFORT,
  DAY_TRIPS,
  LATE_NIGHTS,
  STAIRS_HILLS,
  GUIDE_WILLINGNESS,
  PRIVATE_TRANSFERS,
  REMOTE_COMFORT,
  RUSTIC_LODGING,
  BOATS_FERRIES,
  INTERNAL_FLIGHTS,
  HIKE_APPETITE,
  ALTITUDE_COMFORT,
  TRAIL_SETTING,
  PERMIT_ACTIVITIES,
  EVERYONE_EVERY_DAY,
  WEATHER_AVOIDANCES,
  ...OPERATING_MODE_QUESTIONS,
];

export const FINE_TUNE_QUESTIONS: readonly QuestionDefinition[] = [
  NAMES,
  LODGING_STYLE,
  BREAKFAST,
  SPECIAL_MEALS,
  PACK_LUNCH,
  FREE_TIME,
  GROUP_NOTES,
];

/** The static catalog, without the per-interest role questions. */
export const INTERVIEW_QUESTIONS: readonly QuestionDefinition[] = [
  ...CORE_QUESTIONS,
  ...DESTINATION_QUESTIONS,
  ...FINE_TUNE_QUESTIONS,
];

/**
 * The whole catalog for one traveller: the static questions plus a role
 * question for every priority they chose, in the order they were offered.
 */
export function interviewCatalog(ctx: InterviewContext, answers: QuestionnaireAnswers): QuestionDefinition[] {
  const chosen = priorityOffer(ctx, answers).filter((interest) => chosenInterests(answers).includes(interest));
  const extra = chosenInterests(answers).filter((interest) => !chosen.includes(interest));
  const roles = [...chosen, ...extra].map((interest, index) => roleQuestionFor(interest, index));
  return [...CORE_QUESTIONS, PRIORITY_ROLES, ...roles, ...DESTINATION_QUESTIONS, ...FINE_TUNE_QUESTIONS];
}

export function questionById(ctx: InterviewContext, answers: QuestionnaireAnswers, id: string): QuestionDefinition | undefined {
  if (id.startsWith('priority_role:')) {
    const interest = id.slice('priority_role:'.length) as Interest;
    if (!(INTERESTS as readonly string[]).includes(interest)) return undefined;
    const position = priorityOffer(ctx, answers).indexOf(interest);
    return roleQuestionFor(interest, position < 0 ? 99 : position);
  }
  if (id === 'priority_roles') return PRIORITY_ROLES;
  return INTERVIEW_QUESTIONS.find((question) => question.id === id);
}

export { labelOf as interviewOptionLabel };
