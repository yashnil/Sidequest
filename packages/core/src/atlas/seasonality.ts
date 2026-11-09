import type { Experience } from '../advisor/catalog/schema';

/**
 * ACTIVITY-SPECIFIC SEASONALITY, FROM MEASURED CLIMATE.
 *
 * "In season" is not a property of a place. Tyrol in March is in season for
 * skiing and out of season for hut-to-hut walking; Kerala in July is fine for
 * food and temples and poor for a beach; the Serengeti in April is green and
 * wet, which is a different safari from the dry-season one. A single curve per
 * destination cannot say any of that, and the snow cap this replaces was the
 * first of what would have been many patches on one.
 *
 * So the question asked here is always *this activity, this place, this month*,
 * and it is answered from numbers a traveller could check: thirty-year monthly
 * normals of daily high, daily low and precipitation where people stay and at
 * trekking altitude above it, a snowpack modelled from those, the long-term
 * sea-surface temperature of the nearest water, and day length from latitude.
 *
 * What this is and is not:
 *
 * - **A normal, not a forecast.** Every sentence it produces is about a typical
 *   year. The shortlist says "usually" and checks the picks against records.
 * - **A model of feasibility and comfort, not of quality.** It knows the trail
 *   is under snow; it does not know the wildebeest crossed early this year.
 *   Where a rule stands in for something unmeasured (a safari's dry season) the
 *   basis says so (`rule`).
 * - **Unknown is unknown.** With no climate for a place the answer is `null`,
 *   which the scorer treats as unmeasured — never as a good month and never as
 *   a closed one.
 *
 * Pure: arithmetic on arrays, no I/O, no clock.
 */

/** Twelve values, January first. */
export type Monthly = readonly number[];

export interface ClimatePoint {
  elevM: number;
  /** Mean daily maximum, °C. */
  tmax: Monthly;
  /** Mean daily minimum, °C. */
  tmin: Monthly;
  /** Precipitation, mm per month. */
  pr: Monthly;
}

export interface SeasonInputs {
  lat: number;
  /** Where people stay. */
  base: ClimatePoint;
  /** The highest ground inside the destination, when it stands well above the base. */
  high: ClimatePoint | null;
  /** Sea-surface temperature of the nearest sea, °C, when there is a coast. */
  sst: Monthly | null;
  /** Great-circle km from the centre to the sea; null when inland. */
  coastKm: number | null;
  /** Mean cloud cover by month, %, when held. */
  cloud?: Monthly | null;
  /** Mean significant wave height by month, m, for a coast the wave grid resolves; NaN under sea ice. */
  waves?: Monthly | null;
}

export const ACTIVITIES = [
  'hike_low',
  'hike_high',
  'beach',
  'dive',
  'ski',
  'winter',
  'safari',
  'wild',
  'city',
  'desert',
  'drive',
  'paddle',
  'sky',
  'scenery',
  'any',
] as const;
export type Activity = (typeof ACTIVITIES)[number];

/** What limits an activity in a month, in the order the sentence prefers them. */
export type Limit =
  | 'snow_on_trails'
  | 'too_cold'
  | 'too_hot'
  | 'rains'
  | 'sea_too_cold'
  | 'no_snow'
  | 'short_days'
  | 'frozen_water'
  | 'bright_nights'
  | 'storm_season'
  | 'cloud'
  | 'rough_sea'
  | 'no_sea';

export interface MonthFit {
  /** 0 = not feasible … 1 = as good as it gets. */
  value: number;
  /** The factor that most holds the month back, when one does. */
  limit: Limit | null;
}

export const LIMIT_WORDS: Record<Limit, string> = {
  snow_on_trails: 'snow on the trails',
  too_cold: 'cold',
  too_hot: 'heat',
  rains: 'the rains',
  sea_too_cold: 'a cold sea',
  no_snow: 'no reliable snow',
  short_days: 'very short days',
  frozen_water: 'frozen water',
  bright_nights: 'nights that never get dark',
  storm_season: 'storm season',
  cloud: 'cloudy skies',
  rough_sea: 'rough seas',
  no_sea: 'no sea nearby',
};

