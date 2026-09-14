import { z } from 'zod';
import { INTERESTS, INTEREST_LABELS, type Interest } from '../schemas/common';
import type { TravelerProfile } from '../schemas/profile';
import { PREFERENCE_ROLE_RANK, ROLE_DEMANDS, preferenceRoleSchema, rolesFor, type PreferenceRole, type RoleSource } from './roles';

/**
 * V12 §2 §3 — TRAVELER INTENT: WHAT THE TRIP IS *FOR*.
 *
 * `TravelerProfile` remains the record of what the traveller told us, and
 * nothing here replaces it. This is the derived planning view of the same
 * answers: not a bag of weights but a statement of what each preference is
 * supposed to *do* to the trip, and of how the trip should feel when it is over.
 *
 * Why a second representation at all. The V12 architecture audit found that
 * preferences reach the model as description and reach the product as scoring,
 * and that nothing in between asks whether the composed trip honoured them. A
 * description cannot be checked. This can: every field is either a role with a
 * stated demand (`ROLE_DEMANDS`), or a signal with a defined structural
 * consequence. `IntentSatisfactionReport` (§29) is written against this, not
 * against the profile.
 *
 * Derived, never stored, never asked for. A traveller is never shown the word
 * "intent", never picks an identity from a list, and never sees a role
 * vocabulary — §62 is explicit, and the four role words they *do* see are the
 * ones `priority_roles` already shows.
 *
 * **Pure.** No model call, no provider, no clock. `deriveTravelerIntent` is a
 * function of the profile and the trip's own facts, so the same answers always
 * produce the same intent and a test can pin it without a fixture server.
 */

/**
 * How the traveller wants the trip to *feel*.
 *
 * §3 is explicit that these must not be reduced to POI tags: "restful" is not a
 * category of place, it is a property of the shape of the days. Each one below
 * therefore names a structural consequence, and §32 evaluates them against the
 * itinerary's structure rather than against its contents.
 */
export const DESIRED_FEELINGS = [
  'adventurous',
  'restful',
  'romantic',
  'social',
  'remote',
  'spontaneous',
  'immersive',
  'luxurious',
  'challenging',
  'family_friendly',
  'culturally_rich',
  'slow',
  'high_energy',
] as const;
export const desiredFeelingSchema = z.enum(DESIRED_FEELINGS);
export type DesiredFeeling = z.infer<typeof desiredFeelingSchema>;

/** How much discomfort the traveller will trade for the trip they want. */
export const ROUGHNESS_TOLERANCES = ['comfort_first', 'balanced', 'rough_is_fine', 'seeks_rough'] as const;
export const roughnessToleranceSchema = z.enum(ROUGHNESS_TOLERANCES);
export type RoughnessTolerance = z.infer<typeof roughnessToleranceSchema>;

/** How much of the trip the traveller wants pinned down before they leave. */
export const PLANNING_FLEXIBILITIES = ['pinned', 'mostly_planned', 'loose', 'improvised'] as const;
export const planningFlexibilitySchema = z.enum(PLANNING_FLEXIBILITIES);
export type PlanningFlexibility = z.infer<typeof planningFlexibilitySchema>;

/** Whether the traveller wants to be handled, or to handle it themselves. */
export const INDEPENDENCE_PREFERENCES = ['guided', 'supported', 'independent'] as const;
export const independencePreferenceSchema = z.enum(INDEPENDENCE_PREFERENCES);
export type IndependencePreference = z.infer<typeof independencePreferenceSchema>;

/** One preference, with the role it plays and where that role came from. */
export interface IntentGoal {
  interest: Interest;
  label: string;
  role: PreferenceRole;
  /** `stated` — the traveller answered the role question. `inferred` — read back from the level. */
  basis: RoleSource['basis'];
  /** What the finished trip has to show for it. Copied from `ROLE_DEMANDS` so the report reads one source. */
  demand: (typeof ROLE_DEMANDS)[PreferenceRole];
}

