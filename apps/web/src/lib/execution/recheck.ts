import 'server-only';
import {
  assessOperational,
  factsDueForRecheck,
  volatileFacts,
  weatherAvailability,
  type DayWeather,
  type FactObservation,
  type Itinerary,
  type ItineraryDay,
  type OperationalOutcome,
  type PlaceClass,
  type TravelIntelligence,
  type Trip,
  type VolatileFact,
  type WeatherDataset,
  type WeatherLocation,
} from '@sidequest/core';
import { getItinerary, getTrip } from '@/lib/db/repository';
import { lastFactCheck, recordFactCheck, recordObservations } from '@/lib/db/execution-repository';
import { loadTripIntelligence } from '@/lib/intelligence/load';
import { providerRegistry } from '@/lib/providers/registry';
import { ProviderBudget, ceilingsFor } from '@/lib/providers/cost-budget';
import { operationalEvidenceSeam } from '@/lib/planning/place-identity';
import { fetchWeatherSnapshot, type WeatherFetchTarget } from '@/lib/weather/refresh';
import { getWeatherSnapshot, weatherScopeKey } from '@/lib/weather/snapshot-repository';
import { resolveTripRegion } from '@/lib/region';

/**
 * V9 §9 — THE DETERMINISTIC RECHECK.
 *
 * Every volatile fact behind a plan was read on a date. This module re-reads
 * the ones that are both stale and answerable by a configured, cheap source,
 * writes down what it saw, and stops. Three properties, in order of
 * importance:
 *
 *   - **The plan is never edited.** A changed forecast is an observation with
 *     a sentence a traveller reads; the change to the plan, if any, is a
 *     proposal through Ask Sidequest that the traveller accepts.
 *   - **Unknown ≠ changed.** A day whose new reading is not a forecast (the
 *     source answered with a climate pattern, or nothing) is *not comparable*
 *     and produces no observation. Only an affirmative, like-for-like reading
 *     can say something changed.
 *   - **Fewest requests.** One weather request for every due day of the trip;
 *     one operational request per due stop, under the same budget class a
 *     build uses. Transport status, deadlines and advisories have no
 *     automatable source here and are counted as such — never guessed at.
 *
 * Throttled per trip (`trip_fact_checks`, six hours): opening the trip twice
 * in an afternoon asks once.
 */
export const RECHECK_THROTTLE_HOURS = 6;

/**
 * THE FORECAST COMPARISON RULE, STATED ONCE.
 *
 * A forecast has "changed" for a traveller when the *decision* it supports
 * would change, not when a number moved. Two coarse classes are compared:
 *
 *   - **wet vs dry.** A day is wet when its condition names precipitation
 *     (rain, showers, drizzle, thunderstorm, snow, sleet) or when the chance of
 *     rain is at or above `WET_PROBABILITY_PERCENT`. Crossing that line in
 *     either direction is a change.
 *   - **temperature band.** The daily maximum moving by more than
 *     `TEMPERATURE_BAND_C` in either direction is a change; less is weather
 *     being weather.
 *
 * Wind, cloud and the minimum are deliberately not compared: nothing in the
 * plan is placed against them, so a change in them changes no decision.
 */
export const TEMPERATURE_BAND_C = 5;
export const WET_PROBABILITY_PERCENT = 50;

const WET_CONDITION = /rain|shower|drizzle|thunder|storm|snow|sleet|hail/i;

export type PrecipitationClass = 'wet' | 'dry';

export function precipitationClass(input: { condition?: string | null; precipitationProbabilityPercent?: number | null; precipitationMm?: number | null }): PrecipitationClass {
  if (input.condition && WET_CONDITION.test(input.condition)) return 'wet';
  if (typeof input.precipitationProbabilityPercent === 'number' && input.precipitationProbabilityPercent >= WET_PROBABILITY_PERCENT) return 'wet';
  return 'dry';
}

/** When in the day the rain falls, read from the hourly rows when the source gives them. */
function wetPeriod(day: Extract<DayWeather, { kind: 'forecast' }>): string | null {
  if (!day.hours || day.hours.length === 0) return null;
  const buckets = { morning: 0, afternoon: 0, evening: 0 };
  for (const hour of day.hours) {
    const h = Math.floor(hour.startMinute / 60);
    const wet = hour.precipitationMm + hour.snowfallCm;
    if (h < 12) buckets.morning += wet;
    else if (h < 18) buckets.afternoon += wet;
    else buckets.evening += wet;
  }
  const total = buckets.morning + buckets.afternoon + buckets.evening;
  if (total <= 0) return null;
  const [period, amount] = Object.entries(buckets).sort((a, b) => b[1] - a[1])[0]!;
  return amount / total >= 0.6 ? period : null;
}

