import type { PacketDaylight, PacketPlace, PacketRouteLeg, PacketWeather, ResearchPacket } from './packet-types';

/**
 * THE MODEL IS A TRIP COMPOSER, NOT THE EVIDENCE DATABASE.
 *
 * `ResearchPacket` is the full, unabridged inventory `convert.ts`,
 * `packetGroundTruth` and every validator in `packages/bench/src/validate`
 * still read from — none of that changes here. This module is a *second*,
 * strictly smaller view of the same packet, built only for what actually
 * crosses the wire to the model. Nothing here is a new fact and nothing here
 * is dropped from the record Sidequest keeps — a field missing from
 * `CompactPacket` is a field the model was never going to use to decide
 * anything, still fully present on `packet` itself for the conversion step
 * that runs after the model answers.
 *
 * Measured, not guessed, on a real Iceland packet (162 places, 60 sources,
 * `packet-profile.json`, this pass's own measurement): `packet.places`
 * alone was 95,732 of a 140,063-byte request — 68% of everything sent — and
 * the field-by-field reason was structural, not content: `hours` was
 * `{"state":"unknown"}` on every one of 162 places in this gather path
 * (`hybrid-gather.ts` deliberately never researches hours — see its own
 * header comment), `daylightOnly` was `null` on all 162, and `access` carried
 * six verbose fields — `requiresCar`, `unpavedApproach`, `remoteNoServices`,
 * `strenuous`, `wheelchair`, `feeStated` — every one of them `null`, `false`
 * or `"unknown"` on the overwhelming majority of places. None of that is
 * information; it is the same JSON shape repeated 162 times to say "nothing
 * here." `entityId` (a UUID) travelled on every place and every source too,
 * for a value the model never once needed: places are addressed by array
 * *index*, never by id — see `packet-types.ts`'s own header — so the model
 * has no field to put an entity id in and no reason to have read one. And
 * `packet.sources` — 7,619 bytes of host/title/url on 60 records — was sent
 * in full though the model only ever needs a *count*: it cites a source by
 * index, and the prompt task text already states the valid range as a
 * number (`buildGenerationTask`, unchanged); reading what source 12 *says*
 * has never been part of the model's job, only citing that it relied on one.
 *
 * What survives is what a composition decision actually turns on: identity
 * by index, name, rough geography, category, significance, approximate
 * duration, and only the access/hours/season signals that are not the
 * default "nothing is known" case — because a signal repeated identically
 * on every record is not a signal, and the honesty rule that forbids the
 * model from asserting an unknown fact already makes the unknown case
 * unnecessary to state in the first place.
 */

export interface CompactPlace {
  index: number;
  name: string;
  kind: string;
  cluster: number | null;
  /** Rounded to 5 decimal places — about 1.1m, far past what a day-grouping or geographic judgement needs. */
  lat: number;
  lng: number;
  duration: number | null;
  /** 0-1 real-world prominence. Omitted, never zero, where nobody scored it — see `PacketPlace.significance`. */
  significance?: number;
  /**
   * Only the access/physical signals that are not the default. A place with
   * none of these is a place with nothing unusual stated about getting to
   * or being at it — which is the common case and costs nothing to imply.
   */
  flags?: readonly string[];
  /** Present only when hours are actually known or the place never closes — the common "unknown" case costs nothing. */
  hours?: { open: string; close: string } | 'always_open';
  /** Present only when the place is genuinely out of season for this trip. */
  closedInSeason?: true;
  /** Decision-relevant category tags, filtered — see `filterTags`. */
  tags?: readonly string[];
  /** Present only for somewhere to eat. */
  meals?: readonly string[];
  /** Evidence pointer — an index into the full packet's sources, still resolved there at conversion time. */
  source: number | null;
}

export interface CompactRouteLeg {
  from: number;
  to: number;
  minutes: number;
  mode: 'drive' | 'walk' | 'transit';
}

export interface CompactCluster {
  index: number;
  lat: number;
  lng: number;
  places: readonly number[];
}

export interface CompactBaseCandidate {
  placeIndex: number | null;
  name: string;
  lat: number;
  lng: number;
  basis: string;
}

export interface CompactDay {
  dayNumber: number;
  date: string;
  /** A compact single sentence, not the nested `PacketDaylight`/`PacketWeather` shape — same content, no envelope. */
  daylight: string;
  weather: string;
}

export interface CompactPacket {
  destination: { name: string; countryCode: string | null; scale: string };
  days: readonly CompactDay[];
  places: readonly CompactPlace[];
  clusters: readonly CompactCluster[];
  baseCandidates: readonly CompactBaseCandidate[];
  routeLegs: readonly CompactRouteLeg[];
  /** Not the source records — see the header. The model cites by index; only the valid count matters to it. */
  sourceCount: number;
  /*
   * NO `gaps` OR `unknowns` HERE.
   *
   * Both were sent twice: `buildGenerationTask` (unchanged by this pass)
   * already renders `scan.unknowns` — a superset of `packet.unknowns` plus a
   * few scan-derived items — as prose in the task turn ("Explicitly
   * unestablished: …"), and `packet.gaps` as prose in the same turn ("What
   * the packet does not contain: …"). The model was reading the same facts
   * twice, once as data and once as words it had already been told to read
   * as words. Dropped from here; still computed and still reaches the model,
   * once, from the place it was already reaching it from.
   */
}

