import { CONTINENT_OF, EXPERIENCES, type CatalogDestination, type Experience } from './catalog/schema';
import type { AdvisorProfile, FactorId, AdvisorInterest } from './profile';
import { advisorKm } from './origin';
import { asDestination, type Destination } from './destination';
import { LIMIT_WORDS, climateFromEditorial, seasonModel, travellerSeason, type Limit, type MonthFit, type SeasonModel } from '../atlas/seasonality';

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
    | 'over_budget'
    | 'traveller_avoided'
    | 'set_aside'
    | 'nothing_you_asked_for'
    | 'advisory'
    | 'home';
  message: string;
}

export interface ScoredDestination {
  destination: Destination;
  score: number;
  coverage: number;
  factors: ScoredFactor[];
  /** Per interest: how well this place serves it, 0–1. */
  interestFit: { key: AdvisorInterest['key']; value: number }[];
  /** Months inside the traveller's window, best first, with their suitability. */
  bestMonths: number[];
  /** How good each of the twelve months is for what this traveller wants to do here, and what limits it. */
  seasonMonths: MonthFit[];
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

/**
 * How far an uncertain reading is trusted.
 *
 * An editorial reading stands as written — it is the reference the derived
 * ones are calibrated against. A reading estimated from open data is discounted
 * by how thin its evidence is: half its value is always kept (a place is not
 * thrown away for being little documented) and the other half scales with
 * confidence (nor does it outrank a well-evidenced one on a guess).
 */
function trust(destination: Destination): number {
  return destination.origin === 'editorial' ? 1 : 0.5 + 0.5 * Math.min(1, Math.max(0, destination.confidence));
}

/** A value known only loosely is pulled toward a cautious middle rather than believed or ignored. */
function shrink(value: number, confidence: number, prior: number): number {
  return confidence * value + (1 - confidence) * prior;
}

/* Keyed on the measured climate where there is one: a per-request copy of a record (carrying its lexical mention) shares it. */
const seasonModels = new WeakMap<object, SeasonModel>();

/**
 * The activity-by-month model for a destination: from measured normals when the
 * atlas sampled the place, otherwise reconstructed from the editorial highs and
 * wetness so the same questions can still be asked, more coarsely.
 */
export function seasonModelFor(destination: Destination): SeasonModel {
  const key: object = destination.measured ?? destination;
  const held = seasonModels.get(key);
  if (held) return held;
  const measured = destination.measured;
  const offersCoast = (destination.experiences.beaches_swimming ?? 0) > 0 || (destination.experiences.coastal_scenery ?? 0) >= 2 || (destination.experiences.snorkel_dive ?? 0) > 0;
  let model: SeasonModel;
  if (measured) {
    model = seasonModel({ lat: destination.center.lat, base: measured.base, high: measured.high, sst: measured.sst, coastKm: measured.coastKm ?? (offersCoast && destination.origin === 'editorial' ? 0 : null) }, destination.center.lng);
  } else {
    /*
     * No normals for this place: the same questions are asked of the editorial
     * highs and wetness. Where the editor says there are high mountains or
     * snow sports, a slope is assumed above the base (1,500 m up, the standard
     * 6.5 °C per km cooler, a third wetter) — coarse, and only ever used until
     * the atlas has sampled the real ground.
     */
    const base = climateFromEditorial(destination.highC, destination.wet);
    const mountainous = (destination.experiences.high_mountains ?? 0) >= 2 || (destination.experiences.winter_snow ?? 0) >= 2 || (destination.experiences.glaciers_ice ?? 0) >= 2;
    const high = mountainous
      ? { elevM: 1500, tmax: base.tmax.map((value) => value - 9.75), tmin: base.tmin.map((value) => value - 9.75), pr: base.pr.map((value) => value * 1.3) }
      : null;
    model = seasonModel({ lat: destination.center.lat, base, high, sst: null, coastKm: offersCoast ? 0 : null }, destination.center.lng);
  }
  seasonModels.set(key, model);
  return model;
}

/** The best an activity gets across some months, 0–1. */
function bestFit(destination: Destination, activity: 'beach' | 'dive' | 'ski', months: readonly number[]): number {
  const fit = seasonModelFor(destination).fit[activity];
  return Math.max(0, ...months.map((month) => fit[month - 1]!.value));
}

/** How well one destination serves one experience, 0–1, in the months that count. */
export function experienceValue(input: CatalogDestination | Destination, experience: Experience, months: readonly number[]): number {
  const destination = asDestination(input);
  const raw = Math.min(1, (destination.experiences[experience] ?? 0) / 3);
  if (raw === 0) return 0;
  /* Sea swimming needs a warm sea in the window; a 12 °C Arctic beach is scenery, not a swim. */
  if (experience === 'beaches_swimming') return raw * (0.25 + 0.75 * bestFit(destination, 'beach', months));
  if (experience === 'snorkel_dive') return raw * (0.5 + 0.5 * bestFit(destination, 'dive', months));
  /* Snow sports need a snowpack in the window. */
  if (experience === 'winter_snow') return raw * (0.15 + 0.85 * bestFit(destination, 'ski', months));
  return raw;
}

export function interestValue(input: CatalogDestination | Destination, interest: AdvisorInterest, months: readonly number[]): number {
  const destination = asDestination(input);
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
  /* A city break is a break in a city: a coast with good restaurants is not what was asked for, however well it eats. */
  const shape = interest.key === 'cities' && !URBAN_KINDS.has(destination.kind) ? 0.75 : 1;
  return clamp01((0.6 * (total / shares) + 0.4 * best) * trust(destination) * shape);
}

const ALL_MONTHS: readonly number[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const URBAN_KINDS: ReadonlySet<string> = new Set(['city', 'city_and_surroundings', 'town']);

/** How much of the fit comes from the words of the request once nothing else was said. */
const MENTION_SHARE = 0.5;

function experienceMeasure(destination: Destination, profile: AdvisorProfile, months: readonly number[]): { measure: FactorMeasure; fit: { key: AdvisorInterest['key']; value: number }[] } {
  const mention = profile.terms.length > 0 && destination.mention !== undefined ? clamp01(destination.mention) : null;
  if (profile.interests.length === 0) {
    /* Nothing structured was asked for; the words of the request are the only evidence there is. */
    if (mention !== null) return { measure: measured(mention, mention >= 0.5 ? 'written up for what you described' : 'only loosely matches what you described'), fit: [] };
    return { measure: notAsked('What you most want to do'), fit: [] };
  }
  const fit = profile.interests.map((interest) => ({ key: interest.key, value: interestValue(destination, interest, months) }));
  const totalWeight = profile.interests.reduce((sum, interest) => sum + interest.weight, 0);
  const mean = profile.interests.reduce((sum, interest, index) => sum + interest.weight * fit[index]!.value, 0) / totalWeight;
  /* Breadth: the share of what they asked for that this place does well, so a mix request rewards a place that does the mix. */
  /* A ramp, not a cliff: one catalog point either side of a threshold must not swing half the score. */
  const breadth = profile.interests.reduce((sum, interest, index) => sum + interest.weight * clamp01((fit[index]!.value - 0.4) / 0.3), 0) / totalWeight;
  const strong = fit.filter((entry) => entry.value >= 0.6).length;
  /* What they refused counts against a place built around it ("no cities" and a city break), softly: a refusal is a dislike, not a rule. */
  const refusedValue = Math.max(0, ...profile.refused.map((interest) => interestValue(destination, interest, months)));
  const refusal = refusedValue >= 0.5 ? 1 - 0.4 * refusedValue : 1;
  /*
   * The aurora is a matter of geomagnetic latitude, not of how good the snow
   * is: it is seen under the auroral ovals and rarely far from them. Geographic
   * latitude is a coarse stand-in (the oval dips lower over North America than
   * over Europe), so the fall-off is gentle — but an alpine valley at 46° is
   * not where anybody goes for it.
   */
  const latitude = Math.abs(destination.center.lat);
  const aurora = profile.aurora ? (latitude >= 62 ? 1 : latitude >= 55 ? 0.45 + 0.55 * ((latitude - 55) / 7) : latitude >= 48 ? 0.2 : 0.05) : 1;
  const structured = (0.6 * mean + 0.4 * breadth) * refusal * aurora;
  /*
   * The request's own words can only lift a place, never sink one: a guide
   * that talks about "lochs and castles" is evidence for it, and a guide that
   * does not is no evidence against — the words may simply be the traveller's
   * way of saying something the structured reading already caught.
   */
  const value = mention === null ? structured : structured + MENTION_SHARE * mention * (1 - structured);
  return {
    measure: measured(value, `strong on ${strong} of the ${fit.length} things you asked for${refusal < 1 ? ', but built around something you would rather avoid' : ''}${mention !== null && mention >= 0.5 ? ', and written up for what you described' : ''}`),
    fit,
  };
}

/** How much an editorial season level lets a month count: 0 = avoid or closed … 3 = best. */
const EDITORIAL_GATE = [0.1, 0.5, 0.9, 1];
/** A month at or above this is one you would choose. */
export const GOOD_MONTH = 0.6;
/** A window whose best month is below this is out of season, not merely poor. */
export const CLOSED_MONTH = 0.12;

/**
 * How good each of the twelve months is **for this traveller, at this place**.
 *
 * The activity model answers from measured climate, per activity, weighted by
 * what the traveller wants and the place offers. Where a person also wrote an
 * overall season curve, it gates the answer: an editor's "avoid" holds whatever
 * the normals say (a closed road, a polar night, a cyclone month), and an
 * editor's "best" cannot make a snowbound trail walkable — which is how Tyrol
 * came to be "in season" for March hiking.
 */
export function seasonMonthsFor(input: CatalogDestination | Destination, profile: AdvisorProfile): MonthFit[] {
  const destination = asDestination(input);
  const model = seasonModelFor(destination);
  const { months } = travellerSeason(model, profile.wants, destination.experiences);
  const onFoot = (profile.wants.day_hiking ?? 0) + (profile.wants.multi_day_trekking ?? 0) + (profile.wants.high_mountains ?? 0);
  return months.map((month, index) => {
    let value = month.value;
    let limit: Limit | null = month.limit;
    if (destination.season) {
      const gate = EDITORIAL_GATE[destination.season[index]!] ?? 0.5;
      value = gate * (0.2 + 0.8 * value);
    }
    /* "Hiking but no snow" is a refusal: a month with snow on the ground is out, at the base or — for somebody on foot — on the high trails. */
    if (profile.avoidSnow && (model.snow.base[index]! > 15 || (onFoot >= 0.3 && model.snow.trek[index]! > 40 && (destination.experiences.high_mountains ?? 0) >= 2))) {
      value *= 0.1;
      limit = 'snow_on_trails';
    }
    return { value: clamp01(value), limit };
  });
}

/** Kept for callers that read a 0–3 level: the continuous month value on the old scale. */
export function seasonLevelFor(destination: CatalogDestination | Destination, month: number, profile: AdvisorProfile): number {
  const value = seasonMonthsFor(destination, profile)[month - 1]!.value;
  return value >= 0.85 ? 3 : value >= GOOD_MONTH ? 2 : value >= CLOSED_MONTH ? 1 : 0;
}

function seasonMeasure(destination: Destination, profile: AdvisorProfile): { measure: FactorMeasure; best: number[]; all: MonthFit[]; exclusion: AdvisorExclusion | null } {
  const months = windowOf(profile);
  const all = seasonMonthsFor(destination, profile);
  const at = (month: number) => all[month - 1]!;
  const values = months.map((month) => at(month).value);
  const best = [...months].filter((month) => at(month).value >= GOOD_MONTH).sort((a, b) => at(b).value - at(a).value || a - b);
  const top = Math.max(...values);
  if (!profile.months) {
    return { measure: measured(top, 'you left the timing open, so we used its best months'), best, all, exclusion: null };
  }
  /* The reason the window is poor: whatever limits the most months of it. */
  const limits = new Map<Limit, number>();
  for (const month of months) {
    const limit = at(month).limit;
    if (limit && at(month).value < GOOD_MONTH) limits.set(limit, (limits.get(limit) ?? 0) + 1);
  }
  const why = [...limits.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  if (top < CLOSED_MONTH) {
    return {
      measure: measured(0, 'out of season'),
      best,
      all,
      exclusion: {
        code: 'out_of_season',
        message: `Not a good time: ${months.map(monthWord).join(', ')} at ${destination.name} usually ${why ? `means ${LIMIT_WORDS[why]}` : 'is off-season'} for what you want to do.`,
      },
    };
  }
  const value = profile.monthsFlexible ? top : values.reduce((sum, v) => sum + v, 0) / values.length;
  const goodCount = best.length;
  const basis =
    goodCount === months.length
      ? 'in season for your whole window'
      : goodCount === 0
        ? `possible but not at its best${why ? ` — expect ${LIMIT_WORDS[why]}` : ''}`
        : `good in ${goodCount} of your ${months.length} months${why ? `; otherwise ${LIMIT_WORDS[why]}` : ''}`;
  return { measure: measured(value, basis), best, all, exclusion: null };
}

function climateMeasure(destination: Destination, profile: AdvisorProfile, months: readonly number[]): FactorMeasure {
  if (!profile.climate && profile.warmthShift === 0) return notAsked('Warm, mild or cool');
  const centre = (profile.climate === 'warm' ? 28 : profile.climate === 'mild' ? 21 : profile.climate === 'cold' ? 11 : 21) + 5 * profile.warmthShift;
  const half = profile.climate === 'cold' ? 6 : 4;
  const highs = months.map((month) => destination.highC[month - 1]!);
  const best = highs.reduce((winner, high) => (Math.abs(high - centre) < Math.abs(winner - centre) ? high : winner), highs[0]!);
  const miss = Math.max(0, Math.abs(best - centre) - half);
  return measured(1 - miss / 10, `days around ${Math.round(best)} °C`);
}

function durationMeasure(destination: Destination, profile: AdvisorProfile): { measure: FactorMeasure; exclusion: AdvisorExclusion | null } {
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
  return { measure: measured(1 - Math.min(1, (min - d.max) / d.max), `more time than it needs — pair it with somewhere nearby`), exclusion: null };
}

/**
 * A tight budget is a limit, not a taste: somebody who said "budget-conscious"
 * or "not too expensive" is not offered a place two cost levels above it. A
 * comfortable or luxury budget only ever bends.
 */
function budgetExclusion(destination: Destination, profile: AdvisorProfile): AdvisorExclusion | null {
  if (profile.budget === null || profile.budget > 2 || destination.cost - profile.budget < 2) return null;
  return { code: 'over_budget', message: `${destination.name} is well over the budget you gave.` };
}

/** How a cost above the budget counts, continuous so an estimated 2.4 is not rounded into a verdict. */
function overBudgetValue(over: number): number {
  if (over <= 0) return 1;
  if (over <= 1) return 1 - 0.45 * over;
  if (over <= 2) return 0.55 - 0.4 * (over - 1);
  return Math.max(0, 0.15 - 0.15 * (over - 2));
}

function budgetMeasure(destination: Destination, profile: AdvisorProfile): FactorMeasure {
  if (profile.budget === null && profile.lodging === null) return notAsked('Your budget');
  let value = 1;
  const notes: string[] = [];
  if (profile.budget !== null) {
    const over = destination.cost - profile.budget;
    value = overBudgetValue(over);
    notes.push(over <= 0.25 ? 'within your budget' : over <= 1.25 ? 'a stretch on your budget' : 'well over your budget');
    if (destination.basis.cost === 'estimated') notes.push('costs estimated from the country’s price level');
  }
  /* Somebody who asked for luxury wants the stays to match, not merely to be inside a budget nothing could exceed. */
  if (destination.lodging) {
    if ((profile.lodging === 'luxury' || profile.budget === 4) && !destination.lodging.luxury) {
      value *= 0.6;
      notes.push('few high-end stays');
    }
    if (profile.lodging === 'simple' && !destination.lodging.simple) {
      value *= 0.75;
      notes.push('few simple places to stay');
    }
  }
  return measured(value, notes.join('; '));
}

function adventureMeasure(destination: Destination, profile: AdvisorProfile): { measure: FactorMeasure; exclusion: AdvisorExclusion | null } {
  if (profile.adventure === null) return { measure: notAsked('How adventurous'), exclusion: null };
  const a = profile.adventure;
  const { easiest, typical } = destination.challenge;
  const estimated = destination.basis.logistics === 'estimated';
  /* A rule needs a reading somebody stands behind; an estimated difficulty only lowers the score. */
  if (a === 0 && easiest >= 2 && !estimated) {
    return {
      measure: measured(0, 'too demanding'),
      exclusion: { code: 'too_demanding', message: `Even the easiest version of ${destination.name} involves demanding days.` },
    };
  }
  let value = 1;
  if (a < easiest) value -= 0.45 * (easiest - a);
  if (a > typical) value -= 0.3 * (a - typical);
  if (a <= 1 && destination.remoteness >= 2) value -= 0.25 * (destination.remoteness - 1);
  if (a >= 2 && destination.remoteness < 0.5 && typical <= 1) value -= 0.15;
  const basis = a < easiest - 0.25 ? 'harder than you asked for' : a > typical + 0.25 ? 'tamer than you asked for' : 'matches how adventurous you want to be';
  return { measure: measured(estimated ? shrink(clamp01(value), 0.7, 0.6) : value, basis), exclusion: null };
}

function reachMeasure(destination: Destination, profile: AdvisorProfile): { measure: FactorMeasure; distanceKm: number | null; exclusion: AdvisorExclusion | null; weightScale: number } {
  const complexity = 1 - Math.min(3, destination.access.reach) / 3;
  if (!profile.origin) {
    /* Without a starting point only the last leg is known; it counts at half weight, and the distance is an open question. */
    return { measure: measured(complexity, 'how many connections from a major airport'), distanceKm: null, exclusion: null, weightScale: 0.5 };
  }
  const distanceKm = Math.round(advisorKm(profile.origin, destination.center));
  /* Where they already are is not a trip. */
  if (distanceKm <= Math.max(40, Math.min(destination.radiusKm, 120) * 0.5) && destination.kind !== 'country' && destination.radiusKm <= 250) {
    return { measure: measured(0, 'where you already are'), distanceKm, exclusion: { code: 'home', message: `${destination.name} is where you are starting from.` }, weightScale: 1 };
  }
  /*
   * A long weekend does not cross an ocean. Without a stated limit, the trip's
   * own length implies one: four nights or fewer, about a three-hour flight;
   * a week, a long-haul is a stretch rather than a rule.
   */
  const implied = profile.nights ? (profile.nights.max <= 2 ? 1300 : profile.nights.max <= 4 ? 2500 : profile.nights.max <= 7 ? 7000 : null) : null;
  const limit = profile.maxDistanceKm ?? implied;
  let distance: number;
  if (limit !== null) {
    /* "Close to home" and a long weekend are firm; a longer stated limit bends further before it breaks. */
    const firm = limit <= 2500;
    if (distanceKm > limit * (firm ? 1.15 : 2.2)) {
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

function gettingAroundMeasure(destination: Destination, profile: AdvisorProfile): { measure: FactorMeasure; exclusion: AdvisorExclusion | null } {
  if (profile.car === null) return { measure: notAsked('Whether you will drive'), exclusion: null };
  const { car, transit } = destination.access;
  /* Not known is not a verdict either way: a cautious middle, and the card says it is unconfirmed. */
  if (car === 'unknown') return { measure: measured(profile.car === 'drive' ? 0.8 : 0.5, 'getting around not confirmed'), exclusion: null };
  if (profile.car === 'drive') return { measure: measured(car === 'unnecessary' ? 0.85 : 1, car === 'essential' ? 'a driving trip, which suits you' : 'good with a car'), exclusion: null };
  if (car === 'essential' && transit === 'poor' && destination.basis.logistics !== 'estimated') {
    return {
      measure: measured(0, 'needs a car'),
      exclusion: { code: 'needs_a_car', message: `${destination.name} is hard to do without a car, and you'd rather not drive.` },
    };
  }
  const base = car === 'unnecessary' ? 1 : car === 'helpful' ? 0.65 : 0.25;
  const transitPenalty = transit === 'good' ? 0 : transit === 'limited' || transit === 'unknown' ? 0.1 : 0.25;
  return { measure: measured(base - transitPenalty, car === 'unnecessary' ? 'easy without a car' : 'easier with a car'), exclusion: null };
}

function crowdsMeasure(destination: Destination, profile: AdvisorProfile): FactorMeasure {
  if (profile.avoidCrowds !== true) return notAsked('How you feel about crowds');
  return measured(1 - Math.min(3, destination.crowds) / 3, destination.crowds >= 2 ? 'busy in peak season' : 'quiet even at its busiest');
}

function noveltyMeasure(destination: Destination, profile: AdvisorProfile): FactorMeasure {
  const lowered = destination.name.toLowerCase();
  const visited = profile.visited.some((name) => name.length >= 4 && (lowered.includes(name) || name.includes(lowered)));
  const familiarity = Math.min(3, destination.familiarity);
  if (profile.novelty === 'unusual') return measured((1 - familiarity / 3) * (visited ? 0.3 : 1), familiarity <= 1 ? 'off most people’s lists' : 'well known');
  if (profile.novelty === 'familiar') return measured((0.35 + 0.65 * (familiarity / 3)) * (visited ? 0.5 : 1), familiarity >= 2 ? 'a proven classic' : 'less well trodden');
  if (visited) return measured(0.3, 'you have been before');
  return notAsked('Classics or somewhere unusual');
}

/** What an unknown suitability counts as: below neutral, because "nobody has said it works" is not "it works". */
const UNKNOWN_SUITABILITY = 0.45;

function groupMeasure(destination: Destination, profile: AdvisorProfile): { measure: FactorMeasure; exclusion: AdvisorExclusion | null } {
  const parts: number[] = [];
  const notes: string[] = [];
  const estimated = destination.basis.logistics === 'estimated';
  if (profile.limitedMobility) {
    if (destination.lowMobility === null) {
      parts.push(UNKNOWN_SUITABILITY);
      notes.push('accessibility not confirmed');
    } else {
      if (destination.lowMobility < 0.5 && !estimated) {
        return {
          measure: measured(0, 'hard with limited mobility'),
          exclusion: { code: 'mobility', message: `${destination.name} is hard going with limited mobility.` },
        };
      }
      parts.push(destination.lowMobility / 3);
      notes.push(destination.lowMobility >= 2 ? 'manageable with limited mobility' : 'some of it is hard with limited mobility');
    }
  }
  if (profile.kids) {
    if (destination.family === null) {
      parts.push(UNKNOWN_SUITABILITY);
      notes.push('not confirmed for children');
    } else {
      parts.push(destination.family / 3);
      notes.push(destination.family >= 2 ? 'good with children' : 'harder with children');
    }
  }
  if (profile.olderTravellers) {
    parts.push(destination.lowMobility === null ? UNKNOWN_SUITABILITY : (destination.lowMobility + Math.max(0, 3 - destination.remoteness)) / 6);
    notes.push('older travellers considered');
  }
  if (profile.altitudeSensitive) {
    const high = (destination.experiences.high_mountains ?? 0) >= 2.5 && destination.challenge.typical >= 2.5;
    parts.push(high ? 0.2 : 1);
    if (high) notes.push('high altitude');
  }
  if (parts.length === 0) return { measure: notAsked('Who is going'), exclusion: null };
  return { measure: measured(Math.min(...parts), notes.join('; ')), exclusion: null };
}

/** Cosine similarity of two experience profiles. */
export function experienceSimilarity(a: Pick<Destination, 'experiences'>, b: Pick<Destination, 'experiences'>): number {
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

/**
 * "Somewhere like X": the same kind of trip — what there is to do, how hard it
 * is, what the ground looks like (relief and how warm the best months are) —
 * and never the same place again. Being near X counts for nothing; a traveller
 * asking for "the Dolomites, but cheaper" wants the experience, not the valley
 * next door.
 */
function similarMeasure(destination: Destination, profile: AdvisorProfile, target: Destination | null): FactorMeasure | null {
  if (!profile.similarTo || !target) return null;
  const sameShape = destination.kind === target.kind ? 0.08 : 0;
  const sameFeel = 1 - Math.min(3, Math.abs(destination.challenge.typical - target.challenge.typical)) / 3;
  const warmest = (entry: Destination) => Math.max(...entry.highC);
  const sameWarmth = 1 - Math.min(1, Math.abs(warmest(destination) - warmest(target)) / 14);
  const relief = (entry: Destination) => (entry.measured?.high ? entry.measured.high.elevM - entry.measured.base.elevM : null);
  const a = relief(destination);
  const b = relief(target);
  const sameRelief = a === null || b === null ? 0.5 : 1 - Math.min(1, Math.abs(a - b) / 2500);
  return measured(0.62 * experienceSimilarity(destination, target) * trust(destination) + 0.12 * sameFeel + 0.1 * sameWarmth + 0.08 * sameRelief + sameShape, `similar to ${target.name}`);
}

function ruledOutByName(destination: Destination, avoidText: string): boolean {
  if (!avoidText.trim()) return false;
  const words = new Set(avoidText.split(/[^\p{L}\p{N}]+/u).filter(Boolean));
  const name = destination.name.toLowerCase();
  if (words.has(name) || (name.includes(' ') && avoidText.includes(name))) return true;
  const context = destination.context.toLowerCase();
  return context.length >= 4 && (words.has(context) || (context.includes(' ') && avoidText.includes(context)));
}

export interface ScoreContext {
  similarTarget?: Destination | CatalogDestination | null;
  /** The destinations the request named as its geography; a candidate must lie inside one. */
  withinTargets?: readonly Destination[] | null;
  /** The destinations the request ruled out by name; a candidate must lie inside none. */
  outsideTargets?: readonly Destination[] | null;
}

/**
 * Whether a destination lies inside a named geography: its own extent,
 * generously, because a range's "radius" is a rough circle around a long ridge.
 *
 * A continent-scale target has no usable circle — only the world's hierarchy
 * knows its members. Asked as a *scope* that is safe to wave through, because
 * the world already chose the candidates by that hierarchy. Asked as a
 * *refusal* ("not Antarctica") it must not be: waving everything through would
 * rule out the planet. `strict` is the refusal reading.
 */
export function liesWithin(destination: Destination, target: Destination, strict = false): boolean {
  if (destination.id === target.id || destination.parents.includes(target.id)) return true;
  /* A country is its borders, not a circle round its capital. */
  if (target.kind === 'country' && target.countries.length === 1) return destination.countries.includes(target.countries[0]!);
  if (target.radiusKm >= 1000) return !strict;
  if (strict && target.countries.length === 1 && !destination.countries.includes(target.countries[0]!)) return false;
  const km = advisorKm(destination.center, target.center);
  return km <= Math.max(25, target.radiusKm * 1.15);
}

/** Do-not-travel advisories remove a place; the level below them is a caution on the card. */
const ADVISORY_EXCLUDES = 4;

export function scoreDestination(input: CatalogDestination | Destination, profile: AdvisorProfile, context: ScoreContext = {}): ScoredDestination {
  const destination = asDestination(input);
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
  if (context.withinTargets && context.withinTargets.length > 0 && !context.withinTargets.some((target) => liesWithin(destination, target))) {
    exclude({ code: 'outside_requested_area', message: `Outside ${context.withinTargets.map((target) => target.name).join(' / ')}.` });
  }
  if (ruledOutByName(destination, profile.avoidText)) exclude({ code: 'traveller_avoided', message: 'You asked to avoid this.' });
  const ruledOut = context.outsideTargets?.find((target) => liesWithin(destination, target, true));
  if (ruledOut) exclude({ code: 'traveller_avoided', message: `You ruled out ${ruledOut.name}.` });
  if (destination.advisory && destination.advisory.level >= ADVISORY_EXCLUDES) {
    exclude({ code: 'advisory', message: `${destination.advisory.source} advises against all travel there (as of ${destination.advisory.asOf}).` });
  }

  const add = (id: FactorId, measure: FactorMeasure, scale = 1) => {
    factors.push({ id, weight: FACTOR_WEIGHTS[id] * (profile.emphasis[id] ?? 1) * scale, measure });
  };

  const season = seasonMeasure(destination, profile);
  exclude(season.exclusion);
  /* The experiences are read in the months that are actually good, so a beach is judged on its swimming season inside the window. */
  const goodMonths = season.best.length > 0 ? season.best : months;
  const experience = experienceMeasure(destination, profile, goodMonths);
  add('experience', experience.measure);
  /*
   * Somebody who named their dates cannot move them, so when the place is good
   * is worth more to them than to somebody choosing a month — twice the weight.
   */
  add('season', season.measure, profile.months && !profile.monthsFlexible ? 2 : 1);
  add('climate', climateMeasure(destination, profile, goodMonths));
  const duration = durationMeasure(destination, profile);
  exclude(duration.exclusion);
  add('duration', duration.measure);
  add('budget', budgetMeasure(destination, profile));
  exclude(budgetExclusion(destination, profile));
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
  const similar = similarMeasure(destination, profile, context.similarTarget ? asDestination(context.similarTarget) : null);
  if (similar) add('similar', similar);

  /*
   * A relevance floor on what they came for. A place that does none of it is not
   * a weak match, it is the wrong answer — and without this a perfect season and
   * budget could carry it onto the list.
   */
  if (experience.measure.kind === 'measured' && experience.measure.value < 0.25 && profile.interests.length > 0) {
    /*
     * Judged on what the place offers in its own best season, not in the
     * traveller's window: a beach in a cold-sea month is a poor time for a good
     * answer, which the season factor already says — it is not the wrong answer.
     */
    const atItsBest = experienceMeasure(destination, profile, ALL_MONTHS).measure;
    if (atItsBest.kind === 'measured' && atItsBest.value < 0.25) exclude({ code: 'nothing_you_asked_for', message: `${destination.name} isn't strong on what you asked for.` });
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

  /*
   * Is there a trip here at all? A place with little written about it, few
   * places to sleep and nothing listed to do may match every preference on
   * paper and still not carry several days. `substance` scales the score — at
   * most fifteen percent, so it settles close calls toward the place that is
   * demonstrably a destination and never lets fame outrank fit.
   */
  const substance = destination.origin === 'editorial' ? 1 : 0.85 + 0.15 * clamp01(destination.substance);

  return {
    destination,
    score: measuredWeight > 0 ? (total / measuredWeight) * substance : 0,
    coverage: nominal > 0 ? measuredWeight / nominal : 0,
    factors,
    interestFit: experience.fit,
    bestMonths: season.best,
    seasonMonths: season.all,
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
