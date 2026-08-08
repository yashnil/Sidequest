import 'server-only';
import {
  haversineKm,
  type BenchmarkGroundTruth,
  type BenchmarkTripRequest,
  type DayOpening,
  type FoodVenueFacts,
  type InventoryEntry,
  type SolarDay,
} from '@sidequest/bench';
import {
  findSolarDay,
  findWeatherLocationForPlace,
  findOperatingCalendar,
  operatingOn,
  type CompiledRegion,
  type FoodVenue,
  type MealPeriod,
  type OperatingCalendar,
  type Place,
  type WeatherDataset,
} from '@sidequest/core';
import { tryLeg } from '@sidequest/geo';

/**
 * THE WORLD, NOT A PLAN.
 *
 * This is the instance both arms are judged against, and that is the whole
 * argument for it living here rather than in the arm that happens to have
 * compiled it. The compiled region is a record of what open data says about a
 * piece of ground: when things open, how long a road takes, when the sun sets,
 * what a venue says it cannot cook. None of it is a decision either system made,
 * and a language model planning the same trip is describing the same ground.
 *
 * The alternative was to give each arm its own facts. That is worse in the
 * direction that matters: a plan checked against its own author's beliefs cannot
 * be wrong about the world, so the arm with the smaller world would score best.
 *
 * Three rules keep it a port rather than an advantage.
 *
 * **Nothing planner-shaped crosses.** No candidate scores, no fit assessment, no
 * board, no configuration. Every accessor answers a question about a place, a
 * date or a pair of coordinates.
 *
 * **Places are addressed by the shared identity.** The index below is keyed on
 * the source database's own element id — the thing both arms can produce — and
 * emphatically not on the compiled place id, which only one of them can. A place
 * the inventory never linked is unreachable here, and every check about it
 * returns `unknown`, which is the correct answer rather than a gap.
 *
 * **`null` means "not established", never "no".** Every accessor returns it
 * rather than a default, because a default is how a check silently starts
 * grading a guess.
 */

export interface GroundTruthInput {
  request: BenchmarkTripRequest;
  compiled: CompiledRegion;
  /**
   * The sky, which is not part of the artifact and never will be.
   *
   * A compiled region is cached and reused; a forecast baked into one is how a
   * September traveller is shown August's weather. So the dataset is trip-scoped
   * and passed in, and a session that never fetched one gets `null` — which
   * makes every daylight question `unknown` rather than inventing a sunset.
   */
  weather?: WeatherDataset | null;
  /** Injected, so a plan does not score differently on a Tuesday. */
  now: Date;
}

