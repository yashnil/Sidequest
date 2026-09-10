import { z } from 'zod';
import { DIETARY_NEEDS, type DietaryNeed } from '../schemas/food';
import { INTEREST_LEVELS } from '../schemas/common';

/**
 * PEOPLE, NOT "5 TRAVELERS".
 *
 * V6 §3–§5. A trip used to carry two counts and four group flags. That is
 * enough to size a car and not enough to plan for a person: the mother who
 * had knee surgery, the child who cannot do a seven-hour day, the friend with
 * a peanut allergy and the partner who is vegetarian are four different
 * planning problems, and averaging them produces a trip that fits nobody.
 *
 * A `Traveler` is a person somebody described. It belongs to an account (or,
 * before sign-in, to the browser that made it) and can be on many trips. A
 * `TripPartyMember` says that a traveller is on this trip, in what role, and
 * whether their preferences and constraints apply to the plan. Nobody has to
 * create an account to be described; the person signed in describes them.
 *
 * Privacy: `privateNotes` and every functional need are planning inputs and
 * nothing else. They never reach a public share, a PDF or a log
 * (`party.test.ts` and `share.spec.ts` hold that line).
 */

export const PARTY_VERSION = 1 as const;

export const AGE_GROUPS = ['infant', 'child', 'teen', 'adult', 'senior'] as const;
export const ageGroupSchema = z.enum(AGE_GROUPS);
export type AgeGroup = z.infer<typeof ageGroupSchema>;

export const AGE_GROUP_LABELS: Record<AgeGroup, string> = {
  infant: 'Infant (under 3)',
  child: 'Child',
  teen: 'Teenager',
  adult: 'Adult',
  senior: 'Older traveller',
};

/**
 * FUNCTIONAL NEEDS — WHAT TO PLAN AROUND, NEVER A DIAGNOSIS.
 *
 * Each value names a planning consequence. The vocabulary is deliberately
 * about the trip ("avoid sustained descents") and not the body ("knee
 * surgery"). Free text is kept verbatim beside the ticks and is never turned
 * into a medical statement.
 */
export const FUNCTIONAL_NEEDS = [
  'limited_walking',
  'avoid_steep_climbs',
  'avoid_steep_descents',
  'step_free_access',
  'frequent_rest',
  'heat_sensitive',
  'cold_sensitive',
  'altitude_sensitive',
  'motion_sickness',
  'pregnancy_limits',
  'predictable_meal_times',
  'frequent_restrooms',
  'medication_cold_storage',
  'cannot_stand_long',
  'cannot_drive',
  'limited_driving',
  'sensory_crowd_sensitive',
] as const;
export const functionalNeedSchema = z.enum(FUNCTIONAL_NEEDS);
export type FunctionalNeed = z.infer<typeof functionalNeedSchema>;

export const FUNCTIONAL_NEED_LABELS: Record<FunctionalNeed, string> = {
  limited_walking: 'Difficulty walking long distances',
  avoid_steep_climbs: 'Avoid steep climbs',
  avoid_steep_descents: 'Avoid steep descents',
  step_free_access: 'Step-free or wheelchair access',
  frequent_rest: 'Needs to sit and rest often',
  heat_sensitive: 'Sensitive to heat',
  cold_sensitive: 'Sensitive to cold',
  altitude_sensitive: 'Sensitive to altitude',
  motion_sickness: 'Motion sickness',
  pregnancy_limits: 'Pregnancy-related limits',
  predictable_meal_times: 'Needs predictable meal times',
  frequent_restrooms: 'Needs frequent restroom access',
  medication_cold_storage: 'Medication needs refrigeration',
  cannot_stand_long: 'Cannot stand for long periods',
  cannot_drive: 'Cannot drive',
  limited_driving: 'Can only drive a little',
  sensory_crowd_sensitive: 'Sensitive to noise and crowds',
};

/**
 * Every need maps to at least one planning consequence, so nothing is asked
 * that the planner cannot use. `party.test.ts` holds every need to this
 * table.
 */
export const PLANNING_CONSEQUENCES = [
  'hike_suitability',
  'walking_distance',
  'stairs_and_terrain',
  'activity_density',
  'season_and_time_of_day',
  'altitude',
  'transport_mode',
  'driving_share',
  'meal_timing',
  'lodging_and_prep',
  'crowd_avoidance',
  'route_shape',
] as const;
export type PlanningConsequence = (typeof PLANNING_CONSEQUENCES)[number];

export const NEED_CONSEQUENCES: Record<FunctionalNeed, readonly PlanningConsequence[]> = {
  limited_walking: ['walking_distance', 'hike_suitability', 'activity_density'],
  avoid_steep_climbs: ['hike_suitability', 'stairs_and_terrain'],
  avoid_steep_descents: ['hike_suitability', 'stairs_and_terrain'],
  step_free_access: ['stairs_and_terrain', 'transport_mode', 'lodging_and_prep'],
  frequent_rest: ['activity_density', 'walking_distance'],
  heat_sensitive: ['season_and_time_of_day', 'activity_density'],
  cold_sensitive: ['season_and_time_of_day', 'lodging_and_prep'],
  altitude_sensitive: ['altitude', 'route_shape'],
  motion_sickness: ['transport_mode', 'route_shape'],
  pregnancy_limits: ['hike_suitability', 'altitude', 'activity_density', 'meal_timing'],
  predictable_meal_times: ['meal_timing', 'activity_density'],
  frequent_restrooms: ['route_shape', 'walking_distance'],
  medication_cold_storage: ['lodging_and_prep'],
  cannot_stand_long: ['activity_density', 'crowd_avoidance'],
  cannot_drive: ['driving_share', 'transport_mode'],
  limited_driving: ['driving_share'],
  sensory_crowd_sensitive: ['crowd_avoidance', 'season_and_time_of_day'],
};

