import {
  CLIMATE_EVIDENCE_NOTE,
  seasonMonths,
  type ClimateNormal,
  type ClimateProfile,
} from '../schemas/climate';
import { monthName } from '../region/season';
import type { TripComposerAnswers, TripTheme } from '../schemas/composer';

/**
 * WHEN TO GO, FROM EVIDENCE RATHER THAN FROM FOLKLORE.
 *
 * Every sentence this module produces is derived from a number in a
 * `ClimateProfile` or from locally-computed daylight. There is no table of
 * "best months to visit X" anywhere in this codebase and there must never be
 * one: that is exactly the destination-specific authored content the
 * architecture forbids, and it is also the thing that would be wrong first.
 *
 * What it will not do:
 *
 * - call anything a forecast
 * - claim anything about crowds, prices, festivals or events, none of which we
 *   have sourced
 * - recommend a window when the profile is missing, rather than guessing
 *
 * The scoring is a transparent weighted sum over normalised sub-scores, in the
 * same shape as the place fit scorer, and for the same reason: a traveller can
 * be told *why* a window won, and a future learned ranker has a feature vector
 * waiting for it.
 */

export interface DateWindow {
  /** 1–12. Windows are month-grained because the evidence is. */
  month: number;
  year: number;
  label: string;
  /** 0–1, deterministic. */
  score: number;
  /** Why this window, in the product's register. Every clause is sourced. */
  reasons: string[];
  /** What is worse about it than the alternatives. Never omitted when present. */
  tradeoffs: string[];
  /** Things we could not establish, named rather than left out. */
  unknowns: string[];
  climate: {
    temperature: { low: number; high: number };
    daylightHours: number;
    wetDays: number;
    snowDays: number;
  };
  /** The sentence that must travel with any rendering of the numbers above. */
  evidenceNote: string;
}

export interface DateRecommendation {
  kind: 'recommended';
  windows: DateWindow[];
  sampleYearFrom: number;
  sampleYearTo: number;
  attribution: string;
  attributionUrl?: string;
}

export type DateGuidance =
  | DateRecommendation
  | {
      kind: 'unavailable';
      /** Rendered verbatim. Never replaced by a guess. */
      note: string;
    };

/**
 * The comfort band, in °C, for being outside all day.
 *
 * Chosen for the activity rather than for a person: below eight, an all-day
 * walk needs equipment most travellers do not pack; above twenty-eight, exposed
 * ground stops being pleasant regardless of preference. Traveller preference
 * then *shifts* this band rather than replacing it.
 */
const COMFORT_LOW = 8;
const COMFORT_HIGH = 28;

/** Themes whose enjoyment turns on being outdoors in daylight. */
const OUTDOOR_THEMES: readonly TripTheme[] = ['outdoors', 'mountains', 'water', 'wildlife'];
/** Themes largely indifferent to weather, which changes what a wet month costs. */
const INDOOR_THEMES: readonly TripTheme[] = ['food', 'culture', 'cities'];

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * How comfortable this month's typical daytime high is for the trip's shape.
 *
 * A traveller who said they hate heat moves the ceiling down; one whose themes
 * are museums and restaurants is far less sensitive to either end.
 */
export function temperatureScore(normal: ClimateNormal, answers?: TripComposerAnswers): number {
  const themes = answers?.themes ?? [];
  const indoorHeavy =
    themes.length > 0 && themes.every((theme) => INDOOR_THEMES.includes(theme));
  const low = COMFORT_LOW - (indoorHeavy ? 6 : 0);
  const high = COMFORT_HIGH + (indoorHeavy ? 4 : 0);

  const day = normal.temperature.high;
  if (day >= low && day <= high) return 1;
  const distance = day < low ? low - day : day - high;
  // Ten degrees outside the band is where a month stops being a candidate.
  return clamp01(1 - distance / 10);
}

