import type { AccessKind } from './access-point';
import { assessConfidence, type DestinationEntityType, type ScopeBreadth } from '../schemas/geography';
import { GEOGRAPHIC_SCOPE_VERSION, scopeFingerprint, type GeographicScope } from '../schemas/scope';
import { licence } from '../schemas/licence';
import {
  COMPILED_REGION_VERSION,
  computeBlocking,
  type BaseCandidate,
  type CompiledRegion,
  type CoverageDimensionReport,
  type TravelTimeMatrixData,
} from '../schemas/compiled-region';
import type { Place } from '../schemas/place';
import type { AccessDataset, TransportMode } from '../schemas/access';
import type { OperatingHoursDataset } from '../schemas/hours';
import type { FoodDataset } from '../schemas/food';
import type { WeatherLocation } from '../schemas/weather';
import type { Region } from '../schemas/region';
import { estimateLegMinutes, haversineKm } from '../travel/estimate';
import { SCAN_KIND_PROFILES, type ScanBaseProposal, type ScanCandidateProposal, type ScanProposal } from './proposal';

/**
 * V1 CONVERGENCE — FROM A LOCATED PROPOSAL TO A REGION THE PRODUCT ALREADY READS.
 *
 * The scan writes the same artifact a compilation writes (`CompiledRegion`), so
 * the Discovery Board, the fit scorer, Auto-pick, the planner and the
 * reconciler's evidence tier all work on any destination without a second code
 * path. What it may claim is bounded by what it knows:
 *
 * - **Where**: from a geocoder or places provider. A candidate nobody could
 *   place is left off the region and reported, never given a guessed point.
 * - **How far**: from the matrix the caller measured, whose provenance the
 *   region carries (`measured` / `estimated`). Missing is never zero.
 * - **The soft attributes** (duration, effort, crowds, cost, season): the
 *   model's proposal, marked `estimatedDefaults` on every place so nothing
 *   downstream mistakes them for a published fact.
 * - **Hours and access**: unknown unless a source said otherwise — a gated
 *   site gets an `unknown` calendar with a recheck note, open ground gets an
 *   `always_open` record whose provenance says it is a category judgement.
 *
 * Pure: no clock (the caller passes `createdAt`), no provider, no model.
 */

export interface ResolvedPosition {
  coordinates: { lat: number; lng: number };
  /** `places`: a places provider identified the venue; `geocoder`: a geocoder matched the name; `locality`: only its town placed it. */
  method: 'places' | 'geocoder' | 'locality';
  provider: string;
  providerRef?: string;
  /** True when the point stands for the locality rather than the thing itself. */
  approximate: boolean;
  /** Settled locality from the provider, when it gave one. */
  locality?: string;
  /**
   * Private alpha — the coordinates are where the activity is *started* (a
   * trailhead, car park, lift station or hut), not the activity itself, which
   * is a route or an area. Routing uses the point; the itinerary keeps the
   * activity's own name. `footprint` is where the activity's area placed.
   * `name` only when the source may be stored (never a Google display name).
   */
  accessPoint?: { kind: AccessKind; provider: string; query: string; name?: string; footprint?: { lat: number; lng: number } };
  /** An area-level candidate whose access point was searched for and not verified. */
  accessPointUnverified?: boolean;
}

export interface ScanPoint {
  id: string;
  kind: 'place' | 'base';
  key: string;
  name: string;
  coordinates: { lat: number; lng: number };
}

/** Stable, readable ids. Deterministic in the proposal's order so a re-run of the same proposal yields the same ids. */
export function scanIdFor(prefix: 'place' | 'base', name: string, taken: Set<string>): string {
  const slug =
    name
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'item';
  let id = `scan-${prefix}-${slug}`;
  let n = 2;
  while (taken.has(id)) id = `scan-${prefix}-${slug}-${n++}`;
  taken.add(id);
  return id;
}

export interface ScanPointPlan {
  points: ScanPoint[];
  placeIdByKey: Map<string, string>;
  baseIdByKey: Map<string, string>;
  /** Proposals that could not be placed, with the reason, for the scan's own record and the board's footnote. */
  unplaced: { key: string; name: string; reason: string; code: 'not_placed' | 'approximate_only' | 'duplicate' }[];
}

/**
 * Which proposals become points, and their ids. The one decision here: a
 * candidate whose only position is its locality is kept (approximate) when it
 * is an area-like thing — a neighbourhood, a town, a drive, a market district —
 * where the locality *is* the place, and dropped otherwise, because a museum
 * pinned to the middle of its city is a pin in the wrong place.
 */
export function planScanPoints(proposal: ScanProposal, positions: ReadonlyMap<string, ResolvedPosition | null>): ScanPointPlan {
  const taken = new Set<string>();
  const points: ScanPoint[] = [];
  const placeIdByKey = new Map<string, string>();
  const baseIdByKey = new Map<string, string>();
  const unplaced: ScanPointPlan['unplaced'] = [];
  for (const base of proposal.bases) {
    const position = positions.get(base.key);
    if (!position) {
      unplaced.push({ key: base.key, name: base.name, reason: 'Could not be placed on the map.', code: 'not_placed' });
      continue;
    }
    /*
     * The same place to sleep proposed twice ("Hanoi Old Quarter" and "Hanoi Old
     * Quarter (return)") is one base: two halves of it each looked like less
     * than the other base and lost the first night to it. Whether to return to
     * it at the end is the route's decision (`orderBasesForEdges`), not the
     * proposal's.
     */
    const sameBase = points.find((p) => p.kind === 'base' && haversineKm(p.coordinates, position.coordinates) <= 2 && sharesLeadingName(p.name, base.name));
    if (sameBase) {
      baseIdByKey.set(base.key, sameBase.id);
      unplaced.push({ key: base.key, name: base.name, reason: `The same place to sleep as ${sameBase.name}.`, code: 'duplicate' });
      continue;
    }
    const id = scanIdFor('base', base.name, taken);
    baseIdByKey.set(base.key, id);
    points.push({ id, kind: 'base', key: base.key, name: base.name, coordinates: position.coordinates });
  }
  for (const candidate of proposal.candidates) {
    const position = positions.get(candidate.key);
    if (!position) {
      unplaced.push({ key: candidate.key, name: candidate.name, reason: 'Could not be placed on the map.', code: 'not_placed' });
      continue;
    }
    if (position.approximate && !AREA_LIKE.has(candidate.kind)) {
      unplaced.push({
        key: candidate.key,
        name: candidate.name,
        reason: position.accessPointUnverified ? 'A great fit, but only its area could be found and no trailhead, car park or lift could be verified — not planned until its access point is.' : 'Only its town could be placed, which is not precise enough to plan around.',
        code: 'approximate_only',
      });
      continue;
    }
    const duplicate = points.find((p) => p.kind === 'place' && haversineKm(p.coordinates, position.coordinates) <= 0.3 && sharesLeadingName(p.name, candidate.name));
    if (duplicate) {
      unplaced.push({ key: candidate.key, name: candidate.name, reason: `The same place as ${duplicate.name}.`, code: 'duplicate' });
      continue;
    }
    const id = scanIdFor('place', candidate.name, taken);
    placeIdByKey.set(candidate.key, id);
    points.push({ id, kind: 'place', key: candidate.key, name: candidate.name, coordinates: position.coordinates });
  }
  return { points, placeIdByKey, baseIdByKey, unplaced };
}

