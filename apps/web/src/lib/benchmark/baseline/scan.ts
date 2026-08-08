import type { BenchmarkTripRequest } from '@sidequest/bench';
import { straightLineKm } from './packet';
import type { ResearchPacket } from './packet-types';

/**
 * THE PRELIMINARY SCAN — EVERYTHING WORTH KNOWING BEFORE ANYBODY IS ASKED
 * ANYTHING, AND NOT ONE MODEL CALL.
 *
 * The scan reads the packet and the traveller's own statements and produces the
 * handful of facts that change a trip: how much ground the destination covers,
 * where the places actually are, which of them are shut in the trip's months,
 * whether the dates are inside a forecast horizon or only inside a climate
 * record, how long the daylight is, how the traveller will move, whether there
 * is anywhere to eat, and what would make the plan fail.
 *
 * It is a pure function, and that is what makes it worth having. Every sentence
 * it produces is re-derivable from the same inputs, so a reviewer who doubts one
 * can check it — which is exactly the property a model-written summary of the
 * same material would not have. The model's turn comes later and comes once.
 *
 * What the scan explicitly does *not* do: score a place, rank a base, assign a
 * cluster to a day, or decide what is worth visiting. Those are the four things
 * under test, and a scan that pre-empted them would hand this arm the answer.
 */

export const SCAN_VERSION = 1 as const;

export type ScanScale = 'walkable' | 'compact' | 'regional' | 'dispersed' | 'unknown';

export type TransportMode = 'walk' | 'drive' | 'transit' | 'mixed' | 'unknown';

export interface ScanClusterNote {
  clusterIndex: number;
  placeCount: number;
  spreadKm: number;
  /** Straight-line km from the destination centre. Never a travel time. */
  kmFromCentre: number;
}

export interface PreliminaryScan {
  version: typeof SCAN_VERSION;
  scale: ScanScale;
  /** How far the furthest packet place sits from the destination centre. */
  extentKm: number | null;
  clusters: readonly ScanClusterNote[];
  likelyBases: readonly { name: string; kmFromCentre: number; basis: string }[];
  transport: {
    mode: TransportMode;
    /** Why, in the traveller's own stated terms. Never an inference about them. */
    basis: string;
    /** Places the packet says need a car, when the traveller has none. */
    unreachableWithoutCar: number;
  };
  seasonalAccess: {
    closedInSeason: readonly { placeIndex: number; name: string; note: string }[];
    unknownCount: number;
  };
  weather: {
    /** What kind of evidence the dates got, and for how many of them. */
    forecastDays: number;
    climateDays: number;
    unknownDays: number;
    semantics: string;
  };
  daylight: {
    shortestDaylightMinutes: number | null;
    longestDaylightMinutes: number | null;
    polarDays: number;
    note: string;
  };
  food: {
    venueCount: number;
    clustersWithFood: number;
    clustersWithoutFood: number;
    note: string;
  };
  hours: {
    knownCount: number;
    alwaysOpenCount: number;
    unknownCount: number;
  };
  /** What would make this plan fail, stated as risks rather than as defects. */
  feasibilityRisks: readonly string[];
  /** What nobody established. Carried into the plan's own `unknowns`. */
  unknowns: readonly string[];
}

export function runPreliminaryScan(input: {
  request: BenchmarkTripRequest;
  packet: ResearchPacket;
}): PreliminaryScan {
  const { request, packet } = input;
  const centre = {
    latitude: packet.destination.latitude,
    longitude: packet.destination.longitude,
  };

  const distances = packet.places.map((place) => straightLineKm(centre, place));
  const extentKm = distances.length > 0 ? round(Math.max(...distances), 1) : null;

  const clusters: ScanClusterNote[] = packet.clusters.map((cluster) => ({
    clusterIndex: cluster.index,
    placeCount: cluster.placeIndices.length,
    spreadKm: cluster.spreadKm,
    kmFromCentre: round(
      straightLineKm(centre, {
        latitude: cluster.centreLatitude,
        longitude: cluster.centreLongitude,
      }),
      1,
    ),
  }));

  const transport = describeTransport(request, packet);

  return {
    version: SCAN_VERSION,
    scale: describeScale(extentKm, packet.destination.radiusKm),
    extentKm,
    clusters,
    likelyBases: packet.baseCandidates.map((candidate) => ({
      name: candidate.name,
      kmFromCentre: round(
        straightLineKm(centre, {
          latitude: candidate.latitude,
          longitude: candidate.longitude,
        }),
        1,
      ),
      basis: candidate.basis,
    })),
    transport,
    seasonalAccess: describeSeasonalAccess(packet),
    weather: describeWeather(packet),
    daylight: describeDaylight(packet),
    food: describeFood(packet),
    hours: describeHours(packet),
    feasibilityRisks: feasibilityRisks({ request, packet, extentKm, transport }),
    unknowns: scanUnknowns(packet),
  };
}

