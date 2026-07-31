import type { Avoidance } from '../schemas/common';
import type { Place } from '../schemas/place';
import {
  findDayWeather,
  findSolarDay,
  findWeatherLocationForPlace,
  WEATHER_EVIDENCE_LABELS,
  type DayWeather,
  type WeatherDataset,
  type WeatherEvidenceKind,
} from '../schemas/weather';
import {
  evaluateWeather,
  type WeatherReasonCode,
  type WeatherSuitability,
} from './conditions';

/**
 * WHAT A DISCOVERY-BOARD CARD SAYS ABOUT THE WEATHER.
 *
 * The board is where a traveller decides what to include, so the only weather
 * facts that belong here are the ones that would change that decision. Two
 * failure modes to avoid, and the second is the easy one to fall into:
 *
 * 1. Saying nothing, and letting somebody pick an 11,000 ft viewpoint for a week
 *    the forecast has shut in.
 * 2. Stamping a temperature on all twenty-three cards, at which point the three
 *    that matter are invisible. The opening-hours slice learned this the
 *    expensive way: `always_open` earns no badge precisely so `closed_on_your
 *    _dates` is impossible to miss.
 *
 * So a badge appears only where the weather argues for or against the place over
 * the traveller's actual dates, and the label always names which kind of
 * knowledge it rests on. A card may say "best on Tuesday" only when there is a
 * forecast for Tuesday; where there is only a seasonal pattern it says so, in
 * those words, because "typically wet in October" and "wet on the 14th" are
 * different claims and only one of them is ours to make.
 */

export const PLACE_WEATHER_BADGES = [
  /** A forecast day stands out for this place. Names the day. */
  'best_on_a_day',
  /** The forecast over these dates suits it. */
  'good_in_the_forecast',
  /** The forecast over these dates works against it. */
  'poor_in_the_forecast',
  /** Cloud would take the thing you came for. */
  'visibility_dependent',
  /** Worth having in reserve when something else is rained off. */
  'poor_weather_friendly',
  /** Sunrise to sunset, and now actually checked. */
  'daylight_only',
  /** Seasonal pattern only. Never a forecast. */
  'seasonal_pattern',
  /** We could not find out. */
  'weather_unknown',
] as const;
export type PlaceWeatherBadge = (typeof PLACE_WEATHER_BADGES)[number];

export const PLACE_WEATHER_BADGE_LABELS: Record<PlaceWeatherBadge, string> = {
  best_on_a_day: 'Best on',
  good_in_the_forecast: 'Good in the forecast',
  poor_in_the_forecast: 'Weather works against it',
  visibility_dependent: 'Needs a clear day',
  poor_weather_friendly: 'Bad-weather option',
  daylight_only: 'Daylight only',
  seasonal_pattern: 'Seasonal pattern',
  weather_unknown: 'No weather data',
};

export interface PlaceWeatherAssessment {
  /** The mixture of evidence across the trip's dates. */
  evidence: WeatherEvidenceKind[];
  /** One word for the mixture: Forecast, Historical pattern, Mixed, or none. */
  evidenceLabel: string;
  badges: PlaceWeatherBadge[];
  /** The best forecast date for this place, when a forecast can say. */
  bestDate: string | null;
  /** The worst, when it is worth warning about. */
  worstDate: string | null;
  /** One sentence for the card. Empty when there is nothing worth saying. */
  note: string | null;
  /** Which point the numbers came from, and what it cannot speak for. */
  locationLabel: string | null;
  locationLimitation: string | null;
  /** The attribution line the provider requires wherever its data appears. */
  attribution: string | null;
  /** When the forecast was read. Absent on other evidence. */
  fetchedAt: string | null;
  /** Worst suitability across the trip's dates. Drives the tone of the badge. */
  worst: WeatherSuitability;
  /**
   * *Best* suitability across the trip's dates — which is what decides whether
   * the place is genuinely in trouble.
   *
   * A stop with one wet day out of four is not at risk: the planner will move it
   * to one of the other three, and that is the entire point of the day-assignment
   * layer. Only a place with no good day anywhere in the trip needs somewhere
   * else held in reserve.
   */
  best: WeatherSuitability;
  /**
   * Every distinct thing working against this place across the trip's dates.
   *
   * Machine-readable, so the derived backup section can ask "less sensitive to
   * *what*" without re-deriving anything, and so it uses the same rule the
   * planner does rather than a second copy of it.
   */
  riskReasonCodes: WeatherReasonCode[];
}