/**
 * A feeling the traveller asked for, and what said so.
 *
 * `evidence` is never decoration: §32 warns against over-formalising subjective
 * emotion, and the guard against that is that a feeling may only be claimed
 * where an answer implies it, and must be able to say which answer.
 */
export interface FeelingSignal {
  feeling: DesiredFeeling;
  /** 0–1. How strongly the answers imply it. */
  strength: number;
  evidence: string[];
}

export interface TravelerIntent {
  version: 1;
  /** Roles at `core`: the trip must be structurally different because of these. */
  primaryGoals: IntentGoal[];
  /** Roles at `most_days` or `several_times`: meaningful, repeated representation. */
  secondaryGoals: IntentGoal[];
  /** Roles at `avoid`, plus the traveller's stated avoidances as prose. */
  hardAvoidances: string[];
  /** Every interest's role, including the ones nobody asked about. */
  roles: Record<Interest, PreferenceRole>;
  desiredFeeling: FeelingSignal[];
  roughnessTolerance: RoughnessTolerance;
  planningFlexibility: PlanningFlexibility;
  independencePreference: IndependencePreference;
  /**
   * What kind of trip this is, in the traveller's terms, derived from the
   * strongest goals and the comfort answers. Internal: never shown, never
   * selected from a list, and never a destination's property (§5).
   */
  tripIdentity: string;
  /** Where comfort is being traded for something, in one line each. */
  comfortTradeoffs: string[];
  /** Whether the party wants other people around them. */
  socialStyle: 'private' | 'mixed' | 'social';
  /** How far off the beaten track the traveller wants what they see to be. */
  discoveryStyle: 'classics' | 'balanced' | 'hidden' | 'deep_cuts';
}

const FEELING_FLOOR = 0.34;

function goal(interest: Interest, source: RoleSource): IntentGoal {
  return { interest, label: INTEREST_LABELS[interest], role: source.role, basis: source.basis, demand: ROLE_DEMANDS[source.role] };
}

/**
 * The feelings the answers imply, each with what implied it.
 *
 * Deliberately conservative: a feeling needs more than one weak signal to clear
 * the floor, because a trip described as "restful" on the strength of one
 * answer would then be judged against `restful` for the rest of its life.
 */
function feelingsFrom(profile: TravelerProfile, goals: IntentGoal[], party: { children?: number } | undefined): FeelingSignal[] {
  const add = new Map<DesiredFeeling, { strength: number; evidence: string[] }>();
  const signal = (feeling: DesiredFeeling, strength: number, evidence: string) => {
    const existing = add.get(feeling);
    if (existing) {
      existing.strength = Math.min(1, existing.strength + strength);
      existing.evidence.push(evidence);
    } else add.set(feeling, { strength, evidence: [evidence] });
  };

  const roleOf = (interest: Interest): PreferenceRole => goals.find((entry) => entry.interest === interest)?.role ?? 'opportunistic';
  const strong = (interest: Interest): boolean => PREFERENCE_ROLE_RANK[roleOf(interest)] >= PREFERENCE_ROLE_RANK.several_times;

  if (profile.pace === 'slow') signal('slow', 0.5, 'a slow pace');
  if (profile.pace === 'fast') signal('high_energy', 0.4, 'a fast pace');
  if (profile.dailyIntensity === 'intense') {
    signal('challenging', 0.5, 'intense days');
    signal('high_energy', 0.3, 'intense days');
  }
  if (profile.dailyIntensity === 'light') signal('restful', 0.4, 'light days');
  if (profile.freeTime === 'lots') {
    signal('restful', 0.4, 'a lot of unscheduled time');
    signal('spontaneous', 0.35, 'a lot of unscheduled time');
  }
  if (profile.freeTime === 'packed') signal('high_energy', 0.3, 'a packed plan');

  if (strong('hiking')) signal('adventurous', 0.4, `${INTEREST_LABELS.hiking.toLowerCase()} matters here`);
  if (strong('wildlife')) signal('adventurous', 0.25, 'wildlife matters here');
  if (strong('history_and_culture') || strong('museums_and_galleries')) signal('culturally_rich', 0.45, 'history and culture matter here');
  if (strong('neighbourhoods_and_local_life') || strong('markets_and_street_food')) signal('immersive', 0.45, 'local life matters here');
  if (strong('beaches_and_swimming')) signal('restful', 0.3, 'beach time matters here');

  if (profile.crowdTolerance === 'avoid_crowds') signal('remote', 0.3, 'a preference for fewer people');
  if (profile.interview?.remoteComfort === 'fine' && profile.crowdTolerance === 'avoid_crowds') signal('remote', 0.2, 'comfort with remote places');
  if (profile.budgetStyle === 'luxury') signal('luxurious', 0.6, 'a luxury budget');
  if (profile.budgetStyle === 'premium') signal('luxurious', 0.3, 'a premium budget');
  if (profile.interview?.rusticLodgingOk === false) signal('luxurious', 0.2, 'no appetite for rustic lodging');
  if (party?.children !== undefined && party.children > 0) signal('family_friendly', 0.7, 'children in the party');
  if (profile.interview?.lodgingStyle === 'hostel') signal('social', 0.5, 'hostels as the lodging style');
  if (profile.discoveryMix === 'deep_cuts') signal('adventurous', 0.3, 'a taste for deep cuts');

  return [...add.entries()]
    .filter(([, value]) => value.strength >= FEELING_FLOOR)
    .map(([feeling, value]) => ({ feeling, strength: Math.round(value.strength * 100) / 100, evidence: value.evidence }))
    .sort((a, b) => b.strength - a.strength || a.feeling.localeCompare(b.feeling));
}

