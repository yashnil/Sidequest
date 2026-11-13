import { EXPERIENCE_LABELS, type Experience } from './catalog/schema';
import type { MoodKey } from './answers';
import type { Destination } from './destination';

/**
 * WHAT KIND OF VACATION THIS IS.
 *
 * 2026-11 experience transformation. The advisor used to read a request as a
 * bag of activities, so "a nice retreat with my family, I want to feel good,
 * outdoors stuff" became one interest — spa — and the shortlist was ranked on
 * spa strength: an alpine crossing, a cloud forest and the Maldives. What the
 * request described was a *kind of trip*: restorative, gentle, comfortable,
 * for a family. A wellness retreat and a challenging trek both "have nature";
 * they are not the same holiday.
 *
 * A concept is read from the traveller's own words, weighted, and said back
 * in words they can correct. Emotional context ("life has been stressful") is
 * read only as a travel preference — rest over challenge — and never as a
 * statement about the person.
 *
 * Each concept has a *shape*: how much effort it wants at most, how many hotel
 * moves and how much logistical friction it tolerates, whether comfortable
 * stays matter, which signature experiences carry it and which work against
 * it. `vacationFit` scores a destination against that shape — the whole trip,
 * not a list of attributes. Pure: no clock, no network.
 */

export const CONCEPT_KEYS = [
  'restoration',
  'wellness',
  'scenic_nature',
  'outdoor_adventure',
  'culture',
  'pilgrimage',
  'family_bonding',
  'beach_resort',
  'road_trip',
  'active_hiking',
  'trekking',
  'luxury',
  'budget',
  'once_in_a_lifetime',
] as const;
export type ConceptKey = (typeof CONCEPT_KEYS)[number];

export const CONCEPT_LABELS: Record<ConceptKey, string> = {
  restoration: 'Rest and restoration',
  wellness: 'Wellness',
  scenic_nature: 'Gentle time in nature',
  outdoor_adventure: 'Outdoor adventure',
  culture: 'Culture',
  pilgrimage: 'A pilgrimage walk',
  family_bonding: 'Family time',
  beach_resort: 'Beach and resort',
  road_trip: 'A road trip',
  active_hiking: 'An active hiking trip',
  trekking: 'A multi-day trek',
  luxury: 'Luxury and boutique stays',
  budget: 'Exploring on a budget',
  once_in_a_lifetime: 'Once in a lifetime',
};

export interface ConceptWeight {
  key: ConceptKey;
  /** Share of the reading, summing to one across the concept. */
  weight: number;
}

interface ConceptShape {
  /** The hardest typical day this kind of trip wants, on the catalog's 0 (gentle) … 3 (expedition) scale. */
  effort: number;
  /** How many places to sleep it tolerates before moving becomes the trip. */
  moves: number;
  /** Tolerance for logistical friction, 0 (none) … 1 (happy to wrestle with it). */
  friction: number;
  /** Comfortable stays matter (or, for luxury, high-end ones). */
  comfort: 'none' | 'comfortable' | 'luxury';
  /** Signature experiences that carry this kind of trip. */
  carries: Experience[];
  /** Signature experiences that work against it when they are what a place is built around. */
  against: Experience[];
  /** The mood whose experience mix stands in for this concept in retrieval, when the request named no activity for it. */
  mood: MoodKey | null;
}

/*
 * Only kinds of trip with no activity of their own score what carries them:
 * rest, wellness and a pilgrimage are not said by any activity. A hiking,
 * beach or scenery trip is already scored by the experience factor, and
 * scoring its carriers here a second time flipped close calls (a family ski
 * week answered with a beach because "family" preferred beaches).
 */
const CARRIES_SCORED = new Set<ConceptKey>(['restoration', 'wellness', 'pilgrimage']);

/** How much each kind of trip adds beyond the activities it implies. */
const IMPORTANCE: Record<ConceptKey, number> = {
  restoration: 1,
  wellness: 0.7,
  family_bonding: 0.8,
  luxury: 0.8,
  pilgrimage: 0.6,
  beach_resort: 0.5,
  scenic_nature: 0.45,
  once_in_a_lifetime: 0.4,
  road_trip: 0.4,
  budget: 0.3,
  outdoor_adventure: 0.3,
  culture: 0.25,
  active_hiking: 0.25,
  trekking: 0.25,
};