export interface AssessPlaceWeatherInput {
  place: Place;
  dataset: WeatherDataset | undefined;
  dates: readonly string[];
  avoidances: readonly Avoidance[];
  daylightOnly: boolean;
}

const NOTHING: PlaceWeatherAssessment = {
  evidence: [],
  evidenceLabel: '',
  badges: [],
  bestDate: null,
  worstDate: null,
  note: null,
  locationLabel: null,
  locationLimitation: null,
  attribution: null,
  fetchedAt: null,
  worst: 'unknown',
  best: 'unknown',
  riskReasonCodes: [],
};

export function assessPlaceWeather(input: AssessPlaceWeatherInput): PlaceWeatherAssessment {
  const { place, dataset, dates } = input;
  if (!dataset || dates.length === 0) {
    return {
      ...NOTHING,
      badges: input.daylightOnly ? ['daylight_only'] : [],
    };
  }

  const location = findWeatherLocationForPlace(dataset, place.id);
  if (!location) return { ...NOTHING, badges: input.daylightOnly ? ['daylight_only'] : [] };

  const perDay = dates.map((date) => {
    const evidence: DayWeather =
      findDayWeather(dataset, location.id, date) ?? {
        kind: 'unavailable',
        locationId: location.id,
        date,
        reason: 'provider_error',
        message: 'No weather record was returned for this date.',
        attemptedProvider: dataset.providerName,
        attemptedAt: dataset.generatedAt,
        consideredCache: false,
      };
    return {
      date,
      evidence,
      assessment: evaluateWeather({
        profile: place.weather,
        day: evidence,
        solar: findSolarDay(dataset, location.id, date),
        daylightOnly: input.daylightOnly,
        durationMinutes: place.typicalDurationMinutes,
        avoidances: input.avoidances,
      }),
    };
  });

  const kinds = [...new Set(perDay.map((entry) => entry.evidence.kind))].sort();
  const rankable = perDay.filter((entry) => entry.assessment.rankable);
  const badges: PlaceWeatherBadge[] = [];

  // Ordered by how much each would change a decision, and capped, because a
  // card wearing five weather badges has told the reader nothing.
  const best = [...rankable].sort(
    (a, b) => b.assessment.score - a.assessment.score || a.date.localeCompare(b.date),
  )[0];
  const worstEntry = [...rankable].sort(
    (a, b) => a.assessment.score - b.assessment.score || a.date.localeCompare(b.date),
  )[0];

  const spread =
    best && worstEntry ? best.assessment.score - worstEntry.assessment.score : 0;

  /**
   * `best_on_a_day` and `poor_in_the_forecast` are mutually exclusive.
   *
   * A card wearing "Best on Tue 4 Aug" beside "Weather works against it" is
   * telling the reader two things that sound contradictory and are not — the
   * first already implies the second, for the other days. Naming the good day is
   * the more useful of the two, so it wins and the warning is dropped.
   */
  if (best && spread >= 0.15) badges.push('best_on_a_day');
  else if (best && best.assessment.suitability === 'favorable') {
    badges.push('good_in_the_forecast');
  } else if (worstEntry && worstEntry.assessment.suitability === 'poor') {
    badges.push('poor_in_the_forecast');
  }
  /**
   * The two that report a *gap in what we know* go before the two that describe
   * the place, because the slice below is only two wide.
   *
   * The first ordering put `visibility_dependent` and `poor_weather_friendly`
   * ahead of them, so a card on a trip where one date came back empty could read
   * "Good in the forecast · Needs a clear day" with no trace anywhere that a day
   * had no data at all. A caveat that gets dropped is worse than one that was
   * never offered.
   */
  if (kinds.includes('unavailable')) badges.push('weather_unknown');
  if (kinds.includes('historical_pattern')) badges.push('seasonal_pattern');
  if (place.weather.visibilityDependent) badges.push('visibility_dependent');
  if (place.weather.poorWeatherBackup) badges.push('poor_weather_friendly');
  // `daylight_only` is deliberately *not* pushed here. The operating-hours layer
  // already badges it, from the calendar that owns the fact, and a card carrying
  // the same two words twice a centimetre apart reads as a template rather than
  // as information. The badge stays in the enum because the weather layer is
  // what finally made it enforceable — but the hours layer is what says it.

  const worst = worstSuitability(perDay.map((entry) => entry.assessment.suitability));
  const forecast = perDay.find((entry) => entry.evidence.kind === 'forecast');
  const anySourced = perDay.find(
    (entry) => entry.evidence.kind === 'forecast' || entry.evidence.kind === 'historical_pattern',
  );

  return {
    evidence: kinds,
    evidenceLabel:
      kinds.length === 0
        ? ''
        : kinds.length === 1
          ? WEATHER_EVIDENCE_LABELS[kinds[0]!]
          : 'Mixed evidence',
    // Two, not three. A card already carries a fit meter, a worth-the-detour
    // verdict, and up to five access and hours badges; weather adding a third
    // is where the row stops being scannable.
    badges: badges.slice(0, 2),
    bestDate: badges.includes('best_on_a_day') ? (best?.date ?? null) : null,
    worstDate:
      worstEntry && worstEntry.assessment.suitability === 'poor' ? worstEntry.date : null,
    note: noteFor(perDay, kinds, best, worstEntry, spread),
    locationLabel: location.label,
    locationLimitation: location.limitation,
    attribution:
      anySourced && anySourced.evidence.kind !== 'unavailable'
        ? anySourced.evidence.attribution.notice
        : null,
    fetchedAt:
      forecast && forecast.evidence.kind === 'forecast' ? forecast.evidence.fetchedAt : null,
    worst,
    best: bestSuitability(perDay.map((entry) => entry.assessment.suitability)),
    riskReasonCodes: [
      ...new Set(
        perDay.flatMap((entry) =>
          entry.assessment.reasons.filter((reason) => reason.weight < 0).map((reason) => reason.code),
        ),
      ),
    ].sort(),
  };
}

