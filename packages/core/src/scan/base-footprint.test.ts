import { describe, expect, it } from 'vitest';
import iceland from './fixtures/iceland-ring-road-2026-11.json';
import live from './fixtures/live-scans-2026-11.json';
import { distinctiveWords, outlyingBases, type FootprintContext } from './base-footprint';
import { planScanPoints, type ResolvedPosition } from './assemble';
import type { ScanProposal } from './proposal';

/**
 * A PLACE TO SLEEP PLACED FAR OUTSIDE THE TRIP — synthetic coordinates (real
 * places' approximate positions, so the distances are honest), plus every
 * recorded live scan, none of which may lose a base to this rule.
 */

type Pt = { name: string; locality?: string; lat: number; lng: number };

function build(bases: Pt[], places: Pt[]) {
  const proposal = {
    bases: bases.map((b, i) => ({ key: `b${i}`, name: b.name, locality: b.locality ?? b.name, nightsHint: 2, why: '' })),
    candidates: places.map((p, i) => ({ key: `c${i}`, name: p.name, locality: p.locality ?? '', kind: 'viewpoint' })),
  } as unknown as ScanProposal;
  const positions = new Map<string, ResolvedPosition | null>();
  bases.forEach((b, i) => positions.set(`b${i}`, { coordinates: { lat: b.lat, lng: b.lng }, method: 'geocoder', provider: 'test', approximate: false }));
  places.forEach((p, i) => positions.set(`c${i}`, { coordinates: { lat: p.lat, lng: p.lng }, method: 'geocoder', provider: 'test', approximate: false }));
  return { proposal, positions };
}

const run = (bases: Pt[], places: Pt[], context?: FootprintContext) => {
  const { proposal, positions } = build(bases, places);
  return outlyingBases(proposal, positions, context);
};

/* A northern-circuit safari. */
const NORTH_BASES: Pt[] = [
  { name: 'Arusha town lodges', locality: 'Arusha', lat: -3.37, lng: 36.69 },
  { name: 'Karatu lodges', locality: 'Karatu', lat: -3.34, lng: 35.67 },
  { name: 'Central Serengeti camps', locality: 'Seronera', lat: -2.45, lng: 34.82 },
];
const NORTH_PLACES: Pt[] = [
  { name: 'Ngorongoro Crater floor game drive', locality: 'Ngorongoro Conservation Area', lat: -3.16, lng: 35.59 },
  { name: 'Lake Manyara National Park game drive', locality: 'Mto wa Mbu', lat: -3.5, lng: 35.8 },
  { name: 'Central Serengeti game drives', locality: 'Seronera', lat: -2.3, lng: 34.8 },
  { name: 'Arusha Central Market', locality: 'Arusha', lat: -3.37, lng: 36.68 },
  { name: 'Olduvai Gorge Museum', locality: 'Ngorongoro', lat: -2.99, lng: 35.35 },
];
const TARANGIRE_PARK: Pt = { name: 'Tarangire National Park game drive', locality: 'Tarangire', lat: -3.9, lng: 36.0 };
/* The geocoder's answer for "Tarangire area lodges": Dar es Salaam. */
const TARANGIRE_IN_DAR: Pt = { name: 'Tarangire area lodges', locality: 'Tarangire', lat: -6.8, lng: 39.28 };
const TANZANIA: FootprintContext = { extent: { southWest: { lat: -11.75, lng: 29.3 }, northEast: { lat: -0.98, lng: 40.45 } } };

