import {
  PACKET_CAPS,
  RESEARCH_PACKET_VERSION,
  type PacketAccess,
  type PacketBaseCandidate,
  type PacketCluster,
  type PacketDaylight,
  type PacketDestination,
  type PacketFood,
  type PacketGap,
  type PacketHours,
  type PacketPlace,
  type PacketRouteLeg,
  type PacketSeasonal,
  type PacketSource,
  type PacketWeather,
  type ResearchPacket,
} from './packet-types';

/**
 * ASSEMBLING THE PACKET, DETERMINISTICALLY, FROM DATA SOMEBODY ELSE FETCHED.
 *
 * This module performs no I/O and holds no clock. It takes raw provider records
 * and returns the bounded inventory the generation call receives, and it returns
 * byte-identical JSON for byte-identical input — which is the property that lets
 * a benchmark blame a difference in output on the model rather than on the
 * harness.
 *
 * Two decisions are worth stating plainly, because both look like a missing
 * feature until you see what they are protecting.
 *
 * **The cap is applied by count, never by quality.** There is no scoring pass
 * here and no shortlist. When more places exist than the packet may hold, they
 * are taken round-robin across the proximity clusters so the survivors are
 * geographically spread rather than piled into whichever corner of the region
 * the provider happened to enumerate first — and everything dropped is recorded
 * in `gaps`. A ranked cut would be Sidequest's candidate selector rebuilt under
 * a different name, and this arm exists to find out what a language model does
 * *without* one.
 *
 * **Clusters are a grid over coordinates.** Not travel-time clustering, not
 * k-means, not anything that consults a router. Six lines of arithmetic whose
 * only job is to make the round-robin spread mean something and to give the
 * model a hint that two places are near each other. Nothing downstream treats a
 * cluster as a day.
 */

/* ------------------------------------------------------------------ *
 * What the provider layer hands over
 * ------------------------------------------------------------------ */

export interface RawSource {
  host: string;
  title: string | null;
  url: string | null;
  retrievedAt: string | null;
}

export interface RawPlace {
  entityId: string;
  name: string;
  latitude: number;
  longitude: number;
  kind: string;
  tags: readonly string[];
  typicalDurationMinutes: number | null;
  daylightOnly: boolean | null;
  hours: PacketHours;
  seasonal: PacketSeasonal;
  access: PacketAccess;
  food: PacketFood | null;
  source: RawSource | null;
}

export interface RawDay {
  dayNumber: number;
  date: string;
  daylight: PacketDaylight;
  weather: PacketWeather;
  weatherSource: RawSource | null;
}

export interface RawRouteLeg {
  fromEntityId: string;
  toEntityId: string;
  minutes: number;
  km: number;
  mode: 'drive' | 'walk' | 'transit';
}

export interface RawBaseCandidate {
  entityId: string | null;
  name: string;
  latitude: number;
  longitude: number;
  basis: string;
}

export interface PacketInputs {
  destination: PacketDestination;
  days: readonly RawDay[];
  places: readonly RawPlace[];
  baseCandidates: readonly RawBaseCandidate[];
  routeLegs: readonly RawRouteLeg[];
  /** Gaps the fetching layer already knows about: a refused provider, a switch. */
  gaps: readonly PacketGap[];
  unknowns: readonly string[];
}

/* ------------------------------------------------------------------ *
 * Geometry, in the ten lines it takes
 * ------------------------------------------------------------------ */

const EARTH_RADIUS_KM = 6371;