type DayEntry = {
  date: string;
  evidence: DayWeather;
  assessment: ReturnType<typeof evaluateWeather>;
};

/**
 * The single sentence a card gets, chosen so its verb matches its evidence.
 *
 * "Clearest on Thursday" is only sayable about a forecast. A seasonal pattern
 * gets "typically", and a failed lookup gets a plain statement that we do not
 * know — never an omission, which would read as nothing being wrong.
 */
function noteFor(
  perDay: readonly DayEntry[],
  kinds: readonly WeatherEvidenceKind[],
  best: DayEntry | undefined,
  worst: DayEntry | undefined,
  spread: number,
): string | null {
  if (best && spread >= 0.15) {
    return `${formatDay(best.date)} looks like the day for this one in the current forecast.`;
  }
  if (worst && worst.assessment.suitability === 'poor') {
    return `${worst.assessment.summary} That is the forecast for ${formatDay(worst.date)}.`;
  }
  if (kinds.includes('historical_pattern') && !kinds.includes('forecast')) {
    const pattern = perDay.find((entry) => entry.evidence.kind === 'historical_pattern');
    return pattern
      ? `${pattern.assessment.summary} These are historical patterns for the period, not a forecast for your dates.`
      : null;
  }
  if (kinds.includes('unavailable')) {
    return kinds.length === 1
      ? 'We could not reach a weather source for your dates, so nothing here has been checked against one.'
      : 'We could not get weather for every one of your dates, so part of this has not been checked against anything.';
  }
  return null;
}

function formatDay(date: string): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  return parsed.toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

const SEVERITY: Record<WeatherSuitability, number> = {
  incompatible: 0,
  poor: 1,
  unknown: 2,
  workable: 3,
  favorable: 4,
};

function worstSuitability(values: readonly WeatherSuitability[]): WeatherSuitability {
  return [...values].sort((a, b) => SEVERITY[a] - SEVERITY[b])[0] ?? 'unknown';
}

function bestSuitability(values: readonly WeatherSuitability[]): WeatherSuitability {
  return [...values].sort((a, b) => SEVERITY[b] - SEVERITY[a])[0] ?? 'unknown';
}
