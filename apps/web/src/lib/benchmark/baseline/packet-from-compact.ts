import type { CompactPacket, CompactPlace } from './packet-compact';
import type { PacketInputs, RawPlace } from './packet';
import {
  RESEARCH_PACKET_VERSION,
  type PacketAccess,
  type PacketDestination,
  type PacketFood,
  type PacketHours,
  type PacketPlace,
  type PacketSeasonal,
  type ResearchPacket,
} from './packet-types';

/**
 * RECONSTRUCTING A `ResearchPacket` FROM AN ALREADY-COMPACTED ONE — FOR
 * OFFLINE, PROVIDER-FREE HYDRATION OF A PRESERVED SNAPSHOT ONLY.
 *
 * `hydrateSkeleton()` takes a `ResearchPacket`; a preserved request snapshot
 * from an earlier live run only ever holds `compactPacketForModel(packet)`'s
 * output (`untrusted.retrievedContent.packet`) — see `skeleton-packet.ts`'s
 * own `buildSkeletonEvidencePacketFromCompact` for the earlier instance of
 * this exact problem, one layer up. This is the same answer applied to
 * hydration: every field `hydrateSkeleton` actually reads — coordinates,
 * kind, tags, significance, season, access flags, hours, food, duration,
 * source index — is already present on a `CompactPlace`. What is genuinely
 * gone is what the compact projection never carried in the first place:
 * real entity ids (never read by hydration — places are addressed by index
 * only, the same property `packet-types.ts`'s own header states), full
 * multi-date hours windows (compacted to one representative window, which
 * is all hydration ever reads), and the destination's own coordinate (kept
 * only as a last-resort fallback when no base candidate matches by name;
 * reconstructed here as the mean of every place this packet holds, clearly
 * a synthetic value rather than a geocoded one).
 *
 * This is not a general-purpose reconstruction and is not wired into any
 * production or live-acquisition path — it exists for exactly one purpose:
 * replaying benchmark-isolated hydration against a preserved snapshot with
 * zero provider calls.
 */

const RECONSTRUCTED_SOURCE_HOST = 'reconstructed-from-compact-packet';

function reconstructHours(compact: CompactPlace['hours']): PacketHours {
  if (compact === 'always_open') return { state: 'always_open' };
  if (!compact) return { state: 'unknown' };
  const toMinutes = (clock: string): number => {
    const [hours, minutes] = clock.split(':').map(Number);
    return (hours ?? 0) * 60 + (minutes ?? 0);
  };
  return {
    state: 'known',
    // No real date survives compaction — a single representative window is
    // all `compactHours` ever emitted, and all `hydrateSkeleton` ever reads
    // (`windows[0]`). The empty date is honestly synthetic, not a claim.
    windows: [{ date: '', openMinute: toMinutes(compact.open), closeMinute: toMinutes(compact.close) }],
    closedDates: [],
    sourceIndex: null,
  };
}

function reconstructSeasonal(closedInSeason: true | undefined): PacketSeasonal {
  if (!closedInSeason) return { state: 'unknown' };
  return {
    state: 'closed_in_season',
    // The original note text does not survive compaction (only the boolean
    // does) — said honestly, rather than inventing a plausible-sounding one.
    note: 'Marked closed for the trip’s dates in the compact packet; the original explanatory note was not preserved in that projection.',
  };
}

function reconstructAccess(flags: readonly string[] | undefined): PacketAccess {
  const has = (flag: string): boolean | null => (flags?.includes(flag) ? true : null);
  return {
    requiresCar: has('requires_car'),
    unpavedApproach: has('unpaved_approach'),
    remoteNoServices: has('remote_no_services'),
    strenuous: has('strenuous'),
    wheelchair: flags?.includes('wheelchair_no') ? 'no' : flags?.includes('wheelchair_limited') ? 'limited' : 'unknown',
    feeStated: has('fee_stated'),
  };
}

function reconstructFood(meals: readonly string[] | undefined): PacketFood | null {
  if (!meals) return null;
  return {
    servesSlots: meals as PacketFood['servesSlots'],
    dietaryTags: [],
    cuisine: null,
    cannotAccommodate: [],
  };
}

function reconstructPlace(compact: CompactPlace): PacketPlace {
  return {
    index: compact.index,
    // Never read by `hydrateSkeleton` — places are addressed by index only,
    // per `packet-types.ts`'s own header. Synthesized so the type is whole.
    entityId: `reconstructed-place-${compact.index}`,
    name: compact.name,
    latitude: compact.lat,
    longitude: compact.lng,
    kind: compact.kind,
    clusterIndex: compact.cluster,
    typicalDurationMinutes: compact.duration,
    daylightOnly: compact.flags?.includes('daylight_only') ? true : null,
    hours: reconstructHours(compact.hours),
    seasonal: reconstructSeasonal(compact.closedInSeason),
    access: reconstructAccess(compact.flags),
    food: reconstructFood(compact.meals),
    tags: compact.tags ?? [],
    sourceIndex: compact.source,
    significance: compact.significance ?? null,
  };
}

function meanCoordinate(places: readonly CompactPlace[]): { latitude: number; longitude: number } {
  if (places.length === 0) return { latitude: 0, longitude: 0 };
  const total = places.reduce((sum, place) => ({ lat: sum.lat + place.lat, lng: sum.lng + place.lng }), {
    lat: 0,
    lng: 0,
  });
  return { latitude: total.lat / places.length, longitude: total.lng / places.length };
}

