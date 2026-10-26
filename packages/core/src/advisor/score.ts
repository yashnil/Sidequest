import { CONTINENT_OF, EXPERIENCES, type CatalogDestination, type Experience } from './catalog/schema';
import type { AdvisorProfile, FactorId, AdvisorInterest } from './profile';
import { advisorKm } from './origin';

/**
 * SCORING ONE DESTINATION AGAINST ONE TRAVELLER.
 *
 * Pure: a catalog entry, a profile, arithmetic. Three outcomes per factor, and
 * the distinction is the whole design (and the old ranker's failure):
 *
 * - **measured** — a value in [0, 1] with the sentence that justifies it;
 * - **not asked** — the traveller has not said, so the factor drops out of the
 *   score entirely and is named as an open question;
 * - **excluded** — a hard constraint the destination breaks, with the reason,
 *   which removes it from the list rather than lowering it.
 *
 * The score is the weighted mean of what was measured. Because a mean over
 * fewer factors is easier to max out, `coverage` — measured weight over the
 * weight of every factor that could apply — travels beside it, ties break
 * toward the fuller reading, and the shortlist shows it. A destination is never
 * scored on how famous it is; familiarity counts only against a stated appetite
 * for the familiar or the unusual.
 */

export type FactorMeasure =
  | { kind: 'measured'; value: number; basis: string }
  | { kind: 'not_asked'; question: string };

export interface ScoredFactor {
  id: FactorId;
  weight: number;
  measure: FactorMeasure;
}

export interface AdvisorExclusion {
  code:
    | 'outside_requested_area'
    | 'out_of_season'
    | 'too_far'
    | 'too_short'
    | 'too_demanding'
    | 'mobility'
    | 'needs_a_car'
    | 'traveller_avoided'
    | 'set_aside'
    | 'nothing_you_asked_for';
  message: string;
}

export interface ScoredDestination {
  destination: CatalogDestination;
  score: number;
  coverage: number;
  factors: ScoredFactor[];
  /** Per interest: how well this place serves it, 0–1. */
  interestFit: { key: AdvisorInterest['key']; value: number }[];
  /** Months inside the traveller's window, best first, with their suitability. */
  bestMonths: number[];
  distanceKm: number | null;
  exclusion: AdvisorExclusion | null;
}