const SHAPES: Record<ConceptKey, ConceptShape> = {
  restoration: { effort: 1, moves: 2, friction: 0.35, comfort: 'comfortable', carries: ['hot_springs_wellness', 'lakes', 'beaches_swimming', 'coastal_scenery', 'rainforest_biodiversity'], against: ['multi_day_trekking', 'high_mountains', 'city_life'], mood: 'relaxing' },
  wellness: { effort: 1, moves: 2, friction: 0.45, comfort: 'comfortable', carries: ['hot_springs_wellness'], against: ['multi_day_trekking'], mood: null },
  scenic_nature: { effort: 1.5, moves: 3, friction: 0.6, comfort: 'none', carries: ['lakes', 'coastal_scenery', 'day_hiking', 'high_mountains', 'rainforest_biodiversity'], against: ['city_life'], mood: 'scenic' },
  outdoor_adventure: { effort: 2.5, moves: 4, friction: 0.9, comfort: 'none', carries: ['day_hiking', 'paddling_boating', 'high_mountains', 'volcanoes_geothermal', 'rainforest_biodiversity'], against: ['city_life'], mood: 'adventurous' },
  culture: { effort: 1, moves: 3, friction: 0.6, comfort: 'none', carries: ['villages_culture', 'food', 'city_life'], against: [], mood: null },
  pilgrimage: { effort: 2, moves: 5, friction: 0.8, comfort: 'none', carries: ['multi_day_trekking', 'villages_culture'], against: ['city_life', 'beaches_swimming'], mood: null },
  family_bonding: { effort: 1, moves: 2, friction: 0.4, comfort: 'comfortable', carries: [], against: ['multi_day_trekking'], mood: 'family' },
  beach_resort: { effort: 0.5, moves: 1, friction: 0.4, comfort: 'comfortable', carries: ['beaches_swimming', 'snorkel_dive', 'coastal_scenery'], against: ['multi_day_trekking', 'winter_snow'], mood: 'relaxing' },
  road_trip: { effort: 1.5, moves: 7, friction: 1, comfort: 'none', carries: ['scenic_driving', 'coastal_scenery', 'desert_landscapes'], against: [], mood: null },
  active_hiking: { effort: 2.5, moves: 4, friction: 0.85, comfort: 'none', carries: ['day_hiking', 'multi_day_trekking', 'high_mountains'], against: ['city_life', 'beaches_swimming'], mood: null },
  trekking: { effort: 3, moves: 8, friction: 1, comfort: 'none', carries: ['multi_day_trekking', 'high_mountains'], against: ['city_life', 'beaches_swimming'], mood: null },
  luxury: { effort: 1.5, moves: 3, friction: 0.5, comfort: 'luxury', carries: [], against: [], mood: null },
  budget: { effort: 2, moves: 5, friction: 0.9, comfort: 'none', carries: [], against: [], mood: null },
  once_in_a_lifetime: { effort: 2, moves: 4, friction: 0.8, comfort: 'none', carries: ['big_game_safari', 'glaciers_ice', 'marine_wildlife', 'desert_landscapes'], against: [], mood: 'memorable' },
};

interface ConceptPhrase {
  pattern: RegExp;
  key: ConceptKey;
  weight: number;
  /** What the traveller is told this was read as. Present only where the reading is not obvious from their own word. */
  said?: string;
}

/*
 * The phrase table is data. Emotional words read as a preference for rest and
 * ease, said back in those terms; they never become a fact about the person.
 */
