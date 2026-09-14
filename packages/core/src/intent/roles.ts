import { z } from 'zod';
import { INTERESTS, interestSchema, type Interest, type InterestLevel } from '../schemas/common';

/**
 * V12 §2 §30 — THE ROLE A PREFERENCE PLAYS, WHICH IS NOT HOW MUCH IT IS LIKED.
 *
 * The questionnaire has asked this for a long time and the answer has never
 * survived the journey into the profile. `priority_roles` puts four roles in
 * front of the traveller —
 *
 *   once         "One great one"             a single standout, not a theme
 *   couple       "A couple of times"         woven through the trip
 *   most_days    "Most days"                 expect it on the majority of days
 *   build_around "Build the trip around it"  this is the reason for the trip
 *
 * — and `ROLE_LEVEL` in the catalog then folds the answer into the five-value
 * `InterestLevel`, where **`most_days` and `build_around` both become `core`**.
 * The difference between "I want to walk most days" and "this trip exists
 * because of the trek" is asked, answered, and thrown away one function later;
 * the read-back mapping even shows a traveller who chose "Build the trip around
 * it" the words "Most days" when they come back to the screen.
 *
 * That is the V12 thesis in one line of code. The information a planner needs to
 * treat two trips differently is already being collected; the pipeline flattens
 * it before anything can act on it.
 *
 * So the role is kept as its own fact. `InterestLevel` is untouched and every
 * existing reader keeps working — scoring, frequency caps, the brief — and the
 * role sits beside it for the layers that need to know whether something is a
 * theme or the reason for the journey.
 */
export const PREFERENCE_ROLES = [
  /** Presence is a negative. Only a hard requirement may override it. */
  'avoid',
  /** Include only where it is already convenient. */
  'opportunistic',
  /** One strong inclusion satisfies it completely. */
  'once',
  /** Woven through the trip; needs repeated representation where the ground affords it. */
  'several_times',
  /** Expected on the majority of days: a rhythm rather than a set of stops. */
  'most_days',
  /** Must materially shape the trip's structure — its chapters, its bases, its route. */
  'core',
] as const;
export const preferenceRoleSchema = z.enum(PREFERENCE_ROLES);
export type PreferenceRole = z.infer<typeof preferenceRoleSchema>;

/** Strongest last, so two roles can be compared without a lookup table at the call site. */
export const PREFERENCE_ROLE_RANK: Record<PreferenceRole, number> = {
  avoid: 0,
  opportunistic: 1,
  once: 2,
  several_times: 3,
  most_days: 4,
  core: 5,
};

/**
 * What each role demands of the finished trip.
 *
 * Written as the coverage test rather than as a label, because §31 is explicit
 * that a role is not a checkbox: "one ramen lunch does not satisfy food=core".
 * `minOccurrences` is a floor on *distinct* days carrying the interest, and
 * `shapesStructure` is the separate question of whether the trip has to be
 * built differently because of it.
 */
export interface RoleDemand {
  /** Distinct days that must carry it, before the destination's own affordance is considered. */
  minOccurrences: number;
  /** Whether a chapter or a base has to exist because of this preference. */
  shapesStructure: boolean;
  /** Whether repeated representation is expected where the ground affords it. */
  wantsRepetition: boolean;
  /** One sentence, for the report and for the traveller-facing explanation. */
  reads: string;
}

export const ROLE_DEMANDS: Record<PreferenceRole, RoleDemand> = {
  avoid: { minOccurrences: 0, shapesStructure: false, wantsRepetition: false, reads: 'Kept off the plan unless something else requires it.' },
  opportunistic: { minOccurrences: 0, shapesStructure: false, wantsRepetition: false, reads: 'Included where it is already convenient.' },
  once: { minOccurrences: 1, shapesStructure: false, wantsRepetition: false, reads: 'One strong inclusion.' },
  several_times: { minOccurrences: 2, shapesStructure: false, wantsRepetition: true, reads: 'Woven through the trip.' },
  most_days: { minOccurrences: 3, shapesStructure: false, wantsRepetition: true, reads: 'On the majority of days.' },
  core: { minOccurrences: 2, shapesStructure: true, wantsRepetition: true, reads: 'The trip is built around it.' },
};

/**
 * The four answers `priority_roles` actually offers, as they are stored.
 *
 * Kept as its own type so the questionnaire's vocabulary and the planner's
 * vocabulary can differ without either one silently becoming the other.
 */
export const PRIORITY_ROLE_ANSWERS = ['once', 'couple', 'most_days', 'build_around'] as const;
export const priorityRoleAnswerSchema = z.enum(PRIORITY_ROLE_ANSWERS);
export type PriorityRoleAnswer = z.infer<typeof priorityRoleAnswerSchema>;

/** The traveller's own words for each answer, mapped to what it demands of the plan. */
const ANSWER_ROLE: Record<PriorityRoleAnswer, PreferenceRole> = {
  once: 'once',
  couple: 'several_times',
  most_days: 'most_days',
  build_around: 'core',
};

/**
 * The fallback, for an interest whose role was never asked.
 *
 * `core` maps to `most_days` rather than to `core`, deliberately: a level of
 * `core` is all that survives of *either* "most days" or "build the trip around
 * it", so reading it back as the stronger of the two would invent a claim the
 * traveller may not have made. Where the role itself was recorded it is used and
 * this table is not consulted.
 */
const LEVEL_ROLE: Record<InterestLevel, PreferenceRole> = {
  avoid: 'avoid',
  low: 'opportunistic',
  occasional: 'once',
  frequent: 'several_times',
  core: 'most_days',
};

export interface RoleSource {
  role: PreferenceRole;
  /** `stated` — the traveller answered `priority_roles`. `inferred` — read back from the level. */
  basis: 'stated' | 'inferred';
}

/**
 * The role for one interest: the recorded answer where there is one, the level
 * where there is not, and which of the two it was.
 */
export function roleFor(interest: Interest, input: { levels: Partial<Record<Interest, InterestLevel>>; roles?: Partial<Record<Interest, PriorityRoleAnswer>> | undefined }): RoleSource {
  const stated = input.roles?.[interest];
  if (stated && ANSWER_ROLE[stated]) return { role: ANSWER_ROLE[stated], basis: 'stated' };
  return { role: LEVEL_ROLE[input.levels[interest] ?? 'low'], basis: 'inferred' };
}

/** Every interest's role, in one record. Absent interests read as `opportunistic`, never as missing. */
export function rolesFor(input: { levels: Partial<Record<Interest, InterestLevel>>; roles?: Partial<Record<Interest, PriorityRoleAnswer>> | undefined }): Record<Interest, RoleSource> {
  const out = {} as Record<Interest, RoleSource>;
  for (const interest of INTERESTS) out[interest] = roleFor(interest, input);
  return out;
}

/*
 * Partial, for the same reason `interestLevelsSchema` is: the offer is
 * per-destination, so a complete set of roles is not something an honest wizard
 * can produce, and a stored answer set must keep parsing when the interest
 * vocabulary grows.
 */
export const interestRolesSchema = z.partialRecord(interestSchema, priorityRoleAnswerSchema);
export type InterestRoles = z.infer<typeof interestRolesSchema>;
