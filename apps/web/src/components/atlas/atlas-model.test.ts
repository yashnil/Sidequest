import { describe, expect, it } from 'vitest';
import { boundsOf, formatCoordinate, groupClose, scaleBar } from './atlas-model';

describe('atlas model', () => {
  it('labels coordinates by hemisphere', () => {
    expect(formatCoordinate(38.70781, 'lat')).toBe('38.7078° N');
    expect(formatCoordinate(-9.13659, 'lng')).toBe('9.1366° W');
    expect(formatCoordinate(-33.9, 'lat')).toBe('33.9000° S');
  });

  it('widens a single point so the camera never zooms into one street', () => {
    const b = boundsOf([{ lat: 38.7, lng: -9.1 }])!;
    expect(b.east - b.west).toBeGreaterThan(0.01);
    expect(b.north - b.south).toBeGreaterThan(0.01);
    expect(boundsOf([])).toBeNull();
    expect(boundsOf([{ lat: Number.NaN, lng: 1 }])).toBeNull();
  });

  it('draws a round-number scale bar that fits', () => {
    const bar = scaleBar(38.7, 12)!;
    expect(bar.px).toBeLessThanOrEqual(90);
    expect(bar.label).toMatch(/^(1|2|5|10|20|50|100|200|500)( km| m)$|^\d+ (km|m)$/);
    expect(scaleBar(0, 2)!.label).toMatch(/km$/);
    expect(scaleBar(51.5, 17)!.label).toMatch(/ m$/);
  });
});

import { planToAtlas } from './atlas-model';

describe('plan drawing → atlas', () => {
  it('keeps each line on its evidence and each mark in its class', () => {
    const { points, lines } = planToAtlas({
      base: { name: 'Lisbon', coordinates: { lat: 38.7, lng: -9.13 } },
      marks: [
        { id: 'a', name: 'Belém Tower', coordinates: { lat: 38.69, lng: -9.21 }, kind: 'stop', order: 1 },
        { id: 'b', name: 'A café', coordinates: { lat: 38.71, lng: -9.14 }, kind: 'place' },
        { id: 'a', name: 'Belém Tower again', coordinates: { lat: 38.69, lng: -9.21 }, kind: 'stop', order: 1 },
      ],
      connectors: [
        { id: 'l1', from: { lat: 38.7, lng: -9.13 }, to: { lat: 38.69, lng: -9.21 }, style: 'measured_drive', path: [{ lat: 38.7, lng: -9.13 }, { lat: 38.695, lng: -9.17 }, { lat: 38.69, lng: -9.21 }] },
        { id: 'l2', from: { lat: 38.69, lng: -9.21 }, to: { lat: 38.71, lng: -9.14 }, style: 'sightline' },
        { id: 'l3', from: { lat: 38.69, lng: -9.21 }, to: { lat: 38.71, lng: -9.14 }, style: 'estimated', path: [{ lat: 1, lng: 1 }, { lat: 2, lng: 2 }] },
      ],
    });
    expect(points.map((p) => [p.id, p.state, p.mark])).toEqual([
      ['base', 'base', '⌂'],
      ['a', 'chosen', '1'],
      ['b', 'muted', ''],
    ]);
    expect(points[1]!.label).toBe('Stop 1: Belém Tower');
    expect(lines.map((l) => [l.id, l.style, l.coords.length])).toEqual([
      ['l1', 'measured', 3],
      ['l2', 'unmeasured', 2],
      // An estimate never borrows a routed shape: it is drawn as the straight figure it is.
      ['l3', 'estimated', 2],
    ]);
  });
});

describe('groupClose', () => {
  it('groups pins that sit on one another and leaves the rest alone', () => {
    const groups = groupClose([{ x: 0, y: 0 }, { x: 10, y: 5 }, { x: 18, y: 12 }, { x: 200, y: 200 }], 22);
    expect(groups.map((g) => g.sort()).sort((a, b) => a[0]! - b[0]!)).toEqual([[0, 1, 2], [3]]);
  });
});

describe('planToAtlas', () => {
  it('draws the base once when the plan also marks it', () => {
    const base = { name: 'Reykjavik', coordinates: { lat: 64.1466, lng: -21.9426 } };
    const { points } = planToAtlas({
      base,
      marks: [
        { id: 'b1', kind: 'base', name: 'Reykjavik', coordinates: { lat: 64.14661, lng: -21.94262 } },
        { id: 's1', kind: 'stop', name: 'Grótta', order: 1, coordinates: { lat: 64.164, lng: -22.022 } },
      ] as never,
    });
    expect(points.filter((p) => p.state === 'base')).toHaveLength(1);
    expect(points.map((p) => p.id)).toEqual(['base', 's1']);
  });
});
