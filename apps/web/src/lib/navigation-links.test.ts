import { describe, expect, it } from 'vitest';
import { copyable, coordinatePair, legDirectionsLinks, navModeFor, placeNavigationLinks } from './navigation-links';

describe('LIVE WORLD V1 — navigation handoff links', () => {
  it('builds documented public URLs with no key and six-decimal coordinates', () => {
    const place = placeNavigationLinks({ lat: 64.1472, lng: -21.9397, name: 'Harpa' });
    expect(place.google).toBe('https://www.google.com/maps/search/?api=1&query=64.1472%2C-21.9397');
    expect(place.apple).toContain('maps.apple.com');
    const leg = legDirectionsLinks({ lat: 64.1472, lng: -21.9397 }, { lat: 63.4188, lng: -19.0055 }, 'driving');
    expect(leg.google).toContain('travelmode=driving');
    expect(leg.google).not.toMatch(/key=/);
    expect(navModeFor('walk')).toBe('walking');
    expect(navModeFor('rail')).toBe('transit');
    expect(navModeFor('drive')).toBe('driving');
  });
});

describe('V9 §11 — Apple unified URLs with the legacy form kept', () => {
  it('names a place with /place?coordinate= and keeps ?ll=&q= beside it', () => {
    const place = placeNavigationLinks({ lat: 64.1472, lng: -21.9397, name: 'Harpa' });
    const unified = new URL(place.apple);
    expect(unified.pathname).toBe('/place');
    expect(unified.searchParams.get('coordinate')).toBe('64.1472,-21.9397');
    expect(unified.searchParams.get('name')).toBe('Harpa');
    const legacy = new URL(place.appleLegacy);
    expect(legacy.searchParams.get('ll')).toBe('64.1472,-21.9397');
    expect(legacy.searchParams.get('q')).toBe('Harpa');
  });

  it('routes a leg with /directions?mode= and keeps ?daddr&dirflg beside it', () => {
    for (const [mode, flag] of [
      ['driving', 'd'],
      ['walking', 'w'],
      ['transit', 'r'],
    ] as const) {
      const leg = legDirectionsLinks({ lat: 64.1472, lng: -21.9397 }, { lat: 63.4188, lng: -19.0055 }, mode);
      const unified = new URL(leg.apple);
      expect(unified.pathname).toBe('/directions');
      expect(unified.searchParams.get('source')).toBe('64.1472,-21.9397');
      expect(unified.searchParams.get('destination')).toBe('63.4188,-19.0055');
      expect(unified.searchParams.get('mode')).toBe(mode);
      const legacy = new URL(leg.appleLegacy);
      expect(legacy.searchParams.get('daddr')).toBe('63.4188,-19.0055');
      expect(legacy.searchParams.get('dirflg')).toBe(flag);
    }
  });

  it('gives the clipboard the coordinate pair first and the name after', () => {
    expect(copyable({ lat: 64.1472, lng: -21.9397 }, 'Harpa')).toBe('64.1472,-21.9397 · Harpa');
    expect(copyable({ lat: 64.1472, lng: -21.9397 })).toBe('64.1472,-21.9397');
    expect(copyable({ lat: 64.1472, lng: -21.9397 }, '   ')).toBe('64.1472,-21.9397');
    expect(coordinatePair({ lat: 35.6, lng: 139.7 })).toBe('35.6,139.7');
  });
});
