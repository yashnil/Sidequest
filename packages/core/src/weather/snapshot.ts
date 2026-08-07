import { z } from 'zod';
import {
  weatherAttributionSchema,
  weatherDatasetSchema,
  weatherLocationSchema,
  type WeatherDataset,
  type WeatherLocation,
} from '../schemas/weather';
import { utcOffsetMinutesOn } from '../time/zone';
import { buildSolarDays } from './solar';

/**
 * WEATHER AS A STORED RESULT, NEVER AS SOMETHING A PAGE FETCHES.
 *
 * The defect this replaces, exactly: `/discover` resolved its region during
 * render, and resolving a region called `resolveTripWeather`, and that called a
 * forecast provider. So every page load — every refresh, every back button,
 * every Playwright navigation, every crawler — made an outbound request. Three
 * things followed from that, and all three were visible in the product.
 *
 *   1. A provider having a bad afternoon became a slow page rather than a stale
 *      badge. The traveller could not read the board they already had because we
 *      were busy asking about the sky.
 *   2. A refresh spent money. Nothing in the interface suggested that pressing
 *      reload was an action with a cost, because nothing in the interface
 *      suggested it was an action at all.
 *   3. The forecast underneath a stored plan moved without anybody asking it to.
 *      A page rendered twice showed two different sets of numbers, and the
 *      itinerary above them was built against neither.
 *
 * A snapshot fixes all three by making the fetch an *operation*: it happens
 * once, it is written down, and rendering reads what was written. A page can
 * then say "fetched forty minutes ago" or "never fetched" and offer a button —
 * which is both more honest and considerably faster than what it replaced.
 *
 * ---
 *
 * WHY EVERY FIELD IS HERE.
 *
 * A snapshot is a claim about the world made at a moment in the past, and the
 * whole difficulty is that it does not look like one once it is on a page. Each
 * field below exists so that it cannot be rendered as though it were current:
 *
 *   - `provider` and `model` — which service, and which model run or dataset
 *     where the service names one. Two providers disagreeing is information; two
 *     providers rendered identically is not.
 *   - `fetchedAt` — when, in absolute terms. Never "recently".
 *   - `staleAfter` and `validUntil` — the two clocks. Past the first, the number
 *     is still shown and labelled old. Past the second it is not shown at all,
 *     because a fourteen-day-old forecast for tomorrow is not a weak claim, it
 *     is a different claim.
 *   - `locations` — the points actually sampled, with their elevations. A
 *     forecast for a valley floor rendered against a pass is wrong by degrees
 *     that matter, and this is what lets a surface say which point it used.
 *   - `attribution` — the licence lines that must appear wherever the data does.
 *     Stored with the data so a render can comply without knowing who was asked.
 *   - `operationVersion` — which generation of the refresh operation wrote this.
 *     A snapshot written by an older operation may be missing coverage the
 *     current one would have fetched, and that has to be visible rather than
 *     inferred from the shape of the JSON.
 *   - `refresh` — the status of the last attempt, including a failed one. A
 *     failure that leaves no trace is a button that appears to do nothing.
 */

export const WEATHER_SNAPSHOT_VERSION = 1 as const;

/**
 * Which generation of the refresh operation produced a row.
 *
 * Bumped when the operation starts fetching something it did not fetch before,
 * or stops. Distinct from the schema version: the shape can stay identical while
 * the coverage changes, and a reader that cannot tell those apart will present
 * an under-covered snapshot as a complete one.
 */
export const WEATHER_OPERATION_VERSION = 1 as const;

/**
 * What kind of evidence the stored dates could produce, decided at fetch time.
 *
 * Recorded rather than re-derived, because it depends on the horizon *as it was
 * when the request went out*. A trip that was inside the forecast window a week
 * ago and is not now would silently re-classify itself on read, and the label on
 * screen would change without the data underneath it changing at all.
 */
export const WEATHER_HORIZON_KINDS = ['forecast', 'historical_pattern', 'mixed', 'none'] as const;
export const weatherHorizonKindSchema = z.enum(WEATHER_HORIZON_KINDS);
export type WeatherHorizonKind = z.infer<typeof weatherHorizonKindSchema>;

/**
 * How a refresh went. Four values, and `failed` is the one that earns its place.
 *
 * A refresh that failed and left no record is a button that appears to do
 * nothing — the traveller presses it, the page comes back identical, and there
 * is no way to tell "we tried and the provider was down" from "the click did not
 * register". The message travels with the status for the same reason.
 */
