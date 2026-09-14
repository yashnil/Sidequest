import { z } from 'zod';
import type { DestinationAffordanceProfile, TravelStyle } from '../destinations/affordances';
import { affords } from '../destinations/affordances';
import type { TravelerIntent } from '../intent/traveler-intent';
import { PREFERENCE_ROLE_RANK } from '../intent/roles';
import type { Interest } from '../schemas/common';

/**
 * V12 §6 §7 — HOW *THIS* TRIP SHOULD WORK.
 *
 * Not a category the traveller picks, not a label on a destination, and not
 * something the model returns. It is derived, before the composition call, from
 * the meeting of three things:
 *
 *     TravelerIntent  ×  DestinationAffordanceProfile  ×  the trip's own facts
 *
 * and it decides how the trip should be *planned*, *verified* and *judged* —
 * never what should be in it. §13 is the constraint that keeps this honest: a
 * policy says what matters, what to check and how quality should be measured; it
 * does not say lake → hike → scenic drive. The model still authors the trip.
 *
 * ── WHY THIS IS NEW, GIVEN `TripArchetype` ALREADY EXISTS ────────────────────
 *
 * `TRIP_ARCHETYPES` (14 values on `package.archetype`) is written by the model
 * *after* it has composed, and is read by exactly one consumer — the readiness
 * requirements. It is a label describing what came back. This is the opposite:
 * derived *before* the call, it goes into the composition envelope, and the
 * verification and quality layers read it afterwards. The archetype answers
 * "what did we get?"; the operating model answers "what were we trying to
 * build, and how should it be checked?".
 */

/**
 * The operating families. Small, extensible, and about *behaviour* — §7 is
 * explicit that the names matter less than what each one changes.
 *
 * `mixed_regional` is the honest default rather than a catch-all: a trip whose
 * intent and ground do not point clearly at one family is genuinely a mixed
 * trip, and saying so is better than forcing it.
 */
export const OPERATING_TYPES = [
  'urban_culture',
  'urban_food_nightlife',
  'urban_family',
  'overland_backpacking',
  'mountain_road_trip',
  'multi_day_trek',
  'guided_wildlife',
  'resort_stay',
  'island_hopping',
  'rail_journey',
  'self_drive_road_trip',
  'remote_overland',
  'mixed_regional',
] as const;
export const operatingTypeSchema = z.enum(OPERATING_TYPES);
export type OperatingType = z.infer<typeof operatingTypeSchema>;

export const BASE_PATTERNS = ['single_base', 'hub_and_spoke', 'progression', 'loop', 'operator_owned'] as const;
export const MOBILITY_PATTERNS = ['walk_and_transit', 'self_drive', 'driven', 'scheduled_transport', 'operator_transfer', 'trail', 'mixed'] as const;
export const SCHEDULE_GRANULARITIES = ['to_the_hour', 'to_the_part_of_day', 'loose'] as const;
export const ACTIVITY_DENSITIES = ['sparse', 'light', 'moderate', 'full'] as const;
export const LODGING_PATTERNS = ['neighbourhood_matters', 'social_lodging', 'property_is_the_trip', 'access_defines_it', 'experience_owned', 'practical'] as const;
export const FOOD_PATTERNS = ['named_meals_matter', 'convenient_fuel', 'operator_provided', 'meal_plan', 'self_supplied'] as const;
export const DAY_RHYTHMS = ['early_start', 'standard', 'slow_morning', 'dawn_and_dusk', 'no_fixed_rhythm'] as const;

export type BasePattern = (typeof BASE_PATTERNS)[number];
export type MobilityPattern = (typeof MOBILITY_PATTERNS)[number];
export type ScheduleGranularity = (typeof SCHEDULE_GRANULARITIES)[number];
export type ActivityDensity = (typeof ACTIVITY_DENSITIES)[number];
export type LodgingPattern = (typeof LODGING_PATTERNS)[number];
export type FoodPattern = (typeof FOOD_PATTERNS)[number];
export type DayRhythm = (typeof DAY_RHYTHMS)[number];

/**
 * What a policy changes. Every field here must be *read* by something — §62's
 * rule against decorative data, and the reason this is a typed model rather than
 * a bag of flags.
 */
