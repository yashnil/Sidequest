import type { Avoidance } from '../schemas/common';
import {
  WEATHER_CONDITION_LABELS,
  type DayWeather,
  type ForecastDayWeather,
  type HistoricalPatternDayWeather,
  type HourlyWeather,
  type PlaceWeatherProfile,
  type SolarDay,
  type WeatherCondition,
} from '../schemas/weather';

/**
 * THE ONE PLACE A PLACE IS JUDGED AGAINST A DAY.
 *
 * Every weather threshold in Sidequest is in this file. Not because tidiness is
 * a virtue in itself, but because the alternative is what the codebase already
 * demonstrated with opening hours before they were centralised: three stages
 * each doing their own comparison, and eventually disagreeing about whether an
 * endpoint counts. A UI component that decides 60% cloud is "poor visibility"
 * while the planner uses 80% produces a card that contradicts the plan it
 * generated.
 *
 * WHAT THIS DOES NOT DO
 *
 * It does not close anything. Wind does not shut the gondola here; the operator
 * shuts the gondola, and Sidequest has no feed telling it whether they have.
 * Inferring a closure from a forecast would put "closed" on a screen on the
 * strength of a number that is wrong about a third of the time at four days out,
 * and a traveller who cancelled a booking on that basis would have been misled
 * by us rather than by the weather.
 *
 * So almost everything here grades preference: given two days that are both
 * already legal — reachable, open, within the travel budget — which one should
 * the exposed ridge walk go on? Only two situations are hard, and both are a
 * typed requirement of the place being directly contradicted rather than a guess
 * about somebody else's operational decision. They are named at
 * `INCOMPATIBLE_REASONS` below.
 */

export const WEATHER_SUITABILITIES = [
  /** Actively good for this place. Worth moving things to get. */
  'favorable',
  /** Fine. Nothing here argues against the day. */
  'workable',
  /** Doable, and worse than it could be. Prefer another day; caution if not. */
  'poor',
  /** A typed requirement of the place is contradicted. Two cases only. */
  'incompatible',
  /** No evidence. Never a synonym for "fine". */
  'unknown',
] as const;
export type WeatherSuitability = (typeof WEATHER_SUITABILITIES)[number];

export const WEATHER_SUITABILITY_LABELS: Record<WeatherSuitability, string> = {
  favorable: 'Good weather for this',
  workable: 'Weather looks workable',
  poor: 'Weather works against this',
  incompatible: 'Not usable in this weather',
  unknown: 'No weather data',
};

/**
 * Machine-readable reasons. The UI turns these into sentences and the validator
 * matches on them, so neither has to parse prose.
 */
export const WEATHER_REASON_CODES = [
  'heavy_precipitation',
  'some_precipitation',
  'snowfall',
  'strong_wind',
  'severe_wind',
  'thunderstorms',
  'extreme_heat',
  'warm',
  'extreme_cold',
  'cold',
  'poor_visibility',
  'clear_visibility',
  'dry_and_settled',
  'traveller_avoids_heat',
  'traveller_avoids_cold',
  /**
   * Soft: the road in is worse when it is wet. A comfort and difficulty
   * warning, never a closure — see `placeWeatherProfileSchema`.
   */
  'rough_approach_when_wet',
  /** Hard: an operator says in print that wet ground closes it. */
  'dry_conditions_required',
  /** Hard: signed for daylight use and there is not enough light. */
  'outside_daylight',
  'sheltered_from_it',
  'no_evidence',
  'pattern_only',
] as const;
export type WeatherReasonCode = (typeof WEATHER_REASON_CODES)[number];

/**
 * The only two codes that may ever produce `incompatible`, and why it is these.
 *
 * Both are somebody else's published statement of fact, not our reading of a
 * number. `dry_conditions_required` is an operator saying wet ground closes the
 * place; `outside_daylight` is the sun. Neither is an inference from a forecast,
 * which is the line this list exists to hold.
 *
 * `rough_approach_when_wet` used to be here and was wrong to be. The field
 * behind it says the approach *degrades* — and every Eastern Sierra record
 * carrying it is sourced to "can be rough" or "fine for a normal car when dry".
 * That is a warning to a traveller, not grounds for us to delete their choice.
 */
