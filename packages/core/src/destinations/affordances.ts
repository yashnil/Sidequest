import { z } from 'zod';
import type { DestinationQuestionContext, DestinationTrait } from '../interview/traits';
import { modeStatusFor } from '../reality/schema';
import type { TravelReality } from '../reality/schema';

/**
 * V12 §4 §5 — WHAT THIS PLACE SUPPORTS, ON THESE DATES.
 *
 * Destination *semantics* (V8.1/V10) say what a destination **is**: its type,
 * scale, extent, jurisdictions, parts. This says what styles of travel it
 * naturally **affords** — which is a different question, and the one a planner
 * needs in order to treat the same place differently for two different
 * travellers.
 *
 * ── THE RULE THAT MATTERS MOST (§5) ─────────────────────────────────────────
 *
 * **No destination is named here, and none ever may be.** There is no table
 * saying "Paris means urban culture" or "Rwanda means gorillas", because the
 * same place supports many trips: Paris affords art, food, nightlife, family
 * sightseeing and romance; the Rockies afford serious hiking, a family scenic
 * drive, photography and a luxury lodge week. An affordance profile says what is
 * *possible* here; `TravelerIntent` says what is *wanted*; the operating model is
 * the meeting of the two. A file that named places would be answering both
 * questions at once, which is exactly the shortcut §5 forbids.
 *
 * Every affordance below is therefore derived from evidence that already exists
 * and already carries its own basis sentence: the 29 destination traits
 * (`interview/traits.ts`, each gated on screening evidence), the travel reality
 * (`reality/schema.ts`, a mode status per country with authority and freshness),
 * and the dates. A destination nobody could screen yields **no affordances at
 * all**, which is the honest answer rather than a generic one.
 *
 * ── AFFORDANCES ARE NOT OPERATIONAL FACTS ───────────────────────────────────
 *
 * §4 is explicit: an affordance may help planning, but a closure, a schedule or
 * a permit still requires evidence. Nothing here may be read as "open", "running"
 * or "available on your dates" — that is `AccessConstraint` and the calendar
 * layer's job. `seasonal` below means "this is a seasonal style here", never
 * "this is in season now".
 */

/**
 * The styles of travel a place can support.
 *
 * Deliberately a small, generic vocabulary about *how one travels*, not about
 * what exists there. "mountain_hiking" is a way of spending a week; "mountains"
 * would be a feature of the ground, which the semantics already record.
 */
export const TRAVEL_STYLES = [
  'urban_culture',
  'urban_food',
  'urban_nightlife',
  'museums_and_galleries',
  'neighbourhood_immersion',
  'mountain_hiking',
  'multi_day_trek',
  'alpine_scenery',
  'scenic_road_trip',
  'rail_journey',
  'wildlife_watching',
  'beach_relaxation',
  'water_activities',
  'island_hopping',
  'resort_stay',
  'remote_wilderness',
  'photography',
  'winter_sports',
  'thermal_and_spa',
  'family_nature',
] as const;
export const travelStyleSchema = z.enum(TRAVEL_STYLES);
export type TravelStyle = z.infer<typeof travelStyleSchema>;

/** How well the place supports a style. `seasonal` is about the style, never about the dates being open. */
export const AFFORDANCE_STRENGTHS = ['strong', 'seasonal', 'possible', 'weak'] as const;
export const affordanceStrengthSchema = z.enum(AFFORDANCE_STRENGTHS);
export type AffordanceStrength = z.infer<typeof affordanceStrengthSchema>;

/**
 * How a place *works* operationally, as a planning trait rather than a fact.
 *
 * These change how a trip has to be built — what it depends on, what costs a
 * whole day, what cannot be done without arranging something — without
 * asserting anything dated.
 */