/**
 * How much discomfort these answers actually buy into.
 *
 * **A default is not an answer.** `rusticLodgingOk` defaults to `true` and
 * `remoteComfort` to `fine`, so reading them as positive evidence would make
 * every traveller who was never asked look like somebody who wants to rough it —
 * the "unknown ≠ false" rule this codebase enforces everywhere, run backwards.
 * Only a statement moves this away from `balanced`: a budget position, a refusal
 * of rustic lodging, or a lodging style that is itself the answer.
 */
function roughnessFrom(profile: TravelerProfile): RoughnessTolerance {
  const budget = profile.budgetStyle;
  const lodging = profile.interview?.lodgingStyle;
  if (budget === 'luxury' || lodging === 'luxury_hotel' || lodging === 'resort') return 'comfort_first';
  if (profile.interview?.rusticLodgingOk === false) return 'comfort_first';
  if (budget === 'premium') return 'comfort_first';
  const spare = budget === 'budget' || lodging === 'hostel';
  if (spare && profile.dailyIntensity === 'intense') return 'seeks_rough';
  if (spare) return 'rough_is_fine';
  return 'balanced';
}

function independenceFrom(profile: TravelerProfile): IndependencePreference {
  const guide = profile.interview?.guideWillingness;
  if (guide === 'prefer') return 'guided';
  if (!profile.transport.willDrive && profile.interview?.privateTransfers === 'fine') return 'supported';
  if (profile.transport.willDrive) return 'independent';
  return 'supported';
}

function flexibilityFrom(profile: TravelerProfile): PlanningFlexibility {
  if (profile.freeTime === 'lots') return profile.pace === 'slow' ? 'improvised' : 'loose';
  if (profile.freeTime === 'packed') return 'pinned';
  return 'mostly_planned';
}

/**
 * A short internal name for the kind of trip these answers describe.
 *
 * Built from the traveller's own strongest goals and comfort position, never
 * from the destination — §5 forbids "Paris means urban culture", and this is the
 * function that would be tempted to say it.
 */
function identityFrom(primary: IntentGoal[], roughness: RoughnessTolerance, independence: IndependencePreference): string {
  const lead = primary[0]?.label.toLowerCase();
  const comfort =
    roughness === 'seeks_rough' ? 'rough and self-carried' : roughness === 'rough_is_fine' ? 'simple' : roughness === 'comfort_first' ? 'comfortable' : 'balanced';
  const hands = independence === 'guided' ? 'operator-led' : independence === 'supported' ? 'with transfers arranged' : 'self-directed';
  if (!lead) return `A ${comfort} trip, ${hands}`;
  return `A ${comfort} trip built around ${lead}, ${hands}`;
}