export function drynessScore(normal: ClimateNormal, answers?: TripComposerAnswers): number {
  const themes = answers?.themes ?? [];
  const outdoorHeavy = themes.some((theme) => OUTDOOR_THEMES.includes(theme));
  const daysInMonth = 30;
  const wetShare = clamp01(normal.wetDays / daysInMonth);
  // Rain costs an outdoor trip roughly twice what it costs an indoor one.
  return clamp01(1 - wetShare * (outdoorHeavy ? 1.6 : 0.8));
}

/**
 * Daylight, which is the constraint nobody thinks about until they are stood at
 * a trailhead at three in the afternoon watching it get dark.
 *
 * Only rewarded up to fourteen hours: beyond that a longer day stops adding
 * anything a traveller can use, and rewarding it further would push every
 * recommendation to midsummer regardless of everything else.
 */
export function daylightScore(normal: ClimateNormal): number {
  return clamp01((normal.daylightHours - 8) / 6);
}

/** Snow: a cost for most trips, and the whole point of a few. */
export function snowScore(normal: ClimateNormal, answers?: TripComposerAnswers): number {
  const wantsSnow = answers?.themes.includes('mountains') && answers.outdoorIntensity === 'strenuous';
  const share = clamp01(normal.snowDays / 20);
  return wantsSnow ? 0.5 + share * 0.5 : clamp01(1 - share);
}

export function heatScore(normal: ClimateNormal): number {
  return clamp01(1 - normal.hotDays / 15);
}

export interface WindowFeatures {
  temperature: number;
  dryness: number;
  daylight: number;
  snow: number;
  heat: number;
}

export function windowFeatures(normal: ClimateNormal, answers?: TripComposerAnswers): WindowFeatures {
  return {
    temperature: temperatureScore(normal, answers),
    dryness: drynessScore(normal, answers),
    daylight: daylightScore(normal),
    snow: snowScore(normal, answers),
    heat: heatScore(normal),
  };
}

const WEIGHTS: Record<keyof WindowFeatures, number> = {
  temperature: 0.32,
  dryness: 0.24,
  daylight: 0.2,
  snow: 0.14,
  heat: 0.1,
};

/**
 * V6 §9 — EXPERIENCE-AWARE WEIGHTS.
 *
 * The month that is best for a trip depends on what the trip is for. A hiking
 * trip is decided by dry trails and daylight far more than by a pleasant
 * temperature; a snow trip by snow; a beach trip by warmth and the absence
 * of heat; a city and food trip by comfort and heat. The base weights stand
 * where nothing is known about the trip. Every reweighting is stated in the
 * reasons so the traveller can see what decided it.
 */
export function experienceWeights(answers?: TripComposerAnswers): { weights: Record<keyof WindowFeatures, number>; basis: string } {
  const themes = new Set<string>(answers?.themes ?? []);
  const strenuous = answers?.outdoorIntensity === 'strenuous';
  const w = { ...WEIGHTS };
  let basis = 'general comfort';
  const outdoors = themes.has('outdoors') || themes.has('mountains');
  if (outdoors) {
    w.dryness += 0.12;
    w.daylight += 0.1;
    w.temperature -= 0.12;
    w.heat -= 0.05;
    basis = 'trail conditions and daylight';
  }
  /* A strenuous mountain trip in the composer's vocabulary is the closest thing to "snow matters". */
  if (themes.has('mountains') && strenuous) {
    w.snow += 0.15;
    basis = 'snow and trail conditions';
  }
  if (themes.has('water')) {
    w.temperature += 0.1;
    w.heat += 0.05;
    w.dryness += 0.05;
    w.daylight -= 0.1;
    basis = outdoors ? basis : 'warm, dry weather for the water';
  }
  if (themes.has('food') || themes.has('cities') || themes.has('culture')) {
    w.heat += 0.1;
    w.dryness += 0.05;
    w.daylight -= 0.1;
    basis = outdoors ? basis : 'comfortable city weather';
  }
  if (themes.has('wildlife')) {
    w.dryness += 0.1;
    basis = outdoors ? basis : 'dry-season wildlife viewing';
  }
  const total = Object.values(w).reduce((a, b) => a + Math.max(0, b), 0);
  const normalised = Object.fromEntries(Object.entries(w).map(([k, v]) => [k, Math.max(0, v) / total])) as Record<keyof WindowFeatures, number>;
  return { weights: normalised, basis };
}