export interface OperatingPolicy {
  basePattern: BasePattern;
  mobilityPattern: MobilityPattern;
  scheduleGranularity: ScheduleGranularity;
  activityDensity: ActivityDensity;
  lodgingPattern: LodgingPattern;
  foodPattern: FoodPattern;
  dayRhythm: DayRhythm;
  /** 0–1. How much a hotel change costs this trip. A resort split is expensive; a road trip's is not. */
  hotelChangeCost: number;
  /** 0–1. How much unscheduled time is *wanted*, as opposed to left over. */
  restExpectation: number;
  /** 0–1. How much of the plan depends on something being arranged in advance. */
  bookingIntensity: number;
  /** 0–1. How much the trip's success depends on an operator doing their part. */
  operatorDependence: number;
  /** 0–1. How much the route itself is the point. */
  routeImportance: number;
  /** 0–1. How much recovery the rhythm has to build in. */
  recoveryImportance: number;
  /** 0–1. How certain the transport has to be before the trip is considered ready. */
  transportCertaintyRequirement: number;
}

export interface TripOperatingModel {
  version: 1;
  type: OperatingType;
  /** 0–1. How strongly the inputs point at this family. Low confidence is a real answer. */
  confidence: number;
  policy: OperatingPolicy;
  /** Why this family, in sentences a person can check. Never a score dump. */
  rationale: string[];
  /** Families that nearly fit. Kept because a mixed trip is normal (§44). */
  alternatives: { type: OperatingType; score: number }[];
}