/** Which activity's season each experience follows. */
export const EXPERIENCE_ACTIVITY: Record<Experience, Activity> = {
  day_hiking: 'hike_low',
  multi_day_trekking: 'hike_high',
  high_mountains: 'hike_high',
  glaciers_ice: 'scenery',
  volcanoes_geothermal: 'hike_low',
  lakes: 'paddle',
  beaches_swimming: 'beach',
  coastal_scenery: 'scenery',
  snorkel_dive: 'dive',
  paddling_boating: 'paddle',
  big_game_safari: 'safari',
  wildlife_general: 'wild',
  marine_wildlife: 'scenery',
  birding: 'wild',
  rainforest_biodiversity: 'wild',
  desert_landscapes: 'desert',
  scenic_driving: 'drive',
  rail_journeys: 'city',
  winter_snow: 'ski',
  hot_springs_wellness: 'any',
  villages_culture: 'city',
  food: 'city',
  city_life: 'city',
  night_skies: 'sky',
};

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/** 0 below `a`, rising to 1 at `b`, 1 until `c`, falling to 0 at `d`. */
function trapezoid(x: number, a: number, b: number, c: number, d: number): number {
  if (x <= a || x >= d) return 0;
  if (x < b) return (x - a) / (b - a);
  if (x <= c) return 1;
  return (d - x) / (d - c);
}

/** 1 at or below `good`, falling linearly to `floor` at `bad` and beyond. */
function falling(x: number, good: number, bad: number, floor: number): number {
  if (x <= good) return 1;
  if (x >= bad) return floor;
  return 1 - ((x - good) / (bad - good)) * (1 - floor);
}

/** Hours of daylight on the fifteenth of a month at a latitude (Forsythe et al. 1995, to the minute at these scales). */
export function daylightHours(lat: number, month: number): number {
  const day = [15, 46, 74, 105, 135, 166, 196, 227, 258, 288, 319, 349][month - 1]!;
  const theta = 0.2163108 + 2 * Math.atan(0.9671396 * Math.tan(0.0086 * (day - 186)));
  const declination = Math.asin(0.39795 * Math.cos(theta));
  const phi = (lat * Math.PI) / 180;
  const x = (Math.sin((0.8333 * Math.PI) / 180) + Math.sin(phi) * Math.sin(declination)) / (Math.cos(phi) * Math.cos(declination));
  if (x >= 1) return 24;
  if (x <= -1) return 0;
  return 24 - (24 / Math.PI) * Math.acos(x);
}

/**
 * A monthly snowpack, in mm of water, from normals alone.
 *
 * A degree-day model: precipitation falls as snow when the month is cold, the
 * pack melts in proportion to the warmth above freezing, and the year is run
 * until it repeats. The melt term includes a share of the daily maximum because
 * a month averaging −2 °C with afternoons at +4 °C still loses snow. It is the
 * same family of model that gridded snow products are built on, at a fraction
 * of their fidelity — good for "is the pass under snow in May", not for "how
 * deep". `modelledSnow` is therefore an estimate and is labelled as one.
 */
export function modelledSnow(point: ClimatePoint): number[] {
  const swe = new Array<number>(12).fill(0);
  let pack = 0;
  for (let year = 0; year < 5; year += 1) {
    for (let month = 0; month < 12; month += 1) {
      const tmax = point.tmax[month]!;
      const tmean = (tmax + point.tmin[month]!) / 2;
      const snowShare = clamp01((3 - tmean) / 4);
      const fall = point.pr[month]! * snowShare;
      const warmth = Math.max(0, tmean) + 0.3 * Math.max(0, Math.min(tmax, 8) - Math.max(0, tmean));
      const melt = 3.2 * 30 * warmth;
      pack = Math.max(0, Math.min(4000, pack + fall - melt));
      swe[month] = pack;
    }
  }
  return swe.map((value) => Math.round(value));
}

