import {
  displayNameOf,
  formatMinuteOfDay,
  isLessWeatherSensitive,
  WEATHER_CONDITION_LABELS,
  type DayBackup,
  type DayWeatherSummary,
  type Place,
  type TransportMode,
} from '@sidequest/core';
import type { PlaceDayHours } from './hours';
import type { PlaceDayWeather } from './weather';
import type { PlanningCandidate } from './types';

/**
 * SOMEWHERE ELSE TO GO.
 *
 * Until now Sidequest's entire notion of a weather backup was a sentence on the
 * day that said "have a fallback in mind" — the product noticing the problem out
 * loud and then handing the work back. This finds the fallback.
 *
 * The whole file is about refusing to answer when it cannot answer well. A
 * backup is a promise made to somebody who will act on it while standing
 * somewhere in the rain with a car and a ruined morning, so an invented one is
 * worse than none: they only discover the difference on arrival, at the point
 * where they have the least slack and the fewest options. Every filter below
 * exists to make "no strong backup" a reachable answer.
 */

export interface BackupCandidate {
  place: Place;
  travelMinutesFromBase: number;
  travelModeFromBase: TransportMode;
  /** From the board: 'included' | 'maybe' | 'excluded', or absent. */
  selectionStatus: string | undefined;
  /** Whether the traveller can legally reach it on this date. */
  reachable: boolean;
  hours: PlaceDayHours | undefined;
  weather: PlaceDayWeather | undefined;
}

export interface ChooseBackupsInput {
  date: string;
  /** Places already on the plan, anywhere in the trip. Never offered twice. */
  scheduledPlaceIds: ReadonlySet<string>;
  /** The stops on this day the weather is working against. */
  atRisk: readonly { candidate: PlanningCandidate; weather: PlaceDayWeather }[];
  pool: readonly BackupCandidate[];
  /** Minutes at the wheel a day may hold. Zero for a traveller with no car. */
  maxDriveMinutes: number;
  /** Driving plus riding plus walking. The cap that bounds a car-free rescue. */
  maxTransportMinutes: number;
  limit?: number;
}

/**
 * How far a fallback may be before it stops being one.
 *
 * A backup is used on the morning it is needed, by somebody who has already lost
 * their plan. Seventy-five minutes each way is two and a half hours of getting
 * about before anything else happens, which is where a rescued afternoon turns
 * into a travelling day. The ceiling is the traveller's own daily cap for the
 * mode that reaches the place, or this, whichever is smaller.
 *
 * Renamed off "drive" in Phase 15D, in step with the board-side twin
 * (`MAX_BOARD_BACKUP_TRAVEL_MINUTES`): the number always bounded a journey in
 * whatever mode reached it, and the drive-worded name described neither the
 * value nor the trips it applied to.
 */
export const MAX_BACKUP_TRAVEL_MINUTES = 75;

/** Never more than this on one day: a list of options is not a plan. */
export const MAX_BACKUPS_PER_DAY = 2;