/** The defaults each family brings. A derivation may then adjust them for the traveller. */
const POLICIES: Record<OperatingType, OperatingPolicy> = {
  urban_culture: { basePattern: 'single_base', mobilityPattern: 'walk_and_transit', scheduleGranularity: 'to_the_hour', activityDensity: 'moderate', lodgingPattern: 'neighbourhood_matters', foodPattern: 'convenient_fuel', dayRhythm: 'standard', hotelChangeCost: 0.8, restExpectation: 0.3, bookingIntensity: 0.6, operatorDependence: 0.1, routeImportance: 0.2, recoveryImportance: 0.2, transportCertaintyRequirement: 0.3 },
  urban_food_nightlife: { basePattern: 'single_base', mobilityPattern: 'walk_and_transit', scheduleGranularity: 'to_the_hour', activityDensity: 'moderate', lodgingPattern: 'neighbourhood_matters', foodPattern: 'named_meals_matter', dayRhythm: 'slow_morning', hotelChangeCost: 0.8, restExpectation: 0.4, bookingIntensity: 0.75, operatorDependence: 0.1, routeImportance: 0.15, recoveryImportance: 0.25, transportCertaintyRequirement: 0.3 },
  urban_family: { basePattern: 'single_base', mobilityPattern: 'walk_and_transit', scheduleGranularity: 'to_the_part_of_day', activityDensity: 'light', lodgingPattern: 'practical', foodPattern: 'convenient_fuel', dayRhythm: 'standard', hotelChangeCost: 0.9, restExpectation: 0.5, bookingIntensity: 0.5, operatorDependence: 0.1, routeImportance: 0.15, recoveryImportance: 0.4, transportCertaintyRequirement: 0.4 },
  overland_backpacking: { basePattern: 'progression', mobilityPattern: 'scheduled_transport', scheduleGranularity: 'loose', activityDensity: 'light', lodgingPattern: 'social_lodging', foodPattern: 'self_supplied', dayRhythm: 'no_fixed_rhythm', hotelChangeCost: 0.15, restExpectation: 0.5, bookingIntensity: 0.25, operatorDependence: 0.2, routeImportance: 0.8, recoveryImportance: 0.5, transportCertaintyRequirement: 0.55 },
  mountain_road_trip: { basePattern: 'progression', mobilityPattern: 'self_drive', scheduleGranularity: 'to_the_part_of_day', activityDensity: 'moderate', lodgingPattern: 'access_defines_it', foodPattern: 'self_supplied', dayRhythm: 'early_start', hotelChangeCost: 0.3, restExpectation: 0.3, bookingIntensity: 0.5, operatorDependence: 0.2, routeImportance: 0.9, recoveryImportance: 0.4, transportCertaintyRequirement: 0.85 },
  multi_day_trek: { basePattern: 'operator_owned', mobilityPattern: 'trail', scheduleGranularity: 'to_the_part_of_day', activityDensity: 'full', lodgingPattern: 'experience_owned', foodPattern: 'operator_provided', dayRhythm: 'early_start', hotelChangeCost: 0.05, restExpectation: 0.2, bookingIntensity: 0.85, operatorDependence: 0.9, routeImportance: 0.95, recoveryImportance: 0.9, transportCertaintyRequirement: 0.4 },
  guided_wildlife: { basePattern: 'hub_and_spoke', mobilityPattern: 'operator_transfer', scheduleGranularity: 'to_the_part_of_day', activityDensity: 'moderate', lodgingPattern: 'access_defines_it', foodPattern: 'operator_provided', dayRhythm: 'dawn_and_dusk', hotelChangeCost: 0.5, restExpectation: 0.45, bookingIntensity: 0.95, operatorDependence: 0.95, routeImportance: 0.4, recoveryImportance: 0.6, transportCertaintyRequirement: 0.5 },
  resort_stay: { basePattern: 'single_base', mobilityPattern: 'operator_transfer', scheduleGranularity: 'loose', activityDensity: 'sparse', lodgingPattern: 'property_is_the_trip', foodPattern: 'meal_plan', dayRhythm: 'slow_morning', hotelChangeCost: 0.95, restExpectation: 0.9, bookingIntensity: 0.7, operatorDependence: 0.6, routeImportance: 0.05, recoveryImportance: 0.2, transportCertaintyRequirement: 0.75 },
  island_hopping: { basePattern: 'progression', mobilityPattern: 'scheduled_transport', scheduleGranularity: 'to_the_part_of_day', activityDensity: 'light', lodgingPattern: 'practical', foodPattern: 'convenient_fuel', dayRhythm: 'standard', hotelChangeCost: 0.35, restExpectation: 0.6, bookingIntensity: 0.6, operatorDependence: 0.4, routeImportance: 0.75, recoveryImportance: 0.3, transportCertaintyRequirement: 0.9 },
  rail_journey: { basePattern: 'progression', mobilityPattern: 'scheduled_transport', scheduleGranularity: 'to_the_hour', activityDensity: 'moderate', lodgingPattern: 'neighbourhood_matters', foodPattern: 'convenient_fuel', dayRhythm: 'standard', hotelChangeCost: 0.35, restExpectation: 0.35, bookingIntensity: 0.65, operatorDependence: 0.3, routeImportance: 0.8, recoveryImportance: 0.25, transportCertaintyRequirement: 0.9 },
  self_drive_road_trip: { basePattern: 'progression', mobilityPattern: 'self_drive', scheduleGranularity: 'to_the_part_of_day', activityDensity: 'moderate', lodgingPattern: 'practical', foodPattern: 'self_supplied', dayRhythm: 'standard', hotelChangeCost: 0.3, restExpectation: 0.35, bookingIntensity: 0.4, operatorDependence: 0.15, routeImportance: 0.9, recoveryImportance: 0.3, transportCertaintyRequirement: 0.85 },
  remote_overland: { basePattern: 'progression', mobilityPattern: 'driven', scheduleGranularity: 'to_the_part_of_day', activityDensity: 'light', lodgingPattern: 'practical', foodPattern: 'self_supplied', dayRhythm: 'early_start', hotelChangeCost: 0.2, restExpectation: 0.4, bookingIntensity: 0.6, operatorDependence: 0.7, routeImportance: 0.85, recoveryImportance: 0.6, transportCertaintyRequirement: 0.6 },
  mixed_regional: { basePattern: 'hub_and_spoke', mobilityPattern: 'mixed', scheduleGranularity: 'to_the_part_of_day', activityDensity: 'moderate', lodgingPattern: 'practical', foodPattern: 'convenient_fuel', dayRhythm: 'standard', hotelChangeCost: 0.45, restExpectation: 0.4, bookingIntensity: 0.5, operatorDependence: 0.3, routeImportance: 0.5, recoveryImportance: 0.35, transportCertaintyRequirement: 0.6 },
};

/**
 * What defines each family.
 *
 * Three parts, and the split matters:
 *
 * - `requires` — the affordance that makes this family *this* family. A trek is
 *   not a trek because the ground has mountains; it is a trek because the ground
 *   affords a multi-day route. Listing a merely adjacent style here is what made
 *   an early version score `multi_day_trek` off `mountain_hiking` and call a
 *   Rockies drive an expedition.
 * - `lead` — the interest whose role decides whether the traveller wants this at
 *   all. Scored on the strongest lead, so a family nobody asked for scores zero
 *   however well the ground supports it. This is the §5 guarantee in one line:
 *   the ground can support or refuse, it can never propose.
 * - `supports` — interests that make the fit better without being able to create
 *   it on their own.
 */
