import { describe, expect, it } from 'vitest';
import { dayRouteLinks, mapModeFor, MAX_INTERMEDIATE_WAYPOINTS, type MapStop } from './maps';

function stop(id: string, lat: number, lng: number): MapStop {
  return { id, name: id, lat, lng };
}

describe('dayRouteLinks', () => {
  it('refuses to build a route out of fewer than two stops', () => {
    expect(dayRouteLinks([])).toBeNull();
    expect(dayRouteLinks([stop('a', 37.6, -119)])).toBeNull();
  });

  it('puts the first stop at the origin and the last at the destination', () => {
    const links = dayRouteLinks([
      stop('a', 37.6485, -118.9721),
      stop('b', 37.5936, -118.8228),
      stop('c', 37.8, -119.1),
    ]);
    expect(links).not.toBeNull();
    const url = new URL(links!.google);
    expect(url.searchParams.get('origin')).toBe('37.6485,-118.9721');
    expect(url.searchParams.get('destination')).toBe('37.8,-119.1');
    expect(url.searchParams.get('waypoints')).toBe('37.5936,-118.8228');
    expect(url.searchParams.get('travelmode')).toBe('driving');
    expect(links!.included).toBe(3);
    expect(links!.omitted).toBe(0);
  });

  it('truncates at the waypoint cap and says how many it left behind', () => {
    // 1 origin + 12 intermediate + 1 destination.
    const stops = Array.from({ length: 14 }, (_, index) => stop(`s${index}`, 37 + index / 100, -119));
    const links = dayRouteLinks(stops)!;
    const waypoints = new URL(links.google).searchParams.get('waypoints')!.split('|');
    expect(waypoints).toHaveLength(MAX_INTERMEDIATE_WAYPOINTS);
    expect(links.included).toBe(MAX_INTERMEDIATE_WAYPOINTS + 2);
    // Twelve intermediate stops, nine carried: three are reported, not dropped silently.
    expect(links.omitted).toBe(3);
  });

  it('carries the mode through to both schemes', () => {
    const stops = [stop('a', 35.6, 139.7), stop('b', 35.7, 139.8)];
    expect(new URL(dayRouteLinks(stops, 'walking')!.google).searchParams.get('travelmode')).toBe('walking');
    expect(new URL(dayRouteLinks(stops, 'walking')!.apple).searchParams.get('dirflg')).toBe('w');
    expect(new URL(dayRouteLinks(stops, 'transit')!.apple).searchParams.get('dirflg')).toBe('r');
    expect(new URL(dayRouteLinks(stops, 'driving')!.apple).searchParams.get('dirflg')).toBe('d');
  });

  it('names no place and carries no identifier — coordinates only', () => {
    const links = dayRouteLinks([
      { id: 'devils-postpile', name: 'Devils Postpile', lat: 37.62, lng: -119.08 },
      { id: 'rainbow-falls', name: 'Rainbow Falls', lat: 37.6, lng: -119.09 },
    ])!;
    expect(links.google).not.toContain('Devils');
    expect(links.google).not.toContain('postpile');
    expect(links.apple).not.toContain('Rainbow');
  });
});

describe('mapModeFor', () => {
  it('prefers driving whenever the day drives at all', () => {
    expect(mapModeFor(['walk', 'drive'])).toBe('driving');
    expect(mapModeFor(['rideshare'])).toBe('driving');
  });

  it('asks for transit only when something scheduled carried the day', () => {
    expect(mapModeFor(['walk', 'rail'])).toBe('transit');
    expect(mapModeFor(['ferry'])).toBe('transit');
  });

  it('walks otherwise', () => {
    expect(mapModeFor(['walk'])).toBe('walking');
    expect(mapModeFor([])).toBe('walking');
  });
});