export function chooseBackups(input: ChooseBackupsInput): DayBackup[] {
  const limit = input.limit ?? MAX_BACKUPS_PER_DAY;
  if (input.atRisk.length === 0) return [];

  /**
   * HOW FAR A RESCUE MAY BE, IN THE MODE THAT WOULD REACH IT.
   *
   * This was `min(maxDriveMinutes, 75)`. `maxDailyDriveMinutes` is **zero** for
   * every traveller without a car, so the ceiling was zero, every candidate
   * failed `> ceiling`, and no car-free trip has ever been offered a weather
   * backup — while the copy underneath went on saying nothing on the board was
   * reachable, which was false. The cap is chosen per candidate by the mode that
   * actually reaches it.
   */
  const ceilingFor = (mode: TransportMode): number => {
    /*
     * Nothing established the way there, so nothing establishes that it is close
     * enough either. Judging an unresolved figure against the travelling budget
     * would offer a rescue no measured mode reaches.
     */
    if (mode === 'unsupported') return 0;
    return Math.min(
      mode === 'drive' ? input.maxDriveMinutes : input.maxTransportMinutes,
      MAX_BACKUP_TRAVEL_MINUTES,
    );
  };
  const worst = [...input.atRisk].sort(
    (a, b) =>
      a.weather.assessment.score - b.weather.assessment.score ||
      a.candidate.place.id.localeCompare(b.candidate.place.id),
  )[0];
  if (!worst) return [];

  const trigger = triggerFor(worst.weather);

  const eligible = input.pool.filter((entry) => {
    // 1. Not already on the plan. Offering somebody Thursday's stop as
    //    Tuesday's fallback is offering them nothing.
    if (input.scheduledPlaceIds.has(entry.place.id)) return false;
    // 2. Never something they said they did not want. A fallback that ignores a
    //    stated preference is how a product teaches people their answers are
    //    decorative.
    if (entry.selectionStatus === 'excluded') return false;
    // 3. Reachable on this date, by this traveller, under their own transport
    //    answers. Weather does not get to relax that.
    if (!entry.reachable) return false;
    // 4. Open on this date, for long enough to be worth the journey.
    if (!isOpenEnough(entry)) return false;
    // 5. Close enough to be a rescue rather than a second trip — and by a
    //    journey somebody established. `unsupported` is refused by name, not by
    //    arithmetic: its ceiling of zero happened to admit a zero-minute figure,
    //    which is exactly the shape an unrouted place arrives in ({0, 0} from
    //    the compiled default), and the card then read "In town — no real
    //    journey to it" about a place nobody had routed at all.
    if (entry.travelModeFromBase === 'unsupported') return false;
    if (entry.travelMinutesFromBase > ceilingFor(entry.travelModeFromBase)) return false;
    // 6. Genuinely better in *this* weather. An equally exposed alternative is
    //    not a backup, it is the same afternoon somewhere else.
    if (!isLessExposed(entry, worst.weather)) return false;
    return true;
  });

  const ranked = [...eligible].sort((a, b) => rank(a) - rank(b) || a.place.id.localeCompare(b.place.id));

  return ranked.slice(0, limit).map((entry) => ({
    placeId: entry.place.id,
    name: displayNameOf(entry.place),
    trigger,
    why: whyFor(entry, worst.weather),
    replacesPlaceId: worst.candidate.place.id,
    accessSummary: accessSummaryFor(entry),
    openingSummary: openingSummaryFor(entry),
    /*
     * Rounded at the one writer, because the schema says integer and a provider
     * is entitled to say 27.4: a measured journey passes through `resolveLeg`
     * verbatim, and a float here failed the whole plan's parse after the build
     * had finished — a generic error over a decimal.
     */
    travelMinutesFromBase: Math.round(entry.travelMinutesFromBase),
    /*
     * The mode, persisted beside the minutes. It was already known here — the
     * ceiling above is chosen from it and the access sentence is written from it
     * — and it was thrown away at exactly this line, which is what let the
     * stored figure wear a driving name it had no right to.
     */
    /*
     * The filter above refuses `unsupported` by name; the assertion restates
     * that check for the schema's narrower type, which excludes it at the door.
     */
    travelModeFromBase: entry.travelModeFromBase as Exclude<TransportMode, 'unsupported'>,
    ...withCaution(entry),
  }));
}

/**
 * How near a rescue is, said in the mode that reaches it.
 *
 * The old sentence read "About 40 min out, on roads you are already using" on
 * every backup, including the ones a traveller with no car would reach on foot
 * or by train — roads they are not using and a journey they are not driving.
 */
function accessSummaryFor(entry: BackupCandidate): string {
  if (entry.travelMinutesFromBase <= 5) return 'In town — no real journey to it.';
  switch (entry.travelModeFromBase) {
    case 'drive':
      return `About ${entry.travelMinutesFromBase} min out, on roads you are already using.`;
    case 'walk':
      return `About ${entry.travelMinutesFromBase} min out on foot.`;
    case 'rail':
    case 'public_bus':
    case 'ferry':
    case 'shuttle':
      return `About ${entry.travelMinutesFromBase} min out on public transport.`;
    default:
      /**
       * A DISTANCE WITHOUT A MODE, SAID AS ONE.
       *
       * `unsupported` is what the reach resolver leaves behind when nothing it
       * could use answered for the pair — and the minutes then fall back to the
       * raw matrix figure, which on a road matrix is a *car* number for a
       * traveller who may have no car. An earlier version of this function let
       * that case fall into the `public transport` branch, so a backup nobody
       * had measured a journey to was described as a ride. Naming no mode is the
       * only honest thing left to do with a number like that.
       */
      return `About ${entry.travelMinutesFromBase} min out; we have not established how you would get there.`;
  }
}