export const WEATHER_REFRESH_STATUSES = [
  'never_requested',
  'in_progress',
  'succeeded',
  'failed',
  /**
   * The provider answered, and had nothing for us.
   *
   * Split out of `succeeded` because the two were being conflated on screen with
   * real consequences: with the forecast provider switched off, the fetch path
   * returned a complete dataset in which *every day* was `unavailable`, recorded
   * that as `succeeded`, and the panel then read "Weather: fetched · Fetched
   * recently enough to rely on" over nothing at all. The operation genuinely did
   * not fail — there was no outage and nothing to retry — so calling it `failed`
   * would be its own lie. It returned nothing, which is a third outcome and
   * needs a third name.
   *
   * The same status covers a provider that is configured, answered, and had no
   * data for the dates asked about — a request beyond its archive, or a point it
   * does not cover. From the traveller's side those are the same event: we asked,
   * and we still cannot tell you anything.
   */
  'returned_nothing',
] as const;
export const weatherRefreshStatusSchema = z.enum(WEATHER_REFRESH_STATUSES);
export type WeatherRefreshStatus = z.infer<typeof weatherRefreshStatusSchema>;

export const weatherRefreshSchema = z.object({
  status: weatherRefreshStatusSchema,
  requestedAt: z.string().min(1).optional(),
  completedAt: z.string().min(1).optional(),
  /** One sentence a traveller can read. Never a stack trace or a status code. */
  message: z.string().min(1).optional(),
});
export type WeatherRefresh = z.infer<typeof weatherRefreshSchema>;

export const weatherSnapshotSchema = z.object({
  schemaVersion: z.literal(WEATHER_SNAPSHOT_VERSION),
  tripId: z.string().min(1),
  regionId: z.string().min(1),
  /**
   * The fingerprint of what was asked for: region, dates and points.
   *
   * A snapshot whose key does not match the current request is a snapshot for a
   * different question. Changing the dates must not silently inherit the old
   * trip's forecast, which is precisely what a trip-id-only key would do.
   */
  scopeKey: z.string().min(1),
  provider: z.string().min(1),
  /** The model run or dataset, where the provider names one. Null, never guessed. */
  model: z.string().min(1).nullable(),
  fetchedAt: z.string().min(1),
  /** Past this, the numbers are shown and labelled old. */
  staleAfter: z.string().min(1),
  /** Past this, the numbers are not shown at all. */
  validUntil: z.string().min(1),
  horizon: weatherHorizonKindSchema,
  dates: z.array(z.string().min(1)).min(1),
  /** The points actually sampled, with elevations and zones. */
  locations: z.array(weatherLocationSchema).min(1),
  attribution: z.array(weatherAttributionSchema).default([]),
  operationVersion: z.number().int().positive(),
  refresh: weatherRefreshSchema,
  /** What was fetched. The dataset every existing weather surface already reads. */
  dataset: weatherDatasetSchema,
});
export type WeatherSnapshot = z.infer<typeof weatherSnapshotSchema>;

/**
 * The three states a render may be in, plus the fourth that is not a state at
 * all.
 *
 * `absent` is deliberately not a value on the snapshot — it is what you get when
 * there is no snapshot — so that no code path can construct a snapshot that
 * claims to be missing.
 */
export const WEATHER_SNAPSHOT_STATES = ['fresh', 'stale', 'expired'] as const;
export const weatherSnapshotStateSchema = z.enum(WEATHER_SNAPSHOT_STATES);
export type WeatherSnapshotState = z.infer<typeof weatherSnapshotStateSchema>;

/**
 * HOW MUCH OF THE QUESTION THE STORED ANSWER ACTUALLY COVERS.
 *
 * A snapshot is a record of an *operation*, and an operation can complete and
 * bring back nothing. Before this existed, the only thing a render could ask was
 * "is there a row and how old is it" — so a row full of `unavailable` days was
 * indistinguishable from a row full of forecasts, and the panel said "fetched"
 * for both.
 *
 * Derived from the days themselves rather than stored, because it is a fact
 * about the dataset in hand and re-deriving it can never disagree with it.
 */
export const WEATHER_COVERAGE_LEVELS = ['none', 'partial', 'complete'] as const;
export const weatherCoverageSchema = z.enum(WEATHER_COVERAGE_LEVELS);
export type WeatherCoverage = z.infer<typeof weatherCoverageSchema>;

export function weatherCoverageOf(dataset: WeatherDataset): WeatherCoverage {
  const total = dataset.days.length;
  if (total === 0) return 'none';
  const usable = dataset.days.filter((day) => day.kind !== 'unavailable').length;
  if (usable === 0) return 'none';
  return usable === total ? 'complete' : 'partial';
}