export function scoreWindow(features: WindowFeatures, answers?: TripComposerAnswers): number {
  const { weights } = experienceWeights(answers);
  let total = 0;
  for (const [key, weight] of Object.entries(weights) as [keyof WindowFeatures, number][]) {
    total += features[key] * weight;
  }
  return clamp01(total);
}

/**
 * The reasons and tradeoffs, each tied to the number that produced it.
 *
 * Written as separate lists rather than one paragraph because a tradeoff that
 * gets buried mid-sentence is a tradeoff nobody read — and because the product's
 * whole claim is that it tells you what is wrong with a plan as loudly as what
 * is right.
 */
function narrate(
  normal: ClimateNormal,
  features: WindowFeatures,
): { reasons: string[]; tradeoffs: string[] } {
  const reasons: string[] = [];
  const tradeoffs: string[] = [];

  if (features.temperature >= 0.85) {
    reasons.push(
      `Days typically reach ${Math.round(normal.temperature.high)}°C, which is comfortable for being outside.`,
    );
  } else if (normal.temperature.high < COMFORT_LOW) {
    tradeoffs.push(`Daytime highs around ${Math.round(normal.temperature.high)}°C — cold for long days outdoors.`);
  } else if (normal.temperature.high > COMFORT_HIGH) {
    tradeoffs.push(`Daytime highs around ${Math.round(normal.temperature.high)}°C — hot on exposed ground.`);
  }

  if (features.daylight >= 0.8) {
    reasons.push(`About ${normal.daylightHours.toFixed(1)} hours of daylight, so days can be long.`);
  } else if (normal.daylightHours < 10) {
    tradeoffs.push(`Only about ${normal.daylightHours.toFixed(1)} hours of daylight, which shortens every day.`);
  }

  if (normal.wetDays <= 6) {
    reasons.push(`Around ${Math.round(normal.wetDays)} wet days in the month historically.`);
  } else if (normal.wetDays >= 12) {
    tradeoffs.push(`Around ${Math.round(normal.wetDays)} wet days in the month historically.`);
  }

  if (normal.snowDays >= 3) {
    tradeoffs.push(
      `Snow on about ${Math.round(normal.snowDays)} days, which closes seasonal roads in some regions.`,
    );
  }
  if (normal.hotDays >= 8) {
    tradeoffs.push(`About ${Math.round(normal.hotDays)} days above 32°C.`);
  }
  if (normal.freezeDays >= 10) {
    tradeoffs.push(`Freezing overnight on about ${Math.round(normal.freezeDays)} nights.`);
  }

  return { reasons, tradeoffs };
}

/**
 * The unknowns, stated rather than omitted.
 *
 * Every one of these is a dimension a traveller would reasonably expect a "when
 * should I go" answer to cover, and not one of them is sourced. Saying so is the
 * difference between a partial answer and a misleading one.
 */
const STANDING_UNKNOWNS = [
  'How busy it is — we have no crowd data for this destination.',
  'Prices — nothing here is a claim about what anything costs.',
  'Festivals and closures — only what an official source publishes reaches a plan, and that happens after this step.',
];

export interface RecommendDatesInput {
  profile: ClimateProfile | null;
  /** Nights on the ground, when known. Only used to phrase, never to score. */
  nights?: number | null;
  answers?: TripComposerAnswers;
  /** Restrict to these months. Empty means all twelve. */
  onlyMonths?: readonly number[];
  /** The calendar year windows should be labelled with. */
  year: number;
  /** How many windows to return. */
  limit?: number;
  /** Injected so the same inputs always produce the same answer. */
  now: Date;
}

/**
 * Up to three month-grained windows, best first.
 *
 * Returns `unavailable` rather than a fallback ranking when there is no profile.
 * A recommendation with nothing behind it is the single most damaging thing this
 * module could produce, because it is indistinguishable on screen from one with
 * twenty years of records behind it.
 */
