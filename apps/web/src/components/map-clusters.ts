/**
 * MARKERS THAT LAND ON ONE ANOTHER BECOME ONE MARK THAT SAYS SO.
 *
 * An eleven-day trip has thirty stops, and at the zoom that shows the whole
 * trip most of them sit inside one valley: thirty orange discs printed on top
 * of each other, every number unreadable and every press a guess. A fan-out
 * keeps them all but spreads a crowded town across the map; hiding them lies.
 * So the whole-trip maps group them — one cluster mark with a count and the
 * days it holds — and a press zooms to the cluster's own extent, where the
 * stops come apart by themselves.
 *
 * Pure and deterministic: screen positions in, groups out, no DOM and no map
 * library, so the SVG figure and both MapLibre maps share one rule and a unit
 * test can say exactly what a crowded frame becomes.
 *
 * Rules, in order:
 * 1. **Pinned marks are never grouped.** A base is where you sleep and must
 *    always read as one; the selected stop must stay the thing selected.
 * 2. **Densest first.** The mark with the most neighbours within the radius
 *    seeds a group and takes every unassigned neighbour; ties break on id, so
 *    the same frame always groups the same way.
 * 3. **Groups that still overlap merge.** Two group centres closer than the
 *    radius would draw two discs on top of each other, which is the defect
 *    this module exists to remove.
 * 4. **A group of one is not a group.** It draws as the mark it is.
 */
export interface ClusterItem {
  id: string;
  /** Screen position, in the same units as `radius`. */
  x: number;
  y: number;
  lat: number;
  lng: number;
  /** The accessible name of the mark: listed on the cluster. */
  label: string;
  dayNumber?: number | undefined;
  /** Never grouped (a base, the selected stop). */
  pinned?: boolean | undefined;
}

export interface MarkerCluster {
  /** Stable for the same members, so a renderer can reuse the element. */
  key: string;
  members: ClusterItem[];
  /** Where the cluster mark is drawn: the mean of its members on screen and on the ground. */
  x: number;
  y: number;
  lat: number;
  lng: number;
  /** The days its members belong to, ascending, once each. */
  days: number[];
  bounds: { west: number; south: number; east: number; north: number };
}

export interface ClusterResult {
  singles: ClusterItem[];
  clusters: MarkerCluster[];
}

/** Two marks nearer than this on screen are one mark: a 44 px touch target cannot tell them apart. */
export const CLUSTER_RADIUS_PX = 44;

export function clusterMarkers(items: readonly ClusterItem[], options: { radius?: number } = {}): ClusterResult {
  const radius = options.radius ?? CLUSTER_RADIUS_PX;
  const valid = items.filter((item) => Number.isFinite(item.x) && Number.isFinite(item.y));
  const pinned = valid.filter((item) => item.pinned);
  const free = valid.filter((item) => !item.pinned).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const near = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y) < radius;

  const neighbours = free.map((item) => free.filter((other) => other !== item && near(item, other)).length);
  const seeds = free.map((item, index) => ({ item, index, count: neighbours[index]! })).sort((a, b) => b.count - a.count || (a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0));

  const assigned = new Set<number>();
  let groups: number[][] = [];
  for (const seed of seeds) {
    if (assigned.has(seed.index)) continue;
    const group = [seed.index];
    assigned.add(seed.index);
    free.forEach((other, index) => {
      if (assigned.has(index) || !near(seed.item, other)) return;
      group.push(index);
      assigned.add(index);
    });
    groups.push(group);
  }

  /* Merge groups whose centres would still draw on top of each other. Bounded: every pass removes a group. */
  const centre = (group: number[]) => ({ x: mean(group.map((i) => free[i]!.x)), y: mean(group.map((i) => free[i]!.y)) });
  for (let pass = 0; pass < free.length; pass += 1) {
    let merged = false;
    outer: for (let a = 0; a < groups.length; a += 1) {
      for (let b = a + 1; b < groups.length; b += 1) {
        if (!near(centre(groups[a]!), centre(groups[b]!))) continue;
        groups = [...groups.slice(0, a), [...groups[a]!, ...groups[b]!], ...groups.slice(a + 1, b), ...groups.slice(b + 1)];
        merged = true;
        break outer;
      }
    }
    if (!merged) break;
  }

  const singles: ClusterItem[] = [...pinned];
  const clusters: MarkerCluster[] = [];
  for (const group of groups) {
    const members = group.map((i) => free[i]!).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    if (members.length < 2) {
      singles.push(members[0]!);
      continue;
    }
    clusters.push({
      key: `cluster:${members.map((m) => m.id).join('|')}`,
      members,
      x: mean(members.map((m) => m.x)),
      y: mean(members.map((m) => m.y)),
      lat: mean(members.map((m) => m.lat)),
      lng: mean(members.map((m) => m.lng)),
      days: [...new Set(members.flatMap((m) => (m.dayNumber === undefined ? [] : [m.dayNumber])))].sort((a, b) => a - b),
      bounds: {
        west: Math.min(...members.map((m) => m.lng)),
        east: Math.max(...members.map((m) => m.lng)),
        south: Math.min(...members.map((m) => m.lat)),
        north: Math.max(...members.map((m) => m.lat)),
      },
    });
  }
  clusters.sort((a, b) => (a.key < b.key ? -1 : 1));
  return { singles, clusters };
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / Math.max(1, values.length);
}