function conditionWord(condition: string): string {
  return condition.replace(/_/g, ' ').toLowerCase();
}

export interface ForecastComparison {
  changed: boolean;
  previous: string;
  current: string;
  summary: string;
}

/**
 * Compare a day's stored forecast with a fresh reading of the same day.
 *
 * Null when there is nothing like-for-like to compare: the stored day was
 * not a forecast, or the fresh reading is not one. That is the unknown ≠
 * changed rule in code — a source that answered with less than it did before
 * says nothing about the sky.
 */
export function compareForecast(day: ItineraryDay, current: DayWeather | undefined): ForecastComparison | null {
  if (day.weather.evidence !== 'forecast') return null;
  if (!current || current.kind !== 'forecast') return null;
  const previousClass = precipitationClass({ condition: day.weather.condition ?? null, precipitationProbabilityPercent: day.weather.precipitationProbabilityPercent, precipitationMm: day.weather.precipitationMm ?? null });
  const currentClass = precipitationClass({ condition: current.condition, precipitationProbabilityPercent: current.precipitationProbabilityPercent, precipitationMm: current.precipitationMm });
  const previousMax = day.weather.temperatureMaxC;
  const currentMax = current.temperatureMaxC;
  const temperatureMoved = typeof previousMax === 'number' && Math.abs(currentMax - previousMax) > TEMPERATURE_BAND_C;

  const label = `Day ${day.dayNumber}`;
  const sentences: string[] = [];
  if (previousClass !== currentClass) {
    if (currentClass === 'wet') {
      const period = wetPeriod(current);
      const chance = current.precipitationProbabilityPercent !== null ? ` (${current.precipitationProbabilityPercent}% chance)` : '';
      sentences.push(`${label} now expects ${conditionWord(current.condition)}${period ? ` in the ${period}` : ''}${chance}; it was dry when the plan was built.`);
    } else {
      sentences.push(`${label} now looks dry (${conditionWord(current.condition)}); rain was expected when the plan was built.`);
    }
  }
  if (temperatureMoved) {
    sentences.push(`${label} now expects a high of ${Math.round(currentMax)} °C; the plan was built against ${Math.round(previousMax)} °C.`);
  }
  const currentText = `${conditionWord(current.condition)}, ${Math.round(current.temperatureMinC)}–${Math.round(current.temperatureMaxC)} °C${current.precipitationProbabilityPercent !== null ? `, ${current.precipitationProbabilityPercent}% chance of rain` : ''}`;
  return {
    changed: sentences.length > 0,
    previous: day.weather.summary,
    current: currentText,
    summary: sentences.length > 0 ? sentences.join(' ') : `${label}'s forecast still matches the plan.`,
  };
}

/**
 * Which points the recheck asks about, and which point speaks for each day.
 *
 * Like for like first: every day records which weather point it was placed
 * against (`day.weather.locationId`), and when the trip's compiled region
 * still holds that point it is asked again — same coordinates, same
 * elevation, so a difference is a difference in the sky and not in the
 * question. Otherwise the day's base carries a position (the reconciler
 * placed it), and that point stands for the day. A day whose base has no
 * position falls back to the centroid of the stops placed on it; a day with
 * none of these is not rechecked for weather — it has nothing to be asked
 * about, which is different from being unchanged.
 */