/** Two proposals for one place: within 300 m and sharing their first significant word ("Senso-ji" and "Senso-ji to the river"). */
function sharesLeadingName(a: string, b: string): boolean {
  const lead = (name: string) => name.normalize('NFKD').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).find((w) => w.length >= 4 && !['the', 'park', 'temple', 'shrine', 'museum', 'market', 'trail', 'lake'].includes(w)) ?? '';
  const x = lead(a);
  return x !== '' && x === lead(b);
}

const AREA_LIKE = new Set(['neighbourhood', 'small_town', 'scenic_drive', 'market', 'street_food', 'nightlife', 'island', 'national_park']);

/**
 * A matrix from coordinates alone, for when no router could answer. Labelled
 * `estimated` and built from the same mode-aware estimator the reconciler uses
 * (`travel/estimate.ts`), so the board and the plan agree about a guess.
 */
export function estimatedScanMatrix(points: readonly ScanPoint[], mode: 'car' | 'foot'): TravelTimeMatrixData {
  const ids = points.map((p) => p.id);
  const estimateMode: TransportMode = mode === 'car' ? 'drive' : 'walk';
  const minutes = points.map((a) => points.map((b) => (a.id === b.id ? 0 : Math.max(1, Math.round(estimateLegMinutes({ from: a.coordinates, to: b.coordinates, mode: estimateMode })?.minutes ?? fallbackMinutes(a, b, mode))))));
  const km = points.map((a) => points.map((b) => (a.id === b.id ? 0 : Math.round(haversineKm(a.coordinates, b.coordinates) * 10) / 10)));
  return {
    mode,
    ids,
    minutes,
    km,
    provenance: { kind: 'estimated', note: 'Estimated from straight-line distance with a road factor; no router answered.', source: 'sidequest-geo-estimate' },
  };
}

function fallbackMinutes(a: ScanPoint, b: ScanPoint, mode: 'car' | 'foot'): number {
  const km = haversineKm(a.coordinates, b.coordinates) * 1.3;
  return (km / (mode === 'car' ? 50 : 4.5)) * 60;
}

export interface AssembleScanRegionInput {
  regionId: string;
  destinationName: string;
  entityType: DestinationEntityType;
  breadth: ScopeBreadth;
  center: { lat: number; lng: number };
  countryCode?: string;
  regionCode?: string;
  timeZone: string;
  /** Trip calendar dates, first to last, inclusive. */
  dates: readonly string[];
  /** V1 — where the trip starts and ends (the arrival gateway, else the destination centre) and the usable minutes of each edge day. */
  edges?: { arrival: { lat: number; lng: number }; departure: { lat: number; lng: number }; arrivalUsableMinutes: number; departureUsableMinutes: number };
  carAvailable: boolean | null;
  /** From the traveller's hotel-switching tolerance. 0 keeps one base. */
  maxBaseChanges: number;
  proposal: ScanProposal;
  positions: ReadonlyMap<string, ResolvedPosition | null>;
  plan: ScanPointPlan;
  matrix: TravelTimeMatrixData;
  createdAt: string;
  /** Which providers answered, for the source manifest and the coverage note. */
  providers: { proposal: string; placement: readonly string[]; routing: string };
  /**
   * Somewhere to eat, from the scan's food step: venues whose `routingId` is
   * one of `plan.points` (snapped within a door walk), or null when nothing
   * usable came back. Absent means the caller ran no food step.
   */
  food?: ScanFoodInput;
}

/** What the scan's food step found, and how it went — the coverage row is written from `status`. */
export interface ScanFoodInput {
  dataset: FoodDataset | null;
  status: 'grounded' | 'partial' | 'empty' | 'unavailable' | 'disabled' | 'fixture';
  source: 'openstreetmap' | 'fixture' | null;
  /** The query service that answered, named by the caller for the source manifest; the engine never names one itself. */
  providerName?: string;
  /** One sentence in the product's voice, naming the numbers. */
  detail: string;
}

function foodCoverage(food: ScanFoodInput | undefined, foodAreas: number): CoverageDimensionReport {
  if (!food) return { dimension: 'food', level: 'weak', reasons: ['partial_results_returned'], detail: `${foodAreas} food areas suggested; venues are looked up when the trip is built.` };
  const covered = food.dataset?.venues.length ?? 0;
  switch (food.status) {
    case 'grounded':
      return { dimension: 'food', level: 'usable_with_cautions', reasons: ['partial_results_returned'], detail: food.detail, covered };
    case 'partial':
      return { dimension: 'food', level: 'usable_with_cautions', reasons: ['partial_results_returned', 'provider_unavailable'], detail: food.detail, covered };
    case 'fixture':
      return { dimension: 'food', level: 'usable_with_cautions', reasons: ['inferred_not_sourced'], detail: food.detail, covered };
    case 'empty':
      return { dimension: 'food', level: 'weak', reasons: ['no_results_returned'], detail: food.detail, covered: 0 };
    case 'unavailable':
      return { dimension: 'food', level: 'weak', reasons: ['provider_unavailable'], detail: food.detail, covered: 0 };
    case 'disabled':
      return { dimension: 'food', level: 'weak', reasons: ['no_provider_configured'], detail: food.detail, covered: 0 };
  }
}