/**
 * "Day 3", "Days 2–4", "Days 1–3, 6". Runs of consecutive days are written as
 * a range; more than three runs collapse to first–last, because a cluster's
 * label must fit on the cluster.
 */
export function daysText(days: readonly number[]): string {
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  if (sorted.length === 0) return '';
  if (sorted.length === 1) return `Day ${sorted[0]}`;
  const runs: [number, number][] = [];
  for (const day of sorted) {
    const last = runs[runs.length - 1];
    if (last && day === last[1] + 1) last[1] = day;
    else runs.push([day, day]);
  }
  if (runs.length > 3) return `Days ${sorted[0]}–${sorted[sorted.length - 1]}`;
  return `Days ${runs.map(([a, b]) => (a === b ? String(a) : `${a}–${b}`)).join(', ')}`;
}

/** What a cluster is called, for a screen reader and for the hover list's heading. */
export function clusterLabel(cluster: Pick<MarkerCluster, 'members' | 'days'>, listed = 4): string {
  const names = cluster.members.map((m) => m.label);
  const shown = names.slice(0, listed).join('; ');
  const more = names.length > listed ? `; and ${names.length - listed} more` : '';
  const days = cluster.days.length > 0 ? `, ${daysText(cluster.days).toLowerCase()}` : '';
  return `${cluster.members.length} places close together${days}: ${shown}${more}. Press to zoom in.`;
}

/**
 * The day colours of the whole-trip map.
 *
 * Eleven days of stops in one flare orange is a cloud nobody can read. A day
 * is a colour on the whole trip (and its number on the pin), and the day strip
 * under the map carries the same swatches, so the key and the drawing are one
 * table. Flare is deliberately absent: it is the route and the one action.
 * Two palettes, one per ground, each readable on its own background; after
 * eight days the colours repeat and the number on the pin disambiguates.
 */
export const DAY_COLOURS = {
  night: ['#7fd1e0', '#f2c14e', '#b9a7ff', '#8fd694', '#ff9fb2', '#5fb3ff', '#e6a568', '#d9e36b'],
  paper: ['#1f7a8c', '#a5740c', '#6b55c8', '#3c8a47', '#c2456a', '#2f6fb5', '#a35f25', '#6f7f0e'],
} as const;

export function dayColour(dayNumber: number, ground: 'night' | 'paper' = 'night'): string {
  const palette = DAY_COLOURS[ground];
  const index = (((Math.round(dayNumber) - 1) % palette.length) + palette.length) % palette.length;
  return palette[index]!;
}

/**
 * The cluster mark's ring: one arc per day, sized by how many members it has,
 * in day order — a conic gradient that tells which days are inside before the
 * cluster is pressed.
 */
export function clusterRing(cluster: Pick<MarkerCluster, 'members'>, ground: 'night' | 'paper' = 'night', neutral = '#a3b1b1'): string {
  const total = cluster.members.length;
  const counts = new Map<number | null, number>();
  for (const member of cluster.members) counts.set(member.dayNumber ?? null, (counts.get(member.dayNumber ?? null) ?? 0) + 1);
  const ordered = [...counts.entries()].sort(([a], [b]) => (a ?? Infinity) - (b ?? Infinity));
  let at = 0;
  const stops = ordered.map(([day, count]) => {
    const from = (at / total) * 360;
    at += count;
    const to = (at / total) * 360;
    const colour = day === null ? neutral : dayColour(day, ground);
    return `${colour} ${from.toFixed(1)}deg ${to.toFixed(1)}deg`;
  });
  return `conic-gradient(${stops.join(', ')})`;
}

/**
 * Seats for marks that share one spot when grouping is off (zoomed all the
 * way in): a small ring for a few, a sunflower for many. Offsets in pixels;
 * coordinates are never moved.
 */
export function fanOffsets(count: number): [number, number][] {
  if (count < 2) return [[0, 0]];
  if (count <= 6) {
    const radius = count <= 2 ? 18 : count <= 4 ? 24 : 30;
    return Array.from({ length: count }, (_, k) => {
      const angle = -Math.PI / 2 + (2 * Math.PI * k) / count;
      return [radius * Math.cos(angle), radius * Math.sin(angle)] as [number, number];
    });
  }
  return Array.from({ length: count }, (_, k) => {
    const radius = 16 * Math.sqrt(k + 1);
    const angle = k * 2.39996;
    return [radius * Math.cos(angle), radius * Math.sin(angle)] as [number, number];
  });
}