export function recommendDateWindows(input: RecommendDatesInput): DateGuidance {
  if (!input.profile) {
    return {
      kind: 'unavailable',
      note: 'We have no climate records for this destination yet, so we will not guess at the best time to go.',
    };
  }

  const allowed = new Set(
    input.onlyMonths && input.onlyMonths.length > 0 ? input.onlyMonths : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
  );

  /*
   * A window in the past is not a recommendation.
   *
   * Months already gone in the current year roll to the next one, so "February
   * is best" said in August means next February. Without this the top answer for
   * half the year is a date nobody can book.
   */
  const currentMonth = input.now.getUTCMonth() + 1;
  const currentYear = input.now.getUTCFullYear();

  const windows: DateWindow[] = [];
  for (const normal of input.profile.months) {
    if (!allowed.has(normal.month)) continue;
    const features = windowFeatures(normal, input.answers);
    const score = scoreWindow(features, input.answers);
    const { reasons, tradeoffs } = narrate(normal, features);
    const year = input.year > currentYear || normal.month >= currentMonth ? input.year : input.year + 1;

    windows.push({
      month: normal.month,
      year,
      label: `${monthName(normal.month)} ${year}`,
      score,
      reasons,
      tradeoffs,
      unknowns: [...STANDING_UNKNOWNS],
      climate: {
        temperature: { low: normal.temperature.low, high: normal.temperature.high },
        daylightHours: normal.daylightHours,
        wetDays: normal.wetDays,
        snowDays: normal.snowDays,
      },
      evidenceNote: CLIMATE_EVIDENCE_NOTE,
    });
  }

  windows.sort((a, b) => b.score - a.score || a.month - b.month);

  return {
    kind: 'recommended',
    windows: windows.slice(0, input.limit ?? 3),
    sampleYearFrom: input.profile.sampleYearFrom,
    sampleYearTo: input.profile.sampleYearTo,
    attribution: input.profile.attribution,
    ...(input.profile.attributionUrl ? { attributionUrl: input.profile.attributionUrl } : {}),
  };
}

/** The months a season covers where this destination is. */
export function monthsForSeason(season: string, profile: ClimateProfile | null): number[] {
  if (!profile) return [];
  return seasonMonths(season, profile.coordinates.lat);
}

/**
 * Concrete dates inside a recommended window.
 *
 * The fifteenth-centred span, clamped into the month. Deliberately arbitrary and
 * deliberately *stated* as such in the UI: the evidence is month-grained, so
 * picking a specific week would be precision the data does not carry. What this
 * is for is giving the traveller a start point they can then move.
 */
export function datesInWindow(
  window: { month: number; year: number },
  nights: number,
): { startDate: string; endDate: string } {
  const daysInMonth = new Date(Date.UTC(window.year, window.month, 0)).getUTCDate();
  const startDay = Math.max(1, Math.min(daysInMonth - nights, Math.round((daysInMonth - nights) / 2)));
  const start = new Date(Date.UTC(window.year, window.month - 1, startDay));
  const end = new Date(start.getTime() + nights * 86_400_000);
  return {
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
  };
}

// ---------------------------------------------------------------------------
// From a month-grained window to dates a traveller can book
// ---------------------------------------------------------------------------

/**
 * WHY A MONTH IS NOT AN ANSWER, AND WHAT TURNS IT INTO ONE.
 *
 * MVP V3, Stage 46. "Tell me when this place is at its best" has to come back
 * with something a person can act on — "late May to mid-June", with the reasons
 * — not with the word "June". The evidence is month-grained, so the only honest
 * way to place a window inside a month is to let the *neighbouring* months move
 * it: when the month after scores higher, the window sits late; when the month
 * before scores higher, it sits early; when they are level, it sits in the
 * middle. Every one of those is derived from the same climate normals that
 * produced the ranking, so the window never claims precision the evidence lacks.
 *
 * Deliberately not modelled: weekends, flight prices, school holidays, festivals
 * and crowds. None of them is sourced, and a window nudged by an unsourced guess
 * would be indistinguishable on screen from one nudged by twenty years of data.
 */