export function recheckWeatherPlan(itinerary: Itinerary, timeZone: string, known: readonly WeatherLocation[] = []): { locations: WeatherLocation[]; locationForDay: Map<number, string> } {
  const locations = new Map<string, WeatherLocation>();
  const locationForDay = new Map<number, string>();
  const bases = new Map((itinerary.package?.bases ?? []).map((base) => [base.id, base] as const));
  const anchors = itinerary.package?.anchors ?? [];
  const knownById = new Map(known.map((location) => [location.id, location] as const));
  for (const day of itinerary.days) {
    if (day.weather.evidence !== 'forecast') continue;
    const same = day.weather.locationId ? knownById.get(day.weather.locationId) : undefined;
    if (same) {
      if (!locations.has(same.id)) locations.set(same.id, same);
      locationForDay.set(day.dayNumber, same.id);
      continue;
    }
    const base = bases.get(day.baseId);
    if (base?.coordinates) {
      const id = `base:${base.id}`;
      if (!locations.has(id)) locations.set(id, { id, label: base.displayName ?? base.name, coordinates: base.coordinates, elevationMetres: 0, timeZone, placeIds: [base.id], limitation: 'One point for this base and the days around it.' });
      locationForDay.set(day.dayNumber, id);
      continue;
    }
    const placed = anchors.filter((a) => (a.scheduledDayNumber ?? a.dayNumber) === day.dayNumber && a.identity?.coordinates);
    if (placed.length === 0) continue;
    const lat = placed.reduce((sum, a) => sum + a.identity!.coordinates.lat, 0) / placed.length;
    const lng = placed.reduce((sum, a) => sum + a.identity!.coordinates.lng, 0) / placed.length;
    const id = `day:${day.dayNumber}`;
    locations.set(id, { id, label: `Day ${day.dayNumber}`, coordinates: { lat: Math.round(lat * 1e4) / 1e4, lng: Math.round(lng * 1e4) / 1e4 }, elevationMetres: 0, timeZone, placeIds: placed.map((a) => a.placeId ?? a.id), limitation: 'The middle of the day’s stops; conditions vary across them.' });
    locationForDay.set(day.dayNumber, id);
  }
  return { locations: [...locations.values()], locationForDay };
}

/**
 * THE OFFLINE "CHANGED" SWITCH, FOR TESTS ONLY.
 *
 * The fixture weather is a function of the date, so re-reading it returns
 * what the plan was built against and nothing ever changes — which is right
 * for every test except the one that needs to see a change. With
 * `SIDEQUEST_FIXTURE_WEATHER_SHIFT=<days>`, honoured only while the composer
 * and the weather source are both the offline fixture (the same rule
 * `lib/clock.ts` applies to `SIDEQUEST_FIXTURE_NOW`), the recheck reads the
 * fixture's answer for that many days later and compares it as today's. A
 * live deployment cannot turn this on.
 */