describe('a base placed far outside the trip', () => {
  it('is unplaced when the proposal’s own places put that name inside the trip (the live Tanzania case, inside a country-wide extent)', () => {
    const out = run([...NORTH_BASES, TARANGIRE_IN_DAR], [...NORTH_PLACES, TARANGIRE_PARK], TANZANIA);
    expect(out.map((o) => [o.name, o.ground])).toEqual([['Tarangire area lodges', 'contradicted_by_own_places']]);
    expect(out[0]!.gapKm).toBeGreaterThan(400);
    expect(out[0]!.reason).toContain('Tarangire National Park game drive');
  });

  it('is unplaced when nothing proposed is anywhere near it', () => {
    const out = run([...NORTH_BASES, TARANGIRE_IN_DAR], NORTH_PLACES, TANZANIA);
    expect(out.map((o) => o.ground)).toEqual(['unsupported']);
  });

  it('is unplaced when it lies well outside an evidenced extent and its group is a small minority', () => {
    const tight: FootprintContext = { extent: { southWest: { lat: -4.2, lng: 34.0 }, northEast: { lat: -1.8, lng: 37.2 } } };
    const coastal: Pt = { name: 'Coast stopover', lat: -6.85, lng: 39.3 };
    const coastPlace: Pt = { name: 'Harbour walk', lat: -6.82, lng: 39.29 };
    expect(run([...NORTH_BASES, coastal], [...NORTH_PLACES, coastPlace], tight).map((o) => o.ground)).toEqual(['outside_extent']);
    /* The same group inside a country-wide extent, with its own place: kept (unknown ≠ false). */
    expect(run([...NORTH_BASES, coastal], [...NORTH_PLACES, coastPlace], TANZANIA)).toEqual([]);
  });

  it('planScanPoints records it as unplaced with its reason and plans the rest', () => {
    const { proposal, positions } = build([...NORTH_BASES, TARANGIRE_IN_DAR], [...NORTH_PLACES, TARANGIRE_PARK]);
    const plan = planScanPoints(proposal, positions, { footprint: TANZANIA });
    expect(plan.points.filter((p) => p.kind === 'base').map((p) => p.name)).toEqual(NORTH_BASES.map((b) => b.name));
    expect(plan.unplaced).toEqual([expect.objectContaining({ name: 'Tarangire area lodges', code: 'outside_footprint' })]);
    expect(plan.placeIdByKey.size).toBe(NORTH_PLACES.length + 1);
  });

  it('never takes the last base, and judges nothing on too little evidence', () => {
    expect(run([TARANGIRE_IN_DAR], NORTH_PLACES)).toEqual([]);
    expect(run([NORTH_BASES[0]!, TARANGIRE_IN_DAR], [NORTH_PLACES[0]!, NORTH_PLACES[1]!])).toEqual([]);
  });

  it('reads only distinctive words from a base’s name', () => {
    expect(distinctiveWords('Tarangire area lodges', 'Tarangire')).toEqual(['tarangire']);
    expect(distinctiveWords('Central Serengeti camps')).toEqual(['serengeti']);
  });
});