/** The highest a normal trekking route goes; above it a "high point" is a summit, not a trail. */
const TREK_CEILING_M = 4700;
/** How far above where people stay the high routes run, at most: huts and passes, not summits. */
const TREK_RISE_M = 1900;

/**
 * Climate at an altitude between the base and the high point, by linear
 * interpolation of the two measured columns — each destination's own lapse
 * rate, month by month, rather than a textbook constant.
 */
export function climateAt(inputs: Pick<SeasonInputs, 'base' | 'high'>, elevM: number): ClimatePoint {
  const { base, high } = inputs;
  if (!high || high.elevM <= base.elevM + 50) return base;
  const share = clamp01((elevM - base.elevM) / (high.elevM - base.elevM));
  const mix = (a: Monthly, b: Monthly) => a.map((value, index) => value + (b[index]! - value) * share);
  return { elevM, tmax: mix(base.tmax, high.tmax), tmin: mix(base.tmin, high.tmin), pr: mix(base.pr, high.pr) };
}

/**
 * Where the high trails run: halfway to the highest ground, but never more
 * than a hut-and-pass rise above the base nor above the trekking ceiling. The
 * highest cell in a great range is a summit nobody walks to; halving the gap to
 * an 8,000 m peak would put the "trail" on a glacier and call July snowbound.
 */
export function trekAltitude(inputs: Pick<SeasonInputs, 'base' | 'high'>): number {
  if (!inputs.high) return inputs.base.elevM;
  const relief = inputs.high.elevM - inputs.base.elevM;
  return Math.max(inputs.base.elevM, Math.min(inputs.base.elevM + Math.min(0.5 * relief, TREK_RISE_M), TREK_CEILING_M));
}

/** Where the lifts run: halfway up. */
function skiAltitude(inputs: Pick<SeasonInputs, 'base' | 'high'>): number {
  if (!inputs.high) return inputs.base.elevM;
  return Math.min(inputs.base.elevM + 0.5 * (inputs.high.elevM - inputs.base.elevM), 3600);
}

/**
 * Tropical-cyclone seasons by basin, as months in which a named storm is a
 * realistic part of planning (NOAA NHC / JTWC / BoM basin climatologies). A
 * historical likelihood, never a prediction: it trims a beach month, it does
 * not close it.
 */
function stormSeason(lat: number, lng: number, month: number): boolean {
  const within = (months: number[]) => months.includes(month);
  if (lat >= 9 && lat <= 35 && lng >= -98 && lng <= -55) return within([8, 9, 10]);
  if (lat >= 10 && lat <= 28 && lng >= -118 && lng < -98) return within([8, 9, 10]);
  if (lat >= 8 && lat <= 35 && lng >= 105 && lng <= 150) return within([7, 8, 9, 10]);
  if (lat >= 8 && lat <= 24 && lng >= 78 && lng < 100) return within([5, 10, 11]);
  if (lat <= -8 && lat >= -28 && ((lng >= 40 && lng <= 70) || (lng >= 110 && lng <= 180) || lng <= -140)) return within([1, 2, 3]);
  return false;
}

export interface SeasonModel {
  /** Suitability of every activity in every month. */
  fit: Record<Activity, MonthFit[]>;
  /** Modelled snow on the ground, mm water equivalent, at the base and at trekking altitude. */
  snow: { base: number[]; trek: number[]; trekElevM: number };
}

function worst(parts: [number, Limit | null][]): MonthFit {
  let value = 1;
  let limit: Limit | null = null;
  let lowest = 1;
  for (const [part, why] of parts) {
    value *= part;
    if (part < lowest - 1e-9) {
      lowest = part;
      limit = why;
    }
  }
  return { value: clamp01(value), limit: lowest < 0.85 ? limit : null };
}

/**
 * The whole model for one destination: fifteen activities by twelve months.
 * `lng` is only for the storm basins.
 */
