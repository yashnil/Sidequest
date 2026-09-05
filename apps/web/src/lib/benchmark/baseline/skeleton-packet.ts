import type { BenchmarkInterest, BenchmarkTripRequest } from '@sidequest/bench';
import { compactPlace, round, type CompactPacket, type CompactPlace } from './packet-compact';
import type { PacketRouteLeg, ResearchPacket } from './packet-types';

/**
 * THE SKELETON'S OWN EVIDENCE — BOUNDED BY REGION, NOT JUST BY COUNT.
 *
 * The full-plan composer's request sends every place the packet holds —
 * ~61.7KB measured on the preserved Iceland snapshot, `packet.places` alone
 * accounting for the large majority of it (`packet-compact.ts`'s own
 * measurement). A skeleton call does not need that: it is deciding trip
 * *shape* — archetype, bases, which few experiences anchor each day — not
 * writing a schedule, so it does not need to see every candidate, only enough
 * of each region to decide well and enough of what it left out to say so
 * honestly.
 *
 * The selection below is deterministic and destination-agnostic — nothing
 * here names a place, a region or a country; it operates only on
 * `PacketPlace.clusterIndex`, `.significance`, `.kind`/`.tags`, and the
 * traveller's own stated interests. Three passes, each answering a different
 * question a naive "global top-N" would get wrong:
 *
 * 1. **Per-cluster, not global.** A flat top-N by significance would let one
 *    dense, well-documented region crowd out a quieter one the traveller
 *    still needs to know exists — exactly the failure this pass exists to
 *    guard against (a moving-route request collapsing to wherever the
 *    evidence is thickest). Ranking *inside* each cluster and taking a
 *    bounded number from every one of them is what keeps regional coverage
 *    from depending on how much any one region happened to have.
 * 2. **By significance and by fit, not only one.** Significance says a place
 *    is well-established; it says nothing about whether this traveller would
 *    want it. A pure significance cut would hide a strong personal fit that
 *    happens to be locally obscure, and a pure fit cut would hide the
 *    destination-defining places a good plan has to at least weigh.
 * 3. **A canonical floor and a distinct-kind pass, applied globally after the
 *    per-cluster ranking.** A place whose significance clears a high bar is
 *    kept regardless of its cluster's own quota — a truly major experience
 *    should not be dropped because its neighbours were also good. And one
 *    representative of every experience *kind* the packet holds is kept even
 *    if ranking alone would never have surfaced it, so a rare category (say,
 *    the only hot spring in an otherwise hiking-heavy packet) still reaches
 *    the model as something that exists to be omitted on purpose rather than
 *    never seen at all.
 */

/** Deterministic per-cluster/global bounds. See the header for what each guards against. */
export const SKELETON_EVIDENCE_LIMITS = {
  /** Top places by significance, kept per cluster. */
  perClusterBySignificance: 3,
  /** Top places by traveller-fit, kept per cluster. */
  perClusterByFit: 3,
  /** Ceiling on a single cluster's contribution after the two rankings are unioned. */
  perClusterMax: 6,
  /** Always kept, whatever cluster it is in. */
  canonicalSignificanceFloor: 0.7,
  /** Hard ceiling on the whole selection — a safety valve, not expected to bind in practice. */
  totalPlaceCap: 90,
} as const;

export interface SkeletonEvidencePlace extends CompactPlace {
  /**
   * Why this place survived the cut, so the model can weigh a "canonical"
   * inclusion differently from a "matches your stated interests" one — the
   * same distinction `significance` already draws in the full packet,
   * carried into the reason it is here at all. A place can carry more than
   * one.
   */
  includedFor: readonly ('significant' | 'fit' | 'canonical' | 'distinct_kind')[];
}

export interface SkeletonEvidenceCluster {
  index: number;
  lat: number;
  lng: number;
  /** Only the places actually in this evidence packet — not the cluster's full membership. */
  places: readonly number[];
  /** How many places this cluster holds in the full packet, so the model knows the selection is partial. */
  totalPlacesInRegion: number;
}

