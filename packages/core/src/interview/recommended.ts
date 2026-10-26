import type { Interest } from '../schemas/common';
import { INTEREST_LABELS } from '../schemas/common';
import type { DestinationTrait } from './traits';
import type { InterviewContext } from './catalog';

/**
 * PRODUCTION PASS — "RECOMMENDED FOR THIS TRIP" ON THE PRIORITIES SCREEN.
 *
 * Three interests Sidequest would lead with for *this* trip, each with the one
 * reason that put it there: what the place does best, what the season makes
 * possible or rules out, what a short trip can hold, what the party can do.
 * Pure and deterministic over the interview context; every reason names a
 * fact the screening or the traveller supplied — never a vague "popular".
 *
 * Where it reaches the plan: this is the priorities question's smart default,
 * so "Decide for me" applies exactly these, and the card marks them so a
 * traveller choosing by hand can see them. A recommendation the traveller does
 * not tick changes nothing — the planner reads choices, never suggestions.
 */
export interface RecommendedInterest {
  interest: Interest;
  reason: string;
}

const RECOMMEND_COUNT = 3;

/** Trait → interests it is known for, in order, and the reason as a fragment. */
const TRAIT_LEADS: { trait: DestinationTrait; interests: Interest[]; reason: (place: string) => string }[] = [
  { trait: 'mountain', interests: ['hiking', 'scenic_viewpoints', 'lakes_and_rivers'], reason: (p) => `${p} is mountain country` },
  { trait: 'wilderness', interests: ['wildlife', 'easy_nature_walks', 'stargazing'], reason: (p) => `${p} is wild country` },
  { trait: 'beach', interests: ['beaches_and_swimming', 'food_and_towns'], reason: (p) => `${p} has the coast` },
  { trait: 'island', interests: ['beaches_and_swimming', 'scenic_viewpoints'], reason: () => 'An island trip' },
  { trait: 'archipelago', interests: ['beaches_and_swimming', 'scenic_viewpoints'], reason: () => 'Islands to hop between' },
  { trait: 'food_dense', interests: ['food_and_towns', 'markets_and_street_food'], reason: (p) => `${p} eats well` },
  { trait: 'dense_urban', interests: ['neighbourhoods_and_local_life', 'food_and_towns', 'history_and_culture'], reason: () => 'A city is best on foot' },
  { trait: 'road_trip_region', interests: ['scenic_drives', 'scenic_viewpoints'], reason: () => 'The drive is part of it here' },
  { trait: 'broad_geography', interests: ['history_and_culture', 'scenic_viewpoints'], reason: () => 'A lot of ground to choose from' },
];

/** What a season adds or takes away, only for interests it genuinely changes. */
function seasonal(interest: Interest, ctx: InterviewContext): { delta: number; reason?: string } {
  const season = ctx.destination.season;
  const traits = ctx.destination.traits;
  if (!season) return { delta: 0 };
  if (interest === 'beaches_and_swimming') {
    if (season === 'winter' && !traits.includes('heat_sensitive')) return { delta: -3 };
    if (season === 'summer') return { delta: 1, reason: 'Summer is swimming season' };
  }
  if (interest === 'hiking' && traits.includes('winter_access') && season === 'winter') return { delta: -3 };
  if (interest === 'hiking' && (season === 'summer' || season === 'autumn') && traits.includes('mountain')) return { delta: 1, reason: `${season === 'summer' ? 'Summer' : 'Autumn'} opens the trails` };
  if (interest === 'stargazing' && (season === 'winter' || season === 'autumn')) return { delta: 1, reason: 'Long dark nights this time of year' };
  if (interest === 'hot_springs' && (season === 'winter' || season === 'autumn')) return { delta: 1, reason: 'Hot water in the cold season' };
  return { delta: 0 };
}