/* ------------------------------------------------------------------ *
 * The individual readings
 * ------------------------------------------------------------------ */

/**
 * How much ground this is, read off the places rather than off the name.
 *
 * A destination string tells you nothing about extent — "Tokyo" and "Iceland"
 * are both one word — so the scale comes from where the inventory actually is.
 * The thresholds are stated here rather than tuned: under 3 km is a
 * neighbourhood you walk, under 25 km is a place you stay in the middle of, and
 * past 120 km the trip is a route rather than a base.
 */
function describeScale(extentKm: number | null, radiusKm: number | null): ScanScale {
  const reach = extentKm ?? radiusKm;
  if (reach === null) return 'unknown';
  if (reach <= 3) return 'walkable';
  if (reach <= 25) return 'compact';
  if (reach <= 120) return 'regional';
  return 'dispersed';
}

function describeTransport(
  request: BenchmarkTripRequest,
  packet: ResearchPacket,
): PreliminaryScan['transport'] {
  const unreachableWithoutCar = packet.places.filter(
    (place) => place.access.requiresCar === true,
  ).length;

  const stated = request.movement.preference;
  if (stated === 'drive' && request.movement.carAvailable) {
    return { mode: 'drive', basis: 'The traveller stated they would drive and have a car.', unreachableWithoutCar };
  }
  if (stated === 'public_transport') {
    return {
      mode: 'transit',
      basis: 'The traveller stated a preference for public transport.',
      unreachableWithoutCar,
    };
  }
  if (stated === 'mixed' || stated === 'guided_or_transfers') {
    return {
      mode: 'mixed',
      basis: 'The traveller stated a mixture of ways of getting around.',
      unreachableWithoutCar,
    };
  }
  if (!request.movement.carAvailable) {
    return {
      mode: request.movement.publicTransit === 'avoid' ? 'walk' : 'transit',
      basis: 'The traveller stated they have no car.',
      unreachableWithoutCar,
    };
  }
  return {
    mode: 'unknown',
    basis: 'The traveller stated no preference and the packet cannot settle it.',
    unreachableWithoutCar,
  };
}

function describeSeasonalAccess(packet: ResearchPacket): PreliminaryScan['seasonalAccess'] {
  const closedInSeason: { placeIndex: number; name: string; note: string }[] = [];
  let unknownCount = 0;
  for (const place of packet.places) {
    if (place.seasonal.state === 'closed_in_season') {
      closedInSeason.push({ placeIndex: place.index, name: place.name, note: place.seasonal.note });
    } else if (place.seasonal.state === 'unknown') {
      unknownCount += 1;
    }
  }
  return { closedInSeason, unknownCount };
}

/**
 * Which kind of weather evidence the dates got, counted rather than summarised.
 *
 * The distinction between a forecast and a climate normal is the single most
 * common place a travel plan states something it cannot know. Counting the days
 * in each bucket is what lets the generation prompt say "for these dates you may
 * describe typical conditions and may not describe a forecast" and mean it.
 */
function describeWeather(packet: ResearchPacket): PreliminaryScan['weather'] {
  let forecastDays = 0;
  let climateDays = 0;
  let unknownDays = 0;
  for (const day of packet.days) {
    if (day.weather.state === 'forecast') forecastDays += 1;
    else if (day.weather.state === 'climate') climateDays += 1;
    else unknownDays += 1;
  }

  const parts: string[] = [];
  if (forecastDays > 0) parts.push(`${forecastDays} day(s) are inside a forecast horizon`);
  if (climateDays > 0) {
    parts.push(`${climateDays} day(s) have historical climate only, which describes a typical year and not this one`);
  }
  if (unknownDays > 0) parts.push(`${unknownDays} day(s) have no weather evidence at all`);

  return {
    forecastDays,
    climateDays,
    unknownDays,
    semantics: parts.length > 0 ? `${parts.join('; ')}.` : 'No dates were examined.',
  };
}

function describeDaylight(packet: ResearchPacket): PreliminaryScan['daylight'] {
  const lengths: number[] = [];
  let polarDays = 0;
  for (const day of packet.days) {
    if (day.daylight.state === 'known') {
      lengths.push(day.daylight.sunsetMinute - day.daylight.sunriseMinute);
    } else if (day.daylight.state === 'polar_day' || day.daylight.state === 'polar_night') {
      polarDays += 1;
    }
  }
  if (lengths.length === 0) {
    return {
      shortestDaylightMinutes: null,
      longestDaylightMinutes: null,
      polarDays,
      note:
        polarDays > 0
          ? 'Every examined date is a polar day or a polar night, so an ordinary sunrise and sunset do not apply.'
          : 'No solar record was computed for these dates.',
    };
  }
  const shortest = Math.min(...lengths);
  const longest = Math.max(...lengths);
  return {
    shortestDaylightMinutes: shortest,
    longestDaylightMinutes: longest,
    polarDays,
    note: `Daylight runs from about ${formatHours(shortest)} to ${formatHours(longest)} across these dates.`,
  };
}

