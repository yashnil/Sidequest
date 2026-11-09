import { describe, expect, it } from 'vitest';
import { advisoryTables, areaWarningFor, landmassOf, ownRoomEvidence, ownWeight, placeKey, polygonScopes, refiledParents, spreadFor, suspectLocation } from './evidence.mjs';

const where = (name: string, division: string, ancestors: string[] = [], radiusKm = 20) => ({
  name: placeKey(name),
  division: placeKey(division),
  ancestors: ancestors.map(placeKey),
  places: [name, division, ...ancestors].map(placeKey),
  radiusKm,
});

const advice = (regional: unknown[], extra: object = {}) => ({
  countries: { XX: { name: 'Testland', advisories: [{ authority: 'ca', level: 2, nationalLevel: 2, wholeCountry: true, label: 'Caution', updatedAt: '2026-10-01', url: 'https://example.test', regional, ...extra }] } },
});
const avoid = (area: object, more: object = {}) => ({ level: 4, label: 'Avoid all travel', text: 'Avoid all travel.', areas: [{ kind: 'place', name: 'Lamu County', ...area }], ...more });

describe('a regional warning covers a place only when the warned area contains it', () => {
  it('covers a town in the warned county and not one elsewhere in the country', () => {
    const { prepared } = advisoryTables(advice([avoid({})]));
    expect(areaWarningFor(prepared, 'XX', where('Witu', 'Lamu'))?.level).toBe(4);
    expect(areaWarningFor(prepared, 'XX', where('Nairobi', 'Nairobi'))).toBeNull();
  });

  it('does not extend to a place wider than the province its centre sits in', () => {
    const { prepared } = advisoryTables(advice([avoid({})]));
    expect(areaWarningFor(prepared, 'XX', where('The Coast', 'Lamu', [], 300))).toBeNull();
  });

  it('honours a named exception, which is often the place people actually go', () => {
    const { prepared } = advisoryTables(advice([avoid({}, { exceptions: ['Lamu Island and Manda Island where you should exercise caution'] })]));
    expect(areaWarningFor(prepared, 'XX', where('Lamu Island', 'Lamu'))).toBeNull();
  });

  it('keeps a partial, border or unparsed warning as a caution and never removes on it', () => {
    const partial = advisoryTables(advice([avoid({ scope: 'part' })]));
    expect(areaWarningFor(partial.prepared, 'XX', where('Witu', 'Lamu'))).toBeNull();
    expect(partial.countries.XX?.parts?.[0]?.level).toBe(4);
    const border = advisoryTables(advice([avoid({ kind: 'border_zone', name: 'within 20 km of the border' })]));
    expect(areaWarningFor(border.prepared, 'XX', where('Witu', 'Lamu'))).toBeNull();
    const unparsed = advisoryTables(advice([avoid({}, { unparsed: true })]));
    expect(areaWarningFor(unparsed.prepared, 'XX', where('Witu', 'Lamu'))).toBeNull();
    expect(unparsed.countries.XX?.parts?.[0]?.level).toBe(4);
  });

  it('lets a rest-of-country warning spare only what it names', () => {
    const { prepared } = advisoryTables(advice([avoid({ kind: 'rest_of_country', name: 'the rest' }, { exceptions: ['Bangui'] })]));
    expect(areaWarningFor(prepared, 'XX', where('Bouar', 'Nana-Mambere'))?.level).toBe(4);
    expect(areaWarningFor(prepared, 'XX', where('Bangui', 'Bangui'))).toMatchObject({ exempt: true });
  });

  it('records a whole-country do-not-travel from any one authority', () => {
    const { countries } = advisoryTables(advice([], { level: 4, nationalLevel: 4 }));
    expect(countries.XX).toMatchObject({ level: 4, whole: [{ source: 'Global Affairs Canada' }] });
  });
});

describe('where a place really is', () => {
  it('flags a town far out at sea, but not an island the land layer does not draw', () => {
    const offshore = { offshoreKm: 822 };
    expect(suspectLocation({ selfKinds: [] }, offshore, 'town')).toBe(true);
    expect(suspectLocation({ selfKinds: [] }, offshore, 'island')).toBe(false);
    expect(suspectLocation({ selfKinds: [] }, { offshoreKm: null }, 'town')).toBe(false);
  });

  it('adopts the nearest land for a centre in the water only when that land is about its size', () => {
    const near = { land: null, offshoreKm: 2, nearestLand: { id: 'big', areaKm2: 470_000 } };
    expect(landmassOf({ wdAreaKm2: 40 }, near)).toBeNull();
    expect(landmassOf({ wdAreaKm2: 400_000 }, near)).toBe('big');
    expect(landmassOf({ wdAreaKm2: 40 }, { land: { id: 'own' } })).toBe('own');
  });
});

describe('polygons as scope', () => {
  it('skips a polygon whose children disagree and counts the foot of a mountain range', () => {
    const scopes = polygonScopes([
      { candidateId: 'a', source: 'gmba', memberIds: ['x'], nearMemberIds: ['y'], flags: [] },
      { candidateId: 'b', source: 'admin1', memberIds: ['x'], nearMemberIds: ['y'], flags: ['children_disagree'] },
      { candidateId: 'c', source: 'admin1', memberIds: ['x'], nearMemberIds: ['y'], flags: [] },
    ]);
    expect([...scopes.get('a')!]).toEqual(['x', 'y']);
    expect(scopes.has('b')).toBe(false);
    expect([...scopes.get('c')!]).toEqual(['x']);
  });

  it('re-files a data-only place the boundary refuses, and leaves guide pages alone', () => {
    const scopes = new Map([['p', new Set(['other'])]]);
    expect(refiledParents({ id: 'd', parents: ['p', 'q'] }, scopes)).toEqual(['q']);
    expect(refiledParents({ id: 'd', title: 'Guide', parents: ['p', 'q'] }, scopes)).toEqual(['p', 'q']);
  });
});

describe('room prices', () => {
  it('takes the tier out and counts old listings for less', () => {
    const budget = ownRoomEvidence({ n: 4, usdRealMedian: 30, yearMedian: 2025, tiers: { budget: { n: 4, usdRealMedian: 30 } } }, 2026)!;
    expect(Math.exp(budget.logUsd)).toBeCloseTo(50, 5);
    const old = ownRoomEvidence({ n: 4, usdRealMedian: 30, yearMedian: 2012, tiers: {} }, 2026)!;
    expect(old.nEff).toBeCloseTo(1.4, 5);
  });

  it('trusts more listings more and narrows the range, and widens it where lodges skew prices', () => {
    expect(ownWeight(5)).toBeGreaterThan(ownWeight(1));
    expect(spreadFor(5, false)).toBeLessThan(spreadFor(0, false));
    expect(spreadFor(5, true)).toBeGreaterThan(spreadFor(5, false));
  });
});