export type WeatherAvailability =
  | { kind: 'absent' }
  | {
      kind: 'present';
      state: WeatherSnapshotState;
      /** What the stored dataset actually holds, never what was asked for. */
      coverage: WeatherCoverage;
      snapshot: WeatherSnapshot;
    };

/**
 * Pure, and pure on purpose.
 *
 * This is the one weather function a render path is allowed to call, so it has
 * to be arithmetic over a stored row and a clock and nothing else. The moment it
 * can reach a provider, the property the whole module exists to establish is
 * gone.
 */
export function weatherSnapshotState(
  snapshot: WeatherSnapshot,
  now: Date,
): WeatherSnapshotState {
  const at = now.getTime();
  if (at >= Date.parse(snapshot.validUntil)) return 'expired';
  if (at >= Date.parse(snapshot.staleAfter)) return 'stale';
  return 'fresh';
}

export function weatherAvailability(
  snapshot: WeatherSnapshot | null,
  now: Date,
): WeatherAvailability {
  if (!snapshot) return { kind: 'absent' };
  return {
    kind: 'present',
    state: weatherSnapshotState(snapshot, now),
    coverage: weatherCoverageOf(snapshot.dataset),
    snapshot,
  };
}

/**
 * WHAT THE PANEL SAYS, DECIDED IN ONE PLACE.
 *
 * The heading used to be built at the render site from `kind` and `state` alone,
 * which is how "Weather: fetched · Fetched recently enough to rely on" came to
 * sit above a dataset containing no weather. Three inputs decide it — is there a
 * row, how old is it, and does it hold anything — and reading only two of them
 * produced a sentence the third contradicted.
 *
 * Pure, so it is testable without a database and cannot be the thing that starts
 * a request. The copy lives here rather than at the call site so the board, the
 * itinerary and any export say the same thing.
 */
export function weatherPanelCopy(availability: WeatherAvailability): {
  heading: string;
  body: string;
  /** Whether the numbers in the snapshot may be put on screen. */
  showNumbers: boolean;
} {
  if (availability.kind === 'absent') {
    return { heading: 'Weather: not fetched', body: WEATHER_ABSENT_COPY, showNumbers: false };
  }

  const { state, coverage, snapshot } = availability;

  /*
   * The attempt is reported before the age is, because an attempt that brought
   * back nothing makes the age irrelevant: "fetched 3 minutes ago" is true and
   * completely beside the point when what was fetched was an absence.
   */
  if (snapshot.refresh.status === 'in_progress') {
    return {
      heading: 'Weather: fetching',
      body: 'We are asking now. Nothing on this page has changed yet.',
      showNumbers: coverage !== 'none' && isSnapshotRenderable(state),
    };
  }

  if (snapshot.refresh.status === 'failed') {
    return {
      heading: 'Weather: the last fetch failed',
      body:
        snapshot.refresh.message ??
        'We asked and did not get an answer. Nothing here is a claim about the weather.',
      showNumbers: coverage !== 'none' && isSnapshotRenderable(state),
    };
  }

  if (coverage === 'none') {
    return {
      heading: 'Weather: nothing came back',
      body: 'We asked and got nothing usable for your dates, so there is no weather here to read. That is a statement about our sources rather than about the weather.',
      showNumbers: false,
    };
  }

  const partial =
    coverage === 'partial'
      ? ' Some of your dates came back empty, and those days say so rather than being filled in.'
      : '';

  const heading =
    state === 'fresh'
      ? 'Weather: fetched'
      : state === 'stale'
        ? 'Weather: last fetched a while ago'
        : 'Weather: out of date';

  return {
    heading,
    body: `${WEATHER_SNAPSHOT_STATE_COPY[state]}${partial}`,
    showNumbers: isSnapshotRenderable(state),
  };
}

/**
 * Whether the numbers may be put on screen at all.
 *
 * Fresh and stale both render — stale with its label. Expired does not, because
 * an expired forecast is not a weaker version of the same claim, it is a claim
 * about a window that has closed.
 */
export function isSnapshotRenderable(state: WeatherSnapshotState): boolean {
  return state !== 'expired';
}

/**
 * One sentence per state, in the product's register.
 *
 * Here rather than at each call site so the board, the itinerary and any export
 * say the same thing — and so a state added without copy is a type error.
 */