export const OPERATIONAL_TRAITS = [
  'car_or_shuttle_dependence',
  'dense_transit',
  'single_base_viable',
  'multi_base_likely',
  'long_internal_transfers',
  'water_transfer_dependency',
  'internal_flight_likely',
  'operator_or_guide_dependence',
  'permit_or_reservation_pressure',
  'weather_exposed_access',
  'seasonal_access_windows',
  'altitude_exposure',
  'thin_services',
  'border_crossing',
] as const;
export const operationalTraitSchema = z.enum(OPERATIONAL_TRAITS);
export type OperationalTrait = (typeof OPERATIONAL_TRAITS)[number];

export interface Affordance {
  style: TravelStyle;
  strength: AffordanceStrength;
  /** Why we think so, in one sentence, from the evidence that produced it. Never invented. */
  basis: string;
}

export interface DestinationAffordanceProfile {
  version: 1;
  affordances: Affordance[];
  operationalTraits: { trait: OperationalTrait; basis: string }[];
  /**
   * True when the screening produced nothing to reason from. A caller must treat
   * this as "we do not know what this place affords", never as "it affords
   * nothing" — the distinction this codebase draws everywhere else.
   */
  unknown: boolean;
}

type StyleRule = {
  style: TravelStyle;
  strength: AffordanceStrength;
  /** Traits that must all be present. */
  when: DestinationTrait[];
  /** A mode the country's own reality must not call unavailable, when the style depends on one. */
  needsMode?: Parameters<typeof modeStatusFor>[1];
};

/**
 * The derivation table: trait evidence in, travel style out.
 *
 * Read it as "a place screened as X can support Y", never as "X is Y". Several
 * styles are reachable by more than one route, and the strongest match wins.
 */
const STYLE_RULES: StyleRule[] = [
  { style: 'urban_culture', strength: 'strong', when: ['dense_urban'] },
  { style: 'museums_and_galleries', strength: 'strong', when: ['dense_urban'] },
  { style: 'neighbourhood_immersion', strength: 'strong', when: ['dense_urban', 'walk_heavy'] },
  { style: 'neighbourhood_immersion', strength: 'possible', when: ['dense_urban'] },
  { style: 'urban_food', strength: 'strong', when: ['food_dense'] },
  { style: 'urban_food', strength: 'possible', when: ['dense_urban'] },
  { style: 'urban_nightlife', strength: 'strong', when: ['nightlife_dense'] },
  { style: 'urban_nightlife', strength: 'weak', when: ['wilderness'] },
  { style: 'urban_nightlife', strength: 'weak', when: ['remote'] },

  { style: 'mountain_hiking', strength: 'strong', when: ['mountain'] },
  { style: 'multi_day_trek', strength: 'possible', when: ['mountain', 'remote'] },
  { style: 'multi_day_trek', strength: 'possible', when: ['wilderness'] },
  { style: 'alpine_scenery', strength: 'strong', when: ['mountain'] },
  { style: 'photography', strength: 'strong', when: ['mountain'] },
  { style: 'photography', strength: 'possible', when: ['beach'] },

  { style: 'scenic_road_trip', strength: 'strong', when: ['road_trip_region'] },
  { style: 'scenic_road_trip', strength: 'possible', when: ['car_dependent'] },
  { style: 'rail_journey', strength: 'possible', when: ['transit_rich'], needsMode: 'intercity_train' },

  /* Wilderness is where wildlife is watched; calling that merely "possible" let an overland drive outrank a wildlife trip on its own ground. */
  { style: 'wildlife_watching', strength: 'strong', when: ['wilderness'] },
  { style: 'remote_wilderness', strength: 'strong', when: ['wilderness'] },
  { style: 'remote_wilderness', strength: 'strong', when: ['remote'] },
  { style: 'family_nature', strength: 'possible', when: ['road_trip_region'] },

  { style: 'beach_relaxation', strength: 'strong', when: ['beach'] },
  { style: 'water_activities', strength: 'strong', when: ['beach'] },
  { style: 'water_activities', strength: 'possible', when: ['island'] },
  { style: 'island_hopping', strength: 'strong', when: ['archipelago'], needsMode: 'ferry' },
  { style: 'resort_stay', strength: 'possible', when: ['beach'] },

  { style: 'winter_sports', strength: 'seasonal', when: ['mountain', 'winter_access'] },
  { style: 'thermal_and_spa', strength: 'possible', when: ['mountain'] },
];