/** The needs that make a strenuous day a hard fail for this person rather than a preference. */
export const STRENUOUS_BLOCKERS: readonly FunctionalNeed[] = ['limited_walking', 'avoid_steep_climbs', 'avoid_steep_descents', 'step_free_access', 'cannot_stand_long', 'pregnancy_limits'];

export const PHYSICAL_CAPABILITIES = ['low', 'moderate', 'high'] as const;
export const physicalCapabilitySchema = z.enum(PHYSICAL_CAPABILITIES);
export type PhysicalCapability = z.infer<typeof physicalCapabilitySchema>;

export const SLEEP_RHYTHMS = ['early', 'normal', 'late'] as const;
export const sleepRhythmSchema = z.enum(SLEEP_RHYTHMS);

export const PARTY_ROLES = ['self', 'partner', 'child', 'parent', 'friend', 'other'] as const;
export const partyRoleSchema = z.enum(PARTY_ROLES);
export type PartyRole = z.infer<typeof partyRoleSchema>;

export const PARTY_ROLE_LABELS: Record<PartyRole, string> = {
  self: 'Me',
  partner: 'Partner',
  child: 'Child',
  parent: 'Parent',
  friend: 'Friend',
  other: 'Other traveller',
};

/** Per-person dietary rule: a ticked need, or free text, each with its own strictness. */
export const travelerDietSchema = z.object({
  needs: z.array(z.enum(DIETARY_NEEDS)).default([]),
  strict: z.boolean().default(false),
  /** A stated allergy is always strict; the flag carries whether cross-contamination matters. */
  allergyCrossContamination: z.boolean().default(false),
  notes: z.string().max(400).optional(),
});
export type TravelerDiet = z.infer<typeof travelerDietSchema>;

export const travelerPersonalProfileSchema = z.object({
  /** Interests this person holds, at the interview's own levels. Optional per person; the trip profile is the default. */
  interests: z.record(z.string(), z.enum(INTEREST_LEVELS)).default({}),
  physicalCapability: physicalCapabilitySchema.optional(),
  sleepRhythm: sleepRhythmSchema.optional(),
  /** budget / mid_range / premium / luxury — the interview's own vocabulary, free here to avoid a second enum. */
  budgetStyle: z.string().max(40).optional(),
  transportComfort: z.array(z.enum(['drives', 'mountain_roads', 'unpaved_roads', 'ferries', 'small_planes', 'long_transit'])).default([]),
  lodgingNeeds: z.array(z.string().max(80)).max(8).default([]),
});
export type TravelerPersonalProfile = z.infer<typeof travelerPersonalProfileSchema>;

export const travelerSchema = z.object({
  id: z.string().min(1),
  version: z.literal(PARTY_VERSION),
  displayName: z.string().trim().min(1).max(60),
  ageGroup: ageGroupSchema.optional(),
  /** Optional, and never inferred. */
  age: z.number().int().min(0).max(120).optional(),
  relationship: partyRoleSchema.optional(),
  diet: travelerDietSchema.default({ needs: [], strict: false, allergyCrossContamination: false }),
  needs: z.array(functionalNeedSchema).default([]),
  /** The traveller's own words about what to plan around. Private. */
  needsNotes: z.string().max(600).optional(),
  profile: travelerPersonalProfileSchema.default({ interests: {}, transportComfort: [], lodgingNeeds: [] }),
  /** Private free text. Never shared, printed or logged. */
  privateNotes: z.string().max(1000).optional(),
  /** When true, `needsNotes` and `privateNotes` are omitted even from the owner's own PDF. */
  privacy: z.object({ hideFromPrint: z.boolean().default(false) }).default({ hideFromPrint: false }),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type Traveler = z.infer<typeof travelerSchema>;

export const tripPartyMemberSchema = z.object({
  tripId: z.string().min(1),
  travelerId: z.string().min(1),
  role: partyRoleSchema,
  /** This person's preferences shape the plan. */
  preferencesApply: z.boolean().default(true),
  /** This person's constraints bind the plan. */
  constraintsApply: z.boolean().default(true),
  /** `described` — the owner wrote them down; `invited` — they will fill their own in later. */
  participation: z.enum(['described', 'invited']).default('described'),
  position: z.number().int().min(0).default(0),
});
export type TripPartyMember = z.infer<typeof tripPartyMemberSchema>;

export interface TripParty {
  members: readonly (TripPartyMember & { traveler: Traveler })[];
}

/** The plain-language rules a traveller's diet produces, one per requirement. */
export function dietaryRulesOf(diet: TravelerDiet, labels: Record<DietaryNeed, string>): { label: string; strict: boolean }[] {
  const rules = diet.needs.map((need) => ({ label: labels[need], strict: diet.strict || /allerg/i.test(labels[need]) }));
  if (diet.notes?.trim()) rules.push({ label: diet.notes.trim(), strict: diet.strict });
  return rules;
}