export interface SkeletonEvidenceBaseCandidate {
  placeIndex: number | null;
  name: string;
  lat: number;
  lng: number;
  basis: string;
}

export interface SkeletonRouteLeg {
  from: number;
  to: number;
  minutes: number;
  mode: 'drive' | 'walk' | 'transit';
}

/** The traveller's own stated constraints and preferences, compacted for a shape decision. */
export interface SkeletonTravellerContext {
  nights: number;
  arrival: string;
  departure: string;
  pace: string;
  activityIntensity: string;
  transportPreference: string;
  carAvailable: boolean;
  maxDailyDriveMinutes: number;
  maxDailyTravelMinutes: number;
  desiredBaseCount: number;
  maxBaseChanges: number;
  /** Only `frequent`/`core` — the interests actually worth shaping a day around. */
  strongInterests: readonly string[];
  hardAvoidances: readonly string[];
  mustDo: readonly string[];
  budget: string;
}

export interface SkeletonEvidencePacket {
  destination: { name: string; countryCode: string | null; scale: string };
  tripLength: { days: number; startDate: string; endDate: string };
  traveller: SkeletonTravellerContext;
  places: readonly SkeletonEvidencePlace[];
  /** How many places the full packet held, so the model knows this is a bounded view, not the inventory. */
  totalPlacesInPacket: number;
  clusters: readonly SkeletonEvidenceCluster[];
  baseCandidates: readonly SkeletonEvidenceBaseCandidate[];
  /** Only legs between two places that are both in this evidence packet. */
  routeLegs: readonly SkeletonRouteLeg[];
}

/**
 * A place, as the COMPOSITION CALL sees it — travel judgment fields only.
 *
 * The live acceptance run of 2026-09-01 measured `packet.places` as the
 * single largest block of composition input (~2,600 tokens of ~9,400), and
 * most of each record was verification-grade data the model has no
 * composition use for: five-decimal coordinates (~1.1 m precision — the
 * model does not route, and `clusters[]` already carries the regional
 * geography a shape decision needs), raw source tags, and a provenance
 * index into the sources table. All of that stays on the full
 * `SkeletonEvidencePacket`, which hydration/resolution reads server-side
 * (`resolveAnchorPlace`'s proximity matching, `packet_evidence_unmatched`'s
 * coordinate reuse) — only the *wire payload to the model* is projected
 * down. What survives is exactly what shapes judgment: which experience
 * (`name`/`kind`), where in the region (`cluster`), how long it takes
 * (`duration`), how established it is (`significance`), why it is shown
 * (`includedFor`), and the two rare, materially constraining facts
 * (`closedInSeason`, `flags`).
 */
export interface CompositionViewPlace {
  index: number;
  name: string;
  kind: string;
  cluster: number | null;
  duration: number | null;
  significance?: number;
  includedFor: readonly ('significant' | 'fit' | 'canonical' | 'distinct_kind')[];
  flags?: readonly string[];
  closedInSeason?: true;
}

export interface SkeletonCompositionView {
  destination: SkeletonEvidencePacket['destination'];
  tripLength: SkeletonEvidencePacket['tripLength'];
  traveller: SkeletonTravellerContext;
  places: readonly CompositionViewPlace[];
  totalPlacesInPacket: number;
  clusters: readonly SkeletonEvidenceCluster[];
  baseCandidates: readonly SkeletonEvidenceBaseCandidate[];
  routeLegs: readonly SkeletonRouteLeg[];
}

/**
 * The model-facing projection of an evidence packet. Indices are preserved
 * verbatim — a `placeIndex` the model cites against this view resolves
 * against the full packet identically — and nothing here mutates or
 * replaces the full packet the deterministic pipeline keeps using.
 */