const PHRASES: ConceptPhrase[] = [
  {
    pattern: /\b(stress(ed|ful)?|burn(t|ed)[- ]?out|exhausted|worn out|frazzled|overwhelmed|(tough|hard|rough|long|busy|crazy) (year|time|few months|stretch)|need(ed|s)? (a|some) (break|rest|reset|time off)|feel (good|better|human again|rested)|recharge|decompress|unwind|switch off|slow down|reset)\b/,
    key: 'restoration',
    weight: 1.2,
    said: 'You want to come back rested, so rest and ease count for more than challenge.',
  },
  { pattern: /\b(retreats?|restor(e|ative|ing)|rejuvenat\w+|peaceful|tranquil|quiet (place|time|days)|relax(ing|ation)?|restful|calm|slow pace)\b/, key: 'restoration', weight: 1, said: 'Read “retreat” as somewhere restful with comfortable places to stay, not only a spa.' },
  { pattern: /\b(spas?|wellness|yoga|massages?|onsens?|hot springs?|thermal (baths?|springs?|pools?)|meditat\w+|detox|sauna)\b/, key: 'wellness', weight: 0.8 },
  { pattern: /\b(outdoors?( stuff| things| time)?|outside|nature|fresh air|forests?|woods|scenery|scenic|views|countryside|green)\b/, key: 'scenic_nature', weight: 0.8, said: 'Read “outdoors” as easy time in nature unless you ask for something harder.' },
  { pattern: /\b(adventur(e|es|ous)|thrill(s|ing)?|adrenaline|rafting|canyoning|zip[- ]?lin\w+|climb(ing)?|active holiday)\b/, key: 'outdoor_adventure', weight: 1 },
  { pattern: /\b(culture|cultural|history|historic(al)?|temples?|museums?|architecture|old towns?|heritage|food|cuisine)\b/, key: 'culture', weight: 0.8 },
  { pattern: /\b(pilgrim\w*|camino|spiritual|sacred (sites?|routes?|paths?|walks?))\b/, key: 'pilgrimage', weight: 1 },
  { pattern: /\b(famil(y|ies)|kids?|children|child|toddlers?|grand(parents|kids|children)|multi[- ]?generation\w*|my parents|our parents|son|daughter)\b/, key: 'family_bonding', weight: 0.9 },
  { pattern: /\b(beach(es)?|resorts?|all[- ]inclusive|by the pool|island (getaway|escape)|lounging)\b/, key: 'beach_resort', weight: 0.9 },
  { pattern: /\b(road ?trips?|self[- ]drive|driving (holiday|trip|route|loop))\b/, key: 'road_trip', weight: 1 },
  { pattern: /\b(trek(s|king)?|hut[- ]to[- ]hut|multi[- ]day (hikes?|walks?|treks?)|thru[- ]hik\w*|long[- ]distance (trails?|walks?))\b/, key: 'trekking', weight: 1.1 },
  { pattern: /\b(hik(e|es|ing)|trails?|summits?|backpacking trip|long walks?)\b/, key: 'active_hiking', weight: 1 },
  { pattern: /\b(luxur(y|ious)|five[- ]star|5[- ]star|boutique|splurge|treat (ourselves|myself)|upscale|high[- ]end)\b/, key: 'luxury', weight: 0.8 },
  { pattern: /\b(on a (tight |small |low )?budget|low[- ]budget|tight budget|cheap(ly)?|backpack(er|ing)|shoestring)\b/, key: 'budget', weight: 0.7 },
  { pattern: /\b(once[- ]in[- ]a[- ]lifetime|trip of a lifetime|bucket[- ]list|unforgettable|honeymoon)\b/, key: 'once_in_a_lifetime', weight: 0.8 },
];

export interface ConceptReading {
  concept: ConceptWeight[];
  /** Sentences saying how the request was read, for the traveller to correct. */
  notes: string[];
}

/**
 * The concept a request describes. `says` decides whether a pattern is said
 * affirmatively (it carries the parser's negation handling), so "no hiking"
 * never reads as a hiking trip.
 */
export function readConcept(text: string, says: (pattern: RegExp) => boolean): ConceptReading {
  const weights = new Map<ConceptKey, number>();
  const notes: string[] = [];
  for (const phrase of PHRASES) {
    if (!says(phrase.pattern)) continue;
    weights.set(phrase.key, Math.max(weights.get(phrase.key) ?? 0, phrase.weight));
    if (phrase.said && !notes.includes(phrase.said)) notes.push(phrase.said);
  }
  /* Rest beside a named hike is a gentle walking trip, not a trek: the hiking reading softens rather than wins. */
  if (weights.has('restoration') && weights.has('active_hiking')) weights.set('active_hiking', (weights.get('active_hiking') ?? 0) * 0.5);
  if (weights.has('restoration') && weights.has('trekking')) weights.set('trekking', (weights.get('trekking') ?? 0) * 0.5);
  /* "Outdoors" with rest wanted is a gentle nature trip, never an adventure, unless adventure was said outright. */
  const total = [...weights.values()].reduce((sum, value) => sum + value, 0);
  if (total === 0 || !text.trim()) return { concept: [], notes: [] };
  const concept = [...weights.entries()]
    .map(([key, value]) => ({ key, weight: Math.round((value / total) * 1000) / 1000 }))
    .sort((a, b) => b.weight - a.weight || a.key.localeCompare(b.key))
    .slice(0, 5);
  return { concept, notes: notes.slice(0, 3) };
}

