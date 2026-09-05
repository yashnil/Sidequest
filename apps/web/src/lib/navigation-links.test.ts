import { describe, expect, it } from 'vitest';
import { legDirectionsLinks, navModeFor, placeNavigationLinks } from './navigation-links';

describe('LIVE WORLD V1 — navigation handoff links', () => {
  it('builds documented public URLs with no key and six-decimal coordinates', () => {
    const place = placeNavigationLinks({ lat: 64.1472, lng: -21.9397, name: 'Harpa' });
    expect(place.google).toBe('https://www.google.com/maps/search/?api=1&query=64.1472%2C-21.9397');
    expect(place.apple).toContain('maps.apple.com');
    expect(place.apple).toContain('q=Harpa');
    const leg = legDirectionsLinks({ lat: 64.1472, lng: -21.9397 }, { lat: 63.4188, lng: -19.0055 }, 'driving');
    expect(leg.google).toContain('travelmode=driving');
    expect(leg.apple).toContain('dirflg=d');
    expect(leg.google).not.toMatch(/key=/);
    expect(navModeFor('walk')).toBe('walking');
    expect(navModeFor('rail')).toBe('transit');
    expect(navModeFor('drive')).toBe('driving');
  });
});