export function straightLineKm(
  from: { latitude: number; longitude: number },
  to: { latitude: number; longitude: number },
): number {
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const deltaLat = toRadians(to.latitude - from.latitude);
  const deltaLng = toRadians(to.longitude - from.longitude);
  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(toRadians(from.latitude)) *
      Math.cos(toRadians(to.latitude)) *
      Math.sin(deltaLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/* ------------------------------------------------------------------ *
 * Grid clustering
 * ------------------------------------------------------------------ */

/**
 * How many cells the grid is cut into on each axis.
 *
 * Four, because sixteen cells is comfortably more than the twelve clusters the
 * packet will keep, so the compaction step below has something to compact. A
 * larger number would produce clusters of one place each, which tells the model
 * nothing it could not read off the coordinates.
 */
const GRID_DIVISIONS = 4;

interface Cell {
  key: string;
  row: number;
  column: number;
}

function cellFor(
  place: { latitude: number; longitude: number },
  bounds: { minLat: number; maxLat: number; minLng: number; maxLng: number },
): Cell {
  const latSpan = Math.max(1e-6, bounds.maxLat - bounds.minLat);
  const lngSpan = Math.max(1e-6, bounds.maxLng - bounds.minLng);
  const row = Math.min(
    GRID_DIVISIONS - 1,
    Math.floor(((place.latitude - bounds.minLat) / latSpan) * GRID_DIVISIONS),
  );
  const column = Math.min(
    GRID_DIVISIONS - 1,
    Math.floor(((place.longitude - bounds.minLng) / lngSpan) * GRID_DIVISIONS),
  );
  return { key: `${row}:${column}`, row, column };
}

/* ------------------------------------------------------------------ *
 * The build
 * ------------------------------------------------------------------ */

/**
 * Sorted by identity, not by anything a planner would call preference.
 *
 * The identity order is arbitrary with respect to quality, which is exactly what
 * is wanted: it is stable across runs and it encodes no opinion. Every stage
 * below reads places in this order, which is what makes the packet reproducible.
 */
function byEntityId(a: { entityId: string }, b: { entityId: string }): number {
  return a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0;
}

export function buildResearchPacket(inputs: PacketInputs): ResearchPacket {
  const gaps: PacketGap[] = [...inputs.gaps];

  /*
   * Duplicates removed before anything is counted.
   *
   * Two providers describing the same trailhead is normal; a packet that held it
   * twice would let a plan schedule the same place on two days and look as
   * though it had found two things.
   */
  const seen = new Set<string>();
  const unique = [...inputs.places].sort(byEntityId).filter((place) => {
    if (seen.has(place.entityId)) return false;
    seen.add(place.entityId);
    return true;
  });
  if (unique.length < inputs.places.length) {
    gaps.push({
      kind: 'capped_by_count',
      subject: 'duplicate places',
      detail: `${inputs.places.length - unique.length} record(s) named a place the packet already held.`,
    });
  }

  const attractions = unique.filter((place) => place.food === null);
  const foodVenues = unique.filter((place) => place.food !== null);

  const bounds = boundsOf(unique);
  const cellOf = new Map<string, Cell>();
  for (const place of unique) cellOf.set(place.entityId, cellFor(place, bounds));

  const keptAttractions = takeSpread(attractions, cellOf, PACKET_CAPS.places, gaps, 'places');
  const keptFood = takeSpread(foodVenues, cellOf, PACKET_CAPS.foodVenues, gaps, 'food venues');

  const kept = [...keptAttractions, ...keptFood].sort(byEntityId);

  /*
   * Sources are collected in the order the kept places are read, and deduped on
   * whatever identifies the page. Collecting them from the *unkept* set too
   * would put a host in the plan's source list that nothing in the plan cites.
   */
  const sources: PacketSource[] = [];
  const sourceIndexByKey = new Map<string, number>();
  const sourceIndexFor = (source: RawSource | null): number | null => {
    if (!source) return null;
    const key = source.url ?? source.host;
    const existing = sourceIndexByKey.get(key);
    if (existing !== undefined) return existing;
    if (sources.length >= PACKET_CAPS.sources) return null;
    const index = sources.length;
    sourceIndexByKey.set(key, index);
    sources.push({
      index,
      host: source.host,
      title: source.title,
      url: source.url,
      retrievedAt: source.retrievedAt,
    });
    return index;
  };

  /* Compact the grid cells that survived, in the order they are first met. */
  const clusterIndexByCell = new Map<string, number>();
  const clusterMembers: number[][] = [];

  const places: PacketPlace[] = kept.map((place, index) => {
    const cell = cellOf.get(place.entityId);
    let clusterIndex: number | null = null;
    if (cell) {
      const existing = clusterIndexByCell.get(cell.key);
      if (existing !== undefined) {
        clusterIndex = existing;
        clusterMembers[existing]?.push(index);
      } else if (clusterIndexByCell.size < PACKET_CAPS.clusters) {
        clusterIndex = clusterIndexByCell.size;
        clusterIndexByCell.set(cell.key, clusterIndex);
        clusterMembers.push([index]);
      }
    }
    return {
      index,
      entityId: place.entityId,
      name: place.name,
      latitude: place.latitude,
      longitude: place.longitude,
      kind: place.kind,
      clusterIndex,
      typicalDurationMinutes: place.typicalDurationMinutes,
      daylightOnly: place.daylightOnly,
      hours: place.hours,
      seasonal: place.seasonal,
      access: place.access,
      food: place.food,
      tags: [...place.tags].sort(),
      sourceIndex: sourceIndexFor(place.source),
    };
  });

  const indexByEntityId = new Map<string, number>(
    places.map((place) => [place.entityId, place.index]),
  );

  const clusters: PacketCluster[] = clusterMembers.map((members, index) => {
    const points = members
      .map((member) => places[member])
      .filter((place): place is PacketPlace => place !== undefined);
    const centreLatitude = average(points.map((point) => point.latitude));
    const centreLongitude = average(points.map((point) => point.longitude));
    let spreadKm = 0;
    for (const point of points) {
      spreadKm = Math.max(
        spreadKm,
        straightLineKm({ latitude: centreLatitude, longitude: centreLongitude }, point),
      );
    }
    return {
      index,
      label: `Cluster ${index + 1}`,
      centreLatitude: round(centreLatitude, 5),
      centreLongitude: round(centreLongitude, 5),
      placeIndices: members,
      spreadKm: round(spreadKm, 1),
    };
  });

  /*
   * Route legs, kept only where both endpoints survived the cap.
   *
   * A leg pointing at a place the model cannot see is worse than no leg: it
   * would look like coverage while addressing nothing.
   */
  const legs: PacketRouteLeg[] = [];
  let orphaned = 0;
  for (const leg of [...inputs.routeLegs].sort(legOrder)) {
    const fromIndex = indexByEntityId.get(leg.fromEntityId);
    const toIndex = indexByEntityId.get(leg.toEntityId);
    if (fromIndex === undefined || toIndex === undefined) {
      orphaned += 1;
      continue;
    }
    if (!Number.isFinite(leg.minutes) || !Number.isFinite(leg.km)) {
      orphaned += 1;
      continue;
    }
    if (legs.length >= PACKET_CAPS.routeLegs) {
      gaps.push({
        kind: 'capped_by_count',
        subject: 'measured route legs',
        detail: `Kept ${PACKET_CAPS.routeLegs} of ${inputs.routeLegs.length} measured legs.`,
      });
      break;
    }
    legs.push({
      fromIndex,
      toIndex,
      minutes: Math.round(leg.minutes),
      km: round(leg.km, 1),
      mode: leg.mode,
      provenance: 'measured',
    });
  }
  if (orphaned > 0) {
    gaps.push({
      kind: 'capped_by_count',
      subject: 'measured route legs',
      detail: `${orphaned} leg(s) referenced a place the packet does not hold, or carried no finite time.`,
    });
  }

  const baseCandidates: PacketBaseCandidate[] = [...inputs.baseCandidates]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .slice(0, PACKET_CAPS.baseCandidates)
    .map((candidate) => ({
      placeIndex:
        candidate.entityId === null
          ? null
          : indexByEntityId.get(candidate.entityId) ?? null,
      name: candidate.name,
      latitude: candidate.latitude,
      longitude: candidate.longitude,
      basis: candidate.basis,
    }));
  if (inputs.baseCandidates.length > PACKET_CAPS.baseCandidates) {
    gaps.push({
      kind: 'capped_by_count',
      subject: 'base candidates',
      detail: `Kept ${PACKET_CAPS.baseCandidates} of ${inputs.baseCandidates.length} settlements the geocoder returned.`,
    });
  }

  const days = [...inputs.days]
    .sort((a, b) => a.dayNumber - b.dayNumber)
    .map((day) => ({
      dayNumber: day.dayNumber,
      date: day.date,
      daylight: day.daylight,
      weather: attachWeatherSource(day, sourceIndexFor(day.weatherSource)),
    }));

  const unknowns = [...new Set(inputs.unknowns)].sort().slice(0, PACKET_CAPS.unknowns);
  if (inputs.unknowns.length > unknowns.length) {
    gaps.push({
      kind: 'capped_by_count',
      subject: 'unknowns',
      detail: `Listed ${unknowns.length} of ${inputs.unknowns.length} recorded unknowns.`,
    });
  }

  return {
    version: RESEARCH_PACKET_VERSION,
    destination: inputs.destination,
    days,
    places,
    clusters,
    baseCandidates,
    routeLegs: legs,
    sources,
    gaps: sortGaps(gaps),
    unknowns,
  };
}

/**
 * Round-robin across cells, so a cap costs the region its density rather than
 * one of its corners.
 *
 * Reading straight down the identity order would keep whatever the sort happened
 * to put first, which for OpenStreetMap identifiers correlates with nothing at
 * all — including, unhelpfully, with geography. Taking one place from each cell
 * in turn keeps the survivors spread, and it does so without consulting a single
 * fact about whether any of them is worth visiting.
 */
function takeSpread(
  candidates: readonly RawPlace[],
  cellOf: ReadonlyMap<string, Cell>,
  cap: number,
  gaps: PacketGap[],
  subject: string,
): RawPlace[] {
  if (candidates.length <= cap) return [...candidates];

  const byCell = new Map<string, RawPlace[]>();
  for (const place of candidates) {
    const key = cellOf.get(place.entityId)?.key ?? '0:0';
    const bucket = byCell.get(key);
    if (bucket) bucket.push(place);
    else byCell.set(key, [place]);
  }

  const cellKeys = [...byCell.keys()].sort();
  const taken: RawPlace[] = [];
  for (let round = 0; taken.length < cap; round += 1) {
    let placedThisRound = false;
    for (const key of cellKeys) {
      const bucket = byCell.get(key);
      const place = bucket?.[round];
      if (!place) continue;
      placedThisRound = true;
      taken.push(place);
      if (taken.length >= cap) break;
    }
    if (!placedThisRound) break;
  }

  gaps.push({
    kind: 'capped_by_count',
    subject,
    detail: `Kept ${taken.length} of ${candidates.length}, spread evenly across ${cellKeys.length} area(s).`,
  });
  return taken;
}

function boundsOf(
  places: readonly { latitude: number; longitude: number }[],
): { minLat: number; maxLat: number; minLng: number; maxLng: number } {
  if (places.length === 0) return { minLat: 0, maxLat: 0, minLng: 0, maxLng: 0 };
  let minLat = Number.POSITIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;
  let minLng = Number.POSITIVE_INFINITY;
  let maxLng = Number.NEGATIVE_INFINITY;
  for (const place of places) {
    minLat = Math.min(minLat, place.latitude);
    maxLat = Math.max(maxLat, place.latitude);
    minLng = Math.min(minLng, place.longitude);
    maxLng = Math.max(maxLng, place.longitude);
  }
  return { minLat, maxLat, minLng, maxLng };
}

function attachWeatherSource(day: RawDay, sourceIndex: number | null): PacketWeather {
  if (day.weather.state === 'unknown') return day.weather;
  return { ...day.weather, sourceIndex };
}

function legOrder(a: RawRouteLeg, b: RawRouteLeg): number {
  if (a.fromEntityId !== b.fromEntityId) return a.fromEntityId < b.fromEntityId ? -1 : 1;
  if (a.toEntityId !== b.toEntityId) return a.toEntityId < b.toEntityId ? -1 : 1;
  return a.mode < b.mode ? -1 : a.mode > b.mode ? 1 : 0;
}

/** A stable order, so two runs over the same inputs serialise identically. */
function sortGaps(gaps: readonly PacketGap[]): PacketGap[] {
  return [...gaps].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
    if (a.subject !== b.subject) return a.subject < b.subject ? -1 : 1;
    return a.detail < b.detail ? -1 : a.detail > b.detail ? 1 : 0;
  });
}

function average(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

/** Rounded so a floating-point tail cannot make two equal packets differ. */
function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