export interface ConcreteWindow {
  startDate: string;
  endDate: string;
  /** "Late May to mid-June". Reads as a period, because that is what it is. */
  label: string;
  month: number;
  year: number;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** early / mid / late, and the month it belongs to. The vocabulary a person uses for a date they have not fixed. */
export function describeDayPart(year: number, month: number, day: number): string {
  const total = daysInMonth(year, month);
  const part = day <= Math.round(total / 3) ? 'early' : day <= Math.round((total * 2) / 3) ? 'mid' : 'late';
  return `${part} ${monthName(month)}`;
}

/** "Late May to mid-June", collapsing to one phrase when both ends sit in the same part of the same month. */
export function describeWindow(startDate: string, endDate: string): string {
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  const from = describeDayPart(start.getUTCFullYear(), start.getUTCMonth() + 1, start.getUTCDate());
  const to = describeDayPart(end.getUTCFullYear(), end.getUTCMonth() + 1, end.getUTCDate());
  const phrase = from === to ? from : `${from} to ${to}`;
  return phrase.charAt(0).toUpperCase() + phrase.slice(1);
}

export interface ConcreteWindowInput {
  /** The ranked windows `recommendDateWindows` returned, best first. */
  windows: readonly DateWindow[];
  /** Which of them to place. Defaults to the best. */
  choose?: number;
  nights: number;
  /** Outer bounds the traveller is free between, when they gave any. */
  earliest?: string | null;
  latest?: string | null;
}

/**
 * Places one ranked window on the calendar.
 *
 * Returns null when there is nothing to place — which is the honest answer for a
 * destination with no climate records, and the caller must say so rather than
 * fall back to a date.
 */
export function concreteWindow(input: ConcreteWindowInput): ConcreteWindow | null {
  const chosen = input.windows[input.choose ?? 0];
  if (!chosen) return null;
  const nights = Math.max(1, Math.min(30, Math.round(input.nights)));
  const scoreOf = (month: number) => input.windows.find((w) => w.month === month)?.score ?? null;
  const before = scoreOf(chosen.month === 1 ? 12 : chosen.month - 1);
  const after = scoreOf(chosen.month === 12 ? 1 : chosen.month + 1);
  /*
   * A week of bias, which is as fine a distinction as month-grained evidence
   * can honestly support. Anything smaller would be arithmetic theatre.
   */
  const bias = before !== null && after !== null && Math.abs(after - before) > 0.02 ? (after > before ? 7 : -7) : 0;
  const total = daysInMonth(chosen.year, chosen.month);
  const centred = Math.round((total - nights) / 2) + 1;
  const startDay = Math.max(1, Math.min(total, centred + bias));
  let start = new Date(Date.UTC(chosen.year, chosen.month - 1, startDay));
  let end = new Date(start.getTime() + nights * 86_400_000);

  // The traveller's own bounds always win over the evidence's preferred placement.
  const floor = input.earliest ? new Date(`${input.earliest}T00:00:00Z`) : null;
  const ceiling = input.latest ? new Date(`${input.latest}T00:00:00Z`) : null;
  if (floor && start < floor) {
    start = floor;
    end = new Date(start.getTime() + nights * 86_400_000);
  }
  if (ceiling && end > ceiling) {
    end = ceiling;
    start = new Date(end.getTime() - nights * 86_400_000);
    if (floor && start < floor) start = floor;
  }

  return {
    startDate: iso(start),
    endDate: iso(end),
    label: describeWindow(iso(start), iso(end)),
    month: chosen.month,
    year: chosen.year,
  };
}

/** The months a traveller's free window spans, for restricting the ranking to them. */
export function monthsBetween(earliest: string, latest: string): number[] {
  const from = new Date(`${earliest}T00:00:00Z`);
  const to = new Date(`${latest}T00:00:00Z`);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to < from) return [];
  const months: number[] = [];
  const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
  while (cursor <= to && months.length < 24) {
    const month = cursor.getUTCMonth() + 1;
    if (!months.includes(month)) months.push(month);
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return months;
}
