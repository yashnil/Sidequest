import { describe, expect, it } from 'vitest';
import { CLUSTER_RADIUS_PX, DAY_COLOURS, clusterLabel, clusterMarkers, clusterRing, dayColour, daysText, fanOffsets, type ClusterItem } from './map-clusters';

const item = (id: string, x: number, y: number, extra: Partial<ClusterItem> = {}): ClusterItem => ({ id, x, y, lat: y / 100, lng: x / 100, label: `Place ${id}`, ...extra });

describe('screen-space grouping of overlapping marks', () => {
  it('groups marks nearer than the radius and leaves distant ones alone', () => {
    const result = clusterMarkers([item('a', 100, 100), item('b', 110, 104), item('c', 96, 112), item('far', 400, 400)]);
    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0]!.members.map((m) => m.id)).toEqual(['a', 'b', 'c']);
    expect(result.singles.map((s) => s.id)).toEqual(['far']);
  });

  it('never groups a pinned mark (a base, the selection), even on top of others', () => {
    const result = clusterMarkers([item('base', 100, 100, { pinned: true }), item('a', 102, 101), item('b', 104, 99)]);
    expect(result.singles.map((s) => s.id)).toContain('base');
    expect(result.clusters[0]!.members.map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('is deterministic: the same frame in any input order groups the same way', () => {
    const items = [item('a', 0, 0), item('b', 30, 0), item('c', 60, 0), item('d', 90, 0), item('e', 300, 0)];
    const one = clusterMarkers(items);
    const two = clusterMarkers([...items].reverse());
    expect(two).toEqual(one);
  });

  it('a group of one is not a group', () => {
    const result = clusterMarkers([item('a', 0, 0), item('b', 200, 0)]);
    expect(result.clusters).toEqual([]);
    expect(result.singles).toHaveLength(2);
  });

  it('merges groups whose centres would still draw on top of each other', () => {
    /* A chain: a–b and c–d form two seeds whose centres are close. */
    const result = clusterMarkers([item('a', 0, 0), item('b', 40, 0), item('c', 70, 0), item('d', 110, 0)], { radius: 44 });
    for (let i = 0; i < result.clusters.length; i += 1) {
      for (let j = i + 1; j < result.clusters.length; j += 1) {
        const a = result.clusters[i]!;
        const b = result.clusters[j]!;
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(44);
      }
    }
  });

  it('carries the days, the extent and a stable key', () => {
    const result = clusterMarkers([item('a', 0, 0, { dayNumber: 3 }), item('b', 10, 0, { dayNumber: 1 }), item('c', 0, 10, { dayNumber: 3 })]);
    const cluster = result.clusters[0]!;
    expect(cluster.days).toEqual([1, 3]);
    expect(cluster.key).toBe('cluster:a|b|c');
    expect(cluster.bounds).toEqual({ west: 0, east: 0.1, south: 0, north: 0.1 });
  });

  it('thirty stops in one valley become a handful of marks, every one at least a touch target apart', () => {
    const items = Array.from({ length: 30 }, (_, i) => item(`s${i}`, 500 + (i % 6) * 9, 300 + Math.floor(i / 6) * 9, { dayNumber: (i % 11) + 1 }));
    const result = clusterMarkers(items);
    const marks = [...result.singles.map((s) => ({ x: s.x, y: s.y })), ...result.clusters.map((c) => ({ x: c.x, y: c.y }))];
    expect(marks.length).toBeLessThanOrEqual(3);
    expect(result.clusters.reduce((n, c) => n + c.members.length, 0) + result.singles.length).toBe(30);
    for (let i = 0; i < marks.length; i += 1) for (let j = i + 1; j < marks.length; j += 1) expect(Math.hypot(marks[i]!.x - marks[j]!.x, marks[i]!.y - marks[j]!.y)).toBeGreaterThanOrEqual(CLUSTER_RADIUS_PX);
  });

  it('ignores marks with no screen position', () => {
    expect(clusterMarkers([item('a', Number.NaN, 0), item('b', 0, 0)]).singles.map((s) => s.id)).toEqual(['b']);
  });
});

describe('what a cluster says', () => {
  it('writes days as runs', () => {
    expect(daysText([])).toBe('');
    expect(daysText([3])).toBe('Day 3');
    expect(daysText([4, 2, 3])).toBe('Days 2–4');
    expect(daysText([1, 2, 3, 6])).toBe('Days 1–3, 6');
    expect(daysText([1, 3, 5, 7, 9])).toBe('Days 1–9');
  });

  it('names its members, the count and the days, and says what a press does', () => {
    const label = clusterLabel({ members: ['A', 'B', 'C', 'D', 'E', 'F'].map((n) => item(n, 0, 0, { label: n })), days: [2, 3] });
    expect(label).toBe('6 places close together, days 2–3: A; B; C; D; and 2 more. Press to zoom in.');
  });
});

describe('day colours', () => {
  it('is one colour per day, repeating after the palette, never flare', () => {
    expect(dayColour(1)).toBe(DAY_COLOURS.night[0]);
    expect(dayColour(9)).toBe(dayColour(1));
    expect(new Set(DAY_COLOURS.night.slice(0, 8)).size).toBe(8);
    expect(DAY_COLOURS.night.map((c) => c.toLowerCase())).not.toContain('#ff5a1f');
    expect(dayColour(2, 'paper')).toBe(DAY_COLOURS.paper[1]);
  });

  it('rings a cluster with one arc per day, sized by its members', () => {
    const ring = clusterRing({ members: [item('a', 0, 0, { dayNumber: 2 }), item('b', 0, 0, { dayNumber: 1 }), item('c', 0, 0, { dayNumber: 2 }), item('d', 0, 0)] });
    expect(ring).toBe(`conic-gradient(${dayColour(1)} 0.0deg 90.0deg, ${dayColour(2)} 90.0deg 270.0deg, #a3b1b1 270.0deg 360.0deg)`);
  });
});

describe('fanning marks that share one spot', () => {
  it('gives every mark its own seat, none on top of another', () => {
    for (const n of [2, 4, 6, 9]) {
      const seats = fanOffsets(n);
      expect(seats).toHaveLength(n);
      for (let i = 0; i < n; i += 1) for (let j = i + 1; j < n; j += 1) expect(Math.hypot(seats[i]![0] - seats[j]![0], seats[i]![1] - seats[j]![1])).toBeGreaterThan(10);
    }
    expect(fanOffsets(1)).toEqual([[0, 0]]);
  });
});

describe('a cluster never sits under a bed', () => {
  it('steps aside from a pinned mark it would cover, and stays put otherwise', async () => {
    const { clearOfPinned } = await import('./map-cluster-layer');
    expect(clearOfPinned({ x: 100, y: 100 }, [{ x: 300, y: 300 }])).toEqual([0, 0]);
    const [dx, dy] = clearOfPinned({ x: 100, y: 100 }, [{ x: 100, y: 100 }]);
    expect(Math.hypot(dx, dy)).toBeGreaterThanOrEqual(33);
    const [ax, ay] = clearOfPinned({ x: 110, y: 100 }, [{ x: 100, y: 100 }]);
    expect(Math.hypot(110 + ax - 100, 100 + ay - 100)).toBeGreaterThanOrEqual(33);
    expect(ax).toBeGreaterThan(0);
  });
});