export function compositionViewOfPacket(packet: SkeletonEvidencePacket): SkeletonCompositionView {
  return {
    destination: packet.destination,
    tripLength: packet.tripLength,
    traveller: packet.traveller,
    places: packet.places.map((place) => ({
      index: place.index,
      name: place.name,
      kind: place.kind,
      cluster: place.cluster,
      duration: place.duration,
      ...(place.significance !== undefined ? { significance: place.significance } : {}),
      includedFor: place.includedFor,
      ...(place.flags !== undefined ? { flags: place.flags } : {}),
      ...(place.closedInSeason !== undefined ? { closedInSeason: place.closedInSeason } : {}),
    })),
    totalPlacesInPacket: packet.totalPlacesInPacket,
    clusters: packet.clusters,
    baseCandidates: packet.baseCandidates,
    routeLegs: packet.routeLegs,
  };
}

/**
 * A generic, destination-agnostic keyword table from the shared interest
 * vocabulary (`INTERESTS` in `@sidequest/bench`) to OSM-style tag fragments
 * that plausibly indicate it. Deliberately approximate: this only decides
 * which places make it into the *evidence the model sees*, never which
 * places end up in the trip — that judgement stays the model's, exactly as
 * `PacketPlace.significance`'s own contract already holds for prominence.
 * An interest absent from this table simply never boosts a place's fit score
 * here; it is not thereby unavailable to the model, which still sees every
 * cluster's significance-ranked places regardless of fit.
 */
const INTEREST_KEYWORDS: Partial<Record<BenchmarkInterest, readonly string[]>> = {
  hiking: ['hiking', 'trail', 'trailhead'],
  easy_nature_walks: ['walk', 'nature_reserve', 'park'],
  scenic_viewpoints: ['viewpoint', 'peak', 'lookout'],
  lakes_and_rivers: ['lake', 'river', 'water'],
  beaches_and_swimming: ['beach', 'swimming'],
  scenic_drives: ['scenic', 'drive'],
  wildlife: ['wildlife', 'zoo', 'reserve'],
  geology_and_geothermal: ['geothermal', 'volcano', 'geyser', 'cave'],
  hot_springs: ['hot_spring', 'spa', 'thermal'],
  history_and_culture: ['historic', 'heritage', 'monument', 'castle', 'ruins'],
  museums_and_galleries: ['museum', 'gallery', 'artwork'],
  architecture: ['architecture', 'church', 'cathedral', 'building'],
  food_and_towns: ['restaurant', 'town', 'village'],
  markets_and_street_food: ['market', 'marketplace'],
  fine_dining: ['restaurant'],
  cafes: ['cafe', 'coffee'],
  nightlife: ['bar', 'pub', 'nightclub'],
  shopping: ['shop', 'mall'],
  local_neighbourhoods: ['neighbourhood', 'quarter'],
  festivals_and_events: ['festival', 'event'],
  photography_golden_hour: ['viewpoint', 'peak'],
  stargazing: ['observatory', 'dark_sky'],
  wellness_and_spa: ['spa', 'wellness', 'thermal'],
  boats_and_ferries: ['ferry', 'harbour', 'pier', 'boat'],
  trains: ['railway', 'train_station'],
  winter_sports: ['ski', 'piste', 'snow'],
  diving_and_snorkelling: ['dive', 'snorkel', 'reef'],
};

/**
 * THE NARROW SHAPE THE SELECTION ALGORITHM ACTUALLY NEEDS.
 *
 * Every field the three-pass selection reads and nothing else — which is
 * exactly what a place already carries once it has been through
 * `compactPlace()`, so a *second* input shape (a place from an
 * already-compacted `CompactPacket`, e.g. one recovered from a preserved
 * request snapshot rather than rebuilt from a live `ResearchPacket`) can
 * feed the same selection logic without re-deriving anything, and without
 * this file holding two copies of the same three passes to drift apart.
 */
interface SelectablePlace {
  index: number;
  significance: number | null;
  clusterIndex: number | null;
  kind: string;
  tags: readonly string[];
}

function placeText(place: SelectablePlace): string {
  return `${place.kind} ${place.tags.join(' ')}`.toLowerCase();
}

