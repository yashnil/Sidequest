import { describe, expect, it } from 'vitest';
import { ATLAS_TOURS } from '../landing/atlas-tours';
import { atlasPosition, collectionLine, greetingName, plateRoute, smoothPath } from './stage-model';

describe('greetingName', () => {
  it('greets by the first word of a real name', () => {
    expect(greetingName('Yash Mohanty')).toBe('Yash');
    expect(greetingName('  Ana-María  López ')).toBe('Ana-María');
    expect(greetingName('Zoë')).toBe('Zoë');
  });

  it('says nothing rather than greet somebody by an address or a token', () => {
    expect(greetingName('continuity-desktop-1794469630250')).toBeNull();
    expect(greetingName('ben@example.com')).toBeNull();
    expect(greetingName('user_123')).toBeNull();
    expect(greetingName('')).toBeNull();
    expect(greetingName(null)).toBeNull();
    expect(greetingName('J')).toBeNull();
  });
});

describe('atlasPosition', () => {
  it('lays a coordinate on the same sheet WorldDots draws', () => {
    expect(atlasPosition(0, 0)).toEqual({ left: 50, top: (84 / 144) * 100 });
    expect(atlasPosition(84, -180)).toEqual({ left: 0, top: 0 });
    expect(atlasPosition(-70, 200)).toEqual({ left: 100, top: 100 });
    expect(atlasPosition(Number.NaN, 0)).toBeNull();
  });
});

describe('plateRoute', () => {
  const box = { width: 320, height: 200, pad: 24 };

  it('keeps every real stop inside the plate and centres the shape', () => {
    for (const tour of ATLAS_TOURS) {
      const points = plateRoute(tour.stops, box);
      expect(points).toHaveLength(tour.stops.length);
      for (const p of points) {
        expect(p.x).toBeGreaterThanOrEqual(box.pad - 0.1);
        expect(p.x).toBeLessThanOrEqual(box.width - box.pad + 0.1);
        expect(p.y).toBeGreaterThanOrEqual(box.pad - 0.1);
        expect(p.y).toBeLessThanOrEqual(box.height - box.pad + 0.1);
      }
    }
  });

  it('keeps north up and east right', () => {
    const [west, east] = plateRoute([{ lat: 64, lng: -22 }, { lat: 65, lng: -14 }], box);
    expect(east!.x).toBeGreaterThan(west!.x);
    expect(east!.y).toBeLessThan(west!.y);
  });

  it('draws one stop, and a path through several', () => {
    expect(plateRoute([{ lat: 10, lng: 10 }], box)).toEqual([{ x: 160, y: 100 }]);
    expect(smoothPath([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }])).toMatch(/^M0 0 C.* C.*10 10$/);
    expect(smoothPath([])).toBe('');
  });
});

describe('collectionLine', () => {
  it('counts without inventing urgency', () => {
    expect(collectionLine([{ lifecycle: 'planning' }], 273)).toBe('1 journey · the next in 273 days');
    expect(collectionLine([{ lifecycle: 'traveling' }, { lifecycle: 'idea' }, { lifecycle: 'past' }], 2)).toBe('3 journeys · 1 under way · 1 been and gone');
    expect(collectionLine([{ lifecycle: 'idea' }], null)).toBe('1 journey');
  });
});