/**
 * Internal bookkeeping tags that carry no travel-planning signal, filtered
 * out rather than sent and ignored. `included:*` and `role:*` are how the
 * candidate-selection layer talks to itself about *why a place is in this
 * packet at all* — never a fact about the place a composer would weigh.
 */
function isDecisionRelevantTag(tag: string): boolean {
  return !tag.startsWith('included:') && !tag.startsWith('role:');
}

/** Exported for `skeleton-packet.ts` — the same rounding, applied to the same coordinates. */
export function round(coordinate: number): number {
  return Math.round(coordinate * 100_000) / 100_000;
}

function compactFlags(place: PacketPlace): readonly string[] | undefined {
  const flags: string[] = [];
  if (place.access.requiresCar === true) flags.push('requires_car');
  if (place.access.unpavedApproach === true) flags.push('unpaved_approach');
  if (place.access.remoteNoServices === true) flags.push('remote_no_services');
  if (place.access.strenuous === true) flags.push('strenuous');
  if (place.access.wheelchair === 'limited') flags.push('wheelchair_limited');
  if (place.access.wheelchair === 'no') flags.push('wheelchair_no');
  if (place.access.feeStated === true) flags.push('fee_stated');
  if (place.daylightOnly === true) flags.push('daylight_only');
  return flags.length > 0 ? flags : undefined;
}

function compactHours(place: PacketPlace): CompactPlace['hours'] {
  if (place.hours.state === 'always_open') return 'always_open';
  if (place.hours.state !== 'known') return undefined;
  const first = place.hours.windows[0];
  if (!first) return undefined;
  // One representative window, not the full per-date list — the model needs
  // to know roughly when this is open, not reproduce a calendar it was
  // already told it may not assert exact hours from (see `BASELINE_HONESTY_RULES`).
  const minutesToClock = (minutes: number) =>
    `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  return { open: minutesToClock(first.openMinute), close: minutesToClock(first.closeMinute) };
}

/** Exported for `skeleton-packet.ts`, which compacts a bounded *subset* of places the same way. */
export function compactPlace(place: PacketPlace): CompactPlace {
  const tags = place.tags.filter(isDecisionRelevantTag);
  const compact: CompactPlace = {
    index: place.index,
    name: place.name,
    kind: place.kind,
    cluster: place.clusterIndex,
    lat: round(place.latitude),
    lng: round(place.longitude),
    duration: place.typicalDurationMinutes,
    source: place.sourceIndex,
  };
  if (typeof place.significance === 'number') compact.significance = place.significance;
  const flags = compactFlags(place);
  if (flags) compact.flags = flags;
  const hours = compactHours(place);
  if (hours) compact.hours = hours;
  if (place.seasonal.state === 'closed_in_season') compact.closedInSeason = true;
  if (tags.length > 0) compact.tags = tags;
  if (place.food) compact.meals = place.food.servesSlots;
  return compact;
}

function compactRouteLeg(leg: PacketRouteLeg): CompactRouteLeg {
  // `km` and `provenance` dropped: `provenance` is the literal `'measured'`
  // on every entry `ResearchPacket` can hold — see `PacketRouteLeg` — so it
  // carries no information here, and `km` is redundant with `minutes` for a
  // composition decision (Sidequest's own routing evidence, not something
  // the model is asked to restate).
  return { from: leg.fromIndex, to: leg.toIndex, minutes: leg.minutes, mode: leg.mode };
}

function compactDaylight(daylight: PacketDaylight): string {
  if (daylight.state === 'polar_day') return 'polar day — no true night';
  if (daylight.state === 'polar_night') return 'polar night — no true day';
  if (daylight.state === 'unknown') return 'unknown';
  const minutesToClock = (minutes: number) =>
    `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  return `sunrise ${minutesToClock(daylight.sunriseMinute)}, sunset ${minutesToClock(daylight.sunsetMinute)}`;
}

function compactWeather(weather: PacketWeather): string {
  if (weather.state === 'unknown') return 'unknown';
  const parts = [weather.summary];
  if (weather.highCelsius !== null) parts.push(`high ${weather.highCelsius}°C`);
  if (weather.lowCelsius !== null) parts.push(`low ${weather.lowCelsius}°C`);
  if (weather.precipitationChance !== null) parts.push(`${weather.precipitationChance}% precipitation`);
  return `${weather.state}: ${parts.join(', ')}`;
}

/** The one entry point: a full `ResearchPacket` in, the compact model-facing view out. */
export function compactPacketForModel(packet: ResearchPacket): CompactPacket {
  return {
    destination: {
      name: packet.destination.displayName,
      countryCode: packet.destination.countryCode,
      scale: packet.destination.scale,
    },
    days: packet.days.map((day) => ({
      dayNumber: day.dayNumber,
      date: day.date,
      daylight: compactDaylight(day.daylight),
      weather: compactWeather(day.weather),
    })),
    places: packet.places.map(compactPlace),
    clusters: packet.clusters.map((cluster) => ({
      index: cluster.index,
      lat: round(cluster.centreLatitude),
      lng: round(cluster.centreLongitude),
      places: cluster.placeIndices,
    })),
    baseCandidates: packet.baseCandidates.map((base) => ({
      placeIndex: base.placeIndex,
      name: base.name,
      lat: round(base.latitude),
      lng: round(base.longitude),
      basis: base.basis,
    })),
    routeLegs: packet.routeLegs.map(compactRouteLeg),
    sourceCount: packet.sources.length,
  };
}