/**
 * Preference order among the ones that qualify.
 *
 * A `maybe` outranks everything: the traveller has already looked at it and not
 * said no, so suggesting it is picking up a conversation rather than starting
 * one. After that, indoors beats sheltered beats short, and nearer beats
 * further — because the value of a fallback is almost entirely in how little it
 * costs to take.
 */
function rank(entry: BackupCandidate): number {
  const wasMaybe = entry.selectionStatus === 'maybe' ? 0 : 1000;
  const exposure =
    entry.place.weather.exposure === 'indoor'
      ? 0
      : entry.place.weather.exposure === 'sheltered_outdoor'
        ? 100
        : 200;
  return wasMaybe + exposure + entry.travelMinutesFromBase;
}

function isOpenEnough(entry: BackupCandidate): boolean {
  const hours = entry.hours;
  if (!hours) return false;
  if (hours.status === 'closed') return false;
  // `unknown` hours are schedulable in the main plan with a caution, but a
  // fallback is offered precisely when there is no slack left to absorb a locked
  // door, so unverified hours do not qualify.
  if (hours.status === 'unknown') return false;
  if (hours.status === 'always_open') return true;
  return hours.windows.some(
    (window) => window.closeMinute - window.openMinute >= entry.place.typicalDurationMinutes,
  );
}

/**
 * Whether this place actually copes better with the specific thing going wrong.
 *
 * Not "is it a nice indoor place" in the abstract — a museum is a poor answer to
 * a heat warning if the drive to it crosses the valley floor, and a sheltered
 * forest walk is a fine answer to wind and a bad one to snow. The axis that
 * failed is the axis that has to be better.
 */
function isLessExposed(entry: BackupCandidate, risk: PlaceDayWeather): boolean {
  return isLessWeatherSensitive({
    profile: entry.place.weather,
    riskReasonCodes: risk.assessment.reasons.map((reason) => reason.code),
    ...(entry.weather ? { ownScore: entry.weather.assessment.score } : {}),
    riskScore: risk.assessment.score,
  });
}

function triggerFor(risk: PlaceDayWeather): string {
  const worst = [...risk.assessment.reasons]
    .filter((reason) => reason.weight < 0)
    .sort((a, b) => a.weight - b.weight)[0];
  const what = worst ? worst.text : 'weather that works against the day';
  return risk.assessment.evidence === 'forecast'
    ? `If the forecast holds — ${what}.`
    : `If the season runs true — ${what}.`;
}

/**
 * Why this one is the answer, in a sentence that survives being read aloud.
 *
 * The reason clauses are written to slot in after "because" — "the long views
 * are likely to be shut in" — so anything that appends further words to them
 * produces the sort of half-sentence that makes a product feel machine-written.
 * Each branch below therefore ends where the clause ends.
 */
function whyFor(entry: BackupCandidate, risk: PlaceDayWeather): string {
  const profile = entry.place.weather;
  const because = lowerFirst(reasonOf(risk));
  if (profile.exposure === 'indoor') {
    return `Indoors, so it does not matter that ${because}.`;
  }
  if (profile.exposure === 'sheltered_outdoor') {
    return 'Sheltered enough to sit the weather out, and short enough to be worth the change of plan.';
  }
  return `Far less exposed than what it stands in for, on a day when ${because}.`;
}

function reasonOf(risk: PlaceDayWeather): string {
  const worst = [...risk.assessment.reasons]
    .filter((reason) => reason.weight < 0)
    .sort((a, b) => a.weight - b.weight)[0];
  return worst?.text ?? 'the weather';
}

function openingSummaryFor(entry: BackupCandidate): string {
  const hours = entry.hours;
  if (!hours || hours.status === 'always_open') return 'Open whenever you get there.';
  const window = hours.windows[0];
  if (!window) return 'Open on this date.';
  return `Open ${formatMinuteOfDay(window.openMinute)}–${formatMinuteOfDay(window.closeMinute)} on this date.`;
}

function withCaution(entry: BackupCandidate): { caution?: string } {
  const caution = cautionFor(entry);
  return caution ? { caution } : {};
}

function cautionFor(entry: BackupCandidate): string | undefined {
  if (entry.hours?.requiresVerification && entry.hours.verifyNote) return entry.hours.verifyNote;
  if (entry.place.access.roadSurface !== 'paved') {
    return 'The last stretch is unsurfaced — worth a look at the road before you commit.';
  }
  return undefined;
}

