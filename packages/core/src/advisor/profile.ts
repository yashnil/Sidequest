import type { TripComposerAnswers } from '../schemas/composer';
import { EXPERIENCES, type Experience, type WorldRegion } from './catalog/schema';
import {
  ADVENTURE_LEVELS,
  FOCUS_EXPERIENCES,
  MOOD_EXPERIENCES,
  OPPOSITE_REFINEMENT,
  PURSUIT_EXPERIENCES,
  type AdvisorAnswers,
  type FocusKey,
  type InterestKey,
  type Refinement,
} from './answers';
import { originPointFromText, type OriginPoint } from './origin';
import { conceptMoods, type ConceptWeight } from './concept';

/**
 * ONE READING OF EVERYTHING THE TRAVELLER SAID, IN THE TERMS THE SCORER USES.
 *
 * Pure, and the only place answers become numbers. Every field is `null` when
 * nobody said, and `null` is carried all the way to the scorer, which drops the
 * dimension rather than scoring it at a middle value — the defect that let the
 * old ranker call eight administrative regions equally "100".
 *
 * Refinements ("warmer", "less expensive") are applied here, after the base
 * reading, in the order they were tapped — so the shortlist is always a
 * function of the stored answers and nothing else.
 */
export interface AdvisorProfile {
  /** The months the trip could happen in. Null when the traveller left timing open. */
  months: number[] | null;
  /** True when the dates can still move inside `months` — then the best month counts, not the average. */
  monthsFlexible: boolean;
  /** Experience weights, summing to one. Empty when nothing was said. */
  wants: Partial<Record<Experience, number>>;
  /** The focus keys in priority order, for explanations. */
  focus: FocusKey[];
  /** Each interest with its weight and the experiences it reads, after kind refinements. */
  interests: AdvisorInterest[];
  /** True when the first interest is the stated lead (ranked, or the only one). */
  leadStated: boolean;
  /** Specific things the request named ("gorillas"): picks should be places whose guides are about them. */
  named: string[];
  /** True when every interest is a mood read from a vague request: a leaning Sidequest assumed, not a wish the traveller stated. */
  inferredInterests: boolean;
  /** 0 comfortable … 3 expedition. */
  adventure: number | null;
  /** 1 budget … 4 luxury. */
  budget: number | null;
  lodging: 'simple' | 'comfortable' | 'luxury' | null;
  nights: { min: number; max: number } | null;
  origin: OriginPoint | null;
  /** Great-circle km the traveller is happy to go. Null when unstated. */
  maxDistanceKm: number | null;
  /** Parts of the world in scope. Null = anywhere. */
  regions: WorldRegion[] | null;
  /** Countries in scope (a "domestic" trip). Null = any. */
  countries: string[] | null;
  kids: boolean;
  /** What kind of vacation the request describes, weighted. Empty when the words said nothing about it. */
  concept: ConceptWeight[];
  olderTravellers: boolean;
  limitedMobility: boolean;
  altitudeSensitive: boolean;
  car: 'drive' | 'no_car' | null;
  avoidCrowds: boolean | null;
  novelty: 'familiar' | 'unusual' | 'open' | null;
  climate: 'warm' | 'mild' | 'cold' | null;
  /** The traveller refused snow and ice: a snowbound month is out of season for them. */
  avoidSnow: boolean;
  /** The traveller asked for the aurora: only high latitudes can answer. */
  aurora: boolean;
  /** Interests the traveller refused, as experience mappings. */
  refused: AdvisorInterest[];
  /** How much warmer (+) or cooler (−) than the stated climate, in refinement steps. */
  warmthShift: number;
  /** Lower-cased names the traveller asked to avoid or has already been to. */
  avoidText: string;
  visited: string[];
  excluded: Set<string>;
  similarTo: string | null;
  /** Destination ids the request named as its geography ("in the Karakoram"). Null = anywhere. */
  within: string[] | null;
  /** Words from the request that no structured answer captured ("tea plantations"), for lexical retrieval. */
  terms: string[];
  /** The same words as written, for retrieval by meaning. */
  phrase: string | null;
  /** Destination ids the request ruled out by name; nothing inside one is offered. */
  outside: string[];
  /** Weight multipliers refinements put on factors, e.g. "easier logistics" → access ×2. */
  emphasis: Partial<Record<FactorId, number>>;
  /** Party size, for copy. */
  adults: number;
  children: number;
}