export const INCOMPATIBLE_REASONS: readonly WeatherReasonCode[] = [
  'dry_conditions_required',
  'outside_daylight',
];

export interface WeatherReason {
  code: WeatherReasonCode;
  /** One clause, lower-case, joinable into a sentence. */
  text: string;
  /** Negative hurts, positive helps. Summed into the score. */
  weight: number;
}

export interface WeatherAssessment {
  suitability: WeatherSuitability;
  /**
   * 0–1, higher is better. Only meaningful between two `forecast` days at the
   * same place: it is a preference ordering, not a measurement of anything.
   */
  score: number;
  reasons: WeatherReason[];
  /** One sentence for a card or a timeline row. Never more. */
  summary: string;
  /**
   * Whether this evidence may be used to say one date is better than another.
   * False for historical patterns and for missing data — the two cases where a
   * comparison would be describing the calendar rather than the weather.
   */
  rankable: boolean;
  evidence: DayWeather['kind'];
}

/**
 * Every threshold, in one object, with the reasoning attached.
 *
 * These are judgement calls and they are written down so they can be argued
 * with. None of them is derived from anything; pretending otherwise by burying
 * them in expressions is how a product ends up unable to explain its own
 * behaviour.
 */
export const WEATHER_THRESHOLDS = {
  /** mm over the day. Above this you are wet through whatever you are wearing. */
  heavyPrecipitationMm: 8,
  /** mm over the day. Enough to notice and to want a hood. */
  somePrecipitationMm: 2,
  /** Percent. Providers hedge below this, so treating it as rain overreacts. */
  likelyPrecipitationPercent: 60,
  possiblePrecipitationPercent: 35,
  /** cm of fresh snow. Below this it is scenery; above it, it is underfoot. */
  snowfallCm: 2,
  /** kph gusts. Unpleasant on a ridge, and where lifts start watching. */
  strongGustKph: 55,
  /** kph gusts. Standing up is work; exposed ground is a bad idea. */
  severeGustKph: 75,
  /** °C daily max. Hot enough that shade and water stop being optional. */
  hotC: 30,
  /** °C daily max. The Owens Valley in July. Genuinely dangerous on foot. */
  extremeHeatC: 35,
  /** °C daily max. Cold enough that a long stop outdoors needs real layers. */
  coldC: 3,
  /** °C daily max. Below this an unsheltered afternoon is not a good day out. */
  extremeColdC: -6,
  /** Percent mean cloud. Above this a view is a rumour. */
  obscuredCloudPercent: 80,
  /** Percent mean cloud. Below this the long views are actually there. */
  clearCloudPercent: 30,
  /**
   * The difference in score below which two days are the same day.
   *
   * Without it, a plan reshuffles because one day's precipitation probability is
   * 19% and another's is 21% — churn that destroys the geographic coherence the
   * clustering worked for, in exchange for nothing a traveller could perceive.
   * Set so that it takes a genuine change of category (settled to showery, clear
   * to overcast) to move a stop.
   */
  meaningfulDifference: 0.15,
} as const;

export interface EvaluateWeatherInput {
  profile: PlaceWeatherProfile;
  day: DayWeather;
  /** Sunrise and sunset for the place's zone, when known. */
  solar?: SolarDay;
  /** Officially signed for daylight use only. From the operating calendar. */
  daylightOnly?: boolean;
  /** Minutes the visit takes, for the daylight test. */
  durationMinutes?: number;
  avoidances?: readonly Avoidance[];
}

/**
 * Judge one place against one day.
 *
 * Pure, total, and deterministic: the same inputs always produce the same
 * assessment, including the order of `reasons`, because the planner sorts on
 * this and a plan that reshuffles between identical runs is not a plan.
 */