/** Moods that stand in for a concept's experience mix when the request named no activity for it. */
export function conceptMoods(concept: readonly ConceptWeight[]): { mood: MoodKey; weight: number }[] {
  const out = new Map<MoodKey, number>();
  for (const { key, weight } of concept) {
    const mood = SHAPES[key].mood;
    if (mood) out.set(mood, (out.get(mood) ?? 0) + weight);
  }
  return [...out.entries()].map(([mood, weight]) => ({ mood, weight }));
}

/** A concept in one phrase, for the read-back ("A restful family trip in nature"). */
export function conceptPhrase(concept: readonly ConceptWeight[]): string | null {
  if (concept.length === 0) return null;
  return concept
    .slice(0, 3)
    .map((entry) => CONCEPT_LABELS[entry.key].toLowerCase())
    .join(', ')
    .replace(/^./, (c) => c.toUpperCase());
}

export interface VacationFit {
  value: number;
  /**
   * How much the kind of trip should weigh beside what to do (0–1). Rest,
   * wellness, family and luxury trips are where an activity list misses the
   * point; for a trekking or culture trip the experience reading already says
   * most of it, and a full-weight concept only flattens the ranking.
   */
  importance: number;
  /** The one or two things that most decided it, in words. */
  basis: string;
  /** What works against this kind of trip here, each a full sentence for the card's trade-offs. */
  against: string[];
  /** What works for it, short phrases for the card's "why". */
  carries: string[];
}

/** Experience strengths are on the catalog's 0–3 scale; read here as 0–1. */
function strength(destination: Destination, experience: Experience): number {
  return Math.min(1, Math.max(0, (destination.experiences[experience] ?? 0) / 3));
}

function strongest(destination: Destination, n: number): Experience[] {
  return (Object.entries(destination.experiences) as [Experience, number][])
    .filter(([experience]) => strength(destination, experience) >= 0.66)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([experience]) => experience);
}

/**
 * What a place is built around: its two strongest experiences, each at least
 * two on the catalog's 0–3 scale. The one reading behind every "it is built
 * around …" sentence on a card and behind the disqualifiers in
 * `conflicts.ts`, so the words and the ranking cannot disagree about it.
 */
export function builtAround(destination: Destination): Experience[] {
  return strongest(destination, 2);
}

/**
 * The share of one stated interest's mapping at which an experience is
 * something the traveller asked for themselves. Plain "mountains" gives high
 * mountains 0.45 and multi-day trekking 0.2: the first is their own wish, the
 * second one possibility among several. Read per interest, so a second
 * interest ("mountains, then lakes") does not dilute the first one's wishes.
 */
export const OWN_WISH_SHARE = 0.3;

/**
 * What the traveller asked for themselves, as experiences. A leaning (a mood,
 * `any`) is not a wish. Multi-day trekking counts only where an interest leans
 * to it over day walks — "hut-to-hut" and "high and wild" do, plain "hiking"
 * (0.35 beside day hikes at 0.65) does not — or where the request itself named
 * a trek. A wish is never read back to the traveller as working against their
 * trip (`vacationFit`), and is never a disqualifier (`conflicts.ts`).
 */
export function ownWishes(interests: readonly { any?: boolean; mapping: Partial<Record<Experience, number>> }[], concept: readonly ConceptWeight[] = []): Set<Experience> {
  const out = new Set<Experience>();
  for (const interest of interests) {
    if (interest.any) continue;
    const total = Object.values(interest.mapping).reduce((sum, share) => sum + (share ?? 0), 0);
    if (total === 0) continue;
    for (const [experience, share] of Object.entries(interest.mapping) as [Experience, number][]) {
      if (share / total < OWN_WISH_SHARE) continue;
      if (experience === 'multi_day_trekking' && (interest.mapping.day_hiking ?? 0) >= share) continue;
      out.add(experience);
    }
  }
  if (concept.some((entry) => entry.key === 'trekking')) out.add('multi_day_trekking');
  return out;
}