export function seasonModel(inputs: SeasonInputs, lng = 0): SeasonModel {
  const { base, lat } = inputs;
  /*
   * The high trails are the highest ground that actually melts out. In the
   * Alps that is hut level; under a Patagonian ice cap or in Alaska it is far
   * lower, and calling the ice "the trail" would say the walking season never
   * comes. So the default altitude is lowered, a step at a time, until the
   * modelled pack is gone for at least two months — or the base is reached.
   */
  let trekElevM = trekAltitude(inputs);
  if (inputs.high) {
    for (let step = 0; step < 14 && trekElevM > base.elevM + 150; step += 1) {
      const pack = modelledSnow(climateAt(inputs, trekElevM));
      if (pack.filter((value) => value < 25).length >= 2) break;
      trekElevM -= 150;
    }
    trekElevM = Math.max(base.elevM, trekElevM);
  }
  const trek = climateAt(inputs, trekElevM);
  const ski = climateAt(inputs, skiAltitude(inputs));
  const snowBase = modelledSnow(base);
  const snowTrek = inputs.high ? modelledSnow(trek) : snowBase;
  const snowSki = inputs.high ? modelledSnow(ski) : snowBase;
  const relief = inputs.high ? inputs.high.elevM - base.elevM : 0;
  const coastal = inputs.coastKm !== null && inputs.coastKm <= 30;

  const fit = Object.fromEntries(ACTIVITIES.map((activity) => [activity, [] as MonthFit[]])) as Record<Activity, MonthFit[]>;
  for (let index = 0; index < 12; index += 1) {
    const month = index + 1;
    const tmax = base.tmax[index]!;
    const tmin = base.tmin[index]!;
    const pr = base.pr[index]!;
    const tmean = (tmax + tmin) / 2;
    const light = daylightHours(lat, month);
    const days: [number, Limit | null] = [light >= 8 ? 1 : 0.35 + 0.65 * clamp01((light - 3) / 5), 'short_days'];
    const heatOrCold = (value: number, x: number, coldBelow: number): [number, Limit | null] => [value, x < coldBelow ? 'too_cold' : 'too_hot'];
    const muggy = tmin >= 24 ? 0.85 : 1;

    /* Walking where people stay: comfort, rain, snow underfoot, daylight. */
    fit.hike_low.push(
      worst([
        heatOrCold(trapezoid(tmax, -3, 9, 27, 37) * muggy, tmax, 15),
        [falling(pr, 90, 380, 0.3), 'rains'],
        [falling(snowBase[index]!, 15, 70, 0.05), 'snow_on_trails'],
        days,
      ]),
    );

    /* The high routes: the same questions asked at trekking altitude. Without real relief there are none, and the low answer stands. */
    if (inputs.high) {
      const hx = trek.tmax[index]!;
      fit.hike_high.push(
        worst([
          heatOrCold(trapezoid(hx, -4, 5, 24, 33), hx, 12),
          [falling(trek.pr[index]!, 110, 420, 0.3), 'rains'],
          [falling(snowTrek[index]!, 25, 160, 0.04), 'snow_on_trails'],
          days,
        ]),
      );
    } else {
      fit.hike_high.push(fit.hike_low[index]!);
    }

    /* Swimming: the sea first, then the air, then the rain. Inland there is no beach month at all. */
    const storm: [number, Limit | null] = [stormSeason(lat, lng, month) ? 0.75 : 1, 'storm_season'];
    const hs = inputs.waves?.[index];
    /* Half a metre is a calm bay; past two metres a beach is for watching and a dive boat stays in. */
    const swell: [number, Limit | null] = [hs === undefined || Number.isNaN(hs) ? 1 : falling(hs, 1.2, 3, 0.5), 'rough_sea'];
    const boats: [number, Limit | null] = [hs === undefined || Number.isNaN(hs) ? 1 : falling(hs, 1.5, 3.5, 0.45), 'rough_sea'];
    if (coastal && inputs.sst) {
      const sea = inputs.sst[index]!;
      /* 25 °C is a bath; 22 is fine; 19 is brisk and people do swim in it; under 17 almost nobody does. */
      const seaFit = sea >= 25 ? 1 : sea >= 22 ? 0.6 + 0.4 * ((sea - 22) / 3) : sea >= 19 ? 0.28 + 0.32 * ((sea - 19) / 3) : sea >= 17 ? 0.08 + 0.2 * ((sea - 17) / 2) : 0.04;
      fit.beach.push(worst([[seaFit, 'sea_too_cold'], heatOrCold(trapezoid(tmax, 18, 25, 33, 40), tmax, 25), [falling(pr, 110, 340, 0.4), 'rains'], storm, swell]));
      const diveFit = sea >= 24 ? 1 : sea >= 19 ? 0.45 + 0.55 * ((sea - 19) / 5) : 0.3;
      fit.dive.push(worst([[diveFit, 'sea_too_cold'], [falling(pr, 150, 420, 0.55), 'rains'], storm, boats]));
    } else if (coastal) {
      /* A coast with no sea temperature on record: judged on the air alone, at reduced strength. */
      fit.beach.push(worst([heatOrCold(trapezoid(tmax, 20, 27, 33, 40) * 0.8, tmax, 27), [falling(pr, 110, 340, 0.4), 'rains'], storm]));
      fit.dive.push(worst([heatOrCold(0.3 + 0.5 * trapezoid(tmax, 16, 26, 36, 44), tmax, 26), storm]));
    } else {
      fit.beach.push({ value: 0, limit: 'no_sea' });
      fit.dive.push({ value: 0, limit: 'no_sea' });
    }

    /* Skiing needs a slope and a pack on it. */
    const pack = snowSki[index]!;
    const packFit = pack >= 120 ? 1 : pack >= 30 ? 0.25 + 0.75 * ((pack - 30) / 90) : pack >= 8 ? 0.1 : 0;
    const slope = relief >= 500 ? 1 : relief >= 250 ? 0.6 : 0.3;
    fit.ski.push(worst([[packFit * slope, 'no_snow'], [ski.tmax[index]! <= 6 ? 1 : falling(ski.tmax[index]!, 6, 13, 0.3), 'too_hot'], days]));

    /* Winter for its own sake: snow where you sleep. */
    const groundSnow = snowBase[index]!;
    fit.winter.push(worst([[groundSnow >= 40 ? 1 : groundSnow >= 10 ? 0.5 : tmax <= 1 ? 0.3 : 0, 'no_snow'], days]));

    /* A dry-season rule: game gathers at water and the grass is short. An estimate standing in for what is not measured. */
    fit.safari.push(worst([[pr <= 35 ? 1 : pr <= 90 ? 0.85 : pr <= 160 ? 0.6 : pr <= 260 ? 0.4 : 0.25, 'rains'], heatOrCold(trapezoid(tmax, 5, 16, 35, 43), tmax, 20)]));

    /* Forests and general wildlife never close; the rain decides how pleasant. */
    fit.wild.push(worst([[falling(pr, 160, 450, 0.45), 'rains'], heatOrCold(0.4 + 0.6 * trapezoid(tmax, -8, 8, 33, 41), tmax, 15), days]));

    /* Towns work all year; extremes and deluges take the edge off. */
    fit.city.push(worst([heatOrCold(0.35 + 0.65 * trapezoid(tmax, -8, 9, 30, 40), tmax, 15), [falling(pr, 170, 480, 0.6), 'rains'], [light >= 6 ? 1 : 0.8, 'short_days']]));

    fit.desert.push(worst([heatOrCold(trapezoid(tmax, 2, 15, 31, 41), tmax, 20), [tmin >= -6 ? 1 : 0.7, 'too_cold']]));

    /* Driving: snow where the road is, and on the passes above it. */
    fit.drive.push(
      worst([
        [falling(snowBase[index]!, 20, 90, 0.2), 'snow_on_trails'],
        [inputs.high && relief >= 900 ? falling(snowTrek[index]!, 60, 300, 0.6) : 1, 'snow_on_trails'],
        [falling(pr, 170, 450, 0.55), 'rains'],
        heatOrCold(0.5 + 0.5 * trapezoid(tmax, -6, 6, 34, 44), tmax, 15),
        days,
      ]),
    );

    fit.paddle.push(worst([[tmean <= -1 ? 0.05 : 1, 'frozen_water'], heatOrCold(trapezoid(tmax, 5, 17, 31, 39), tmax, 20), [falling(pr, 130, 400, 0.45), 'rains']]));

    /* Night skies need night. */
    fit.sky.push(worst([[light <= 15 ? 1 : light >= 21 ? 0.05 : 1 - 0.95 * ((light - 15) / 6), 'bright_nights'], inputs.cloud ? [falling(inputs.cloud[index]!, 35, 85, 0.25), 'cloud'] : [falling(pr, 120, 380, 0.5), 'rains']]));

    /* Being outside by the sea or among ice without getting in: wider comfort than a hike, no swimming needed. */
    fit.scenery.push(worst([heatOrCold(trapezoid(tmax, -2, 11, 30, 39), tmax, 15), [falling(pr, 110, 380, 0.4), 'rains'], days]));

    fit.any.push(worst([heatOrCold(0.5 + 0.5 * trapezoid(tmax, -10, 6, 31, 41), tmax, 15)]));
  }
  return { fit, snow: { base: snowBase, trek: snowTrek, trekElevM: Math.round(trekElevM) } };
}