export function compiledRegionGroundTruth(input: GroundTruthInput): BenchmarkGroundTruth {
  const { compiled } = input;

  const places = new Map<string, Place>();
  for (const place of compiled.places) {
    const entityId = place.source.element?.elementId;
    if (entityId) places.set(entityId, place);
  }

  const venues = new Map<string, FoodVenue>();
  for (const venue of compiled.food?.venues ?? []) {
    const entityId = venue.source.element?.elementId;
    if (entityId) venues.set(entityId, venue);
  }

  const calendars = new Map<string, OperatingCalendar>();
  for (const place of places.values()) {
    const calendar = findOperatingCalendar(compiled.operatingHours, place.id);
    if (calendar) calendars.set(place.id, calendar);
  }

  /*
   * Which approaches the region holds for each place, so "do you need a car"
   * can be answered from the record rather than from the road surface. A place
   * every rule reaches by driving needs one; a place with a shuttle, a bus or a
   * walk-in does not; a place with no rule at all has no answer, and says so.
   */
  const approaches = new Map<string, Set<string>>();
  for (const rule of compiled.access.rules) {
    for (const placeId of rule.placeIds) {
      const modes = approaches.get(placeId) ?? new Set<string>();
      modes.add(rule.approachMode);
      approaches.set(placeId, modes);
    }
  }

  const entryFor = (entityId: string): InventoryEntry | null => {
    const place = places.get(entityId);
    if (!place) return null;
    const modes = approaches.get(place.id);
    return {
      entityId,
      name: place.name,
      latitude: place.coordinates.lat,
      longitude: place.coordinates.lng,
      typicalDurationMinutes: place.typicalDurationMinutes,
      /*
       * A signed daylight-only restriction is a published rule about a gate, and
       * the artifact does not carry one as such — what it carries is a weather
       * profile about visibility and exposure, which is a different claim. Null
       * rather than false: "nobody said" is what is true here, and a false would
       * read as "somebody checked and it is open after dark".
       */
      daylightOnly: null,
      tags: tagsFor(place),
      requiresCar: modes === undefined ? null : [...modes].every((mode) => mode === 'drive'),
      unpavedApproach: place.access.roadSurface !== 'paved',
      remoteNoServices: place.access.remoteNoServices,
      strenuous: place.physicalIntensity === 'strenuous',
    };
  };

  return {
    request: input.request,
    now: input.now,

    place: entryFor,

    openingOn(entityId, date): DayOpening | null {
      const place = places.get(entityId);
      if (!place) return null;
      const calendar = calendars.get(place.id);
      if (!calendar) return null;

      const operating = operatingOn(calendar, date);
      return {
        status: operating.status,
        windows: operating.windows.map((window) => ({
          openMinute: window.openMinute,
          closeMinute: window.closeMinute,
        })),
        /*
         * Read off the window the day resolved to rather than off the calendar
         * as a whole: a summer schedule and a winter one can publish different
         * last admissions, and quoting the wrong one is the sort of error that
         * only shows up on the day.
         */
        lastAdmissionMinute: operating.windows[0]?.lastAdmissionMinute ?? null,
      };
    },

    seasonallyOpenOn(entityId, date): boolean | null {
      const place = places.get(entityId);
      if (!place) return null;
      const month = Number(date.slice(5, 7));
      if (!Number.isInteger(month) || month < 1 || month > 12) return null;
      return place.seasonalAccess.openMonths.includes(month);
    },

    solar(entityId, date): SolarDay | null {
      const place = places.get(entityId);
      if (!place) return null;
      return solarFor(input.weather ?? null, place.id, date);
    },

    routeMinutes(fromEntityId, toEntityId): number | null {
      const from = places.get(fromEntityId);
      const to = places.get(toEntityId);
      if (!from || !to) return null;
      const measured = tryLeg(compiled.travelTimes, from.id, to.id);
      if (!measured) return null;
      /*
       * Only a measured matrix answers. A modelled or estimated cell is a road
       * model's opinion, and handing one to a validator as ground truth would
       * let this arm's own estimate convict the other arm's number of being
       * wrong by fifteen minutes.
       */
      return compiled.travelTimes.provenance.kind === 'measured' ? measured.minutes : null;
    },

    straightLineKm(fromEntityId, toEntityId): number | null {
      const from = places.get(fromEntityId) ?? venues.get(fromEntityId);
      const to = places.get(toEntityId) ?? venues.get(toEntityId);
      if (!from || !to) return null;
      return haversineKm(
        { latitude: from.coordinates.lat, longitude: from.coordinates.lng },
        { latitude: to.coordinates.lat, longitude: to.coordinates.lng },
      );
    },

    food(entityId): FoodVenueFacts | null {
      const venue = venues.get(entityId);
      if (!venue) return null;
      return {
        entityId,
        name: venue.name,
        latitude: venue.coordinates.lat,
        longitude: venue.coordinates.lng,
        servesSlots: slotsFor(venue.mealPeriods),
        /*
         * Only what the venue itself refused. `unknown` is the common answer and
         * it is not a refusal — reading silence as "cannot" would convict a plan
         * of a conflict nobody stated.
         */
        cannotAccommodate: venue.dietary
          .filter((claim) => claim.evidence === 'venue_states_unsuitable')
          .map((claim) => claim.need),
      };
    },

    /**
     * WHETHER A CITED SOURCE ACTUALLY SAYS THAT.
     *
     * Unanswerable from here, and `null` rather than an optimistic `true`.
     *
     * `sourceIndex` points into *a plan's own* source list. This object is
     * shared between the two arms by construction, so it cannot hold one plan's
     * list without holding the other's — and resolving an index against the
     * wrong list would confirm claims at random. The honest reading is that the
     * benchmark did not retrieve these pages itself and cannot vouch for them,
     * which is exactly what a `null` means everywhere else in this port.
     */
    supportsClaim(): boolean | null {
      return null;
    },
  };
}