export interface AdvisorInterest {
  key: InterestKey;
  weight: number;
  mapping: Partial<Record<Experience, number>>;
  /**
   * A leaning rather than a wish (a mood: "somewhere beautiful"): any one of
   * its experiences satisfies it, so it is scored on the best the place has,
   * never on having all of them.
   */
  any?: boolean;
  /** Skiing or snowboarding was asked for by name: snow without lifts is not what they mean. */
  lifts?: boolean;
}

export const FACTOR_IDS = [
  'experience',
  'season',
  'climate',
  'duration',
  'budget',
  'adventure',
  'reach',
  'getting_around',
  'crowds',
  'novelty',
  'group',
  'vacation',
  'similar',
] as const;
export type FactorId = (typeof FACTOR_IDS)[number];

const NORTHERN_SEASON: Record<string, number[]> = {
  spring: [3, 4, 5],
  summer: [6, 7, 8],
  autumn: [9, 10, 11],
  fall: [9, 10, 11],
  winter: [12, 1, 2],
};

/**
 * The months a season means **to the traveller** — their holiday, read in their
 * own hemisphere. The old ranker read "summer" in each destination's own
 * hemisphere, which made Patagonia "in season" for someone whose summer
 * holiday is July. Absent an origin, the northern calendar is assumed and the
 * assumption is stated (see `assumptionsFor`).
 */
export function seasonMonthsForTraveller(season: string, origin: OriginPoint | null): number[] {
  const months = NORTHERN_SEASON[season] ?? [];
  if (origin && origin.lat < -15) return months.map((month) => ((month + 5) % 12) + 1);
  return months;
}

function monthsOf(answers: TripComposerAnswers, origin: OriginPoint | null): { months: number[] | null; flexible: boolean } {
  const dates = answers.dates;
  switch (dates.mode) {
    case 'exact':
    case 'flexible': {
      if (!dates.startDate) return { months: null, flexible: true };
      const start = Number(dates.startDate.slice(5, 7));
      const end = dates.endDate ? Number(dates.endDate.slice(5, 7)) : start;
      const months = [start];
      for (let m = start; m !== end && months.length < 12; ) {
        m = (m % 12) + 1;
        months.push(m);
      }
      return { months, flexible: dates.mode === 'flexible' };
    }
    case 'month':
      return dates.month ? { months: [dates.month], flexible: false } : { months: null, flexible: true };
    case 'months':
      return dates.months?.length ? { months: [...dates.months], flexible: true } : { months: null, flexible: true };
    case 'season':
      return dates.season ? { months: seasonMonthsForTraveller(dates.season, origin), flexible: true } : { months: null, flexible: true };
    default:
      return { months: null, flexible: true };
  }
}

const THEME_FOCUS: Record<string, FocusKey[]> = {
  outdoors: ['hiking'],
  mountains: ['mountains'],
  water: ['lakes', 'beaches'],
  wildlife: ['wildlife'],
  food: ['culture_food'],
  culture: ['culture_food'],
  cities: ['cities'],
};

/** The traveller's interests in order: the advisor's own list, else the composer's themes. */
export function focusOf(answers: TripComposerAnswers): FocusKey[] {
  const own = answers.discovery?.focus ?? [];
  if (own.length > 0) return [...own];
  const out: FocusKey[] = [];
  for (const theme of answers.themes) for (const key of THEME_FOCUS[theme] ?? []) if (!out.includes(key)) out.push(key);
  return out;
}

/**
 * AdvisorInterest weights. Ranked: the lead counts most and each later one less, so
 * "mountains first, wildlife if it fits" is not scored as four equal wishes.
 * Unranked: equal, which is what the traveller actually said.
 */