export function evaluateWeather(input: EvaluateWeatherInput): WeatherAssessment {
  const { day } = input;
  if (day.kind === 'unavailable') {
    return {
      suitability: 'unknown',
      score: 0.5,
      reasons: [
        { code: 'no_evidence', text: 'we could not get weather for this date', weight: 0 },
      ],
      summary: 'No weather data for this date, so nothing here has been checked against it.',
      rankable: false,
      evidence: 'unavailable',
    };
  }

  const reasons =
    day.kind === 'forecast'
      ? forecastReasons(day, input)
      : historicalReasons(day, input);

  const daylight = daylightReason(input);
  if (daylight) reasons.push(daylight);

  const hard = reasons.filter((reason) => INCOMPATIBLE_REASONS.includes(reason.code));
  const score = clamp(
    0.6 + reasons.reduce((sum, reason) => sum + reason.weight, 0),
  );

  const suitability: WeatherSuitability = hard.length > 0
    ? 'incompatible'
    : score >= 0.75
      ? 'favorable'
      : score >= 0.45
        ? 'workable'
        : 'poor';

  return {
    suitability,
    score,
    reasons: [...reasons].sort(
      (a, b) => a.weight - b.weight || a.code.localeCompare(b.code),
    ),
    summary: summarise(suitability, reasons, day),
    // A pattern describes a fortnight of past Augusts. It cannot rank two days
    // inside that fortnight against each other, because it holds the same
    // numbers for both.
    rankable: day.kind === 'forecast',
    evidence: day.kind,
  };
}