export interface ScanAssembly {
  region: CompiledRegion;
  /** Bases the portfolio left out, with the reason. */
  basesLeftOut: { name: string; reason: string }[];
}

const DAY_MINUTES_PER_BASE_NIGHT = 360;
/** On a car-free trip, the longest hop still treated as a walk. Matches the planner's rule. */
const CAR_FREE_WALK_KM = 1.6;
/** Half a day of things to do, the least that justifies packing up and moving. */
const MIN_BASE_CONTENT_MINUTES = 180;

/**
 * Which bases, in what order, for how many nights. Deterministic, read off the
 * matrix and the candidates, never off the model's own night counts — those
 * are one input (the prior) among the measured ones.
 *
 * 1. Each candidate belongs to the nearest proposed base by matrix minutes.
 * 2. A base's value is the time its candidates would take to enjoy, weighted
 *    by tier, plus the model's night hint as a small prior.
 * 3. Keep at most `maxBaseChanges + 1` bases and never more than the nights
 *    allow at two nights each (one night only when a trip is short and moving).
 * 4. Order the kept bases along the shortest open path that starts at the
 *    proposal's first base (the model writes bases in arrival order; with no
 *    gateway known that is the only orientation evidence there is).
 * 5. Nights in proportion to value, largest remainder, at least one each.
 */
export function chooseScanBases(input: {
  bases: readonly { id: string; proposal: ScanBaseProposal }[];
  places: readonly { id: string; proposal: ScanCandidateProposal }[];
  minutes: (fromId: string, toId: string) => number | null;
  nights: number;
  maxBaseChanges: number;
  /** Where the trip starts and ends, and how much of each edge day is usable; absent means the order is decided by the bases alone. */
  edges?: TripEdges;
}): { kept: { id: string; nights: number; transferMinutesFromPrevious: number }[]; leftOut: { id: string; reason: string }[]; nearestBase: Map<string, string>; splitStay: boolean } {
  const { bases, places, minutes, nights } = input;
  const nearestBase = new Map<string, string>();
  const value = new Map<string, number>(bases.map((b) => [b.id, Math.min(2, b.proposal.nightsHint) * 60]));
  for (const place of places) {
    let best: { id: string; m: number } | null = null;
    for (const base of bases) {
      const m = minutes(base.id, place.id);
      if (m === null) continue;
      if (!best || m < best.m) best = { id: base.id, m };
    }
    if (!best) continue;
    nearestBase.set(place.id, best.id);
    const weight = place.proposal.tier === 'classic' ? 1 : place.proposal.tier === 'hidden_gem' ? 0.85 : 0.7;
    value.set(best.id, (value.get(best.id) ?? 0) + weight * place.proposal.durationMinutes);
  }
  const effectiveNights = Math.max(1, nights);
  const cap = Math.max(1, Math.min(bases.length, input.maxBaseChanges + 1, effectiveNights >= 4 ? Math.floor(effectiveNights / 2) : effectiveNights >= 2 ? 2 : 1));
  /*
   * A base earns a place by what is near it, not by the night count the
   * proposal suggested: beyond the first, a base needs at least half a day of
   * things to do that are closer to it than to any other base. The hint stays a
   * tie-breaking prior, never a reason on its own to pack and move.
   */
  const content = new Map<string, number>();
  for (const place of places) {
    const id = nearestBase.get(place.id);
    if (id) content.set(id, (content.get(id) ?? 0) + place.proposal.durationMinutes);
  }
  const ranked = [...bases].sort((a, b) => (value.get(b.id) ?? 0) - (value.get(a.id) ?? 0) || bases.indexOf(a) - bases.indexOf(b));
  const earns = (id: string, rank: number) => rank === 0 || places.length === 0 || (content.get(id) ?? 0) >= MIN_BASE_CONTENT_MINUTES;
  const keptIds = new Set(ranked.filter((b, rank) => rank < cap && earns(b.id, rank)).map((b) => b.id));
  const leftOut = ranked
    .filter((b) => !keptIds.has(b.id))
    .map((b) => ({
      id: b.id,
      reason:
        input.maxBaseChanges === 0
          ? 'You asked to keep to one place to sleep.'
          : (content.get(b.id) ?? 0) < MIN_BASE_CONTENT_MINUTES && places.length > 0
            ? 'Too little near it that is not already closer to another base.'
            : 'Fewer nights than it would take to make another move worthwhile.',
    }));
  // Candidates of a dropped base move to the nearest kept base.
  for (const place of places) {
    const current = nearestBase.get(place.id);
    if (current && keptIds.has(current)) continue;
    let best: { id: string; m: number } | null = null;
    for (const id of keptIds) {
      const m = minutes(id, place.id);
      if (m === null) continue;
      if (!best || m < best.m) best = { id, m };
    }
    if (best) nearestBase.set(place.id, best.id);
  }

  // Shortest open path from the proposal's first kept base — or, with the trip's edges known, the order that respects arrival and departure.
  const keptInProposalOrder = bases.filter((b) => keptIds.has(b.id)).map((b) => b.id);
  const ordered = input.edges ? orderBasesForEdges(keptInProposalOrder, minutes, input.edges, input.maxBaseChanges, effectiveNights) : { order: shortestOpenPath(keptInProposalOrder, minutes), splitStay: false };
  const order = ordered.order;

  // Nights by value, largest remainder, at least one each. A split stay shares its base's value: one arrival night, the rest at the end.
  const occurrences = (id: string) => order.filter((o) => o === id).length;
  const stayValue = (id: string, i: number) => {
    const v = Math.max(1, value.get(id) ?? 0);
    if (occurrences(id) === 1) return v;
    return i === order.indexOf(id) ? Math.max(1, v * 0.25) : v * 0.75;
  };
  const totalValue = order.reduce((n, id, i) => n + stayValue(id, i), 0);
  const raw = order.map((id, i) => (stayValue(id, i) / totalValue) * effectiveNights);
  const floors = raw.map((r) => Math.max(1, Math.floor(r)));
  let assigned = floors.reduce((a, b) => a + b, 0);
  const remainders = raw.map((r, i) => ({ i, rem: r - Math.floor(r) })).sort((a, b) => b.rem - a.rem || a.i - b.i);
  for (let k = 0; assigned < effectiveNights; k = (k + 1) % remainders.length) {
    floors[remainders[k]!.i]! += 1;
    assigned += 1;
  }
  while (assigned > effectiveNights) {
    // Over-assigned by the one-night floor: take back from the largest.
    const largest = floors.indexOf(Math.max(...floors));
    if (floors[largest]! <= 1) break;
    floors[largest]! -= 1;
    assigned -= 1;
  }
  const kept = order.map((id, i) => ({
    id,
    nights: floors[i]!,
    transferMinutesFromPrevious: i === 0 ? 0 : Math.round(minutes(order[i - 1]!, id) ?? 0),
  }));
  void DAY_MINUTES_PER_BASE_NIGHT;
  return { kept, leftOut, nearestBase, splitStay: ordered.splitStay };
}