/** How well a place's kind/tags match the traveller's `frequent`/`core` interests. Not a ranking of the trip — see the module header. */
function fitScore(place: SelectablePlace, strongInterests: readonly BenchmarkInterest[]): number {
  const text = placeText(place);
  let score = 0;
  for (const interest of strongInterests) {
    const keywords = INTEREST_KEYWORDS[interest];
    if (!keywords) continue;
    if (keywords.some((keyword) => text.includes(keyword))) score += 1;
  }
  return score;
}

/**
 * Deterministic tie-break: higher score first, lower index first. Index
 * rather than name/id, for the same reason `packet.ts` sorts by entity id —
 * a stable, opinion-free order that does not depend on anything a planner
 * would call quality.
 */
function byScoreThenIndex(scoreOf: (place: SelectablePlace) => number) {
  return (a: SelectablePlace, b: SelectablePlace): number => scoreOf(b) - scoreOf(a) || a.index - b.index;
}

/**
 * THE THREE PASSES, SHARED BY BOTH ENTRY POINTS.
 *
 * Returns which indices survived and why — nothing about *how* the caller
 * got its places (a live `ResearchPacket` or a preserved compact packet)
 * enters this function at all.
 */
function selectEvidenceIndices(
  places: readonly SelectablePlace[],
  strongInterests: readonly BenchmarkInterest[],
): { selectedIndices: number[]; includedFor: Map<number, Set<SkeletonEvidencePlace['includedFor'][number]>> } {
  const significanceOf = (place: SelectablePlace): number =>
    typeof place.significance === 'number' ? place.significance : -1;
  const fitOf = (place: SelectablePlace): number => fitScore(place, strongInterests);

  const includedFor = new Map<number, Set<SkeletonEvidencePlace['includedFor'][number]>>();
  const include = (place: SelectablePlace, reason: SkeletonEvidencePlace['includedFor'][number]): void => {
    const set = includedFor.get(place.index) ?? new Set();
    set.add(reason);
    includedFor.set(place.index, set);
  };

  const byCluster = new Map<number, SelectablePlace[]>();
  for (const place of places) {
    if (place.clusterIndex === null) continue;
    const bucket = byCluster.get(place.clusterIndex) ?? [];
    bucket.push(place);
    byCluster.set(place.clusterIndex, bucket);
  }

  for (const [, members] of byCluster) {
    const bySignificance = [...members].sort(byScoreThenIndex(significanceOf));
    const byFit = [...members].sort(byScoreThenIndex(fitOf));

    for (const place of bySignificance.slice(0, SKELETON_EVIDENCE_LIMITS.perClusterBySignificance)) {
      include(place, 'significant');
    }
    for (const place of byFit.slice(0, SKELETON_EVIDENCE_LIMITS.perClusterByFit)) {
      if (fitOf(place) > 0) include(place, 'fit');
    }

    // Cap this cluster's contribution: keep the highest combined score among
    // whatever the two passes above selected, dropping the rest — never the
    // cluster's absence, which the caller can already see from `clusters`.
    const clusterSelected = members.filter((place) => includedFor.has(place.index));
    if (clusterSelected.length > SKELETON_EVIDENCE_LIMITS.perClusterMax) {
      const overflow = [...clusterSelected]
        .sort(byScoreThenIndex((place) => significanceOf(place) + fitOf(place)))
        .slice(SKELETON_EVIDENCE_LIMITS.perClusterMax);
      for (const place of overflow) includedFor.delete(place.index);
    }
  }

  // Canonical floor: kept regardless of cluster quota or cluster membership at all.
  for (const place of places) {
    if (significanceOf(place) >= SKELETON_EVIDENCE_LIMITS.canonicalSignificanceFloor) {
      include(place, 'canonical');
    }
  }

  // Distinct-kind pass: one representative of every experience kind, so a
  // rare category is something the model can see and choose to omit rather
  // than never learn existed.
  const seenKinds = new Set<string>();
  for (const place of [...places].sort(byScoreThenIndex(significanceOf))) {
    if (seenKinds.has(place.kind)) continue;
    seenKinds.add(place.kind);
    if (!includedFor.has(place.index)) include(place, 'distinct_kind');
  }

  let selectedIndices = [...includedFor.keys()].sort((a, b) => a - b);
  if (selectedIndices.length > SKELETON_EVIDENCE_LIMITS.totalPlaceCap) {
    const byIndex = new Map(places.map((place) => [place.index, place]));
    const ranked = selectedIndices
      .map((index) => byIndex.get(index)!)
      .sort(byScoreThenIndex((place) => significanceOf(place) + fitOf(place)))
      .slice(0, SKELETON_EVIDENCE_LIMITS.totalPlaceCap);
    selectedIndices = ranked.map((place) => place.index).sort((a, b) => a - b);
  }

  return { selectedIndices, includedFor };
}