/** Climate reconstructed from an editorial reading (highs and a 0–3 wetness), for a place with no measured normals. */
export function climateFromEditorial(highC: Monthly, wet: Monthly, elevM = 0): ClimatePoint {
  const WET_MM = [15, 60, 140, 280];
  return { elevM, tmax: [...highC], tmin: highC.map((value) => value - 9), pr: wet.map((level) => WET_MM[Math.round(level)] ?? 60) };
}

/**
 * How good each month is for what one traveller wants to do at one place.
 *
 * Each wanted experience follows its own activity curve, weighted by how much
 * the traveller wants it *and* how much the place offers it — the season that
 * counts is the season of what they would actually do there. With nothing
 * wanted, the place's own strengths stand in.
 */
export function travellerSeason(
  model: SeasonModel,
  wants: Partial<Record<Experience, number>>,
  offers: Partial<Record<Experience, number>>,
): { months: MonthFit[]; drivers: Activity[] } {
  const weights = new Map<Activity, number>();
  let total = 0;
  const add = (experience: Experience, weight: number) => {
    if (weight <= 0) return;
    const activity = EXPERIENCE_ACTIVITY[experience];
    weights.set(activity, (weights.get(activity) ?? 0) + weight);
    total += weight;
  };
  for (const [experience, want] of Object.entries(wants) as [Experience, number][]) add(experience, want * ((offers[experience] ?? 0) / 3));
  if (total === 0) for (const [experience, offer] of Object.entries(offers) as [Experience, number][]) add(experience, (offer / 3) ** 2);
  if (total === 0) {
    weights.set('any', 1);
    total = 1;
  }
  const drivers = [...weights.entries()].sort((a, b) => b[1] - a[1]).map(([activity]) => activity);
  const months: MonthFit[] = [];
  for (let index = 0; index < 12; index += 1) {
    let value = 0;
    let limit: Limit | null = null;
    let heaviest = 0;
    for (const [activity, weight] of weights) {
      const month = model.fit[activity][index]!;
      value += (weight / total) * month.value;
      /* The sentence names what limits the activity that matters most. */
      const drag = weight * (1 - month.value);
      if (month.limit && drag > heaviest) {
        heaviest = drag;
        limit = month.limit;
      }
    }
    months.push({ value: clamp01(value), limit: value < 0.75 ? limit : null });
  }
  return { months, drivers };
}