/**
 * V1 — THE ARRIVAL DAY AND THE DEPARTURE DAY ARE PART OF THE ROUTE.
 *
 * Where a traveller lands and leaves, and how much of each of those days is
 * left once they have, decides which base comes first and last. An order is
 * scored by the transfer from the arrival point to its first base (weighted by
 * how little of the arrival day is usable, with a firm penalty when the
 * transfer would eat most of it), the transfers between bases, and the
 * transfer from its last base to the departure point (the same way). A split
 * stay — the arrival base again at the end — is allowed when it clearly wins
 * and the traveller's move tolerance covers the extra move. An early arrival
 * may still go straight on: that is a routing decision, not a rule.
 */
export interface TripEdges {
  /** Minutes from where the traveller arrives to each base, estimated; null when unknown. */
  fromArrival: (baseId: string) => number | null;
  /** Minutes from each base to where the traveller leaves. */
  toDeparture: (baseId: string) => number | null;
  /** Minutes of the arrival day left once landed and settled. */
  arrivalUsableMinutes: number;
  /** Minutes of the departure day before the traveller must leave for the airport or station. */
  departureUsableMinutes: number;
}

/** Weighted minutes a transfer costs on an edge day: dearer the less of the day there is, with a firm penalty past 40% of it. */
export function edgeTransferCost(minutes: number | null, usableMinutes: number): number {
  if (minutes === null || minutes <= 20) return 0;
  const weight = Math.max(0.5, Math.min(4, 300 / Math.max(60, usableMinutes)));
  return minutes * weight + (minutes > 0.4 * Math.max(0, usableMinutes) ? 180 : 0);
}

/** A split stay must beat the best plain order by this many weighted minutes to be worth the extra move. */
const SPLIT_STAY_MIN_GAIN = 120;

export function orderBasesForEdges(ids: readonly string[], minutes: (a: string, b: string) => number | null, edges: TripEdges, maxBaseChanges: number, nights: number): { order: string[]; splitStay: boolean } {
  if (ids.length <= 1) return { order: [...ids], splitStay: false };
  const leg = (a: string, b: string) => minutes(a, b) ?? 10_000;
  const costOf = (order: readonly string[]) => {
    let total = edgeTransferCost(edges.fromArrival(order[0]!), edges.arrivalUsableMinutes) + edgeTransferCost(edges.toDeparture(order[order.length - 1]!), edges.departureUsableMinutes);
    for (let i = 1; i < order.length; i += 1) total += leg(order[i - 1]!, order[i]!);
    return total;
  };
  const permutations = (rest: readonly string[]): string[][] => (rest.length <= 1 ? [[...rest]] : rest.flatMap((head, i) => permutations([...rest.slice(0, i), ...rest.slice(i + 1)]).map((tail) => [head, ...tail])));
  let best: { order: string[]; cost: number } | null = null;
  for (const order of permutations(ids)) {
    const cost = costOf(order);
    if (!best || cost < best.cost) best = { order, cost };
  }
  /* The split stay: the base nearest both ends holds the first night and the last. Every stay keeps at least one night, and the moves stay within tolerance. */
  if (ids.length + 1 <= nights && ids.length <= maxBaseChanges) {
    const anchor = [...ids].sort((a, b) => ((edges.fromArrival(a) ?? 999) + (edges.toDeparture(a) ?? 999)) - ((edges.fromArrival(b) ?? 999) + (edges.toDeparture(b) ?? 999)))[0]!;
    const rest = ids.filter((id) => id !== anchor);
    let split: { order: string[]; cost: number } | null = null;
    for (const middle of permutations(rest)) {
      const order = [anchor, ...middle, anchor];
      const cost = costOf(order);
      if (!split || cost < split.cost) split = { order, cost };
    }
    if (split && split.cost + SPLIT_STAY_MIN_GAIN <= best!.cost) return { order: split.order, splitStay: true };
  }
  return { order: best!.order, splitStay: false };
}