const TRAIT_OPERATIONS: { trait: DestinationTrait; operational: OperationalTrait }[] = [
  { trait: 'car_dependent', operational: 'car_or_shuttle_dependence' },
  { trait: 'road_trip_region', operational: 'car_or_shuttle_dependence' },
  { trait: 'transit_rich', operational: 'dense_transit' },
  { trait: 'dense_urban', operational: 'single_base_viable' },
  { trait: 'multi_base_likely', operational: 'multi_base_likely' },
  { trait: 'broad_geography', operational: 'long_internal_transfers' },
  { trait: 'water_transfer', operational: 'water_transfer_dependency' },
  { trait: 'archipelago', operational: 'water_transfer_dependency' },
  { trait: 'internal_flight_likely', operational: 'internal_flight_likely' },
  { trait: 'guide_transfer_likely', operational: 'operator_or_guide_dependence' },
  { trait: 'wilderness', operational: 'thin_services' },
  { trait: 'remote', operational: 'thin_services' },
  { trait: 'weather_exposed', operational: 'weather_exposed_access' },
  { trait: 'winter_access', operational: 'seasonal_access_windows' },
  { trait: 'high_altitude', operational: 'altitude_exposure' },
  { trait: 'cross_border', operational: 'border_crossing' },
];

const STRENGTH_RANK: Record<AffordanceStrength, number> = { weak: 0, possible: 1, seasonal: 2, strong: 3 };

/**
 * What this place affords, from what was actually screened about it.
 *
 * Pure, and cheap: a table walk over at most 29 traits. §61 requires the
 * derivation layers to add no model call and no provider call, and this adds
 * neither.
 */
export function deriveAffordances(input: { destination: Pick<DestinationQuestionContext, 'traits' | 'basis'>; reality?: TravelReality | null | undefined }): DestinationAffordanceProfile {
  const present = new Set(input.destination.traits);
  const basisFor = (traits: DestinationTrait[]): string => traits.map((trait) => input.destination.basis[trait]).filter((line): line is string => Boolean(line))[0] ?? '';

  const best = new Map<TravelStyle, Affordance>();
  for (const rule of STYLE_RULES) {
    if (!rule.when.every((trait) => present.has(trait))) continue;
    /*
     * A style that depends on a mode the country says is unavailable is not
     * afforded here, whatever the ground looks like. `unknown` is not
     * `unavailable`: only an affirmative "no" removes the style.
     */
    if (rule.needsMode && input.reality && modeStatusFor(input.reality, rule.needsMode) === 'unavailable') continue;
    const candidate: Affordance = { style: rule.style, strength: rule.strength, basis: basisFor(rule.when) };
    const existing = best.get(rule.style);
    if (!existing || STRENGTH_RANK[candidate.strength] > STRENGTH_RANK[existing.strength]) best.set(rule.style, candidate);
  }

  const operational = new Map<OperationalTrait, string>();
  for (const { trait, operational: op } of TRAIT_OPERATIONS) {
    if (!present.has(trait)) continue;
    if (!operational.has(op)) operational.set(op, input.destination.basis[trait] ?? '');
  }

  return {
    version: 1,
    affordances: [...best.values()].sort((a, b) => STRENGTH_RANK[b.strength] - STRENGTH_RANK[a.strength] || a.style.localeCompare(b.style)),
    operationalTraits: [...operational.entries()].map(([trait, basis]) => ({ trait, basis })),
    unknown: input.destination.traits.length === 0,
  };
}

/** Whether the place supports this style at all — `weak` and absent are different answers. */
export function affords(profile: DestinationAffordanceProfile, style: TravelStyle): AffordanceStrength | 'unknown' {
  if (profile.unknown) return 'unknown';
  const found = profile.affordances.find((entry) => entry.style === style);
  if (found) return found.strength;
  return 'unknown';
}