const SIGNALS: Record<OperatingType, { requires: TravelStyle[]; lead: Interest[]; supports?: Interest[] }> = {
  /*
   * Immersion in a place's own life is culture, not backpacking. Leaving
   * `neighbourhoods_and_local_life` off this lead sent every traveller who
   * named it to `overland_backpacking`, whatever their budget or comfort.
   */
  urban_culture: { requires: ['urban_culture', 'museums_and_galleries'], lead: ['history_and_culture', 'museums_and_galleries', 'neighbourhoods_and_local_life'], supports: ['architecture_and_landmarks'] },
  urban_food_nightlife: { requires: ['urban_food', 'urban_nightlife'], lead: ['food_and_towns', 'markets_and_street_food'], supports: ['neighbourhoods_and_local_life'] },
  urban_family: { requires: ['urban_culture'], lead: ['easy_nature_walks'], supports: ['architecture_and_landmarks'] },
  overland_backpacking: { requires: ['neighbourhood_immersion'], lead: ['neighbourhoods_and_local_life', 'markets_and_street_food'], supports: ['hiking'] },
  mountain_road_trip: { requires: ['scenic_road_trip', 'mountain_hiking'], lead: ['hiking'], supports: ['scenic_drives', 'scenic_viewpoints', 'lakes_and_rivers'] },
  multi_day_trek: { requires: ['multi_day_trek'], lead: ['hiking'] },
  guided_wildlife: { requires: ['wildlife_watching'], lead: ['wildlife'] },
  resort_stay: { requires: ['resort_stay', 'beach_relaxation'], lead: ['beaches_and_swimming'] },
  island_hopping: { requires: ['island_hopping'], lead: ['beaches_and_swimming'], supports: ['lakes_and_rivers'] },
  rail_journey: { requires: ['rail_journey'], lead: ['history_and_culture', 'neighbourhoods_and_local_life'] },
  self_drive_road_trip: { requires: ['scenic_road_trip'], lead: ['scenic_drives'], supports: ['scenic_viewpoints'] },
  /*
   * Remote overland is about *covering* remote ground, which is why its lead is
   * not hiking: a hiking-led trip in a remote place is a trek, and listing
   * hiking here made every expedition score as an overland drive instead.
   */
  remote_overland: { requires: ['remote_wilderness'], lead: ['scenic_viewpoints'], supports: ['hiking', 'wildlife'] },
  mixed_regional: { requires: [], lead: [] },
};

const STYLE_WEIGHT: Record<string, number> = { strong: 1, seasonal: 0.6, possible: 0.5, weak: 0, unknown: 0 };

/**
 * Derive the operating model.
 *
 * Scored rather than switched, because §44 is right that most good trips are
 * mixed and a hard classifier would have to pretend otherwise. The score is
 * **intent led**: the ground can only support or refuse what the traveller
 * wants, it can never propose a family on its own. That is what stops this
 * becoming "the Rockies means road trip" — the thing §5 forbids.
 */