function forecastReasons(
  day: ForecastDayWeather,
  input: EvaluateWeatherInput,
): WeatherReason[] {
  const { profile, avoidances = [] } = input;
  const reasons: WeatherReason[] = [];
  const t = WEATHER_THRESHOLDS;

  const sheltered = profile.exposure === 'indoor' || profile.exposure === 'sheltered_outdoor';
  const shelterRelief = profile.exposure === 'indoor' ? 1 : 0.5;
  const sensitivityWeight = (level: PlaceWeatherProfile['precipitation']) =>
    level === 'high' ? 1 : level === 'moderate' ? 0.6 : 0.25;

  // --- Precipitation ------------------------------------------------------
  const probability = day.precipitationProbabilityPercent;
  const heavy =
    day.precipitationMm >= t.heavyPrecipitationMm ||
    (probability !== null && probability >= t.likelyPrecipitationPercent && day.precipitationMm >= t.somePrecipitationMm);
  const some =
    !heavy &&
    (day.precipitationMm >= t.somePrecipitationMm ||
      (probability !== null && probability >= t.possiblePrecipitationPercent));

  if (heavy) {
    reasons.push({
      code: 'heavy_precipitation',
      text: `${Math.round(day.precipitationMm)} mm of rain forecast`,
      weight: -0.45 * sensitivityWeight(profile.precipitation) * (1 - shelterRelief * (sheltered ? 1 : 0)),
    });
  } else if (some) {
    reasons.push({
      code: 'some_precipitation',
      text:
        probability !== null
          ? `a ${probability}% chance of rain`
          : 'showers forecast',
      weight: -0.2 * sensitivityWeight(profile.precipitation) * (sheltered ? 0.4 : 1),
    });
  }

  if (day.snowfallCm >= t.snowfallCm) {
    reasons.push({
      code: 'snowfall',
      text: `${Math.round(day.snowfallCm)} cm of snow forecast`,
      weight: -0.4 * sensitivityWeight(profile.cold) * (sheltered ? 0.4 : 1),
    });
  }

  /**
   * The road rather than the place — and a caution rather than a verdict.
   *
   * Kept separate from the activity's own sensitivity because a soak in falling
   * snow is lovely right up until the track out is mud, and the traveller needs
   * to know which half is the problem. Weighted heavily enough to lose a
   * tie-break and to earn a visible caution; nowhere near enough, on its own, to
   * take the place off the plan.
   */
  if (profile.approachDegradesWhenWet && (heavy || day.snowfallCm >= t.snowfallCm)) {
    reasons.push({
      code: 'rough_approach_when_wet',
      text: 'the unsurfaced approach will be rougher going after this much rain',
      weight: -0.35,
    });
  }

  /**
   * The one weather fact that removes a place from a plan.
   *
   * Guarded three ways and every guard matters. It fires only on `forecast`
   * evidence, so a seasonal average can never produce it. It requires a record
   * that could not exist without an official source, because the schema will not
   * validate one otherwise. And it needs real precipitation on the day, not a
   * probability — a 70% chance of rain is not an operator closing a gate, and
   * presenting it as one would be us putting words in their mouth.
   */
  if (profile.dryConditionsRequired && (heavy || day.snowfallCm >= t.snowfallCm)) {
    reasons.push({
      code: 'dry_conditions_required',
      text: profile.dryConditionsRequired.reason,
      weight: -1,
    });
  }

  // --- Wind ---------------------------------------------------------------
  if (day.windGustMaxKph >= t.severeGustKph) {
    reasons.push({
      code: 'severe_wind',
      text: `gusts to ${Math.round(day.windGustMaxKph)} kph`,
      weight: -0.4 * sensitivityWeight(profile.wind) * (sheltered ? 0.3 : 1),
    });
  } else if (day.windGustMaxKph >= t.strongGustKph) {
    reasons.push({
      code: 'strong_wind',
      text: `gusts to ${Math.round(day.windGustMaxKph)} kph`,
      weight: -0.2 * sensitivityWeight(profile.wind) * (sheltered ? 0.3 : 1),
    });
  }

  if (day.condition === 'thunderstorm') {
    reasons.push({
      code: 'thunderstorms',
      text: 'thunderstorms forecast',
      weight: profile.exposure === 'exposed_outdoor' ? -0.4 : sheltered ? -0.1 : -0.25,
    });
  }

  // --- Temperature --------------------------------------------------------
  const high = day.apparentTemperatureMaxC ?? day.temperatureMaxC;
  if (high >= t.extremeHeatC) {
    reasons.push({
      code: 'extreme_heat',
      text: `${Math.round(high)} °C at the hottest part of the day`,
      weight: -0.45 * sensitivityWeight(profile.heat) * (profile.exposure === 'indoor' ? 0.2 : 1),
    });
  } else if (high >= t.hotC) {
    reasons.push({
      code: 'warm',
      text: `${Math.round(high)} °C`,
      weight: -0.15 * sensitivityWeight(profile.heat) * (profile.exposure === 'indoor' ? 0.2 : 1),
    });
  }
  if (day.temperatureMaxC <= t.extremeColdC) {
    reasons.push({
      code: 'extreme_cold',
      text: `${Math.round(day.temperatureMaxC)} °C at best`,
      weight: -0.4 * sensitivityWeight(profile.cold) * (profile.exposure === 'indoor' ? 0.2 : 1),
    });
  } else if (day.temperatureMaxC <= t.coldC) {
    reasons.push({
      code: 'cold',
      text: `${Math.round(day.temperatureMaxC)} °C at best`,
      weight: -0.15 * sensitivityWeight(profile.cold) * (profile.exposure === 'indoor' ? 0.2 : 1),
    });
  }

  // The traveller's own stated limits, which are not the same as the place's.
  // Somebody who said "not in extreme heat" is telling us about themselves, and
  // it applies even at a place that copes with heat perfectly well.
  if (avoidances.includes('extreme_heat') && high >= t.hotC && profile.exposure !== 'indoor') {
    reasons.push({
      code: 'traveller_avoids_heat',
      text: 'you asked us to keep you out of extreme heat',
      weight: high >= t.extremeHeatC ? -0.35 : -0.15,
    });
  }
  if (
    avoidances.includes('extreme_cold') &&
    day.temperatureMaxC <= t.coldC &&
    profile.exposure !== 'indoor'
  ) {
    reasons.push({
      code: 'traveller_avoids_cold',
      text: 'you asked us to keep you out of extreme cold',
      weight: day.temperatureMaxC <= t.extremeColdC ? -0.35 : -0.15,
    });
  }

  // --- Visibility ---------------------------------------------------------
  const cloud = day.cloudCoverMeanPercent;
  if (profile.visibilityDependent) {
    if (day.condition === 'fog' || (cloud !== null && cloud >= t.obscuredCloudPercent)) {
      reasons.push({
        code: 'poor_visibility',
        text: 'the long views are likely to be shut in',
        weight: -0.4,
      });
    } else if (cloud !== null && cloud <= t.clearCloudPercent) {
      reasons.push({
        code: 'clear_visibility',
        text: 'clear enough for the view this place is here for',
        weight: 0.25,
      });
    }
  }

  if (!heavy && !some && day.snowfallCm < t.snowfallCm && day.windGustMaxKph < t.strongGustKph) {
    reasons.push({ code: 'dry_and_settled', text: 'dry and settled', weight: 0.12 });
  }

  if (sheltered && (heavy || some || day.snowfallCm >= t.snowfallCm)) {
    reasons.push({
      code: 'sheltered_from_it',
      text:
        profile.exposure === 'indoor'
          ? 'you are indoors for it'
          : 'sheltered enough to sit the weather out',
      weight: 0.15,
    });
  }

  return reasons;
}

