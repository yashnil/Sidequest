import type { GeoBounds } from '../schemas/geography';
import { haversineKm } from '../travel/estimate';
import type { ScanProposal } from './proposal';

/**
 * Eval v3 — A PLACE TO SLEEP PLACED FAR OUTSIDE THE TRIP.
 *
 * A live "Tanzania safari" scan proposed "Tarangire area lodges"; the geocoder
 * answered with a row in Dar es Salaam, hundreds of kilometres from every other
 * base and every candidate of a northern-circuit safari. A country-wide extent
 * contains Dar es Salaam, so the destination's extent alone cannot refuse it,
 * and a distance-from-centre envelope wide enough for a road trip admits it.
 *
 * The rule judges a base against the trip's own evidence footprint — the other
 * placed bases and candidates — and never against a place name:
 *
 * 1. **Detached.** Points are linked when within `T` of each other (single
 *    linkage), `T = max(FOOTPRINT_LINK_FLOOR_KM, 3 × the median nearest-neighbour
 *    distance)`. The floor is wider than an island chain's longest hop (Hawaii's
 *    Kauai–Oʻahu channel is ~170 km between placed points) and a road trip's
 *    usual spacing between a base and its nearest stop, so a legitimately spread
 *    trip stays one footprint. A base outside the largest linked group is
 *    detached. Judged only with at least `FOOTPRINT_MIN_POINTS` placed points
 *    and another placed base inside the largest group — too little evidence is
 *    unknown, never a refusal, and the last base is never taken away.
 * 2. **Not protected.** A base within reach of a part the traveller named, or
 *    on the way between two points outside its own group (a road-trip night
 *    between two stretches: `d(A,B0)+d(B0,C) ≤ 1.25·d(A,C)`), is kept.
 * 3. **One affirmative ground**, recorded on the result:
 *    - `contradicted_by_own_places` — a placed candidate whose name or locality
 *      carries the base's distinctive word ("Tarangire") lies in the main
 *      footprint: the proposal's own places say where that base is;
 *    - `unsupported` — the base's linked group holds no candidate at all: a
 *      place to sleep with nothing to do near it is not a stay of this trip;
 *    - `outside_extent` — the destination has an evidenced extent, the base is
 *      outside it by more than `max(50 km, 25 % of its diagonal)`, and its group
 *      is a minority (≤ 20 % of the placed points).
 *
 * A detached base with none of these grounds is kept: unknown ≠ false.
 */

export const FOOTPRINT_LINK_FLOOR_KM = 250;
export const FOOTPRINT_MIN_POINTS = 5;
const NN_FACTOR = 3;
const PART_REACH_KM = 75;
const CORRIDOR_RATIO = 1.25;
const MINORITY_SHARE = 0.2;

type LatLng = { lat: number; lng: number };

export type OutlyingBaseGround = 'contradicted_by_own_places' | 'unsupported' | 'outside_extent';

export interface OutlyingBase {
  key: string;
  name: string;
  ground: OutlyingBaseGround;
  /** Straight-line distance to the nearest point of the main footprint, rounded. */
  gapKm: number;
  reason: string;
}

export interface FootprintContext {
  /** The destination's evidenced extent (published, union of parts or interpreted parts); omit when none. */
  extent?: GeoBounds | null;
  /** Parts the traveller named, placed. */
  parts?: readonly { label: string; center: LatLng }[];
}

/** Words that describe a kind of stay or a direction, never which place it is. */
const GENERIC = new Set(
  'area areas lodge lodges camp camps hotel hotels town towns city centre center village villages national park parks lake lakes region near base stay stays central north south east west northern southern eastern western upper lower old new the and district quarter beach beaches resort resorts river valley mountain mountains island islands coast gateway airport side road downtown guesthouse guesthouses hostel inn hut huts cabin cabins conservation reserve game safari'.split(' '),
);

const fold = (value: string) => value.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export function distinctiveWords(...labels: readonly (string | undefined)[]): string[] {
  const words = labels.flatMap((label) => (label ? fold(label).split(' ') : []));
  return [...new Set(words.filter((w) => w.length >= 4 && !GENERIC.has(w) && !/^\d+$/.test(w)))];
}