export function deriveOperatingModel(input: {
  intent: TravelerIntent;
  affordances: DestinationAffordanceProfile;
  nights: number;
  /** Whether the traveller drives themselves, read from the contract rather than guessed. */
  willDrive: boolean;
}): TripOperatingModel {
  const { intent, affordances } = input;
  const roleWeight = (interest: Interest): number => {
    const rank = PREFERENCE_ROLE_RANK[intent.roles[interest] ?? 'opportunistic'];
    if (rank <= PREFERENCE_ROLE_RANK.opportunistic) return 0;
    return (rank - PREFERENCE_ROLE_RANK.once + 1) / (PREFERENCE_ROLE_RANK.core - PREFERENCE_ROLE_RANK.once + 1);
  };

  const scored = OPERATING_TYPES.map((type) => {
    const signal = SIGNALS[type];
    /* What the traveller wants: the strongest role among the interests that *define* this family. */
    const wanted = signal.lead.reduce((best, interest) => Math.max(best, roleWeight(interest)), 0);
    /* What the ground affords: the best of the styles that make this family itself. */
    const offered = signal.requires.reduce((best, style) => Math.max(best, STYLE_WEIGHT[affords(affordances, style)] ?? 0), 0);
    /* A supporting interest improves a fit it could not have created. */
    const support = (signal.supports ?? []).reduce((best, interest) => Math.max(best, roleWeight(interest)), 0);
    let score = wanted === 0 ? 0 : wanted * (affordances.unknown ? 0.5 : offered) * (1 + support * 0.15);
    /* Comfort and independence shift the families that are defined by them. */
    /*
     * Backpacking is defined by roughing it, not by an interest. A traveller who
     * wants to be among local life on a mid-range budget is on a cultural trip;
     * the same answers with a spare budget and simple lodging are backpacking.
     */
    if (type === 'overland_backpacking') {
      if (intent.roughnessTolerance === 'rough_is_fine' || intent.roughnessTolerance === 'seeks_rough') score *= 1.8;
      else if (intent.roughnessTolerance === 'comfort_first') score *= 0.2;
      else score *= 0.3;
    }
    /* And a resort is defined by wanting to be looked after; without that signal it is just an island. */
    if (type === 'resort_stay') {
      const restful = intent.desiredFeeling.some((f) => f.feeling === 'restful');
      if (intent.roughnessTolerance === 'comfort_first') score *= 1.4;
      if (restful) score *= 1.3;
      if (!restful && intent.roughnessTolerance !== 'comfort_first') score *= 0.7;
    }
    if (type === 'multi_day_trek' && intent.desiredFeeling.some((f) => f.feeling === 'challenging')) score *= 1.3;
    if (type === 'guided_wildlife' && intent.independencePreference === 'guided') score *= 1.3;
    /*
     * Not a weight — a refusal. A traveller who told us they are not driving has
     * made a `user_explicit` statement, and a family whose whole mobility
     * pattern is "you drive it" is not a weaker fit for them, it is not a fit.
     * Weighting it down left it selected anyway whenever nothing else scored,
     * which is how a non-driver was handed a self-drive road trip.
     */
    if (POLICIES[type].mobilityPattern === 'self_drive' && !input.willDrive) return { type, score: 0 };
    if (type === 'remote_overland' && input.willDrive) score *= 0.6;
    if (type === 'urban_family' && intent.desiredFeeling.some((f) => f.feeling === 'family_friendly')) score *= 1.6;
    if (type === 'urban_food_nightlife' && intent.roles.food_and_towns === 'core') score *= 1.3;
    /* Somebody who wants to improvise is not island-hopping to a ferry timetable. */
    if (type === 'island_hopping' && intent.planningFlexibility === 'improvised') score *= 0.5;
    /* A single-base family is a poor fit for a long trip, and a progression for a very short one. */
    const pattern = POLICIES[type].basePattern;
    if (pattern === 'single_base' && input.nights > 10) score *= 0.7;
    if (pattern === 'progression' && input.nights < 4) score *= 0.6;
    return { type, score: Math.round(score * 1000) / 1000 };
  })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.type.localeCompare(b.type));

  const lead = scored[0];
  const runnerUp = scored[1];
  /*
   * A clear lead, or an honest "mixed". The margin matters more than the height:
   * two families scoring 0.90 and 0.88 is a mixed trip, not a confident one.
   */
  const margin = lead && runnerUp ? lead.score - runnerUp.score : (lead?.score ?? 0);
  const confident = Boolean(lead) && (scored.length === 1 || margin >= 0.15);
  const type: OperatingType = confident && lead ? lead.type : 'mixed_regional';

  const rationale: string[] = [];
  if (!lead) rationale.push('Nothing in the answers points at a particular way of travelling, so the trip is planned as a mixed regional one.');
  else if (!confident) rationale.push(`Two ways of travelling fit these answers almost equally (${scored.slice(0, 2).map((entry) => entry.type.replace(/_/g, ' ')).join(' and ')}), so the trip is planned as a mixed one and each chapter decides for itself.`);
  else {
    const goal = intent.primaryGoals[0]?.label ?? intent.secondaryGoals[0]?.label;
    rationale.push(`${goal ? `${goal} leads these answers` : 'These answers'}, and the ground here supports it, so the trip is planned as ${type.replace(/_/g, ' ')}.`);
  }
  if (affordances.unknown) rationale.push('Nothing could be screened about this destination, so the ground neither supports nor refuses any of this — the traveller’s answers decided it alone.');
  if (intent.roughnessTolerance === 'comfort_first') rationale.push('Comfort is being paid for, so rougher ways of covering the same ground are weighted down.');
  if (!input.willDrive) rationale.push('The traveller is not driving, so families that depend on a self-driven route are weighted down.');

  return {
    version: 1,
    type,
    confidence: confident ? Math.min(1, Math.round((lead?.score ?? 0) * 100) / 100) : Math.round(Math.min(0.5, lead?.score ?? 0) * 100) / 100,
    policy: POLICIES[type],
    rationale,
    alternatives: scored.slice(0, 3),
  };
}

export function policyFor(type: OperatingType): OperatingPolicy {
  return POLICIES[type];
}