export const WEATHER_SNAPSHOT_STATE_COPY: Record<WeatherSnapshotState, string> = {
  fresh: 'Fetched recently enough to rely on.',
  stale: 'This is the last weather we fetched, and it is old enough that we would check it again before you pack.',
  expired: 'The weather we had has passed the window it was good for, so we are not showing it.',
};

export const WEATHER_ABSENT_COPY =
  'We have not fetched the weather for this trip. Nothing here is a claim about what it will be like.';

/**
 * Minutes a snapshot stays fresh, and minutes it stays showable at all.
 *
 * Two clocks with a wide gap between them, because the two kinds of evidence age
 * at wildly different rates. A forecast is one model run old within hours; ten
 * years of reanalysis for the second week of August will say the same thing next
 * month as it does today. One number for both would either hammer the archive
 * endpoint or serve last week's forecast as this morning's.
 */
export const SNAPSHOT_FRESH_MINUTES: Record<WeatherHorizonKind, number> = {
  forecast: 60,
  historical_pattern: 60 * 24 * 30,
  mixed: 60,
  none: 60,
};

export const SNAPSHOT_VALID_MINUTES: Record<WeatherHorizonKind, number> = {
  forecast: 60 * 24,
  historical_pattern: 60 * 24 * 180,
  mixed: 60 * 24,
  none: 60,
};

export function snapshotWindow(
  horizon: WeatherHorizonKind,
  fetchedAt: Date,
): { staleAfter: string; validUntil: string } {
  const fresh = SNAPSHOT_FRESH_MINUTES[horizon];
  const valid = SNAPSHOT_VALID_MINUTES[horizon];
  return {
    staleAfter: new Date(fetchedAt.getTime() + fresh * 60_000).toISOString(),
    validUntil: new Date(fetchedAt.getTime() + valid * 60_000).toISOString(),
  };
}

/** What a dataset actually turned out to hold, for the stored `horizon`. */
export function horizonOf(dataset: WeatherDataset): WeatherHorizonKind {
  let forecast = false;
  let pattern = false;
  for (const day of dataset.days) {
    if (day.kind === 'forecast') forecast = true;
    else if (day.kind === 'historical_pattern') pattern = true;
  }
  if (forecast && pattern) return 'mixed';
  if (forecast) return 'forecast';
  if (pattern) return 'historical_pattern';
  return 'none';
}

/**
 * A dataset of `unavailable` days, built without touching anything.
 *
 * The render path's answer when there is no snapshot, and the reason it can be
 * an answer at all: every downstream surface already handles `unavailable`
 * honestly, so "we have not fetched this" flows through the board, the planner
 * and the itinerary as a stated absence rather than as a crash or — far worse —
 * as a fair day.
 *
 * Solar is still computed. The sun is not a prediction and does not come from a
 * provider, so having no forecast must not take the daylight with it: a
 * daylight-only site still has to be scheduled inside the light whether or not
 * anybody knows what the sky is doing.
 *
 * This function is the reason `lib/region.ts` no longer imports the weather
 * module at all. It used to reach `weatherProviderFor('off')` for the same
 * result, which meant the render path statically depended on the file that
 * chooses and runs the live provider — one edit away from fetching again.
 */
export function unavailableWeatherDataset(input: {
  regionId: string;
  locations: readonly WeatherLocation[];
  dates: readonly string[];
  now: Date;
  reason: 'not_configured' | 'provider_error' | 'outside_supported_range';
  message: string;
  provider?: string;
}): WeatherDataset {
  const generatedAt = input.now.toISOString();
  const provider = input.provider ?? 'not-fetched';
  return weatherDatasetSchema.parse({
    version: 1,
    regionId: input.regionId,
    locations: input.locations,
    days: input.locations.flatMap((location) =>
      input.dates.map((date) => ({
        kind: 'unavailable' as const,
        locationId: location.id,
        date,
        reason: input.reason,
        message: input.message,
        attemptedProvider: provider,
        attemptedAt: generatedAt,
        /*
         * False, and it matters. A render path has not "considered a cache" — it
         * has read the one stored snapshot and found none. Claiming otherwise
         * would tell a reader that recovery had been attempted when the entire
         * design is that recovery is somebody pressing a button.
         */
        consideredCache: false,
      })),
    ),
    solar: buildSolarDays({
      locations: input.locations,
      dates: input.dates,
      utcOffsetMinutesFor: (location, date) => utcOffsetMinutesOn(date, location.timeZone),
      computedAt: generatedAt,
    }),
    generatedAt,
    providerName: provider,
  });
}