export function fixtureWeatherShiftDays(env: Record<string, string | undefined> = process.env): number {
  if (env.SIDEQUEST_COMPOSER_PROVIDER !== 'fixture' || env.SIDEQUEST_WEATHER_PROVIDER?.trim().toLowerCase() !== 'fixture') return 0;
  const parsed = Number.parseInt(env.SIDEQUEST_FIXTURE_WEATHER_SHIFT ?? '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.min(7, parsed);
}

function shiftDate(date: string, days: number): string {
  if (days === 0) return date;
  const at = new Date(`${date}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

const OUTCOME_WORDS: Record<OperationalOutcome, string> = {
  open_at_time: 'open at the planned time',
  opens_later: 'opening later than the planned arrival',
  closes_earlier: 'closing before the planned visit ends',
  closed_on_date: 'closed on that date',
  closed_permanently: 'listed as permanently closed',
  closed_temporarily_now: 'listed as temporarily closed right now',
  hours_unknown: 'without published hours',
  not_applicable: 'a place hours do not apply to',
  unavailable: 'unanswered by the source',
};

export interface RecheckCounts {
  due: number;
  checked: number;
  changed: number;
  notComparable: number;
  notAutomatable: number;
  weatherRequests: number;
  hoursRequests: number;
}

export type RecheckOutcome =
  | { ran: false; skipped: 'recent' | 'no_trip' | 'no_plan' | 'nothing_due'; lastCheckedAt: string | null }
  | { ran: true; checkedAt: string; counts: RecheckCounts; observations: FactObservation[] };

/** Seams for the two sources, so a test can hand in a reading without a provider. */
export interface RecheckDeps {
  fetchWeather?: (target: WeatherFetchTarget) => Promise<WeatherDataset | null>;
  env?: Record<string, string | undefined>;
}

async function fetchWeatherThroughSnapshot(target: WeatherFetchTarget): Promise<WeatherDataset | null> {
  const outcome = await fetchWeatherSnapshot(target);
  if (!outcome.ok) return null;
  const availability = weatherAvailability(getWeatherSnapshot(target.tripId, target.scopeKey), new Date());
  return availability.kind === 'present' ? availability.snapshot.dataset : null;
}

/**
 * Re-read the stale, answerable facts behind a trip's plan and record what
 * changed. Idempotent inside the throttle window; never edits the itinerary.
 */
export async function recheckStaleFacts(tripId: string, options: { now?: Date } & RecheckDeps = {}): Promise<RecheckOutcome> {
  const now = options.now ?? new Date();
  const env = options.env ?? process.env;
  const last = lastFactCheck(tripId);
  if (last && now.getTime() - Date.parse(last.checkedAt) < RECHECK_THROTTLE_HOURS * 3_600_000) {
    return { ran: false, skipped: 'recent', lastCheckedAt: last.checkedAt };
  }
  const trip = getTrip(tripId);
  if (!trip) return { ran: false, skipped: 'no_trip', lastCheckedAt: last?.checkedAt ?? null };
  let stored: Itinerary | null;
  try {
    stored = getItinerary(tripId);
  } catch {
    stored = null;
  }
  if (!stored) return { ran: false, skipped: 'no_plan', lastCheckedAt: last?.checkedAt ?? null };

  const loaded = loadTripIntelligence({ trip, itinerary: stored, now, persist: false });
  const registry = providerRegistry(env);
  const capabilities = {
    forecast: registry.byId['weather.forecast']?.available ?? false,
    hours: registry.byId['places.hours']?.available ?? false,
    transit: registry.byId['routing.transit']?.available ?? false,
  };
  const facts = volatileFacts({ itinerary: loaded.itinerary, intelligence: loaded.intelligence, booked: loaded.booked, now, capabilities });
  const due = factsDueForRecheck(facts);
  const notAutomatable = facts.filter((f) => f.stale && !f.recheckable).length;
  if (due.length === 0) return { ran: false, skipped: 'nothing_due', lastCheckedAt: last?.checkedAt ?? null };

  const counts: RecheckCounts = { due: due.length, checked: 0, changed: 0, notComparable: 0, notAutomatable, weatherRequests: 0, hoursRequests: 0 };
  const observed: Omit<FactObservation, 'id' | 'acknowledgedAt'>[] = [];
  const observedAt = now.toISOString();

  await recheckForecasts({ tripId, trip, itinerary: loaded.itinerary, intelligence: loaded.intelligence, due, now, counts, observed, observedAt, fetchWeather: options.fetchWeather ?? fetchWeatherThroughSnapshot, env });
  await recheckHours({ itinerary: loaded.itinerary, due, now, counts, observed, observedAt, env, available: capabilities.hours });

  const observations = recordObservations(tripId, observed);
  recordFactCheck(tripId, { ...counts }, now);
  return { ran: true, checkedAt: observedAt, counts, observations };
}

async function recheckForecasts(input: {
  tripId: string;
  trip: Trip;
  itinerary: Itinerary;
  intelligence: TravelIntelligence;
  due: readonly VolatileFact[];
  now: Date;
  counts: RecheckCounts;
  observed: Omit<FactObservation, 'id' | 'acknowledgedAt'>[];
  observedAt: string;
  fetchWeather: (target: WeatherFetchTarget) => Promise<WeatherDataset | null>;
  env: Record<string, string | undefined>;
}): Promise<void> {
  const dueDays = new Set(input.due.filter((f) => f.kind === 'forecast').flatMap((f) => f.dayNumbers));
  if (dueDays.size === 0) return;
  const timeZone = input.intelligence.destinationContext.timeZone ?? 'UTC';
  /* The plan's own weather points, when the trip has a compiled region; a trip planned without one reads its bases. */
  let known: readonly WeatherLocation[] = [];
  try {
    const resolved = await resolveTripRegion(input.trip);
    if (resolved.ok) known = resolved.context.compiled.weatherLocations;
  } catch {
    known = [];
  }
  const plan = recheckWeatherPlan(input.itinerary, timeZone, known);
  const days = input.itinerary.days.filter((d) => dueDays.has(d.dayNumber));
  const askable = days.filter((d) => plan.locationForDay.has(d.dayNumber));
  input.counts.notComparable += days.length - askable.length;
  if (askable.length === 0) return;

  /* One request for every due day of the trip. Its own scope: the plan's own weather snapshot is never overwritten by a recheck. */
  const shift = fixtureWeatherShiftDays(input.env);
  const dates = [...new Set(askable.map((d) => shiftDate(d.date, shift)))].sort();
  const regionId = `recheck:${input.tripId}`;
  const target: WeatherFetchTarget = { tripId: input.tripId, regionId, locations: plan.locations, dates, scopeKey: weatherScopeKey({ regionId, dates, locations: plan.locations }) };
  input.counts.weatherRequests += 1;
  const dataset = await input.fetchWeather(target).catch((): WeatherDataset | null => null);
  if (!dataset) {
    /* The source did not answer: nothing is known, so nothing is claimed. */
    input.counts.notComparable += askable.length;
    return;
  }
  for (const day of askable) {
    const locationId = plan.locationForDay.get(day.dayNumber)!;
    const reading = dataset.days.find((d) => d.locationId === locationId && d.date === shiftDate(day.date, shift));
    const comparison = compareForecast(day, reading);
    input.counts.checked += 1;
    if (!comparison) {
      input.counts.notComparable += 1;
      continue;
    }
    if (!comparison.changed) continue;
    input.counts.changed += 1;
    input.observed.push({ factId: `fact:forecast:${day.dayNumber}`, kind: 'forecast', observedAt: input.observedAt, previous: comparison.previous, current: comparison.current, changed: true, dayNumbers: [day.dayNumber], summary: comparison.summary });
  }
}

async function recheckHours(input: {
  itinerary: Itinerary;
  due: readonly VolatileFact[];
  now: Date;
  counts: RecheckCounts;
  observed: Omit<FactObservation, 'id' | 'acknowledgedAt'>[];
  observedAt: string;
  env: Record<string, string | undefined>;
  available: boolean;
}): Promise<void> {
  const dueHours = input.due.filter((f) => f.kind === 'hours' || f.kind === 'status');
  if (dueHours.length === 0 || !input.available) return;
  const budget = new ProviderBudget(ceilingsFor({ anchors: dueHours.length, days: input.itinerary.days.length, bases: input.itinerary.package?.bases.length ?? 1, mealsNeedingVenue: 0 }));
  const seam = operationalEvidenceSeam(budget, input.env, input.now);
  if (!seam) {
    input.counts.notComparable += dueHours.length;
    return;
  }
  const anchors = input.itinerary.package?.anchors ?? [];
  for (const fact of dueHours) {
    const itemId = fact.id.replace(/^fact:(hours|status):/, '');
    const day = input.itinerary.days.find((d) => d.dayNumber === fact.dayNumbers[0]);
    const item = day?.items.find((i) => i.id === itemId);
    if (!day || !item || item.kind !== 'activity' || !item.operational || !item.placeId) {
      input.counts.notComparable += 1;
      continue;
    }
    const anchor = anchors.find((a) => a.placeId === item.placeId && a.identity?.providerRef);
    if (!anchor?.identity?.providerRef) {
      input.counts.notComparable += 1;
      continue;
    }
    input.counts.hoursRequests += 1;
    input.counts.checked += 1;
    const evidence = await seam({ placeId: item.placeId, providerRef: anchor.identity.providerRef, provider: anchor.identity.provider, name: item.title, placeClass: (anchor.identity.placeClass ?? 'unknown') as PlaceClass });
    if (!evidence || evidence.unavailableReason) {
      input.counts.notComparable += 1;
      continue;
    }
    const daysUntil = Math.round((Date.parse(`${day.date}T00:00:00Z`) - input.now.getTime()) / 86_400_000);
    const assessment = assessOperational({ evidence, placeClass: (anchor.identity.placeClass ?? 'unknown') as PlaceClass, date: day.date, startMinute: item.startMinute, endMinute: item.endMinute, daysUntil });
    const before = item.operational.outcome;
    const after = assessment.outcome;
    if (!hoursChangeIsReal(before, after)) continue;
    input.counts.changed += 1;
    input.observed.push({
      factId: fact.id,
      kind: fact.kind,
      observedAt: input.observedAt,
      previous: before,
      current: after,
      changed: true,
      dayNumbers: [day.dayNumber],
      summary: `${item.title} on day ${day.dayNumber} is now ${OUTCOME_WORDS[after]}; it was ${OUTCOME_WORDS[before]} when the plan was built.`,
    });
  }
}

/**
 * V9 — WHAT COUNTS AS AN HOURS CHANGE.
 *
 * The reconciler already moved a visit that opened later or closed earlier
 * to the hours it read, so a fresh reading of "open at the planned time" on
 * that visit is the plan working, not the world changing. A change is a
 * different reading that the plan has not already absorbed: a closure, or a
 * visit that was open and now is not. Unknown readings are never changes.
 */
export function hoursChangeIsReal(before: string, after: string): boolean {
  if (after === before) return false;
  if (after === 'hours_unknown' || after === 'unavailable' || after === 'not_applicable') return false;
  const absorbed = new Set(['open_at_time', 'opens_later', 'closes_earlier']);
  if (after === 'open_at_time' && absorbed.has(before)) return false;
  return true;
}