/**
 * THE SAME RECONSTRUCTION, SHAPED FOR `packetGroundTruth` INSTEAD OF
 * `hydrateSkeleton`.
 *
 * `packetGroundTruth({inputs, request, now})` takes a `PacketInputs` — the
 * *raw*, entity-id-keyed shape `buildResearchPacket` itself consumes, one
 * step earlier than a `ResearchPacket` — and indexes places by entity id;
 * it applies no capping or re-clustering of its own, so unlike
 * `researchPacketFromCompact` above this does not need to preserve a
 * specific index space, only the same synthesized entity ids that function
 * uses (`reconstructed-place-${index}`), so a `BenchmarkPlan`'s
 * `place.entityId` — carried through from the same reconstructed
 * `PacketPlace` — resolves against this ground truth correctly.
 *
 * `buildResearchPacket` itself is deliberately not reused for this: it
 * applies `PACKET_CAPS.places` (140), and the preserved snapshot holds 162
 * — round-tripping through it would silently drop places and could change
 * which survive, breaking the exact index space the skeleton was generated
 * against. This stays a direct, capping-free reconstruction.
 */
export function packetInputsFromCompact(compact: CompactPacket): PacketInputs {
  const places: RawPlace[] = compact.places.map((place) => ({
    entityId: `reconstructed-place-${place.index}`,
    name: place.name,
    latitude: place.lat,
    longitude: place.lng,
    kind: place.kind,
    tags: place.tags ?? [],
    typicalDurationMinutes: place.duration,
    daylightOnly: place.flags?.includes('daylight_only') ? true : null,
    hours: reconstructHours(place.hours),
    seasonal: reconstructSeasonal(place.closedInSeason),
    access: reconstructAccess(place.flags),
    food: reconstructFood(place.meals),
    // No real source record survives compaction (only a count does) — see
    // `researchPacketFromCompact`'s own reconstructed `sources` list.
    source: null,
    significance: place.significance ?? null,
  }));

  return {
    destination: {
      entityId: 'reconstructed-destination',
      displayName: compact.destination.name,
      countryCode: compact.destination.countryCode,
      latitude: meanCoordinate(compact.places).latitude,
      longitude: meanCoordinate(compact.places).longitude,
      radiusKm: null,
      scale: compact.destination.scale as PacketDestination['scale'],
    },
    days: compact.days.map((day) => ({
      dayNumber: day.dayNumber,
      date: day.date,
      daylight: { state: 'unknown' },
      weather: { state: 'unknown' },
      weatherSource: null,
    })),
    places,
    baseCandidates: compact.baseCandidates.map((base) => ({
      entityId: null,
      name: base.name,
      latitude: base.lat,
      longitude: base.lng,
      basis: base.basis,
    })),
    routeLegs: compact.routeLegs.map((leg) => ({
      fromEntityId: `reconstructed-place-${leg.from}`,
      toEntityId: `reconstructed-place-${leg.to}`,
      minutes: leg.minutes,
      km: 0,
      mode: leg.mode,
    })),
    gaps: [
      {
        kind: 'not_requested',
        subject: 'full research packet',
        detail:
          'These inputs were reconstructed from an already-compacted snapshot for offline replay; several fields are synthetic placeholders rather than acquired evidence — see packet-from-compact.ts.',
      },
    ],
    unknowns: [],
  };
}

export function researchPacketFromCompact(compact: CompactPacket): ResearchPacket {
  const centre = meanCoordinate(compact.places);
  const destination: PacketDestination = {
    entityId: 'reconstructed-destination',
    displayName: compact.destination.name,
    countryCode: compact.destination.countryCode,
    // A synthetic centroid, not a geocoded value — see this file's own
    // header. Only ever read as hydration's last-resort fallback when no
    // base candidate matches by name.
    latitude: centre.latitude,
    longitude: centre.longitude,
    radiusKm: null,
    scale: compact.destination.scale as PacketDestination['scale'],
  };

  return {
    version: RESEARCH_PACKET_VERSION,
    destination,
    days: compact.days.map((day) => ({
      dayNumber: day.dayNumber,
      date: day.date,
      // Compact daylight/weather are already-rendered prose, not the
      // structured union `hydrateSkeleton` never reads from `packet.days`
      // anyway (it uses the traveller's own arrival/departure instead).
      daylight: { state: 'unknown' },
      weather: { state: 'unknown' },
    })),
    places: compact.places.map(reconstructPlace),
    clusters: compact.clusters.map((cluster) => ({
      index: cluster.index,
      label: `cluster-${cluster.index}`,
      centreLatitude: cluster.lat,
      centreLongitude: cluster.lng,
      placeIndices: cluster.places,
      spreadKm: 0,
    })),
    baseCandidates: compact.baseCandidates.map((base) => ({
      placeIndex: base.placeIndex,
      name: base.name,
      latitude: base.lat,
      longitude: base.lng,
      basis: base.basis,
    })),
    routeLegs: compact.routeLegs.map((leg) => ({
      fromIndex: leg.from,
      toIndex: leg.to,
      minutes: leg.minutes,
      km: 0,
      mode: leg.mode,
      provenance: 'measured',
    })),
    sources: Array.from({ length: compact.sourceCount }, (_, index) => ({
      index,
      host: RECONSTRUCTED_SOURCE_HOST,
      title: null,
      url: null,
      retrievedAt: null,
    })),
    gaps: [
      {
        kind: 'not_requested',
        subject: 'full research packet',
        detail:
          'This packet was reconstructed from an already-compacted snapshot for offline replay; several fields (entity ids, full multi-date hours, the destination coordinate) are synthetic placeholders rather than acquired evidence.',
      },
    ],
    unknowns: [],
  };
}