function lowerFirst(value: string): string {
  return value.charAt(0).toLowerCase() + value.slice(1);
}

/**
 * The day-level weather block: what the day rests on, what it cost, and where
 * else to go.
 *
 * Read off the evidence and the finished timeline rather than declared beside
 * them, which is what stops it claiming something the schedule does not show.
 */
export function summariseDayWeather(input: {
  date: string;
  /** Weather for the stops actually on this day. */
  onDay: readonly { candidate: PlanningCandidate; weather: PlaceDayWeather }[];
  /** The zone most of the day sat under, for the headline numbers. */
  representative: PlaceDayWeather | undefined;
  decisions: readonly string[];
  backups: readonly DayBackup[];
  noBackupReason?: string;
}): DayWeatherSummary {
  const evidence = input.representative?.evidence;
  const cautions: string[] = [];

  for (const entry of input.onDay) {
    const { assessment } = entry.weather;
    if (assessment.suitability === 'poor' || assessment.suitability === 'incompatible') {
      cautions.push(`${displayNameOf(entry.candidate.place)}: ${lowerFirst(assessment.summary)}`);
    }
  }

  const base = {
    decisions: [...input.decisions],
    cautions: [...new Set(cautions)],
    backups: [...input.backups],
    ...(input.noBackupReason ? { noBackupReason: input.noBackupReason } : {}),
  };

  if (!evidence || evidence.kind === 'unavailable') {
    return {
      evidence: 'unavailable',
      ...(input.representative
        ? {
            locationId: input.representative.locationId,
            locationLabel: input.representative.locationLabel,
          }
        : {}),
      summary:
        evidence?.kind === 'unavailable'
          ? `We could not get weather for this date. ${evidence.message}`
          : 'We have no weather for this day, so nothing here was placed against it.',
      precipitationProbabilityPercent: null,
      ...base,
      provider: evidence?.kind === 'unavailable' ? evidence.attemptedProvider : 'none',
      attribution:
        'Nothing here has been checked against the weather. Rebuild once a forecast is available.',
    };
  }

  if (evidence.kind === 'historical_pattern') {
    return {
      evidence: 'historical_pattern',
      locationId: input.representative!.locationId,
      locationLabel: input.representative!.locationLabel,
      summary:
        `Typically ${Math.round(evidence.temperatureMaxC.p50)} °C here at this time of year, ` +
        `with ${Math.round(evidence.wetDayFrequency * 100)}% of days in this period wet. ` +
        `This is what the last ${evidence.sampleYearTo - evidence.sampleYearFrom + 1} years have done, not a forecast for this date.`,
      temperatureMaxC: evidence.temperatureMaxC.p50,
      temperatureMinC: evidence.temperatureMinC.p50,
      precipitationProbabilityPercent: null,
      ...(input.representative!.solar
        ? {
            sunriseMinute: input.representative!.solar.sunriseMinute,
            sunsetMinute: input.representative!.solar.sunsetMinute,
          }
        : {}),
      ...base,
      provider: evidence.attribution.provider,
      attribution: evidence.attribution.notice,
    };
  }

  return {
    evidence: 'forecast',
    locationId: input.representative!.locationId,
    locationLabel: input.representative!.locationLabel,
    summary:
      `${WEATHER_CONDITION_LABELS[evidence.condition]}, ` +
      `${Math.round(evidence.temperatureMinC)}–${Math.round(evidence.temperatureMaxC)} °C` +
      (evidence.precipitationProbabilityPercent !== null
        ? `, ${evidence.precipitationProbabilityPercent}% chance of rain`
        : '') +
      '.',
    temperatureMaxC: evidence.temperatureMaxC,
    temperatureMinC: evidence.temperatureMinC,
    precipitationProbabilityPercent: evidence.precipitationProbabilityPercent,
    precipitationMm: evidence.precipitationMm,
    snowfallCm: evidence.snowfallCm,
    windGustMaxKph: evidence.windGustMaxKph,
    condition: WEATHER_CONDITION_LABELS[evidence.condition],
    ...(input.representative!.solar
      ? {
          sunriseMinute: input.representative!.solar.sunriseMinute,
          sunsetMinute: input.representative!.solar.sunsetMinute,
        }
      : {}),
    fetchedAt: evidence.fetchedAt,
    staleAfterMinutes: evidence.staleAfterMinutes,
    ...base,
    provider: evidence.attribution.provider,
    attribution: evidence.attribution.notice,
  };
}