function strongInterestsOf(request: BenchmarkTripRequest): BenchmarkInterest[] {
  return (Object.entries(request.taste.interests) as [BenchmarkInterest, string][])
    .filter(([, level]) => level === 'frequent' || level === 'core')
    .map(([interest]) => interest)
    .sort();
}

function travellerContext(request: BenchmarkTripRequest, strongInterests: readonly string[]): SkeletonTravellerContext {
  return {
    nights: request.dates.nights,
    arrival: `${request.arrival.precision}${request.arrival.time ? ` ${request.arrival.time}` : ''}`,
    departure: `${request.departure.precision}${request.departure.time ? ` ${request.departure.time}` : ''}`,
    pace: request.rhythm.pace,
    activityIntensity: request.rhythm.activityIntensity,
    transportPreference: request.movement.preference,
    carAvailable: request.movement.carAvailable,
    maxDailyDriveMinutes: request.movement.maxDailyDriveMinutes,
    maxDailyTravelMinutes: request.movement.maxDailyTravelMinutes,
    desiredBaseCount: request.movement.desiredBaseCount,
    maxBaseChanges: request.movement.maxBaseChanges,
    strongInterests,
    hardAvoidances: [...request.taste.hardAvoidances].sort(),
    mustDo: request.taste.mustDo,
    budget: request.practicalities.budget,
  };
}

/** The one entry point: a full `ResearchPacket` and the traveller's request in, the bounded skeleton view out. */
export function buildSkeletonEvidencePacket(
  packet: ResearchPacket,
  request: BenchmarkTripRequest,
): SkeletonEvidencePacket {
  const strongInterests = strongInterestsOf(request);
  const selectable: SelectablePlace[] = packet.places.map((place) => ({
    index: place.index,
    significance: place.significance ?? null,
    clusterIndex: place.clusterIndex,
    kind: place.kind,
    tags: place.tags,
  }));
  const { selectedIndices, includedFor } = selectEvidenceIndices(selectable, strongInterests);

  const selectedSet = new Set(selectedIndices);
  const places: SkeletonEvidencePlace[] = selectedIndices.map((index) => {
    const place = packet.places[index]!;
    return {
      ...compactPlace(place),
      includedFor: [...(includedFor.get(index) ?? [])].sort(),
    };
  });

  const byCluster = new Map<number, number>();
  for (const place of packet.places) {
    if (place.clusterIndex === null) continue;
    byCluster.set(place.clusterIndex, (byCluster.get(place.clusterIndex) ?? 0) + 1);
  }

  const clusters: SkeletonEvidenceCluster[] = packet.clusters.map((cluster) => ({
    index: cluster.index,
    lat: round(cluster.centreLatitude),
    lng: round(cluster.centreLongitude),
    places: cluster.placeIndices.filter((index) => selectedSet.has(index)),
    totalPlacesInRegion: byCluster.get(cluster.index) ?? cluster.placeIndices.length,
  }));

  const routeLegs: SkeletonRouteLeg[] = packet.routeLegs
    .filter((leg: PacketRouteLeg) => selectedSet.has(leg.fromIndex) && selectedSet.has(leg.toIndex))
    .map((leg) => ({ from: leg.fromIndex, to: leg.toIndex, minutes: leg.minutes, mode: leg.mode }));

  const baseCandidates: SkeletonEvidenceBaseCandidate[] = packet.baseCandidates.map((base) => ({
    placeIndex: base.placeIndex,
    name: base.name,
    lat: round(base.latitude),
    lng: round(base.longitude),
    basis: base.basis,
  }));

  return {
    destination: {
      name: packet.destination.displayName,
      countryCode: packet.destination.countryCode,
      scale: packet.destination.scale,
    },
    tripLength: {
      days: packet.days.length,
      startDate: packet.days[0]?.date ?? request.dates.startDate ?? '',
      endDate: packet.days[packet.days.length - 1]?.date ?? request.dates.endDate ?? '',
    },
    traveller: travellerContext(request, strongInterests),
    places,
    totalPlacesInPacket: packet.places.length,
    clusters,
    baseCandidates,
    routeLegs,
  };
}