function carries(label: string, word: string): boolean {
  return ` ${fold(label)} `.includes(` ${word} `);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function outsideByKm(bounds: GeoBounds, point: LatLng): number {
  const lat = Math.min(Math.max(point.lat, bounds.southWest.lat), bounds.northEast.lat);
  const lng = Math.min(Math.max(point.lng, bounds.southWest.lng), bounds.northEast.lng);
  return haversineKm(point, { lat, lng });
}

function diagonal(bounds: GeoBounds): number {
  return haversineKm(bounds.southWest, bounds.northEast);
}

export function outlyingBases(
  proposal: Pick<ScanProposal, 'bases' | 'candidates'>,
  positions: ReadonlyMap<string, { coordinates: LatLng } | null>,
  context: FootprintContext = {},
): OutlyingBase[] {
  const points: { key: string; kind: 'base' | 'place'; at: LatLng; labels: string[] }[] = [
    ...proposal.bases.flatMap((b) => {
      const p = positions.get(b.key);
      return p ? [{ key: b.key, kind: 'base' as const, at: p.coordinates, labels: [b.name, b.locality] }] : [];
    }),
    ...proposal.candidates.flatMap((c) => {
      const p = positions.get(c.key);
      return p ? [{ key: c.key, kind: 'place' as const, at: p.coordinates, labels: [c.name, c.locality] }] : [];
    }),
  ];
  const n = points.length;
  if (n < FOOTPRINT_MIN_POINTS) return [];

  const dist = points.map((a) => points.map((b) => haversineKm(a.at, b.at)));
  const nearest = points.map((_, i) => Math.min(...dist[i]!.filter((_, j) => j !== i)));
  const link = Math.max(FOOTPRINT_LINK_FLOOR_KM, NN_FACTOR * median(nearest));

  // Single-linkage groups at the link distance.
  const group = new Array<number>(n).fill(-1);
  let groups = 0;
  for (let i = 0; i < n; i++) {
    if (group[i] !== -1) continue;
    const stack = [i];
    group[i] = groups;
    while (stack.length > 0) {
      const at = stack.pop()!;
      for (let j = 0; j < n; j++) {
        if (group[j] !== -1 || dist[at]![j]! > link) continue;
        group[j] = groups;
        stack.push(j);
      }
    }
    groups += 1;
  }
  if (groups < 2) return [];
  const sizes = new Array<number>(groups).fill(0);
  for (const g of group) sizes[g]! += 1;
  const main = sizes.indexOf(Math.max(...sizes));
  /* Two equal largest groups (two cities of a two-city trip) have no main footprint to judge against. */
  if (sizes.filter((s) => s === sizes[main]).length > 1) return [];
  const mainIdx = points.map((_, i) => i).filter((i) => group[i] === main);
  if (!mainIdx.some((i) => points[i]!.kind === 'base')) return [];

  const out: OutlyingBase[] = [];
  points.forEach((point, i) => {
    if (point.kind !== 'base' || group[i] === main) return;
    const own = points.map((_, j) => j).filter((j) => group[j] === group[i]);
    const gap = Math.min(...mainIdx.map((j) => dist[i]![j]!));
    if (gap <= link) return;
    if ((context.parts ?? []).some((part) => haversineKm(part.center, point.at) <= PART_REACH_KM)) return;
    /* On the way between two stretches of the trip (in the main footprint or another group): a road-trip night, not a stray. */
    const others = points.map((_, j) => j).filter((j) => group[j] !== group[i]);
    for (const a of others)
      for (const c of others) if (a < c && dist[a]![c]! > link && dist[a]![i]! + dist[i]![c]! <= CORRIDOR_RATIO * dist[a]![c]!) return;

    const words = distinctiveWords(...point.labels);
    const base = proposal.bases.find((b) => b.key === point.key)!;
    const contradicted = mainIdx.find((j) => points[j]!.kind === 'place' && words.some((w) => points[j]!.labels.some((label) => carries(label, w))));
    const gapKm = Math.round(gap);
    let ground: OutlyingBaseGround | null = null;
    let reason = '';
    if (contradicted !== undefined) {
      const name = proposal.candidates.find((c) => c.key === points[contradicted]!.key)?.name ?? 'its own places';
      ground = 'contradicted_by_own_places';
      reason = `The map placed it about ${gapKm} km from the rest of the trip, while ${name} — in the same area by name — sits with the rest; a different place with a similar name, so it is not planned.`;
    } else if (!own.some((j) => points[j]!.kind === 'place')) {
      ground = 'unsupported';
      reason = `The map placed it about ${gapKm} km from the rest of the trip, with nothing proposed near it; not planned as a place to sleep.`;
    } else if (context.extent && outsideByKm(context.extent, point.at) > Math.max(50, 0.25 * diagonal(context.extent)) && own.length <= MINORITY_SHARE * n) {
      ground = 'outside_extent';
      reason = `The map placed it about ${gapKm} km from the rest of the trip and well outside the destination; not planned as a place to sleep.`;
    }
    if (ground) out.push({ key: base.key, name: base.name, ground, gapKm, reason });
  });
  return out;
}
