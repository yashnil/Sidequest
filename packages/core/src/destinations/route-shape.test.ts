import { describe, expect, it } from 'vitest';
import { describeRouteShape, readRouteShape } from './route-shape';

const kind = (phrase: string, concept?: Parameters<typeof readRouteShape>[0]['concept'], note?: string) => readRouteShape({ phrase, ...(concept ? { concept } : {}), ...(note ? { note } : {}) })?.kind ?? null;

describe('reading a route-shaped request from the traveller’s words', () => {
  it('a ring road, a circuit or a loop goes round', () => {
    expect(kind('Iceland Ring Road')).toBe('loop');
    expect(kind('Iceland Ring Road', { type: 'corridor', scale: 'region' })).toBe('loop');
    expect(kind('Ring of Kerry')).toBe('loop');
    expect(kind('Annapurna Circuit')).toBe('loop');
    expect(kind('South Island loop')).toBe('loop');
    expect(readRouteShape({ phrase: 'Iceland Ring Road' })?.cue).toBe('ring road');
  });

  it('“around” a country or an island goes round it; around a city means near it', () => {
    expect(kind('around Iceland')).toBe('loop');
    expect(kind('Around the island of Tasmania', { type: 'island', scale: 'region' })).toBe('loop');
    expect(kind('around Tokyo', { type: 'city_region', scale: 'region' })).toBeNull();
    expect(kind('around Kyoto', { type: 'settlement', scale: 'settlement' })).toBeNull();
    expect(kind('road trip around Kyoto', { type: 'settlement', scale: 'settlement' })).toBe('loop');
  });

  it('a road trip, a coast road or a named or numbered road is a journey along roads', () => {
    expect(kind('Scottish Highlands road trip')).toBe('touring');
    expect(kind('NC500')).toBe('touring');
    expect(kind('NC 500')).toBe('touring');
    expect(kind('Great Ocean Road')).toBe('touring');
    expect(kind('Route 66')).toBe('touring');
    expect(kind('Pacific Coast Highway')).toBe('touring');
    expect(kind('Wild Atlantic Way coastal drive')).toBe('touring');
  });

  it('“A to B” and “the length of” run from one end to the other, with the stops kept as typed', () => {
    const shape = readRouteShape({ phrase: 'Tokyo to Kyoto to Hiroshima' });
    expect(shape?.kind).toBe('linear');
    expect(shape?.stops).toEqual(['Tokyo', 'Kyoto', 'Hiroshima']);
    expect(describeRouteShape(shape!)).toBe('A journey from Tokyo to Hiroshima by way of Kyoto.');
    expect(readRouteShape({ phrase: 'from Lisbon to Porto' })?.stops).toEqual(['Lisbon', 'Porto']);
    expect(kind('the length of Chile')).toBe('linear');
    expect(kind('Vietnam north to south')).toBe('linear');
  });

  it('a place, or several named places, is not a route', () => {
    expect(kind('Tokyo')).toBeNull();
    expect(kind('Kyoto and Nara')).toBeNull();
    expect(kind('Kyoto, Osaka and Nara')).toBeNull();
    expect(kind('the Dolomites')).toBeNull();
    expect(kind('Amalfi Coast')).toBeNull();
    expect(kind('Iceland')).toBeNull();
    expect(kind('trip to Japan')).toBeNull();
    expect(kind('Iceland year round')).toBeNull();
  });

  it('a street named as a road, inside a town, is not a road trip', () => {
    expect(kind('Abbey Road', { type: 'landmark', scale: 'point' })).toBeNull();
    expect(kind('Rodeo Drive', { type: 'landmark', scale: 'neighbourhood' })).toBeNull();
    expect(kind('The Loop', { type: 'settlement', scale: 'neighbourhood' })).toBeNull();
  });

  it('the traveller’s note can make a trip a journey, never unmake one', () => {
    expect(kind('Scotland', undefined, 'We want to do it as a road trip')).toBe('touring');
    expect(kind('Iceland Ring Road', undefined, 'staying somewhere quiet')).toBe('loop');
    expect(kind('Scotland', undefined, 'somewhere quiet')).toBeNull();
  });
});