function interestsFrom(focus: FocusKey[], ranked: boolean, discovery: AdvisorAnswers | undefined, refinements: Refinement[]): AdvisorInterest[] {
  const weights = new Map<FocusKey, number>();
  focus.forEach((key, index) => weights.set(key, ranked ? 1 / (1 + 0.7 * index) : 1));
  for (const refinement of refinements) {
    const boost = refinement === 'more_hiking' ? 'hiking' : refinement === 'more_wildlife' ? 'wildlife' : refinement === 'more_beach' ? 'beaches' : null;
    if (boost) weights.set(boost, (weights.get(boost) ?? 0) + 1);
  }

  const interests: AdvisorInterest[] = [];
  for (const [key, weight] of weights) {
    let mapping: Partial<Record<Experience, number>> = FOCUS_EXPERIENCES[key];
    if (key === 'wildlife' && discovery?.wildlifeKind && discovery.wildlifeKind !== 'any') {
      mapping = discovery.wildlifeKind === 'safari'
        ? { big_game_safari: 0.75, wildlife_general: 0.25 }
        : discovery.wildlifeKind === 'marine'
          ? { marine_wildlife: 0.7, snorkel_dive: 0.3 }
          : { birding: 0.7, wildlife_general: 0.3 };
    }
    if (key === 'mountains' && discovery?.mountainStyle) {
      mapping = discovery.mountainStyle === 'glaciers'
        ? { glaciers_ice: 0.7, high_mountains: 0.2, coastal_scenery: 0.1 }
        : discovery.mountainStyle === 'hut_to_hut'
        ? { high_mountains: 0.5, multi_day_trekking: 0.4, day_hiking: 0.1 }
        : discovery.mountainStyle === 'high_altitude'
          ? { high_mountains: 0.55, multi_day_trekking: 0.3, glaciers_ice: 0.15 }
          : { day_hiking: 0.5, high_mountains: 0.4, lakes: 0.1 };
    }
    if (key === 'beaches' && discovery?.swimStyle === 'warm_sea') mapping = { beaches_swimming: 0.7, snorkel_dive: 0.3 };
    if (key === 'beaches' && discovery?.swimStyle === 'diving') mapping = { snorkel_dive: 0.75, beaches_swimming: 0.15, coastal_scenery: 0.1 };
    if (key === 'beaches' && discovery?.swimStyle === 'snorkel') mapping = { beaches_swimming: 0.45, snorkel_dive: 0.4, coastal_scenery: 0.15 };
    if (key === 'lakes' && discovery?.swimStyle === 'lakes') mapping = { lakes: 1 };
    interests.push({ key, weight, mapping, ...(key === 'snow' && discovery?.skiing ? { lifts: true } : {}) });
  }
  /* A pursuit is something the traveller named outright, so it weighs as much as a lead interest. */
  for (const key of discovery?.pursuits ?? []) interests.push({ key, weight: 1, mapping: PURSUIT_EXPERIENCES[key] });
  /* A mood speaks only while nothing more specific has been said. */
  if (interests.length === 0) for (const key of discovery?.moods ?? []) interests.push({ key, weight: 1, mapping: MOOD_EXPERIENCES[key], any: true });
  /*
   * The kind of trip widens what is looked for, at a lower weight than anything
   * named: "a retreat, outdoors stuff" keeps spa as its stated interest and adds
   * gentle nature and rest, instead of dropping "outdoors" because an activity
   * was named.
   */
  /* Only while no broad activity was named: "a family ski week" is a ski trip, and "family" must not bring beaches into it. */
  for (const { mood, weight } of focus.length > 0 ? [] : conceptMoods(discovery?.concept ?? [])) {
    if (interests.some((interest) => interest.key === mood)) continue;
    interests.push({ key: mood, weight: Math.min(0.7, 0.35 + weight), mapping: MOOD_EXPERIENCES[mood], any: true });
  }
  return interests;
}