/**
 * A pattern says what this fortnight usually does. That is worth knowing and it
 * is worth preparing for, and it is not worth reordering a trip over — so the
 * weights here are deliberately small and `rankable` is false either way.
 */
function historicalReasons(
  day: HistoricalPatternDayWeather,
  input: EvaluateWeatherInput,
): WeatherReason[] {
  const { profile, avoidances = [] } = input;
  /**
   * Shelter counts here just as much as it does against a forecast.
   *
   * The first version of this branch ignored exposure entirely, so a wet season
   * scored an indoor museum exactly as badly as an exposed ridge — which made
   * every place in the region equally "at risk" in November and left the board
   * with nothing to suggest as a fallback. A season being wet is a reason to
   * plan around it; it is not a reason to think being indoors stops helping.
   */
  const sheltered = profile.exposure === 'indoor' || profile.exposure === 'sheltered_outdoor';
  const shelter = profile.exposure === 'indoor' ? 0.15 : sheltered ? 0.5 : 1;
  const reasons: WeatherReason[] = [
    {
      code: 'pattern_only',
      text: `typical for ${day.bandStart.replace('-', '/')}–${day.bandEnd.replace('-', '/')} across ${day.sampleYearFrom}–${day.sampleYearTo}`,
      weight: 0,
    },
  ];
  const t = WEATHER_THRESHOLDS;

  if (day.wetDayFrequency >= 0.3) {
    reasons.push({
      code: 'some_precipitation',
      text: `${Math.round(day.wetDayFrequency * 100)}% of days in this period have been wet`,
      weight: (profile.precipitation === 'high' ? -0.2 : -0.1) * shelter,
    });
  }
  if (day.snowDayFrequency >= 0.2) {
    reasons.push({
      code: 'snowfall',
      text: `${Math.round(day.snowDayFrequency * 100)}% of days in this period have seen snow`,
      weight: (profile.cold === 'high' ? -0.2 : -0.1) * shelter,
    });
  }
  if (sheltered && (day.wetDayFrequency >= 0.3 || day.snowDayFrequency >= 0.2)) {
    reasons.push({
      code: 'sheltered_from_it',
      text:
        profile.exposure === 'indoor'
          ? 'you are indoors for it'
          : 'sheltered enough to sit the weather out',
      weight: 0.12,
    });
  }
  if (day.temperatureMaxC.p50 >= t.extremeHeatC) {
    reasons.push({
      code: 'extreme_heat',
      text: `typically around ${Math.round(day.temperatureMaxC.p50)} °C here at this time of year`,
      weight: profile.heat === 'high' ? -0.3 : profile.heat === 'moderate' ? -0.15 : -0.05,
    });
    if (avoidances.includes('extreme_heat') && profile.exposure !== 'indoor') {
      reasons.push({
        code: 'traveller_avoids_heat',
        text: 'you asked us to keep you out of extreme heat',
        weight: -0.2,
      });
    }
  }
  if (day.temperatureMaxC.p50 <= t.coldC) {
    reasons.push({
      code: 'cold',
      text: `typically around ${Math.round(day.temperatureMaxC.p50)} °C here at this time of year`,
      weight: profile.cold === 'high' ? -0.25 : -0.1,
    });
    if (avoidances.includes('extreme_cold') && profile.exposure !== 'indoor') {
      reasons.push({
        code: 'traveller_avoids_cold',
        text: 'you asked us to keep you out of extreme cold',
        weight: -0.2,
      });
    }
  }
  if (day.windGustKphP90 >= t.severeGustKph && profile.wind === 'high') {
    reasons.push({
      code: 'strong_wind',
      text: `the windiest days here reach ${Math.round(day.windGustKphP90)} kph`,
      weight: -0.1,
    });
  }

  return reasons;
}