/* ------------------------------------------------------------------ *
 * Facts, flattened into the shared tag vocabulary
 * ------------------------------------------------------------------ */

/**
 * What kind of place this is, in words a neutral checker can match.
 *
 * Every entry is a fact the artifact already states — a category, an interest
 * the place genuinely satisfies, a road surface, a crowd level — rather than a
 * judgement made here. That matters because the avoidance check convicts a plan
 * on these: a tag invented to be helpful would fabricate a violation, and a tag
 * withheld would hide one.
 */
function tagsFor(place: Place): string[] {
  const tags = new Set<string>([place.category, ...place.tags, ...place.interests]);

  if (place.physicalIntensity === 'strenuous') tags.add('strenuous');
  if (place.access.roadSurface === 'unpaved') tags.add('unpaved');
  if (place.access.roadSurface === 'partly_unpaved') tags.add('unpaved');
  if (place.access.remoteNoServices) {
    tags.add('remote');
    tags.add('no_services');
  }
  if (place.access.mountainRoad) tags.add('mountain_road');
  if (place.crowdLevel === 'very_busy') tags.add('very_busy');
  if (place.crowdLevel === 'busy') tags.add('crowded');
  if (place.costLevel === 3) tags.add('expensive');
  if (place.bestTimeOfDay === 'sunrise') tags.add('sunrise');
  if (place.category === 'day_hike' && place.typicalDurationMinutes >= 240) tags.add('long_hike');

  return [...tags];
}

/**
 * Which slots a venue can fill.
 *
 * `coffee` becomes `snack` rather than `breakfast`: a place that serves coffee
 * has not said it serves a meal, and the neutral vocabulary's `breakfast` is a
 * meal. `groceries` fills no slot at all — buying the makings of a lunch is a
 * provisioning stop, and the plan says so with its own stop kind.
 */
const SLOT_FOR: Record<MealPeriod, FoodVenueFacts['servesSlots'][number] | null> = {
  breakfast: 'breakfast',
  coffee: 'snack',
  lunch: 'lunch',
  snack: 'snack',
  dinner: 'dinner',
  groceries: null,
};

function slotsFor(periods: readonly MealPeriod[]): FoodVenueFacts['servesSlots'] {
  const slots = new Set<FoodVenueFacts['servesSlots'][number]>();
  for (const period of periods) {
    const slot = SLOT_FOR[period];
    if (slot) slots.add(slot);
  }
  return [...slots];
}

/**
 * Sunrise and sunset for a place on a date, where a fetched dataset holds them.
 *
 * Null when no forecast was ever fetched for this trip, which is why an
 * unfetched session scores daylight questions as unknown rather than as
 * violations. Guessing at a sunset from a latitude would be inventing the one
 * fact a daylight-only visit turns on.
 */
function solarFor(
  weather: WeatherDataset | null,
  placeId: string,
  date: string,
): SolarDay | null {
  if (!weather) return null;

  const location = findWeatherLocationForPlace(weather, placeId);
  if (!location) return null;
  const solar = findSolarDay(weather, location.id, date);
  if (!solar) return null;

  /*
   * Polar days and nights are read off the numbers rather than off a flag,
   * because the dataset has no flag and the arithmetic is unambiguous: a sunset
   * that never comes and a sunrise that never comes are both representable as a
   * degenerate window, and calling either "normal" would let a plan schedule a
   * daylight-only walk into permanent darkness.
   */
  const daylight = solar.sunsetMinute - solar.sunriseMinute;
  const kind: SolarDay['kind'] =
    daylight >= 1439 ? 'polar_day' : daylight <= 0 ? 'polar_night' : 'normal';

  return { sunriseMinute: solar.sunriseMinute, sunsetMinute: solar.sunsetMinute, kind };
}