/** The interests flattened to experience weights summing to one. */
export function wantsOf(interests: readonly AdvisorInterest[]): Partial<Record<Experience, number>> {
  const wants: Partial<Record<Experience, number>> = {};
  for (const { weight, mapping } of interests) {
    for (const [experience, share] of Object.entries(mapping) as [Experience, number][]) {
      wants[experience] = (wants[experience] ?? 0) + weight * share;
    }
  }
  const total = Object.values(wants).reduce((sum, value) => sum + (value ?? 0), 0);
  if (total > 0) for (const experience of EXPERIENCES) if (wants[experience]) wants[experience] = wants[experience]! / total;
  return wants;
}

const FLIGHT_KM: Record<string, number | null> = { short: 2500, moderate: 6000, long: 11000, any: null };

/** Applies refinements in tap order, dropping a tap that its later opposite undid. */
export function effectiveRefinements(list: readonly Refinement[]): Refinement[] {
  const out: Refinement[] = [];
  for (const refinement of list) {
    const opposite = OPPOSITE_REFINEMENT[refinement];
    if (opposite && out.includes(opposite)) {
      out.splice(out.indexOf(opposite), 1);
      continue;
    }
    if (!out.includes(refinement)) out.push(refinement);
  }
  return out;
}

export function profileFrom(answers: TripComposerAnswers): AdvisorProfile {
  const discovery = answers.discovery;
  const named = discovery?.originPoint;
  const origin: OriginPoint | null = originPointFromText(answers.origin, answers.originCountry) ?? (named ? { lat: named.lat, lng: named.lng, label: named.label, countryCode: named.countryCode, basis: 'city' } : null);
  const { months, flexible } = monthsOf(answers, origin);
  const refinements = effectiveRefinements(discovery?.refinements ?? []);
  const focus = focusOf(answers);

  let adventure: number | null = discovery?.adventure
    ? ADVENTURE_LEVELS.indexOf(discovery.adventure)
    : answers.outdoorIntensity === 'gentle'
      ? 0
      : answers.outdoorIntensity === 'moderate'
        ? 1
        : answers.outdoorIntensity === 'strenuous'
          ? 2
          : null;
  let budget: number | null =
    answers.budget === 'budget' ? 1 : answers.budget === 'mid_range' ? 2 : answers.budget === 'premium' ? 3 : answers.budget === 'luxury' ? 4 : null;
  let maxDistanceKm = answers.flightTolerance ? FLIGHT_KM[answers.flightTolerance] ?? null : null;
  let avoidCrowds: boolean | null = answers.crowdTolerance ? answers.crowdTolerance === 'avoid' : null;
  let novelty: AdvisorProfile['novelty'] =
    answers.surpriseAppetite === 'familiar' ? 'familiar' : answers.surpriseAppetite === 'surprise_me' ? 'unusual' : answers.surpriseAppetite === 'open' ? 'open' : null;
  let car: AdvisorProfile['car'] = answers.transport === 'drive' ? 'drive' : answers.transport === 'public_transport' ? 'no_car' : null;
  const climate = answers.climatePreference && answers.climatePreference !== 'any' ? answers.climatePreference : null;
  let warmthShift = 0;
  const emphasis: Partial<Record<FactorId, number>> = {};

  /* A tight budget is close to a constraint: somebody who said "budget-conscious" means it. */
  if (budget !== null && budget <= 2) emphasis.budget = 2;
  /* A stated appetite for the classic or the unusual is a real preference, not a tiebreak. */
  if (novelty === 'familiar' || novelty === 'unusual') emphasis.novelty = 2;

  for (const refinement of refinements) {
    switch (refinement) {
      case 'more_adventurous':
        adventure = Math.min(3, (adventure ?? 1) + 1);
        break;
      case 'easier':
        adventure = Math.max(0, (adventure ?? 1) - 1);
        break;
      case 'cheaper':
        budget = Math.max(1, (budget ?? 3) - 1);
        emphasis.budget = 2;
        break;
      case 'warmer':
        warmthShift += 1;
        break;
      case 'cooler':
        warmthShift -= 1;
        break;
      case 'less_crowded':
        avoidCrowds = true;
        emphasis.crowds = 2;
        break;
      case 'closer':
        maxDistanceKm = origin ? Math.max(1500, Math.round((maxDistanceKm ?? 9000) * 0.55)) : maxDistanceKm;
        emphasis.reach = 2;
        break;
      case 'more_unusual':
        novelty = 'unusual';
        emphasis.novelty = 2.5;
        break;
      case 'more_classic':
        novelty = 'familiar';
        emphasis.novelty = 2;
        break;
      case 'easier_logistics':
        emphasis.reach = Math.max(emphasis.reach ?? 1, 2);
        emphasis.getting_around = 2.5;
        break;
      case 'less_driving':
        car = 'no_car';
        emphasis.getting_around = 2;
        break;
      default:
        break;
    }
  }

  const nights =
    answers.duration.mode === 'fixed' && answers.duration.nights
      ? { min: answers.duration.nights, max: answers.duration.nights }
      : answers.duration.mode === 'range' && answers.duration.minNights && answers.duration.maxNights
        ? { min: answers.duration.minNights, max: answers.duration.maxNights }
        : null;

  const needs = new Set(answers.travelerNeeds);
  /*
   * Who is going is not a preference to trade off. Limited mobility weighs
   * three times its nominal share, children and older travellers twice; a
   * stated trip length is a fact about the traveller's calendar and counts
   * half as much again.
   */
  if (needs.has('mobility_limited')) emphasis.group = Math.max(emphasis.group ?? 1, 3);
  else if (answers.children > 0 || needs.has('kids_under_12') || needs.has('seniors_in_group')) emphasis.group = Math.max(emphasis.group ?? 1, 2);
  /* A long trip is decided by sizing: three weeks in a ten-night place leaves half the trip unexplained. */
  if (nights) emphasis.duration = Math.max(emphasis.duration ?? 1, nights.max >= 14 ? 2.5 : 1.5);
  const interests = interestsFrom(focus, discovery?.focusRanked === true, discovery, refinements);
  return {
    months,
    monthsFlexible: flexible,
    wants: wantsOf(interests),
    focus,
    interests,
    leadStated: (interests.length === 1 && !interests[0]!.any) || (discovery?.focusRanked === true && interests.length > 1 && focus.length > 0),
    named: discovery?.named ?? [],
    inferredInterests: interests.length > 0 && interests.every((interest) => interest.any === true),
    adventure,
    budget,
    lodging: answers.lodgingComfort === 'simple' ? 'simple' : answers.lodgingComfort === 'refined' ? 'luxury' : answers.lodgingComfort === 'comfortable' ? 'comfortable' : null,
    nights,
    origin,
    maxDistanceKm,
    regions: discovery?.regions?.length ? [...discovery.regions] : null,
    countries: answers.tripScope === 'domestic' && origin?.countryCode ? [origin.countryCode] : discovery?.countries?.length ? [...discovery.countries] : null,
    kids: answers.children > 0 || needs.has('kids_under_12'),
    concept: [...(discovery?.concept ?? [])],
    olderTravellers: needs.has('seniors_in_group'),
    limitedMobility: needs.has('mobility_limited'),
    altitudeSensitive: needs.has('altitude_sensitive'),
    car,
    avoidCrowds,
    novelty,
    climate,
    avoidSnow: discovery?.avoidSnow === true && !focus.includes('snow'),
    aurora: discovery?.aurora === true,
    refused: (discovery?.refused ?? []).filter((key) => !focus.includes(key)).map((key) => ({ key, weight: 1, mapping: FOCUS_EXPERIENCES[key] })),
    warmthShift,
    avoidText: (answers.avoid ?? '').toLowerCase(),
    visited: (answers.visited ?? []).map((name) => name.toLowerCase()),
    excluded: new Set(discovery?.excluded ?? []),
    similarTo: discovery?.similarTo ?? null,
    within: discovery?.within?.length ? [...discovery.within] : null,
    terms: [...(discovery?.terms ?? [])],
    phrase: discovery?.phrase ?? null,
    outside: [...(discovery?.outside ?? [])],
    emphasis,
    adults: answers.adults,
    children: answers.children,
  };
}
