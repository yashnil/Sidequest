import { describe, expect, it } from 'vitest';
import { coherentScale, diagonalKm, travelExtentFor } from './semantics';

/* Published rows, as the geocoder returned them (2026-10). */
const TOKYO = { center: { lat: 35.6769, lng: 139.7639 }, bounds: { southWest: { lat: 20.2146, lng: 135.8537 }, northEast: { lat: 35.8984, lng: 154.2055 } }, population: 13_613_660 };
const ZURICH = { center: { lat: 47.3744, lng: 8.541 }, bounds: { southWest: { lat: 47.3202, lng: 8.448 }, northEast: { lat: 47.4347, lng: 8.6255 } }, population: 443_037 };
const NYC = { center: { lat: 40.7127, lng: -74.006 }, bounds: { southWest: { lat: 40.4766, lng: -74.2588 }, northEast: { lat: 40.9176, lng: -73.7002 } }, population: 8_467_513 };
const UTAH = { center: { lat: 39.42, lng: -111.71 }, bounds: { southWest: { lat: 37.0, lng: -114.05 }, northEast: { lat: 42.0, lng: -109.04 } } };
/* A municipality the size of a province, centred near one edge (a giant consolidated city-region). */
const GIANT = { center: { lat: 29.56, lng: 106.55 }, bounds: { southWest: { lat: 28.16, lng: 105.29 }, northEast: { lat: 32.2, lng: 110.2 } }, population: 9_000_000 };

describe('the travel extent of a destination', () => {
  it('a metropolis whose boundary reaches remote islands is planned around the city, and keeps its canonical box', () => {
    const out = travelExtentFor({ type: 'settlement', ...TOKYO });
    expect(out.basis).toBe('urban_core');
    expect(diagonalKm(out.bounds)).toBeLessThan(200);
    expect(out.bounds.southWest.lat).toBeGreaterThan(34.5); // no Ogasawara, no Okinotorishima
    expect(out.reason).toMatch(/published boundary/);
    expect(diagonalKm(TOKYO.bounds)).toBeGreaterThan(1500);
  });

  it('ordinary cities keep their published extent', () => {
    expect(travelExtentFor({ type: 'settlement', ...ZURICH }).basis).toBe('published');
    expect(travelExtentFor({ type: 'settlement', ...NYC }).basis).toBe('published');
  });

  it('a giant municipality is narrowed to its urban core', () => {
    const out = travelExtentFor({ type: 'city_region', ...GIANT });
    expect(out.basis).toBe('urban_core');
    expect(diagonalKm(out.bounds)).toBeLessThan(diagonalKm(GIANT.bounds));
  });

  it('states, countries, islands and parks are never narrowed', () => {
    for (const type of ['admin_area', 'country', 'island', 'protected_area', 'natural_region'] as const) {
      expect(travelExtentFor({ type, ...UTAH }).basis).toBe('published');
      expect(travelExtentFor({ type, ...TOKYO }).basis).toBe('published');
    }
  });

  it('without a population the type ceiling still catches a fragmented city', () => {
    const { population: _p, ...tokyo } = TOKYO;
    expect(travelExtentFor({ type: 'settlement', ...tokyo }).basis).toBe('urban_core');
  });
});

describe('scale agrees with type', () => {
  it('a country is national whatever its box says; a town is at least a settlement; a city never a country', () => {
    expect(coherentScale('country', 'settlement')).toBe('country');
    expect(coherentScale('country', 'continental')).toBe('continental');
    expect(coherentScale('settlement', 'neighbourhood')).toBe('settlement');
    expect(coherentScale('settlement', 'country')).toBe('district');
    expect(coherentScale('admin_area', 'district')).toBe('subregion');
    expect(coherentScale('admin_area', 'region')).toBe('region');
    expect(coherentScale('informal_region', 'country')).toBe('country');
  });
});