/** What the party changes: young children and limited mobility move the plan towards easy ground. */
function party(interest: Interest, ctx: InterviewContext): { delta: number; reason?: string } {
  const needs = ctx.traveller.travelerNeeds;
  const kids = ctx.traveller.children > 0 || needs.includes('kids_under_12');
  const mobility = needs.includes('mobility_limited') || needs.includes('seniors_in_group');
  if (interest === 'hiking' && (kids || mobility)) return { delta: -2 };
  if (interest === 'easy_nature_walks' && (kids || mobility)) return { delta: 2, reason: kids ? 'Easy going with children' : 'Easy on everyone' };
  if (interest === 'wildlife' && kids) return { delta: 1, reason: 'Children love the animals' };
  if (interest === 'beaches_and_swimming' && kids) return { delta: 1, reason: 'A beach day suits children' };
  return { delta: 0 };
}

/** A short trip should lead with what fits close to a base, not what needs a day of driving. */
function length(interest: Interest, ctx: InterviewContext): { delta: number; reason?: string } {
  const days = ctx.traveller.tripDays;
  if (days <= 3 && (interest === 'scenic_drives' || interest === 'wildlife')) return { delta: -1 };
  if (days <= 3 && (interest === 'food_and_towns' || interest === 'neighbourhoods_and_local_life')) return { delta: 1, reason: 'Fits a short trip' };
  if (days >= 10 && interest === 'scenic_drives') return { delta: 1, reason: 'Enough days to cover ground' };
  return { delta: 0 };
}

export function recommendedInterests(ctx: InterviewContext): RecommendedInterest[] {
  const offered = new Set(ctx.traveller.offeredInterests);
  if (offered.size === 0) return [];
  const place = ctx.destination.proseName || ctx.destination.name;
  const score = new Map<Interest, { value: number; reason: string; strength: number }>();
  const consider = (interest: Interest, value: number, reason: string, strength: number) => {
    if (!offered.has(interest)) return;
    const current = score.get(interest);
    if (!current) score.set(interest, { value, reason, strength });
    else {
      /* The strongest reason a place gives, plus a little for each further one: three traits naming viewpoints is not three times the case for them. */
      current.value = Math.max(current.value, value) + Math.min(current.value, value) * 0.15;
      if (strength > current.strength) {
        current.reason = reason;
        current.strength = strength;
      }
    }
  };
  TRAIT_LEADS.forEach((lead, leadIndex) => {
    if (!ctx.destination.traits.includes(lead.trait)) return;
    lead.interests.forEach((interest, i) => consider(interest, 3 - i * 0.5 - leadIndex * 0.05, lead.reason(place), 2));
  });
  // Every destination gets a fair chance at the universals, ranked below what the place is known for.
  for (const interest of ['food_and_towns', 'history_and_culture', 'scenic_viewpoints', 'easy_nature_walks'] as Interest[]) consider(interest, 0.5, 'Good almost anywhere', 0);
  for (const interest of [...score.keys()]) {
    for (const adjust of [seasonal(interest, ctx), party(interest, ctx), length(interest, ctx)]) {
      const entry = score.get(interest)!;
      entry.value += adjust.delta;
      if (adjust.reason && adjust.delta > 0) {
        entry.reason = adjust.reason;
        entry.strength = 3;
      }
    }
  }
  // Party and season can also bring in an interest the traits did not name.
  for (const interest of ['easy_nature_walks', 'wildlife', 'stargazing', 'hot_springs'] as Interest[]) {
    if (score.has(interest) || !offered.has(interest)) continue;
    const bonus = [seasonal(interest, ctx), party(interest, ctx)].filter((a) => a.delta > 0);
    if (bonus.length > 0) score.set(interest, { value: bonus.reduce((s, a) => s + a.delta, 0), reason: bonus[0]!.reason!, strength: 3 });
  }
  return [...score.entries()]
    .filter(([, entry]) => entry.value > 0)
    .sort((a, b) => b[1].value - a[1].value || INTEREST_LABELS[a[0]].localeCompare(INTEREST_LABELS[b[0]]))
    .slice(0, RECOMMEND_COUNT)
    .map(([interest, entry]) => ({ interest, reason: entry.reason }));
}