/** Open path from the first id visiting all, minimum total minutes. Exhaustive up to 7 stops (the base cap is 6). */
export function shortestOpenPath(ids: readonly string[], minutes: (a: string, b: string) => number | null): string[] {
  if (ids.length <= 2) return [...ids];
  const [first, ...rest] = ids;
  let best: { path: string[]; cost: number } | null = null;
  const permute = (prefix: string[], remaining: string[], cost: number) => {
    if (best && cost >= best.cost) return;
    if (remaining.length === 0) {
      best = { path: prefix, cost };
      return;
    }
    for (const next of remaining) {
      const step = minutes(prefix[prefix.length - 1]!, next);
      permute([...prefix, next], remaining.filter((r) => r !== next), cost + (step ?? 10_000));
    }
  };
  permute([first!], rest, 0);
  return (best as { path: string[] } | null)?.path ?? [...ids];
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function monthsOf(dates: readonly string[]): number[] {
  return [...new Set(dates.map((d) => Number(d.slice(5, 7))))].sort((a, b) => a - b);
}

export function assembleScanRegion(input: AssembleScanRegionInput): ScanAssembly {
  const { proposal, positions, plan, matrix } = input;
  const nights = Math.max(0, input.dates.length - 1);
  const index = new Map(matrix.ids.map((id, i) => [id, i]));
  const matrixMinutes = (a: string, b: string): number | null => {
    const i = index.get(a);
    const j = index.get(b);
    if (i === undefined || j === undefined) return null;
    const value = matrix.minutes[i]?.[j];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  };
  /*
   * Door-to-door minutes for the scan's own geography (which base, how far a
   * transfer is, how far a place sits from where you sleep). On a car-free
   * trip a long hop is public transport, estimated — never a ninety-kilometre
   * walk, which is how a live Hanoi trip once gave a two-night base a
   * 1,485-minute transfer and left its days empty. The stored matrix keeps its
   * own mode and provenance; this only decides geography.
   */
  const pointAt = new Map(plan.points.map((p) => [p.id, p.coordinates] as const));
  const minutes = (a: string, b: string): number | null => {
    const measured = matrixMinutes(a, b);
    if (matrix.mode !== 'foot') return measured;
    const pa = pointAt.get(a);
    const pb = pointAt.get(b);
    if (!pa || !pb) return measured;
    if (haversineKm(pa, pb) <= CAR_FREE_WALK_KM) return measured;
    return estimateLegMinutes({ from: pa, to: pb, mode: 'rail' })?.minutes ?? measured;
  };
  const kmBetween = (a: string, b: string): number | null => {
    const i = index.get(a);
    const j = index.get(b);
    if (i === undefined || j === undefined) return null;
    const value = matrix.km[i]?.[j];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  };

  const baseEntries = proposal.bases
    .map((b) => ({ id: plan.baseIdByKey.get(b.key), proposal: b }))
    .filter((b): b is { id: string; proposal: ScanBaseProposal } => b.id !== undefined)
    /* A base proposed twice is one base, kept under its first proposal. */
    .filter((b, i, all) => all.findIndex((other) => other.id === b.id) === i);
  const placeEntries = proposal.candidates
    .map((c) => ({ id: plan.placeIdByKey.get(c.key), proposal: c }))
    .filter((c): c is { id: string; proposal: ScanCandidateProposal } => c.id !== undefined);
  if (baseEntries.length === 0) throw new Error('A scan region needs at least one placed base.');

  const edgeMinutes = (point: { lat: number; lng: number }, baseId: string): number | null => {
    const at = pointAt.get(baseId);
    if (!at) return null;
    if (haversineKm(at, point) <= CAR_FREE_WALK_KM) return 0;
    return estimateLegMinutes({ from: point, to: at, mode: matrix.mode === 'foot' ? 'rail' : 'drive' })?.minutes ?? null;
  };
  const edges: TripEdges | undefined = input.edges
    ? {
        fromArrival: (id) => edgeMinutes(input.edges!.arrival, id),
        toDeparture: (id) => edgeMinutes(input.edges!.departure, id),
        arrivalUsableMinutes: input.edges.arrivalUsableMinutes,
        departureUsableMinutes: input.edges.departureUsableMinutes,
      }
    : undefined;
  const choice = chooseScanBases({ bases: baseEntries, places: placeEntries, minutes, nights, maxBaseChanges: input.maxBaseChanges, ...(edges ? { edges } : {}) });
  const keptIds = choice.kept.map((k) => k.id);
  const primaryBaseId = keptIds[0]!;
  const positionOf = (key: string) => positions.get(key)!;
  const baseById = new Map(baseEntries.map((b) => [b.id, b]));
  const lastVerified = input.createdAt.slice(0, 10);
  const mode: 'car' | 'foot' = matrix.mode === 'car' ? 'car' : 'foot';
  const transportModes: TransportMode[] = input.carAvailable === false ? ['walk', 'public_bus', 'rail', 'rideshare'] : ['drive', 'walk'];

  // --- places -------------------------------------------------------------------
  const places: Place[] = placeEntries.map(({ id, proposal: c }) => {
    const position = positionOf(c.key)!;
    const profile = SCAN_KIND_PROFILES[c.kind];
    const baseId = choice.nearestBase.get(id) ?? primaryBaseId;
    const fromBase = minutes(baseId, id);
    const fromBaseKm = kmBetween(baseId, id);
    const outdoor = c.exposure === 'outdoor';
    const indoor = c.exposure === 'indoor';
    const popularity = c.tier === 'classic' ? 0.8 : c.tier === 'side_quest' ? 0.45 : 0.25;
    const hidden = c.tier === 'hidden_gem' ? 0.75 : c.tier === 'side_quest' ? 0.5 : 0.15;
    const sourceName =
      position.accessPoint
        ? `Proposed by Sidequest's research model; routed from its ${position.accessPoint.kind.replace(/_/g, ' ')}${position.accessPoint.name ? ` (${position.accessPoint.name})` : ''}, located with ${position.provider}`
        : position.method === 'places'
        ? `Proposed by Sidequest's research model; located with ${position.provider}`
        : position.method === 'geocoder'
          ? `Proposed by Sidequest's research model; located with ${position.provider}`
          : `Proposed by Sidequest's research model; placed at its town by ${position.provider}`;
    const place: Place = {
      id,
      regionId: input.regionId,
      name: c.name,
      // The proposal's own locality, in the traveller's language; the geocoder's is a fallback, never a replacement.
      locality: c.locality || position.locality || input.destinationName,
      shortDescription: c.why.slice(0, 280),
      coordinates: position.coordinates,
      tags: [`kind:${c.kind}`, `tier:${c.tier}`, ...(c.zone ? [`zone:${c.zone}`] : []), ...(c.booking !== 'none' ? [`booking:${c.booking}`] : []), ...(position.approximate ? ['position:approximate'] : []), ...(position.accessPoint ? [`access:${position.accessPoint.kind}`, ...(position.accessPoint.footprint ? [`footprint:${position.accessPoint.footprint.lat.toFixed(5)},${position.accessPoint.footprint.lng.toFixed(5)}`] : [])] : [])],
      source: {
        name: sourceName,
        kind: position.method === 'places' && position.provider.includes('google') ? 'google_places' : 'osm',
        confidence: position.method === 'places' ? 0.7 : position.method === 'geocoder' ? 0.6 : 0.4,
        lastVerified,
      },
      relationship: fromBase !== null && fromBase <= (mode === 'car' ? 20 : 25) ? 'base' : 'satellite',
      category: profile.category,
      displayKind: profile.label,
      experienceSignificance: c.tier === 'classic' ? 0.8 : c.tier === 'hidden_gem' ? 0.6 : 0.5,
      hoursExpectation: profile.hours,
      durationBasis: 'category_estimate',
      estimatedDefaults: ['access', 'seasonal_access', 'physical_intensity', 'crowd_level', 'cost_level'],
      interests: c.interests.length > 0 ? c.interests : [...profile.interests],
      typicalDurationMinutes: Math.max(15, Math.min(600, c.durationMinutes)),
      costLevel: c.costLevel,
      physicalIntensity: c.intensity,
      crowdLevel: c.crowd,
      popularityScore: popularity,
      hiddenGemScore: hidden,
      weather: {
        exposure: indoor ? 'indoor' : outdoor ? 'exposed_outdoor' : 'mixed',
        precipitation: indoor ? 'low' : outdoor ? 'high' : 'moderate',
        wind: indoor ? 'low' : outdoor && (c.kind === 'boat_trip' || c.kind === 'day_hike' || c.kind === 'viewpoint') ? 'high' : 'moderate',
        heat: indoor ? 'low' : outdoor && c.intensity !== 'none' && c.intensity !== 'easy' ? 'high' : 'moderate',
        cold: indoor ? 'low' : outdoor ? 'moderate' : 'low',
        visibilityDependent: profile.visibilityDependent && !indoor,
        poorWeatherBackup: c.rainyDayOk || indoor,
        approachDegradesWhenWet: outdoor && (c.kind === 'day_hike' || c.kind === 'scenic_drive'),
        note: indoor ? 'Indoors; weather barely matters.' : outdoor ? 'Outdoors and exposed; the forecast decides how good this is.' : 'Partly outdoors.',
      },
      bestTimeOfDay: c.bestTime,
      seasonalAccess: {
        openMonths: c.openMonths && c.openMonths.length > 0 ? c.openMonths : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
        closureRisk: c.openMonths && c.openMonths.length > 0 && c.openMonths.length < 12 ? 'seasonal' : 'none',
        ...(c.seasonalNote ? { note: c.seasonalNote } : {}),
      },
      access: { roadSurface: 'paved', mountainRoad: false, parkingDifficulty: 'moderate', remoteNoServices: false },
      travelFromBase: {
        distanceKm: fromBaseKm ?? 0,
        driveMinutes: Math.max(0, Math.round(fromBase ?? 0)),
        driveIsScenic: c.kind === 'scenic_drive',
        mode,
      },
      ...(c.caution || c.booking !== 'none'
        ? { logisticsNote: [c.caution, c.booking === 'required' ? 'Booking required — reserve ahead.' : c.booking === 'recommended' ? 'Booking recommended.' : null].filter(Boolean).join(' ') }
        : {}),
    };
    return place;
  });

  // --- bases ----------------------------------------------------------------------
  const bases: BaseCandidate[] = baseEntries.map(({ id, proposal: b }) => {
    const position = positionOf(b.key)!;
    const kept = choice.kept.find((k) => k.id === id);
    const within = places.filter((p) => (choice.nearestBase.get(p.id) ?? primaryBaseId) === id).map((p) => p.id);
    return {
      id,
      name: b.name,
      coordinates: position.coordinates,
      role: id === primaryBaseId ? 'primary_base' : kept ? 'secondary_base' : 'satellite',
      routingId: id,
      timeZone: input.timeZone,
      suggestedNights: { min: 1, max: Math.max(1, Math.min(30, kept?.nights ?? Math.max(1, b.nightsHint))) },
      placesWithinReach: within,
      transportModes,
      lodgingEvidence: 'unknown',
      rationale: b.why,
      tradeoffs: [],
      evidenceFactIds: [],
    } as BaseCandidate;
  });

  // --- base portfolio ---------------------------------------------------------------
  let cursor = input.dates[0]!;
  const portfolioBases = choice.kept.map((k, order) => {
    const fromDate = cursor;
    const toDate = order === choice.kept.length - 1 ? input.dates[input.dates.length - 1]! : addDays(fromDate, k.nights);
    cursor = toDate;
    return {
      clusterId: choice.kept.findIndex((other) => other.id === k.id) === order ? `cluster-${k.id}` : `cluster-${k.id}-return`,
      baseId: k.id,
      baseName: baseById.get(k.id)!.proposal.name,
      order,
      nights: k.nights,
      fromDate,
      toDate,
      transferMinutesFromPrevious: k.transferMinutesFromPrevious,
      transferIsWholeDay: k.transferMinutesFromPrevious > 300,
    };
  });

  // --- datasets -----------------------------------------------------------------------
  const operatingHours: OperatingHoursDataset = {
    version: 1,
    regionId: input.regionId,
    calendars: places.map((place) =>
      place.hoursExpectation === 'open_ground'
        ? {
            kind: 'always_open' as const,
            placeId: place.id,
            admission: { reservationRequired: false, timedEntry: false, permitRequired: false, walkInAllowed: true, capacityLimited: false },
            daylightOnly: false,
            note: 'Open ground — no staffed opening hours apply.',
            provenance: { kind: 'estimated' as const, sourceName: 'Category of place', confidence: 0.6, volatility: 'stable' as const },
          }
        : {
            kind: 'unknown' as const,
            placeId: place.id,
            admission: {
              reservationRequired: place.tags.includes('booking:required'),
              timedEntry: false,
              permitRequired: false,
              walkInAllowed: !place.tags.includes('booking:required'),
              capacityLimited: false,
              note: 'Entry rules are not recorded; check before you go.',
            },
            daylightOnly: false,
            note: 'We hold no opening-hours record for this place.',
            provenance: {
              kind: 'estimated' as const,
              sourceName: 'No source',
              confidence: 0,
              volatility: 'dynamic' as const,
              recheckNote: 'Opening hours are checked when the trip is built, where a provider has them. Check before you go.',
            },
          },
    ),
  } as OperatingHoursDataset;

  const access: AccessDataset = {
    regionId: input.regionId,
    points: [],
    services: [],
    rules: places.map((place, i) => ({
      id: `scan-rule-${i}`,
      label: `Access to ${place.name}`,
      placeIds: [place.id],
      months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
      approachMode: input.carAvailable === false ? 'walk' : 'drive',
      ...(input.carAvailable === false ? { approachMinutes: null } : {}),
      privateVehicle: 'allowed',
      serviceRequirement: 'none',
      walkMinutesFromDropOff: 0,
      internalTransfer: { mode: 'walk', minutes: 0 },
      permitRequired: false,
      notes: [],
      provenance: {
        kind: 'estimated',
        sourceName: 'Located on a map; access not checked',
        confidence: 0.4,
        volatility: 'dynamic',
        recheckNote: 'We know where this is, not whether it is open to the public on your dates. Check before you go.',
      },
    })),
  } as AccessDataset;

  // Each place is claimed by the forecast point of the base it belongs to.
  const weatherLocations: WeatherLocation[] = keptIds
    .map((baseId) => {
      const base = baseById.get(baseId)!;
      const claimed = places.filter((p) => (keptIds.includes(choice.nearestBase.get(p.id) ?? '') ? choice.nearestBase.get(p.id) : primaryBaseId) === baseId).map((p) => p.id);
      return {
        id: `${input.regionId}:wx:${baseId}`,
        label: base.proposal.name,
        coordinates: positionOf(base.proposal.key)!.coordinates,
        elevationMetres: 0,
        timeZone: input.timeZone,
        placeIds: claimed,
        limitation: 'One forecast point for this base and the places around it; elevation is not accounted for.',
      };
    })
    .filter((location) => location.placeIds.length > 0);

  // --- scope and region -----------------------------------------------------------------
  const allPoints = plan.points.map((p) => p.coordinates);
  const radiusKm = Math.min(3000, Math.max(5, Math.ceil(Math.max(0, ...allPoints.map((p) => haversineKm(input.center, p))) * 1.1)));
  const firstBase = baseById.get(primaryBaseId)!;
  const scope: GeographicScope = {
    schemaVersion: GEOGRAPHIC_SCOPE_VERSION,
    revision: 1,
    destinationCandidateId: input.regionId,
    destinationName: input.destinationName,
    destinationEntityType: input.entityType,
    breadth: input.breadth,
    center: input.center,
    boundaryEvidence: 'reach_circle',
    reachRadiusKm: radiusKm,
    administrative: {
      ...(input.countryCode ? { countryCode: input.countryCode } : {}),
      ...(input.regionCode ? { regionCode: input.regionCode } : {}),
      aliases: [],
      hierarchy: [],
      divisionIds: [],
    },
    ...(input.countryCode ? { countryCode: input.countryCode } : {}),
    timeZones: [input.timeZone],
    shape: { kind: 'radius', center: input.center, radiusKm },
    includedAreas: [],
    excludedAreas: [],
    gateways: [],
    transport: {
      primaryMode: input.carAvailable === false ? 'walk' : 'drive',
      allowedModes: transportModes,
      carAvailable: input.carAvailable,
      acceptsWaterOrAirTransfers: null,
      basis: 'profile',
      note: input.carAvailable === false ? 'Planned without a car.' : 'Planned with a car available.',
    },
    maxBaseChanges: Math.max(0, Math.min(10, input.maxBaseChanges)),
    nights: Math.min(30, nights),
    rationale: `The area the scan's places span, around ${input.destinationName}.`,
    confidence: assessConfidence(['single_provider_only', 'model_inference_only']),
    decidedBy: [],
    confirmedByUser: true,
  } as GeographicScope;

  const region: Region = {
    id: input.regionId,
    name: input.destinationName,
    baseName: firstBase.proposal.name,
    baseCoordinates: positionOf(firstBase.proposal.key)!.coordinates,
    summary: proposal.package.transportSummary || `${input.destinationName}, as Sidequest's scan found it.`,
    maxRadiusKm: radiusKm,
    aliases: [],
    transportSummary: proposal.package.transportSummary || 'How you get around depends on the bases you choose.',
    noVehicleSummary: 'Without a vehicle, the places furthest from where you sleep may be out of reach.',
  } as Region;

  // --- coverage, said honestly --------------------------------------------------------------
  const precise = placeEntries.filter((p) => positionOf(p.proposal.key)?.method !== 'locality').length;
  const measured = matrix.provenance.kind === 'measured';
  const dimensions: CoverageDimensionReport[] = [
    { dimension: 'geographic_resolution', level: 'usable_with_cautions', reasons: ['inferred_not_sourced'], detail: 'An area drawn around the places the scan found, not a published boundary.' },
    { dimension: 'places', level: places.length >= 12 ? 'usable_with_cautions' : 'weak', reasons: ['inferred_not_sourced'], detail: `${places.length} places proposed by Sidequest's research model and located on a map (${precise} precisely).`, expected: proposal.candidates.length, covered: places.length },
    { dimension: 'mainstream_attractions', level: 'usable_with_cautions', reasons: ['inferred_not_sourced'], detail: 'Classics come from travel knowledge, not a popularity database.' },
    { dimension: 'hidden_gems', level: 'usable_with_cautions', reasons: ['inferred_not_sourced'], detail: 'Quieter places were proposed deliberately; how quiet they are is a judgement, not a count.' },
    { dimension: 'operating_hours', level: 'weak', reasons: ['no_official_source_found'], detail: 'No opening hours are stored here; staffed places are checked when the trip is built where a provider has them.', expected: places.length, covered: 0 },
    { dimension: 'road_routing', level: mode === 'car' ? (measured ? 'high' : 'usable_with_cautions') : 'not_applicable', reasons: mode === 'car' ? [measured ? 'fully_covered' : 'inferred_not_sourced'] : ['not_relevant_to_region'], detail: measured ? `Travel times measured by ${input.providers.routing}.` : 'Travel times estimated from distance; no router answered.' },
    { dimension: 'walking_routing', level: mode === 'foot' ? (measured ? 'high' : 'usable_with_cautions') : 'not_applicable', reasons: mode === 'foot' ? [measured ? 'fully_covered' : 'inferred_not_sourced'] : ['not_relevant_to_region'], detail: measured ? `Walking times measured by ${input.providers.routing}.` : 'Walking times estimated from distance.' },
    { dimension: 'transit_routing', level: 'weak', reasons: ['no_provider_configured'], detail: 'Public transport is not timed; legs that need it are shown as estimates.' },
    { dimension: 'weather', level: 'usable_with_cautions', reasons: ['partial_results_returned'], detail: `${weatherLocations.length} forecast point${weatherLocations.length === 1 ? '' : 's'}, one per base.` },
    foodCoverage(input.food, proposal.foodAreas.length),
    { dimension: 'official_sources', level: 'weak', reasons: ['no_official_source_found'], detail: 'Nothing here was read off an official page.' },
    { dimension: 'source_freshness', level: 'usable_with_cautions', reasons: ['evidence_stale'], detail: `Scanned ${lastVerified}. Conditions change; check before you go.` },
  ];
  /*
   * Food: only venues priced against a row this region's matrix holds and
   * belonging to this region. Anything else would fail the region's integrity
   * gate, and food is never worth failing a scan over — it is dropped instead.
   */
  const matrixIds = new Set(matrix.ids);
  const foodVenues = (input.food?.dataset?.venues ?? []).filter((venue) => matrixIds.has(venue.routingId)).map((venue) => ({ ...venue, regionId: input.regionId }));
  const food: FoodDataset | null = foodVenues.length > 0 ? { version: 1, regionId: input.regionId, venues: foodVenues, gaps: [] } : null;
  const blocking = computeBlocking(dimensions, { drivingPlanned: mode === 'car' });

  const compiled: CompiledRegion = {
    schemaVersion: COMPILED_REGION_VERSION,
    id: `compiled-${input.regionId}`,
    compilerVersion: SCAN_COMPILER_VERSION,
    region,
    scope,
    scopeFingerprint: scopeFingerprint(scope),
    bases,
    primaryBaseId,
    subregions: [],
    satellites: places
      .filter((p) => p.relationship === 'satellite')
      .map((p) => ({
        id: `sat-${p.id}`,
        name: p.name,
        parentBaseId: choice.nearestBase.get(p.id) ?? primaryBaseId,
        placeIds: [p.id],
        minutesFromBase: p.travelFromBase.driveMinutes,
        suggestedMinutes: p.typicalDurationMinutes,
        requiredModes: [],
        seasonalMonths: p.seasonalAccess.openMonths.length === 12 ? [] : [...p.seasonalAccess.openMonths],
        evidenceFactIds: [],
      })),
    places,
    access,
    operatingHours,
    weatherLocations,
    travelTimes: matrix,
    ...(food ? { food } : {}),
    ...(portfolioBases.length > 0
      ? {
          basePortfolio: {
            bases: portfolioBases,
            excluded: choice.leftOut.map((l) => ({ clusterId: `cluster-${l.id}`, name: baseById.get(l.id)!.proposal.name, reason: l.reason, unreachable: false })),
            transferDays: portfolioBases.filter((b) => b.transferIsWholeDay).length,
            rationale:
              choice.splitStay
                ? `The first and last nights are near where you arrive and leave, so neither travel day also carries a long transfer; the stays between them are in the order that keeps the moves shortest.`
                : portfolioBases.length > 1
                ? `${portfolioBases.length} bases in the order that keeps the moves between them shortest${input.edges ? ' and the arrival and departure days light' : ''}, nights in proportion to what is near each.`
                : 'One base: everything worth doing is within reach of it, or you asked to stay put.',
          },
        }
      : {}),
    licences: [
      ...(input.food?.source === 'openstreetmap' && food ? [licence('ODbL-1.0', ['food'])] : []),
      licence('sidequest-authored', ['places', 'access', 'hours']),
    ],
    sourceManifest: {
      facts: [],
      pages: [],
      providers: [
        { name: input.providers.proposal, version: '1', calls: 1, failures: 0 },
        ...input.providers.placement.map((name) => ({ name, version: '1', calls: 0, failures: 0 })),
        { name: input.providers.routing, version: '1', calls: 0, failures: 0 },
        ...(food && input.food?.source === 'openstreetmap' ? [{ name: input.food.providerName ?? 'openstreetmap', version: '1', calls: 0, failures: 0 }] : []),
      ],
      attributions: [],
    },
    coverage: {
      dimensions,
      blocksItinerary: blocking.blocksItinerary,
      blockingDimensions: blocking.blockingDimensions,
      recheckFactIds: [],
      summary: `Proposed by Sidequest's research model for this traveller, located on a map, timed by ${measured ? input.providers.routing : 'distance estimates'}. Hours and access are checked when the trip is built.`,
    },
    diagnostics: {
      compilerVersion: SCAN_COMPILER_VERSION,
      startedAt: input.createdAt,
      finishedAt: input.createdAt,
      stageCount: 0,
      stageTimings: [],
      budget: { consumed: {}, limits: {}, exhausted: [] },
      promptVersions: {},
      warnings: plan.unplaced.map((u) => `Not placed: ${u.name} — ${u.reason}`).slice(0, 20),
    },
    createdAt: input.createdAt,
  } as CompiledRegion;

  return {
    region: compiled,
    basesLeftOut: choice.leftOut.map((l) => ({ name: baseById.get(l.id)!.proposal.name, reason: l.reason })),
  };
}

export const SCAN_COMPILER_VERSION = 'discovery-scan/1';

/** Months the scan's dates touch, for callers assembling a region request. */
export { monthsOf as scanMonthsOf };