/**
 * How many places to sleep seeing it well takes. `bases` lists the candidate
 * towns, not a required itinerary: a compact region is one base however many
 * towns it names, and a wide one needs more moves the wider it is.
 */
export function staysNeeded(destination: Destination): number {
  const candidates = Math.max(1, destination.bases.length);
  if (candidates === 1 || destination.radiusKm <= 80) return 1;
  return Math.min(candidates, 1 + Math.floor(destination.radiusKm / 140));
}

/** How much moving around, transfers and driving a place implies, 0 (none) … 1 (a lot). */
export function frictionOf(destination: Destination): number {
  const car = destination.access.car === 'essential' ? 0.35 : destination.access.car === 'helpful' ? 0.15 : 0;
  const transit = destination.access.transit === 'poor' ? 0.2 : destination.access.transit === 'limited' ? 0.1 : 0;
  const reach = (Math.min(3, destination.access.reach) / 3) * 0.2;
  const remote = (Math.min(3, destination.remoteness) / 3) * 0.25;
  return Math.min(1, car + transit + reach + remote);
}

/**
 * The whole trip against the kind of trip. Each concept is scored on its own
 * shape and the readings are blended by the concept's weights; the basis names
 * what decided it. Unknowns lower nothing: a place with no lodging reading is
 * not marked down for comfort, and no family reading is not a "no".
 */
export function vacationFit(
  destination: Destination,
  concept: readonly ConceptWeight[],
  context: {
    nights: number | null;
    kids: boolean;
    adventure?: number | null;
    /** The request named a broad activity, which the experience factor already scores. */
    focused?: boolean;
    /** What the traveller asked for themselves (`ownWishes`). */
    wishes?: ReadonlySet<Experience>;
  },
): VacationFit | null {
  if (concept.length === 0) return null;
  const signature = builtAround(destination);
  const ownWish = (experience: Experience) => context.wishes?.has(experience) === true;
  const friction = frictionOf(destination);
  const bases = staysNeeded(destination);
  const against: string[] = [];
  const carries: string[] = [];
  let total = 0;

  for (const { key, weight } of concept) {
    const shape = SHAPES[key];
    let fit = 1;
    /* Effort: what the easiest version still asks, and what the place is typically about. */
    const { easiest, typical } = destination.challenge;
    /* A stated adventure level outranks what a concept assumes: "outdoors" from somebody who asked for rugged is not a gentle walk. */
    const effortCap = context.adventure !== null && context.adventure !== undefined ? Math.max(shape.effort, context.adventure + 0.5) : shape.effort;
    if (easiest > effortCap) {
      fit -= 0.35 * (easiest - effortCap);
      if (effortCap <= 1) pushOnce(against, `Even the gentlest version involves demanding days — more effort than a restful trip wants.`);
    } else if (typical > effortCap + 1) {
      fit -= 0.12;
    }
    /* Moves: a restorative week is not five hotels. */
    if (context.nights !== null && bases > shape.moves) {
      fit -= Math.min(0.3, 0.1 * (bases - shape.moves));
      if (shape.moves <= 2) pushOnce(against, `Seeing it well usually means ${bases} places to stay — more packing and moving than a restful trip wants.`);
    }
    /* Friction: driving, transfers, connections, remoteness. */
    if (friction > shape.friction) {
      fit -= Math.min(0.35, (friction - shape.friction) * 0.9);
      if (shape.friction <= 0.45 && friction - shape.friction > 0.15) {
        pushOnce(against, destination.access.car === 'essential' ? 'Getting around depends on driving, which adds effort to a trip meant to be easy.' : 'Reaching and getting around it takes more logistics than a restful trip wants.');
      }
    }
    /* Comfort: only a reading counts; no reading is not a "no". */
    if (destination.lodging) {
      if (shape.comfort === 'comfortable' && !destination.lodging.comfortable && !destination.lodging.luxury) {
        fit -= 0.3;
        pushOnce(against, 'Places to stay are mostly simple; comfortable stays are scarce.');
      }
      if (shape.comfort === 'luxury' && !destination.lodging.luxury) {
        fit -= 0.35;
        pushOnce(against, 'Few high-end places to stay.');
      }
      if (shape.comfort === 'luxury' && destination.lodging.luxury) pushOnce(carries, 'high-end stays');
    }
    /*
     * Signature, for and against. How strongly the place offers what carries
     * this kind of trip sets the base (a spread, not a pass mark); what it is
     * built around that works against it costs on top. Without this every
     * place with a comfortable bed scored "suits a restful trip".
     */
    /* Gentle nature with no activity named is only said here: "outdoors stuff" must still mean somewhere outdoors. */
    if (shape.carries.length > 0 && (CARRIES_SCORED.has(key) || (key === 'scenic_nature' && !context.focused))) {
      const strengths = shape.carries.map((experience) => strength(destination, experience)).sort((a, b) => b - a);
      const carried = (strengths[0]! + (strengths[1] ?? 0)) / 2;
      fit -= 0.45 * (1 - carried);
      for (const experience of shape.carries) if (strength(destination, experience) >= 0.99) pushOnce(carries, EXPERIENCE_LABELS[experience].toLowerCase());
    }
    for (const experience of signature) {
      /* Something the traveller asked for is not held against the trip they asked for ("mountains" and a restful trip: the peaks are the point). */
      if (!shape.against.includes(experience) || ownWish(experience)) continue;
      fit -= 0.18;
      /* One sentence per experience, naming the weightiest kind of trip it works against (the concept is sorted by weight). */
      if (!against.some((line) => line.startsWith(builtAroundPrefix(experience)))) against.push(builtAroundSentence(experience, phraseFor([{ key, weight: 1 }])));
    }
    /* Family: the place's own family reading when there is one. */
    if (key === 'family_bonding' && destination.family !== null) {
      /* The family reading is on the catalog's 0–3 scale. */
      const family = Math.min(1, Math.max(0, destination.family / 3));
      fit = fit * 0.6 + family * 0.4;
      if (family >= 0.99) pushOnce(carries, context.kids ? 'easy with children' : 'easy for a family');
      else if (family < 0.5) pushOnce(against, context.kids ? 'Not an easy place to travel with children.' : 'Not an easy place to travel as a family.');
    }
    total += weight * Math.min(1, Math.max(0, fit));
  }

  const value = Math.round(Math.min(1, Math.max(0, total)) * 1000) / 1000;
  const importance = Math.round(concept.reduce((sum, { key, weight }) => sum + weight * IMPORTANCE[key], 0) * 1000) / 1000;
  const basis = value >= 0.8 ? `suits ${phraseFor(concept)}` : value >= 0.55 ? `partly suits ${phraseFor(concept)}` : `a poor fit for ${phraseFor(concept)}`;
  return { value, importance, basis, against: against.slice(0, 3), carries: carries.slice(0, 4) };
}