describe('a legitimately spread trip keeps every base', () => {
  it('a Rockies road trip (Banff → Jasper, with a bare night on the way)', () => {
    const bases: Pt[] = [
      { name: 'Banff', lat: 51.18, lng: -115.57 },
      { name: 'Lake Louise', lat: 51.43, lng: -116.18 },
      { name: 'Jasper', lat: 52.87, lng: -118.08 },
      { name: 'Revelstoke', lat: 51.0, lng: -118.2 },
    ];
    const places: Pt[] = [
      { name: 'Johnston Canyon', lat: 51.25, lng: -115.84 },
      { name: 'Moraine Lake', lat: 51.32, lng: -116.18 },
      { name: 'Peyto Lake', lat: 51.72, lng: -116.51 },
      { name: 'Columbia Icefield', lat: 52.22, lng: -117.22 },
      { name: 'Maligne Canyon', lat: 52.92, lng: -118.0 },
      { name: 'Emerald Lake', lat: 51.44, lng: -116.53 },
    ];
    expect(run(bases, places)).toEqual([]);
  });

  it('an Iceland ring road (the recorded live scan, and a sparse synthetic ring)', () => {
    const recorded = run(
      iceland.bases.map((b) => ({ name: b.name, lat: b.coordinates.lat, lng: b.coordinates.lng })),
      iceland.places.map((p) => ({ name: p.name, lat: p.coordinates.lat, lng: p.coordinates.lng })),
    );
    expect(recorded).toEqual([]);
    const ring: Pt[] = [
      { name: 'Reykjavik', lat: 64.15, lng: -21.94 },
      { name: 'Vik', lat: 63.42, lng: -19.0 },
      { name: 'Hofn', lat: 64.25, lng: -15.21 },
      { name: 'Egilsstadir', lat: 65.26, lng: -14.4 },
      { name: 'Akureyri', lat: 65.68, lng: -18.09 },
    ];
    const stops: Pt[] = [
      { name: 'Seljalandsfoss', lat: 63.62, lng: -19.99 },
      { name: 'Skaftafell', lat: 64.02, lng: -16.97 },
      { name: 'Jokulsarlon', lat: 64.05, lng: -16.18 },
      { name: 'Dettifoss', lat: 65.81, lng: -16.38 },
      { name: 'Godafoss', lat: 65.68, lng: -17.55 },
    ];
    expect(run(ring, stops)).toEqual([]);
  });

  it('an island chain (Hawaii, each island with its own places)', () => {
    const bases: Pt[] = [
      { name: 'Lihue', lat: 21.98, lng: -159.37 },
      { name: 'Honolulu', lat: 21.31, lng: -157.86 },
      { name: 'Kahului', lat: 20.89, lng: -156.47 },
      { name: 'Kailua-Kona', lat: 19.64, lng: -155.99 },
    ];
    const places: Pt[] = [
      { name: 'Waimea Canyon', lat: 22.07, lng: -159.66 },
      { name: 'Diamond Head', lat: 21.26, lng: -157.8 },
      { name: 'Haleakala summit', lat: 20.71, lng: -156.25 },
      { name: 'Volcanoes National Park', lat: 19.42, lng: -155.29 },
      { name: 'Hanauma Bay', lat: 21.27, lng: -157.69 },
    ];
    expect(run(bases, places)).toEqual([]);
    /* Even the outermost island as a bare base: it lies within the chain's hop. */
    expect(run(bases, places.slice(1))).toEqual([]);
  });

  it('a multi-country trip with named parts (Lisbon and Barcelona)', () => {
    const lisbon: Pt[] = [
      { name: 'Lisbon', lat: 38.72, lng: -9.14 },
      { name: 'Sintra', lat: 38.8, lng: -9.39 },
    ];
    const lisbonPlaces: Pt[] = [
      { name: 'Belem Tower', lat: 38.69, lng: -9.22 },
      { name: 'Alfama', lat: 38.71, lng: -9.13 },
      { name: 'Pena Palace', lat: 38.79, lng: -9.39 },
      { name: 'Cascais', lat: 38.7, lng: -9.42 },
    ];
    const barcelona: Pt = { name: 'Barcelona', lat: 41.39, lng: 2.17 };
    const barcelonaPlaces: Pt[] = [{ name: 'Sagrada Familia', lat: 41.4, lng: 2.17 }, { name: 'Park Guell', lat: 41.41, lng: 2.15 }];
    expect(run([...lisbon, barcelona], [...lisbonPlaces, ...barcelonaPlaces])).toEqual([]);
    /* A bare Barcelona base is still the traveller's own named part. */
    const parts = [{ label: 'Lisbon', center: { lat: 38.72, lng: -9.14 } }, { label: 'Barcelona', center: { lat: 41.39, lng: 2.17 } }];
    expect(run([...lisbon, barcelona], lisbonPlaces, { parts })).toEqual([]);
  });

  it('a bare night on the way between two stretches of a long road trip', () => {
    const west: Pt[] = [{ name: 'Flagstaff', lat: 35.2, lng: -111.65 }];
    const westPlaces: Pt[] = [
      { name: 'Grand Canyon South Rim', lat: 36.06, lng: -112.14 },
      { name: 'Sedona', lat: 34.87, lng: -111.76 },
      { name: 'Walnut Canyon', lat: 35.17, lng: -111.51 },
      { name: 'Sunset Crater', lat: 35.37, lng: -111.5 },
    ];
    const east: Pt[] = [{ name: 'Oklahoma City', lat: 35.47, lng: -97.52 }];
    const eastPlaces: Pt[] = [{ name: 'Route 66 Museum', lat: 35.51, lng: -98.97 }];
    /* Amarillo: no candidate near it, far from both ends, but squarely on the way. */
    const night: Pt = { name: 'Amarillo', lat: 35.22, lng: -101.83 };
    expect(run([...west, night, ...east], [...westPlaces, ...eastPlaces])).toEqual([]);
  });

  it('every recorded live scan — and the one stray base among them', () => {
    for (const scan of live.scans) {
      const out = run(
        scan.bases.map((b) => ({ name: b.name, lat: b.coordinates.lat, lng: b.coordinates.lng })),
        scan.places.map((p) => ({ name: p.name, lat: p.coordinates.lat, lng: p.coordinates.lng })),
      );
      /*
       * The recorded Highlands scan placed "Broadford or Isleornsay" (Skye) near
       * Sheffield, ~360 km from every other point of the trip: the second real
       * case this rule catches. Every other base of every recorded scan stays.
       */
      if (scan.label === 'scotland-road-trip') expect(out.map((o) => [o.name, o.ground]), scan.label).toEqual([['Broadford or Isleornsay', 'unsupported']]);
      else expect(out, scan.label).toEqual([]);
    }
  });
});