function describeFood(packet: ResearchPacket): PreliminaryScan['food'] {
  const venues = packet.places.filter((place) => place.food !== null);
  const withFood = new Set<number>();
  for (const venue of venues) {
    if (venue.clusterIndex !== null) withFood.add(venue.clusterIndex);
  }
  const clustersWithoutFood = packet.clusters.filter(
    (cluster) => !withFood.has(cluster.index),
  ).length;

  return {
    venueCount: venues.length,
    clustersWithFood: withFood.size,
    clustersWithoutFood,
    note:
      venues.length === 0
        ? 'The packet holds no eating place at all, so every meal is an assumption rather than a suggestion.'
        : clustersWithoutFood > 0
          ? `${clustersWithoutFood} area(s) in this packet contain no listed eating place; a day spent there needs food carried in.`
          : 'Every area in this packet contains at least one listed eating place.',
  };
}

function describeHours(packet: ResearchPacket): PreliminaryScan['hours'] {
  let knownCount = 0;
  let alwaysOpenCount = 0;
  let unknownCount = 0;
  for (const place of packet.places) {
    if (place.hours.state === 'known') knownCount += 1;
    else if (place.hours.state === 'always_open') alwaysOpenCount += 1;
    else unknownCount += 1;
  }
  return { knownCount, alwaysOpenCount, unknownCount };
}

/**
 * The risks, as a list a person could act on.
 *
 * Each entry names something that would make the trip not work, and each is
 * derived from a stated constraint meeting an observed fact. Nothing here is a
 * style preference: "there is nowhere to eat near half the region" is a risk,
 * "the days are a little full" is not, and mixing the two is how a warning list
 * becomes something people scroll past.
 */
function feasibilityRisks(input: {
  request: BenchmarkTripRequest;
  packet: ResearchPacket;
  extentKm: number | null;
  transport: PreliminaryScan['transport'];
}): string[] {
  const risks: string[] = [];
  const { request, packet, extentKm, transport } = input;

  if (packet.places.length === 0) {
    risks.push('The place inventory came back empty, so nothing can be scheduled from evidence.');
  }

  if (!request.movement.carAvailable && transport.unreachableWithoutCar > 0) {
    risks.push(
      `${transport.unreachableWithoutCar} place(s) in the packet are recorded as needing a car, and the traveller has none.`,
    );
  }

  if (extentKm !== null && extentKm > 150 && request.movement.desiredBaseCount === 1) {
    risks.push(
      `The inventory spans about ${extentKm} km and the traveller wants a single base, so the far end may be out of reach within their stated daily travel limit.`,
    );
  }

  if (packet.routeLegs.length === 0 && packet.places.length > 1) {
    risks.push('No travel time between any two places was measured, so every stated journey time would be a guess.');
  }

  const closed = packet.places.filter((place) => place.seasonal.state === 'closed_in_season');
  if (closed.length > 0) {
    risks.push(`${closed.length} place(s) are recorded as shut in the trip's months.`);
  }

  if (request.party.dietaryStrict && packet.places.every((place) => place.food === null)) {
    risks.push(
      'The traveller has a strict dietary requirement and the packet holds no eating place whose provision could be checked.',
    );
  }

  const mobility = request.party.mobility.filter((entry) => entry !== 'none');
  if (mobility.length > 0) {
    const unknownAccess = packet.places.filter(
      (place) => place.access.wheelchair === 'unknown',
    ).length;
    if (unknownAccess > 0) {
      risks.push(
        `The traveller stated an access need and ${unknownAccess} place(s) publish no accessibility information, so suitability cannot be confirmed from the data here.`,
      );
    }
  }

  return risks;
}

function scanUnknowns(packet: ResearchPacket): string[] {
  const unknowns = new Set<string>(packet.unknowns);
  const hours = describeHours(packet);
  if (hours.unknownCount > 0) {
    unknowns.add(
      `Opening hours are unknown for ${hours.unknownCount} of the ${packet.places.length} places in this packet.`,
    );
  }
  const weather = describeWeather(packet);
  if (weather.unknownDays > 0) {
    unknowns.add(`No weather evidence exists for ${weather.unknownDays} of the trip's dates.`);
  }
  if (packet.destination.scale === 'unknown') {
    unknowns.add('The destination record does not state how much ground it covers.');
  }
  return [...unknowns].sort();
}

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

/** Only ever used in prose, and rounded so it reads as an approximation. */
function formatHours(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = Math.round(minutes % 60);
  return rest === 0 ? `${hours} hours` : `${hours} hours ${rest} minutes`;
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