/**
 * THE SAME EVIDENCE, RECOVERED FROM AN ALREADY-COMPACTED PACKET.
 *
 * For exactly one situation: a preserved request snapshot from an earlier
 * live/diagnostic run holds `compactPacketForModel(packet)`'s output —
 * `untrusted.retrievedContent.packet` — but not the full `ResearchPacket`
 * it was built from (see `packet-compact.ts`'s own header for why only the
 * compact projection was ever meant to leave the process). Every field the
 * selection above reads — `significance`, `cluster`, `kind`, `tags` — is
 * already present on a `CompactPlace`, so this does not need the fields the
 * full `ResearchPacket` alone would have carried (`entityId`, full
 * multi-date hours, boolean `access` fields): a `SkeletonEvidencePlace`
 * carries no more detail than a `CompactPlace` already does, and this
 * produces byte-identical output to `buildSkeletonEvidencePacket` given
 * the `ResearchPacket` the compact packet was itself compacted from.
 */
export function buildSkeletonEvidencePacketFromCompact(
  compact: CompactPacket,
  request: BenchmarkTripRequest,
): SkeletonEvidencePacket {
  const strongInterests = strongInterestsOf(request);
  const selectable: SelectablePlace[] = compact.places.map((place) => ({
    index: place.index,
    significance: place.significance ?? null,
    clusterIndex: place.cluster,
    kind: place.kind,
    tags: place.tags ?? [],
  }));
  const { selectedIndices, includedFor } = selectEvidenceIndices(selectable, strongInterests);

  const selectedSet = new Set(selectedIndices);
  const placeByIndex = new Map(compact.places.map((place) => [place.index, place]));
  const places: SkeletonEvidencePlace[] = selectedIndices.map((index) => ({
    ...placeByIndex.get(index)!,
    includedFor: [...(includedFor.get(index) ?? [])].sort(),
  }));

  const clusters: SkeletonEvidenceCluster[] = compact.clusters.map((cluster) => ({
    index: cluster.index,
    lat: cluster.lat,
    lng: cluster.lng,
    places: cluster.places.filter((index) => selectedSet.has(index)),
    totalPlacesInRegion: cluster.places.length,
  }));

  const routeLegs: SkeletonRouteLeg[] = compact.routeLegs.filter(
    (leg) => selectedSet.has(leg.from) && selectedSet.has(leg.to),
  );

  const baseCandidates: SkeletonEvidenceBaseCandidate[] = compact.baseCandidates.map((base) => ({
    placeIndex: base.placeIndex,
    name: base.name,
    lat: base.lat,
    lng: base.lng,
    basis: base.basis,
  }));

  return {
    destination: compact.destination,
    tripLength: {
      days: compact.days.length,
      startDate: compact.days[0]?.date ?? request.dates.startDate ?? '',
      endDate: compact.days[compact.days.length - 1]?.date ?? request.dates.endDate ?? '',
    },
    traveller: travellerContext(request, strongInterests),
    places,
    totalPlacesInPacket: compact.places.length,
    clusters,
    baseCandidates,
    routeLegs,
  };
}