function builtAroundPrefix(experience: Experience): string {
  return `It is built around ${EXPERIENCE_LABELS[experience].toLowerCase()}, `;
}

/** The sentence a card carries when what a place is built around works against the kind of trip; `conflicts.ts` uses the same words. */
export function builtAroundSentence(experience: Experience, tripPhrase: string): string {
  return `${builtAroundPrefix(experience)}which is not what ${tripPhrase} is for.`;
}

/** The kind of trip in words ("a restful trip"), led by the weightiest concept. */
export function phraseFor(concept: readonly ConceptWeight[]): string {
  const lead = concept[0]!.key;
  const words: Record<ConceptKey, string> = {
    restoration: 'a restful trip',
    wellness: 'a wellness trip',
    scenic_nature: 'easy time in nature',
    outdoor_adventure: 'an adventurous trip',
    culture: 'a culture trip',
    pilgrimage: 'a pilgrimage walk',
    family_bonding: 'a family trip',
    beach_resort: 'a beach holiday',
    road_trip: 'a road trip',
    active_hiking: 'a hiking trip',
    trekking: 'a multi-day trek',
    luxury: 'a luxury trip',
    budget: 'a budget trip',
    once_in_a_lifetime: 'a once-in-a-lifetime trip',
  };
  return words[lead];
}

function pushOnce(list: string[], value: string): void {
  if (!list.includes(value)) list.push(value);
}

/**
 * Is the stay longer than the place deserves? A region good for five nights is
 * not improved by ten: the honest answer is a shorter stay plus somewhere else.
 */
export function durationVerdict(destination: Destination, nights: number | null): { overlong: boolean; best: { min: number; max: number } } {
  const best = { min: destination.nights.min, max: destination.nights.max };
  return { overlong: nights !== null && nights > destination.nights.max + 1, best };
}