/**
 * The daylight test. A hard one, and the only one in this file that rests on a
 * fact rather than a prediction.
 *
 * A visit that cannot finish before the light goes is not a visit somebody
 * should be sent on, so this returns an incompatibility rather than a caution.
 * It fires only for places whose operator has actually signed them that way —
 * two, in this region — and only when there is a real sunrise and sunset to
 * check against. With no solar record it returns nothing at all, because
 * "we did not work out the light" must never read as "there is not enough".
 */
function daylightReason(input: EvaluateWeatherInput): WeatherReason | null {
  if (!input.daylightOnly || !input.solar) return null;
  const duration = input.durationMinutes ?? 0;
  const usable = input.solar.sunsetMinute - input.solar.sunriseMinute;
  if (usable >= duration) return null;
  return {
    code: 'outside_daylight',
    text: `there are only ${Math.round(usable / 60)} hours of daylight, and this needs ${Math.round(duration / 60)}`,
    weight: -1,
  };
}

/**
 * The sentence, and the three registers it has to keep apart.
 *
 * A traveller reading these has to be able to tell, without thinking about it,
 * which of three quite different things is being said:
 *
 *   - **reduced comfort** — go, and expect the drive to be less pleasant;
 *   - **poor conditions** — go if you want to, and know it will not be the day
 *     this place is at its best;
 *   - **genuine incompatibility** — this cannot be done, and here is who says so.
 *
 * Collapsing the first two into the third is how a product ends up deleting
 * somebody's plans over a washboard road, so the first branch below is a comfort
 * warning that deliberately reads as one.
 */
function summarise(
  suitability: WeatherSuitability,
  reasons: readonly WeatherReason[],
  day: DayWeather,
): string {
  const worst = [...reasons]
    .filter((reason) => reason.weight < 0)
    .sort((a, b) => a.weight - b.weight)[0];
  const best = [...reasons]
    .filter((reason) => reason.weight > 0)
    .sort((a, b) => b.weight - a.weight)[0];

  if (suitability === 'incompatible' && worst) {
    // Names the source, because this is the one verdict that removes something.
    return `Not usable on this day: ${worst.text}`;
  }
  if (suitability === 'poor' && worst) {
    return worst.code === 'rough_approach_when_wet'
      ? `Still doable, but ${worst.text}.`
      : `Working against it: ${worst.text}.`;
  }
  if (suitability === 'favorable') {
    return best ? `Good conditions for this — ${best.text}.` : 'Good conditions for this.';
  }
  if (worst) return `Workable, though ${worst.text}.`;
  return day.kind === 'forecast'
    ? `${WEATHER_CONDITION_LABELS[day.condition]}, and nothing that argues against this.`
    : 'Nothing in the seasonal pattern argues against this.';
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, Math.round(value * 1000) / 1000));
}

/**
 * How much the weather costs a visit placed at a particular time.
 *
 * Null when there is no hourly evidence, which is the answer that matters most:
 * beyond the forecast horizon, and for any provider that returns daily values
 * only, there is nothing to time anything against and the caller must leave the
 * day exactly as the other constraints made it. Inventing an intra-day shape
 * from a daily average would be fabricating the very thing the number claims to
 * measure.
 */
export function weatherPenaltyAt(input: {
  day: DayWeather;
  profile: PlaceWeatherProfile;
  startMinute: number;
  durationMinutes: number;
}): number | null {
  const { day, profile } = input;
  if (day.kind !== 'forecast' || day.hours.length === 0) return null;
  const covered = day.hours.filter(
    (hour) =>
      hour.startMinute + 60 > input.startMinute &&
      hour.startMinute < input.startMinute + input.durationMinutes,
  );
  if (covered.length === 0) return null;
  return (
    covered.reduce((sum, hour) => sum + hourPenalty(hour, profile), 0) / covered.length
  );
}