export function deriveTravelerIntent(input: {
  profile: TravelerProfile;
  /** The role answers as the traveller gave them, when the profile's source answers are to hand. */
  interestRoles?: Parameters<typeof rolesFor>[0]['roles'];
  /**
   * The party, which lives on its own rows rather than on the profile (V6).
   * Optional: a caller without it gets an intent with no family signal rather
   * than a guess about who is travelling.
   */
  party?: { children?: number } | undefined;
}): TravelerIntent {
  const { profile } = input;
  const sources = rolesFor({ levels: profile.interests, ...(input.interestRoles ? { roles: input.interestRoles } : {}) });

  const primaryGoals: IntentGoal[] = [];
  const secondaryGoals: IntentGoal[] = [];
  const hardAvoidances: string[] = [];
  const roles = {} as Record<Interest, PreferenceRole>;

  for (const interest of INTERESTS) {
    const source = sources[interest];
    roles[interest] = source.role;
    if (source.role === 'core') primaryGoals.push(goal(interest, source));
    else if (source.role === 'most_days' || source.role === 'several_times') secondaryGoals.push(goal(interest, source));
    else if (source.role === 'avoid') hardAvoidances.push(`${INTEREST_LABELS[interest]} — asked for it to be kept off the plan`);
  }
  /* Strongest first, and stable: a stated role outranks an inferred one at the same rank. */
  const order = (a: IntentGoal, b: IntentGoal): number =>
    PREFERENCE_ROLE_RANK[b.role] - PREFERENCE_ROLE_RANK[a.role] ||
    (a.basis === b.basis ? 0 : a.basis === 'stated' ? -1 : 1) ||
    a.label.localeCompare(b.label);
  primaryGoals.sort(order);
  secondaryGoals.sort(order);

  for (const avoidance of profile.avoidances) hardAvoidances.push(`Stated avoidance: ${avoidance.replace(/_/g, ' ')}`);

  const roughnessTolerance = roughnessFrom(profile);
  const independencePreference = independenceFrom(profile);
  const comfortTradeoffs: string[] = [];
  if (roughnessTolerance === 'seeks_rough' || roughnessTolerance === 'rough_is_fine') comfortTradeoffs.push('Simple lodging is acceptable where it buys a better position or a better day.');
  if (profile.budgetStyle === 'budget') comfortTradeoffs.push('Cost is being traded against convenience.');
  if (profile.transport.willDrive === false && independencePreference !== 'guided') comfortTradeoffs.push('No self-driving: the route must work on arranged or scheduled transport.');
  if (profile.freeTime === 'lots') comfortTradeoffs.push('Unscheduled time is wanted; an empty afternoon is the plan working, not a gap in it.');

  return {
    version: 1,
    primaryGoals,
    secondaryGoals,
    hardAvoidances,
    roles,
    desiredFeeling: feelingsFrom(profile, [...primaryGoals, ...secondaryGoals], input.party),
    roughnessTolerance,
    planningFlexibility: flexibilityFrom(profile),
    independencePreference,
    tripIdentity: identityFrom(primaryGoals, roughnessTolerance, independencePreference),
    comfortTradeoffs,
    socialStyle: profile.interview?.lodgingStyle === 'hostel' ? 'social' : profile.crowdTolerance === 'avoid_crowds' ? 'private' : 'mixed',
    discoveryStyle:
      profile.discoveryMix === 'mostly_classics' ? 'classics' : profile.discoveryMix === 'mostly_hidden' ? 'hidden' : profile.discoveryMix === 'deep_cuts' ? 'deep_cuts' : 'balanced',
  };
}

export const travelerIntentSchema = z.object({
  version: z.literal(1),
  roles: z.record(z.string(), preferenceRoleSchema),
  roughnessTolerance: roughnessToleranceSchema,
  planningFlexibility: planningFlexibilitySchema,
  independencePreference: independencePreferenceSchema,
  tripIdentity: z.string().min(1),
});