/** Nominal weights. Refinement emphasis multiplies them; unmeasured ones drop out. Sum to one without `similar`. */
export const FACTOR_WEIGHTS: Record<FactorId, number> = {
  experience: 0.32,
  season: 0.15,
  climate: 0.07,
  duration: 0.06,
  budget: 0.08,
  adventure: 0.08,
  reach: 0.07,
  getting_around: 0.04,
  crowds: 0.04,
  novelty: 0.06,
  group: 0.03,
  similar: 0.14,
};

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export function monthWord(month: number): string {
  return MONTHS[(month - 1 + 12) % 12]!;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function measured(value: number, basis: string): FactorMeasure {
  return { kind: 'measured', value: clamp01(value), basis };
}
function notAsked(question: string): FactorMeasure {
  return { kind: 'not_asked', question };
}

/** The months that count: the traveller's, or every month when they left it open. */
function windowOf(profile: AdvisorProfile): number[] {
  return profile.months ?? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
}

/** Sea swimming needs warm days; a 15 °C Arctic beach is scenery, not a swim. */
function swimmable(destination: CatalogDestination, months: readonly number[]): number {
  const highs = months.map((month) => destination.highC[month - 1]!);
  const best = Math.max(...highs);
  return clamp01((best - 19) / 7);
}

/** How well one destination serves one experience, 0–1, in the months that count. */
export function experienceValue(destination: CatalogDestination, experience: Experience, months: readonly number[]): number {
  const raw = (destination.experiences[experience] ?? 0) / 3;
  if (experience === 'beaches_swimming') return raw * (0.25 + 0.75 * swimmable(destination, months));
  if (experience === 'winter_snow') {
    const cold = months.some((month) => destination.highC[month - 1]! <= 4);
    return cold ? raw : raw * 0.15;
  }
  return raw;
}

export function interestValue(destination: CatalogDestination, interest: AdvisorInterest, months: readonly number[]): number {
  let total = 0;
  let shares = 0;
  for (const [experience, share] of Object.entries(interest.mapping) as [Experience, number][]) {
    total += share * experienceValue(destination, experience, months);
    shares += share;
  }
  if (shares === 0) return 0;
  /*
   * The best *major* experience inside an interest also counts (a component
   * carrying at least 30% of it): a place with world-class whales but no
   * birding should not read as half a wildlife destination — while a minor
   * component (day hikes inside "mountains") cannot carry the interest alone.
   */
  const majors = (Object.entries(interest.mapping) as [Experience, number][]).filter(([, share]) => share / shares >= 0.3).map(([experience]) => experience);
  const best = Math.max(0, ...majors.map((experience) => experienceValue(destination, experience, months)));
  return clamp01(0.6 * (total / shares) + 0.4 * best);
}

function experienceMeasure(destination: CatalogDestination, profile: AdvisorProfile, months: readonly number[]): { measure: FactorMeasure; fit: { key: AdvisorInterest['key']; value: number }[] } {
  if (profile.interests.length === 0) return { measure: notAsked('What you most want to do'), fit: [] };
  const fit = profile.interests.map((interest) => ({ key: interest.key, value: interestValue(destination, interest, months) }));
  const totalWeight = profile.interests.reduce((sum, interest) => sum + interest.weight, 0);
  const mean = profile.interests.reduce((sum, interest, index) => sum + interest.weight * fit[index]!.value, 0) / totalWeight;
  /* Breadth: the share of what they asked for that this place does well, so a mix request rewards a place that does the mix. */
  /* A ramp, not a cliff: one catalog point either side of a threshold must not swing half the score. */
  const breadth = profile.interests.reduce((sum, interest, index) => sum + interest.weight * clamp01((fit[index]!.value - 0.4) / 0.3), 0) / totalWeight;
  const strong = fit.filter((entry) => entry.value >= 0.6).length;
  return {
    measure: measured(0.6 * mean + 0.4 * breadth, `strong on ${strong} of the ${fit.length} things you asked for`),
    fit,
  };
}

function seasonMeasure(destination: CatalogDestination, profile: AdvisorProfile): { measure: FactorMeasure; best: number[]; exclusion: AdvisorExclusion | null } {
  const months = windowOf(profile);
  const ranked = [...months].sort((a, b) => destination.season[b - 1]! - destination.season[a - 1]! || a - b);
  const values = months.map((month) => destination.season[month - 1]! / 3);
  const best = ranked.filter((month) => destination.season[month - 1]! >= 2);
  if (!profile.months) {
    return { measure: measured(Math.max(...values), 'you left the timing open, so we used its best months'), best, exclusion: null };
  }
  const value = profile.monthsFlexible ? Math.max(...values) : values.reduce((sum, v) => sum + v, 0) / values.length;
  if (Math.max(...values) === 0) {
    return {
      measure: measured(0, 'out of season'),
      best,
      exclusion: { code: 'out_of_season', message: `Not a good time: ${destination.name} is off-season in ${months.map(monthWord).join(', ')}.` },
    };
  }
  const goodCount = values.filter((v) => v >= 2 / 3).length;
  return {
    measure: measured(value, goodCount === months.length ? 'in season for your whole window' : `good in ${goodCount} of your ${months.length} months`),
    best,
    exclusion: null,
  };
}

function climateMeasure(destination: CatalogDestination, profile: AdvisorProfile, months: readonly number[]): FactorMeasure {
  if (!profile.climate && profile.warmthShift === 0) return notAsked('Warm, mild or cool');
  const centre = (profile.climate === 'warm' ? 28 : profile.climate === 'mild' ? 21 : profile.climate === 'cold' ? 11 : 21) + 5 * profile.warmthShift;
  const half = profile.climate === 'cold' ? 6 : 4;
  const highs = months.map((month) => destination.highC[month - 1]!);
  const best = highs.reduce((winner, high) => (Math.abs(high - centre) < Math.abs(winner - centre) ? high : winner), highs[0]!);
  const miss = Math.max(0, Math.abs(best - centre) - half);
  return measured(1 - miss / 10, `days around ${best} °C`);
}

function durationMeasure(destination: CatalogDestination, profile: AdvisorProfile): { measure: FactorMeasure; exclusion: AdvisorExclusion | null } {
  if (!profile.nights) return { measure: notAsked('How long you have'), exclusion: null };
  const { min, max } = profile.nights;
  const d = destination.nights;
  if (max < d.min * 0.7 || (max <= 4 && max < d.min)) {
    return {
      measure: measured(0, 'too short'),
      exclusion: { code: 'too_short', message: `${destination.name} needs at least ${d.min} nights to be worth the journey.` },
    };
  }
  if (max >= d.min && min <= d.max) return { measure: measured(1, `${d.min}–${d.max} nights suits it`), exclusion: null };
  if (max < d.min) return { measure: measured(1 - (d.min - max) / d.min, `ideally ${d.min}+ nights`), exclusion: null };
  return { measure: measured(1 - 0.75 * Math.min(1, (min - d.max) / d.max), `more time than it needs — pair it with somewhere nearby`), exclusion: null };
}

function budgetMeasure(destination: CatalogDestination, profile: AdvisorProfile): FactorMeasure {
  if (profile.budget === null && profile.lodging === null) return notAsked('Your budget');
  let value = 1;
  const notes: string[] = [];
  if (profile.budget !== null) {
    const over = destination.cost - profile.budget;
    value = over <= 0 ? 1 : over === 1 ? 0.55 : over === 2 ? 0.15 : 0;
    notes.push(over <= 0 ? 'within your budget' : over === 1 ? 'a stretch on your budget' : 'well over your budget');
  }
  if (profile.lodging === 'luxury' && !destination.lodging.luxury) {
    value *= 0.6;
    notes.push('few high-end stays');
  }
  if (profile.lodging === 'simple' && !destination.lodging.simple) {
    value *= 0.75;
    notes.push('few simple places to stay');
  }
  return measured(value, notes.join('; '));
}

function adventureMeasure(destination: CatalogDestination, profile: AdvisorProfile): { measure: FactorMeasure; exclusion: AdvisorExclusion | null } {
  if (profile.adventure === null) return { measure: notAsked('How adventurous'), exclusion: null };
  const a = profile.adventure;
  const { easiest, typical } = destination.challenge;
  if (a === 0 && easiest >= 2) {
    return {
      measure: measured(0, 'too demanding'),
      exclusion: { code: 'too_demanding', message: `Even the easiest version of ${destination.name} involves demanding days.` },
    };
  }
  let value = 1;
  if (a < easiest) value -= 0.45 * (easiest - a);
  if (a > typical) value -= 0.3 * (a - typical);
  if (a <= 1 && destination.remoteness >= 2) value -= 0.25 * (destination.remoteness - 1);
  if (a >= 2 && destination.remoteness === 0 && typical <= 1) value -= 0.15;
  const basis = a < easiest ? 'harder than you asked for' : a > typical ? 'tamer than you asked for' : 'matches how adventurous you want to be';
  return { measure: measured(value, basis), exclusion: null };
}

function reachMeasure(destination: CatalogDestination, profile: AdvisorProfile): { measure: FactorMeasure; distanceKm: number | null; exclusion: AdvisorExclusion | null; weightScale: number } {
  const complexity = 1 - destination.access.reach / 3;
  if (!profile.origin) {
    /* Without a starting point only the last leg is known; it counts at half weight, and the distance is an open question. */
    return { measure: measured(complexity, 'how many connections from a major airport'), distanceKm: null, exclusion: null, weightScale: 0.5 };
  }
  const distanceKm = Math.round(advisorKm(profile.origin, destination.center));
  /*
   * A long weekend does not cross an ocean. Without a stated limit, the trip's
   * own length implies one: four nights or fewer, about a three-hour flight;
   * a week, a long-haul is a stretch rather than a rule.
   */
  const implied = profile.nights ? (profile.nights.max <= 4 ? 2500 : profile.nights.max <= 7 ? 7000 : null) : null;
  const limit = profile.maxDistanceKm ?? implied;
  let distance: number;
  if (limit !== null) {
    /* "Close to home" and a long weekend are firm; a longer stated limit bends further before it breaks. */
    const firm = limit <= 2500;
    if (distanceKm > limit * (firm ? 1.25 : 2.2)) {
      return {
        measure: measured(0, 'too far'),
        distanceKm,
        exclusion: { code: 'too_far', message: `About ${Math.round(distanceKm / 100) * 100} km from ${profile.origin.label} — ${profile.maxDistanceKm !== null ? 'further than you want to go' : 'too far for a trip that short'}.` },
        weightScale: 1,
      };
    }
    distance = distanceKm <= limit ? 1 : clamp01(1 - (distanceKm - limit) / limit);
  } else {
    distance = 1 - 0.45 * Math.min(1, distanceKm / 15000);
  }
  return {
    measure: measured(0.75 * distance + 0.25 * complexity, `about ${Math.round(distanceKm / 100) * 100} km from ${profile.origin.label}`),
    distanceKm,
    exclusion: null,
    weightScale: 1,
  };
}

function gettingAroundMeasure(destination: CatalogDestination, profile: AdvisorProfile): { measure: FactorMeasure; exclusion: AdvisorExclusion | null } {
  if (profile.car === null) return { measure: notAsked('Whether you will drive'), exclusion: null };
  const { car, transit } = destination.access;
  if (profile.car === 'drive') return { measure: measured(car === 'unnecessary' ? 0.85 : 1, car === 'essential' ? 'a driving trip, which suits you' : 'good with a car'), exclusion: null };
  if (car === 'essential' && transit === 'poor') {
    return {
      measure: measured(0, 'needs a car'),
      exclusion: { code: 'needs_a_car', message: `${destination.name} is hard to do without a car, and you'd rather not drive.` },
    };
  }
  const base = car === 'unnecessary' ? 1 : car === 'helpful' ? 0.65 : 0.25;
  const transitPenalty = transit === 'good' ? 0 : transit === 'limited' ? 0.1 : 0.25;
  return { measure: measured(base - transitPenalty, car === 'unnecessary' ? 'easy without a car' : 'easier with a car'), exclusion: null };
}

function crowdsMeasure(destination: CatalogDestination, profile: AdvisorProfile): FactorMeasure {
  if (profile.avoidCrowds !== true) return notAsked('How you feel about crowds');
  return measured(1 - destination.crowds / 3, destination.crowds >= 2 ? 'busy in peak season' : 'quiet even at its busiest');
}

function noveltyMeasure(destination: CatalogDestination, profile: AdvisorProfile): FactorMeasure {
  const visited = profile.visited.some((name) => name.length >= 4 && (destination.name.toLowerCase().includes(name) || name.includes(destination.name.toLowerCase())));
  if (profile.novelty === 'unusual') return measured((1 - destination.familiarity / 3) * (visited ? 0.3 : 1), destination.familiarity <= 1 ? 'off most people’s lists' : 'well known');
  if (profile.novelty === 'familiar') return measured((0.35 + 0.65 * (destination.familiarity / 3)) * (visited ? 0.5 : 1), destination.familiarity >= 2 ? 'a proven classic' : 'less well trodden');
  if (visited) return measured(0.3, 'you have been before');
  return notAsked('Classics or somewhere unusual');
}

function groupMeasure(destination: CatalogDestination, profile: AdvisorProfile): { measure: FactorMeasure; exclusion: AdvisorExclusion | null } {
  const parts: number[] = [];
  const notes: string[] = [];
  if (profile.limitedMobility) {
    if (destination.lowMobility === 0) {
      return {
        measure: measured(0, 'hard with limited mobility'),
        exclusion: { code: 'mobility', message: `${destination.name} is hard going with limited mobility.` },
      };
    }
    parts.push(destination.lowMobility / 3);
    notes.push(destination.lowMobility >= 2 ? 'manageable with limited mobility' : 'some of it is hard with limited mobility');
  }
  if (profile.kids) {
    parts.push(destination.family / 3);
    notes.push(destination.family >= 2 ? 'good with children' : 'harder with children');
  }
  if (profile.olderTravellers) {
    parts.push((destination.lowMobility + Math.max(0, 3 - destination.remoteness)) / 6);
    notes.push('older travellers considered');
  }
  if (profile.altitudeSensitive) {
    const high = (destination.experiences.high_mountains ?? 0) >= 3 && destination.challenge.typical >= 3;
    parts.push(high ? 0.2 : 1);
    if (high) notes.push('high altitude');
  }
  if (parts.length === 0) return { measure: notAsked('Who is going'), exclusion: null };
  return { measure: measured(Math.min(...parts), notes.join('; ')), exclusion: null };
}

/** Cosine similarity of two experience profiles. */
export function experienceSimilarity(a: CatalogDestination, b: CatalogDestination): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const experience of EXPERIENCES) {
    const x = a.experiences[experience] ?? 0;
    const y = b.experiences[experience] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

function similarMeasure(destination: CatalogDestination, profile: AdvisorProfile, target: CatalogDestination | null): FactorMeasure | null {
  if (!profile.similarTo || !target) return null;
  const sameShape = destination.kind === target.kind ? 0.1 : 0;
  const sameFeel = 1 - Math.abs(destination.challenge.typical - target.challenge.typical) / 3;
  return measured(0.75 * experienceSimilarity(destination, target) + 0.15 * sameFeel + sameShape, `similar to ${target.name}`);
}

function ruledOutByName(destination: CatalogDestination, avoidText: string): boolean {
  if (!avoidText.trim()) return false;
  const words = new Set(avoidText.split(/[^\p{L}\p{N}]+/u).filter(Boolean));
  const name = destination.name.toLowerCase();
  if (words.has(name) || (name.includes(' ') && avoidText.includes(name))) return true;
  const context = destination.context.toLowerCase();
  return context.length >= 4 && (words.has(context) || (context.includes(' ') && avoidText.includes(context)));
}

export interface ScoreContext {
  similarTarget?: CatalogDestination | null;
}

export function scoreDestination(destination: CatalogDestination, profile: AdvisorProfile, context: ScoreContext = {}): ScoredDestination {
  const months = windowOf(profile);
  const factors: ScoredFactor[] = [];
  let exclusion: AdvisorExclusion | null = null;
  const exclude = (candidate: AdvisorExclusion | null) => {
    if (candidate && !exclusion) exclusion = candidate;
  };

  if (profile.excluded.has(destination.id)) exclude({ code: 'set_aside', message: 'You set this one aside.' });
  if (profile.regions && !profile.regions.includes(destination.worldRegion)) {
    exclude({ code: 'outside_requested_area', message: 'Outside the part of the world you asked for.' });
  }
  if (profile.countries && !destination.countries.some((code) => profile.countries!.includes(code))) {
    exclude({ code: 'outside_requested_area', message: profile.countries.length === 1 ? 'Outside the country you want to stay in.' : 'Outside the countries you asked for.' });
  }
  if (ruledOutByName(destination, profile.avoidText)) exclude({ code: 'traveller_avoided', message: 'You asked to avoid this.' });

  const add = (id: FactorId, measure: FactorMeasure, scale = 1) => {
    factors.push({ id, weight: FACTOR_WEIGHTS[id] * (profile.emphasis[id] ?? 1) * scale, measure });
  };

  const season = seasonMeasure(destination, profile);
  exclude(season.exclusion);
  /* The experiences are read in the months that are actually good, so a beach is judged on its swimming season inside the window. */
  const goodMonths = season.best.length > 0 ? season.best : months;
  const experience = experienceMeasure(destination, profile, goodMonths);
  add('experience', experience.measure);
  add('season', season.measure);
  add('climate', climateMeasure(destination, profile, goodMonths));
  const duration = durationMeasure(destination, profile);
  exclude(duration.exclusion);
  add('duration', duration.measure);
  add('budget', budgetMeasure(destination, profile));
  const adventure = adventureMeasure(destination, profile);
  exclude(adventure.exclusion);
  add('adventure', adventure.measure);
  const reach = reachMeasure(destination, profile);
  exclude(reach.exclusion);
  add('reach', reach.measure, reach.weightScale);
  const around = gettingAroundMeasure(destination, profile);
  exclude(around.exclusion);
  add('getting_around', around.measure);
  add('crowds', crowdsMeasure(destination, profile));
  add('novelty', noveltyMeasure(destination, profile));
  const group = groupMeasure(destination, profile);
  exclude(group.exclusion);
  add('group', group.measure);
  const similar = similarMeasure(destination, profile, context.similarTarget ?? null);
  if (similar) add('similar', similar);

  /*
   * A relevance floor on what they came for. A place that does none of it is not
   * a weak match, it is the wrong answer — and without this a perfect season and
   * budget could carry it onto the list.
   */
  if (experience.measure.kind === 'measured' && experience.measure.value < 0.25 && profile.interests.length > 0) {
    exclude({ code: 'nothing_you_asked_for', message: `${destination.name} isn't strong on what you asked for.` });
  }

  let measuredWeight = 0;
  let total = 0;
  let nominal = 0;
  for (const factor of factors) {
    nominal += factor.weight;
    if (factor.measure.kind === 'measured') {
      measuredWeight += factor.weight;
      total += factor.weight * factor.measure.value;
    }
  }

  return {
    destination,
    score: measuredWeight > 0 ? total / measuredWeight : 0,
    coverage: nominal > 0 ? measuredWeight / nominal : 0,
    factors,
    interestFit: experience.fit,
    bestMonths: season.best,
    distanceKm: reach.distanceKm,
    exclusion,
  };
}

/**
 * A total order: score, then coverage (the fuller reading wins a tie), then the
 * lead interest, then id. Never familiarity, never catalog position.
 */
export function compareScored(a: ScoredDestination, b: ScoredDestination): number {
  const byScore = Math.round(b.score * 1000) - Math.round(a.score * 1000);
  if (byScore !== 0) return byScore;
  const byCoverage = Math.round(b.coverage * 100) - Math.round(a.coverage * 100);
  if (byCoverage !== 0) return byCoverage;
  const lead = (s: ScoredDestination) => s.interestFit[0]?.value ?? 0;
  if (lead(b) !== lead(a)) return lead(b) - lead(a);
  return a.destination.id.localeCompare(b.destination.id);
}

export { CONTINENT_OF };