function hourPenalty(hour: HourlyWeather, profile: PlaceWeatherProfile): number {
  const t = WEATHER_THRESHOLDS;
  const weight = (level: PlaceWeatherProfile['precipitation']) =>
    level === 'high' ? 1 : level === 'moderate' ? 0.6 : 0.25;
  const sheltered = profile.exposure === 'indoor' || profile.exposure === 'sheltered_outdoor';
  const shelter = sheltered ? 0.35 : 1;

  let penalty = 0;
  penalty += Math.min(hour.precipitationMm, 10) * 0.35 * weight(profile.precipitation) * shelter;
  penalty += Math.min(hour.snowfallCm, 10) * 0.35 * weight(profile.cold) * shelter;
  if (hour.precipitationProbabilityPercent !== null) {
    penalty += (hour.precipitationProbabilityPercent / 100) * 0.8 * weight(profile.precipitation) * shelter;
  }
  if (hour.windGustKph >= t.strongGustKph) {
    penalty += ((hour.windGustKph - t.strongGustKph) / 40) * weight(profile.wind) * shelter;
  }
  if (isStormy(hour.condition)) penalty += profile.exposure === 'exposed_outdoor' ? 1.2 : 0.5;
  if (profile.visibilityDependent && hour.cloudCoverPercent !== null) {
    penalty += (hour.cloudCoverPercent / 100) * 0.6;
  }
  if (profile.heat !== 'low' && hour.temperatureC >= t.hotC) {
    penalty += ((hour.temperatureC - t.hotC) / 10) * weight(profile.heat);
  }
  if (profile.cold !== 'low' && hour.temperatureC <= t.coldC) {
    penalty += ((t.coldC - hour.temperatureC) / 10) * weight(profile.cold);
  }
  return penalty;
}

function isStormy(condition: WeatherCondition): boolean {
  return condition === 'thunderstorm';
}

/**
 * Whether one place genuinely copes better than another with *this* weather.
 *
 * The single definition, shared by the planner's day-level fallback selection
 * and the Discovery Board's trip-level backup section. They ask the same
 * question at different moments — "somewhere else to go on Thursday" and
 * "somewhere else to have in reserve" — and answering it twice is how a card
 * offers a backup the planner would refuse.
 *
 * The test is per-axis, not general. A museum is a poor answer to a heat warning
 * if the drive to it crosses the valley floor; a sheltered forest walk is a fine
 * answer to wind and a bad one to snow. Whatever failed has to be the thing that
 * is better here.
 */
export function isLessWeatherSensitive(input: {
  profile: PlaceWeatherProfile;
  riskReasonCodes: readonly WeatherReasonCode[];
  /** The candidate's own score for the day, when there is one to compare. */
  ownScore?: number;
  riskScore?: number;
}): boolean {
  const { profile } = input;
  const codes = new Set(input.riskReasonCodes);

  if (
    (codes.has('rough_approach_when_wet') || codes.has('dry_conditions_required')) &&
    (profile.approachDegradesWhenWet || profile.dryConditionsRequired)
  ) {
    return false;
  }
  if (
    (codes.has('heavy_precipitation') || codes.has('some_precipitation')) &&
    profile.precipitation !== 'low'
  ) {
    return false;
  }
  if ((codes.has('severe_wind') || codes.has('strong_wind')) && profile.wind === 'high') return false;
  if (codes.has('snowfall') && profile.cold === 'high') return false;
  if ((codes.has('extreme_heat') || codes.has('traveller_avoids_heat')) && profile.heat === 'high') {
    return false;
  }
  if ((codes.has('extreme_cold') || codes.has('traveller_avoids_cold')) && profile.cold === 'high') {
    return false;
  }
  if (codes.has('poor_visibility') && profile.visibilityDependent) return false;
  if (codes.has('thunderstorms') && profile.exposure === 'exposed_outdoor') return false;

  if (
    input.ownScore !== undefined &&
    input.riskScore !== undefined &&
    input.ownScore <= input.riskScore
  ) {
    return false;
  }

  return profile.poorWeatherBackup || profile.exposure === 'indoor';
}

/**
 * Whether moving something from one day to another is worth the disruption.
 *
 * Day assignment has already grouped places geographically; every move trades
 * some of that coherence for weather. This is the exchange rate, and it is
 * deliberately not free — a plan that reshuffles for a two-point change in
 * precipitation probability has spent a real thing on an imaginary one.
 */
export function isMeaningfullyBetter(candidate: number, incumbent: number): boolean {
  return candidate - incumbent >= WEATHER_THRESHOLDS.meaningfulDifference;
}
